//! Atlas CLI helper — `~/.local/bin/atlas`.
//!
//! Same pattern as `code` (VS Code) or `zed` (Zed): a tiny shell
//! wrapper the user runs from any terminal to open the current
//! folder (or any path) as an Atlas project.
//!
//! Usage:
//!   atlas             open the current directory
//!   atlas ./some-dir  open the named directory
//!   atlas --version   print the IDE version
//!
//! Install location is `~/.local/bin/atlas` because:
//!   1. macOS GUI launches have a minimal PATH, and the agent spawn path
//!      already prepends `~/.local/bin` when enriching a child's PATH — so
//!      anything installed there is reachable from spawned processes too.
//!   2. It's the standard XDG-ish "user binaries" location and
//!      doesn't require sudo.
//!
//! Install is **idempotent + overwriting**: every app launch
//! refreshes the script so an old version of the helper never
//! lingers. The shell script template is in this file (not a
//! separate asset) so the build-time `CARGO_PKG_VERSION` can be
//! baked straight into the `--version` branch with one `format!`.

use std::path::PathBuf;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::State;

const HELPER_TEMPLATE: &str = include_str!("../../bin/atlas-cli.sh");

/// Per-process state holding a path the CLI helper passed on argv at
/// launch (e.g. `atlas ~/Desktop/foo` → `~/Desktop/foo`). Consumed
/// exactly once by `cli_take_initial_project_path` — after that the
/// frontend's normal hydration path takes over so a window reload
/// doesn't re-trigger the open.
#[derive(Default)]
pub struct CliLaunchState {
    initial: Mutex<Option<String>>,
}

impl CliLaunchState {
    pub fn new(initial: Option<String>) -> Self {
        Self {
            initial: Mutex::new(initial),
        }
    }
}

/// Parse the process argv for a project path. Called once at startup
/// from `lib.rs::run()` before Tauri builds. Returns `Some(abs_path)`
/// when:
///   - exactly one positional arg after the executable
///   - the arg is an existing directory
/// Otherwise `None` — the app boots into its normal hydrated state.
///
/// We intentionally don't pull in `clap` for one positional arg.
pub fn parse_initial_project() -> Option<String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    tracing::info!(target: "atlas::cli", "launch argv (positional): {args:?}");
    parse_project_path(&args)
}

/// Resolve a single positional directory argument to a canonical path.
/// Shared by the cold-start path (`parse_initial_project`) and the
/// single-instance callback (which receives a forwarded argv). `args` must
/// already have the program name stripped. Returns `Some(abs_dir)` only when
/// there's exactly one positional, it isn't a flag, and it's an existing dir.
pub fn parse_project_path(args: &[String]) -> Option<String> {
    if args.len() != 1 {
        // Zero (plain `atlas`, cwd handled by the shell helper passing `.`)
        // or multiple args — refuse rather than guess.
        return None;
    }
    let raw = &args[0];
    if raw.starts_with('-') {
        return None;
    }
    let abs = std::fs::canonicalize(raw).ok()?;
    if abs.is_dir() {
        Some(abs.to_string_lossy().into_owned())
    } else {
        None
    }
}

#[tauri::command]
pub fn cli_take_initial_project_path(state: State<'_, CliLaunchState>) -> Option<String> {
    state.initial.lock().take()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub installed: bool,
    /// Absolute path of the installed helper (`~/.local/bin/atlas`).
    /// Always Some — points at where it would go if not installed.
    pub path: Option<String>,
    /// Version string read from the installed script's first line
    /// `# atlas-cli-version: <version>` marker. None if the file
    /// exists but the marker is missing (e.g. user-edited or a much
    /// older helper). Used by the Settings UI to show whether the
    /// installed copy matches the current IDE version.
    pub installed_version: Option<String>,
    /// Version we'd install right now (the running IDE build).
    pub current_version: String,
}

fn helper_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".local").join("bin").join("atlas"))
}

fn read_installed_version(path: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    raw.lines()
        .find_map(|l| l.strip_prefix("# atlas-cli-version: ").map(|v| v.trim().to_string()))
}

#[tauri::command]
pub fn cli_status() -> CliStatus {
    let path = helper_path();
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let (installed, installed_version) = match path.as_deref() {
        Some(p) if p.exists() => (true, read_installed_version(p)),
        _ => (false, None),
    };
    CliStatus {
        installed,
        path: path.map(|p| p.to_string_lossy().into_owned()),
        installed_version,
        current_version,
    }
}

/// Write `~/.local/bin/atlas` with the bundled shell helper, bake
/// the current IDE version in, set the executable bit. Idempotent:
/// if the file already exists we overwrite, since the whole point of
/// this command is "make sure the latest helper is installed."
///
/// Returns the post-install status so the caller can render
/// confirmation without a second IPC round-trip.
#[tauri::command]
pub async fn cli_install_helper() -> Result<CliStatus, String> {
    let version = env!("CARGO_PKG_VERSION").to_string();
    let path = helper_path().ok_or_else(|| "could not resolve $HOME".to_string())?;

    tokio::task::spawn_blocking({
        let path = path.clone();
        let version = version.clone();
        move || -> Result<(), String> {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)
                    .map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
            }
            let body = HELPER_TEMPLATE.replace("{{VERSION}}", &version);
            let tmp = path.with_extension("tmp");
            std::fs::write(&tmp, body).map_err(|e| format!("write tmp: {e}"))?;

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = std::fs::metadata(&tmp)
                    .map_err(|e| format!("stat tmp: {e}"))?
                    .permissions();
                perms.set_mode(0o755);
                std::fs::set_permissions(&tmp, perms)
                    .map_err(|e| format!("chmod tmp: {e}"))?;
            }

            std::fs::rename(&tmp, &path)
                .map_err(|e| format!("rename to {}: {e}", path.display()))?;
            Ok(())
        }
    })
    .await
    .map_err(|e| e.to_string())??;

    tracing::info!(
        target: "atlas::cli",
        "installed atlas CLI helper at {} (version {version})",
        path.display()
    );
    Ok(cli_status())
}

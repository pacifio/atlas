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
///
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
    let abs = dunce::canonicalize(raw).ok()?;
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
    dirs::home_dir().map(|h| {
        if cfg!(target_os = "linux") {
            h.join(".local").join("bin").join("atl")
        } else {
            h.join(".local").join("bin").join("atlas")
        }
    })
}

#[cfg(target_os = "linux")]
fn is_atlas_binary(path: &std::path::Path) -> bool {
    use std::io::Read;
    if !is_elf_binary(path) {
        return false;
    }
    if let Ok(mut f) = std::fs::File::open(path) {
        const NEEDLE: &[u8] = b"dev.atlas.ide";
        const CHUNK_SIZE: usize = 64 * 1024;
        const MAX_SCAN: usize = 32 * 1024 * 1024;

        let mut buf = vec![0u8; CHUNK_SIZE + NEEDLE.len() - 1];
        let mut carry_len = 0;
        let mut total_read = 0;

        while total_read < MAX_SCAN {
            let to_read = (MAX_SCAN - total_read).min(CHUNK_SIZE);
            let n = match f.read(&mut buf[carry_len..carry_len + to_read]) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            };
            total_read += n;
            let valid_len = carry_len + n;
            if buf[..valid_len].windows(NEEDLE.len()).any(|w| w == NEEDLE) {
                return true;
            }
            carry_len = valid_len.min(NEEDLE.len() - 1);
            buf.copy_within(valid_len - carry_len..valid_len, 0);
        }
    }
    false
}

fn system_bin_path() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        for candidate in [
            "/usr/bin/atl",
            "/usr/local/bin/atl",
            "/usr/bin/tryatlas",
            "/usr/local/bin/tryatlas",
            "/usr/bin/atlas",
            "/usr/local/bin/atlas",
            "/opt/atlas/bin/atlas",
        ] {
            let p = PathBuf::from(candidate);
            if p.is_file() {
                if let Ok(meta) = p.metadata() {
                    if meta.permissions().mode() & 0o111 != 0 {
                        if candidate.ends_with("/atlas") && !is_atlas_binary(&p) {
                            continue;
                        }
                        return Some(p);
                    }
                }
            }
        }
    }
    None
}

#[cfg(unix)]
fn is_elf_binary(path: &std::path::Path) -> bool {
    use std::io::Read;
    if let Ok(mut f) = std::fs::File::open(path) {
        let mut magic = [0u8; 4];
        if f.read_exact(&mut magic).is_ok() {
            return magic == [0x7f, b'E', b'L', b'F'];
        }
    }
    false
}

#[cfg(not(unix))]
fn is_elf_binary(_path: &std::path::Path) -> bool {
    false
}

fn read_installed_version(path: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    raw.lines().find_map(|l| {
        l.strip_prefix("# atlas-cli-version: ")
            .map(|v| v.trim().to_string())
    })
}

fn read_installed_appimage(path: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    raw.lines().find_map(|l| {
        l.strip_prefix("# atlas-appimage-path: ")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    })
}

/// `cli_status` reads files (and on Linux may scan up to 32 MiB of a system
/// binary in `is_atlas_binary`), so it runs on the blocking pool rather than
/// the thread a sync command would occupy.
#[tauri::command]
pub async fn cli_status() -> Result<CliStatus, String> {
    tokio::task::spawn_blocking(status_blocking)
        .await
        .map_err(|e| e.to_string())
}

fn status_blocking() -> CliStatus {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    if let Some(sys) = system_bin_path() {
        return CliStatus {
            installed: true,
            path: Some(sys.to_string_lossy().into_owned()),
            installed_version: Some(current_version.clone()),
            current_version,
        };
    }
    let path = helper_path();
    // If ~/.local/bin/atlas is a real compiled ELF binary, report it as installed
    if let Some(p) = path.as_deref() {
        if p.exists() && is_elf_binary(p) {
            return CliStatus {
                installed: true,
                path: Some(p.to_string_lossy().into_owned()),
                installed_version: Some(current_version.clone()),
                current_version,
            };
        }
    }
    let (installed, installed_version) = match path.as_deref() {
        Some(p) if p.exists() => {
            let ver = read_installed_version(p);
            if let Some(target) = read_installed_appimage(p) {
                if !std::path::Path::new(&target).is_file() {
                    (true, None)
                } else {
                    (true, ver)
                }
            } else {
                (true, ver)
            }
        }
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
    // The helper is a bash script that relaunches Atlas with `open -n`; neither
    // exists on Windows, where it would only shadow `atlas` in Git Bash.
    if cfg!(windows) {
        return Err("the atlas CLI helper is not available on Windows yet".to_string());
    }
    // `~/.local/bin/atlas` belongs to the released app — it is what `atlas .`
    // in any terminal opens — and the window refreshes it on every launch, so
    // a source build would otherwise take it over just by starting.
    if atlas_profile::is_dev() {
        return Err("the atlas CLI helper is not installed by the dev profile".to_string());
    }
    let version = env!("CARGO_PKG_VERSION").to_string();

    // The probes below read files (and may scan a system binary), so they
    // share the blocking pool with the install itself.
    if let Some(status) = tokio::task::spawn_blocking({
        let version = version.clone();
        move || -> Option<CliStatus> {
            // If Atlas is already installed system-wide (e.g. /usr/bin/atlas on Linux),
            // prevent ~/.local/bin/atlas from shadowing it, and clean up any old helper.
            if let Some(sys) = system_bin_path() {
                if let Some(helper) = helper_path() {
                    if helper.exists() {
                        if let Ok(content) = std::fs::read_to_string(&helper) {
                            if content.contains("atlas-cli-version") || content.contains("open -na")
                            {
                                let _ = std::fs::remove_file(&helper);
                            }
                        }
                    }
                }
                if let Some(atlas_link) =
                    dirs::home_dir().map(|h| h.join(".local").join("bin").join("atlas"))
                {
                    if let Ok(meta) = std::fs::symlink_metadata(&atlas_link) {
                        if meta.file_type().is_symlink() {
                            let is_broken = !atlas_link.exists();
                            let points_to_atl = std::fs::read_link(&atlas_link)
                                .map(|target| {
                                    target == std::path::Path::new("atl") || target.ends_with("atl")
                                })
                                .unwrap_or(false);
                            if is_broken || points_to_atl {
                                let _ = std::fs::remove_file(&atlas_link);
                            }
                        }
                    }
                }
                return Some(CliStatus {
                    installed: true,
                    path: Some(sys.to_string_lossy().into_owned()),
                    installed_version: Some(version.clone()),
                    current_version: version,
                });
            }

            // If ~/.local/bin/atlas is an ELF binary (e.g. tarball installed to ~/.local),
            // never overwrite the real binary with a shell script helper!
            if let Some(helper) = helper_path() {
                if helper.exists() && is_elf_binary(&helper) {
                    return Some(CliStatus {
                        installed: true,
                        path: Some(helper.to_string_lossy().into_owned()),
                        installed_version: Some(version.clone()),
                        current_version: version,
                    });
                }
            }
            None
        }
    })
    .await
    .map_err(|e| e.to_string())?
    {
        return Ok(status);
    }

    let path = helper_path().ok_or_else(|| "could not resolve $HOME".to_string())?;

    tokio::task::spawn_blocking({
        let path = path.clone();
        let version = version.clone();
        move || -> Result<(), String> {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)
                    .map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
            }
            let appimage_path = std::env::var("APPIMAGE").unwrap_or_default();
            let body = HELPER_TEMPLATE
                .replace("{{VERSION}}", &version)
                .replace("{{APPIMAGE_PATH}}", &appimage_path);
            let tmp = path.with_extension("tmp");
            std::fs::write(&tmp, body).map_err(|e| format!("write tmp: {e}"))?;

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = std::fs::metadata(&tmp)
                    .map_err(|e| format!("stat tmp: {e}"))?
                    .permissions();
                perms.set_mode(0o755);
                std::fs::set_permissions(&tmp, perms).map_err(|e| format!("chmod tmp: {e}"))?;
            }

            std::fs::rename(&tmp, &path)
                .map_err(|e| format!("rename to {}: {e}", path.display()))?;

            #[cfg(target_os = "linux")]
            {
                if let Some(atlas_link) =
                    dirs::home_dir().map(|h| h.join(".local").join("bin").join("atlas"))
                {
                    let usr_atlas = std::path::Path::new("/usr/bin/atlas");
                    let safe_to_link = !usr_atlas.exists() || is_atlas_binary(usr_atlas);
                    if safe_to_link {
                        if let Ok(meta) = std::fs::symlink_metadata(&atlas_link) {
                            if meta.file_type().is_symlink() && !atlas_link.exists() {
                                let _ = std::fs::remove_file(&atlas_link);
                                let _ = std::os::unix::fs::symlink("atl", &atlas_link);
                            }
                        } else {
                            let _ = std::os::unix::fs::symlink("atl", &atlas_link);
                        }
                    }
                }
            }

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
    cli_status().await
}

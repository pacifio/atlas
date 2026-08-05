//! Program resolution, PATH enrichment, and host-env sanitisation for spawning
//! ACP agent subprocesses.
//!
//! macOS GUI apps launched from Finder/the Dock inherit only a minimal PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), so `npx`/`node`/Homebrew binaries the
//! agents need are invisible unless we enrich PATH and/or resolve the program
//! to an absolute path via the user's login shell. This module owns all of
//! that hard-won logic; the registry/catalog resolves an agent to a bare
//! command and then runs it through [`resolve_command`] here before spawning.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock, RwLock};

use crate::error::AcpError;
use crate::registry::AgentSpec;

/// A Node toolchain Atlas installed itself (via the bundled nvm) when the
/// machine had no usable Node. Set by `register_managed_node_bin` after a
/// successful install. When present it WINS over whatever the login shell would
/// resolve — that's what makes the "incompatible system Node" case work: we
/// prefer our known-good version instead of the user's old one.
static MANAGED_NODE_BIN: RwLock<Option<PathBuf>> = RwLock::new(None);

/// Register the bin dir of an Atlas-managed Node install (e.g.
/// `<NVM_DIR>/versions/node/vXX/bin`) as the preferred toolchain for agent
/// spawns. Deliberately does NOT mutate the process PATH: this runs post-boot
/// from a Tauri worker thread, and env mutation off the main thread is racy
/// (M8). Spawns pick the managed toolchain up per-command instead —
/// `resolve_command` emits a JSON stdio spec whose env prepends this dir to
/// PATH, so the agent AND its children (npx → node) resolve the managed Node
/// without a global mutation.
pub fn register_managed_node_bin(bin_dir: PathBuf) {
    if let Ok(mut guard) = MANAGED_NODE_BIN.write() {
        *guard = Some(bin_dir);
    }
}

/// The currently-registered managed Node bin dir, if any.
pub fn managed_node_bin() -> Option<PathBuf> {
    MANAGED_NODE_BIN.read().ok().and_then(|g| g.clone())
}

/// Resolve a bare program name (e.g. `npx`) to an absolute path the way the
/// user's login+interactive shell would — covering nvm / fnm / volta / asdf /
/// Homebrew / custom npm prefixes. macOS GUI apps inherit only a minimal PATH,
/// so this is what makes a Finder-launched app find the same binaries the
/// terminal does. Bounded by a timeout so a slow/hanging shell rc can't block
/// the agent spawn. Returns `None` (caller keeps the bare name) if the probe
/// fails, times out, or the program isn't found.
fn resolve_program_abs(program: &str) -> Option<String> {
    // Already absolute → use as-is.
    if program.starts_with('/') {
        return Some(program.to_string());
    }
    // Prefer the Atlas-managed Node toolchain (bundled-nvm install) when set —
    // it's a known-good version and must beat an incompatible system Node.
    // Checked BEFORE the cache: a toolchain registered mid-session must win
    // over a stale cached resolution.
    if let Some(bin) = managed_node_bin() {
        let candidate = bin.join(program);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    // Once-per-app cache: the login-shell probe costs up to 5s and used to run
    // (and leak a thread + shell child on timeout) on EVERY agent spawn (M8).
    static PROBE_CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    let cache = PROBE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = cache.lock().ok().and_then(|c| c.get(program).cloned()) {
        return hit;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let resolved = probe_shell(
        &shell,
        &format!("command -v {program} 2>/dev/null"),
        std::time::Duration::from_secs(5),
    )
    .and_then(|out| {
        if !out.status.success() {
            return None;
        }
        let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
        // Accept only a real absolute path (not a shell function/alias name).
        (p.starts_with('/') && std::path::Path::new(&p).exists()).then_some(p)
    });
    if let Ok(mut c) = cache.lock() {
        c.insert(program.to_string(), resolved.clone());
    }
    resolved
}

/// Run `$SHELL -lc <script>` with an OWNED timeout: on expiry the probe child
/// is killed (so its reader thread exits promptly) instead of being abandoned
/// to run forever — the old `recv_timeout`-only pattern leaked one thread AND
/// one login shell per timed-out probe.
fn probe_shell(
    shell: &str,
    script: &str,
    timeout: std::time::Duration,
) -> Option<std::process::Output> {
    let child = std::process::Command::new(shell)
        .args(["-lc", script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(timeout) {
        Ok(out) => out.ok(),
        Err(_) => {
            // Kill the probe so the reader thread unblocks and both clean up.
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .status();
            None
        }
    }
}

/// Rewrite a `shell-words`-style command so its program (first token) is an
/// absolute path resolved via the login shell. No-op for JSON specs (`{…}`) and
/// when resolution fails (keeps the bare command → process-PATH resolution).
pub(crate) fn resolve_command(command: &str) -> String {
    let trimmed = command.trim_start();
    if trimmed.starts_with('{') {
        return command.to_string(); // JSON stdio spec — leave untouched.
    }
    let (program, rest) = match trimmed.split_once(char::is_whitespace) {
        Some((p, r)) => (p, r),
        None => (trimmed, ""),
    };
    match resolve_program_abs(program) {
        Some(abs) => {
            // With an Atlas-managed Node toolchain registered, hand the SDK a
            // JSON stdio spec whose env prepends the managed bin dir to PATH —
            // per-command env instead of a global mutation. This is what makes
            // the agent's CHILDREN (npx → `#!/usr/bin/env node`) resolve the
            // managed Node too; the absolute program path alone doesn't.
            if let Some(bin) = managed_node_bin() {
                let path = format!(
                    "{}:{}",
                    bin.to_string_lossy(),
                    std::env::var("PATH").unwrap_or_default()
                );
                // AgentSpec commands are simple space-separated tokens (no
                // quoting), so whitespace splitting matches what the SDK's
                // shell_words split would have produced.
                let args: Vec<&str> = rest.split_whitespace().collect();
                let spec = serde_json::json!({
                    "type": "stdio",
                    "name": std::path::Path::new(&abs)
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "agent".into()),
                    "command": abs,
                    "args": args,
                    "env": [{ "name": "PATH", "value": path }],
                });
                return spec.to_string();
            }
            if rest.is_empty() {
                shell_quote(&abs)
            } else {
                format!("{} {rest}", shell_quote(&abs))
            }
        }
        None => command.to_string(),
    }
}

/// POSIX single-quote a token so the downstream `shell_words::split` in
/// `AcpAgent::from_str` reassembles it as ONE argument even when it contains
/// spaces. The Atlas-managed Node toolchain lives under
/// `~/Library/Application Support/dev.atlas.ide/...` — a path WITH A SPACE — so
/// resolving `npx` to its absolute managed path and then splicing it back into a
/// space-joined command string made `shell_words` split the path in two
/// (`…/Library/Application` + `Support/…`). The spawn then failed with
/// `ENOENT` / "No such file or directory" even though `npx` was perfectly
/// available. Single-quoting the program path keeps it intact through the split.
fn shell_quote(s: &str) -> String {
    // Wrap in single quotes; escape any embedded single quote the POSIX way.
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Turn a raw spawn failure into an actionable message. The driver now
/// surfaces the underlying error (instead of the old "driver task panicked
/// before initialize" mask), but a bare "No such file or directory (os error
/// 2)" still doesn't tell the user that the missing thing is the runtime the
/// agent needs. The default agents launch via `npx`, so an ENOENT almost always
/// means Node.js isn't installed (or isn't on the GUI app's PATH).
pub(crate) fn explain_spawn_failure(spec: &AgentSpec, err: AcpError) -> AcpError {
    let raw = err.to_string();
    let looks_missing = raw.contains("os error 2")
        || raw.contains("No such file or directory")
        || raw.contains("ENOENT")
        || raw.contains("not found");
    if !looks_missing {
        return err;
    }

    // First whitespace-separated token of the command is the executable.
    let program = spec
        .command
        .split_whitespace()
        .next()
        .unwrap_or(&spec.command);

    let hint = if program == "npx" || program == "node" {
        "Node.js (which provides `npx`) was not found. Install Node.js \
         (https://nodejs.org) and relaunch Atlas. If it is installed, make sure \
         it is on your login shell's PATH."
    } else if program == "opencode" {
        "the OpenCode CLI was not found. Install it from https://opencode.ai \
         (then optionally run `opencode auth login`) and relaunch Atlas."
    } else if program == "cursor-agent" {
        "the Cursor CLI was not found. Install it from https://cursor.com/cli \
         and run `cursor-agent login`, then relaunch Atlas."
    } else {
        "the agent's runtime executable was not found on PATH"
    };

    AcpError::other(format!(
        "Could not start {}: `{}` is not available — {hint} (underlying error: {raw})",
        spec.display_name, program
    ))
}

/// Startup-time host environment fix-ups for the ACP agent process.
///
/// Two concrete problems this addresses:
///
/// 1. **`CLAUDECODE` env var leak.** The canonical
///    `@zed-industries/claude-code-acp` agent refuses to start when it sees
///    `CLAUDECODE` set in its env (anti-nesting guard). If Atlas itself was
///    launched from a parent Claude Code shell that var leaks into every
///    spawned child. Strip it.
///
/// 2. **Minimal PATH in macOS GUI apps.** When Atlas is launched from
///    Finder/the Dock the process PATH is only
///    `/usr/bin:/bin:/usr/sbin:/sbin` — `npx` (used to fetch the canonical
///    ACP agent), `node`, `bun`, `claude`, Homebrew binaries, etc. are all
///    missing. Without this enrichment `acp_spawn_agent` fails with ENOENT
///    in the bundled app even though everything works from a terminal.
pub fn sanitize_host_env() {
    // SAFETY: called once at startup before any threads spawn child processes.
    // remove_var/set_var are unsafe on the 2024 edition because mutating env
    // in a multithreaded program is racy; we accept that risk here at boot.
    unsafe {
        std::env::remove_var("CLAUDECODE");
    }
    enrich_path();
}

fn enrich_path() {
    // Three passes, cheapest first:
    //
    // 1. The cheap, deterministic prepends (~$HOME/.local/bin, .bun, .cargo,
    //    /opt/homebrew/{bin,sbin}, /usr/local/{bin,sbin}, /usr/{bin,sbin})
    //    happen synchronously so the very first `acp_spawn_agent` call can
    //    already resolve `npx`/`node` from a Homebrew install.
    //
    // 2. The user's REAL shell PATH, queried synchronously via
    //    `$SHELL -lc 'echo $PATH'` (bounded by a short timeout). This is the
    //    authoritative fix: macOS GUI apps launched from Finder/the Dock only
    //    inherit `/usr/bin:/bin:/usr/sbin:/sbin`, so `npx`/`node` installed via
    //    nvm/fnm/volta/asdf or a custom npm prefix are invisible — the hardcoded
    //    guesses in pass 1 can't cover every version manager. The login shell
    //    resolves PATH exactly the way the user's terminal does (which is why
    //    `tauri dev` from a terminal "just works" but the bundled app didn't).
    //    Mirrors `commands::claude_setup::resolve_cli`, but applied process-wide
    //    so the ACP agent spawn — not just `claude_status` — benefits.
    //
    // 3. The `~/.nvm/versions/node/*` enumeration on a background thread, kept
    //    as a belt-and-suspenders fallback for the rare case where the login
    //    shell probe fails or times out.
    apply_cheap_path_extras();
    merge_login_shell_path();
    nvm_path_walk();
}

/// Query the user's login+interactive shell for its `PATH` and merge it into
/// the process environment. Bounded by a 3s timeout so a slow shell rc (conda
/// init, etc.) can't hang app startup — on timeout we fall back to the
/// hardcoded extras already applied in `apply_cheap_path_extras`.
fn merge_login_shell_path() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    // `-lc` loads the user's full login config (where
    // nvm/fnm/etc. mutate PATH). Owned timeout: the probe child is killed on
    // expiry instead of leaking (see `probe_shell`).
    let Some(out) = probe_shell(
        &shell,
        "printf '%s' \"$PATH\"",
        std::time::Duration::from_secs(3),
    ) else {
        return;
    };
    if !out.status.success() {
        return;
    }

    let raw = String::from_utf8_lossy(&out.stdout);
    let entries: Vec<String> = raw
        .trim()
        .split(':')
        .filter(|s| !s.is_empty() && s.starts_with('/'))
        .map(String::from)
        .collect();
    if !entries.is_empty() {
        // Prepend so the login-shell PATH wins over the hardcoded guesses,
        // matching what the user's terminal would resolve first.
        prepend_to_path(&entries);
    }
}

fn apply_cheap_path_extras() {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut extras: Vec<String> = Vec::new();
    if !home.is_empty() {
        extras.push(format!("{home}/.local/bin"));
        extras.push(format!("{home}/.bun/bin"));
        extras.push(format!("{home}/.cargo/bin"));
    }
    extras.push("/opt/homebrew/bin".into());
    extras.push("/opt/homebrew/sbin".into());
    extras.push("/usr/local/bin".into());
    extras.push("/usr/local/sbin".into());
    extras.push("/usr/bin".into());
    extras.push("/bin".into());
    prepend_to_path(&extras);
}

/// Synchronous at boot (a readdir over `~/.nvm/versions/node` is microseconds)
/// so ALL process-env mutation is confined to `sanitize_host_env` on the main
/// thread before any child processes spawn — the old background-thread version
/// mutated PATH mid-flight (M8).
fn nvm_path_walk() {
    let home = match std::env::var("HOME") {
        Ok(h) if !h.is_empty() => h,
        _ => return,
    };
    let nvm_root = std::path::PathBuf::from(&home)
        .join(".nvm")
        .join("versions")
        .join("node");
    let Ok(entries) = std::fs::read_dir(&nvm_root) else {
        return;
    };
    let mut versions: Vec<_> = entries
        .flatten()
        .map(|e| e.path().join("bin"))
        .filter(|p| p.is_dir())
        .collect();
    // Newest version first (lexicographic — fine for vMAJOR.MINOR.PATCH).
    versions.sort();
    versions.reverse();
    let extras: Vec<String> = versions
        .into_iter()
        .map(|v| v.to_string_lossy().into_owned())
        .collect();
    if extras.is_empty() {
        return;
    }
    prepend_to_path(&extras);
}

fn prepend_to_path(extras: &[String]) {
    let base = std::env::var("PATH").unwrap_or_default();
    let mut path_parts: Vec<String> = if base.is_empty() {
        Vec::new()
    } else {
        base.split(':').map(String::from).collect()
    };

    // Prepend extras (in reverse so the first listed wins after all inserts),
    // skipping anything already on PATH.
    for extra in extras.iter().rev() {
        if !path_parts.iter().any(|p| p == extra) {
            path_parts.insert(0, extra.clone());
        }
    }

    let new_path = path_parts.join(":");
    // SAFETY: every caller runs at boot on the main thread, inside
    // `sanitize_host_env`, before any threads spawn child processes — the
    // post-boot mutators were removed (managed-node registration now injects
    // PATH per-command via the JSON stdio spec instead).
    unsafe {
        std::env::set_var("PATH", new_path);
    }
}

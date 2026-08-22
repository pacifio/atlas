//! Host environment fix-ups applied once at startup.
//!
//! Moved from `atlas-acp/src/spawn.rs` at Stage 3 of the Zed port, unchanged.
//! It belongs with the transport because it exists entirely for the benefit of
//! the child process an [`AcpConnection`](crate::AcpConnection) spawns.

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

    // `probe_shell` runs `-lic` — login AND interactive, so both
    // `.zprofile` (nvm/fnm) and `.zshrc` (opencode, most curl-installers)
    // PATH exports are seen. Owned timeout: the probe child is killed on
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

    // Interactive rc files can print noise lines before the real answer —
    // `printf` emits no trailing newline, so the PATH is the LAST line.
    let raw = String::from_utf8_lossy(&out.stdout);
    let Some(path_line) = raw.lines().rev().find(|l| !l.trim().is_empty()) else {
        return;
    };
    let entries: Vec<String> = path_line
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
        // Agent-CLI install dirs whose PATH export lives only in ~/.zshrc
        // (interactive-only) — deterministic backstop for the shell probe.
        extras.push(format!("{home}/.opencode/bin"));
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


/// Run `$SHELL -lic <script>` with an OWNED timeout: on expiry the probe child
/// is killed (so its reader thread exits promptly) instead of being abandoned
/// to run forever — the old `recv_timeout`-only pattern leaked one thread AND
/// one login shell per timed-out probe.
///
/// `-i` (interactive) is NOT optional: zsh only reads `~/.zshrc` in
/// interactive shells, and that's where most CLI installers put their PATH
/// export (OpenCode writes `export PATH=~/.opencode/bin:$PATH` there). A
/// login-only `-lc` probe reads `.zprofile`/`.zlogin` but skips `.zshrc`, so
/// the bundled app couldn't find `opencode` even though the terminal (and
/// `tauri dev`) could — agent worked in dev, ENOENT in production. Mirrors
/// `claude_setup::resolve_cli`, which already probes with `-lic` for the same
/// reason. Interactive rcs can print noise; callers must parse defensively
/// (last line / filtered entries).
fn probe_shell(
    shell: &str,
    script: &str,
    timeout: std::time::Duration,
) -> Option<std::process::Output> {
    let child = std::process::Command::new(shell)
        .args(["-lic", script])
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

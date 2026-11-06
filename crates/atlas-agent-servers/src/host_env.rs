//! Host environment fix-ups applied once at startup.
//!
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
    //
    // Unix only. A Windows GUI process inherits the user's full PATH from
    // Explorer, and every pass here is POSIX-shaped (`:` separators, `/`-rooted
    // entries, `$SHELL -lic`, `kill -9`) — running them on Windows corrupted
    // PATH at boot and broke every later git/node/agent spawn.
    #[cfg(unix)]
    {
        apply_cheap_path_extras();
        merge_login_shell_path();
        nvm_path_walk();
    }
}

/// Query the user's login+interactive shell for its `PATH` and merge it into
/// the process environment. Bounded by a 3s timeout so a slow shell rc (conda
/// init, etc.) can't hang app startup — on timeout we fall back to the
/// hardcoded extras already applied in `apply_cheap_path_extras`.
#[cfg(unix)]
fn merge_login_shell_path() {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".to_string()
            } else if std::path::Path::new("/bin/bash").exists() {
                "/bin/bash".to_string()
            } else {
                "/bin/sh".to_string()
            }
        });

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

#[cfg(unix)]
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
#[cfg(unix)]
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

#[cfg(unix)]
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
#[cfg(unix)]
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

#[cfg(all(test, unix))]
mod probe_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt as _;

    /// A "shell" that takes `-lic <script>` like the real one and does what
    /// `body` says. The probe is what is under test, not zsh.
    fn fake_shell(dir: &std::path::Path, body: &str) -> String {
        let path = dir.join("shell");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    /// A scratch directory (the crate has no `tempfile`), removed on drop.
    struct Scratch(std::path::PathBuf);
    impl Scratch {
        fn new() -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let dir =
                std::env::temp_dir().join(format!("atlas-probe-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn alive(pid: i32) -> bool {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .is_ok_and(|s| s.success())
    }

    #[test]
    fn a_shell_that_answers_is_read_to_the_end() {
        let dir = Scratch::new();
        let shell = fake_shell(dir.path(), r#"printf 'noise\n/opt/x/bin:/usr/bin'"#);
        let out = probe_shell(&shell, "ignored", std::time::Duration::from_secs(5))
            .expect("a prompt shell answers");
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            "noise\n/opt/x/bin:/usr/bin"
        );
    }

    /// The boot-time hang: an rc file that blocks (a prompt, a network
    /// call). The probe must give up on time AND take the shell with it —
    /// the old pattern leaked one login shell per expiry, forever.
    #[test]
    fn a_shell_that_never_answers_is_killed_at_the_deadline() {
        let dir = Scratch::new();
        let pid_file = dir.path().join("pid");
        let shell = fake_shell(
            dir.path(),
            &format!("echo $$ > '{}'\nexec sleep 30", pid_file.display()),
        );

        // Long enough for the fake shell to start and record its pid first:
        // macOS scans a freshly written executable on its first launch, which
        // alone took ~330ms on a dev Mac — past the 300ms this used to allow,
        // so the shell was killed before it wrote the pid file.
        let started = std::time::Instant::now();
        let out = probe_shell(&shell, "ignored", std::time::Duration::from_secs(2));
        assert!(out.is_none(), "an expired probe reports nothing");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "the probe waited past its deadline: {:?}",
            started.elapsed()
        );

        let pid: i32 = std::fs::read_to_string(&pid_file)
            .expect("the shell recorded its pid before blocking")
            .trim()
            .parse()
            .unwrap();
        // The kill is asynchronous to the probe's return; give it a moment.
        let gone = (0..50).any(|_| {
            if alive(pid) {
                std::thread::sleep(std::time::Duration::from_millis(20));
                false
            } else {
                true
            }
        });
        assert!(
            gone,
            "the timed-out probe shell (pid {pid}) is still running"
        );
    }
}

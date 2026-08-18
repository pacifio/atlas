//! Tier 0, verified against the real kernel.
//!
//! The Seatbelt profile *content* is vendored security-policy data, so unit
//! testing its text proves nothing. What matters is what it does, and that can
//! only be established by running a command under it:
//!
//! * a workspace path is readable and writable — a sandbox that breaks the
//!   agent's own workspace is worse than none, and the failure is silent;
//! * a known-sensitive path is unreadable — the threat the user actually named;
//! * ordinary toolchain reads still work — a sandbox users turn off protects
//!   nobody.
//!
//! macOS only. On every other host the ladder degrades to tier 1 (containment
//! and approvals), which is asserted separately.

#![cfg(target_os = "macos")]

use std::path::{Path, PathBuf};

use atlas_cersei::tools::{EnforcementTier, ToolPolicy};

struct Workspace(PathBuf);

impl Workspace {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("atlas-sbx-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        std::fs::write(p.join("inside.txt"), "workspace content\n").unwrap();
        // Canonical, because Seatbelt matches resolved paths and macOS's temp
        // dir is reached through two symlinked prefixes.
        Workspace(p.canonicalize().unwrap())
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Run `command` confined, and return (exit code, stdout+stderr).
fn confined(ws: &Workspace, command: &str) -> (Option<i32>, String) {
    let policy = ToolPolicy::new(ws.path(), "sandbox-tier0");
    assert_eq!(
        policy.tier(),
        EnforcementTier::Sandboxed,
        "this host has /usr/bin/sandbox-exec, so the ladder must select tier 0"
    );
    let sandbox = policy.sandbox().expect("tier 0 implies a sandbox");
    let argv = sandbox.wrap(vec!["sh".into(), "-c".into(), command.to_string()]);
    let out = std::process::Command::new(&argv[0])
        .args(&argv[1..])
        .current_dir(ws.path())
        .output()
        .expect("sandbox-exec should launch");
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    (out.status.code(), text)
}

#[test]
fn the_workspace_is_readable_and_writable() {
    let ws = Workspace::new();
    let (code, out) = confined(&ws, "cat inside.txt && echo written > new.txt && cat new.txt");
    assert_eq!(code, Some(0), "{out}");
    assert!(out.contains("workspace content"), "{out}");
    assert!(ws.path().join("new.txt").exists(), "the write did not land: {out}");
}

#[test]
fn credentials_and_browser_profiles_are_unreadable() {
    let ws = Workspace::new();
    // `~/Library/Keychains` exists on every macOS install, so this asserts the
    // deny rule rather than the absence of a directory.
    let (_, out) = confined(
        &ws,
        "ls ~/Library/Keychains >/dev/null 2>&1 && echo REACHED || echo denied",
    );
    assert!(
        out.contains("denied"),
        "a sensitive path was reachable from inside the sandbox: {out}"
    );
}

#[test]
fn ordinary_reads_outside_the_workspace_still_work() {
    // The deny list is deliberately a list, not a whitelist: a read whitelist
    // tight enough to be meaningful breaks cargo, npm, and go, and a sandbox
    // users disable protects nobody.
    let ws = Workspace::new();
    let (code, out) = confined(&ws, "ls /usr/bin/env && echo TOOLCHAIN-OK");
    assert_eq!(code, Some(0), "{out}");
    assert!(out.contains("TOOLCHAIN-OK"), "{out}");
}

#[test]
fn the_network_still_works() {
    // The base policy opens with `(deny default)`, and the vendored network
    // policy grants only the *supporting* rights — DNS config, the security
    // server, loopback sockets — because Codex injects the outbound rule from
    // its proxy layer, which Atlas deliberately did not vendor. Without an
    // explicit allow, every socket is blocked: `npm install`, `cargo fetch`,
    // `pip install` and `git push` all fail, for every macOS user, since tier 0
    // is the default. This test is the one that catches that.
    let ws = Workspace::new();
    let (code, out) = confined(
        &ws,
        "curl -sS --max-time 20 -o /dev/null -w '%{http_code}' https://example.com",
    );
    if out.contains("Could not resolve host") && std::env::var("CI").is_err() {
        // Offline developer machine — the assertion below would fail for a
        // reason that has nothing to do with the sandbox.
        eprintln!("skipping: no network");
        return;
    }
    assert_eq!(code, Some(0), "the sandbox blocked the network: {out}");
    assert!(out.contains("200"), "{out}");
}

#[test]
fn writing_outside_the_workspace_is_refused() {
    let ws = Workspace::new();
    let outside = std::env::temp_dir().join(format!("atlas-escape-{}", uuid::Uuid::new_v4()));
    // A path under the user's home rather than under /tmp: the temp directories
    // stay writable on purpose, because every compiler puts intermediates there.
    let home = std::env::var("HOME").expect("HOME");
    let target = Path::new(&home).join(".atlas-sandbox-escape-probe");
    let (_, out) = confined(
        &ws,
        &format!(
            "touch '{}' && echo ESCAPED || echo blocked",
            target.display()
        ),
    );
    let escaped = target.exists();
    let _ = std::fs::remove_file(&target);
    let _ = std::fs::remove_file(&outside);
    assert!(!escaped, "wrote outside the workspace: {out}");
    assert!(out.contains("blocked"), "{out}");
}

#[test]
fn a_workspace_path_with_shell_metacharacters_does_not_break_the_profile() {
    // Paths are `-D` parameters precisely so a name like this cannot close a
    // policy expression and rewrite the rest of the profile.
    let base = std::env::temp_dir().join(format!("atlas-sbx-{}", uuid::Uuid::new_v4()));
    let odd = base.join("a b (c) \"d\"");
    std::fs::create_dir_all(&odd).unwrap();
    std::fs::write(odd.join("inside.txt"), "ok\n").unwrap();
    let ws = Workspace(odd.canonicalize().unwrap());

    let (code, out) = confined(&ws, "cat inside.txt");
    assert_eq!(code, Some(0), "{out}");
    assert!(out.contains("ok"), "{out}");
    let _ = std::fs::remove_dir_all(&base);
}

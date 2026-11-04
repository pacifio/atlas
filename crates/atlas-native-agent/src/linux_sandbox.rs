//! Atlas as the engine's Linux sandbox helper. Compiled on Linux only.
//!
//! On macOS the engine sandboxes a command with `/usr/bin/sandbox-exec`,
//! which is already on disk. Linux has no such binary: the engine's
//! `SandboxType::LinuxSeccomp` re-execs a helper whose **arg0** is
//! `atlas-engine-linux-sandbox`, and when the embedder hands it no path for
//! one the engine refuses the sandbox transform before spawning anything.
//! Under the default `WorkspaceWrite` policy every sandboxed tool call then
//! ends the turn normally having run nothing, which is how the native agent
//! behaved in every Linux build until this module existed.
//!
//! The engine's own binaries solve it with `atlas-engine-arg0`: one
//! executable that becomes the helper when started under that name, plus a
//! temp dir of aliases prepended to `PATH`. Atlas takes the first half and
//! not the second (see `helper.rs` for why the app avoids `arg0_dispatch`):
//!
//! - [`dispatch_if_sandbox_alias`] runs first thing in `main`, through
//!   `run_engine_helper_if_asked`, and turns the process into the helper
//!   when its arg0's basename is the helper's name.
//! - [`install_alias`] gives the engine a path with that basename: a symlink
//!   to Atlas's own executable inside the engine home. It lives in the home,
//!   not a per-process temp dir, so nothing is left behind on exit and the
//!   path is the same every launch. bubblewrap builds without `--argv0`
//!   re-enter the helper inside the sandbox by this path, so the basename is
//!   what keeps dispatch working there.
//! - [`bubblewrap_problem`] says, in words, why the sandbox will fail on this
//!   machine, so a missing or AppArmor-blocked bubblewrap shows up in the log
//!   at startup instead of as a confusing first tool call.

use std::ffi::OsStr;
use std::io;
use std::path::Path;
use std::path::PathBuf;

use atlas_engine_sandboxing::landlock::ATLAS_AGENT_LINUX_SANDBOX_ARG0;

/// Become the engine's Linux sandbox helper if this process was started as
/// one. Never returns when it was; returns at once otherwise.
pub(crate) fn dispatch_if_sandbox_alias() {
    let Some(argv0) = std::env::args_os().next() else {
        return;
    };
    if is_sandbox_alias(&argv0) {
        atlas_engine_linux_sandbox::run_main();
    }
}

/// Whether `argv0` names the sandbox helper. The basename alone decides, as
/// in `atlas-engine-arg0`: bubblewrap's `--argv0` passes the bare name, and
/// the no-`--argv0` path passes the alias's full path.
fn is_sandbox_alias(argv0: &OsStr) -> bool {
    Path::new(argv0)
        .file_name()
        .is_some_and(|name| name == ATLAS_AGENT_LINUX_SANDBOX_ARG0)
}

/// Where the helper alias lives inside an engine home.
pub(crate) fn alias_path(engine_home: &Path) -> PathBuf {
    engine_home
        .join("linux-sandbox")
        .join(ATLAS_AGENT_LINUX_SANDBOX_ARG0)
}

/// Point the helper alias in `engine_home` at `target` and return its path.
///
/// Idempotent, and atomic when it changes anything: the new link is made
/// under a private name and renamed over the old one, so an engine that is
/// mid-spawn never sees the alias missing. Re-pointed on every launch
/// because the executable can move: an AppImage mounts at a new
/// `/tmp/.mount_*` each time it starts.
pub(crate) fn install_alias(engine_home: &Path, target: &Path) -> io::Result<PathBuf> {
    let path = alias_path(engine_home);
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::other("the helper alias has no parent directory"))?;
    std::fs::create_dir_all(dir)?;
    if std::fs::read_link(&path).is_ok_and(|current| current == target) {
        return Ok(path);
    }
    let staging = dir.join(format!(
        ".{ATLAS_AGENT_LINUX_SANDBOX_ARG0}.{}",
        std::process::id()
    ));
    match std::fs::remove_file(&staging) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    std::os::unix::fs::symlink(target, &staging)?;
    if let Err(e) = std::fs::rename(&staging, &path) {
        let _ = std::fs::remove_file(&staging);
        return Err(e);
    }
    Ok(path)
}

/// Why the engine's sandbox cannot run on this machine, or `None` when
/// bubblewrap is present and can create the namespaces the sandbox needs.
///
/// Spawns a process: call it off the async runtime.
pub(crate) fn bubblewrap_problem() -> Option<String> {
    let Some(bwrap) = atlas_engine_sandboxing::find_system_bwrap_in_path() else {
        return Some(
            "bubblewrap (bwrap) is not on PATH; the native agent cannot run commands until it \
             is installed (the distro package is `bubblewrap`)"
                .to_string(),
        );
    };
    // The same probe CI runs before the sandbox suites: every namespace the
    // sandbox can ask for, networking included.
    let output = std::process::Command::new(&bwrap)
        .args(["--unshare-all", "--ro-bind", "/", "/", "true"])
        .stdin(std::process::Stdio::null())
        .output();
    match output {
        Ok(out) if out.status.success() => None,
        Ok(out) => Some(describe_bwrap_failure(
            &bwrap,
            &String::from_utf8_lossy(&out.stderr),
        )),
        Err(e) => Some(format!("{} could not be started: {e}", bwrap.display())),
    }
}

fn describe_bwrap_failure(bwrap: &Path, stderr: &str) -> String {
    let stderr = stderr.trim();
    let restricted = Path::new("/proc/sys/kernel/apparmor_restrict_unprivileged_userns");
    let hint = if std::fs::read_to_string(restricted).is_ok_and(|v| v.trim() == "1") {
        " AppArmor restricts unprivileged user namespaces on this system \
         (kernel.apparmor_restrict_unprivileged_userns=1); install the distro's AppArmor \
         profile for bwrap, or see docs/reference/linux-support.md."
    } else {
        " Unprivileged user namespaces may be disabled (kernel.unprivileged_userns_clone or \
         user.max_user_namespaces)."
    };
    format!(
        "{} cannot create the sandbox's namespaces, so the native agent's commands will fail: \
         {stderr}.{hint}",
        bwrap.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_alias_is_recognised_by_basename_alone() {
        assert!(is_sandbox_alias(OsStr::new("atlas-engine-linux-sandbox")));
        assert!(is_sandbox_alias(OsStr::new(
            "/home/u/.atlas/atlas-agent/engine/linux-sandbox/atlas-engine-linux-sandbox"
        )));
        assert!(!is_sandbox_alias(OsStr::new("/usr/bin/atl")));
        assert!(!is_sandbox_alias(OsStr::new(
            "atlas-engine-linux-sandbox-x"
        )));
        assert!(!is_sandbox_alias(OsStr::new("")));
    }

    #[test]
    fn the_alias_points_at_the_target_and_keeps_the_helper_name() {
        let home = tempfile::tempdir().unwrap();
        let target = home.path().join("atl");
        std::fs::write(&target, b"").unwrap();

        let path = install_alias(home.path(), &target).unwrap();

        assert_eq!(path.file_name().unwrap(), ATLAS_AGENT_LINUX_SANDBOX_ARG0);
        assert!(path.starts_with(home.path()));
        assert_eq!(std::fs::read_link(&path).unwrap(), target);
    }

    #[test]
    fn installing_again_is_a_no_op_and_a_moved_executable_is_followed() {
        let home = tempfile::tempdir().unwrap();
        let first = home.path().join("first");
        let second = home.path().join("second");

        let path = install_alias(home.path(), &first).unwrap();
        assert_eq!(install_alias(home.path(), &first).unwrap(), path);
        assert_eq!(std::fs::read_link(&path).unwrap(), first);

        // An AppImage mounts somewhere new on every launch.
        install_alias(home.path(), &second).unwrap();
        assert_eq!(std::fs::read_link(&path).unwrap(), second);

        // Nothing but the alias is left in its directory.
        let entries: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![OsStr::new(ATLAS_AGENT_LINUX_SANDBOX_ARG0)]);
    }

    #[test]
    fn a_failure_names_the_binary_and_carries_bwraps_words() {
        let message = describe_bwrap_failure(
            Path::new("/usr/bin/bwrap"),
            "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n",
        );
        assert!(message.starts_with("/usr/bin/bwrap cannot create"));
        assert!(message.contains("Failed RTM_NEWADDR"));
    }
}

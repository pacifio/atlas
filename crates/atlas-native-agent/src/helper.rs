//! Atlas re-entered as one of the engine's helper processes.
//!
//! The engine does not do all of its sandboxed work in-process. It re-execs
//! the binary it was handed as `self_exe` — Atlas's own executable — with a
//! helper flag in `argv[1]`, and expects that process to *be* the helper:
//!
//! - **`--atlas-engine-run-as-fs-helper`**, on every platform. Each file
//!   read or write under a restricted policy (`WorkspaceWrite`, the default)
//!   goes through it — under `sandbox-exec` on macOS, a restricted token on
//!   Windows. It reads one JSON request on stdin and answers on stdout.
//! - **`--run-as-windows-sandbox`**, on Windows. The launcher that sets up
//!   the restricted token and runs the inner command (usually the fs helper
//!   above, from a copy of this exe under the engine home's `.sandbox-bin`).
//! - **`--atlas-engine-run-as-arg0-exec-helper`**, on Unix, for a sandboxed
//!   command that asked for a specific `argv[0]`.
//! - **arg0 `atlas-engine-linux-sandbox`**, on Linux. The seccomp +
//!   bubblewrap sandbox every restricted command runs under. Dispatched on
//!   the *name* the process was started under, not a flag; the alias that
//!   carries that name is made by `crate::linux_sandbox`.
//!
//! The engine's binaries all start through `atlas-engine-arg0`, which does this
//! dispatch. Atlas embeds the engine instead, and for a long time handled
//! none of these flags: the re-exec booted a second copy of the app, nothing
//! ever answered the engine on stdout, and every native `apply_patch` hung
//! until the turn was abandoned. Zed (`--askpass`, `--crash-handler`) and
//! the engine (`arg0_dispatch`) both settle it the same way, which is the way
//! here: branch on argv before the GUI exists.
//!
//! `arg0_dispatch` itself is not reused. On the way past it loads
//! `~/.atlas_engine/.env` into the process and prepends a temp dir of aliases
//! to `PATH` — neither of which the app wants, and the app is the case that
//! returns.

/// Run the engine helper this process was launched as, if any. Never returns
/// when one matches; returns at once otherwise.
///
/// Call this first thing in `main`, before Tauri, any logging, or any thread:
/// a helper's only interface is its stdio and exit code.
pub fn run_engine_helper_if_asked() {
    // Before argv[1]: the sandbox helper's own arguments are its command
    // line, and nothing in them is one of the flags below.
    #[cfg(target_os = "linux")]
    crate::linux_sandbox::dispatch_if_sandbox_alias();
    let Some(argv1) = std::env::args_os().nth(1) else {
        return;
    };
    let Some(argv1) = argv1.to_str() else {
        return;
    };
    if argv1 == atlas_engine_exec_server::ATLAS_AGENT_FS_HELPER_ARG1 {
        atlas_engine_exec_server::run_fs_helper_main();
    }
    #[cfg(target_os = "windows")]
    if argv1 == atlas_engine_windows_sandbox::ATLAS_AGENT_WINDOWS_SANDBOX_ARG1 {
        atlas_engine_windows_sandbox::run_windows_sandbox_wrapper_main();
    }
    #[cfg(unix)]
    if argv1 == atlas_engine_exec_server::ATLAS_AGENT_ARG0_EXEC_HELPER_ARG1 {
        atlas_engine_exec_server::run_arg0_exec_helper_main();
    }
}

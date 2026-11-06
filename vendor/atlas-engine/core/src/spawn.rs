// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
use atlas_engine_network_proxy::NetworkProxy;
use atlas_engine_utils_absolute_path::AbsolutePathBuf;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::Child;
use tokio::process::Command;
use tracing::trace;

use atlas_engine_protocol::permissions::NetworkSandboxPolicy;
use atlas_engine_protocol::shell_environment::is_non_inheritable_env_var;

/// Experimental environment variable that will be set to some non-empty value
/// if both of the following are true:
///
/// 1. The process was spawned by Atlas Agent as part of a shell tool call.
/// 2. NetworkSandboxPolicy is restricted for the tool call.
///
/// We may try to have just one environment variable for all sandboxing
/// attributes, so this may change in the future.
pub const ATLAS_AGENT_SANDBOX_NETWORK_DISABLED_ENV_VAR: &str =
    "ATLAS_AGENT_SANDBOX_NETWORK_DISABLED";

/// Should be set when the process is spawned under a sandbox. Currently, the
/// value is "seatbelt" for macOS, but it may change in the future to
/// accommodate sandboxing configuration and other sandboxing mechanisms.
pub const ATLAS_AGENT_SANDBOX_ENV_VAR: &str = "ATLAS_AGENT_SANDBOX";

#[derive(Debug, Clone, Copy)]
pub enum StdioPolicy {
    RedirectForShellTool,
    Inherit,
}

/// Spawns the appropriate child process for the exec params and sandbox settings,
/// ensuring the args and environment variables used to create the `Command`
/// (and `Child`) honor the configuration.
///
/// For now, we take `NetworkSandboxPolicy` as a parameter to spawn_child()
/// because we need to determine whether to set the
/// `ATLAS_AGENT_SANDBOX_NETWORK_DISABLED_ENV_VAR` environment variable.
pub(crate) struct SpawnChildRequest<'a> {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub arg0: Option<&'a str>,
    pub cwd: AbsolutePathBuf,
    pub network_sandbox_policy: NetworkSandboxPolicy,
    pub network: Option<&'a NetworkProxy>,
    pub stdio_policy: StdioPolicy,
    pub env: HashMap<String, String>,
}

/// A spawned shell-tool child, with whatever holds the processes it starts.
pub(crate) struct SpawnedChild {
    pub child: Child,
    pub tree: ProcessTree,
}

/// Atlas: the processes a shell call started, so cancel and timeout reach
/// them and not just the shell.
///
/// Unix does this with the child's process group, which `exec` signals
/// directly; this type is empty there. Windows has no group to signal —
/// `kill_child_process_group` is a no-op and `TerminateProcess` stops only the
/// direct child — so a `powershell -Command` running another program left
/// that program orphaned when the turn was stopped. Here the child runs in a
/// Job Object instead:
///
/// - [`ProcessTree::kill`] on cancel and timeout ends every member;
/// - dropping it, as an abandoned call does, closes the job, and
///   `KILL_ON_JOB_CLOSE` ends every member;
/// - [`ProcessTree::release`] when the call finishes on its own lets what it
///   deliberately started (a dev server) keep running, as on Unix.
#[derive(Debug, Default)]
pub(crate) struct ProcessTree {
    #[cfg(windows)]
    job: Option<atlas_engine_utils_pty::JobObject>,
}

impl ProcessTree {
    /// End every process the call started.
    pub(crate) fn kill(&self) {
        #[cfg(windows)]
        if let Some(job) = &self.job
            && let Err(error) = job.terminate()
        {
            tracing::warn!("terminating a shell call's process tree failed: {error}");
        }
    }

    /// The call ended on its own: leave what it started running.
    pub(crate) fn release(&self) {
        #[cfg(windows)]
        if let Some(job) = &self.job
            && let Err(error) = job.preserve_descendants()
        {
            tracing::warn!("releasing a shell call's process tree failed: {error}");
        }
    }
}

pub(crate) async fn spawn_child_async(
    request: SpawnChildRequest<'_>,
) -> std::io::Result<SpawnedChild> {
    let SpawnChildRequest {
        program,
        args,
        arg0,
        cwd,
        network_sandbox_policy,
        network,
        stdio_policy,
        mut env,
    } = request;

    env.retain(|name, _| !is_non_inheritable_env_var(name));

    trace!(
        "spawn_child_async: {program:?} {args:?} {arg0:?} {cwd:?} {network_sandbox_policy:?} {stdio_policy:?} {env:?}"
    );

    let mut cmd = Command::new(&program);
    #[cfg(unix)]
    cmd.arg0(arg0.map_or_else(|| program.to_string_lossy().to_string(), String::from));
    // Atlas: CREATE_NO_WINDOW. This is the shell tool's executor when it is
    // not sandboxed — every `powershell.exe -EncodedCommand …` a turn runs
    // comes through here with piped stdio. The engine runs inside a GUI
    // process that has no console, so without this flag each tool call was
    // handed a fresh console, which Windows Terminal put on screen.
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    cmd.args(args);
    cmd.current_dir(cwd);
    if let Some(network) = network {
        network.apply_to_env(&mut env);
    }
    // macOS fd cleanup must keep the shell escalation socket.
    #[cfg(target_os = "macos")]
    let inherited_fd = env
        .get(atlas_engine_shell_escalation::ESCALATE_SOCKET_ENV_VAR)
        .and_then(|fd| fd.parse().ok());
    cmd.env_clear();
    cmd.envs(env);

    if !network_sandbox_policy.is_enabled() {
        cmd.env(ATLAS_AGENT_SANDBOX_NETWORK_DISABLED_ENV_VAR, "1");
    }

    // If this Atlas Agent process dies (including being killed via SIGKILL), we want
    // any child processes that were spawned as part of a `"shell"` tool call
    // to also be terminated.

    #[cfg(unix)]
    unsafe {
        let detach_from_tty = matches!(stdio_policy, StdioPolicy::RedirectForShellTool);
        #[cfg(target_os = "linux")]
        let parent_pid = libc::getpid();
        cmd.pre_exec(move || {
            if detach_from_tty {
                atlas_engine_utils_pty::process_group::detach_from_tty()?;
            }

            // This relies on prctl(2), so it only works on Linux.
            #[cfg(target_os = "linux")]
            {
                // This prctl call effectively requests, "deliver SIGTERM when my
                // current parent dies."
                atlas_engine_utils_pty::process_group::set_parent_death_signal(parent_pid)?;
            }
            // macOS cannot receive the fd with close-on-exec set atomically.
            #[cfg(target_os = "macos")]
            atlas_engine_utils_pty::pty::close_inherited_fds_except(inherited_fd.as_slice());
            Ok(())
        });
    }

    match stdio_policy {
        StdioPolicy::RedirectForShellTool => {
            // Do not create a file descriptor for stdin because otherwise some
            // commands may hang forever waiting for input. For example, ripgrep has
            // a heuristic where it may try to read from stdin as explained here:
            // https://github.com/BurntSushi/ripgrep/blob/e2362d4d5185d02fa857bf381e7bd52e66fafc73/crates/core/flags/hiargs.rs#L1101-L1103
            cmd.stdin(Stdio::null());

            cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        }
        StdioPolicy::Inherit => {
            // Inherit stdin, stdout, and stderr from the parent process.
            cmd.stdin(Stdio::inherit())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit());
        }
    }

    // Atlas: on Windows the child starts suspended and is resumed only once it
    // is in the job, so nothing it starts can be created outside it. A job
    // that cannot be made, or a nested job that refuses the child, falls back
    // to the uncontained spawn this always was.
    #[cfg(windows)]
    let job = match atlas_engine_utils_pty::JobObject::create() {
        Ok(job) => {
            // Keeps CREATE_NO_WINDOW, which it also sets.
            job.prepare_suspended_spawn(&mut cmd);
            Some(job)
        }
        Err(error) => {
            tracing::warn!(
                "no job object for a shell call, its descendants are uncontained: {error}"
            );
            None
        }
    };

    let child = cmd.kill_on_drop(true).spawn()?;

    #[cfg(windows)]
    let job = match (job, child.id()) {
        (Some(job), Some(pid)) => job.assign_and_resume_process(pid)?.then_some(job),
        _ => None,
    };

    Ok(SpawnedChild {
        child,
        tree: ProcessTree {
            #[cfg(windows)]
            job,
        },
    })
}

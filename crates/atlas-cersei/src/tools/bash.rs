//! `Bash` — run a shell command in the project root, with a timeout, combined
//! stdout+stderr, and bounded-memory output capture.
//!
//! Each call starts fresh in `ctx.working_dir` — no persisted per-session
//! cwd/env. A model must pass a relative path rather than rely on a prior `cd`.
//! For anything that must outlive the call — a dev server, a REPL, a long build
//! — use the persistent [`terminal`](super::terminal) tools instead.
//!
//! Three properties here are deliberate and were kept:
//!
//! * The child runs in **its own process group**, so cancelling kills
//!   grandchildren (a `cargo build`'s `rustc` processes) rather than orphaning
//!   them.
//! * Output goes to a **file**, not a pipe, so a full pipe buffer can never
//!   deadlock the poll loop.
//! * A **non-zero exit with output is a success**, because that is normal for
//!   grep, diff, and test runners.
//!
//! Two were fixed (tool spec D5, D11):
//!
//! * The capture file is now **drained incrementally into a bounded head/tail
//!   ring** while the command runs. It used to be read whole into memory after
//!   the fact and then trimmed, so a command emitting gigabytes was fully
//!   buffered before being thrown away.
//! * A failed read of that file used to become an empty result via
//!   `unwrap_or_default`, which the model then read as "the command produced no
//!   output". It is now an error.

use std::io::Read;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use cersei::tools::{PermissionLevel, Tool, ToolCategory, ToolContext, ToolResult};
use serde::Deserialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::policy::{ToolPolicy, ESCALATION_MARKER};
use super::{coerce, errors, screen, truncate};

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_TIMEOUT_MS: u64 = 600_000;

const DESCRIPTION: &str = "Runs a shell command and returns its combined output. For git, npm, \
cargo, docker — not for files: Read a file, Grep its contents, Glob by name, List a directory, \
Edit or Write to change one. Those return grounded, bounded output; cat/sed/find here costs far \
more context for the same answer.\n\
- Every call starts in the project root; a `cd` does not carry to the next call.\n\
- For something that must keep running — a dev server, a REPL, a slow build — use TerminalStart.";

#[derive(Deserialize)]
struct Input {
    command: String,
    timeout: Option<u64>,
}

struct Captured {
    ring: truncate::HeadTail,
    /// Path to the full output, when it was capped and therefore worth keeping.
    spill: Option<std::path::PathBuf>,
}

enum Outcome {
    Done { code: i32, output: Captured },
    TimedOut { ms: u64, output: Captured },
    /// The turn's cancel token fired: the process group was killed, its exit
    /// awaited, and whatever output landed is returned as a REAL result — the
    /// model (and history) see a settled tool call, not a dropped future.
    Cancelled { output: Captured },
}

/// Kill the child's whole process group (the shell AND its descendants —
/// `child.kill()` alone orphans grandchildren like `cargo build`'s rustc
/// processes), then reap. Unix-only; falls back to killing the shell.
fn kill_process_group(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        // Negative pid = the process group created by `process_group(0)`.
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Everything the blocking runner needs, so the signature stays readable.
struct RunSpec {
    argv: Vec<String>,
    cwd: std::path::PathBuf,
    /// Where a *retained* full output is kept. Inside the workspace, so the
    /// gate permits the model to read the file the truncation notice names.
    /// `None` runs without a retained copy (tests, direct callers).
    spill_dir: Option<std::path::PathBuf>,
    timeout_ms: u64,
    cancel: Option<CancellationToken>,
    max_output: usize,
}

/// Run `spec.argv` in `spec.cwd`, combining stdout+stderr into a capture file
/// and draining it incrementally into a bounded ring. Blocking — call inside
/// `spawn_blocking`.
fn run_blocking(spec: RunSpec) -> Result<Outcome, String> {
    // The live capture file is transient and goes to the system temp dir. It
    // deliberately does *not* go into the workspace: a file appearing and
    // vanishing there on every single shell command would churn the user's
    // `git status` and every file watcher pointed at their project. Only the
    // rare retained copy lands in the workspace, below.
    let capture = std::env::temp_dir().join(format!("atlas-bash-{}.out", uuid::Uuid::new_v4()));
    let file = std::fs::File::create(&capture).map_err(|e| format!("capture file: {e}"))?;
    let err_handle = file.try_clone().map_err(|e| format!("capture file: {e}"))?;

    let (program, args) = spec
        .argv
        .split_first()
        .ok_or_else(|| "empty command line".to_string())?;
    let mut cmd = std::process::Command::new(program);
    cmd.args(args)
        .current_dir(&spec.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::from(file))
        .stderr(Stdio::from(err_handle));
    // Own process group so cancel/timeout can kill the whole tree, and so the
    // group keeps being reaped by THIS loop even if the runner's cancel race
    // drops the async wrapper (spawn_blocking threads are not abortable —
    // this loop always runs to completion and cleans up).
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = std::fs::remove_file(&capture);
            return Err(format!("Failed to launch shell: {e}"));
        }
    };

    // A second handle on the same file, read incrementally as the child writes.
    // This is what keeps memory flat: the ring holds the head and the tail, and
    // the middle is counted rather than kept.
    let mut drain = std::fs::File::open(&capture).map_err(|e| format!("capture file: {e}"))?;
    let mut ring = truncate::HeadTail::new(spec.max_output);
    let mut buf = vec![0u8; 64 * 1024];
    // Rendered before the ring sees it. A command run without a TTY usually
    // turns its spinner off, but `--color=always`, `--progress` and anything
    // that draws with `\r` do not care whether a terminal is attached — and
    // raw cursor movements cost the model its context window for output that
    // renders to a line (see `screen.rs`).
    //
    // Drained on every read, not at EOF: `pump` reads until the pipe is empty,
    // so buffering until then would hold a whole gigabyte in the renderer and
    // undo the flat memory the capture file buys. Only *committed* lines are
    // taken, so a progress line rewritten across several reads still collapses.
    let mut screen = screen::Screen::new();
    let mut pump = |drain: &mut std::fs::File,
                    ring: &mut truncate::HeadTail,
                    screen: &mut screen::Screen|
     -> Result<(), String> {
        loop {
            match drain.read(&mut buf) {
                Ok(0) => return Ok(()),
                Ok(n) => {
                    screen.push(&buf[..n]);
                    ring.push(screen.take_committed().as_bytes());
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                // A read failure used to become an empty result. It is a real
                // error: "no output" and "we could not read the output" are
                // different facts and the model must not confuse them.
                Err(e) => return Err(format!("Failed to read command output: {e}")),
            }
        }
    };

    let deadline = Instant::now() + Duration::from_millis(spec.timeout_ms);
    let mut timed_out = false;
    let mut cancelled = false;
    // Back off from a tight poll to a relaxed one: a 10-minute build should not
    // wake a thread 40,000 times.
    let mut idle = Duration::from_millis(5);
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {
                pump(&mut drain, &mut ring, &mut screen)?;
                if spec.cancel.as_ref().is_some_and(|t| t.is_cancelled()) {
                    kill_process_group(&mut child);
                    cancelled = true;
                    break;
                }
                if Instant::now() >= deadline {
                    kill_process_group(&mut child);
                    timed_out = true;
                    break;
                }
                std::thread::sleep(idle);
                idle = (idle * 2).min(Duration::from_millis(100));
            }
            Err(e) => {
                kill_process_group(&mut child);
                let _ = std::fs::remove_file(&capture);
                return Err(format!("Failed to wait on shell: {e}"));
            }
        }
    }
    // Whatever the child wrote between the last pump and its exit, plus the
    // line it left unfinished — a command that ends without a trailing newline
    // still said something.
    pump(&mut drain, &mut ring, &mut screen)?;
    ring.push(screen.take().0.as_bytes());

    // Only a capped run keeps a full copy, and only then does anything touch
    // the workspace. The copy is what makes the truncation notice actionable:
    // it names a path inside the workspace, which is a path the gate permits
    // the model to read.
    let mut spill = None;
    if ring.was_capped() {
        if let Some(dir) = &spec.spill_dir {
            match std::fs::create_dir_all(dir)
                .and_then(|()| {
                    let target = dir.join(format!("bash-{}.out", uuid::Uuid::new_v4()));
                    std::fs::copy(&capture, &target).map(|_| target)
                }) {
                Ok(target) => spill = Some(target),
                Err(e) => tracing::warn!(error = %e, "retaining full command output failed"),
            }
        }
    }
    let _ = std::fs::remove_file(&capture);
    let output = Captured { ring, spill };

    if cancelled {
        return Ok(Outcome::Cancelled { output });
    }
    if timed_out {
        return Ok(Outcome::TimedOut {
            ms: spec.timeout_ms,
            output,
        });
    }
    let code = child
        .try_wait()
        .ok()
        .flatten()
        .and_then(|s| s.code())
        .unwrap_or(-1);
    Ok(Outcome::Done { code, output })
}

impl Captured {
    fn render(&self, label: &str) -> String {
        let mut body = self.ring.render(label);
        if let Some(path) = &self.spill {
            body.push_str(&format!(
                "\n\n[Full output ({} bytes) is in {}. Read it if you need the omitted middle.]",
                self.ring.total(),
                path.display()
            ));
        }
        body
    }
}

#[derive(Default)]
pub struct BashTool {
    /// The turn's cancel token. When set, a Stop kills the running command's
    /// whole process group, awaits its exit, and returns the partial output
    /// as a real (error) result. `None` = uncancellable (delegate children,
    /// tests) — the wall-clock timeout still bounds it.
    pub cancel: Option<CancellationToken>,
    /// The session policy, which supplies the sandbox and the in-workspace
    /// directory output spills to. `None` runs unsandboxed with a temp-dir
    /// capture — the tier-3 floor, used by tests and by direct callers.
    pub policy: Option<Arc<ToolPolicy>>,
}

impl BashTool {
    pub fn cancellable(token: CancellationToken) -> Self {
        Self {
            cancel: Some(token),
            policy: None,
        }
    }

    pub fn with_policy(mut self, policy: Arc<ToolPolicy>) -> Self {
        self.policy = Some(policy);
        self
    }

    /// Ask whether to re-run `command` outside the sandbox, and do it if the
    /// user says yes.
    ///
    /// The prompt says the command re-runs **from the start**, because that is
    /// what is being approved: a command that partly succeeded before the
    /// denial will repeat the part that worked.
    ///
    /// Returns `None` when the user declines — the caller then reports the
    /// original denied result, which is the honest outcome.
    async fn offer_escalation(&self, command: &str, ctx: &ToolContext) -> Option<ToolResult> {
        use cersei::tools::permissions::{PermissionDecision, PermissionRequest};

        let request = PermissionRequest {
            tool_name: self.name().to_string(),
            tool_input: serde_json::json!({
                ESCALATION_MARKER: true,
                "command": command,
            }),
            permission_level: PermissionLevel::Dangerous,
            description: format!(
                "The sandbox refused an operation in `{command}`. Run it again outside the                  sandbox? It restarts from the beginning."
            ),
            id: uuid::Uuid::new_v4().to_string(),
        };
        match ctx.permissions.check(&request).await {
            PermissionDecision::Deny(_) => None,
            _ => {
                // Re-enter with the marker set: the sandbox is skipped for this
                // one call, and `ToolPolicy::decide` guarantees the answer was
                // never written to the approval cache.
                let escalated = Self {
                    cancel: self.cancel.clone(),
                    policy: self.policy.clone(),
                };
                Some(
                    escalated
                        .execute(
                            serde_json::json!({
                                ESCALATION_MARKER: true,
                                "command": command,
                            }),
                            ctx,
                        )
                        .await,
                )
            }
        }
    }
}

#[async_trait]
impl Tool for BashTool {
    fn name(&self) -> &str {
        "Bash"
    }
    fn description(&self) -> &str {
        DESCRIPTION
    }
    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::Execute
    }
    fn category(&self) -> ToolCategory {
        ToolCategory::Shell
    }
    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "The shell command to execute" },
                "timeout": { "type": "integer", "description": "Optional timeout in milliseconds (default 120000, max 600000)" }
            },
            "required": ["command"]
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input = coerce::for_schema(input, &self.input_schema());
        // A re-entry after the sandbox refused the command: the user has
        // already been asked, so this run is deliberately unconfined. It applies
        // to this call only and was never cached — see `ESCALATION_MARKER`.
        let escalated = input.get(ESCALATION_MARKER).and_then(Value::as_bool) == Some(true);
        let input: Input = match serde_json::from_value(input) {
            Ok(i) => i,
            Err(e) => {
                return ToolResult::error(errors::decode_failure(
                    "Bash",
                    &e.to_string(),
                    r#"{"command": "cargo build"}"#,
                ))
            }
        };
        let timeout_ms = input.timeout.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS);

        // Sandbox wrapping is the *only* thing that actually bounds what a
        // shell command can touch. Classification decides how often the user is
        // interrupted; this decides what the command can reach.
        let mut argv = vec!["sh".to_string(), "-c".to_string(), input.command.clone()];
        let sandbox = self
            .policy
            .as_ref()
            .filter(|_| !escalated)
            .and_then(|p| p.sandbox().cloned());
        if let Some(sb) = &sandbox {
            argv = sb.wrap(argv);
        }

        let spec = RunSpec {
            argv,
            cwd: ctx.working_dir.clone(),
            spill_dir: self.policy.as_ref().map(|p| p.spill_dir()),
            timeout_ms,
            cancel: self.cancel.clone(),
            max_output: truncate::MAX_OUTPUT_BYTES,

        };

        let result = tokio::task::spawn_blocking(move || run_blocking(spec)).await;

        match result {
            Ok(Ok(Outcome::Done { code, output })) => {
                let body = output.render("Bash output");
                if code == 0 {
                    if body.trim().is_empty() {
                        ToolResult::success("(command completed with no output)")
                    } else {
                        ToolResult::success(body)
                    }
                } else if body.trim().is_empty() {
                    // Nonzero AND silent → a genuine failure with nothing to act on.
                    ToolResult::error(format!(
                        "Command failed with exit code {code} and produced no output."
                    ))
                } else {
                    // Nonzero WITH output is normal for many tools (grep no-match,
                    // diff, test, find on an unreadable entry). Surface it as a
                    // non-error result — the output (and any error text) is visible
                    // and the model decides — rather than flagging a failed call.
                    // A sandbox denial is a decision the user can make, not a
                    // dead end (harness story 6). Ask once; if they agree, the
                    // command re-runs unconfined for this call and nothing is
                    // remembered.
                    if !escalated
                        && sandbox.as_ref().is_some_and(|sb| sb.looks_like_denial(&body))
                    {
                        if let Some(result) = self.offer_escalation(&input.command, ctx).await {
                            return result;
                        }
                    }
                    ToolResult::success(format!("{body}\n\n(Command exited with code {code}.)"))
                }
            }
            Ok(Ok(Outcome::Cancelled { output })) => ToolResult::error(format!(
                "Command cancelled by user (process group killed). Partial output:\n{}",
                output.render("Bash output")
            )),
            Ok(Ok(Outcome::TimedOut { ms, output })) => ToolResult::error(format!(
                "Command timed out after {ms}ms (process killed). Partial output:\n{}\n\n\
                 If this command genuinely needs longer, start it with TerminalStart instead, \
                 which survives the call.",
                output.render("Bash output")
            )),
            Ok(Err(e)) => ToolResult::error(e),
            Err(e) => ToolResult::error(format!("Bash task panicked: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{test_ctx, TmpDir};

    async fn run(dir: &std::path::Path, args: Value) -> ToolResult {
        BashTool::default().execute(args, &test_ctx(dir.to_path_buf())).await
    }

    #[tokio::test]
    async fn echo_and_exit_zero() {
        let tmp = TmpDir::new();
        let r = run(tmp.path(), serde_json::json!({"command": "echo hello"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("hello"));
    }

    #[tokio::test]
    async fn runs_in_working_dir() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("marker.txt"), "x").unwrap();
        let r = run(tmp.path(), serde_json::json!({"command": "ls"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("marker.txt"));
    }

    #[tokio::test]
    async fn nonzero_exit_no_output_is_error() {
        let tmp = TmpDir::new();
        let r = run(tmp.path(), serde_json::json!({"command": "exit 3"})).await;
        assert!(r.is_error);
        assert!(r.content.contains("exit code 3"));
    }

    #[tokio::test]
    async fn nonzero_exit_with_output_is_not_error() {
        let tmp = TmpDir::new();
        // grep no-match exits 1 but is a normal outcome — must not flag a failure.
        let r = run(tmp.path(), serde_json::json!({"command": "echo found; exit 1"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("found"));
        assert!(r.content.contains("exited with code 1"));
    }

    #[tokio::test]
    async fn combined_stderr() {
        let tmp = TmpDir::new();
        let r = run(tmp.path(), serde_json::json!({"command": "echo oops 1>&2"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("oops"));
    }

    #[tokio::test]
    async fn stdout_and_stderr_stay_interleaved() {
        let tmp = TmpDir::new();
        let r = run(
            tmp.path(),
            serde_json::json!({"command": "echo one; echo two 1>&2; echo three"}),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        let one = r.content.find("one").unwrap();
        let two = r.content.find("two").unwrap();
        let three = r.content.find("three").unwrap();
        assert!(one < two && two < three, "chronological order must survive: {}", r.content);
    }

    #[tokio::test]
    async fn cancel_kills_process_group_and_settles_with_partial_output() {
        let tmp = TmpDir::new();
        let token = CancellationToken::new();
        let tool = BashTool::cancellable(token.clone());
        // Emits early output, then sleeps, then would WRITE A FILE — the write
        // must never land once the user cancels mid-sleep.
        let ctx = test_ctx(tmp.path().to_path_buf());
        let fut = tool.execute(
            serde_json::json!({
                "command": "echo started; sleep 20; echo late > after-cancel.txt",
                "timeout": 60000
            }),
            &ctx,
        );
        let killer = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            killer.cancel();
        });
        let started = std::time::Instant::now();
        let r = fut.await;
        // Settled promptly (not after the 20s sleep), as a REAL result…
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        assert!(r.is_error, "{}", r.content);
        assert!(r.content.contains("cancelled"), "{}", r.content);
        // …carrying the partial output produced before the kill…
        assert!(r.content.contains("started"), "{}", r.content);
        // …and the whole process group is dead: the post-sleep write must
        // never appear, even after giving any survivor time to reach it.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert!(
            !tmp.path().join("after-cancel.txt").exists(),
            "process group must be killed — no writes after the settled result"
        );
    }

    #[tokio::test]
    async fn timeout_kills_process() {
        let tmp = TmpDir::new();
        let r = run(tmp.path(), serde_json::json!({"command": "sleep 5", "timeout": 200})).await;
        assert!(r.is_error);
        assert!(r.content.contains("timed out"));
    }

    // ── D5/D6: bounded memory, honest truncation ────────────────────────────

    #[tokio::test]
    async fn large_output_keeps_the_tail() {
        let tmp = TmpDir::new();
        // 50k of noise followed by the thing that actually matters. Head-only
        // truncation threw exactly this away.
        let r = run(
            tmp.path(),
            serde_json::json!({"command": "yes a | head -c 50000; echo THE-REAL-ERROR"}),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("omitted from the middle"), "{}", r.content);
        assert!(
            r.content.contains("THE-REAL-ERROR"),
            "the failing end of the output must survive truncation"
        );
    }

    #[tokio::test]
    async fn truncated_output_reports_the_true_size() {
        let tmp = TmpDir::new();
        let r = run(
            tmp.path(),
            serde_json::json!({"command": "yes a | head -c 100000"}),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(
            r.content.contains("of 100000 bytes omitted") || r.content.contains("of 100001 bytes omitted"),
            "the notice must state the pre-cap size: {}",
            &r.content[..r.content.len().min(400)]
        );
    }

    #[tokio::test]
    async fn the_full_output_spills_where_the_model_may_read_it() {
        let tmp = TmpDir::new();
        let policy = ToolPolicy::contained(tmp.path());
        let tool = BashTool::default().with_policy(policy.clone());
        let r = tool
            .execute(
                serde_json::json!({"command": "yes a | head -c 60000"}),
                &test_ctx(tmp.path().to_path_buf()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("Full output"), "{}", r.content);
        let spill = policy.spill_dir();
        let files: Vec<_> = std::fs::read_dir(&spill).unwrap().filter_map(Result::ok).collect();
        assert_eq!(files.len(), 1, "one retained copy");
        // It is inside the workspace, so the gate lets the model read the file
        // the truncation notice named.
        assert!(policy.contain(&files[0].path().to_string_lossy()).is_ok());
        assert_eq!(std::fs::metadata(files[0].path()).unwrap().len(), 60_000);
        policy.cleanup();
        assert!(!spill.exists(), "session teardown removes spills");
    }

    #[tokio::test]
    async fn output_under_the_cap_leaves_no_file_behind() {
        let tmp = TmpDir::new();
        let policy = ToolPolicy::contained(tmp.path());
        let tool = BashTool::default().with_policy(policy.clone());
        let r = tool
            .execute(
                serde_json::json!({"command": "echo small"}),
                &test_ctx(tmp.path().to_path_buf()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        let files: Vec<_> = std::fs::read_dir(policy.spill_dir())
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert!(
            files.is_empty(),
            "an uncapped command must leave nothing in the workspace — otherwise every \
             shell call churns the user's git status and file watchers: {files:?}"
        );
    }

    #[tokio::test]
    async fn a_progress_line_reaches_the_model_rendered() {
        // No TTY is attached here, so most tools turn their spinner off — but
        // `--color=always`, `--progress` and anything drawing with `\r` do not
        // ask, and raw cursor movements cost the model its context window.
        let tmp = TmpDir::new();
        let r = run(
            tmp.path(),
            serde_json::json!({
                "command": r"printf '\033[1G\033[0K1\033[1G\033[0K2\033[1G\033[0K3\033[1G\033[0Kadded 312 packages\n'",
                "timeout": 10000
            }),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("added 312 packages"), "{}", r.content);
        assert!(!r.content.contains('\u{1b}'), "raw escapes reached the model: {:?}", r.content);
        assert!(!r.content.contains("1added"), "a frame survived: {:?}", r.content);
    }

    #[tokio::test]
    async fn colour_is_dropped_and_its_text_kept() {
        let tmp = TmpDir::new();
        let r = run(
            tmp.path(),
            serde_json::json!({
                "command": r"printf '\033[31mERROR\033[0m: build failed\n'",
                "timeout": 10000
            }),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("ERROR: build failed"), "{:?}", r.content);
    }

    #[tokio::test]
    async fn output_without_a_trailing_newline_is_not_lost() {
        // Rendering commits on a newline, so the last line of a command that
        // does not print one has to be flushed when the child exits.
        let tmp = TmpDir::new();
        let r = run(
            tmp.path(),
            serde_json::json!({"command": "printf 'no trailing newline'", "timeout": 10000}),
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("no trailing newline"), "{:?}", r.content);
    }

    #[tokio::test]
    async fn a_gigabyte_of_output_does_not_exhaust_memory() {
        let tmp = TmpDir::new();
        // 256 MB through the ring. If this were buffered whole the test host
        // would feel it; with the ring, resident output is ~30 KB.
        let r = run(
            tmp.path(),
            serde_json::json!({
                "command": "yes 0123456789abcdef | head -c 268435456",
                "timeout": 120000
            }),
        )
        .await;
        assert!(!r.is_error, "{}", &r.content[..r.content.len().min(300)]);
        assert!(r.content.len() < 100_000, "returned {} bytes", r.content.len());
        assert!(r.content.contains("of 268435456 bytes omitted"), "{}", &r.content[..400]);
    }
}

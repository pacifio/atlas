//! Persistent terminal sessions (tool spec D10).
//!
//! The one-shot shell tool cannot host a dev server, a REPL, an interactive
//! installer, or a build that outlives its timeout: it starts a process, waits,
//! kills it, and returns. These two tools are the missing half.
//!
//! **Two surfaces rather than one with a mode flag.** `TerminalStart` launches a
//! command and, if the process is still alive at the yield deadline, hands back
//! a session id. `TerminalWrite` sends input to a live session and returns
//! whatever it has produced since the last call — with an empty `input` it
//! polls without sending anything, which is how the agent watches a build.
//!
//! **A PTY is always allocated.** Codex defaults terminal allocation off and
//! consequently rejects writes to the session; interactivity is the entire
//! reason this tool exists, so here it is unconditional. It also means
//! `npm create`, `cargo login`, and anything else that checks `isatty` behaves
//! the way it does in a real terminal.
//!
//! **Timeouts are per call, not per session.** A process outlives the call that
//! started it and ends on its own exit, on eviction, or at session teardown.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use cersei::tools::{PermissionLevel, Tool, ToolCategory, ToolContext, ToolResult};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Deserialize;
use serde_json::Value;

use super::policy::ToolPolicy;
use super::screen::Screen;
use super::{coerce, errors};

/// How long `TerminalStart` waits before deciding the process is long-running
/// and handing back a session id instead of a final result.
const DEFAULT_YIELD_MS: u64 = 3_000;
const MAX_YIELD_MS: u64 = 60_000;
/// How long a poll waits for *new* output before returning empty.
const DEFAULT_POLL_MS: u64 = 2_000;
const MAX_POLL_MS: u64 = 60_000;
/// How long a write may block before the session is declared unresponsive.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

/// Soft cap on live sessions. Above it, eviction runs.
const SESSION_SOFT_CAP: usize = 8;
/// The most recently used sessions are never evicted.
const PROTECTED: usize = 3;
/// How long a session may claim to be busy before eviction stops believing it.
///
/// `busy` is set on entry to a call and cleared on the way out. If a call
/// panics between those points the flag sticks, and a session nothing can evict
/// is a process nothing reaps. Bounding it costs nothing — a genuinely active
/// call refreshes `last_used` every poll, and the longest a single call can run
/// is [`MAX_POLL_MS`].
const BUSY_TRUST: Duration = Duration::from_secs(180);


struct Session {
    /// The cersei session that owns it, so teardown can sweep.
    owner: String,
    command: String,
    /// Behind its own lock so a write happens with the global [`STORE`] lock
    /// *released* — a PTY whose child stopped reading blocks the writer on a
    /// full kernel buffer, and blocking there while holding `STORE` deadlocked
    /// every other terminal call in the process.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    pending: Arc<Mutex<Screen>>,
    /// Set by the reader thread when the PTY master reaches EOF — every byte
    /// the process ever wrote is now in `pending`.
    eof: Arc<std::sync::atomic::AtomicBool>,
    last_used: Instant,
    /// Set while a call is inside this session, so eviction cannot pull the
    /// session out from under an in-flight interaction.
    busy: bool,
    /// Recorded once the process is reaped, so a later poll can still report it.
    exit: Option<String>,
}

impl Session {
    /// Whether the process has finished, reaping it if so.
    fn finished(&mut self) -> Option<String> {
        if self.exit.is_some() {
            return self.exit.clone();
        }
        match self.child.try_wait() {
            Ok(Some(status)) => {
                let code = status.exit_code();
                self.exit = Some(format!("exited with code {code}"));
                self.exit.clone()
            }
            _ => None,
        }
    }

    fn kill(&mut self) {
        // The whole process group, mirroring `bash.rs`: a PTY child is its
        // session leader, so `sh -c "npm run dev"` and every worker it spawned
        // share its pgid. `child.kill()` alone HUPs the direct child and
        // orphans anything that called setpgid or ignores SIGHUP — and an
        // orphan holding the slave open means the reader thread never sees EOF
        // and leaks. SIGKILL to the group first also makes the fallback's
        // reap immediate instead of a graceful-shutdown sleep loop run while
        // callers hold the store lock.
        #[cfg(unix)]
        if let Some(pid) = self.child.process_id() {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Process-global store. Sessions must survive across turns, so this cannot
/// live on anything the turn owns.
static STORE: LazyLock<Mutex<HashMap<String, Session>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Terminate every session belonging to `owner`. Called at session teardown.
pub fn shutdown_owner(owner: &str) {
    let mut store = STORE.lock();
    let ids: Vec<String> = store
        .iter()
        .filter(|(_, s)| s.owner == owner)
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        if let Some(mut s) = store.remove(&id) {
            s.kill();
        }
    }
}

/// Bring the store back under the soft cap.
///
/// Exited sessions go first, oldest by last use; only then live ones. The most
/// recently used are protected, and a session with a call inside it is never
/// evicted.
fn evict(store: &mut HashMap<String, Session>) {
    if store.len() <= SESSION_SOFT_CAP {
        return;
    }
    let mut ranked: Vec<(String, Instant, bool, bool)> = store
        .iter_mut()
        .map(|(id, s)| {
            let done = s.finished().is_some();
            let busy = s.busy && s.last_used.elapsed() < BUSY_TRUST;
            (id.clone(), s.last_used, done, busy)
        })
        .collect();
    // Most recent first, so the protected prefix is easy to name.
    ranked.sort_by_key(|r| std::cmp::Reverse(r.1));
    let protected: std::collections::HashSet<String> =
        ranked.iter().take(PROTECTED).map(|r| r.0.clone()).collect();

    // Exited before live; within each, least recently used first.
    let mut candidates: Vec<&(String, Instant, bool, bool)> = ranked
        .iter()
        .filter(|(id, _, _, busy)| !busy && !protected.contains(id))
        .collect();
    candidates.sort_by(|a, b| b.2.cmp(&a.2).then(a.1.cmp(&b.1)));

    for (id, _, _, _) in candidates {
        if store.len() <= SESSION_SOFT_CAP {
            break;
        }
        if let Some(mut s) = store.remove(id) {
            s.kill();
        }
    }
}

/// Spawn `command` under a PTY and register it.
///
/// `sandbox` wraps the command exactly as it does for the one-shot shell. A
/// persistent terminal that skipped the sandbox would be a way to run anything
/// the sandbox exists to bound — a longer-lived hole than the one-shot tool,
/// not a smaller one.
fn spawn(
    owner: &str,
    command: &str,
    cwd: &std::path::Path,
    sandbox: Option<&super::sandbox::Sandbox>,
) -> Result<String, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 40,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut argv = vec!["sh".to_string(), "-c".to_string(), command.to_string()];
    if let Some(sb) = sandbox {
        argv = sb.wrap(argv);
    }
    let mut cmd = CommandBuilder::new(&argv[0]);
    for arg in &argv[1..] {
        cmd.arg(arg);
    }
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    // Nothing here should try to page its output at an agent.
    cmd.env("PAGER", "cat");
    cmd.env("GIT_PAGER", "cat");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // Drop the slave so a read on the master sees EOF when the child exits.
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let pending = Arc::new(Mutex::new(Screen::new()));
    let eof = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let sink = pending.clone();
    let eof_flag = eof.clone();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => sink.lock().push(&buf[..n]),
                Err(_) => break,
            }
        }
        eof_flag.store(true, std::sync::atomic::Ordering::SeqCst);
    });

    let id = uuid::Uuid::new_v4().to_string();
    let mut store = STORE.lock();
    store.insert(
        id.clone(),
        Session {
            owner: owner.to_string(),
            command: command.to_string(),
            writer: Arc::new(Mutex::new(writer)),
            child,
            pending,
            eof,
            last_used: Instant::now(),
            busy: true,
            exit: None,
        },
    );
    evict(&mut store);
    Ok(id)
}

/// How long after the process exits to wait for the reader thread to drain the
/// last PTY bytes, when EOF has not been seen yet. Exit can be observed before
/// the final output crosses the PTY, and taking the buffer at that instant
/// discarded the tail — for a failing build, the error summary.
const DRAIN_GRACE: Duration = Duration::from_millis(300);

/// Wait until the session produces output, exits (and drains), or `deadline`
/// passes.
async fn wait_for(id: &str, deadline: Duration) -> (String, Option<String>, u64) {
    let start = Instant::now();
    let mut idle = Duration::from_millis(10);
    let mut exit_seen: Option<Instant> = None;
    let mut last_seen: Option<(usize, u64, usize, usize)> = None;
    loop {
        {
            let mut store = STORE.lock();
            let Some(session) = store.get_mut(id) else {
                return (String::new(), Some("session gone".to_string()), 0);
            };
            let exit = session.finished();
            if exit.is_some() && exit_seen.is_none() {
                exit_seen = Some(Instant::now());
            }
            let drained = session.eof.load(std::sync::atomic::Ordering::SeqCst)
                || exit_seen.is_some_and(|t| t.elapsed() >= DRAIN_GRACE);
            let (ready, print) = {
                let screen = session.pending.lock();
                (!screen.is_empty(), screen.fingerprint())
            };
            // "Settled" means output is present AND nothing new arrived since
            // the previous look — returning at the first byte handed back a
            // PTY's echo of the input while the actual response was milliseconds
            // behind it.
            let stable = ready && last_seen == Some(print);
            last_seen = Some(print);
            let settle = match &exit {
                // Exited: hold on (briefly) until the reader reports EOF, so
                // the final bytes are returned with the exit status instead of
                // being discarded with the session.
                Some(_) => drained,
                None => stable || start.elapsed() >= deadline,
            };
            if settle {
                let (text, dropped) = session.pending.lock().take();
                session.last_used = Instant::now();
                return (text, exit, dropped);
            }
        }
        tokio::time::sleep(idle).await;
        idle = (idle * 2).min(Duration::from_millis(100));
    }
}

fn release(id: &str) {
    if let Some(session) = STORE.lock().get_mut(id) {
        session.busy = false;
        session.last_used = Instant::now();
    }
}

fn render(command: &str, id: &str, text: &str, exit: Option<&str>, dropped: u64) -> String {
    let mut out = String::new();
    match (exit, text.is_empty()) {
        (Some(status), _) => out.push_str(&format!("Session {id} ({command}) {status}.\n")),
        // A live session with nothing new to say. The old text said only "is
        // still running" and invited another read, so a model asked to start a
        // dev server polled it six times: `npm run dev` never exits, so "is it
        // done yet" has no answer it can reach by asking again.
        //
        // Both readings are offered because the harness genuinely cannot tell
        // them apart — a server that has finished starting and a process
        // blocked on stdin are the same silence from out here. What it *can*
        // say for certain is that another identical read changes nothing, and
        // that is the part that stops the loop.
        (None, true) => out.push_str(&format!(
            "Session {id} ({command}) is still running and has produced no new output since \
             the last read. Reading again will not change that.\n\
             If this is a server, watcher or dev build, going quiet is what starting \
             successfully looks like — say so and move on. If it is waiting for input, send \
             that input with this session_id.\n"
        )),
        (None, false) => out.push_str(&format!(
            "Session {id} ({command}) is still running.\n\
             Use TerminalWrite with this session_id to send input, or with an empty input to \
             read more output.\n"
        )),
    }
    if dropped > 0 {
        out.push_str(&format!(
            "[{dropped} bytes of older output were dropped — the session produced more than \
             could be held.]\n"
        ));
    }
    if !text.is_empty() {
        out.push('\n');
        out.push_str(text);
    }
    out
}

// ─── TerminalStart ──────────────────────────────────────────────────────────

const START_DESCRIPTION: &str = "Runs a command in a terminal session that outlives this call: \
a dev server, a REPL, a watcher, an interactive installer, or a build too slow for Bash. A TTY \
is always allocated.\n\
- Still running at `timeout` → returns a session_id and the output so far; pass it to \
TerminalWrite.\n\
- Finished first → returns its full output and exit status, and keeps no session.\n\
- Use Bash for a command that just runs and finishes.";

#[derive(Deserialize)]
struct StartInput {
    command: String,
    timeout: Option<u64>,
}

#[derive(Default)]
pub struct TerminalStartTool {
    /// The session policy, which supplies the sandbox. `None` runs unsandboxed
    /// — the tier-3 floor, used by tests and direct callers.
    pub policy: Option<Arc<ToolPolicy>>,
}

#[async_trait]
impl Tool for TerminalStartTool {
    fn name(&self) -> &str {
        "TerminalStart"
    }
    fn description(&self) -> &str {
        START_DESCRIPTION
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
                "command": { "type": "string", "description": "The command to start" },
                "timeout": { "type": "integer", "description": "Milliseconds to wait before yielding a session_id (default 3000, max 60000)" }
            },
            "required": ["command"]
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input = coerce::for_schema(input, &self.input_schema());
        let input: StartInput = match serde_json::from_value(input) {
            Ok(i) => i,
            Err(e) => {
                return ToolResult::error(errors::decode_failure(
                    "TerminalStart",
                    &e.to_string(),
                    r#"{"command": "npm run dev"}"#,
                ))
            }
        };
        let yield_ms = input.timeout.unwrap_or(DEFAULT_YIELD_MS).min(MAX_YIELD_MS);

        let sandbox = self.policy.as_ref().and_then(|p| p.sandbox());
        // Ownership keys teardown: `shutdown_owner` is called with the Atlas
        // session id the policy was built for. `ToolContext::session_id` is a
        // fallback for direct callers (tests) — in production it only matches
        // because the runtime also sets it on the agent builder, and relying on
        // that alone is how teardown silently swept nothing.
        let owner = self
            .policy
            .as_ref()
            .map(|p| p.session().to_string())
            .unwrap_or_else(|| ctx.session_id.clone());
        let id = match spawn(&owner, &input.command, &ctx.working_dir, sandbox) {
            Ok(id) => id,
            Err(e) => return ToolResult::error(format!("Failed to start a terminal session: {e}")),
        };

        // Keep collecting until the process exits or the yield deadline passes,
        // rather than returning at the first byte of output — a build that
        // prints one line and keeps going should not look finished.
        let deadline = Instant::now() + Duration::from_millis(yield_ms);
        let mut collected = String::new();
        let mut dropped_total = 0u64;
        let mut exit = None;
        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let (text, status, dropped) = wait_for(&id, remaining.min(Duration::from_millis(250))).await;
            collected.push_str(&text);
            dropped_total += dropped;
            if status.is_some() {
                exit = status;
                break;
            }
        }
        if exit.is_none() {
            // One last sweep so nothing produced in the final instant is lost.
            let (text, status, dropped) = wait_for(&id, Duration::ZERO).await;
            collected.push_str(&text);
            dropped_total += dropped;
            exit = status;
        }

        release(&id);
        let body = render(&input.command, &id, &collected, exit.as_deref(), dropped_total);
        if exit.is_some() {
            // Finished within the deadline: nothing to keep.
            if let Some(mut s) = STORE.lock().remove(&id) {
                s.kill();
            }
        }
        ToolResult::success(body)
    }
}

// ─── TerminalWrite ──────────────────────────────────────────────────────────

const WRITE_DESCRIPTION: &str = "Sends input to a running terminal session and returns what it \
produced since the last call.\n\
- Append \\n to submit a line.\n\
- Empty input polls: nothing is sent, new output is returned. This is how you watch a build or \
wait for a server.\n\
- Output is delivered once; the next call returns only what is new.";

#[derive(Deserialize)]
struct WriteInput {
    session_id: String,
    #[serde(default)]
    input: String,
    timeout: Option<u64>,
}

pub struct TerminalWriteTool;

#[async_trait]
impl Tool for TerminalWriteTool {
    fn name(&self) -> &str {
        "TerminalWrite"
    }
    fn description(&self) -> &str {
        WRITE_DESCRIPTION
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
                "session_id": { "type": "string", "description": "Session id returned by TerminalStart" },
                "input": { "type": "string", "description": "Text to send. Empty polls for new output without sending anything." },
                "timeout": { "type": "integer", "description": "Milliseconds to wait for new output (default 2000, max 60000)" }
            },
            "required": ["session_id"]
        })
    }

    async fn execute(&self, input: Value, _ctx: &ToolContext) -> ToolResult {
        let input = coerce::for_schema(input, &self.input_schema());
        let input: WriteInput = match serde_json::from_value(input) {
            Ok(i) => i,
            Err(e) => {
                return ToolResult::error(errors::decode_failure(
                    "TerminalWrite",
                    &e.to_string(),
                    r#"{"session_id": "<from TerminalStart>", "input": "y\n"}"#,
                ))
            }
        };

        // The store lock is held only long enough to fetch handles. The write
        // itself happens off it, in a blocking task with a timeout: a PTY
        // whose child is not reading blocks the writer on a full kernel
        // buffer, and blocking there while holding `STORE` deadlocked every
        // other terminal call in the process.
        let (command, writer) = {
            let mut store = STORE.lock();
            let Some(session) = store.get_mut(&input.session_id) else {
                return ToolResult::error(format!(
                    "No terminal session '{}'. It either finished, was never started, or was \
                     evicted to make room. Start a new one with TerminalStart.",
                    input.session_id
                ));
            };
            session.busy = true;
            (session.command.clone(), session.writer.clone())
        };
        if !input.input.is_empty() {
            let bytes = input.input.clone().into_bytes();
            let write = tokio::task::spawn_blocking(move || {
                let mut w = writer.lock();
                w.write_all(&bytes).and_then(|()| w.flush())
            });
            let failure: Option<String> = match tokio::time::timeout(WRITE_TIMEOUT, write).await {
                Ok(Ok(Ok(()))) => None,
                Ok(Ok(Err(e))) => Some(format!("Failed to write to the session: {e}")),
                Ok(Err(e)) => Some(format!("Failed to write to the session: {e}")),
                Err(_) => Some(format!(
                    "The session did not accept input within {}s — its process is not \
                     reading (a full buffer, or a program not waiting for input). Poll it \
                     with an empty input, or terminate it with TerminalKill.",
                    WRITE_TIMEOUT.as_secs()
                )),
            };
            if let Some(message) = failure {
                release(&input.session_id);
                return ToolResult::error(message);
            }
        }

        let poll_ms = input.timeout.unwrap_or(DEFAULT_POLL_MS).min(MAX_POLL_MS);
        let (text, exit, dropped) = wait_for(&input.session_id, Duration::from_millis(poll_ms)).await;
        release(&input.session_id);
        let body = render(&command, &input.session_id, &text, exit.as_deref(), dropped);
        if exit.is_some() {
            if let Some(mut s) = STORE.lock().remove(&input.session_id) {
                s.kill();
            }
        }
        ToolResult::success(body)
    }
}

// ─── TerminalKill ───────────────────────────────────────────────────────────

const KILL_DESCRIPTION: &str = "Terminates a terminal session started by TerminalStart, killing \
its whole process tree. Use when a session is done, stuck, or no longer needed.";

#[derive(Deserialize)]
struct KillInput {
    session_id: String,
}

#[derive(Default)]
pub struct TerminalKillTool {
    /// Supplies the owner identity, so this tool can only end sessions its own
    /// agent started. `None` (tests, direct callers) falls back to
    /// `ctx.session_id`, mirroring `TerminalStart`.
    pub policy: Option<Arc<ToolPolicy>>,
}

#[async_trait]
impl Tool for TerminalKillTool {
    fn name(&self) -> &str {
        "TerminalKill"
    }
    fn description(&self) -> &str {
        KILL_DESCRIPTION
    }
    // No prompt — but only because the ownership check below bounds it to
    // sessions this agent started. Promptless plus unbounded would have been a
    // cross-session kill by id.
    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::None
    }
    fn category(&self) -> ToolCategory {
        ToolCategory::Shell
    }
    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "session_id": { "type": "string", "description": "Session id returned by TerminalStart" }
            },
            "required": ["session_id"]
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input = coerce::for_schema(input, &self.input_schema());
        let input: KillInput = match serde_json::from_value(input) {
            Ok(i) => i,
            Err(e) => {
                return ToolResult::error(errors::decode_failure(
                    "TerminalKill",
                    &e.to_string(),
                    r#"{"session_id": "<from TerminalStart>"}"#,
                ))
            }
        };
        let caller = self
            .policy
            .as_ref()
            .map(|p| p.session().to_string())
            .unwrap_or_else(|| ctx.session_id.clone());
        let session = {
            let mut store = STORE.lock();
            match store.get(&input.session_id) {
                Some(s) if s.owner != caller => {
                    return ToolResult::error(format!(
                        "Session '{}' belongs to a different agent session and cannot be \
                         terminated from this one.",
                        input.session_id
                    ));
                }
                Some(_) => store.remove(&input.session_id),
                None => None,
            }
        };
        match session {
            Some(mut s) => {
                let command = s.command.clone();
                s.kill();
                ToolResult::success(format!(
                    "Terminated session {} ({command}).",
                    input.session_id
                ))
            }
            None => ToolResult::success(format!(
                "No session '{}' — it already finished or was never started. Nothing to do.",
                input.session_id
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{test_ctx, TmpDir};
    use serde_json::json;

    fn session_id_from(body: &str) -> String {
        body.split_whitespace()
            .nth(1)
            .expect("session id in the first line")
            .to_string()
    }

    #[tokio::test]
    async fn a_progress_spinner_reaches_the_model_as_one_line() {
        // End to end through a real PTY. `npm install` draws its spinner with
        // exactly this: cursor to column 1, erase to end of line, one glyph —
        // and unrendered it spent 172.8K tokens of one session's context.
        let tmp = TmpDir::new();
        let script = r"for i in 1 2 3 4 5 6 7 8 9 10; do printf '\033[1G\033[0K%s' $i; done; printf '\033[1G\033[0Kadded 312 packages\n'";
        let r = TerminalStartTool::default()
            .execute(
                json!({"command": format!("sh -c \"{script}\""), "timeout": 5000}),
                &test_ctx(tmp.path().to_path_buf()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("added 312 packages"), "{}", r.content);
        assert!(
            !r.content.contains('\u{1b}'),
            "raw escape sequences reached the model: {:?}",
            r.content
        );
        // The intermediate frames are gone, not merely hidden.
        for frame in ["1", "2", "3", "4", "5", "6", "7", "8", "9"] {
            assert!(
                !r.content.contains(&format!("{frame}added")),
                "a spinner frame survived: {:?}",
                r.content
            );
        }
    }

    #[tokio::test]
    async fn a_finished_command_returns_its_output_and_no_session() {
        let tmp = TmpDir::new();
        let r = TerminalStartTool::default()
            .execute(
                json!({"command": "echo hello-terminal", "timeout": 5000}),
                &test_ctx(tmp.path().to_path_buf()),
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("hello-terminal"), "{}", r.content);
        assert!(r.content.contains("exited with code 0"), "{}", r.content);
        // Asserted on this session rather than on the store's size: the suite
        // runs in parallel and other tests hold sessions of their own.
        let id = session_id_from(&r.content);
        assert!(
            !STORE.lock().contains_key(&id),
            "a finished command keeps no session"
        );
    }

    #[tokio::test]
    async fn a_long_running_command_yields_a_session_that_survives_the_call() {
        let tmp = TmpDir::new();
        let ctx = test_ctx(tmp.path().to_path_buf());
        let r = TerminalStartTool::default()
            .execute(
                json!({"command": "echo ready; sleep 30", "timeout": 1500}),
                &ctx,
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("still running"), "{}", r.content);
        assert!(r.content.contains("ready"), "{}", r.content);
        let id = session_id_from(&r.content);
        assert!(STORE.lock().contains_key(&id), "the session outlived the call");

        // A poll returns only what is new — the already-delivered "ready" must
        // not come back a second time. (The header echoes the command, so the
        // assertion is on the body: everything after the header is empty.)
        let poll = TerminalWriteTool
            .execute(json!({"session_id": id, "timeout": 300}), &ctx)
            .await;
        assert!(!poll.is_error, "{}", poll.content);
        // The header echoes the command, which contains the word — so the
        // check is that it appears once (there) and not twice (re-delivered).
        assert_eq!(
            poll.content.matches("ready").count(),
            1,
            "output was re-delivered: {}",
            poll.content
        );
        // And the poll tells the model what the quiet means, instead of
        // inviting it to ask again.
        assert!(
            poll.content.contains("no new output since the last read"),
            "{}",
            poll.content
        );
        assert!(poll.content.contains("Reading again will not change that"), "{}", poll.content);

        shutdown_owner(&ctx.session_id);
        assert!(!STORE.lock().contains_key(&id), "teardown terminates everything");
    }

    #[tokio::test]
    async fn input_reaches_the_process() {
        let tmp = TmpDir::new();
        let mut ctx = test_ctx(tmp.path().to_path_buf());
        ctx.session_id = "input-test".into();
        let r = TerminalStartTool::default()
            .execute(
                json!({"command": "read line; echo GOT:$line; sleep 5", "timeout": 800}),
                &ctx,
            )
            .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("still running"), "{}", r.content);
        let id = session_id_from(&r.content);

        let w = TerminalWriteTool
            .execute(json!({"session_id": id, "input": "abc\n", "timeout": 3000}), &ctx)
            .await;
        assert!(!w.is_error, "{}", w.content);
        assert!(w.content.contains("GOT:abc"), "{}", w.content);
        shutdown_owner("input-test");
    }

    #[tokio::test]
    async fn teardown_sweeps_by_the_policy_session_not_the_runner_context() {
        // In production `ToolContext::session_id` is whatever the runner set —
        // historically a fresh UUID per turn, which `shutdown_owner(<atlas
        // session id>)` could never match, so killing an agent never terminated
        // its terminals. Ownership now comes from the policy, which carries the
        // same session name teardown sweeps by. The ctx deliberately gets a
        // DIFFERENT id here: the sweep must work anyway.
        let tmp = TmpDir::new();
        let policy = crate::tools::ToolPolicy::contained_for(tmp.path(), "atlas-session-7");
        let mut ctx = test_ctx(tmp.path().to_path_buf());
        ctx.session_id = "runner-minted-uuid".into();
        let r = TerminalStartTool {
            policy: Some(policy),
        }
        .execute(json!({"command": "sleep 30", "timeout": 300}), &ctx)
        .await;
        assert!(!r.is_error, "{}", r.content);
        let id = session_id_from(&r.content);
        assert!(STORE.lock().contains_key(&id), "session should be live");

        // Sweeping by the runner's id must NOT match…
        shutdown_owner("runner-minted-uuid");
        assert!(STORE.lock().contains_key(&id), "wrong owner key swept the session");
        // …and sweeping by the Atlas session id must.
        shutdown_owner("atlas-session-7");
        assert!(
            !STORE.lock().contains_key(&id),
            "teardown by the policy's session name must terminate the terminal"
        );
    }

    #[tokio::test]
    async fn kill_terminates_a_live_session_and_its_tree() {
        let tmp = TmpDir::new();
        let ctx = test_ctx(tmp.path().to_path_buf());
        let r = TerminalStartTool::default()
            .execute(json!({"command": "sleep 60", "timeout": 300}), &ctx)
            .await;
        assert!(!r.is_error, "{}", r.content);
        let id = session_id_from(&r.content);
        assert!(STORE.lock().contains_key(&id));

        // A different agent session must not be able to end it — TerminalKill
        // is promptless precisely because it is bounded to its own sessions.
        let foreign = crate::tools::ToolPolicy::contained_for(tmp.path(), "someone-else");
        let refused = TerminalKillTool {
            policy: Some(foreign),
        }
        .execute(json!({"session_id": id.clone()}), &ctx)
        .await;
        assert!(refused.is_error, "{}", refused.content);
        assert!(STORE.lock().contains_key(&id), "a foreign kill must not land");

        let k = TerminalKillTool::default()
            .execute(json!({"session_id": id}), &ctx)
            .await;
        assert!(!k.is_error, "{}", k.content);
        assert!(k.content.contains("Terminated"), "{}", k.content);
        assert!(!STORE.lock().contains_key(&id), "the session must be gone");

        // Killing again is a no-op with a plain answer, not an error the
        // model has to reason its way out of.
        let again = TerminalKillTool::default()
            .execute(json!({"session_id": id}), &ctx)
            .await;
        assert!(!again.is_error, "{}", again.content);
        assert!(again.content.contains("Nothing to do"), "{}", again.content);
    }

    #[tokio::test]
    async fn the_final_output_of_a_finishing_command_is_not_dropped() {
        // Exit can be observed before the last bytes cross the PTY; taking the
        // buffer at that instant discarded the tail — for a failing build, the
        // error summary. wait_for now drains to EOF (or a short grace) first.
        let tmp = TmpDir::new();
        let ctx = test_ctx(tmp.path().to_path_buf());
        for _ in 0..5 {
            let r = TerminalStartTool::default()
                .execute(
                    json!({"command": "echo FIRST; echo THE-LAST-LINE", "timeout": 5000}),
                    &ctx,
                )
                .await;
            assert!(!r.is_error, "{}", r.content);
            assert!(r.content.contains("exited with code 0"), "{}", r.content);
            assert!(
                r.content.contains("THE-LAST-LINE"),
                "the tail was discarded with the session: {}",
                r.content
            );
        }
    }

    #[tokio::test]
    async fn writing_to_an_unknown_session_is_a_correctable_error() {
        let tmp = TmpDir::new();
        let r = TerminalWriteTool
            .execute(
                json!({"session_id": "not-a-session", "input": "x"}),
                &test_ctx(tmp.path().to_path_buf()),
            )
            .await;
        assert!(r.is_error);
        assert!(r.content.contains("TerminalStart"), "{}", r.content);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn a_terminal_session_is_sandboxed_like_the_one_shot_shell() {
        // It was not: `spawn` built `sh -c` directly, so at tier 0 a
        // `TerminalStart` reached paths the identical `Bash` call was denied —
        // a longer-lived hole than the one-shot tool, not a smaller one.
        let tmp = TmpDir::new();
        let policy = crate::tools::ToolPolicy::new(tmp.path(), "sandboxed-terminal");
        if policy.sandbox().is_none() {
            return; // no sandbox-exec on this host
        }
        let mut ctx = test_ctx(tmp.path().to_path_buf());
        ctx.session_id = "sandboxed-terminal".into();
        let r = TerminalStartTool {
            policy: Some(policy),
        }
        .execute(
            json!({
                "command": "ls ~/Library/Keychains >/dev/null 2>&1 && echo REACHED || echo denied",
                "timeout": 5000
            }),
            &ctx,
        )
        .await;
        assert!(!r.is_error, "{}", r.content);
        assert!(
            r.content.contains("denied"),
            "the terminal reached a path the sandbox denies Bash: {}",
            r.content
        );
        shutdown_owner("sandboxed-terminal");
    }

    #[test]
    fn eviction_takes_exited_sessions_before_live_ones() {
        // Exercised directly on the ranking, so the test needs no real
        // processes and cannot be flaky.
        let now = Instant::now();
        let mut ranked: Vec<(String, Instant, bool, bool)> = vec![
            ("live-old".into(), now - Duration::from_secs(100), false, false),
            ("exited-new".into(), now - Duration::from_secs(1), true, false),
        ];
        ranked.sort_by(|a, b| b.2.cmp(&a.2).then(a.1.cmp(&b.1)));
        assert_eq!(ranked[0].0, "exited-new", "an exited session goes first");
    }

    #[test]
    fn a_sessions_output_is_rendered_not_replayed() {
        // A session's buffer holds what a reader would SEE. `screen.rs` owns
        // the rendering and its bounds; this pins that the terminal tool wires
        // it in, because handing the raw stream to the model is what spent
        // 172.8K tokens on an npm spinner.
        let mut p = Screen::new();
        for frame in 0..2_000 {
            p.push(b"\x1b[1G\x1b[0K");
            p.push(&[b"|/-\\\\"[frame % 4]]);
        }
        p.push(b"\x1b[1G\x1b[0Kadded 312 packages\n");
        let (text, _) = p.take();
        assert_eq!(text, "added 312 packages\n");
        // And taking twice does not re-deliver.
        assert_eq!(p.take().0, "");
    }
}

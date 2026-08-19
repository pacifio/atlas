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

use std::collections::{HashMap, VecDeque};
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
use super::{coerce, errors};

/// How long `TerminalStart` waits before deciding the process is long-running
/// and handing back a session id instead of a final result.
const DEFAULT_YIELD_MS: u64 = 3_000;
const MAX_YIELD_MS: u64 = 60_000;
/// How long a poll waits for *new* output before returning empty.
const DEFAULT_POLL_MS: u64 = 2_000;
const MAX_POLL_MS: u64 = 60_000;

/// Bytes of undelivered output held per session. Beyond this the oldest is
/// dropped and counted — a dev server left running for an hour must not grow
/// without bound.
const PENDING_CAP: usize = 256 * 1024;

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

/// Output a session has produced but not yet handed to the model.
struct Pending {
    buf: VecDeque<u8>,
    /// Bytes dropped from the front because the buffer was full.
    dropped: u64,
}

impl Pending {
    fn new() -> Self {
        Self {
            buf: VecDeque::new(),
            dropped: 0,
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        self.buf.extend(chunk);
        while self.buf.len() > PENDING_CAP {
            self.buf.pop_front();
            self.dropped += 1;
        }
    }

    /// Drain everything pending. Delivered output is removed, so a second call
    /// returns only what is new.
    fn take(&mut self) -> (String, u64) {
        let bytes: Vec<u8> = self.buf.drain(..).collect();
        let dropped = std::mem::take(&mut self.dropped);
        // Lossy is right for terminal output: it can legitimately be binary,
        // and unlike a file read there is no path by which it is written back
        // into source.
        (String::from_utf8_lossy(&bytes).into_owned(), dropped)
    }

    fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}

struct Session {
    /// The cersei session that owns it, so teardown can sweep.
    owner: String,
    command: String,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    pending: Arc<Mutex<Pending>>,
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
    let pending = Arc::new(Mutex::new(Pending::new()));

    let sink = pending.clone();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => sink.lock().push(&buf[..n]),
                Err(_) => break,
            }
        }
    });

    let id = uuid::Uuid::new_v4().to_string();
    let mut store = STORE.lock();
    store.insert(
        id.clone(),
        Session {
            owner: owner.to_string(),
            command: command.to_string(),
            writer,
            child,
            pending,
            last_used: Instant::now(),
            busy: true,
            exit: None,
        },
    );
    evict(&mut store);
    Ok(id)
}

/// Wait until the session produces output, exits, or `deadline` passes.
async fn wait_for(id: &str, deadline: Duration) -> (String, Option<String>, u64) {
    let start = Instant::now();
    let mut idle = Duration::from_millis(10);
    loop {
        {
            let mut store = STORE.lock();
            let Some(session) = store.get_mut(id) else {
                return (String::new(), Some("session gone".to_string()), 0);
            };
            let exit = session.finished();
            let ready = !session.pending.lock().is_empty();
            if exit.is_some() || ready || start.elapsed() >= deadline {
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
    match exit {
        Some(status) => out.push_str(&format!("Session {id} ({command}) {status}.\n")),
        None => out.push_str(&format!(
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
    if text.is_empty() {
        out.push_str("(no new output)");
    } else {
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
        let id = match spawn(&ctx.session_id, &input.command, &ctx.working_dir, sandbox) {
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

        let command = {
            let mut store = STORE.lock();
            let Some(session) = store.get_mut(&input.session_id) else {
                return ToolResult::error(format!(
                    "No terminal session '{}'. It either finished, was never started, or was \
                     evicted to make room. Start a new one with TerminalStart.",
                    input.session_id
                ));
            };
            session.busy = true;
            if !input.input.is_empty() {
                if let Err(e) = session
                    .writer
                    .write_all(input.input.as_bytes())
                    .and_then(|()| session.writer.flush())
                {
                    session.busy = false;
                    return ToolResult::error(format!("Failed to write to the session: {e}"));
                }
            }
            session.command.clone()
        };

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
        assert!(
            poll.content.ends_with("(no new output)"),
            "output was re-delivered: {}",
            poll.content
        );

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
    fn pending_output_is_bounded_and_reports_what_it_dropped() {
        let mut p = Pending::new();
        p.push(&vec![b'a'; PENDING_CAP + 500]);
        let (text, dropped) = p.take();
        assert_eq!(text.len(), PENDING_CAP);
        assert_eq!(dropped, 500);
        // And taking twice does not re-deliver.
        assert_eq!(p.take().0, "");
    }
}

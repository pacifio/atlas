//! One-shot command terminals — the engine behind ACP's `terminal/*` methods
//! (P1.2, `plans/atlas-acp-parity-loop.md`).
//!
//! This is a different animal from [`crate::TerminalManager`], which exists to
//! back the *interactive* terminal pane: that one spawns `$SHELL -l`, streams
//! every byte to the UI over an mpsc channel, and never ends. ACP instead asks
//! the client to run one specific `command` + `args`, retain a bounded window of
//! its output, and report an exit status — a command runner. Trying to express
//! that on top of the interactive manager would mean writing a command into a
//! login shell's stdin and guessing where its output ended, so the two share
//! `portable_pty` and nothing else.
//!
//! A PTY (rather than plain pipes) is deliberate: the agent runs build tools and
//! test runners, and those switch to terse, un-coloured output when they detect
//! they are not attached to a terminal. Running them on a PTY is what makes the
//! captured output match what the user would have seen in their own shell.

use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, ExitStatus, PtySize};

/// Bytes retained when the agent does not specify `outputByteLimit`.
///
/// The ACP field is optional, and an unbounded buffer is not an option: a
/// runaway `yes` or a chatty watch process would grow it until the host is
/// killed. 1 MiB comfortably holds a full test-suite run while bounding the
/// worst case.
pub const DEFAULT_OUTPUT_BYTE_LIMIT: u64 = 1024 * 1024;

/// PTY geometry for agent-run commands. Nothing renders this, but the width
/// still matters: tools wrap their output to `$COLUMNS`, and the 80-column
/// default would hard-wrap paths and diffs in the text the agent reads back.
const PTY_COLS: u16 = 120;
const PTY_ROWS: u16 = 30;

/// How a finished command ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandExit {
    /// `None` when the process was terminated by a signal.
    pub exit_code: Option<u32>,
    /// Signal name (e.g. `SIGKILL`) when killed, else `None`.
    pub signal: Option<String>,
}

/// A bounded, UTF-8-safe window over a command's output.
///
/// ACP requires truncation from the **beginning** — the most recent output is
/// what matters to an agent reading a failure — and requires that the retained
/// bytes stay a valid string. Both are easy to get subtly wrong, so they live
/// here behind tests rather than at the call site.
#[derive(Debug)]
struct OutputBuffer {
    bytes: Vec<u8>,
    limit: usize,
    truncated: bool,
}

impl OutputBuffer {
    fn new(limit: u64) -> Self {
        Self {
            bytes: Vec::new(),
            // Saturating: `u64::MAX` from a careless agent must clamp, not wrap
            // to a tiny buffer on 32-bit.
            limit: usize::try_from(limit).unwrap_or(usize::MAX),
            truncated: false,
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
        if self.bytes.len() <= self.limit {
            return;
        }
        self.truncated = true;
        // Drop from the front, then walk forward off any UTF-8 continuation
        // byte (`0b10xxxxxx`). Slicing on a raw byte offset would cut a
        // multi-byte character in half and every later read would show a
        // replacement char at the head of the window.
        let mut cut = self.bytes.len() - self.limit;
        while cut < self.bytes.len() && (self.bytes[cut] & 0b1100_0000) == 0b1000_0000 {
            cut += 1;
        }
        self.bytes.drain(..cut);
    }

    /// The retained window as a string. Lossy by necessity — a command may emit
    /// genuinely non-UTF-8 bytes (a binary blob, a latin-1 log) and ACP's
    /// `output` field is a string, so there is nothing else to return. The
    /// boundary walk in [`Self::push`] means truncation itself never
    /// manufactures a replacement character; anything here came from the child.
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }
}

/// Shared state for one running (or finished) command.
#[derive(Debug)]
struct Inner {
    output: Mutex<OutputBuffer>,
    exit: Mutex<Option<CommandExit>>,
    /// Signalled once when the child exits, so `wait_for_exit` can park instead
    /// of polling.
    exit_notify: tokio::sync::Notify,
    /// Signalled every time the reader thread appends, and once more at exit,
    /// so a watcher can follow the output without polling.
    output_notify: tokio::sync::Notify,
}

/// A single command running on a PTY.
pub struct CommandTerminal {
    inner: Arc<Inner>,
    /// Kept so `kill` can signal the child. `portable_pty`'s `Child` needs
    /// `&mut` to kill, hence the mutex.
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
}

impl std::fmt::Debug for CommandTerminal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CommandTerminal")
            .field("exited", &self.exit_status().is_some())
            .finish_non_exhaustive()
    }
}

impl CommandTerminal {
    /// Spawn `command` with `args` on a PTY and start draining its output.
    ///
    /// Returns as soon as the child is running — output accumulates on a reader
    /// thread, so a long build does not block the ACP connection.
    pub fn spawn(
        command: &str,
        args: &[String],
        env: &[(String, String)],
        cwd: Option<&std::path::Path>,
        output_byte_limit: u64,
    ) -> anyhow::Result<Self> {
        let pair = native_pty_system().openpty(PtySize {
            rows: PTY_ROWS,
            cols: PTY_COLS,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut cmd = CommandBuilder::new(command);
        for arg in args {
            cmd.arg(arg);
        }
        for (k, v) in env {
            cmd.env(k, v);
        }
        if let Some(dir) = cwd {
            cmd.cwd(dir);
        }

        let child = pair.slave.spawn_command(cmd)?;
        // The slave must be dropped once the child holds it, or the master read
        // never sees EOF and `wait_for_exit` hangs forever after the command
        // finishes.
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader()?;
        let inner = Arc::new(Inner {
            output: Mutex::new(OutputBuffer::new(output_byte_limit)),
            exit: Mutex::new(None),
            exit_notify: tokio::sync::Notify::new(),
            output_notify: tokio::sync::Notify::new(),
        });
        let child = Arc::new(Mutex::new(child));

        // Reader thread: blocking reads off the PTY master until EOF, which
        // arrives when the child exits and the last slave fd closes.
        let reader_inner = inner.clone();
        let reader_child = child.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Ok(mut out) = reader_inner.output.lock() {
                            out.push(&buf[..n]);
                        }
                        reader_inner.output_notify.notify_waiters();
                    }
                }
            }
            // EOF — reap the child so the exit status is real rather than
            // inferred from the pipe closing.
            let status = reader_child.lock().ok().and_then(|mut c| c.wait().ok());
            if let Ok(mut slot) = reader_inner.exit.lock() {
                *slot = Some(exit_from(status));
            }
            reader_inner.exit_notify.notify_waiters();
            // Wake output watchers too: the last append before EOF may have
            // landed while nobody was registered, and this is their signal to
            // read it and stop.
            reader_inner.output_notify.notify_waiters();
        });

        Ok(Self { inner, child })
    }

    /// Output retained so far, and whether anything was dropped from the front.
    pub fn output(&self) -> (String, bool) {
        match self.inner.output.lock() {
            Ok(out) => (out.text(), out.truncated),
            Err(_) => (String::new(), false),
        }
    }

    /// `Some` once the command has exited.
    pub fn exit_status(&self) -> Option<CommandExit> {
        self.inner.exit.lock().ok().and_then(|s| s.clone())
    }

    /// Park until the command appends output, or exits.
    ///
    /// Deliberately carries no payload and no cursor: a watcher re-reads the
    /// whole retained buffer, so notifications COALESCE — a command printing in
    /// a tight loop wakes its watcher as often as it happens to be registered,
    /// not once per write. That is the behaviour wanted; the alternative is a
    /// wake per byte for output nobody has rendered yet.
    ///
    /// Returns immediately once the command has exited, so a watcher loop that
    /// checks `exit_status` terminates rather than parking forever.
    ///
    /// See [`Self::wait_for_exit`] for why `enable()` and not a bare `await`.
    pub async fn output_changed(&self) {
        let notified = self.inner.output_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.exit_status().is_some() {
            return;
        }
        notified.await;
    }

    /// Park until the command exits, then return how it ended.
    ///
    /// `enable()` is what actually registers interest. A `Notified` future
    /// created but not yet polled is NOT in the notify list, so
    /// `notify_waiters()` firing between construction and the first `await`
    /// would reach nobody — and since the reader thread signals exit exactly
    /// once, the waiter would then park forever on a command that has already
    /// finished. `tokio::pin!` + `enable()` moves that registration ahead of
    /// the status check, which is the whole point of checking after it.
    pub async fn wait_for_exit(&self) -> CommandExit {
        loop {
            let notified = self.inner.exit_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(status) = self.exit_status() {
                return status;
            }
            notified.await;
            if let Some(status) = self.exit_status() {
                return status;
            }
        }
    }

    /// Kill the command. Idempotent — killing an already-exited command is a
    /// no-op, not an error, because the agent's kill can always race the
    /// process finishing on its own.
    pub fn kill(&self) -> anyhow::Result<()> {
        if self.exit_status().is_some() {
            return Ok(());
        }
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
        Ok(())
    }
}

fn exit_from(status: Option<ExitStatus>) -> CommandExit {
    match status {
        Some(s) => {
            let code = s.exit_code();
            CommandExit {
                exit_code: Some(code),
                signal: None,
            }
        }
        // Reaping failed (already reaped, or the platform lost it). Reporting
        // "exited, code unknown" beats claiming success.
        None => CommandExit {
            exit_code: None,
            signal: None,
        },
    }
}

/// Terminals owned by one host, keyed by the id handed back to the agent.
///
/// Every terminal remembers the session that created it so teardown can kill
/// the orphans: ACP expects `terminal/release`, but an agent that crashes or a
/// session the user closes mid-build would otherwise leave the child process
/// running with nothing left to reap it.
#[derive(Default)]
pub struct CommandTerminals {
    inner: Mutex<HashMap<String, Entry>>,
}

struct Entry {
    terminal: Arc<CommandTerminal>,
    session_id: String,
}

impl CommandTerminals {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a terminal under `session_id`; returns its id.
    pub fn insert(&self, session_id: &str, terminal: CommandTerminal) -> String {
        let id = format!("term_{}", uuid::Uuid::new_v4());
        if let Ok(mut map) = self.inner.lock() {
            map.insert(
                id.clone(),
                Entry {
                    terminal: Arc::new(terminal),
                    session_id: session_id.to_string(),
                },
            );
        }
        id
    }

    #[must_use]
    pub fn get(&self, id: &str) -> Option<Arc<CommandTerminal>> {
        self.inner
            .lock()
            .ok()?
            .get(id)
            .map(|e| e.terminal.clone())
    }

    /// Drop a terminal, killing it if it is still running.
    ///
    /// ACP's `terminal/release` says the client may reclaim resources; a
    /// still-running child must be killed rather than orphaned, since after
    /// release nobody holds a handle to reap it.
    pub fn release(&self, id: &str) -> bool {
        let Ok(mut map) = self.inner.lock() else {
            return false;
        };
        match map.remove(id) {
            Some(entry) => {
                let _ = entry.terminal.kill();
                true
            }
            None => false,
        }
    }

    /// Release every terminal belonging to `session_id`. Called on session
    /// teardown so a closed tab cannot leave a build running forever.
    pub fn release_session(&self, session_id: &str) -> usize {
        let Ok(mut map) = self.inner.lock() else {
            return 0;
        };
        let doomed: Vec<String> = map
            .iter()
            .filter(|(_, e)| e.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &doomed {
            if let Some(entry) = map.remove(id) {
                let _ = entry.terminal.kill();
            }
        }
        doomed.len()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.inner.lock().map(|m| m.len()).unwrap_or(0)
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(command: &str, args: &[&str]) -> CommandTerminal {
        let args: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
        CommandTerminal::spawn(command, &args, &[], None, DEFAULT_OUTPUT_BYTE_LIMIT)
            .expect("spawn")
    }

    #[tokio::test]
    async fn captures_output_and_a_zero_exit_code() {
        let term = run("/bin/echo", &["hello acp"]);
        let exit = term.wait_for_exit().await;
        assert_eq!(exit.exit_code, Some(0));
        let (output, truncated) = term.output();
        assert!(output.contains("hello acp"), "got {output:?}");
        assert!(!truncated);
    }

    #[tokio::test]
    async fn reports_a_nonzero_exit_code() {
        let term = run("/bin/sh", &["-c", "exit 3"]);
        assert_eq!(term.wait_for_exit().await.exit_code, Some(3));
    }

    /// A command that finishes before `wait_for_exit` is called must not hang —
    /// the notification has already fired by then, so the status has to be
    /// re-checked rather than waited on blindly.
    #[tokio::test]
    async fn waiting_on_an_already_finished_command_returns_immediately() {
        let term = run("/bin/echo", &["fast"]);
        let _ = term.wait_for_exit().await;
        let again =
            tokio::time::timeout(std::time::Duration::from_secs(5), term.wait_for_exit()).await;
        assert!(again.is_ok(), "second wait must not block");
    }

    #[tokio::test]
    async fn kill_terminates_a_long_running_command() {
        let term = run("/bin/sh", &["-c", "sleep 30"]);
        term.kill().expect("kill");
        let exit = tokio::time::timeout(std::time::Duration::from_secs(10), term.wait_for_exit())
            .await
            .expect("killed command must exit promptly");
        assert_ne!(exit.exit_code, Some(0), "a killed command did not succeed");
    }

    #[tokio::test]
    async fn killing_an_already_exited_command_is_not_an_error() {
        let term = run("/bin/echo", &["done"]);
        let _ = term.wait_for_exit().await;
        assert!(
            term.kill().is_ok(),
            "kill races the process finishing on its own; that is normal"
        );
    }

    #[tokio::test]
    async fn env_and_cwd_reach_the_child() {
        let dir = std::env::temp_dir();
        let term = CommandTerminal::spawn(
            "/bin/sh",
            &["-c".into(), "printf %s \"$ATLAS_TEST_VAR\"; pwd".into()],
            &[("ATLAS_TEST_VAR".to_string(), "marker".to_string())],
            Some(&dir),
            DEFAULT_OUTPUT_BYTE_LIMIT,
        )
        .expect("spawn");
        term.wait_for_exit().await;
        let (output, _) = term.output();
        assert!(output.contains("marker"), "env not passed: {output:?}");
    }

    #[test]
    fn the_buffer_keeps_the_most_recent_bytes_not_the_first() {
        let mut buf = OutputBuffer::new(5);
        buf.push(b"abcdefghij");
        assert_eq!(buf.text(), "fghij", "ACP truncates from the beginning");
        assert!(buf.truncated);
    }

    #[test]
    fn an_under_limit_buffer_is_not_marked_truncated() {
        let mut buf = OutputBuffer::new(64);
        buf.push(b"short");
        assert_eq!(buf.text(), "short");
        assert!(!buf.truncated);
    }

    /// The spec requires truncation to land on a character boundary. Cutting
    /// mid-character would put a replacement char at the head of every
    /// subsequent read.
    #[test]
    fn truncation_never_splits_a_multibyte_character() {
        // 'é' is 2 bytes, '→' is 3, '🙂' is 4 — a limit that lands inside each.
        for limit in 1..=12 {
            let mut buf = OutputBuffer::new(limit as u64);
            buf.push("aé→🙂bc".as_bytes());
            let text = buf.text();
            assert!(
                !text.contains('\u{FFFD}'),
                "limit {limit} split a character: {text:?}"
            );
        }
    }

    #[test]
    fn incremental_pushes_truncate_the_same_as_one_big_push() {
        let mut incremental = OutputBuffer::new(4);
        for byte in b"abcdefgh" {
            incremental.push(&[*byte]);
        }
        let mut bulk = OutputBuffer::new(4);
        bulk.push(b"abcdefgh");
        assert_eq!(incremental.text(), bulk.text());
        assert_eq!(incremental.text(), "efgh");
    }

    #[tokio::test]
    async fn releasing_a_session_kills_its_terminals_and_leaves_others_alone() {
        let terminals = CommandTerminals::new();
        let mine = terminals.insert("session-a", run("/bin/sh", &["-c", "sleep 30"]));
        let theirs = terminals.insert("session-b", run("/bin/sh", &["-c", "sleep 30"]));

        assert_eq!(terminals.release_session("session-a"), 1);
        assert!(terminals.get(&mine).is_none(), "session-a's is gone");
        let survivor = terminals.get(&theirs).expect("session-b's survives");

        // Clean up the survivor so the test leaves no stray process.
        assert!(terminals.release(&theirs));
        let _ = survivor.wait_for_exit().await;
    }

    #[test]
    fn releasing_an_unknown_terminal_reports_false_rather_than_panicking() {
        let terminals = CommandTerminals::new();
        assert!(!terminals.release("term_does_not_exist"));
    }

    /// The signal a watcher follows to stream a running command's output into
    /// the UI. Without it the output only moves when something unrelated
    /// happens to re-read the buffer.
    #[tokio::test]
    async fn output_changed_wakes_while_the_command_is_still_running() {
        // Prints, then stays alive: a watcher must be woken by the print, not
        // left parked until the process ends.
        let term = run("/bin/sh", &["-c", "echo first; sleep 30"]);
        let woke = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            async {
                loop {
                    term.output_changed().await;
                    if term.output().0.contains("first") {
                        return;
                    }
                }
            },
        )
        .await;
        let _ = term.kill();
        assert!(woke.is_ok(), "output_changed never woke for a live command");
    }

    /// A watcher loop is written as `loop { output_changed().await; ...; if
    /// exited { break } }`. If the await parked forever once the command was
    /// gone, that loop would leak a task per terminal for the life of the app.
    #[tokio::test]
    async fn output_changed_returns_at_once_once_the_command_has_exited() {
        let term = run("/bin/echo", &["done"]);
        let _ = term.wait_for_exit().await;
        let returned =
            tokio::time::timeout(std::time::Duration::from_secs(5), term.output_changed()).await;
        assert!(returned.is_ok(), "a finished command must not park its watcher");
    }

}

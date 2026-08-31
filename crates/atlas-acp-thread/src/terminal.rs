//! Agent-created terminals — ported from
//! `zed-ref/crates/acp_thread/src/terminal.rs` and the provider-event handling
//! at `acp_thread.rs:4639-4715`.
//!
//! The mechanism worth porting is the **out-of-order buffering**. A terminal's
//! `Created` event is not guaranteed to reach the thread before its first
//! `Output` or even its `Exit`: the agent gets the terminal id back from
//! `terminal/create` and can reference it in a `session/update` immediately,
//! which races the client's own bookkeeping. Zed handles this with two
//! side-tables keyed by terminal id (`pending_terminal_output`,
//! `pending_terminal_exit`) that are drained when `Created` finally lands.
//! Without them the first chunk of a fast command's output is silently lost —
//! which is exactly what the agent then reads back as the command's result.
//!
//! Divergence from Zed: Zed's `Terminal` wraps a full `terminal::Terminal`
//! entity (an alacritty grid it renders). Atlas runs agent commands through
//! [`atlas_terminal::command::CommandTerminal`], which already owns the PTY and
//! keeps a bounded output buffer, so the port keeps Zed's *event and buffering*
//! shape and delegates the running to that. Zed's OS-sandbox wrapper
//! (`SandboxWrap`) is not ported: it depends on Zed's `sandbox` crate and is a
//! separate feature from the thread model.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use agent_client_protocol::schema::v1 as acp;
use atlas_terminal::command::{
    CommandExit, CommandTerminal, OutputBuffer, DEFAULT_OUTPUT_BYTE_LIMIT,
};
use indexmap::IndexMap;

/// How many terminal ids may have output or an exit status parked for them
/// before the oldest is dropped.
///
/// The buffering exists for a race measured in milliseconds — the agent
/// referencing a terminal id in a `session/update` before our own `Created`
/// bookkeeping lands — so an id that is still unclaimed after 64 others have
/// come and gone is not early, it is fabricated. See `handle_event`.
const MAX_PENDING_TERMINALS: usize = 64;

/// Total bytes parked across every not-yet-created terminal id.
///
/// Matched to [`DEFAULT_OUTPUT_BYTE_LIMIT`] so a terminal cannot buy more
/// buffer by delaying its own announcement than it would get after it.
const MAX_PENDING_OUTPUT_BYTES: usize = DEFAULT_OUTPUT_BYTE_LIMIT as usize;

/// What the terminal provider tells the thread. Ported from
/// `TerminalProviderEvent` (`acp_thread.rs:2183-2200`).
#[derive(Debug)]
pub enum TerminalProviderEvent {
    Created {
        terminal_id: acp::TerminalId,
        label: String,
        cwd: Option<PathBuf>,
        output_byte_limit: Option<u64>,
        /// `None` for a DISPLAY-ONLY terminal: the agent runs the command
        /// itself and streams everything through `terminal_output` /
        /// `terminal_exit` meta, so there is no PTY on our side — only the
        /// buffer those events fill. `Some` for a terminal created through
        /// `terminal/create`, whose PTY we own.
        terminal: Option<Arc<CommandTerminal>>,
    },
    Output {
        terminal_id: acp::TerminalId,
        data: Vec<u8>,
    },
    TitleChanged {
        terminal_id: acp::TerminalId,
        title: String,
    },
    Exit {
        terminal_id: acp::TerminalId,
        status: acp::TerminalExitStatus,
    },
}

impl TerminalProviderEvent {
    /// Which terminal this event is about. Every variant names one, and the
    /// thread needs it to find the tool calls that render it.
    pub fn terminal_id(&self) -> &acp::TerminalId {
        match self {
            Self::Created { terminal_id, .. }
            | Self::Output { terminal_id, .. }
            | Self::TitleChanged { terminal_id, .. }
            | Self::Exit { terminal_id, .. } => terminal_id,
        }
    }
}

/// One terminal the agent references — created through `terminal/create` (we
/// own the PTY) or announced through `terminal_info` meta (display-only: the
/// agent owns the process and streams output/exit as meta events).
pub struct AcpTerminal {
    id: acp::TerminalId,
    command_label: String,
    working_dir: Option<PathBuf>,
    output_byte_limit: Option<u64>,
    started_at: Instant,
    /// `None` for a display-only terminal. Everything it shows arrived as
    /// provider events into `replayed_output`.
    inner: Option<Arc<CommandTerminal>>,
    /// Output that arrived as provider events before/alongside the PTY's own
    /// capture. Held separately so replaying a pre-`Created` buffer cannot
    /// interleave into the middle of what the PTY reader collected.
    ///
    /// Bounded by `output_byte_limit`. For a terminal we own this holds only
    /// the pre-`Created` burst and the PTY buffer carries the rest; for a
    /// DISPLAY-ONLY terminal it is the *entire* capture, and it is the only
    /// thing standing between a watch-mode build and unbounded RSS.
    replayed_output: OutputBuffer,
    exit_status: Option<acp::TerminalExitStatus>,
    stopped_by_user: bool,
}

impl std::fmt::Debug for AcpTerminal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AcpTerminal")
            .field("id", &self.id)
            .field("command_label", &self.command_label)
            .field("exited", &self.exit_status.is_some())
            .finish_non_exhaustive()
    }
}

impl AcpTerminal {
    pub fn new(
        id: acp::TerminalId,
        command_label: String,
        working_dir: Option<PathBuf>,
        output_byte_limit: Option<u64>,
        inner: Option<Arc<CommandTerminal>>,
    ) -> Self {
        Self {
            id,
            command_label,
            working_dir,
            output_byte_limit,
            started_at: Instant::now(),
            inner,
            // `None` means the agent declared no limit, not that it declared no
            // limit *applies*: a display-only terminal never gets to declare
            // one at all (`handle_session_update` has no field to read it from),
            // so it lands on the same default a `terminal/create` without an
            // `outputByteLimit` gets.
            replayed_output: OutputBuffer::new(
                output_byte_limit.unwrap_or(DEFAULT_OUTPUT_BYTE_LIMIT),
            ),
            exit_status: None,
            stopped_by_user: false,
        }
    }

    pub fn id(&self) -> &acp::TerminalId {
        &self.id
    }

    pub fn command(&self) -> &str {
        &self.command_label
    }

    pub fn update_command_label(&mut self, label: &str) {
        self.command_label = label.to_owned();
    }

    pub fn working_dir(&self) -> &Option<PathBuf> {
        &self.working_dir
    }

    pub fn output_byte_limit(&self) -> Option<u64> {
        self.output_byte_limit
    }

    pub fn started_at(&self) -> Instant {
        self.started_at
    }

    /// The PTY, when this terminal is one WE created. A display-only terminal
    /// (announced through `terminal_info` meta) has none — the agent owns the
    /// process, and asking us to kill or await it has no meaning.
    pub fn inner(&self) -> Option<&Arc<CommandTerminal>> {
        self.inner.as_ref()
    }

    pub fn was_stopped_by_user(&self) -> bool {
        self.stopped_by_user
    }

    pub(crate) fn write_output(&mut self, data: &[u8]) {
        self.replayed_output.push(data);
    }

    pub(crate) fn set_exit_status(&mut self, status: acp::TerminalExitStatus) {
        self.exit_status = Some(status);
    }

    /// What `terminal/output` answers with.
    ///
    /// Replayed pre-`Created` bytes are prefixed, because they are by definition
    /// the earliest output of the command.
    pub fn current_output(&self) -> acp::TerminalOutputResponse {
        let (captured, captured_truncated) = match &self.inner {
            Some(inner) => inner.output(),
            // Display-only: the meta events ARE the capture.
            None => (String::new(), false),
        };
        // Either buffer having dropped its front makes the whole response
        // partial. Reading `truncated` off the PTY alone is how a display-only
        // terminal came to report a complete capture of a buffer it had been
        // trimming for hours.
        let truncated = captured_truncated || self.replayed_output.truncated();
        let output = if self.replayed_output.is_empty() {
            captured
        } else {
            let mut out = self.replayed_output.text();
            out.push_str(&captured);
            out
        };

        let exit_status = self.exit_status.clone().or_else(|| {
            self.inner
                .as_ref()
                .and_then(|inner| inner.exit_status().map(exit_status_from_command))
        });

        let mut response = acp::TerminalOutputResponse::new(output, truncated);
        response.exit_status = exit_status;
        response
    }

    /// Kill the command. Marks the terminal as user-stopped so the UI can tell
    /// a cancel apart from a command that failed on its own.
    pub fn stop_by_user(&mut self) -> anyhow::Result<()> {
        self.stopped_by_user = true;
        self.kill()
    }

    pub fn kill(&self) -> anyhow::Result<()> {
        match &self.inner {
            Some(inner) => inner.kill(),
            None => Err(anyhow::anyhow!(
                "terminal {} is agent-owned (display-only); there is no process to kill",
                self.id
            )),
        }
    }

    /// `None` when this terminal cannot be awaited: a display-only terminal
    /// whose exit has not arrived yet.
    ///
    /// The exit for one of those arrives as a meta event on some later
    /// `session/update`, and nothing here can park on that. Returning a default
    /// `TerminalExitStatus` instead would be indistinguishable from a clean
    /// `exit 0` — the one answer a caller must not be handed when the truth is
    /// "we have no idea". Unreachable in production today: the
    /// `terminal/wait_for_exit` handler awaits the PTY directly and refuses
    /// display-only terminals before it would get here.
    pub async fn wait_for_exit(&self) -> Option<acp::TerminalExitStatus> {
        if let Some(status) = &self.exit_status {
            return Some(status.clone());
        }
        match &self.inner {
            Some(inner) => Some(exit_status_from_command(inner.wait_for_exit().await)),
            None => None,
        }
    }
}

/// Killing the child on drop is the only thing that covers an ABRUPT teardown.
///
/// The tidy path is already safe — `terminal/release` kills before it drops
/// (`atlas-agent-servers/src/handlers.rs`) — but a session closed with a build
/// still running never reaches it: `close_session` drops the last
/// `AcpThreadHandle`, which drops the `TerminalRegistry`, which drops us. And
/// nothing below here saves it. `portable-pty`'s unix child is a plain
/// `std::process::Child`, which does not kill on drop, and the reader thread
/// holds a dup'd master fd, so the PTY never even hangs up. The child would
/// outlive Atlas as an orphan, still writing into a buffer nobody will read.
///
/// Display-only terminals have no process of ours to kill, and `kill()` says so
/// with an error — expected here, not a failure.
impl Drop for AcpTerminal {
    fn drop(&mut self) {
        if self.inner.is_none() {
            return;
        }
        if let Err(err) = self.kill() {
            tracing::debug!(terminal_id = %self.id, "killing terminal on drop failed: {err:#}");
        }
    }
}

pub fn exit_status_from_command(exit: CommandExit) -> acp::TerminalExitStatus {
    let mut status = acp::TerminalExitStatus::new();
    status.exit_code = exit.exit_code;
    status.signal = exit.signal;
    status
}

/// The thread's terminal side-tables, kept together so the buffering rule has
/// one owner. Ported from `AcpThread`'s `terminals` /
/// `pending_terminal_output` / `pending_terminal_exit` fields.
///
/// `terminals` itself is deliberately uncapped, unlike the two pending maps.
/// Every entry in it cost the agent a `terminal/create` that spawned a real
/// process, so the OS bounds it long before this map does, and the only ways to
/// cap it here are worse than the growth: refusing `terminal/create` is a
/// policy the handler should own and answer with a protocol error, and evicting
/// an entry would kill a command the agent is still using. The pending maps
/// have neither excuse — nothing was spawned, and an id parked there may not
/// exist at all (ATL-218 finding 6).
#[derive(Default)]
pub struct TerminalRegistry {
    terminals: IndexMap<acp::TerminalId, AcpTerminal>,
    /// Insertion-ordered so eviction can be oldest-first. A `HashMap` would
    /// leave "which id has been waiting longest" unanswerable, and the id that
    /// has waited longest is exactly the one least likely to ever be claimed.
    pending_output: IndexMap<acp::TerminalId, Vec<Vec<u8>>>,
    pending_exit: IndexMap<acp::TerminalId, acp::TerminalExitStatus>,
    /// Running total of every chunk in `pending_output`, so the byte budget is
    /// enforced without walking the map on each event.
    pending_output_bytes: usize,
}

impl TerminalRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, id: &acp::TerminalId) -> Option<&AcpTerminal> {
        self.terminals.get(id)
    }

    pub fn get_mut(&mut self, id: &acp::TerminalId) -> Option<&mut AcpTerminal> {
        self.terminals.get_mut(id)
    }

    pub fn contains(&self, id: &acp::TerminalId) -> bool {
        self.terminals.contains_key(id)
    }

    pub fn len(&self) -> usize {
        self.terminals.len()
    }

    pub fn is_empty(&self) -> bool {
        self.terminals.is_empty()
    }

    pub fn remove(&mut self, id: &acp::TerminalId) -> Option<AcpTerminal> {
        self.take_pending_output(id);
        self.pending_exit.shift_remove(id);
        self.terminals.shift_remove(id)
    }

    /// Take an id's parked chunks, keeping the byte accounting straight.
    fn take_pending_output(&mut self, id: &acp::TerminalId) -> Option<Vec<Vec<u8>>> {
        let chunks = self.pending_output.shift_remove(id)?;
        let bytes: usize = chunks.iter().map(Vec::len).sum();
        self.pending_output_bytes = self.pending_output_bytes.saturating_sub(bytes);
        Some(chunks)
    }

    /// Park output for a terminal that has not been announced yet, then bring
    /// the side-tables back inside their budget.
    ///
    /// The buffering itself is load-bearing and stays: out-of-order arrival is
    /// a real, documented case. What is bounded is how long an id that will
    /// NEVER be announced gets to hold memory — `handle_session_update` reads
    /// `terminal_id` off agent-supplied meta with no membership check, and
    /// `terminal/release` refuses ids it does not know, so nothing else prunes
    /// a fabricated one before the session ends.
    fn park_output(&mut self, id: acp::TerminalId, data: Vec<u8>) {
        self.pending_output_bytes += data.len();
        self.pending_output.entry(id).or_default().push(data);

        while self.pending_output.len() > MAX_PENDING_TERMINALS {
            let oldest = self
                .pending_output
                .get_index(0)
                .map(|(id, _)| id.clone())
                .expect("non-empty above the cap");
            self.take_pending_output(&oldest);
        }

        // Over the byte budget, drop the OLDEST chunk of the OLDEST id rather
        // than the id that just arrived: the newest bytes are the ones most
        // likely to belong to a terminal that is about to be announced.
        while self.pending_output_bytes > MAX_PENDING_OUTPUT_BYTES {
            let Some((id, chunks)) = self.pending_output.get_index_mut(0) else {
                // Cannot happen — the total is the sum of what is in the map —
                // but resetting beats spinning if it ever did.
                self.pending_output_bytes = 0;
                break;
            };
            if chunks.is_empty() {
                let id = id.clone();
                self.pending_output.shift_remove(&id);
                continue;
            }
            let dropped = chunks.remove(0).len();
            self.pending_output_bytes = self.pending_output_bytes.saturating_sub(dropped);
            if chunks.is_empty() {
                let id = id.clone();
                self.pending_output.shift_remove(&id);
            }
        }
    }

    /// Park an exit status for an unannounced terminal. Capped by id count
    /// only: a `TerminalExitStatus` is two small fields, so the id ceiling is
    /// the whole of the bound.
    fn park_exit(&mut self, id: acp::TerminalId, status: acp::TerminalExitStatus) {
        self.pending_exit.insert(id, status);
        while self.pending_exit.len() > MAX_PENDING_TERMINALS {
            self.pending_exit.shift_remove_index(0);
        }
    }

    /// Ported from `AcpThread::on_terminal_provider_event`
    /// (`acp_thread.rs:4639-4715`).
    pub fn handle_event(&mut self, event: TerminalProviderEvent) {
        match event {
            TerminalProviderEvent::Created {
                terminal_id,
                label,
                cwd,
                output_byte_limit,
                terminal,
            } => {
                let mut acp_terminal = AcpTerminal::new(
                    terminal_id.clone(),
                    label,
                    cwd,
                    output_byte_limit,
                    terminal,
                );

                // Drain anything that arrived first. Order within the buffer is
                // arrival order, which is the order the PTY produced it.
                if let Some(chunks) = self.take_pending_output(&terminal_id) {
                    for data in chunks {
                        acp_terminal.write_output(&data);
                    }
                }

                if let Some(status) = self.pending_exit.shift_remove(&terminal_id) {
                    acp_terminal.set_exit_status(status);
                }

                self.terminals.insert(terminal_id, acp_terminal);
            }
            TerminalProviderEvent::Output { terminal_id, data } => {
                if let Some(terminal) = self.terminals.get_mut(&terminal_id) {
                    terminal.write_output(&data);
                } else {
                    self.park_output(terminal_id, data);
                }
            }
            TerminalProviderEvent::TitleChanged { terminal_id, title } => {
                if let Some(terminal) = self.terminals.get_mut(&terminal_id) {
                    terminal.update_command_label(&title);
                }
            }
            TerminalProviderEvent::Exit {
                terminal_id,
                status,
            } => {
                if let Some(terminal) = self.terminals.get_mut(&terminal_id) {
                    terminal.set_exit_status(status);
                } else {
                    self.park_exit(terminal_id, status);
                }
            }
        }
    }

    /// How many output chunks are parked for a terminal that has not been
    /// created yet. Exposed so the buffering invariant can be asserted directly
    /// rather than inferred from the rendered output.
    pub fn pending_output_len(&self, id: &acp::TerminalId) -> usize {
        self.pending_output.get(id).map_or(0, |c| c.len())
    }

    /// Whether an exit status arrived before the terminal it belongs to.
    pub fn has_pending_exit(&self, id: &acp::TerminalId) -> bool {
        self.pending_exit.contains_key(id)
    }

    /// How many terminal ids have output parked for them, and how many bytes
    /// that costs. Exposed so the bound can be asserted directly.
    pub fn pending_output_stats(&self) -> (usize, usize) {
        (self.pending_output.len(), self.pending_output_bytes)
    }

    /// How many exit statuses are parked for terminals not yet announced.
    pub fn pending_exit_len(&self) -> usize {
        self.pending_exit.len()
    }
}

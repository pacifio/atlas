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

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use agent_client_protocol::schema::v1 as acp;
use atlas_terminal::command::{CommandExit, CommandTerminal};

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
    replayed_output: Vec<u8>,
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
            replayed_output: Vec::new(),
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
        self.replayed_output.extend_from_slice(data);
    }

    pub(crate) fn set_exit_status(&mut self, status: acp::TerminalExitStatus) {
        self.exit_status = Some(status);
    }

    /// What `terminal/output` answers with.
    ///
    /// Replayed pre-`Created` bytes are prefixed, because they are by definition
    /// the earliest output of the command.
    pub fn current_output(&self) -> acp::TerminalOutputResponse {
        let (captured, truncated) = match &self.inner {
            Some(inner) => inner.output(),
            // Display-only: the meta events ARE the capture.
            None => (String::new(), false),
        };
        let output = if self.replayed_output.is_empty() {
            captured
        } else {
            let mut out = String::from_utf8_lossy(&self.replayed_output).into_owned();
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

    pub async fn wait_for_exit(&self) -> acp::TerminalExitStatus {
        if let Some(status) = &self.exit_status {
            return status.clone();
        }
        match &self.inner {
            Some(inner) => exit_status_from_command(inner.wait_for_exit().await),
            // Display-only with no exit yet: the exit arrives as a meta event,
            // and nothing here can await it. Unreachable in production today —
            // the `terminal/wait_for_exit` handler awaits the PTY directly and
            // refuses display-only terminals before it would get here — so an
            // empty status is the honest answer for a test or future caller.
            None => acp::TerminalExitStatus::new(),
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
#[derive(Default)]
pub struct TerminalRegistry {
    terminals: HashMap<acp::TerminalId, AcpTerminal>,
    pending_output: HashMap<acp::TerminalId, Vec<Vec<u8>>>,
    pending_exit: HashMap<acp::TerminalId, acp::TerminalExitStatus>,
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
        self.pending_output.remove(id);
        self.pending_exit.remove(id);
        self.terminals.remove(id)
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
                if let Some(chunks) = self.pending_output.remove(&terminal_id) {
                    for data in chunks {
                        acp_terminal.write_output(&data);
                    }
                }

                if let Some(status) = self.pending_exit.remove(&terminal_id) {
                    acp_terminal.set_exit_status(status);
                }

                self.terminals.insert(terminal_id, acp_terminal);
            }
            TerminalProviderEvent::Output { terminal_id, data } => {
                if let Some(terminal) = self.terminals.get_mut(&terminal_id) {
                    terminal.write_output(&data);
                } else {
                    self.pending_output
                        .entry(terminal_id)
                        .or_default()
                        .push(data);
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
                    self.pending_exit.insert(terminal_id, status);
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
}

use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    CreateElicitationRequest, CreateElicitationResponse, CreateTerminalRequest,
    CreateTerminalResponse, ElicitationAction, InitializeRequest, KillTerminalRequest,
    ReadTextFileRequest, ReadTextFileResponse, WriteTextFileRequest, WriteTextFileResponse,
    KillTerminalResponse, ReleaseTerminalRequest, ReleaseTerminalResponse,
    RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SessionId, SessionNotification, TerminalExitStatus,
    TerminalOutputRequest, TerminalOutputResponse, WaitForTerminalExitRequest,
    WaitForTerminalExitResponse,
};
use agent_client_protocol::{AcpAgent, Agent, ConnectionTo, LineDirection};
use dashmap::DashMap;
use serde::Serialize;
use serde_json::{Map, Value};
use tokio::sync::oneshot;
use uuid::Uuid;

use atlas_terminal::command::{CommandExit, CommandTerminal, CommandTerminals, DEFAULT_OUTPUT_BYTE_LIMIT};

use crate::capabilities::AgentCaps;
use crate::error::{AcpError, Result};
use crate::events::{AcpEvent, EventSink};
use crate::model_sniff::ModelSniffer;
use crate::registry::AgentId;

/// Per-(agent, session) lifecycle guard the driver consults before
/// forwarding any inbound event to the rest of the stack. Created on
/// `register_session` and dropped on `drop_session`.
///
/// The guard solves a real race: when the user hits Stop, the host
/// fires `cancel_turn` which (a) sends a `CancelNotification` to the
/// agent and (b) drops the senders for already-pending permission
/// requests so the driver's `rx.await` resolves as `Cancelled`. But
/// the agent may already have a `RequestPermissionRequest` or a
/// `SessionUpdate` in flight. Without the guard the driver happily
/// dispatches it — the user gets a permission popup ~seconds AFTER
/// hitting Stop, or sees stale assistant chunks accrue in the
/// transcript. With the guard set to `cancelled = true`, the driver
/// rejects late inbound traffic at the protocol boundary and the
/// frontend never knows it existed.
///
/// `turn_epoch` is bumped on every `mark_turn_started` and stamped onto
/// every event the driver emits for the session (`EventSink::emit`'s
/// `turn` argument), so the session actor can drop stragglers from a
/// stale-but-not-cancelled prior turn (rapid Stop + new prompt on the
/// same session). Epoch 0 = no turn has ever started → events are
/// emitted unstamped (`None`) so `session/load` replay flows through.
pub struct SessionGuard {
    pub turn_epoch: AtomicU64,
    pub cancelled: AtomicBool,
}

impl SessionGuard {
    pub fn new() -> Self {
        Self {
            turn_epoch: AtomicU64::new(0),
            cancelled: AtomicBool::new(false),
        }
    }

    /// True if any event for this session should be dropped at the
    /// driver (cancelled and not yet re-armed by a new turn).
    fn is_blocked(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    /// Called by the registry on `cancel_turn`.
    pub fn mark_cancelled(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    /// Called by the registry on `mark_turn_started`. Re-arms the
    /// guard so subsequent inbound events for this session flow
    /// through again. Returns the new turn epoch — the actor keeps it
    /// to match against the stamps on inbound events.
    pub fn mark_turn_started(&self) -> u64 {
        let epoch = self.turn_epoch.fetch_add(1, Ordering::AcqRel) + 1;
        self.cancelled.store(false, Ordering::Release);
        epoch
    }

    /// The current turn's epoch, or `None` if no turn has ever started
    /// (events emitted then are replay / pre-turn traffic and must not
    /// be gated on turn identity).
    pub fn current_turn(&self) -> Option<u64> {
        let epoch = self.turn_epoch.load(Ordering::Acquire);
        (epoch > 0).then_some(epoch)
    }
}

/// Per-agent map of session lifecycle guards. The driver consults
/// this on every inbound notification/request; the registry mutates
/// it from `register_session` / `drop_session` / `cancel_turn` /
/// `mark_turn_started`.
pub type SessionGuards = DashMap<SessionId, Arc<SessionGuard>>;

/// One outstanding permission request waiting on the UI.
pub struct PendingPermissionEntry {
    pub session_id: SessionId,
    pub sender: oneshot::Sender<RequestPermissionOutcome>,
}

/// Elicitations awaiting a user answer (P3.3). Same shape as
/// [`PendingPermissionEntry`] and for the same reason: the request must be
/// answered from the Tauri layer, long after the handler returned.
pub struct PendingElicitationEntry {
    pub sender: oneshot::Sender<ElicitationAction>,
}

pub type PendingElicitations = DashMap<Uuid, PendingElicitationEntry>;

/// Permissions awaiting a client decision.
///
/// The notification handler stashes a [`oneshot::Sender`] under a fresh
/// `request_id`; the Tauri layer resolves it via `acp_respond_permission` once
/// the user clicks a button. Tracks `session_id` so `cancel_turn` can drop
/// the right ones (per ACP spec, any pending permission for a cancelled turn
/// MUST resolve as `Cancelled`).
pub type PendingPermissions = DashMap<Uuid, PendingPermissionEntry>;

/// Resources owned by a single spawned ACP agent. Held inside the
/// [`crate::registry::AgentRegistry`] under an [`AgentId`].
pub struct AgentRuntime {
    pub connection: ConnectionTo<Agent>,
    pub pending_permissions: Arc<PendingPermissions>,
    /// Per-session lifecycle guards. Shared `Arc` so the driver task
    /// reads it on every inbound event while the registry mutates it
    /// from cancel / start / drop. See [`SessionGuard`].
    pub session_guards: Arc<SessionGuards>,
    /// Drop to ask the driver task to shut down.
    pub shutdown_tx: Option<oneshot::Sender<()>>,
    /// Auth methods the agent advertised in its `InitializeResponse`.
    /// For claude-agent-acp these include "Claude Subscription" and
    /// "Anthropic Console" entries with `_meta.terminal-auth` carrying
    /// the exact subprocess spec the host must run to drive the OAuth
    /// flow. Returned as a JSON-friendly projection so the Tauri layer
    /// can hand them straight to the frontend.
    pub auth_methods: Vec<AuthMethodWire>,
    /// Everything the agent advertised at `initialize` — capability lookups
    /// for the whole stack read this rather than re-deriving from the wire.
    pub caps: AgentCaps,
    /// Elicitations awaiting a user answer (P3.3).
    pub pending_elicitations: Arc<PendingElicitations>,
    /// The host's event sink. Held so registry-side RPCs can emit events of
    /// their own — the end-of-turn usage on a `PromptResponse` (P2.5) arrives
    /// as an RPC RESULT, not a notification, so the driver task never sees it.
    pub sink: Arc<dyn EventSink>,
    /// Terminals this agent created through `terminal/*` (P1.2). Shared with
    /// the driver task's handlers; the registry releases a session's terminals
    /// on teardown so a closed tab cannot orphan a running build.
    pub terminals: Arc<CommandTerminals>,
    /// Legacy `models` blobs recovered off the raw wire for agents still on the
    /// pre-config-options dialect (OpenCode, Cursor). See [`ModelSniffer`].
    pub model_sniffer: Arc<ModelSniffer>,
}

/// How the client is expected to satisfy one auth method (R2).
///
/// Mirrors the schema's tagged `AuthMethod` enum. A method with **no** `type`
/// is `Agent` per the spec, and an *unrecognised* `type` degrades to `Agent`
/// too: these variants are UNSTABLE, and "call `authenticate` and see" is the
/// only universally safe behaviour for a shape we do not understand.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMethodKind {
    /// The agent authenticates itself; the client just calls `authenticate`.
    Agent,
    /// The client sets environment variables, then calls `authenticate`.
    EnvVar,
    /// The client runs the agent binary with `args` in a terminal; the CLI
    /// drives the browser flow.
    Terminal,
}

/// One environment variable an `env_var` method wants set.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthEnvVar {
    pub name: String,
    pub label: Option<String>,
    /// Schema defaults: `secret` is true, `optional` is false. Both default to
    /// the SAFER reading when absent — treat an unlabelled var as a secret that
    /// is required, rather than leaking it or silently skipping it.
    pub secret: bool,
    pub optional: bool,
}

/// JSON-friendly projection of `AuthMethod` for the wire.
///
/// ## What adapters actually send (captured 2026-08-19, task R1)
///
/// | adapter | id | `type` | carries |
/// |---|---|---|---|
/// | claude-agent-acp | `claude-ai-login` | `terminal` | `args` + `_meta["terminal-auth"]` |
/// | claude-agent-acp | `console-login` | `terminal` | `args` + `_meta["terminal-auth"]` |
/// | codex-acp | `api-key` | *absent* → agent | `_meta["api-key"].provider = "openai"` |
/// | codex-acp | `chat-gpt` | *absent* → agent | — |
///
/// Two things that survey contradicts in the obvious design:
///
/// 1. **No adapter sends typed `env_var` yet.** Codex's API-key method is a bare
///    `agent` method with a proprietary `_meta["api-key"]` hint. The `env_var`
///    branch is built to spec here but is currently exercised by nobody, so
///    [`api_key_provider`] surfaces the codex hint as the real-world equivalent.
/// 2. **For `terminal` methods the typed `args` are NOT sufficient on their
///    own.** They are relative to the agent's own binary (`--cli auth login
///    --claudeai`) and the spec never says what that binary is — and Atlas
///    launches claude via `npx -y @agentclientprotocol/claude-agent-acp`, so
///    there is no path to reconstruct. `_meta["terminal-auth"]` carries the
///    fully-resolved `{command, args}`. So the rule is NOT a blanket "typed data
///    wins": the typed `type` classifies the method, while `_meta` supplies the
///    runnable command when present. See [`Self::runnable_terminal`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthMethodWire {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// Which branch of the flow this method drives.
    pub kind: AuthMethodKind,
    /// `env_var` methods: the variables the client must set.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub env_vars: Vec<AuthEnvVar>,
    /// `env_var` methods: where the user obtains the credential. This is the
    /// "endpoint" the meeting notes were reaching for — it comes from the
    /// protocol at runtime, not from the registry manifest.
    pub link: Option<String>,
    /// Typed `terminal.args`, relative to the agent's own binary.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    /// `_meta.terminal-auth.command` — the resolved binary to actually exec.
    pub terminal_command: Option<String>,
    /// `_meta.terminal-auth.args` — the full argv tail for that command.
    pub terminal_args: Option<Vec<String>>,
    /// `_meta.terminal-auth.label` — adapter-suggested UI label.
    pub terminal_label: Option<String>,
    /// `_meta["api-key"].provider` — codex's proprietary hint that this method
    /// is satisfied by that provider's API key. Lets the UI show the same
    /// env-var checklist a typed `env_var` method would get.
    pub api_key_provider: Option<String>,
}

impl AuthMethodWire {
    /// Project an `AuthMethod` re-serialized as JSON.
    ///
    /// Reads JSON rather than matching the typed enum because the `Terminal` /
    /// `EnvVar` variants are gated behind `unstable_auth_methods`; without the
    /// feature the wire-level `type` silently deserializes as `Agent` and the
    /// extra fields are lost. Reading the raw object is immune to that.
    fn from_json(v: &Value) -> Option<Self> {
        let obj = v.as_object()?;
        let id = obj.get("id")?.as_str()?.to_string();
        let name = obj.get("name")?.as_str()?.to_string();
        let description = obj.get("description").and_then(|d| d.as_str()).map(String::from);
        let kind = match obj.get("type").and_then(|t| t.as_str()) {
            Some("env_var") => AuthMethodKind::EnvVar,
            Some("terminal") => AuthMethodKind::Terminal,
            // Absent = `agent` per spec. Unknown = degrade to `agent`, and say
            // so once so an adapter shipping a new variant is discoverable
            // rather than silently mistreated.
            Some(other) if other != "agent" => {
                tracing::info!(
                    target: "atlas_acp::driver",
                    method = %id,
                    r#type = %other,
                    "unknown ACP auth method type; treating as `agent`"
                );
                AuthMethodKind::Agent
            }
            _ => AuthMethodKind::Agent,
        };
        let env_vars = obj
            .get("vars")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(parse_env_var).collect())
            .unwrap_or_default();
        let link = obj.get("link").and_then(|l| l.as_str()).map(String::from);
        let args = obj
            .get("args")
            .and_then(|a| a.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let meta = obj.get("_meta").and_then(|m| m.as_object());
        let (terminal_command, terminal_args, terminal_label) = meta
            .and_then(extract_terminal_auth)
            .map(|t| (Some(t.command), Some(t.args), t.label))
            .unwrap_or((None, None, None));
        let api_key_provider = meta
            .and_then(|m| m.get("api-key"))
            .and_then(|k| k.get("provider"))
            .and_then(|p| p.as_str())
            .map(String::from);
        Some(Self {
            id,
            name,
            description,
            kind,
            env_vars,
            link,
            args,
            terminal_command,
            terminal_args,
            terminal_label,
            api_key_provider,
        })
    }

    /// The command Atlas can actually exec for a terminal-style login, if any.
    ///
    /// Only `_meta["terminal-auth"]` yields one: typed `terminal.args` describe
    /// arguments to a binary the protocol never names. When this is `None` for a
    /// `Terminal` method, enrichment (R3) fills it from `builtin_login_args`.
    #[must_use]
    pub fn runnable_terminal(&self) -> Option<(String, Vec<String>)> {
        let command = self.terminal_command.clone()?;
        Some((command, self.terminal_args.clone().unwrap_or_default()))
    }

    /// Whether this method can be driven by running a subprocess.
    #[must_use]
    pub fn is_terminal_capable(&self) -> bool {
        self.kind == AuthMethodKind::Terminal || self.terminal_command.is_some()
    }
}

/// One `vars[]` entry. Skips malformed items rather than failing the method —
/// the schema itself uses `VecSkipError` here, so a bad entry must not discard
/// the good ones alongside it.
fn parse_env_var(v: &Value) -> Option<AuthEnvVar> {
    let obj = v.as_object()?;
    let name = obj.get("name")?.as_str()?.to_string();
    Some(AuthEnvVar {
        name,
        label: obj.get("label").and_then(|l| l.as_str()).map(String::from),
        secret: obj.get("secret").and_then(|b| b.as_bool()).unwrap_or(true),
        optional: obj.get("optional").and_then(|b| b.as_bool()).unwrap_or(false),
    })
}

struct TerminalAuth {
    command: String,
    args: Vec<String>,
    label: Option<String>,
}

fn extract_terminal_auth(meta: &Map<String, Value>) -> Option<TerminalAuth> {
    let ta = meta.get("terminal-auth")?.as_object()?;
    let command = ta.get("command").and_then(|v| v.as_str())?.to_string();
    let args = ta
        .get("args")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let label = ta.get("label").and_then(|v| v.as_str()).map(String::from);
    Some(TerminalAuth { command, args, label })
}

/// Whether this session's guard is blocking late traffic (cancelled / torn
/// down). A missing guard passes through, matching the notification handler:
/// early requests can land before `new_session` returns and installs it.
fn session_blocked(guards: &Arc<SessionGuards>, session_id: &SessionId) -> bool {
    guards
        .get(session_id)
        .map(|g| g.is_blocked())
        .unwrap_or(false)
}

fn cancelled_session() -> agent_client_protocol::Error {
    agent_client_protocol::Error::request_cancelled()
}

/// Map an engine exit into the wire shape.
fn to_exit_status(exit: CommandExit) -> TerminalExitStatus {
    let mut status = TerminalExitStatus::new();
    status.exit_code = exit.exit_code;
    status.signal = exit.signal;
    status
}

/// The error for a terminal id the host does not know. Distinct from a generic
/// internal error so an agent can tell "you released it already" from "the
/// command blew up".
fn unknown_terminal(
    id: &agent_client_protocol::schema::v1::TerminalId,
) -> agent_client_protocol::Error {
    agent_client_protocol::Error::invalid_params()
        .data(serde_json::json!({ "terminalId": id.0.as_ref() }))
}

/// What the driver hands back when initialize completes.
pub struct InitializedAgent {
    pub connection: ConnectionTo<Agent>,
    pub auth_methods: Vec<AuthMethodWire>,
    /// Everything the agent advertised. See [`AgentCaps`].
    pub caps: AgentCaps,
}

/// Spawn an ACP agent and wait for its `initialize` handshake to complete.
///
/// Returns once `InitializeRequest` has round-tripped. The driver task continues
/// running in the background until `shutdown_tx` is dropped or the agent
/// process exits.
pub async fn spawn_agent(
    agent_id: AgentId,
    command: String,
    sink: Arc<dyn EventSink>,
) -> Result<AgentRuntime> {
    let pending: Arc<PendingPermissions> = Arc::new(DashMap::new());
    let guards: Arc<SessionGuards> = Arc::new(DashMap::new());
    let (ready_tx, ready_rx) = oneshot::channel::<Result<InitializedAgent>>();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    let terminals: Arc<CommandTerminals> = Arc::new(CommandTerminals::new());
    let elicitations: Arc<PendingElicitations> = Arc::new(DashMap::new());
    let elicitations_for_task = elicitations.clone();
    let pending_for_task = pending.clone();
    let guards_for_task = guards.clone();
    let terminals_for_task = terminals.clone();
    let sink_for_task = sink.clone();
    let command_for_task = command.clone();
    let model_sniffer: Arc<ModelSniffer> = Arc::new(ModelSniffer::new());
    let sniffer_for_task = model_sniffer.clone();

    // Trailing stderr from the agent process (ring buffer, newest last). When
    // the driver dies, the tail rides on the AgentDisconnected reason so the
    // user sees WHY the process exited (panic message, missing module, OOM
    // note) instead of a bare "driver exited".
    let stderr_tail: Arc<std::sync::Mutex<std::collections::VecDeque<String>>> =
        Arc::new(std::sync::Mutex::new(std::collections::VecDeque::new()));
    let stderr_for_task = stderr_tail.clone();

    let driver_handle = tokio::spawn(async move {
        let result = run_driver(
            agent_id,
            command_for_task,
            sink_for_task.clone(),
            pending_for_task,
            guards_for_task,
            terminals_for_task,
            elicitations_for_task,
            stderr_for_task.clone(),
            sniffer_for_task,
            ready_tx,
            shutdown_rx,
        )
        .await;

        let mut reason = match &result {
            Ok(()) => "driver exited cleanly".to_string(),
            Err(e) => format!("driver error: {e}"),
        };
        if let Ok(tail) = stderr_for_task.lock() {
            if !tail.is_empty() {
                let joined: Vec<&str> = tail.iter().map(String::as_str).collect();
                reason = format!("{reason}\nrecent stderr:\n{}", joined.join("\n"));
            }
        }
        sink_for_task.emit(agent_id, AcpEvent::AgentDisconnected { reason }, None);
        result
    });

    let initialized = match ready_rx.await {
        // The driver answered: either a successful handshake or an explicit
        // initialize error. Propagate as-is.
        Ok(res) => res?,
        // `ready_tx` was dropped without sending — the driver task returned
        // (or panicked) BEFORE the `initialize` handshake completed, most
        // commonly because the agent subprocess failed to spawn (e.g. `npx`
        // / `node` not on PATH → ENOENT). The generic "task panicked"
        // message hid that real cause; recover it from the join handle so
        // the user sees the actual failure instead of a useless panic string.
        Err(_) => {
            return Err(match driver_handle.await {
                // Returned Ok(()) but never sent ready — shouldn't happen,
                // but don't claim a panic if it does.
                Ok(Ok(())) => {
                    AcpError::other("agent process exited before completing initialize")
                }
                // The real, actionable error (ENOENT, spawn failure, …).
                Ok(Err(e)) => e,
                // Genuine panic in the driver task.
                Err(join_err) => {
                    AcpError::other(format!("driver task panicked before initialize: {join_err}"))
                }
            });
        }
    };

    Ok(AgentRuntime {
        connection: initialized.connection,
        pending_permissions: pending,
        session_guards: guards,
        shutdown_tx: Some(shutdown_tx),
        auth_methods: initialized.auth_methods,
        caps: initialized.caps,
        pending_elicitations: elicitations,
        sink,
        terminals,
        model_sniffer,
    })
}

async fn run_driver(
    agent_id: AgentId,
    command: String,
    sink: Arc<dyn EventSink>,
    pending: Arc<PendingPermissions>,
    guards: Arc<SessionGuards>,
    terminals: Arc<CommandTerminals>,
    elicitations: Arc<PendingElicitations>,
    stderr_tail: Arc<std::sync::Mutex<std::collections::VecDeque<String>>>,
    model_sniffer: Arc<ModelSniffer>,
    ready_tx: oneshot::Sender<Result<InitializedAgent>>,
    shutdown_rx: oneshot::Receiver<()>,
) -> Result<()> {
    /// Trailing stderr lines kept for the disconnect reason.
    const STDERR_TAIL_LINES: usize = 20;
    let sink_dbg = sink.clone();
    let agent = AcpAgent::from_str(&command)?.with_debug(move |line, direction| {
        // Stderr lines from the agent process are the most useful for
        // post-mortem debugging — surface them through `tracing` so the host
        // can subscribe with the regular logging machinery, and keep a small
        // tail for the AgentDisconnected reason.
        match direction {
            LineDirection::Stderr => {
                tracing::warn!(target: "atlas_acp::agent_stderr", agent = ?agent_id, "{line}");
                if let Ok(mut tail) = stderr_tail.lock() {
                    if tail.len() >= STDERR_TAIL_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(line.trim_end().to_string());
                }
            }
            LineDirection::Stdin => {
                tracing::trace!(target: "atlas_acp::stdin", agent = ?agent_id, "{line}");
                model_sniffer.observe_outgoing(&line);
            }
            LineDirection::Stdout => {
                tracing::trace!(target: "atlas_acp::stdout", agent = ?agent_id, "{line}");
                model_sniffer.observe_incoming(&line);
            }
        }
        let _ = &sink_dbg; // keep sink alive in this scope; reserved for future ring-buffer
    });

    let sink_notif = sink.clone();
    let sink_perm = sink.clone();
    let pending_for_handler = pending.clone();
    let guards_for_notif = guards.clone();
    let guards_for_perm = guards.clone();
    // One clone per handler closure — each `.on_receive_request` takes ownership
    // of what it captures, so they cannot share a single binding.
    let terminals_create = terminals.clone();
    let terminals_output = terminals.clone();
    let terminals_wait = terminals.clone();
    let terminals_kill = terminals.clone();
    let terminals_release = terminals.clone();
    let elicitations_for_handler = elicitations.clone();
    let sink_for_elicit = sink.clone();
    let guards_for_read = guards.clone();
    let guards_for_write = guards.clone();
    // One pump per terminal-shaped tool call (P1.4).
    let pumped: crate::terminal_pump::PumpedCalls = Arc::new(dashmap::DashSet::new());
    let pumped_for_notif = pumped.clone();
    let terminals_for_pump = terminals.clone();
    let sink_for_pump = sink.clone();

    agent_client_protocol::Client
        .builder()
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                // Drop late updates for cancelled sessions at the
                // protocol boundary. Without this gate, assistant
                // chunks or tool calls emitted between the user's Stop
                // and the agent's terminal `stop_reason: cancelled`
                // would contaminate the transcript.
                //
                // "Guard missing" is treated as PASS-THROUGH (not
                // blocked) deliberately: the agent often emits early
                // notifications (e.g. `available_commands_update`)
                // before `new_session` returns to the host, so the
                // guard may not be installed yet when those land.
                // Guards only exist to BLOCK; absence means "no
                // opinion, let it through."
                let mut turn = None;
                if let Some(guard) = guards_for_notif.get(&notification.session_id) {
                    if guard.is_blocked() {
                        tracing::debug!(
                            target: "atlas_acp::driver",
                            agent = ?agent_id,
                            session = ?notification.session_id,
                            "dropping late SessionUpdate (session cancelled)"
                        );
                        return Ok(());
                    }
                    turn = guard.current_turn();
                }
                // A tool call whose content is a bare `terminalId` renders as
                // nothing on its own — start tailing the terminal so its output
                // streams into the card through the `_meta.terminal_output`
                // path the apply layer already handles (P1.4).
                for (tool_call_id, terminal_id) in
                    crate::terminal_pump::terminal_refs(&notification.update)
                {
                    crate::terminal_pump::spawn(
                        &pumped_for_notif,
                        &terminals_for_pump,
                        sink_for_pump.clone(),
                        agent_id,
                        notification.session_id.clone(),
                        turn,
                        tool_call_id,
                        terminal_id,
                    );
                }
                sink_notif.emit(
                    agent_id,
                    AcpEvent::SessionUpdate {
                        session_id: notification.session_id,
                        update: notification.update,
                    },
                    turn,
                );
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        // ── elicitation/create (P3.3) ────────────────────────────────────
        // The agent asks the USER something mid-turn. Mirrors the permission
        // handler exactly: stash a oneshot under a fresh id, emit an event, and
        // answer from the Tauri layer whenever the user responds. Answering
        // inline is impossible — a human is in the loop.
        .on_receive_request(
            async move |request: CreateElicitationRequest, responder, connection| {
                let pending = elicitations_for_handler.clone();
                let sink = sink_for_elicit.clone();
                let request_id = Uuid::new_v4();
                let (tx, rx) = oneshot::channel::<ElicitationAction>();
                pending.insert(request_id, PendingElicitationEntry { sender: tx });

                // Project the mode via JSON: `ElicitationMode` is
                // `#[non_exhaustive]` and unstable-gated, and the UI builds a
                // form from `requestedSchema` rather than matching variants.
                let raw = serde_json::to_value(&request.mode).unwrap_or_default();
                let mode = raw
                    .get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("form")
                    .to_string();
                let session_id = raw
                    .pointer("/scope/sessionId")
                    .and_then(|v| v.as_str())
                    .map(|s| SessionId::new(s.to_string()));
                sink.emit(
                    agent_id,
                    AcpEvent::Elicitation {
                        session_id,
                        request_id,
                        mode,
                        message: request.message.clone(),
                        requested_schema: raw.get("requestedSchema").cloned(),
                        url: raw.get("url").and_then(|u| u.as_str()).map(str::to_owned),
                    },
                    None,
                );

                connection.spawn(async move {
                    let action = rx.await.unwrap_or_else(|_| {
                        // Sender dropped (agent killed, app shutdown). ACP has
                        // an explicit `cancel` action for exactly this, which
                        // is far better than leaving the agent blocked forever.
                        ElicitationAction::Cancel
                    });
                    pending.remove(&request_id);
                    responder.respond(CreateElicitationResponse::new(action))
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        // ── fs/* (P1.3) ──────────────────────────────────────────────────
        // Both are gated on the session guard, the same gate the notification
        // and permission handlers use. A cancelled session must not still be
        // writing to the user's files: after Stop, an in-flight
        // `fs/write_text_file` is exactly the late effect the guard exists to
        // suppress. Reads are gated too, for consistency and so a cancelled
        // turn stops doing work.
        .on_receive_request(
            async move |request: ReadTextFileRequest, responder, connection| {
                let guards = guards_for_read.clone();
                connection.spawn(async move {
                    if session_blocked(&guards, &request.session_id) {
                        return responder.respond_with_error(cancelled_session());
                    }
                    match crate::fs::read_text_file(
                        &request.path,
                        request.line,
                        request.limit,
                    ) {
                        Ok(content) => responder.respond(ReadTextFileResponse::new(content)),
                        Err(e) => responder.respond_with_internal_error(e),
                    }
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: WriteTextFileRequest, responder, connection| {
                let guards = guards_for_write.clone();
                connection.spawn(async move {
                    if session_blocked(&guards, &request.session_id) {
                        return responder.respond_with_error(cancelled_session());
                    }
                    match crate::fs::write_text_file(&request.path, &request.content) {
                        Ok(()) => {
                            tracing::debug!(
                                target: "atlas_acp::driver",
                                path = %request.path.display(),
                                bytes = request.content.len(),
                                "fs/write_text_file"
                            );
                            responder.respond(WriteTextFileResponse::new())
                        }
                        Err(e) => responder.respond_with_internal_error(e),
                    }
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        // ── terminal/* (P1.2) ────────────────────────────────────────────
        // Five client-served methods backed by `atlas_terminal::command`. The
        // capability that advertises them lives in `capabilities::SERVED`; the
        // truthfulness test there fails if these registrations and that flag
        // ever get out of step.
        //
        // Each handler answers inside `connection.spawn` rather than inline:
        // `terminal/wait_for_exit` blocks for the whole lifetime of the
        // command, and holding the protocol loop for a 10-minute build would
        // stall every other message on the connection — including the
        // `session/cancel` the user presses to stop it.
        .on_receive_request(
            async move |request: CreateTerminalRequest, responder, connection| {
                let terminals = terminals_create.clone();
                connection.spawn(async move {
                    let env: Vec<(String, String)> = request
                        .env
                        .iter()
                        .map(|v| (v.name.clone(), v.value.clone()))
                        .collect();
                    let limit = request.output_byte_limit.unwrap_or(DEFAULT_OUTPUT_BYTE_LIMIT);
                    let spawned = CommandTerminal::spawn(
                        &request.command,
                        &request.args,
                        &env,
                        request.cwd.as_deref(),
                        limit,
                    );
                    match spawned {
                        Ok(terminal) => {
                            let id = terminals
                                .insert(request.session_id.0.as_ref(), terminal);
                            tracing::debug!(
                                target: "atlas_acp::driver",
                                terminal_id = %id,
                                command = %request.command,
                                "terminal/create"
                            );
                            responder.respond(CreateTerminalResponse::new(id))
                        }
                        Err(e) => {
                            // A command that cannot start (missing binary, bad
                            // cwd) is the agent's problem to handle, so it gets
                            // a protocol error rather than a phantom terminal
                            // whose every later call would 404.
                            tracing::warn!(
                                target: "atlas_acp::driver",
                                command = %request.command,
                                error = %e,
                                "terminal/create failed"
                            );
                            responder.respond_with_internal_error(e)
                        }
                    }
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: TerminalOutputRequest, responder, connection| {
                let terminals = terminals_output.clone();
                connection.spawn(async move {
                    let Some(term) = terminals.get(request.terminal_id.0.as_ref()) else {
                        return responder.respond_with_error(unknown_terminal(&request.terminal_id));
                    };
                    let (output, truncated) = term.output();
                    let mut resp = TerminalOutputResponse::new(output, truncated);
                    // Present only once the command has finished; while it runs
                    // the agent polls this to stream progress.
                    resp.exit_status = term.exit_status().map(to_exit_status);
                    responder.respond(resp)
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: WaitForTerminalExitRequest, responder, connection| {
                let terminals = terminals_wait.clone();
                connection.spawn(async move {
                    let Some(term) = terminals.get(request.terminal_id.0.as_ref()) else {
                        return responder.respond_with_error(unknown_terminal(&request.terminal_id));
                    };
                    let exit = term.wait_for_exit().await;
                    responder.respond(WaitForTerminalExitResponse::new(to_exit_status(exit)))
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: KillTerminalRequest, responder, connection| {
                let terminals = terminals_kill.clone();
                connection.spawn(async move {
                    let Some(term) = terminals.get(request.terminal_id.0.as_ref()) else {
                        return responder.respond_with_error(unknown_terminal(&request.terminal_id));
                    };
                    // Kill but KEEP the entry: ACP lets the agent read output
                    // and exit status after killing, and only `terminal/release`
                    // drops the handle.
                    let _ = term.kill();
                    responder.respond(KillTerminalResponse::new())
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: ReleaseTerminalRequest, responder, connection| {
                let terminals = terminals_release.clone();
                connection.spawn(async move {
                    // Releasing an unknown terminal is not an error — the agent
                    // may release twice, or release one the session teardown
                    // already reaped.
                    terminals.release(request.terminal_id.0.as_ref());
                    responder.respond(ReleaseTerminalResponse::new())
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, connection| {
                // Auto-reject permission requests for cancelled
                // sessions. The agent gets a clean `Cancelled`
                // outcome (so its turn can wind down per ACP spec)
                // and the frontend never sees a popup it shouldn't
                // have to dismiss.
                //
                // Missing guard = pass through (see notification
                // handler comment for why).
                let blocked = guards_for_perm
                    .get(&request.session_id)
                    .map(|g| g.is_blocked())
                    .unwrap_or(false);
                if blocked {
                    tracing::debug!(
                        target: "atlas_acp::driver",
                        agent = ?agent_id,
                        session = ?request.session_id,
                        "auto-cancelling permission request for cancelled session"
                    );
                    return responder.respond(RequestPermissionResponse::new(
                        RequestPermissionOutcome::Cancelled,
                    ));
                }

                let request_id = Uuid::new_v4();
                let (tx, rx) = oneshot::channel::<RequestPermissionOutcome>();
                pending_for_handler.insert(
                    request_id,
                    PendingPermissionEntry {
                        session_id: request.session_id.clone(),
                        sender: tx,
                    },
                );

                let turn = guards_for_perm
                    .get(&request.session_id)
                    .and_then(|g| g.current_turn());
                sink_perm.emit(
                    agent_id,
                    AcpEvent::PermissionRequest {
                        request_id,
                        session_id: request.session_id.clone(),
                        tool_call: request.tool_call.clone(),
                        options: request.options.clone(),
                    },
                    turn,
                );

                // Await the user's decision OUTSIDE the dispatch loop. `on_*`
                // handlers block the loop until they return (see the crate's
                // ordering docs) — awaiting a human here froze every OTHER
                // session multiplexed on this driver (all projects using this
                // plugin): their deltas, prompt results, and permission
                // requests all sat unread until this modal was answered.
                // Spawning frees the loop immediately; the responder is moved
                // into the task and answers whenever the user clicks.
                let pending = pending_for_handler.clone();
                connection.spawn(async move {
                    let outcome = rx.await.unwrap_or_else(|_| {
                        // Sender dropped (registry kill, app shutdown,
                        // cancel_turn) — ACP spec: treat as Cancelled.
                        RequestPermissionOutcome::Cancelled
                    });
                    pending.remove(&request_id);
                    responder.respond(RequestPermissionResponse::new(outcome))
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, |connection: ConnectionTo<Agent>| async move {
            // Built from `capabilities::SERVED` — the single table that also
            // backs the truthfulness test, so Atlas can never promise a method
            // it has no handler for. Every flag flips there, not here.
            let caps = crate::capabilities::client_capabilities();

            let init_result = connection
                .send_request(
                    InitializeRequest::new(ProtocolVersion::V1).client_capabilities(caps),
                )
                .block_task()
                .await;

            match init_result {
                Ok(resp) => {
                    // Re-serialize and pick out the auth methods as JSON.
                    // See AuthMethodWire::from_json for why.
                    let methods: Vec<AuthMethodWire> = serde_json::to_value(&resp)
                        .ok()
                        .and_then(|v| {
                            v.get("authMethods")
                                .and_then(|a| a.as_array())
                                .map(|arr| {
                                    arr.iter()
                                        .filter_map(AuthMethodWire::from_json)
                                        .collect()
                                })
                        })
                        .unwrap_or_default();
                    // Capture the WHOLE capability tree, not just the two
                    // fields the pre-P0.3 code read. Downstream tasks (P1.1
                    // mcpServers, P2.1 embeddedContext, P2.3 resume/list/close,
                    // P3.2/P3.4/P3.6, A2 logout) then need a struct read rather
                    // than another handshake.
                    let caps = AgentCaps::from_agent(&resp.agent_capabilities);
                    tracing::debug!(?caps, "agent capabilities captured at initialize");
                    let _ = ready_tx.send(Ok(InitializedAgent {
                        connection: connection.clone(),
                        auth_methods: methods,
                        caps,
                    }));
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(AcpError::Protocol(format!("{e:?}"))));
                    return Err(e);
                }
            }

            // Park until the host asks us to shut down. The protocol stays
            // open as long as this future is alive; closing it lets the SDK
            // tear down the subprocess cleanly.
            let _ = shutdown_rx.await;
            Ok(())
        })
        .await?;

    Ok(())
}


#[cfg(test)]
mod auth_method_tests {
    use super::*;

    /// Verbatim from `npx -y @agentclientprotocol/claude-agent-acp` (R1,
    /// 2026-08-19). Typed `terminal` AND the `_meta` fallback, together.
    #[test]
    fn claude_terminal_method_parses_both_the_type_and_the_runnable_command() {
        let raw = serde_json::json!({
            "id": "claude-ai-login",
            "name": "Claude Subscription",
            "description": "Use Claude subscription ",
            "type": "terminal",
            "args": ["--cli", "auth", "login", "--claudeai"],
            "_meta": { "terminal-auth": {
                "command": "/usr/local/bin/node",
                "args": ["/tmp/.bin/claude-agent-acp", "--cli", "auth", "login", "--claudeai"],
                "label": "Claude Login"
            }}
        });
        let m = AuthMethodWire::from_json(&raw).expect("parses");
        assert_eq!(m.kind, AuthMethodKind::Terminal);
        assert_eq!(m.args, vec!["--cli", "auth", "login", "--claudeai"]);
        let (cmd, args) = m.runnable_terminal().expect("meta supplies the binary");
        assert_eq!(cmd, "/usr/local/bin/node");
        assert_eq!(args[0], "/tmp/.bin/claude-agent-acp");
        assert!(m.is_terminal_capable());
    }

    /// The inversion worth remembering: typed `args` alone cannot be executed,
    /// because the protocol never names the binary they belong to.
    #[test]
    fn a_terminal_method_without_meta_has_no_runnable_command() {
        let m = AuthMethodWire::from_json(&serde_json::json!({
            "id": "x", "name": "X", "type": "terminal", "args": ["auth", "login"]
        }))
        .expect("parses");
        assert_eq!(m.kind, AuthMethodKind::Terminal);
        assert!(
            m.runnable_terminal().is_none(),
            "typed args are relative to an unnamed binary — enrichment must fill this"
        );
    }

    /// Verbatim from `npx -y @agentclientprotocol/codex-acp` (R1): no `type`
    /// field at all, plus a proprietary api-key hint.
    #[test]
    fn codex_api_key_method_is_an_agent_method_with_a_provider_hint() {
        let m = AuthMethodWire::from_json(&serde_json::json!({
            "id": "api-key",
            "name": "API Key",
            "description": "Use an API key to authenticate",
            "_meta": { "api-key": { "provider": "openai" } }
        }))
        .expect("parses");
        assert_eq!(m.kind, AuthMethodKind::Agent, "absent type means agent");
        assert_eq!(m.api_key_provider.as_deref(), Some("openai"));
        assert!(!m.is_terminal_capable());
    }

    #[test]
    fn codex_chat_gpt_method_is_a_bare_agent_method() {
        let m = AuthMethodWire::from_json(&serde_json::json!({
            "id": "chat-gpt", "name": "ChatGPT"
        }))
        .expect("parses");
        assert_eq!(m.kind, AuthMethodKind::Agent);
        assert!(m.api_key_provider.is_none());
        assert!(m.env_vars.is_empty());
    }

    /// No adapter ships this yet (R1), so the branch is spec-driven — which is
    /// exactly why it needs a test pinning the schema's defaults.
    #[test]
    fn an_env_var_method_parses_vars_and_link() {
        let m = AuthMethodWire::from_json(&serde_json::json!({
            "id": "gemini-key",
            "name": "Gemini API Key",
            "type": "env_var",
            "link": "https://aistudio.google.com/apikey",
            "vars": [
                { "name": "GEMINI_API_KEY", "label": "Gemini key" },
                { "name": "GOOGLE_PROJECT", "secret": false, "optional": true }
            ]
        }))
        .expect("parses");
        assert_eq!(m.kind, AuthMethodKind::EnvVar);
        assert_eq!(m.link.as_deref(), Some("https://aistudio.google.com/apikey"));
        assert_eq!(m.env_vars.len(), 2);
        // Defaults must be the SAFER reading when the adapter omits them.
        assert!(m.env_vars[0].secret, "an unlabelled var is a secret");
        assert!(!m.env_vars[0].optional, "an unlabelled var is required");
        assert!(!m.env_vars[1].secret && m.env_vars[1].optional);
    }

    /// The schema uses `VecSkipError` for `vars`; a malformed entry must not
    /// take the well-formed ones with it.
    #[test]
    fn a_malformed_var_entry_is_skipped_not_fatal() {
        let m = AuthMethodWire::from_json(&serde_json::json!({
            "id": "k", "name": "K", "type": "env_var",
            "vars": [ { "label": "no name here" }, { "name": "REAL_KEY" } ]
        }))
        .expect("parses");
        assert_eq!(m.env_vars.len(), 1);
        assert_eq!(m.env_vars[0].name, "REAL_KEY");
    }

    /// These variants are UNSTABLE — a future `type` must degrade, not break.
    #[test]
    fn an_unknown_type_degrades_to_agent() {
        let m = AuthMethodWire::from_json(&serde_json::json!({
            "id": "future", "name": "Future", "type": "webauthn_or_something"
        }))
        .expect("parses");
        assert_eq!(m.kind, AuthMethodKind::Agent);
    }

    #[test]
    fn a_method_without_an_id_is_rejected() {
        assert!(AuthMethodWire::from_json(&serde_json::json!({ "name": "no id" })).is_none());
    }

    /// The TS side destructures these names; camelCase is the contract.
    #[test]
    fn the_wire_shape_is_camel_case() {
        let m = AuthMethodWire::from_json(&serde_json::json!({
            "id": "a", "name": "A", "type": "env_var",
            "link": "https://example.test",
            "vars": [{ "name": "K" }],
            "_meta": { "api-key": { "provider": "openai" } }
        }))
        .expect("parses");
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["kind"], "env_var");
        assert_eq!(v["envVars"][0]["name"], "K");
        assert_eq!(v["apiKeyProvider"], "openai");
        assert!(v.get("link").is_some());
    }
}

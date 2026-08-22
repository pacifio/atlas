use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    ClientCapabilities, FileSystemCapabilities, InitializeRequest, ReadTextFileRequest,
    ReadTextFileResponse, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SessionId, SessionNotification, WriteTextFileRequest,
    WriteTextFileResponse,
};
use agent_client_protocol::{AcpAgent, Agent, ConnectionTo, LineDirection};
use dashmap::DashMap;
use serde::Serialize;
use serde_json::{Map, Value};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::error::{AcpError, Result};
use crate::events::{AcpEvent, EventSink};
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

/// Permissions awaiting a client decision.
///
/// The notification handler stashes a [`oneshot::Sender`] under a fresh
/// `request_id`; the Tauri layer resolves it via `acp_respond_permission` once
/// the user clicks a button. Tracks `session_id` so `cancel_turn` can drop
/// the right ones (per ACP spec, any pending permission for a cancelled turn
/// MUST resolve as `Cancelled`).
pub type PendingPermissions = DashMap<Uuid, PendingPermissionEntry>;

/// Image attachments staged for the *next* prompt of each session, drained
/// one-shot when that prompt is sent. A separate low-churn side-channel so
/// the `text: String` prompt seam stays untouched. Safe because the frontend
/// serialises sends per session — exactly one prompt is staged-then-fired at
/// a time, so each turn drains its own images.
pub type PendingAttachments = DashMap<SessionId, Vec<crate::registry::ImageAttachment>>;

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
    /// Whether the agent advertised `promptCapabilities.image` at
    /// initialize. Gates whether staged image attachments are sent as
    /// `ContentBlock::Image` or dropped (sending them anyway would violate
    /// the ACP spec).
    pub prompt_image_supported: bool,
    /// Images staged for each session's next prompt. See [`PendingAttachments`].
    pub pending_attachments: Arc<PendingAttachments>,
}

/// JSON-friendly projection of `AuthMethod` for the wire. The ACP Rust
/// schema's `AuthMethod` struct only has `id`/`name`/`description`/`meta`,
/// but claude-agent-acp puts the actual usable spec (subprocess command +
/// args) inside `_meta.terminal-auth`. We pull that out here so the
/// frontend doesn't have to know the meta key layout.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthMethodWire {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// `_meta.terminal-auth.command` — typically `process.execPath` (the
    /// adapter's Node binary). Required to actually run the auth flow.
    pub terminal_command: Option<String>,
    /// `_meta.terminal-auth.args` — the full argv tail to hand to the
    /// command above (already includes `--cli auth login --claudeai`
    /// etc., relative to the adapter binary).
    pub terminal_args: Option<Vec<String>>,
    /// `_meta.terminal-auth.label` — human-readable label the adapter
    /// suggests for any UI affordance that runs the spec.
    pub terminal_label: Option<String>,
}

impl AuthMethodWire {
    /// Project an `AuthMethod` re-serialized as JSON. We go through JSON
    /// instead of matching the enum directly because the `Terminal`
    /// variant is gated on the `unstable_auth_methods` feature flag and
    /// without it the wire-level `type: "terminal"` + top-level `args`
    /// silently fall through to the `Agent` variant during deserialization.
    /// The `_meta.terminal-auth` block survives either way and is the
    /// canonical source of the subprocess spec — read it directly.
    fn from_json(v: &Value) -> Option<Self> {
        let obj = v.as_object()?;
        let id = obj.get("id")?.as_str()?.to_string();
        let name = obj.get("name")?.as_str()?.to_string();
        let description = obj.get("description").and_then(|d| d.as_str()).map(String::from);
        let (terminal_command, terminal_args, terminal_label) = obj
            .get("_meta")
            .and_then(|m| m.as_object())
            .and_then(|m| extract_terminal_auth(m))
            .map(|t| (Some(t.command), Some(t.args), t.label))
            .unwrap_or((None, None, None));
        Some(Self {
            id,
            name,
            description,
            terminal_command,
            terminal_args,
            terminal_label,
        })
    }
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

/// What the driver hands back when initialize completes.
pub struct InitializedAgent {
    pub connection: ConnectionTo<Agent>,
    pub auth_methods: Vec<AuthMethodWire>,
    pub prompt_image_supported: bool,
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

    let pending_for_task = pending.clone();
    let guards_for_task = guards.clone();
    let sink_for_task = sink.clone();
    let command_for_task = command.clone();

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
            stderr_for_task.clone(),
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
        prompt_image_supported: initialized.prompt_image_supported,
        pending_attachments: Arc::new(DashMap::new()),
    })
}

async fn run_driver(
    agent_id: AgentId,
    command: String,
    sink: Arc<dyn EventSink>,
    pending: Arc<PendingPermissions>,
    guards: Arc<SessionGuards>,
    stderr_tail: Arc<std::sync::Mutex<std::collections::VecDeque<String>>>,
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
            }
            LineDirection::Stdout => {
                tracing::trace!(target: "atlas_acp::stdout", agent = ?agent_id, "{line}");
            }
        }
        let _ = &sink_dbg; // keep sink alive in this scope; reserved for future ring-buffer
    });

    let sink_notif = sink.clone();
    let sink_perm = sink.clone();
    let sink_write = sink.clone();
    let pending_for_handler = pending.clone();
    let guards_for_notif = guards.clone();
    let guards_for_perm = guards.clone();
    let guards_for_write = guards.clone();

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
        .on_receive_request(
            async move |request: WriteTextFileRequest, responder, _connection| {
                // The ACP filesystem service. An agent that honours our
                // advertised `fs.writeTextFile` sends the edit here instead of
                // touching the disk itself, so this handler is BOTH the write
                // and the capture signal.
                //
                // Surfaced as an ordinary `tool_call` session update rather
                // than a bespoke event: everything downstream — the turn card's
                // file chips, `canonical_name`, the write sampler, the file
                // touch that becomes a Checkpoint — already understands that
                // shape. A new event type would need re-teaching at every one
                // of those layers.
                let path = request.path.clone();
                let display = path.file_name().map(|n| n.to_string_lossy().into_owned());
                let existed = path.exists();
                let result = std::fs::create_dir_all(
                    path.parent().unwrap_or_else(|| std::path::Path::new("/")),
                )
                .and_then(|()| std::fs::write(&path, request.content.as_bytes()));

                if let Err(e) = &result {
                    tracing::warn!(
                        target: "atlas_acp::driver",
                        agent = ?agent_id,
                        path = %path.display(),
                        "fs/write_text_file failed: {e}"
                    );
                }

                if result.is_ok() {
                    let turn = guards_for_write
                        .get(&request.session_id)
                        .and_then(|g| g.current_turn());
                    let update = fs_write_tool_call(
                        &format!("atlas-fs-write-{}", Uuid::new_v4()),
                        &path,
                        &request.content,
                        existed,
                        display.as_deref(),
                    );
                    if let Ok(update) = serde_json::from_value(update) {
                        sink_write.emit(
                            agent_id,
                            AcpEvent::SessionUpdate {
                                session_id: request.session_id.clone(),
                                update,
                            },
                            turn,
                        );
                    }
                }

                match result {
                    Ok(()) => responder.respond(WriteTextFileResponse::default()),
                    Err(e) => responder.respond_with_error(agent_client_protocol::Error::into_internal_error(e)),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: ReadTextFileRequest, responder, _connection| {
                // The read half. Not a capture signal (reads never produce a
                // Checkpoint), but it must exist: advertising `readTextFile`
                // and then failing the call would break every agent that takes
                // us at our word.
                //
                // `line`/`limit` are honoured — an agent asking for a slice of
                // a large file must not be handed the whole thing.
                let path = request.path.clone();
                match std::fs::read_to_string(&path) {
                    Ok(text) => {
                        let content = match (request.line, request.limit) {
                            (None, None) => text,
                            (line, limit) => {
                                // ACP line numbers are 1-based.
                                let skip = line.unwrap_or(1).saturating_sub(1) as usize;
                                let take = limit.map(|l| l as usize).unwrap_or(usize::MAX);
                                text.lines()
                                    .skip(skip)
                                    .take(take)
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            }
                        };
                        responder.respond(ReadTextFileResponse::new(content))
                    }
                    Err(e) => {
                        tracing::debug!(
                            target: "atlas_acp::driver",
                            path = %path.display(),
                            "fs/read_text_file failed: {e}"
                        );
                        responder.respond_with_error(agent_client_protocol::Error::into_internal_error(e))
                    }
                }
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
            // Advertise `_meta.terminal-auth: true` so adapters like
            // claude-agent-acp populate the response's `authMethods`
            // with structured subprocess specs we can actually run.
            // Without this flag the adapter returns an empty auth-methods
            // list and `/login` has no way to launch the OAuth flow.
            //
            // `_meta.terminal_output: true` opts into LIVE command output:
            // claude-agent-acp and codex-acp share this meta contract — a
            // Bash-shaped tool_call carries `terminal_info` and its updates
            // stream `terminal_output` / `terminal_exit` in `_meta`, which
            // the apply layer folds into the tool call's visible result as
            // it runs. Without the flag both adapters only deliver output
            // once the command has finished. (Underscore vs. dash matches
            // each adapter's key exactly — Zed advertises both spellings.)
            // Advertise the ACP filesystem service, the way Zed does
            // (`client_capabilities_for_agent`). Two reasons, and the second is
            // the load-bearing one:
            //
            // 1. Agents that honour it stop touching the disk behind our back —
            //    gemini-cli's `AcpFileSystemService` routes through the client
            //    whenever the capability is advertised, and falls back to raw
            //    `fs` when it is not.
            // 2. It makes the write AUTHORITATIVE for session capture. Sniffing
            //    tool-call deltas is inference — every agent announces edits
            //    differently, and each new adapter is a fresh way to miss one.
            //    An `fs/write_text_file` request is the agent telling us
            //    exactly which path it is changing, with the content in hand.
            let mut caps = ClientCapabilities::default();
            caps.fs = FileSystemCapabilities::new()
                .read_text_file(true)
                .write_text_file(true);
            let mut meta = Map::new();
            meta.insert("terminal-auth".into(), Value::Bool(true));
            meta.insert("terminal_output".into(), Value::Bool(true));
            // Cursor-only capability (Zed sends it too): opts into
            // parameterized model ids like `gpt-5.4[reasoning=medium]`.
            // Unknown meta keys are ignored per the ACP spec, so sending it
            // unconditionally beats plumbing a per-spec meta field.
            meta.insert("parameterizedModelPicker".into(), Value::Bool(true));
            caps.meta = Some(meta);

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
                    let prompt_image_supported =
                        resp.agent_capabilities.prompt_capabilities.image;
                    let _ = ready_tx.send(Ok(InitializedAgent {
                        connection: connection.clone(),
                        auth_methods: methods,
                        prompt_image_supported,
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

/// The `tool_call` session update that stands in for an `fs/write_text_file`.
///
/// Extracted so the shape can be tested: everything downstream keys off these
/// exact fields. `locations` is what the write sampler reads to derive the file
/// touch that becomes a Checkpoint; `rawInput.tool_name` is what
/// `canonical_name` classifies as write-shaped; the diff `content` is what the
/// turn card renders.
///
/// `Edit` vs `Write` follows whether the file already existed — the link rule
/// is asymmetric on exactly that distinction, so reporting it honestly here is
/// what lets a pre-existing file take the permissive arm.
pub(crate) fn fs_write_tool_call(
    call_id: &str,
    path: &std::path::Path,
    content: &str,
    existed: bool,
    display: Option<&str>,
) -> Value {
    let path_str = path.to_string_lossy();
    serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": call_id,
        "title": display.map(str::to_string).unwrap_or_else(|| path_str.to_string()),
        "kind": "edit",
        // The write already happened; there is no pending phase to report.
        "status": "completed",
        "locations": [{ "path": path_str }],
        "rawInput": {
            "tool_name": if existed { "Edit" } else { "Write" },
            "file_path": path_str,
            "content": content,
        },
        "content": [{
            "type": "diff",
            "path": path_str,
            "newText": content,
        }],
    })
}

#[cfg(test)]
mod fs_tests {
    use super::*;

    #[test]
    fn a_write_becomes_a_write_shaped_tool_call() {
        let v = fs_write_tool_call(
            "c1",
            std::path::Path::new("/tmp/project/greeting.txt"),
            "hello\n",
            false,
            Some("greeting.txt"),
        );
        assert_eq!(v["sessionUpdate"], "tool_call");
        assert_eq!(v["status"], "completed");
        assert_eq!(v["kind"], "edit");
        // The path must be in `locations` — that is the only field the write
        // sampler reads, and a Checkpoint depends on it.
        assert_eq!(v["locations"][0]["path"], "/tmp/project/greeting.txt");
        // A new file must classify as Write, so the link rule takes its strict
        // (content-checked) arm rather than crediting the agent on path alone.
        assert_eq!(v["rawInput"]["tool_name"], "Write");
        assert_eq!(v["rawInput"]["content"], "hello\n");
    }

    #[test]
    fn an_overwrite_reports_edit_so_the_permissive_arm_applies() {
        let v = fs_write_tool_call(
            "c2",
            std::path::Path::new("/tmp/project/existing.rs"),
            "fn main() {}\n",
            true,
            None,
        );
        assert_eq!(v["rawInput"]["tool_name"], "Edit");
        // No display name → the full path is the title.
        assert_eq!(v["title"], "/tmp/project/existing.rs");
    }

    #[test]
    fn the_diff_content_carries_the_written_text() {
        let v = fs_write_tool_call(
            "c3",
            std::path::Path::new("/tmp/p/a.txt"),
            "line one\nline two\n",
            false,
            Some("a.txt"),
        );
        assert_eq!(v["content"][0]["type"], "diff");
        assert_eq!(v["content"][0]["path"], "/tmp/p/a.txt");
        assert_eq!(v["content"][0]["newText"], "line one\nline two\n");
    }
}

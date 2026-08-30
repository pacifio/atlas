//! The `AgentConnection` the app plugs into, over the ported engine.
//!
//! This was the counterpart of the Cersei connection, now deleted (#54), and it
//! implements the same trait, because that is the whole point of the seam: the
//! app cannot tell which engine is behind it.
//!
//! # Shape
//!
//! One in-process app-server runtime per connection. Requests go out through a
//! cloneable handle; events come back on a single stream that only one owner
//! can read, so a pump task owns the client and everything else holds the
//! handle. That split is forced by the facade (`next_event` takes `&mut self`)
//! and it happens to be the right shape anyway — the pump is the one place
//! engine events become thread updates.
//!
//! # Why a turn needs both a response and a notification
//!
//! `turn/start` returns as soon as the turn is *accepted*, carrying a turn id
//! and `status: InProgress` — the permission-request test upstream proves it,
//! since it reads a server request only after the response has landed. The
//! turn's outcome arrives later, as a `TurnCompleted` notification.
//!
//! That splits the turn across two channels, and creates a race that has to be
//! closed rather than avoided: the waiter can only be registered *after* the
//! response, because the response is where the turn id comes from — but the
//! completion travels on the event stream, which is a different task and can
//! get there first. A short turn against a fast provider does exactly that.
//! Registering "before sending" is not available as a fix.
//!
//! So [`TurnWaiters`] buffers completions nobody is waiting for yet, and
//! `register` checks that buffer before it parks. Without it, `prompt` returns
//! a future that never resolves and the composer spins forever on a turn that
//! has already finished.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use agent_client_protocol::schema::v1 as acp;
use anyhow::anyhow;
use anyhow::Result;
use atlas_acp_thread::{
    AcpThread, AcpThreadHandle, AgentConnection, AgentId, AgentModelId, AgentModelInfo,
    AgentModelList, AgentModelSelector, AgentSessionModes, AuthorizationKind,
};
use crate::AgentSessionEffort;
use atlas_agent_servers::ThreadEventSink;
use codex_app_server_client::InProcessAppServerClient;
use codex_app_server_client::InProcessAppServerRequestHandle;
// The v2 protocol types are re-exported at the crate root
// (`pub use protocol::v2::*`), so this alias is the whole vocabulary.
use codex_app_server_protocol as v2;
use codex_app_server_protocol::ClientRequest;
use codex_app_server_protocol::RequestId;
use codex_app_server_protocol::ServerRequest;
use codex_app_server::in_process::InProcessServerEvent;
use codex_login::auth::ExternalAuth;
use codex_protocol::openai_models::ReasoningEffort;
use futures::future::BoxFuture;
use futures::FutureExt;
use tokio::sync::oneshot;

use crate::engine::config::EngineSettings;
use crate::engine::approvals;
use crate::engine::memory::{self, MemorySearch};
use crate::engine::modes;
use crate::engine::runtime::start_engine;
use crate::engine::runtime::EngineRuntime;
use crate::engine::sink::EngineSessions;
use crate::engine::sink::apply_notification;

/// Request ids Atlas mints for the engine.
///
/// The in-process transport still speaks the JSON-RPC envelope, so every
/// request needs an id, and the engine rejects a repeat with
/// `duplicate request id`.
///
/// **There is exactly one of these per connection, shared.** Every per-session
/// control handed out — modes, effort — mints from this same counter. Giving
/// them their own counters is the obvious-looking thing and it is wrong: each
/// starts at zero, so the first prompt after a mode or effort change collides
/// and the turn fails to start.
#[derive(Default)]
struct RequestIds(std::sync::atomic::AtomicI64);

impl RequestIds {
    fn next(&self) -> RequestId {
        RequestId::Integer(self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
    }
}

/// In-flight turns.
///
/// Two maps, because cancel and prompt need different keys. `prompt` waits on a
/// *turn* id — the notification is the only thing that carries the outcome. But
/// the protocol's cancel takes a thread *and* a turn id, while the app can only
/// name a session. So the thread→turn direction has to be recorded too, or
/// cancel has nothing to interrupt.
/// How many unclaimed completions to keep.
///
/// Only ever holds turns that finished between `turn/start` returning and
/// `prompt` registering — a window of microseconds — plus any turn started by
/// something other than `prompt`. Small and bounded so a long-lived connection
/// cannot accumulate them.
const UNCLAIMED_COMPLETIONS: usize = 16;

#[derive(Default)]
pub struct TurnWaiters {
    waiters: Mutex<HashMap<String, oneshot::Sender<v2::Turn>>>,
    active: Mutex<HashMap<String, String>>,
    /// Retry notices seen for a turn, so the pill can say *which* attempt.
    ///
    /// Counted here rather than read off the event, because the engine's
    /// stream-error notification carries a message and a `will_retry` flag and
    /// no attempt number (D8). The count is the honest reconstruction.
    attempts: Mutex<HashMap<String, usize>>,
    /// Completions that arrived before anyone asked for them. See the module
    /// docs: this is what closes the register-after-response race.
    unclaimed: Mutex<std::collections::VecDeque<v2::Turn>>,
}

impl TurnWaiters {
    fn register(&self, thread_id: &str, turn_id: &str) -> oneshot::Receiver<v2::Turn> {
        let (tx, rx) = oneshot::channel();

        // The completion may already have arrived. Claim it rather than parking
        // on a notification that has been and gone.
        let mut unclaimed = self.unclaimed();
        if let Some(pos) = unclaimed.iter().position(|t| t.id == turn_id) {
            let turn = unclaimed.remove(pos).expect("position just found");
            drop(unclaimed);
            let _ = tx.send(turn);
            return rx;
        }
        drop(unclaimed);

        self.waiters().insert(turn_id.to_string(), tx);
        self.active()
            .insert(thread_id.to_string(), turn_id.to_string());
        rx
    }

    /// Called from the pump.
    pub(crate) fn complete(&self, thread_id: &str, turn: v2::Turn) {
        // Clear the active entry first, and only if it still names *this* turn.
        // A later turn on the same thread must not have its entry removed by a
        // straggling completion from the previous one.
        let mut active = self.active();
        if active.get(thread_id).is_some_and(|id| id == &turn.id) {
            active.remove(thread_id);
        }
        drop(active);

        self.attempts
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&turn.id);

        if let Some(tx) = self.waiters().remove(&turn.id) {
            let _ = tx.send(turn);
            return;
        }
        // Nobody is waiting yet. Hold it for the register that is about to
        // happen; drop the oldest if this connection somehow accrues them.
        let mut unclaimed = self.unclaimed();
        unclaimed.push_back(turn);
        while unclaimed.len() > UNCLAIMED_COMPLETIONS {
            unclaimed.pop_front();
        }
    }

    /// Records one retry notice for a turn and returns its attempt number,
    /// counting from 1.
    pub(crate) fn note_retry(&self, turn_id: &str) -> usize {
        let mut attempts = self.attempts.lock().unwrap_or_else(|p| p.into_inner());
        let counter = attempts.entry(turn_id.to_string()).or_insert(0);
        *counter += 1;
        *counter
    }

    fn unclaimed(&self) -> std::sync::MutexGuard<'_, std::collections::VecDeque<v2::Turn>> {
        self.unclaimed.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The turn to interrupt for a session, if one is running.
    pub(crate) fn active_turn(&self, thread_id: &str) -> Option<String> {
        self.active().get(thread_id).cloned()
    }

    fn forget(&self, thread_id: &str, turn_id: &str) {
        self.waiters().remove(turn_id);
        let mut active = self.active();
        if active.get(thread_id).is_some_and(|id| id == turn_id) {
            active.remove(thread_id);
        }
    }

    fn waiters(&self) -> std::sync::MutexGuard<'_, HashMap<String, oneshot::Sender<v2::Turn>>> {
        self.waiters.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn active(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.active.lock().unwrap_or_else(|p| p.into_inner())
    }
}

pub struct EngineConnection {
    id: AgentId,
    requests: InProcessAppServerRequestHandle,
    sessions: Arc<EngineSessions>,
    turns: Arc<TurnWaiters>,
    thread_events: ThreadEventSink,
    request_ids: Arc<RequestIds>,
    settings: EngineSettings,
    /// The pump. Held so it is aborted when the connection is dropped rather
    /// than outliving it against a dead runtime.
    _pump: Arc<PumpHandle>,
    /// The engine's runtime. Dropped last, after the pump it hosts. Also the
    /// spawn target for fire-and-forget work started from SYNC entry points:
    /// `cancel` is called on whatever thread the host is on — the composer's
    /// stop button arrives on the MAIN thread — and a bare `tokio::spawn`
    /// there panics ("no reactor running") and aborts the whole app.
    runtime: Arc<EngineRuntime>,
    /// The mode each session is in.
    ///
    /// Held here because the engine has no "Atlas mode" concept to read back —
    /// it has an approval policy and a sandbox policy, and several modes could
    /// in principle produce the same pair. The mode the user picked is Atlas's
    /// fact to remember.
    session_modes: Arc<Mutex<HashMap<acp::SessionId, acp::SessionModeId>>>,
    default_mode: Option<acp::SessionModeId>,
    /// Atlas's on-device retrieval, if the host injected it.
    ///
    /// `None` means the index is not ready; the tool is then not advertised at
    /// all rather than advertised and failing, because a tool the model is
    /// told about and cannot use is worse than one it never sees.
    memory_search: Option<MemorySearch>,
}

struct PumpHandle(tokio::task::JoinHandle<()>);

impl Drop for PumpHandle {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl EngineConnection {
    pub async fn connect(
        id: AgentId,
        settings: EngineSettings,
        thread_events: ThreadEventSink,
        external_auth: Option<Arc<dyn ExternalAuth>>,
    ) -> Result<Arc<Self>> {
        Self::connect_with_mode(id, settings, thread_events, external_auth, None).await
    }

    pub async fn connect_with_mode(
        id: AgentId,
        settings: EngineSettings,
        thread_events: ThreadEventSink,
        external_auth: Option<Arc<dyn ExternalAuth>>,
        default_mode: Option<acp::SessionModeId>,
    ) -> Result<Arc<Self>> {
        Self::connect_full(id, settings, thread_events, external_auth, default_mode, None).await
    }

    pub async fn connect_full(
        id: AgentId,
        settings: EngineSettings,
        thread_events: ThreadEventSink,
        external_auth: Option<Arc<dyn ExternalAuth>>,
        default_mode: Option<acp::SessionModeId>,
        memory_search: Option<MemorySearch>,
    ) -> Result<Arc<Self>> {
        let (runtime, client) = start_engine(&settings, external_auth).await?;
        let max_retries = settings.stream_max_retries;
        let requests = client.request_handle();
        let sessions = Arc::new(EngineSessions::default());
        let turns = Arc::new(TurnWaiters::default());

        // On the engine's runtime, not the host's: the pump owns the client,
        // and the client's `next_event` is fed by engine tasks.
        let pump = runtime.handle().spawn(pump_events(
            client,
            sessions.clone(),
            turns.clone(),
            max_retries,
            memory_search.clone(),
        ));

        Ok(Arc::new(Self {
            id,
            requests,
            sessions,
            turns,
            thread_events,
            request_ids: Arc::new(RequestIds::default()),
            settings,
            _pump: Arc::new(PumpHandle(pump)),
            runtime: Arc::new(runtime),
            session_modes: Arc::new(Mutex::new(HashMap::new())),
            default_mode,
            memory_search,
        }))
    }

    async fn call<T: serde::de::DeserializeOwned>(
        &self,
        build: impl FnOnce(RequestId) -> ClientRequest,
    ) -> Result<T> {
        let request = build(self.request_ids.next());
        self.requests
            .request_typed::<T>(request)
            .await
            .map_err(|e| anyhow!("{e}"))
    }

    /// Pushes a mode onto a thread and records it.
    ///
    /// `thread/settings/update` is the engine's only per-thread lever for this,
    /// and it takes the approval policy and the sandbox policy separately —
    /// both are needed, because sandbox alone cannot express "ask first" and
    /// approval alone cannot stop a command that never asks.
    async fn apply_mode(&self, session_id: &acp::SessionId, mode: &acp::SessionModeId) -> Result<()> {
        let (approval_policy, sandbox_policy) = modes::engine_policy(&mode.0);
        let _: v2::ThreadSettingsUpdateResponse = self
            .call(|request_id| ClientRequest::ThreadSettingsUpdate {
                request_id,
                params: v2::ThreadSettingsUpdateParams {
                    thread_id: session_id.to_string(),
                    approval_policy: Some(approval_policy),
                    sandbox_policy: Some(sandbox_policy),
                    ..Default::default()
                },
            })
            .await?;
        self.session_modes
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(session_id.clone(), mode.clone());
        Ok(())
    }

    /// Branch a stored conversation into a new thread — `thread/fork`.
    ///
    /// Returns the new thread's id. Only the fork happens here: the host opens
    /// the branch through the normal reopen path, which replays the forked
    /// history the same way any reopened session's is replayed.
    pub async fn fork_thread(&self, session_id: &acp::SessionId) -> Result<String> {
        let model = self
            .sessions
            .selected_model(session_id)
            .unwrap_or_else(|| self.settings.model.clone());
        let response: v2::ThreadForkResponse = self
            .call(|request_id| ClientRequest::ThreadFork {
                request_id,
                params: v2::ThreadForkParams {
                    thread_id: session_id.to_string(),
                    last_turn_id: None,
                    before_turn_id: None,
                    path: None,
                    model: Some(model),
                    model_provider: Some(self.settings.provider.id.clone()),
                    service_tier: None,
                    cwd: self.sessions.cwd(session_id),
                    runtime_workspace_roots: None,
                    approval_policy: None,
                    approvals_reviewer: None,
                    sandbox: None,
                    permissions: None,
                    config: None,
                    base_instructions: None,
                    developer_instructions: None,
                    ephemeral: false,
                    thread_source: None,
                    exclude_turns: true,
                    defer_goal_continuation: false,
                },
            })
            .await?;
        Ok(response.thread.id)
    }

    /// Discover the cwd's skills and re-publish the command list with them.
    ///
    /// User- and repo-scope only: the engine's bundled system skills lean on
    /// upstream services the gateway does not serve, and a row that errors on
    /// click is worse than no row. Best-effort by design — a session without
    /// skills is a session with the static commands, not a failed session.
    async fn discover_skills(&self, session_id: &acp::SessionId, cwd: &std::path::Path) {
        let listed: Result<v2::SkillsListResponse> = self
            .call(|request_id| ClientRequest::SkillsList {
                request_id,
                params: v2::SkillsListParams {
                    cwds: vec![cwd.to_path_buf()],
                    force_reload: false,
                },
            })
            .await;
        let Ok(listed) = listed else {
            return;
        };
        let skills: Vec<crate::engine::commands::SkillRef> = listed
            .data
            .into_iter()
            .flat_map(|entry| entry.skills)
            .filter(|skill| {
                skill.enabled
                    && matches!(skill.scope, v2::SkillScope::User | v2::SkillScope::Repo)
            })
            .map(|skill| crate::engine::commands::SkillRef {
                name: skill.name,
                description: skill.description,
                path: skill.path.as_path().to_path_buf(),
            })
            .collect();
        if skills.is_empty() {
            return;
        }
        self.sessions.set_skills(session_id, skills.clone());
        if let Some(thread) = self.sessions.thread(session_id) {
            let _ = thread
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .handle_session_update(acp::SessionUpdate::AvailableCommandsUpdate(
                    acp::AvailableCommandsUpdate::new(crate::engine::commands::available(&skills)),
                ));
        }
    }

    /// Reasoning effort for one session — native-only, like the Cersei path.
    pub fn session_effort(
        &self,
        session_id: &acp::SessionId,
    ) -> Option<Arc<dyn AgentSessionEffort>> {
        self.sessions.thread(session_id)?;
        Some(Arc::new(EngineSessionControls {
            requests: self.requests.clone(),
            session_id: session_id.clone(),
            request_ids: self.request_ids.clone(),
            runtime: self.runtime.handle(),
        }))
    }

    fn new_thread(
        self: &Arc<Self>,
        session_id: acp::SessionId,
        work_dirs: Vec<PathBuf>,
        title: Option<Arc<str>>,
    ) -> AcpThreadHandle {
        let events = (self.thread_events)(&session_id);
        let mut thread = AcpThread::new(
            session_id,
            self.clone() as Arc<dyn AgentConnection>,
            work_dirs,
            title,
            events,
        );
        // Text only for the tracer bullet. The engine accepts images and more,
        // but advertising a capability before its path is wired is how an
        // attachment gets silently dropped instead of degraded to a mention.
        thread.set_prompt_capabilities(acp::PromptCapabilities::default());
        // Publish the slash commands on EVERY thread this connection makes.
        // This used to happen in `new_session` only, which left a resumed
        // session — the restored tab a user actually types "/" into — with an
        // empty picker while a fresh chat's was full.
        let _ = thread.handle_session_update(acp::SessionUpdate::AvailableCommandsUpdate(
            // The static set. Skills are discovered right after the session
            // registers (`discover_skills`) and re-publish the full list.
            acp::AvailableCommandsUpdate::new(crate::engine::commands::available(&[])),
        ));
        Arc::new(Mutex::new(thread))
    }
}

/// An answer to an engine server request, on its way back to the pump.
///
/// Dialog answers cannot be sent straight to the client: the pump owns it, and
/// `next_event` borrows it mutably for as long as it is waiting. So a dialog
/// task sends its answer here and the pump, which is the only thing that can
/// touch the client, delivers it.
struct ServerAnswer {
    request_id: RequestId,
    result: std::result::Result<serde_json::Value, String>,
}

async fn pump_events(
    mut client: InProcessAppServerClient,
    sessions: Arc<EngineSessions>,
    turns: Arc<TurnWaiters>,
    max_retries: usize,
    memory_search: Option<MemorySearch>,
) {
    let (answers_tx, mut answers_rx) = tokio::sync::mpsc::unbounded_channel::<ServerAnswer>();

    loop {
        tokio::select! {
            // Biased so answers are delivered promptly: a turn is blocked on
            // every one of them.
            biased;

            Some(answer) = answers_rx.recv() => {
                match answer.result {
                    Ok(value) => {
                        let _ = client.resolve_server_request(answer.request_id, value).await;
                    }
                    Err(message) => {
                        let _ = client
                            .reject_server_request(
                                answer.request_id,
                                codex_app_server_protocol::JSONRPCErrorError {
                                    code: -32603,
                                    message,
                                    data: None,
                                },
                            )
                            .await;
                    }
                }
            }

            event = client.next_event() => {
                let Some(event) = event else { return };
                // Opportunistic burst drain. The model streams token-sized
                // deltas, and each one that reaches the thread fans out into
                // the whole downstream chain — thread lock, projector diff,
                // a Tauri emit, a webview re-render. At token frequency that
                // chain IS the UI jank. Draining whatever is already queued
                // and merging consecutive message deltas for the same item
                // collapses a burst into one application; when the stream is
                // slower than the pump, `now_or_never` finds nothing and
                // every delta still applies immediately — no timer, no added
                // latency, backpressure-proportional batching.
                let mut batch = vec![event];
                while batch.len() < 256 {
                    match futures::FutureExt::now_or_never(client.next_event()) {
                        Some(Some(event)) => batch.push(event),
                        _ => break,
                    }
                }
                for event in coalesce_message_deltas(batch) {
                    match event {
                        InProcessServerEvent::ServerNotification(notification) => {
                            apply_notification(&sessions, &turns, max_retries, *notification);
                        }
                        InProcessServerEvent::ServerRequest(request) => {
                            handle_server_request(&sessions, *request, &answers_tx, &memory_search);
                        }
                        InProcessServerEvent::Lagged { skipped } => {
                            // Transport health, not an application event. Worth
                            // saying out loud: dropped notifications show up to a
                            // user as a turn that rendered incompletely.
                            tracing::warn!(
                                target: "atlas_native_agent::engine",
                                "the engine event stream lagged; {skipped} notifications dropped",
                            );
                        }
                    }
                }
            }
        }
    }
}

/// Merge ADJACENT message deltas for the same item into one.
///
/// Adjacent only, deliberately: reordering across other notifications could
/// move a delta past the `ItemCompleted` that closes its item, or past a
/// server request that must be answered in sequence. Within an unbroken run of
/// deltas for one item, concatenation is exactly what the thread would have
/// done one call at a time — minus the per-call fan-out.
fn coalesce_message_deltas(events: Vec<InProcessServerEvent>) -> Vec<InProcessServerEvent> {
    use codex_app_server_protocol::ServerNotification;
    let mut out: Vec<InProcessServerEvent> = Vec::with_capacity(events.len());
    for event in events {
        if let (
            Some(InProcessServerEvent::ServerNotification(last)),
            InProcessServerEvent::ServerNotification(next),
        ) = (out.last_mut(), &event)
        {
            if let (
                ServerNotification::AgentMessageDelta(accumulated),
                ServerNotification::AgentMessageDelta(delta),
            ) = (last.as_mut(), next.as_ref())
            {
                if accumulated.thread_id == delta.thread_id
                    && accumulated.item_id == delta.item_id
                {
                    accumulated.delta.push_str(&delta.delta);
                    continue;
                }
            }
        }
        out.push(event);
    }
    out
}

/// Routes an engine server request to the user, or refuses it.
///
/// Never blocks the pump. The dialog stays open for as long as the user takes,
/// and the pump has to keep draining events the whole time — the turn's own
/// progress arrives on the same stream.
fn handle_server_request(
    sessions: &Arc<EngineSessions>,
    request: ServerRequest,
    answers: &tokio::sync::mpsc::UnboundedSender<ServerAnswer>,
    memory_search: &Option<MemorySearch>,
) {
    use codex_app_server_protocol::ServerRequest as Req;

    // A tool Atlas implements itself, rather than a question for the user.
    if let Req::DynamicToolCall { request_id, params } = &request {
        let cwd = sessions
            .cwd(&acp::SessionId::new(params.thread_id.as_str()))
            .unwrap_or_default();
        serve_dynamic_tool(
            request_id.clone(),
            params.clone(),
            cwd,
            memory_search.clone(),
            answers.clone(),
        );
        return;
    }

    let (request_id, thread_id, prompt) = match &request {
        Req::CommandExecutionRequestApproval { request_id, params } => (
            request_id.clone(),
            params.thread_id.clone(),
            approvals::tool_call(
                &params.item_id,
                acp::ToolKind::Execute,
                params.command.clone(),
                params.reason.clone(),
            ),
        ),
        Req::FileChangeRequestApproval { request_id, params } => (
            request_id.clone(),
            params.thread_id.clone(),
            approvals::tool_call(
                &params.item_id,
                acp::ToolKind::Edit,
                None,
                params.reason.clone(),
            ),
        ),
        Req::PermissionsRequestApproval { request_id, params } => (
            request_id.clone(),
            params.thread_id.clone(),
            approvals::tool_call(
                &params.item_id,
                acp::ToolKind::Execute,
                None,
                params.reason.clone(),
            ),
        ),
        other => {
            // Elicitations, dynamic tool calls, attestation. Refused rather
            // than ignored: an unanswered request is a turn that hangs with no
            // way for the user to see why.
            tracing::warn!(
                target: "atlas_native_agent::engine",
                "refusing an engine server request Atlas does not serve yet: {other:?}",
            );
            let _ = answers.send(ServerAnswer {
                request_id: other.id().clone(),
                result: Err("Atlas does not serve this engine request yet".to_string()),
            });
            return;
        }
    };

    let Some(thread) = sessions.thread(&acp::SessionId::new(thread_id.as_str())) else {
        let _ = answers.send(ServerAnswer {
            request_id,
            result: Err("no open thread for this approval".to_string()),
        });
        return;
    };

    // Take the waiter out under the lock, then await it on its own task.
    let waiter = {
        let mut thread = thread.lock().unwrap_or_else(|p| p.into_inner());
        thread.request_tool_call_authorization(
            prompt,
            approvals::options(),
            AuthorizationKind::PermissionGrant,
        )
    };
    let waiter = match waiter {
        Ok(waiter) => waiter,
        Err(e) => {
            let _ = answers.send(ServerAnswer {
                request_id,
                result: Err(format!("the approval could not be raised: {e}")),
            });
            return;
        }
    };

    let answers = answers.clone();
    tokio::spawn(async move {
        let decision = approvals::decision_for(&waiter.await);
        // Shaped per request kind: the engine's two approval surfaces take
        // different response types even though the user answered one question.
        let result = match &request {
            Req::CommandExecutionRequestApproval { .. } => serde_json::to_value(
                v2::CommandExecutionRequestApprovalResponse {
                    decision: decision.for_command(),
                },
            ),
            Req::FileChangeRequestApproval { .. } => {
                serde_json::to_value(v2::FileChangeRequestApprovalResponse {
                    decision: decision.for_file_change(),
                })
            }
            // The permissions surface grants capabilities rather than
            // answering yes/no, and Atlas has no UI for choosing *which*
            // capabilities. Approving grants nothing extra, which lets the
            // engine proceed under the sandbox it already has rather than
            // silently widening it on a click the user did not understand.
            _ => serde_json::to_value(v2::PermissionsRequestApprovalResponse {
                permissions: v2::GrantedPermissionProfile {
                    network: None,
                    file_system: None,
                },
                scope: match decision {
                    approvals::Decision::AcceptForSession => v2::PermissionGrantScope::Session,
                    _ => v2::PermissionGrantScope::Turn,
                },
                strict_auto_review: None,
            }),
        };
        let _ = answers.send(ServerAnswer {
            request_id,
            result: result.map_err(|e| format!("could not encode the approval: {e}")),
        });
    });
}

/// Answers a tool the engine asked Atlas to run.
///
/// Always answers. A dynamic tool call left unanswered is a turn that stops
/// with no error and no explanation, which is the worst shape a tool failure
/// can take — so an unknown tool and a failed search both come back as a
/// result the model can read and move on from.
fn serve_dynamic_tool(
    request_id: RequestId,
    params: v2::DynamicToolCallParams,
    cwd: String,
    memory_search: Option<MemorySearch>,
    answers: tokio::sync::mpsc::UnboundedSender<ServerAnswer>,
) {
    tokio::spawn(async move {
        let (text, success) = if params.tool != memory::TOOL_NAME {
            (
                format!("Atlas does not implement the tool {:?}.", params.tool),
                false,
            )
        } else {
            match (memory_search, memory::parse_arguments(&params.arguments)) {
                (None, _) => (
                    "Memory search is unavailable (the index is not ready).".to_string(),
                    false,
                ),
                (_, None) => ("`query` is required.".to_string(), false),
                (Some(search), Some((query, limit))) => {
                    let docs = search(cwd, query, limit).await;
                    (memory::render(&docs), true)
                }
            }
        };

        let result = serde_json::to_value(v2::DynamicToolCallResponse {
            content_items: memory::output(text, success),
            success,
        });
        let _ = answers.send(ServerAnswer {
            request_id,
            result: result.map_err(|e| format!("could not encode the tool result: {e}")),
        });
    });
}

/// Maps the engine's turn outcome onto the protocol's stop reason.
///
/// `Failed` is deliberately not a stop reason: the protocol has no failure
/// variant, and reporting a failed turn as `EndTurn` would render an error as a
/// normal finish. It becomes an `Err` so the caller surfaces it.
pub(crate) fn stop_reason(turn: &v2::Turn) -> Result<acp::StopReason> {
    match turn.status {
        v2::TurnStatus::Completed => Ok(acp::StopReason::EndTurn),
        v2::TurnStatus::Interrupted => Ok(acp::StopReason::Cancelled),
        v2::TurnStatus::Failed => Err(anyhow!(
            "{}",
            turn.error
                .as_ref()
                .map(|e| e.message.clone())
                .unwrap_or_else(|| "the turn failed without a message".to_string())
        )),
        // The engine sends this while a turn runs, never as its outcome.
        v2::TurnStatus::InProgress => Err(anyhow!(
            "the engine reported a turn as still in progress after completing it",
        )),
    }
}

impl AgentConnection for EngineConnection {
    fn agent_id(&self) -> AgentId {
        self.id.clone()
    }

    fn telemetry_id(&self) -> Arc<str> {
        self.id.0.clone()
    }

    fn agent_version(&self) -> Option<Arc<str>> {
        Some(env!("CARGO_PKG_VERSION").into())
    }

    fn new_session(
        self: Arc<Self>,
        work_dirs: Vec<PathBuf>,
    ) -> BoxFuture<'static, Result<AcpThreadHandle>> {
        async move {
            let cwd = work_dirs
                .first()
                .cloned()
                .unwrap_or_else(|| self.settings.cwd.clone());

            let response: v2::ThreadStartResponse = self
                .call(|request_id| ClientRequest::ThreadStart {
                    request_id,
                    params: v2::ThreadStartParams {
                        model: Some(self.settings.model.clone()),
                        model_provider: Some(self.settings.provider.id.clone()),
                        cwd: Some(cwd.to_string_lossy().into_owned()),
                        // Declared only when retrieval exists. Advertising a
                        // tool the host cannot serve teaches the model to call
                        // something that always fails.
                        dynamic_tools: self
                            .memory_search
                            .as_ref()
                            .map(|_| vec![memory::tool_spec()]),
                        ..Default::default()
                    },
                })
                .await?;

            // The engine's thread id *is* the ACP session id. Keeping them the
            // same identifier rather than maintaining a mapping is what lets a
            // stored row resolve without a translation table.
            let session_id = acp::SessionId::new(response.thread.id.as_str());
            let thread = self.new_thread(session_id.clone(), work_dirs, None);
            self.sessions.insert(
                session_id.clone(),
                &thread,
                cwd.to_string_lossy().into_owned(),
            );

            let mode = self
                .default_mode
                .clone()
                .unwrap_or_else(|| acp::SessionModeId::new(modes::DEFAULT_MODE_ID));
            // Applied rather than merely recorded: a thread started without
            // this runs on the engine's own defaults, so the picker would show
            // a mode the engine is not in.
            self.apply_mode(&session_id, &mode).await?;
            self.discover_skills(&session_id, &cwd).await;
            Ok(thread)
        }
        .boxed()
    }

    /// Load IS advertised now, because reopening genuinely replays.
    ///
    /// This was `false` through the cutover, which is what produced D6's
    /// "resumed without history" notice — correct then, because the seam threw
    /// the engine's stored turns away and every reopened session really did
    /// continue from nothing. The turns are replayed now (`engine::replay`),
    /// so reporting `WithoutHistory` over a fully repainted transcript would
    /// be the notice lying in the other direction.
    ///
    /// The one row that still opens empty is a pre-cutover id the engine has
    /// never seen: the fresh-thread fallback inside [`Self::resume_session`].
    /// D6 accepted that loss, and it now applies only where it is true.
    fn supports_load_session(&self) -> bool {
        true
    }

    /// Same path as [`Self::resume_session`]: the engine's `thread/resume`
    /// both continues the thread and returns its stored history, so load and
    /// resume are one operation here — the split only matters for agents where
    /// replaying is a separate, heavier call.
    fn load_session(
        self: Arc<Self>,
        session_id: acp::SessionId,
        work_dirs: Vec<PathBuf>,
        title: Option<Arc<str>>,
    ) -> BoxFuture<'static, Result<AcpThreadHandle>> {
        self.resume_session(session_id, work_dirs, title)
    }

    fn supports_resume_session(&self) -> bool {
        true
    }

    fn supports_session_history(&self) -> bool {
        true
    }

    /// Reopen a stored row without replaying it (D6).
    ///
    /// Two cases reach here and both end the same way for the user. A thread
    /// the engine knows resumes; a pre-cutover row it has never heard of does
    /// not, and gets a fresh thread instead. Neither replays into the
    /// transcript, because no converter from the old format exists and D6
    /// accepts that loss rather than owning one forever.
    ///
    /// The failure is not treated as an error: a stored row that will not open
    /// is worse than one that opens empty, and "the row is from before the
    /// engine changed" is not something the user did wrong.
    fn resume_session(
        self: Arc<Self>,
        session_id: acp::SessionId,
        work_dirs: Vec<PathBuf>,
        title: Option<Arc<str>>,
    ) -> BoxFuture<'static, Result<AcpThreadHandle>> {
        async move {
            let cwd = work_dirs
                .first()
                .cloned()
                .unwrap_or_else(|| self.settings.cwd.clone());

            let resumed: Result<v2::ThreadResumeResponse> = self
                .call(|request_id| ClientRequest::ThreadResume {
                    request_id,
                    params: v2::ThreadResumeParams {
                        thread_id: session_id.to_string(),
                        cwd: Some(cwd.to_string_lossy().into_owned()),
                        model: Some(self.settings.model.clone()),
                        model_provider: Some(self.settings.provider.id.clone()),
                        ..Default::default()
                    },
                })
                .await;

            let (engine_thread_id, stored_turns) = match resumed {
                Ok(response) => (response.thread.id, response.thread.turns),
                Err(resume_err) => {
                    // A resume refusal does NOT mean the thread is unknown.
                    // The commonest refusal is the opposite: the thread is
                    // still loaded in this engine — close a tab and reopen it
                    // and the rollout writer is still held — and `thread/
                    // resume` answers "already has an active writer". The old
                    // arm treated every refusal as "never heard of it" and
                    // silently opened a FRESH thread, which is exactly the
                    // "my conversation restarted" bug. `thread/read` needs no
                    // writer, so it is both the existence test and the
                    // history: if it answers, the thread is real, keeps its
                    // id, and its turns replay below.
                    let read: Result<v2::ThreadReadResponse> = self
                        .call(|request_id| ClientRequest::ThreadRead {
                            request_id,
                            params: v2::ThreadReadParams {
                                thread_id: session_id.to_string(),
                                include_turns: true,
                            },
                        })
                        .await;
                    match read {
                        Ok(response) => (response.thread.id, response.thread.turns),
                        Err(read_err) => {
                            // `warn!`, not `info!`: this arm is reached by an
                            // unknown thread id (a pre-cutover row — expected)
                            // but also by a transport failure or a bad reply,
                            // and those mean the model continues with no
                            // context while the chat repaints from Atlas's own
                            // transcript and looks fine. The two errors are
                            // printed so the reader can tell which it was.
                            tracing::warn!(
                                target: "atlas_native_agent::engine",
                                "opening thread {session_id} fresh: the engine could not \
                                 resume it or read it back — either it does not know the \
                                 id (a row from before the engine changed) or the calls \
                                 themselves failed. resume: {resume_err}; read: {read_err}",
                            );
                            let started: v2::ThreadStartResponse = self
                                .call(|request_id| ClientRequest::ThreadStart {
                                    request_id,
                                    params: v2::ThreadStartParams {
                                        model: Some(self.settings.model.clone()),
                                        model_provider: Some(self.settings.provider.id.clone()),
                                        cwd: Some(cwd.to_string_lossy().into_owned()),
                                        dynamic_tools: self
                                            .memory_search
                                            .as_ref()
                                            .map(|_| vec![memory::tool_spec()]),
                                        ..Default::default()
                                    },
                                })
                                .await?;
                            (started.thread.id, Vec::new())
                        }
                    }
                }
            };

            // Keyed by the id the engine will stamp on its events, which is
            // the only id the sink can match. For a pre-cutover row that is a
            // new id — the caller reads it off the returned thread and rebinds
            // the store row (`resume_thread` compares it to the stored id and
            // adopts, #56); nothing here writes to history.
            let engine_session_id = acp::SessionId::new(engine_thread_id.as_str());
            let thread = self.new_thread(engine_session_id.clone(), work_dirs, title);
            {
                // The response carried the thread's whole stored history — the
                // primary source for what a reopened session shows. Replayed
                // before the handle leaves, so the first snapshot already has
                // it (see `engine::replay`). A pre-cutover row took the
                // fresh-thread arm above and has no turns; it opens empty,
                // which D6 accepted, and now only that row does.
                let mut locked = thread.lock().unwrap_or_else(|p| p.into_inner());
                crate::engine::replay::replay_turns(&mut locked, &stored_turns);
            }
            self.sessions.insert(
                engine_session_id.clone(),
                &thread,
                cwd.to_string_lossy().into_owned(),
            );
            let mode = self
                .default_mode
                .clone()
                .unwrap_or_else(|| acp::SessionModeId::new(modes::DEFAULT_MODE_ID));
            self.apply_mode(&engine_session_id, &mode).await?;
            self.discover_skills(&engine_session_id, &cwd).await;
            Ok(thread)
        }
        .boxed()
    }

    /// The native agent authenticates with the user's Atlas account, through
    /// the D10 token provider — not with an ACP auth method. Advertising none
    /// is what keeps the sign-in flow from offering one, and D10 requires the
    /// engine's own login surface stay off too.
    fn auth_methods(&self) -> &[acp::AuthMethod] {
        &[]
    }

    fn authenticate(&self, _method: acp::AuthMethodId) -> BoxFuture<'static, Result<()>> {
        async {
            Err(anyhow!(
                "Atlas Agent signs in with your Atlas account, not with an agent auth method",
            ))
        }
        .boxed()
    }

    fn prompt(&self, params: acp::PromptRequest) -> BoxFuture<'static, Result<acp::PromptResponse>> {
        let mut text = crate::engine::sink::flatten_prompt(&params.prompt);
        let thread_id = params.session_id.to_string();
        let requests = self.requests.clone();
        let turns = self.turns.clone();
        let request_id = self.request_ids.next();
        // The session's picked model, or the configured default. Reading the
        // per-session state is what makes the picker real: this request-level
        // `model` overrides the engine-side thread setting every turn, so
        // sending the default here silently undid every selection.
        let model = self
            .sessions
            .selected_model(&params.session_id)
            .unwrap_or_else(|| self.settings.model.clone());

        // A slash command is not something to say to the model — sent as a
        // turn it would arrive as the literal text "/compact", which the
        // engine has no reason to interpret. Each resolves to what it really
        // is: a protocol call, a canned turn, a local reply, or a skill turn.
        let skills = self.sessions.skills(&params.session_id);
        let mut turn_input: Option<Vec<v2::UserInput>> = None;
        match crate::engine::commands::parse(&text, &skills) {
            Some(crate::engine::commands::Command::Compact) => {
                let thread_id = thread_id.clone();
                return async move {
                    let _: v2::ThreadCompactStartResponse = requests
                        .request_typed(ClientRequest::ThreadCompactStart {
                            request_id,
                            params: v2::ThreadCompactStartParams { thread_id },
                        })
                        .await?;
                    // Compaction is not a turn: nothing streams, and there is
                    // no turn id to wait on. Ending it here rather than
                    // parking is what stops the composer spinning on a turn
                    // that was never started.
                    Ok(acp::PromptResponse::new(acp::StopReason::EndTurn))
                }
                .boxed();
            }
            // `/init` IS a turn — agent work with the usual approval flow
            // around the file write — whose text the user did not have to
            // write. Substitute the canned prompt and fall through.
            Some(crate::engine::commands::Command::Init) => {
                text = crate::engine::commands::INIT_PROMPT.to_string();
            }
            // `/diff` and `/status` are answered from this side, exactly as the
            // upstream TUI answered them — they were always frontend features.
            // The reply is pushed into the thread as an assistant message and
            // the turn ends; no model is consulted and nothing is billed.
            Some(crate::engine::commands::Command::Diff) => {
                let sessions = self.sessions.clone();
                let session_id = params.session_id.clone();
                return async move {
                    let cwd = sessions
                        .cwd(&session_id)
                        .unwrap_or_else(|| ".".to_string());
                    // git can chew on a large tree; keep it off the async
                    // runtime's threads.
                    let reply = tokio::task::spawn_blocking(move || {
                        crate::engine::commands::diff_reply(&cwd)
                    })
                    .await
                    .unwrap_or_else(|e| format!("Could not run git: {e}"));
                    if let Some(thread) = sessions.thread(&session_id) {
                        thread
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .push_assistant_content_block(
                                acp::ContentBlock::Text(acp::TextContent::new(reply)),
                                false,
                            );
                    }
                    Ok(acp::PromptResponse::new(acp::StopReason::EndTurn))
                }
                .boxed();
            }
            Some(crate::engine::commands::Command::Status) => {
                let sessions = self.sessions.clone();
                let session_id = params.session_id.clone();
                return async move {
                    let cwd = sessions
                        .cwd(&session_id)
                        .unwrap_or_else(|| "unknown".to_string());
                    let reply = crate::engine::commands::status_reply(&model, &cwd);
                    if let Some(thread) = sessions.thread(&session_id) {
                        thread
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .push_assistant_content_block(
                                acp::ContentBlock::Text(acp::TextContent::new(reply)),
                                false,
                            );
                    }
                    Ok(acp::PromptResponse::new(acp::StopReason::EndTurn))
                }
                .boxed();
            }
            // `/undo` — `thread/rollback` drops the last exchange from the
            // engine's durable history, and the thread's entries are trimmed
            // to match so the transcript shows what the model now remembers.
            Some(crate::engine::commands::Command::Undo) => {
                let sessions = self.sessions.clone();
                let session_id = params.session_id.clone();
                let thread_id = thread_id.clone();
                return async move {
                    let rolled = requests
                        .request_typed::<v2::ThreadRollbackResponse>(ClientRequest::ThreadRollback {
                            request_id,
                            params: v2::ThreadRollbackParams {
                                thread_id,
                                num_turns: 1,
                            },
                        })
                        .await;
                    let reply = match rolled {
                        Ok(_) => {
                            if let Some(thread) = sessions.thread(&session_id) {
                                let mut locked =
                                    thread.lock().unwrap_or_else(|p| p.into_inner());
                                // The LAST user entry is "/undo" itself — the
                                // host pushed it before prompt() ran. The
                                // exchange being undone starts at the user
                                // entry BEFORE it; both go.
                                let user_indices: Vec<usize> = locked
                                    .entries()
                                    .iter()
                                    .enumerate()
                                    .filter(|(_, entry)| {
                                        matches!(
                                            entry,
                                            atlas_acp_thread::AgentThreadEntry::UserMessage(_)
                                        )
                                    })
                                    .map(|(ix, _)| ix)
                                    .collect();
                                if let Some(from) =
                                    user_indices.iter().rev().nth(1).copied()
                                {
                                    locked.remove_entries_from(from);
                                } else if let Some(only) = user_indices.last().copied() {
                                    locked.remove_entries_from(only);
                                }
                            }
                            "Rewound the last exchange — the conversation continues from \
                             before it."
                                .to_string()
                        }
                        // The engine refuses when there is nothing to drop;
                        // that is an answer, not a failure.
                        Err(_) => "Nothing to rewind yet.".to_string(),
                    };
                    if let Some(thread) = sessions.thread(&session_id) {
                        thread
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .push_assistant_content_block(
                                acp::ContentBlock::Text(acp::TextContent::new(reply)),
                                false,
                            );
                    }
                    Ok(acp::PromptResponse::new(acp::StopReason::EndTurn))
                }
                .boxed();
            }
            // `/goal` — set with input, show without.
            Some(crate::engine::commands::Command::Goal(objective)) => {
                let sessions = self.sessions.clone();
                let session_id = params.session_id.clone();
                let thread_id = thread_id.clone();
                return async move {
                    let reply = match objective {
                        Some(objective_text) => {
                            let set = requests
                                .request_typed::<v2::ThreadGoalSetResponse>(ClientRequest::ThreadGoalSet {
                                    request_id,
                                    params: v2::ThreadGoalSetParams {
                                        thread_id,
                                        objective: Some(objective_text.clone()),
                                        ..Default::default()
                                    },
                                })
                                .await;
                            match set {
                                Ok(_) => format!("**Goal set:** {objective_text}"),
                                Err(e) => format!("Could not set the goal: {e}"),
                            }
                        }
                        None => {
                            let got = requests
                                .request_typed::<v2::ThreadGoalGetResponse>(ClientRequest::ThreadGoalGet {
                                    request_id,
                                    params: v2::ThreadGoalGetParams { thread_id },
                                })
                                .await;
                            match got {
                                Ok(response) => response
                                    .goal
                                    .map(|goal| format!("**Goal:** {}", goal.objective))
                                    .unwrap_or_else(|| {
                                        "No goal set. `/goal <objective>` sets one."
                                            .to_string()
                                    }),
                                Err(e) => format!("Could not read the goal: {e}"),
                            }
                        }
                    };
                    if let Some(thread) = sessions.thread(&session_id) {
                        thread
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .push_assistant_content_block(
                                acp::ContentBlock::Text(acp::TextContent::new(reply)),
                                false,
                            );
                    }
                    Ok(acp::PromptResponse::new(acp::StopReason::EndTurn))
                }
                .boxed();
            }
            // `/review` — `review/start`, INLINE on this thread, which is what
            // makes it renderable with zero new UI: the review runs as a turn
            // here, its findings stream through the same pipeline as any
            // answer. On this thread's model too — our engine config leaves
            // `review_model` unset on purpose, and the engine then uses the
            // parent thread's model, which the gateway serves.
            Some(crate::engine::commands::Command::Review(instructions)) => {
                let thread_id = thread_id.clone();
                return async move {
                    let target = match instructions {
                        Some(instructions) => v2::ReviewTarget::Custom { instructions },
                        None => v2::ReviewTarget::UncommittedChanges,
                    };
                    let started: v2::ReviewStartResponse = requests
                        .request_typed(ClientRequest::ReviewStart {
                            request_id,
                            params: v2::ReviewStartParams {
                                thread_id: thread_id.clone(),
                                target,
                                delivery: Some(v2::ReviewDelivery::Inline),
                            },
                        })
                        .await
                        .map_err(|e| anyhow!("the review could not start: {e}"))?;
                    if started.turn.status != v2::TurnStatus::InProgress {
                        return Ok(acp::PromptResponse::new(stop_reason(&started.turn)?));
                    }
                    let waiter = turns.register(&thread_id, &started.turn.id);
                    match waiter.await {
                        Ok(turn) => Ok(acp::PromptResponse::new(stop_reason(&turn)?)),
                        Err(_) => {
                            turns.forget(&thread_id, &started.turn.id);
                            Err(anyhow!("the engine stopped before the review completed"))
                        }
                    }
                }
                .boxed();
            }
            // A discovered skill runs as a turn whose input NAMES the skill —
            // the engine loads it itself; any extra words ride along as text.
            Some(crate::engine::commands::Command::Skill { name, path, args }) => {
                let mut items = vec![v2::UserInput::Skill { name, path }];
                if let Some(args) = args {
                    items.push(v2::UserInput::Text {
                        text: args,
                        text_elements: Vec::new(),
                    });
                }
                turn_input = Some(items);
            }
            None => {}
        }

        async move {
            let started: v2::TurnStartResponse = requests
                .request_typed(ClientRequest::TurnStart {
                    request_id,
                    params: v2::TurnStartParams {
                        thread_id: thread_id.clone(),
                        input: turn_input.unwrap_or_else(|| {
                            vec![v2::UserInput::Text {
                                text,
                                text_elements: Vec::new(),
                            }]
                        }),
                        model: Some(model),
                        ..Default::default()
                    },
                })
                .await
                .map_err(|e| anyhow!("{e}"))?;

            // If the turn already finished, its outcome is in the response and
            // no notification is coming — registering a waiter for it would
            // hang forever.
            if started.turn.status != v2::TurnStatus::InProgress {
                return Ok(acp::PromptResponse::new(stop_reason(&started.turn)?));
            }

            let waiter = turns.register(&thread_id, &started.turn.id);
            let turn = match waiter.await {
                Ok(turn) => turn,
                Err(_) => {
                    turns.forget(&thread_id, &started.turn.id);
                    return Err(anyhow!("the engine stopped before the turn completed"));
                }
            };
            Ok(acp::PromptResponse::new(stop_reason(&turn)?))
        }
        .boxed()
    }

    fn session_modes(&self, session_id: &acp::SessionId) -> Option<Arc<dyn AgentSessionModes>> {
        self.sessions.thread(session_id)?;
        Some(Arc::new(EngineSessionModes {
            connection: self.clone_handle(),
            session_id: session_id.clone(),
        }))
    }

    /// The models the gateway will actually serve (D3).
    ///
    /// Returning `None` here — which this did until now — is why the composer
    /// fell back to the **BYOK** picker: with no model list from the agent, the
    /// only list the app had was the user's own provider keys. That is a list
    /// of models this agent cannot use, priced at rates that do not apply, and
    /// picking one sends a slug the gateway answers with `403
    /// model_not_allowed`. The catalogue was authored and reaching the engine
    /// the whole time; nothing published it.
    fn model_selector(&self, session_id: &acp::SessionId) -> Option<Arc<dyn AgentModelSelector>> {
        self.sessions.thread(session_id)?;
        Some(Arc::new(EngineModelSelector {
            requests: self.requests.clone(),
            request_ids: self.request_ids.clone(),
            session_id: session_id.clone(),
            sessions: self.sessions.clone(),
        }))
    }

    fn into_any(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
        self
    }

    fn cancel(&self, session_id: &acp::SessionId) {
        let thread_id = session_id.to_string();
        let Some(turn_id) = self.turns.active_turn(&thread_id) else {
            // Nothing is running. Not an error — a cancel can race a turn that
            // just finished — but worth saying, because the other reading is
            // that the turn was never recorded and cancel is silently dead.
            tracing::debug!(
                target: "atlas_native_agent::engine",
                "cancel for {thread_id} with no turn in flight",
            );
            return;
        };
        let requests = self.requests.clone();
        let request_id = self.request_ids.next();
        // Fire and forget, like the Cersei path: the caller is awaiting the
        // turn's own completion, and the engine answers an interrupt by
        // finishing that turn as `Interrupted`.
        //
        // On the ENGINE's runtime, never a bare `tokio::spawn`: this sync
        // method runs on the caller's thread, and the stop button's caller is
        // the main thread, where there is no ambient runtime — a bare spawn
        // there panicked and took the whole app down with it.
        self.runtime.handle().spawn(async move {
            let result = requests
                .request_typed::<v2::TurnInterruptResponse>(ClientRequest::TurnInterrupt {
                    request_id,
                    params: v2::TurnInterruptParams { thread_id, turn_id },
                })
                .await;
            if let Err(e) = result {
                tracing::warn!(
                    target: "atlas_native_agent::engine",
                    "interrupting the engine turn failed: {e}",
                );
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message_delta(thread: &str, item: &str, delta: &str) -> InProcessServerEvent {
        InProcessServerEvent::ServerNotification(Box::new(
            codex_app_server_protocol::ServerNotification::AgentMessageDelta(
                v2::AgentMessageDeltaNotification {
                    thread_id: thread.to_string(),
                    turn_id: "turn-1".to_string(),
                    item_id: item.to_string(),
                    delta: delta.to_string(),
                },
            ),
        ))
    }

    fn delta_text(event: &InProcessServerEvent) -> Option<&str> {
        match event {
            InProcessServerEvent::ServerNotification(n) => match n.as_ref() {
                codex_app_server_protocol::ServerNotification::AgentMessageDelta(p) => {
                    Some(p.delta.as_str())
                }
                _ => None,
            },
            _ => None,
        }
    }

    #[test]
    fn a_burst_of_token_deltas_collapses_into_one_application() {
        // Each delta that reaches the thread fans out into a lock, a projector
        // diff, a Tauri emit and a webview render — at token frequency that
        // chain is the UI jank this closes.
        let merged = coalesce_message_deltas(vec![
            message_delta("t1", "i1", "the "),
            message_delta("t1", "i1", "whole "),
            message_delta("t1", "i1", "answer"),
        ]);
        assert_eq!(merged.len(), 1);
        assert_eq!(delta_text(&merged[0]), Some("the whole answer"));
    }

    #[test]
    fn deltas_for_different_items_or_threads_never_merge() {
        // Merging across items would put one item's words in another's mouth.
        let merged = coalesce_message_deltas(vec![
            message_delta("t1", "i1", "a"),
            message_delta("t1", "i2", "b"),
            message_delta("t2", "i2", "c"),
            // Adjacent same-item AFTER a break merges again from there.
            message_delta("t2", "i2", "d"),
        ]);
        let texts: Vec<_> = merged.iter().filter_map(delta_text).collect();
        assert_eq!(texts, ["a", "b", "cd"]);
    }

    /// The protocol's `Turn` has no `Default`, so fixtures spell it out.
    fn turn_with_id(id: &str, status: v2::TurnStatus) -> v2::Turn {
        v2::Turn {
            id: id.to_string(),
            items: Vec::new(),
            items_view: Default::default(),
            status,
            error: None,
            started_at: None,
            completed_at: None,
            duration_ms: None,
        }
    }

    fn turn(status: v2::TurnStatus) -> v2::Turn {
        turn_with_id("t1", status)
    }

    #[test]
    fn a_completed_turn_ends_the_turn_and_an_interrupted_one_reads_as_cancelled() {
        assert_eq!(
            stop_reason(&turn(v2::TurnStatus::Completed)).expect("completed"),
            acp::StopReason::EndTurn,
        );
        assert_eq!(
            stop_reason(&turn(v2::TurnStatus::Interrupted)).expect("interrupted"),
            acp::StopReason::Cancelled,
        );
    }

    #[test]
    fn a_failed_turn_is_an_error_rather_than_a_normal_finish() {
        // The protocol has no failure stop reason. Mapping `Failed` onto
        // `EndTurn` would render a broken turn as a finished one — the user
        // sees a turn that just stopped, with no error anywhere.
        let mut failed = turn(v2::TurnStatus::Failed);
        failed.error = Some(v2::TurnError {
            message: "the model refused".to_string(),
            codex_error_info: None,
            additional_details: None,
            retry_delay_ms: None,
        });
        let err = stop_reason(&failed).expect_err("a failed turn must not be a stop reason");
        assert!(err.to_string().contains("the model refused"));
    }

    #[test]
    fn a_failed_turn_with_no_message_still_errors() {
        let err = stop_reason(&turn(v2::TurnStatus::Failed)).expect_err("still an error");
        assert!(err.to_string().contains("failed"));
    }

    #[tokio::test]
    async fn a_turn_completion_reaches_the_waiter_that_registered_for_it() {
        let waiters = TurnWaiters::default();
        let rx = waiters.register("thread-1", "t1");
        waiters.complete("thread-1", turn(v2::TurnStatus::Completed));
        assert_eq!(rx.await.expect("delivered").id, "t1");
    }

    #[tokio::test]
    async fn a_completion_for_another_turn_does_not_wake_this_one() {
        // Two turns in flight is the case this guards: waking the wrong waiter
        // would end one turn on another's outcome.
        let waiters = TurnWaiters::default();
        let rx = waiters.register("thread-1", "t1");
        waiters.complete("thread-2", turn_with_id("t2", v2::TurnStatus::Interrupted));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), rx)
                .await
                .is_err(),
            "t1's waiter must still be waiting",
        );
    }

    #[test]
    fn cancel_can_find_the_running_turn_and_stops_looking_once_it_ends() {
        // `turn/interrupt` needs a turn id, and the app can only name a
        // session. Without this map cancel has nothing to send and would be
        // silently inert — the worst shape for a cancel button.
        let waiters = TurnWaiters::default();
        assert_eq!(waiters.active_turn("thread-1"), None);

        let _rx = waiters.register("thread-1", "t1");
        assert_eq!(waiters.active_turn("thread-1"), Some("t1".to_string()));

        waiters.complete("thread-1", turn(v2::TurnStatus::Completed));
        assert_eq!(
            waiters.active_turn("thread-1"),
            None,
            "a finished turn must not stay cancellable",
        );
    }

    #[test]
    fn a_stale_completion_does_not_clear_the_next_turn() {
        // Turn 1 completes late, after turn 2 has started on the same thread.
        // Clearing by thread id alone would leave turn 2 uncancellable.
        let waiters = TurnWaiters::default();
        let _first = waiters.register("thread-1", "t1");
        let _second = waiters.register("thread-1", "t2");
        waiters.complete("thread-1", turn_with_id("t1", v2::TurnStatus::Completed));
        assert_eq!(
            waiters.active_turn("thread-1"),
            Some("t2".to_string()),
            "the newer turn must still be the cancellable one",
        );
    }

    #[tokio::test]
    async fn a_completion_that_beats_its_waiter_is_still_delivered() {
        // The race the module docs describe. `turn/start`'s response is where
        // the turn id comes from, so registration cannot happen before the
        // request — and the completion travels on a different task. Losing it
        // here means `prompt` never resolves and the composer spins forever on
        // a turn that already finished.
        let waiters = TurnWaiters::default();
        waiters.complete("thread-1", turn(v2::TurnStatus::Completed));

        let rx = waiters.register("thread-1", "t1");
        let delivered = tokio::time::timeout(std::time::Duration::from_millis(50), rx)
            .await
            .expect("a completion that arrived first must not be lost")
            .expect("delivered");
        assert_eq!(delivered.id, "t1");
        assert_eq!(delivered.status, v2::TurnStatus::Completed);
    }

    #[tokio::test]
    async fn an_early_completion_is_claimed_only_by_its_own_turn() {
        let waiters = TurnWaiters::default();
        waiters.complete("thread-1", turn_with_id("t1", v2::TurnStatus::Completed));

        // A different turn must not swallow t1's completion.
        let other = waiters.register("thread-1", "t2");
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), other)
                .await
                .is_err(),
            "t2 must not be resolved by t1's completion",
        );
        // And t1's is still there to claim.
        let mine = waiters.register("thread-1", "t1");
        assert_eq!(mine.await.expect("still buffered").id, "t1");
    }

    #[tokio::test]
    async fn unclaimed_completions_do_not_grow_without_bound() {
        // A connection lives as long as the app does. An unbounded buffer of
        // turns nobody claimed would be a slow leak.
        let waiters = TurnWaiters::default();
        for i in 0..(UNCLAIMED_COMPLETIONS + 8) {
            waiters.complete(
                "thread-1",
                turn_with_id(&format!("t{i}"), v2::TurnStatus::Completed),
            );
        }
        assert_eq!(waiters.unclaimed().len(), UNCLAIMED_COMPLETIONS);
        // The oldest were dropped, the newest survive.
        let newest = format!("t{}", UNCLAIMED_COMPLETIONS + 7);
        assert!(waiters.unclaimed().iter().any(|t| t.id == newest));
        assert!(!waiters.unclaimed().iter().any(|t| t.id == "t0"));
    }

    #[test]
    fn request_ids_are_unique_within_a_connection() {
        let ids = RequestIds::default();
        assert_ne!(ids.next(), ids.next());
    }
}

/// A handle onto the connection that a per-session control can hold.
///
/// `AgentSessionModes` is handed out from `&self`, not from `Arc<Self>`, so the
/// controls cannot hold the connection itself. They hold what they need
/// instead: the request handle and the shared mode table.
#[derive(Clone)]
struct ConnectionHandle {
    requests: InProcessAppServerRequestHandle,
    request_ids: Arc<RequestIds>,
    session_modes: Arc<Mutex<HashMap<acp::SessionId, acp::SessionModeId>>>,
}

impl EngineConnection {
    fn clone_handle(&self) -> ConnectionHandle {
        ConnectionHandle {
            requests: self.requests.clone(),
            request_ids: self.request_ids.clone(),
            session_modes: self.session_modes.clone(),
        }
    }
}

impl ConnectionHandle {
    async fn update_settings(
        &self,
        session_id: &acp::SessionId,
        build: impl FnOnce(&mut v2::ThreadSettingsUpdateParams),
    ) -> Result<()> {
        let mut params = v2::ThreadSettingsUpdateParams {
            thread_id: session_id.to_string(),
            ..Default::default()
        };
        build(&mut params);
        let _: v2::ThreadSettingsUpdateResponse = self
            .requests
            .request_typed(ClientRequest::ThreadSettingsUpdate {
                request_id: self.request_ids.next(),
                params,
            })
            .await
            .map_err(|e| anyhow!("{e}"))?;
        Ok(())
    }
}

struct EngineSessionModes {
    connection: ConnectionHandle,
    session_id: acp::SessionId,
}

impl AgentSessionModes for EngineSessionModes {
    fn current_mode(&self) -> acp::SessionModeId {
        self.connection
            .session_modes
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&self.session_id)
            .cloned()
            .unwrap_or_else(|| acp::SessionModeId::new(modes::DEFAULT_MODE_ID))
    }

    fn all_modes(&self) -> Vec<acp::SessionMode> {
        modes::mode_state(&self.current_mode().0).available_modes
    }

    fn set_mode(&self, mode: acp::SessionModeId) -> BoxFuture<'static, Result<()>> {
        let connection = self.connection.clone();
        let session_id = self.session_id.clone();
        async move {
            let (approval_policy, sandbox_policy) = modes::engine_policy(&mode.0);
            connection
                .update_settings(&session_id, |params| {
                    params.approval_policy = Some(approval_policy);
                    params.sandbox_policy = Some(sandbox_policy);
                })
                .await?;
            // Recorded only after the engine accepted it. Recording first would
            // leave the picker showing a mode the engine refused.
            connection
                .session_modes
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(session_id, mode);
            Ok(())
        }
        .boxed()
    }
}

/// The composer's model picker, backed by the authored catalogue.
///
/// The list is Atlas's, not the engine's: the engine would fetch one from
/// `{base}/models`, and the gateway's reply is stock-OpenAI shaped where the
/// engine expects its own rich record, so that fetch cannot parse (D3). The
/// catalogue is the source of truth for both.
struct EngineModelSelector {
    requests: InProcessAppServerRequestHandle,
    request_ids: Arc<RequestIds>,
    session_id: acp::SessionId,
    /// The per-session state the selection is written to — the same state the
    /// turn path reads its `model` from. It lives on `EngineSessions`, not
    /// here, because the host constructs a fresh selector per call: state held
    /// on the selector was forgotten the moment the call returned, which is
    /// exactly how the picker's tick mark never moved and the choice never
    /// reached a turn.
    sessions: Arc<EngineSessions>,
}

impl EngineModelSelector {
    fn catalogue() -> Vec<AgentModelInfo> {
        let Ok(catalog) = crate::engine::catalog::atlas_catalog() else {
            // The catalogue is authored in this repo and covered by its own
            // tests, so this is a build-time impossibility rather than a
            // runtime condition — but an empty picker is a better failure than
            // a panic in the composer.
            tracing::error!("the authored model catalogue failed to parse");
            return Vec::new();
        };
        catalog
            .models
            .into_iter()
            .map(|model| AgentModelInfo {
                id: AgentModelId::new(model.slug.as_str()),
                name: model.display_name.as_str().into(),
                description: model.description.as_deref().map(Into::into),
                icon: None,
                is_latest: false,
                // Deliberately blank. The BYOK picker shows per-million
                // provider rates, which are not what an Atlas turn costs — a
                // turn is metered against the account's own weighted cap. A
                // number here would be a wrong number.
                cost: None,
                disabled: None,
            })
            .collect()
    }
}

impl AgentModelSelector for EngineModelSelector {
    fn list_models(&self) -> BoxFuture<'static, Result<AgentModelList>> {
        let models = Self::catalogue();
        async move { Ok(AgentModelList::Flat(models)) }.boxed()
    }

    fn select_model(&self, model_id: AgentModelId) -> BoxFuture<'static, Result<()>> {
        // Refused rather than sent. The gateway answers an unknown slug with
        // `403 model_not_allowed`, which arrives as a failed turn well after
        // the user made the choice; saying no here keeps the cause next to the
        // click.
        let known = Self::catalogue().into_iter().any(|m| m.id == model_id);
        let requests = self.requests.clone();
        let request_id = self.request_ids.next();
        let thread_id = self.session_id.to_string();
        let model = model_id.as_str().to_string();
        if known {
            self.sessions
                .set_selected_model(&self.session_id, model.clone());
        }
        async move {
            if !known {
                return Err(anyhow!("{model} is not a model this account can use"));
            }
            let _: v2::ThreadSettingsUpdateResponse = requests
                .request_typed(ClientRequest::ThreadSettingsUpdate {
                    request_id,
                    params: v2::ThreadSettingsUpdateParams {
                        thread_id,
                        model: Some(model),
                        ..Default::default()
                    },
                })
                .await?;
            Ok(())
        }
        .boxed()
    }

    fn selected_model(&self) -> BoxFuture<'static, Result<AgentModelInfo>> {
        // The per-session choice, or the catalogue default before any choice.
        let selected = self
            .sessions
            .selected_model(&self.session_id)
            .map(|m| AgentModelId::new(m.as_str()))
            .unwrap_or_else(|| AgentModelId::new(crate::engine::catalog::DEFAULT_MODEL));
        let found = Self::catalogue().into_iter().find(|m| m.id == selected);
        async move {
            found.ok_or_else(|| anyhow!("the selected model is not in the catalogue"))
        }
        .boxed()
    }
}

struct EngineSessionControls {
    requests: InProcessAppServerRequestHandle,
    session_id: acp::SessionId,
    request_ids: Arc<RequestIds>,
    /// Spawn target for the fire-and-forget update — `set_effort` is a sync
    /// trait method and runs on the caller's thread, where there may be no
    /// ambient runtime (the same main-thread hazard `cancel` had).
    runtime: tokio::runtime::Handle,
}

impl AgentSessionEffort for EngineSessionControls {
    /// Spec open question 4, resolved: the per-session effort knob is
    /// `thread/settings/update`'s `effort` field. `None` clears the override
    /// and returns the model to its own default, which is what the trait's
    /// `None` means.
    fn set_effort(&self, level: Option<String>) -> Result<()> {
        let effort = match level.as_deref() {
            Some(level) => Some(parse_effort(level)?),
            None => None,
        };
        let requests = self.requests.clone();
        let request_id = self.request_ids.next();
        let thread_id = self.session_id.to_string();
        // The trait is synchronous and the call is not, so this is fire-and-
        // forget like the Cersei path's — on the engine's runtime, because
        // the caller's thread may have none. A rejected update is logged
        // rather than surfaced, because the caller has already moved on.
        self.runtime.spawn(async move {
            let result = requests
                .request_typed::<v2::ThreadSettingsUpdateResponse>(
                    ClientRequest::ThreadSettingsUpdate {
                        request_id,
                        params: v2::ThreadSettingsUpdateParams {
                            thread_id,
                            effort,
                            ..Default::default()
                        },
                    },
                )
                .await;
            if let Err(e) = result {
                tracing::warn!(
                    target: "atlas_native_agent::engine",
                    "setting reasoning effort failed: {e}",
                );
            }
        });
        Ok(())
    }
}

/// Atlas's effort vocabulary onto the engine's.
///
/// Rejected rather than silently defaulted: a mistyped level that quietly
/// became "medium" would look like the knob doing nothing.
fn parse_effort(level: &str) -> Result<ReasoningEffort> {
    match level.to_ascii_lowercase().as_str() {
        "none" => Ok(ReasoningEffort::None),
        "minimal" => Ok(ReasoningEffort::Minimal),
        "low" => Ok(ReasoningEffort::Low),
        "medium" => Ok(ReasoningEffort::Medium),
        "high" => Ok(ReasoningEffort::High),
        "xhigh" | "x-high" => Ok(ReasoningEffort::XHigh),
        "max" => Ok(ReasoningEffort::Max),
        "ultra" => Ok(ReasoningEffort::Ultra),
        other => Err(anyhow!("unknown reasoning effort {other:?}")),
    }
}

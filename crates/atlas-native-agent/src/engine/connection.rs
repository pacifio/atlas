//! The `AgentConnection` the app plugs into, over the ported engine.
//!
//! This is the counterpart of `crate::connection::CerseiConnection`, and it
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
use atlas_acp_thread::{AcpThread, AcpThreadHandle, AgentConnection, AgentId, AgentSessionModes};
use crate::connection::AgentSessionEffort;
use atlas_agent_servers::ThreadEventSink;
use codex_app_server_client::InProcessAppServerClient;
use codex_app_server_client::InProcessAppServerRequestHandle;
// The v2 protocol types are re-exported at the crate root
// (`pub use protocol::v2::*`), so this alias is the whole vocabulary.
use codex_app_server_protocol as v2;
use codex_app_server_protocol::ClientRequest;
use codex_app_server_protocol::RequestId;
use codex_app_server::in_process::InProcessServerEvent;
use codex_login::auth::ExternalAuth;
use codex_protocol::openai_models::ReasoningEffort;
use futures::future::BoxFuture;
use futures::FutureExt;
use tokio::sync::oneshot;

use crate::engine::config::EngineSettings;
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
    /// The engine's runtime. Dropped last, after the pump it hosts.
    _runtime: Arc<EngineRuntime>,
    /// The mode each session is in.
    ///
    /// Held here because the engine has no "Atlas mode" concept to read back —
    /// it has an approval policy and a sandbox policy, and several modes could
    /// in principle produce the same pair. The mode the user picked is Atlas's
    /// fact to remember.
    session_modes: Arc<Mutex<HashMap<acp::SessionId, acp::SessionModeId>>>,
    default_mode: Option<acp::SessionModeId>,
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
        let (runtime, client) = start_engine(&settings, external_auth).await?;
        let max_retries = settings.stream_max_retries;
        let requests = client.request_handle();
        let sessions = Arc::new(EngineSessions::default());
        let turns = Arc::new(TurnWaiters::default());

        // On the engine's runtime, not the host's: the pump owns the client,
        // and the client's `next_event` is fed by engine tasks.
        let pump = runtime
            .handle()
            .spawn(pump_events(
                client,
                sessions.clone(),
                turns.clone(),
                max_retries,
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
            _runtime: Arc::new(runtime),
            session_modes: Arc::new(Mutex::new(HashMap::new())),
            default_mode,
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
        Arc::new(Mutex::new(thread))
    }
}

async fn pump_events(
    mut client: InProcessAppServerClient,
    sessions: Arc<EngineSessions>,
    turns: Arc<TurnWaiters>,
    max_retries: usize,
) {
    while let Some(event) = client.next_event().await {
        match event {
            InProcessServerEvent::ServerNotification(notification) => {
                apply_notification(&sessions, &turns, max_retries, *notification);
            }
            InProcessServerEvent::ServerRequest(request) => {
                // Approvals and elicitations round-trip here, and wiring them
                // is #47's job. Until then every server request is refused
                // rather than ignored: an unanswered request is a turn that
                // hangs with no way for the user to see why.
                let id = request.id().clone();
                tracing::warn!(
                    target: "atlas_native_agent::engine",
                    "refusing an engine server request: {request:?}",
                );
                let _ = client
                    .reject_server_request(
                        id,
                        codex_app_server_protocol::JSONRPCErrorError {
                            code: -32601,
                            message: "Atlas does not serve engine server requests yet (#47)"
                                .to_string(),
                            data: None,
                        },
                    )
                    .await;
            }
            InProcessServerEvent::Lagged { skipped } => {
                // Transport health, not an application event. Worth saying out
                // loud: dropped notifications show up to a user as a turn that
                // rendered incompletely.
                tracing::warn!(
                    target: "atlas_native_agent::engine",
                    "the engine event stream lagged; {skipped} notifications dropped",
                );
            }
        }
    }
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
                        ..Default::default()
                    },
                })
                .await?;

            // The engine's thread id *is* the ACP session id. Keeping them the
            // same identifier rather than maintaining a mapping is what lets a
            // stored row resolve without a translation table.
            let session_id = acp::SessionId::new(response.thread.id.as_str());
            let thread = self.new_thread(session_id.clone(), work_dirs, None);
            self.sessions.insert(session_id.clone(), &thread);

            let mode = self
                .default_mode
                .clone()
                .unwrap_or_else(|| acp::SessionModeId::new(modes::DEFAULT_MODE_ID));
            // Applied rather than merely recorded: a thread started without
            // this runs on the engine's own defaults, so the picker would show
            // a mode the engine is not in.
            self.apply_mode(&session_id, &mode).await?;
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
        let text = crate::engine::sink::flatten_prompt(&params.prompt);
        let thread_id = params.session_id.to_string();
        let requests = self.requests.clone();
        let turns = self.turns.clone();
        let request_id = self.request_ids.next();
        let model = self.settings.model.clone();

        async move {
            let started: v2::TurnStartResponse = requests
                .request_typed(ClientRequest::TurnStart {
                    request_id,
                    params: v2::TurnStartParams {
                        thread_id: thread_id.clone(),
                        input: vec![v2::UserInput::Text {
                            text,
                            text_elements: Vec::new(),
                        }],
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
        tokio::spawn(async move {
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

struct EngineSessionControls {
    requests: InProcessAppServerRequestHandle,
    session_id: acp::SessionId,
    request_ids: Arc<RequestIds>,
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
        // forget like the Cersei path's. A rejected update is logged rather
        // than surfaced, because the caller has already moved on.
        tokio::spawn(async move {
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

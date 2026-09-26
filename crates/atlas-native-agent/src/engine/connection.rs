//! The `AgentConnection` the app plugs into, over the ported engine.
//!
//! This was the counterpart of the previous native connection, now deleted (#54), and it
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
use std::sync::RwLock;

use agent_client_protocol::schema::v1 as acp;
use anyhow::anyhow;
use anyhow::Result;
use atlas_acp_thread::{
    AcpThread, AcpThreadHandle, AgentConnection, AgentId, AgentModelId, AgentModelInfo,
    AgentModelList, AgentModelSelector, AgentSessionModes, AgentSessionRewind, AuthorizationKind,
};
use crate::AgentSessionEffort;
use atlas_agent_servers::{SessionMcpOffer, SessionMcpRequest, SessionMcpServers, ThreadEventSink};
use atlas_engine_app_server_client::InProcessAppServerClient;
use atlas_engine_app_server_client::InProcessAppServerRequestHandle;
// The v2 protocol types are re-exported at the crate root
// (`pub use protocol::v2::*`), so this alias is the whole vocabulary.
use atlas_engine_app_server_protocol as v2;
use atlas_engine_app_server_protocol::ClientRequest;
use atlas_engine_app_server_protocol::RequestId;
use atlas_engine_app_server_protocol::ServerRequest;
use atlas_engine_app_server::in_process::InProcessServerEvent;
use atlas_engine_login::auth::ExternalAuth;
use atlas_engine_protocol::openai_models::ReasoningEffort;
use futures::future::BoxFuture;
use futures::FutureExt;
use tokio::sync::oneshot;

use crate::engine::auth::SystemClock;
use crate::engine::catalog_cache::{self, CatalogueFetcher, CatalogueUnavailable};
use crate::engine::config::EngineHome;
use crate::engine::config::EngineSettings;
use crate::engine::config::WireDialect;
use crate::engine::approvals;
use crate::engine::mcp;
use crate::engine::modes;
use crate::engine::questions;
use crate::engine::tool_approvals;
use crate::engine::runtime::start_engine;
use crate::engine::runtime::EngineRuntime;
use crate::engine::sink::EngineSessions;
use crate::engine::sink::PromptPlace;
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
    /// Threads whose prompt is between entry and [`TurnWaiters::register`] —
    /// the window in which a stop has no turn id to interrupt (#57). The
    /// register-after-response race has a cancel half too: `active` is only
    /// written by `register`, which runs after the `turn/start` round trip, so
    /// a stop pressed during that round trip used to find nothing and return —
    /// while the UI, whose `running_turn` was already taken, dropped the Stop
    /// button in the same instant. The turn then ran to completion with no way
    /// to stop it.
    starting: Mutex<std::collections::HashSet<String>>,
    /// Stops pressed inside that window. Recorded here by [`TurnWaiters::cancel_requested`]
    /// and honoured by the prompt path the moment the turn id exists.
    pending_cancel: Mutex<std::collections::HashSet<String>>,
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
            .unwrap_or_else(std::sync::PoisonError::into_inner)
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
        let mut attempts = self.attempts.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let counter = attempts.entry(turn_id.to_string()).or_insert(0);
        *counter += 1;
        *counter
    }

    fn unclaimed(&self) -> std::sync::MutexGuard<'_, std::collections::VecDeque<v2::Turn>> {
        self.unclaimed.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The turn to interrupt for a session, if one is running.
    pub(crate) fn active_turn(&self, thread_id: &str) -> Option<String> {
        self.active().get(thread_id).cloned()
    }

    /// Whether a turn is running or starting on this thread — the state in
    /// which a mode switch would relabel the picker without touching the
    /// turn's frozen context (#61).
    pub(crate) fn is_busy(&self, thread_id: &str) -> bool {
        self.active().contains_key(thread_id) || self.starting().contains(thread_id)
    }

    /// The prompt path is about to send `turn/start`. Until [`TurnWaiters::end_prompt`]
    /// a cancel for this thread has no turn id; it is recorded instead and
    /// honoured when the id exists.
    fn begin_prompt(&self, thread_id: &str) {
        self.starting().insert(thread_id.to_string());
    }

    /// A cancel arrived with no active turn. Records it if a prompt is inside
    /// its starting window, and answers whether it was recorded — `false`
    /// means nothing is running or starting, a true no-op.
    pub(crate) fn cancel_requested(&self, thread_id: &str) -> bool {
        if !self.starting().contains(thread_id) {
            return false;
        }
        self.pending_cancel().insert(thread_id.to_string());
        true
    }

    /// The starting window is over — the turn registered, failed to start, or
    /// finished before it could be waited on. Answers whether a cancel arrived
    /// inside the window; the flag is consumed either way, so a stop aimed at
    /// a turn that never ran cannot leak into the next one.
    fn end_prompt(&self, thread_id: &str) -> bool {
        self.starting().remove(thread_id);
        self.pending_cancel().remove(thread_id)
    }

    fn starting(&self) -> std::sync::MutexGuard<'_, std::collections::HashSet<String>> {
        self.starting.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn pending_cancel(&self) -> std::sync::MutexGuard<'_, std::collections::HashSet<String>> {
        self.pending_cancel.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn forget(&self, thread_id: &str, turn_id: &str) {
        self.waiters().remove(turn_id);
        let mut active = self.active();
        if active.get(thread_id).is_some_and(|id| id == turn_id) {
            active.remove(thread_id);
        }
    }

    fn waiters(&self) -> std::sync::MutexGuard<'_, HashMap<String, oneshot::Sender<v2::Turn>>> {
        self.waiters.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn active(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.active.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// The catalogue this connection is running on (ADR-0007).
///
/// Captured at connect from the fetched-and-cached gateway list, and the
/// single source for both the picker and the model a thread starts on. The
/// engine loaded the same rows into its own catalogue at startup and will
/// not reload them; that is why [`LiveCatalogue::fingerprint`] exists — a
/// refresh whose fingerprint differs needs a new connection, one whose
/// fingerprint matches may swap the labels in place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveCatalogue {
    /// What the composer lists, in the gateway's order.
    pub picker: Vec<AgentModelInfo>,
    /// The first entitled row: what a session runs on before any pick.
    pub default_model: String,
    /// Slugs and context windows, in order — the engine-relevant identity.
    pub fingerprint: u64,
    /// When the rows were fetched (unix seconds). `0` for a pinned model.
    pub fetched_at: u64,
    /// The gateway did not answer at connect and an older cache carried it.
    pub stale: bool,
}

impl LiveCatalogue {
    /// A single pinned model, for a provider whose list the seam does not
    /// own (the dev Responses provider).
    fn single(model: String) -> Self {
        Self {
            picker: vec![AgentModelInfo {
                id: AgentModelId::new(model.as_str()),
                name: model.as_str().into(),
                description: None,
                icon: None,
                is_latest: false,
                cost: None,
                disabled: None,
            }],
            default_model: model,
            fingerprint: 0,
            fetched_at: 0,
            stale: false,
        }
    }

    fn from_projection(projected: catalog_cache::ProjectedCatalogue, fetched_at: u64, stale: bool) -> Self {
        Self {
            picker: projected.picker,
            default_model: projected.default_model,
            fingerprint: projected.fingerprint,
            fetched_at,
            stale,
        }
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
    /// The model list this connection runs on. A std lock, not a tokio one:
    /// the host reads it under `futures::executor::block_on` on the send
    /// path, where a lock that parks the runtime would deadlock it.
    catalogue: Arc<RwLock<LiveCatalogue>>,
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
    /// Decides the MCP servers each thread is handed (the memory tool
    /// server), projected into the thread's config overrides.
    session_mcp: Option<Arc<dyn SessionMcpServers>>,
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
        Self::connect_full(id, settings, thread_events, external_auth, default_mode, None, None).await
    }

    /// Opens the connection.
    ///
    /// `catalogue` is how the model list is fetched (ADR-0007). It is
    /// required on the gateway dialect — there is no list without it — and
    /// ignored on the Responses one, where `settings.model` names the single
    /// pinned model. The resolve runs here, on the host runtime, before the
    /// engine starts: it may wait on the network for up to the fetch timeout,
    /// and the engine's startup task is the wrong place to do that waiting.
    pub async fn connect_full(
        id: AgentId,
        settings: EngineSettings,
        thread_events: ThreadEventSink,
        external_auth: Option<Arc<dyn ExternalAuth>>,
        default_mode: Option<acp::SessionModeId>,
        session_mcp: Option<Arc<dyn SessionMcpServers>>,
        catalogue: Option<Arc<dyn CatalogueFetcher>>,
    ) -> Result<Arc<Self>> {
        let (live, response) = match settings.provider.wire {
            WireDialect::Chat => {
                let Some(fetcher) = catalogue else {
                    return Err(anyhow!(
                        "the gateway dialect needs a catalogue fetcher and none was supplied"
                    ));
                };
                let resolved = catalog_cache::resolve(
                    settings.home.path(),
                    fetcher.as_ref(),
                    &SystemClock,
                    false,
                )
                .await?;
                let stale = resolved.is_stale();
                let cache = resolved.into_cache();
                let Some(projected) = catalog_cache::project(&cache) else {
                    return Err(CatalogueUnavailable::no_entitled_models().into());
                };
                let response = projected.response.clone();
                (
                    LiveCatalogue::from_projection(projected, cache.fetched_at, stale),
                    Some(response),
                )
            }
            WireDialect::Responses => {
                let Some(model) = settings.model.clone() else {
                    return Err(anyhow!("the Responses dialect needs a configured model"));
                };
                (LiveCatalogue::single(model), None)
            }
        };
        tracing::info!(
            default_model = %live.default_model,
            models = live.picker.len(),
            stale = live.stale,
            "native agent: model catalogue resolved",
        );

        // Mint the account token BEFORE the engine exists. The engine installs
        // the provider eagerly (`AuthManager::install_external_auth` resolves
        // it on the spot), so a mint that fails — no network at launch, most
        // often — failed inside the runtime start and reached the user as
        // "starting the in-process app-server runtime" with the cause cut
        // off. Resolving here says what actually went wrong, in the words
        // the catalogue path already uses, and costs nothing on success: the
        // token is cached on the provider, so the engine's own resolve is a
        // cache hit.
        if let Some(auth) = external_auth.as_ref() {
            if let Err(err) = auth.resolve().await {
                return Err(anyhow!(
                    "Atlas Agent can't sign in to the gateway ({err}). Check your connection and try again."
                ));
            }
        }
        let (runtime, client) = start_engine(&settings, external_auth, response.as_ref()).await?;
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
            session_mcp.clone(),
        ));

        Ok(Arc::new(Self {
            id,
            requests,
            sessions,
            turns,
            thread_events,
            request_ids: Arc::new(RequestIds::default()),
            settings,
            catalogue: Arc::new(RwLock::new(live)),
            _pump: Arc::new(PumpHandle(pump)),
            runtime: Arc::new(runtime),
            session_modes: Arc::new(Mutex::new(HashMap::new())),
            default_mode,
            session_mcp,
        }))
    }

    /// The model a thread starts on before any pick: the catalogue's first
    /// entitled row (ADR-0007).
    fn default_model(&self) -> String {
        self.catalogue
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .default_model
            .clone()
    }

    /// The catalogue this connection is running on.
    pub fn catalogue_snapshot(&self) -> LiveCatalogue {
        self.catalogue
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Swaps in refreshed labels without a reconnect.
    ///
    /// Only for a catalogue with the **same fingerprint**: the engine loaded
    /// its rows once, at startup, so a list with a different slug set or a
    /// different context window is a list the engine does not know, and
    /// offering it here would let the user pick a model the engine would
    /// invent metadata for (`model_info_from_slug`) and the gateway would
    /// `400`. That case is a reconnect, and this refuses it.
    pub fn replace_catalogue_metadata(&self, next: LiveCatalogue) -> Result<()> {
        let mut live = self
            .catalogue
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if live.fingerprint != next.fingerprint {
            return Err(anyhow!(
                "the model list changed in a way the running engine cannot pick up; reconnect"
            ));
        }
        *live = next;
        Ok(())
    }

    /// The engine's private home — where the catalogue cache lives.
    pub fn engine_home(&self) -> &EngineHome {
        &self.settings.home
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
            .unwrap_or_else(std::sync::PoisonError::into_inner)
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
            .unwrap_or_else(|| self.default_model());
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
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .handle_session_update(acp::SessionUpdate::AvailableCommandsUpdate(
                    acp::AvailableCommandsUpdate::new(crate::engine::commands::available(&skills)),
                ));
        }
    }

    /// Reasoning effort for one session — native-only, like the previous native path.
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

    /// What the host offers the thread about to open in `cwd`, and its config
    /// overrides. The engine takes StreamableHttp servers, so it is asked as
    /// an agent that advertises HTTP MCP.
    fn mcp_offer(
        &self,
        cwd: &std::path::Path,
        session_id: Option<&acp::SessionId>,
    ) -> (SessionMcpOffer, Option<HashMap<String, serde_json::Value>>) {
        let offer = atlas_agent_servers::session_mcp::offer_for(
            self.session_mcp.as_ref(),
            &SessionMcpRequest {
                agent_id: self.id.clone(),
                http_mcp: true,
                // In-process: the one connection Atlas vouches for, so it may
                // be handed the UI tool server (ADR-0012).
                ui_control: true,
                // And, for the same reason, organisation access: it may be
                // handed the organisation tool server (ADR-0014).
                org_access: true,
                cwd: cwd.to_path_buf(),
                session_id: session_id.cloned(),
            },
        );
        let config = mcp::thread_config(offer.servers(), offer.ask_first());
        (offer, config)
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
    host: Option<Arc<dyn SessionMcpServers>>,
) {
    let (answers_tx, mut answers_rx) = tokio::sync::mpsc::unbounded_channel::<ServerAnswer>();

    loop {
        tokio::select! {
            // Biased so answers are delivered promptly: a turn is blocked on
            // every one of them.
            biased;

            Some(answer) = answers_rx.recv() => {
                // A failed delivery here is the worst silent outcome this
                // loop has: the engine turn waits forever for an answer that
                // will never arrive, and the user sees a spinner (#69). It
                // cannot be retried — the request id may be gone — but it
                // must never be invisible.
                match answer.result {
                    Ok(value) => {
                        if let Err(e) = client.resolve_server_request(answer.request_id, value).await {
                            tracing::warn!(
                                target: "atlas_native_agent::engine",
                                "delivering an approval to the engine failed; \
                                 the waiting turn may hang: {e}",
                            );
                        }
                    }
                    Err(message) => {
                        if let Err(e) = client
                            .reject_server_request(
                                answer.request_id,
                                atlas_engine_app_server_protocol::JSONRPCErrorError {
                                    code: -32603,
                                    message,
                                    data: None,
                                },
                            )
                            .await
                        {
                            tracing::warn!(
                                target: "atlas_native_agent::engine",
                                "delivering a rejection to the engine failed; \
                                 the waiting turn may hang: {e}",
                            );
                        }
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
                            handle_server_request(&sessions, host.as_ref(), *request, &answers_tx);
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
    use atlas_engine_app_server_protocol::ServerNotification;
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
///
/// Two kinds reach the user: the tool approvals, and the model's own
/// clarifying question (ADR-0013). Both pin a card above the composer, so both
/// join the session's one-card-at-a-time line ([`PromptPlace`]) here, on the
/// pump, where the order they join in is the order they arrived in.
///
/// The tool approvals are the three the engine asks as approval requests, and
/// a fourth it asks as an MCP elicitation of its own: an outward action on one
/// of Atlas's tool servers (ADR-0014, [`tool_approvals`]). `host` is what
/// describes that one — who it reaches, and the full body.
fn handle_server_request(
    sessions: &Arc<EngineSessions>,
    host: Option<&Arc<dyn SessionMcpServers>>,
    request: ServerRequest,
    answers: &tokio::sync::mpsc::UnboundedSender<ServerAnswer>,
) {
    use atlas_engine_app_server_protocol::ServerRequest as Req;

    let request = match request {
        Req::ToolRequestUserInput { request_id, params } => {
            ask_question(sessions, request_id, params, answers);
            return;
        }
        Req::McpServerElicitationRequest { request_id, params }
            if tool_approvals::is_engine_tool_approval(
                &params,
                sessions.is_host_server(&params.thread_id, &params.server_name),
            ) =>
        {
            ask_tool_approval(sessions, host.cloned(), request_id, params, answers);
            return;
        }
        other => other,
    };

    // `surface` and `item_id` exist only for the decision log below: an
    // approval that is answered and then goes nowhere leaves no other trace.
    let (request_id, thread_id, prompt, surface, item_id) = match &request {
        Req::CommandExecutionRequestApproval { request_id, params } => (
            request_id.clone(),
            params.thread_id.clone(),
            approvals::tool_call(
                &params.item_id,
                acp::ToolKind::Execute,
                params.command.clone(),
                params.reason.clone(),
            ),
            "command",
            params.item_id.clone(),
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
            "file_change",
            params.item_id.clone(),
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
            "permissions",
            params.item_id.clone(),
        ),
        other => {
            // MCP elicitations, dynamic tool calls, attestation. Refused
            // rather than ignored: an unanswered request is a turn that hangs
            // with no way for the user to see why.
            //
            // MCP elicitation stays refused on purpose, not for want of a
            // path (ADR-0013): a tool server Atlas offers returns its
            // candidates in its result and the MODEL asks, so no tool server
            // ever talks to the user directly. The one elicitation served is
            // the ENGINE's own ask before an outward action, recognised above
            // (`tool_approvals`) and never one a server sent.
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

    let session_id = acp::SessionId::new(thread_id.as_str());
    let Some(thread) = sessions.thread(&session_id) else {
        let _ = answers.send(ServerAnswer {
            request_id,
            result: Err("no open thread for this approval".to_string()),
        });
        return;
    };

    let answered = raise_in_turn(sessions.join_prompt_line(&session_id), thread, |thread| {
        thread.request_tool_call_authorization(
            prompt,
            approvals::options(),
            AuthorizationKind::PermissionGrant,
        )
    });
    let answers = answers.clone();
    tokio::spawn(async move {
        let decision = match answered.await {
            Ok(Some(outcome)) => approvals::decision_for(&outcome),
            // The turn stopped while this card waited behind another. The
            // engine's own word for "the user stopped the turn" is Cancel.
            Ok(None) => approvals::Decision::Cancel,
            Err(e) => {
                let _ = answers.send(ServerAnswer {
                    request_id,
                    result: Err(format!("the approval could not be raised: {e}")),
                });
                return;
            }
        };
        // The one record that an approval was answered, and how. A report of a
        // turn that stalls after Allow (issue 294) is otherwise undiagnosable:
        // nothing downstream says which tool the user released, or whether the
        // engine ever heard the answer.
        tracing::info!(
            target: "atlas::approvals",
            decision = ?decision,
            surface,
            item_id = %item_id,
            "approval answered"
        );
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

/// Asks the user before an outward action on one of Atlas's tool servers
/// (ADR-0014): the engine's own approval for a prompted tool, on the approval
/// card, attached to the call's row and described by the host — who it
/// reaches, and the full body ([`tool_approvals`]).
///
/// A tool the user allowed for the rest of this session is answered yes at
/// once, with no card. Otherwise the card joins the session's line here, on
/// the pump, and is raised once the host has described the call — at most
/// [`DESCRIBE_WITHIN`] later, after which it shows the call's own arguments
/// rather than hold the turn on the cloud.
fn ask_tool_approval(
    sessions: &Arc<EngineSessions>,
    host: Option<Arc<dyn SessionMcpServers>>,
    request_id: RequestId,
    params: v2::McpServerElicitationRequestParams,
    answers: &tokio::sync::mpsc::UnboundedSender<ServerAnswer>,
) {
    let session_id = acp::SessionId::new(params.thread_id.as_str());
    let Some(thread) = sessions.thread(&session_id) else {
        let _ = answers.send(ServerAnswer {
            request_id,
            result: Err("no open thread for this approval".to_string()),
        });
        return;
    };
    let server = params.server_name.clone();
    let arguments = tool_approvals::arguments(&params);
    let waiting = {
        let thread = thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        tool_approvals::waiting_call(&thread, &server, &arguments)
    };
    // The call's own row when the thread has it; a card of its own otherwise,
    // so the user is still asked rather than the turn left hanging.
    let (item_id, tool) = waiting.unwrap_or_else(|| {
        (acp::ToolCallId::new(format!("{server}-approval-{request_id:?}")), String::new())
    });

    if !tool.is_empty() && sessions.allowed_for_session(&session_id, &server, &tool) {
        record_consent(host.as_ref(), &session_id, &server, &tool, &arguments);
        tracing::info!(
            target: "atlas::approvals",
            decision = "accept_for_session",
            surface = "mcp_tool",
            item_id = %item_id,
            "approval answered from this session's allowance",
        );
        let _ = answers.send(ServerAnswer {
            request_id,
            result: Ok(tool_approvals::response(approvals::Decision::Accept)),
        });
        return;
    }

    let place = sessions.join_prompt_line(&session_id);
    let sessions = sessions.clone();
    let answers = answers.clone();
    tokio::spawn(async move {
        let description = match host.as_ref().filter(|_| !tool.is_empty()) {
            Some(host) => {
                let call = atlas_agent_servers::CallToApprove {
                    session_id: &session_id,
                    server: &server,
                    tool: &tool,
                    arguments: &arguments,
                };
                tokio::time::timeout(DESCRIBE_WITHIN, host.describe_call(call))
                    .await
                    .ok()
                    .flatten()
            }
            None => None,
        };
        let update = tool_approvals::card(item_id.clone(), &server, &tool, description);
        let answered = raise_in_turn(place, thread, |thread| {
            thread.request_tool_call_authorization(
                update,
                approvals::options(),
                AuthorizationKind::PermissionGrant,
            )
        });
        let decision = match answered.await {
            Ok(Some(outcome)) => approvals::decision_for(&outcome),
            Ok(None) => approvals::Decision::Cancel,
            Err(e) => {
                let _ = answers.send(ServerAnswer {
                    request_id,
                    result: Err(format!("the approval could not be raised: {e}")),
                });
                return;
            }
        };
        if decision == approvals::Decision::AcceptForSession && !tool.is_empty() {
            sessions.allow_for_session(&session_id, &server, &tool);
        }
        if matches!(decision, approvals::Decision::Accept | approvals::Decision::AcceptForSession) {
            record_consent(host.as_ref(), &session_id, &server, &tool, &arguments);
        }
        tracing::info!(
            target: "atlas::approvals",
            decision = ?decision,
            surface = "mcp_tool",
            item_id = %item_id,
            "approval answered"
        );
        let _ = answers.send(ServerAnswer {
            request_id,
            result: Ok(tool_approvals::response(decision)),
        });
    });
}

/// Tells the host the user approved this call
/// ([`SessionMcpServers::approved_call`]), just before the engine hears yes.
/// The server that answers an outward call posts only an approved one, so a
/// call the engine runs without asking — bypass mode auto-approves every
/// prompted tool — is refused there (ADR-0014). A call whose row was not
/// found has no tool name to record, so it is refused too rather than
/// approved blind.
fn record_consent(
    host: Option<&Arc<dyn SessionMcpServers>>,
    session_id: &acp::SessionId,
    server: &str,
    tool: &str,
    arguments: &serde_json::Value,
) {
    if let Some(host) = host.filter(|_| !tool.is_empty()) {
        host.approved_call(atlas_agent_servers::CallToApprove { session_id, server, tool, arguments });
    }
}

/// How long an outward action's card waits on the host to say whom the call
/// reaches before it is raised with the call's own arguments instead.
const DESCRIBE_WITHIN: std::time::Duration = std::time::Duration::from_secs(5);

/// Puts the model's clarifying question to the user (ADR-0013).
///
/// Raised as an elicitation on the session's thread, in the shape the existing
/// question card renders ([`questions::elicitation`]); answered through the
/// same respond path an ACP agent's question is. Anything but an answer — the
/// card skipped, the turn stopped, the thread gone — goes back as an error,
/// which the engine reads as "no answers" and the turn carries on. Never
/// unanswered: a question nobody replies to is a turn that hangs.
fn ask_question(
    sessions: &Arc<EngineSessions>,
    request_id: RequestId,
    params: v2::ToolRequestUserInputParams,
    answers: &tokio::sync::mpsc::UnboundedSender<ServerAnswer>,
) {
    let session_id = acp::SessionId::new(params.thread_id.as_str());
    let Some(thread) = sessions.thread(&session_id) else {
        let _ = answers.send(ServerAnswer {
            request_id,
            result: Err("no open thread for this question".to_string()),
        });
        return;
    };
    let elicitation = match questions::elicitation(&session_id, &params) {
        Ok(elicitation) => elicitation,
        Err(e) => {
            let _ = answers.send(ServerAnswer {
                request_id,
                result: Err(e),
            });
            return;
        }
    };

    let answered = raise_in_turn(sessions.join_prompt_line(&session_id), thread, |thread| {
        thread
            .request_elicitation(elicitation)
            .map(|(_entry, waiter)| waiter)
    });
    let answers = answers.clone();
    tokio::spawn(async move {
        let result = match answered.await {
            Ok(Some(response)) => questions::answers(&params, &response).and_then(|response| {
                serde_json::to_value(response)
                    .map_err(|e| format!("could not encode the answer: {e}"))
            }),
            Ok(None) => Err(questions::DISMISSED.to_string()),
            Err(e) => Err(format!("the question could not be raised: {e}")),
        };
        // The same trace an approval leaves, for the same reason: a turn that
        // stalls after a question is otherwise undiagnosable.
        tracing::info!(
            target: "atlas::approvals",
            answered = result.is_ok(),
            surface = "question",
            item_id = %params.item_id,
            "question answered"
        );
        let _ = answers.send(ServerAnswer { request_id, result });
    });
}

/// Raises a card with `raise` once `place` reaches the front of its session's
/// line; the returned future resolves to the user's answer.
///
/// A card with nothing ahead of it is raised **now**, on the pump, exactly as
/// an approval always was — so the thread sees the card before it applies the
/// next notification. Only a card that has to wait is raised later, from the
/// awaiting task.
///
/// `Ok(None)` when the card waited and the turn stopped in the meantime. Stop
/// resolves the cards that are *showing*; one still queued has not been raised
/// yet, and raising it afterwards would pin a card for a turn that is over.
///
/// The place is released once the answer is in, which is what lets the next
/// card up.
fn raise_in_turn<W>(
    mut place: PromptPlace,
    thread: AcpThreadHandle,
    raise: impl FnOnce(&mut AcpThread) -> std::result::Result<W, acp::Error> + Send + 'static,
) -> BoxFuture<'static, std::result::Result<Option<W::Output>, String>>
where
    W: std::future::Future + Send + 'static,
    W::Output: Send,
{
    fn lock(thread: &AcpThreadHandle) -> std::sync::MutexGuard<'_, AcpThread> {
        thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    if !place.is_queued() {
        // Take the waiter out under the lock, then await it without holding it.
        let waiter = raise(&mut lock(&thread));
        return async move {
            let answer = waiter.map_err(|e| e.to_string())?.await;
            drop(place);
            Ok(Some(answer))
        }
        .boxed();
    }
    async move {
        place.wait().await;
        let waiter = {
            let mut thread = lock(&thread);
            if !thread.is_generating() {
                return Ok(None);
            }
            raise(&mut thread).map_err(|e| e.to_string())?
        };
        let answer = waiter.await;
        drop(place);
        Ok(Some(answer))
    }
    .boxed()
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

            // Offered before the thread id exists; bound to it once the
            // engine answers, released (dropped unbound) if it never does.
            let (mcp_offer, mcp_config) = self.mcp_offer(&cwd, None);
            let response: v2::ThreadStartResponse = self
                .call(|request_id| ClientRequest::ThreadStart {
                    request_id,
                    params: v2::ThreadStartParams {
                        model: Some(self.default_model()),
                        model_provider: Some(self.settings.provider.id.clone()),
                        cwd: Some(cwd.to_string_lossy().into_owned()),
                        config: mcp_config,
                        ..Default::default()
                    },
                })
                .await?;

            // The engine's thread id *is* the ACP session id. Keeping them the
            // same identifier rather than maintaining a mapping is what lets a
            // stored row resolve without a translation table.
            let session_id = acp::SessionId::new(response.thread.id.as_str());
            self.sessions
                .expect_mcp_servers(&response.thread.id, mcp::server_names(mcp_offer.servers()));
            mcp_offer.bind(&session_id);
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

    /// The engine reads StreamableHttp MCP servers from its configuration,
    /// which each thread's start and resume carry (`engine::mcp`).
    fn supports_http_mcp(&self) -> bool {
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

            // Offered for the stored id; bound below to whichever id the
            // thread ends up with (a pre-cutover row gets a fresh one).
            let (mcp_offer, mcp_config) = self.mcp_offer(&cwd, Some(&session_id));
            let resumed: Result<v2::ThreadResumeResponse> = self
                .call(|request_id| ClientRequest::ThreadResume {
                    request_id,
                    params: v2::ThreadResumeParams {
                        thread_id: session_id.to_string(),
                        cwd: Some(cwd.to_string_lossy().into_owned()),
                        model: Some(self.default_model()),
                        model_provider: Some(self.settings.provider.id.clone()),
                        config: mcp_config.clone(),
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
                        // Known gap: a thread still loaded in the engine keeps
                        // the MCP config it was started with, so the memory
                        // server entry offered above does not reach it, and the
                        // token it holds was revoked when its session ended.
                        // Its memory tools answer 401 until the engine lets go
                        // of the thread, and nothing else carries memory to it.
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
                                        model: Some(self.default_model()),
                                        model_provider: Some(self.settings.provider.id.clone()),
                                        cwd: Some(cwd.to_string_lossy().into_owned()),
                                        config: mcp_config.clone(),
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
            self.sessions.expect_mcp_servers(
                &engine_session_id.to_string(),
                mcp::server_names(mcp_offer.servers()),
            );
            mcp_offer.bind(&engine_session_id);
            let thread = self.new_thread(engine_session_id.clone(), work_dirs, title);
            {
                // The response carried the thread's whole stored history — the
                // primary source for what a reopened session shows. Replayed
                // before the handle leaves, so the first snapshot already has
                // it (see `engine::replay`). A pre-cutover row took the
                // fresh-thread arm above and has no turns; it opens empty,
                // which D6 accepted, and now only that row does.
                let mut locked = thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
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
            .unwrap_or_else(|| self.default_model());

        // A slash command is not something to say to the model — sent as a
        // turn it would arrive as the literal text "/compact", which the
        // engine has no reason to interpret. Each resolves to what it really
        // is: a protocol call, a canned turn, a local reply, or a skill turn.
        let skills = self.sessions.skills(&params.session_id);
        let mut turn_input: Option<Vec<v2::UserInput>> = None;
        match crate::engine::commands::parse(&text, &skills) {
            Some(crate::engine::commands::Command::Compact) => {
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
                let session_id = params.session_id;
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
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
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
                let session_id = params.session_id;
                return async move {
                    let cwd = sessions
                        .cwd(&session_id)
                        .unwrap_or_else(|| "unknown".to_string());
                    let reply = crate::engine::commands::status_reply(&model, &cwd);
                    if let Some(thread) = sessions.thread(&session_id) {
                        thread
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
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
                let session_id = params.session_id;
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
                                    thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
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
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
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
                let session_id = params.session_id;
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
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
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
                let request_ids = self.request_ids.clone();
                return async move {
                    let target = match instructions {
                        Some(instructions) => v2::ReviewTarget::Custom { instructions },
                        None => v2::ReviewTarget::UncommittedChanges,
                    };
                    // The review runs as a turn, so it has the same stop
                    // window as a prompt: no id to interrupt until
                    // `review/start` answers (#57).
                    turns.begin_prompt(&thread_id);
                    let started = match requests
                        .request_typed::<v2::ReviewStartResponse>(ClientRequest::ReviewStart {
                            request_id,
                            params: v2::ReviewStartParams {
                                thread_id: thread_id.clone(),
                                target,
                                delivery: Some(v2::ReviewDelivery::Inline),
                            },
                        })
                        .await
                    {
                        Ok(started) => started,
                        Err(e) => {
                            turns.end_prompt(&thread_id);
                            return Err(anyhow!("the review could not start: {e}"));
                        }
                    };
                    if started.turn.status != v2::TurnStatus::InProgress {
                        turns.end_prompt(&thread_id);
                        return Ok(acp::PromptResponse::new(stop_reason(&started.turn)?));
                    }
                    let waiter = turns.register(&thread_id, &started.turn.id);
                    if turns.end_prompt(&thread_id) {
                        send_interrupt(
                            &requests,
                            &request_ids,
                            thread_id.clone(),
                            started.turn.id.clone(),
                        )
                        .await;
                    }
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

        let request_ids = self.request_ids.clone();
        let sessions = self.sessions.clone();
        async move {
            // A turn lists whichever MCP servers are up when it starts, so a
            // first prompt sent before the host's servers finish starting
            // went out without their tools — and the memory tools are the
            // only way memory reaches the model. Bounded: past it, the turn
            // goes ahead without them.
            if !sessions
                .wait_for_mcp_servers(&thread_id, crate::engine::sink::MCP_STARTUP_WAIT)
                .await
            {
                tracing::warn!(
                    thread = %thread_id,
                    "host MCP servers still starting; this turn goes ahead without their tools"
                );
            }
            // Opens the window a stop can land in with no turn id to
            // interrupt. Every exit below closes it via `end_prompt` (#57).
            turns.begin_prompt(&thread_id);
            let started = match requests
                .request_typed::<v2::TurnStartResponse>(ClientRequest::TurnStart {
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
            {
                Ok(started) => started,
                Err(e) => {
                    // The turn never ran; a stop aimed at it succeeded
                    // vacuously and must not leak into the next turn.
                    turns.end_prompt(&thread_id);
                    return Err(anyhow!("{e}"));
                }
            };

            // If the turn already finished, its outcome is in the response and
            // no notification is coming — registering a waiter for it would
            // hang forever.
            if started.turn.status != v2::TurnStatus::InProgress {
                turns.end_prompt(&thread_id);
                return Ok(acp::PromptResponse::new(stop_reason(&started.turn)?));
            }

            let waiter = turns.register(&thread_id, &started.turn.id);
            // A stop pressed while `turn/start` was in flight had no id to
            // interrupt. It was recorded; honour it now that the id exists.
            // The engine answers by completing the turn as `Interrupted`,
            // which the waiter below reports the usual way.
            if turns.end_prompt(&thread_id) {
                send_interrupt(
                    &requests,
                    &request_ids,
                    thread_id.clone(),
                    started.turn.id.clone(),
                )
                .await;
            }
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

    fn supports_rewind(&self) -> bool {
        true
    }

    fn rewind(&self, session_id: &acp::SessionId) -> Option<Arc<dyn AgentSessionRewind>> {
        self.sessions.thread(session_id)?;
        Some(Arc::new(EngineSessionRewind {
            connection: self.clone_rewind_handle(),
            session_id: session_id.clone(),
        }))
    }

    fn session_modes(&self, session_id: &acp::SessionId) -> Option<Arc<dyn AgentSessionModes>> {
        self.sessions.thread(session_id)?;
        Some(Arc::new(EngineSessionModes {
            connection: self.clone_handle(),
            session_id: session_id.clone(),
        }))
    }

    /// The models the gateway will actually serve (ADR-0007).
    ///
    /// Returning `None` here — which this did until now — is why the composer
    /// fell back to the **BYOK** picker: with no model list from the agent, the
    /// only list the app had was the user's own provider keys. That is a list
    /// of models this agent cannot use, priced at rates that do not apply, and
    /// picking one sends a slug the gateway answers with `403
    /// model_not_allowed`.
    fn model_selector(&self, session_id: &acp::SessionId) -> Option<Arc<dyn AgentModelSelector>> {
        self.sessions.thread(session_id)?;
        Some(Arc::new(EngineModelSelector {
            requests: self.requests.clone(),
            request_ids: self.request_ids.clone(),
            session_id: session_id.clone(),
            sessions: self.sessions.clone(),
            catalogue: self.catalogue.clone(),
        }))
    }

    fn into_any(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
        self
    }

    fn cancel(&self, session_id: &acp::SessionId) {
        let thread_id = session_id.to_string();
        let Some(turn_id) = self.turns.active_turn(&thread_id) else {
            // No turn is registered — but one may be mid-`turn/start`, with
            // no id to interrupt yet. That stop used to be silently dropped,
            // and the Stop button disappeared with it (#57): recorded now,
            // and the prompt path honours it the moment the id exists.
            if self.turns.cancel_requested(&thread_id) {
                tracing::info!(
                    target: "atlas_native_agent::engine",
                    "cancel for {thread_id} recorded while its turn is still starting",
                );
            } else {
                // Nothing running or starting. Not an error — a cancel can
                // race a turn that just finished — but worth saying, because
                // the other reading is that the turn was never recorded and
                // cancel is silently dead.
                tracing::debug!(
                    target: "atlas_native_agent::engine",
                    "cancel for {thread_id} with no turn in flight",
                );
            }
            return;
        };
        let requests = self.requests.clone();
        let request_ids = self.request_ids.clone();
        // Fire and forget, like the previous native path: the caller is awaiting the
        // turn's own completion, and the engine answers an interrupt by
        // finishing that turn as `Interrupted`.
        //
        // On the ENGINE's runtime, never a bare `tokio::spawn`: this sync
        // method runs on the caller's thread, and the stop button's caller is
        // the main thread, where there is no ambient runtime — a bare spawn
        // there panicked and took the whole app down with it.
        self.runtime.handle().spawn(async move {
            send_interrupt(&requests, &request_ids, thread_id, turn_id).await;
        });
    }
}

/// Send `turn/interrupt` and log a failure. The caller is awaiting the turn's
/// own completion, which the engine answers by finishing it as `Interrupted` —
/// so the response here carries nothing to act on, only an error to surface.
async fn send_interrupt(
    requests: &InProcessAppServerRequestHandle,
    request_ids: &RequestIds,
    thread_id: String,
    turn_id: String,
) {
    let result = requests
        .request_typed::<v2::TurnInterruptResponse>(ClientRequest::TurnInterrupt {
            request_id: request_ids.next(),
            params: v2::TurnInterruptParams { thread_id, turn_id },
        })
        .await;
    if let Err(e) = result {
        tracing::warn!(
            target: "atlas_native_agent::engine",
            "interrupting the engine turn failed: {e}",
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── #57: the stop window between `turn/start` and `register` ──────────
    //
    // The integration test presses Stop once against a real engine; these pin
    // the interleavings deterministically, because which side of `register`
    // the press lands on cannot be scripted from outside.

    #[test]
    fn a_cancel_during_the_starting_window_is_recorded_and_handed_to_the_prompt() {
        let turns = TurnWaiters::default();
        turns.begin_prompt("t1");
        assert!(
            turns.cancel_requested("t1"),
            "a stop with a prompt mid-start is recorded, not dropped",
        );
        let _rx = turns.register("t1", "turn-1");
        assert!(
            turns.end_prompt("t1"),
            "the recorded stop reaches the prompt path once the id exists",
        );
        assert!(!turns.end_prompt("t1"), "and is consumed by it");
    }

    #[test]
    fn a_cancel_with_nothing_running_or_starting_stays_a_no_op() {
        let turns = TurnWaiters::default();
        assert!(!turns.cancel_requested("t1"));
        turns.begin_prompt("t1");
        assert!(!turns.end_prompt("t1"), "no stop was pressed");
        assert!(
            !turns.cancel_requested("t1"),
            "the window is closed; a late stop is a no-op again",
        );
    }

    #[test]
    fn a_stop_aimed_at_a_turn_that_never_ran_does_not_leak_into_the_next_one() {
        let turns = TurnWaiters::default();
        turns.begin_prompt("t1");
        assert!(turns.cancel_requested("t1"));
        // `turn/start` failed: the prompt path closes the window, and the
        // stop succeeded vacuously.
        assert!(turns.end_prompt("t1"));
        // The user's next message must not be killed by the stale press.
        turns.begin_prompt("t1");
        assert!(!turns.end_prompt("t1"));
    }

    fn message_delta(thread: &str, item: &str, delta: &str) -> InProcessServerEvent {
        InProcessServerEvent::ServerNotification(Box::new(
            atlas_engine_app_server_protocol::ServerNotification::AgentMessageDelta(
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
                atlas_engine_app_server_protocol::ServerNotification::AgentMessageDelta(p) => {
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
            atlas_engine_error_info: None,
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

    // ── ADR-0013: the engine's requests that reach the user ───────────────
    //
    // Driven through `handle_server_request`, the one function the pump hands
    // every engine request to, against a real `AcpThread`: what the tests
    // read back is the card the thread raised and the answer the engine is
    // sent — the two ends a user and the engine actually see.

    mod asking_the_user {
        use super::*;
        use atlas_acp_thread::{ElicitationStatus, SelectedPermissionOutcome, ToolCallStatus};
        use serde_json::json;
        use std::time::Duration;
        use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

        const THREAD: &str = "thread-1";

        struct Seam {
            sessions: Arc<EngineSessions>,
            thread: AcpThreadHandle,
            answers_tx: UnboundedSender<ServerAnswer>,
            answers_rx: UnboundedReceiver<ServerAnswer>,
            /// What describes an outward action's call, as the app's offers do.
            host: Option<Arc<dyn SessionMcpServers>>,
            /// How many calls the host was asked to describe.
            described: Arc<std::sync::atomic::AtomicUsize>,
            /// The approvals the host was told of, as the app's offers keep
            /// them for the organisation tool server.
            consent: Arc<atlas_agent_servers::OutwardConsent>,
        }

        impl Seam {
            /// An open session whose turn is running, as it is whenever the
            /// engine asks anything.
            fn open() -> Self {
                let sessions = Arc::new(EngineSessions::default());
                let session_id = acp::SessionId::new(THREAD);
                let thread = crate::engine::test_support::detached_thread(session_id.clone());
                sessions.insert(session_id, &thread, "/tmp".to_string());
                lock(&thread).begin_turn();
                let (answers_tx, answers_rx) = unbounded_channel();
                Self {
                    sessions,
                    thread,
                    answers_tx,
                    answers_rx,
                    host: None,
                    described: Arc::default(),
                    consent: Arc::default(),
                }
            }

            fn engine_asks(&self, request: ServerRequest) {
                handle_server_request(&self.sessions, self.host.as_ref(), request, &self.answers_tx);
            }

            async fn engine_hears(&mut self) -> ServerAnswer {
                tokio::time::timeout(Duration::from_secs(5), self.answers_rx.recv())
                    .await
                    .expect("the engine is answered, not left waiting")
                    .expect("the answer channel is open")
            }

            /// Lets spawned card tasks run, then says whether anything was sent.
            async fn engine_heard_nothing(&mut self) -> bool {
                settle().await;
                self.answers_rx.try_recv().is_err()
            }

            fn question_card(&self) -> Option<atlas_acp_thread::ElicitationEntryId> {
                lock(&self.thread)
                    .elicitations()
                    .elicitations()
                    .iter()
                    .find(|e| matches!(e.status, ElicitationStatus::Pending { .. }))
                    .map(|e| e.id.clone())
            }

            fn question_schema(&self) -> serde_json::Value {
                let thread = lock(&self.thread);
                let pending = thread
                    .elicitations()
                    .elicitations()
                    .iter()
                    .find(|e| matches!(e.status, ElicitationStatus::Pending { .. }))
                    .expect("a question card is showing");
                serde_json::to_value(&pending.request).expect("serialises")["requestedSchema"].clone()
            }

            fn answer_question(&self, content: serde_json::Value) {
                let id = self.question_card().expect("a question card is showing");
                let response = serde_json::from_value(json!({ "action": "accept", "content": content }))
                    .expect("an accept response");
                lock(&self.thread).respond_to_elicitation(&id, response);
            }

            fn skip_question(&self) {
                let id = self.question_card().expect("a question card is showing");
                lock(&self.thread).respond_to_elicitation(
                    &id,
                    acp::CreateElicitationResponse::new(acp::ElicitationAction::Decline),
                );
            }

            fn approval_card(&self, item: &str) -> bool {
                lock(&self.thread)
                    .tool_call(&acp::ToolCallId::new(item))
                    .is_some_and(|(_, call)| {
                        matches!(call.status, ToolCallStatus::WaitingForConfirmation { .. })
                    })
            }

            fn allow(&self, item: &str) {
                lock(&self.thread).authorize_tool_call(
                    acp::ToolCallId::new(item),
                    SelectedPermissionOutcome::new(
                        acp::PermissionOptionId::new("allow-once"),
                        acp::PermissionOptionKind::AllowOnce,
                    ),
                );
            }
        }

        fn lock(thread: &AcpThreadHandle) -> std::sync::MutexGuard<'_, AcpThread> {
            thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        }

        async fn settle() {
            for _ in 0..20 {
                tokio::task::yield_now().await;
            }
        }

        fn request(id: i64, method: &str, params: serde_json::Value) -> ServerRequest {
            serde_json::from_value(json!({ "id": id, "method": method, "params": params }))
                .expect("a well-formed engine request")
        }

        fn question(id: i64) -> ServerRequest {
            request(
                id,
                "item/tool/requestUserInput",
                json!({
                    "threadId": THREAD,
                    "turnId": "turn-1",
                    "itemId": "call-1",
                    "questions": [{
                        "id": "which_comment",
                        "header": "Comment",
                        "question": "Which comment should I resolve?",
                        "isOther": true,
                        "isSecret": false,
                        "options": [
                            { "label": "The first one", "description": "Only the oldest" },
                            { "label": "All four", "description": "Every open comment" },
                        ],
                    }],
                    "isBlocking": true,
                }),
            )
        }

        fn command_approval(id: i64, item: &str) -> ServerRequest {
            request(
                id,
                "item/commandExecution/requestApproval",
                json!({
                    "threadId": THREAD,
                    "turnId": "turn-1",
                    "itemId": item,
                    "startedAtMs": 0,
                    "command": "git push",
                }),
            )
        }

        fn is_answer_to(answer: &ServerAnswer, id: i64) -> bool {
            answer.request_id == RequestId::Integer(id)
        }

        #[tokio::test]
        async fn a_question_from_the_engine_becomes_a_question_card_with_its_options_and_other() {
            let mut seam = Seam::open();
            seam.engine_asks(question(1));

            let schema = seam.question_schema();
            let field = &schema["properties"]["which_comment"];
            assert_eq!(field["description"], "Which comment should I resolve?");
            assert_eq!(field["oneOf"][0]["title"], "The first one");
            assert_eq!(field["oneOf"][1]["title"], "All four");
            assert_eq!(
                schema["properties"]["which_comment__other"]["_meta"]["_askUserQuestionCustomAnswer"]
                    ["questionId"],
                "which_comment",
                "the free-form Other the card pairs with the question",
            );
            assert!(seam.engine_heard_nothing().await, "the turn blocks on the user");
        }

        #[tokio::test]
        async fn answering_the_card_returns_the_chosen_option_to_the_engine() {
            let mut seam = Seam::open();
            seam.engine_asks(question(1));
            seam.answer_question(json!({ "which_comment": "All four" }));

            let answer = seam.engine_hears().await;
            assert!(is_answer_to(&answer, 1));
            assert_eq!(
                answer.result.expect("an answer, not an error"),
                json!({ "answers": { "which_comment": { "answers": ["All four"] } } }),
            );
        }

        #[tokio::test]
        async fn answering_other_returns_the_free_text_to_the_engine() {
            let mut seam = Seam::open();
            seam.engine_asks(question(1));
            seam.answer_question(json!({ "which_comment__other": "only the one from Priya" }));

            let answer = seam.engine_hears().await;
            assert_eq!(
                answer.result.expect("an answer, not an error"),
                json!({ "answers": { "which_comment": { "answers": ["only the one from Priya"] } } }),
            );
        }

        #[tokio::test]
        async fn skipping_the_card_returns_an_error_to_the_engine_rather_than_hanging() {
            let mut seam = Seam::open();
            seam.engine_asks(question(1));
            seam.skip_question();

            let answer = seam.engine_hears().await;
            assert!(is_answer_to(&answer, 1));
            assert_eq!(answer.result.unwrap_err(), questions::DISMISSED);
        }

        #[tokio::test]
        async fn stopping_the_turn_under_a_question_returns_an_error_to_the_engine() {
            let mut seam = Seam::open();
            seam.engine_asks(question(1));
            lock(&seam.thread).cancel();

            let answer = seam.engine_hears().await;
            assert_eq!(answer.result.unwrap_err(), questions::DISMISSED);
        }

        #[tokio::test]
        async fn a_question_for_a_thread_that_is_not_open_is_refused_at_once() {
            let mut seam = Seam::open();
            let mut orphan = serde_json::to_value(question(1)).expect("serialises");
            orphan["params"]["threadId"] = json!("thread-gone");
            seam.engine_asks(serde_json::from_value(orphan).expect("still a request"));

            assert!(seam.engine_hears().await.result.is_err());
        }

        #[tokio::test]
        async fn an_mcp_server_elicitation_is_still_refused() {
            // ADR-0013: the model asks; a tool server never talks to the user.
            let mut seam = Seam::open();
            seam.engine_asks(request(
                1,
                "mcpServer/elicitation/request",
                json!({
                    "threadId": THREAD,
                    "turnId": "turn-1",
                    "serverName": "atlas_org",
                    "mode": "url",
                    "message": "Sign in",
                    "url": "https://example.com/login",
                    "elicitationId": "e-1",
                }),
            ));

            let answer = seam.engine_hears().await;
            assert!(answer.result.is_err());
            assert!(seam.question_card().is_none(), "nothing reaches the user");
        }

        #[tokio::test]
        async fn a_question_arriving_while_an_approval_shows_waits_its_turn() {
            let mut seam = Seam::open();
            seam.engine_asks(command_approval(1, "cmd-1"));
            seam.engine_asks(question(2));

            assert!(seam.approval_card("cmd-1"));
            settle().await;
            assert!(seam.question_card().is_none(), "one card at a time");

            seam.allow("cmd-1");
            assert!(is_answer_to(&seam.engine_hears().await, 1));
            settle().await;
            assert!(seam.question_card().is_some(), "the question is next in line");

            seam.answer_question(json!({ "which_comment": "The first one" }));
            let answer = seam.engine_hears().await;
            assert!(is_answer_to(&answer, 2));
            assert!(answer.result.is_ok());
        }

        #[tokio::test]
        async fn an_approval_arriving_while_a_question_shows_waits_its_turn() {
            let mut seam = Seam::open();
            seam.engine_asks(question(1));
            seam.engine_asks(command_approval(2, "cmd-1"));

            assert!(seam.question_card().is_some());
            settle().await;
            assert!(!seam.approval_card("cmd-1"), "one card at a time");

            seam.answer_question(json!({ "which_comment": "All four" }));
            assert!(is_answer_to(&seam.engine_hears().await, 1));
            settle().await;
            assert!(seam.approval_card("cmd-1"), "the approval is next in line");

            seam.allow("cmd-1");
            let answer = seam.engine_hears().await;
            assert!(is_answer_to(&answer, 2));
            assert_eq!(
                answer.result.expect("an approval")["decision"],
                json!("accept"),
            );
        }

        #[tokio::test]
        async fn cards_are_shown_in_the_order_the_engine_asked() {
            let mut seam = Seam::open();
            seam.engine_asks(command_approval(1, "cmd-1"));
            seam.engine_asks(command_approval(2, "cmd-2"));
            seam.engine_asks(question(3));

            assert!(seam.approval_card("cmd-1"));
            settle().await;
            assert!(!seam.approval_card("cmd-2"));
            assert!(seam.question_card().is_none());

            seam.allow("cmd-1");
            assert!(is_answer_to(&seam.engine_hears().await, 1));
            settle().await;
            assert!(seam.approval_card("cmd-2"));
            assert!(seam.question_card().is_none());

            seam.allow("cmd-2");
            assert!(is_answer_to(&seam.engine_hears().await, 2));
            settle().await;
            assert!(seam.question_card().is_some());
        }

        #[tokio::test]
        async fn a_card_still_queued_when_the_turn_stops_is_never_shown() {
            let mut seam = Seam::open();
            seam.engine_asks(command_approval(1, "cmd-1"));
            seam.engine_asks(question(2));

            // Stop resolves the approval that is showing...
            lock(&seam.thread).cancel();
            let first = seam.engine_hears().await;
            assert!(is_answer_to(&first, 1));
            assert_eq!(first.result.expect("an approval")["decision"], json!("cancel"));

            // ...and the question queued behind it is answered, not raised.
            let second = seam.engine_hears().await;
            assert!(is_answer_to(&second, 2));
            assert!(second.result.is_err());
            assert!(seam.question_card().is_none(), "no card for a turn that is over");
        }

        // ── Outward actions ask first (ADR-0014) ───────────────────────────

        /// Describes every call it is asked about as a reply on Sam Lee's
        /// comment, as the app's organisation offer does for
        /// `org_comment_reply`, counts the asks, and keeps the approvals it
        /// is told of.
        struct DescribingHost(Arc<std::sync::atomic::AtomicUsize>, Arc<atlas_agent_servers::OutwardConsent>);

        impl SessionMcpServers for DescribingHost {
            fn offer(&self, _request: &SessionMcpRequest) -> SessionMcpOffer {
                SessionMcpOffer::none()
            }

            fn describe_call(
                &self,
                call: atlas_agent_servers::CallToApprove<'_>,
            ) -> BoxFuture<'static, Option<atlas_agent_servers::CallDescription>> {
                self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let body = call.arguments["body"].as_str().unwrap_or_default().to_string();
                async move {
                    Some(atlas_agent_servers::CallDescription {
                        title: "Reply on Sam Lee's comment".into(),
                        recipient: "Sam Lee, on their comment \"can you check the path?\" in Fix the theme importer".into(),
                        body,
                    })
                }
                .boxed()
            }

            fn approved_call(&self, call: atlas_agent_servers::CallToApprove<'_>) {
                self.1.record(call);
            }
        }

        /// A reply long enough that shortening it anywhere would show.
        fn long_body() -> String {
            "Renamed the importer's theme keys and added the missing test.\n".repeat(200)
        }

        fn reply_args(body: &str) -> serde_json::Value {
            json!({ "comment": "k1", "body": body })
        }

        impl Seam {
            /// An open session offered `atlas_org`, whose host describes calls.
            fn with_org() -> Self {
                let mut seam = Self::open();
                seam.sessions.expect_mcp_servers(THREAD, ["atlas_org".to_string()]);
                seam.host = Some(Arc::new(DescribingHost(seam.described.clone(), seam.consent.clone())));
                seam
            }

            fn describes(&self) -> usize {
                self.described.load(std::sync::atomic::Ordering::SeqCst)
            }

            /// Whether the host holds the user's approval of this reply —
            /// what the organisation tool server checks before posting —
            /// spending it as the server does.
            fn consented(&self, arguments: &serde_json::Value) -> bool {
                self.consent.take(THREAD, "atlas_org", "org_comment_reply", arguments)
            }

            /// The engine announces the call, as `item/started` does before it
            /// asks.
            fn model_calls(&self, item: &str, tool: &str, arguments: serde_json::Value) {
                lock(&self.thread)
                    .handle_session_update(acp::SessionUpdate::ToolCall(
                        acp::ToolCall::new(item.to_string(), format!("atlas_org.{tool}"))
                            .kind(acp::ToolKind::Other)
                            .status(acp::ToolCallStatus::InProgress)
                            .raw_input(arguments),
                    ))
                    .expect("the call is announced");
            }

            fn answer(&self, item: &str, kind: acp::PermissionOptionKind, id: &str) {
                lock(&self.thread).authorize_tool_call(
                    acp::ToolCallId::new(item),
                    SelectedPermissionOutcome::new(acp::PermissionOptionId::new(id), kind),
                );
            }

            /// The row's title, its content as text, and its tool name.
            fn row(&self, item: &str) -> (String, Vec<String>, Option<String>) {
                let thread = lock(&self.thread);
                let (_, call) = thread.tool_call(&acp::ToolCallId::new(item)).expect("the row");
                let content = call
                    .content
                    .iter()
                    .filter_map(|c| match c {
                        atlas_acp_thread::ToolCallContent::ContentBlock(atlas_acp_thread::ContentBlock::Text(t)) => {
                            Some(t.clone())
                        }
                        _ => None,
                    })
                    .collect();
                (call.label.clone(), content, call.tool_name.as_ref().map(std::string::ToString::to_string))
            }
        }

        /// The engine's own ask before a prompted tool: an MCP elicitation
        /// naming the server, marked as a tool-call approval, asking nothing.
        fn tool_approval(id: i64, server: &str, arguments: serde_json::Value) -> ServerRequest {
            request(
                id,
                "mcpServer/elicitation/request",
                json!({
                    "threadId": THREAD,
                    "turnId": "turn-1",
                    "serverName": server,
                    "mode": "form",
                    "_meta": {
                        "atlas_agent_approval_kind": "mcp_tool_call",
                        "tool_params": arguments,
                    },
                    "message": format!("Allow the {server} MCP server to run tool \"org_comment_reply\"?"),
                    "requestedSchema": { "type": "object", "properties": {} },
                }),
            )
        }

        fn action(answer: ServerAnswer) -> String {
            answer.result.expect("an elicitation response")["action"].as_str().unwrap().to_string()
        }

        #[tokio::test]
        async fn an_outward_action_is_the_approval_card_on_its_row_with_the_recipient_and_the_full_body() {
            let mut seam = Seam::with_org();
            let body = long_body();
            seam.model_calls("call-1", "org_comment_reply", reply_args(&body));
            seam.engine_asks(tool_approval(1, "atlas_org", reply_args(&body)));
            settle().await;

            assert!(seam.approval_card("call-1"), "the card is on the call's own row");
            let (title, content, tool_name) = seam.row("call-1");
            assert_eq!(title, "Reply on Sam Lee's comment");
            assert_eq!(
                content,
                [
                    "Sam Lee, on their comment \"can you check the path?\" in Fix the theme importer".to_string(),
                    body.clone(),
                ],
                "the recipient, then the body in full",
            );
            assert_eq!(tool_name.as_deref(), Some("atlas_org.org_comment_reply"), "the row still reads as the call");
            assert_eq!(seam.describes(), 1);
            assert!(seam.engine_heard_nothing().await, "nothing is posted until the user answers");
            assert!(!seam.consented(&reply_args(&body)), "and nothing is approved yet");
        }

        #[tokio::test]
        async fn allowing_once_lets_this_reply_through_and_the_next_one_asks_again() {
            let mut seam = Seam::with_org();
            seam.model_calls("call-1", "org_comment_reply", reply_args("first"));
            seam.engine_asks(tool_approval(1, "atlas_org", reply_args("first")));
            settle().await;
            seam.answer("call-1", acp::PermissionOptionKind::AllowOnce, "allow-once");
            let answer = seam.engine_hears().await;
            assert!(is_answer_to(&answer, 1));
            assert_eq!(action(answer), "accept");
            assert!(seam.consented(&reply_args("first")), "the host holds the approval of this reply");
            assert!(!seam.consented(&reply_args("first")), "once");

            seam.model_calls("call-2", "org_comment_reply", reply_args("second"));
            seam.engine_asks(tool_approval(2, "atlas_org", reply_args("second")));
            settle().await;
            assert!(seam.approval_card("call-2"), "allow once covers one reply");
            assert!(seam.engine_heard_nothing().await);
            assert!(!seam.consented(&reply_args("second")), "not approved until asked");
        }

        #[tokio::test]
        async fn allowing_for_the_session_covers_the_next_reply_with_no_card() {
            let mut seam = Seam::with_org();
            seam.model_calls("call-1", "org_comment_reply", reply_args("first"));
            seam.engine_asks(tool_approval(1, "atlas_org", reply_args("first")));
            settle().await;
            seam.answer("call-1", acp::PermissionOptionKind::AllowAlways, "allow-always");
            assert_eq!(action(seam.engine_hears().await), "accept");

            seam.model_calls("call-2", "org_comment_reply", reply_args("second"));
            seam.engine_asks(tool_approval(2, "atlas_org", reply_args("second")));
            let answer = seam.engine_hears().await;
            assert!(is_answer_to(&answer, 2));
            assert_eq!(action(answer), "accept", "answered from the session's allowance");
            assert!(!seam.approval_card("call-2"), "no card the second time");
            assert_eq!(seam.describes(), 1, "nothing to describe when nobody is asked");
            assert!(seam.consented(&reply_args("first")));
            assert!(seam.consented(&reply_args("second")), "the allowance approves each call it covers");
        }

        #[tokio::test]
        async fn declining_is_a_decline_the_engine_turns_into_an_error_without_calling_the_tool() {
            // `action: decline` is what the engine reads as "user rejected MCP
            // tool call": it skips the call and hands the model that error
            // (`mcp_tool_call.rs`, `parse_mcp_tool_approval_elicitation_response`
            // → `notify_mcp_tool_call_skip`). The end-to-end half — the tool
            // really is never called — is `engine_turn.rs`.
            let mut seam = Seam::with_org();
            seam.model_calls("call-1", "org_comment_reply", reply_args("no"));
            seam.engine_asks(tool_approval(1, "atlas_org", reply_args("no")));
            settle().await;
            seam.answer("call-1", acp::PermissionOptionKind::RejectOnce, "reject");
            assert_eq!(action(seam.engine_hears().await), "decline");
            assert!(!seam.consented(&reply_args("no")), "a declined reply is never approved");

            // A decline is not remembered: the next reply asks again.
            seam.model_calls("call-2", "org_comment_reply", reply_args("again"));
            seam.engine_asks(tool_approval(2, "atlas_org", reply_args("again")));
            settle().await;
            assert!(seam.approval_card("call-2"));
        }

        #[tokio::test]
        async fn stopping_the_turn_under_an_outward_card_cancels_it() {
            let mut seam = Seam::with_org();
            seam.model_calls("call-1", "org_comment_reply", reply_args("x"));
            seam.engine_asks(tool_approval(1, "atlas_org", reply_args("x")));
            settle().await;
            lock(&seam.thread).cancel();
            assert_eq!(action(seam.engine_hears().await), "cancel");
            assert!(!seam.consented(&reply_args("x")));
        }

        #[tokio::test]
        async fn an_outward_card_waits_behind_the_card_already_showing() {
            let mut seam = Seam::with_org();
            seam.engine_asks(command_approval(1, "cmd-1"));
            seam.model_calls("call-1", "org_comment_reply", reply_args("x"));
            seam.engine_asks(tool_approval(2, "atlas_org", reply_args("x")));
            settle().await;
            assert!(seam.approval_card("cmd-1"));
            assert!(!seam.approval_card("call-1"), "one card at a time");

            seam.allow("cmd-1");
            assert!(is_answer_to(&seam.engine_hears().await, 1));
            settle().await;
            assert!(seam.approval_card("call-1"), "the outward card is next in line");
        }

        #[tokio::test]
        async fn with_nothing_to_describe_it_the_card_still_asks_on_the_rows_own_title() {
            let seam = Seam::open();
            seam.sessions.expect_mcp_servers(THREAD, ["atlas_org".to_string()]);
            seam.model_calls("call-1", "org_comment_reply", reply_args("x"));
            seam.engine_asks(tool_approval(1, "atlas_org", reply_args("x")));
            settle().await;
            assert!(seam.approval_card("call-1"));
            assert_eq!(seam.row("call-1").0, "atlas_org.org_comment_reply");
        }

        #[tokio::test]
        async fn the_same_form_from_a_server_atlas_did_not_offer_is_refused() {
            // ADR-0013: a tool server never talks to the user, even wearing
            // the engine's marker. Only a server the host offered — which
            // never elicits — can be the subject of the engine's own ask.
            let mut seam = Seam::with_org();
            seam.model_calls("call-1", "org_comment_reply", reply_args("x"));
            seam.engine_asks(tool_approval(1, "someone_elses", reply_args("x")));
            let answer = seam.engine_hears().await;
            assert!(answer.result.is_err());
            assert!(!seam.approval_card("call-1"), "nothing reaches the user");
        }

        #[tokio::test]
        async fn a_second_session_is_not_held_up_by_the_first_ones_card() {
            let seam = Seam::open();
            let other = acp::SessionId::new("thread-2");
            let other_thread = crate::engine::test_support::detached_thread(other.clone());
            seam.sessions.insert(other, &other_thread, "/tmp".to_string());

            seam.engine_asks(command_approval(1, "cmd-1"));
            let mut elsewhere = serde_json::to_value(question(2)).expect("serialises");
            elsewhere["params"]["threadId"] = json!("thread-2");
            seam.engine_asks(serde_json::from_value(elsewhere).expect("still a request"));

            assert!(seam.approval_card("cmd-1"));
            assert!(
                lock(&other_thread)
                    .elicitations()
                    .elicitations()
                    .iter()
                    .any(|e| matches!(e.status, ElicitationStatus::Pending { .. })),
                "the line is per session",
            );
        }
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
    /// For the in-flight-turn check in `set_mode` (#61).
    turns: Arc<TurnWaiters>,
}

/// What a rewind needs, and no more: the request channel to reach the engine
/// and the session table to reach the thread. Same reason the other session
/// controls hold parts rather than the connection — see `ConnectionHandle`.
#[derive(Clone)]
struct RewindHandle {
    requests: InProcessAppServerRequestHandle,
    request_ids: Arc<RequestIds>,
    sessions: Arc<EngineSessions>,
}

struct EngineSessionRewind {
    connection: RewindHandle,
    session_id: acp::SessionId,
}

impl AgentSessionRewind for EngineSessionRewind {
    fn run(&self) -> BoxFuture<'static, Result<Option<String>>> {
        let handle = self.connection.clone();
        let session_id = self.session_id.clone();
        async move { handle.rewind_last_turn(&session_id).await }.boxed()
    }
}

impl RewindHandle {
    /// Drop the last turn and hand back the prompt that started it.
    ///
    /// This is the rewind half of "retry": `thread/rollback` drops the turn
    /// from the engine's durable history, the thread's entries are trimmed to
    /// match so the transcript shows what the model now remembers, and the
    /// caller re-sends the returned text through the ordinary send path.
    ///
    /// Deliberately NOT a re-implementation of `prompt`'s turn machinery.
    /// Rewinding and re-sending are separable failures — a rewind that lands
    /// and a send that does not must leave the user holding their prompt, not
    /// a silently shortened thread — and splitting them here is what lets the
    /// host report the two apart.
    ///
    /// Unlike `/undo` this is not itself a turn, so there is no `/undo` user
    /// entry to skip: the turn being dropped starts at the LAST user entry,
    /// not the second-to-last.
    ///
    /// `None` means the engine declined — almost always an empty thread. It is
    /// NOT a promise that nothing moved: the request layer folds a refusal and
    /// a dead channel into one error, and a channel that dies after the
    /// rollback ran lands here too. Everything past a rollback known to have
    /// succeeded is an `Err`, so the only ambiguity left is this one.
    ///
    /// Only the FLATTENED text survives. `ContentBlock::to_text` returns a
    /// resource link as a bare URI and joins mixed blocks without the newlines
    /// the original input carried (`thread.rs:99` vs `sink.rs:351`), so a turn
    /// whose prompt mixed prose and `@`-mentions does not round-trip verbatim.
    /// Attachments are not reconstructed at all — the thread stores what was
    /// sent, not the composer state that produced it.
    async fn rewind_last_turn(&self, session_id: &acp::SessionId) -> Result<Option<String>> {
        // Ask before trimming. The engine refusing (nothing to drop) has to
        // leave the transcript exactly as it was, so nothing local moves until
        // the durable history has already moved.
        let rolled = self
            .requests
            .request_typed::<v2::ThreadRollbackResponse>(ClientRequest::ThreadRollback {
                request_id: self.request_ids.next(),
                params: v2::ThreadRollbackParams {
                    thread_id: session_id.to_string(),
                    num_turns: 1,
                },
            })
            .await;
        if let Err(e) = rolled {
            // A refusal and a broken channel are the same value here — the
            // request layer does not distinguish "the engine said no" from "the
            // engine never answered", and a transport error can also arrive
            // AFTER the rollback ran. So this is honestly `None` only in the
            // first case, and the caller is told as much rather than being
            // promised the history is untouched. Erring instead would put a
            // scary message in front of the far commoner empty-thread case.
            tracing::debug!("thread/rollback declined or failed: {e}");
            return Ok(None);
        }

        // Past this point the durable history has ALREADY shrunk. Reporting
        // `None` — "nothing to rewind" — from here would tell the user nothing
        // happened while the engine and the transcript silently disagree about
        // the conversation. An error is the only honest answer.
        let Some(thread) = self.sessions.thread(session_id) else {
            return Err(anyhow!(
                "rewound the engine's history but the session's thread is gone; \
                 reopen the conversation to resynchronise"
            ));
        };
        let mut locked = thread
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let last_user = locked
            .entries()
            .iter()
            .enumerate()
            .rev()
            .find_map(|(ix, entry)| match entry {
                atlas_acp_thread::AgentThreadEntry::UserMessage(msg) => {
                    Some((ix, msg.content.to_text().to_string()))
                }
                _ => None,
            });
        let Some((from, text)) = last_user else {
            return Err(anyhow!(
                "rewound the engine's history but the transcript holds no prompt to \
                 replay; reopen the conversation to resynchronise"
            ));
        };
        // `EntriesRemoved` is what the delta projector turns into
        // `HistoryRewound`, which is what trims the store's mirror and
        // resolves any permission request stranded by the removal.
        locked.remove_entries_from(from);
        Ok(Some(text))
    }
}

impl EngineConnection {
    fn clone_rewind_handle(&self) -> RewindHandle {
        RewindHandle {
            requests: self.requests.clone(),
            request_ids: self.request_ids.clone(),
            sessions: self.sessions.clone(),
        }
    }

    fn clone_handle(&self) -> ConnectionHandle {
        ConnectionHandle {
            requests: self.requests.clone(),
            request_ids: self.request_ids.clone(),
            session_modes: self.session_modes.clone(),
            turns: self.turns.clone(),
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
            .unwrap_or_else(std::sync::PoisonError::into_inner)
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
            // Refused, not silently narrowed to the picker: the engine's
            // `update_settings` writes only the session configuration, and a
            // running turn keeps the frozen context it started with — so a
            // mid-turn switch would change the label while every remaining
            // tool call executes under the old policy. Showing "Plan —
            // read-only" over a turn still running with full access is the
            // one shape worse than no control at all (#61). Stop the turn,
            // then switch; the next turn picks the new mode up at start.
            if connection.turns.is_busy(&session_id.to_string()) {
                return Err(anyhow!(
                    "The permission mode can't change while a turn is running — \
                     it would only relabel the picker; the running turn keeps \
                     the permissions it started with. Stop the turn first."
                ));
            }
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
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(session_id, mode);
            Ok(())
        }
        .boxed()
    }
}

/// The composer's model picker, backed by the connection's live catalogue.
///
/// The list is the gateway's, fetched and cached by the seam (ADR-0007) and
/// captured on the connection at connect. The engine would fetch one from
/// `{base}/models` itself, but the gateway's reply is stock-OpenAI shaped
/// where the engine expects its own rich record, so that fetch cannot parse.
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
    /// The connection's catalogue, shared rather than copied: a refresh that
    /// swaps the labels in place is visible to the next selector the host
    /// builds.
    catalogue: Arc<RwLock<LiveCatalogue>>,
}

impl EngineModelSelector {
    fn catalogue(&self) -> Vec<AgentModelInfo> {
        self.catalogue
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .picker
            .clone()
    }

    fn default_model(&self) -> String {
        self.catalogue
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .default_model
            .clone()
    }
}

impl AgentModelSelector for EngineModelSelector {
    fn list_models(&self) -> BoxFuture<'static, Result<AgentModelList>> {
        let models = self.catalogue();
        async move { Ok(AgentModelList::Flat(models)) }.boxed()
    }

    fn select_model(&self, model_id: AgentModelId) -> BoxFuture<'static, Result<()>> {
        // Refused rather than sent. The gateway answers an unknown slug with
        // `403 model_not_allowed`, which arrives as a failed turn well after
        // the user made the choice; saying no here keeps the cause next to the
        // click.
        let known = self.catalogue().into_iter().any(|m| m.id == model_id);
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
        // The per-session choice, or the catalogue's first entitled row
        // before any choice.
        let selected = self
            .sessions
            .selected_model(&self.session_id)
            .map(|m| AgentModelId::new(m.as_str()))
            .unwrap_or_else(|| AgentModelId::new(self.default_model().as_str()));
        let found = self.catalogue().into_iter().find(|m| m.id == selected);
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
        // forget like the previous native path's — on the engine's runtime, because
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

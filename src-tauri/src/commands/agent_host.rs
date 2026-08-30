//! The seam between the ported ACP stack and the `agents_*` command surface.
//!
//! [`AgentHost`] is what `commands/agents.rs` talks to. It owns the ported
//! [`AgentManager`], the [`DeltaProjector`] that turns thread events into the
//! frozen wire, and the two pieces of bookkeeping the ported stack deliberately
//! does not do:
//!
//! 1. **Identity.** The frontend has always addressed an agent by a per-spawn
//!    `AgentId` (a uuid) and a session by `SessionKey { agent_id, session_id }`.
//!    The ported manager keys connections by [`Agent`] (`Native` or a stable
//!    string id) and sessions by `acp::SessionId`. This module holds the map
//!    between the two, so the whole TS surface keeps working unchanged.
//! 2. **History.** Every conversation's metadata row in the app-owned
//!    thread-metadata store is kept current from the same thread events the
//!    wire projection reads (ADR-0001). The row is metadata only; the
//!    transcript stays with the agent.
//! 3. **Session metadata.** `snapshot_meta` has to answer
//!    `{plugin_id, cwd, current_model}` cheaply on the send path — checkpoint
//!    touchpoint #3 depends on it — and turn identity is stamped here, at send
//!    time, not by the thread (touchpoint #6).
//!
//! # No default agents
//!
//! There is no builtin table, no auto-acquire, and no spawn ladder (research
//! ADR-0002). The native agent is always present because it is
//! in-process; every other agent exists only because the installed map says so.
//! [`AgentHost::agent_for`] is the whole of that policy, and it is four lines.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{
    AcpThread, AcpThreadHandle, AgentConnection, AgentId as ThreadAgentId, AgentModelId,
    ElicitationEntryId, ElicitationStoreEvent, SelectedPermissionOutcome, TerminalAuthCommand,
};
use atlas_agent_delta::{project, DeltaProjector, DeltaSink, ThreadObserver};
use atlas_agent_manager::{Agent, AgentManager, ResumeMode};
use atlas_agent_servers::{AcpConnectionDefaults, AgentServer, ConnectOptions};
use atlas_agent_store::{AgentRegistryStore, AgentServerStore, ExternalAgentSource};
use atlas_agent_transcript::TranscriptKind;
use atlas_agent_wire::{
    classify_message, AgentId, ErrorClass, Message, PlanEntry, SessionStatus, Usage,
};
use atlas_native_agent::CERSEI_AGENT_ID;
use atlas_thread_metadata::{
    affects_thread_metadata, collect_all_sessions, importable_threads, PathList, ThreadFilter,
    ThreadId, ThreadMetadata, ThreadMetadataStore, ThreadRecorder, ThreadSnapshot,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ── The IPC wire shapes ─────────────────────────────────────────────────────
//
// These moved out of `atlas-agents` with the port. Field names and serde
// attributes are unchanged: the frontend's `src/types/agents.ts` describes
// exactly these, and Stage 3 does not touch the frontend.

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct SessionKey {
    pub agent_id: AgentId,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentInfo {
    pub agent_id: AgentId,
    pub spec_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionModeInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionInit {
    pub key: SessionKey,
    pub current_mode: Option<String>,
    pub available_modes: Vec<SessionModeInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginSpec {
    pub plugin_id: String,
    pub display_name: String,
    /// Informational only — spawning resolves the command through the store.
    pub command: String,
    pub transcript: TranscriptKind,
    pub supports_modes: bool,
    pub supports_models: bool,
    /// Everything except the native agent.
    pub external: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionSnapshot {
    pub agent_id: AgentId,
    pub session_id: String,
    pub cwd: String,
    pub plugin_id: String,
    pub status: SessionStatus,
    pub current_mode: Option<String>,
    pub current_model: Option<String>,
    pub available_modes: Vec<SessionModeInfo>,
    pub available_models: Vec<SessionModeInfo>,
    pub available_commands: Vec<serde_json::Value>,
    pub config_options: Vec<serde_json::Value>,
    pub prompt_image_supported: bool,
    pub plan: Vec<PlanEntry>,
    pub messages: Vec<Message>,
    pub usage: Usage,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Frontend-friendly permission outcome. Struct variant, not tuple: serde's
/// internal tagging only supports struct or unit variants, and a tuple variant
/// would silently lose the inner value across the Tauri boundary.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum PermissionDecision {
    Selected { option_id: String },
    Cancelled,
}

// ── Errors ──────────────────────────────────────────────────────────────────

/// A host failure that carries its classification.
///
/// Everything the commands reject with funnels through here so `CmdError.kind`
/// keeps meaning what it meant: `auth` routes the frontend into sign-in, which
/// is the only signal it gets when an agent rejects `session/new` before any
/// turn exists.
#[derive(Debug)]
pub struct HostError {
    pub message: String,
    pub class: ErrorClass,
}

impl HostError {
    pub fn new(message: impl Into<String>, class: ErrorClass) -> Self {
        Self {
            message: message.into(),
            class,
        }
    }

    /// Classify a message we did not raise ourselves — an agent's rejection, a
    /// transport failure, an install error.
    pub fn classified(message: impl Into<String>) -> Self {
        let message = message.into();
        let class = classify_message(&message);
        Self { message, class }
    }

    pub fn unknown_session() -> Self {
        Self::new("unknown session id", ErrorClass::ProcessDead)
    }

    pub fn unknown_agent() -> Self {
        Self::new("unknown agent id", ErrorClass::ProcessDead)
    }
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<anyhow::Error> for HostError {
    fn from(e: anyhow::Error) -> Self {
        // `{:#}` so the whole context chain survives — an agent's own rejection
        // is usually the innermost link, and it is the one worth classifying.
        Self::classified(format!("{e:#}"))
    }
}

pub type Result<T> = std::result::Result<T, HostError>;

// ── Bookkeeping ─────────────────────────────────────────────────────────────

#[derive(Clone)]
struct AgentRecord {
    agent: Agent,
    plugin_id: String,
}

struct SessionRecord {
    agent: Agent,
    plugin_id: String,
    cwd: String,
    current_model: Option<String>,
    /// Stamped at send time; the deltas of a turn carry it so the frontend can
    /// drop a terminal that belongs to a superseded turn (touchpoint #6).
    turn_seq: u64,
    created_at: DateTime<Utc>,
}

/// Build an elicitation response, or `None` for the answers that cancel.
///
/// Shared by both elicitation paths — a session's dialog and a connection's
/// sign-in dialog — so the same answer means the same thing in both.
fn elicitation_response(
    action: &str,
    content: Option<serde_json::Value>,
) -> Result<Option<acp::CreateElicitationResponse>> {
    // `{"action": "accept"}`, NOT `{"outcome": "accepted"}`. `ElicitationAction`
    // is an internally tagged enum on `action` with snake_case variants, and its
    // catch-all `Other` arm is `#[serde(untagged)]` — so a wrong tag does not
    // fall through to it, it fails the whole union. This built an
    // `outcome`-shaped object that could never deserialize, so EVERY elicitation
    // answer died here with `Fatal`, the webview logged a warning and dismissed
    // the card, and the agent went on awaiting a reply that was never sent.
    let value = match action {
        "accept" => serde_json::json!({
            "action": "accept",
            "content": content.unwrap_or(serde_json::json!({})),
        }),
        "decline" => serde_json::json!({ "action": "decline" }),
        // Anything else cancels. That is the caller's intent, not a failure.
        _ => return Ok(None),
    };
    // A malformed `accept` is a real error and says so. Cancelling silently
    // would answer the agent something the user did not choose, and leave the
    // caller believing their answer went through.
    serde_json::from_value(value)
        .map(Some)
        .map_err(|e| HostError::new(e.to_string(), ErrorClass::Fatal))
}

pub struct AgentHost {
    manager: Arc<AgentManager>,
    projector: Arc<DeltaProjector>,
    store: Arc<AgentServerStore>,
    registry: Arc<AgentRegistryStore>,
    agents: Mutex<HashMap<AgentId, AgentRecord>>,
    /// One uuid per plugin id, for the life of the process. The frontend spawns
    /// per tab and expects a stable handle back; the ported manager keeps one
    /// connection per agent, so minting a fresh uuid per spawn would hand out
    /// several names for one thing.
    by_plugin: Mutex<HashMap<String, AgentId>>,
    sessions: Mutex<HashMap<String, SessionRecord>>,
    /// Registry agents found on the user's `PATH`, from the last probe.
    ///
    /// Cached because the catalog is a sync, instant read and a probe walks
    /// every `PATH` directory. Detection is an install *affordance* only —
    /// finding a binary never makes an agent runnable and never auto-spawns
    /// anything (ADR-0002). Refreshed by `agents_catalog_refresh`.
    detected: Mutex<Vec<atlas_agent_store::DetectedAgent>>,
    /// Atlas's session history.
    ///
    /// `None` only when the store could not be opened — a corrupt or
    /// newer-schema database. The failure is logged, history is unavailable,
    /// and the app still runs: losing the sidebar must not lose the agent.
    /// Nothing surfaces this in the UI yet; the sidebar re-point (#21) is where
    /// an empty history gets a reason attached to it.
    history: Option<ThreadRecorder>,
    /// Request-scoped elicitations, announced by every connection.
    ///
    /// These belong to no session — they are the ones raised during sign-in,
    /// before any session exists — so they cannot ride the session delta
    /// stream. The receiver is taken once, by the forwarder that turns them
    /// into `atlas:agent-elicitation`.
    request_elicitations: RequestElicitations,
}

/// The plumbing for elicitations that belong to a connection, not a session.
struct RequestElicitations {
    /// Taken once, by [`AgentHost::take_request_elicitations`].
    stream: Mutex<Option<mpsc::UnboundedReceiver<(ThreadAgentId, ElicitationStoreEvent)>>>,
    /// Which agent + entry a wire request id refers to, so an answer can find
    /// its way back. The session-scoped counterpart lives on the projector.
    answered_by: Mutex<HashMap<Uuid, (ThreadAgentId, ElicitationEntryId)>>,
}

/// Builds the native agent.
///
/// There is no longer a switch here. It existed so the Cersei path could keep
/// shipping while the ported engine was proved (#45); that path is deleted
/// (#54), so this constructs the one implementation there is.
///
/// `ATLAS_AGENT_ENGINE=dev` still points it at a provider read from the
/// environment — Phase 2's tracer bullet, kept for working on the engine
/// without an Atlas account. It stays an explicit opt-in rather than a
/// fallback: a build that silently sent turns to whatever
/// `ATLAS_ENGINE_BASE_URL` happened to hold would be a traffic redirect nobody
/// asked for.
fn select_native_agent(config_dir: &Path) -> Arc<dyn atlas_agent_servers::AgentServer> {
    use atlas_native_agent::engine::{EngineAgentServer, EngineSettings};

    let cwd = std::env::current_dir().unwrap_or_else(|_| config_dir.to_path_buf());
    let settings = if std::env::var("ATLAS_AGENT_ENGINE").as_deref() == Ok("dev") {
        tracing::warn!("native agent: DEV provider (ATLAS_AGENT_ENGINE=dev)");
        EngineSettings::from_env(config_dir, cwd)
    } else {
        EngineSettings::gateway(config_dir, cwd)
    };
    tracing::info!(
        provider = %settings.provider.base_url,
        model = %settings.model,
        home = %settings.home.path().display(),
        "native agent: Atlas Agent",
    );
    Arc::new(EngineAgentServer::new(settings))
}

impl AgentHost {
    pub fn new(
        sink: Arc<dyn DeltaSink>,
        config_dir: PathBuf,
        store: Arc<AgentServerStore>,
        registry: Arc<AgentRegistryStore>,
    ) -> Arc<Self> {
        let native = select_native_agent(&config_dir);
        Self::with_native(sink, config_dir, store, registry, native)
    }

    /// [`AgentHost::new`] with the native agent supplied by the caller — the
    /// seam tests use to stand in a scripted agent.
    pub(crate) fn with_native(
        sink: Arc<dyn DeltaSink>,
        config_dir: PathBuf,
        store: Arc<AgentServerStore>,
        registry: Arc<AgentRegistryStore>,
        native: Arc<dyn AgentServer>,
    ) -> Arc<Self> {
        let projector = DeltaProjector::new(sink);
        let history = match ThreadMetadataStore::open(atlas_thread_metadata::db_path(&config_dir)) {
            Ok(store) => Some(ThreadRecorder::new(store)),
            Err(e) => {
                tracing::error!(error = %e, "session history unavailable");
                None
            }
        };
        let (elicitation_tx, elicitation_rx) = mpsc::unbounded_channel();
        let options = ConnectOptions {
            root_dir: None,
            defaults: AcpConnectionDefaults::default(),
            thread_events: projector.thread_events(),
            // Tag each connection's events with its agent id on the way out:
            // the store itself only knows entry ids, and the forwarder has to
            // know which connection to read the elicitation back from.
            request_elicitation_events: {
                let tx = elicitation_tx;
                Arc::new(move |agent_id: &ThreadAgentId| {
                    let (agent_tx, mut agent_rx) = mpsc::unbounded_channel();
                    let tx = tx.clone();
                    let agent_id = agent_id.clone();
                    tokio::spawn(async move {
                        while let Some(event) = agent_rx.recv().await {
                            if tx.send((agent_id.clone(), event)).is_err() {
                                return;
                            }
                        }
                    });
                    agent_tx
                })
            },
            client_name: "atlas",
            client_version: env!("CARGO_PKG_VERSION").to_string(),
        };
        let manager = AgentManager::new(store.clone(), native, options);
        let host = Arc::new(Self {
            manager,
            projector,
            store,
            registry,
            agents: Mutex::new(HashMap::new()),
            by_plugin: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            detected: Mutex::new(Vec::new()),
            history,
            request_elicitations: RequestElicitations {
                stream: Mutex::new(Some(elicitation_rx)),
                answered_by: Mutex::new(HashMap::new()),
            },
        });
        // Weak, and installed after the host exists: the observer needs the
        // host to name the agent a session belongs to, and a strong reference
        // here would be a cycle that never drops.
        if host.history.is_some() {
            host.projector
                .observe_threads(Arc::new(HistoryObserver(Arc::downgrade(&host))));
        }
        host
    }

    /// Atlas's session history, or `None` when the store could not be opened.
    pub fn history(&self) -> Option<&ThreadRecorder> {
        self.history.as_ref()
    }

    pub fn manager(&self) -> &Arc<AgentManager> {
        &self.manager
    }

    pub fn store(&self) -> &Arc<AgentServerStore> {
        &self.store
    }

    pub fn registry(&self) -> &Arc<AgentRegistryStore> {
        &self.registry
    }

    // `native_sessions` and `native_delete_session` are gone with the Cersei
    // runtime that owned those files (#54). They read a second, engine-private
    // session store; the ported engine keeps its own under a different shape,
    // and pointing the timeline at it would recreate exactly the scrape-reader
    // pattern ADR-0001 removed.
    //
    // The memory timeline's coverage of native sessions narrows as a result —
    // D8's accepted narrowing, with where it gets re-sourced from left as spec
    // open question 8. Rows the app owns are unaffected: they come from the
    // thread-metadata store, which is the only source the sidebar has ever had.
    //
    // 0.3.1 taught the deleted `native_sessions` to strip Atlas's injected
    // memory blocks out of sidebar previews. That fix does not transfer: it
    // cleaned previews read from the engine-private store this path no longer
    // touches. `strip_injected_context` itself survives and still guards the
    // app-owned rows.

    /// Re-probe `PATH` for registry agents the user already has.
    pub fn probe_detected(&self) {
        let agents = self.registry().agents();
        let found = atlas_agent_store::detection::detect_on_current_path(&agents);
        *lock(&self.detected) = found;
    }

    pub fn detected(&self) -> Vec<atlas_agent_store::DetectedAgent> {
        lock(&self.detected).clone()
    }

    /// Stand in a detection result instead of probing the machine running the
    /// test — what is on the developer's `PATH` is not the subject.
    #[cfg(test)]
    pub(crate) fn set_detected_for_tests(&self, found: Vec<atlas_agent_store::DetectedAgent>) {
        *lock(&self.detected) = found;
    }

    /// Tear every agent process down before the app exits.
    ///
    /// `process::exit` skips `Drop`, so without this the ACP children outlive
    /// Atlas. Dropping a connection closes the child's stdin, which is how the
    /// transport asks it to leave; the caller gives that a bounded moment.
    pub fn shutdown(&self) {
        for (agent, _) in self.manager.connections() {
            self.manager.drop_connection(&agent);
        }
        lock(&self.sessions).clear();
    }

    // ---- identity --------------------------------------------------------

    /// Which agent a plugin id names, if Atlas can run it at all.
    ///
    /// This is the whole of the no-default-agents rule: the native agent is
    /// always available because it is in-process, and any other id must appear
    /// in the installed map. Nothing is downloaded, discovered or guessed here.
    pub fn agent_for(&self, plugin_id: &str) -> Result<Agent> {
        if plugin_id == CERSEI_AGENT_ID {
            return Ok(Agent::Native);
        }
        let id = atlas_acp_thread::AgentId::new(plugin_id);
        if self.store.entry(&id).is_none() {
            return Err(HostError::new(
                format!("{plugin_id} is not installed. Install it from the Agent Marketplace."),
                ErrorClass::Fatal,
            ));
        }
        Ok(Agent::Custom { id })
    }

    fn plugin_id_of(agent: &Agent) -> String {
        match agent {
            Agent::Native => CERSEI_AGENT_ID.to_string(),
            Agent::Custom { id } => id.as_str().to_string(),
        }
    }

    /// The uuid the frontend uses for this plugin, minting it on first sight.
    fn handle_for(&self, agent: &Agent) -> AgentId {
        let plugin_id = Self::plugin_id_of(agent);
        let mut by_plugin = lock(&self.by_plugin);
        if let Some(existing) = by_plugin.get(&plugin_id) {
            return *existing;
        }
        let handle = AgentId::new();
        by_plugin.insert(plugin_id.clone(), handle);
        lock(&self.agents).insert(
            handle,
            AgentRecord {
                agent: agent.clone(),
                plugin_id,
            },
        );
        handle
    }

    fn record_for(&self, agent_id: AgentId) -> Result<AgentRecord> {
        lock(&self.agents)
            .get(&agent_id)
            .cloned()
            .ok_or_else(HostError::unknown_agent)
    }

    /// The plugin this agent handle was spawned from. On the delta hot path
    /// (analytics), so it stays a single map lookup.
    pub fn plugin_id_for_agent(&self, agent_id: AgentId) -> Option<String> {
        lock(&self.agents)
            .get(&agent_id)
            .map(|record| record.plugin_id.clone())
    }

    pub fn display_name(&self, plugin_id: &str) -> String {
        if plugin_id == CERSEI_AGENT_ID {
            // The name changes here; the id above does not. `CERSEI_AGENT_ID`
            // is a storage key every recorded thread resolves through (D7), so
            // the two deliberately disagree — this is the only place the user
            // ever sees either of them.
            return "Atlas Agent".to_string();
        }
        self.store
            .agent_display_name(&atlas_acp_thread::AgentId::new(plugin_id))
            .unwrap_or_else(|| plugin_id.to_string())
    }

    // ---- the agent catalog ----------------------------------------------

    /// Every agent Atlas can run: the native one, plus the installed map.
    pub fn list_plugins(&self) -> Vec<PluginSpec> {
        let mut out = vec![self.plugin_spec(&Agent::Native)];
        out.extend(
            self.store
                .external_agents()
                .into_iter()
                .map(|id| self.plugin_spec(&Agent::Custom { id })),
        );
        out
    }

    fn plugin_spec(&self, agent: &Agent) -> PluginSpec {
        let plugin_id = Self::plugin_id_of(agent);
        let connection = self.connected(agent);
        // Modes and models are per-SESSION in ACP, so there is no session-free
        // answer for an external agent — the authoritative one is the
        // snapshot's `available_modes` / `available_models`, which come back
        // empty for an agent that offers neither. These flags are the pre-session
        // hint only: the native agent always has both, and a connected external
        // agent is worth asking. Nothing in the UI gates on them today.
        let supports_modes = agent.is_native() || connection.is_some();
        let supports_models = agent.is_native() || connection.is_some();
        let command = match agent {
            Agent::Native => String::new(),
            Agent::Custom { id } => match self.store.agent_source(id) {
                Some(ExternalAgentSource::Registry) => "registry".to_string(),
                _ => String::new(),
            },
        };
        PluginSpec {
            transcript: transcript_kind_for(&plugin_id),
            display_name: self.display_name(&plugin_id),
            command,
            supports_modes,
            supports_models,
            external: !agent.is_native(),
            plugin_id,
        }
    }

    fn connected(&self, agent: &Agent) -> Option<Arc<dyn AgentConnection>> {
        self.manager.connected(agent)
    }

    /// Every agent with a live connection, in the frontend's shape.
    pub fn list_agents(&self) -> Vec<AgentInfo> {
        self.manager
            .connections()
            .into_iter()
            .map(|(agent, _)| {
                let plugin_id = Self::plugin_id_of(&agent);
                AgentInfo {
                    agent_id: self.handle_for(&agent),
                    display_name: self.display_name(&plugin_id),
                    spec_id: plugin_id,
                }
            })
            .collect()
    }

    /// Capability answers for the catalog, read from the LIVE connection.
    ///
    /// ACP capabilities only exist after `initialize`, so every one of these is
    /// false until the agent has been connected at least once. The catalog
    /// documents that; the frontend falls back to other fields in that window.
    pub fn capabilities(&self, plugin_id: &str) -> PluginCapabilities {
        let Ok(agent) = self.agent_for(plugin_id) else {
            return PluginCapabilities::default();
        };
        let Some(connection) = self.connected(&agent) else {
            return PluginCapabilities::default();
        };
        PluginCapabilities {
            auth_kinds: connection
                .auth_methods()
                .iter()
                .map(|method| auth_kind_token(method).to_string())
                .collect(),
            supports_logout: connection.supports_logout(),
            supports_load_session: connection.supports_load_session(),
            supports_session_list: connection.session_list().is_some(),
            // ACP has no fork, but the native engine does (`thread/fork`) —
            // the capability is "is this the native connection", exactly the
            // downcast `fork_session` performs.
            supports_fork: connection
                .clone()
                .downcast::<atlas_native_agent::EngineConnection>()
                .is_some(),
        }
    }

    // ---- lifecycle -------------------------------------------------------

    /// Connect to an agent, or join the connection already in flight.
    pub async fn spawn(&self, plugin_id: &str) -> Result<AgentInfo> {
        let agent = self.agent_for(plugin_id)?;
        self.manager
            .connection(agent.clone())
            .await
            .map_err(HostError::from)?;
        Ok(AgentInfo {
            agent_id: self.handle_for(&agent),
            display_name: self.display_name(plugin_id),
            spec_id: plugin_id.to_string(),
        })
    }

    /// Drop an agent's connection. The next spawn starts a fresh one.
    pub fn kill(&self, agent_id: AgentId) -> Result<()> {
        let record = self.record_for(agent_id)?;
        self.forget_request_elicitations(&ThreadAgentId::new(record.plugin_id.as_str()));
        self.manager.drop_connection(&record.agent);
        lock(&self.sessions).retain(|_, session| session.agent != record.agent);
        Ok(())
    }

    pub async fn new_session(
        &self,
        agent_id: AgentId,
        cwd: PathBuf,
        additional_directories: Vec<PathBuf>,
    ) -> Result<SessionInit> {
        let record = self.record_for(agent_id)?;
        let mut work_dirs = vec![cwd.clone()];
        work_dirs.extend(additional_directories);
        let thread = self
            .manager
            .new_session(record.agent.clone(), work_dirs)
            .await
            .map_err(HostError::from)?;
        Ok(self.bind(agent_id, &record, cwd, thread))
    }

    /// Reopen a stored session, letting the agent replay it.
    ///
    /// Load only, with no resume fallback: this is the pre-history path the
    /// chat panel still calls to rebind a session it already knows about
    /// (`agents_load_session`). Opening a **history row** goes through
    /// [`AgentHost::resume_thread`] instead, which picks load or resume by
    /// capability. The two converge when #21 re-points the sidebar.
    pub async fn load_session(
        &self,
        agent_id: AgentId,
        session_id: String,
        cwd: PathBuf,
    ) -> Result<SessionKey> {
        let record = self.record_for(agent_id)?;
        let key = SessionKey {
            agent_id,
            session_id: session_id.clone(),
        };
        if lock(&self.sessions).contains_key(&session_id) {
            return Ok(key);
        }
        let acp_id = acp::SessionId::new(session_id.as_str());
        let thread = self
            .manager
            .load_session(record.agent.clone(), acp_id, vec![cwd.clone()], None)
            .await
            .map_err(HostError::from)?;
        self.bind(agent_id, &record, cwd, thread);
        Ok(key)
    }

    /// Register a thread with the projector and the session table.
    ///
    /// Order matters: the projector is attached before anything else can touch
    /// the thread, because it drains the events buffered while `session/new`
    /// was still in flight — the replay that `session/load` produces lands
    /// there, and dropping it is the replay-loss bug the port fixes.
    fn bind(
        &self,
        agent_id: AgentId,
        record: &AgentRecord,
        cwd: PathBuf,
        thread: AcpThreadHandle,
    ) -> SessionInit {
        let session_id = lock_thread(&thread).session_id().clone();

        // History first, then the projector. The conversation exists, so
        // history knows about it before anything has been typed into it —
        // Zed's store writes on the same trigger (`conversation_view.rs:917-919`),
        // and a chat that emits no thread event would otherwise never appear at
        // all. Before `attach` because `attach` starts draining events: a
        // `NewEntry` that lands first would be followed by this draft write and
        // pushed back to "nothing sent yet".
        if let Some(history) = self.history() {
            history.record_connected(
                &record.plugin_id.as_str().into(),
                &session_id,
                snapshot_of(&thread),
            );
        }
        self.projector.attach(agent_id, thread.clone());

        let (current_mode, available_modes) = self.modes_of(&thread, &session_id);
        lock(&self.sessions).insert(
            session_id.to_string(),
            SessionRecord {
                agent: record.agent.clone(),
                plugin_id: record.plugin_id.clone(),
                cwd: cwd.to_string_lossy().into_owned(),
                current_model: None,
                turn_seq: 0,
                created_at: Utc::now(),
            },
        );
        SessionInit {
            key: SessionKey {
                agent_id,
                session_id: session_id.to_string(),
            },
            current_mode,
            available_modes,
        }
    }

    fn modes_of(
        &self,
        thread: &AcpThreadHandle,
        session_id: &acp::SessionId,
    ) -> (Option<String>, Vec<SessionModeInfo>) {
        let connection = lock_thread(thread).connection().clone();
        let Some(modes) = connection.session_modes(session_id) else {
            return (None, Vec::new());
        };
        (
            Some(modes.current_mode().to_string()),
            modes
                .all_modes()
                .into_iter()
                .map(|mode| SessionModeInfo {
                    id: mode.id.to_string(),
                    name: mode.name.clone(),
                    description: mode.description,
                })
                .collect(),
        )
    }

    /// Tear down a session. Idempotent — a tab can close twice.
    pub async fn drop_session(&self, session_id: &str) -> Result<()> {
        let removed = lock(&self.sessions).remove(session_id).is_some();
        if !removed {
            return Ok(());
        }
        // Only the live binding goes. The history row is the record of the
        // conversation and outlives the tab that showed it.
        if let Some(history) = self.history() {
            history.forget(&acp::SessionId::new(session_id));
        }
        self.manager
            .close_session(&acp::SessionId::new(session_id))
            .await
            .map_err(HostError::from)
    }

    // ---- session reads ---------------------------------------------------

    fn thread(&self, session_id: &str) -> Result<AcpThreadHandle> {
        self.manager
            .session(&acp::SessionId::new(session_id))
            .map(|handle| handle.thread)
            .ok_or_else(HostError::unknown_session)
    }

    /// The cheap metadata the send path needs (touchpoint #3).
    ///
    /// Same wire shape as [`Self::snapshot`] with `messages` empty: five
    /// frontend call sites only read these fields, and serializing a long
    /// session's whole transcript for them costs megabytes per call.
    pub fn snapshot_meta(&self, key: &SessionKey) -> Result<SessionSnapshot> {
        self.build_snapshot(key, false)
    }

    pub fn snapshot(&self, key: &SessionKey) -> Result<SessionSnapshot> {
        self.build_snapshot(key, true)
    }

    fn build_snapshot(&self, key: &SessionKey, with_messages: bool) -> Result<SessionSnapshot> {
        let (plugin_id, cwd, current_model, created_at) = {
            let sessions = lock(&self.sessions);
            let record = sessions
                .get(&key.session_id)
                .ok_or_else(HostError::unknown_session)?;
            (
                record.plugin_id.clone(),
                record.cwd.clone(),
                record.current_model.clone(),
                record.created_at,
            )
        };
        let handle = self.thread(&key.session_id)?;
        let session_id = acp::SessionId::new(key.session_id.as_str());
        let connection = lock_thread(&handle).connection().clone();

        let (current_mode, available_modes) = self.modes_of(&handle, &session_id);
        let selector = connection.model_selector(&session_id);
        // A session nobody has picked a model in yet still HAS a current model —
        // the one the agent defaulted to. Without this the picker opens on no
        // selection at all.
        //
        // This is the PICKER's value and nothing else. `record.current_model` —
        // what the user actually chose through Atlas — is what stamps the
        // transcript below, because `snapshot_messages` applies one id to every
        // assistant run it returns: stamping history with a default read at
        // snapshot time would relabel turns that ran on a different model.
        let picker_model = current_model.clone().or_else(|| {
            selector
                .as_ref()
                .and_then(|selector| {
                    futures::executor::block_on(async { selector.selected_model().await.ok() })
                })
                .map(|model| model.id.as_str().to_string())
                // The native runtime names a session with no BYOK provider
                // configured "/" — a joined pair of empty strings, not a model.
                .filter(|id| !id.is_empty() && id != "/")
        });
        let available_models = selector
            .and_then(|selector| {
                // `AgentModelSelector` is an async interface because the native
                // agent's list can require work; both implementations here
                // resolve from state already in memory (an external agent's
                // list came in with `session/new`), so this never actually
                // parks. That is what makes a `block_on` safe on the send path.
                futures::executor::block_on(async { selector.list_models().await.ok() })
            })
            .map(|list| {
                // Grouped lists flatten: the composer's picker is one list, and
                // the group is cosmetic in a dropdown Atlas does not render.
                let models = match list {
                    atlas_acp_thread::AgentModelList::Flat(models) => models,
                    atlas_acp_thread::AgentModelList::Grouped(groups) => {
                        groups.into_iter().flat_map(|(_, models)| models).collect()
                    }
                };
                models
                    .into_iter()
                    .map(|model| SessionModeInfo {
                        id: model.id.as_str().to_string(),
                        name: model.name.to_string(),
                        description: model.description.map(|d| d.to_string()),
                    })
                    .collect()
            })
            .unwrap_or_default();

        let thread = lock_thread(&handle);
        let status = if thread.had_error() {
            SessionStatus::Error
        } else if thread.is_generating() {
            SessionStatus::Running
        } else {
            SessionStatus::Idle
        };
        let usage = thread
            .token_usage()
            .map(|usage| Usage {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                // The ported thread carries no cache split — ACP's usage report
                // has none, and only the native agent ever populated these.
                cache_creation_tokens: 0,
                cache_read_tokens: 0,
                cost: thread.cost().map(|cost| cost.amount).unwrap_or(0.0),
            })
            .unwrap_or_default();
        let snapshot = SessionSnapshot {
            agent_id: key.agent_id,
            session_id: key.session_id.clone(),
            cwd,
            plugin_id,
            status,
            current_mode,
            current_model: picker_model,
            available_modes,
            available_models,
            available_commands: thread
                .available_commands()
                .iter()
                .map(|command| serde_json::to_value(command).unwrap_or(serde_json::Value::Null))
                .collect(),
            config_options: connection
                .session_config_options(&session_id)
                .map(|options| {
                    options
                        .config_options()
                        .iter()
                        .map(|option| {
                            serde_json::to_value(option).unwrap_or(serde_json::Value::Null)
                        })
                        .collect()
                })
                .unwrap_or_default(),
            prompt_image_supported: thread.prompt_capabilities().image,
            plan: project::plan_entries(&thread.plan().entries),
            messages: if with_messages {
                project::snapshot_messages(&thread, current_model.as_deref())
            } else {
                Vec::new()
            },
            usage,
            created_at,
            updated_at: Utc::now(),
        };
        Ok(snapshot)
    }

    // ---- turns -----------------------------------------------------------

    /// Start a turn, and return as soon as it is running.
    ///
    /// The command must not await the whole turn: the frontend awaits this
    /// invoke before it stops showing the composer as busy, and a turn runs for
    /// minutes. The turn is driven on its own task, and its failure is
    /// announced on the wire rather than returned here — by then the caller is
    /// long gone.
    pub fn send(self: &Arc<Self>, key: &SessionKey, content: Vec<acp::ContentBlock>) -> Result<()> {
        let session_id = acp::SessionId::new(key.session_id.as_str());
        let turn_seq = {
            let mut sessions = lock(&self.sessions);
            let record = sessions
                .get_mut(&key.session_id)
                .ok_or_else(HostError::unknown_session)?;
            record.turn_seq = record.turn_seq.wrapping_add(1);
            record.turn_seq
        };
        // Before the turn opens, so the `status: running` that `begin_turn`
        // emits already carries this turn's identity.
        self.projector.set_turn_seq(&session_id, turn_seq);

        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = this.manager.send(&session_id, content).await {
                let message = format!("{e:#}");
                let class = classify_message(&message);
                this.projector.note_turn_failed(
                    &session_id,
                    message,
                    Some(class.wire_token().to_string()),
                );
            }
        });
        Ok(())
    }

    pub fn cancel(&self, key: &SessionKey) -> Result<()> {
        self.manager
            .cancel(&acp::SessionId::new(key.session_id.as_str()));
        Ok(())
    }

    // ---- per-session settings -------------------------------------------

    pub async fn set_mode(&self, key: &SessionKey, mode_id: String) -> Result<()> {
        let session_id = acp::SessionId::new(key.session_id.as_str());
        let connection = lock_thread(&self.thread(&key.session_id)?).connection().clone();
        let modes = connection
            .session_modes(&session_id)
            .ok_or_else(|| HostError::new("this agent has no session modes", ErrorClass::Fatal))?;
        modes
            .set_mode(acp::SessionModeId::new(mode_id))
            .await
            .map_err(HostError::from)
    }

    pub async fn set_model(&self, key: &SessionKey, model_id: String) -> Result<()> {
        let session_id = acp::SessionId::new(key.session_id.as_str());
        let connection = lock_thread(&self.thread(&key.session_id)?).connection().clone();
        let selector = connection.model_selector(&session_id).ok_or_else(|| {
            HostError::new("this agent has no model selection", ErrorClass::Fatal)
        })?;
        selector
            .select_model(AgentModelId::new(model_id.clone()))
            .await
            .map_err(HostError::from)?;
        if let Some(record) = lock(&self.sessions).get_mut(&key.session_id) {
            record.current_model = Some(model_id.clone());
        }
        // The thread has no event for this, so the host announces it.
        self.projector.note_model_changed(&session_id, model_id);
        Ok(())
    }

    pub async fn set_config_option(
        &self,
        key: &SessionKey,
        config_id: String,
        value: serde_json::Value,
    ) -> Result<()> {
        let session_id = acp::SessionId::new(key.session_id.as_str());
        let connection = lock_thread(&self.thread(&key.session_id)?).connection().clone();
        let options = connection
            .session_config_options(&session_id)
            .ok_or_else(|| HostError::new("this agent has no config options", ErrorClass::Fatal))?;
        // A bool maps to the wire's boolean form, anything else to the select
        // form — the same mapping the old stack made.
        let value = match value {
            serde_json::Value::Bool(on) => acp::SessionConfigOptionValue::boolean(on),
            // A string rides as-is; anything else is re-serialized so an agent
            // that advertised, say, a numeric option still gets its own value
            // back rather than a quoted JSON blob.
            other => acp::SessionConfigOptionValue::value_id(
                other
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| other.to_string()),
            ),
        };
        let confirmed = options
            .set_config_option(acp::SessionConfigId::new(config_id), value)
            .await
            .map_err(HostError::from)?;
        // The response is the authoritative echo — a follow-up notification is
        // optional, and most agents never send one. Discarding this list is
        // what made the effort pill snap back: the set WORKED on the agent and
        // nothing ever told the frontend (#32). Same shape as
        // `note_model_changed` below, for the same reason.
        self.projector.note_config_options(&session_id, &confirmed);
        Ok(())
    }

    /// Reasoning effort — a native-agent-only knob, as in Zed.
    ///
    /// Accepted by the engine, and **inert against the Atlas gateway**: the
    /// gateway's forwarded allowlist carries no reasoning parameter, so the
    /// authored catalogue advertises no effort levels and the picker offers
    /// none. Kept because the engine still honours it on any other provider.
    pub fn set_effort(&self, key: &SessionKey, effort: String) -> Result<()> {
        let session_id = acp::SessionId::new(key.session_id.as_str());
        let native = self.native_connection(&key.session_id)?;
        let control = native.session_effort(&session_id).ok_or_else(|| {
            HostError::new("this session has no effort control", ErrorClass::Fatal)
        })?;
        control
            .set_effort(Some(effort))
            .map_err(|e| HostError::classified(e.to_string()))
    }

    // Tool-output compression is gone (#54). It was a knob on the Cersei
    // runtime's RTK tool-output compressor, and the engine has no counterpart —
    // a named casualty (D8). The command and its toggle went with it, rather
    // than leaving a control that silently does nothing.

    /// Branch a session into a new thread. `None` for agents that cannot —
    /// the frontend's `supportsFork` hides the affordance for those, so this
    /// answer is a belt over braces, not a user-facing error.
    pub async fn fork_session(&self, key: &SessionKey) -> Result<Option<String>> {
        let Ok(native) = self.native_connection(&key.session_id) else {
            return Ok(None);
        };
        let session_id = acp::SessionId::new(key.session_id.as_str());
        let forked = native
            .fork_thread(&session_id)
            .await
            .map_err(|e| HostError::classified(e.to_string()))?;
        Ok(Some(forked))
    }

    fn native_connection(&self, session_id: &str) -> Result<Arc<atlas_native_agent::EngineConnection>> {
        let connection = lock_thread(&self.thread(session_id)?).connection().clone();
        connection
            .downcast::<atlas_native_agent::EngineConnection>()
            .ok_or_else(|| {
                HostError::new(
                    "this control is only available on the native agent",
                    ErrorClass::Fatal,
                )
            })
    }

    // ---- permissions and elicitations ------------------------------------

    pub fn respond_permission(
        &self,
        session_id: &str,
        request_id: Uuid,
        decision: PermissionDecision,
    ) -> Result<()> {
        let key = self
            .projector
            .permission_key(&request_id)
            .ok_or_else(|| HostError::new("permission request is not pending", ErrorClass::Fatal))?;
        let handle = self.thread(session_id)?;
        match decision {
            PermissionDecision::Selected { option_id } => {
                // The option's kind decides what the thread does with the tool
                // call, so it is read back off the pending request rather than
                // trusted from the frontend.
                let kind = pending_option_kind(&handle, &key.tool_call_id, &option_id)
                    .ok_or_else(|| {
                        HostError::new("permission option is not offered", ErrorClass::Fatal)
                    })?;
                lock_thread(&handle).authorize_tool_call(
                    key.tool_call_id,
                    SelectedPermissionOutcome::new(acp::PermissionOptionId::new(option_id), kind),
                );
            }
            PermissionDecision::Cancelled => {
                lock_thread(&handle).cancel_tool_call_authorization(&key.tool_call_id);
            }
        }
        Ok(())
    }

    /// The stream of request-scoped elicitations, taken once.
    ///
    /// `None` on a second call — the forwarder owns it for the life of the
    /// process, and two drainers would each see half the events.
    pub fn take_request_elicitations(
        &self,
    ) -> Option<mpsc::UnboundedReceiver<(ThreadAgentId, ElicitationStoreEvent)>> {
        self.request_elicitations
            .stream
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }

    /// Read a connection-level elicitation and mint the wire id that answers it.
    ///
    /// `None` when the entry is already gone. Announcing twice is not guarded
    /// against here and does not need to be: the caller forwards only
    /// `ElicitationRequested`, which the store emits exactly once per entry.
    pub fn announce_request_elicitation(
        &self,
        agent_id: &ThreadAgentId,
        entry_id: &ElicitationEntryId,
    ) -> Option<(Uuid, atlas_agent_delta::ElicitationWire)> {
        let connection = self.manager.connection_by_agent_id(agent_id)?;
        let store = connection.request_elicitations()?;
        let wire = {
            let store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let (_, elicitation) = store.elicitation(entry_id)?;
            atlas_agent_delta::elicitation_wire(elicitation)
        };
        let request_id = Uuid::new_v4();
        self.request_elicitations
            .answered_by
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(request_id, (agent_id.clone(), entry_id.clone()));
        Some((request_id, wire))
    }

    /// A question the user no longer has to answer.
    ///
    /// The agent can end one out of band — `session/complete_elicitation`, sent
    /// when the user finished a device-code login in their browser. The store
    /// marks the entry resolved and the dialog on screen becomes a prompt for
    /// something that already happened, stacked over the sign-in modal's live
    /// tail. Returns the wire id to dismiss, and forgets it.
    ///
    /// `None` while the entry is still pending, which is what an ordinary
    /// update means.
    pub fn resolve_request_elicitation(
        &self,
        agent_id: &ThreadAgentId,
        entry_id: &ElicitationEntryId,
    ) -> Option<Uuid> {
        let connection = self.manager.connection_by_agent_id(agent_id)?;
        let store = connection.request_elicitations()?;
        let still_pending = {
            let store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let (_, elicitation) = store.elicitation(entry_id)?;
            matches!(
                elicitation.status,
                atlas_acp_thread::ElicitationStatus::Pending { .. }
            )
        };
        if still_pending {
            return None;
        }
        let mut answered_by = self
            .request_elicitations
            .answered_by
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let request_id = answered_by
            .iter()
            .find(|(_, (agent, entry))| agent == agent_id && entry == entry_id)
            .map(|(request_id, _)| *request_id)?;
        answered_by.remove(&request_id);
        Some(request_id)
    }

    /// Forget an agent's outstanding questions.
    ///
    /// Called when its connection goes: a dialog whose agent has died can no
    /// longer be answered, and without this the entry lives for the rest of the
    /// process. Small, but it is a map that only ever grew — every abandoned
    /// sign-in left one behind.
    pub fn forget_request_elicitations(&self, agent_id: &ThreadAgentId) {
        self.request_elicitations
            .answered_by
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|_, (agent, _)| agent != agent_id);
    }

    pub fn respond_elicitation(
        &self,
        request_id: Uuid,
        action: &str,
        content: Option<serde_json::Value>,
    ) -> Result<()> {
        // Connection-level first: these belong to no session, so the
        // projector has never heard of them.
        //
        // The lookup is its own statement so the `answered_by` guard is
        // DROPPED before anything else is locked. As an `if let` scrutinee it
        // would live to the end of the block, held across the manager's entry
        // mutexes and the elicitation store's — a lock order nothing else
        // takes, and one that would only ever be discovered by deadlocking.
        let request_scoped = self
            .request_elicitations
            .answered_by
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&request_id);
        if let Some((agent_id, entry_id)) = request_scoped {
            let Some(connection) = self.manager.connection_by_agent_id(&agent_id) else {
                return Ok(());
            };
            let Some(store) = connection.request_elicitations() else {
                return Ok(());
            };
            let mut store = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            match elicitation_response(action, content)? {
                Some(response) => store.respond_to_elicitation(&entry_id, response),
                None => store.cancel_elicitation(&entry_id),
            }
            return Ok(());
        }
        // An unknown id is a no-op, not an error: the user can answer a dialog
        // whose agent already died.
        let Some(key) = self.projector.elicitation_key(&request_id) else {
            return Ok(());
        };
        let handle = self.thread(&key.session_id.to_string())?;
        let mut thread = lock_thread(&handle);
        match elicitation_response(action, content)? {
            Some(response) => thread.respond_to_elicitation(&key.entry_id, response),
            None => thread.cancel_elicitation(&key.entry_id),
        }
        Ok(())
    }

    // ---- history -----------------------------------------------------------

    /// Turn a history row into a live session.
    ///
    /// One action, as Zed makes it (`sidebar.rs:3843-3883` →
    /// `agent_panel.rs:4371+`): the agent is started if it is not running, the
    /// session is reopened through whichever of `session/load` /
    /// `session/resume` the agent advertised, and the row is unarchived. A row
    /// whose thread never got a session id is a draft, and opens as a new
    /// conversation — which is what Zed's `resume_session_id = None` does
    /// (`agent_panel.rs:4464-4467`).
    ///
    /// A failure leaves the row exactly as it was, archived flag included:
    /// nothing here runs before the session is open. Atlas never deletes a
    /// history row because an agent could not reopen it — the user's record is
    /// theirs to remove.
    ///
    /// An agent that rejects the reopen because the user is not signed in comes
    /// back classified as `auth`, which is what routes the frontend into the
    /// sign-in flow — Zed's `AuthRequired` branch
    /// (`conversation_view.rs:1150-1157`) reached through the message
    /// classification Atlas already has, rather than a typed downcast.
    pub async fn resume_thread(&self, thread_id: ThreadId) -> Result<ResumedThread> {
        let history = self.history_or_err()?;
        let thread = history
            .store()
            .thread(thread_id)
            .ok_or_else(|| HostError::new("no such thread", ErrorClass::Fatal))?;

        // Already open in this process — the tab just needs focusing, and
        // reopening would be a second session for one conversation.
        if let Some(session_id) = thread.session_id.clone() {
            if lock(&self.sessions).contains_key(session_id.0.as_ref()) {
                history.store().unarchive(thread_id);
                return Ok(ResumedThread {
                    key: SessionKey {
                        agent_id: self.handle_for(&self.agent_for(thread.agent_id.as_str())?),
                        session_id: session_id.to_string(),
                    },
                    resumed_without_history: false,
                });
            }
        }

        let agent = self.spawn(thread.agent_id.as_str()).await?;
        let record = self.record_for(agent.agent_id)?;
        let work_dirs = thread.folder_paths().paths().to_vec();
        let cwd = work_dirs.first().cloned().unwrap_or_default();

        let (opened, resumed_without_history) = match thread.session_id.clone() {
            // A draft: there is no stored conversation to reopen, so this is a
            // new one. The row is bound to it first, or the live feed would
            // mint a second row for the thread the user just clicked.
            None => {
                let opened = self
                    .manager
                    .new_session(record.agent.clone(), work_dirs)
                    .await
                    .map_err(HostError::from)?;
                let session_id = lock_thread(&opened).session_id().clone();
                history.adopt(session_id, thread_id);
                (opened, false)
            }
            Some(session_id) => {
                let resumed = self
                    .manager
                    .resume_stored_session(
                        record.agent.clone(),
                        session_id.clone(),
                        work_dirs,
                        thread.title(),
                    )
                    .await
                    .map_err(HostError::from)?;
                // The agent may have answered with a different session id than
                // the stored one — the engine's fresh-thread fallback for a
                // pre-cutover row does exactly that. The row is bound to the
                // id the live feed will stamp on its events, the same
                // invariant the draft arm above keeps; without it the feed's
                // first write mints a duplicate row and the one the user
                // clicked is orphaned on the dead id (#56).
                let opened_session_id = lock_thread(&resumed.thread).session_id().clone();
                if opened_session_id != session_id {
                    history.adopt(opened_session_id, thread_id);
                }
                (resumed.thread, resumed.mode == ResumeMode::WithoutHistory)
            }
        };

        let init = self.bind(agent.agent_id, &record, cwd, opened);
        // After the session is open, and after `bind` — the live feed preserves
        // whatever `archived` it finds, so unarchiving first would be undone by
        // the row it writes (`agent_panel.rs:4382-4386` unarchives on open).
        history.store().unarchive(thread_id);
        Ok(ResumedThread {
            key: init.key,
            resumed_without_history,
        })
    }

    /// Remove a history row, and ask the agent to forget its session if it can.
    ///
    /// Local first and unconditionally — deleting from Atlas's own history must
    /// never depend on an agent being reachable, let alone on Atlas touching
    /// the agent's files. The agent-side half is best effort and gated on
    /// `sessionCapabilities.delete`; an agent that cannot do it is not an
    /// error, and the row is gone either way (Zed's
    /// `threads_archive_view.rs:807-851`).
    ///
    /// Deleting the row of a conversation that is **still open** removes it
    /// now, and its next message puts it back under the same thread id — the
    /// live feed keeps its binding on purpose. That is Zed's behaviour and it
    /// is the honest one: history records conversations, and this one has not
    /// finished. Archive is the action for "out of my way but keep it".
    pub async fn delete_thread(&self, thread_id: ThreadId) -> Result<()> {
        let history = self.history_or_err()?;
        let Some(thread) = history.store().thread(thread_id) else {
            return Ok(());
        };
        history.store().delete(thread_id);

        let Some(session_id) = thread.session_id else {
            return Ok(());
        };
        let Ok(agent) = self.agent_for(thread.agent_id.as_str()) else {
            // The agent was uninstalled. Atlas's record is still the user's to
            // delete, and it already is.
            return Ok(());
        };
        if let Err(e) = self.manager.delete_stored_session(agent, &session_id).await {
            tracing::warn!(error = %e, %session_id, "agent could not delete the session");
        }
        Ok(())
    }

    /// The open project's threads — the chat history sidebar's only source.
    ///
    /// **Scoped to `cwd`.** The store is app-level and holds every project's
    /// threads (ADR-0001), and this used to return all of them, Zed-style. That
    /// suits Zed, where the window IS the project; Atlas switches projects
    /// inside one window, so a list mixing every project's chats was noise the
    /// user had to read past, and a thread from another project sitting at the
    /// top read as if it belonged to the one in front. Everything is still
    /// reachable — `thread_history` backs the "All history" view, unscoped.
    ///
    /// With no project open (`cwd` empty) there is nothing to scope to, so the
    /// full list stands rather than showing an empty sidebar.
    ///
    /// Matching `cwd` happens HERE rather than in the UI: the comparison has to
    /// run against the same canonicalised form the grouping key uses, and only
    /// this side has it. The UI comparing its own raw path string silently
    /// matched nothing whenever the two spellings differed (symlink,
    /// `/private` prefix, trailing slash).
    pub fn thread_projects(&self, cwd: Option<&str>) -> Result<Vec<ThreadProjectWire>> {
        let projects = self.history_or_err()?.store().projects();

        // Basenames collide: two checkouts both called `web` are one label. Any
        // name shared by more than one project gets qualified with its parent
        // directory, so the sidebar can always tell them apart.
        let mut name_counts: HashMap<String, usize> = HashMap::new();
        for project in &projects {
            *name_counts.entry(project_name(&project.paths)).or_default() += 1;
        }

        let here = cwd
            .filter(|c| !c.is_empty())
            .map(|c| PathBuf::from(c.to_string()));

        Ok(projects
            .into_iter()
            // Group-level, not thread-level: a project opened in a linked git
            // worktree groups under its main repository, and the threads from
            // both halves belong to the project the user is looking at.
            .filter(|project| {
                let Some(path) = here.as_ref() else {
                    return true;
                };
                // `contains` canonicalises its argument, so this compares like
                // for like whatever spelling the caller passed.
                project.paths.contains(path)
                    || project
                        .threads
                        .iter()
                        .any(|thread| thread.folder_paths().contains(path))
            })
            .map(|project| {
                let plain = project_name(&project.paths);
                let ambiguous = name_counts.get(&plain).copied().unwrap_or(0) > 1;
                ThreadProjectWire {
                    name: if ambiguous {
                        qualified_project_name(&project.paths)
                    } else {
                        plain
                    },
                    paths: paths_of(&project.paths),
                    // Everything that survives the filter is the open project,
                    // except when nothing was scoped to in the first place.
                    is_current: here.is_some(),
                    threads: project.threads.iter().map(thread_row).collect(),
                }
            })
            .collect())
    }

    /// Every thread, archived or not, newest-started first — the history view.
    pub fn thread_history(&self, archived_only: bool) -> Result<Vec<ThreadRow>> {
        let filter = if archived_only {
            ThreadFilter::ArchivedOnly
        } else {
            ThreadFilter::All
        };
        Ok(self
            .history_or_err()?
            .store()
            .history(filter)
            .iter()
            .map(thread_row)
            .collect())
    }

    /// Take a thread out of the active list, keeping it in history.
    pub fn archive_thread(&self, thread_id: ThreadId) -> Result<()> {
        self.history_or_err()?.store().archive(thread_id);
        Ok(())
    }

    /// Which installed agents can be imported from, and how much they have.
    ///
    /// Connecting to every installed agent is the price of the answer, and Zed
    /// pays it too (`thread_import.rs:689-792`): whether an agent has listable
    /// history is something only the agent can say, at `initialize`. The native
    /// agent is absent because its threads are already Atlas's.
    ///
    /// An agent that cannot be imported from is *reported*, not hidden. A user
    /// who does not see their agent has no way to tell a missing feature from a
    /// missing agent.
    pub async fn import_candidates(&self) -> Result<Vec<ImportCandidate>> {
        let known = self.history_or_err()?.store().known_session_ids();
        let mut out = Vec::new();
        for plugin_id in self.store.external_agents() {
            let plugin_id = plugin_id.to_string();
            let status = match self.list_sessions_of(&plugin_id).await {
                Ok(None) => ImportStatus::Unsupported,
                Ok(Some(sessions)) => ImportStatus::Ready {
                    importable: importable_threads(sessions, &plugin_id.as_str().into(), &known)
                        .len(),
                },
                Err(e) => ImportStatus::Error { message: e.message },
            };
            out.push(ImportCandidate {
                plugin_id: plugin_id.clone(),
                display_name: self.display_name(&plugin_id),
                status,
            });
        }
        Ok(out)
    }

    /// Pull the chosen agents' sessions into history. Answers how many rows
    /// were added.
    pub async fn import_threads(&self, plugin_ids: Vec<String>) -> Result<usize> {
        let mut imported = 0;
        for plugin_id in plugin_ids {
            imported += self.import_from(&plugin_id).await?;
        }
        Ok(imported)
    }

    /// The one-time import pass, so an existing user's history is not empty
    /// after the update.
    ///
    /// Once per agent, ever, recorded in the store so it survives a restart —
    /// and recorded whatever the outcome, including a failure. "Once" is what
    /// the spec asks for, and the alternative is re-spawning every installed
    /// agent on every launch to retry a convenience; a user whose agent was
    /// signed out that morning can import by hand, which is one action away in
    /// the history view.
    ///
    /// A fresh install has no installed agents, so this does nothing at all,
    /// which is the point: it must never be a reason for an agent to exist.
    pub async fn backfill_history(&self) {
        let Some(history) = self.history() else {
            return;
        };
        for plugin_id in self.store.external_agents() {
            let plugin_id = plugin_id.to_string();
            let agent_id: atlas_acp_thread::AgentId = plugin_id.as_str().into();
            if history.store().has_backfilled(&agent_id) {
                continue;
            }
            match self.import_from(&plugin_id).await {
                Ok(rows) => tracing::info!(%plugin_id, rows, "backfilled history"),
                Err(e) => tracing::warn!(error = %e.message, %plugin_id, "backfill found nothing"),
            }
            history.store().mark_backfilled(&agent_id);
        }
    }

    /// Fetch one agent's sessions and write the new ones. Answers how many.
    ///
    /// The single place import happens, so the manual flow and the backfill
    /// cannot drift apart on what "importable" means.
    async fn import_from(&self, plugin_id: &str) -> Result<usize> {
        let history = self.history_or_err()?;
        let Some(sessions) = self.list_sessions_of(plugin_id).await? else {
            return Ok(0);
        };
        // Read what is known *now*, not when the modal was opened: two imports
        // racing, or a conversation started since, must not produce a second
        // row for one session.
        let rows = importable_threads(
            sessions,
            &plugin_id.into(),
            &history.store().known_session_ids(),
        );
        let imported = rows.len();
        history.store().save_all(rows);
        Ok(imported)
    }

    /// Every session an agent will list, or `None` when it has no listable
    /// history — which is to say, when it did not advertise
    /// `sessionCapabilities.list`.
    async fn list_sessions_of(
        &self,
        plugin_id: &str,
    ) -> Result<Option<Vec<atlas_acp_thread::AgentSessionInfo>>> {
        let agent = self.agent_for(plugin_id)?;
        let connection = self
            .manager
            .connection(agent)
            .await
            .map_err(HostError::from)?;
        let Some(list) = connection.session_list() else {
            return Ok(None);
        };
        // No cwd filter. Zed scopes its import to a workspace because its
        // connections are per-workspace; Atlas has one connection per agent and
        // an app-level store whose rows carry their own paths, so "everything
        // this agent knows" is both simpler and more useful.
        collect_all_sessions(list.as_ref(), None)
            .await
            .map(Some)
            .map_err(HostError::from)
    }

    fn history_or_err(&self) -> Result<&ThreadRecorder> {
        self.history()
            .ok_or_else(|| HostError::new("session history is unavailable", ErrorClass::Fatal))
    }

    // ---- the agent's own session store -----------------------------------

    // ---- auth ------------------------------------------------------------

    pub async fn auth_methods(&self, agent_id: AgentId) -> Result<Vec<AuthMethodWire>> {
        let record = self.record_for(agent_id)?;
        let Some(connection) = self.connected(&record.agent) else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        for method in connection.auth_methods() {
            let Some(wire) = AuthMethodWire::from_acp(method) else {
                continue;
            };
            // Ask the connection what it would actually run, rather than
            // re-deriving it from `_meta` here. That keeps the client's idea of
            // "can this method be started" identical to the backend's.
            let resolved = match connection.terminal_auth_command(method.id()) {
                Some(task) => match task.await {
                    Ok(command) => Some(command),
                    // Not the same as "this agent named no login". Collapsing
                    // the two makes the UI say "Atlas could not find this
                    // agent's CLI" — the exact wrong answer this resolution
                    // exists to stop — so the real reason goes in the log.
                    Err(err) => {
                        tracing::warn!(
                            target: "atlas::agents",
                            "resolving the login command for `{}` failed: {err}",
                            method.id()
                        );
                        None
                    }
                },
                None => None,
            };
            out.push(wire.with_runnable(resolved.as_ref()));
        }
        Ok(out)
    }

    /// The login command the agent named for a method, if it named one.
    pub async fn terminal_auth_command(
        &self,
        agent_id: AgentId,
        method_id: &str,
    ) -> Result<Option<TerminalAuthCommand>> {
        let record = self.record_for(agent_id)?;
        let Some(connection) = self.connected(&record.agent) else {
            return Ok(None);
        };
        let Some(task) = connection.terminal_auth_command(&acp::AuthMethodId::new(method_id)) else {
            return Ok(None);
        };
        task.await.map(Some).map_err(HostError::from)
    }

    pub async fn authenticate(&self, agent_id: AgentId, method_id: String) -> Result<()> {
        let record = self.record_for(agent_id)?;
        let connection = self
            .manager
            .connection(record.agent.clone())
            .await
            .map_err(HostError::from)?;
        connection
            .authenticate(acp::AuthMethodId::new(method_id))
            .await
            .map_err(HostError::from)
    }

    pub async fn logout(&self, agent_id: AgentId) -> Result<()> {
        let record = self.record_for(agent_id)?;
        let connection = self
            .connected(&record.agent)
            .ok_or_else(HostError::unknown_agent)?;
        if !connection.supports_logout() {
            return Err(HostError::new(
                "this agent does not support signing out",
                ErrorClass::Fatal,
            ));
        }
        connection.logout().await.map_err(HostError::from)
    }
}

/// What a thread currently is, as history records it.
///
/// Read under the thread's own lock and nothing else's: the caller must not be
/// holding the projection lock, or the history store would queue behind the
/// wire projection.
fn snapshot_of(thread: &AcpThreadHandle) -> ThreadSnapshot {
    let thread = lock_thread(thread);
    ThreadSnapshot {
        is_draft: thread.is_draft(),
        // The agent's title when it has produced one, else what the user
        // opened with. A row the user cannot recognise is a row they cannot
        // use, and agents title threads late or not at all.
        title: thread.title().cloned().or_else(|| thread.fallback_title()),
        work_dirs: thread.work_dirs().to_vec(),
    }
}

/// Keeps every live conversation's history row current.
///
/// Zed's `ThreadMetadataStore` subscribes to each `ConversationView`
/// (`thread_metadata_store.rs:1188-1212`); Atlas has no views, so the projector
/// forwards the same events here and this reads the thread the way Zed's
/// handler reads its own.
///
/// Weak on purpose: the host owns the projector that owns this.
struct HistoryObserver(std::sync::Weak<AgentHost>);

impl ThreadObserver for HistoryObserver {
    fn on_thread_event(
        &self,
        agent_id: AgentId,
        session_id: &acp::SessionId,
        event: &atlas_acp_thread::AcpThreadEvent,
        thread: &AcpThreadHandle,
    ) {
        // Cheapest check first: this runs on every streamed chunk, and the
        // work below — a map lookup, the thread's lock, a path clone — is worth
        // doing only for the events that can change a row.
        if !affects_thread_metadata(event) {
            return;
        }
        let Some(host) = self.0.upgrade() else {
            return;
        };
        let Some(history) = host.history() else {
            return;
        };
        // The store keeps the agent's durable id, not this process's handle for
        // it: a row outlives the spawn that made it.
        let Some(plugin_id) = host.plugin_id_for_agent(agent_id) else {
            tracing::warn!(%agent_id, %session_id, "no plugin for agent; history not recorded");
            return;
        };
        history.record(
            &plugin_id.as_str().into(),
            session_id,
            event,
            snapshot_of(thread),
        );
    }
}

/// One thread, as every history surface renders it.
///
/// Deliberately flat and already-formatted: the sidebar re-reads this on every
/// store change, and shaping it in the webview would be work repeated per
/// render. `title` is the *display* title — the user's rename if there is one,
/// the agent's if not, the default otherwise — because no caller has ever
/// wanted to re-derive that precedence.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRow {
    pub thread_id: String,
    /// Absent while the thread is a draft.
    pub session_id: Option<String>,
    /// Which agent ran it — the row's icon, and who resumes it.
    pub agent_id: String,
    pub title: String,
    pub updated_at: String,
    pub created_at: Option<String>,
    pub archived: bool,
    /// The project this thread belongs to, for a history row that is shown
    /// outside its project's group.
    pub project_name: String,
    pub folder_paths: Vec<String>,
}

/// One project's threads, as the sidebar groups them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadProjectWire {
    pub name: String,
    pub paths: Vec<String>,
    /// This project is the one the caller currently has open. Decided here so
    /// the match runs against canonicalised paths — see `thread_projects`.
    pub is_current: bool,
    pub threads: Vec<ThreadRow>,
}

fn thread_row(thread: &ThreadMetadata) -> ThreadRow {
    ThreadRow {
        thread_id: thread.thread_id.to_key_string(),
        session_id: thread.session_id.as_ref().map(std::string::ToString::to_string),
        agent_id: thread.agent_id.to_string(),
        title: thread.display_title().to_string(),
        updated_at: thread.updated_at.to_rfc3339(),
        created_at: thread.created_at.map(|at| at.to_rfc3339()),
        archived: thread.archived,
        project_name: project_name(thread.main_worktree_paths()),
        folder_paths: paths_of(thread.folder_paths()),
    }
}

fn paths_of(paths: &PathList) -> Vec<String> {
    paths
        .ordered_paths()
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

/// What to call a project: the name of its directory, or all of their names
/// when it spans several.
///
/// Two projects whose directories share a name read identically here;
/// `thread_projects` detects that and falls back to
/// [`qualified_project_name`], so the collision never reaches the user.
fn project_name(paths: &PathList) -> String {
    let names: Vec<String> = paths
        .ordered_paths()
        .filter_map(|path| path.file_name())
        .map(|name| name.to_string_lossy().into_owned())
        .collect();
    if names.is_empty() {
        return "No project".to_string();
    }
    names.join(", ")
}

/// `project_name` with each directory's parent in front (`teamA/web`), for the
/// case where the bare names collide. Falls back to the bare name for a path
/// with no parent.
fn qualified_project_name(paths: &PathList) -> String {
    let names: Vec<String> = paths
        .ordered_paths()
        .filter_map(|path| {
            let name = path.file_name()?.to_string_lossy().into_owned();
            Some(match path.parent().and_then(|p| p.file_name()) {
                Some(parent) => format!("{}/{}", parent.to_string_lossy(), name),
                None => name,
            })
        })
        .collect();
    if names.is_empty() {
        return "No project".to_string();
    }
    names.join(", ")
}

/// One installed agent, as the import flow lists it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCandidate {
    pub plugin_id: String,
    pub display_name: String,
    pub status: ImportStatus,
}

/// Whether an agent can be imported from, and why not when it cannot.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ImportStatus {
    /// It listed its sessions, and this many are new to Atlas.
    Ready { importable: usize },
    /// It did not advertise `sessionCapabilities.list`. Named, not guessed —
    /// the user is told which capability is missing rather than that the agent
    /// "doesn't work".
    Unsupported,
    /// It was asked and something went wrong. Shown, because a silent failure
    /// is indistinguishable from an agent with no history.
    Error { message: String },
}

/// A history row, now live.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumedThread {
    pub key: SessionKey,
    /// The agent could only continue the session, not replay it. The user is
    /// told, in the app's existing notice styling — a conversation that comes
    /// back empty with no explanation reads as data loss.
    pub resumed_without_history: bool,
}

/// What a live connection advertises. All false before the handshake.
#[derive(Debug, Clone, Default)]
pub struct PluginCapabilities {
    pub auth_kinds: Vec<String>,
    pub supports_logout: bool,
    pub supports_load_session: bool,
    pub supports_session_list: bool,
    pub supports_fork: bool,
}

/// A registry agent's cached icon, as a data URL.
///
/// Data URL rather than a path because the asset protocol 403s files under
/// hidden directories, so a path is useless to the webview (the same
/// constraint `canvas.rs` works around). Icons are SVG on disk; a missing or
/// unreadable one is simply absent rather than an error.
pub fn icon_data_url(agent: &atlas_agent_store::RegistryAgent) -> Option<String> {
    let bytes = std::fs::read(agent.icon_path()?).ok()?;
    use base64::Engine;
    Some(format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// Where an agent keeps its own transcript.
///
/// This is not a default-agent table: nothing here makes an agent available,
/// and an id that is not listed simply gets Atlas's own recording. It exists
/// because checkpoint touchpoint #11 requires the port to keep reading the
/// transcripts agents write for themselves, and knowing where those are is
/// per-agent knowledge no protocol advertises.
pub fn transcript_kind_for(plugin_id: &str) -> TranscriptKind {
    if plugin_id == CERSEI_AGENT_ID {
        return TranscriptKind::CerseiJson;
    }
    TranscriptKind::None
}

/// One auth method, as the frontend reads it.
///
/// Moved from `atlas-acp/src/driver.rs` with the port, still built by reading
/// the method's SERIALIZED form rather than matching the typed enum: the
/// `Terminal` / `EnvVar` variants are unstable-gated, and without the feature a
/// wire-level `type` silently deserializes as `Agent` with its extra fields
/// dropped. Reading the raw object is immune to that.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthMethodWire {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// Which branch of the flow this method drives.
    pub kind: String,
    /// `env_var` methods: the variables the client must set.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub env_vars: Vec<AuthEnvVar>,
    /// `env_var` methods: where the user obtains the credential.
    pub link: Option<String>,
    /// Typed `terminal.args`, relative to the agent's own binary.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    /// The binary to actually exec, and what to run it with.
    ///
    /// Resolved through the same path `agents_run_auth_method` uses, NOT read
    /// off `_meta` alone: the stabilised typed `Terminal` variant names only
    /// the arguments, because the program is the agent's own binary and only
    /// the backend knows where that is. Reading `_meta` alone reported no
    /// command for those methods, and the UI blocks a terminal method with no
    /// command — so a login the backend could run was refused by the client.
    pub terminal_command: Option<String>,
    pub terminal_args: Option<Vec<String>>,
    pub terminal_label: Option<String>,
    /// The environment that login must run with. It carries the proxy
    /// configuration and the spawn quirks, so a command shown or run without it
    /// reaches the network differently from the agent it is signing in.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub terminal_env: Vec<(String, String)>,
    /// `_meta["api-key"].provider` — a proprietary hint that this method is
    /// satisfied by that provider's API key. Lets the UI show the same env-var
    /// checklist a typed `env_var` method would get.
    pub api_key_provider: Option<String>,
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

impl AuthMethodWire {
    fn from_acp(method: &acp::AuthMethod) -> Option<Self> {
        let value = serde_json::to_value(method).ok()?;
        let obj = value.as_object()?;
        let id = obj.get("id")?.as_str()?.to_string();
        let meta = obj.get("_meta").and_then(|m| m.as_object());
        let terminal = meta
            .and_then(|m| m.get("terminal-auth"))
            .and_then(|t| t.as_object());
        Some(Self {
            name: obj
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or(&id)
                .to_string(),
            description: obj
                .get("description")
                .and_then(|d| d.as_str())
                .map(str::to_string),
            kind: auth_kind_token(method).to_string(),
            env_vars: obj
                .get("vars")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(parse_env_var).collect())
                .unwrap_or_default(),
            link: obj.get("link").and_then(|l| l.as_str()).map(str::to_string),
            args: obj
                .get("args")
                .and_then(|a| a.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default(),
            terminal_command: terminal
                .and_then(|t| t.get("command"))
                .and_then(|c| c.as_str())
                .map(str::to_string),
            terminal_args: terminal.and_then(|t| t.get("args")).and_then(|a| {
                a.as_array()
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            }),
            terminal_label: terminal
                .and_then(|t| t.get("label"))
                .and_then(|l| l.as_str())
                .map(str::to_string),
            api_key_provider: meta
                .and_then(|m| m.get("api-key"))
                .and_then(|k| k.get("provider"))
                .and_then(|p| p.as_str())
                .map(str::to_string),
            terminal_env: Vec::new(),
            id,
        })
    }

    /// Overlay what the backend would actually run for this method.
    ///
    /// One source of truth: `terminal_auth_command_for` prefers the typed
    /// `Terminal` variant and falls back to `_meta`, so whatever it resolves is
    /// exactly what `agents_run_auth_method` executes and exactly what the user
    /// can be told to run by hand.
    fn with_runnable(mut self, resolved: Option<&TerminalAuthCommand>) -> Self {
        if let Some(resolved) = resolved {
            self.terminal_command = Some(resolved.command.clone());
            self.terminal_args = Some(resolved.args.clone());
            // `declared_env`, NOT `env`. The spawn environment is the agent's
            // whole inherited one — the user's environment plus the BYOK keys
            // from the keychain — and this field is displayed, copied and typed
            // into a shell. Only what the agent declared belongs on the wire.
            self.terminal_env = resolved.declared_env.clone();
            if self.terminal_label.is_none() {
                self.terminal_label = Some(resolved.label.clone());
            }
        }
        self
    }
}

/// One `vars[]` entry. Skips a malformed item rather than failing the method —
/// the schema itself does the same, so a bad entry must not discard the good
/// ones alongside it.
fn parse_env_var(v: &serde_json::Value) -> Option<AuthEnvVar> {
    let obj = v.as_object()?;
    Some(AuthEnvVar {
        name: obj.get("name")?.as_str()?.to_string(),
        label: obj.get("label").and_then(|l| l.as_str()).map(str::to_string),
        secret: obj.get("secret").and_then(serde_json::Value::as_bool).unwrap_or(true),
        optional: obj.get("optional").and_then(serde_json::Value::as_bool).unwrap_or(false),
    })
}

/// The wire token for an auth method's kind (`agent` | `env_var` | `terminal`).
///
/// Read off the serialized form rather than matched on the enum: the typed
/// variants are unstable-gated, and without the feature a `terminal` method
/// deserializes as `agent` with its extra fields dropped.
fn auth_kind_token(method: &acp::AuthMethod) -> &'static str {
    match serde_json::to_value(method)
        .ok()
        .as_ref()
        .and_then(|v| v.get("type"))
        .and_then(|t| t.as_str())
    {
        Some("env_var") => "env_var",
        Some("terminal") => "terminal",
        _ => "agent",
    }
}

/// The kind of a permission option the thread is currently offering.
fn pending_option_kind(
    handle: &AcpThreadHandle,
    tool_call_id: &acp::ToolCallId,
    option_id: &str,
) -> Option<acp::PermissionOptionKind> {
    let thread = lock_thread(handle);
    let (_, call) = thread.tool_call(tool_call_id)?;
    let atlas_acp_thread::ToolCallStatus::WaitingForConfirmation { options, .. } = &call.status
    else {
        return None;
    };
    options.option_by_id(option_id).map(|option| option.kind)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn lock_thread(thread: &AcpThreadHandle) -> std::sync::MutexGuard<'_, AcpThread> {
    thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

// ── The installed map on disk ───────────────────────────────────────────────
//
// Zed keeps this in `settings.json` under `agent_servers`. Atlas keeps the same
// JSON in a file of its own so a hand edit is possible without touching app
// settings, and so uninstalling an agent is one atomic write.

/// Where the installed map lives. Beside the agents it describes.
pub fn installed_map_path(data_dir: &std::path::Path) -> PathBuf {
    atlas_agent_store::external_agents_dir(data_dir).join("installed.json")
}

/// Read the installed map. A missing or unreadable file is an empty map — a
/// fresh install has no external agents, which is the whole point.
pub fn load_installed(data_dir: &std::path::Path) -> atlas_agent_store::AllAgentServersSettings {
    let path = installed_map_path(data_dir);
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|e| {
            tracing::warn!(
                target: "atlas::agents",
                path = %path.display(),
                "installed map is unreadable ({e}); treating it as empty"
            );
            Default::default()
        }),
        Err(_) => Default::default(),
    }
}

/// Write the installed map, creating its directory if needed.
pub fn save_installed(
    data_dir: &std::path::Path,
    settings: &atlas_agent_store::AllAgentServersSettings,
) -> std::io::Result<()> {
    let path = installed_map_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, json)
}

#[cfg(test)]
mod elicitation_response_tests {
    use super::*;

    /// The tag is `action` with snake_case variants, and the catch-all `Other`
    /// arm is `#[serde(untagged)]` — so a wrong tag fails the whole union
    /// rather than landing in it. This shipped as `{"outcome": "accepted"}`,
    /// which meant no elicitation answer ever deserialized: the command
    /// returned `Fatal`, the card was dismissed anyway, and the agent waited on
    /// a reply that was never sent. Pin the wire.
    #[test]
    fn accept_carries_the_answers_under_the_action_tag() {
        let content = serde_json::json!({ "question_0": "TypeScript", "question_1": ["DMs"] });
        let response = elicitation_response("accept", Some(content))
            .expect("a well-formed accept is not an error")
            .expect("accept is a response, not a cancel");
        assert!(matches!(response.action, acp::ElicitationAction::Accept(_)));
        assert_eq!(
            serde_json::to_value(&response).unwrap(),
            serde_json::json!({
                "action": "accept",
                "content": { "question_0": "TypeScript", "question_1": ["DMs"] },
            })
        );
    }

    #[test]
    fn accept_with_no_content_is_still_an_accept() {
        let response = elicitation_response("accept", None).unwrap().unwrap();
        assert!(matches!(response.action, acp::ElicitationAction::Accept(_)));
    }

    /// Declining is an ANSWER — the agent is told the user skipped and carries
    /// on — so it must reach the wire, unlike a cancel.
    #[test]
    fn decline_is_a_response() {
        let response = elicitation_response("decline", None).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(&response).unwrap(),
            serde_json::json!({ "action": "decline" })
        );
    }

    /// Cancel is `None` on purpose: the caller cancels the entry instead of
    /// sending an answer the user never gave.
    #[test]
    fn cancel_sends_nothing() {
        assert!(elicitation_response("cancel", None).unwrap().is_none());
        assert!(elicitation_response("anything-else", None).unwrap().is_none());
    }

    /// A value the schema does not allow (a nested object) must be a loud
    /// error, not a silently truncated answer.
    #[test]
    fn a_malformed_accept_is_an_error() {
        let content = serde_json::json!({ "q": { "nested": "object" } });
        assert!(elicitation_response("accept", Some(content)).is_err());
    }
}

#[cfg(test)]
mod auth_method_wire_tests {
    use super::*;

    fn method(value: serde_json::Value) -> acp::AuthMethod {
        serde_json::from_value(value).expect("an auth method this schema understands")
    }

    /// The typed `Terminal` variant is the STABILISED way an agent says how to
    /// sign in, and it names only the arguments — the binary is the agent's own,
    /// which only the backend knows. Reading `_meta` alone left the wire saying
    /// this method has no command, so the UI blocked it with "Atlas could not
    /// find this agent's CLI" for a login the backend could run perfectly well.
    #[test]
    fn a_typed_terminal_method_reports_the_command_the_backend_would_run() {
        let wire = AuthMethodWire::from_acp(&method(serde_json::json!({
            "id": "login",
            "name": "Log in",
            "type": "terminal",
            "args": ["login"],
        })))
        .expect("a wire method");
        assert_eq!(
            wire.terminal_command, None,
            "precondition: the method itself names no binary"
        );

        let resolved = atlas_acp_thread::build_terminal_auth_command(
            "run-1".to_string(),
            "Log in".to_string(),
            "/opt/atlas/agents/cursor-agent".to_string(),
            vec!["acp".to_string(), "login".to_string()],
            // The SPAWN environment — the agent's whole inherited one, keychain
            // keys included. It must not reach the wire.
            vec![
                ("ANTHROPIC_API_KEY".to_string(), "sk-secret".to_string()),
                ("HTTPS_PROXY".to_string(), "http://proxy".to_string()),
            ],
            // What the agent DECLARED, which is all that may be shown.
            vec![("HTTPS_PROXY".to_string(), "http://proxy".to_string())],
        );
        let wire = wire.with_runnable(Some(&resolved));

        assert_eq!(
            wire.terminal_command.as_deref(),
            Some("/opt/atlas/agents/cursor-agent")
        );
        assert_eq!(
            wire.terminal_args.as_deref(),
            Some(["acp".to_string(), "login".to_string()].as_slice())
        );
        assert_eq!(
            wire.terminal_env,
            vec![("HTTPS_PROXY".to_string(), "http://proxy".to_string())],
            "what the agent declared goes with it — it carries the proxy config"
        );
        assert!(
            !wire.terminal_env.iter().any(|(name, _)| name == "ANTHROPIC_API_KEY"),
            "the spawn environment must not reach a field that is displayed, \
             copied to the clipboard and typed into a shell that keeps history"
        );
    }

    /// An agent that named no login at all still reports none. Guessing is what
    /// the deleted builtin login table did.
    #[test]
    fn a_method_with_no_runnable_command_stays_empty() {
        let wire = AuthMethodWire::from_acp(&method(serde_json::json!({
            "id": "api-key",
            "name": "API key",
        })))
        .expect("a wire method")
        .with_runnable(None);

        assert_eq!(wire.terminal_command, None);
        assert!(wire.terminal_env.is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::test_support::{fresh_host, fresh_host_with_native};
    use atlas_acp_thread::{AcpThread, AcpThreadHandle, AgentConnection};
    use atlas_agent_servers::AgentServerDelegate;
    use futures::future::BoxFuture;
    use futures::FutureExt;

    /// A native agent that reopens every session under one fixed id of its
    /// own choosing — the shape of the engine's fresh-thread fallback for a
    /// row whose stored id it does not know.
    struct RebindingNative {
        fresh_id: &'static str,
    }

    impl AgentConnection for RebindingNative {
        fn agent_id(&self) -> atlas_acp_thread::AgentId {
            atlas_acp_thread::AgentId::new(CERSEI_AGENT_ID)
        }

        fn telemetry_id(&self) -> Arc<str> {
            CERSEI_AGENT_ID.into()
        }

        fn new_session(
            self: Arc<Self>,
            work_dirs: Vec<PathBuf>,
        ) -> BoxFuture<'static, anyhow::Result<AcpThreadHandle>> {
            let thread = self.thread(acp::SessionId::new(self.fresh_id), work_dirs);
            async move { Ok(thread) }.boxed()
        }

        fn supports_load_session(&self) -> bool {
            true
        }

        fn load_session(
            self: Arc<Self>,
            _session_id: acp::SessionId,
            work_dirs: Vec<PathBuf>,
            _title: Option<Arc<str>>,
        ) -> BoxFuture<'static, anyhow::Result<AcpThreadHandle>> {
            // The stored id is not honoured: the thread comes back under the
            // agent's own fresh id, exactly like the engine's fallback.
            let thread = self.thread(acp::SessionId::new(self.fresh_id), work_dirs);
            async move { Ok(thread) }.boxed()
        }

        fn auth_methods(&self) -> &[acp::AuthMethod] {
            &[]
        }

        fn authenticate(
            &self,
            _method: acp::AuthMethodId,
        ) -> BoxFuture<'static, anyhow::Result<()>> {
            async { Ok(()) }.boxed()
        }

        fn prompt(
            &self,
            _params: acp::PromptRequest,
        ) -> BoxFuture<'static, anyhow::Result<acp::PromptResponse>> {
            async { Ok(acp::PromptResponse::new(acp::StopReason::EndTurn)) }.boxed()
        }

        fn cancel(&self, _session_id: &acp::SessionId) {}

        fn into_any(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
            self
        }
    }

    impl RebindingNative {
        fn thread(
            self: &Arc<Self>,
            session_id: acp::SessionId,
            work_dirs: Vec<PathBuf>,
        ) -> AcpThreadHandle {
            Arc::new(std::sync::Mutex::new(AcpThread::new(
                session_id,
                self.clone() as Arc<dyn AgentConnection>,
                work_dirs,
                None,
                atlas_acp_thread::event_channel().0,
            )))
        }
    }

    impl AgentServer for RebindingNative {
        fn agent_id(&self) -> atlas_acp_thread::AgentId {
            atlas_acp_thread::AgentId::new(CERSEI_AGENT_ID)
        }

        fn connect(
            &self,
            _delegate: AgentServerDelegate,
            _options: ConnectOptions,
        ) -> BoxFuture<'static, anyhow::Result<Arc<dyn AgentConnection>>> {
            let connection = Arc::new(RebindingNative {
                fresh_id: self.fresh_id,
            });
            async move { Ok(connection as Arc<dyn AgentConnection>) }.boxed()
        }

        fn into_any(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
            self
        }
    }

    /// Issue #56 (B1): the engine may answer a resume with a *different*
    /// session id than the stored one — its fresh-thread fallback for a
    /// pre-cutover row does exactly that. The row the user clicked must be
    /// rebound to the id the live feed will stamp on its events; otherwise the
    /// feed's first write mints a duplicate sidebar row and the original is
    /// orphaned on the dead id.
    #[tokio::test]
    async fn a_resume_that_comes_back_under_a_new_id_rebinds_the_row() {
        let native = Arc::new(RebindingNative {
            fresh_id: "engine-fresh-id",
        });
        let (host, dir) = fresh_host_with_native(native);
        let history = host.history().expect("a fresh host has history");

        let thread = atlas_thread_metadata::ThreadMetadata {
            session_id: Some(acp::SessionId::new("cersei-era-id")),
            ..atlas_thread_metadata::ThreadMetadata::new(
                atlas_thread_metadata::ThreadId::new(),
                CERSEI_AGENT_ID.into(),
                atlas_thread_metadata::PathList::new(&[PathBuf::from("/tmp/atlas")]),
            )
        };
        let thread_id = thread.thread_id;
        history.store().save_all(vec![thread]);

        let resumed = host.resume_thread(thread_id).await.expect("resume succeeds");
        assert_eq!(resumed.key.session_id, "engine-fresh-id");

        // The live feed's first write under the new id must land on the row
        // the user clicked, not mint a second one.
        history.record_connected(
            &atlas_acp_thread::AgentId::new(CERSEI_AGENT_ID),
            &acp::SessionId::new("engine-fresh-id"),
            atlas_thread_metadata::ThreadSnapshot {
                is_draft: false,
                title: None,
                work_dirs: vec![PathBuf::from("/tmp/atlas")],
            },
        );
        let rows = history.store().threads();
        assert_eq!(rows.len(), 1, "one conversation, one row");
        assert_eq!(rows[0].thread_id, thread_id);
        assert_eq!(
            rows[0].session_id,
            Some(acp::SessionId::new("engine-fresh-id"))
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The whole no-default-agents rule, checked at the only place that
    /// enforces it. A fresh install must offer exactly one agent, and every
    /// other id — including the ones the deleted `BUILTIN_AGENTS` table used to
    /// name — must be refused rather than downloaded, discovered or guessed.
    #[tokio::test]
    async fn a_fresh_install_can_run_only_the_native_agent() {
        let (host, dir) = fresh_host();

        let plugins = host.list_plugins();
        assert_eq!(plugins.len(), 1, "one agent, and it is the native one");
        assert_eq!(plugins[0].plugin_id, CERSEI_AGENT_ID);
        assert!(!plugins[0].external);

        assert!(matches!(host.agent_for(CERSEI_AGENT_ID), Ok(Agent::Native)));
        for id in ["claude-code-ts", "codex", "opencode", "cursor", "kilo"] {
            let err = host.agent_for(id).expect_err("{id} must not be runnable");
            // Fatal, not auth: signing in or retrying changes nothing, only
            // installing does.
            assert_eq!(err.class, ErrorClass::Fatal, "for {id}");
            assert!(err.message.contains("not installed"), "for {id}: {err}");
        }

        // Nothing has connected, so nothing is running and no capability is
        // claimed — capabilities only exist after `initialize`.
        assert!(host.list_agents().is_empty());
        let caps = host.capabilities(CERSEI_AGENT_ID);
        assert!(caps.auth_kinds.is_empty());
        assert!(!caps.supports_logout);
        // `session/fork` has no equivalent on the ported seam, so this is
        // false for every agent rather than optimistically true.
        assert!(!caps.supports_fork);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A history row is the user's record. An agent that cannot be reached,
    /// cannot be started, or has forgotten the conversation must leave it
    /// exactly as it found it — archived flag included.
    #[tokio::test]
    async fn a_resume_that_fails_changes_nothing_about_the_row() {
        let (host, dir) = fresh_host();
        let history = host.history().expect("a fresh host has history");
        let thread = atlas_thread_metadata::ThreadMetadata {
            session_id: Some(acp::SessionId::new("ses-1")),
            ..atlas_thread_metadata::ThreadMetadata::new(
                atlas_thread_metadata::ThreadId::new(),
                // Not installed: `spawn` will refuse, which is the most basic
                // way a resume fails.
                "an-uninstalled-agent".into(),
                atlas_thread_metadata::PathList::new(&[PathBuf::from("/tmp/atlas")]),
            )
        };
        let thread_id = thread.thread_id;
        history.store().save_all(vec![thread]);
        history.store().archive(thread_id);

        let error = host
            .resume_thread(thread_id)
            .await
            .expect_err("an agent that is not installed cannot be resumed");
        assert_eq!(error.class, ErrorClass::Fatal);

        let after = history.store().thread(thread_id).expect("the row survives");
        assert!(after.archived, "and it is still where the user left it");
        assert_eq!(after.session_id, Some(acp::SessionId::new("ses-1")));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Deleting is Atlas's own record going away. It cannot depend on an agent
    /// being installed, running, or willing.
    #[tokio::test]
    async fn deleting_a_row_never_depends_on_the_agent() {
        let (host, dir) = fresh_host();
        let history = host.history().expect("a fresh host has history");
        let thread = atlas_thread_metadata::ThreadMetadata {
            session_id: Some(acp::SessionId::new("ses-1")),
            ..atlas_thread_metadata::ThreadMetadata::new(
                atlas_thread_metadata::ThreadId::new(),
                "an-uninstalled-agent".into(),
                atlas_thread_metadata::PathList::new(&[PathBuf::from("/tmp/atlas")]),
            )
        };
        let thread_id = thread.thread_id;
        history.store().save_all(vec![thread]);

        host.delete_thread(thread_id).await.expect("delete is local");

        assert!(history.store().thread(thread_id).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Installing is writing one map entry — and that entry is the whole
    /// difference between "not there" and "runnable".
    #[tokio::test]
    async fn an_installed_map_entry_is_what_makes_an_agent_runnable() {
        let (host, dir) = fresh_host();
        assert!(host.agent_for("some-agent").is_err());

        let mut settings = atlas_agent_store::AllAgentServersSettings::default();
        settings.0.insert(
            "some-agent".to_string(),
            atlas_agent_store::AgentServerSettings::custom("/bin/echo", vec!["acp".into()]),
        );
        host.store().set_settings(settings).await;

        assert!(matches!(
            host.agent_for("some-agent"),
            Ok(Agent::Custom { .. })
        ));
        let ids: Vec<String> = host
            .list_plugins()
            .into_iter()
            .map(|plugin| plugin.plugin_id)
            .collect();
        assert_eq!(ids, [CERSEI_AGENT_ID, "some-agent"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Every session command has to reject an id it never bound, rather than
    /// answering about some other session.
    #[tokio::test]
    async fn commands_reject_a_session_that_was_never_opened() {
        let (host, dir) = fresh_host();
        let key = SessionKey {
            agent_id: AgentId::new(),
            session_id: "no-such-session".to_string(),
        };
        assert_eq!(
            host.snapshot_meta(&key).unwrap_err().class,
            ErrorClass::ProcessDead
        );
        assert!(host.snapshot(&key).is_err());
        assert!(host.send(&key, Vec::new()).is_err());
        // Cancel and drop are idempotent by design: a tab can close twice, and
        // a stop pressed after a turn ended must not raise.
        assert!(host.cancel(&key).is_ok());
        assert!(host.drop_session(&key.session_id).await.is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Only the NATIVE agent keeps a record Atlas can read. Every external
    /// one — Claude included, since Atlas stopped parsing `~/.claude/projects`
    /// (ADR-0001) — gets Atlas's own recording, which is what makes its history
    /// rows reopen at all.
    #[test]
    fn only_the_native_agent_keeps_its_own_readable_transcript() {
        assert_eq!(transcript_kind_for(CERSEI_AGENT_ID), TranscriptKind::CerseiJson);
        for id in [
            "claude-code-ts",
            "claude-code",
            "codex",
            "opencode",
            "some-registry-agent",
        ] {
            assert_eq!(transcript_kind_for(id), TranscriptKind::None, "{id}");
        }
    }

    #[test]
    fn an_absent_installed_map_reads_as_empty() {
        let dir = std::env::temp_dir().join(format!("atlas-installed-{}", Uuid::new_v4()));
        assert!(load_installed(&dir).0.is_empty());
    }

    #[test]
    fn the_installed_map_round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!("atlas-installed-{}", Uuid::new_v4()));
        let mut settings = atlas_agent_store::AllAgentServersSettings::default();
        settings.0.insert(
            "some-agent".to_string(),
            atlas_agent_store::AgentServerSettings::registry(),
        );
        save_installed(&dir, &settings).expect("the map is written");
        assert_eq!(load_installed(&dir), settings);

        // A corrupt file is an empty map, not a panic: a half-written install
        // must not make the app unable to list agents.
        std::fs::write(installed_map_path(&dir), "{ not json").unwrap();
        assert!(load_installed(&dir).0.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The wire shape is Zed's, verbatim — a map written by Zed reads here.
    #[test]
    fn the_installed_map_is_zeds_json() {
        let settings: atlas_agent_store::AllAgentServersSettings = serde_json::from_str(
            r#"{ "my-agent": { "type": "custom", "command": "~/bin/agent", "args": ["--acp"] },
                 "some-cli": { "type": "registry" } }"#,
        )
        .expect("Zed's shape");
        assert_eq!(settings.0.len(), 2);
        assert!(settings.has_registry_agents());
    }
}

/// A real host wired to a temp data dir, for tests that need one.
///
/// Shared with `commands::catalog` and `commands::registry`: those answer
/// questions *about* a host, and standing up the real thing is what makes the
/// answers worth anything — an empty installed map really is what a fresh
/// profile has.
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// A host with an empty installed map — a fresh install.
    pub(crate) fn fresh_host() -> (Arc<AgentHost>, PathBuf) {
        let dir = std::env::temp_dir().join(format!("atlas-host-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        struct Discard;
        impl DeltaSink for Discard {
            fn emit(&self, _envelope: atlas_agent_wire::SessionDeltaEnvelope) {}
        }
        // Offline by construction. A test must never depend on the registry
        // being reachable — `set_settings` refreshes the catalogue whenever the
        // map names a registry agent, and that would put a network round-trip
        // on the critical path of every assertion here.
        struct Offline;
        impl atlas_agent_store::HttpClient for Offline {
            fn get(
                &self,
                _url: &str,
            ) -> futures::future::BoxFuture<'static, anyhow::Result<atlas_agent_store::HttpResponse>>
            {
                use futures::FutureExt;
                async { Err(anyhow::anyhow!("offline in tests")) }.boxed()
            }
        }
        let http: Arc<dyn atlas_agent_store::HttpClient> = Arc::new(Offline);
        let registry = Arc::new(atlas_agent_store::AgentRegistryStore::new(
            dir.clone(),
            http.clone(),
        ));
        let store = Arc::new(AgentServerStore::new(
            dir.clone(),
            http,
            atlas_agent_store::NodeRuntime::unavailable("not needed in this test"),
            Arc::new(atlas_agent_store::InheritedProjectEnvironment),
            Some(registry.clone()),
        ));
        let host = AgentHost::new(Arc::new(Discard), dir.clone(), store, registry);
        (host, dir)
    }

    /// [`fresh_host`], but the native agent is the caller's scripted stand-in
    /// rather than the real engine.
    pub(crate) fn fresh_host_with_native(
        native: Arc<dyn AgentServer>,
    ) -> (Arc<AgentHost>, PathBuf) {
        let dir = std::env::temp_dir().join(format!("atlas-host-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        struct Discard;
        impl DeltaSink for Discard {
            fn emit(&self, _envelope: atlas_agent_wire::SessionDeltaEnvelope) {}
        }
        struct Offline;
        impl atlas_agent_store::HttpClient for Offline {
            fn get(
                &self,
                _url: &str,
            ) -> futures::future::BoxFuture<'static, anyhow::Result<atlas_agent_store::HttpResponse>>
            {
                use futures::FutureExt;
                async { Err(anyhow::anyhow!("offline in tests")) }.boxed()
            }
        }
        let http: Arc<dyn atlas_agent_store::HttpClient> = Arc::new(Offline);
        let registry = Arc::new(atlas_agent_store::AgentRegistryStore::new(
            dir.clone(),
            http.clone(),
        ));
        let store = Arc::new(AgentServerStore::new(
            dir.clone(),
            http,
            atlas_agent_store::NodeRuntime::unavailable("not needed in this test"),
            Arc::new(atlas_agent_store::InheritedProjectEnvironment),
            Some(registry.clone()),
        ));
        let host = AgentHost::with_native(Arc::new(Discard), dir.clone(), store, registry, native);
        (host, dir)
    }
}

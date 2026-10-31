//! The seam between the ACP stack and the `agents_*` command surface.
//!
//! [`AgentHost`] is what `commands/agents.rs` talks to. It owns the
//! [`AgentManager`], the [`DeltaProjector`] that turns thread events into the
//! session-delta wire, and the two pieces of bookkeeping the stack deliberately
//! does not do:
//!
//! 1. **Identity.** The frontend has always addressed an agent by a per-spawn
//!    `AgentId` (a uuid) and a session by `SessionKey { agent_id, session_id }`.
//!    The manager keys connections by [`Agent`] (`Native` or a stable
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
use atlas_agent_manager::{Agent, AgentConnectionEntry, AgentManager, ResumeMode};
use atlas_agent_servers::{
    AcpConnectionDefaults, AgentServer, ConnectOptions, SessionMcpOffer, SessionMcpRequest,
    SessionMcpServers,
};
use atlas_agent_store::{AgentRegistryStore, AgentServerStore, ExternalAgentSource};
use atlas_agent_transcript::TranscriptKind;
use atlas_agent_wire::{
    classify_message, AgentId, ErrorClass, Message, PlanEntry, SessionStatus, Usage,
};
use atlas_native_agent::ATLAS_AGENT_ID;
use atlas_thread_metadata::{
    affects_thread_metadata, collect_all_sessions, importable_threads, AttachSource,
    AttachedProject, MarkUnread, PathList, ProjectAccess, ThreadId, ThreadMetadata,
    ThreadMetadataStore, ThreadRecorder, ThreadSnapshot,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

mod open_turns;
mod wake;
pub use open_turns::OpenTurn;
pub use wake::{PendingWake, WakeSource};

// ── The IPC wire shapes ─────────────────────────────────────────────────────
//
// These moved out of `atlas-agents`. Field names and serde
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
    /// Models only: who makes it, as the agent stated it (the gateway's
    /// `publisher`, an ACP model group's name). Absent when unstated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Models only: newly released — the picker's "New" badge.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub is_new: bool,
    /// Models only: superseded but still served — folded under "Legacy models".
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub legacy: bool,
}

impl SessionModeInfo {
    /// A model row for the picker, from the seam's record.
    fn from_model(model: &atlas_acp_thread::AgentModelInfo) -> Self {
        Self {
            id: model.id.as_str().to_string(),
            name: model.name.to_string(),
            description: model.description.as_deref().map(str::to_string),
            provider: model.provider.as_deref().map(str::to_string),
            is_new: model.is_latest,
            legacy: model.legacy,
        }
    }
}

/// What the picker's Refresh got back (ADR-0007).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeModelsRefresh {
    /// The list, as the picker shows it.
    pub models: Vec<SessionModeInfo>,
    /// The first entitled row: what a new session starts on.
    pub default_model: String,
    /// Anything the user can see changed.
    pub changed: bool,
    /// The native connection was dropped so the engine picks up the new
    /// rows. Open native sessions were told, and rebind on their next send.
    pub reconnected: bool,
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
    /// The children this session delegated to, in launch order.
    ///
    /// Carried with the transcript, not separately: a subagent is read out of
    /// a tool call, so a snapshot that had the calls but not the subagents
    /// would show a reloaded session's delegated work as plain tool calls —
    /// live and reloaded views of one session disagreeing, which is the
    /// shape of ATL-224. Empty with `messages` for the metadata-only read.
    #[serde(default)]
    pub subagents: Vec<atlas_agent_delta::Subagent>,
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

/// How long the boot backfill waits on one agent's `session/list` import,
/// connect included. Longer than the transport's own `REQUEST_TIMEOUT` so a
/// slow-but-answering agent is not cut off by the outer clock first; an agent
/// that hits this is one whose connect is wedged, and it is tried again next
/// launch rather than marked done.
const BACKFILL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// How long the project sync waits on one agent, connect included. Far shorter
/// than [`BACKFILL_TIMEOUT`]: this runs every time the sidebar opens or the
/// window regains focus, so a wedged agent must cost the user seconds, not
/// minutes. It is simply tried again on the next trigger.
const SYNC_AGENT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// How long the project sync leaves an agent alone after it failed to
/// answer, doubling each time up to [`SYNC_BACKOFF_MAX`], and reset by one
/// answer.
///
/// Without this the per-agent timeout was a retry loop: the sync runs on
/// every window focus, so an agent that could not list its sessions cost the
/// user [`SYNC_AGENT_TIMEOUT`] of a held connection on every alt-tab, forever
/// — thirteen times in ten minutes in one log. The timeout bounds one
/// attempt; this bounds how often there is one.
const SYNC_BACKOFF_FIRST: std::time::Duration = std::time::Duration::from_secs(5 * 60);
const SYNC_BACKOFF_MAX: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// One agent's standing with the project sync after a failure.
#[derive(Debug, Clone, Copy)]
struct SyncBackoff {
    /// Not asked again before this.
    until: std::time::Instant,
    /// How long the next failure holds it off.
    next: std::time::Duration,
}

/// A project synced less than this long ago is not synced again.
///
/// The sidebar fires a sync on mount, on a cwd change and on every window
/// focus; this is what makes that cheap. Short enough that a session started in
/// a terminal is picked up by the next alt-tab back.
const SYNC_DEBOUNCE: std::time::Duration = std::time::Duration::from_secs(30);

/// How recent an agent-listed session must be to land active rather than on
/// the Settled shelf.
const SYNC_ACTIVE_DAYS: i64 = 7;

/// The recency window of ADR-0001 amendment Rule 5, as an instant: a session
/// the project sync lists with activity at or after it lands active; anything
/// older lands settled.
pub(crate) fn sync_active_cutoff(now: DateTime<Utc>) -> DateTime<Utc> {
    now - chrono::Duration::days(SYNC_ACTIVE_DAYS)
}

/// How long after one of Atlas's own turns ends a write to that session's
/// transcript is still put down to Atlas. An agent adapter (the Claude one, for
/// one) flushes its transcript a beat after the prompt response; that trailing
/// write is not another process.
const ATLAS_WRITE_SLACK: chrono::Duration = chrono::Duration::seconds(5);

/// Told when a session starts and when it ends — shared memory's sessions
/// table (`shared_memory::SharedMemoryStore`).
///
/// A session starts when it is bound (opened, loaded or resumed). It ends when
/// it is dropped, or when its agent's process exits: the connection announces
/// an exit on every live thread, and killing an agent or quitting the app ends
/// the process too. `ended` may be called for a session that already ended;
/// the implementation keeps it to one end.
pub trait SessionLifecycle: Send + Sync {
    /// `agent` is the durable plugin id (`atlas-agent` for the native agent).
    fn session_started(&self, session_id: &str, agent: &str, cwd: &str);
    fn session_ended(&self, session_id: &str);
}

/// The MCP servers every agent connection offers its sessions, installed after
/// the host exists (the memory tool server starts later in setup). Empty until
/// then: a session opened before it is installed is offered nothing.
#[derive(Default)]
struct SessionMcpSlot(Mutex<Option<Arc<dyn SessionMcpServers>>>);

impl SessionMcpServers for SessionMcpSlot {
    fn offer(&self, request: &SessionMcpRequest) -> SessionMcpOffer {
        atlas_agent_servers::session_mcp::offer_for(lock(&self.0).as_ref(), request)
    }

    fn describe_call(
        &self,
        call: atlas_agent_servers::CallToApprove<'_>,
    ) -> futures::future::BoxFuture<'static, Option<atlas_agent_servers::CallDescription>> {
        match lock(&self.0).as_ref() {
            Some(servers) => servers.describe_call(call),
            None => Box::pin(async { None }),
        }
    }

    fn approved_call(&self, call: atlas_agent_servers::CallToApprove<'_>) {
        if let Some(servers) = lock(&self.0).as_ref() {
            servers.approved_call(call);
        }
    }
}

pub struct AgentHost {
    manager: Arc<AgentManager>,
    projector: Arc<DeltaProjector>,
    store: Arc<AgentServerStore>,
    registry: Arc<AgentRegistryStore>,
    /// Atlas's config directory — what the native engine's home is derived
    /// from. Kept so the model-catalogue refresh can find the cache the
    /// connection reads (ADR-0007) without a connection being open.
    config_dir: PathBuf,
    agents: Mutex<HashMap<AgentId, AgentRecord>>,
    /// One uuid per plugin id, for the life of the process. The frontend spawns
    /// per tab and expects a stable handle back; the manager keeps one
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
    /// newer-epoch database. The failure is logged, history is unavailable,
    /// and the app still runs: losing the sidebar must not lose the agent.
    history: Option<ThreadRecorder>,
    /// What Atlas itself has been doing in each session, by session id: turns
    /// in flight and when the last one ended. This, not membership of
    /// [`AgentHost::sessions`], is what "Atlas is hosting it" means for the
    /// live-elsewhere rule (Rule 7). A session is bound the moment a sidebar
    /// row is opened, while a terminal may well still be writing it; only
    /// Atlas's own turns explain Atlas's own writes. Entries outlive the
    /// binding — a tab closed right after its turn still owns that turn's
    /// trailing write — and are a few bytes per session Atlas has prompted.
    activity: Mutex<HashMap<String, AtlasActivity>>,
    /// **Provisional** transcript aliases: on-disk session ids guessed to be
    /// another transcript of one of Atlas's own sessions, keyed by the alias.
    /// An ACP adapter may keep one ACP session id while writing its
    /// continuation to a transcript under a fresh id — the Claude adapter does
    /// exactly that when plan mode's "clear context" restarts its private
    /// conversation, and announces nothing on the wire. Without this the
    /// watcher saw "a new session", the sync imported it as a terminal one, it
    /// showed live elsewhere while Atlas was the writer, and opening it ran a
    /// second agent process on the same file.
    ///
    /// A guess lives here, in memory only, until the file's writes settle it
    /// ([`AgentHost::review_aliases`]): a write outside its owner's turns
    /// revokes it, a later owner turn that writes only the alias confirms it,
    /// and a confirmed alias moves to the history store, which persists it.
    /// Nothing provisional is ever written to disk.
    aliases: Mutex<HashMap<String, ProvisionalAlias>>,
    /// When each project directory was last synced, for the debounce in
    /// [`AgentHost::sync_project`]. In memory only: a restart syncing once more
    /// is the right behaviour.
    last_project_sync: Mutex<HashMap<String, std::time::Instant>>,
    /// Agents the project sync is leaving alone for a while, and until when
    /// — see [`SyncBackoff`].
    sync_backoff: Mutex<HashMap<String, SyncBackoff>>,
    /// Why `history` is `None`, carried into every history command's error so
    /// the sidebar can say it instead of reading as an empty list.
    history_error: Option<String>,
    /// The newest branch probe per session. Probes run on the blocking pool
    /// and can finish out of order; only the latest one for a session may
    /// write, so a slow earlier probe cannot overwrite a newer branch.
    branch_probes: Arc<Mutex<BranchProbes>>,
    /// Request-scoped elicitations, announced by every connection.
    ///
    /// These belong to no session — they are the ones raised during sign-in,
    /// before any session exists — so they cannot ride the session delta
    /// stream. The receiver is taken once, by the forwarder that turns them
    /// into `atlas:agent-elicitation`.
    request_elicitations: RequestElicitations,
    /// Where session start and end are recorded. Installed at startup; `None`
    /// until then (and in tests that do not care).
    lifecycle: Mutex<Option<Arc<dyn SessionLifecycle>>>,
    /// What each session is offered in its MCP server list.
    session_mcp: Arc<SessionMcpSlot>,
    /// Project access requests on screen, by (session, folder): each one's
    /// answer, once there is one. A second request for the same folder
    /// waits on the card already up instead of raising another.
    access_requests: Mutex<HashMap<(String, PathBuf), AccessAnswer>>,
    /// Prompts Atlas sends on its own (a pull request watch's wake), held
    /// until their session's turn ends ([`AgentHost::wake`]).
    wakes: wake::Wakes,
    /// Turns running now, on disk, so a launch after a quit or crash knows
    /// which to continue ([`AgentHost::take_left_open_turns`]).
    open_turns: open_turns::OpenTurns,
}

/// Where an access request's answer arrives.
type AccessAnswer = tokio::sync::watch::Receiver<Option<AccessRequestOutcome>>;

/// Which branch probe is the newest for each session (see
/// [`AgentHost::refresh_branch`]).
#[derive(Default)]
struct BranchProbes {
    next: u64,
    latest: HashMap<acp::SessionId, u64>,
}

impl BranchProbes {
    /// Number a new probe for `session_id`, making it the latest.
    fn start(&mut self, session_id: &acp::SessionId) -> u64 {
        self.next += 1;
        self.latest.insert(session_id.clone(), self.next);
        self.next
    }

    /// Retire `probe`, answering whether it may write: only the newest one
    /// started for its session may. The newest also clears the entry, so the
    /// map holds only sessions with a probe in flight.
    fn finish(&mut self, session_id: &acp::SessionId, probe: u64) -> bool {
        if self.latest.get(session_id) != Some(&probe) {
            return false;
        }
        self.latest.remove(session_id);
        true
    }
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
/// There is no longer a switch here. It existed so the previous native path could keep
/// shipping while the engine was proved (#45); that path is deleted
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
    // No model in this line: none is named in code (ADR-0007). The
    // connection logs the catalogue it resolved when it connects.
    tracing::info!(
        provider = %settings.provider.base_url,
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
        let (history, history_error) =
            match ThreadMetadataStore::open(atlas_thread_metadata::db_path(&config_dir)) {
                Ok(store) => (Some(ThreadRecorder::new(store)), None),
                Err(e) => {
                    tracing::error!(error = %e, "session history unavailable");
                    (None, Some(e.to_string()))
                }
            };
        let (elicitation_tx, elicitation_rx) = mpsc::unbounded_channel();
        let session_mcp = Arc::new(SessionMcpSlot::default());
        let options = ConnectOptions {
            session_mcp: Some(session_mcp.clone() as Arc<dyn SessionMcpServers>),
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
        let open_turns = open_turns::OpenTurns::load(config_dir.join("open-turns.json"));
        let host = Arc::new(Self {
            manager,
            projector,
            store,
            registry,
            config_dir,
            agents: Mutex::new(HashMap::new()),
            by_plugin: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            detected: Mutex::new(Vec::new()),
            history,
            activity: Mutex::new(HashMap::new()),
            aliases: Mutex::new(HashMap::new()),
            last_project_sync: Mutex::new(HashMap::new()),
            sync_backoff: Mutex::new(HashMap::new()),
            history_error,
            branch_probes: Arc::default(),
            request_elicitations: RequestElicitations {
                stream: Mutex::new(Some(elicitation_rx)),
                answered_by: Mutex::new(HashMap::new()),
            },
            lifecycle: Mutex::new(None),
            session_mcp,
            access_requests: Mutex::new(HashMap::new()),
            wakes: wake::Wakes::default(),
            open_turns,
        });
        // Weak, and installed after the host exists: the observer needs the
        // host to name the agent a session belongs to, and a strong reference
        // here would be a cycle that never drops.
        host.projector
            .observe_threads(Arc::new(HostObserver(Arc::downgrade(&host))));
        host
    }

    /// Install where session start and end are recorded.
    pub fn set_session_lifecycle(&self, lifecycle: Arc<dyn SessionLifecycle>) {
        *lock(&self.lifecycle) = Some(lifecycle);
    }

    /// Install what every agent's sessions are offered in `mcpServers` (the
    /// memory tool server).
    pub fn set_session_mcp(&self, servers: Arc<dyn SessionMcpServers>) {
        *lock(&self.session_mcp.0) = Some(servers);
    }

    fn lifecycle(&self) -> Option<Arc<dyn SessionLifecycle>> {
        lock(&self.lifecycle).clone()
    }

    /// Record the end of every session in `ended`.
    fn end_sessions(&self, ended: impl IntoIterator<Item = String>) {
        if let Some(lifecycle) = self.lifecycle() {
            for session_id in ended {
                lifecycle.session_ended(&session_id);
            }
        }
    }

    /// Remove every session `agent` owns from the session table, recording
    /// each one's end: the agent's process is going away with them.
    fn forget_sessions_of(&self, agent: &Agent) {
        let mut ended = Vec::new();
        lock(&self.sessions).retain(|session_id, session| {
            let keep = &session.agent != agent;
            if !keep {
                ended.push(session_id.clone());
            }
            keep
        });
        self.end_sessions(ended);
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

    /// Atlas's config directory, where the native agent's own settings live.
    pub fn config_dir(&self) -> &Path {
        &self.config_dir
    }

    // `native_sessions` and `native_delete_session` are gone with the previous native
    // runtime that owned those files (#54). They read a second, engine-private
    // session store; the engine keeps its own under a different shape,
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
        // First: the sweep below fails every running turn's send, and those
        // turns must stay recorded as cut short, not ended.
        self.open_turns.freeze();
        // The manager sweeps its own maps rather than being driven through
        // `connections()`, which yields only entries that reached `Connected`.
        // An agent still connecting is invisible to that list and is exactly
        // the one that spawns a child moments after the app decided to leave
        // (ATL-227, ATL-228).
        self.manager.shutdown();
        // Quitting ends every agent process, and with it every session.
        let ended: Vec<String> = lock(&self.sessions).drain().map(|(id, _)| id).collect();
        self.end_sessions(ended);
        // The projector holds each session's only strong thread handle, and
        // the thread holds the connection `Arc`. Left in place it pinned every
        // connection past both sweeps above, so no `Drop` ran and no child was
        // killed at quit — the app-servers from a launch two days earlier
        // (plan, diagnosis D). Cleared last: nothing may route to it after.
        self.projector.shutdown();
    }

    // ---- identity --------------------------------------------------------

    /// Which agent a plugin id names, if Atlas can run it at all.
    ///
    /// This is the whole of the no-default-agents rule: the native agent is
    /// always available because it is in-process, and any other id must appear
    /// in the installed map. Nothing is downloaded, discovered or guessed here.
    pub fn agent_for(&self, plugin_id: &str) -> Result<Agent> {
        let agent = self.installed_agent(plugin_id)?;
        // Turned off in Settings → Agents: still installed, never started.
        if self
            .store
            .settings()
            .get(plugin_id)
            .is_some_and(|entry| !entry.enabled())
        {
            return Err(HostError::new(
                format!("{plugin_id} is turned off. Turn it on in Settings → Agents."),
                ErrorClass::Fatal,
            ));
        }
        Ok(agent)
    }

    /// [`Self::agent_for`] without the on/off check: for what stops, inspects
    /// or restarts an agent, which a turned-off one still needs.
    fn installed_agent(&self, plugin_id: &str) -> Result<Agent> {
        if plugin_id == ATLAS_AGENT_ID {
            return Ok(Agent::Native);
        }
        let id = atlas_acp_thread::AgentId::new(plugin_id);
        if self.store.entry(&id).is_none() {
            return Err(HostError::new(
                format!("{plugin_id} is not installed. Add it in Settings → Agents."),
                ErrorClass::Fatal,
            ));
        }
        Ok(Agent::Custom { id })
    }

    fn plugin_id_of(agent: &Agent) -> String {
        match agent {
            Agent::Native => ATLAS_AGENT_ID.to_string(),
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
        if plugin_id == ATLAS_AGENT_ID {
            // `ATLAS_AGENT_ID` is a storage key every recorded thread resolves
            // through; the product name is what the user sees, and this is the
            // only place the two meet.
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
        let Ok(agent) = self.installed_agent(plugin_id) else {
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
            // Asked of the connection, not inferred from its concrete type.
            // `supports_fork` above still downcasts, and that is exactly the
            // identity check ADR-0002 rules out — a second one would entrench
            // it. Any connection that answers true here is offered the
            // affordance, native or not.
            supports_rewind: connection.supports_rewind(),
        }
    }

    // ---- lifecycle -------------------------------------------------------

    /// Connect to an agent, or join the connection already in flight.
    pub async fn spawn(&self, plugin_id: &str) -> Result<AgentInfo> {
        let agent = self.agent_for(plugin_id)?;
        // The bind lifecycle is logged at info on purpose: a session that never
        // opens shows up to the user only as a message parked in the composer
        // queue, and the terminal is the one place that can say which hop —
        // connect, or session/new — never came back.
        let started = std::time::Instant::now();
        tracing::info!(plugin_id, "agent connect requested");
        if let Err(err) = self.manager.connection(agent.clone()).await {
            tracing::warn!(plugin_id, elapsed_ms = started.elapsed().as_millis() as u64, %err, "agent connect failed");
            return Err(HostError::from(err));
        }
        tracing::info!(
            plugin_id,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "agent connected"
        );
        Ok(AgentInfo {
            agent_id: self.handle_for(&agent),
            display_name: self.display_name(plugin_id),
            spec_id: plugin_id.to_string(),
        })
    }

    /// Drop an agent's connection. The next spawn starts a fresh one.
    pub fn kill(&self, agent_id: AgentId) -> Result<()> {
        let record = self.record_for(agent_id)?;
        self.kill_agent(&record.plugin_id, &record.agent);
        Ok(())
    }

    /// [`Self::kill`], keyed by plugin id rather than by spawn handle.
    ///
    /// The escape hatch for a tab that never got a handle: a connect that has
    /// not answered has no `AgentInfo` to name it by, so the renderer's
    /// "cancel" button only has the plugin id it asked for. Works whether the
    /// connection is up, still connecting, or already gone.
    pub fn kill_plugin(&self, plugin_id: &str) -> Result<()> {
        let agent = self.installed_agent(plugin_id)?;
        self.kill_agent(plugin_id, &agent);
        Ok(())
    }

    fn kill_agent(&self, plugin_id: &str, agent: &Agent) {
        self.forget_request_elicitations(&ThreadAgentId::new(plugin_id));
        self.manager.drop_connection(agent);
        self.forget_sessions_of(agent);
    }

    /// Whether any open session on `plugin_id` has a turn running. `false` for
    /// an agent that is not installed.
    pub fn agent_turn_running(&self, plugin_id: &str) -> bool {
        let Ok(agent) = self.installed_agent(plugin_id) else {
            return false;
        };
        let sessions: Vec<String> = lock(&self.sessions)
            .iter()
            .filter(|(_, record)| record.agent == agent)
            .map(|(id, _)| id.clone())
            .collect();
        sessions.iter().any(|id| {
            self.thread(id)
                .is_ok_and(|handle| lock_thread(&handle).is_generating())
        })
    }

    /// Restart `plugin_id` so its next connect runs the version the registry
    /// now lists. The caller has waited for [`Self::agent_turn_running`] to
    /// clear — this never interrupts a reply.
    ///
    /// The same move as the native model refresh below: every open chat on
    /// the agent is told it is disconnected first, which is what lets the tab
    /// rebind (respawn + `session/load`) on its next send with its transcript
    /// intact. Dropping the connection without that left each tab holding a
    /// session nothing knew any more — its next message failed with "unknown
    /// session id".
    pub fn restart_for_update(&self, plugin_id: &str, version: &str) -> Result<()> {
        let agent = self.installed_agent(plugin_id)?;
        self.disconnect_chats(
            &agent,
            &format!("updated to v{version}; the next message reconnects"),
        );
        self.kill_agent(plugin_id, &agent);
        Ok(())
    }

    /// Stop an agent that was just turned off in Settings → Agents: its open
    /// chats are told why, and its process ends. Turning it back on lets the
    /// next message reconnect.
    pub fn turn_off(&self, plugin_id: &str) -> Result<()> {
        let agent = self.installed_agent(plugin_id)?;
        self.disconnect_chats(&agent, "turned off in Settings → Agents");
        self.kill_agent(plugin_id, &agent);
        Ok(())
    }

    /// `agent`'s process exited and the manager dropped its connection
    /// (`AgentManagerEvent::ConnectionExited`).
    ///
    /// The manager forgot the sessions; the host and the tabs still held
    /// them, so a tab's next message went to a session id the respawned agent
    /// had never heard of and failed with "unknown session id". The same
    /// notice as an update restart lets each tab rebind instead.
    pub fn agent_exited(&self, agent: &Agent) {
        let plugin_id = Self::plugin_id_of(agent);
        self.disconnect_chats(agent, "the agent stopped; the next message reconnects");
        self.forget_request_elicitations(&ThreadAgentId::new(plugin_id.as_str()));
        self.forget_sessions_of(agent);
    }

    /// Tell every open chat on `agent` it is disconnected, then close its
    /// projection: the tab rebinds (respawn + `session/load`) on its next send
    /// with its transcript intact.
    fn disconnect_chats(&self, agent: &Agent, reason: &str) {
        let sessions: Vec<String> = lock(&self.sessions)
            .iter()
            .filter(|(_, record)| &record.agent == agent)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &sessions {
            let session_id = acp::SessionId::new(id.as_str());
            self.projector.note_agent_disconnected(&session_id, reason);
            // The projection holds the session's only strong thread handle,
            // and through it the connection: left in place, the old process
            // outlives the restart until the tab closes — while the update
            // rewrites the `node_modules` it loads from. Closing it is what
            // lets the process go now. After the notice, which needs it.
            self.projector.close_session(&session_id);
        }
    }

    /// Drop the native agent's connection, if one is open.
    ///
    /// Sign-out calls this (#62): the engine's token cache lives on the
    /// connection and serves the access JWT until the JWT's own `exp` — the
    /// JWT verifies statelessly against JWKS, so revoking the session token
    /// does not invalidate it, and an open connection would keep making
    /// authenticated, org-billed gateway calls for up to ~9 minutes after
    /// the user signed out. Dropping the connection is what actually stops
    /// them: the cache dies with it, and so does any in-flight turn. The
    /// next spawn reconnects and mints fresh — or fails, honestly, now that
    /// there is nothing to mint with.
    pub fn drop_native_connection(&self) {
        self.forget_request_elicitations(&ThreadAgentId::new(ATLAS_AGENT_ID));
        self.manager.drop_connection(&Agent::Native);
        self.forget_sessions_of(&Agent::Native);
    }

    /// Re-fetch the native agent's model catalogue from the gateway
    /// (ADR-0007): the picker's Refresh.
    ///
    /// The fetcher is the app's — the gateway, over the registered token and
    /// org sources. [`Self::refresh_native_models_with`] is the same routine
    /// with the fetcher supplied, so a test can drive it against a fake.
    pub async fn refresh_native_models(&self) -> Result<NativeModelsRefresh> {
        use atlas_native_agent::engine::config::GATEWAY_BASE_URL;
        use atlas_native_agent::engine::GatewayCatalogueFetcher;
        let fetcher = GatewayCatalogueFetcher::registered(GATEWAY_BASE_URL);
        self.refresh_native_models_with(&fetcher).await
    }

    /// See [`Self::refresh_native_models`].
    ///
    /// Three outcomes, decided by comparing what the gateway now says with
    /// what the live engine loaded at connect:
    ///
    /// - **No live engine**: the cache is rewritten and the next spawn reads
    ///   it. Nothing to reconcile.
    /// - **Same fingerprint** (same slugs and context windows): labels swap
    ///   into the live connection. No teardown.
    /// - **Different fingerprint**: the engine loaded rows it will not reload,
    ///   and a slug it does not know gets invented metadata the gateway
    ///   `400`s. So the connection is dropped, exactly as sign-out drops it,
    ///   and every open native session is told so; the next spawn reconnects
    ///   on the fresh cache without a network round trip. A running turn
    ///   blocks this — the cache is already written, so nothing is lost by
    ///   asking the user to stop first.
    pub async fn refresh_native_models_with(
        &self,
        fetcher: &dyn atlas_native_agent::engine::CatalogueFetcher,
    ) -> Result<NativeModelsRefresh> {
        use atlas_native_agent::engine::catalog_cache::{project, refresh_now};
        use atlas_native_agent::engine::{EngineConnection, EngineHome, SystemClock};

        let home = EngineHome::under_config_dir(&self.config_dir);
        let cache = refresh_now(home.path(), fetcher, &SystemClock)
            .await
            .map_err(|err| HostError::classified(format!("could not refresh models: {err}")))?;
        let Some(projected) = project(&cache) else {
            // Written anyway: the next connect will refuse on the same
            // grounds, honestly, rather than run on the previous list.
            return Err(HostError::new(
                "the gateway lists no models this organization may use",
                ErrorClass::Fatal,
            ));
        };
        let models: Vec<SessionModeInfo> = projected
            .picker
            .iter()
            .map(SessionModeInfo::from_model)
            .collect();
        let default_model = projected.default_model.clone();

        let live = self
            .manager
            .connected(&Agent::Native)
            .and_then(<dyn AgentConnection>::downcast::<EngineConnection>);
        let Some(live) = live else {
            return Ok(NativeModelsRefresh {
                models,
                default_model,
                changed: true,
                reconnected: false,
            });
        };

        let before = live.catalogue_snapshot();
        if before.fingerprint == projected.fingerprint {
            let next = atlas_native_agent::engine::connection::LiveCatalogue {
                picker: projected.picker,
                default_model: projected.default_model,
                fingerprint: projected.fingerprint,
                fetched_at: cache.fetched_at,
                stale: false,
            };
            live.replace_catalogue_metadata(next)
                .map_err(HostError::from)?;
            let before_labels: Vec<(String, Option<String>)> = before
                .picker
                .iter()
                .map(|m| {
                    (
                        m.name.to_string(),
                        m.description.as_deref().map(str::to_string),
                    )
                })
                .collect();
            let after_labels: Vec<(String, Option<String>)> = models
                .iter()
                .map(|m| (m.name.clone(), m.description.clone()))
                .collect();
            let changed = before_labels != after_labels;
            return Ok(NativeModelsRefresh {
                models,
                default_model,
                changed,
                reconnected: false,
            });
        }

        let native_sessions: Vec<String> = lock(&self.sessions)
            .iter()
            .filter(|(_, record)| record.agent == Agent::Native)
            .map(|(id, _)| id.clone())
            .collect();
        let running = native_sessions.iter().any(|id| {
            self.thread(id)
                .is_ok_and(|handle| lock_thread(&handle).is_generating())
        });
        if running {
            return Err(HostError::new(
                "A turn is running. Stop it, then refresh models again — the new list applies at the next restart.",
                ErrorClass::Fatal,
            ));
        }
        for id in &native_sessions {
            self.projector.note_agent_disconnected(
                &acp::SessionId::new(id.as_str()),
                "the model list changed; restart to continue",
            );
        }
        self.drop_native_connection();
        Ok(NativeModelsRefresh {
            models,
            default_model,
            changed: true,
            reconnected: true,
        })
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
        let plugin_id = record.plugin_id.as_str();
        let started = std::time::Instant::now();
        tracing::info!(plugin_id, cwd = %cwd.display(), "session/new requested");
        let thread = match self
            .manager
            .new_session(record.agent.clone(), work_dirs)
            .await
        {
            Ok(thread) => thread,
            Err(err) => {
                tracing::warn!(plugin_id, elapsed_ms = started.elapsed().as_millis() as u64, %err, "session/new failed");
                return Err(HostError::from(err));
            }
        };
        tracing::info!(
            plugin_id,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "session/new opened"
        );
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
        // The row's attached projects, when it has a row: the same roots a
        // resume from the sidebar opens with.
        let row = self
            .history()
            .and_then(|history| history.store().thread_for_session(&acp_id));
        let attached = row
            .as_ref()
            .map(|row| row.attached_projects.clone())
            .unwrap_or_default();
        let mut work_dirs = vec![cwd.clone()];
        if let Some(row) = row.as_ref() {
            work_dirs.extend(Self::attached_work_dirs(row));
        }
        let thread = self
            .manager
            .load_session(record.agent.clone(), acp_id, work_dirs, None)
            .await
            .map_err(HostError::from)?;
        lock_thread(&thread).set_attached_roots(session_roots(&attached));
        self.bind(agent_id, &record, cwd, thread);
        if !attached.is_empty() {
            self.apply_session_roots(&session_id, &attached).await;
        }
        Ok(key)
    }

    /// Register a thread with the projector and the session table.
    ///
    /// Order matters: the projector is attached before anything else can touch
    /// the thread, because it drains the events buffered while `session/new`
    /// was still in flight — the replay that `session/load` produces lands
    /// there, and dropping it is the replay-loss bug this fixes.
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
        // a chat that emits no thread event would otherwise never appear at
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
        // After `record_connected`, which is what binds the session to its
        // row: the branch has somewhere to land by the time git answers.
        self.refresh_branch(&session_id, &cwd.to_string_lossy());
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
        if let Some(lifecycle) = self.lifecycle() {
            lifecycle.session_started(
                session_id.0.as_ref(),
                record.plugin_id.as_str(),
                &cwd.to_string_lossy(),
            );
        }
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
                    provider: None,
                    is_new: false,
                    legacy: false,
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
        self.end_sessions([session_id.to_string()]);
        // Only the live binding goes. The history row is the record of the
        // conversation and outlives the tab that showed it.
        if let Some(history) = self.history() {
            history.forget(&acp::SessionId::new(session_id));
        }
        // The projector holds the session's only strong thread handle, so
        // nothing else can release it — and its permission and elicitation
        // routes are keyed by wire request id with no other removal path
        // (ATL-225). Before `close_session` so the thread and its terminals are
        // dropped whether or not the agent's own close RPC succeeds.
        self.projector
            .close_session(&acp::SessionId::new(session_id));
        self.manager
            .close_session(&acp::SessionId::new(session_id))
            .await
            .map_err(HostError::from)
    }

    // ---- session reads ---------------------------------------------------

    /// Whether the session's agent advertised
    /// `promptCapabilities.embeddedContext` at initialize — the send path's
    /// choice between an embedded resource and a text block for a paste.
    pub fn prompt_embedded_context(&self, key: &SessionKey) -> Result<bool> {
        let handle = self.thread(&key.session_id)?;
        let embedded = lock_thread(&handle).prompt_capabilities().embedded_context;
        Ok(embedded)
    }

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
                // Grouped lists flatten: the composer's picker is one list. A
                // group's name is kept as each of its models' provider when the
                // model does not already state one — the picker's rail is
                // built on it.
                let models: Vec<atlas_acp_thread::AgentModelInfo> = match list {
                    atlas_acp_thread::AgentModelList::Flat(models) => models,
                    atlas_acp_thread::AgentModelList::Grouped(groups) => groups
                        .into_iter()
                        .flat_map(|(group, models)| {
                            models.into_iter().map(move |mut model| {
                                if model.provider.is_none() && !group.0.is_empty() {
                                    model.provider = Some(group.0.clone());
                                }
                                model
                            })
                        })
                        .collect(),
                };
                models.iter().map(SessionModeInfo::from_model).collect()
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
                cache_creation_tokens: usage.cache_write_tokens,
                cache_read_tokens: usage.cache_read_tokens,
                reasoning_tokens: usage.reasoning_tokens,
                cost: thread.cost().map(|cost| cost.amount).unwrap_or(0.0),
                currency: thread.cost().map(|cost| cost.currency.to_string()),
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
            subagents: if with_messages {
                // The snapshot's message ids are positional (`msg-{ix}`), and
                // `snapshot_messages` builds them the same way, so naming the
                // entry's own index here points at the same message.
                project::subagents(
                    &thread,
                    |ix| Some(format!("msg-{ix}")),
                    |ix| {
                        thread
                            .entry_created_at(ix)
                            .unwrap_or(created_at)
                            .timestamp_millis()
                    },
                )
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
        let (turn_seq, cwd) = {
            let mut sessions = lock(&self.sessions);
            let record = sessions
                .get_mut(&key.session_id)
                .ok_or_else(HostError::unknown_session)?;
            record.turn_seq = record.turn_seq.wrapping_add(1);
            (record.turn_seq, record.cwd.clone())
        };
        // Every turn start, not only the bind: the user may have switched
        // branches since the session opened, and the row should name the
        // branch the latest work ran on. The model likewise.
        self.refresh_branch(&session_id, &cwd);
        self.refresh_model(&session_id);
        // Before the turn opens, so the `status: running` that `begin_turn`
        // emits already carries this turn's identity.
        self.projector.set_turn_seq(&session_id, turn_seq);
        // Before the agent can write a byte of this turn to its transcript, so
        // the session watcher never mistakes that write for another process.
        self.begin_atlas_turn(&key.session_id);
        let thread = self
            .history()
            .and_then(|history| history.thread_for(&session_id));
        if let Some(thread) = thread {
            self.open_turns.begin(thread);
        }

        let this = self.clone();
        let session_key = key.session_id.clone();
        tauri::async_runtime::spawn(async move {
            let sent = this.manager.send(&session_id, content).await;
            // Every way out of the turn ends it, a superseded one included:
            // each send counted itself in, so each counts itself out.
            this.end_atlas_turn(&session_key);
            // A superseded turn's end must not write out the turn that
            // replaced it. A session closed meanwhile ended its turn with it.
            if let Some(thread) = thread {
                let superseded = lock(&this.sessions)
                    .get(&session_key)
                    .is_some_and(|record| record.turn_seq != turn_seq);
                if !superseded {
                    this.open_turns.end(thread);
                }
            }
            // A wake held for this turn goes out once the session is idle.
            this.drain_wakes_later(&session_key);
            if let Err(e) = sent {
                // A send that was superseded reports back late, and its failure
                // belongs to a turn that is already over. Announcing it anyway
                // stamps the error with whatever turn is current — so the
                // cancelled turn's error lands on the live one, and the chat
                // shows a failure for a turn that is still streaming. Same
                // omission as the thread's own turn guard one layer down
                // (ATL-229).
                if !this.is_current_turn(&session_key, turn_seq) {
                    tracing::debug!(
                        session = %session_id,
                        turn_seq,
                        "dropping a superseded turn's failure: {e:#}"
                    );
                    return;
                }
                let message = format!("{e:#}");
                let class = classify_message(&message);
                // A failure is a raised hand: a snoozed session wakes for it.
                if let Some(history) = this.history() {
                    history.note_failure(&session_id, Utc::now());
                }
                this.projector.note_turn_failed(
                    &session_id,
                    message,
                    Some(class.wire_token().to_string()),
                );
            }
        });
        Ok(())
    }

    /// The turns the last run left running, emptied from the record. Each is
    /// either continued (and recorded again when its turn starts) or let go.
    pub fn take_left_open_turns(&self) -> Vec<(ThreadId, OpenTurn)> {
        self.open_turns.take_left_open()
    }

    /// The next turn in `thread` continues one cut short by a restart, the
    /// `count`th in a row.
    pub fn expect_continuation(&self, thread: ThreadId, count: u32) {
        self.open_turns.expect_continuation(thread, count);
    }

    fn begin_atlas_turn(&self, session_id: &str) {
        let mut activity = lock(&self.activity);
        let entry = activity.entry(session_id.to_owned()).or_default();
        entry.in_flight += 1;
        entry.turns_started += 1;
    }

    fn end_atlas_turn(&self, session_id: &str) {
        let mut activity = lock(&self.activity);
        let entry = activity.entry(session_id.to_owned()).or_default();
        entry.in_flight = entry.in_flight.saturating_sub(1);
        entry.last_turn_end = Some(Utc::now());
    }

    /// What Atlas has been doing in each session it has prompted — the input
    /// the live-elsewhere rule and the session watcher read to tell Atlas's own
    /// transcript writes from another process's. An alias, provisional or
    /// confirmed, carries its owner's activity: its writes are the owner's
    /// turn.
    pub(crate) fn atlas_activity(&self) -> HashMap<String, AtlasActivity> {
        let mut activity = lock(&self.activity).clone();
        let mut aliases: Vec<(String, String)> = lock(&self.aliases)
            .iter()
            .map(|(alias, p)| (alias.clone(), p.owner.clone()))
            .collect();
        if let Some(history) = self.history() {
            aliases.extend(
                history
                    .store()
                    .session_aliases()
                    .into_iter()
                    .map(|(alias, owner)| (alias.to_string(), owner.to_string())),
            );
        }
        for (alias, owner) in aliases {
            if let Some(owned) = activity.get(&owner).copied() {
                activity.insert(alias, owned);
            }
        }
        activity
    }

    /// Settle provisional aliases against one watcher batch. `written` is
    /// every session id whose transcript moved in the batch, with its new
    /// time. Answers the aliases revoked, which the caller must now treat as
    /// unknown sessions — due a sync at once, and recomputed for liveness.
    ///
    /// Decided per alias by [`review_alias`], from activity and file times
    /// alone. A confirmed alias is handed to the history store, which
    /// persists it, and leaves this map; one whose owner has no row any more
    /// (deleted) is simply dropped.
    pub(crate) fn review_aliases(&self, written: &HashMap<String, DateTime<Utc>>) -> Vec<String> {
        let activity = lock(&self.activity).clone();
        let verdicts: Vec<(String, String, AliasVerdict)> = lock(&self.aliases)
            .iter()
            .filter_map(|(alias, p)| {
                let verdict = review_alias(
                    written.get(alias).copied(),
                    written.contains_key(&p.owner),
                    p.claimed_turn,
                    activity.get(&p.owner),
                );
                (verdict != AliasVerdict::Keep).then(|| (alias.clone(), p.owner.clone(), verdict))
            })
            .collect();
        let mut revoked = Vec::new();
        for (alias, owner, verdict) in verdicts {
            lock(&self.aliases).remove(&alias);
            if verdict == AliasVerdict::Revoke {
                tracing::info!(%alias, %owner, "transcript alias revoked: written outside Atlas's turn");
                revoked.push(alias);
                continue;
            }
            let recorded = self.history().is_some_and(|history| {
                history.store().record_session_alias(
                    &acp::SessionId::new(alias.as_str()),
                    &acp::SessionId::new(owner.as_str()),
                )
            });
            tracing::info!(%alias, %owner, recorded, "transcript alias confirmed");
        }
        revoked
    }

    /// Attribute a session id that just appeared on disk to one of Atlas's own
    /// turns, if one explains it. Answers whether `new_id` is (now) Atlas's.
    ///
    /// The session watcher asks this about every id it sees for the first
    /// time. The rule ([`alias_owner`]): an Atlas turn is in flight in a
    /// session whose own transcript is in the same directory (`on_disk`). The
    /// directory is per project and per storage format, so that is "same cwd,
    /// same kind of agent" read from what is on disk rather than from an agent
    /// id (ADR-0002). It is a guess, because the adapter that does this says
    /// nothing on the wire: a terminal session started in the same project
    /// during one of Atlas's turns is claimed too. So the claim is
    /// provisional, and [`AgentHost::review_aliases`] revokes it the first
    /// time that file is written outside its owner's turn.
    pub(crate) fn claim_for_atlas_turn(
        &self,
        new_id: &str,
        on_disk: &std::collections::HashSet<String>,
    ) -> bool {
        if lock(&self.aliases).contains_key(new_id) {
            return true;
        }
        let activity = lock(&self.activity).clone();
        let Some(owner) = alias_owner(new_id, on_disk, &activity) else {
            return false;
        };
        let claimed_turn = activity.get(&owner).map_or(0, |a| a.turns_started);
        tracing::info!(alias = new_id, %owner, "on-disk session provisionally attributed to an Atlas turn");
        lock(&self.aliases).insert(
            new_id.to_owned(),
            ProvisionalAlias {
                owner,
                claimed_turn,
            },
        );
        true
    }

    /// Read the git branch `cwd` is on and record it on the session's history
    /// row, off the async runtime.
    ///
    /// Fire-and-forget by design: a thread's branch is a label on a sidebar
    /// card, and neither binding a session nor sending a turn may wait on, or
    /// fail because of, a git process. A detached HEAD, a folder outside any
    /// repository, or git missing altogether all read as "no branch", and
    /// "no branch" writes nothing — the row keeps the last branch Atlas
    /// actually saw (or stays unknown). The store skips the write, and the
    /// sidebar event, when the branch has not changed.
    fn refresh_branch(&self, session_id: &acp::SessionId, cwd: &str) {
        if cwd.is_empty() {
            return;
        }
        let Some(history) = self.history().cloned() else {
            return;
        };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            tracing::debug!(%session_id, "no async runtime; thread branch not refreshed");
            return;
        };
        let session_id = session_id.clone();
        let cwd = PathBuf::from(cwd);
        let probes = Arc::clone(&self.branch_probes);
        let probe = lock(&probes).start(&session_id);
        // `Handle::spawn_blocking` is `tokio::task::spawn_blocking` on the
        // runtime we were called from; the handle is only how this stays a
        // no-op instead of a panic for a caller outside one.
        runtime.spawn_blocking(move || {
            let branch = atlas_checkpoint::git::current_branch(&cwd);
            // Checked and written under one lock, so a newer probe cannot
            // start and finish between the check and the write.
            let mut probes = lock(&probes);
            if !probes.finish(&session_id, probe) {
                return;
            }
            if let Some(branch) = branch {
                history.note_branch(&session_id, Arc::from(branch));
            }
        });
    }

    /// Read the model the session is on from its agent and record it on the
    /// history row, for the sidebar's hover card.
    ///
    /// Fire-and-forget, like [`Self::refresh_branch`]: the selector is async
    /// and may do work, and neither a send nor a model pick may wait on it.
    /// An agent with no model selection, or one that answers nothing, writes
    /// nothing — the row keeps the last model Atlas saw.
    fn refresh_model(&self, session_id: &acp::SessionId) {
        let Some(history) = self.history().cloned() else {
            return;
        };
        let Ok(handle) = self.thread(session_id.0.as_ref()) else {
            return;
        };
        let connection = lock_thread(&handle).connection().clone();
        let Some(selector) = connection.model_selector(session_id) else {
            return;
        };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let session_id = session_id.clone();
        runtime.spawn(async move {
            let Ok(model) = selector.selected_model().await else {
                return;
            };
            let id = model.id.as_str();
            // The native runtime names a session with no BYOK provider "/".
            if id.is_empty() || id == "/" {
                return;
            }
            let label: Arc<str> = if model.name.trim().is_empty() {
                Arc::from(id)
            } else {
                model.name.clone()
            };
            history.note_model(&session_id, label);
        });
    }

    /// Whether `turn_seq` is still the turn this session is running.
    ///
    /// A session that has since been dropped counts as not current: there is
    /// nothing left to announce a failure on.
    fn is_current_turn(&self, session_id: &str, turn_seq: u64) -> bool {
        lock(&self.sessions)
            .get(session_id)
            .is_some_and(|record| record.turn_seq == turn_seq)
    }

    pub fn cancel(&self, key: &SessionKey) -> Result<()> {
        self.manager
            .cancel(&acp::SessionId::new(key.session_id.as_str()));
        Ok(())
    }

    /// The user pressed Stop: cancel the turn, drop any wake held for the
    /// session, and end its pull request watches, so nothing Atlas sends on
    /// its own starts the agent straight back up. The order matters: the held
    /// wakes go first, so the cancelled turn's end finds none to send.
    pub fn stop(&self, key: &SessionKey) -> Result<()> {
        self.forget_wakes(&key.session_id);
        if let Some(history) = self.history() {
            if let Some(thread_id) =
                history.thread_for(&acp::SessionId::new(key.session_id.as_str()))
            {
                history.store().end_pull_request_watches(thread_id);
            }
        }
        self.cancel(key)
    }

    /// Cancel the turn without the user asking it to stop: the tab closed,
    /// the project is going away, a guide run was cancelled. Held wakes are
    /// dropped so the cancelled turn does not hand straight over to one, but
    /// the session's watches stay on — a watch outlives its tab, and the next
    /// thing it hears opens the session again.
    pub fn interrupt(&self, key: &SessionKey) -> Result<()> {
        self.forget_wakes(&key.session_id);
        self.cancel(key)
    }

    // ---- per-session settings -------------------------------------------

    pub async fn set_mode(&self, key: &SessionKey, mode_id: String) -> Result<()> {
        let session_id = acp::SessionId::new(key.session_id.as_str());
        let connection = lock_thread(&self.thread(&key.session_id)?)
            .connection()
            .clone();
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
        let connection = lock_thread(&self.thread(&key.session_id)?)
            .connection()
            .clone();
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
        self.refresh_model(&session_id);
        Ok(())
    }

    pub async fn set_config_option(
        &self,
        key: &SessionKey,
        config_id: String,
        value: serde_json::Value,
    ) -> Result<()> {
        let session_id = acp::SessionId::new(key.session_id.as_str());
        let connection = lock_thread(&self.thread(&key.session_id)?)
            .connection()
            .clone();
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

    /// Reasoning effort — a native-agent-only knob.
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

    // Tool-output compression is gone (#54). It was a knob on the old native
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
        // Lineage: the branch remembers where it came from, so the session
        // context overlay can show the parent and the forks.
        if let Some(history) = self.history() {
            history
                .store()
                .record_session_fork(&acp::SessionId::new(forked.as_str()), &session_id);
        }
        Ok(Some(forked))
    }

    /// Drop the last exchange and return the prompt that started it.
    ///
    /// The rewind half of a retry. `None` means "not retryable here" — either
    /// the agent is not the native one (no ACP agent has a rewind verb; the
    /// capability record in schema 1.5.0 has `fork`, `resume`, `list`,
    /// `delete` and `close`, and nothing that forgets turns) or the thread has
    /// no exchange left to drop. Callers re-send the returned text through the
    /// ordinary send path, so a rewind that lands and a send that fails are
    /// two outcomes the UI can tell apart.
    pub async fn rewind_last_turn(&self, key: &SessionKey) -> Result<Option<String>> {
        let session_id = acp::SessionId::new(key.session_id.as_str());
        let connection = lock_thread(&self.thread(&key.session_id)?)
            .connection()
            .clone();
        // Through the seam, not a downcast: an agent that grows a rewind gets
        // this for free, and nothing here names a concrete connection type.
        let Some(rewind) = connection.rewind(&session_id) else {
            return Ok(None);
        };
        rewind
            .run()
            .await
            .map_err(|e| HostError::classified(e.to_string()))
    }

    fn native_connection(
        &self,
        session_id: &str,
    ) -> Result<Arc<atlas_native_agent::EngineConnection>> {
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
        let key = self.projector.permission_key(&request_id).ok_or_else(|| {
            HostError::new("permission request is not pending", ErrorClass::Fatal)
        })?;
        let handle = self.thread(session_id)?;
        match decision {
            PermissionDecision::Selected { option_id } => {
                // The option's kind decides what the thread does with the tool
                // call, so it is read back off the pending request rather than
                // trusted from the frontend.
                let kind = pending_option_kind(&handle, &key.tool_call_id, &option_id).ok_or_else(
                    || HostError::new("permission option is not offered", ErrorClass::Fatal),
                )?;
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
            let store = store
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
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
            let store = store
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
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
            let mut store = store
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
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
    /// One action: the agent is started if it is not running, the
    /// session is reopened through whichever of `session/load` /
    /// `session/resume` the agent advertised. Opening moves the session
    /// between no lifecycle states — a settled one stays settled until the
    /// user sends — and marking it viewed is the frontend's, on focus. A row
    /// whose thread never got a session id is a draft, and opens as a new
    /// conversation.
    ///
    /// A failure leaves the row exactly as it was: nothing here writes it
    /// before the session is open. Atlas never deletes a
    /// history row because an agent could not reopen it — the user's record is
    /// theirs to remove.
    ///
    /// An agent that rejects the reopen because the user is not signed in comes
    /// back classified as `auth`, which is what routes the frontend into the
    /// sign-in flow, reached through the message
    /// classification Atlas already has rather than a typed downcast.
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
        let mut work_dirs = thread.folder_paths().paths().to_vec();
        let cwd = work_dirs.first().cloned().unwrap_or_default();
        // The session's read-write attached projects open with it as further
        // working directories: an ACP agent's `additionalDirectories`, the
        // engine's writable roots. Read-only ones reach Atlas's own grants
        // below and the agent through the prompt, never as a directory it
        // may edit.
        work_dirs.extend(Self::attached_work_dirs(&thread));

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

        // Before `bind`, whose history write reads the thread's own folders:
        // the attached projects must already be known as attached.
        lock_thread(&opened).set_attached_roots(session_roots(&thread.attached_projects));
        let init = self.bind(agent.agent_id, &record, cwd, opened);
        if !thread.attached_projects.is_empty() {
            self.apply_session_roots(&init.key.session_id, &thread.attached_projects)
                .await;
        }
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
    /// error, and the row is gone either way.
    ///
    /// Deleting the row of a conversation that is **still open** removes it
    /// now, and its next message puts it back under the same thread id — the
    /// live feed keeps its binding on purpose. That is the honest
    /// behaviour: history records conversations, and this one has not
    /// finished. Settle is the action for "out of my way but keep it".
    ///
    /// Deleting a session that is **live elsewhere** (Rule 7 — another
    /// process, typically `claude` in a terminal, is writing it now) is
    /// refused outright. The agent-side delete would remove the transcript out
    /// from under that process. `modified` is the session watcher's file times,
    /// the same input the sidebar's dot is computed from, so the refusal and
    /// the dot agree.
    ///
    /// The delete is durable against re-import: the store records the session
    /// as deleted, and no sync, backfill or manual import brings it back even
    /// when the agent could not forget it.
    pub async fn delete_thread(
        &self,
        thread_id: ThreadId,
        modified: &HashMap<String, DateTime<Utc>>,
    ) -> Result<()> {
        let history = self.history_or_err()?;
        let Some(thread) = history.store().thread(thread_id) else {
            return Ok(());
        };
        if let Some(session_id) = thread.session_id.as_ref() {
            let id = session_id.0.as_ref();
            if live_elsewhere(
                modified.get(id).copied(),
                self.atlas_activity().get(id),
                Utc::now(),
            ) {
                return Err(HostError::new(
                    "This session is still active in another process; close it there first.",
                    ErrorClass::Fatal,
                ));
            }
        }
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
    /// threads (ADR-0001), and this used to return all of them. That
    /// would suit a window that IS the project; Atlas switches projects
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
    pub fn thread_projects(
        &self,
        cwd: Option<&str>,
        modified: &HashMap<String, DateTime<Utc>>,
    ) -> Result<Vec<ThreadProjectWire>> {
        let projects = self.history_or_err()?.store().projects();
        let live = self.live_context(modified);

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
                    threads: project
                        .threads
                        .iter()
                        .map(|t| thread_row(t, &live))
                        .collect(),
                }
            })
            .collect())
    }

    /// Every thread, newest-started first — the history view.
    pub fn thread_history(
        &self,
        modified: &HashMap<String, DateTime<Utc>>,
    ) -> Result<Vec<ThreadRow>> {
        let live = self.live_context(modified);
        Ok(self
            .history_or_err()?
            .store()
            .history()
            .iter()
            .map(|t| thread_row(t, &live))
            .collect())
    }

    /// Snapshot what `thread_row` needs to decide `live_elsewhere`: the
    /// watcher's file times, what Atlas's own turns have been doing, and the
    /// clock. The watcher is passed in rather than held, since it already
    /// holds the host.
    fn live_context<'a>(&self, modified: &'a HashMap<String, DateTime<Utc>>) -> LiveContext<'a> {
        LiveContext {
            modified,
            activity: self.atlas_activity(),
            now: Utc::now(),
            forks: self
                .history()
                .map(|history| {
                    history
                        .store()
                        .session_forks()
                        .into_iter()
                        .map(|(child, parent)| (child.to_string(), parent.to_string()))
                        .collect()
                })
                .unwrap_or_default(),
        }
    }

    /// Move a session to the sidebar's Settled shelf.
    ///
    /// Refused while a turn is running there — in Atlas, or in another
    /// process — or the agent is waiting on the user: a session that is
    /// mid-work is not done, and settling it would hide the very thing about
    /// to need attention. Also refused just after a user send: the send
    /// records the interaction before the turn is counted in, and the store
    /// re-checks that under its lock, so a settle racing a send cannot slip
    /// through the gap.
    ///
    /// `activity_in` answers, for one of the row's folders, the file times
    /// that are evidence of another process ([`ActivityIn`]). It is asked for
    /// this row's own folders, not whichever project the sidebar has open:
    /// a row from another project is live or not by its own transcripts. A
    /// folder with no answer is no evidence either way; by hand, the user's
    /// word stands.
    ///
    /// Answers whether the session moved; `false` when it was already settled
    /// or no longer exists.
    pub fn settle_thread(&self, thread_id: ThreadId, activity_in: ActivityIn<'_>) -> Result<bool> {
        let history = self.history_or_err()?;
        let Some(thread) = history.store().thread(thread_id) else {
            return Ok(false);
        };
        if let Some(session_id) = thread.session_id.as_ref() {
            let id = session_id.0.as_ref();
            let activity = self.atlas_activity();
            let modified = thread
                .folder_paths()
                .paths()
                .iter()
                .filter_map(|folder| activity_in(folder))
                .filter_map(|times| times.get(id).copied())
                .max();
            if history.store().sent_to_recently(thread_id)
                || self.session_is_busy(id, &activity)
                || live_elsewhere(modified, activity.get(id), Utc::now())
            {
                return Err(HostError::new(
                    "This session is still running; settle it once the turn ends.",
                    ErrorClass::Fatal,
                ));
            }
        }
        Ok(history.store().settle(thread_id))
    }

    /// Take a session back off the Settled shelf. Answers whether it was on
    /// it.
    pub fn unsettle_thread(&self, thread_id: ThreadId) -> Result<bool> {
        Ok(self.history_or_err()?.store().unsettle(thread_id))
    }

    /// Pin a session, placed among the pinned by `order_key` (minted by the
    /// frontend). Brings a settled or snoozed one back. Answers whether
    /// anything changed.
    pub fn pin_thread(&self, thread_id: ThreadId, order_key: Option<String>) -> Result<bool> {
        Ok(self
            .history_or_err()?
            .store()
            .pin(thread_id, order_key.map(Arc::from)))
    }

    pub fn unpin_thread(&self, thread_id: ThreadId) -> Result<bool> {
        Ok(self.history_or_err()?.store().unpin(thread_id))
    }

    /// Move a pinned session to `order_key`. `false` for one not pinned.
    pub fn reorder_pinned_thread(&self, thread_id: ThreadId, order_key: String) -> Result<bool> {
        Ok(self
            .history_or_err()?
            .store()
            .reorder_pin(thread_id, Arc::from(order_key)))
    }

    /// Snooze a session until `until`.
    ///
    /// Refused while the session has a pending request — a permission or a
    /// question the user has not answered: snoozing would hide the very thing
    /// waiting on them, and it would wake straight away regardless. Refused
    /// too for a time not in the future. Answers whether it snoozed (`false`
    /// for a session that no longer exists).
    pub fn snooze_thread(&self, thread_id: ThreadId, until: DateTime<Utc>) -> Result<bool> {
        let history = self.history_or_err()?;
        let Some(thread) = history.store().thread(thread_id) else {
            return Ok(false);
        };
        if until <= Utc::now() {
            return Err(HostError::new(
                "Pick a time in the future to snooze until.",
                ErrorClass::Fatal,
            ));
        }
        if thread
            .session_id
            .as_ref()
            .is_some_and(|id| self.session_has_pending_request(id.0.as_ref()))
        {
            return Err(HostError::new(
                "This session is waiting for you; answer it before snoozing.",
                ErrorClass::Fatal,
            ));
        }
        Ok(history.store().snooze(thread_id, until))
    }

    /// The user renamed the session. An empty name clears the rename, so the
    /// agent's own title shows again.
    pub fn rename_thread(&self, thread_id: ThreadId, title: &str) -> Result<()> {
        self.history_or_err()?
            .store()
            .set_title_override(thread_id, title.trim().to_owned());
        Ok(())
    }

    /// Wake a snoozed session by hand. Answers whether it was snoozed.
    pub fn wake_thread(&self, thread_id: ThreadId) -> Result<bool> {
        Ok(self.history_or_err()?.store().wake(thread_id))
    }

    /// Undo a snooze the user just set, leaving no "woke" mark. Answers
    /// whether it was snoozed.
    pub fn unsnooze_thread(&self, thread_id: ThreadId) -> Result<bool> {
        Ok(self.history_or_err()?.store().unsnooze(thread_id))
    }

    /// The user opened or focused the session the tab `session_id` runs.
    /// Answers whether a row was marked (a draft has none).
    pub fn mark_session_viewed(&self, session_id: &str) -> Result<bool> {
        Ok(self
            .history_or_err()?
            .note_viewed(&acp::SessionId::new(session_id), Utc::now()))
    }

    /// Make a session read as unread again. Refused for one with no
    /// completed turn — there is nothing to be unread.
    pub fn mark_thread_unread(&self, thread_id: ThreadId) -> Result<bool> {
        match self.history_or_err()?.store().mark_unread(thread_id) {
            MarkUnread::Marked => Ok(true),
            MarkUnread::AlreadyUnread | MarkUnread::Missing => Ok(false),
            MarkUnread::NoCompletedTurn => Err(HostError::new(
                "This session has no finished turn to mark unread.",
                ErrorClass::Fatal,
            )),
        }
    }

    // ---- attached projects -----------------------------------------------

    /// The history row a live session writes to. A draft is found through
    /// its binding: its session id is never persisted.
    fn row_for_session(&self, session_id: &str) -> Result<ThreadId> {
        self.history_or_err()?
            .thread_for(&acp::SessionId::new(session_id))
            .ok_or_else(|| HostError::new("This session has no history row.", ErrorClass::Fatal))
    }

    /// The projects attached to the session the tab `session_id` runs.
    pub fn session_projects(&self, session_id: &str) -> Result<Vec<AttachedProject>> {
        let thread_id = self.row_for_session(session_id)?;
        Ok(self.history_or_err()?.store().attached_projects(thread_id))
    }

    /// Attach `project` to the session, then hand the session its new roots.
    /// Already attached is not an error: nothing changes, and the change
    /// reports `changed: false`.
    pub async fn attach_session_project(
        &self,
        session_id: &str,
        project: AttachedProject,
    ) -> Result<SessionProjectsChange> {
        let thread_id = self.row_for_session(session_id)?;
        let changed = self
            .history_or_err()?
            .store()
            .attach_project(thread_id, project);
        self.projects_changed(session_id, thread_id, changed).await
    }

    /// Detach the project at `path` from the session.
    pub async fn detach_session_project(
        &self,
        session_id: &str,
        path: &Path,
    ) -> Result<SessionProjectsChange> {
        let thread_id = self.row_for_session(session_id)?;
        let changed = self
            .history_or_err()?
            .store()
            .detach_project(thread_id, path);
        self.projects_changed(session_id, thread_id, changed).await
    }

    /// Change what the agent may do in the project at `path`.
    pub async fn set_session_project_access(
        &self,
        session_id: &str,
        path: &Path,
        access: ProjectAccess,
    ) -> Result<SessionProjectsChange> {
        let thread_id = self.row_for_session(session_id)?;
        let changed = self
            .history_or_err()?
            .store()
            .set_project_access(thread_id, path, access);
        self.projects_changed(session_id, thread_id, changed).await
    }

    async fn projects_changed(
        &self,
        session_id: &str,
        thread_id: ThreadId,
        changed: bool,
    ) -> Result<SessionProjectsChange> {
        let projects = self.history_or_err()?.store().attached_projects(thread_id);
        let applied_live = if changed {
            self.apply_session_roots(session_id, &projects).await
        } else {
            self.live_roots_supported(session_id)
        };
        Ok(SessionProjectsChange {
            projects: projects.iter().map(AttachedProjectWire::from).collect(),
            changed,
            applied_live,
        })
    }

    /// Whether the session's agent can change an open session's roots — the
    /// capability the UI reads to say "from the next turn" or "when this
    /// session is resumed". `false` for a session that is not open.
    pub fn live_roots_supported(&self, session_id: &str) -> bool {
        self.thread(session_id)
            .map(|handle| {
                lock_thread(&handle)
                    .connection()
                    .supports_live_session_roots()
            })
            .unwrap_or(false)
    }

    /// Hand an open session the roots its attached projects call for.
    ///
    /// Two halves. Atlas's own grants first, on the thread: the client-side
    /// `fs/*` handlers read and write through them, for every agent. Then the
    /// agent's sandbox, where the connection can change it on a live session
    /// (the native engine can; ACP has no request for it). Answers whether
    /// the agent's half landed. Bounded (ADR-0008): a wedged engine leaves
    /// the attachment recorded and reported as not applied, rather than
    /// parking the command.
    async fn apply_session_roots(&self, session_id: &str, projects: &[AttachedProject]) -> bool {
        let Ok(handle) = self.thread(session_id) else {
            return false;
        };
        let roots = session_roots(projects);
        let connection = {
            let mut thread = lock_thread(&handle);
            thread.set_attached_roots(roots.clone());
            thread.connection().clone()
        };
        if !connection.supports_live_session_roots() {
            return false;
        }
        let update = connection.update_session_roots(&acp::SessionId::new(session_id), roots);
        match tokio::time::timeout(ROOTS_UPDATE_TIMEOUT, update).await {
            Ok(Ok(())) => true,
            Ok(Err(e)) => {
                tracing::warn!(session_id, "attached project roots not applied: {e}");
                false
            }
            Err(_) => {
                tracing::warn!(session_id, "attached project roots timed out");
                false
            }
        }
    }

    /// The read-write attached projects of a row, as extra working
    /// directories to open its session with — how they reach an ACP agent's
    /// `additionalDirectories` and the native engine's writable roots at
    /// start. Read-only ones are not among them: an agent's additional
    /// directory is one it may edit.
    fn attached_work_dirs(row: &ThreadMetadata) -> Vec<PathBuf> {
        row.attached_projects
            .iter()
            .filter(|p| p.access.is_writable() && !row.references_folder_path(&p.path))
            .map(|p| p.path.clone())
            .collect()
    }

    /// Ask the user, in the session, to let its agent use `path`.
    ///
    /// The request appears where every permission request does, as the
    /// approval card. `wait` bounds how long the caller is kept: past it the
    /// answer is [`AccessRequestOutcome::Pending`] and the card stays up —
    /// an approval that comes later still attaches the project, for the
    /// agent's next look. A second request for the same path while one is
    /// up waits on the same card rather than raising another.
    pub async fn request_project_access(
        self: &Arc<Self>,
        session_id: &str,
        request: ProjectAccessRequest,
        wait: std::time::Duration,
    ) -> Result<AccessRequestOutcome> {
        let thread_id = self.row_for_session(session_id)?;
        if let Some(existing) = self
            .history_or_err()?
            .store()
            .attached_projects(thread_id)
            .into_iter()
            .find(|p| p.path == request.path)
        {
            if existing.access == ProjectAccess::ReadWrite || existing.access == request.access {
                return Ok(AccessRequestOutcome::AlreadyGranted(existing.access));
            }
        }

        let key = (session_id.to_string(), request.path.clone());
        let mut rx = {
            let mut pending = lock(&self.access_requests);
            pending.retain(|_, rx| rx.borrow().is_none());
            match pending.get(&key) {
                Some(rx) => rx.clone(),
                None => {
                    let rx = self.raise_access_card(session_id, thread_id, request)?;
                    pending.insert(key, rx.clone());
                    rx
                }
            }
        };
        let decided = tokio::time::timeout(wait, rx.wait_for(Option::is_some)).await;
        match decided {
            Ok(Ok(value)) => Ok(value.clone().unwrap_or(AccessRequestOutcome::Denied)),
            // The card went away without an answer (the session closed).
            Ok(Err(_)) => Ok(AccessRequestOutcome::Denied),
            Err(_) => Ok(AccessRequestOutcome::Pending),
        }
    }

    /// Put the access request on the session's thread as an approval card,
    /// and start the task that acts on the answer.
    fn raise_access_card(
        self: &Arc<Self>,
        session_id: &str,
        thread_id: ThreadId,
        request: ProjectAccessRequest,
    ) -> Result<AccessAnswer> {
        let handle = self.thread(session_id)?;
        let tool_call_id = acp::ToolCallId::new(format!("atlas-project-access-{}", Uuid::new_v4()));
        let mut fields = acp::ToolCallUpdateFields::default();
        fields.kind = Some(if request.access.is_writable() {
            acp::ToolKind::Edit
        } else {
            acp::ToolKind::Read
        });
        fields.title = Some(access_card_title(&request));
        fields.content = Some(vec![acp::ToolCallContent::Content(acp::Content::new(
            acp::ContentBlock::Text(acp::TextContent::new(access_card_body(&request))),
        ))]);
        fields.locations = Some(vec![acp::ToolCallLocation::new(request.path.clone())]);
        let mut options = Vec::new();
        if request.access.is_writable() {
            options.push(acp::PermissionOption::new(
                ACCESS_OPTION_WRITE,
                "Allow read and write",
                acp::PermissionOptionKind::AllowOnce,
            ));
        }
        options.push(acp::PermissionOption::new(
            ACCESS_OPTION_READ,
            "Allow read-only",
            acp::PermissionOptionKind::AllowOnce,
        ));
        options.push(acp::PermissionOption::new(
            ACCESS_OPTION_DENY,
            "Deny",
            acp::PermissionOptionKind::RejectOnce,
        ));
        let waiter = lock_thread(&handle)
            .request_tool_call_authorization(
                acp::ToolCallUpdate::new(tool_call_id.clone(), fields),
                atlas_acp_thread::PermissionOptions::Flat(options),
                atlas_acp_thread::AuthorizationKind::PermissionGrant,
            )
            .map_err(|e| HostError::new(e.to_string(), ErrorClass::Fatal))?;

        let (tx, rx) = tokio::sync::watch::channel(None);
        let host = Arc::downgrade(self);
        let session_id = session_id.to_string();
        tokio::spawn(async move {
            let outcome = waiter.await;
            let granted = match &outcome {
                atlas_acp_thread::RequestPermissionOutcome::Selected(sel)
                    if matches!(
                        sel.option_kind,
                        acp::PermissionOptionKind::AllowOnce
                            | acp::PermissionOptionKind::AllowAlways
                    ) =>
                {
                    Some(if sel.option_id.0.as_ref() == ACCESS_OPTION_WRITE {
                        ProjectAccess::ReadWrite
                    } else {
                        ProjectAccess::ReadOnly
                    })
                }
                // A rejection, a cancel (Esc), or the turn moving on without
                // an answer: none of them is the user granting anything.
                _ => None,
            };
            let result = match (granted, host.upgrade()) {
                (Some(access), Some(host)) => {
                    match host
                        .grant_project_access(&session_id, thread_id, &request, access)
                        .await
                    {
                        Ok(applied_live) => AccessRequestOutcome::Granted {
                            access,
                            applied_live,
                        },
                        Err(e) => {
                            tracing::warn!(session_id, "access granted but not recorded: {e}");
                            AccessRequestOutcome::Denied
                        }
                    }
                }
                _ => AccessRequestOutcome::Denied,
            };
            // Shown on the card's tool call, for the transcript.
            if let Some(host) = host.upgrade() {
                if let Ok(handle) = host.thread(&session_id) {
                    let mut fields = acp::ToolCallUpdateFields::default();
                    fields.status = Some(match result {
                        AccessRequestOutcome::Granted { .. } => acp::ToolCallStatus::Completed,
                        _ => acp::ToolCallStatus::Failed,
                    });
                    let _ = lock_thread(&handle)
                        .update_tool_call(acp::ToolCallUpdate::new(tool_call_id, fields));
                }
            }
            let _ = tx.send(Some(result));
        });
        Ok(rx)
    }

    /// The user approved: attach the project at the granted access (or raise
    /// an attached one to it), and widen the session's roots.
    async fn grant_project_access(
        &self,
        session_id: &str,
        thread_id: ThreadId,
        request: &ProjectAccessRequest,
        access: ProjectAccess,
    ) -> Result<bool> {
        let store = self.history_or_err()?.store().clone();
        let attached = store.attach_project(
            thread_id,
            AttachedProject::new(
                request.path.clone(),
                request.display_name.clone(),
                access,
                AttachSource::AgentRequest,
            ),
        );
        if !attached {
            store.set_project_access(thread_id, &request.path, access);
        }
        let projects = store.attached_projects(thread_id);
        Ok(self.apply_session_roots(session_id, &projects).await)
    }

    /// Whether Atlas has work in flight in this session: a turn it sent that
    /// has not come back, a turn the thread reports running, or a permission
    /// or elicitation the user has not answered.
    fn session_is_busy(&self, session_id: &str, activity: &HashMap<String, AtlasActivity>) -> bool {
        if activity.get(session_id).is_some_and(|a| a.in_flight > 0) {
            return true;
        }
        let Ok(handle) = self.thread(session_id) else {
            return false;
        };
        let generating = lock_thread(&handle).is_generating();
        generating || self.session_has_pending_request(session_id)
    }

    /// Whether the session is waiting on the user: a permission request or a
    /// question (elicitation) not yet answered. A session Atlas is not
    /// hosting has none it could know of.
    fn session_has_pending_request(&self, session_id: &str) -> bool {
        let Ok(handle) = self.thread(session_id) else {
            return false;
        };
        let thread = lock_thread(&handle);
        thread.elicitations().elicitations().iter().any(|e| {
            matches!(
                e.status,
                atlas_acp_thread::ElicitationStatus::Pending { .. }
            )
        }) || thread.entries().iter().any(|entry| {
            matches!(
                entry,
                atlas_acp_thread::AgentThreadEntry::ToolCall(call)
                    if matches!(
                        call.status,
                        atlas_acp_thread::ToolCallStatus::WaitingForConfirmation { .. }
                    )
            )
        })
    }

    /// Settle every session idle for longer than `idle`, skipping any that is
    /// busy in Atlas ([`Self::session_is_busy`]: a running turn or a pending
    /// request) or live in another process. The store applies the rest of
    /// the rule (already settled, pinned, snoozed, un-settled since its last
    /// activity) under its own lock. Answers how many were settled.
    ///
    /// Liveness elsewhere is judged per candidate from its own folders'
    /// transcripts ([`ActivityIn`]), asked once per folder. The sweep covers
    /// every project, while the session watcher only watches the open one;
    /// reading only the watcher's times would take "nothing recorded" for
    /// "quiet" and settle a session a terminal is using in another project.
    /// A candidate any of whose folders cannot be answered for is skipped:
    /// the sweep never settles a session it could not check.
    #[cfg(test)]
    pub fn auto_settle_idle(
        &self,
        idle: chrono::Duration,
        activity_in: ActivityIn<'_>,
    ) -> Result<usize> {
        self.auto_settle_idle_keeping(idle, activity_in, false)
    }

    /// [`Self::auto_settle_idle`], leaving every session with a linked pull
    /// request alone when `keep_pull_requests` (`autoSettleKeepPullRequests`).
    /// A watched one is left alone either way.
    pub fn auto_settle_idle_keeping(
        &self,
        idle: chrono::Duration,
        activity_in: ActivityIn<'_>,
        keep_pull_requests: bool,
    ) -> Result<usize> {
        let history = self.history_or_err()?;
        let now = Utc::now();
        let cutoff = now - idle;
        // Only the rows already idle past the cutoff are worth a busy check:
        // most ticks find none, and then nothing else is read.
        let idle_sessions = history
            .store()
            .idle_sessions_keeping(cutoff, keep_pull_requests);
        if idle_sessions.is_empty() {
            return Ok(0);
        }
        let activity = self.atlas_activity();
        let mut by_folder: HashMap<PathBuf, Option<HashMap<String, DateTime<Utc>>>> =
            HashMap::new();
        let busy: std::collections::HashSet<acp::SessionId> = idle_sessions
            .into_iter()
            .filter(|(session_id, folders)| {
                let id = session_id.0.as_ref();
                if folders.paths().is_empty() || self.session_is_busy(id, &activity) {
                    return true;
                }
                let mut modified = None;
                for folder in folders.paths() {
                    let times = by_folder
                        .entry(folder.clone())
                        .or_insert_with(|| activity_in(folder));
                    let Some(times) = times else {
                        return true; // no coverage: not settled
                    };
                    modified = modified.max(times.get(id).copied());
                }
                live_elsewhere(modified, activity.get(id), now)
            })
            .map(|(session_id, _)| session_id)
            .collect();
        Ok(history
            .store()
            .auto_settle_idle_keeping(cutoff, &busy, keep_pull_requests))
    }

    /// Which installed agents can be imported from, and how much they have.
    ///
    /// Connecting to every installed agent is the price of the answer: whether an agent has listable
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
            let status = match self.list_sessions_of(&plugin_id, None).await {
                Ok(None) => ImportStatus::Unsupported,
                Ok(Some(sessions)) => ImportStatus::Ready {
                    importable: importable_threads(
                        sessions,
                        &plugin_id.as_str().into(),
                        &known,
                        None,
                    )
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
            // An agent whose connect already failed this launch is not going
            // to list anything; asking again only starts a second doomed
            // attempt. Left unmarked, so it is tried on the next launch.
            if self.connect_has_failed(&plugin_id) {
                tracing::warn!(%plugin_id, "backfill skipped: the agent's connect failed");
                continue;
            }
            // Bounded per agent. The import runs at boot, sequentially over
            // every installed agent, and the user's first click joins whatever
            // connect it started — so one agent that never answers used to
            // hold every later one, and the user, behind it (diagnosis B).
            match tokio::time::timeout(BACKFILL_TIMEOUT, self.import_from(&plugin_id)).await {
                Ok(Ok(rows)) => tracing::info!(%plugin_id, rows, "backfilled history"),
                Ok(Err(e)) => {
                    tracing::warn!(error = %e.message, %plugin_id, "backfill found nothing")
                }
                // Not marked: a timeout says nothing about the agent's history,
                // only about this launch, so the next one tries again.
                Err(_elapsed) => {
                    tracing::warn!(
                        %plugin_id,
                        timeout_secs = BACKFILL_TIMEOUT.as_secs(),
                        "backfill timed out; will retry next launch"
                    );
                    continue;
                }
            }
            history.store().mark_backfilled(&agent_id);
        }
    }

    /// Until when the sync is leaving `plugin_id` alone, if it is.
    fn sync_held_off_until(&self, plugin_id: &str) -> Option<std::time::Instant> {
        let now = std::time::Instant::now();
        lock(&self.sync_backoff)
            .get(plugin_id)
            .map(|backoff| backoff.until)
            .filter(|until| *until > now)
    }

    /// The agent answered: it is in good standing again.
    fn note_sync_answered(&self, plugin_id: &str) {
        lock(&self.sync_backoff).remove(plugin_id);
    }

    /// The agent did not answer: hold it off, for longer each time. Answers
    /// how long.
    fn note_sync_failed(&self, plugin_id: &str) -> std::time::Duration {
        let mut backoff = lock(&self.sync_backoff);
        let hold = backoff
            .get(plugin_id)
            .map_or(SYNC_BACKOFF_FIRST, |previous| previous.next);
        backoff.insert(
            plugin_id.to_owned(),
            SyncBackoff {
                until: std::time::Instant::now() + hold,
                next: (hold * 2).min(SYNC_BACKOFF_MAX),
            },
        );
        hold
    }

    /// Whether the manager currently holds a failed connect for `plugin_id`.
    ///
    /// `Error` entries are evicted from the manager's table as they land, so
    /// this is usually a brief window — but it is exactly the window the boot
    /// backfill runs in, one agent after another.
    fn connect_has_failed(&self, plugin_id: &str) -> bool {
        let Ok(agent) = self.installed_agent(plugin_id) else {
            return false;
        };
        self.manager
            .entry(&agent)
            .is_some_and(|entry| matches!(&*lock(&entry), AgentConnectionEntry::Error { .. }))
    }

    /// Fetch one agent's sessions and write the new ones. Answers how many.
    ///
    /// The single place import happens, so the manual flow and the backfill
    /// cannot drift apart on what "importable" means.
    async fn import_from(&self, plugin_id: &str) -> Result<usize> {
        let history = self.history_or_err()?;
        let Some(sessions) = self.list_sessions_of(plugin_id, None).await? else {
            return Ok(0);
        };
        // Read what is known *now*, not when the modal was opened: two imports
        // racing, or a conversation started since, must not produce a second
        // row for one session.
        let rows = importable_threads(
            sessions,
            &plugin_id.into(),
            &self.known_or_atlas_owned(history),
            None,
        );
        // The filter above is a snapshot; the insert re-checks under the
        // store's write lock, so a sync or backfill landing in between cannot
        // leave two rows for one session.
        Ok(history.store().insert_new_sessions(rows))
    }

    /// Every session an agent will list, or `None` when it has no listable
    /// history — which is to say, when it did not advertise
    /// `sessionCapabilities.list`.
    ///
    /// `cwd` narrows the listing to one directory, honoured by the agent. The
    /// import flows pass `None`: Atlas has one connection per agent and
    /// an app-level store whose rows carry their own paths, so "everything this
    /// agent knows" is both simpler and more useful there. The project sync
    /// passes the open project, because it runs often and wants the cheap
    /// answer.
    async fn list_sessions_of(
        &self,
        plugin_id: &str,
        cwd: Option<PathBuf>,
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
        collect_all_sessions(list.as_ref(), cwd)
            .await
            .map(Some)
            .map_err(HostError::from)
    }

    /// Bring the recent sessions an agent holds for one project into the
    /// sidebar, so one started outside Atlas (a Claude Code run in a terminal)
    /// is there when the sidebar opens. Answers how many rows were added.
    ///
    /// ADR-0001 amendment (2026-10-05, ATL-421/ATL-422): the history store is
    /// still the only thing the sidebar reads and Atlas still never scrapes an
    /// agent's storage, but "imported once, at boot" no longer holds. The agent
    /// is asked over ACP `session/list`, filtered to `cwd`, whenever the
    /// sidebar is shown for that project. Rows whose `updated_at` is within the
    /// last week land active; older ones land settled, as an import does.
    ///
    /// Only agents that already have a row in the store are asked. The sync is
    /// automatic, and an automatic action must not be the reason an installed
    /// agent the user has never used gets spawned (ADR-0002); a row is the
    /// evidence the user has used it. Which agents those are is read from the
    /// rows' `agent_id`, never from a list of names.
    ///
    /// One agent being slow, signed out or broken costs only its own rows: each
    /// is bounded by [`SYNC_AGENT_TIMEOUT`] and a failure is logged and skipped.
    /// A project synced within [`SYNC_DEBOUNCE`] answers `0` without asking,
    /// unless `force` (the session watcher saw an unknown transcript appear):
    /// that skips the check but still records the time.
    ///
    /// Sessions the store already knows are not skipped outright: their
    /// agent-reported `updated_at` goes through
    /// [`ThreadMetadataStore::touch_sessions`], so a session picked up again
    /// in a terminal moves up its section. It does not leave the Settled
    /// shelf for that — only the user sending does.
    ///
    /// `cwd` must already be canonical (`threads_sync_project` does that): it
    /// is the debounce key and the `session/list` filter, and two spellings of
    /// one directory would be two projects to both.
    ///
    /// [`ThreadMetadataStore::touch_sessions`]: atlas_thread_metadata::ThreadMetadataStore::touch_sessions
    pub async fn sync_project(&self, cwd: &str, force: bool) -> Result<usize> {
        let history = self.history_or_err()?;
        {
            let mut last = lock(&self.last_project_sync);
            let now = std::time::Instant::now();
            if !force
                && last
                    .get(cwd)
                    .is_some_and(|at| now.duration_since(*at) < SYNC_DEBOUNCE)
            {
                return Ok(0);
            }
            last.insert(cwd.to_owned(), now);
        }

        let used: std::collections::HashSet<String> = history
            .store()
            .threads()
            .into_iter()
            .map(|thread| thread.agent_id.as_str().to_owned())
            .collect();
        let cutoff = sync_active_cutoff(Utc::now());

        let mut added = 0;
        for plugin_id in self.store.external_agents() {
            let plugin_id = plugin_id.to_string();
            if !used.contains(&plugin_id) {
                continue;
            }
            if self.connect_has_failed(&plugin_id) {
                tracing::warn!(%plugin_id, "project sync skipped: the agent's connect failed");
                continue;
            }
            if let Some(until) = self.sync_held_off_until(&plugin_id) {
                tracing::debug!(
                    %plugin_id,
                    in_secs = until.saturating_duration_since(std::time::Instant::now()).as_secs(),
                    "project sync skipped: backing off after a failure"
                );
                continue;
            }
            let listed = tokio::time::timeout(
                SYNC_AGENT_TIMEOUT,
                self.list_sessions_of(&plugin_id, Some(PathBuf::from(cwd))),
            )
            .await;
            let sessions = match listed {
                Ok(Ok(Some(sessions))) => {
                    self.note_sync_answered(&plugin_id);
                    sessions
                }
                Ok(Ok(None)) => {
                    self.note_sync_answered(&plugin_id);
                    continue;
                }
                Ok(Err(e)) => {
                    let hold = self.note_sync_failed(&plugin_id);
                    tracing::warn!(
                        error = %e.message,
                        %plugin_id,
                        retry_in_secs = hold.as_secs(),
                        "project sync found nothing"
                    );
                    continue;
                }
                Err(_elapsed) => {
                    let hold = self.note_sync_failed(&plugin_id);
                    tracing::warn!(
                        %plugin_id,
                        timeout_secs = SYNC_AGENT_TIMEOUT.as_secs(),
                        retry_in_secs = hold.as_secs(),
                        "project sync timed out"
                    );
                    continue;
                }
            };
            // Read what is known *now*, after the (slow) listing, not before
            // the loop: a thread started in Atlas, or a concurrent import,
            // while this agent was answering must not get a second row.
            let known = self.known_or_atlas_owned(history);
            let activity: Vec<_> = sessions
                .iter()
                .filter(|s| known.contains(&s.session_id))
                .filter_map(|s| Some((s.session_id.clone(), s.updated_at?)))
                .collect();
            history.store().touch_sessions(&activity);
            let rows =
                importable_threads(sessions, &plugin_id.as_str().into(), &known, Some(cutoff));
            added += history.store().insert_new_sessions(rows);
        }
        Ok(added)
    }

    /// What an import must skip: every session the store knows (rows, and
    /// those the user deleted), plus every on-disk session id attributed to
    /// one of Atlas's own sessions ([`AgentHost::claim_for_atlas_turn`]). The
    /// last is what keeps an adapter's internal continuation of a session
    /// Atlas is running from being listed back in as somebody else's.
    fn known_or_atlas_owned(
        &self,
        history: &ThreadRecorder,
    ) -> std::collections::HashSet<acp::SessionId> {
        // Confirmed aliases are already in the store's known set.
        let mut known = history.store().known_session_ids();
        known.extend(
            lock(&self.aliases)
                .keys()
                .map(|id| acp::SessionId::new(id.as_str())),
        );
        known
    }

    fn history_or_err(&self) -> Result<&ThreadRecorder> {
        self.history().ok_or_else(|| {
            let message = match &self.history_error {
                Some(cause) => format!("session history is unavailable: {cause}"),
                None => "session history is unavailable".to_string(),
            };
            HostError::new(message, ErrorClass::Fatal)
        })
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
        let Some(task) = connection.terminal_auth_command(&acp::AuthMethodId::new(method_id))
        else {
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
        // use, and agents title threads late or not at all. The message on
        // record carries the memory blocks `agents_send` prepended, and those
        // are not what the user opened with.
        title: thread
            .title()
            .cloned()
            .or_else(|| thread.fallback_title(atlas_agent_transcript::strip_injected_context)),
        // Its own folders only: an attached project the session was opened
        // with as a working directory is not the session's project, and
        // recording it would move the row to another group.
        work_dirs: thread.own_work_dirs(),
    }
}

/// The host's view of every live thread's events: keeps each conversation's
/// history row current, and records a session's end when its agent's process
/// exits.
///
/// The projector forwards each thread's events here, and this reads the thread
/// to decide what the history row should say.
///
/// Weak on purpose: the host owns the projector that owns this.
struct HostObserver(std::sync::Weak<AgentHost>);

impl ThreadObserver for HostObserver {
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
        // A load error on a live thread is the connection reporting that the
        // agent's process exited (`atlas-agent-servers`, the wait task): the
        // session has ended even though its tab is still open.
        if matches!(
            event,
            atlas_acp_thread::AcpThreadEvent::LoadError(atlas_acp_thread::LoadError::Exited { .. })
        ) {
            host.end_sessions([session_id.to_string()]);
        }
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
    /// When the session was settled — on the sidebar's Settled shelf — as
    /// RFC 3339; `None` while it is active.
    pub settled_at: Option<String>,
    /// When the session was pinned (RFC 3339); `None` when it is not.
    pub pinned_at: Option<String>,
    /// Its place among the pinned: a fractional key compared as a plain
    /// string. `None` sorts after every keyed pin.
    pub pin_order: Option<String>,
    /// When a snoozed session wakes on its own (RFC 3339); `None` when it is
    /// not snoozed.
    pub snoozed_until: Option<String>,
    pub snoozed_at: Option<String>,
    /// When it last woke from a snooze — on time, early because it raised its
    /// hand, or by hand.
    pub last_snooze_wake_at: Option<String>,
    /// When the user last opened or focused it.
    pub last_viewed_at: Option<String>,
    /// When its latest turn completed, as Atlas saw it end.
    pub last_turn_completed_at: Option<String>,
    /// Its latest turn completed after the user last viewed it. Decided here
    /// so every surface agrees.
    pub unread: bool,
    /// It woke from a snooze and the user has not viewed it since.
    pub woke: bool,
    /// The project this thread belongs to, for a history row that is shown
    /// outside its project's group.
    pub project_name: String,
    pub folder_paths: Vec<String>,
    /// The git branch the thread's working directory was on when it last
    /// started a turn (or was opened). `None` when Atlas never saw one — a
    /// detached HEAD, a folder that is not a repository, a row older than
    /// the column. Never guessed.
    pub branch: Option<String>,
    /// The model the latest turn ran on, by its display name. `None` when
    /// Atlas never saw one (an import, a row older than the column).
    pub model: Option<String>,
    /// Another process (typically `claude` in a terminal) wrote this session
    /// within the liveness window and Atlas is not hosting it (Rule 7).
    pub live_elsewhere: bool,
    /// The projects attached to the session besides its own folder, in the
    /// order they were attached. Everything a surface needs to show them, to
    /// match a project filter on them, or to split changes by them.
    pub attached_projects: Vec<AttachedProjectWire>,
    /// The session this one was branched from ("Branch from here"), as the
    /// parent's agent session id. `None` for a session that was not forked
    /// in Atlas. The session context overlay's Lineage reads it both ways:
    /// this row's parent, and the rows that name this one.
    pub forked_from_session_id: Option<String>,
    /// The pull requests linked to the session — opened from it, found on
    /// its branch, linked by the user or the agent — each with the host's
    /// last reported state. Tombstones (unlinked ones) are left out.
    pub pull_requests: Vec<super::session_pull_requests::PullRequestLinkWire>,
}

/// One project attached to a session, as every surface reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedProjectWire {
    /// The folder, absolute. Its identity within the session.
    pub path: String,
    pub display_name: String,
    /// `read_only` or `read_write`.
    pub access: String,
    /// RFC 3339.
    pub attached_at: String,
    /// `mention`, `agent_request` or `clone`.
    pub source: String,
}

impl From<&AttachedProject> for AttachedProjectWire {
    fn from(project: &AttachedProject) -> Self {
        Self {
            path: project.path.to_string_lossy().into_owned(),
            display_name: project.display_name.to_string(),
            access: project.access.as_str().to_string(),
            attached_at: project.attached_at.to_rfc3339(),
            source: project.source.as_str().to_string(),
        }
    }
}

/// What an attach, detach or access change did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionProjectsChange {
    /// The session's attached projects after the change.
    pub projects: Vec<AttachedProjectWire>,
    /// Whether anything changed. Attaching a path that is already attached,
    /// or setting the access it already has, changes nothing.
    pub changed: bool,
    /// Whether the agent's sandbox takes the change from the session's next
    /// turn. `false` when the agent cannot change an open session's roots
    /// (ACP has no request for it) or the session is not open: the change is
    /// recorded, and reaches the agent when the session is next opened.
    /// Atlas's own file grants apply at once either way.
    pub applied_live: bool,
}

/// An agent's request to use a folder, already validated
/// (`session_projects::validate_requested_path`).
#[derive(Debug, Clone)]
pub struct ProjectAccessRequest {
    /// Canonical, absolute, an existing directory.
    pub path: PathBuf,
    pub display_name: String,
    pub access: ProjectAccess,
    /// The agent's own words for why, shown on the card.
    pub reason: Option<String>,
    /// The folder is a git repository's root or inside one.
    pub in_git_repository: bool,
}

/// How an access request ended, as the asking agent is told.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccessRequestOutcome {
    /// The user approved, at this access; `applied_live` as for
    /// [`SessionProjectsChange::applied_live`].
    Granted {
        access: ProjectAccess,
        applied_live: bool,
    },
    /// The user denied it, dismissed the card, or the session went away.
    Denied,
    /// Already attached at this access or more; nothing was asked.
    AlreadyGranted(ProjectAccess),
    /// No answer within the wait. The card stays up.
    Pending,
}

/// How long an attach waits on the agent's sandbox update (ADR-0008).
const ROOTS_UPDATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// The access card's option ids, read back off the user's pick.
const ACCESS_OPTION_WRITE: &str = "grant_read_write";
const ACCESS_OPTION_READ: &str = "grant_read_only";
const ACCESS_OPTION_DENY: &str = "deny";

/// The roots a session's attached projects call for.
pub(crate) fn session_roots(projects: &[AttachedProject]) -> atlas_acp_thread::SessionRoots {
    let mut roots = atlas_acp_thread::SessionRoots::default();
    for project in projects {
        if project.access.is_writable() {
            roots.read_write.push(project.path.clone());
        } else {
            roots.read_only.push(project.path.clone());
        }
    }
    roots
}

/// `~/work/server` for a path under the home folder, the path as is
/// otherwise: the card has to say clearly which folder, in the form the user
/// knows it by.
pub(crate) fn display_path(path: &Path) -> String {
    if let Some(home) = dirs::home_dir() {
        if let Ok(rest) = path.strip_prefix(&home) {
            return format!("~/{}", rest.display());
        }
    }
    path.display().to_string()
}

fn access_card_title(request: &ProjectAccessRequest) -> String {
    let what = if request.access.is_writable() {
        "write access"
    } else {
        "read access"
    };
    format!("Wants {what} to {}", display_path(&request.path))
}

fn access_card_body(request: &ProjectAccessRequest) -> String {
    let mut body = String::new();
    if let Some(reason) = request.reason.as_deref().filter(|r| !r.trim().is_empty()) {
        body.push_str(reason.trim());
        body.push_str("\n\n");
    }
    body.push_str(&format!("Folder: {}", request.path.display()));
    if request.in_git_repository {
        body.push_str(" (git repository)");
    }
    body.push_str(if request.access.is_writable() {
        "\n\nApproving attaches it to this session. Read and write lets the agent edit it; \
         read-only lets it look but never change anything."
    } else {
        "\n\nApproving attaches it to this session, read-only: the agent can look but never \
         change anything."
    });
    body
}

/// What `thread_row` needs to decide [`ThreadRow::live_elsewhere`].
struct LiveContext<'a> {
    modified: &'a HashMap<String, DateTime<Utc>>,
    activity: HashMap<String, AtlasActivity>,
    now: DateTime<Utc>,
    /// Branched sessions, child -> parent session id (`session_forks`), for
    /// [`ThreadRow::forked_from_session_id`].
    forks: HashMap<String, String>,
}

/// What Atlas's own turns have been doing in one session.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct AtlasActivity {
    /// Turns Atlas has sent that have not come back yet.
    pub in_flight: u32,
    /// When the last of Atlas's turns in this session came back.
    pub last_turn_end: Option<DateTime<Utc>>,
    /// How many turns Atlas has started here, ever — a turn's identity, so a
    /// provisional alias can tell "a later turn" from the one it was claimed
    /// in.
    pub turns_started: u64,
}

/// A transcript id guessed to be another file of one of Atlas's sessions,
/// not yet settled ([`AgentHost::review_aliases`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProvisionalAlias {
    /// The session id Atlas holds.
    pub owner: String,
    /// The owner's `turns_started` when the alias was claimed: the turn it
    /// first appeared in.
    pub claimed_turn: u64,
}

/// What one watcher batch says about a provisional alias.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AliasVerdict {
    /// Nothing decisive happened.
    Keep,
    /// The file was written when its owner had no Atlas turn to explain it:
    /// another process (a terminal) is writing it, so it is that process's
    /// session.
    Revoke,
    /// A later turn of the owner wrote the alias and not the owner's own
    /// transcript: the conversation really moved there.
    Confirm,
}

/// Settle a provisional alias against one batch. `alias_written` is the
/// alias file's new time if it moved in this batch; `owner_written`, whether
/// the owner's own transcript moved too.
///
/// A real continuation is only ever written while Atlas is driving its owner,
/// so a write that [`explained_by_atlas`] cannot put down to the owner's turn
/// (none in flight, and not within [`ATLAS_WRITE_SLACK`] of the last one
/// ending) revokes. Confirmation needs a turn *after* the claiming one —
/// within the claiming turn both files are written, which proves nothing —
/// that writes the alias while leaving the owner's file alone.
pub(crate) fn review_alias(
    alias_written: Option<DateTime<Utc>>,
    owner_written: bool,
    claimed_turn: u64,
    owner: Option<&AtlasActivity>,
) -> AliasVerdict {
    let Some(at) = alias_written else {
        return AliasVerdict::Keep;
    };
    if !explained_by_atlas(at, owner) {
        return AliasVerdict::Revoke;
    }
    let later_turn = owner.is_some_and(|a| a.turns_started > claimed_turn);
    if later_turn && !owner_written {
        AliasVerdict::Confirm
    } else {
        AliasVerdict::Keep
    }
}

/// Whether a write to a session's transcript at `modified` is Atlas's own:
/// one of its turns is running there, or the write landed no more than
/// [`ATLAS_WRITE_SLACK`] after its last turn ended.
pub(crate) fn explained_by_atlas(
    modified: DateTime<Utc>,
    activity: Option<&AtlasActivity>,
) -> bool {
    activity.is_some_and(|a| {
        a.in_flight > 0
            || a.last_turn_end
                .is_some_and(|ended| modified <= ended + ATLAS_WRITE_SLACK)
    })
}

/// Which of Atlas's sessions a transcript id that has just appeared belongs
/// to, if any: one with an Atlas turn in flight whose own transcript is in the
/// same directory. Several candidates (two concurrent turns in one project)
/// cannot be told apart from disk; the lowest id is chosen so the answer is at
/// least stable, and either way the write is Atlas's.
pub(crate) fn alias_owner(
    new_id: &str,
    on_disk: &std::collections::HashSet<String>,
    activity: &HashMap<String, AtlasActivity>,
) -> Option<String> {
    activity
        .iter()
        .filter(|(id, a)| a.in_flight > 0 && id.as_str() != new_id && on_disk.contains(*id))
        .map(|(id, _)| id.clone())
        .min()
}

/// The liveness rule (ADR-0001 amendment, Rule 7): the transcript was written
/// within the live window, and not by Atlas. Being *bound* in Atlas — the row
/// was opened — says nothing either way; a terminal can be writing a session
/// Atlas has open, and that is exactly the fork this guards against.
/// For one folder, the session file times that are evidence of another
/// process (`SessionWatcher::activity_in`); `None` when the folder cannot be
/// checked. Settling reads it per row, so a row is judged by its own project.
pub type ActivityIn<'a> = &'a dyn Fn(&Path) -> Option<HashMap<String, DateTime<Utc>>>;

pub(crate) fn live_elsewhere(
    modified: Option<DateTime<Utc>>,
    activity: Option<&AtlasActivity>,
    now: DateTime<Utc>,
) -> bool {
    modified.is_some_and(|at| {
        atlas_agent_transcript::discovery::is_live(at, now) && !explained_by_atlas(at, activity)
    })
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

fn thread_row(thread: &ThreadMetadata, live: &LiveContext<'_>) -> ThreadRow {
    let session_id = thread
        .session_id
        .as_ref()
        .map(std::string::ToString::to_string);
    let live_elsewhere = session_id.as_deref().is_some_and(|id| {
        live_elsewhere(
            live.modified.get(id).copied(),
            live.activity.get(id),
            live.now,
        )
    });
    let forked_from_session_id = session_id
        .as_deref()
        .and_then(|id| live.forks.get(id).cloned());
    ThreadRow {
        thread_id: thread.thread_id.to_key_string(),
        session_id,
        agent_id: thread.agent_id.to_string(),
        title: display_title(thread),
        updated_at: thread.updated_at.to_rfc3339(),
        created_at: thread.created_at.map(|at| at.to_rfc3339()),
        settled_at: rfc3339(thread.settled_at),
        pinned_at: rfc3339(thread.pinned_at),
        pin_order: thread.pin_order.as_deref().map(str::to_string),
        snoozed_until: rfc3339(thread.snoozed_until),
        snoozed_at: rfc3339(thread.snoozed_at),
        last_snooze_wake_at: rfc3339(thread.last_snooze_wake_at),
        last_viewed_at: rfc3339(thread.last_viewed_at),
        last_turn_completed_at: rfc3339(thread.last_turn_completed_at),
        unread: thread.is_unread(),
        woke: thread.is_woke(),
        project_name: project_name(thread.main_worktree_paths()),
        folder_paths: paths_of(thread.folder_paths()),
        live_elsewhere,
        branch: thread.branch.as_deref().map(str::to_string),
        model: thread.model.as_deref().map(str::to_string),
        attached_projects: thread
            .attached_projects
            .iter()
            .map(AttachedProjectWire::from)
            .collect(),
        forked_from_session_id,
        pull_requests: super::session_pull_requests::links_wire(&thread.pull_requests),
    }
}

fn rfc3339(at: Option<DateTime<Utc>>) -> Option<String> {
    at.map(|at| at.to_rfc3339())
}

/// The row's title with any Atlas memory block taken out.
///
/// Rows recorded before `snapshot_of` cleaned its fallback were named after the
/// block's opening marker (`--- SHARED MEMORY ---`), and the store kept only
/// that line. Such a title cleans to nothing, which is the default title; the
/// real name replaces it the next time the conversation is live.
fn display_title(thread: &ThreadMetadata) -> String {
    let title = atlas_agent_transcript::strip_injected_context(&thread.display_title());
    if title.is_empty() {
        atlas_thread_metadata::DEFAULT_THREAD_TITLE.to_string()
    } else {
        title
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
    pub supports_rewind: bool,
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
/// because checkpoint touchpoint #11 requires keeping the host reading the
/// transcripts agents write for themselves, and knowing where those are is
/// per-agent knowledge no protocol advertises.
pub fn transcript_kind_for(plugin_id: &str) -> TranscriptKind {
    if plugin_id == ATLAS_AGENT_ID {
        return TranscriptKind::Native;
    }
    TranscriptKind::None
}

/// One auth method, as the frontend reads it.
///
/// Moved from `atlas-acp/src/driver.rs`, still built by reading
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
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default(),
            terminal_command: terminal
                .and_then(|t| t.get("command"))
                .and_then(|c| c.as_str())
                .map(str::to_string),
            terminal_args: terminal.and_then(|t| t.get("args")).and_then(|a| {
                a.as_array().map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
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
        label: obj
            .get("label")
            .and_then(|l| l.as_str())
            .map(str::to_string),
        secret: obj
            .get("secret")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
        optional: obj
            .get("optional")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
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
    thread
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

// ── The installed map on disk ───────────────────────────────────────────────
//
// The installed map is JSON in a file of its own, so a hand edit is possible without touching app
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
        assert!(elicitation_response("anything-else", None)
            .unwrap()
            .is_none());
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
            !wire
                .terminal_env
                .iter()
                .any(|(name, _)| name == "ANTHROPIC_API_KEY"),
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
    #[test]
    fn only_the_newest_branch_probe_for_a_session_may_write() {
        let mut probes = super::BranchProbes::default();
        let a = agent_client_protocol::schema::v1::SessionId::new("a");
        let b = agent_client_protocol::schema::v1::SessionId::new("b");

        let first = probes.start(&a);
        let second = probes.start(&a);
        let other = probes.start(&b);
        // The second turn's probe finishes first; the first one, slower, must
        // not overwrite the branch it recorded.
        assert!(probes.finish(&a, second));
        assert!(!probes.finish(&a, first));
        // Another session's probes are their own.
        assert!(probes.finish(&b, other));
        assert!(probes.latest.is_empty(), "nothing in flight, nothing kept");
    }

    use super::test_support::{fresh_host, fresh_host_with_native};
    use super::*;
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

    /// A selector that knows its default before any pick — the shape the
    /// engine's catalogue-backed selector has (#76).
    struct FakeSelector;

    impl atlas_acp_thread::AgentModelSelector for FakeSelector {
        fn list_models(
            &self,
        ) -> BoxFuture<'static, anyhow::Result<atlas_acp_thread::AgentModelList>> {
            async { Ok(atlas_acp_thread::AgentModelList::Flat(Vec::new())) }.boxed()
        }

        fn select_model(
            &self,
            _model_id: atlas_acp_thread::AgentModelId,
        ) -> BoxFuture<'static, anyhow::Result<()>> {
            async { Ok(()) }.boxed()
        }

        fn selected_model(
            &self,
        ) -> BoxFuture<'static, anyhow::Result<atlas_acp_thread::AgentModelInfo>> {
            async {
                Ok(atlas_acp_thread::AgentModelInfo {
                    id: atlas_acp_thread::AgentModelId::new("fake-default-model"),
                    name: "Fake Default".into(),
                    description: None,
                    icon: None,
                    is_latest: true,
                    cost: None,
                    disabled: None,
                    provider: None,
                    legacy: false,
                })
            }
            .boxed()
        }
    }

    impl AgentConnection for RebindingNative {
        fn agent_id(&self) -> atlas_acp_thread::AgentId {
            atlas_acp_thread::AgentId::new(ATLAS_AGENT_ID)
        }

        fn telemetry_id(&self) -> Arc<str> {
            ATLAS_AGENT_ID.into()
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

        fn model_selector(
            &self,
            _session_id: &acp::SessionId,
        ) -> Option<Arc<dyn atlas_acp_thread::AgentModelSelector>> {
            Some(Arc::new(FakeSelector))
        }

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
            atlas_acp_thread::AgentId::new(ATLAS_AGENT_ID)
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

    /// A native agent whose threads report to the host the way a real
    /// connection's do — through the `thread_events` sink it was handed at
    /// connect — so an event on the thread reaches the host's observer.
    struct LiveNative {
        session_id: &'static str,
        events: std::sync::Mutex<Option<atlas_agent_servers::ThreadEventSink>>,
    }

    impl LiveNative {
        fn new(session_id: &'static str) -> Arc<Self> {
            Arc::new(Self {
                session_id,
                events: std::sync::Mutex::new(None),
            })
        }
    }

    impl AgentConnection for LiveNative {
        fn agent_id(&self) -> atlas_acp_thread::AgentId {
            atlas_acp_thread::AgentId::new(ATLAS_AGENT_ID)
        }

        fn telemetry_id(&self) -> Arc<str> {
            ATLAS_AGENT_ID.into()
        }

        fn new_session(
            self: Arc<Self>,
            work_dirs: Vec<PathBuf>,
        ) -> BoxFuture<'static, anyhow::Result<AcpThreadHandle>> {
            let session_id = acp::SessionId::new(self.session_id);
            let sink = self
                .events
                .lock()
                .unwrap()
                .clone()
                .expect("connected first");
            let thread = Arc::new(std::sync::Mutex::new(AcpThread::new(
                session_id.clone(),
                self.clone() as Arc<dyn AgentConnection>,
                work_dirs,
                None,
                sink(&session_id),
            )));
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

    impl AgentServer for LiveNative {
        fn agent_id(&self) -> atlas_acp_thread::AgentId {
            atlas_acp_thread::AgentId::new(ATLAS_AGENT_ID)
        }

        fn connect(
            &self,
            _delegate: AgentServerDelegate,
            options: ConnectOptions,
        ) -> BoxFuture<'static, anyhow::Result<Arc<dyn AgentConnection>>> {
            let connection = Arc::new(LiveNative {
                session_id: self.session_id,
                events: std::sync::Mutex::new(Some(options.thread_events)),
            });
            async move { Ok(connection as Arc<dyn AgentConnection>) }.boxed()
        }

        fn into_any(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
            self
        }
    }

    /// A host recording session lifecycle into shared memory, a project
    /// directory, and the scope's store to read the sessions table back from.
    fn recording_host(
        native: Arc<dyn AgentServer>,
    ) -> (
        Arc<AgentHost>,
        PathBuf,
        PathBuf,
        Arc<atlas_memory::record::RecordStore>,
    ) {
        let (host, dir) = fresh_host_with_native(native);
        let tick = Arc::new(std::sync::atomic::AtomicI64::new(0));
        let memory =
            crate::commands::shared_memory::SharedMemoryStore::with_clock(Arc::new(move || {
                100 * (tick.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1)
            }));
        host.set_session_lifecycle(Arc::new(memory));
        let project = dir.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let record = crate::commands::shared_memory::store_for(&project.to_string_lossy()).unwrap();
        (host, dir, project, record)
    }

    /// Issue #81: opening a session records its start and owning agent, and
    /// dropping it (a tab closed) records its end. The native agent is an
    /// agent like any other here, recorded under its stored id.
    #[tokio::test]
    async fn a_dropped_session_leaves_its_start_end_and_agent() {
        let (host, dir, project, record) = recording_host(LiveNative::new("s-drop"));
        let agent_id = host.spawn(ATLAS_AGENT_ID).await.expect("spawn").agent_id;
        host.new_session(agent_id, project.clone(), Vec::new())
            .await
            .expect("a session opens");

        host.drop_session("s-drop").await.expect("drop");
        host.drop_session("s-drop")
            .await
            .expect("a second drop is a no-op");

        assert_eq!(
            record.sessions().unwrap(),
            vec![atlas_memory::record::SessionRow {
                session_id: "s-drop".into(),
                agent: ATLAS_AGENT_ID.into(),
                started_at: Some(100),
                ended_at: Some(200),
            }],
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Issue #81: an agent process that exits ends its sessions — the
    /// connection announces the exit on every live thread as a load error.
    #[tokio::test]
    async fn an_agent_process_exit_ends_its_session() {
        let (host, dir, project, record) = recording_host(LiveNative::new("s-exit"));
        let agent_id = host.spawn(ATLAS_AGENT_ID).await.expect("spawn").agent_id;
        host.new_session(agent_id, project.clone(), Vec::new())
            .await
            .expect("a session opens");

        let thread = host.thread("s-exit").expect("live");
        lock_thread(&thread).emit_load_error(atlas_acp_thread::LoadError::Exited {
            status: Some(1),
            stderr: "".into(),
        });
        for _ in 0..100 {
            if record.sessions().unwrap()[0].ended_at.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        let row = &record.sessions().unwrap()[0];
        assert_eq!(row.agent, ATLAS_AGENT_ID);
        assert_eq!((row.started_at, row.ended_at), (Some(100), Some(200)));

        // The tab closing afterwards does not end it a second time.
        host.drop_session("s-exit").await.expect("drop");
        let ends = record
            .events_newest(10)
            .unwrap()
            .into_iter()
            .filter(|e| e.kind == "session_end")
            .count();
        assert_eq!(ends, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Issue #81: stopping an agent kills its process, which ends every
    /// session it had open.
    #[tokio::test]
    async fn killing_an_agent_ends_its_sessions() {
        let (host, dir, project, record) = recording_host(LiveNative::new("s-kill"));
        let agent_id = host.spawn(ATLAS_AGENT_ID).await.expect("spawn").agent_id;
        host.new_session(agent_id, project.clone(), Vec::new())
            .await
            .expect("a session opens");

        host.kill(agent_id).expect("kill");

        assert_eq!(record.sessions().unwrap()[0].ended_at, Some(200));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The manager evicting an agent whose process died (`ConnectionExited`)
    /// must take its sessions out of the host too. Left in, the tab's next
    /// message went to a session id the respawned agent never knew and failed
    /// with "unknown session id"; forgotten (after the disconnect notice), the
    /// tab rebinds through `session/load` instead.
    #[tokio::test]
    async fn an_evicted_agents_sessions_are_forgotten_so_the_tab_rebinds() {
        let (host, dir, project, record) = recording_host(LiveNative::new("s-evict"));
        let agent_id = host.spawn(ATLAS_AGENT_ID).await.expect("spawn").agent_id;
        host.new_session(agent_id, project.clone(), Vec::new())
            .await
            .expect("a session opens");
        assert!(
            lock(&host.sessions).contains_key("s-evict"),
            "precondition: the host holds the session"
        );

        // What the manager's event triggers; the manager has already
        // forgotten the session on its side by then.
        host.agent_exited(&Agent::Native);

        assert!(
            !lock(&host.sessions).contains_key("s-evict"),
            "the host must not keep a session the dead process owned"
        );
        assert_eq!(record.sessions().unwrap()[0].ended_at, Some(200));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Issue #76: a native session's model must be known to capture BEFORE
    /// the user ever touches the picker. `current_model` used to be written
    /// only by an explicit pick, so the common case — running on the default —
    /// told capture `None` on every turn and the Timeline row showed no
    /// model, while the agent knew its model the whole time.
    #[tokio::test]
    async fn a_new_native_session_knows_its_model_before_any_pick() {
        let native = Arc::new(RebindingNative {
            fresh_id: "s-model",
        });
        let (host, dir) = fresh_host_with_native(native);

        let agent_id = host.spawn(ATLAS_AGENT_ID).await.expect("spawn").agent_id;
        let init = host
            .new_session(agent_id, PathBuf::from("/tmp/atlas"), Vec::new())
            .await
            .expect("a session opens");

        let snap = host.snapshot_meta(&init.key).expect("meta");
        assert_eq!(
            snap.current_model.as_deref(),
            Some("fake-default-model"),
            "the record carries the agent's own default before any pick",
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The host half of the live-elsewhere fix: binding a session records no
    /// Atlas activity (opening a row must not hide a terminal's writes), and a
    /// sent turn is counted in and out, leaving the time it ended behind.
    #[tokio::test]
    async fn only_a_sent_turn_counts_as_atlas_activity() {
        let native = Arc::new(RebindingNative {
            fresh_id: "s-activity",
        });
        let (host, dir) = fresh_host_with_native(native);
        let agent_id = host.spawn(ATLAS_AGENT_ID).await.expect("spawn").agent_id;
        let init = host
            .new_session(agent_id, PathBuf::from("/tmp/atlas"), Vec::new())
            .await
            .expect("a session opens");
        let id = init.key.session_id.clone();

        assert!(
            !host.atlas_activity().contains_key(&id),
            "bound is not active"
        );
        let opened = Utc::now();
        assert!(live_elsewhere(
            Some(opened),
            host.atlas_activity().get(&id),
            opened
        ));

        host.send(&init.key, Vec::new()).expect("send");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let ended = loop {
            let activity = host.atlas_activity().get(&id).copied().unwrap_or_default();
            if let (0, Some(ended)) = (activity.in_flight, activity.last_turn_end) {
                break ended;
            }
            assert!(std::time::Instant::now() < deadline, "the turn never ended");
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        };
        let activity = host.atlas_activity();
        assert!(!live_elsewhere(Some(ended), activity.get(&id), ended));
        let later = ended + chrono::Duration::seconds(30);
        assert!(live_elsewhere(Some(later), activity.get(&id), later));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Issue #62: sign-out drops the native connection — the engine's token
    /// cache lives on it, and the JWT it holds outlives the revoked session
    /// token. This pins the host half: after the drop nothing is running, so
    /// the next spawn builds a fresh connection (and with it a fresh, empty
    /// cache) instead of reusing the credentialled one.
    #[tokio::test]
    async fn dropping_the_native_connection_leaves_nothing_running() {
        let native = Arc::new(RebindingNative { fresh_id: "s-1" });
        let (host, dir) = fresh_host_with_native(native);

        host.spawn(ATLAS_AGENT_ID)
            .await
            .expect("native agent spawns");
        // The Connecting→Connected flip runs on a spawned task; on the test's
        // current-thread runtime it needs the yield before `connected` sees it.
        tokio::task::yield_now().await;
        assert!(
            host.manager().connected(&Agent::Native).is_some(),
            "a connection is open",
        );

        host.drop_native_connection();
        assert!(
            host.manager().connected(&Agent::Native).is_none(),
            "sign-out leaves nothing running",
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A scripted gateway for the model-list refresh (ADR-0007).
    struct FakeCatalogue {
        rows: Vec<(&'static str, bool)>,
        error: Option<atlas_native_agent::engine::FetchError>,
    }

    impl atlas_native_agent::engine::CatalogueFetcher for FakeCatalogue {
        fn fetch(
            &self,
        ) -> futures::future::BoxFuture<
            '_,
            std::result::Result<
                atlas_native_agent::engine::catalog_cache::GatewayCatalogue,
                atlas_native_agent::engine::FetchError,
            >,
        > {
            use atlas_native_agent::engine::catalog_cache::{GatewayCatalogue, GatewayRow};
            use futures::FutureExt;
            let answer = match &self.error {
                Some(err) => Err(err.clone()),
                None => Ok(GatewayCatalogue {
                    has_grant: true,
                    rows: self
                        .rows
                        .iter()
                        .map(|(id, entitled)| GatewayRow {
                            id: id.to_string(),
                            entitled: *entitled,
                            ..GatewayRow::default()
                        })
                        .collect(),
                }),
            };
            async move { answer }.boxed()
        }

        fn org(&self) -> Option<String> {
            Some("org_1".to_string())
        }
    }

    /// ADR-0007: the picker's Refresh rewrites the cache the next connect
    /// reads and answers with the list — with no engine open, that is the
    /// whole job, and the next spawn picks the rows up without a request.
    #[tokio::test]
    async fn refreshing_models_rewrites_the_cache_the_next_connect_reads() {
        use atlas_native_agent::engine::catalog_cache::load_cache;
        let native = Arc::new(RebindingNative { fresh_id: "s-1" });
        let (host, dir) = fresh_host_with_native(native);

        let refreshed = host
            .refresh_native_models_with(&FakeCatalogue {
                rows: vec![
                    ("model-a", true),
                    ("model-locked", false),
                    ("model-b", true),
                ],
                error: None,
            })
            .await
            .expect("the gateway answered");

        let ids: Vec<&str> = refreshed.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["model-a", "model-b"], "entitled rows, gateway order");
        assert_eq!(refreshed.default_model, "model-a");
        assert!(refreshed.changed);
        assert!(
            !refreshed.reconnected,
            "nothing was open, so nothing was torn down"
        );

        let home = atlas_native_agent::engine::EngineHome::under_config_dir(&dir);
        let cache = load_cache(home.path())
            .await
            .expect("the cache was written");
        assert_eq!(
            cache.org.as_deref(),
            Some("org_1"),
            "keyed by the org it was fetched for"
        );
        assert_eq!(
            cache.rows.len(),
            3,
            "the gateway's rows verbatim, locked one included"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A refresh the gateway refuses reaches the frontend classified, so a
    /// credential failure routes to sign-in and an empty grant reads as the
    /// setup problem it is — never as "the button did nothing".
    #[tokio::test]
    async fn a_refused_refresh_is_classified_for_the_frontend() {
        let native = Arc::new(RebindingNative { fresh_id: "s-1" });
        let (host, dir) = fresh_host_with_native(native);

        let Err(denied) = host
            .refresh_native_models_with(&FakeCatalogue {
                rows: vec![],
                error: Some(atlas_native_agent::engine::FetchError::Unauthorized(
                    String::new(),
                )),
            })
            .await
        else {
            panic!("a 401 is a refusal");
        };
        assert!(matches!(denied.class, ErrorClass::Auth), "{denied:?}");

        let Err(nothing) = host
            .refresh_native_models_with(&FakeCatalogue {
                rows: vec![("model-locked", false)],
                error: None,
            })
            .await
        else {
            panic!("a list with nothing entitled is no list");
        };
        assert!(matches!(nothing.class, ErrorClass::Fatal), "{nothing:?}");
        assert!(nothing.message.contains("no models"), "{}", nothing.message);

        let _ = std::fs::remove_dir_all(&dir);
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
            session_id: Some(acp::SessionId::new("pre-rename-id")),
            ..atlas_thread_metadata::ThreadMetadata::new(
                atlas_thread_metadata::ThreadId::new(),
                ATLAS_AGENT_ID.into(),
                atlas_thread_metadata::PathList::new(&[PathBuf::from("/tmp/atlas")]),
            )
        };
        let thread_id = thread.thread_id;
        history.store().save_all(vec![thread]);

        let resumed = host
            .resume_thread(thread_id)
            .await
            .expect("resume succeeds");
        assert_eq!(resumed.key.session_id, "engine-fresh-id");

        // The live feed's first write under the new id must land on the row
        // the user clicked, not mint a second one.
        history.record_connected(
            &atlas_acp_thread::AgentId::new(ATLAS_AGENT_ID),
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
        assert_eq!(plugins[0].plugin_id, ATLAS_AGENT_ID);
        assert!(!plugins[0].external);

        assert!(matches!(host.agent_for(ATLAS_AGENT_ID), Ok(Agent::Native)));
        for id in ["claude-code-ts", "codex", "opencode", "cursor", "kilo"] {
            let Err(err) = host.agent_for(id) else {
                panic!("{id} must not be runnable");
            };
            // Fatal, not auth: signing in or retrying changes nothing, only
            // installing does.
            assert_eq!(err.class, ErrorClass::Fatal, "for {id}");
            assert!(err.message.contains("not installed"), "for {id}: {err}");
        }

        // Nothing has connected, so nothing is running and no capability is
        // claimed — capabilities only exist after `initialize`.
        assert!(host.list_agents().is_empty());
        let caps = host.capabilities(ATLAS_AGENT_ID);
        assert!(caps.auth_kinds.is_empty());
        assert!(!caps.supports_logout);
        // `session/fork` has no equivalent on the seam, so this is
        // false for every agent rather than optimistically true.
        assert!(!caps.supports_fork);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A history row is the user's record. An agent that cannot be reached,
    /// cannot be started, or has forgotten the conversation must leave it
    /// exactly as it found it — its lifecycle included.
    #[tokio::test]
    async fn a_resume_that_fails_changes_nothing_about_the_row() {
        let (host, dir) = fresh_host();
        let history = host.history().expect("a fresh host has history");
        let thread = atlas_thread_metadata::ThreadMetadata {
            session_id: Some(acp::SessionId::new("ses-1")),
            // Settled where the user left it (a fresh row is inside the
            // settle grace, so the store's `settle` would refuse it).
            settled_at: Some(chrono::Utc::now()),
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

        let error = host
            .resume_thread(thread_id)
            .await
            .expect_err("an agent that is not installed cannot be resumed");
        assert_eq!(error.class, ErrorClass::Fatal);

        let after = history.store().thread(thread_id).expect("the row survives");
        assert!(after.is_settled(), "and it is still where the user left it");
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

        host.delete_thread(thread_id, &HashMap::new())
            .await
            .expect("delete is local");

        assert!(history.store().thread(thread_id).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The review finding: deleting a row whose session a terminal is still
    /// writing asked the agent to delete the transcript under it. Refused,
    /// with the row left as it was; once the terminal is quiet, it goes.
    #[tokio::test]
    async fn a_session_live_elsewhere_cannot_be_deleted() {
        let (host, dir) = fresh_host();
        let history = host.history().expect("a fresh host has history");
        let thread = atlas_thread_metadata::ThreadMetadata {
            session_id: Some(acp::SessionId::new("ses-live")),
            ..atlas_thread_metadata::ThreadMetadata::new(
                atlas_thread_metadata::ThreadId::new(),
                "an-uninstalled-agent".into(),
                atlas_thread_metadata::PathList::new(&[PathBuf::from("/tmp/atlas")]),
            )
        };
        let thread_id = thread.thread_id;
        history.store().save_all(vec![thread]);

        let written_just_now = HashMap::from([("ses-live".to_owned(), Utc::now())]);
        let err = host
            .delete_thread(thread_id, &written_just_now)
            .await
            .expect_err("a session another process is writing is not deleted");
        assert!(err.message.contains("still active in another process"));
        assert!(history.store().thread(thread_id).is_some(), "row untouched");

        let quiet = HashMap::from([(
            "ses-live".to_owned(),
            Utc::now() - chrono::Duration::minutes(10),
        )]);
        host.delete_thread(thread_id, &quiet)
            .await
            .expect("a quiet session deletes");
        assert!(history.store().thread(thread_id).is_none());
        assert!(
            history
                .store()
                .is_session_deleted(&acp::SessionId::new("ses-live")),
            "and stays deleted against the next sync"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Settling refuses a session with a turn in flight, and the idle sweep
    /// passes over it and over one live in another process; once quiet, both
    /// settle it and the row says so on the wire.
    #[tokio::test]
    async fn a_running_session_is_not_settled_by_hand_or_by_the_sweep() {
        let (host, dir) = fresh_host();
        let history = host.history().expect("a fresh host has history");
        let row = |session: &str| {
            let mut thread = atlas_thread_metadata::ThreadMetadata {
                session_id: Some(acp::SessionId::new(session)),
                ..atlas_thread_metadata::ThreadMetadata::new(
                    atlas_thread_metadata::ThreadId::new(),
                    "an-uninstalled-agent".into(),
                    atlas_thread_metadata::PathList::new(&[PathBuf::from("/tmp/atlas")]),
                )
            };
            thread.updated_at = Utc::now() - chrono::Duration::days(5);
            thread.interacted_at = Some(thread.updated_at);
            thread
        };
        let (running, elsewhere) = (row("ses-running"), row("ses-elsewhere"));
        let (running_id, elsewhere_id) = (running.thread_id, elsewhere.thread_id);
        history.store().save_all(vec![running, elsewhere]);

        let quiet = |_: &Path| Some(HashMap::new());
        let written_just_now =
            |_: &Path| Some(HashMap::from([("ses-elsewhere".to_owned(), Utc::now())]));

        host.begin_atlas_turn("ses-running");
        let err = host
            .settle_thread(running_id, &quiet)
            .expect_err("a session mid-turn is not settled");
        assert!(err.message.contains("still running"));

        host.settle_thread(elsewhere_id, &written_just_now)
            .expect_err("nor is one running in another process");
        let settled = host
            .auto_settle_idle(chrono::Duration::days(3), &written_just_now)
            .unwrap();
        assert_eq!(settled, 0, "busy here, live elsewhere: neither is settled");

        host.end_atlas_turn("ses-running");
        assert!(
            host.settle_thread(running_id, &quiet)
                .expect("a quiet session settles"),
            "and says it moved"
        );
        assert!(
            !host.settle_thread(running_id, &quiet).unwrap(),
            "settling it again changes nothing, and says so"
        );
        let settled = host
            .auto_settle_idle(chrono::Duration::days(3), &quiet)
            .unwrap();
        assert_eq!(settled, 1, "the sweep settles the other once it is quiet");

        let rows = host.thread_history(&HashMap::new()).unwrap();
        for id in [running_id, elsewhere_id] {
            let row = rows
                .iter()
                .find(|r| r.thread_id == id.to_key_string())
                .unwrap();
            assert!(row.settled_at.is_some(), "settledAt on the wire");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The review finding: the sweep covers every project, the session watcher
    /// only the open one. A session in another project is judged by its own
    /// folder's transcripts — and when they cannot be read, it is not settled.
    #[tokio::test]
    async fn the_sweep_judges_each_session_by_its_own_project() {
        let (host, dir) = fresh_host();
        let history = host.history().expect("a fresh host has history");
        let mut thread = atlas_thread_metadata::ThreadMetadata::new(
            atlas_thread_metadata::ThreadId::new(),
            "an-uninstalled-agent".into(),
            atlas_thread_metadata::PathList::new(&[PathBuf::from("/tmp/another-project")]),
        );
        thread.session_id = Some(acp::SessionId::new("ses-other"));
        thread.updated_at = Utc::now() - chrono::Duration::days(5);
        thread.interacted_at = Some(thread.updated_at);
        let id = thread.thread_id;
        history.store().save_all(vec![thread]);

        // What the sidebar's open project knows: nothing about this one.
        let open_project = PathBuf::from("/tmp/atlas");
        let asked = std::sync::Mutex::new(Vec::<PathBuf>::new());
        let terminal_in_other = |folder: &Path| {
            asked.lock().unwrap().push(folder.to_path_buf());
            if folder == open_project {
                Some(HashMap::new())
            } else {
                Some(HashMap::from([("ses-other".to_owned(), Utc::now())]))
            }
        };
        let idle = chrono::Duration::days(3);
        assert_eq!(host.auto_settle_idle(idle, &terminal_in_other).unwrap(), 0);
        assert_eq!(
            *asked.lock().unwrap(),
            [PathBuf::from("/tmp/another-project")],
            "asked about the session's own folder"
        );
        host.settle_thread(id, &terminal_in_other)
            .expect_err("by hand too, the row's own project decides");

        let unreadable = |_: &Path| None;
        assert_eq!(
            host.auto_settle_idle(idle, &unreadable).unwrap(),
            0,
            "no coverage, no settle"
        );

        let quiet = |_: &Path| Some(HashMap::new());
        assert_eq!(host.auto_settle_idle(idle, &quiet).unwrap(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Snoozing goes through the host's checks: a time in the past is refused
    /// with a reason, and the wire row carries the snooze and, once woken,
    /// the woke mark.
    #[tokio::test]
    async fn a_snooze_is_checked_and_reaches_the_wire() {
        let (host, dir) = fresh_host();
        let history = host.history().expect("a fresh host has history");
        let mut thread = atlas_thread_metadata::ThreadMetadata::new(
            atlas_thread_metadata::ThreadId::new(),
            "an-uninstalled-agent".into(),
            atlas_thread_metadata::PathList::new(&[PathBuf::from("/tmp/atlas")]),
        );
        thread.session_id = Some(acp::SessionId::new("ses-snooze"));
        let id = thread.thread_id;
        history.store().save_all(vec![thread]);

        let err = host
            .snooze_thread(id, Utc::now() - chrono::Duration::minutes(1))
            .expect_err("the past is not a snooze");
        assert!(err.message.contains("future"));

        let until = Utc::now() + chrono::Duration::hours(1);
        assert!(host.snooze_thread(id, until).unwrap());
        let row_of = |host: &AgentHost| {
            host.thread_history(&HashMap::new())
                .unwrap()
                .into_iter()
                .find(|r| r.thread_id == id.to_key_string())
                .unwrap()
        };
        let row = row_of(&host);
        assert_eq!(row.snoozed_until, Some(until.to_rfc3339()));
        assert!(!row.woke);

        assert!(host.wake_thread(id).unwrap());
        let row = row_of(&host);
        assert!(row.snoozed_until.is_none() && row.woke);

        assert!(host.mark_session_viewed("ses-snooze").unwrap());
        assert!(!row_of(&host).woke, "viewing clears it");
        assert!(
            host.mark_thread_unread(id).is_err(),
            "no finished turn to be unread"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A send records the interaction before the turn is counted in. A settle
    /// that lands in that gap is refused, not taken as "quiet".
    #[tokio::test]
    async fn a_session_just_sent_to_is_not_settled() {
        let (host, dir) = fresh_host();
        let history = host.history().expect("a fresh host has history");
        let mut thread = atlas_thread_metadata::ThreadMetadata::new(
            atlas_thread_metadata::ThreadId::new(),
            "an-uninstalled-agent".into(),
            atlas_thread_metadata::PathList::new(&[PathBuf::from("/tmp/atlas")]),
        );
        thread.session_id = Some(acp::SessionId::new("ses-sent"));
        let id = thread.thread_id;
        history.store().save_all(vec![thread]);
        history.store().update_interacted_at(id, Utc::now());

        let err = host
            .settle_thread(id, &|_: &Path| Some(HashMap::new()))
            .expect_err("the turn has not been counted in yet");
        assert!(err.message.contains("still running"));
        assert!(!history.store().settle(id), "the store refuses it too");
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
        assert_eq!(ids, [ATLAS_AGENT_ID, "some-agent"]);

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
        assert_eq!(transcript_kind_for(ATLAS_AGENT_ID), TranscriptKind::Native);
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

    /// The installed map's JSON shape is a stable wire format.
    #[test]
    fn the_installed_map_json_shape_is_stable() {
        let settings: atlas_agent_store::AllAgentServersSettings = serde_json::from_str(
            r#"{ "my-agent": { "type": "custom", "command": "~/bin/agent", "args": ["--acp"] },
                 "some-cli": { "type": "registry" } }"#,
        )
        .expect("installed-map shape");
        assert_eq!(settings.0.len(), 2);
        assert!(settings.has_registry_agents());
    }

    /// The first message on record, as `agents_send` delivers it: Atlas's
    /// memory blocks, then what the user typed.
    const MEMORY_PREFIXED: &str = "--- SHARED MEMORY ---\n\
        - the sidebar is virtualised\n\
        --- END SHARED MEMORY ---\n\n\
        --- RELEVANT PROJECT MEMORY ---\n\
        notes\n\
        --- END RELEVANT PROJECT MEMORY ---\n\n\
        fix the sidebar scrolling bug\nit jumps on resize";

    /// An agent that never titles its threads — the native agent — used to
    /// have every one named `--- SHARED MEMORY ---`, the first line of the
    /// memory Atlas prepends. The name is the user's first line.
    #[test]
    fn an_untitled_thread_is_named_after_the_user_not_the_injected_memory() {
        let connection = Arc::new(RebindingNative { fresh_id: "s" });
        let thread = connection.thread(acp::SessionId::new("s"), Vec::new());
        lock_thread(&thread).push_user_content_block(
            None,
            acp::ContentBlock::Text(acp::TextContent::new(MEMORY_PREFIXED)),
        );

        assert_eq!(
            snapshot_of(&thread).title.as_deref(),
            Some("fix the sidebar scrolling bug")
        );
    }

    /// A liveness snapshot in which nothing is live.
    fn no_live() -> LiveContext<'static> {
        static EMPTY: std::sync::LazyLock<HashMap<String, DateTime<Utc>>> =
            std::sync::LazyLock::new(HashMap::new);
        LiveContext {
            modified: &EMPTY,
            activity: HashMap::new(),
            now: Utc::now(),
            forks: HashMap::new(),
        }
    }

    fn running() -> AtlasActivity {
        AtlasActivity {
            in_flight: 1,
            last_turn_end: None,
            ..Default::default()
        }
    }

    /// The review finding: the Claude adapter's plan-mode "clear context"
    /// keeps the ACP session id but writes on under a fresh transcript id. An
    /// id that appears beside a session Atlas is mid-turn in is Atlas's.
    #[test]
    fn a_transcript_appearing_during_an_atlas_turn_beside_its_own_is_atlas() {
        let on_disk: std::collections::HashSet<String> =
            ["hosted".to_owned(), "fresh".to_owned()].into();
        let activity = HashMap::from([("hosted".to_owned(), running())]);
        assert_eq!(
            alias_owner("fresh", &on_disk, &activity).as_deref(),
            Some("hosted")
        );
    }

    #[test]
    fn a_transcript_is_not_attributed_without_a_matching_atlas_turn() {
        let on_disk: std::collections::HashSet<String> =
            ["hosted".to_owned(), "fresh".to_owned()].into();
        // Atlas's session is idle: the new transcript is someone else's.
        let idle = HashMap::from([(
            "hosted".to_owned(),
            AtlasActivity {
                in_flight: 0,
                last_turn_end: Some(Utc::now()),
                ..Default::default()
            },
        )]);
        assert_eq!(alias_owner("fresh", &on_disk, &idle), None);
        // Mid-turn, but in another project (its transcript is not here).
        let elsewhere = HashMap::from([("other-project".to_owned(), running())]);
        assert_eq!(alias_owner("fresh", &on_disk, &elsewhere), None);
    }

    fn turn(turns_started: u64, in_flight: u32, ended: Option<DateTime<Utc>>) -> AtlasActivity {
        AtlasActivity {
            in_flight,
            last_turn_end: ended,
            turns_started,
        }
    }

    /// A terminal `claude` started during an Atlas turn was claimed as an
    /// alias and hidden until restart. Its next write, with the owner idle,
    /// gives it back.
    #[test]
    fn a_provisional_alias_written_outside_its_owners_turn_is_revoked() {
        let now = Utc::now();
        let idle = turn(1, 0, Some(now - chrono::Duration::minutes(2)));
        assert_eq!(
            review_alias(Some(now), false, 1, Some(&idle)),
            AliasVerdict::Revoke
        );
        assert_eq!(
            review_alias(Some(now), false, 1, None),
            AliasVerdict::Revoke,
            "an owner Atlas never prompted explains nothing"
        );
        assert_eq!(
            review_alias(None, false, 1, Some(&idle)),
            AliasVerdict::Keep
        );
    }

    #[test]
    fn a_write_within_the_slack_after_the_owners_turn_does_not_revoke() {
        let ended = Utc::now() - chrono::Duration::seconds(30);
        let just_ended = turn(1, 0, Some(ended));
        let trailing = ended + chrono::Duration::seconds(2);
        assert_eq!(
            review_alias(Some(trailing), true, 1, Some(&just_ended)),
            AliasVerdict::Keep
        );
    }

    #[test]
    fn a_later_owner_turn_writing_only_the_alias_confirms_it() {
        let now = Utc::now();
        // The claiming turn writes both files: proves nothing.
        assert_eq!(
            review_alias(Some(now), true, 1, Some(&turn(1, 1, None))),
            AliasVerdict::Keep
        );
        assert_eq!(
            review_alias(Some(now), false, 1, Some(&turn(1, 1, None))),
            AliasVerdict::Keep,
            "still the claiming turn"
        );
        // A later turn that also wrote the owner's own file: not yet.
        assert_eq!(
            review_alias(Some(now), true, 1, Some(&turn(2, 1, None))),
            AliasVerdict::Keep
        );
        // A later turn writing only the alias.
        assert_eq!(
            review_alias(Some(now), false, 1, Some(&turn(2, 1, None))),
            AliasVerdict::Confirm
        );
    }

    /// End to end through the host: claim, revoke on a stray write; claim,
    /// confirm on a later turn, and the confirmed alias is in the store.
    #[tokio::test]
    async fn aliases_are_revoked_or_confirmed_by_what_writes_them() {
        let (host, dir) = fresh_host();
        let history = host.history().expect("history");
        let mut owner_row = atlas_thread_metadata::ThreadMetadata::new(
            atlas_thread_metadata::ThreadId::new(),
            "some-agent".into(),
            atlas_thread_metadata::PathList::new(&[PathBuf::from("/tmp/atlas")]),
        );
        owner_row.session_id = Some(acp::SessionId::new("hosted"));
        history.store().save_all(vec![owner_row]);
        let on_disk: std::collections::HashSet<String> = [
            "hosted".to_owned(),
            "terminal".to_owned(),
            "fresh".to_owned(),
        ]
        .into();

        // A terminal session appearing mid-turn is claimed...
        host.begin_atlas_turn("hosted");
        assert!(host.claim_for_atlas_turn("terminal", &on_disk));
        host.end_atlas_turn("hosted");
        // ...and revoked by its own write a minute later.
        let stray = HashMap::from([(
            "terminal".to_owned(),
            Utc::now() + chrono::Duration::minutes(1),
        )]);
        assert_eq!(host.review_aliases(&stray), ["terminal".to_owned()]);
        assert!(!host.atlas_activity().contains_key("terminal"));
        assert!(!host
            .known_or_atlas_owned(history)
            .contains(&acp::SessionId::new("terminal")));

        // The real continuation: claimed in turn 2, written alone in turn 3.
        host.begin_atlas_turn("hosted");
        assert!(host.claim_for_atlas_turn("fresh", &on_disk));
        host.end_atlas_turn("hosted");
        host.begin_atlas_turn("hosted");
        let only_alias = HashMap::from([("fresh".to_owned(), Utc::now())]);
        assert!(host.review_aliases(&only_alias).is_empty());
        assert_eq!(
            history
                .store()
                .session_aliases()
                .get(&acp::SessionId::new("fresh")),
            Some(&acp::SessionId::new("hosted")),
            "confirmed, and persisted"
        );
        assert!(
            host.atlas_activity().contains_key("fresh"),
            "a confirmed alias still carries its owner's activity"
        );
        host.end_atlas_turn("hosted");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_alias_carries_its_owners_activity() {
        let (host, dir) = fresh_host();
        host.begin_atlas_turn("hosted");
        let on_disk: std::collections::HashSet<String> =
            ["hosted".to_owned(), "fresh".to_owned()].into();
        assert!(host.claim_for_atlas_turn("fresh", &on_disk));
        let now = Utc::now();
        assert!(
            !live_elsewhere(Some(now), host.atlas_activity().get("fresh"), now),
            "Atlas's own continuation is not live elsewhere"
        );
        // And an import skips it.
        let history = host.history().expect("history");
        assert!(host
            .known_or_atlas_owned(history)
            .contains(&acp::SessionId::new("fresh")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn live_elsewhere_needs_a_recent_write() {
        let now = Utc::now();
        let recent = Some(now - chrono::Duration::seconds(5));
        let old = Some(now - chrono::Duration::seconds(600));
        assert!(live_elsewhere(recent, None, now));
        assert!(!live_elsewhere(old, None, now));
        assert!(!live_elsewhere(None, None, now));
    }

    /// The review finding: opening a row binds the session, and binding used
    /// to count as "hosted", so the guard went away the moment the user could
    /// act on it. Bound with no Atlas turn is still a terminal's session.
    #[test]
    fn a_bound_but_idle_session_with_a_fresh_write_is_live_elsewhere() {
        let now = Utc::now();
        let written = Some(now - chrono::Duration::seconds(10));
        // Opened in Atlas, never prompted from it: no activity recorded.
        assert!(live_elsewhere(
            written,
            Some(&AtlasActivity::default()),
            now
        ));
        // Prompted from Atlas long before the terminal's write.
        let idle = AtlasActivity {
            in_flight: 0,
            last_turn_end: Some(now - chrono::Duration::minutes(10)),
            ..Default::default()
        };
        assert!(live_elsewhere(written, Some(&idle), now));
    }

    #[test]
    fn a_session_with_an_atlas_turn_in_flight_is_not_live_elsewhere() {
        let now = Utc::now();
        let running = AtlasActivity {
            in_flight: 1,
            last_turn_end: None,
            ..Default::default()
        };
        assert!(!live_elsewhere(Some(now), Some(&running), now));
    }

    #[test]
    fn a_write_just_after_atlas_turn_ended_is_atlas_own() {
        let now = Utc::now();
        let ended = now - chrono::Duration::seconds(20);
        let done = AtlasActivity {
            in_flight: 0,
            last_turn_end: Some(ended),
            ..Default::default()
        };
        let trailing = ended + chrono::Duration::seconds(2);
        assert!(!live_elsewhere(Some(trailing), Some(&done), now));
        assert!(!live_elsewhere(Some(ended), Some(&done), now));
    }

    #[test]
    fn a_write_well_after_atlas_turn_ended_is_live_elsewhere() {
        let now = Utc::now();
        let ended = now - chrono::Duration::seconds(60);
        let done = AtlasActivity {
            in_flight: 0,
            last_turn_end: Some(ended),
            ..Default::default()
        };
        let later = ended + chrono::Duration::seconds(30);
        assert!(live_elsewhere(Some(later), Some(&done), now));
    }

    /// Rows recorded before the fix kept only the marker line. They read as
    /// the default title rather than as scaffolding, and a clean title is left
    /// alone.
    #[test]
    fn a_row_named_after_injected_memory_reads_as_the_default_title() {
        let mut row = ThreadMetadata::new(
            ThreadId::new(),
            ThreadAgentId::new(ATLAS_AGENT_ID),
            PathList::default(),
        );

        row.title = Some("--- SHARED MEMORY ---".into());
        assert_eq!(
            thread_row(&row, &no_live()).title,
            atlas_thread_metadata::DEFAULT_THREAD_TITLE
        );

        row.title = Some("Origin dropdown cleanup".into());
        assert_eq!(
            thread_row(&row, &no_live()).title,
            "Origin dropdown cleanup"
        );
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

//! Ported from `agent_connection_store.rs`, function for function.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1 as acp;
use anyhow::{anyhow, Result};
use atlas_acp_thread::{AcpThread, AcpThreadHandle, AgentConnection, AgentId, LoadError};
use atlas_agent_servers::{
    AgentServer, AgentServerDelegate, ConnectOptions, CustomAgentServer,
};
use futures::future::{BoxFuture, Shared};
use futures::FutureExt;

use crate::catalog::AgentCatalog;

/// How many manager events are buffered for a slow subscriber.
const EVENT_BUFFER: usize = 64;

/// Which agent a connection is to.
///
/// Ported from Zed's `Agent` (`agent_ui.rs:425-436`). The native agent is a
/// variant rather than an id because it is always present: it is the one agent
/// a fresh install has, and no installed map can remove it (research §D12-3).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Agent {
    Native,
    Custom { id: AgentId },
}

impl Agent {
    pub fn is_native(&self) -> bool {
        matches!(self, Self::Native)
    }
}

#[derive(Clone)]
pub struct AgentConnectedState {
    pub connection: Arc<dyn AgentConnection>,
}

impl std::fmt::Debug for AgentConnectedState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentConnectedState")
            .field("agent", &self.connection.agent_id())
            .finish()
    }
}

type ConnectFuture = Shared<BoxFuture<'static, Result<AgentConnectedState, LoadError>>>;

/// The half of a connect attempt that can stop it.
///
/// The attempt runs on a task of its own so that cancelling it does not depend
/// on who happens to be awaiting the shared future. Dropping the manager's own
/// handle would not reach the work: a caller parked in `connection()` holds a
/// clone of the same `Shared` and keeps polling it, so the download finishes,
/// the process spawns and the handshake completes for an agent the user
/// already killed (ATL-228). Aborting the task drops the connect future
/// itself, and with it the child it had spawned.
#[derive(Clone, Debug)]
pub struct ConnectHandle(tokio::task::AbortHandle);

impl ConnectHandle {
    /// Stop the attempt. A no-op once it has finished.
    pub fn abort(&self) {
        self.0.abort();
    }
}

pub enum AgentConnectionEntry {
    Connecting {
        connect_task: ConnectFuture,
        /// Kept beside the future so every eviction path can reach it.
        cancel: ConnectHandle,
    },
    Connected(AgentConnectedState),
    Error { error: LoadError },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentConnectionStatus {
    Disconnected,
    Connecting,
    Connected,
}

impl AgentConnectionEntry {
    /// Resolves when the connection is up, or with why it is not.
    ///
    /// A second caller arriving mid-connect gets the same future, which is what
    /// keeps one agent to one process.
    pub fn wait_for_connection(&self) -> ConnectFuture {
        match self {
            Self::Connecting { connect_task, .. } => connect_task.clone(),
            Self::Connected(state) => {
                let state = state.clone();
                async move { Ok(state) }.boxed().shared()
            }
            Self::Error { error } => {
                let error = error.clone();
                async move { Err(error) }.boxed().shared()
            }
        }
    }

    pub fn status(&self) -> AgentConnectionStatus {
        match self {
            Self::Connecting { .. } => AgentConnectionStatus::Connecting,
            Self::Connected(_) => AgentConnectionStatus::Connected,
            Self::Error { .. } => AgentConnectionStatus::Disconnected,
        }
    }
}

/// What Zed emits with `cx.emit` on the entry and on the store.
#[derive(Clone, Debug)]
pub enum AgentManagerEvent {
    NewVersionAvailable { agent: Agent, version: String },
    LoadingStatusChanged { agent: Agent, status: Option<String> },
    Connected { agent: Agent },
    ConnectionFailed { agent: Agent, error: LoadError },
    /// The set of connections changed — one was added, dropped, or uninstalled.
    ConnectionsChanged,
}

/// How a stored session came back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeMode {
    /// The agent replayed the conversation as `session/update` notifications
    /// during `session/load`. The user sees their history.
    Replayed,
    /// The agent continued the session without replaying it (`session/resume`).
    /// The conversation works; the old messages are not there, and the user has
    /// to be told so rather than left to wonder where they went.
    WithoutHistory,
}

pub struct ResumedSession {
    pub thread: AcpThreadHandle,
    pub mode: ResumeMode,
}

/// One open session and the agent it belongs to.
#[derive(Clone)]
pub struct SessionHandle {
    pub agent: Agent,
    pub thread: AcpThreadHandle,
}

type Entry = Arc<Mutex<AgentConnectionEntry>>;

pub struct AgentManager {
    catalog: Arc<dyn AgentCatalog>,
    native: Arc<dyn AgentServer>,
    options: ConnectOptions,
    entries: Mutex<HashMap<Agent, Entry>>,
    /// Keyed by the agent as well as the id, because the id is the agent's to
    /// choose and the protocol scopes it to one client/agent pair. Keyed by the
    /// id alone, two agents that both mint `ses-1` are one entry, and the
    /// second registration silently evicts the first (ATL-230 finding 1).
    sessions: Mutex<HashMap<(Agent, acp::SessionId), SessionHandle>>,
    events: tokio::sync::broadcast::Sender<AgentManagerEvent>,
}

impl AgentManager {
    /// Must be built inside a tokio runtime: it starts the task that watches the
    /// installed map, which is Zed's `cx.subscribe(&agent_server_store, …)`.
    pub fn new(
        catalog: Arc<dyn AgentCatalog>,
        native: Arc<dyn AgentServer>,
        options: ConnectOptions,
    ) -> Arc<Self> {
        let (events, _) = tokio::sync::broadcast::channel(EVENT_BUFFER);
        let this = Arc::new(Self {
            catalog,
            native,
            options,
            entries: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            events,
        });

        let mut updates = this.catalog.updates();
        let weak = Arc::downgrade(&this);
        tokio::spawn(async move {
            while updates.changed().await.is_ok() {
                let Some(this) = weak.upgrade() else {
                    return;
                };
                this.handle_agent_servers_updated();
            }
        });

        this
    }

    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<AgentManagerEvent> {
        self.events.subscribe()
    }

    pub fn entry(&self, key: &Agent) -> Option<Entry> {
        self.lock_entries().get(key).cloned()
    }

    pub fn connection_status(&self, key: &Agent) -> AgentConnectionStatus {
        self.entry(key)
            .map(|entry| lock(&entry).status())
            .unwrap_or(AgentConnectionStatus::Disconnected)
    }

    pub fn agent_version(&self, key: &Agent) -> Option<Arc<str>> {
        match &*lock(&self.entry(key)?) {
            AgentConnectionEntry::Connected(state) => state.connection.agent_version(),
            AgentConnectionEntry::Connecting { .. } | AgentConnectionEntry::Error { .. } => None,
        }
    }

    /// Every connection that is up right now.
    pub fn connections(&self) -> Vec<(Agent, Arc<dyn AgentConnection>)> {
        self.lock_entries()
            .iter()
            .filter_map(|(key, entry)| match &*lock(entry) {
                AgentConnectionEntry::Connected(state) => {
                    Some((key.clone(), state.connection.clone()))
                }
                _ => None,
            })
            .collect()
    }

    /// The live connection for one key, or `None` if it is not connected.
    ///
    /// The synchronous counterpart to [`Self::connection`], which waits for one:
    /// this answers about the connection that exists right now. The map is keyed
    /// by [`Agent`], so it is a lookup rather than the scan
    /// [`Self::connections`] would make the caller write.
    pub fn connected(&self, key: &Agent) -> Option<Arc<dyn AgentConnection>> {
        match &*lock(&self.entry(key)?) {
            AgentConnectionEntry::Connected(state) => Some(state.connection.clone()),
            _ => None,
        }
    }

    /// The live connection an ACP agent id names.
    ///
    /// By id rather than by key, for the callers that only have one: a
    /// connection-level event names the agent that raised it and nothing else.
    /// A scan, because the id is not the key — the native agent's key carries
    /// no id at all.
    pub fn connection_by_agent_id(&self, agent_id: &AgentId) -> Option<Arc<dyn AgentConnection>> {
        self.connections()
            .into_iter()
            .find(|(_, connection)| &connection.agent_id() == agent_id)
            .map(|(_, connection)| connection)
    }

    /// Ported from `restart_connection` (`:127-141`).
    ///
    /// A restart while a connect is already in flight is a no-op: that attempt
    /// *is* the restart, and tearing it down would leave the caller waiting on a
    /// future nobody is driving.
    pub fn restart_connection(self: &Arc<Self>, key: Agent, server: Arc<dyn AgentServer>) -> Entry {
        self.open_entry(key, server, Reuse::Replace)
    }

    /// Connect to `key`, resolving which server backs it.
    ///
    /// Zed resolves the server in its UI layer and passes it to
    /// `request_connection`; Atlas has no such layer, so this is where the two
    /// halves meet. An agent nobody installed produces an `Error` entry that is
    /// never stored — installing it and asking again starts a real attempt.
    pub fn connect_to(self: &Arc<Self>, key: Agent) -> Entry {
        // A fast path, not a guard. Two callers arriving together both fall
        // through to `request_connection`, which makes the decision under one
        // lock; resolving a server twice costs an `Arc` and starts nothing.
        if let Some(entry) = self.entry(&key) {
            return entry;
        }
        match self.server_for(&key) {
            Ok(server) => self.request_connection(key, server),
            Err(error) => Arc::new(Mutex::new(AgentConnectionEntry::Error { error })),
        }
    }

    /// Drop `key`'s connection and forget its sessions.
    ///
    /// Zed does this implicitly — the entry goes when the last view holding it
    /// does. Atlas's UI can close an agent explicitly (`agents_kill`), and the
    /// next request has to start a fresh process rather than hand back a
    /// connection to one that is gone.
    pub fn drop_connection(&self, key: &Agent) {
        let removed = self.lock_entries().remove(key);
        let Some(entry) = removed else {
            return;
        };
        cancel_connect(&entry);
        self.forget_sessions_for(key);
        self.emit(AgentManagerEvent::ConnectionsChanged);
    }

    /// Drop every connection and forget every session.
    ///
    /// The app calls this on its way out, where `process::exit` skips `Drop`
    /// and anything not released here is a child process that outlives Atlas.
    /// It sweeps the maps rather than iterating [`Self::connections`], because
    /// that yields only entries that reached `Connected` — an attempt still in
    /// flight is invisible to it, and is exactly the case that spawns a child
    /// moments after the app decided to leave.
    pub fn shutdown(&self) {
        let entries: Vec<Entry> = self.lock_entries().drain().map(|(_, entry)| entry).collect();
        for entry in &entries {
            cancel_connect(entry);
        }
        let had_sessions = {
            let mut sessions = self.lock_sessions();
            let had = !sessions.is_empty();
            sessions.clear();
            had
        };
        if !entries.is_empty() || had_sessions {
            self.emit(AgentManagerEvent::ConnectionsChanged);
        }
    }

    /// Forget every session open on `key`.
    ///
    /// Called from every path that evicts a connection, not just the explicit
    /// one. A session pins the connection `Arc` — `SessionHandle` holds the
    /// thread, and the thread holds the connection — so a session left behind
    /// after an eviction keeps the agent's process alive with nothing able to
    /// reach it — including [`Self::shutdown`] before it swept the sessions map
    /// too, which is how these outlived the app (ATL-227).
    ///
    /// Local only: the sessions are not closed on the agent first. A version
    /// bump and an uninstall both end with that process being dropped, and a
    /// `session/close` RPC to a peer that is about to be killed buys nothing.
    fn forget_sessions_for(&self, key: &Agent) {
        self.lock_sessions().retain(|(agent, _), _| agent != key);
    }

    /// Restart `key`, resolving its server the way [`Self::connect_to`] does.
    pub fn restart(self: &Arc<Self>, key: Agent) -> Entry {
        match self.server_for(&key) {
            Ok(server) => self.restart_connection(key, server),
            Err(error) => Arc::new(Mutex::new(AgentConnectionEntry::Error { error })),
        }
    }

    /// Ported from `request_connection` (`:143-266`).
    pub fn request_connection(self: &Arc<Self>, key: Agent, server: Arc<dyn AgentServer>) -> Entry {
        self.open_entry(key, server, Reuse::Existing)
    }

    /// The one place an entry is created.
    ///
    /// The check and the insert are a single decision — "is anyone already
    /// connecting to this agent, and if not, start" — so they happen under one
    /// `entries` guard. Zed's original could split them because its store is
    /// `Rc`-based and confined to the GPUI main thread, where the whole body is
    /// one uninterruptible borrow. The port kept the shape and moved it onto a
    /// multi-threaded runtime, which is what let two callers each start a
    /// process 11–30% of the time (ATL-226).
    ///
    /// `start_connection` is safe to call under the guard: both `AgentServer`
    /// implementations build a boxed future and perform no I/O synchronously,
    /// and neither can reach back into the manager. The `emit` and `watch_*`
    /// calls stay outside it — they spawn tasks that take the same lock.
    fn open_entry(self: &Arc<Self>, key: Agent, server: Arc<dyn AgentServer>, reuse: Reuse) -> Entry {
        let (entry, connect_task, replaced) = {
            let mut entries = self.lock_entries();
            match entries.get(&key) {
                Some(existing) if reuse == Reuse::Existing => return existing.clone(),
                // A restart while a connect is already in flight is a no-op:
                // that attempt *is* the restart, and tearing it down would
                // leave its callers waiting on a future nobody is driving.
                Some(existing)
                    if matches!(&*lock(existing), AgentConnectionEntry::Connecting { .. }) =>
                {
                    return existing.clone()
                }
                _ => {}
            }
            let replaced = entries.remove(&key);
            let (connect_task, cancel) = self.start_connection(&key, server);
            let entry: Entry = Arc::new(Mutex::new(AgentConnectionEntry::Connecting {
                connect_task: connect_task.clone(),
                cancel,
            }));
            entries.insert(key.clone(), entry.clone());
            (entry, connect_task, replaced)
        };

        if let Some(replaced) = replaced {
            // The replaced connection is unreachable from the map now, so
            // anything still pinning it would keep its process alive for good.
            cancel_connect(&replaced);
            self.forget_sessions_for(&key);
        }
        self.emit(AgentManagerEvent::ConnectionsChanged);

        self.watch_connect_result(key.clone(), &entry, connect_task);
        self.watch_new_version(key.clone(), &entry);
        self.watch_loading_status(key, &entry);

        entry
    }

    /// Which server backs this key.
    ///
    /// The native agent is always available; an external one exists only if the
    /// installed map has an entry for it. There is no fallback, no PATH lookup
    /// and no auto-acquire — an agent nobody installed simply is not there
    /// (research §D12-3, LOCKED).
    pub fn server_for(&self, key: &Agent) -> Result<Arc<dyn AgentServer>, LoadError> {
        match key {
            Agent::Native => Ok(self.native.clone()),
            Agent::Custom { id } => {
                if self.catalog.agent_server(id).is_none() {
                    return Err(LoadError::Unsupported {
                        message: format!("`{id}` is not installed").into(),
                    });
                }
                Ok(Arc::new(
                    CustomAgentServer::new(id.clone())
                        .with_default_mode(self.catalog.default_mode(id)),
                ))
            }
        }
    }

    /// Ported from `start_connection` (`:284-312`).
    ///
    /// The attempt is spawned rather than left for the first poller, so that
    /// the returned [`ConnectHandle`] can actually stop it. See that type for
    /// why dropping the future is not enough.
    fn start_connection(
        &self,
        key: &Agent,
        server: Arc<dyn AgentServer>,
    ) -> (ConnectFuture, ConnectHandle) {
        let delegate = match key {
            Agent::Native => Some(AgentServerDelegate::native()),
            Agent::Custom { id } => self.catalog.agent_server(id).map(AgentServerDelegate::new),
        };
        let options = self.options.clone();
        let connect = match delegate {
            Some(delegate) => server.connect(delegate, options),
            // Uninstalled between `server_for` and here. Falling through to the
            // native delegate used to report "no command resolver for agent
            // `x`" — a description of Atlas's own plumbing rather than of what
            // happened to the user (ATL-230 finding 2).
            None => {
                let error = LoadError::Unsupported {
                    message: format!("`{}` is not installed", agent_label(key)).into(),
                };
                async move { Err(anyhow::Error::from(error)) }.boxed()
            }
        };

        let task = tokio::spawn(connect);
        let cancel = ConnectHandle(task.abort_handle());
        let future = async move {
            match task.await {
                Ok(Ok(connection)) => Ok(AgentConnectedState { connection }),
                Ok(Err(err)) => Err(match err.downcast::<LoadError>() {
                    Ok(load_error) => load_error,
                    Err(err) => LoadError::Other(err.to_string().into()),
                }),
                Err(join) if join.is_cancelled() => Err(LoadError::Other(
                    "the agent was stopped while it was connecting".into(),
                )),
                // A panic inside a connect is the agent server's bug, not a
                // reason to poison every waiter with a second panic.
                Err(join) => Err(LoadError::Other(join.to_string().into())),
            }
        }
        .boxed()
        .shared();

        (future, cancel)
    }

    fn watch_connect_result(self: &Arc<Self>, key: Agent, entry: &Entry, task: ConnectFuture) {
        let this = Arc::downgrade(self);
        let entry = Arc::downgrade(entry);
        tokio::spawn(async move {
            let result = task.await;
            let Some(this) = this.upgrade() else {
                return;
            };
            let Some(entry) = entry.upgrade() else {
                return;
            };
            // The entry may have been replaced while connecting — by a restart,
            // or by an uninstall. Anything it says now is about a connection
            // nobody asked for.
            if !this.is_current(&key, &entry) {
                return;
            }

            match result {
                Ok(state) => {
                    let mut slot = lock(&entry);
                    if matches!(&*slot, AgentConnectionEntry::Connecting { .. }) {
                        *slot = AgentConnectionEntry::Connected(state);
                    }
                    drop(slot);
                    this.emit(AgentManagerEvent::Connected { agent: key });
                }
                Err(error) => {
                    let mut slot = lock(&entry);
                    if matches!(&*slot, AgentConnectionEntry::Connecting { .. }) {
                        *slot = AgentConnectionEntry::Error {
                            error: error.clone(),
                        };
                    }
                    drop(slot);
                    // Dropped from the table, not left as a tombstone: whoever
                    // holds this entry sees the error, and the next request
                    // starts fresh instead of replaying it.
                    this.lock_entries().remove(&key);
                    this.emit(AgentManagerEvent::ConnectionFailed {
                        agent: key,
                        error,
                    });
                    this.emit(AgentManagerEvent::ConnectionsChanged);
                }
            }
        });
    }

    /// Ported from the version watcher (`:209-238`).
    ///
    /// One bump is enough: the entry goes, and with it the manager's handle on a
    /// connection running the old binary. The next request starts the new one.
    fn watch_new_version(self: &Arc<Self>, key: Agent, entry: &Entry) {
        let Agent::Custom { id } = &key else {
            // Nothing versions the in-process agent but the app itself.
            return;
        };
        let Some(mut versions) = self.catalog.watch_new_version(id) else {
            return;
        };
        let this = Arc::downgrade(self);
        let entry = Arc::downgrade(entry);
        tokio::spawn(async move {
            while versions.changed().await.is_ok() {
                let version = versions.borrow_and_update().clone();
                let Some(version) = version else {
                    continue;
                };
                let Some(this) = this.upgrade() else {
                    return;
                };
                let Some(entry) = entry.upgrade() else {
                    return;
                };
                if !this.is_current(&key, &entry) {
                    return;
                }
                let removed = this.lock_entries().remove(&key);
                if let Some(removed) = removed {
                    // Including an attempt still in flight: it is resolving the
                    // command of the binary that just went stale.
                    cancel_connect(&removed);
                }
                this.forget_sessions_for(&key);
                this.emit(AgentManagerEvent::NewVersionAvailable {
                    agent: key.clone(),
                    version,
                });
                this.emit(AgentManagerEvent::ConnectionsChanged);
                return;
            }
        });
    }

    /// Ported from the loading-status watcher (`:240-263`).
    fn watch_loading_status(self: &Arc<Self>, key: Agent, entry: &Entry) {
        let Agent::Custom { id } = &key else {
            return;
        };
        let Some(mut statuses) = self.catalog.watch_loading_status(id) else {
            return;
        };
        let this = Arc::downgrade(self);
        let entry = Arc::downgrade(entry);
        tokio::spawn(async move {
            while statuses.changed().await.is_ok() {
                let status = statuses.borrow_and_update().clone();
                let Some(this) = this.upgrade() else {
                    return;
                };
                let Some(entry) = entry.upgrade() else {
                    return;
                };
                if !this.is_current(&key, &entry) {
                    return;
                }
                this.emit(AgentManagerEvent::LoadingStatusChanged {
                    agent: key.clone(),
                    status,
                });
            }
        });
    }

    /// Ported from `handle_agent_servers_updated` (`:268-282`).
    ///
    /// The native agent always survives; an external one survives only while the
    /// installed map still lists it, which is how an uninstall closes its
    /// connection.
    fn handle_agent_servers_updated(&self) {
        let installed = self.catalog.external_agents();
        let removed: Vec<(Agent, Entry)> = {
            let mut entries = self.lock_entries();
            let mut removed = Vec::new();
            entries.retain(|key, entry| {
                let installed = match key {
                    Agent::Native => true,
                    Agent::Custom { id } => installed.contains(id),
                };
                if !installed {
                    removed.push((key.clone(), entry.clone()));
                }
                installed
            });
            removed
        };
        if removed.is_empty() {
            return;
        }
        for (key, entry) in &removed {
            // An uninstall that lands mid-install used to download the archive,
            // extract it and complete the handshake anyway (ATL-228).
            cancel_connect(entry);
            self.forget_sessions_for(key);
        }
        self.emit(AgentManagerEvent::ConnectionsChanged);
    }

    fn is_current(&self, key: &Agent, entry: &Entry) -> bool {
        self.lock_entries()
            .get(key)
            .is_some_and(|current| Arc::ptr_eq(current, entry))
    }

    fn emit(&self, event: AgentManagerEvent) {
        // No subscribers is normal — the events are for a UI that may not be
        // attached yet.
        let _ = self.events.send(event);
    }

    fn lock_entries(&self) -> std::sync::MutexGuard<'_, HashMap<Agent, Entry>> {
        self.entries.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    // ---- sessions -------------------------------------------------------

    /// Connect if needed, then open a session on that agent.
    pub async fn new_session(
        self: &Arc<Self>,
        agent: Agent,
        work_dirs: Vec<PathBuf>,
    ) -> Result<AcpThreadHandle> {
        let connection = self.connection(agent.clone()).await?;
        let thread = connection.new_session(work_dirs).await?;
        self.register_session(agent, &thread);
        Ok(thread)
    }

    /// Reopen a stored session with its history.
    pub async fn load_session(
        self: &Arc<Self>,
        agent: Agent,
        session_id: acp::SessionId,
        work_dirs: Vec<PathBuf>,
        title: Option<Arc<str>>,
    ) -> Result<AcpThreadHandle> {
        let connection = self.connection(agent.clone()).await?;
        if !connection.supports_load_session() {
            return Err(anyhow!("this agent cannot load stored sessions"));
        }
        let thread = connection.load_session(session_id, work_dirs, title).await?;
        self.register_session(agent, &thread);
        Ok(thread)
    }

    /// Reopen a stored session without replaying it.
    pub async fn resume_session(
        self: &Arc<Self>,
        agent: Agent,
        session_id: acp::SessionId,
        work_dirs: Vec<PathBuf>,
        title: Option<Arc<str>>,
    ) -> Result<AcpThreadHandle> {
        let connection = self.connection(agent.clone()).await?;
        if !connection.supports_resume_session() {
            return Err(anyhow!("this agent cannot resume sessions"));
        }
        let thread = connection
            .resume_session(session_id, work_dirs, title)
            .await?;
        self.register_session(agent, &thread);
        Ok(thread)
    }

    /// Bring a stored session back to life, by whatever the agent advertised.
    ///
    /// Ported from Zed's resume ladder (`conversation_view.rs:1109-1143`):
    /// `session/load` when the agent advertises `loadSession`, else
    /// `session/resume` when it advertises `sessionCapabilities.resume`, else
    /// an error naming the limitation. The connection is obtained the usual
    /// way, so an agent that is not running is started first — resume is one
    /// action, not two.
    ///
    /// A failure here is a failure. It never falls back to starting a fresh
    /// session: the user clicked a specific conversation, and quietly handing
    /// them an empty one instead is worse than saying the agent could not
    /// reopen it. The history row is untouched either way — only the user
    /// deletes rows.
    pub async fn resume_stored_session(
        self: &Arc<Self>,
        agent: Agent,
        session_id: acp::SessionId,
        work_dirs: Vec<PathBuf>,
        title: Option<Arc<str>>,
    ) -> Result<ResumedSession> {
        let connection = self.connection(agent.clone()).await?;
        let (thread, mode) = if connection.supports_load_session() {
            let thread = connection
                .clone()
                .load_session(session_id, work_dirs, title)
                .await?;
            // `Replayed` restates the advertised capability rather than
            // observing the replay, and ATL-230 finding 3 is right that this is
            // weaker than the doc comment on `ResumeMode` claims.
            //
            // Deriving it from `thread.entries().is_empty()` here was tried and
            // reverted: for every EXTERNAL agent the replay frames are
            // *enqueued* rather than applied by the time this returns.
            // `handle_session_notification` goes through the connection's
            // ordered dispatch queue (`atlas-agent-servers/src/handlers.rs`,
            // `spawn_dispatch_queue`) drained on its own task, while the
            // `session/load` response resolves on the RPC path with no barrier
            // between them — so an empty thread here means "not drained yet"
            // as often as it means "the agent replayed nothing", and the check
            // told users their history was gone on conversations that had it.
            //
            // The signal belongs to the connection, which is the only layer
            // that knows a frame arrived: count the `session/update`s received
            // between the load request and its response, or flush the dispatch
            // queue before `open_or_create_session` returns. Until then the
            // frontend's own empty-thread fallback
            // (`src/features/chat/lib/resume-session.ts`) is what covers this.
            (thread, ResumeMode::Replayed)
        } else if connection.supports_resume_session() {
            let thread = connection
                .clone()
                .resume_session(session_id, work_dirs, title)
                .await?;
            (thread, ResumeMode::WithoutHistory)
        } else {
            return Err(anyhow!(
                "Loading or resuming sessions is not supported by this agent."
            ));
        };
        self.register_session(agent, &thread);
        Ok(ResumedSession { thread, mode })
    }

    /// Ask the agent to forget a stored session — only if it advertised that it
    /// can. Answers whether it was asked.
    ///
    /// Zed's archive-view delete (`threads_archive_view.rs:807-851`): the local
    /// row is removed by the caller first and unconditionally, and this is the
    /// best-effort second half. `session/delete` rides on the session-list
    /// object, which exists only when the agent advertised
    /// `sessionCapabilities.list` — so an agent with no listable history is
    /// never sent one, whatever else it claims.
    ///
    /// Like Zed, this connects if the agent is not running: a conversation the
    /// user deleted should not stay on the agent's disk until they happen to
    /// start it again.
    pub async fn delete_stored_session(
        self: &Arc<Self>,
        agent: Agent,
        session_id: &acp::SessionId,
    ) -> Result<bool> {
        let connection = self.connection(agent).await?;
        let Some(list) = connection.session_list().filter(|list| list.supports_delete()) else {
            return Ok(false);
        };
        list.delete_session(session_id).await?;
        Ok(true)
    }

    /// The session an id names.
    ///
    /// The id alone is not a key — see [`Self::sessions`] — so this answers
    /// only when exactly one agent has a session by that name. Two agents that
    /// minted the same id is a case Atlas cannot resolve from an id alone, and
    /// picking one would route a user's message into another agent's
    /// conversation. Saying "no such session" is wrong in a way the user can
    /// see and recover from; the other is wrong invisibly.
    pub fn session(&self, session_id: &acp::SessionId) -> Option<SessionHandle> {
        let sessions = self.lock_sessions();
        let mut matching = sessions
            .iter()
            .filter(|((_, id), _)| id == session_id)
            .map(|(_, handle)| handle);
        let found = matching.next()?;
        if matching.next().is_some() {
            tracing::error!(
                session = %session_id,
                "two connected agents are using this session id; refusing to guess which one is meant"
            );
            return None;
        }
        Some(found.clone())
    }

    /// Every open session id.
    ///
    /// Ids can repeat across agents: they come from the agent verbatim, and the
    /// protocol scopes them to one client/agent pair rather than to the app.
    /// Whether any agent has a session by this id.
    ///
    /// The question [`Self::session`] cannot answer on its own, because it
    /// refuses an ambiguous id — and "two agents have it" is a different thing
    /// from "nobody does".
    fn knows_session(&self, session_id: &acp::SessionId) -> bool {
        self.lock_sessions()
            .keys()
            .any(|(_, id)| id == session_id)
    }

    pub fn sessions(&self) -> Vec<acp::SessionId> {
        self.lock_sessions()
            .keys()
            .map(|(_, session_id)| session_id.clone())
            .collect()
    }

    /// Run one turn.
    ///
    /// This is Zed's `AcpThread::send` (`acp_thread.rs`): the user's message is
    /// added optimistically so it renders before the agent answers, the turn is
    /// opened, and the turn is closed with whatever the agent stopped for. A
    /// failed prompt marks the thread rather than silently leaving it
    /// generating.
    pub async fn send(
        &self,
        session_id: &acp::SessionId,
        content: Vec<acp::ContentBlock>,
    ) -> Result<acp::StopReason> {
        let handle = self
            .session(session_id)
            .ok_or_else(|| anyhow!("unknown session: {session_id}"))?;
        let connection = lock_thread(&handle.thread).connection().clone();

        // An agent that accepts client-generated message ids gets one, which is
        // what lets a later truncate name this message.
        let client_ids = connection.client_user_message_ids();
        let client_id = client_ids.as_ref().map(|caps| caps.new_id());

        // The turn's identity is kept, not dropped. `begin_turn` supersedes any
        // turn still running, so a send that overlaps another leaves the older
        // one to return later — and closing the thread's turn unconditionally
        // meant the *cancelled* turn closed the *live* one (ATL-229).
        let turn = {
            let mut thread = lock_thread(&handle.thread);
            for block in &content {
                thread.push_user_content_block(client_id.clone(), block.clone());
            }
            thread.begin_turn()
        };

        let request = acp::PromptRequest::new(session_id.clone(), content);
        let result = match (&client_ids, client_id) {
            (Some(caps), Some(id)) => caps.prompt(id, request).await,
            _ => connection.prompt(request).await,
        };

        // Either way the caller learns what happened to its own turn; what the
        // thread does about it depends on whether that turn is still the one
        // running.
        match result {
            Ok(response) => {
                lock_thread(&handle.thread).end_turn_unless_superseded(turn, response.stop_reason);
                Ok(response.stop_reason)
            }
            Err(err) => {
                lock_thread(&handle.thread).set_error_unless_superseded(turn);
                Err(err)
            }
        }
    }

    /// Stop the running turn. Safe to call when nothing is running.
    pub fn cancel(&self, session_id: &acp::SessionId) {
        if let Some(handle) = self.session(session_id) {
            lock_thread(&handle.thread).cancel();
        }
    }

    /// Close a session, dropping the manager's handle on its thread.
    ///
    /// An id that names nothing is `Ok`: a tab can close twice, and a session
    /// already forgotten by an eviction has nothing left to close. An id that
    /// names *two* sessions is an error rather than a silent success — see
    /// [`Self::session`] — because the caller asked for something to happen and
    /// nothing did.
    pub async fn close_session(&self, session_id: &acp::SessionId) -> Result<()> {
        if !self.knows_session(session_id) {
            return Ok(());
        }
        let Some(handle) = self.session(session_id) else {
            return Err(anyhow!(
                "two connected agents are using session {session_id}; \
                 close it through the agent that owns it"
            ));
        };
        self.lock_sessions()
            .remove(&(handle.agent.clone(), session_id.clone()));
        let connection = lock_thread(&handle.thread).connection().clone();
        if connection.supports_close_session() {
            connection.close_session(session_id.clone()).await?;
        }
        Ok(())
    }

    /// The connection for `agent`, connecting first if it is not up.
    pub async fn connection(self: &Arc<Self>, agent: Agent) -> Result<Arc<dyn AgentConnection>> {
        let entry = self.connect_to(agent);
        let task = lock(&entry).wait_for_connection();
        let state = task.await.map_err(anyhow::Error::from)?;
        Ok(state.connection)
    }

    fn register_session(&self, agent: Agent, thread: &AcpThreadHandle) {
        let session_id = lock_thread(thread).session_id().clone();
        self.lock_sessions().insert(
            (agent.clone(), session_id),
            SessionHandle {
                agent,
                thread: thread.clone(),
            },
        );
    }

    fn lock_sessions(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<(Agent, acp::SessionId), SessionHandle>> {
        self.sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Whether an entry already in the table settles the request, or is being
/// replaced by it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Reuse {
    Existing,
    Replace,
}

/// Stop an evicted entry's connect attempt, if it had one still running.
fn cancel_connect(entry: &Entry) {
    if let AgentConnectionEntry::Connecting { cancel, .. } = &*lock(entry) {
        cancel.abort();
    }
}

/// How an agent names itself in an error a user reads.
fn agent_label(key: &Agent) -> String {
    match key {
        Agent::Native => "the built-in agent".to_string(),
        Agent::Custom { id } => id.to_string(),
    }
}

fn lock(entry: &Entry) -> std::sync::MutexGuard<'_, AgentConnectionEntry> {
    entry.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn lock_thread(thread: &AcpThreadHandle) -> std::sync::MutexGuard<'_, AcpThread> {
    thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

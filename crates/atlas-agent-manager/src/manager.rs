//! The connection table and session registry behind [`AgentManager`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_client_protocol::schema::v1 as acp;
use anyhow::{anyhow, Result};
use atlas_acp_thread::{AcpThread, AcpThreadHandle, AgentConnection, AgentId, LoadError};
use atlas_agent_servers::{AgentServer, AgentServerDelegate, ConnectOptions, CustomAgentServer};
use futures::future::{BoxFuture, Shared};
use futures::FutureExt;

use crate::catalog::AgentCatalog;

/// How many manager events are buffered for a slow subscriber.
const EVENT_BUFFER: usize = 64;

/// The ceiling on one connect attempt, end to end.
///
/// The attempt includes resolving the command — which for an external agent
/// may be a download and an install — so this is minutes, not seconds. Its
/// job is not to be a good estimate; the transport already bounds each hop
/// (`INITIALIZE_TIMEOUT`, `REQUEST_TIMEOUT` in atlas-agent-servers). Its job
/// is to make "a `Connecting` entry is permanent" impossible: whatever hangs
/// inside the attempt, the entry becomes an error and is evicted, and the
/// next request starts fresh.
pub const CONNECT_DEADLINE: Duration = Duration::from_secs(20 * 60);

/// How old an in-flight connect must be before a restart replaces it.
///
/// Younger than this, a restart is a no-op: that attempt *is* the restart,
/// and tearing it down would leave the caller waiting on a future nobody is
/// driving (invariants.rs: `a_restart_racing_a_request_abandons_no_connect`).
/// Older, the attempt is what the user is trying to escape — a handshake that
/// has not answered in 30 s is not about to — so the restart cancels it and
/// starts over, which is what a button labelled Restart has to mean.
pub const RESTART_STALE_AFTER: Duration = Duration::from_secs(30);

/// The two clocks above, held on the manager so a test can shorten them. The
/// defaults are the constants; nothing in the app changes them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Deadlines {
    pub connect: Duration,
    pub restart_stale_after: Duration,
}

impl Default for Deadlines {
    fn default() -> Self {
        Self {
            connect: CONNECT_DEADLINE,
            restart_stale_after: RESTART_STALE_AFTER,
        }
    }
}

/// Which agent a connection is to.
///
/// The native agent is a
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
        /// When the attempt began, so a restart can tell a fresh attempt it
        /// should join from a stale one it should replace.
        started_at: Instant,
    },
    Connected(AgentConnectedState),
    Error {
        error: LoadError,
    },
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

/// What the manager announces about an entry or about itself.
#[derive(Clone, Debug)]
pub enum AgentManagerEvent {
    NewVersionAvailable {
        agent: Agent,
        version: String,
    },
    LoadingStatusChanged {
        agent: Agent,
        status: Option<String>,
    },
    Connected {
        agent: Agent,
    },
    ConnectionFailed {
        agent: Agent,
        error: LoadError,
    },
    /// The set of connections changed — one was added, dropped, or uninstalled.
    ConnectionsChanged,
    /// A connected agent's process exited and its connection was dropped
    /// (`evict_when_exited`). The manager has forgotten its sessions; whoever
    /// holds them above it has to tell their chats, or each one's next message
    /// goes to a session id the respawned agent has never heard of.
    ConnectionExited {
        agent: Agent,
    },
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
    deadlines: Mutex<Deadlines>,
}

impl AgentManager {
    /// Must be built inside a tokio runtime: it starts the task that watches the
    /// installed map.
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
            deadlines: Mutex::new(Deadlines::default()),
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

    /// Shorten the connect ceiling and the stale-restart threshold. Test-facing:
    /// the defaults are minutes and seconds, and a test that waits them out
    /// proves nothing a shorter one would not. Applies to attempts started
    /// after the call.
    pub fn set_deadlines(&self, deadlines: Deadlines) {
        *self
            .deadlines
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = deadlines;
    }

    fn deadlines(&self) -> Deadlines {
        *self
            .deadlines
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
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

    /// Whether `key`'s agent advertised `mcpCapabilities.http` at
    /// `initialize` — the one fact that decides whether it can be handed an
    /// HTTP MCP server. `None` while it is not connected: capabilities exist
    /// only once the handshake has answered.
    pub fn supports_http_mcp(&self, key: &Agent) -> Option<bool> {
        self.connected(key)
            .map(|connection| connection.supports_http_mcp())
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

    /// A restart while a young connect is already in flight is a no-op: that
    /// attempt *is* the restart. One older than [`RESTART_STALE_AFTER`] is
    /// cancelled and replaced — see `open_entry`.
    pub fn restart_connection(self: &Arc<Self>, key: Agent, server: Arc<dyn AgentServer>) -> Entry {
        self.open_entry(key, server, Reuse::Replace)
    }

    /// Connect to `key`, resolving which server backs it.
    ///
    /// Atlas has no UI layer that resolves the server and passes it to
    /// `request_connection`, so this is where the two halves meet. An agent nobody installed produces an `Error` entry that is
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
    /// Atlas's UI can close an agent explicitly (`agents_kill`), and the
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
        let entries: Vec<Entry> = self
            .lock_entries()
            .drain()
            .map(|(_, entry)| entry)
            .collect();
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
    /// Local only: the sessions are not closed on the agent first. An update
    /// and an uninstall both end with that process being dropped, and a
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

    pub fn request_connection(self: &Arc<Self>, key: Agent, server: Arc<dyn AgentServer>) -> Entry {
        self.open_entry(key, server, Reuse::Existing)
    }

    /// The one place an entry is created.
    ///
    /// The check and the insert are a single decision — "is anyone already
    /// connecting to this agent, and if not, start" — so they happen under one
    /// `entries` guard. Split across two lock acquisitions on the multi-threaded
    /// runtime, two callers each started a process 11–30% of the time
    /// (ATL-226).
    ///
    /// `start_connection` is safe to call under the guard: both `AgentServer`
    /// implementations build a boxed future and perform no I/O synchronously,
    /// and neither can reach back into the manager. The `emit` and `watch_*`
    /// calls stay outside it — they spawn tasks that take the same lock.
    fn open_entry(
        self: &Arc<Self>,
        key: Agent,
        server: Arc<dyn AgentServer>,
        reuse: Reuse,
    ) -> Entry {
        let (entry, connect_task, replaced, failed, statuses) = {
            let mut entries = self.lock_entries();
            // An attempt that has already failed is never handed out again,
            // however recently. Its waiters hear the error as the connect
            // resolves, but `watch_connect_result` evicts it on a task of its
            // own, so a retry arriving in between found the dead entry still
            // in the table and was handed the old failure back without a new
            // attempt — reading as `Disconnected` all the while.
            let failed = entries.get(&key).and_then(take_settled_failure);
            match entries.get(&key) {
                _ if failed.is_some() => {}
                Some(existing) if reuse == Reuse::Existing => return existing.clone(),
                // A restart while a *young* connect is in flight is a no-op:
                // that attempt *is* the restart, and tearing it down would
                // leave its callers waiting on a future nobody is driving.
                // Past `restart_stale_after` the attempt is the thing the
                // user is trying to get out of, so it falls through to the
                // replace path below: cancelled, its sessions forgotten, and
                // a fresh one started. Its waiters are released with the
                // cancellation error rather than left on the old future.
                Some(existing) if self.is_young_connect(existing) => return existing.clone(),
                _ => {}
            }
            let replaced = entries.remove(&key);
            // Subscribe BEFORE the attempt starts. A `watch` receiver treats the
            // value already in the channel as seen, so a status the connect sent
            // before a later subscribe — "Downloading Node.js…", the first thing
            // a fresh machine does — never fired `changed()`, and the tab read a
            // bare "Starting …" through the whole download.
            let statuses = self.loading_status_receiver(&key);
            let (connect_task, cancel) = self.start_connection(&key, server);
            let entry: Entry = Arc::new(Mutex::new(AgentConnectionEntry::Connecting {
                connect_task: connect_task.clone(),
                cancel,
                started_at: Instant::now(),
            }));
            entries.insert(key.clone(), entry.clone());
            (entry, connect_task, replaced, failed, statuses)
        };

        // The failed attempt is no longer current, so its own watcher will
        // stay silent; this is the one place left to announce it.
        if let Some(error) = failed {
            self.emit(AgentManagerEvent::ConnectionFailed {
                agent: key.clone(),
                error,
            });
        }
        if let Some(replaced) = replaced {
            // The replaced connection is unreachable from the map now, so
            // anything still pinning it would keep its process alive for good.
            cancel_connect(&replaced);
            self.forget_sessions_for(&key);
        }
        self.emit(AgentManagerEvent::ConnectionsChanged);

        self.watch_connect_result(key.clone(), &entry, connect_task);
        self.watch_new_version(key.clone(), &entry);
        self.watch_loading_status(key, &entry, statuses);

        entry
    }

    /// Whether `entry` is a connect attempt too recent for a restart to replace.
    fn is_young_connect(&self, entry: &Entry) -> bool {
        match &*lock(entry) {
            AgentConnectionEntry::Connecting { started_at, .. } => {
                started_at.elapsed() < self.deadlines().restart_stale_after
            }
            _ => false,
        }
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

        // The ceiling on the whole attempt — see `CONNECT_DEADLINE`. Expiry is
        // an `Err` like any other, so `watch_connect_result` evicts the entry
        // and releases every waiter, and dropping the future drops the child
        // it had spawned.
        let deadline = self.deadlines().connect;
        let label: Arc<str> = agent_label(key).into();
        let connect = async move {
            match tokio::time::timeout(deadline, connect).await {
                Ok(result) => result,
                Err(_elapsed) => Err(anyhow::Error::from(LoadError::TimedOut {
                    agent: label,
                    phase: "connect".into(),
                    after: deadline,
                    stderr: None,
                })),
            }
        };

        let task = tokio::spawn(connect);
        let cancel = ConnectHandle(task.abort_handle());
        let future = async move {
            match task.await {
                Ok(Ok(connection)) => Ok(AgentConnectedState { connection }),
                Ok(Err(err)) => Err(match err.downcast::<LoadError>() {
                    Ok(load_error) => load_error,
                    // `{:#}`, not `to_string()`: an `anyhow` chain displays
                    // only its outermost context by default, so a native
                    // engine start that failed because the account token
                    // could not be minted reached the user as the bare
                    // "starting the in-process app-server runtime" — the
                    // cause ("Atlas can't be reached") was the link that
                    // got dropped (2026-09-14).
                    Err(err) => LoadError::Other(format!("{err:#}").into()),
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
            // by an uninstall, or by a retry that found it already failed.
            // Anything it says now is about a connection nobody asked for.
            match result {
                Ok(state) => {
                    let connection = state.connection.clone();
                    if !this.mark_connected(&key, &entry, state) {
                        return;
                    }
                    this.emit(AgentManagerEvent::Connected { agent: key.clone() });
                    this.evict_when_exited(key, entry, connection);
                }
                Err(error) => {
                    // Checked, marked and dropped under one `entries` guard.
                    // Marked first and dropped after, the entry read as
                    // `Disconnected` while a request could still be handed
                    // it; and `open_entry` evicts a failed entry itself, so
                    // exactly one of the two must win and announce it.
                    {
                        let mut entries = this.lock_entries();
                        let current = entries
                            .get(&key)
                            .is_some_and(|current| Arc::ptr_eq(current, &entry));
                        if !current {
                            return;
                        }
                        take_settled_failure(&entry);
                        // Dropped from the table, not left as a tombstone:
                        // whoever holds this entry sees the error, and the
                        // next request starts fresh instead of replaying it.
                        entries.remove(&key);
                    }
                    this.emit(AgentManagerEvent::ConnectionFailed { agent: key, error });
                    this.emit(AgentManagerEvent::ConnectionsChanged);
                }
            }
        });
    }

    /// Drop the entry the moment its process exits.
    ///
    /// A connection's child dying used to reach only the sessions open on it
    /// (`emit_load_error`); the manager kept the entry as `Connected`, so the
    /// next request — a new tab, a prewarm, the sidebar sync — was handed a
    /// transport with nobody behind it and waited out `REQUEST_TIMEOUT` to
    /// learn so. With zero sessions open nothing ever told the manager at
    /// all. Now the exit evicts, and the next request starts fresh.
    fn evict_when_exited(
        self: &Arc<Self>,
        key: Agent,
        entry: Entry,
        connection: Arc<dyn AgentConnection>,
    ) {
        let this = Arc::downgrade(self);
        let entry = Arc::downgrade(&entry);
        tokio::spawn(async move {
            connection.exited().await;
            let Some(this) = this.upgrade() else {
                return;
            };
            let Some(entry) = entry.upgrade() else {
                return;
            };
            {
                let mut entries = this.lock_entries();
                let current = entries
                    .get(&key)
                    .is_some_and(|current| Arc::ptr_eq(current, &entry));
                // Replaced already (a restart, an uninstall): not ours to drop.
                if !current || !matches!(&*lock(&entry), AgentConnectionEntry::Connected(_)) {
                    return;
                }
                entries.remove(&key);
            }
            tracing::warn!(agent = ?key, "the agent process exited; its connection was dropped");
            this.forget_sessions_for(&key);
            this.emit(AgentManagerEvent::ConnectionExited { agent: key });
            this.emit(AgentManagerEvent::ConnectionsChanged);
        });
    }

    /// Watches for version bumps, without evicting the entry.
    ///
    /// Dropping the entry the moment the version moves stranded
    /// every open chat on the agent: the manager forgot their sessions while
    /// the host and the tab still held them, so the next message failed with
    /// "unknown session id" and nothing recovered it. So this only announces
    /// the bump. Whoever owns the sessions decides when the old process goes —
    /// the host waits for the agent to go idle, tells each open chat, then
    /// drops the connection (`AgentHost::apply_agent_update`). One bump per
    /// entry: the restart replaces the entry, and its successor watches anew.
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
                this.emit(AgentManagerEvent::NewVersionAvailable {
                    agent: key.clone(),
                    version,
                });
                return;
            }
        });
    }

    /// The install-progress channel for `key`, if it has one. Taken before the
    /// connect starts — see `open_entry`.
    fn loading_status_receiver(
        &self,
        key: &Agent,
    ) -> Option<tokio::sync::watch::Receiver<Option<String>>> {
        let Agent::Custom { id } = key else {
            return None;
        };
        self.catalog.watch_loading_status(id)
    }

    fn watch_loading_status(
        self: &Arc<Self>,
        key: Agent,
        entry: &Entry,
        statuses: Option<tokio::sync::watch::Receiver<Option<String>>>,
    ) {
        let Some(mut statuses) = statuses else {
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
                let current = entry
                    .upgrade()
                    .is_some_and(|entry| this.is_current(&key, &entry));
                if !current {
                    // A failed connect is evicted as it resolves, which can beat
                    // its own final clear here. A clear is always safe to deliver,
                    // and dropping it left "Installing …" on screen for good.
                    if status.is_none() {
                        this.emit(AgentManagerEvent::LoadingStatusChanged {
                            agent: key.clone(),
                            status,
                        });
                    }
                    return;
                }
                this.emit(AgentManagerEvent::LoadingStatusChanged {
                    agent: key.clone(),
                    status,
                });
            }
        });
    }

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

    /// Moves a current `Connecting` entry to `Connected`; false when the entry
    /// was replaced while it connected. Both the waiter in `connection` and the
    /// watcher in `watch_connect_result` call this, whichever the runtime
    /// polls first: with only the watcher doing it, `connection` could return
    /// a live transport while the table still read `Connecting`.
    fn mark_connected(&self, key: &Agent, entry: &Entry, state: AgentConnectedState) -> bool {
        if !self.is_current(key, entry) {
            return false;
        }
        let mut slot = lock(entry);
        if matches!(&*slot, AgentConnectionEntry::Connecting { .. }) {
            *slot = AgentConnectionEntry::Connected(state);
        }
        true
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
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
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
        let thread = connection
            .load_session(session_id, work_dirs, title)
            .await?;
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
    /// The ladder is: `session/load` when the agent advertises `loadSession`, else
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
    /// The local row is removed by the caller first and unconditionally, and this is the
    /// best-effort second half. `session/delete` rides on the session-list
    /// object, which exists only when the agent advertised
    /// `sessionCapabilities.list` — so an agent with no listable history is
    /// never sent one, whatever else it claims.
    ///
    /// This connects if the agent is not running: a conversation the
    /// user deleted should not stay on the agent's disk until they happen to
    /// start it again.
    pub async fn delete_stored_session(
        self: &Arc<Self>,
        agent: Agent,
        session_id: &acp::SessionId,
    ) -> Result<bool> {
        let connection = self.connection(agent).await?;
        let Some(list) = connection
            .session_list()
            .filter(|list| list.supports_delete())
        else {
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
    /// Ids can repeat across agents: they come from the agent unmodified, and the
    /// protocol scopes them to one client/agent pair rather than to the app.
    /// Whether any agent has a session by this id.
    ///
    /// The question [`Self::session`] cannot answer on its own, because it
    /// refuses an ambiguous id — and "two agents have it" is a different thing
    /// from "nobody does".
    fn knows_session(&self, session_id: &acp::SessionId) -> bool {
        self.lock_sessions().keys().any(|(_, id)| id == session_id)
    }

    pub fn sessions(&self) -> Vec<acp::SessionId> {
        self.lock_sessions()
            .keys()
            .map(|(_, session_id)| session_id.clone())
            .collect()
    }

    /// Run one turn.
    ///
    /// The user's message is added optimistically so it renders before the agent answers, the turn is
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
                let mut thread = lock_thread(&handle.thread);
                // The turn's token split rides on the response (claude-agent-acp
                // fills it; codex-acp does not). Folded in BEFORE the turn closes
                // so the UsageUpdated delta lands ahead of TurnFinished — the
                // renderer snapshots per-turn usage at turn end, and capture
                // flushes the turn there too. Superseded or not, the tokens
                // were spent, so this is unconditional.
                if let Some(usage) = response.usage.as_ref() {
                    thread.accumulate_turn_usage(usage);
                }
                thread.end_turn_unless_superseded(turn, response.stop_reason);
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
        let entry = self.connect_to(agent.clone());
        let task = lock(&entry).wait_for_connection();
        let state = task.await.map_err(anyhow::Error::from)?;
        let connection = state.connection.clone();
        self.mark_connected(&agent, &entry, state);
        Ok(connection)
    }

    /// Every session-opening path ends here, so this is where the one
    /// session-start line is written.
    fn register_session(&self, agent: Agent, thread: &AcpThreadHandle) {
        let (session_id, connection) = {
            let thread = lock_thread(thread);
            (thread.session_id().clone(), thread.connection().clone())
        };
        log_session_start(&connection, &session_id);
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
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
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

/// Why `entry`'s attempt failed, if it already has — marking a `Connecting`
/// whose future resolved with an error as the `Error` it now is, so whoever
/// still holds the entry reads it as failed rather than in flight.
fn take_settled_failure(entry: &Entry) -> Option<LoadError> {
    let mut slot = lock(entry);
    let error = match &*slot {
        AgentConnectionEntry::Error { error } => error.clone(),
        AgentConnectionEntry::Connecting { connect_task, .. } => {
            connect_task.peek()?.as_ref().err()?.clone()
        }
        AgentConnectionEntry::Connected(_) => return None,
    };
    *slot = AgentConnectionEntry::Error {
        error: error.clone(),
    };
    Some(error)
}

/// The one line a session start writes: which agent, and whether it
/// advertised HTTP MCP support. Answers "which installed adapters can receive
/// an HTTP MCP server" from the log of any real run.
///
/// `agent` is the stable id Atlas knows the agent by; `agent_name` is what the
/// agent called itself at `initialize`. The native agent reports
/// `http_mcp=true`: its engine takes StreamableHttp MCP servers through each
/// thread's config.
fn log_session_start(connection: &Arc<dyn AgentConnection>, session_id: &acp::SessionId) {
    tracing::info!(
        agent = %connection.agent_id(),
        agent_name = %connection.telemetry_id(),
        session_id = %session_id,
        http_mcp = connection.supports_http_mcp(),
        "agent session started"
    );
}

/// How an agent names itself in an error a user reads.
fn agent_label(key: &Agent) -> String {
    match key {
        Agent::Native => "the built-in agent".to_string(),
        Agent::Custom { id } => id.to_string(),
    }
}

fn lock(entry: &Entry) -> std::sync::MutexGuard<'_, AgentConnectionEntry> {
    entry
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn lock_thread(thread: &AcpThreadHandle) -> std::sync::MutexGuard<'_, AcpThread> {
    thread
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

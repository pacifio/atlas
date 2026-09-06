//! Test doubles that can be held still.
//!
//! The crate's original fakes resolve instantly and never spawn anything, which
//! is why every finding in ATL-226 through ATL-230 was invisible to a green
//! suite (ATL-231). These are the same seams with the two properties those
//! findings need: a connect the test can park mid-flight, and doubles that
//! report their own destruction.
//!
//! Nothing here spawns a process — `tests/handshake.rs` covers that path with a
//! real child. What these cover is the manager's own bookkeeping around a
//! connect that has not finished yet.

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1 as acp;
use anyhow::{anyhow, Result};
use atlas_acp_thread::{
    AcpThread, AcpThreadEvent, AcpThreadHandle, AgentConnection, AgentId, EventStream, LoadError,
};
use atlas_agent_manager::{
    Agent, AgentCatalog, AgentConnectedState, AgentConnectionEntry, AgentManager,
};
use atlas_agent_servers::{
    AcpConnectionDefaults, AgentServer, AgentServerCommand, AgentServerDelegate, ConnectOptions,
    ExternalAgentServer, ThreadEventSink,
};
use futures::future::BoxFuture;
use futures::FutureExt;
use tokio::sync::{oneshot, watch};

// ---------------------------------------------------------------------- gate

/// A latch a test opens when it wants the thing behind it to proceed.
///
/// `watch` rather than `Notify` because the waiter reads the current value
/// before it parks: a gate opened before anyone waits is still open, so the
/// test cannot lose the race with the task it is trying to hold.
pub struct Gate(watch::Sender<bool>);

impl Gate {
    pub fn shut() -> Arc<Self> {
        Arc::new(Self(watch::channel(false).0))
    }

    /// `send_replace` rather than `send`: a latch has to stay open even when it
    /// is opened before anything is waiting on it, and `send` throws the value
    /// away when the channel has no receivers yet.
    pub fn open(&self) {
        self.0.send_replace(true);
    }

    pub fn is_open(&self) -> bool {
        *self.0.borrow()
    }

    /// Parks until [`Self::open`]. Returns immediately if it is already open.
    pub async fn wait(&self) {
        let mut rx = self.0.subscribe();
        while !*rx.borrow_and_update() {
            if rx.changed().await.is_err() {
                return;
            }
        }
    }
}

/// Counts its own destruction unless it was told the work finished.
///
/// Held inside a future to answer "was this dropped, or did it run to
/// completion?" — the whole question in ATL-228.
pub struct CancelProbe {
    finished: AtomicBool,
    cancelled: Arc<AtomicUsize>,
}

impl CancelProbe {
    pub fn new(cancelled: Arc<AtomicUsize>) -> Self {
        Self {
            finished: AtomicBool::new(false),
            cancelled,
        }
    }

    pub fn finish(&self) {
        self.finished.store(true, Ordering::SeqCst);
    }
}

impl Drop for CancelProbe {
    fn drop(&mut self) {
        if !self.finished.load(Ordering::SeqCst) {
            self.cancelled.fetch_add(1, Ordering::SeqCst);
        }
    }
}

// ------------------------------------------------------------------- catalog

/// An installed map a test can move: add an agent, take it away, announce a new
/// version.
pub struct TestCatalog {
    agents: Mutex<Vec<AgentId>>,
    /// Agents still listed as installed whose command resolver is gone — the
    /// window between `server_for` and `start_connection` (ATL-230 finding 2).
    resolvers_hidden: Mutex<Vec<AgentId>>,
    versions: Mutex<HashMap<AgentId, watch::Sender<Option<String>>>>,
    loading: Mutex<HashMap<AgentId, watch::Sender<Option<String>>>>,
    updates: watch::Sender<u64>,
    generation: AtomicUsize,
}

impl TestCatalog {
    pub fn new(agents: &[&str]) -> Arc<Self> {
        let agents: Vec<AgentId> = agents.iter().map(|id| AgentId::new(*id)).collect();
        let versions = agents
            .iter()
            .map(|id| (id.clone(), watch::channel(None).0))
            .collect();
        let loading = agents
            .iter()
            .map(|id| (id.clone(), watch::channel(None).0))
            .collect();
        Arc::new(Self {
            agents: Mutex::new(agents),
            resolvers_hidden: Mutex::new(Vec::new()),
            versions: Mutex::new(versions),
            loading: Mutex::new(loading),
            updates: watch::channel(0).0,
            generation: AtomicUsize::new(0),
        })
    }

    pub fn announce_new_version(&self, id: &str, version: &str) {
        let versions = self.versions.lock().unwrap();
        versions[&AgentId::new(id)]
            .send(Some(version.to_owned()))
            .expect("the manager holds a receiver");
    }

    /// Take the agent's command resolver away while leaving it installed, so
    /// the manager's uninstall watcher does not fire.
    pub fn hide_resolver(&self, id: &str) {
        self.resolvers_hidden.lock().unwrap().push(AgentId::new(id));
    }

    pub fn uninstall(&self, id: &str) {
        self.agents.lock().unwrap().retain(|a| a.as_str() != id);
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) as u64 + 1;
        self.updates.send(generation).ok();
    }
}

impl AgentCatalog for TestCatalog {
    fn external_agents(&self) -> Vec<AgentId> {
        self.agents.lock().unwrap().clone()
    }

    fn agent_server(&self, id: &AgentId) -> Option<Arc<dyn ExternalAgentServer>> {
        if self.resolvers_hidden.lock().unwrap().contains(id) {
            return None;
        }
        self.agents
            .lock()
            .unwrap()
            .contains(id)
            .then(|| Arc::new(TestResolver) as Arc<dyn ExternalAgentServer>)
    }

    fn default_mode(&self, _id: &AgentId) -> Option<acp::SessionModeId> {
        None
    }

    fn watch_new_version(&self, id: &AgentId) -> Option<watch::Receiver<Option<String>>> {
        Some(self.versions.lock().unwrap().get(id)?.subscribe())
    }

    fn watch_loading_status(&self, id: &AgentId) -> Option<watch::Receiver<Option<String>>> {
        Some(self.loading.lock().unwrap().get(id)?.subscribe())
    }

    fn updates(&self) -> watch::Receiver<u64> {
        self.updates.subscribe()
    }
}

pub struct TestResolver;

impl ExternalAgentServer for TestResolver {
    fn get_command(
        &self,
        _extra_args: Vec<String>,
        _extra_env: HashMap<String, String>,
    ) -> BoxFuture<'static, Result<AgentServerCommand>> {
        async { Err(anyhow!("this test never spawns a process")) }.boxed()
    }
}

// -------------------------------------------------------------------- server

/// What a connect attempt should do.
#[derive(Clone)]
pub enum ConnectBehaviour {
    /// Resolve as soon as it is polled.
    Immediate,
    /// Park on `gate` until the test opens it, then resolve.
    Gated(Arc<Gate>),
    /// Fail without ever producing a connection.
    Fails(LoadError),
}

/// An agent server whose connect the test controls in time as well as outcome.
pub struct TestServer {
    id: AgentId,
    behaviour: Mutex<ConnectBehaviour>,
    pub attempts: Arc<AtomicUsize>,
    /// Connect futures dropped before they resolved — a cancelled connect.
    pub connects_cancelled: Arc<AtomicUsize>,
    /// Connections handed out and not yet dropped.
    pub live_connections: Arc<AtomicUsize>,
    /// Sessions opened, so each gets an id of its own.
    sessions_opened: Arc<AtomicUsize>,
    /// Prompts that reached the connection, so a test can wait for a turn to be
    /// genuinely in flight before starting the one that supersedes it.
    pub prompts_started: Arc<AtomicUsize>,
    /// Prompt answers, in the order the test wants them delivered. An empty
    /// queue means "answer immediately with `EndTurn`".
    prompts: Arc<Mutex<std::collections::VecDeque<oneshot::Receiver<Result<acp::StopReason>>>>>,
    /// One id for every session this server's connections mint, so a test can
    /// drive the collision case.
    fixed_session_id: Option<String>,
    /// Every session's event stream, kept so a test can read what the thread
    /// announced rather than inferring it from the thread's final state.
    events: Arc<Mutex<HashMap<acp::SessionId, EventStream<AcpThreadEvent>>>>,
}

impl TestServer {
    pub fn new(id: &str) -> Arc<Self> {
        Self::with_behaviour(id, ConnectBehaviour::Immediate)
    }

    pub fn gated(id: &str, gate: Arc<Gate>) -> Arc<Self> {
        Self::with_behaviour(id, ConnectBehaviour::Gated(gate))
    }

    pub fn with_behaviour(id: &str, behaviour: ConnectBehaviour) -> Arc<Self> {
        Arc::new(Self {
            id: AgentId::new(id),
            behaviour: Mutex::new(behaviour),
            attempts: Arc::new(AtomicUsize::new(0)),
            connects_cancelled: Arc::new(AtomicUsize::new(0)),
            live_connections: Arc::new(AtomicUsize::new(0)),
            sessions_opened: Arc::new(AtomicUsize::new(0)),
            prompts_started: Arc::new(AtomicUsize::new(0)),
            prompts: Arc::new(Mutex::new(Default::default())),
            fixed_session_id: None,
            events: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Every session this server's connections open answers to `session_id`.
    /// The collision ATL-230 describes, made reproducible.
    pub fn with_fixed_session_id(id: &str, session_id: &str) -> Arc<Self> {
        Arc::new(Self {
            id: AgentId::new(id),
            behaviour: Mutex::new(ConnectBehaviour::Immediate),
            attempts: Arc::new(AtomicUsize::new(0)),
            connects_cancelled: Arc::new(AtomicUsize::new(0)),
            live_connections: Arc::new(AtomicUsize::new(0)),
            sessions_opened: Arc::new(AtomicUsize::new(0)),
            prompts_started: Arc::new(AtomicUsize::new(0)),
            prompts: Arc::new(Mutex::new(Default::default())),
            fixed_session_id: Some(session_id.to_string()),
            events: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn set_behaviour(&self, behaviour: ConnectBehaviour) {
        *self.behaviour.lock().unwrap() = behaviour;
    }

    pub fn prompts_started(&self) -> usize {
        self.prompts_started.load(Ordering::SeqCst)
    }

    pub fn attempts(&self) -> usize {
        self.attempts.load(Ordering::SeqCst)
    }

    pub fn connects_cancelled(&self) -> usize {
        self.connects_cancelled.load(Ordering::SeqCst)
    }

    pub fn live_connections(&self) -> usize {
        self.live_connections.load(Ordering::SeqCst)
    }

    /// Everything a session's thread has announced since the last call.
    ///
    /// Drains what is buffered; the stream stays put for the next call.
    pub fn drain_events(&self, session_id: &acp::SessionId) -> Vec<AcpThreadEvent> {
        let mut streams = self.events.lock().unwrap();
        let Some(stream) = streams.get_mut(session_id) else {
            return Vec::new();
        };
        let mut drained = Vec::new();
        while let Ok(event) = stream.try_recv() {
            drained.push(event);
        }
        drained
    }

    /// Queue an answer the test delivers by hand. The returned sender closes
    /// the prompt it is paired with, in queue order.
    pub fn queue_prompt(&self) -> oneshot::Sender<Result<acp::StopReason>> {
        let (tx, rx) = oneshot::channel();
        self.prompts.lock().unwrap().push_back(rx);
        tx
    }
}

impl AgentServer for TestServer {
    fn agent_id(&self) -> AgentId {
        self.id.clone()
    }

    fn connect(
        &self,
        _delegate: AgentServerDelegate,
        _options: ConnectOptions,
    ) -> BoxFuture<'static, Result<Arc<dyn AgentConnection>>> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        // Armed out here, not inside the async block: a connect aborted before
        // it is ever polled must still count as cancelled, and a probe created
        // on first poll would never exist to say so.
        let probe = CancelProbe::new(self.connects_cancelled.clone());
        let behaviour = self.behaviour.lock().unwrap().clone();
        let id = self.id.clone();
        let live = self.live_connections.clone();
        let sessions_opened = self.sessions_opened.clone();
        let prompts_started = self.prompts_started.clone();
        let prompts = self.prompts.clone();
        let fixed_session_id = self.fixed_session_id.clone();
        let events = self.events.clone();

        async move {
            // Dropped-before-resolved is the signal ATL-228 turns on, so the
            // probe is held for the whole of the parked window.
            let probe = probe;
            match behaviour {
                ConnectBehaviour::Immediate => {}
                ConnectBehaviour::Gated(gate) => gate.wait().await,
                ConnectBehaviour::Fails(error) => {
                    probe.finish();
                    return Err(anyhow::Error::from(error));
                }
            }
            probe.finish();
            live.fetch_add(1, Ordering::SeqCst);
            Ok(Arc::new(TestConnection {
                id,
                live,
                sessions_opened,
                prompts_started,
                prompts,
                fixed_session_id,
                events,
            }) as Arc<dyn AgentConnection>)
        }
        .boxed()
    }

    fn into_any(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
        self
    }
}

pub struct TestConnection {
    id: AgentId,
    live: Arc<AtomicUsize>,
    sessions_opened: Arc<AtomicUsize>,
    prompts_started: Arc<AtomicUsize>,
    prompts: Arc<Mutex<std::collections::VecDeque<oneshot::Receiver<Result<acp::StopReason>>>>>,
    fixed_session_id: Option<String>,
    events: Arc<Mutex<HashMap<acp::SessionId, EventStream<AcpThreadEvent>>>>,
}

impl Drop for TestConnection {
    fn drop(&mut self) {
        self.live.fetch_sub(1, Ordering::SeqCst);
    }
}

impl AgentConnection for TestConnection {
    fn agent_id(&self) -> AgentId {
        self.id.clone()
    }

    fn telemetry_id(&self) -> Arc<str> {
        self.id.0.clone()
    }

    fn agent_version(&self) -> Option<Arc<str>> {
        Some("1.0.0".into())
    }

    fn new_session(
        self: Arc<Self>,
        work_dirs: Vec<PathBuf>,
    ) -> BoxFuture<'static, Result<AcpThreadHandle>> {
        let nth = self.sessions_opened.fetch_add(1, Ordering::SeqCst);
        let session_id = match &self.fixed_session_id {
            Some(fixed) => acp::SessionId::new(fixed.clone()),
            None => acp::SessionId::new(format!("session-{}-{nth}", self.id)),
        };
        async move {
            // The receiver is kept rather than dropped, so a test can assert on
            // what the thread announced — `Stopped` in particular, which is the
            // event the whole `TurnFinished` chain hangs off.
            let (sink, stream) = atlas_acp_thread::event_channel();
            self.events
                .lock()
                .unwrap()
                .insert(session_id.clone(), stream);
            let thread = AcpThread::new(
                session_id,
                self.clone() as Arc<dyn AgentConnection>,
                work_dirs,
                None,
                sink,
            );
            Ok(Arc::new(Mutex::new(thread)) as AcpThreadHandle)
        }
        .boxed()
    }

    fn auth_methods(&self) -> &[acp::AuthMethod] {
        &[]
    }

    fn authenticate(&self, _method: acp::AuthMethodId) -> BoxFuture<'static, Result<()>> {
        async { Ok(()) }.boxed()
    }

    fn prompt(
        &self,
        _params: acp::PromptRequest,
    ) -> BoxFuture<'static, Result<acp::PromptResponse>> {
        self.prompts_started.fetch_add(1, Ordering::SeqCst);
        let queued = self.prompts.lock().unwrap().pop_front();
        async move {
            match queued {
                // The test decides when this turn comes back, and with what.
                Some(rx) => match rx.await {
                    Ok(result) => result.map(acp::PromptResponse::new),
                    Err(_) => Err(anyhow!("the test dropped this turn's answer")),
                },
                None => Ok(acp::PromptResponse::new(acp::StopReason::EndTurn)),
            }
        }
        .boxed()
    }

    fn cancel(&self, _session_id: &acp::SessionId) {}

    fn into_any(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
        self
    }
}

// ------------------------------------------------------------------- harness

pub fn connect_options() -> ConnectOptions {
    let thread_events: ThreadEventSink =
        Arc::new(|_session_id| atlas_acp_thread::event_channel().0);
    ConnectOptions {
        root_dir: None,
        defaults: AcpConnectionDefaults::default(),
        thread_events,
        request_elicitation_events: Arc::new(|_agent_id| atlas_acp_thread::event_channel().0),
        client_name: "atlas-test",
        client_version: "0.0.0".to_string(),
    }
}

pub fn manager(catalog: Arc<TestCatalog>, native: Arc<dyn AgentServer>) -> Arc<AgentManager> {
    AgentManager::new(catalog, native, connect_options())
}

pub fn custom(id: &str) -> Agent {
    Agent::Custom {
        id: AgentId::new(id),
    }
}

/// Awaits an entry's connect attempt without holding its lock across the await.
pub async fn settle(
    entry: Arc<Mutex<AgentConnectionEntry>>,
) -> Result<AgentConnectedState, LoadError> {
    let task = entry.lock().unwrap().wait_for_connection();
    task.await
}

/// Polls until `f` answers, or gives up.
///
/// The manager's state changes on spawned tasks, so a test waits for a state
/// rather than awaiting a future. Wall-clock rather than `start_paused`: every
/// test here needs the multi-thread flavour to race anything at all, and
/// `start_paused` is current-thread only.
pub async fn wait_for<T>(mut f: impl FnMut() -> Option<T>) -> Option<T> {
    for _ in 0..500 {
        if let Some(value) = f() {
            return Some(value);
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    None
}

/// Gives spawned bookkeeping a chance to run without asserting on a state.
pub async fn settle_tasks() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

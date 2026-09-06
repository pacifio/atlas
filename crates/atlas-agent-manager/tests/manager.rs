//! The three behaviours the manager exists to get right: connect once,
//! reconnect after a failure, and drop a connection when its agent moves to a
//! new version.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1 as acp;
use anyhow::{anyhow, Result};
use atlas_acp_thread::{AcpThread, AcpThreadHandle, AgentConnection, AgentId, AgentThreadEntry, LoadError};
use atlas_agent_manager::{
    Agent, AgentCatalog, AgentConnectedState, AgentConnectionEntry, AgentConnectionStatus,
    AgentManager, AgentManagerEvent,
};
use atlas_agent_servers::{
    AcpConnectionDefaults, AgentServer, AgentServerCommand, AgentServerDelegate, ConnectOptions,
    ExternalAgentServer, ThreadEventSink,
};
use futures::future::BoxFuture;
use futures::FutureExt;
use tokio::sync::watch;

// ------------------------------------------------------------------- catalog

/// An installed map a test can move: add an agent, take it away, announce a new
/// version. The real one is `AgentServerStore`, which needs a registry, an HTTP
/// client and a Node runtime to say the same things.
struct FakeCatalog {
    agents: Mutex<Vec<AgentId>>,
    versions: Mutex<HashMap<AgentId, watch::Sender<Option<String>>>>,
    loading: Mutex<HashMap<AgentId, watch::Sender<Option<String>>>>,
    updates: watch::Sender<u64>,
    generation: AtomicUsize,
}

impl FakeCatalog {
    fn new(agents: &[&str]) -> Arc<Self> {
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
            versions: Mutex::new(versions),
            loading: Mutex::new(loading),
            updates: watch::channel(0).0,
            generation: AtomicUsize::new(0),
        })
    }

    fn announce_new_version(&self, id: &str, version: &str) {
        let versions = self.versions.lock().unwrap();
        versions[&AgentId::new(id)]
            .send(Some(version.to_owned()))
            .expect("the manager holds a receiver");
    }

    fn announce_loading(&self, id: &str, status: &str) {
        let loading = self.loading.lock().unwrap();
        loading[&AgentId::new(id)]
            .send(Some(status.to_owned()))
            .expect("the manager holds a receiver");
    }

    fn uninstall(&self, id: &str) {
        self.agents.lock().unwrap().retain(|a| a.as_str() != id);
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) as u64 + 1;
        self.updates.send(generation).ok();
    }
}

impl AgentCatalog for FakeCatalog {
    fn external_agents(&self) -> Vec<AgentId> {
        self.agents.lock().unwrap().clone()
    }

    fn agent_server(&self, id: &AgentId) -> Option<Arc<dyn ExternalAgentServer>> {
        self.agents
            .lock()
            .unwrap()
            .contains(id)
            .then(|| Arc::new(FakeResolver) as Arc<dyn ExternalAgentServer>)
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

struct FakeResolver;

impl ExternalAgentServer for FakeResolver {
    fn get_command(
        &self,
        _extra_args: Vec<String>,
        _extra_env: HashMap<String, String>,
    ) -> BoxFuture<'static, Result<AgentServerCommand>> {
        async { Err(anyhow!("this test never spawns a process")) }.boxed()
    }
}

// -------------------------------------------------------------------- server

/// An agent server whose connect attempt the test decides, one attempt at a
/// time. Nothing is spawned and no protocol is spoken.
struct FakeServer {
    id: AgentId,
    outcomes: Mutex<std::collections::VecDeque<Result<(), LoadError>>>,
    attempts: Arc<AtomicUsize>,
    /// Whether the connections it hands out fail their turns.
    prompt_fails: bool,
}

impl FakeServer {
    fn new(id: &str, outcomes: Vec<Result<(), LoadError>>) -> (Arc<Self>, Arc<AtomicUsize>) {
        let attempts = Arc::new(AtomicUsize::new(0));
        (
            Arc::new(Self {
                id: AgentId::new(id),
                outcomes: Mutex::new(outcomes.into()),
                attempts: attempts.clone(),
                prompt_fails: false,
            }),
            attempts,
        )
    }

    fn failing_turns(id: &str) -> Arc<Self> {
        Arc::new(Self {
            id: AgentId::new(id),
            outcomes: Mutex::new(Default::default()),
            attempts: Arc::new(AtomicUsize::new(0)),
            prompt_fails: true,
        })
    }
}

impl AgentServer for FakeServer {
    fn agent_id(&self) -> AgentId {
        self.id.clone()
    }

    fn connect(
        &self,
        _delegate: AgentServerDelegate,
        _options: ConnectOptions,
    ) -> BoxFuture<'static, Result<Arc<dyn AgentConnection>>> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        // Default to success once the script runs out, so a test that only
        // scripts a failure still gets a working reconnect.
        let outcome = self
            .outcomes
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(()));
        let id = self.id.clone();
        let prompt_fails = self.prompt_fails;
        async move {
            match outcome {
                Ok(()) => Ok(Arc::new(FakeConnection {
                    id,
                    prompt_fails,
                }) as Arc<dyn AgentConnection>),
                Err(error) => Err(anyhow::Error::from(error)),
            }
        }
        .boxed()
    }

    fn into_any(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
        self
    }
}

struct FakeConnection {
    id: AgentId,
    prompt_fails: bool,
}

impl AgentConnection for FakeConnection {
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
        let session_id = acp::SessionId::new(format!("session-{}", self.id));
        async move {
            let thread = AcpThread::new(
                session_id,
                self.clone() as Arc<dyn AgentConnection>,
                work_dirs,
                None,
                atlas_acp_thread::event_channel().0,
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
        let fails = self.prompt_fails;
        async move {
            if fails {
                return Err(anyhow!("the model refused"));
            }
            Ok(acp::PromptResponse::new(acp::StopReason::EndTurn))
        }
        .boxed()
    }

    fn cancel(&self, _session_id: &acp::SessionId) {}

    fn into_any(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
        self
    }
}

// ------------------------------------------------------------------- harness

fn connect_options() -> ConnectOptions {
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

fn manager(catalog: Arc<FakeCatalog>, native: Arc<dyn AgentServer>) -> Arc<AgentManager> {
    AgentManager::new(catalog, native, connect_options())
}

fn custom(id: &str) -> Agent {
    Agent::Custom {
        id: AgentId::new(id),
    }
}

/// Awaits an entry's connect attempt without holding its lock across the await.
async fn settle(
    entry: Arc<Mutex<AgentConnectionEntry>>,
) -> Result<AgentConnectedState, LoadError> {
    let task = entry.lock().unwrap().wait_for_connection();
    task.await
}

/// Polls until `f` answers, or gives up. The manager's state changes on spawned
/// tasks, so a test waits for a state rather than awaiting a future.
async fn wait_for<T>(mut f: impl FnMut() -> Option<T>) -> Option<T> {
    for _ in 0..500 {
        if let Some(value) = f() {
            return Some(value);
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    None
}

// --------------------------------------------------------------------- tests

#[tokio::test(flavor = "multi_thread")]
async fn a_connection_request_connects_once_and_is_reused() {
    let catalog = FakeCatalog::new(&["claude-code"]);
    let (server, attempts) = FakeServer::new("claude-code", vec![]);
    let manager = manager(catalog, server.clone());

    let key = custom("claude-code");
    let first = manager.request_connection(key.clone(), server.clone());
    // Sequential, so this is the map lookup and nothing more: the first call's
    // insert has already landed. The join under genuine concurrency — the
    // behaviour the doc comments actually claim — is
    // `concurrent_requests_for_one_agent_start_exactly_one_connection` in
    // `tests/invariants.rs`, which needs a multi-thread runtime and hundreds of
    // rounds to be worth anything.
    let second = manager.request_connection(key.clone(), server.clone());
    assert!(Arc::ptr_eq(&first, &second));

    let state = settle(first).await
        .expect("the connection comes up");
    assert_eq!(state.connection.agent_id().as_str(), "claude-code");

    wait_for(|| (manager.connection_status(&key) == AgentConnectionStatus::Connected).then_some(()))
        .await
        .expect("the entry reaches Connected");
    assert_eq!(manager.agent_version(&key).as_deref(), Some("1.0.0"));

    // Asking again once connected does not reconnect.
    manager.request_connection(key, server.clone());
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_connection_is_dropped_and_the_next_request_reconnects() {
    let catalog = FakeCatalog::new(&["claude-code"]);
    let (server, attempts) = FakeServer::new(
        "claude-code",
        vec![Err(LoadError::Exited {
            status: Some(1),
            stderr: "boom".into(),
        })],
    );
    let manager = manager(catalog, server.clone());
    let key = custom("claude-code");

    let entry = manager.request_connection(key.clone(), server.clone());
    let error = settle(entry).await
        .expect_err("the first attempt fails");
    assert!(matches!(error, LoadError::Exited { status: Some(1), .. }));

    // The failure is not cached: the entry is gone, so the agent reads as
    // disconnected rather than permanently broken.
    wait_for(|| {
        (manager.connection_status(&key) == AgentConnectionStatus::Disconnected).then_some(())
    })
    .await
    .expect("the failed entry is dropped");

    let retry = manager.request_connection(key.clone(), server.clone());
    settle(retry).await
        .expect("the second attempt connects");
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn restarting_a_connected_agent_reconnects_it() {
    let catalog = FakeCatalog::new(&["claude-code"]);
    let (server, attempts) = FakeServer::new("claude-code", vec![]);
    let manager = manager(catalog, server.clone());
    let key = custom("claude-code");

    settle(manager
        .request_connection(key.clone(), server.clone())).await
        .expect("connected");
    // A restart while the entry is still settling into `Connected` is a no-op
    // by design, so wait for it to land first.
    wait_for(|| (manager.connection_status(&key) == AgentConnectionStatus::Connected).then_some(()))
        .await
        .expect("connected");

    settle(manager
        .restart_connection(key.clone(), server.clone())).await
        .expect("reconnected");
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_version_drops_the_connection_and_announces_itself() {
    let catalog = FakeCatalog::new(&["claude-code"]);
    let (server, attempts) = FakeServer::new("claude-code", vec![]);
    let manager = manager(catalog.clone(), server.clone());
    let mut events = manager.subscribe();
    let key = custom("claude-code");

    settle(manager
        .request_connection(key.clone(), server.clone())).await
        .expect("connected");
    wait_for(|| (manager.connection_status(&key) == AgentConnectionStatus::Connected).then_some(()))
        .await
        .expect("connected");

    catalog.announce_new_version("claude-code", "2.0.0");

    let announced = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Ok(AgentManagerEvent::NewVersionAvailable { agent, version }) =
                events.recv().await
            {
                return (agent, version);
            }
        }
    })
    .await
    .expect("the new version is announced");
    assert_eq!(announced, (key.clone(), "2.0.0".to_string()));

    // The running process is on the old binary, so the connection goes with it.
    wait_for(|| {
        (manager.connection_status(&key) == AgentConnectionStatus::Disconnected).then_some(())
    })
    .await
    .expect("the connection is dropped on a version bump");

    // And the next request starts the new binary.
    settle(manager
        .request_connection(key, server.clone())).await
        .expect("reconnected on the new version");
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn install_progress_reaches_subscribers() {
    let catalog = FakeCatalog::new(&["claude-code"]);
    let (server, _) = FakeServer::new("claude-code", vec![]);
    let manager = manager(catalog.clone(), server.clone());
    let mut events = manager.subscribe();

    manager.request_connection(custom("claude-code"), server.clone());
    catalog.announce_loading("claude-code", "Installing 2.0.0…");

    let status = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Ok(AgentManagerEvent::LoadingStatusChanged { status, .. }) = events.recv().await {
                return status;
            }
        }
    })
    .await
    .expect("the loading status is announced");
    assert_eq!(status.as_deref(), Some("Installing 2.0.0…"));
}

#[tokio::test(flavor = "multi_thread")]
async fn uninstalling_an_agent_closes_its_connection() {
    let catalog = FakeCatalog::new(&["claude-code"]);
    let (server, _) = FakeServer::new("claude-code", vec![]);
    let manager = manager(catalog.clone(), server.clone());
    let key = custom("claude-code");

    settle(manager
        .request_connection(key.clone(), server.clone())).await
        .expect("connected");

    catalog.uninstall("claude-code");

    wait_for(|| {
        (manager.connection_status(&key) == AgentConnectionStatus::Disconnected).then_some(())
    })
    .await
    .expect("an uninstalled agent's connection is dropped");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_nobody_installed_cannot_be_connected_to() {
    // The whole point of the locked no-default-agents decision: there is no
    // ladder to fall back to, so an agent that is not in the installed map does
    // not exist.
    let catalog = FakeCatalog::new(&[]);
    let (server, attempts) = FakeServer::new("cersei", vec![]);
    let manager = manager(catalog, server.clone());

    let error = settle(manager
        .connect_to(custom("claude-code"))).await
        .expect_err("an uninstalled agent has nothing to connect to");
    assert!(matches!(error, LoadError::Unsupported { .. }));
    assert_eq!(attempts.load(Ordering::SeqCst), 0, "nothing was spawned");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_native_agent_is_always_connectable() {
    // No installed map, no registry: the native agent is still there. This is
    // the fresh-install shape.
    let catalog = FakeCatalog::new(&[]);
    let (server, _) = FakeServer::new("cersei", vec![]);
    let manager = manager(catalog, server.clone());

    let state = settle(manager
        .request_connection(Agent::Native, server.clone())).await
        .expect("the native agent connects");
    assert_eq!(state.connection.agent_id().as_str(), "cersei");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_turn_opens_and_closes_around_the_prompt() {
    let catalog = FakeCatalog::new(&[]);
    let (server, _) = FakeServer::new("cersei", vec![]);
    let manager = manager(catalog, server.clone());

    let thread = manager
        .new_session(Agent::Native, vec![PathBuf::from("/tmp")])
        .await
        .expect("a session opens on the native agent");
    let session_id = thread.lock().unwrap().session_id().clone();
    assert!(manager.session(&session_id).is_some(), "the manager owns it");

    let stop = manager
        .send(
            &session_id,
            vec![acp::ContentBlock::Text(acp::TextContent::new(
                "hello".to_string(),
            ))],
        )
        .await
        .expect("the turn runs");

    assert_eq!(stop, acp::StopReason::EndTurn);
    let thread = thread.lock().unwrap();
    assert!(
        matches!(thread.entries().first(), Some(AgentThreadEntry::UserMessage(_))),
        "the user's message is in the thread before the agent answers"
    );
    assert!(!thread.is_generating(), "the turn was closed");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_turn_marks_the_thread_instead_of_leaving_it_generating() {
    let catalog = FakeCatalog::new(&[]);
    let server = FakeServer::failing_turns("cersei");
    let manager = manager(catalog, server.clone());

    let thread = manager
        .new_session(Agent::Native, vec![PathBuf::from("/tmp")])
        .await
        .expect("a session opens");
    let session_id = thread.lock().unwrap().session_id().clone();

    manager
        .send(
            &session_id,
            vec![acp::ContentBlock::Text(acp::TextContent::new(
                "hello".to_string(),
            ))],
        )
        .await
        .expect_err("the turn fails");

    let thread = thread.lock().unwrap();
    assert!(thread.had_error(), "the failure is recorded on the thread");
    assert!(!thread.is_generating(), "and it is not left generating");
}

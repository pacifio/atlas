//! Bringing a stored session back, and letting an agent forget one.
//!
//! Every test here drives a fake connection that advertises a chosen subset of
//! the session capabilities. That is the point: which of `session/load`,
//! `session/resume` and `session/delete` an agent gets is decided by what it
//! advertised at `initialize` and by nothing else — there is no agent name in
//! this file, and there must never be one.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1 as acp;
use anyhow::{anyhow, Result};
use atlas_acp_thread::{
    AcpThread, AcpThreadHandle, AgentConnection, AgentId, AgentSessionList,
    AgentSessionListRequest, AgentSessionListResponse,
};
use atlas_agent_manager::{Agent, AgentCatalog, AgentManager, ResumeMode};
use atlas_agent_servers::{
    AcpConnectionDefaults, AgentServer, AgentServerCommand, AgentServerDelegate, ConnectOptions,
    ExternalAgentServer, ThreadEventSink,
};
use futures::future::BoxFuture;
use futures::FutureExt;
use tokio::sync::watch;

/// What an agent said it could do at `initialize`.
#[derive(Clone, Copy, Default)]
struct Capabilities {
    /// `agentCapabilities.loadSession` — a top-level bool in this schema.
    load: bool,
    /// `sessionCapabilities.resume` — a presence marker.
    resume: bool,
    /// `sessionCapabilities.list` — a presence marker. Without it there is no
    /// session-list object at all, and so no delete either.
    list: bool,
    /// `sessionCapabilities.delete` — a presence marker under the list object.
    delete: bool,
}

impl Capabilities {
    fn load() -> Self {
        Self { load: true, ..Self::default() }
    }
    fn resume() -> Self {
        Self { resume: true, ..Self::default() }
    }
    fn neither() -> Self {
        Self::default()
    }
}

// ------------------------------------------------------------------ the fake

struct FakeConnection {
    id: AgentId,
    capabilities: Capabilities,
    /// Load/resume fail when set — an agent that no longer knows the session.
    forgets_sessions: bool,
    /// Whether `session/load` actually replays the conversation into the
    /// thread. The protocol requires it before the load answers; an agent that
    /// advertises `loadSession` and sends nothing is the case the mode is now
    /// derived from rather than assumed (ATL-230 finding 3).
    replays_history: bool,
    calls: Arc<Mutex<Vec<String>>>,
}

impl FakeConnection {
    fn thread(self: &Arc<Self>, session_id: acp::SessionId) -> AcpThreadHandle {
        Arc::new(Mutex::new(AcpThread::new(
            session_id,
            self.clone() as Arc<dyn AgentConnection>,
            vec![PathBuf::from("/tmp/atlas")],
            None,
            atlas_acp_thread::event_channel().0,
        )))
    }

    fn note(&self, call: &str) {
        self.calls.lock().unwrap().push(call.to_string());
    }
}

impl AgentConnection for FakeConnection {
    fn agent_id(&self) -> AgentId {
        self.id.clone()
    }

    fn telemetry_id(&self) -> Arc<str> {
        self.id.0.clone()
    }

    fn new_session(
        self: Arc<Self>,
        _work_dirs: Vec<PathBuf>,
    ) -> BoxFuture<'static, Result<AcpThreadHandle>> {
        self.note("new_session");
        let thread = self.thread(acp::SessionId::new("fresh"));
        async move { Ok(thread) }.boxed()
    }

    fn supports_load_session(&self) -> bool {
        self.capabilities.load
    }

    fn load_session(
        self: Arc<Self>,
        session_id: acp::SessionId,
        _work_dirs: Vec<PathBuf>,
        _title: Option<Arc<str>>,
    ) -> BoxFuture<'static, Result<AcpThreadHandle>> {
        self.note("load_session");
        if self.forgets_sessions {
            return async { Err(anyhow!("no conversation found with that id")) }.boxed();
        }
        let thread = self.thread(session_id);
        if self.replays_history {
            thread.lock().unwrap().push_user_content_block(
                None,
                acp::ContentBlock::Text(acp::TextContent::new("what we said before".to_string())),
            );
        }
        async move { Ok(thread) }.boxed()
    }

    fn supports_resume_session(&self) -> bool {
        self.capabilities.resume
    }

    fn resume_session(
        self: Arc<Self>,
        session_id: acp::SessionId,
        _work_dirs: Vec<PathBuf>,
        _title: Option<Arc<str>>,
    ) -> BoxFuture<'static, Result<AcpThreadHandle>> {
        self.note("resume_session");
        if self.forgets_sessions {
            return async { Err(anyhow!("no conversation found with that id")) }.boxed();
        }
        let thread = self.thread(session_id);
        async move { Ok(thread) }.boxed()
    }

    fn session_list(&self) -> Option<Arc<dyn AgentSessionList>> {
        // Exactly the real gate: no `list` capability, no list object — and so
        // no delete, whatever `delete` says.
        self.capabilities.list.then(|| {
            Arc::new(FakeSessionList {
                supports_delete: self.capabilities.delete,
                calls: self.calls.clone(),
            }) as Arc<dyn AgentSessionList>
        })
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
        async { Ok(acp::PromptResponse::new(acp::StopReason::EndTurn)) }.boxed()
    }

    fn cancel(&self, _session_id: &acp::SessionId) {}

    fn into_any(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
        self
    }
}

struct FakeSessionList {
    supports_delete: bool,
    calls: Arc<Mutex<Vec<String>>>,
}

impl AgentSessionList for FakeSessionList {
    fn list_sessions(
        &self,
        _request: AgentSessionListRequest,
    ) -> BoxFuture<'static, Result<AgentSessionListResponse>> {
        async { Ok(AgentSessionListResponse::new(Vec::new())) }.boxed()
    }

    fn supports_delete(&self) -> bool {
        self.supports_delete
    }

    fn delete_session(&self, _session_id: &acp::SessionId) -> BoxFuture<'static, Result<()>> {
        self.calls.lock().unwrap().push("delete_session".into());
        async { Ok(()) }.boxed()
    }

    fn into_any(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
        self
    }
}

// ---------------------------------------------------------------- harness

struct FakeServer {
    id: AgentId,
    capabilities: Capabilities,
    forgets_sessions: bool,
    replays_history: bool,
    calls: Arc<Mutex<Vec<String>>>,
    spawns: Arc<AtomicUsize>,
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
        self.spawns.fetch_add(1, Ordering::SeqCst);
        let connection = Arc::new(FakeConnection {
            id: self.id.clone(),
            capabilities: self.capabilities,
            forgets_sessions: self.forgets_sessions,
            replays_history: self.replays_history,
            calls: self.calls.clone(),
        });
        async move { Ok(connection as Arc<dyn AgentConnection>) }.boxed()
    }

    fn into_any(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
        self
    }
}

struct FakeCatalog(AgentId);

impl AgentCatalog for FakeCatalog {
    fn external_agents(&self) -> Vec<AgentId> {
        vec![self.0.clone()]
    }
    fn agent_server(&self, _id: &AgentId) -> Option<Arc<dyn ExternalAgentServer>> {
        Some(Arc::new(FakeResolver))
    }
    fn default_mode(&self, _id: &AgentId) -> Option<acp::SessionModeId> {
        None
    }
    fn watch_new_version(&self, _id: &AgentId) -> Option<watch::Receiver<Option<String>>> {
        None
    }
    fn watch_loading_status(&self, _id: &AgentId) -> Option<watch::Receiver<Option<String>>> {
        None
    }
    fn updates(&self) -> watch::Receiver<u64> {
        watch::channel(0).1
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

struct Harness {
    manager: Arc<AgentManager>,
    agent: Agent,
    calls: Arc<Mutex<Vec<String>>>,
    spawns: Arc<AtomicUsize>,
}

impl Harness {
    fn new(capabilities: Capabilities) -> Self {
        Self::with(capabilities, false, true)
    }

    /// An agent that has forgotten whatever session it is asked for.
    fn forgetful(capabilities: Capabilities) -> Self {
        Self::with(capabilities, true, true)
    }

    /// An agent that advertises `loadSession`, answers the load, and replays
    /// nothing — a spec violation real agents have shipped.
    fn silent(capabilities: Capabilities) -> Self {
        Self::with(capabilities, false, false)
    }

    fn with(capabilities: Capabilities, forgets_sessions: bool, replays_history: bool) -> Self {
        let id = AgentId::new("some-agent");
        let calls = Arc::new(Mutex::new(Vec::new()));
        let spawns = Arc::new(AtomicUsize::new(0));
        let server = Arc::new(FakeServer {
            id: id.clone(),
            capabilities,
            forgets_sessions,
            replays_history,
            calls: calls.clone(),
            spawns: spawns.clone(),
        });
        let thread_events: ThreadEventSink =
            Arc::new(|_session_id| atlas_acp_thread::event_channel().0);
        let manager = AgentManager::new(
            Arc::new(FakeCatalog(id)),
            server,
            ConnectOptions {
                root_dir: None,
                defaults: AcpConnectionDefaults::default(),
                thread_events,
                request_elicitation_events: Arc::new(|_agent_id| {
                    atlas_acp_thread::event_channel().0
                }),
                client_name: "atlas-test",
                client_version: "0.0.0".to_string(),
            },
        );
        Self {
            manager,
            agent: Agent::Native,
            calls,
            spawns,
        }
    }

    async fn resume(&self) -> Result<ResumeMode> {
        self.manager
            .resume_stored_session(
                self.agent.clone(),
                acp::SessionId::new("ses-1"),
                vec![PathBuf::from("/tmp/atlas")],
                None,
            )
            .await
            .map(|resumed| resumed.mode)
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

// ------------------------------------------------------------------- tests

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_that_can_load_replays_the_conversation() {
    let harness = Harness::new(Capabilities::load());

    assert_eq!(harness.resume().await.unwrap(), ResumeMode::Replayed);
    assert_eq!(harness.calls(), vec!["load_session"]);
}

/// The mode is an observation, not a restatement of the capability. An agent
/// that advertises `loadSession` and then replays nothing leaves the user
/// looking at a blank conversation, and calling that `Replayed` is why no
/// notice was shown for it (ATL-230 finding 3).
#[tokio::test(flavor = "multi_thread")]
async fn an_agent_that_advertises_load_and_replays_nothing_is_reported_without_history() {
    let harness = Harness::silent(Capabilities::load());

    assert_eq!(harness.resume().await.unwrap(), ResumeMode::WithoutHistory);
    assert_eq!(
        harness.calls(),
        vec!["load_session"],
        "the load is still attempted, and still answered"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_that_can_only_resume_continues_without_the_history() {
    let harness = Harness::new(Capabilities::resume());

    assert_eq!(harness.resume().await.unwrap(), ResumeMode::WithoutHistory);
    assert_eq!(
        harness.calls(),
        vec!["resume_session"],
        "and load is not attempted first"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn loading_wins_when_an_agent_advertises_both() {
    let harness = Harness::new(Capabilities {
        load: true,
        resume: true,
        ..Capabilities::default()
    });

    assert_eq!(harness.resume().await.unwrap(), ResumeMode::Replayed);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_that_can_do_neither_says_so_and_starts_nothing() {
    let harness = Harness::new(Capabilities::neither());

    let error = harness.resume().await.expect_err("there is nothing to do");
    assert!(
        error.to_string().to_lowercase().contains("not supported"),
        "the error should name the limitation: {error}"
    );
    assert!(
        harness.calls().is_empty(),
        "no RPC is sent, and no fresh session is started in its place"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn resuming_starts_an_agent_that_is_not_running() {
    let harness = Harness::new(Capabilities::load());
    assert_eq!(harness.spawns.load(Ordering::SeqCst), 0);

    harness.resume().await.unwrap();

    assert_eq!(harness.spawns.load(Ordering::SeqCst), 1, "spawned on demand");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_the_agent_has_forgotten_fails_without_starting_a_new_one() {
    let harness = Harness::forgetful(Capabilities::load());

    let error = harness.resume().await.expect_err("the agent said no");
    assert!(error.to_string().contains("no conversation found"));
    assert_eq!(
        harness.calls(),
        vec!["load_session"],
        "a failed load must not silently become a new session"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_is_asked_to_forget_a_session_only_when_it_says_it_can() {
    let advertised = Harness::new(Capabilities {
        list: true,
        delete: true,
        ..Capabilities::default()
    });
    assert!(advertised
        .manager
        .delete_stored_session(advertised.agent.clone(), &acp::SessionId::new("ses-1"))
        .await
        .unwrap());
    assert_eq!(advertised.calls(), vec!["delete_session"]);

    // `delete` without `list` is not a capability: there is no list object to
    // carry it, which is exactly how the protocol nests them.
    let unlisted = Harness::new(Capabilities {
        delete: true,
        ..Capabilities::default()
    });
    assert!(!unlisted
        .manager
        .delete_stored_session(unlisted.agent.clone(), &acp::SessionId::new("ses-1"))
        .await
        .unwrap());
    assert!(unlisted.calls().is_empty());

    let neither = Harness::new(Capabilities::neither());
    assert!(!neither
        .manager
        .delete_stored_session(neither.agent.clone(), &acp::SessionId::new("ses-1"))
        .await
        .unwrap());
    assert!(neither.calls().is_empty());
}

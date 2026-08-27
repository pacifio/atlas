//! Cersei end to end on the ported seam.
//!
//! Everything here goes through the real path: `AgentServer::connect` →
//! `AgentConnection::new_session` → an `AcpThread` → `prompt` → the runtime's
//! turn loop → its events → thread entries. The only substitution is the model
//! itself (see [`common::ScriptedProvider`]), because a test cannot have one.
//!
//! No Tauri wiring is involved; this is the harness the port's stage-3 gate
//! asks for.

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{
    AcpThread, AcpThreadHandle, AgentConnection, AgentId, AgentThreadEntry, ToolCallStatus,
};
use atlas_agent_servers::{
    AcpConnectionDefaults, AgentServer, AgentServerDelegate, ConnectOptions,
    RequestElicitationSink, ThreadEventSink,
};
use atlas_cersei::CerseiRuntime;
use atlas_native_agent::{CerseiAgentServer, CERSEI_AGENT_ID};
use common::{Response, ScriptedProvider};

struct Harness {
    _config_dir: tempfile::TempDir,
    work_dir: tempfile::TempDir,
    connection: Arc<dyn AgentConnection>,
}

impl Harness {
    async fn start(responses: Vec<Response>) -> Self {
        let config_dir = tempfile::tempdir().expect("config dir");
        let work_dir = tempfile::tempdir().expect("work dir");

        let runtime = CerseiRuntime::new(config_dir.path().to_path_buf());
        runtime.set_provider_factory(Some(ScriptedProvider::factory(responses)));

        let server = CerseiAgentServer::with_runtime(runtime);
        let connection = server
            .connect(AgentServerDelegate::native(), connect_options())
            .await
            .expect("the native agent connects without a process");

        Self {
            _config_dir: config_dir,
            work_dir,
            connection,
        }
    }

    async fn new_session(&self) -> AcpThreadHandle {
        self.connection
            .clone()
            .new_session(vec![self.work_dir.path().to_path_buf()])
            .await
            .expect("new session")
    }
}

/// Threads emit into a channel nobody reads; the assertions read the thread
/// itself. Keeping the sender alive is what stops the emit path erroring.
fn connect_options() -> ConnectOptions {
    let sinks: Arc<Mutex<Vec<atlas_acp_thread::EventStream<atlas_acp_thread::AcpThreadEvent>>>> =
        Arc::new(Mutex::new(Vec::new()));
    let thread_events: ThreadEventSink = Arc::new(move |_session_id| {
        let (tx, rx) = atlas_acp_thread::event_channel();
        sinks.lock().unwrap().push(rx);
        tx
    });
    // The native agent raises no request-scoped elicitations (it advertises no
    // auth methods), but `ConnectOptions` still requires a sink. Same shape as
    // `atlas-agent-servers/tests/connect.rs`: leak the receiver so sends never
    // fail for a reason unrelated to the test.
    let request_elicitation_events: RequestElicitationSink = Arc::new(|_agent_id: &AgentId| {
        let (tx, rx) = atlas_acp_thread::event_channel();
        Box::leak(Box::new(rx));
        tx
    });
    ConnectOptions {
        root_dir: None,
        defaults: AcpConnectionDefaults::default(),
        thread_events,
        request_elicitation_events,
        client_name: "atlas-test",
        client_version: "0.0.0".to_string(),
    }
}

fn lock(thread: &AcpThreadHandle) -> std::sync::MutexGuard<'_, AcpThread> {
    thread.lock().unwrap_or_else(|p| p.into_inner())
}

fn assistant_text(thread: &AcpThreadHandle) -> String {
    lock(thread)
        .entries()
        .iter()
        .filter_map(|entry| match entry {
            AgentThreadEntry::AssistantMessage(message) => Some(
                message
                    .chunks
                    .iter()
                    .map(|chunk| chunk.block().to_text().to_owned())
                    .collect::<String>(),
            ),
            _ => None,
        })
        .collect()
}

fn text_prompt(session_id: &acp::SessionId, text: &str) -> acp::PromptRequest {
    acp::PromptRequest::new(
        session_id.clone(),
        vec![acp::ContentBlock::Text(acp::TextContent::new(
            text.to_owned(),
        ))],
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn a_turn_streams_into_the_thread_and_ends() {
    let harness = Harness::start(vec![Response::text("ported and running")]).await;
    let thread = harness.new_session().await;
    let session_id = lock(&thread).session_id().clone();

    lock(&thread).begin_turn();
    let response = harness
        .connection
        .prompt(text_prompt(&session_id, "are you there?"))
        .await
        .expect("the turn completes");
    lock(&thread).end_turn(response.stop_reason);

    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);
    assert!(
        assistant_text(&thread).contains("ported and running"),
        "the scripted response reached the thread: {:?}",
        assistant_text(&thread)
    );
    assert!(!lock(&thread).is_generating(), "the turn is closed");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_thread_reports_the_turn_usage() {
    let harness = Harness::start(vec![Response::text("counted")]).await;
    let thread = harness.new_session().await;
    let session_id = lock(&thread).session_id().clone();

    harness
        .connection
        .prompt(text_prompt(&session_id, "count something"))
        .await
        .expect("the turn completes");

    let thread = lock(&thread);
    let usage = thread.token_usage().expect("usage reached the thread");
    assert_eq!(usage.input_tokens, 11);
    assert_eq!(usage.output_tokens, 7);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tool_call_waits_for_permission_and_a_rejection_stops_it() {
    let target = "permission-probe.txt";
    let harness = Harness::start(vec![Response::tool_call(
        "call-1",
        "Write",
        serde_json::json!({ "file_path": target, "content": "should not be written" }),
    )])
    .await;
    let thread = harness.new_session().await;
    let session_id = lock(&thread).session_id().clone();
    let written = harness.work_dir.path().join(target);

    let connection = harness.connection.clone();
    let turn = tokio::spawn({
        let session_id = session_id.clone();
        async move { connection.prompt(text_prompt(&session_id, "write a file")).await }
    });

    // The prompt reaches the thread as a tool call waiting on an answer.
    let tool_call_id = wait_for(|| pending_tool_call(&thread))
        .await
        .expect("a permission prompt appeared in the thread");

    let deny = {
        let thread = lock(&thread);
        let (_, call) = thread.tool_call(&tool_call_id).expect("the tool call");
        let ToolCallStatus::WaitingForConfirmation { options, .. } = &call.status else {
            panic!("expected a waiting tool call");
        };
        let option_id = options
            .deny_once_option_id()
            .expect("the native agent offers a reject option");
        atlas_acp_thread::SelectedPermissionOutcome::new(
            option_id,
            acp::PermissionOptionKind::RejectOnce,
        )
    };
    lock(&thread).authorize_tool_call(tool_call_id.clone(), deny);

    turn.await.expect("the turn task").expect("the turn completes");

    assert!(
        !written.exists(),
        "a rejected Write must not touch the filesystem"
    );
    // `Failed`, not `Rejected`: the tool runs in-process, so the denial comes
    // back to it as a tool error and the runtime reports that result — the same
    // thing the old stack showed. What matters is that the answer reached the
    // runtime and stopped the write.
    let thread = lock(&thread);
    let (_, call) = thread.tool_call(&tool_call_id).expect("the tool call");
    assert!(
        matches!(call.status, ToolCallStatus::Failed | ToolCallStatus::Rejected),
        "a denied tool call does not end up completed: {:?}",
        call.status
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stored_session_reloads_with_its_transcript() {
    let harness = Harness::start(vec![Response::text("remember this")]).await;
    let thread = harness.new_session().await;
    let session_id = lock(&thread).session_id().clone();

    harness
        .connection
        .prompt(text_prompt(&session_id, "say something memorable"))
        .await
        .expect("the turn completes");

    // Drop every handle, as closing a tab does.
    harness
        .connection
        .clone()
        .close_session(session_id.clone())
        .await
        .expect("close");
    drop(thread);

    let reloaded = harness
        .connection
        .clone()
        .load_session(
            session_id,
            vec![harness.work_dir.path().to_path_buf()],
            None,
        )
        .await
        .expect("the stored session reloads");

    let text = assistant_text(&reloaded);
    assert!(
        text.contains("remember this"),
        "the replayed transcript carries the turn: {text:?}"
    );
    let has_prompt = lock(&reloaded)
        .entries()
        .iter()
        .any(|entry| matches!(entry, AgentThreadEntry::UserMessage(_)));
    assert!(has_prompt, "the user's own message is replayed too");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_native_agent_advertises_no_auth_method() {
    let harness = Harness::start(vec![Response::text("hi")]).await;
    assert!(
        harness.connection.auth_methods().is_empty(),
        "the native agent signs in with API keys, not an ACP auth method"
    );
    assert_eq!(harness.connection.agent_id().as_str(), CERSEI_AGENT_ID);
}

#[tokio::test(flavor = "multi_thread")]
async fn stored_sessions_can_be_listed_and_deleted() {
    let harness = Harness::start(vec![Response::text("stored")]).await;
    let thread = harness.new_session().await;
    let session_id = lock(&thread).session_id().clone();

    harness
        .connection
        .prompt(text_prompt(&session_id, "leave a transcript"))
        .await
        .expect("the turn completes");

    let list = harness
        .connection
        .session_list()
        .expect("the native agent lists its stored sessions");

    let request = atlas_acp_thread::AgentSessionListRequest {
        cwd: Some(harness.work_dir.path().to_path_buf()),
        ..Default::default()
    };
    let listed = list.list_sessions(request).await.expect("listing");
    assert!(
        listed.sessions.iter().any(|s| s.session_id == session_id),
        "the session that just ran is in the listing"
    );

    // The delete request carries only an id, so it relies on the directory the
    // listing above was made against.
    assert!(list.supports_delete());
    list.delete_session(&session_id).await.expect("delete");

    let request = atlas_acp_thread::AgentSessionListRequest {
        cwd: Some(harness.work_dir.path().to_path_buf()),
        ..Default::default()
    };
    let listed = list.list_sessions(request).await.expect("listing");
    assert!(
        !listed.sessions.iter().any(|s| s.session_id == session_id),
        "and it is gone once deleted"
    );
}

fn pending_tool_call(thread: &AcpThreadHandle) -> Option<acp::ToolCallId> {
    lock(thread).entries().iter().find_map(|entry| match entry {
        AgentThreadEntry::ToolCall(call)
            if matches!(call.status, ToolCallStatus::WaitingForConfirmation { .. }) =>
        {
            Some(call.id.clone())
        }
        _ => None,
    })
}

/// Polls `f` until it answers, or gives up after a few seconds.
///
/// The turn runs on its own task, so what a test is waiting for is the thread
/// reaching a state, not a future resolving.
async fn wait_for<T>(mut f: impl FnMut() -> Option<T>) -> Option<T> {
    for _ in 0..600 {
        if let Some(value) = f() {
            return Some(value);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    None
}

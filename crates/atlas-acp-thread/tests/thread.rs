//! Thread-model tests, adapted from Zed's `acp_thread` suite
//! (`~/Codes/zed-ref/crates/acp_thread/src/acp_thread.rs`, the `mod tests` at
//! the end of the file). Zed's versions are GPUI tests driving a `StubAgentConnection`
//! through a `TestAppContext`; these drive the same mechanism through plain
//! method calls, so the assertions are about behaviour rather than rendering.
//!
//! Each test names the Zed test it is adapted from.

use std::any::Any;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use anyhow::Result;
use atlas_acp_thread::*;
use futures::future::BoxFuture;

// ---------------------------------------------------------------- stub agent

/// Adapted from Zed's `StubAgentConnection` (`connection.rs`, `test_support`).
struct StubAgentConnection {
    auth_methods: Vec<acp::AuthMethod>,
    cancel_count: AtomicUsize,
}

impl StubAgentConnection {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            auth_methods: Vec::new(),
            cancel_count: AtomicUsize::new(0),
        })
    }
}

impl AgentConnection for StubAgentConnection {
    fn agent_id(&self) -> AgentId {
        AgentId::new("stub")
    }

    fn telemetry_id(&self) -> Arc<str> {
        "stub".into()
    }

    fn new_session(
        self: Arc<Self>,
        _work_dirs: Vec<std::path::PathBuf>,
    ) -> BoxFuture<'static, Result<AcpThreadHandle>> {
        Box::pin(async { Err(anyhow::anyhow!("not used in these tests")) })
    }

    fn auth_methods(&self) -> &[acp::AuthMethod] {
        &self.auth_methods
    }

    fn authenticate(&self, _method: acp::AuthMethodId) -> BoxFuture<'static, Result<()>> {
        Box::pin(async { Ok(()) })
    }

    fn prompt(
        &self,
        _params: acp::PromptRequest,
    ) -> BoxFuture<'static, Result<acp::PromptResponse>> {
        Box::pin(async { Err(anyhow::anyhow!("not used in these tests")) })
    }

    fn cancel(&self, _session_id: &acp::SessionId) {
        self.cancel_count.fetch_add(1, Ordering::SeqCst);
    }

    fn into_any(self: Arc<Self>) -> Arc<dyn Any + Send + Sync> {
        self
    }
}

// ------------------------------------------------------------------ fixtures

fn new_thread() -> (AcpThread, EventStream<AcpThreadEvent>, Arc<StubAgentConnection>) {
    let (tx, rx) = event_channel();
    let connection = StubAgentConnection::new();
    let thread = AcpThread::new(
        acp::SessionId::new("test-session"),
        connection.clone(),
        Vec::new(),
        None,
        tx,
    );
    (thread, rx, connection)
}

fn text_block(text: &str) -> acp::ContentBlock {
    acp::ContentBlock::Text(acp::TextContent::new(text))
}

fn user_chunk(text: &str, message_id: Option<&str>) -> acp::SessionUpdate {
    let mut chunk = acp::ContentChunk::new(text_block(text));
    chunk.message_id = message_id.map(acp::MessageId::new);
    acp::SessionUpdate::UserMessageChunk(chunk)
}

fn agent_chunk(text: &str, message_id: Option<&str>) -> acp::SessionUpdate {
    let mut chunk = acp::ContentChunk::new(text_block(text));
    chunk.message_id = message_id.map(acp::MessageId::new);
    acp::SessionUpdate::AgentMessageChunk(chunk)
}

fn thought_chunk(text: &str, message_id: Option<&str>) -> acp::SessionUpdate {
    let mut chunk = acp::ContentChunk::new(text_block(text));
    chunk.message_id = message_id.map(acp::MessageId::new);
    acp::SessionUpdate::AgentThoughtChunk(chunk)
}

fn tool_call(id: &str, title: &str, status: acp::ToolCallStatus) -> acp::ToolCall {
    let mut call = acp::ToolCall::new(acp::ToolCallId::new(id), title);
    call.status = status;
    call
}

fn tool_call_update(id: &str, status: Option<acp::ToolCallStatus>) -> acp::ToolCallUpdate {
    let mut fields = acp::ToolCallUpdateFields::new();
    fields.status = status;
    acp::ToolCallUpdate::new(acp::ToolCallId::new(id), fields)
}

fn user_messages(thread: &AcpThread) -> Vec<String> {
    thread
        .entries()
        .iter()
        .filter_map(|entry| match entry {
            AgentThreadEntry::UserMessage(message) => Some(message.content.to_text().to_string()),
            _ => None,
        })
        .collect()
}

fn assistant_chunk_texts(thread: &AcpThread) -> Vec<(bool, String)> {
    thread
        .entries()
        .iter()
        .filter_map(|entry| match entry {
            AgentThreadEntry::AssistantMessage(message) => Some(message),
            _ => None,
        })
        .flat_map(|message| {
            message
                .chunks
                .iter()
                .map(|chunk| (chunk.is_thought(), chunk.block().to_text().to_string()))
        })
        .collect()
}

fn status_of(thread: &AcpThread, id: &str) -> String {
    let (_, call) = thread
        .tool_call(&acp::ToolCallId::new(id))
        .expect("tool call missing");
    call.status.to_string()
}

// ------------------------------------------------------------- message chunks

/// Adapted from `test_user_message_chunks_use_protocol_message_id_boundaries`.
#[tokio::test]
async fn user_chunks_split_on_a_changed_protocol_message_id() {
    let (mut thread, _events, _conn) = new_thread();

    thread.handle_session_update(user_chunk("one ", Some("m1"))).unwrap();
    thread.handle_session_update(user_chunk("two", Some("m1"))).unwrap();
    thread.handle_session_update(user_chunk("three", Some("m2"))).unwrap();

    assert_eq!(user_messages(&thread), vec!["one two", "three"]);
}

/// Adapted from the same test's "no ids at all" case: an agent that never sends
/// `messageId` must keep the pre-`messageId` behaviour of merging everything.
#[tokio::test]
async fn user_chunks_without_ids_all_merge() {
    let (mut thread, _events, _conn) = new_thread();

    thread.handle_session_update(user_chunk("a", None)).unwrap();
    thread.handle_session_update(user_chunk("b", None)).unwrap();

    assert_eq!(user_messages(&thread), vec!["ab"]);
}

/// Adapted from `test_protocol_user_chunk_does_not_merge_into_optimistic_prompt`.
///
/// The optimistic message is what the user typed; a protocol chunk that arrives
/// carrying its own id is a different message being announced, and merging the
/// two would silently rewrite the user's own prompt in the transcript.
#[tokio::test]
async fn a_protocol_chunk_does_not_merge_into_the_optimistic_prompt() {
    let (mut thread, _events, _conn) = new_thread();

    thread.push_user_content_block(Some(ClientUserMessageId::new()), text_block("typed"));
    thread.handle_session_update(user_chunk("from agent", Some("m1"))).unwrap();

    assert_eq!(user_messages(&thread), vec!["typed", "from agent"]);
}

/// Adapted from `test_ignore_echoed_user_message_chunks_during_active_turn`.
#[tokio::test]
async fn an_echoed_user_chunk_is_not_rendered_twice() {
    let (mut thread, _events, _conn) = new_thread();

    thread.push_user_content_block(Some(ClientUserMessageId::new()), text_block("hello"));
    // The server echoes the prompt back with no id of its own.
    thread.handle_session_update(user_chunk("hello", None)).unwrap();

    assert_eq!(user_messages(&thread), vec!["hello"]);
}

/// Adapted from `test_assistant_chunks_use_protocol_message_id_boundaries`.
#[tokio::test]
async fn assistant_chunks_split_on_a_changed_protocol_message_id() {
    let (mut thread, _events, _conn) = new_thread();

    thread.handle_session_update(agent_chunk("one ", Some("a1"))).unwrap();
    thread.handle_session_update(agent_chunk("two", Some("a1"))).unwrap();
    thread.handle_session_update(agent_chunk("three", Some("a2"))).unwrap();

    assert_eq!(
        assistant_chunk_texts(&thread),
        vec![(false, "one two".to_string()), (false, "three".to_string())]
    );
}

/// Adapted from `test_thinking_concatenation`.
///
/// Thought and message chunks never merge into each other even when they carry
/// no ids, or the reasoning would be rendered as the answer.
#[tokio::test]
async fn thoughts_concatenate_but_never_merge_into_the_message() {
    let (mut thread, _events, _conn) = new_thread();

    thread.handle_session_update(thought_chunk("think ", None)).unwrap();
    thread.handle_session_update(thought_chunk("more", None)).unwrap();
    thread.handle_session_update(agent_chunk("answer", None)).unwrap();

    assert_eq!(
        assistant_chunk_texts(&thread),
        vec![
            (true, "think more".to_string()),
            (false, "answer".to_string())
        ]
    );
}

// ----------------------------------------------------------------- tool calls

/// Adapted from `test_tool_call_not_found_creates_failed_entry`.
#[tokio::test]
async fn an_update_for_an_unknown_tool_call_becomes_a_failed_entry() {
    let (mut thread, _events, _conn) = new_thread();

    thread
        .update_tool_call(tool_call_update("ghost", Some(acp::ToolCallStatus::Completed)))
        .unwrap();

    assert_eq!(status_of(&thread, "ghost"), "Failed");
}

/// Adapted from `test_permission_request_sets_waiting_status_on_existing_tool_call`.
#[tokio::test]
async fn requesting_permission_puts_an_existing_call_into_waiting() {
    let (mut thread, _events, _conn) = new_thread();

    thread
        .upsert_tool_call(tool_call("t1", "run", acp::ToolCallStatus::InProgress))
        .unwrap();
    let _waiter = thread
        .request_tool_call_authorization(
            tool_call_update("t1", None),
            PermissionOptions::Flat(Vec::new()),
            AuthorizationKind::PermissionGrant,
        )
        .unwrap();

    assert_eq!(status_of(&thread, "t1"), "Waiting for confirmation");
}

/// Adapted from
/// `test_duplicate_tool_call_update_preserves_open_permission_request_until_authorized`
/// and `test_permission_request_tracks_agent_status_until_resolved`.
///
/// This is the regression that matters most in this file: while the user is
/// being asked, the agent keeps streaming status updates for the same call.
/// Applying one directly would drop the `respond_tx` and strand the agent
/// waiting on an answer that can no longer be sent.
#[tokio::test]
async fn a_status_update_does_not_close_an_open_permission_request() {
    let (mut thread, _events, _conn) = new_thread();

    thread
        .upsert_tool_call(tool_call("t1", "run", acp::ToolCallStatus::Pending))
        .unwrap();
    let waiter = thread
        .request_tool_call_authorization(
            tool_call_update("t1", None),
            PermissionOptions::Flat(Vec::new()),
            AuthorizationKind::PermissionGrant,
        )
        .unwrap();

    // Duplicate in-progress updates arrive while the prompt is open.
    thread
        .upsert_tool_call(tool_call("t1", "run", acp::ToolCallStatus::InProgress))
        .unwrap();
    thread
        .upsert_tool_call(tool_call("t1", "run", acp::ToolCallStatus::InProgress))
        .unwrap();

    assert_eq!(
        status_of(&thread, "t1"),
        "Waiting for confirmation",
        "the open prompt must survive concurrent status updates"
    );

    // Answering still works, and lands on the status the agent had reached.
    thread.authorize_tool_call(
        acp::ToolCallId::new("t1"),
        SelectedPermissionOutcome::new(
            acp::PermissionOptionId::new("allow"),
            acp::PermissionOptionKind::AllowOnce,
        ),
    );

    let outcome = waiter.await;
    assert!(matches!(outcome, RequestPermissionOutcome::Selected(_)));
    assert_eq!(status_of(&thread, "t1"), "In Progress");
}

/// Adapted from `test_cancel_tool_call_authorization_resolves_permission_request`.
#[tokio::test]
async fn cancelling_an_authorization_resolves_the_waiter() {
    let (mut thread, _events, _conn) = new_thread();

    thread
        .upsert_tool_call(tool_call("t1", "run", acp::ToolCallStatus::Pending))
        .unwrap();
    let waiter = thread
        .request_tool_call_authorization(
            tool_call_update("t1", None),
            PermissionOptions::Flat(Vec::new()),
            AuthorizationKind::PermissionGrant,
        )
        .unwrap();

    thread.cancel_tool_call_authorization(&acp::ToolCallId::new("t1"));

    assert!(matches!(waiter.await, RequestPermissionOutcome::Cancelled));
    assert_eq!(status_of(&thread, "t1"), "Canceled");
}

/// Rejecting moves the call to `Rejected` rather than letting it proceed.
#[tokio::test]
async fn rejecting_a_permission_marks_the_call_rejected() {
    let (mut thread, _events, _conn) = new_thread();

    thread
        .upsert_tool_call(tool_call("t1", "run", acp::ToolCallStatus::Pending))
        .unwrap();
    let _waiter = thread
        .request_tool_call_authorization(
            tool_call_update("t1", None),
            PermissionOptions::Flat(Vec::new()),
            AuthorizationKind::PermissionGrant,
        )
        .unwrap();

    thread.authorize_tool_call(
        acp::ToolCallId::new("t1"),
        SelectedPermissionOutcome::new(
            acp::PermissionOptionId::new("deny"),
            acp::PermissionOptionKind::RejectOnce,
        ),
    );

    assert_eq!(status_of(&thread, "t1"), "Rejected");
}

/// An `ActionChoice` prompt is not a grant: whichever option is picked, the tool
/// proceeds and the caller interprets the option id.
#[tokio::test]
async fn an_action_choice_proceeds_even_when_the_option_reads_as_a_rejection() {
    let (mut thread, _events, _conn) = new_thread();

    thread
        .upsert_tool_call(tool_call("t1", "save?", acp::ToolCallStatus::Pending))
        .unwrap();
    let _waiter = thread
        .request_tool_call_authorization(
            tool_call_update("t1", None),
            PermissionOptions::Flat(Vec::new()),
            AuthorizationKind::ActionChoice,
        )
        .unwrap();

    thread.authorize_tool_call(
        acp::ToolCallId::new("t1"),
        SelectedPermissionOutcome::new(
            acp::PermissionOptionId::new("discard"),
            acp::PermissionOptionKind::RejectOnce,
        ),
    );

    assert_eq!(status_of(&thread, "t1"), "In Progress");
}

/// Adapted from `test_succeeding_canceled_toolcall`: a completion that arrives
/// after cancellation still wins, because the tool really did finish.
#[tokio::test]
async fn a_completion_arriving_after_cancel_is_recorded() {
    let (mut thread, _events, _conn) = new_thread();

    thread.begin_turn();
    thread
        .upsert_tool_call(tool_call("t1", "run", acp::ToolCallStatus::InProgress))
        .unwrap();
    thread.cancel();
    assert_eq!(status_of(&thread, "t1"), "Canceled");

    thread
        .upsert_tool_call(tool_call("t1", "run", acp::ToolCallStatus::Completed))
        .unwrap();
    assert_eq!(status_of(&thread, "t1"), "Completed");
}

// --------------------------------------------------------------------- cancel

/// Adapted from `AcpThread::cancel` + `mark_pending_entries_as_canceled`.
#[tokio::test]
async fn cancel_resolves_every_pending_permission_and_tells_the_connection() {
    let (mut thread, _events, connection) = new_thread();

    thread.begin_turn();
    thread
        .upsert_tool_call(tool_call("t1", "run", acp::ToolCallStatus::Pending))
        .unwrap();
    let waiter = thread
        .request_tool_call_authorization(
            tool_call_update("t1", None),
            PermissionOptions::Flat(Vec::new()),
            AuthorizationKind::PermissionGrant,
        )
        .unwrap();

    thread.cancel();

    assert!(matches!(waiter.await, RequestPermissionOutcome::Cancelled));
    assert_eq!(status_of(&thread, "t1"), "Canceled");
    assert_eq!(connection.cancel_count.load(Ordering::SeqCst), 1);
    assert!(!thread.is_generating());
}

/// Adapted from `run_turn` (`acp_thread.rs:3743`): a follow-up send cancels the
/// previous turn with `InterruptedByFollowUp`, which is a different outcome from
/// the user pressing stop and is visible to whoever was awaiting permission.
#[tokio::test]
async fn a_follow_up_turn_cancels_the_previous_one_as_interrupted() {
    let (mut thread, _events, _conn) = new_thread();

    thread.begin_turn();
    thread
        .upsert_tool_call(tool_call("t1", "run", acp::ToolCallStatus::Pending))
        .unwrap();
    let waiter = thread
        .request_tool_call_authorization(
            tool_call_update("t1", None),
            PermissionOptions::Flat(Vec::new()),
            AuthorizationKind::PermissionGrant,
        )
        .unwrap();

    thread.begin_turn();

    assert!(matches!(
        waiter.await,
        RequestPermissionOutcome::InterruptedByFollowUp
    ));
}

/// Cancelling with no turn running must not fire `session/cancel` — Zed returns
/// early on `running_turn.take()` being `None`.
#[tokio::test]
async fn cancelling_an_idle_thread_does_not_notify_the_agent() {
    let (mut thread, _events, connection) = new_thread();

    thread.cancel();

    assert_eq!(connection.cancel_count.load(Ordering::SeqCst), 0);
}

// ------------------------------------------------------------------ plan/usage

#[tokio::test]
async fn a_plan_update_replaces_the_plan_and_reports_stats() {
    let (mut thread, _events, _conn) = new_thread();

    let done = acp::PlanEntry::new(
        "done",
        acp::PlanEntryPriority::Medium,
        acp::PlanEntryStatus::Completed,
    );
    let running = acp::PlanEntry::new(
        "running",
        acp::PlanEntryPriority::High,
        acp::PlanEntryStatus::InProgress,
    );
    let todo = acp::PlanEntry::new(
        "todo",
        acp::PlanEntryPriority::Low,
        acp::PlanEntryStatus::Pending,
    );

    thread.handle_session_update(acp::SessionUpdate::Plan(acp::Plan::new(vec![
        done, running, todo,
    ])))
    .unwrap();

    let stats = thread.plan().stats();
    assert_eq!(stats.completed, 1);
    assert_eq!(stats.pending, 2, "an in-progress entry still counts as pending");
    assert_eq!(
        stats.in_progress_entry.map(|e| e.content.as_str()),
        Some("running")
    );
}

#[tokio::test]
async fn a_usage_update_populates_token_usage_and_cost() {
    let (mut thread, _events, _conn) = new_thread();

    let mut update = acp::UsageUpdate::new(1_000, 4_000);
    update.cost = Some(acp::Cost::new(0.25, "USD"));
    thread
        .handle_session_update(acp::SessionUpdate::UsageUpdate(update))
        .unwrap();

    let usage = thread.token_usage().expect("usage missing");
    assert_eq!(usage.used_tokens, 1_000);
    assert_eq!(usage.max_tokens, 4_000);
    assert_eq!(usage.ratio(), TokenUsageRatio::Normal);
    assert_eq!(thread.cost().map(|c| c.amount), Some(0.25));
}

#[tokio::test]
async fn token_usage_warns_at_the_threshold_and_never_without_a_maximum() {
    let unknown_max = TokenUsage {
        max_tokens: 0,
        used_tokens: 999_999,
        ..Default::default()
    };
    assert_eq!(unknown_max.ratio(), TokenUsageRatio::Normal);

    let warning = TokenUsage {
        max_tokens: 100,
        used_tokens: 80,
        ..Default::default()
    };
    assert_eq!(warning.ratio(), TokenUsageRatio::Warning);

    let exceeded = TokenUsage {
        max_tokens: 100,
        used_tokens: 100,
        ..Default::default()
    };
    assert_eq!(exceeded.ratio(), TokenUsageRatio::Exceeded);
}

/// A permission request whose `tool_call` is a BARE update — id only, nothing
/// announced beforehand. The protocol makes every field but the id optional on
/// an update, and some adapters ask permission without a prior `tool_call`
/// notification. Refusing the request over a missing display string strands
/// the agent on an error and the user never sees a prompt (#28).
#[tokio::test]
async fn a_bare_permission_request_for_an_unknown_call_still_yields_a_prompt() {
    let (mut thread, _events, _conn) = new_thread();

    let _waiter = thread
        .request_tool_call_authorization(
            tool_call_update("never-announced", None),
            PermissionOptions::Flat(Vec::new()),
            AuthorizationKind::PermissionGrant,
        )
        .expect("a bare update must not be refused");

    assert_eq!(status_of(&thread, "never-announced"), "Waiting for confirmation");
}

/// The synthesized placeholder takes whatever the update DID carry — an agent
/// that sent a title without a prior announcement keeps it.
#[tokio::test]
async fn a_titled_permission_request_for_an_unknown_call_keeps_its_title() {
    let (mut thread, _events, _conn) = new_thread();

    let mut fields = acp::ToolCallUpdateFields::new();
    fields.title = Some("Delete the database".to_string());
    let _waiter = thread
        .request_tool_call_authorization(
            acp::ToolCallUpdate::new(acp::ToolCallId::new("t9"), fields),
            PermissionOptions::Flat(Vec::new()),
            AuthorizationKind::PermissionGrant,
        )
        .unwrap();

    let (_, call) = thread.tool_call(&acp::ToolCallId::new("t9")).expect("the call exists");
    assert_eq!(call.label, "Delete the database");
}

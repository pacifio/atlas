//! What the wire sees when a real thread runs.
//!
//! Every test drives an actual `AcpThread` with actual `session/update`
//! payloads and asserts on the deltas that come out the other side, because
//! that is the pair the rest of Atlas depends on — the thread's behaviour and
//! the wire's shape, together.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{
    AcpThread, AcpThreadHandle, AgentConnection, AgentId as ThreadAgentId, AuthorizationKind,
    PermissionOptions,
};
use atlas_agent_delta::{AgentId, DeltaProjector, DeltaSink, SessionDelta, SessionDeltaEnvelope};
use futures::future::BoxFuture;
use futures::FutureExt;

// ------------------------------------------------------------------- harness

#[derive(Default)]
struct Recorder {
    envelopes: Mutex<Vec<SessionDeltaEnvelope>>,
}

impl Recorder {
    fn kinds(&self) -> Vec<String> {
        self.envelopes
            .lock()
            .unwrap()
            .iter()
            .map(|envelope| {
                serde_json::to_value(&envelope.delta).unwrap()["kind"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect()
    }

    fn deltas(&self) -> Vec<SessionDelta> {
        self.envelopes
            .lock()
            .unwrap()
            .iter()
            .map(|envelope| envelope.delta.clone())
            .collect()
    }

    fn len(&self) -> usize {
        self.envelopes.lock().unwrap().len()
    }
}

impl DeltaSink for Recorder {
    fn emit(&self, envelope: SessionDeltaEnvelope) {
        self.envelopes.lock().unwrap().push(envelope);
    }
}

struct StubConnection;

impl AgentConnection for StubConnection {
    fn agent_id(&self) -> ThreadAgentId {
        ThreadAgentId::new("stub")
    }
    fn telemetry_id(&self) -> Arc<str> {
        "stub".into()
    }
    fn new_session(
        self: Arc<Self>,
        _work_dirs: Vec<PathBuf>,
    ) -> BoxFuture<'static, anyhow::Result<AcpThreadHandle>> {
        async { Err(anyhow::anyhow!("not used")) }.boxed()
    }
    fn auth_methods(&self) -> &[acp::AuthMethod] {
        &[]
    }
    fn authenticate(&self, _method: acp::AuthMethodId) -> BoxFuture<'static, anyhow::Result<()>> {
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

struct Harness {
    projector: Arc<DeltaProjector>,
    recorder: Arc<Recorder>,
    thread: AcpThreadHandle,
    session_id: acp::SessionId,
    /// Pumped by hand, so a test sees the deltas a thread mutation produced
    /// rather than whatever a task happened to coalesce. `attach` spawns the
    /// same loop in production.
    events: Mutex<atlas_acp_thread::EventStream<atlas_acp_thread::AcpThreadEvent>>,
}

impl Harness {
    fn start() -> Self {
        let recorder = Arc::new(Recorder::default());
        let projector = DeltaProjector::new(recorder.clone());
        let session_id = acp::SessionId::new("sess-1");

        // The sink is handed out before the thread exists, exactly as
        // `ConnectOptions` does it.
        let events = (projector.thread_events())(&session_id);
        let thread = Arc::new(Mutex::new(AcpThread::new(
            session_id.clone(),
            Arc::new(StubConnection) as Arc<dyn AgentConnection>,
            vec![PathBuf::from("/tmp")],
            None,
            events,
        )));
        let events = projector
            .register(AgentId::new(), thread.clone())
            .expect("the session was registered");

        Self {
            projector,
            recorder,
            thread,
            session_id,
            events: Mutex::new(events),
        }
    }

    /// Apply everything the thread has emitted so far.
    fn pump(&self) {
        let mut events = self.events.lock().unwrap();
        while let Ok(event) = events.try_recv() {
            self.projector.apply(&self.session_id, event);
        }
    }

    fn update(&self, update: serde_json::Value) {
        let update: acp::SessionUpdate =
            serde_json::from_value(update).expect("a session update this schema understands");
        lock(&self.thread)
            .handle_session_update(update)
            .expect("the thread accepts it");
        self.pump();
    }

    fn expect(&self, at_least: usize) {
        self.pump();
        assert!(
            self.recorder.len() >= at_least,
            "expected at least {at_least} deltas, saw {:?}",
            self.recorder.kinds()
        );
    }
}

fn lock(thread: &AcpThreadHandle) -> std::sync::MutexGuard<'_, AcpThread> {
    thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn text_chunk(text: &str) -> serde_json::Value {
    serde_json::json!({
        "sessionUpdate": "agent_message_chunk",
        "content": { "type": "text", "text": text },
    })
}

fn thought_chunk(text: &str) -> serde_json::Value {
    serde_json::json!({
        "sessionUpdate": "agent_thought_chunk",
        "content": { "type": "text", "text": text },
    })
}

// --------------------------------------------------------------------- tests

#[tokio::test(flavor = "multi_thread")]
async fn streamed_text_is_a_message_then_chunks() {
    let harness = Harness::start();

    harness.update(text_chunk("Hel"));
    harness.update(text_chunk("lo"));
    harness.expect(2);

    assert_eq!(harness.recorder.kinds(), ["message_appended", "text_chunk"]);
    match &harness.recorder.deltas()[1] {
        SessionDelta::TextChunk { delta, .. } => assert_eq!(delta, "lo"),
        other => panic!("expected a text chunk, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_thought_after_text_opens_its_own_message() {
    // The thread keeps one entry with interleaved chunks; the wire keeps a
    // message per run, so the mode switch has to split.
    let harness = Harness::start();

    harness.update(text_chunk("thinking about it"));
    harness.update(thought_chunk("hmm"));
    harness.update(thought_chunk("...yes"));
    harness.expect(3);

    assert_eq!(
        harness.recorder.kinds(),
        ["message_appended", "message_appended", "thinking_chunk"]
    );
    match &harness.recorder.deltas()[1] {
        SessionDelta::MessageAppended { message } => {
            assert_eq!(message.mode, atlas_agent_delta::MessageMode::Thinking);
            assert_eq!(message.thinking, "hmm");
            assert!(message.content.is_empty());
        }
        other => panic!("expected a message, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_user_message_never_reaches_the_wire() {
    // Capture gets the prompt from the send path, with the raw text before
    // memory prefixing. A user message on the delta stream would double-record
    // it, and with the wrong text.
    let harness = Harness::start();

    lock(&harness.thread).push_user_content_block(
        None,
        acp::ContentBlock::Text(acp::TextContent::new("do the thing".to_string())),
    );
    harness.update(text_chunk("on it"));
    harness.expect(1);

    assert_eq!(harness.recorder.kinds(), ["message_appended"]);
    match &harness.recorder.deltas()[0] {
        SessionDelta::MessageAppended { message } => {
            assert_eq!(message.role, atlas_agent_delta::MessageRole::Assistant);
        }
        other => panic!("expected the assistant's message, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tool_call_carries_all_four_canonicalization_inputs() {
    // Touchpoint #10: capture derives the canonical tool name from
    // `canonical_name(tool_name, title, kind, arguments)`, and the wire
    // `tool_name` alone is a display title.
    let harness = Harness::start();

    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "call-1",
        "title": "Read src/main.rs",
        "kind": "read",
        "status": "in_progress",
        "rawInput": { "path": "src/main.rs" },
    }));
    harness.expect(1);

    match &harness.recorder.deltas()[0] {
        SessionDelta::ToolCallUpserted { tool_call, .. } => {
            assert_eq!(tool_call.id, "call-1");
            assert_eq!(tool_call.title.as_deref(), Some("Read src/main.rs"));
            assert_eq!(tool_call.kind.as_deref(), Some("read"));
            assert_eq!(tool_call.arguments["path"], "src/main.rs");
            assert!(!tool_call.tool_name.is_empty());
            assert_eq!(tool_call.status, atlas_agent_delta::ToolCallStatus::Running);
        }
        other => panic!("expected a tool call, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn growing_tool_output_streams_as_chunks_and_settling_sends_a_snapshot() {
    let harness = Harness::start();

    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "call-1",
        "title": "Bash",
        "kind": "execute",
        "status": "in_progress",
        "rawInput": { "command": "ls" },
    }));
    // Output arrives; nothing else about the call changed.
    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call_update",
        "toolCallId": "call-1",
        "content": [{ "type": "content", "content": { "type": "text", "text": "one" } }],
    }));
    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call_update",
        "toolCallId": "call-1",
        "content": [{ "type": "content", "content": { "type": "text", "text": "one\ntwo" } }],
    }));
    // Now it finishes: a status change is never a chunk.
    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call_update",
        "toolCallId": "call-1",
        "status": "completed",
        "content": [{ "type": "content", "content": { "type": "text", "text": "one\ntwo" } }],
    }));
    harness.expect(4);

    assert_eq!(
        harness.recorder.kinds(),
        [
            "tool_call_upserted",
            "tool_call_upserted",
            "tool_call_output_chunk",
            "tool_call_upserted",
        ]
    );
    match &harness.recorder.deltas()[2] {
        SessionDelta::ToolCallOutputChunk {
            tool_call_id,
            delta,
            ..
        } => {
            assert_eq!(tool_call_id, "call-1");
            assert_eq!(delta, "\ntwo", "only the tail travels");
        }
        other => panic!("expected an output chunk, got {other:?}"),
    }
    match &harness.recorder.deltas()[3] {
        SessionDelta::ToolCallUpserted { tool_call, .. } => {
            assert_eq!(
                tool_call.status,
                atlas_agent_delta::ToolCallStatus::Completed
            );
            assert_eq!(tool_call.result.as_deref(), Some("one\ntwo"));
        }
        other => panic!("expected a snapshot, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_turn_is_a_status_flip_and_a_terminal() {
    // There is no `turn_started` kind — `status: running` is the signal, and the
    // turn identity is the one the host stamped.
    let harness = Harness::start();
    harness.projector.set_turn_seq(&harness.session_id, 7);

    lock(&harness.thread).begin_turn();
    harness.expect(1);
    lock(&harness.thread).end_turn(acp::StopReason::EndTurn);
    harness.expect(3);

    assert_eq!(
        harness.recorder.kinds(),
        ["status", "turn_finished", "status"]
    );
    match &harness.recorder.deltas()[0] {
        SessionDelta::Status { status, turn_seq } => {
            assert_eq!(*status, atlas_agent_delta::SessionStatus::Running);
            assert_eq!(*turn_seq, 7);
        }
        other => panic!("expected a status, got {other:?}"),
    }
    match &harness.recorder.deltas()[1] {
        SessionDelta::TurnFinished {
            stop_reason,
            turn_seq,
        } => {
            // The token the frontend matches on, serialized rather than
            // hand-formatted (ATL-6 shipped "endturn").
            assert_eq!(stop_reason, "end_turn");
            assert_eq!(*turn_seq, 7);
        }
        other => panic!("expected a terminal, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_permission_prompt_is_announced_and_resolved_by_the_same_id() {
    let harness = Harness::start();

    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "call-1",
        "title": "Write a.txt",
        "kind": "edit",
        "status": "pending",
        "rawInput": { "path": "a.txt" },
    }));
    harness.expect(1);

    let waiter = lock(&harness.thread)
        .request_tool_call_authorization(
            acp::ToolCallUpdate::new(
                acp::ToolCallId::new("call-1"),
                acp::ToolCallUpdateFields::default(),
            ),
            PermissionOptions::Flat(vec![acp::PermissionOption::new(
                "allow_once",
                "Allow once",
                acp::PermissionOptionKind::AllowOnce,
            )]),
            AuthorizationKind::PermissionGrant,
        )
        .expect("the prompt opens");
    harness.expect(3);

    let kinds = harness.recorder.kinds();
    assert!(
        kinds.contains(&"permission_request".to_string()),
        "the prompt reached the wire: {kinds:?}"
    );
    assert!(
        kinds.contains(&"status".to_string()),
        "and the session reads as waiting: {kinds:?}"
    );

    let request_id = harness
        .recorder
        .deltas()
        .into_iter()
        .find_map(|delta| match delta {
            SessionDelta::PermissionRequest {
                request_id,
                tool_call,
                options,
            } => {
                assert_eq!(tool_call["toolCallId"], "call-1");
                assert_eq!(options[0]["optionId"], "allow_once");
                Some(request_id)
            }
            _ => None,
        })
        .expect("a permission request");

    // The host answers by uuid and has to reach the tool call behind it.
    let key = harness
        .projector
        .permission_key(&request_id)
        .expect("the request is routable back to its tool call");
    assert_eq!(key.tool_call_id.to_string(), "call-1");

    lock(&harness.thread).authorize_tool_call(
        acp::ToolCallId::new("call-1"),
        atlas_acp_thread::SelectedPermissionOutcome::new(
            acp::PermissionOptionId::new("allow_once"),
            acp::PermissionOptionKind::AllowOnce,
        ),
    );
    // The thread announces the answer from the waiter, which is what the agent
    // side is holding.
    waiter.await;
    harness.expect(5);

    let resolved = harness
        .recorder
        .deltas()
        .into_iter()
        .find_map(|delta| match delta {
            SessionDelta::PermissionResolved { request_id } => Some(request_id),
            _ => None,
        })
        .expect("the prompt is closed on the wire too");
    assert_eq!(resolved, request_id, "closed by the id it was opened with");
}

#[tokio::test(flavor = "multi_thread")]
async fn plan_mode_commands_config_and_title_all_project() {
    let harness = Harness::start();

    harness.update(serde_json::json!({
        "sessionUpdate": "plan",
        "entries": [{ "content": "step one", "priority": "high", "status": "in_progress" }],
    }));
    harness.update(serde_json::json!({
        "sessionUpdate": "current_mode_update",
        "currentModeId": "plan",
    }));
    harness.update(serde_json::json!({
        "sessionUpdate": "available_commands_update",
        "availableCommands": [{ "name": "login", "description": "sign in" }],
    }));
    harness.update(serde_json::json!({
        "sessionUpdate": "session_info_update",
        "title": "a named session",
    }));
    harness.expect(4);

    assert_eq!(
        harness.recorder.kinds(),
        [
            "plan_updated",
            "mode_changed",
            "available_commands",
            "title_updated"
        ]
    );
    match &harness.recorder.deltas()[0] {
        SessionDelta::PlanUpdated { plan } => {
            assert_eq!(plan[0].content, "step one");
            assert_eq!(plan[0].status, "in_progress");
            assert_eq!(plan[0].priority.as_deref(), Some("high"));
        }
        other => panic!("expected a plan, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn context_usage_and_the_token_split_are_separate_deltas() {
    let harness = Harness::start();

    // An ACP agent reports a context window and no split.
    harness.update(serde_json::json!({
        "sessionUpdate": "usage_update",
        "used": 1_000,
        "size": 200_000,
    }));
    harness.expect(1);
    assert_eq!(harness.recorder.kinds(), ["context_usage"]);

    // The native agent reports a real input/output split.
    lock(&harness.thread).update_token_usage(Some(atlas_acp_thread::TokenUsage {
        input_tokens: 11,
        output_tokens: 7,
        ..Default::default()
    }));
    harness.expect(2);
    match &harness.recorder.deltas()[1] {
        SessionDelta::UsageUpdated { usage } => {
            assert_eq!(usage.input_tokens, 11);
            assert_eq!(usage.output_tokens, 7);
        }
        other => panic!("expected a usage split, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_host_announces_what_the_thread_cannot() {
    let harness = Harness::start();

    harness
        .projector
        .note_turn_failed(&harness.session_id, "the model refused", Some("auth".into()));
    harness
        .projector
        .note_model_changed(&harness.session_id, "anthropic/claude");
    harness
        .projector
        .note_compression_saved(&harness.session_id, 128);
    harness
        .projector
        .note_agent_disconnected(&harness.session_id, "process died");
    harness.expect(4);

    assert_eq!(
        harness.recorder.kinds(),
        [
            "turn_failed",
            "model_changed",
            "compression_saved",
            "agent_disconnected"
        ]
    );
    match &harness.recorder.deltas()[0] {
        SessionDelta::TurnFailed {
            error, error_kind, ..
        } => {
            assert_eq!(error, "the model refused");
            // "auth" is what routes the frontend to the sign-in flow.
            assert_eq!(error_kind.as_deref(), Some("auth"));
        }
        other => panic!("expected a failure, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn every_delta_ships_with_its_routing_keys() {
    let harness = Harness::start();
    harness.update(text_chunk("hi"));
    harness.expect(1);

    let envelope = &harness.recorder.envelopes.lock().unwrap()[0];
    assert_eq!(envelope.session_id, "sess-1");
    let value = serde_json::to_value(envelope).unwrap();
    assert_eq!(value["session_id"], "sess-1");
    assert!(value["agent_id"].is_string());
    assert_eq!(value["kind"], "message_appended");
}

/// The elicitation counterpart of the permission round-trip.
///
/// The wire names an elicitation by a fresh uuid, and `agents_respond_elicitation`
/// answers by that uuid — so the projector has to remember which thread entry it
/// stood for. Without the mapping the id the frontend was handed resolves to
/// nothing and the dialog can never be answered.
#[test]
fn an_elicitation_can_be_answered_by_the_id_the_wire_carried() {
    let harness = Harness::start();

    // The 1.5 wire shape: `mode` discriminates, the scope is flattened in.
    let request: acp::CreateElicitationRequest = serde_json::from_value(serde_json::json!({
        "mode": "form",
        "sessionId": "sess-1",
        "message": "Which environment?",
        "requestedSchema": {
            "type": "object",
            "properties": { "env": { "type": "string" } },
        },
    }))
    .expect("a request this schema understands");

    let (entry_id, _response) = lock(&harness.thread)
        .request_elicitation(request)
        .expect("the thread accepts it");
    harness.pump();

    let request_id = harness
        .recorder
        .deltas()
        .into_iter()
        .find_map(|delta| match delta {
            SessionDelta::ElicitationRequested {
                request_id,
                mode,
                message,
                requested_schema,
                url,
            } => {
                // A schema and no url is the form shape; the frontend narrows
                // `mode` to exactly these two.
                assert_eq!(mode, "form");
                assert_eq!(message, "Which environment?");
                assert!(requested_schema.is_some());
                assert!(url.is_none());
                Some(request_id)
            }
            _ => None,
        })
        .expect("an elicitation request");

    let key = harness
        .projector
        .elicitation_key(&request_id)
        .expect("the uuid resolves to the entry waiting on it");
    assert_eq!(key.session_id, harness.session_id);
    assert_eq!(key.entry_id, entry_id);

    // An id that was never announced resolves to nothing rather than to some
    // other session's dialog.
    assert!(harness
        .projector
        .elicitation_key(&uuid::Uuid::new_v4())
        .is_none());
}

/// A snapshot is what the frontend paints before any delta arrives, so it has
/// to describe the same conversation the deltas do — including the user's half,
/// which the live stream deliberately omits.
#[test]
fn a_snapshot_carries_the_whole_conversation_including_the_user() {
    let harness = Harness::start();

    lock(&harness.thread).push_user_content_block(
        None,
        acp::ContentBlock::Text(acp::TextContent::new("fix the bug".to_string())),
    );
    harness.update(serde_json::json!({
        "sessionUpdate": "agent_thought_chunk",
        "content": { "type": "text", "text": "let me look" },
    }));
    harness.update(serde_json::json!({
        "sessionUpdate": "agent_message_chunk",
        "content": { "type": "text", "text": "found it" },
    }));
    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "call-1",
        "title": "Edit main.rs",
        "kind": "edit",
        "status": "completed",
        "rawInput": { "path": "main.rs" },
    }));

    let thread = lock(&harness.thread);
    let messages =
        atlas_agent_delta::project::snapshot_messages(&thread, Some("claude-opus-5"));
    drop(thread);

    let shape: Vec<(&str, &str)> = messages
        .iter()
        .map(|m| {
            let role = match m.role {
                atlas_agent_delta::MessageRole::User => "user",
                atlas_agent_delta::MessageRole::Assistant => "assistant",
                atlas_agent_delta::MessageRole::System => "system",
            };
            let mode = match m.mode {
                atlas_agent_delta::MessageMode::Text => "text",
                atlas_agent_delta::MessageMode::Thinking => "thinking",
                atlas_agent_delta::MessageMode::Tool => "tool",
            };
            (role, mode)
        })
        .collect();
    assert_eq!(
        shape,
        [
            ("user", "text"),
            // The thought and the prose are separate runs, so they are separate
            // bubbles — the same split the delta stream makes.
            ("assistant", "thinking"),
            ("assistant", "text"),
            ("assistant", "tool"),
        ]
    );
    assert_eq!(messages[0].content, "fix the bug");
    assert_eq!(messages[1].thinking, "let me look");
    assert_eq!(messages[2].content, "found it");
    assert_eq!(messages[3].tool_calls[0].id, "call-1");

    // The user never gets a model attribution; the agent's messages do.
    assert!(messages[0].model.is_none());
    assert_eq!(messages[2].model.as_deref(), Some("claude-opus-5"));

    // Message ids are unique — the frontend keys its mirror on them.
    let ids: std::collections::HashSet<_> = messages.iter().map(|m| &m.id).collect();
    assert_eq!(ids.len(), messages.len());
}

// ------------------------------------------------------- terminal tool calls

/// `echo`, wherever this platform keeps it.
fn echo_binary() -> &'static str {
    ["/bin/echo", "/usr/bin/echo"]
        .into_iter()
        .find(|path| std::path::Path::new(path).exists())
        .unwrap_or("echo")
}

/// Announce a tool call whose content is a terminal the agent created. This is
/// the exact shape `terminal/create` + `session/update` produce: the block
/// carries an id and nothing else — the output lives on the client's side.
fn terminal_tool_call(id: &str, terminal_id: &str) -> serde_json::Value {
    serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": id,
        "title": "Run a command",
        "kind": "execute",
        "status": "in_progress",
        "content": [{ "type": "terminal", "terminalId": terminal_id }],
    })
}

/// Register a real PTY-backed command as `terminal_id`, the way
/// `handle_create_terminal` does, and wait for it to finish.
async fn create_terminal(harness: &Harness, terminal_id: &str, args: &[&str]) {
    let terminal = std::sync::Arc::new(
        atlas_terminal::command::CommandTerminal::spawn(
            echo_binary(),
            &args.iter().map(std::string::ToString::to_string).collect::<Vec<_>>(),
            &[],
            None,
            4096,
        )
        .expect("failed to spawn echo(1)"),
    );
    terminal.wait_for_exit().await;
    lock(&harness.thread).on_terminal_provider_event(
        atlas_acp_thread::TerminalProviderEvent::Created {
            terminal_id: acp::TerminalId::new(terminal_id),
            label: "echo".into(),
            cwd: None,
            output_byte_limit: Some(4096),
            terminal: Some(terminal),
        },
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_terminal_tool_call_carries_its_output_to_the_wire() {
    // The regression: a terminal block contributed NOTHING to the tool call —
    // it was skipped when flattening the result — so a command the agent ran
    // through `terminal/create` showed an empty output pane forever, however
    // much it printed.
    let harness = Harness::start();

    create_terminal(&harness, "term-1", &["hello from the pty"]).await;
    harness.update(terminal_tool_call("call-1", "term-1"));
    lock(&harness.thread).note_terminal_output(&acp::TerminalId::new("term-1"));
    harness.expect(1);

    let result = harness
        .recorder
        .deltas()
        .into_iter()
        .filter_map(|d| match d {
            SessionDelta::ToolCallUpserted { tool_call, .. } => tool_call.result,
            _ => None,
        })
        .next_back()
        .expect("the tool call reached the wire");
    assert!(
        result.contains("hello from the pty"),
        "the terminal's output is missing from the tool call result: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn terminal_output_still_names_its_block_on_the_wire() {
    // The block itself must survive alongside the flattened text: it is what
    // tells the UI this tool call ran a terminal rather than returned a string.
    let harness = Harness::start();

    create_terminal(&harness, "term-2", &["x"]).await;
    harness.update(terminal_tool_call("call-2", "term-2"));
    harness.expect(1);

    let blocks = harness
        .recorder
        .deltas()
        .into_iter()
        .filter_map(|d| match d {
            SessionDelta::ToolCallUpserted { tool_call, .. } => Some(tool_call.content_blocks),
            _ => None,
        })
        .next_back()
        .expect("the tool call reached the wire");
    let json = serde_json::to_value(&blocks).expect("blocks serialize");
    assert_eq!(json[0]["type"], "terminal");
    assert_eq!(json[0]["terminalId"], "term-2");
}

#[tokio::test(flavor = "multi_thread")]
async fn growing_terminal_output_re_projects_the_tool_call() {
    // Live streaming. A terminal's output grows on its own, long after the
    // tool call that references it was announced — nothing else about the
    // thread changes. Zed gets this free: its terminal is an entity the view
    // holds, so notifying it re-renders the tool call. Atlas's terminals reach
    // the UI only through the tool call's projection, so without an explicit
    // link the output pane shows whatever happened to be buffered when some
    // unrelated event last re-projected the entry.
    let harness = Harness::start();

    // The terminal must exist before the agent can reference it: the id comes
    // from `terminal/create`, and the thread rejects a block naming an unknown
    // one (as Zed's `ToolCallContent::from_acp` does).
    create_terminal(&harness, "term-3", &["first"]).await;
    harness.update(terminal_tool_call("call-3", "term-3"));
    harness.expect(1);
    let before = harness.recorder.len();

    lock(&harness.thread).on_terminal_provider_event(
        atlas_acp_thread::TerminalProviderEvent::Output {
            terminal_id: acp::TerminalId::new("term-3"),
            data: b"and then more".to_vec(),
        },
    );
    harness.pump();

    assert!(
        harness.recorder.len() > before,
        "the terminal's growth produced no delta: {:?}",
        harness.recorder.kinds()
    );
    let last = harness
        .recorder
        .deltas()
        .into_iter()
        .filter_map(|d| match d {
            SessionDelta::ToolCallOutputChunk { delta, .. } => Some(delta),
            SessionDelta::ToolCallUpserted { tool_call, .. } => tool_call.result,
            _ => None,
        })
        .next_back()
        .expect("the tool call reached the wire");
    assert!(
        last.contains("and then more"),
        "the new output never reached the wire: {last:?}"
    );
}

/// #30 — the projection must be a function of the EVENT STREAM, not of live
/// state re-read at drain time. The drain lags the thread: an agent that gives
/// up on its own request (a cancelled turn ends the call) can move the status
/// past `WaitingForConfirmation` before the projector processes the
/// `ToolAuthorizationRequested` that preceded it. Re-reading status at drain
/// time made that window swallow the request entirely — no `permission_request`
/// delta, so the host never learned the uuid, and nothing could ever resolve.
///
/// The correct account of that sequence on the wire is: the prompt existed,
/// then it was resolved. Both deltas, in order. (The illustrative comment
/// below exercises the completed path; a cancelled turn moves the status the
/// same way.)
#[tokio::test(flavor = "multi_thread")]
async fn a_prompt_the_agent_abandoned_before_the_drain_is_still_announced_then_resolved() {
    let harness = Harness::start();

    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "call-1",
        "title": "Run tests",
        "kind": "execute",
        "status": "pending",
    }));
    harness.pump();

    // The prompt opens — but the projector does NOT get to drain yet.
    let waiter = lock(&harness.thread)
        .request_tool_call_authorization(
            acp::ToolCallUpdate::new(
                acp::ToolCallId::new("call-1"),
                acp::ToolCallUpdateFields::default(),
            ),
            PermissionOptions::Flat(vec![acp::PermissionOption::new(
                "allow_once",
                "Allow once",
                acp::PermissionOptionKind::AllowOnce,
            )]),
            AuthorizationKind::PermissionGrant,
        )
        .expect("the prompt opens");

    // The agent finishes the call before the drain runs (the same happens when
    // a cancelled turn ends it) — the terminal status replaces the waiting
    // state and drops the responder.
    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call_update",
        "toolCallId": "call-1",
        "status": "completed",
    }));
    // The dropped responder resolves the waiter; polling it emits the
    // `ToolAuthorizationReceived` the projector turns into the resolution.
    let outcome = waiter.await;
    assert!(matches!(
        outcome,
        atlas_acp_thread::RequestPermissionOutcome::Cancelled
    ));
    harness.pump();

    let kinds = harness.recorder.kinds();
    let request_at = kinds.iter().position(|k| k == "permission_request");
    let resolved_at = kinds.iter().position(|k| k == "permission_resolved");
    assert!(
        request_at.is_some(),
        "the prompt must reach the wire even though the status moved on: {kinds:?}"
    );
    assert!(
        resolved_at.is_some(),
        "and must be resolved so no pill is left open: {kinds:?}"
    );
    assert!(request_at < resolved_at, "announced before resolved: {kinds:?}");
}

/// #32 — the authoritative echo of a config-option set is the RESPONSE, not a
/// follow-up notification (the schema makes the notification optional). The
/// host forwards the response's list through this announcement; without it,
/// clicking "high" on the effort pill worked on the agent while the pill
/// snapped back, because nothing ever told the frontend it took.
#[tokio::test(flavor = "multi_thread")]
async fn the_host_announces_config_options_the_set_response_confirmed() {
    let harness = Harness::start();

    let options: Vec<acp::SessionConfigOption> = vec![serde_json::from_value(serde_json::json!({
        "id": "thought",
        "name": "Thinking",
        "category": "thought_level",
        "type": "select",
        "currentValue": "high",
        "options": [
            { "value": "low", "name": "Low" },
            { "value": "high", "name": "High" },
        ],
    }))
    .expect("an option this schema understands")];

    harness
        .projector
        .note_config_options(&harness.session_id, &options);
    harness.expect(1);

    match &harness.recorder.deltas()[0] {
        SessionDelta::ConfigOptionsUpdated { config_options } => {
            assert_eq!(config_options.len(), 1);
            assert_eq!(config_options[0]["id"], "thought");
            assert_eq!(
                config_options[0]["currentValue"], "high",
                "the confirmed value is what moves the pill"
            );
        }
        other => panic!("expected config options, got {other:?}"),
    }
}

// ------------------------------------------------- display-only terminals
//
// The shape ATL-219 is about: a terminal the AGENT runs and streams to us as
// `session/update` meta. It has no PTY of its own, so everything it will ever
// show arrives through `TerminalProviderEvent::Output`.

fn display_only_terminal(harness: &Harness, terminal_id: &str) {
    lock(&harness.thread).on_terminal_provider_event(
        atlas_acp_thread::TerminalProviderEvent::Created {
            terminal_id: acp::TerminalId::new(terminal_id),
            label: "agent-run".into(),
            cwd: None,
            output_byte_limit: None,
            terminal: None,
        },
    );
}

fn push_output(harness: &Harness, terminal_id: &str, data: &[u8]) {
    lock(&harness.thread).on_terminal_provider_event(
        atlas_acp_thread::TerminalProviderEvent::Output {
            terminal_id: acp::TerminalId::new(terminal_id),
            data: data.to_vec(),
        },
    );
    harness.pump();
}

/// The deltas emitted since `from`.
fn since(harness: &Harness, from: usize) -> Vec<SessionDelta> {
    harness.recorder.deltas().into_iter().skip(from).collect()
}

/// Regression, ATL-219. Every output chunk re-projected the tool call from
/// scratch — which meant decoding and copying everything the command had
/// printed so far, then comparing it byte for byte against the previous copy,
/// with the session's lock held. The cost per chunk grew with the total, so a
/// command's projection was quadratic in its own output and 2 MB of it stalled
/// the session for about four seconds.
///
/// What is asserted here is the *shape* the cheap path produces: exactly one
/// delta, carrying exactly the new bytes. `a_growing_terminal_costs_the_tail`
/// measures the cost itself.
#[tokio::test(flavor = "multi_thread")]
async fn a_growing_display_only_terminal_streams_only_its_tail() {
    let harness = Harness::start();

    display_only_terminal(&harness, "term-tail");
    push_output(&harness, "term-tail", b"first");
    harness.update(terminal_tool_call("call-tail", "term-tail"));
    harness.expect(1);
    let before = harness.recorder.len();

    push_output(&harness, "term-tail", b"-second");

    let new = since(&harness, before);
    assert_eq!(
        new.len(),
        1,
        "one chunk of output should be one delta: {:?}",
        harness.recorder.kinds()
    );
    match &new[0] {
        SessionDelta::ToolCallOutputChunk { delta, .. } => assert_eq!(delta, "-second"),
        other => panic!("expected only the tail on the wire, got {other:?}"),
    }
}

/// The guard on the cheap path. Once the buffer starts dropping its front, a
/// byte offset from an earlier read names different bytes than it did — and
/// `terminal_output` prefixes a truncation marker, which moves everything
/// again. Streaming a tail against that offset would ship garbage, so the
/// projection has to fall back to announcing the whole tool call.
#[tokio::test(flavor = "multi_thread")]
async fn a_truncating_terminal_falls_back_to_a_whole_snapshot() {
    let harness = Harness::start();

    lock(&harness.thread).on_terminal_provider_event(
        atlas_acp_thread::TerminalProviderEvent::Created {
            terminal_id: acp::TerminalId::new("term-trunc"),
            label: "agent-run".into(),
            cwd: None,
            output_byte_limit: Some(8),
            terminal: None,
        },
    );
    push_output(&harness, "term-trunc", b"12345678");
    harness.update(terminal_tool_call("call-trunc", "term-trunc"));
    harness.expect(1);
    let before = harness.recorder.len();

    push_output(&harness, "term-trunc", b"ABCD");

    let new = since(&harness, before);
    let result = match new.last() {
        Some(SessionDelta::ToolCallUpserted { tool_call, .. }) => tool_call
            .result
            .clone()
            .expect("the tool call carries its output"),
        other => panic!("a truncated buffer must re-announce the whole call, got {other:?}"),
    };
    assert!(
        result.starts_with("[earlier output dropped]"),
        "the wire has to admit the buffer dropped its front: {result:?}"
    );
    assert!(
        result.ends_with("5678ABCD"),
        "the retained window is the most recent bytes: {result:?}"
    );
}

/// Output arrives as bytes, and a chunk boundary can land in the middle of a
/// character. Serving a tail by byte offset must never cut one in half — the
/// offset the projection holds is a length it was told, not one it validated.
#[tokio::test(flavor = "multi_thread")]
async fn a_character_split_across_two_chunks_survives_the_tail_path() {
    let harness = Harness::start();

    display_only_terminal(&harness, "term-utf8");
    push_output(&harness, "term-utf8", b"start");
    harness.update(terminal_tool_call("call-utf8", "term-utf8"));
    harness.expect(1);

    // '🙂' is four bytes; send it two at a time.
    let smiley = "🙂".as_bytes();
    push_output(&harness, "term-utf8", &smiley[..2]);
    push_output(&harness, "term-utf8", &smiley[2..]);

    let assembled: String = harness
        .recorder
        .deltas()
        .into_iter()
        .filter_map(|delta| match delta {
            SessionDelta::ToolCallUpserted { tool_call, .. } => tool_call.result,
            SessionDelta::ToolCallOutputChunk { delta, .. } => Some(delta),
            _ => None,
        })
        .collect();
    assert_eq!(
        assembled, "start🙂",
        "a character split across chunks came through mangled"
    );
}

/// Regression, ATL-223. A streamed assistant message rebuilt and re-compared
/// its whole text on every chunk. The wire shape is unchanged — this pins that
/// the length-based tail finds the same suffix the full-string comparison did,
/// including across a block whose rendering changes kind mid-run.
#[tokio::test(flavor = "multi_thread")]
async fn a_run_that_changes_block_kind_still_streams_its_tail() {
    let harness = Harness::start();

    harness.update(serde_json::json!({
        "sessionUpdate": "agent_message_chunk",
        "content": { "type": "resource_link", "uri": "file:///tmp/a.rs", "name": "a.rs" },
    }));
    harness.update(text_chunk("and here is why"));
    harness.expect(2);

    assert_eq!(harness.recorder.kinds(), ["message_appended", "text_chunk"]);
    let assembled: String = harness
        .recorder
        .deltas()
        .into_iter()
        .filter_map(|delta| match delta {
            SessionDelta::MessageAppended { message } => Some(message.content),
            SessionDelta::TextChunk { delta, .. } => Some(delta),
            _ => None,
        })
        .collect();
    assert_eq!(
        assembled, "file:///tmp/a.rs\nand here is why",
        "the streamed tail does not reassemble into the run's text"
    );
}

/// Regression, ATL-221. `snapshot_messages` read the clock while it built each
/// message, so a snapshot of a past conversation reported every message as sent
/// at the moment it was taken — and two snapshots of a thread nobody had
/// touched disagreed with each other. The frontend computes turn durations and
/// "N ago" separators from these values, so the collapse was functional, not
/// cosmetic.
#[tokio::test(flavor = "multi_thread")]
async fn two_snapshots_of_an_unchanged_thread_carry_the_same_times() {
    let harness = Harness::start();

    lock(&harness.thread).push_user_content_block(
        None,
        acp::ContentBlock::Text(acp::TextContent::new("do the thing".to_string())),
    );
    harness.update(text_chunk("on it"));

    let first = atlas_agent_delta::project::snapshot_messages(&lock(&harness.thread), None);
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let second = atlas_agent_delta::project::snapshot_messages(&lock(&harness.thread), None);

    assert_eq!(first.len(), 2, "the snapshot is the whole conversation");
    let firsts: Vec<_> = first.iter().map(|m| m.timestamp).collect();
    let seconds: Vec<_> = second.iter().map(|m| m.timestamp).collect();
    assert_eq!(
        firsts, seconds,
        "reading the same unchanged thread twice produced different times"
    );
}

/// The half of ATL-221 that the UI actually renders: the gap between two
/// messages. Minted at read time they all collapse to the same instant, so a
/// reopened conversation shows every pause as zero.
#[tokio::test(flavor = "multi_thread")]
async fn a_pause_between_two_messages_survives_into_the_snapshot() {
    let harness = Harness::start();

    lock(&harness.thread).push_user_content_block(
        None,
        acp::ContentBlock::Text(acp::TextContent::new("first".to_string())),
    );
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    // A second user chunk would merge into the same entry — consecutive
    // same-kind chunks are one message. The reply is what opens a new one.
    harness.update(text_chunk("second"));

    let messages = atlas_agent_delta::project::snapshot_messages(&lock(&harness.thread), None);
    let gap = messages[1].timestamp - messages[0].timestamp;
    assert!(
        gap.num_milliseconds() >= 10,
        "the pause between the two messages was flattened to {gap}"
    );
}

/// Regression, ATL-222. The empty-plan guard was written to suppress a FIRST
/// empty plan; it suppressed every clear as well, so an agent that abandoned
/// its plan never said so and the UI kept a card full of steps that no longer
/// existed.
#[tokio::test(flavor = "multi_thread")]
async fn clearing_a_plan_is_announced() {
    let harness = Harness::start();

    harness.update(serde_json::json!({
        "sessionUpdate": "plan",
        "entries": [{ "content": "step one", "priority": "high", "status": "pending" }],
    }));
    harness.expect(1);
    let before = harness.recorder.len();

    harness.update(serde_json::json!({ "sessionUpdate": "plan", "entries": [] }));

    let new = since(&harness, before);
    match new.first() {
        Some(SessionDelta::PlanUpdated { plan }) => assert!(
            plan.is_empty(),
            "the clear has to carry an empty plan, got {plan:?}"
        ),
        other => panic!("clearing a plan said nothing on the wire: {other:?}"),
    }
}

/// The behaviour the original guard was protecting, kept. An agent that has
/// never announced a plan and reports an empty one is describing the status
/// quo, and a `plan_updated` for it would make the UI redraw nothing.
#[tokio::test(flavor = "multi_thread")]
async fn a_first_empty_plan_still_says_nothing() {
    let harness = Harness::start();

    harness.update(serde_json::json!({ "sessionUpdate": "plan", "entries": [] }));
    harness.pump();

    assert!(
        !harness.recorder.kinds().contains(&"plan_updated".to_string()),
        "an empty plan nobody had announced produced a delta: {:?}",
        harness.recorder.kinds()
    );
}

/// Regression, ATL-224. An assistant chunk carrying only an image flattens to
/// the empty string. The live stream announced a message for it anyway while
/// the snapshot skipped it, so the same conversation had a blank bubble before
/// a reload and no bubble after one.
#[tokio::test(flavor = "multi_thread")]
async fn an_image_only_assistant_turn_is_absent_from_both_the_stream_and_the_snapshot() {
    let harness = Harness::start();

    harness.update(serde_json::json!({
        "sessionUpdate": "agent_message_chunk",
        "content": { "type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo=" },
    }));
    harness.pump();

    assert!(
        !harness
            .recorder
            .kinds()
            .contains(&"message_appended".to_string()),
        "an image-only turn put a blank bubble on the wire: {:?}",
        harness.recorder.kinds()
    );
    let snapshot = atlas_agent_delta::project::snapshot_messages(&lock(&harness.thread), None);
    assert!(
        snapshot.is_empty(),
        "the snapshot and the stream disagree: {snapshot:?}"
    );
}

/// The other half of ATL-224: a run held back as empty is not lost. The moment
/// it has something to render it is announced as a whole message, because
/// nobody has one to append a chunk to.
#[tokio::test(flavor = "multi_thread")]
async fn a_run_held_back_as_empty_is_announced_once_it_has_text() {
    let harness = Harness::start();

    harness.update(serde_json::json!({
        "sessionUpdate": "agent_message_chunk",
        "content": { "type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo=" },
    }));
    harness.update(text_chunk("here is what it shows"));
    harness.expect(1);

    assert_eq!(harness.recorder.kinds(), ["message_appended"]);
    match &harness.recorder.deltas()[0] {
        SessionDelta::MessageAppended { message } => assert!(
            message.content.ends_with("here is what it shows"),
            "the text that made the run renderable is missing: {:?}",
            message.content
        ),
        other => panic!("expected a whole message, got {other:?}"),
    }
}

// ------------------------------------------------------ retention (ATL-225)

/// A permission prompt, opened on `call_id`. Returns the waiter so the caller
/// controls when — or whether — it is answered.
fn open_permission(harness: &Harness, call_id: &str) {
    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": call_id,
        "title": "Write a.txt",
        "kind": "edit",
        "status": "pending",
        "rawInput": { "path": "a.txt" },
    }));
    let _waiter = lock(&harness.thread)
        .request_tool_call_authorization(
            acp::ToolCallUpdate::new(
                acp::ToolCallId::new(call_id),
                acp::ToolCallUpdateFields::default(),
            ),
            PermissionOptions::Flat(vec![acp::PermissionOption::new(
                "allow_once",
                "Allow once",
                acp::PermissionOptionKind::AllowOnce,
            )]),
            AuthorizationKind::PermissionGrant,
        )
        .expect("the prompt opens");
    harness.pump();
}

/// Regression, ATL-225 finding 1. `permissions` and `elicitations` are keyed by
/// wire request id and had no removal anywhere in the file. The projector is a
/// process-lifetime Tauri singleton, so every prompt the app had ever shown
/// stayed routable — and retained — for as long as Atlas ran.
#[tokio::test(flavor = "multi_thread")]
async fn a_session_whose_stream_ends_leaves_no_routes_behind() {
    let recorder = Arc::new(Recorder::default());
    let projector = DeltaProjector::new(recorder.clone());
    let session_id = acp::SessionId::new("sess-closing");

    let events = (projector.thread_events())(&session_id);
    let thread = Arc::new(Mutex::new(AcpThread::new(
        session_id.clone(),
        Arc::new(StubConnection) as Arc<dyn AgentConnection>,
        vec![PathBuf::from("/tmp")],
        None,
        events,
    )));
    projector.attach(AgentId::new(), thread.clone());

    lock(&thread)
        .handle_session_update(
            serde_json::from_value(serde_json::json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "call-1",
                "title": "Write a.txt",
                "kind": "edit",
                "status": "pending",
            }))
            .unwrap(),
        )
        .unwrap();
    let waiter = lock(&thread)
        .request_tool_call_authorization(
            acp::ToolCallUpdate::new(
                acp::ToolCallId::new("call-1"),
                acp::ToolCallUpdateFields::default(),
            ),
            PermissionOptions::Flat(vec![acp::PermissionOption::new(
                "allow_once",
                "Allow once",
                acp::PermissionOptionKind::AllowOnce,
            )]),
            AuthorizationKind::PermissionGrant,
        )
        .expect("the prompt opens");

    await_until("the prompt was routed", || {
        projector.routing_table_sizes().0 == 1
    })
    .await;

    // Closing is told, not noticed: the projection holds the only strong handle
    // on the thread, and the thread holds the sender, so waiting for the stream
    // to end would wait forever.
    drop(waiter);
    projector.close_session(&session_id);
    assert_eq!(
        projector.routing_table_sizes(),
        (0, 0),
        "a closed session left its permission routes behind"
    );
    assert_eq!(
        Arc::strong_count(&thread),
        1,
        "the closed session's thread is still held, and with it its terminals"
    );
}

/// Regression, ATL-225 finding 2. A session's event stream is pre-registered
/// before its `session/load` RPC runs, so replayed history is not dropped. When
/// that RPC fails nothing takes the stream back out, and the key stayed for the
/// life of the process.
#[tokio::test(flavor = "multi_thread")]
async fn a_stream_for_a_session_that_never_opened_is_swept() {
    let recorder = Arc::new(Recorder::default());
    let projector = DeltaProjector::new(recorder);

    // A load that failed: the sink was handed out, the thread that would have
    // owned it was dropped with the error, and `register` was never called.
    let orphan = (projector.thread_events())(&acp::SessionId::new("sess-failed"));
    assert_eq!(projector.pending_len(), 1);
    drop(orphan);

    // The next session opened sweeps it, because that is the one moment the
    // projector learns anything about session lifetimes.
    let _live = (projector.thread_events())(&acp::SessionId::new("sess-next"));
    assert_eq!(
        projector.pending_len(),
        1,
        "the failed session's stream was retained alongside the live one"
    );
}

/// Regression, ATL-225 finding 4. A rewind removes entries from the thread, and
/// a tool call that goes away takes its permission prompt with it. Without
/// clearing the route the frontend keeps a modal open on a tool call that no
/// longer exists, answerable by nobody — the stranding shape of ATL-213, one
/// layer up.
#[tokio::test(flavor = "multi_thread")]
async fn a_rewind_resolves_the_permission_prompt_it_removes() {
    let harness = Harness::start();

    lock(&harness.thread).push_user_content_block(
        None,
        acp::ContentBlock::Text(acp::TextContent::new("go".to_string())),
    );
    open_permission(&harness, "call-rewound");
    let before = harness.recorder.len();

    lock(&harness.thread).remove_entries_from(0);
    harness.pump();

    let new = since(&harness, before);
    assert!(
        new.iter()
            .any(|delta| matches!(delta, SessionDelta::PermissionResolved { .. })),
        "the prompt was left open on a tool call that no longer exists: {new:?}"
    );
    assert!(
        new.iter()
            .any(|delta| matches!(delta, SessionDelta::HistoryRewound { .. })),
        "the rewind itself still has to reach the wire: {new:?}"
    );
}

/// Poll `check` until it holds, or fail. The projecting task runs on its own
/// task, so these tests wait on it rather than assuming a scheduling order.
async fn await_until(what: &str, check: impl Fn() -> bool) {
    for _ in 0..200 {
        if check() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    panic!("timed out waiting until {what}");
}

// ------------------------------------------------------------- cost (ATL-219)
//
// Ignored by default: these measure time, and a machine under load is not a
// regression. They are kept rather than deleted because the acceptance criteria
// for ATL-219 and ATL-223 are about how cost SCALES, and a benchmark that no
// longer exists cannot be re-run against a later change.
//
//     cargo test -p atlas-agent-delta --release -- --ignored --nocapture

/// Drive `chunks` output chunks of `chunk_len` bytes through a display-only
/// terminal's tool call, and return how long the projection took.
async fn time_terminal_projection(chunks: usize, chunk_len: usize) -> std::time::Duration {
    let harness = Harness::start();
    display_only_terminal(&harness, "bench");
    push_output(&harness, "bench", b"x");
    harness.update(terminal_tool_call("call-bench", "bench"));
    harness.pump();

    let payload = vec![b'y'; chunk_len];
    let start = std::time::Instant::now();
    for _ in 0..chunks {
        push_output(&harness, "bench", &payload);
    }
    start.elapsed()
}

/// ATL-219. Every chunk used to rebuild and re-compare the whole accumulated
/// output, so five times the chunks cost about twenty times the time. The fix
/// makes each chunk cost its own length, so total time grows with the number of
/// chunks and not with their sum.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "timing, not correctness"]
async fn a_growing_terminal_costs_the_tail() {
    let small = time_terminal_projection(1_000, 200).await;
    let large = time_terminal_projection(5_000, 200).await;
    let ratio = large.as_secs_f64() / small.as_secs_f64();
    println!(
        "terminal: 1000 chunks {small:?}, 5000 chunks {large:?}, ratio {ratio:.2} (linear is 5)"
    );
    assert!(
        ratio < 10.0,
        "five times the output cost {ratio:.1}x the time; the projection is still superlinear"
    );
}

/// ATL-223, the same shape one file over: streamed assistant text used to be
/// rebuilt, compared and cloned in full on every token.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "timing, not correctness"]
async fn streamed_text_costs_the_tail() {
    async fn run(chunks: usize) -> std::time::Duration {
        let harness = Harness::start();
        harness.update(text_chunk("start"));
        let piece = "z".repeat(200);
        let start = std::time::Instant::now();
        for _ in 0..chunks {
            harness.update(text_chunk(&piece));
        }
        start.elapsed()
    }
    let small = run(1_000).await;
    let large = run(5_000).await;
    let ratio = large.as_secs_f64() / small.as_secs_f64();
    println!("text: 1000 chunks {small:?}, 5000 chunks {large:?}, ratio {ratio:.2} (linear is 5)");
    assert!(
        ratio < 10.0,
        "five times the text cost {ratio:.1}x the time; streaming is still superlinear"
    );
}

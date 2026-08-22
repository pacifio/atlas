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
    thread.lock().unwrap_or_else(|p| p.into_inner())
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

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
use atlas_agent_delta::{
    AgentId, DeltaProjector, DeltaSink, Origin, QueuedPrompt, SessionDelta, SessionDeltaEnvelope,
};
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
    thread
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
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
async fn an_unstamped_user_message_never_reaches_the_wire() {
    // Only a prompt the host stamped is announced (`stamp_user_message`). A
    // user entry nobody stamped — history an agent replays on `session/load` —
    // stays silent, as every user entry used to: the snapshot carries it, and
    // announcing a replay would paint the conversation twice.
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
            started_at_ms,
            ended_at_ms,
            worked_ms,
        } => {
            // The token the frontend matches on, serialized rather than
            // hand-formatted (ATL-6 shipped "endturn").
            assert_eq!(stop_reason, "end_turn");
            assert_eq!(*turn_seq, 7);
            // The turn's wall time travels with its terminal, so the client
            // never has to time it itself.
            let (started, ended) = (started_at_ms.unwrap(), ended_at_ms.unwrap());
            assert!(started <= ended, "{started} > {ended}");
            assert!(worked_ms.is_some(), "timed on the monotonic clock");
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

    // The native agent reports a real input/output split, cache halves and
    // reasoning included — none of it is flattened to zero on the way out.
    lock(&harness.thread).update_token_usage(Some(atlas_acp_thread::TokenUsage {
        input_tokens: 11,
        output_tokens: 7,
        cache_read_tokens: 5,
        cache_write_tokens: 3,
        reasoning_tokens: 2,
        ..Default::default()
    }));
    harness.expect(2);
    match &harness.recorder.deltas()[1] {
        SessionDelta::UsageUpdated { usage } => {
            assert_eq!(usage.input_tokens, 11);
            assert_eq!(usage.output_tokens, 7);
            assert_eq!(usage.cache_read_tokens, 5);
            assert_eq!(usage.cache_creation_tokens, 3);
            assert_eq!(usage.reasoning_tokens, 2);
        }
        other => panic!("expected a usage split, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn rate_limits_are_announced_once_per_change() {
    // The engine repeats the account snapshot every turn; the wire hears it
    // when it changes.
    let harness = Harness::start();
    let limits = atlas_acp_thread::RateLimits {
        primary: Some(atlas_acp_thread::RateLimitWindow {
            used_percent: 40,
            window_minutes: Some(300),
            resets_at: Some(1_800_000_000),
        }),
        secondary: None,
        plan_type: Some("plus".into()),
    };
    lock(&harness.thread).update_rate_limits(Some(limits.clone()));
    harness.expect(1);
    match &harness.recorder.deltas()[0] {
        SessionDelta::RateLimits {
            primary, plan_type, ..
        } => {
            assert_eq!(primary.as_ref().map(|w| w.used_percent), Some(40));
            assert_eq!(plan_type.as_deref(), Some("plus"));
        }
        other => panic!("expected rate limits, got {other:?}"),
    }

    lock(&harness.thread).update_rate_limits(Some(limits.clone()));
    assert_eq!(
        harness.recorder.kinds().len(),
        1,
        "an unchanged snapshot is silence"
    );

    let mut moved = limits;
    moved.primary.as_mut().expect("primary").used_percent = 55;
    lock(&harness.thread).update_rate_limits(Some(moved));
    harness.expect(2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cache_only_turn_still_counts_as_a_split() {
    // A cached-prompt turn can have zero fresh input and zero output — the
    // cache reads are the whole spend. It must not be mistaken for "no
    // split reported".
    let harness = Harness::start();
    lock(&harness.thread).update_token_usage(Some(atlas_acp_thread::TokenUsage {
        cache_read_tokens: 900,
        ..Default::default()
    }));
    harness.expect(1);
    assert_eq!(harness.recorder.kinds(), ["usage_updated"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_host_announces_what_the_thread_cannot() {
    let harness = Harness::start();

    harness.projector.note_turn_failed(
        &harness.session_id,
        "the model refused",
        Some("auth".into()),
    );
    harness.projector.note_model_changed(
        &harness.session_id,
        "anthropic/claude",
        Some(Origin::Remote {
            id: "user-7".into(),
            name: Some("Ada".into()),
        }),
    );
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
    match &harness.recorder.deltas()[1] {
        SessionDelta::ModelChanged { model_id, origin } => {
            assert_eq!(model_id, "anthropic/claude");
            assert_eq!(
                origin,
                &Some(Origin::Remote {
                    id: "user-7".into(),
                    name: Some("Ada".into()),
                }),
                "the announcement names who picked it"
            );
        }
        other => panic!("expected a model change, got {other:?}"),
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

/// A replayed user message with an image (claude-agent-acp replays one as an
/// image chunk followed by the prose) snapshots as its prose plus the image.
/// It used to come out as the text `` `Image` `` + prose, the image dropped —
/// so a reopened conversation showed a code span where the picture had been.
#[test]
fn a_snapshot_keeps_the_images_a_user_message_carried() {
    let harness = Harness::start();
    for content in [
        serde_json::json!({ "type": "image", "mimeType": "image/png", "data": "iVBORw0K" }),
        serde_json::json!({ "type": "text", "text": "can you see this issue?" }),
    ] {
        harness.update(serde_json::json!({
            "sessionUpdate": "user_message_chunk",
            "messageId": "u1",
            "content": content,
        }));
    }

    let messages = atlas_agent_delta::project::snapshot_messages(&lock(&harness.thread), None);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].content, "can you see this issue?");
    assert_eq!(
        messages[0].images,
        [atlas_agent_wire::MessageImage {
            mime_type: "image/png".into(),
            data: "iVBORw0K".into(),
        }]
    );
}

/// No images, no key: every message that never had one serializes exactly as
/// it did before the field existed.
#[test]
fn a_snapshot_message_without_images_omits_the_key() {
    let harness = Harness::start();
    lock(&harness.thread).push_user_content_block(
        None,
        acp::ContentBlock::Text(acp::TextContent::new("plain".to_string())),
    );
    let messages = atlas_agent_delta::project::snapshot_messages(&lock(&harness.thread), None);
    let json = serde_json::to_value(&messages[0]).unwrap();
    assert!(json.get("images").is_none(), "got: {json}");
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
    let messages = atlas_agent_delta::project::snapshot_messages(&thread, Some("claude-opus-5"));
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

/// ACP carries no per-message time, so what an agent's `session/load` replays
/// is stamped when Atlas heard it. The wire says so, live and in snapshots,
/// until the user speaks again; from there messages are timed for real.
#[tokio::test(flavor = "multi_thread")]
async fn a_replayed_message_says_its_time_is_approximate() {
    let harness = Harness::start();

    lock(&harness.thread).begin_replay();
    harness.update(serde_json::json!({
        "sessionUpdate": "user_message_chunk",
        "content": { "type": "text", "text": "fix the bug" },
    }));
    harness.update(text_chunk("found it"));
    harness.expect(1);
    match &harness.recorder.deltas()[0] {
        SessionDelta::MessageAppended { message } => assert!(message.timestamp_approximate),
        other => panic!("expected a message, got {other:?}"),
    }

    lock(&harness.thread).push_user_content_block(
        None,
        acp::ContentBlock::Text(acp::TextContent::new("and the test".to_string())),
    );
    harness.update(text_chunk("added"));
    harness.expect(2);
    match &harness.recorder.deltas()[1] {
        SessionDelta::MessageAppended { message } => assert!(!message.timestamp_approximate),
        other => panic!("expected a message, got {other:?}"),
    }

    let messages = atlas_agent_delta::project::snapshot_messages(&lock(&harness.thread), None);
    let approximate: Vec<bool> = messages.iter().map(|m| m.timestamp_approximate).collect();
    assert_eq!(approximate, [true, true, false, false]);
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
            &args
                .iter()
                .map(std::string::ToString::to_string)
                .collect::<Vec<_>>(),
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
    // thread changes. Atlas's terminals reach
    // the UI only through the tool call's projection, so without an explicit
    // link the output pane shows whatever happened to be buffered when some
    // unrelated event last re-projected the entry.
    let harness = Harness::start();

    // The terminal must exist before the agent can reference it: the id comes
    // from `terminal/create`, and the thread rejects a block naming an unknown
    // one.
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
    assert!(
        request_at < resolved_at,
        "announced before resolved: {kinds:?}"
    );
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
        .note_config_options(&harness.session_id, &options, None);
    harness.expect(1);

    match &harness.recorder.deltas()[0] {
        SessionDelta::ConfigOptionsUpdated { config_options, .. } => {
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

/// Past the byte limit the buffer drops its front — and the tail must keep
/// streaming. Offsets are in the command's total output, so a window that has
/// moved on still serves "what came after what you last saw"; before this, a
/// terminal that truncated once re-announced its whole megabyte window on every
/// later chunk — the ATL-219 cost, back, for exactly the long builds that
/// motivated the cheap path. The user's pane keeps the complete output.
#[tokio::test(flavor = "multi_thread")]
async fn a_truncating_terminal_keeps_streaming_its_tail() {
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
    push_output(&harness, "term-trunc", b"EF");

    let new = since(&harness, before);
    let tails: Vec<String> = new
        .iter()
        .map(|d| match d {
            SessionDelta::ToolCallOutputChunk { delta, .. } => delta.clone(),
            other => panic!("a truncated buffer must still stream its tail, got {other:?}"),
        })
        .collect();
    assert_eq!(tails, ["ABCD", "EF"], "each chunk is exactly the new bytes");
}

/// The honesty the old fallback existed for is kept where it matters: a
/// projection that has to be REBUILT (here, the first look at a terminal that
/// already dropped its front) says so, and shows the window it has.
#[tokio::test(flavor = "multi_thread")]
async fn a_rebuilt_result_admits_what_the_buffer_dropped() {
    let harness = Harness::start();

    lock(&harness.thread).on_terminal_provider_event(
        atlas_acp_thread::TerminalProviderEvent::Created {
            terminal_id: acp::TerminalId::new("term-late"),
            label: "agent-run".into(),
            cwd: None,
            output_byte_limit: Some(8),
            terminal: None,
        },
    );
    push_output(&harness, "term-late", b"12345678ABCD");
    harness.update(terminal_tool_call("call-late", "term-late"));
    harness.expect(1);

    let result = match harness.recorder.deltas().last() {
        Some(SessionDelta::ToolCallUpserted { tool_call, .. }) => tool_call
            .result
            .clone()
            .expect("the tool call carries its output"),
        other => panic!("expected the first snapshot, got {other:?}"),
    };
    assert!(
        result.starts_with("[earlier output dropped]"),
        "a rebuilt result has to admit the buffer dropped its front: {result:?}"
    );
    assert!(
        result.ends_with("5678ABCD"),
        "the retained window is the most recent bytes: {result:?}"
    );

    // And from there the tail streams, in the same coordinates.
    let before = harness.recorder.len();
    push_output(&harness, "term-late", b"EF");
    match since(&harness, before).as_slice() {
        [SessionDelta::ToolCallOutputChunk { delta, .. }] => assert_eq!(delta, "EF"),
        other => panic!("the tail after a rebuilt result still streams, got {other:?}"),
    }
}

/// A status change on a command past the byte limit must not swap the output
/// the user has been reading for the window plus a marker.
#[tokio::test(flavor = "multi_thread")]
async fn a_status_change_past_the_limit_keeps_the_streamed_output() {
    let harness = Harness::start();

    lock(&harness.thread).on_terminal_provider_event(
        atlas_acp_thread::TerminalProviderEvent::Created {
            terminal_id: acp::TerminalId::new("term-done"),
            label: "agent-run".into(),
            cwd: None,
            output_byte_limit: Some(8),
            terminal: None,
        },
    );
    push_output(&harness, "term-done", b"12345678");
    harness.update(terminal_tool_call("call-done", "term-done"));
    harness.expect(1);
    push_output(&harness, "term-done", b"ABCD");
    let before = harness.recorder.len();

    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call_update",
        "toolCallId": "call-done",
        "status": "completed",
    }));
    harness.pump();

    let result = match since(&harness, before).last() {
        Some(SessionDelta::ToolCallUpserted { tool_call, .. }) => tool_call.result.clone(),
        other => panic!("a status change re-announces the call, got {other:?}"),
    };
    assert_eq!(result.as_deref(), Some("12345678ABCD"));
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
        !harness
            .recorder
            .kinds()
            .contains(&"plan_updated".to_string()),
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

/// The same bound past the default byte limit. 16 000 chunks of 200 bytes is
/// 3.2 MB against a 1 MiB window, so two thirds of the chunks arrive after the
/// buffer has started dropping its front — where every chunk used to rebuild
/// and re-ship the whole window.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "timing, not correctness"]
async fn a_terminal_past_its_byte_limit_still_costs_the_tail() {
    let under = time_terminal_projection(4_000, 200).await;
    let over = time_terminal_projection(16_000, 200).await;
    let ratio = over.as_secs_f64() / under.as_secs_f64();
    println!(
        "terminal past limit: 4000 chunks {under:?}, 16000 chunks {over:?}, ratio {ratio:.2} (linear is 4)"
    );
    assert!(
        ratio < 8.0,
        "four times the output, across the byte limit, cost {ratio:.1}x the time"
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

// ----------------------------------------------------------------- subagents
//
// ACP has no subagent concept: every one of these is an ordinary tool call
// plus `rawInput` and `_meta`, which is what `atlas_acp_thread::subagent`
// reads. The unit tests there cover each agent's vocabulary; these drive the
// whole path — thread, projection, wire — in one agent's words each, so that
// what the detector recognises actually reaches a client.

fn subagents(harness: &Harness) -> Vec<atlas_agent_delta::Subagent> {
    harness
        .recorder
        .deltas()
        .into_iter()
        .filter_map(|delta| match delta {
            SessionDelta::SubagentUpserted { subagent } => Some(subagent),
            _ => None,
        })
        .collect()
}

/// A launch named by its tool, with its children attributed by a vendor
/// `_meta` parent key — the shape Claude Code and Devin both use.
#[tokio::test(flavor = "multi_thread")]
async fn a_named_launch_becomes_a_subagent_and_its_work_nests_under_it() {
    let harness = Harness::start();

    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "toolu_parent",
        "title": "Review the auth module",
        "kind": "think",
        "status": "in_progress",
        "rawInput": {
            "description": "Review the auth module",
            "prompt": "Read src/auth and report back.",
            "subagent_type": "code-reviewer",
        },
        "_meta": { "claudeCode": { "toolName": "Task" } },
    }));
    harness.pump();

    let launched = subagents(&harness);
    let child = launched.last().expect("a subagent was announced");
    assert_eq!(child.tool_call_id, "toolu_parent");
    assert_eq!(child.name, "Review the auth module");
    assert_eq!(child.role.as_deref(), Some("code-reviewer"));
    assert_eq!(
        child.prompt.as_deref(),
        Some("Read src/auth and report back.")
    );
    assert_eq!(child.status, atlas_agent_delta::SubagentStatus::Running);
    assert_eq!(child.tool_call_count, 0, "it has not done anything yet");

    // The child reads a file. Same session, same stream as the parent's own
    // work — only the meta tells them apart.
    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "toolu_child",
        "title": "Read src/auth.rs",
        "kind": "read",
        "status": "in_progress",
        "_meta": { "claudeCode": { "parentToolUseId": "toolu_parent" } },
    }));
    harness.pump();

    let nested = harness
        .recorder
        .deltas()
        .into_iter()
        .find_map(|delta| match delta {
            SessionDelta::ToolCallUpserted { tool_call, .. } if tool_call.id == "toolu_child" => {
                Some(tool_call)
            }
            _ => None,
        })
        .expect("the child's call reached the wire");
    assert_eq!(
        nested.parent_tool_call_id.as_deref(),
        Some("toolu_parent"),
        "a child's call names the launch it belongs to"
    );
    assert_eq!(
        subagents(&harness)
            .last()
            .expect("an update")
            .tool_call_count,
        1,
        "the launch counts its child's work"
    );

    // It finishes.
    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call_update",
        "toolCallId": "toolu_parent",
        "status": "completed",
        "content": [{ "type": "content", "content": { "type": "text", "text": "No issues found." } }],
    }));
    harness.pump();

    let done = subagents(&harness).pop().expect("a terminal update");
    assert_eq!(done.status, atlas_agent_delta::SubagentStatus::Completed);
    assert_eq!(done.result.as_deref(), Some("No issues found."));
    assert!(done.ended_at_ms.is_some(), "a finished child is stamped");
}

/// A launch that is itself the whole child (Claude's synchronous `Agent`)
/// ends when that call does — not when it was created, which is all the
/// thread remembers of it. Live, every such child read "done 0s".
#[tokio::test(flavor = "multi_thread")]
async fn a_child_that_finishes_later_states_how_long_it_ran() {
    let harness = Harness::start();

    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "toolu_counter",
        "title": "counter",
        "kind": "think",
        "status": "in_progress",
        "rawInput": { "description": "counter", "prompt": "Count the files." },
        "_meta": { "claudeCode": { "toolName": "Agent" } },
    }));
    harness.pump();
    let started = subagents(&harness).last().expect("announced").started_at_ms;

    std::thread::sleep(std::time::Duration::from_millis(1100));
    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call_update",
        "toolCallId": "toolu_counter",
        "status": "completed",
        "content": [{ "type": "content", "content": { "type": "text", "text": "92" } }],
    }));
    harness.pump();

    let done = subagents(&harness).pop().expect("a terminal update");
    let ended = done.ended_at_ms.expect("a finished child is stamped");
    assert!(
        ended - started >= 1000,
        "it ran for over a second, not {}ms",
        ended - started
    );

    // A later, unrelated change re-derives every child; the end it was given
    // must survive that rather than fall back to its launch time.
    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "toolu_other",
        "title": "Read README.md",
        "kind": "read",
        "status": "completed",
    }));
    harness.pump();
    let all = subagents(&harness);
    let latest = all
        .iter()
        .rev()
        .find(|s| s.tool_call_id == "toolu_counter")
        .expect("still announced");
    assert_eq!(latest.ended_at_ms, Some(ended));
}

/// A reopened session: the launch and its result are replayed back to back,
/// so the thread's clock says the child took no time. The child's own report
/// is the duration, and its count of the work this session never saw.
#[tokio::test(flavor = "multi_thread")]
async fn a_replayed_child_keeps_the_time_and_work_it_reported() {
    let harness = Harness::start();

    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "toolu_counter",
        "title": "counter",
        "kind": "think",
        "status": "pending",
        "rawInput": { "description": "counter", "subagent_type": "Explore", "prompt": "Count." },
        "_meta": { "claudeCode": { "toolName": "Agent" } },
    }));
    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call_update",
        "toolCallId": "toolu_counter",
        "status": "completed",
        "rawOutput": [{
            "type": "text",
            "text": "There are 92 files.\nagentId: a1\n<usage>subagent_tokens: 27872\ntool_uses: 2\nduration_ms: 17145</usage>",
        }],
        "_meta": { "claudeCode": { "toolName": "Agent" } },
    }));
    harness.pump();

    let done = subagents(&harness).pop().expect("announced");
    assert_eq!(done.status, atlas_agent_delta::SubagentStatus::Completed);
    assert_eq!(
        done.ended_at_ms.expect("stamped") - done.started_at_ms,
        17145,
        "the child's own clock, not the replay's"
    );
    assert_eq!(done.tool_call_count, 2, "work the replay never showed");
}

/// An agent that models children as a tree reports each thing it does to one
/// as its own call. The child's identity is its path, so several calls
/// collapse into one row.
#[tokio::test(flavor = "multi_thread")]
async fn lifecycle_calls_for_one_child_collapse_into_one_subagent() {
    let harness = Harness::start();

    let step = |id: &str, title: &str, kind: &str, status: &str| {
        serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": id,
            "title": title,
            "kind": "other",
            "status": status,
            "rawInput": {
                "agentPath": "/root/ui_test_one",
                "agentThreadId": "thr_1",
                "activityKind": kind,
            },
        })
    };

    harness.update(step(
        "c1",
        "Start subagent Ui test one",
        "started",
        "completed",
    ));
    harness.pump();
    let after_start = subagents(&harness);
    let child = after_start.last().expect("a subagent");
    assert_eq!(child.name, "Ui test one", "named from its agent path");
    assert_eq!(child.tool_call_id, "c1");

    harness.update(step(
        "c2",
        "Complete subagent Ui test one",
        "completed",
        "completed",
    ));
    harness.pump();

    let all = subagents(&harness);
    let ids: std::collections::BTreeSet<_> = all.iter().map(|s| s.tool_call_id.clone()).collect();
    assert_eq!(
        ids,
        ["c1".to_owned()].into_iter().collect(),
        "both steps are the same child, keyed on its agent path"
    );
}

/// An agent that names its delegation tool something Atlas has never seen,
/// but whose input says what it is — the Copilot shape, and the reason the
/// detector reads evidence rather than a table of tool names.
#[tokio::test(flavor = "multi_thread")]
async fn a_launch_is_recognised_from_its_input_alone() {
    let harness = Harness::start();

    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "call-x",
        "title": "Delegating work",
        "kind": "other",
        "status": "in_progress",
        "rawInput": {
            "agent_type": "coding-agent",
            "description": "Fix the flaky test",
            "prompt": "Find and fix the flake in auth_test.rs.",
        },
    }));
    harness.pump();

    let child = subagents(&harness).pop().expect("a subagent");
    assert_eq!(child.name, "Fix the flaky test");
    assert_eq!(child.role.as_deref(), Some("coding-agent"));
}

/// The guard that matters most: a phantom subagent row never completes, so an
/// ordinary tool call must never become one.
#[tokio::test(flavor = "multi_thread")]
async fn ordinary_tool_calls_announce_no_subagent() {
    let harness = Harness::start();

    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "call-1",
        "title": "Run the tests",
        "kind": "execute",
        "status": "in_progress",
        // A description and a prompt, but not a Task tool.
        "rawInput": { "description": "Run the tests", "prompt": "cargo test" },
    }));
    harness.pump();

    assert!(
        subagents(&harness).is_empty(),
        "shape alone must not read as a subagent"
    );
}

fn tool_call_of(delta: &SessionDelta) -> &atlas_agent_delta::ToolCall {
    match delta {
        SessionDelta::ToolCallUpserted { tool_call, .. } => tool_call,
        other => panic!("expected a tool call, got {other:?}"),
    }
}

/// A call's start is stamped the first time it is seen, its end the first time
/// it settles, and neither moves after that — which is what lets a reloaded
/// session show the same duration the live one did.
#[tokio::test(flavor = "multi_thread")]
async fn a_tool_call_is_timed_from_first_sight_to_first_settling() {
    let harness = Harness::start();

    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "call-1",
        "title": "Bash",
        "kind": "execute",
        "status": "in_progress",
        "rawInput": { "command": "ls" },
    }));
    harness.expect(1);
    let first = tool_call_of(&harness.recorder.deltas()[0]).clone();
    let started = first.started_at_ms.expect("stamped at first sight");
    assert_eq!(first.ended_at_ms, None, "still running");

    std::thread::sleep(std::time::Duration::from_millis(5));
    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call_update",
        "toolCallId": "call-1",
        "status": "completed",
    }));
    harness.expect(2);
    let settled = tool_call_of(&harness.recorder.deltas()[1]).clone();
    assert_eq!(
        settled.started_at_ms,
        Some(started),
        "the start never moves"
    );
    let ended = settled.ended_at_ms.expect("stamped when it completed");
    assert!(ended >= started + 5, "{ended} vs {started}");

    // A later update to a finished call (a retitle) re-stamps nothing.
    std::thread::sleep(std::time::Duration::from_millis(5));
    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call_update",
        "toolCallId": "call-1",
        "title": "Bash (done)",
    }));
    harness.expect(3);
    let later = tool_call_of(&harness.recorder.deltas()[2]).clone();
    assert_eq!(later.started_at_ms, Some(started));
    assert_eq!(later.ended_at_ms, Some(ended));

    // And the snapshot a reloaded client hydrates from says the same.
    let messages = atlas_agent_delta::project::snapshot_messages(&lock(&harness.thread), None);
    let call = &messages[0].tool_calls[0];
    assert_eq!(call.started_at_ms, Some(started));
    assert_eq!(call.ended_at_ms, Some(ended));
}

/// A call that fails, or is cancelled with its turn, has ended too.
#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_tool_call_is_stamped_as_ended() {
    let harness = Harness::start();
    lock(&harness.thread).begin_turn();
    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "call-1",
        "title": "Bash",
        "kind": "execute",
        "status": "in_progress",
    }));
    lock(&harness.thread).cancel();
    harness.pump();

    let last = harness
        .recorder
        .deltas()
        .into_iter()
        .rev()
        .find(|delta| matches!(delta, SessionDelta::ToolCallUpserted { .. }))
        .expect("the cancel was announced");
    let call = tool_call_of(&last);
    assert_eq!(call.status, atlas_agent_delta::ToolCallStatus::Failed);
    assert!(call.ended_at_ms.is_some());
}

/// The snapshot puts each turn's wall time and stop reason on the message
/// that ends it, so "Worked for" / "Stopped after" survives a reload.
#[test]
fn a_snapshot_carries_each_turns_timing_on_its_last_message() {
    let harness = Harness::start();
    let prompt = |text: &str| {
        lock(&harness.thread).push_user_content_block(
            None,
            acp::ContentBlock::Text(acp::TextContent::new(text.to_string())),
        );
    };

    prompt("first");
    lock(&harness.thread).begin_turn();
    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "call-1",
        "title": "Read a.rs",
        "kind": "read",
        "status": "completed",
    }));
    harness.update(serde_json::json!({
        "sessionUpdate": "agent_message_chunk",
        "content": { "type": "text", "text": "done" },
    }));
    std::thread::sleep(std::time::Duration::from_millis(5));
    lock(&harness.thread).end_turn(acp::StopReason::EndTurn);

    // A turn the user stopped before the agent said anything has no message
    // of its own, and must not lend its time to the previous turn's reply.
    prompt("second");
    lock(&harness.thread).begin_turn();
    lock(&harness.thread).end_turn(acp::StopReason::Cancelled);

    prompt("third");
    lock(&harness.thread).begin_turn();
    harness.update(serde_json::json!({
        "sessionUpdate": "agent_message_chunk",
        "content": { "type": "text", "text": "partial" },
    }));
    lock(&harness.thread).end_turn(acp::StopReason::Cancelled);
    harness.pump();

    let messages = atlas_agent_delta::project::snapshot_messages(&lock(&harness.thread), None);
    let timing: Vec<(&str, Option<u64>, Option<&str>)> = messages
        .iter()
        .map(|m| {
            (
                if m.content.is_empty() {
                    "tool"
                } else {
                    m.content.as_str()
                },
                m.worked_ms,
                m.stop_reason.as_deref(),
            )
        })
        .collect();
    // Two prompts with nothing between them are one user entry in the thread.
    assert_eq!(timing.len(), 5, "{timing:?}");
    assert_eq!(timing[0], ("first", None, None));
    assert_eq!(
        timing[1],
        ("tool", None, None),
        "only the turn's last message"
    );
    assert_eq!(timing[2].0, "done");
    assert!(timing[2].1.unwrap() >= 5, "{timing:?}");
    assert_eq!(
        timing[2].2,
        Some("end_turn"),
        "the empty turn lent it nothing"
    );
    assert_eq!(timing[3], ("secondthird", None, None));
    assert_eq!(timing[4].0, "partial");
    assert!(timing[4].1.is_some());
    assert_eq!(timing[4].2, Some("cancelled"));

    // Absent rather than null on the wire, like every other optional field.
    let json = serde_json::to_value(&messages[0]).unwrap();
    assert!(json.get("worked_ms").is_none(), "got: {json}");
    assert!(json.get("stop_reason").is_none(), "got: {json}");
}

fn chunk(harness: &Harness, text: &str) {
    harness.update(serde_json::json!({
        "sessionUpdate": "agent_message_chunk",
        "content": { "type": "text", "text": text },
    }));
}

/// A rewind inside a turn (`/undo`) must not leave the open turn counting
/// from past the end of the thread: what the turn says after the rewind is
/// its own, and is the message its timing belongs on.
#[test]
fn a_turn_rewound_into_still_times_what_it_says_next() {
    let harness = Harness::start();
    let prompt = |text: &str| {
        lock(&harness.thread).push_user_content_block(
            None,
            acp::ContentBlock::Text(acp::TextContent::new(text.to_string())),
        );
    };

    prompt("first");
    lock(&harness.thread).begin_turn();
    chunk(&harness, "first reply");
    lock(&harness.thread).end_turn(acp::StopReason::EndTurn);

    prompt("/undo");
    lock(&harness.thread).begin_turn();
    // The rewind takes the first exchange and the prompt back …
    lock(&harness.thread).remove_entries_from(0);
    // … and the turn then answers.
    chunk(&harness, "undone");
    lock(&harness.thread).end_turn(acp::StopReason::EndTurn);
    harness.pump();

    let messages = atlas_agent_delta::project::snapshot_messages(&lock(&harness.thread), None);
    assert_eq!(messages.len(), 1, "{messages:?}");
    assert_eq!(messages[0].content, "undone");
    assert!(
        messages[0].worked_ms.is_some(),
        "the reply after the rewind is timed"
    );
    assert_eq!(messages[0].stop_reason.as_deref(), Some("end_turn"));
}

/// A stop that arrives after its turn already closed — a cancel answered
/// behind the stop it raced — is swallowed, so it cannot relabel the finished
/// turn as stopped.
#[tokio::test(flavor = "multi_thread")]
async fn a_late_duplicate_stop_does_not_relabel_a_finished_turn() {
    let harness = Harness::start();
    lock(&harness.thread).push_user_content_block(
        None,
        acp::ContentBlock::Text(acp::TextContent::new("go".to_string())),
    );
    lock(&harness.thread).begin_turn();
    chunk(&harness, "done");
    lock(&harness.thread).end_turn(acp::StopReason::EndTurn);
    lock(&harness.thread).end_turn(acp::StopReason::Cancelled);
    harness.pump();

    let finished: Vec<String> = harness
        .recorder
        .deltas()
        .into_iter()
        .filter_map(|delta| match delta {
            SessionDelta::TurnFinished { stop_reason, .. } => Some(stop_reason),
            _ => None,
        })
        .collect();
    assert_eq!(finished, ["end_turn"], "one terminal, the real one");
    let messages = atlas_agent_delta::project::snapshot_messages(&lock(&harness.thread), None);
    assert_eq!(
        messages.last().unwrap().stop_reason.as_deref(),
        Some("end_turn")
    );
}

/// The terminal carries the turn it closed, not whatever the thread's newest
/// record is when the projector gets to it: here a whole second turn runs
/// before the first stop is drained.
#[tokio::test(flavor = "multi_thread")]
async fn a_terminal_drained_late_announces_its_own_turn() {
    let harness = Harness::start();
    lock(&harness.thread).begin_turn();
    std::thread::sleep(std::time::Duration::from_millis(30));
    lock(&harness.thread).end_turn(acp::StopReason::EndTurn);
    lock(&harness.thread).begin_turn();
    lock(&harness.thread).end_turn(acp::StopReason::Cancelled);
    harness.pump();

    let finished: Vec<(String, u64)> = harness
        .recorder
        .deltas()
        .into_iter()
        .filter_map(|delta| match delta {
            SessionDelta::TurnFinished {
                stop_reason,
                worked_ms,
                ..
            } => Some((stop_reason, worked_ms.unwrap())),
            _ => None,
        })
        .collect();
    assert_eq!(finished.len(), 2);
    assert_eq!(finished[0].0, "end_turn");
    assert!(finished[0].1 >= 30, "{finished:?}");
    assert_eq!(finished[1].0, "cancelled");
    assert!(finished[1].1 < 30, "{finished:?}");
}

// ------------------------------------------------------- Universal RC groundwork

fn user_text(text: &str) -> acp::ContentBlock {
    acp::ContentBlock::Text(acp::TextContent::new(text.to_string()))
}

fn seqs(harness: &Harness) -> Vec<u64> {
    harness
        .recorder
        .envelopes
        .lock()
        .unwrap()
        .iter()
        .map(|envelope| envelope.seq)
        .collect()
}

/// A prompt the host sent is the user half of the exchange on the wire, with
/// who sent it and the id the sender minted — what lets a remote viewer see
/// the question, and the window adopt its own optimistic row.
#[tokio::test(flavor = "multi_thread")]
async fn a_stamped_prompt_is_announced_with_its_sender() {
    let harness = Harness::start();

    harness.projector.stamp_user_message(
        &harness.session_id,
        Origin::Remote {
            id: "guest:ab12".into(),
            name: Some("Sam".into()),
        },
        Some("cm-1".into()),
    );
    {
        // Pushed under one lock, as `AgentManager::send` does.
        let mut thread = lock(&harness.thread);
        thread.push_user_content_block(None, user_text("fix the "));
        thread.push_user_content_block(None, user_text("build"));
    }
    harness.update(text_chunk("on it"));
    harness.expect(2);

    assert_eq!(
        harness.recorder.kinds(),
        ["user_message", "message_appended"],
        "the whole prompt is one announcement, before the answer"
    );
    match &harness.recorder.deltas()[0] {
        SessionDelta::UserMessage {
            message,
            origin,
            client_message_id,
        } => {
            assert_eq!(message.role, atlas_agent_delta::MessageRole::User);
            assert_eq!(message.content, "fix the build");
            assert_eq!(client_message_id.as_deref(), Some("cm-1"));
            assert_eq!(
                origin,
                &Origin::Remote {
                    id: "guest:ab12".into(),
                    name: Some("Sam".into())
                }
            );
        }
        other => panic!("expected the user's message, got {other:?}"),
    }
}

/// A second prompt sent before the agent said anything merges into the first
/// one's thread entry. It is still a send of its own, so it is still
/// announced — with only its own text.
#[tokio::test(flavor = "multi_thread")]
async fn a_prompt_that_merges_into_the_last_entry_is_still_announced() {
    let harness = Harness::start();

    harness
        .projector
        .stamp_user_message(&harness.session_id, Origin::Local, Some("a".into()));
    lock(&harness.thread).push_user_content_block(None, user_text("first"));
    harness.pump();
    harness
        .projector
        .stamp_user_message(&harness.session_id, Origin::Local, Some("b".into()));
    lock(&harness.thread).push_user_content_block(None, user_text("second"));
    harness.pump();

    let announced: Vec<(String, Option<String>)> = harness
        .recorder
        .deltas()
        .into_iter()
        .filter_map(|delta| match delta {
            SessionDelta::UserMessage {
                message,
                client_message_id,
                ..
            } => Some((message.content, client_message_id)),
            _ => None,
        })
        .collect();
    assert_eq!(
        announced,
        [
            ("first".to_string(), Some("a".to_string())),
            ("second".to_string(), Some("b".to_string())),
        ]
    );
}

/// `seq` is dense, starts at 1 and follows emit order, for thread-driven and
/// host-announced deltas alike.
#[tokio::test(flavor = "multi_thread")]
async fn every_delta_is_numbered_densely_in_emit_order() {
    let harness = Harness::start();

    harness.update(text_chunk("Hel"));
    harness
        .projector
        .note_model_changed(&harness.session_id, "anthropic/claude", None);
    harness.update(text_chunk("lo"));
    harness.projector.note_queue_changed(
        &harness.session_id,
        vec![QueuedPrompt {
            id: "q-1".into(),
            text: "next".into(),
            origin: Origin::Local,
        }],
    );
    harness
        .projector
        .note_hold_changed(&harness.session_id, true);
    harness.expect(5);

    assert_eq!(seqs(&harness), [1, 2, 3, 4, 5]);
    assert_eq!(
        harness.recorder.kinds(),
        [
            "message_appended",
            "model_changed",
            "text_chunk",
            "queue_changed",
            "hold_changed"
        ]
    );
}

/// The joiner's contract: a snapshot reflects exactly the deltas at or below
/// its `as_of_seq`. The thread here runs ahead of the projection (events not
/// yet drained, as under load); the snapshot catches the projection up first,
/// and nothing it contains is announced again afterwards.
#[tokio::test(flavor = "multi_thread")]
async fn a_snapshot_reflects_exactly_the_deltas_at_or_below_its_seq() {
    let harness = Harness::start();

    harness.update(text_chunk("Hello"));
    // Into the thread, NOT drained: the projection is behind.
    for chunk in [", wor", "ld"] {
        let update: acp::SessionUpdate = serde_json::from_value(text_chunk(chunk)).unwrap();
        lock(&harness.thread).handle_session_update(update).unwrap();
    }

    let snapshot = harness
        .projector
        .snapshot(&harness.session_id, true, None)
        .expect("the session is projected");
    assert_eq!(
        Some(snapshot.as_of_seq),
        seqs(&harness).last().copied(),
        "the catch-up was announced, and the snapshot is as of it"
    );
    assert_eq!(snapshot.messages.len(), 1);
    assert_eq!(snapshot.messages[0].content, "Hello, world");

    // Draining the stale events now says nothing new...
    harness.pump();
    assert_eq!(Some(snapshot.as_of_seq), seqs(&harness).last().copied());

    // ...and what comes later is above it, and applies on top cleanly.
    harness.update(text_chunk("!"));
    let after: Vec<SessionDeltaEnvelope> = harness
        .recorder
        .envelopes
        .lock()
        .unwrap()
        .iter()
        .filter(|envelope| envelope.seq > snapshot.as_of_seq)
        .cloned()
        .collect();
    let mut text = snapshot.messages[0].content.clone();
    for envelope in after {
        if let SessionDelta::TextChunk { delta, .. } = envelope.delta {
            text.push_str(&delta);
        }
    }
    assert_eq!(
        text, "Hello, world!",
        "nothing applied twice, nothing missed"
    );
}

/// A client that joins (or a window that reloads) while the agent waits on a
/// permission must be able to answer it: the snapshot hands back the open
/// prompt by the id its delta carried, and forgets it once answered.
#[tokio::test(flavor = "multi_thread")]
async fn a_snapshot_hands_back_the_open_permission_prompt() {
    let harness = Harness::start();
    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "call-1",
        "title": "Write a.txt",
        "kind": "edit",
        "status": "pending",
        "rawInput": { "path": "a.txt" },
    }));
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
    harness.pump();

    let request_id = harness
        .recorder
        .deltas()
        .into_iter()
        .find_map(|delta| match delta {
            SessionDelta::PermissionRequest { request_id, .. } => Some(request_id),
            _ => None,
        })
        .expect("a permission request");

    let snapshot = harness
        .projector
        .snapshot(&harness.session_id, false, None)
        .expect("projected");
    assert_eq!(snapshot.pending_permissions.len(), 1);
    let pending = &snapshot.pending_permissions[0];
    assert_eq!(pending.request_id, request_id);
    assert_eq!(pending.tool_call["toolCallId"], "call-1");
    assert_eq!(pending.options[0]["optionId"], "allow_once");

    lock(&harness.thread).authorize_tool_call(
        acp::ToolCallId::new("call-1"),
        atlas_acp_thread::SelectedPermissionOutcome::new(
            acp::PermissionOptionId::new("allow_once"),
            acp::PermissionOptionKind::AllowOnce,
        ),
    );
    waiter.await;
    harness.pump();
    let snapshot = harness
        .projector
        .snapshot(&harness.session_id, false, None)
        .expect("projected");
    assert!(snapshot.pending_permissions.is_empty());
}

/// The elicitation counterpart: the newest unanswered one comes back with the
/// id the wire carried.
#[test]
fn a_snapshot_hands_back_the_waiting_elicitation() {
    let harness = Harness::start();
    let request: acp::CreateElicitationRequest = serde_json::from_value(serde_json::json!({
        "mode": "form",
        "sessionId": "sess-1",
        "message": "Which environment?",
        "requestedSchema": { "type": "object" },
    }))
    .unwrap();
    let (entry_id, _response) = lock(&harness.thread).request_elicitation(request).unwrap();
    harness.pump();
    let request_id = harness
        .recorder
        .deltas()
        .into_iter()
        .find_map(|delta| match delta {
            SessionDelta::ElicitationRequested { request_id, .. } => Some(request_id),
            _ => None,
        })
        .unwrap();

    let pending = harness
        .projector
        .snapshot(&harness.session_id, false, None)
        .unwrap()
        .pending_elicitation
        .expect("still waiting");
    assert_eq!(pending.request_id, request_id);
    assert_eq!(pending.message, "Which environment?");

    lock(&harness.thread).cancel_elicitation(&entry_id);
    assert!(harness
        .projector
        .snapshot(&harness.session_id, false, None)
        .unwrap()
        .pending_elicitation
        .is_none());
}

/// The native agent raises no event for a mode it was set to; an ACP agent
/// echoes one. The host announces the change either way, and the echo is not
/// a second change.
#[tokio::test(flavor = "multi_thread")]
async fn a_mode_change_is_said_once_whoever_says_it() {
    let harness = Harness::start();

    harness
        .projector
        .note_mode_changed(&harness.session_id, "plan", Some(Origin::Local));
    harness.update(serde_json::json!({
        "sessionUpdate": "current_mode_update",
        "currentModeId": "plan",
    }));
    harness.update(serde_json::json!({
        "sessionUpdate": "current_mode_update",
        "currentModeId": "default",
    }));
    harness.pump();

    let modes: Vec<(String, Option<Origin>)> = harness
        .recorder
        .deltas()
        .into_iter()
        .filter_map(|delta| match delta {
            SessionDelta::ModeChanged { mode_id, origin } => Some((mode_id, origin)),
            _ => None,
        })
        .collect();
    // The host's announcement names who set it; the agent's own change
    // (nobody through the host) names nobody.
    assert_eq!(
        modes,
        [
            ("plan".to_string(), Some(Origin::Local)),
            ("default".to_string(), None)
        ]
    );
}

/// The host serves the projection's announced view as its snapshot whenever a
/// projection exists, and the thread-built list only as a fallback. The two
/// must agree on everything a reload reads — in particular a turn's
/// "Worked for" / "Stopped after" — or the RC path silently loses it.
#[tokio::test(flavor = "multi_thread")]
async fn the_announced_snapshot_carries_turn_timing_like_the_thread_built_one() {
    let harness = Harness::start();
    lock(&harness.thread).push_user_content_block(None, user_text("first"));
    lock(&harness.thread).begin_turn();
    harness.update(serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "call-1",
        "title": "Read a.rs",
        "kind": "read",
        "status": "completed",
    }));
    harness.update(serde_json::json!({
        "sessionUpdate": "agent_message_chunk",
        "content": { "type": "text", "text": "done" },
    }));
    std::thread::sleep(std::time::Duration::from_millis(5));
    lock(&harness.thread).end_turn(acp::StopReason::EndTurn);
    harness.pump();

    let announced = harness
        .projector
        .snapshot(&harness.session_id, true, None)
        .expect("the session is projected")
        .messages;
    let built = atlas_agent_delta::project::snapshot_messages(&lock(&harness.thread), None);

    let timing =
        |messages: &[atlas_agent_delta::Message]| -> Vec<(bool, Option<u64>, Option<String>)> {
            messages
                .iter()
                .map(|m| (m.timestamp_approximate, m.worked_ms, m.stop_reason.clone()))
                .collect()
        };
    assert_eq!(
        timing(&announced),
        timing(&built),
        "{announced:#?}\nvs\n{built:#?}"
    );
    let last = announced.last().expect("the reply is a message");
    assert!(last.worked_ms.unwrap() >= 5, "{last:?}");
    assert_eq!(last.stop_reason.as_deref(), Some("end_turn"));
}

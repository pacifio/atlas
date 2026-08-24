//! The deltas reach the outbound pipeline losslessly, in order, on the emit
//! path.
//!
//! This is touchpoint #1, and the reason it is a test rather than a comment:
//! `CaptureMiddleware` is a pipeline *stage*, not a bus subscriber, precisely
//! because the bus drops events for a lagging subscriber and a dropped event is
//! a hole in the permanent record. A pipeline that ran late, dropped, or
//! reordered would be the same hole with a different cause.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{AcpThread, AcpThreadHandle, AgentConnection};
use atlas_agent_delta::{AgentId, DeltaProjector, DeltaSink, SessionDeltaEnvelope};
use atlas_bus::{OutboundMiddleware, OutboundPipeline};
use futures::future::BoxFuture;
use futures::FutureExt;

/// One stage of the pipeline. The real ones are broadcast, analytics, capture,
/// transcript and memory-ingest; what matters here is that each sees every
/// event and that they see them in registration order.
struct Stage {
    name: &'static str,
    order: Arc<Mutex<Vec<&'static str>>>,
    seen: Arc<Mutex<Vec<String>>>,
}

impl OutboundMiddleware<SessionDeltaEnvelope> for Stage {
    fn on_event(&self, event: &SessionDeltaEnvelope) {
        self.order.lock().unwrap().push(self.name);
        self.seen.lock().unwrap().push(
            serde_json::to_value(&event.delta).unwrap()["kind"]
                .as_str()
                .unwrap()
                .to_string(),
        );
    }
}

/// The host's sink: run the pipeline, then whatever else it does.
struct PipelineSink {
    pipeline: OutboundPipeline<SessionDeltaEnvelope>,
    emitted: Arc<AtomicUsize>,
}

impl DeltaSink for PipelineSink {
    fn emit(&self, envelope: SessionDeltaEnvelope) {
        self.pipeline.run(&envelope);
        self.emitted.fetch_add(1, Ordering::SeqCst);
    }
}

struct Stub;

impl AgentConnection for Stub {
    fn agent_id(&self) -> atlas_acp_thread::AgentId {
        atlas_acp_thread::AgentId::new("stub")
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

#[tokio::test(flavor = "multi_thread")]
async fn every_delta_reaches_every_stage_in_order_on_the_emit_path() {
    const STAGES: [&str; 5] = [
        "broadcast",
        "analytics",
        "capture",
        "transcript",
        "memory-ingest",
    ];

    let order = Arc::new(Mutex::new(Vec::new()));
    let seen: Vec<Arc<Mutex<Vec<String>>>> =
        STAGES.iter().map(|_| Arc::new(Mutex::new(Vec::new()))).collect();
    let mut pipeline = OutboundPipeline::new();
    for (name, seen) in STAGES.iter().zip(&seen) {
        pipeline.push(Arc::new(Stage {
            name,
            order: order.clone(),
            seen: seen.clone(),
        }));
    }

    let emitted = Arc::new(AtomicUsize::new(0));
    let projector = DeltaProjector::new(Arc::new(PipelineSink {
        pipeline,
        emitted: emitted.clone(),
    }));

    let session_id = acp::SessionId::new("sess-1");
    let events = (projector.thread_events())(&session_id);
    let thread = Arc::new(Mutex::new(AcpThread::new(
        session_id.clone(),
        Arc::new(Stub) as Arc<dyn AgentConnection>,
        vec![PathBuf::from("/tmp")],
        None,
        events,
    )));
    let mut stream = projector
        .register(AgentId::new(), thread.clone())
        .expect("registered");

    // A turn's worth of traffic: text, a tool call that runs and finishes, and
    // a terminal.
    let updates = [
        serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "working on it" },
        }),
        serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call-1",
            "title": "Bash",
            "kind": "execute",
            "status": "in_progress",
            "rawInput": { "command": "ls" },
        }),
        serde_json::json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "call-1",
            "status": "completed",
            "content": [{ "type": "content", "content": { "type": "text", "text": "a.txt" } }],
        }),
    ];
    {
        let mut thread = thread.lock().unwrap();
        thread.begin_turn();
        for update in updates {
            thread
                .handle_session_update(serde_json::from_value(update).unwrap())
                .unwrap();
        }
        thread.end_turn(acp::StopReason::EndTurn);
    }

    let mut applied = 0;
    while let Ok(event) = stream.try_recv() {
        projector.apply(&session_id, event);
        applied += 1;
    }
    assert!(applied > 0, "the thread emitted something to project");

    // Synchronous: by the time `apply` returned, every stage had already run.
    // Nothing here waits, sleeps or polls.
    let total = emitted.load(Ordering::SeqCst);
    assert!(total > 0, "deltas reached the sink");

    // Lossless: every stage saw every delta, and the same ones.
    let first = seen[0].lock().unwrap().clone();
    assert_eq!(first.len(), total, "the first stage saw every delta");
    for (name, stage) in STAGES.iter().zip(&seen) {
        assert_eq!(
            *stage.lock().unwrap(),
            first,
            "`{name}` saw a different stream"
        );
    }

    // In order: the stages ran in registration order, once each, per event.
    let order = order.lock().unwrap().clone();
    assert_eq!(order.len(), total * STAGES.len());
    for chunk in order.chunks(STAGES.len()) {
        assert_eq!(chunk, STAGES, "stages ran out of registration order");
    }

    // And the turn is on the record from both ends.
    assert_eq!(first.first().map(String::as_str), Some("status"));
    assert!(first.contains(&"turn_finished".to_string()));
    assert!(first.contains(&"tool_call_upserted".to_string()));
}

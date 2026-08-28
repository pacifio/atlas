//! Seam 1: a turn, driven through the trait the app drives.
//!
//! This is the tracer bullet's evidence. The spec's Testing Decisions say the
//! tests that matter here "drive the seam the app drives and assert on what
//! comes back", and that they are "engine-blind by construction" — nothing
//! below reaches into engine internals. It calls `new_session`, `prompt` and
//! `cancel` on `dyn AgentConnection`, exactly as `AgentHost` does.
//!
//! The model is a local mock speaking the Responses SSE wire. That is stronger
//! evidence than a manual click-through against a live provider, not weaker:
//! it runs in CI, it is deterministic, and it pins the streaming path rather
//! than just the happy-path total.
//!
//! **This file is also the regression test for the stack-size bug.** Before the
//! seam gave the engine its own runtime, `a_turn_completes_end_to_end_…` did not
//! fail — it *aborted the process* with `fatal runtime error: stack overflow`,
//! because `thread/start` overflowed the default 2 MiB stack. It runs at the
//! default stack size on purpose: setting `RUST_MIN_STACK` here would hide
//! exactly the regression it exists to catch. See `engine::runtime` for why.

#![cfg(feature = "ported-engine")]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{AcpThreadEvent, AgentConnection, AgentId};
use atlas_agent_servers::ThreadEventSink;
use atlas_native_agent::engine::config::{EngineHome, EngineProvider, EngineSettings};
use atlas_native_agent::engine::connection::EngineConnection;
use serde_json::json;
use wiremock::matchers::method;
use wiremock::matchers::path;
use wiremock::{Mock, MockServer, ResponseTemplate};

/// The Responses SSE framing the engine parses: `event:` then `data:`.
fn sse(events: Vec<serde_json::Value>) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    for ev in events {
        let kind = ev.get("type").and_then(|v| v.as_str()).expect("typed event");
        writeln!(&mut out, "event: {kind}").expect("write");
        write!(&mut out, "data: {ev}\n\n").expect("write");
    }
    out
}

fn assistant_turn(text: &str) -> String {
    sse(vec![
        json!({"type": "response.created", "response": {"id": "resp-1"}}),
        json!({
            "type": "response.output_item.done",
            "item": {
                "type": "message",
                "role": "assistant",
                "id": "msg-1",
                "content": [{"type": "output_text", "text": text}]
            }
        }),
        json!({
            "type": "response.completed",
            "response": {
                "id": "resp-1",
                "usage": {
                    "input_tokens": 0, "input_tokens_details": null,
                    "output_tokens": 0, "output_tokens_details": null,
                    "total_tokens": 0
                }
            }
        }),
    ])
}

struct Harness {
    _server: MockServer,
    _home: tempfile::TempDir,
    connection: Arc<EngineConnection>,
    /// Everything the app would have been told about the thread.
    ///
    /// One channel shared by every session: these tests use one session each,
    /// and asserting on what the *host* receives is the point — a retry the
    /// thread records but never announces is invisible in the UI.
    events: std::sync::mpsc::Receiver<AcpThreadEvent>,
}

impl Harness {
    /// Drains what has been announced so far.
    fn drained(&self) -> Vec<AcpThreadEvent> {
        self.events.try_iter().collect()
    }

    async fn open_thread(&self) -> acp::SessionId {
        let thread = self
            .connection
            .clone()
            .new_session(vec![PathBuf::from(".")])
            .await
            .expect("the engine should start a thread");
        let id = thread
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .session_id()
            .clone();
        // The thread must stay alive: the session table holds it weakly, so
        // dropping it here would silently stop every update for this session.
        std::mem::forget(thread);
        id
    }
}

/// Mounts `mocks` in order; each is `(times, template)`, `None` meaning
/// "for the rest of the test". wiremock prefers the first mock with calls
/// left, which is what lets a test script "fail once, then succeed".
async fn harness_with(mocks: Vec<(Option<u64>, ResponseTemplate)>) -> Harness {
    harness_configured(mocks, |s| s).await
}

async fn harness_configured(
    mocks: Vec<(Option<u64>, ResponseTemplate)>,
    tune: impl FnOnce(EngineSettings) -> EngineSettings,
) -> Harness {
    let server = MockServer::start().await;
    for (times, template) in mocks {
        let mock = Mock::given(method("POST"))
            .and(path("/v1/responses"))
            .respond_with(template);
        match times {
            Some(n) => mock.up_to_n_times(n).mount(&server).await,
            None => mock.mount(&server).await,
        }
    }

    let home = tempfile::tempdir().expect("tempdir");
    // The engine resolves the key from the environment itself. A unique name
    // per process keeps this from colliding with a developer's real key.
    let key_var = "ATLAS_ENGINE_TEST_KEY";
    unsafe_set_var(key_var, "test-key");

    let settings = tune(EngineSettings::new(
        EngineHome::at(home.path().join("engine")),
        EngineProvider::dev(
            "atlas-test",
            format!("{}/v1", server.uri()),
            Some(key_var.to_string()),
        ),
        "gpt-5-codex",
        home.path().to_path_buf(),
    ));

    let (tx, events) = std::sync::mpsc::channel();
    let tx = Arc::new(std::sync::Mutex::new(tx));
    let sink: ThreadEventSink = Arc::new(move |_id: &acp::SessionId| {
        let (thread_tx, mut thread_rx) = tokio::sync::mpsc::unbounded_channel();
        let out = tx.clone();
        tokio::spawn(async move {
            while let Some(event) = thread_rx.recv().await {
                if out
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .send(event)
                    .is_err()
                {
                    return;
                }
            }
        });
        thread_tx
    });

    let connection = EngineConnection::connect(AgentId::new("cersei"), settings, sink, None)
        .await
        .expect("the engine should start in-process");

    Harness {
        _server: server,
        _home: home,
        connection,
        events,
    }
}

async fn harness(body: String) -> Harness {
    harness_with(vec![(None, sse_ok(body))]).await
}

/// A stream that starts and then dies: SSE headers, `response.created`, and
/// then nothing. No `response.completed`.
///
/// This is bar item 5's "killed stream", and it is *not* the same as an HTTP
/// error. A 500 fails the request before a stream exists, which the engine
/// retries at the request layer without a word; only a stream that opens and
/// then stops produces `EventMsg::StreamError`, which is what carries
/// `will_retry` and therefore what the user ever sees.
fn killed_stream() -> ResponseTemplate {
    sse_ok(sse(vec![
        json!({"type": "response.created", "response": {"id": "resp-1"}}),
    ]))
}

fn sse_ok(body: String) -> ResponseTemplate {
    ResponseTemplate::new(200)
        .insert_header("content-type", "text/event-stream")
        .set_body_raw(body, "text/event-stream")
}

fn unsafe_set_var(key: &str, value: &str) {
    // Edition 2021: `set_var` is safe here. Isolated to one call so the day
    // this crate moves to 2024 there is exactly one place to change.
    std::env::set_var(key, value);
}

fn text(prompt: &str) -> Vec<acp::ContentBlock> {
    vec![acp::ContentBlock::Text(acp::TextContent::new(
        prompt.to_string(),
    ))]
}

#[tokio::test]
async fn a_turn_completes_end_to_end_on_the_ported_engine() {
    // Criterion 3 of #45, at the seam: prompt in, stop reason out, with the
    // engine actually running in this process.
    let h = harness(assistant_turn("hello from the engine")).await;
    let session_id = h.open_thread().await;

    let response = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("say something")))
        .await
        .expect("the turn should complete");

    assert_eq!(
        response.stop_reason,
        acp::StopReason::EndTurn,
        "a turn the model finished normally must end the turn",
    );
}

#[tokio::test]
async fn the_engine_reports_a_session_id_the_app_can_address() {
    // The engine's thread id *is* the ACP session id — no translation table.
    // If that ever stops holding, every stored row stops resolving.
    let h = harness(assistant_turn("ok")).await;
    assert!(
        !h.open_thread().await.to_string().is_empty(),
        "a session must be addressable",
    );
}

#[tokio::test]
async fn the_native_agent_advertises_no_acp_auth_method() {
    // D10: the native agent signs in with the Atlas account, and the engine's
    // own login surface stays off. Advertising a method here is what would put
    // an agent sign-in prompt in front of the user.
    let h = harness(assistant_turn("ok")).await;
    assert!(h.connection.auth_methods().is_empty());
}

// ---------------------------------------------------------------------------
// #46 — cancel, retry, and stop reasons at the seam.
//
// Acceptance-bar items 4 and 5, asserted where the spec says to assert them:
// Seam 1, through the trait, on what the app is actually told.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_cancelled_turn_ends_aborted_rather_than_hanging_or_ending_normally() {
    // Bar item 4. The two failure shapes this rules out are the ones a user
    // would actually meet: a cancel that does nothing and leaves the composer
    // spinning, and a cancel that ends the turn as if the model had finished,
    // which loses the fact that the answer is incomplete.
    let h = harness_with(vec![(
        None,
        sse_ok(assistant_turn("this should never be delivered"))
            .set_delay(Duration::from_secs(30)),
    )])
    .await;
    let session_id = h.open_thread().await;

    let connection = h.connection.clone();
    let prompting = {
        let session_id = session_id.clone();
        tokio::spawn(async move {
            connection
                .prompt(acp::PromptRequest::new(session_id, text("take your time")))
                .await
        })
    };

    // Cancel needs a turn in flight, and `turn/start` has to have returned
    // before the seam knows the turn id to interrupt. Rather than sleep a
    // guessed interval, retry the cancel until the prompt finishes: a cancel
    // with nothing running is a documented no-op, so repeating it is safe.
    let cancelled = tokio::time::timeout(Duration::from_secs(20), async {
        while !prompting.is_finished() {
            h.connection.cancel(&session_id);
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await;
    assert!(
        cancelled.is_ok(),
        "the cancel never took effect — the turn was still running after 20s",
    );

    let response = prompting
        .await
        .expect("the prompt task should not panic")
        .expect("a cancelled turn is an outcome, not an error");

    assert_eq!(
        response.stop_reason,
        acp::StopReason::Cancelled,
        "a cancelled turn must report Cancelled, not EndTurn",
    );
}

#[tokio::test]
async fn a_dropped_stream_retries_and_the_app_is_told_it_is_retrying() {
    // Bar item 5. A retry the engine performs but never announces is
    // indistinguishable from a hang, so "it completed" is only half of what
    // this has to prove — the retry notice reaching the host is the other half.
    let h = harness_with(vec![
        (Some(1), killed_stream()),
        (None, sse_ok(assistant_turn("recovered"))),
    ])
    .await;
    let session_id = h.open_thread().await;

    let response = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("hello")))
        .await
        .expect("the turn should survive one dropped stream");

    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);

    let retries: Vec<_> = h
        .drained()
        .into_iter()
        .filter_map(|e| match e {
            AcpThreadEvent::Retry(status) => Some(status),
            _ => None,
        })
        .collect();

    assert!(
        !retries.is_empty(),
        "a retried turn must announce the retry — silence reads as a hang",
    );
    let first = &retries[0];
    assert_eq!(first.attempt, 1, "the first retry is attempt 1");
    assert!(
        first.max_attempts > 0,
        "the pill renders attempt/max; a zero max renders as \"1/0\"",
    );
    assert!(
        !first.last_error.is_empty(),
        "the retry notice must carry why it is retrying",
    );
}

#[tokio::test]
async fn exhausting_the_retries_surfaces_a_typed_error_rather_than_a_normal_finish() {
    // Bar item 5's second half. The engine has no failure stop reason, so a
    // failed turn mapped onto `EndTurn` would render as a turn that simply
    // stopped, with the error nowhere.
    let h = harness_configured(vec![(None, killed_stream())], |s| {
        // One retry, not five: this asserts the shape of exhaustion, and
        // waiting out the engine's default backoff would only make it slow.
        s.with_stream_max_retries(1)
    })
    .await;
    let session_id = h.open_thread().await;

    let outcome = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("hello")))
        .await;

    let error = outcome.expect_err("an exhausted turn must not report success");
    assert!(
        !error.to_string().is_empty(),
        "the terminal error must say something",
    );
}

#[tokio::test]
async fn cancelling_with_nothing_running_is_a_no_op_rather_than_a_panic() {
    // `turn/interrupt` needs a turn id and the app can only name a session, so
    // a cancel that races a finished turn has nothing to send. It must be
    // quiet, not fatal.
    let h = harness(assistant_turn("ok")).await;
    let session_id = h.open_thread().await;
    h.connection.cancel(&session_id);
    h.connection.cancel(&acp::SessionId::new("no-such-thread"));
}

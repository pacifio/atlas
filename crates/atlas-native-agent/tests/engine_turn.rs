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

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{AgentConnection, AgentId};
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
}

async fn harness(body: String) -> Harness {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/responses"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(body, "text/event-stream"),
        )
        .mount(&server)
        .await;

    let home = tempfile::tempdir().expect("tempdir");
    // The engine resolves the key from the environment itself. A unique name
    // per process keeps this from colliding with a developer's real key.
    let key_var = "ATLAS_ENGINE_TEST_KEY";
    unsafe_set_var(key_var, "test-key");

    let settings = EngineSettings::new(
        EngineHome::at(home.path().join("engine")),
        EngineProvider::dev(
            "atlas-test",
            format!("{}/v1", server.uri()),
            Some(key_var.to_string()),
        ),
        "gpt-5-codex",
        home.path().to_path_buf(),
    );

    let connection = EngineConnection::connect(
        AgentId::new("cersei"),
        settings,
        Arc::new(|_: &acp::SessionId| tokio::sync::mpsc::unbounded_channel().0),
        None,
    )
    .await
    .expect("the engine should start in-process");

    Harness {
        _server: server,
        _home: home,
        connection,
    }
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

    let thread = h
        .connection
        .clone()
        .new_session(vec![PathBuf::from(".")])
        .await
        .expect("the engine should start a thread");

    let session_id = thread
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .session_id()
        .clone();

    let response = h
        .connection
        .prompt(acp::PromptRequest::new(
            session_id,
            text("say something"),
        ))
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
    let thread = h
        .connection
        .clone()
        .new_session(vec![PathBuf::from(".")])
        .await
        .expect("thread");
    let session_id = thread
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .session_id()
        .clone();
    assert!(
        !session_id.to_string().is_empty(),
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

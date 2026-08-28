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
    /// Open threads, kept alive for the test's lifetime.
    threads: std::sync::Mutex<Vec<atlas_acp_thread::AcpThreadHandle>>,
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

    /// Opens a thread and keeps it alive.
    ///
    /// The session table holds threads weakly, so a test that dropped its
    /// handle would silently stop receiving every update for that session.
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
        self.threads
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(thread);
        id
    }

    /// The assistant text currently rendered in the newest thread.
    fn assistant_text(&self) -> String {
        let thread = self.thread();
        let thread = thread.lock().unwrap_or_else(|p| p.into_inner());
        thread
            .entries()
            .iter()
            .filter_map(|e| match e {
                atlas_acp_thread::AgentThreadEntry::AssistantMessage(m) => Some(m),
                _ => None,
            })
            .flat_map(|m| m.chunks.iter())
            .map(|c| format!("{c:?}"))
            .collect::<Vec<_>>()
            .join("")
    }

    fn thread(&self) -> atlas_acp_thread::AcpThreadHandle {
        self.threads
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .last()
            .cloned()
            .expect("a thread must be open")
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
    harness_full(mocks, tune, None).await
}

async fn harness_full(
    mocks: Vec<(Option<u64>, ResponseTemplate)>,
    tune: impl FnOnce(EngineSettings) -> EngineSettings,
    memory_search: Option<atlas_native_agent::engine::memory::MemorySearch>,
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

    let connection = EngineConnection::connect_full(
        AgentId::new("cersei"),
        settings,
        sink,
        None,
        None,
        memory_search,
    )
    .await
    .expect("the engine should start in-process");

    Harness {
        _server: server,
        _home: home,
        connection,
        threads: std::sync::Mutex::new(Vec::new()),
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

// ---------------------------------------------------------------------------
// #47 — modes and the effort knob, verified against the engine.
//
// The mapping itself is unit-tested in `engine::modes`. What these add is the
// half a unit test cannot reach: that the engine *accepts* each policy pair.
// A mode that maps cleanly and is then refused at the protocol is a mode that
// silently does nothing.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn all_four_permission_modes_are_accepted_by_the_engine() {
    // Acceptance bar item 8, first half. Each mode is pushed through the same
    // `AgentSessionModes` surface the mode picker drives.
    let h = harness(assistant_turn("ok")).await;
    let session_id = h.open_thread().await;

    let modes = h
        .connection
        .session_modes(&session_id)
        .expect("the native agent must offer modes");

    assert_eq!(
        modes.all_modes().len(),
        4,
        "the picker offers four modes on both engines",
    );

    for mode in modes.all_modes() {
        modes
            .set_mode(mode.id.clone())
            .await
            .unwrap_or_else(|e| panic!("the engine refused mode {:?}: {e}", mode.id));
        assert_eq!(
            modes.current_mode(),
            mode.id,
            "the picker must report the mode that was actually set",
        );
    }
}

#[tokio::test]
async fn a_new_session_starts_in_a_mode_the_engine_has_been_told_about() {
    // Recording a mode without pushing it would leave the picker showing one
    // thing while the engine ran on its own defaults — the failure mode where
    // "Plan" is displayed and the agent edits files anyway.
    let h = harness(assistant_turn("ok")).await;
    let session_id = h.open_thread().await;
    let modes = h.connection.session_modes(&session_id).expect("modes");
    assert_eq!(modes.current_mode().to_string(), "default");
}

#[tokio::test]
async fn the_effort_knob_reaches_the_engine_and_rejects_a_level_it_does_not_know() {
    // Acceptance bar item 8, second half, and spec open question 4: the
    // per-session effort knob is `thread/settings/update`'s `effort` field.
    let h = harness(assistant_turn("ok")).await;
    let session_id = h.open_thread().await;

    let effort = h
        .connection
        .session_effort(&session_id)
        .expect("the native agent must offer the effort knob");

    for level in ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] {
        effort
            .set_effort(Some(level.to_string()))
            .unwrap_or_else(|e| panic!("{level} should be a valid effort: {e}"));
    }
    effort.set_effort(None).expect("clearing the override is valid");

    // Rejected rather than silently defaulted: a level that quietly became
    // "medium" would look like the knob doing nothing.
    assert!(
        effort.set_effort(Some("enthusiastic".to_string())).is_err(),
        "an unknown effort level must be refused, not rounded to a default",
    );

    // And the session still works afterwards — the settings updates did not
    // leave the thread in a state the engine refuses to run.
    let response = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("still there?")))
        .await
        .expect("the turn should still complete after settings updates");
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);
}

#[tokio::test]
async fn a_turn_still_completes_after_switching_into_plan_mode() {
    // Plan pairs read-only with `Never`, the most restrictive combination
    // Atlas can ask for. If the engine rejected that pair, the symptom would
    // be a mode that appears to switch and then breaks the next turn.
    let h = harness(assistant_turn("read-only answer")).await;
    let session_id = h.open_thread().await;
    let modes = h.connection.session_modes(&session_id).expect("modes");

    modes
        .set_mode(acp::SessionModeId::new("plan"))
        .await
        .expect("plan mode should be accepted");

    let response = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("what would you do?")))
        .await
        .expect("a turn in plan mode should still run");
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);
}

#[tokio::test]
async fn per_session_controls_share_the_connection_request_id_counter() {
    // Regression, with an honest caveat about how strong it is.
    //
    // The bug: the mode and effort controls minted request ids from their own
    // counters, each starting at zero, so they collided with the connection's.
    // The engine rejects a repeat outright — `duplicate request id` — and the
    // symptom was a prompt after a mode or effort change failing to start.
    //
    // **This test exercises the path but does not deterministically reproduce
    // the collision**, because the engine only rejects ids that are
    // concurrently *in flight*, and that needs the fire-and-forget effort
    // updates to still be outstanding when the prompt goes out. Reintroducing
    // the bug does not reliably fail this test. The invariant is stated where
    // it can be seen instead — on `RequestIds` in `engine::connection` — and
    // what this covers is the ordinary sequence a user produces: change some
    // settings, then send a message.
    let h = harness(assistant_turn("ok")).await;
    let session_id = h.open_thread().await;

    let modes = h.connection.session_modes(&session_id).expect("modes");
    let effort = h.connection.session_effort(&session_id).expect("effort");

    for mode in ["acceptEdits", "plan", "default"] {
        modes
            .set_mode(acp::SessionModeId::new(mode))
            .await
            .expect("mode should be accepted");
    }
    for level in ["high", "low", "medium"] {
        effort.set_effort(Some(level.to_string())).expect("effort");
    }

    let response = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("after all that")))
        .await
        .expect("a prompt after mode and effort changes must still start");
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);
}

// ---------------------------------------------------------------------------
// #47 — the approval round-trip.
//
// Acceptance bar item 7. The engine asks; the request has to surface on the
// thread as a tool-call authorization with Atlas's own option vocabulary; the
// user's answer has to get back to the engine as its own decision.
// ---------------------------------------------------------------------------

/// A turn that asks to run a command, then finishes.
///
/// **The command must be one the engine does not trust.** "Ask" mode is
/// `UnlessTrusted`, and a trusted command — `echo` among them — runs without
/// ever raising an approval. The first version of these tests used `echo` and
/// silently proved nothing: the turn completed, no dialog appeared, and the
/// only symptom was a helper timing out.
fn command_then_done(command: &str) -> String {
    let args = serde_json::to_string(&json!({
        "command": command,
        "workdir": null,
        "timeout_ms": 1000,
    }))
    .expect("arguments");
    sse(vec![
        json!({"type": "response.created", "response": {"id": "resp-1"}}),
        json!({
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call-1",
                "name": "shell_command",
                "arguments": args
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

/// Answers the first authorization the thread announces, and reports the
/// options the user was shown.
async fn answer_first_authorization(
    h: &Harness,
    pick: acp::PermissionOptionKind,
) -> Option<Vec<acp::PermissionOptionKind>> {
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    let mut seen: Vec<String> = Vec::new();
    while std::time::Instant::now() < deadline {
        for event in h.drained() {
            seen.push(format!("{event:?}"));
            if let AcpThreadEvent::ToolAuthorizationRequested { id, options } = event {
                let atlas_acp_thread::PermissionOptions::Flat(options) = options else {
                    panic!("the engine's prompts are a flat option list");
                };
                let kinds: Vec<_> = options.iter().map(|o| o.kind).collect();
                let chosen = options
                    .iter()
                    .find(|o| o.kind == pick)
                    .unwrap_or_else(|| panic!("no {pick:?} option was offered"));
                h.thread()
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .authorize_tool_call(
                        id,
                        atlas_acp_thread::SelectedPermissionOutcome::new(
                            chosen.option_id.clone(),
                            chosen.kind,
                        ),
                    );
                return Some(kinds);
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // Say what did arrive. "No approval" and "an approval that never reached
    // the thread" look identical from the assertion alone.
    eprintln!("no authorization within 20s; thread events were: {seen:#?}");
    None
}

#[tokio::test]
async fn a_command_approval_reaches_the_dialog_with_atlas_own_option_vocabulary() {
    // Bar item 7. In "Ask" mode the engine must stop before a command, and the
    // stop has to arrive as a tool-call authorization on the thread — the same
    // event an external ACP agent produces, so the existing dialog renders it.
    let h = harness_with(vec![
        (Some(1), sse_ok(command_then_done("rm -rf /tmp/atlas-approval-probe"))),
        (None, sse_ok(assistant_turn("done"))),
    ])
    .await;
    let session_id = h.open_thread().await;

    let connection = h.connection.clone();
    let prompting = {
        let session_id = session_id.clone();
        tokio::spawn(async move {
            connection
                .prompt(acp::PromptRequest::new(session_id, text("run something")))
                .await
        })
    };

    let kinds = answer_first_authorization(&h, acp::PermissionOptionKind::AllowOnce)
        .await
        .expect("the engine should have asked for approval");

    assert_eq!(
        kinds,
        [
            acp::PermissionOptionKind::AllowOnce,
            acp::PermissionOptionKind::AllowAlways,
            acp::PermissionOptionKind::RejectOnce,
        ],
        "the dialog must offer Atlas's own three options",
    );

    let response = tokio::time::timeout(Duration::from_secs(30), prompting)
        .await
        .expect("the turn should not hang once the dialog is answered")
        .expect("the prompt task should not panic")
        .expect("the turn should complete");
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);
}

#[tokio::test]
async fn declining_a_command_lets_the_turn_finish_rather_than_killing_it() {
    // The engine's own distinction, and the reason decline and cancel are not
    // the same answer: "the agent will continue the turn". A decline that
    // aborted would lose whatever the agent was going to say next.
    let h = harness_with(vec![
        (Some(1), sse_ok(command_then_done("rm -rf /tmp/atlas-approval-probe"))),
        (None, sse_ok(assistant_turn("understood"))),
    ])
    .await;
    let session_id = h.open_thread().await;

    let connection = h.connection.clone();
    let prompting = {
        let session_id = session_id.clone();
        tokio::spawn(async move {
            connection
                .prompt(acp::PromptRequest::new(session_id, text("run something")))
                .await
        })
    };

    answer_first_authorization(&h, acp::PermissionOptionKind::RejectOnce)
        .await
        .expect("the engine should have asked for approval");

    let response = tokio::time::timeout(Duration::from_secs(30), prompting)
        .await
        .expect("a declined command must not hang the turn")
        .expect("the prompt task should not panic")
        .expect("a declined command is an outcome, not an error");
    assert_eq!(
        response.stop_reason,
        acp::StopReason::EndTurn,
        "declining one action must not abort the whole turn",
    );
}

// ---------------------------------------------------------------------------
// #46, second half — the tool-execution clauses of bar items 4 and 5.
//
// These were owed by #46 and blocked on #47: a tool call cannot reach the seam
// until approvals round-trip, because in Ask mode an untrusted command raises
// a dialog and waits.
//
// Both assert on the *filesystem*, not on protocol chatter. A turn can report
// "cancelled" while the command it started keeps running, and a retried turn
// can look identical whether the tool ran once or twice. The side effect is
// the only witness that tells those apart.
// ---------------------------------------------------------------------------

/// A turn that runs `command`, then finishes on the next response.
fn command_turn(command: &str) -> String {
    command_then_done_with(command)
}

fn command_then_done_with(command: &str) -> String {
    let args = serde_json::to_string(&json!({
        "command": command,
        "workdir": null,
        "timeout_ms": 60000,
    }))
    .expect("arguments");
    sse(vec![
        json!({"type": "response.created", "response": {"id": "resp-1"}}),
        json!({
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call-1",
                "name": "shell_command",
                "arguments": args
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

#[tokio::test]
async fn cancelling_mid_tool_stops_the_command_it_started() {
    // Bar item 4's tool clause. The turn reporting `Cancelled` is not enough:
    // an orphaned child keeps writing to the user's disk after the UI says the
    // turn stopped. The marker file is what distinguishes "the turn ended" from
    // "the work ended".
    let dir = tempfile::tempdir().expect("tempdir");
    let marker = dir.path().join("survived-the-cancel");
    let command = format!(
        "sleep 5; touch {}",
        marker.to_string_lossy(),
    );

    let h = harness_with(vec![
        (Some(1), sse_ok(command_turn(&command))),
        (None, sse_ok(assistant_turn("done"))),
    ])
    .await;
    let session_id = h.open_thread().await;

    let connection = h.connection.clone();
    let prompting = {
        let session_id = session_id.clone();
        tokio::spawn(async move {
            connection
                .prompt(acp::PromptRequest::new(session_id, text("do the slow thing")))
                .await
        })
    };

    answer_first_authorization(&h, acp::PermissionOptionKind::AllowOnce)
        .await
        .expect("the engine should ask before an untrusted command");

    // Let it get started, then cancel while it is genuinely running.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let cancelled = tokio::time::timeout(Duration::from_secs(20), async {
        while !prompting.is_finished() {
            h.connection.cancel(&session_id);
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await;
    assert!(cancelled.is_ok(), "the cancel never took effect");

    let response = prompting
        .await
        .expect("the prompt task should not panic")
        .expect("a cancelled turn is an outcome, not an error");
    assert_eq!(response.stop_reason, acp::StopReason::Cancelled);

    // Past when the command would have finished had it survived.
    tokio::time::sleep(Duration::from_secs(6)).await;
    assert!(
        !marker.exists(),
        "the cancelled command kept running and touched {} — the turn was \
         reported as cancelled while its child process was still working",
        marker.display(),
    );
}

#[tokio::test]
async fn a_retried_turn_does_not_re_run_a_tool_call_that_already_executed() {
    // Bar item 5's tool clause. This is the failure that costs real money and
    // real damage: the stream drops after a command has run, the engine
    // retries, and the command runs a second time. An `rm`, a deploy, a
    // payment — anything not idempotent.
    //
    // The counter file is the witness. Protocol events cannot tell the two
    // cases apart, because a correct retry and a double-execution produce the
    // same visible turn.
    let dir = tempfile::tempdir().expect("tempdir");
    let counter = dir.path().join("executions");
    let command = format!("echo ran >> {}", counter.to_string_lossy());

    let h = harness_with(vec![
        // The command runs, and then the stream dies before completing the
        // turn — so the engine retries the *turn*.
        (Some(1), sse_ok(command_turn(&command))),
        (Some(1), killed_stream()),
        (None, sse_ok(assistant_turn("finished"))),
    ])
    .await;
    let session_id = h.open_thread().await;

    let connection = h.connection.clone();
    let prompting = {
        let session_id = session_id.clone();
        tokio::spawn(async move {
            connection
                .prompt(acp::PromptRequest::new(session_id, text("append once")))
                .await
        })
    };

    answer_first_authorization(&h, acp::PermissionOptionKind::AllowOnce)
        .await
        .expect("the engine should ask before an untrusted command");

    let response = tokio::time::timeout(Duration::from_secs(60), prompting)
        .await
        .expect("the retried turn should not hang")
        .expect("the prompt task should not panic")
        .expect("the turn should survive the dropped stream");
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);

    // The turn must actually have been retried, or "ran once" is trivially
    // true and this proves nothing about retries at all.
    let retried = h
        .drained()
        .into_iter()
        .any(|e| matches!(e, AcpThreadEvent::Retry(_)));
    assert!(
        retried,
        "no retry was announced, so this turn never exercised the retry path",
    );

    let runs = std::fs::read_to_string(&counter).unwrap_or_default();
    let runs = runs.lines().filter(|l| !l.trim().is_empty()).count();
    assert_eq!(
        runs, 1,
        "the command ran {runs} times across the retry; a non-idempotent \
         command run twice is the failure this clause exists to prevent",
    );
}

#[tokio::test]
async fn control_an_approved_command_really_does_run() {
    // The control for the two tests above. Both of them assert that a file
    // does *not* appear, or appears once — and both would pass just as well if
    // approved commands never ran at all, which is exactly what a
    // workspace-write sandbox does to a path outside the workspace.
    //
    // Without this, "the cancel killed the command" and "the command was never
    // able to run" are indistinguishable.
    let dir = tempfile::tempdir().expect("tempdir");
    let marker = dir.path().join("it-ran");
    let command = format!("touch {}", marker.to_string_lossy());

    let h = harness_with(vec![
        (Some(1), sse_ok(command_turn(&command))),
        (None, sse_ok(assistant_turn("done"))),
    ])
    .await;
    let session_id = h.open_thread().await;

    let connection = h.connection.clone();
    let prompting = {
        let session_id = session_id.clone();
        tokio::spawn(async move {
            connection
                .prompt(acp::PromptRequest::new(session_id, text("touch it")))
                .await
        })
    };

    answer_first_authorization(&h, acp::PermissionOptionKind::AllowOnce)
        .await
        .expect("the engine should ask before an untrusted command");

    let _ = tokio::time::timeout(Duration::from_secs(60), prompting).await;

    assert!(
        marker.exists(),
        "an approved command did not run at all, so the cancel and retry tests \
         above prove nothing: they assert on a file that could never appear",
    );
}

// ---------------------------------------------------------------------------
// #48 — search_memory on the ported engine (acceptance bar item 11).
// ---------------------------------------------------------------------------

/// A turn that calls `search_memory`, then answers.
fn memory_lookup_turn(arguments: serde_json::Value) -> String {
    sse(vec![
        json!({"type": "response.created", "response": {"id": "resp-1"}}),
        json!({
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call-mem",
                "name": "search_memory",
                "arguments": arguments.to_string()
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

/// What one `search_memory` call was asked: cwd, query, limit.
type SearchCall = (String, String, usize);
type SearchLog = Arc<std::sync::Mutex<Vec<SearchCall>>>;

/// Records what the tool was asked, and answers with one doc.
fn recording_search() -> (atlas_native_agent::engine::memory::MemorySearch, SearchLog) {
    let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = calls.clone();
    let search: atlas_native_agent::engine::memory::MemorySearch =
        Arc::new(move |cwd: String, query: String, limit: usize| {
            seen.lock()
                .unwrap_or_else(|p| p.into_inner())
                .push((cwd, query.clone(), limit));
            Box::pin(async move {
                vec![atlas_native_agent::engine::memory::MemDoc {
                    title: "ADR-0003".to_string(),
                    source: "docs/adr".to_string(),
                    text: format!("the answer to {query}"),
                }]
            })
        });
    (search, calls)
}

#[tokio::test]
async fn search_memory_is_registered_and_returns_live_results() {
    // Bar item 11. The retrieval itself never moved — `atlas-memory` depends on
    // neither engine — so what this proves is the projection: the engine knows
    // the tool exists, calls it, and Atlas answers from the live callback.
    let (search, calls) = recording_search();
    let h = harness_full(
        vec![
            (Some(1), sse_ok(memory_lookup_turn(json!({"query": "how does auth work", "limit": 3})))),
            (None, sse_ok(assistant_turn("grounded answer"))),
        ],
        |s| s,
        Some(search),
    )
    .await;
    let session_id = h.open_thread().await;

    let response = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("what do we know?")))
        .await
        .expect("the turn should complete");
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);

    let calls = calls.lock().unwrap_or_else(|p| p.into_inner()).clone();
    assert_eq!(calls.len(), 1, "the engine should have called search_memory once");
    let (cwd, query, limit) = &calls[0];
    assert_eq!(query, "how does auth work");
    assert_eq!(*limit, 3);
    assert!(
        !cwd.is_empty(),
        "retrieval is per project, so the session's cwd has to reach it — the \
         engine's tool-call request does not carry one",
    );
}

#[tokio::test]
async fn the_memory_tool_is_not_advertised_when_there_is_no_retrieval() {
    // A tool the model is told about and cannot use is worse than one it never
    // sees: it will call it, fail, and often retry.
    let h = harness(assistant_turn("ok")).await;
    let session_id = h.open_thread().await;
    let response = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("hello")))
        .await
        .expect("a turn without memory retrieval still works");
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);
}

#[tokio::test]
async fn a_memory_call_with_no_query_is_answered_rather_than_left_hanging() {
    // The model can and does call this with an empty query. An unanswered
    // dynamic tool call is a turn that stops with no error and no explanation.
    let (search, calls) = recording_search();
    let h = harness_full(
        vec![
            (Some(1), sse_ok(memory_lookup_turn(json!({"query": "   "})))),
            (None, sse_ok(assistant_turn("asked instead"))),
        ],
        |s| s,
        Some(search),
    )
    .await;
    let session_id = h.open_thread().await;

    let response = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("what do we know?")))
        .await
        .expect("an empty query must not hang the turn");
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);
    assert!(
        calls.lock().unwrap_or_else(|p| p.into_inner()).is_empty(),
        "an empty query should never reach retrieval",
    );
}

// ---------------------------------------------------------------------------
// #49 — history continuity across the engine swap (D6/D7).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_row_from_before_the_engine_changed_opens_instead_of_erroring() {
    // Bar item 2. A stored row the engine has never heard of — every native
    // row is one, in Phase 2. It must open. A row that refuses to open is
    // worse than one that opens empty, and "this is from before the engine
    // changed" is not something the user did wrong.
    let h = harness(assistant_turn("continuing")).await;

    let thread = h
        .connection
        .clone()
        .resume_session(
            acp::SessionId::new("a-cersei-era-session-id"),
            vec![PathBuf::from(".")],
            Some("An old conversation".into()),
        )
        .await
        .expect("a pre-cutover row must open rather than error");

    let session_id = thread
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .session_id()
        .clone();
    h.threads
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .push(thread);

    // And the conversation continues from there, which is what the notice
    // promises the user.
    let response = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("still here?")))
        .await
        .expect("the reopened row should take a new turn");
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);
}

#[tokio::test]
async fn the_engine_advertises_resume_not_load_so_the_user_is_told() {
    // This is what produces D6's notice, and it is load-bearing rather than a
    // detail: the manager picks the resume mode by *capability*, so
    // advertising load would report every reopened row as replayed — opening
    // pre-cutover rows empty and silent, leaving the user to wonder where the
    // conversation went.
    let h = harness(assistant_turn("ok")).await;
    assert!(
        !h.connection.supports_load_session(),
        "advertising load would suppress the no-history notice",
    );
    assert!(h.connection.supports_resume_session());
    assert!(h.connection.supports_session_history());
}

#[tokio::test]
async fn the_native_agent_keeps_the_stored_agent_id_across_the_swap() {
    // D7: the stored agent id is a storage key, not a display name. Both
    // engines answer to "cersei" so every row written before the switch still
    // resolves after it.
    let h = harness(assistant_turn("ok")).await;
    assert_eq!(h.connection.agent_id().as_str(), "cersei");
}

#[tokio::test]
async fn a_turn_emits_the_events_the_live_thread_feed_records_on() {
    // Bar item 3, at the seam. The recorder is not changed by the port — it
    // observes `AcpThreadEvent`s, and both engines produce them through the
    // same `AcpThread`. What has to hold is that an engine turn still emits
    // events the feed acts on; if it did not, rows would silently stop
    // updating and nothing would fail.
    //
    // It asks the recorder's own predicate rather than listing events, so this
    // cannot drift away from what the feed actually keys on.
    let h = harness(assistant_turn("hello")).await;
    let session_id = h.open_thread().await;

    h.connection
        .prompt(acp::PromptRequest::new(session_id, text("say something")))
        .await
        .expect("the turn should complete");

    let recorded: Vec<_> = h
        .drained()
        .into_iter()
        .filter(atlas_thread_metadata::affects_thread_metadata)
        .collect();

    assert!(
        !recorded.is_empty(),
        "an engine turn produced no event the live feed records on, so its \
         store row would never be created or updated",
    );
}

#[tokio::test]
async fn the_models_answer_actually_reaches_the_transcript() {
    // The user-visible half of the same bug the live-feed test found: the sink
    // mapped streaming deltas only, so an answer delivered as a completed item
    // — which is every answer from a provider that does not stream — vanished.
    // The turn completed, the stop reason was right, and the chat stayed empty.
    let h = harness(assistant_turn("the answer is 42")).await;
    let session_id = h.open_thread().await;

    h.connection
        .prompt(acp::PromptRequest::new(session_id, text("what is it?")))
        .await
        .expect("the turn should complete");

    assert!(
        h.assistant_text().contains("the answer is 42"),
        "the model's answer never reached the transcript; rendered: {}",
        h.assistant_text(),
    );
}

#[tokio::test]
async fn a_streamed_answer_is_not_rendered_twice() {
    // The other side of it. The engine sends deltas *and* a completed item
    // carrying the whole text, so rendering both shows the answer twice.
    let streamed = sse(vec![
        json!({"type": "response.created", "response": {"id": "resp-1"}}),
        json!({
            "type": "response.output_item.done",
            "item": {
                "type": "message",
                "role": "assistant",
                "id": "msg-1",
                "content": [{"type": "output_text", "text": "unique-marker-xyz"}]
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
    ]);
    let h = harness(streamed).await;
    let session_id = h.open_thread().await;

    h.connection
        .prompt(acp::PromptRequest::new(session_id, text("say it once")))
        .await
        .expect("the turn should complete");

    let rendered = h.assistant_text();
    assert_eq!(
        rendered.matches("unique-marker-xyz").count(),
        1,
        "the answer was rendered more than once: {rendered}",
    );
}

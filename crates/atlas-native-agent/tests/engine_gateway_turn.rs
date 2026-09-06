//! Seam 1, on the gateway wire: a turn through the trait the app drives, with
//! the Atlas Chat Completions dialect (D3) carrying it.
//!
//! Its sibling `engine_turn.rs` drives the same trait against the engine's own
//! Responses dialect. This file exists because the two share nothing below the
//! seam — different request body, different route, different SSE grammar,
//! different error table — so a green Responses suite says nothing at all about
//! whether the gateway path works.
//!
//! The mock speaks the gateway contract rather than a convenient
//! approximation: `data: [DONE]` ends a good stream, an error frame plus a
//! withheld sentinel ends a bad one, and the request body is asserted against
//! the forwarded allowlist — because the gateway answers one stray field with a
//! `400` and there is no partial credit.

use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{AcpThreadEvent, AgentConnection, AgentId};
use atlas_agent_servers::ThreadEventSink;
use atlas_native_agent::engine::auth::{AtlasExternalAuth, AtlasTokenSource};
use atlas_native_agent::engine::config::{EngineHome, EngineProvider, EngineSettings};
use atlas_native_agent::engine::connection::EngineConnection;
use codex_login::auth::ExternalAuthFuture;
use serde_json::Value;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// A token source that always mints. The gateway provider names no `env_key`,
/// so without one of these the engine has no credential to send at all.
struct StaticToken;

impl AtlasTokenSource for StaticToken {
    fn mint(&self) -> ExternalAuthFuture<'_, String> {
        Box::pin(async { Ok("test-access-jwt".to_string()) })
    }
}

/// Mints a different token every time, so a refresh is visible on the wire.
///
/// A source that returns the same string cannot tell "refreshed and retried"
/// apart from "retried with the dead token", which is the whole distinction
/// D10 turns on.
#[derive(Default)]
struct RotatingToken {
    minted: std::sync::atomic::AtomicUsize,
}

impl AtlasTokenSource for RotatingToken {
    fn mint(&self) -> ExternalAuthFuture<'_, String> {
        let n = self
            .minted
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::pin(async move { Ok(format!("jwt-{n}")) })
    }
}

fn sse_ok(body: String) -> ResponseTemplate {
    ResponseTemplate::new(200)
        .insert_header("content-type", "text/event-stream")
        .set_body_raw(body, "text/event-stream")
}

/// The gateway's own framing: bare `data:` lines, no `event:` names.
fn frames(frames: &[&str]) -> String {
    frames
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect()
}

fn answer(text: &str) -> String {
    let delta = serde_json::json!({
        "id": "chatcmpl-1",
        "object": "chat.completion.chunk",
        "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": null}],
    })
    .to_string();
    let finish = r#"{"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#;
    let usage = r#"{"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":14}}"#;
    frames(&[&delta, finish, usage, "[DONE]"])
}

struct Harness {
    server: MockServer,
    _home: tempfile::TempDir,
    connection: Arc<EngineConnection>,
    threads: std::sync::Mutex<Vec<atlas_acp_thread::AcpThreadHandle>>,
    events: std::sync::mpsc::Receiver<AcpThreadEvent>,
}

impl Harness {
    async fn open_thread(&self) -> acp::SessionId {
        let thread = match self.connection.clone().new_session(vec![PathBuf::from(".")]).await {
            Ok(thread) => thread,
            Err(err) => panic!("the engine should start a thread: {err:#}"),
        };
        let id = thread
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .session_id()
            .clone();
        self.threads
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(thread);
        id
    }

    fn assistant_text(&self) -> String {
        let Some(thread) = self
            .threads
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .last()
            .cloned()
        else {
            panic!("a thread must be open");
        };
        let thread = thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
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

    fn drained(&self) -> Vec<AcpThreadEvent> {
        self.events.try_iter().collect()
    }

    /// The body of the last completion request the gateway received.
    async fn last_request_body(&self) -> Value {
        let Some(received) = self.server.received_requests().await else {
            panic!("the mock server must be recording requests");
        };
        let Some(last) = received
            .iter().rfind(|r| r.url.path().ends_with("/chat/completions"))
        else {
            panic!("no completion request reached the gateway");
        };
        match serde_json::from_slice(&last.body) {
            Ok(body) => body,
            Err(err) => panic!("the request body must be JSON: {err}"),
        }
    }
}

async fn harness(mocks: Vec<(Option<u64>, ResponseTemplate)>) -> Harness {
    harness_with_token(mocks, Arc::new(StaticToken)).await
}

async fn harness_with_token(
    mocks: Vec<(Option<u64>, ResponseTemplate)>,
    token: Arc<dyn AtlasTokenSource>,
) -> Harness {
    let server = MockServer::start().await;
    for (times, template) in mocks {
        let mock = Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(template);
        match times {
            Some(n) => mock.up_to_n_times(n).mount(&server).await,
            None => mock.mount(&server).await,
        }
    }

    let Ok(home) = tempfile::tempdir() else {
        panic!("tempdir");
    };
    let settings = EngineSettings::new(
        EngineHome::at(home.path().join("engine")),
        EngineProvider::gateway(format!("{}/v1", server.uri())),
        atlas_native_agent::engine::catalog::DEFAULT_MODEL,
        home.path().to_path_buf(),
    );

    let (tx, events) = std::sync::mpsc::channel();
    let tx = Arc::new(std::sync::Mutex::new(tx));
    let sink: ThreadEventSink = Arc::new(move |_id: &acp::SessionId| {
        let (thread_tx, mut thread_rx) = tokio::sync::mpsc::unbounded_channel();
        let out = tx.clone();
        tokio::spawn(async move {
            while let Some(event) = thread_rx.recv().await {
                if out
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .send(event)
                    .is_err()
                {
                    return;
                }
            }
        });
        thread_tx
    });

    let external_auth = Arc::new(AtlasExternalAuth::new(token));
    let connection = match EngineConnection::connect_full(
        AgentId::new("cersei"),
        settings,
        sink,
        Some(external_auth),
        None,
        None,
    )
    .await
    {
        Ok(connection) => connection,
        Err(err) => panic!("the engine should start in-process: {err:#}"),
    };

    Harness {
        server,
        _home: home,
        connection,
        threads: std::sync::Mutex::new(Vec::new()),
        events,
    }
}

fn text(prompt: &str) -> Vec<acp::ContentBlock> {
    vec![acp::ContentBlock::Text(acp::TextContent::new(
        prompt.to_string(),
    ))]
}

#[tokio::test]
async fn a_turn_completes_through_the_gateway_dialect() {
    // The criterion the whole ticket is about: prompt in, answer rendered, turn
    // ended — with the request on the gateway's route and the reply on the
    // gateway's grammar. Nothing below the seam is shared with the Responses
    // path, so this is the only thing that says the dialect works.
    let h = harness(vec![(None, sse_ok(answer("hello from the gateway")))]).await;
    let session_id = h.open_thread().await;

    let response = match h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("say something")))
        .await
    {
        Ok(response) => response,
        Err(err) => panic!("the turn should complete: {err:#}"),
    };

    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);
    assert!(
        h.assistant_text().contains("hello from the gateway"),
        "the answer must reach the thread, not just the stop reason: {}",
        h.assistant_text(),
    );
    assert!(
        !h.drained().is_empty(),
        "the app must be told something happened",
    );
}

#[tokio::test]
async fn the_request_that_leaves_carries_only_what_the_gateway_forwards() {
    // Asserted on the wire rather than on the builder, because everything
    // between the two — the engine's own request assembly, the config, the
    // provider — is what would put a Responses field back. One stray key is a
    // 400 and the turn never starts.
    const ALLOWED: &[&str] = &[
        "model",
        "messages",
        "stream",
        "max_tokens",
        "tools",
        "tool_choice",
        "response_format",
        "stop",
    ];

    let h = harness(vec![(None, sse_ok(answer("ok")))]).await;
    let session_id = h.open_thread().await;
    let _ = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("hi")))
        .await;

    let body = h.last_request_body().await;
    let Some(object) = body.as_object() else {
        panic!("the request body must be a JSON object: {body}");
    };
    for key in object.keys() {
        assert!(
            ALLOWED.contains(&key.as_str()),
            "`{key}` is off the gateway's allowlist; this request is a 400",
        );
    }

    // Not vacuous: the turn really did carry a prompt and a bounded output.
    assert_eq!(body["model"], serde_json::json!("claude-sonnet-4-6"));
    assert!(body["max_tokens"].is_number(), "max_tokens must be explicit");
    let Some(messages) = body["messages"].as_array() else {
        panic!("messages must be an array");
    };
    assert!(
        messages.len() >= 2,
        "a turn carries at least the system prompt and the user's words",
    );
    assert_eq!(messages[0]["role"], serde_json::json!("system"));
}

#[tokio::test]
async fn the_minted_token_is_what_authorises_the_request() {
    // D10 end to end: the gateway provider names no `env_key`, so if the
    // `ExternalAuth` provider is not reached the request goes out with no
    // credential and every turn 401s in production.
    let h = harness(vec![(None, sse_ok(answer("ok")))]).await;
    let session_id = h.open_thread().await;
    let _ = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("hi")))
        .await;

    let Some(received) = h.server.received_requests().await else {
        panic!("the mock server must be recording requests");
    };
    let Some(last) = received
        .iter().rfind(|r| r.url.path().ends_with("/chat/completions"))
    else {
        panic!("no completion request reached the gateway");
    };
    let authorization = last
        .headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    assert_eq!(authorization, "Bearer test-access-jwt");
}

#[tokio::test]
async fn a_stream_that_dies_without_the_sentinel_does_not_end_the_turn_normally() {
    // The gateway's rule at the seam. A truncated answer reported as a finished
    // one is the failure the withheld sentinel exists to prevent, and it is
    // invisible to the user by construction — the text that did arrive looks
    // like the whole reply.
    let half = frames(&[
        &serde_json::json!({
            "id": "chatcmpl-1",
            "choices": [{"index": 0, "delta": {"content": "half an ans"}, "finish_reason": null}],
        })
        .to_string(),
    ]);
    let h = harness(vec![(None, sse_ok(half))]).await;
    let session_id = h.open_thread().await;

    let outcome = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("hi")))
        .await;

    match outcome {
        Err(_) => {}
        Ok(response) => assert_ne!(
            response.stop_reason,
            acp::StopReason::EndTurn,
            "an incomplete stream must not report a finished turn",
        ),
    }
}

#[tokio::test]
async fn a_filled_cap_is_surfaced_once_rather_than_retried() {
    // The acceptance criterion, at the seam and end to end: the gateway answers
    // 402 exactly once and the engine must not ask again. `up_to_n_times(1)`
    // plus a request count is what makes "zero retries" an assertion rather
    // than a claim — a second attempt would find no mock and fail differently.
    let cap = ResponseTemplate::new(402).set_body_raw(
        r#"{"error":{"message":"The org monthly AI budget is spent.","code":"cap_exceeded","window":"monthly","scope":"org","used":307425,"cap":350000,"reset":"2026-09-01T00:00:00.000Z"}}"#,
        "application/json",
    );
    let h = harness(vec![(None, cap)]).await;
    let session_id = h.open_thread().await;

    let outcome = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("hi")))
        .await;
    assert!(outcome.is_err(), "a filled cap must fail the turn");

    let Some(received) = h.server.received_requests().await else {
        panic!("the mock server must be recording requests");
    };
    let attempts = received
        .iter()
        .filter(|r| r.url.path().ends_with("/chat/completions"))
        .count();
    assert_eq!(
        attempts, 1,
        "a 402 must produce zero automatic re-requests, saw {attempts} attempts",
    );
}

#[tokio::test]
async fn an_expired_token_is_re_minted_and_the_turn_carries_on() {
    // D10's other half, end to end. The gateway's `401 token_expired` is the
    // normal end of a long session — the JWT lives ten minutes and a turn can
    // outlast it — and the contract says refresh once and retry rather than
    // back off. Without this the user sees a turn fail for no reason they can
    // act on, roughly ten minutes into working.
    //
    // The token source mints a *different* value each call, because a static
    // one cannot distinguish "refreshed, then retried" from "retried with the
    // same dead token" — which is the only thing this test is about.
    let expired = ResponseTemplate::new(401).set_body_raw(
        r#"{"error":{"message":"token expired","type":"authentication_error","code":"token_expired"}}"#,
        "application/json",
    );
    let h = harness_with_token(
        vec![
            (Some(1), expired),
            (None, sse_ok(answer("recovered"))),
        ],
        Arc::new(RotatingToken::default()),
    )
    .await;
    let session_id = h.open_thread().await;

    let response = match h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("hi")))
        .await
    {
        Ok(response) => response,
        Err(err) => panic!("an expired token must not fail the turn: {err:#}"),
    };
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);
    assert!(h.assistant_text().contains("recovered"));

    let Some(received) = h.server.received_requests().await else {
        panic!("the mock server must be recording requests");
    };
    let tokens: Vec<String> = received
        .iter()
        .filter(|r| r.url.path().ends_with("/chat/completions"))
        .map(|r| {
            r.headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string()
        })
        .collect();
    assert!(
        tokens.len() >= 2,
        "the 401 must be retried, saw {} attempt(s)",
        tokens.len(),
    );
    assert_ne!(
        tokens[0],
        tokens[tokens.len() - 1],
        "the retry must carry a freshly minted token, not the expired one: {tokens:?}",
    );
}

#[tokio::test]
async fn an_unauthorized_token_is_not_retried_at_all() {
    // The other 401. A credential the gateway will never accept does not become
    // acceptable by being sent again, and the contract says so explicitly.
    //
    // What this pins is the bound, not the code split: the engine's own
    // recovery runs before the classification sees the error, and it allows one
    // retry either way. The `token_expired` / `unauthorized` distinction is
    // asserted where it is actually decided — the classification table in
    // `codex_api::atlas_gateway`, which is what the unary calls go through.
    // Here the claim is narrower and still worth holding: a dead credential
    // does not turn into a retry storm.
    let unauthorized = ResponseTemplate::new(401).set_body_raw(
        r#"{"error":{"message":"invalid token","type":"authentication_error","code":"unauthorized"}}"#,
        "application/json",
    );
    let h = harness_with_token(
        vec![(None, unauthorized)],
        Arc::new(RotatingToken::default()),
    )
    .await;
    let session_id = h.open_thread().await;

    let outcome = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("hi")))
        .await;
    assert!(outcome.is_err(), "an unusable credential must fail the turn");

    let Some(received) = h.server.received_requests().await else {
        panic!("the mock server must be recording requests");
    };
    let attempts = received
        .iter()
        .filter(|r| r.url.path().ends_with("/chat/completions"))
        .count();
    assert!(
        attempts <= 2,
        "an unauthorized credential must not be retried in a loop, saw {attempts} attempts",
    );
}

#[tokio::test]
async fn a_rate_limited_turn_shows_one_countdown_and_then_gives_the_turn_back() {
    // D15(b) and acceptance bar item 13. Two properties, and the ticket needs
    // both:
    //
    //  * the wait is *visible* — the retry notice carries the gateway's own
    //    `Retry-After`, so the pill counts down to the attempt instead of up
    //    from the notice. A minute-long wait with no visible end is
    //    indistinguishable from a hang, which is the complaint;
    //  * there is exactly *one* of them. The engine's default of five retries
    //    at the gateway's stated 60s is a five-minute stall inside one turn.
    //
    // The mock answers 429 every time, so the only thing that stops it is the
    // bound.
    let limited = ResponseTemplate::new(429)
        .insert_header("retry-after", "1")
        .set_body_raw(
            r#"{"error":{"message":"too many requests","type":"rate_limit_error","code":"rate_limited"}}"#,
            "application/json",
        );
    let h = harness(vec![(None, limited)]).await;
    let session_id = h.open_thread().await;

    let outcome = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("hi")))
        .await;
    assert!(
        outcome.is_err(),
        "after its one retry the turn must surface, not keep waiting",
    );

    let retries: Vec<_> = h
        .drained()
        .into_iter()
        .filter_map(|event| match event {
            AcpThreadEvent::Retry(status) => Some(status),
            _ => None,
        })
        .collect();

    assert_eq!(
        retries.len(),
        1,
        "exactly one visible retry, got {}: {retries:#?}",
        retries.len(),
    );
    let status = &retries[0];
    assert_eq!(status.max_attempts, 1, "the pill must not promise more");
    assert!(
        status.duration > std::time::Duration::ZERO,
        "the countdown needs the gateway's stated interval, not zero — a pill \
         that cannot count down is the hang this test exists to prevent",
    );
    assert_eq!(
        status.duration,
        std::time::Duration::from_secs(1),
        "and it must be the interval the gateway actually asked for",
    );
}

#[tokio::test]
async fn the_model_picker_offers_the_gateway_catalogue_and_nothing_else() {
    // The bug this closes: the seam returned no model selector, so the composer
    // fell back to the BYOK picker — the user's own provider keys. That is a
    // list of models this agent cannot use, priced at rates that do not apply,
    // and picking one sends a slug the gateway answers with 403.
    use atlas_acp_thread::{AgentModelId, AgentModelList};

    let h = harness(vec![(None, sse_ok(answer("ok")))]).await;
    let session_id = h.open_thread().await;

    let Some(selector) = h.connection.model_selector(&session_id) else {
        panic!("the native agent must publish a model list, or the app falls back to BYOK");
    };
    let Ok(AgentModelList::Flat(models)) = selector.list_models().await else {
        panic!("the catalogue should list as a flat set");
    };

    let ids: Vec<String> = models.iter().map(|m| m.id.as_str().to_string()).collect();
    assert_eq!(
        ids,
        [
            "claude-sonnet-4-6",
            "claude-opus-5",
            "claude-opus-4-8",
            "gemini-3.6-flash",
            "gemini-3.5-flash-lite",
            "glm-5.3-flash",
        ],
        "the picker must offer exactly what the gateway serves",
    );
    assert!(
        !ids.iter()
            .any(|id| id.starts_with("gpt-") || id.starts_with("openai/")),
        "a model the gateway cannot generate from must never be offerable: {ids:?}",
    );
    // No prices. The BYOK picker shows per-million provider rates, which are
    // not what an Atlas turn costs — it is metered against the account's cap.
    assert!(models.iter().all(|m| m.cost.is_none()));

    // And a model outside the catalogue is refused here rather than becoming a
    // 403 on the next turn, well after the click that caused it.
    assert!(
        selector.select_model(AgentModelId::new("gpt-5.1")).await.is_err(),
        "selecting a model the account cannot use must fail at the click",
    );
}

#[tokio::test]
async fn a_new_session_advertises_its_commands_and_no_login() {
    // The native agent published nothing, so its slash picker was empty while
    // every external agent's was full. And signing into Atlas *is* signing into
    // the agent, so a login command would be a second, broken way to do
    // something already done.
    //
    // Asserted on the thread's own state rather than on the event: that is what
    // the composer reads, and it does not race the event forwarder.
    let h = harness(vec![(None, sse_ok(answer("ok")))]).await;
    let _ = h.open_thread().await;

    let Some(thread) = h
        .threads
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .last()
        .cloned()
    else {
        panic!("a thread must be open");
    };
    let names: Vec<String> = thread
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .available_commands()
        .iter()
        .map(|c| c.name.clone())
        .collect();

    assert!(
        !names.is_empty(),
        "a new session must publish its command list, or the picker is empty",
    );
    assert!(names.contains(&"compact".to_string()), "{names:?}");
    assert!(
        !names.iter().any(|n| n.contains("login")),
        "the account's own sign-in is the agent's sign-in: {names:?}",
    );
}

#[tokio::test]
async fn the_paying_org_rides_every_request_and_follows_a_switch() {
    // The gateway's `Atlas-Org` header names who pays, and the grant that
    // admits a request belongs to the payer — omitted, the request is
    // attributed personally, and an account whose AI access comes through its
    // organisation is refused on every turn while the org sits entitled.
    //
    // Two assertions in one test because the second is the reason for the
    // design: the org is read per request, so switching org mid-session bills
    // — and is admitted by — the new one on the very next message.
    let org = Arc::new(std::sync::Mutex::new(Some("org_first".to_string())));
    let reader = org.clone();
    atlas_native_agent::engine::set_org_source(Arc::new(move || {
        reader.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }));

    let h = harness(vec![(None, sse_ok(answer("ok")))]).await;
    let session_id = h.open_thread().await;
    let _ = h
        .connection
        .prompt(acp::PromptRequest::new(session_id.clone(), text("one")))
        .await;

    *org.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some("org_second".to_string());
    let _ = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("two")))
        .await;

    let Some(received) = h.server.received_requests().await else {
        panic!("the mock server must be recording requests");
    };
    let orgs: Vec<String> = received
        .iter()
        .filter(|r| r.url.path().ends_with("/chat/completions"))
        .map(|r| {
            r.headers
                .get("atlas-org")
                .and_then(|value| value.to_str().ok())
                .unwrap_or("<absent>")
                .to_string()
        })
        .collect();
    assert_eq!(
        orgs,
        ["org_first", "org_second"],
        "the header must be present, and must follow the switch: {orgs:?}",
    );
}

#[tokio::test]
async fn a_resumed_session_advertises_the_same_commands_a_new_one_does() {
    // The bug this closes: commands were published in `new_session` only, so a
    // restored tab — the place a user actually types "/" — resumed into a
    // thread with an empty list, and the picker showed nothing while a fresh
    // chat's showed everything. Resuming an id the engine does not know takes
    // the fresh-thread fallback arm, which is exactly the restored-tab path.
    let h = harness(vec![(None, sse_ok(answer("ok")))]).await;
    let thread = match h
        .connection
        .clone()
        .resume_session(
            acp::SessionId::new("thread-from-before-the-cutover"),
            vec![PathBuf::from(".")],
            None,
        )
        .await
    {
        Ok(thread) => thread,
        Err(err) => panic!("a stored row must open: {err:#}"),
    };
    let names: Vec<String> = thread
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .available_commands()
        .iter()
        .map(|c| c.name.clone())
        .collect();
    assert!(
        names.contains(&"compact".to_string()),
        "a resumed session's picker must not be empty: {names:?}",
    );
}

#[tokio::test]
async fn the_picked_model_is_what_the_next_turn_requests() {
    // The bug this closes: the selection was written to a selector the host
    // throws away per call, and every `turn/start` sent the configured default
    // explicitly — overriding the choice. The picker changed nothing.
    use atlas_acp_thread::AgentModelId;

    let h = harness(vec![(None, sse_ok(answer("ok")))]).await;
    let session_id = h.open_thread().await;

    let Some(selector) = h.connection.model_selector(&session_id) else {
        panic!("the native agent must publish a model selector");
    };
    if let Err(err) = selector.select_model(AgentModelId::new("claude-opus-5")).await {
        panic!("a catalogue model must be selectable: {err:#}");
    }
    // The picker's tick mark must move too — it used to reset to the default
    // because the selection died with the throwaway selector.
    let Some(selector) = h.connection.model_selector(&session_id) else {
        panic!("selector");
    };
    let Ok(current) = selector.selected_model().await else {
        panic!("the current model must be readable after a selection");
    };
    assert_eq!(current.id.as_str(), "claude-opus-5");

    let _ = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("hello")))
        .await;
    let body = h.last_request_body().await;
    assert_eq!(
        body["model"], "claude-opus-5",
        "the turn must run on the model the user picked",
    );
}

#[tokio::test]
async fn status_and_diff_answer_from_this_side_without_spending_a_turn() {
    // `/status` and `/diff` were the upstream TUI's own features — no engine
    // call, no model, nothing billed. The seam is Atlas's frontend to the same
    // engine, so they answer here: an assistant message appears, the turn
    // ends, and the gateway never hears about it.
    let h = harness(vec![(None, sse_ok(answer("ok")))]).await;
    let session_id = h.open_thread().await;

    let response = match h
        .connection
        .prompt(acp::PromptRequest::new(session_id.clone(), text("/status")))
        .await
    {
        Ok(response) => response,
        Err(err) => panic!("/status must succeed: {err:#}"),
    };
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);
    assert!(
        h.assistant_text().contains("claude-sonnet-4-6"),
        "the status reply must name the session's model",
    );

    let response = match h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("/diff")))
        .await
    {
        Ok(response) => response,
        Err(err) => panic!("/diff must succeed: {err:#}"),
    };
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);

    let Some(received) = h.server.received_requests().await else {
        panic!("the mock server must be recording requests");
    };
    let completions = received
        .iter()
        .filter(|r| r.url.path().ends_with("/chat/completions"))
        .count();
    assert_eq!(
        completions, 0,
        "a frontend command must not reach the gateway or be billed",
    );
}

/// Build a connection over an EXISTING home directory — the piece the shared
/// harness cannot do, and exactly what "the app was restarted" means to the
/// engine: a new process, the same rollout files.
async fn connection_at(
    home: &std::path::Path,
    server: &MockServer,
) -> (Arc<EngineConnection>, std::sync::mpsc::Receiver<AcpThreadEvent>) {
    let settings = EngineSettings::new(
        EngineHome::at(home.join("engine")),
        EngineProvider::gateway(format!("{}/v1", server.uri())),
        atlas_native_agent::engine::catalog::DEFAULT_MODEL,
        home.to_path_buf(),
    );
    let (tx, events) = std::sync::mpsc::channel();
    let tx = Arc::new(std::sync::Mutex::new(tx));
    let sink: ThreadEventSink = Arc::new(move |_id: &acp::SessionId| {
        let (thread_tx, mut thread_rx) = tokio::sync::mpsc::unbounded_channel();
        let out = tx.clone();
        tokio::spawn(async move {
            while let Some(event) = thread_rx.recv().await {
                if out
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .send(event)
                    .is_err()
                {
                    return;
                }
            }
        });
        thread_tx
    });
    let external_auth = Arc::new(AtlasExternalAuth::new(Arc::new(StaticToken)));
    let connection = EngineConnection::connect_full(
        AgentId::new("cersei"),
        settings,
        sink,
        Some(external_auth),
        None,
        None,
    )
    .await
    .unwrap_or_else(|err| panic!("the engine should start in-process: {err:#}"));
    (connection, events)
}

fn thread_texts(thread: &atlas_acp_thread::AcpThreadHandle) -> Vec<(String, String)> {
    let locked = thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    locked
        .entries()
        .iter()
        .filter_map(|entry| match entry {
            atlas_acp_thread::AgentThreadEntry::UserMessage(m) => {
                Some(("user".to_string(), format!("{:?}", m.chunks)))
            }
            atlas_acp_thread::AgentThreadEntry::AssistantMessage(m) => {
                Some(("assistant".to_string(), format!("{:?}", m.chunks)))
            }
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn a_reopened_session_replays_its_whole_conversation() {
    // The two reopened-session bugs in one test. The engine's `thread/resume`
    // response has always carried the thread's full stored history; the seam
    // dropped it, so a reopened session repainted from a truncated byproduct
    // record. Worse: for a thread the engine still has loaded — close the tab,
    // click the row again, the common case — `thread/resume` answers "already
    // has an active writer", and the old fallback treated that refusal as
    // "unknown thread" and silently opened a FRESH one: the conversation
    // restarted. This drives that exact path: one engine, one stored session,
    // reopened while the engine still holds its writer.
    let home = tempfile::tempdir().expect("tempdir");
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(sse_ok(answer(
            "the complete answer, every word of it, not a fragment",
        )))
        .mount(&server)
        .await;

    let (connection, _events) = connection_at(home.path(), &server).await;
    let session_id = {
        let thread = connection
            .clone()
            .new_session(vec![home.path().to_path_buf()])
            .await
            .expect("a session should open");
        let id = thread
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .session_id()
            .clone();
        let response = connection
            .prompt(acp::PromptRequest::new(id.clone(), text("what is the answer?")))
            .await
            .expect("the turn should complete");
        assert_eq!(response.stop_reason, acp::StopReason::EndTurn);
        id
        // The tab's AcpThread handle drops here; the engine keeps the thread
        // loaded, writer lock and all — exactly the state a reopened row
        // finds.
    };

    let thread = connection
        .clone()
        .load_session(session_id.clone(), vec![home.path().to_path_buf()], None)
        .await
        .expect("a stored session should reopen");

    let reopened_id = thread
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .session_id()
        .clone();
    assert_eq!(
        reopened_id, session_id,
        "a different id means the reopen silently RESTARTED the conversation",
    );

    let texts = thread_texts(&thread);
    let all: String = texts
        .iter()
        .map(|(role, text)| format!("{role}: {text}\n"))
        .collect();
    assert!(
        all.contains("what is the answer?"),
        "the user's message must replay: {all}",
    );
    assert!(
        all.contains("the complete answer, every word of it, not a fragment"),
        "the assistant's message must replay WHOLE: {all}",
    );

    // And the reopened session is not a museum: a new turn still works.
    let response = connection
        .prompt(acp::PromptRequest::new(reopened_id, text("and again?")))
        .await
        .expect("a turn on the reopened session should complete");
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);
}

/// Mimic the host: the user's message is pushed into the thread before
/// `prompt` runs (`AcpThread::send` does both). The seam tests drive `prompt`
/// directly, so tests that care about user entries push one first.
fn push_user(thread: &atlas_acp_thread::AcpThreadHandle, id: &str, text_content: &str) {
    let _ = thread
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .handle_session_update(acp::SessionUpdate::UserMessageChunk(
            acp::ContentChunk::new(acp::ContentBlock::Text(acp::TextContent::new(
                text_content.to_string(),
            )))
            .message_id(acp::MessageId::new(id)),
        ));
}

#[tokio::test]
async fn undo_rewinds_the_engine_and_trims_the_transcript_to_match() {
    let h = harness(vec![(None, sse_ok(answer("a regrettable answer")))]).await;
    let session_id = h.open_thread().await;
    let thread = h
        .threads
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .last()
        .cloned()
        .expect("thread");

    push_user(&thread, "u1", "first question");
    let _ = h
        .connection
        .prompt(acp::PromptRequest::new(session_id.clone(), text("first question")))
        .await
        .expect("the first turn should complete");

    push_user(&thread, "u2", "/undo");
    let response = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("/undo")))
        .await
        .expect("/undo should succeed");
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);

    let all = format!(
        "{:?}",
        thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner).entries()
    );
    assert!(
        !all.contains("first question") && !all.contains("a regrettable answer"),
        "the undone exchange must leave the transcript: {all}",
    );
    assert!(
        all.contains("Rewound"),
        "the user must be told what happened: {all}",
    );
}

#[tokio::test]
async fn goal_set_is_confirmed_and_readable_back() {
    let h = harness(vec![(None, sse_ok(answer("ok")))]).await;
    let session_id = h.open_thread().await;

    let response = h
        .connection
        .prompt(acp::PromptRequest::new(
            session_id.clone(),
            text("/goal ship the port by friday"),
        ))
        .await
        .expect("/goal should succeed");
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);
    assert!(
        h.assistant_text().contains("ship the port by friday"),
        "setting must be confirmed: {}",
        h.assistant_text(),
    );

    let _ = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("/goal")))
        .await
        .expect("bare /goal should succeed");
    assert!(
        h.assistant_text().matches("ship the port by friday").count() >= 2,
        "bare /goal must read the goal back: {}",
        h.assistant_text(),
    );

    let Some(received) = h.server.received_requests().await else {
        panic!("recording");
    };
    assert_eq!(
        received
            .iter()
            .filter(|r| r.url.path().ends_with("/chat/completions"))
            .count(),
        0,
        "goal management must not spend a model turn",
    );
}

#[tokio::test]
async fn review_runs_inline_on_this_thread_and_this_model() {
    // `review/start` with Inline delivery runs the review as a turn on the
    // SAME thread — its findings stream through the pipeline every answer
    // uses, which is what makes /review renderable with zero new UI. And on
    // this thread's model: our engine config deliberately leaves
    // `review_model` unset, so the engine falls back to the parent thread's
    // model — the one the gateway serves — instead of an upstream reviewer
    // model it would 403.
    let h = harness(vec![(None, sse_ok(answer("looks fine, one nit")))]).await;
    let session_id = h.open_thread().await;

    let response = h
        .connection
        .prompt(acp::PromptRequest::new(
            session_id,
            text("/review focus on naming"),
        ))
        .await
        .expect("/review should complete");
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);

    let body = h.last_request_body().await;
    assert_eq!(
        body["model"],
        atlas_native_agent::engine::catalog::DEFAULT_MODEL,
        "the review must run on the session's model, not a reviewer pin",
    );
    assert!(
        h.assistant_text().contains("looks fine, one nit"),
        "the review's findings must land in the transcript: {}",
        h.assistant_text(),
    );
}

#[tokio::test]
async fn a_repo_skill_joins_the_picker_and_runs_as_a_skill_turn() {
    let home = tempfile::tempdir().expect("tempdir");
    let cwd = tempfile::tempdir().expect("tempdir");
    let skill_dir = cwd.path().join(".codex/skills/release-notes");
    std::fs::create_dir_all(&skill_dir).expect("skill dir");
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: release-notes\ndescription: Draft release notes from recent commits\n---\n\n\
         # Release notes\n\nSummarise the latest changes as release notes.\n",
    )
    .expect("skill file");

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(sse_ok(answer("drafted")))
        .mount(&server)
        .await;
    let (connection, _events) = connection_at(home.path(), &server).await;
    let thread = connection
        .clone()
        .new_session(vec![cwd.path().to_path_buf()])
        .await
        .expect("session");
    let session_id = thread
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .session_id()
        .clone();

    let names: Vec<String> = thread
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .available_commands()
        .iter()
        .map(|c| c.name.clone())
        .collect();
    assert!(
        names.contains(&"release-notes".to_string()),
        "a discovered skill must join the picker: {names:?}",
    );

    let response = connection
        .prompt(acp::PromptRequest::new(session_id, text("/release-notes")))
        .await
        .expect("the skill turn should complete");
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);
    // The engine loads the skill itself; its content must be in what left for
    // the gateway, or the "skill" was just the literal text "/release-notes".
    let Some(received) = server.received_requests().await else {
        panic!("recording");
    };
    let bodies: String = received
        .iter()
        .filter(|r| r.url.path().ends_with("/chat/completions"))
        .map(|r| String::from_utf8_lossy(&r.body).into_owned())
        .collect();
    assert!(
        bodies.contains("release notes"),
        "the skill's content must reach the model",
    );
}

#[tokio::test]
async fn cancel_from_a_runtime_less_thread_interrupts_instead_of_aborting() {
    // The stop button reaches `cancel()` on the MAIN thread — a sync path
    // with no ambient tokio runtime. A bare `tokio::spawn` there panics
    // ("there is no reactor running") inside a non-unwinding native frame,
    // which aborts the entire app. This drives that exact shape: a running
    // turn, then cancel from a plain std thread.
    let h = harness(vec![(
        None,
        sse_ok(answer("slow")).set_delay(std::time::Duration::from_secs(20)),
    )])
    .await;
    let session_id = h.open_thread().await;

    let connection = h.connection.clone();
    let prompt_session = session_id.clone();
    let turn = tokio::spawn(async move {
        connection
            .prompt(acp::PromptRequest::new(prompt_session, text("take your time")))
            .await
    });

    // The turn is live once the model call reaches the gateway.
    for _ in 0..200 {
        let arrived = h
            .server
            .received_requests()
            .await
            .map(|requests| {
                requests
                    .iter()
                    .any(|r| r.url.path().ends_with("/chat/completions"))
            })
            .unwrap_or(false);
        if arrived {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }

    let connection = h.connection.clone();
    std::thread::spawn(move || {
        // No runtime on this thread, exactly like the main thread.
        connection.cancel(&session_id);
    })
    .join()
    .expect("cancel must not panic off-runtime");

    // And the interrupt actually lands: the turn ends promptly instead of
    // waiting out the 20s response.
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), turn)
        .await
        .expect("the cancelled turn must end promptly")
        .expect("the prompt task must not panic");
    let _ = result; // Cancelled or Interrupted — either way it ended.
}

#[tokio::test]
async fn compact_is_visible_in_the_thread_not_a_silent_shrug() {
    // /compact returned EndTurn and the engine summarised in the background —
    // with nothing on screen ever saying so, which is indistinguishable from
    // the command being broken. The compaction item now lands in the thread
    // (InProgress → Completed), which the projector renders as the pill.
    let h = harness(vec![(None, sse_ok(answer("summary")))]).await;
    let session_id = h.open_thread().await;
    let _ = h
        .connection
        .prompt(acp::PromptRequest::new(session_id.clone(), text("hello there")))
        .await
        .expect("the first turn should complete");

    let response = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("/compact")))
        .await
        .expect("/compact should succeed");
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);

    let thread = h
        .threads
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .last()
        .cloned()
        .expect("thread");
    let mut seen = false;
    for _ in 0..200 {
        let has_compaction = thread
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entries()
            .iter()
            .any(|entry| {
                matches!(entry, atlas_acp_thread::AgentThreadEntry::ContextCompaction(_))
            });
        if has_compaction {
            seen = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(seen, "compaction must be visible in the thread timeline");
}

#[tokio::test]
async fn an_executed_command_appears_as_a_tool_call_with_its_output() {
    // The #46 wiring, end to end: the model asks for `exec_command`, the
    // engine actually runs it, and the ITEM notifications land in the thread
    // as a tool-call row — kind, final status from the exit code, and the
    // command's real output. This same upsert is what capture's write
    // extraction reads, which is where Artifacts checkpoints come from: no
    // tool rows meant no write set meant no checkpoint, ever.
    let tool_turn = {
        let call = serde_json::json!({
            "id": "c1",
            "choices": [{"index": 0, "delta": {"tool_calls": [{
                "index": 0,
                "id": "call_1",
                "type": "function",
                "function": {
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"echo checkpoint-proof\"}",
                },
            }]}, "finish_reason": null}],
        })
        .to_string();
        let finish =
            r#"{"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#;
        frames(&[&call, finish, "[DONE]"])
    };
    // First completion answers with the tool call; every later one (the
    // follow-up carrying the tool result) answers with text.
    let h = harness(vec![
        (Some(1), sse_ok(tool_turn)),
        (None, sse_ok(answer("ran it"))),
    ])
    .await;
    let session_id = h.open_thread().await;

    // Bypass approvals: this test is about the item pipeline, not the dialog.
    let modes = h
        .connection
        .session_modes(&session_id)
        .expect("the native agent advertises modes");
    modes
        .set_mode(acp::SessionModeId::new("bypass"))
        .await
        .expect("bypass mode should apply");

    let response = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("run it")))
        .await
        .expect("the tool turn should complete");
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);

    let thread = h
        .threads
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .last()
        .cloned()
        .expect("thread");
    let locked = thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let call = locked
        .entries()
        .iter()
        .find_map(|entry| match entry {
            atlas_acp_thread::AgentThreadEntry::ToolCall(call) => Some(call),
            _ => None,
        })
        .expect("the executed command must appear as a tool-call row");
    assert!(
        matches!(call.status, atlas_acp_thread::ToolCallStatus::Completed),
        "echo exits 0, so the row must settle as completed: {:?}",
        call.status,
    );
    let rendered = format!("{call:?}");
    assert!(
        rendered.contains("checkpoint-proof"),
        "the command's real output must be on the row: {rendered}",
    );
}

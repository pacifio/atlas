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

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{AcpThreadEvent, AgentConnection, AgentId};
use atlas_agent_servers::ThreadEventSink;
use atlas_native_agent::engine::config::{EngineHome, EngineProvider, EngineSettings};
use atlas_native_agent::engine::connection::EngineConnection;
use atlas_engine_sandboxing::landlock::ATLAS_AGENT_LINUX_SANDBOX_ARG0;
use atlas_engine_test_binary_support::{
    TestBinaryDispatchGuard, TestBinaryDispatchMode, configure_test_binary_dispatch,
};
use serde_json::json;
use wiremock::matchers::method;
use wiremock::matchers::path;
use wiremock::{Mock, MockServer, ResponseTemplate};

// ---------------------------------------------------------------------------
// This test binary doubles as the Linux sandbox helper.
// ---------------------------------------------------------------------------
//
// On macOS the engine sandboxes a command with `/usr/bin/sandbox-exec`, which
// is already on disk. Linux has no equivalent: `SandboxType::LinuxSeccomp`
// re-execs a helper binary whose *arg0* is `atlas-engine-linux-sandbox`, and if the
// embedder supplied no path for one the engine returns
// `MissingLinuxSandboxExecutable` from the sandbox transform — before spawning
// anything. The tool call fails, the turn ends normally, and the three tests
// below that watch for a file on disk see nothing. That is exactly the CI
// failure they showed: `EndTurn` instead of `Cancelled`, and a command that
// "ran 0 times".
//
// Atlas ships macOS and has no arg0 dispatch, so the app has no helper to
// offer (see `EngineSettings::linux_sandbox_exe`). The tests do: upstream's own
// suites make the *test binary* the helper, and this is that same construction
// — `vendor/atlas-engine/core/tests/suite/mod.rs`. The `#[ctor]` runs before any test
// thread exists, which is what makes the `set_var`/PATH work inside it sound.
// Re-entered under one of the helper identities it dispatches and never
// returns; on the ordinary first entry it installs the arg0 aliases and hands
// back a guard naming their paths.
#[ctor::ctor]
static TEST_BINARY_DISPATCH: Option<TestBinaryDispatchGuard> = {
    configure_test_binary_dispatch("atlas-native-agent-tests", |exe_name, argv1| {
        #[cfg(unix)]
        if argv1 == Some(atlas_engine_exec_server::ATLAS_AGENT_ARG0_EXEC_HELPER_ARG1) {
            return TestBinaryDispatchMode::DispatchArg0Only;
        }
        if argv1 == Some(atlas_engine_exec_server::ATLAS_AGENT_FS_HELPER_ARG1) {
            return TestBinaryDispatchMode::DispatchArg0Only;
        }
        if exe_name == ATLAS_AGENT_LINUX_SANDBOX_ARG0 {
            return TestBinaryDispatchMode::DispatchArg0Only;
        }
        TestBinaryDispatchMode::InstallAliases
    })
};

/// The helper path the engine is handed on Linux, and nothing elsewhere.
///
/// The alias the guard installed is preferred over `current_exe()` because its
/// basename is `atlas-engine-linux-sandbox`, which is what re-triggers arg0 dispatch
/// on bubblewrap builds that cannot pass `--argv0`.
#[cfg(target_os = "linux")]
fn test_linux_sandbox_exe() -> Option<PathBuf> {
    TEST_BINARY_DISPATCH
        .as_ref()
        .and_then(|guard| guard.paths().atlas_engine_linux_sandbox_exe.clone())
        .or_else(|| std::env::current_exe().ok())
}

#[cfg(not(target_os = "linux"))]
fn test_linux_sandbox_exe() -> Option<PathBuf> {
    None
}

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

/// Like [`assistant_turn`], with a real token-usage block (#74).
fn assistant_turn_with_usage(text: &str) -> String {
    sse(vec![
        json!({"type": "response.created", "response": {"id": "resp-u"}}),
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
                "id": "resp-u",
                "usage": {
                    "input_tokens": 100, "input_tokens_details": {"cached_tokens": 40},
                    "output_tokens": 42, "output_tokens_details": null,
                    "total_tokens": 142
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
        self.open_thread_in(PathBuf::from(".")).await
    }

    /// Open a thread rooted at a specific directory.
    ///
    /// A test whose command WRITES a file has to say where: the engine runs
    /// tools under a workspace-write sandbox, so a path outside the session's
    /// roots is denied — silently, as far as the protocol is concerned. On
    /// macOS seatbelt a tempdir under `/tmp` slips through anyway; Linux
    /// landlock does not, which is why those tests passed locally and failed
    /// in CI with the command never having run.
    async fn open_thread_in(&self, root: PathBuf) -> acp::SessionId {
        let thread = self
            .connection
            .clone()
            .new_session(vec![root])
            .await
            .expect("the engine should start a thread");
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

    /// The assistant text currently rendered in the newest thread.
    fn assistant_text(&self) -> String {
        let thread = self.thread();
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

    fn thread(&self) -> atlas_acp_thread::AcpThreadHandle {
        self.threads
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
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
    session_mcp: Option<Arc<dyn atlas_agent_servers::SessionMcpServers>>,
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

    let mut settings = EngineSettings::new(
        EngineHome::at(home.path().join("engine")),
        EngineProvider::dev(
            "atlas-test",
            format!("{}/v1", server.uri()),
            Some(key_var.to_string()),
        ),
        Some("test-model".to_string()),
        home.path().to_path_buf(),
    );
    // Production leaves this `None`. Without it every sandboxed command in this
    // file is refused before it spawns on Linux — see the module header.
    settings.linux_sandbox_exe = test_linux_sandbox_exe();
    let settings = tune(settings);

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

    let connection = EngineConnection::connect_full(
        AgentId::new("atlas-agent"),
        settings,
        sink,
        None,
        None,
        session_mcp,
        // The Responses dialect pins its model; no catalogue is fetched.
        None,
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
async fn token_usage_reaches_the_thread_the_app_reads() {
    // #74. The engine emits `thread/tokenUsage/updated` after a completion,
    // and everything downstream of the thread is already built: the
    // TokenUsageUpdated event drives the projector's UsageUpdated delta,
    // which is what the Timeline's token-consumption display and capture's
    // record_usage consume. The sink ignoring the notification is why the
    // native agent — the one agent that reports a REAL input/output split —
    // showed no consumption at all.
    let h = harness(assistant_turn_with_usage("ok")).await;
    let session_id = h.open_thread().await;

    h.connection
        .prompt(acp::PromptRequest::new(session_id, text("count me")))
        .await
        .expect("the turn should complete");

    let thread = h.thread();
    let locked = thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let usage = locked
        .token_usage()
        .expect("a turn that reported usage must leave it on the thread");
    assert_eq!(usage.input_tokens, 100);
    assert_eq!(usage.output_tokens, 42);
    // The cached share of the prompt is real spend at a different price; it
    // rides along rather than being folded into `input_tokens` or dropped.
    assert_eq!(usage.cache_read_tokens, 40);
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

    // ONE press, like production (#57). The earlier version of this test
    // retried cancel in a 100 ms loop, which could never fail on the lost
    // press: a stop landing while `turn/start` is still in flight used to be
    // silently dropped, and the loop's next iteration papered over it. The
    // press may land before or after the turn registers — the seam records
    // a too-early stop and honours it the moment the turn id exists, so a
    // single press must take the turn down from either side of that line.
    // (`connection.rs` unit-tests both interleavings deterministically.)
    tokio::time::sleep(Duration::from_millis(500)).await;
    h.connection.cancel(&session_id);

    let response = tokio::time::timeout(Duration::from_secs(20), prompting)
        .await
        .expect("one press must take the turn down — 20s later it was still running")
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
async fn a_mode_switch_during_a_turn_is_refused_rather_than_relabelling_the_picker() {
    // #61. The engine's `update_settings` writes the session configuration; a
    // RUNNING turn keeps the frozen context it started with. Accepting the
    // switch mid-turn would flip the picker to "Plan — read-only, no edits or
    // commands" while the turn's remaining tool calls execute with whatever
    // the turn began with — a security control displayed as active while
    // absent. Refusing is the honest answer.
    let h = harness_with(vec![
        (
            Some(1),
            sse_ok(assistant_turn("slow answer")).set_delay(Duration::from_secs(5)),
        ),
        (None, sse_ok(assistant_turn("ok"))),
    ])
    .await;
    let session_id = h.open_thread().await;
    let modes = h.connection.session_modes(&session_id).expect("modes");

    let connection = h.connection.clone();
    let prompting = {
        let session_id = session_id.clone();
        tokio::spawn(async move {
            connection
                .prompt(acp::PromptRequest::new(session_id, text("take your time")))
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(500)).await;

    assert!(
        modes.set_mode(acp::SessionModeId::new("plan")).await.is_err(),
        "a mid-turn mode switch must be refused, not displayed",
    );
    assert_eq!(
        modes.current_mode().to_string(),
        "default",
        "the picker must keep reporting the mode really in force",
    );

    let response = prompting
        .await
        .expect("the prompt task should not panic")
        .expect("the refused switch must not break the running turn");
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);

    // With the turn over, the same switch is accepted.
    modes
        .set_mode(acp::SessionModeId::new("plan"))
        .await
        .expect("the switch is accepted once nothing is running");
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
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
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
    // "the work ended" — and the started marker is what makes its absence mean
    // anything: without it, a command that never ran (refused, sandboxed out of
    // the directory, not yet spawned when the cancel landed) passes too.
    let dir = tempfile::tempdir().expect("tempdir");
    let started = dir.path().join("started");
    let marker = dir.path().join("survived-the-cancel");
    let command = format!(
        "touch {}; sleep 5; touch {}",
        started.to_string_lossy(),
        marker.to_string_lossy(),
    );

    let h = harness_with(vec![
        (Some(1), sse_ok(command_turn(&command))),
        (None, sse_ok(assistant_turn("done"))),
    ])
    .await;
    let session_id = h.open_thread_in(dir.path().to_path_buf()).await;

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

    // Cancel only once the command is provably running.
    tokio::time::timeout(Duration::from_secs(20), async {
        while !started.exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the command never started, so a cancel could prove nothing");
    let started_at = tokio::time::Instant::now();
    assert!(
        !prompting.is_finished(),
        "the turn ended before it was cancelled"
    );

    // ONE press, like production (#57) — see the note in
    // `a_cancelled_turn_ends_aborted_rather_than_hanging_or_ending_normally`.
    // A retry loop here would hide a lost press.
    h.connection.cancel(&session_id);

    let response = tokio::time::timeout(Duration::from_secs(20), prompting)
        .await
        .expect("one press must take the turn down — 20s later it was still running")
        .expect("the prompt task should not panic")
        .expect("a cancelled turn is an outcome, not an error");
    assert_eq!(response.stop_reason, acp::StopReason::Cancelled);

    // Past when the command would have finished had it survived.
    tokio::time::sleep_until(started_at + Duration::from_secs(6)).await;
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
    let session_id = h.open_thread_in(dir.path().to_path_buf()).await;

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
    let session_id = h.open_thread_in(dir.path().to_path_buf()).await;

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
// #83 — the memory tool server, handed to the engine as an MCP server.
// ---------------------------------------------------------------------------

/// A turn that calls the memory server's `memory_search`, then answers.
fn memory_search_turn(arguments: serde_json::Value) -> String {
    sse(vec![
        json!({"type": "response.created", "response": {"id": "resp-1"}}),
        json!({
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call-mem",
                "namespace": "mcp__atlas_memory",
                "name": "memory_search",
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

#[path = "support/memory_server.rs"]
mod memory_server;
use memory_server::OfferingMemory;

#[tokio::test(flavor = "multi_thread")]
async fn the_engine_is_handed_the_memory_server_and_a_turn_calls_memory_search() {
    let (url, calls) = memory_server::start().await;
    let offering = Arc::new(OfferingMemory {
        url,
        asked: std::sync::Mutex::new(Vec::new()),
        settled: Arc::default(),
    });
    let h = harness_full(
        vec![
            (Some(1), sse_ok(memory_search_turn(json!({"query": "how do we sign tokens"})))),
            (None, sse_ok(assistant_turn("grounded answer"))),
        ],
        |s| s,
        Some(offering.clone() as Arc<dyn atlas_agent_servers::SessionMcpServers>),
    )
    .await;
    assert!(
        h.connection.supports_http_mcp(),
        "the engine takes StreamableHttp MCP servers",
    );
    let session_id = h.open_thread().await;

    let asked = offering.asked.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
    assert_eq!(asked.len(), 1, "one offer per session request");
    assert!(asked[0].http_mcp);
    assert!(asked[0].ui_control, "the in-process engine carries UI control (ADR-0012)");
    assert!(asked[0].org_access, "the in-process engine carries organisation access (ADR-0014)");
    assert_eq!(asked[0].agent_id.as_str(), "atlas-agent");
    assert_eq!(asked[0].session_id, None, "a new thread has no id until the engine answers");
    assert_eq!(
        *offering.settled.lock().unwrap_or_else(std::sync::PoisonError::into_inner),
        vec![Some(session_id.to_string())],
        "the offer is bound to the engine's thread id",
    );

    let response = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("how do we sign tokens?")))
        .await
        .expect("the turn should complete");
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);

    let calls = calls.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
    assert_eq!(calls.len(), 1, "the engine should have called memory_search once: {calls:?}");
    assert_eq!(calls[0].0, "Bearer session-token", "with the session's token");
    assert_eq!(calls[0].1, json!({"query": "how do we sign tokens"}));
}

// ---------------------------------------------------------------------------
// #118 — outward actions ask first (ADR-0014), through the real engine.
//
// The projection makes `org_comment_reply` a `prompt` tool on `atlas_org`; the
// engine then stops before the call and asks with an MCP elicitation of its
// own, which the seam puts on the approval card. The witness is the tool
// server's own call log: a declined reply never reaches it.
// ---------------------------------------------------------------------------

/// A turn that calls `atlas_org`'s `org_comment_reply`, then answers.
fn reply_turn() -> String {
    outward_turn("org_comment_reply", json!({ "comment": "k1", "body": "Renamed it." }))
}

/// A turn that calls `atlas_org`'s outward `tool` with `arguments`, then
/// answers.
fn outward_turn(tool: &str, arguments: serde_json::Value) -> String {
    sse(vec![
        json!({"type": "response.created", "response": {"id": "resp-1"}}),
        json!({
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call-outward",
                "namespace": "mcp__atlas_org",
                "name": tool,
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

/// Offers one stand-in server as `atlas_org`, and keeps the approvals the
/// seam reports as the app's offers do ([`atlas_agent_servers::OutwardConsent`]),
/// with the session its offer was bound to.
struct OfferingOrg {
    url: String,
    consent: Arc<atlas_agent_servers::OutwardConsent>,
    session: Arc<std::sync::Mutex<Option<String>>>,
}

impl atlas_agent_servers::SessionMcpServers for OfferingOrg {
    fn offer(&self, _request: &atlas_agent_servers::SessionMcpRequest) -> atlas_agent_servers::SessionMcpOffer {
        let server = acp::McpServer::Http(
            acp::McpServerHttp::new("atlas_org", self.url.clone())
                .headers(vec![acp::HttpHeader::new("Authorization", "Bearer session-token")]),
        );
        let session = self.session.clone();
        atlas_agent_servers::SessionMcpOffer::new(vec![server], move |id| {
            *session.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = id.map(ToString::to_string);
        })
        // As the app's offer declares them: the host names its outward tools.
        .asking_first(atlas_agent_servers::AskFirst::none().on("atlas_org", &["org_comment_reply", "org_send"]))
    }

    fn approved_call(&self, call: atlas_agent_servers::CallToApprove<'_>) {
        self.consent.record(call);
    }
}

/// A stand-in `atlas_org` that posts a reply only when the user approved that
/// exact call — the organisation tool server's own check — and the offer
/// that hands it to a session.
async fn consenting_org() -> (Arc<dyn atlas_agent_servers::SessionMcpServers>, memory_server::Calls) {
    consenting_org_for("org_comment_reply").await
}

/// [`consenting_org`], standing in for the outward `tool`.
async fn consenting_org_for(
    tool: &'static str,
) -> (Arc<dyn atlas_agent_servers::SessionMcpServers>, memory_server::Calls) {
    let consent = Arc::new(atlas_agent_servers::OutwardConsent::new());
    let session: Arc<std::sync::Mutex<Option<String>>> = Arc::default();
    let gate: memory_server::Gate = {
        let (consent, session) = (consent.clone(), session.clone());
        Arc::new(move |arguments| {
            let session = session.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
            session.is_some_and(|id| consent.take(&id, "atlas_org", tool, arguments))
        })
    };
    let (url, calls) = memory_server::start_gated(tool, gate).await;
    (Arc::new(OfferingOrg { url, consent, session }), calls)
}

/// A reply turn against a stand-in `atlas_org`, answered with `pick`.
/// Returns the tool server's calls and every request the model was sent.
async fn reply_answered_with(
    pick: acp::PermissionOptionKind,
) -> (Vec<(String, serde_json::Value)>, Vec<String>) {
    outward_answered_with("org_comment_reply", json!({ "comment": "k1", "body": "Renamed it." }), pick).await
}

/// A turn calling the outward `tool` with `arguments` against a stand-in
/// `atlas_org`, answered with `pick`. Returns the tool server's calls and
/// every request the model was sent.
async fn outward_answered_with(
    tool: &'static str,
    arguments: serde_json::Value,
    pick: acp::PermissionOptionKind,
) -> (Vec<(String, serde_json::Value)>, Vec<String>) {
    let (org, calls) = consenting_org_for(tool).await;
    let h = harness_full(
        vec![(Some(1), sse_ok(outward_turn(tool, arguments))), (None, sse_ok(assistant_turn("ok")))],
        |s| s,
        Some(org),
    )
    .await;
    let session_id = h.open_thread().await;
    let connection = h.connection.clone();
    let prompting = tokio::spawn(async move {
        connection
            .prompt(acp::PromptRequest::new(session_id, text("reply on the comment")))
            .await
    });

    answer_first_authorization(&h, pick)
        .await
        .expect("the engine should have asked before the reply");
    let response = tokio::time::timeout(Duration::from_secs(30), prompting)
        .await
        .expect("the turn should not hang once the card is answered")
        .expect("the prompt task should not panic")
        .expect("the turn should complete");
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);

    let calls = calls.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
    let sent = h
        ._server
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .map(|r| String::from_utf8_lossy(&r.body).into_owned())
        .collect();
    (calls, sent)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_declined_reply_is_never_posted_and_the_model_is_told_it_was_rejected() {
    let (calls, sent) = reply_answered_with(acp::PermissionOptionKind::RejectOnce).await;
    assert!(calls.is_empty(), "the tool server was never called: {calls:?}");
    assert!(
        sent.last().is_some_and(|body| body.contains("user rejected MCP tool call")),
        "the model reads the rejection as the call's error",
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_allowed_reply_is_posted_once() {
    let (calls, _) = reply_answered_with(acp::PermissionOptionKind::AllowOnce).await;
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0].1, json!({ "comment": "k1", "body": "Renamed it." }));
}

/// #120: a message is the same kind of outward action, declared by the host
/// beside the reply — it asks, and only an allowed send reaches the server.
#[tokio::test(flavor = "multi_thread")]
async fn an_allowed_send_is_posted_once_and_a_declined_one_never() {
    let args = json!({ "to": "general", "body": "The importer is fixed." });
    let (calls, _) = outward_answered_with("org_send", args.clone(), acp::PermissionOptionKind::AllowOnce).await;
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0].1, args);
    let (calls, sent) = outward_answered_with("org_send", args, acp::PermissionOptionKind::RejectOnce).await;
    assert!(calls.is_empty(), "a declined send never reaches the server: {calls:?}");
    assert!(sent.last().is_some_and(|body| body.contains("user rejected MCP tool call")));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reply_allowed_for_the_session_is_posted() {
    let (calls, _) = reply_answered_with(acp::PermissionOptionKind::AllowAlways).await;
    assert_eq!(calls.len(), 1, "{calls:?}");
}

/// Bypass is `AskForApproval::Never` over full access, and the engine
/// auto-approves every MCP permission prompt under exactly that pair
/// (`mcp_permission_prompt_is_auto_approved`) — a per-tool `prompt` included —
/// so it runs the reply with no card. The seam never asked, so it reported no
/// approval, and the tool server refuses: nothing is posted, and the model
/// reads why (ADR-0014). (Plan mode, `Never` over read-only, is not
/// auto-approved there; the engine's `Never` declines the call itself.)
#[tokio::test(flavor = "multi_thread")]
async fn in_bypass_mode_an_outward_action_is_refused_and_nothing_is_posted() {
    let (org, calls) = consenting_org().await;
    let h = harness_full(
        vec![(Some(1), sse_ok(reply_turn())), (None, sse_ok(assistant_turn("ok")))],
        |s| s,
        Some(org),
    )
    .await;
    let session_id = h.open_thread().await;
    h.connection
        .session_modes(&session_id)
        .expect("modes")
        .set_mode(acp::SessionModeId::new("bypass"))
        .await
        .expect("bypass is a mode");
    let response = tokio::time::timeout(
        Duration::from_secs(30),
        h.connection.prompt(acp::PromptRequest::new(session_id, text("reply on the comment"))),
    )
    .await
    .expect("nothing waits on a card in bypass")
    .expect("the turn should complete");
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);
    assert!(
        !h.drained().iter().any(|e| matches!(e, AcpThreadEvent::ToolAuthorizationRequested { .. })),
        "no card was raised",
    );
    let calls = calls.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
    assert!(calls.is_empty(), "nothing is posted unasked: {calls:?}");
    let sent: Vec<String> = h
        ._server
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .map(|r| String::from_utf8_lossy(&r.body).into_owned())
        .collect();
    assert!(
        sent.last().is_some_and(|body| body.contains("not approved by the user")),
        "the model reads the refusal as the call's result",
    );
}

#[tokio::test]
async fn no_dynamic_memory_tool_is_declared_any_more() {
    // `search_memory` is gone; `memory_search` over MCP replaced it. A model
    // that still calls the old name is answered, not left hanging.
    let h = harness_with(vec![
        (
            Some(1),
            sse_ok(sse(vec![
                json!({"type": "response.created", "response": {"id": "resp-1"}}),
                json!({
                    "type": "response.output_item.done",
                    "item": {
                        "type": "function_call",
                        "call_id": "call-old",
                        "name": "search_memory",
                        "arguments": "{\"query\": \"x\"}"
                    }
                }),
                json!({"type": "response.completed", "response": {"id": "resp-1", "usage": {
                    "input_tokens": 0, "input_tokens_details": null,
                    "output_tokens": 0, "output_tokens_details": null, "total_tokens": 0}}}),
            ])),
        ),
        (None, sse_ok(assistant_turn("ok"))),
    ])
    .await;
    let session_id = h.open_thread().await;
    let response = h
        .connection
        .prompt(acp::PromptRequest::new(session_id, text("hello")))
        .await
        .expect("a call to a tool that no longer exists must not hang the turn");
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);
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
            acp::SessionId::new("a-pre-rename-session-id"),
            vec![PathBuf::from(".")],
            Some("An old conversation".into()),
        )
        .await
        .expect("a pre-cutover row must open rather than error");

    let session_id = thread
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .session_id()
        .clone();
    h.threads
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
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
async fn the_engine_advertises_load_because_reopening_genuinely_replays() {
    // This asserted the OPPOSITE through the cutover — resume-not-load — and
    // that was correct then: the seam threw the engine's stored turns away, so
    // "resumed without history" was the honest notice. The turns replay now
    // (`engine::replay`), so advertising resume would show that notice over a
    // fully repainted transcript: the notice lying the other way. The one row
    // that still opens empty is a pre-cutover id the engine never saw, via the
    // fresh-thread fallback (D6's accepted loss, now correctly narrow).
    let h = harness(assistant_turn("ok")).await;
    assert!(
        h.connection.supports_load_session(),
        "reopening replays, so load is the honest capability",
    );
    assert!(h.connection.supports_resume_session());
    assert!(h.connection.supports_session_history());
}

#[tokio::test]
async fn the_native_agent_answers_to_its_stored_agent_id() {
    // The stored agent id is a storage key, not a display name: every thread
    // row the store writes for the native agent resolves through this string
    // (ADR-0011), so the connection must report exactly it.
    let h = harness(assistant_turn("ok")).await;
    assert_eq!(h.connection.agent_id().as_str(), "atlas-agent");
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

    assert!(
        h.drained()
            .into_iter()
            .any(|event| atlas_thread_metadata::affects_thread_metadata(&event)),
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

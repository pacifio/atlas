//! Unit-level tests for the pieces of the transport that can be exercised
//! without an agent: the session bookkeeping, the directory rules, the debug
//! tap, and the environment workarounds.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{event_channel, AcpThread, AgentId};
use atlas_agent_servers::*;

mod support;
use support::stub::stub_connection;

fn session_id(id: &str) -> acp::SessionId {
    acp::SessionId::new(id)
}

fn thread_handle(id: &str) -> Arc<Mutex<AcpThread>> {
    let (tx, rx) = event_channel();
    // Hold the receiver alive; a closed channel would make every emit fail and
    // is not what these tests are about.
    Box::leak(Box::new(rx));
    Arc::new(Mutex::new(AcpThread::new(
        session_id(id),
        stub_connection(),
        vec![PathBuf::from("/tmp")],
        None,
        tx,
    )))
}

fn registered(registry: &SessionRegistry, id: &str) -> Arc<Mutex<AcpThread>> {
    let thread = thread_handle(id);
    registry.insert(
        session_id(id),
        AcpSession {
            thread: Arc::downgrade(&thread),
            cancel_signal: CancelSignal::new(),
            session_modes: None,
            config_options: None,
            ref_count: 1,
        },
    );
    thread
}

// ------------------------------------------------------- session ref counting

/// A second opener adds a handle rather than a second session; the session only
/// really closes when the last one goes.
#[test]
fn a_session_closes_only_when_the_last_handle_is_released() {
    let registry = SessionRegistry::new();
    let _thread = registered(&registry, "s1");

    assert!(registry.acquire(&session_id("s1")).is_some());

    assert_eq!(registry.release(&session_id("s1")), Some(1));
    assert!(registry.contains(&session_id("s1")));

    assert_eq!(registry.release(&session_id("s1")), Some(0));
    assert!(!registry.contains(&session_id("s1")));
}

/// Releasing more times than acquiring must not underflow into a live session.
#[test]
fn releasing_an_unknown_session_is_not_an_error() {
    let registry = SessionRegistry::new();
    assert_eq!(registry.release(&session_id("ghost")), None);
}

/// The pending table is the source of truth while a load is in flight, because
/// the sessions entry is pre-registered to catch history replay and would
/// otherwise be counted twice.
#[test]
fn a_concurrent_open_joins_the_in_flight_load() {
    let registry = SessionRegistry::new();

    assert!(
        !registry.pending_acquire(&session_id("s1")),
        "nothing is in flight yet"
    );

    registry.pending_begin(session_id("s1"));
    assert!(registry.pending_acquire(&session_id("s1")));

    // Two handles now wait on one load.
    assert_eq!(registry.pending_take(&session_id("s1")), Some(2));
}

/// Closing during a load ticks the pending count down; only at zero does the
/// pre-registered sessions entry go, which is what the load task detects to
/// fail rather than hand back an orphaned thread.
#[test]
fn closing_during_a_load_decrements_the_pending_count() {
    let registry = SessionRegistry::new();
    let _thread = registered(&registry, "s1");
    registry.pending_begin(session_id("s1"));
    registry.pending_acquire(&session_id("s1"));

    assert_eq!(registry.pending_release(&session_id("s1")), Some(1));
    assert_eq!(registry.pending_release(&session_id("s1")), Some(0));
    assert_eq!(
        registry.pending_release(&session_id("s1")),
        None,
        "the pending entry is gone once it hits zero"
    );
}

/// A thread the UI dropped must not be resurrected by the connection still
/// listing its session.
#[test]
fn a_dropped_thread_is_reported_as_an_unknown_session() {
    let registry = SessionRegistry::new();
    let thread = registered(&registry, "s1");

    assert!(registry.thread(&session_id("s1")).is_ok());
    drop(thread);
    assert!(registry.thread(&session_id("s1")).is_err());
}

/// The property the cancel deadline rests on: a cancel belongs to the turns
/// that were already running when it fired, and to no others.
///
/// This replaced a session-wide `suppress_abort_err` bool that `cancel` set
/// and the first turn to resolve consumed — so a cancel could be spent on a
/// turn it was not meant for, and a turn started afterwards could inherit a
/// suppression nobody asked for.
#[test]
fn a_cancel_belongs_to_the_turns_it_interrupted() {
    let signal = CancelSignal::new();

    // A turn already running when the cancel lands.
    let during = signal.waiter().probe();
    assert!(!during.fired(), "nothing has been cancelled yet");

    signal.fire();
    assert!(during.fired(), "the running turn's own cancel");

    // A turn that starts afterwards must not inherit it.
    let after = signal.waiter().probe();
    assert!(
        !after.fired(),
        "a later turn inherited a cancel meant for an earlier one"
    );

    // And a second cancel reaches the later turn, without needing the first
    // to have been consumed by anyone.
    signal.fire();
    assert!(after.fired());
    assert!(during.fired(), "reading a probe must not consume it");
}

/// One signal per session, so cancelling one chat cannot end another's turn.
#[test]
fn cancel_state_is_stored_per_session() {
    let registry = SessionRegistry::new();
    let _one = registered(&registry, "s1");
    let _two = registered(&registry, "s2");

    let watching_two = registry
        .with_session(&session_id("s2"), |session| {
            session.cancel_signal.waiter().probe()
        })
        .expect("s2 exists");

    registry.with_session(&session_id("s1"), |session| session.cancel_signal.fire());

    assert!(
        !watching_two.fired(),
        "cancelling one session cancelled another"
    );
}

// ------------------------------------------------------- session directories

#[test]
fn extra_working_directories_are_only_sent_when_the_agent_supports_them() {
    let dirs = vec![PathBuf::from("/a"), PathBuf::from("/b")];

    let supported = SessionDirectories::from_work_dirs(&dirs, true).unwrap();
    assert_eq!(supported.cwd, PathBuf::from("/a"));
    assert_eq!(supported.additional_directories, vec![PathBuf::from("/b")]);

    let unsupported = SessionDirectories::from_work_dirs(&dirs, false).unwrap();
    assert_eq!(unsupported.cwd, PathBuf::from("/a"));
    assert!(
        unsupported.additional_directories.is_empty(),
        "an agent that cannot take extra roots must not be told about them"
    );
}

#[test]
fn a_session_needs_at_least_one_working_directory() {
    assert!(SessionDirectories::from_work_dirs(&[], true).is_err());
}

// ---------------------------------------------------------------- debug tap

#[test]
fn the_trailing_stderr_run_is_what_explains_an_exit() {
    let log = AcpDebugLog::new();

    log.record_line(AcpDebugMessageDirection::Stderr, "early warning");
    log.record_line(
        AcpDebugMessageDirection::Incoming,
        r#"{"jsonrpc":"2.0","method":"session/update","params":{}}"#,
    );
    log.record_line(AcpDebugMessageDirection::Stderr, "cannot find module");
    log.record_line(AcpDebugMessageDirection::Stderr, "exiting");

    assert_eq!(
        log.trailing_stderr().as_deref(),
        Some("cannot find module\nexiting"),
        "only the final run, or the earlier noise buries the reason"
    );
}

#[test]
fn no_trailing_stderr_when_the_last_thing_was_traffic() {
    let log = AcpDebugLog::new();
    log.record_line(AcpDebugMessageDirection::Stderr, "warning");
    log.record_line(
        AcpDebugMessageDirection::Incoming,
        r#"{"jsonrpc":"2.0","id":1,"result":{}}"#,
    );

    assert_eq!(log.trailing_stderr(), None);
}

/// An outbound request may be recorded after an agent writes its startup
/// failure but before the exit watcher observes the child. That request must
/// not erase the diagnostic carried by the `Exited` error.
#[test]
fn exit_stderr_keeps_a_reason_before_our_final_request() {
    let log = AcpDebugLog::new();

    log.record_line(AcpDebugMessageDirection::Stderr, "cannot find module acp");
    log.record_line(
        AcpDebugMessageDirection::Outgoing,
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
    );

    assert_eq!(
        log.exit_stderr().as_deref(),
        Some("cannot find module acp"),
        "our request cannot overwrite the agent's final diagnostic"
    );
}

#[test]
fn a_batched_line_records_every_message_in_it() {
    let log = AcpDebugLog::new();
    log.record_line(
        AcpDebugMessageDirection::Incoming,
        r#"[{"jsonrpc":"2.0","method":"a"},{"jsonrpc":"2.0","method":"b"}]"#,
    );

    let (backlog, _rx) = log.subscribe();
    assert_eq!(backlog.len(), 2);
}

#[test]
fn requests_notifications_and_responses_are_told_apart() {
    let log = AcpDebugLog::new();
    log.record_line(
        AcpDebugMessageDirection::Outgoing,
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
    );
    log.record_line(
        AcpDebugMessageDirection::Incoming,
        r#"{"jsonrpc":"2.0","method":"session/update","params":{}}"#,
    );
    log.record_line(
        AcpDebugMessageDirection::Incoming,
        r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#,
    );
    log.record_line(
        AcpDebugMessageDirection::Incoming,
        r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"boom"}}"#,
    );

    let (backlog, _rx) = log.subscribe();
    let kinds: Vec<&str> = backlog
        .iter()
        .map(|message| match &message.message {
            AcpDebugMessageContent::Request { .. } => "request",
            AcpDebugMessageContent::Notification { .. } => "notification",
            AcpDebugMessageContent::Response { result: Ok(_), .. } => "result",
            AcpDebugMessageContent::Response { result: Err(_), .. } => "error",
            AcpDebugMessageContent::Stderr { .. } => "stderr",
        })
        .collect();

    assert_eq!(kinds, ["request", "notification", "result", "error"]);
}

#[test]
fn a_line_that_is_not_json_is_ignored_rather_than_recorded() {
    let log = AcpDebugLog::new();
    log.record_line(AcpDebugMessageDirection::Incoming, "not json at all");

    let (backlog, _rx) = log.subscribe();
    assert!(backlog.is_empty());
}

/// ATL-235. The message cap alone never bounded memory, because Atlas tees its
/// own `fs/read_text_file` responses in here and those carry whole files. Sixty
/// 2 MB reads — ordinary behaviour for a coding agent — parked 120 MB.
#[test]
fn reading_big_files_does_not_grow_the_ring_past_its_byte_budget() {
    let log = AcpDebugLog::new();

    let file = "x".repeat(2 * 1024 * 1024);
    for id in 0..60 {
        let line = format!(r#"{{"jsonrpc":"2.0","id":{id},"result":{{"content":"{file}"}}}}"#);
        log.record_line(AcpDebugMessageDirection::Outgoing, &line);
    }

    // Asserted against the measured 120 MB, not against the constant: a bound
    // stated only in terms of the thing being tuned goes vacuous the moment
    // someone raises it.
    let pushed_through = 60 * file.len();
    assert!(
        log.retained_bytes() < pushed_through / 100,
        "ring holds {} bytes of the {pushed_through} pushed through it",
        log.retained_bytes()
    );
    assert!(log.retained_bytes() <= MAX_DEBUG_BACKLOG_BYTES);

    // The conversation is still legible — the bodies went, the exchange did not.
    let (backlog, _rx) = log.subscribe();
    assert_eq!(backlog.len(), 60, "messages were dropped, not just bodies");
    assert!(
        !format!("{:?}", backlog.last().expect("a message")).contains(&file),
        "an oversized body survived verbatim"
    );
}

/// Elision handles one huge message; this is the other half. Enough
/// individually-reasonable messages still add up, and only the byte budget
/// catches that — which is why the message cap alone was never a bound.
#[test]
fn the_byte_budget_evicts_even_when_no_single_message_is_oversized() {
    let log = AcpDebugLog::new();

    let body = "z".repeat(MAX_DEBUG_MESSAGE_BYTES - 128);
    let line =
        format!(r#"{{"jsonrpc":"2.0","method":"session/update","params":{{"t":"{body}"}}}}"#);
    assert!(
        line.len() <= MAX_DEBUG_MESSAGE_BYTES,
        "fixture must stay under the per-message cap or it tests elision instead"
    );

    // Enough to pass the byte budget twice over, and far short of the 2000
    // message cap, so only the byte budget can be what evicts.
    let sent = (MAX_DEBUG_BACKLOG_BYTES * 2).div_ceil(line.len());
    assert!(sent < 2000, "fixture must not reach the message cap");
    for _ in 0..sent {
        log.record_line(AcpDebugMessageDirection::Incoming, &line);
    }

    assert!(
        log.retained_bytes() <= MAX_DEBUG_BACKLOG_BYTES,
        "ring holds {} bytes after {sent} in-cap messages, budget is {}",
        log.retained_bytes(),
        MAX_DEBUG_BACKLOG_BYTES
    );
    let (backlog, _rx) = log.subscribe();
    assert!(
        backlog.len() < sent,
        "nothing was evicted: {} messages held of {sent} sent, all under the \
         per-message cap and under the 2000-message cap",
        backlog.len()
    );
}

/// The envelope has to outlive the body, or the ring stops being a record of
/// the conversation and becomes a record of its small half.
#[test]
fn an_elided_message_keeps_its_method_and_says_what_it_dropped() {
    let log = AcpDebugLog::new();

    let big = "y".repeat(MAX_DEBUG_MESSAGE_BYTES * 2);
    let line = format!(
        r#"{{"jsonrpc":"2.0","id":7,"method":"fs/read_text_file","params":{{"content":"{big}"}}}}"#
    );
    log.record_line(AcpDebugMessageDirection::Outgoing, &line);

    let (backlog, _rx) = log.subscribe();
    let AcpDebugMessageContent::Request { method, params, .. } =
        &backlog.first().expect("one message").message
    else {
        panic!("expected a request, got {:?}", backlog.first());
    };

    assert_eq!(method.as_ref(), "fs/read_text_file");
    let params = params.as_ref().expect("a marker, not an absent body");
    assert_eq!(
        params["atlasElided"]["bytes"].as_u64(),
        Some(line.len() as u64),
        "the marker should say how big the dropped body was: {params}"
    );
}

/// The elision had a hole exactly where an agent controls the size. An error
/// response's `data` is an unbounded value, and `parse_value` puts the whole
/// error object in it as a string when it cannot deserialize — so an oversized
/// error line was kept verbatim while being charged as if it had been elided,
/// and the byte budget never fired for it.
#[test]
fn an_oversized_error_response_is_elided_like_any_other_payload() {
    let log = AcpDebugLog::new();

    let big = "e".repeat(MAX_DEBUG_MESSAGE_BYTES * 4);
    let line = format!(
        r#"{{"jsonrpc":"2.0","id":9,"error":{{"code":-32603,"message":"boom","data":"{big}"}}}}"#
    );
    log.record_line(AcpDebugMessageDirection::Incoming, &line);

    assert!(
        log.retained_bytes() < line.len() / 4,
        "an error body was charged as elided but kept whole: {} bytes held of a {} byte line",
        log.retained_bytes(),
        line.len()
    );

    let (backlog, _rx) = log.subscribe();
    assert!(
        !format!("{:?}", backlog.first().expect("one message")).contains(&big),
        "the error body survived verbatim"
    );
}

/// Enough oversized error lines must still be evicted. This is the budget
/// itself, on the message shape that used to escape it.
#[test]
fn oversized_error_responses_are_bounded_in_aggregate() {
    let log = AcpDebugLog::new();

    let big = "e".repeat(MAX_DEBUG_MESSAGE_BYTES * 4);
    for id in 0..200 {
        let line = format!(
            r#"{{"jsonrpc":"2.0","id":{id},"error":{{"code":-32603,"message":"boom","data":"{big}"}}}}"#
        );
        log.record_line(AcpDebugMessageDirection::Incoming, &line);
    }

    // Measured from the ring's actual contents, not from its own accounting.
    // Asserting `retained_bytes() <= budget` would have passed while the bug
    // was live, because the bug WAS the accounting: it reported ~128 bytes for
    // a message it kept whole, so the budget it is compared against never
    // fired. A test of a self-reported number cannot catch a self-report that
    // lies.
    let (backlog, _rx) = log.subscribe();
    let held: usize = backlog.iter().map(|m| format!("{m:?}").len()).sum();
    assert!(
        held < 200 * big.len() / 10,
        "the ring really holds {held} bytes after {} bytes of error responses",
        200 * big.len()
    );
    assert!(log.retained_bytes() <= MAX_DEBUG_BACKLOG_BYTES);
}

/// `trailing_stderr` is what turns "process exited" into a reason, so a huge
/// stderr line has to be cut rather than dropped — and the reason an agent
/// died is at the start of what it printed.
#[test]
fn an_oversized_stderr_line_is_cut_but_still_explains_itself() {
    let log = AcpDebugLog::new();

    let mut line = String::from("Error: cannot find module 'foo'");
    line.push_str(&"!".repeat(MAX_DEBUG_MESSAGE_BYTES * 2));
    log.record_line(AcpDebugMessageDirection::Stderr, &line);

    let trailing = log.trailing_stderr().expect("stderr should still explain");
    assert!(
        trailing.starts_with("Error: cannot find module 'foo'"),
        "the reason was cut away: {}",
        &trailing[..60.min(trailing.len())]
    );
    assert!(
        trailing.len() < line.len(),
        "an oversized stderr line was retained whole"
    );
    assert!(log.retained_bytes() <= MAX_DEBUG_BACKLOG_BYTES);
}

#[test]
fn a_subscriber_gets_the_backlog_and_then_live_messages() {
    let log = AcpDebugLog::new();
    log.record_line(AcpDebugMessageDirection::Stderr, "before");

    let (backlog, mut rx) = log.subscribe();
    assert_eq!(backlog.len(), 1);

    log.record_line(AcpDebugMessageDirection::Stderr, "after");
    let live = rx.try_recv().expect("live message missing");
    assert!(matches!(
        live.message,
        AcpDebugMessageContent::Stderr { .. }
    ));
}

// ------------------------------------------------------------- env workarounds

#[test]
fn the_claude_workaround_blanks_the_api_key_rather_than_unsetting_it() {
    let env = env_quirks(&AgentId::new("claude-code"));
    assert_eq!(env.get("ANTHROPIC_API_KEY"), Some(&String::new()));
}

#[test]
fn an_agent_with_no_workaround_gets_a_clean_environment() {
    assert!(env_quirks(&AgentId::new("some-installed-agent")).is_empty());
}

/// Codex's auth reads `CODEX_API_KEY` and `OPENAI_API_KEY`. The second was once
/// forwarded as `OPEN_AI_API_KEY`, a name nothing reads, so a
/// key the user exported never reached the agent.
#[test]
fn codex_gets_the_api_keys_its_auth_actually_reads() {
    let host = |key: &str| match key {
        "CODEX_API_KEY" => Some("codex-key".to_owned()),
        "OPENAI_API_KEY" => Some("openai-key".to_owned()),
        "OPEN_AI_API_KEY" => Some("misspelled".to_owned()),
        "ANTHROPIC_API_KEY" => Some("not-codex".to_owned()),
        _ => None,
    };
    let env = env_quirks_from(&AgentId::new("codex"), host);

    assert_eq!(
        env.get("CODEX_API_KEY").map(String::as_str),
        Some("codex-key")
    );
    assert_eq!(
        env.get("OPENAI_API_KEY").map(String::as_str),
        Some("openai-key")
    );
    assert_eq!(
        env.len(),
        2,
        "only the keys codex reads are forwarded: {env:?}"
    );
}

/// A key the host does not have is left out rather than forwarded empty.
#[test]
fn codex_forwards_no_key_the_host_does_not_have() {
    assert!(env_quirks_from(&AgentId::new("codex"), |_| None).is_empty());
}

#[test]
fn gemini_is_told_which_host_it_is_running_in() {
    let env = env_quirks(&AgentId::new("gemini"));
    assert_eq!(env.get("SURFACE"), Some(&"atlas".to_owned()));
}

// ------------------------------------------------------------- capabilities

/// Only what the handlers actually serve is advertised — an agent told we can
/// do something we cannot will call it and fail mid-turn.
#[test]
fn advertised_capabilities_match_what_the_handlers_serve() {
    let caps = client_capabilities_for_agent(&AgentId::new("any"));

    assert!(caps.fs.read_text_file);
    assert!(caps.fs.write_text_file);
    assert!(caps.terminal);
    assert!(caps.auth.terminal);
    let elicitation = caps.elicitation.expect("elicitation capabilities missing");
    assert!(elicitation.form.is_some());
    assert!(elicitation.url.is_some());
}

// ── the terminal-output pump ────────────────────────────────────────────────
//
// `follow_terminal_output` is the link between a terminal and the tool call that
// renders it: a running command's output has to become thread events, or the tool call that renders
// it is never re-projected and the output pane stays frozen. These drive the
// real spawned task against a real PTY.

/// A thread plus the receiver its events land on, so a test can watch them.
fn thread_with_events(
    id: &str,
) -> (
    Arc<Mutex<AcpThread>>,
    atlas_acp_thread::EventStream<atlas_acp_thread::AcpThreadEvent>,
) {
    let (tx, rx) = event_channel();
    let thread = Arc::new(Mutex::new(AcpThread::new(
        session_id(id),
        stub_connection(),
        vec![PathBuf::from("/tmp")],
        None,
        tx,
    )));
    (thread, rx)
}

/// Register `terminal` under `terminal_id` and announce a tool call that
/// references it — the shape `terminal/create` plus a `session/update` produce.
fn tool_call_running(
    thread: &Arc<Mutex<AcpThread>>,
    terminal_id: &acp::TerminalId,
    terminal: Arc<atlas_terminal::command::CommandTerminal>,
) {
    thread.lock().unwrap().on_terminal_provider_event(
        atlas_acp_thread::TerminalProviderEvent::Created {
            terminal_id: terminal_id.clone(),
            label: "cmd".into(),
            cwd: None,
            output_byte_limit: Some(4096),
            terminal: Some(terminal),
        },
    );
    let update: acp::SessionUpdate = serde_json::from_value(serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "call-1",
        "title": "Run a command",
        "kind": "execute",
        "status": "in_progress",
        "content": [{ "type": "terminal", "terminalId": terminal_id.to_string() }],
    }))
    .expect("the update parses");
    thread
        .lock()
        .unwrap()
        .handle_session_update(update)
        .expect("the thread accepts it");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_pump_turns_a_running_command_into_thread_events() {
    let (thread, mut events) = thread_with_events("sess-pump");
    let terminal_id = acp::TerminalId::new("term-pump");
    // Prints, then lingers: the event must arrive while the command still runs,
    // not only once it has exited.
    let terminal = Arc::new(
        atlas_terminal::command::CommandTerminal::spawn(
            "/bin/sh",
            &["-c".to_string(), "echo streaming; sleep 30".to_string()],
            &[],
            None,
            4096,
        )
        .expect("spawn"),
    );
    tool_call_running(&thread, &terminal_id, terminal.clone());
    // Drain what announcing the tool call already emitted.
    while events.try_recv().is_ok() {}

    handlers::follow_terminal_output(thread.clone(), terminal.clone(), terminal_id.clone());

    // Not "any event": the pump reports once on start, and that report can
    // precede the echo. What is under test is an event arriving once the
    // output HAS the line. A pump that registers for wakes only after the
    // command has printed never sends that one — the echo is the command's
    // only output — which is how this test once timed out on a fast CI runner.
    let reported = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while events.recv().await.is_some() {
            let output = thread
                .lock()
                .unwrap()
                .terminal_output(&terminal_id)
                .unwrap_or_default();
            if output.contains("streaming") {
                return true;
            }
        }
        false
    })
    .await;
    let still_running = terminal.exit_status().is_none();
    let _ = terminal.kill();
    assert_eq!(
        reported,
        Ok(true),
        "the pump produced no thread event carrying what the command printed"
    );
    assert!(
        still_running,
        "the report must arrive while the command runs"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_pump_stops_when_the_thread_is_gone() {
    // A session torn down while its command still runs must not be kept alive
    // by its own terminal — the task holds the thread weakly and gives up.
    let (thread, events) = thread_with_events("sess-dropped");
    let terminal_id = acp::TerminalId::new("term-dropped");
    let terminal = Arc::new(
        atlas_terminal::command::CommandTerminal::spawn(
            "/bin/sh",
            &["-c".to_string(), "sleep 30".to_string()],
            &[],
            None,
            4096,
        )
        .expect("spawn"),
    );
    let weak = Arc::downgrade(&thread);
    handlers::follow_terminal_output(thread.clone(), terminal.clone(), terminal_id);

    drop(events);
    drop(thread);
    let _ = terminal.kill();
    // The kill wakes the pump, which finds nothing to report to and returns —
    // releasing the last handle it held.
    for _ in 0..100 {
        if weak.upgrade().is_none() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("the pump kept the thread alive after its session went away");
}

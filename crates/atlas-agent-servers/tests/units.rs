//! Unit-level tests for the pieces of the transport that can be exercised
//! without an agent: the session bookkeeping, the directory rules, the debug
//! tap, and the environment workarounds.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{event_channel, AcpThread, AgentId};
use atlas_agent_servers::*;

mod stub;
use stub::stub_connection;

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
            suppress_abort_err: false,
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

#[test]
fn cancel_state_is_stored_per_session() {
    let registry = SessionRegistry::new();
    let _thread = registered(&registry, "s1");

    registry.with_session(&session_id("s1"), |session| {
        session.suppress_abort_err = true;
    });
    let taken = registry.with_session(&session_id("s1"), |session| {
        let was = session.suppress_abort_err;
        session.suppress_abort_err = false;
        was
    });

    assert_eq!(taken, Some(true));
    assert_eq!(
        registry.with_session(&session_id("s1"), |s| s.suppress_abort_err),
        Some(false),
        "the flag is consumed, so a cancel cannot leak into a later turn"
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

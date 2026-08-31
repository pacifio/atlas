//! Terminal buffering tests, adapted from Zed's
//! `test_terminal_output_buffered_before_created_renders`,
//! `test_terminal_output_and_exit_buffered_before_created`, and
//! `test_terminal_kill_allows_wait_for_exit_to_complete`
//! (`~/Codes/zed-ref/crates/acp_thread/src/acp_thread.rs`).
//!
//! The race these cover is real and not hypothetical: the agent is handed a
//! terminal id by `terminal/create` and can reference it in a `session/update`
//! immediately, which can beat the client's own `Created` bookkeeping. Without
//! the side-tables the first chunk of a fast command's output is dropped — and
//! that output is exactly what the agent reads back as the command's result.

use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::*;
use atlas_terminal::command::CommandTerminal;

fn terminal_id(id: &str) -> acp::TerminalId {
    acp::TerminalId::new(id)
}

/// `true(1)` lives in different places across the platforms this runs on
/// (macOS locally, ubuntu in CI), so resolve it rather than hardcoding a path.
fn true_binary() -> &'static str {
    ["/usr/bin/true", "/bin/true"]
        .into_iter()
        .find(|path| std::path::Path::new(path).exists())
        .unwrap_or("true")
}

/// A real PTY-backed command, so the registry is exercised against the same
/// type production uses rather than a stand-in.
fn spawn_true() -> Arc<CommandTerminal> {
    Arc::new(
        CommandTerminal::spawn(true_binary(), &[], &[], None, 1024)
            .expect("failed to spawn true(1)"),
    )
}

fn created(id: &acp::TerminalId) -> TerminalProviderEvent {
    TerminalProviderEvent::Created {
        terminal_id: id.clone(),
        label: "true".into(),
        cwd: None,
        output_byte_limit: Some(1024),
        terminal: Some(spawn_true()),
    }
}

fn exit_status(code: u32) -> acp::TerminalExitStatus {
    let mut status = acp::TerminalExitStatus::new();
    status.exit_code = Some(code);
    status
}

/// Adapted from `test_terminal_output_buffered_before_created_renders`.
#[test]
fn output_arriving_before_created_is_replayed_not_dropped() {
    let mut registry = TerminalRegistry::new();
    let id = terminal_id("t1");

    registry.handle_event(TerminalProviderEvent::Output {
        terminal_id: id.clone(),
        data: b"first".to_vec(),
    });
    registry.handle_event(TerminalProviderEvent::Output {
        terminal_id: id.clone(),
        data: b"-second".to_vec(),
    });

    assert_eq!(
        registry.pending_output_len(&id),
        2,
        "output must be parked while the terminal is unknown"
    );
    assert!(registry.get(&id).is_none());

    registry.handle_event(created(&id));

    assert_eq!(registry.pending_output_len(&id), 0);
    let output = registry.get(&id).expect("terminal missing").current_output();
    assert!(
        output.output.starts_with("first-second"),
        "replayed output must lead, got {:?}",
        output.output
    );
}

/// Adapted from `test_terminal_output_and_exit_buffered_before_created`.
#[test]
fn an_exit_arriving_before_created_is_applied_on_creation() {
    let mut registry = TerminalRegistry::new();
    let id = terminal_id("t1");

    registry.handle_event(TerminalProviderEvent::Output {
        terminal_id: id.clone(),
        data: b"done".to_vec(),
    });
    registry.handle_event(TerminalProviderEvent::Exit {
        terminal_id: id.clone(),
        status: exit_status(3),
    });

    assert!(registry.has_pending_exit(&id));

    registry.handle_event(created(&id));

    assert!(!registry.has_pending_exit(&id));
    let output = registry.get(&id).expect("terminal missing").current_output();
    assert!(output.output.starts_with("done"));
    assert_eq!(
        output.exit_status.and_then(|s| s.exit_code),
        Some(3),
        "the buffered exit status must survive creation"
    );
}

/// Output for a terminal that already exists goes straight through.
#[test]
fn output_after_created_is_not_parked() {
    let mut registry = TerminalRegistry::new();
    let id = terminal_id("t1");

    registry.handle_event(created(&id));
    registry.handle_event(TerminalProviderEvent::Output {
        terminal_id: id.clone(),
        data: b"live".to_vec(),
    });

    assert_eq!(registry.pending_output_len(&id), 0);
    assert!(registry
        .get(&id)
        .expect("terminal missing")
        .current_output()
        .output
        .starts_with("live"));
}

/// Buffering is per terminal id — one terminal's pending output must never be
/// replayed into another's.
#[test]
fn parked_output_is_keyed_by_terminal() {
    let mut registry = TerminalRegistry::new();
    let (a, b) = (terminal_id("a"), terminal_id("b"));

    registry.handle_event(TerminalProviderEvent::Output {
        terminal_id: a.clone(),
        data: b"for-a".to_vec(),
    });
    registry.handle_event(created(&b));

    assert_eq!(registry.pending_output_len(&a), 1);
    assert!(!registry
        .get(&b)
        .expect("terminal missing")
        .current_output()
        .output
        .contains("for-a"));
}

/// A title change renames the terminal's command label, which is what the ACP
/// `title` field on an `Execute` tool call updates.
#[test]
fn a_title_change_renames_the_command_label() {
    let mut registry = TerminalRegistry::new();
    let id = terminal_id("t1");

    registry.handle_event(created(&id));
    registry.handle_event(TerminalProviderEvent::TitleChanged {
        terminal_id: id.clone(),
        title: "cargo build".into(),
    });

    assert_eq!(registry.get(&id).expect("terminal missing").command(), "cargo build");
}

/// Adapted from `test_terminal_kill_allows_wait_for_exit_to_complete`: a killed
/// terminal must still resolve its exit waiter, or `terminal/wait_for_exit`
/// hangs forever.
#[tokio::test]
async fn killing_a_terminal_still_resolves_wait_for_exit() {
    let mut registry = TerminalRegistry::new();
    let id = terminal_id("t1");
    registry.handle_event(created(&id));

    let terminal = registry.get(&id).expect("terminal missing");
    terminal.kill().unwrap();

    // Resolves rather than hanging; the concrete status depends on whether the
    // kill beat the process finishing on its own, which is a real race.
    let _status = terminal.wait_for_exit().await;
}

/// Removing a terminal clears its side-tables too, so a later id reuse does not
/// inherit a dead terminal's parked output.
#[test]
fn removing_a_terminal_drops_its_parked_state() {
    let mut registry = TerminalRegistry::new();
    let id = terminal_id("t1");

    registry.handle_event(TerminalProviderEvent::Output {
        terminal_id: id.clone(),
        data: b"stale".to_vec(),
    });
    registry.handle_event(TerminalProviderEvent::Exit {
        terminal_id: id.clone(),
        status: exit_status(0),
    });
    registry.remove(&id);

    assert_eq!(registry.pending_output_len(&id), 0);
    assert!(!registry.has_pending_exit(&id));
}

// ── Display-only terminals (#29) ───────────────────────────────────────────

/// A terminal announced through `terminal_info` meta has no PTY on our side —
/// the agent owns the process. Everything it shows arrives as provider events.
fn display_only(id: &acp::TerminalId) -> TerminalProviderEvent {
    TerminalProviderEvent::Created {
        terminal_id: id.clone(),
        label: "cargo test".into(),
        cwd: None,
        output_byte_limit: None,
        terminal: None,
    }
}

#[test]
fn a_display_only_terminal_shows_exactly_what_the_meta_events_carried() {
    let mut registry = TerminalRegistry::new();
    let id = terminal_id("emb");

    registry.handle_event(display_only(&id));
    registry.handle_event(TerminalProviderEvent::Output {
        terminal_id: id.clone(),
        data: b"line one\n".to_vec(),
    });
    registry.handle_event(TerminalProviderEvent::Output {
        terminal_id: id.clone(),
        data: b"line two\n".to_vec(),
    });
    registry.handle_event(TerminalProviderEvent::Exit {
        terminal_id: id.clone(),
        status: exit_status(0),
    });

    let output = registry.get(&id).expect("registered").current_output();
    assert_eq!(output.output, "line one\nline two\n");
    assert_eq!(output.exit_status.and_then(|s| s.exit_code), Some(0));
}

/// The parking side-tables serve display-only terminals too: output racing
/// ahead of the `terminal_info` that announces the terminal must not be lost —
/// it is by definition the command's earliest output.
#[test]
fn output_arriving_before_a_display_only_terminal_is_replayed() {
    let mut registry = TerminalRegistry::new();
    let id = terminal_id("emb");

    registry.handle_event(TerminalProviderEvent::Output {
        terminal_id: id.clone(),
        data: b"early\n".to_vec(),
    });
    registry.handle_event(display_only(&id));

    assert_eq!(
        registry.get(&id).expect("registered").current_output().output,
        "early\n"
    );
}

/// There is no process on our side to kill or await: killing errors honestly,
/// and a known exit is still answered.
#[test]
fn a_display_only_terminal_refuses_a_kill_and_reports_a_known_exit() {
    let mut registry = TerminalRegistry::new();
    let id = terminal_id("emb");
    registry.handle_event(display_only(&id));
    registry.handle_event(TerminalProviderEvent::Exit {
        terminal_id: id.clone(),
        status: exit_status(2),
    });

    let terminal = registry.get(&id).expect("registered");
    assert!(terminal.kill().is_err(), "no process of ours to kill");
    assert!(terminal.inner().is_none());
    assert_eq!(
        futures::executor::block_on(terminal.wait_for_exit())
            .expect("a known exit is answerable even without a process")
            .exit_code,
        Some(2)
    );
}

/// The other half of the same contract: a display-only terminal whose exit has
/// NOT arrived answers `None`, not a default status that reads as `exit 0`.
#[test]
fn a_display_only_terminal_without_an_exit_admits_it_does_not_know() {
    let mut registry = TerminalRegistry::new();
    let id = terminal_id("emb");
    registry.handle_event(display_only(&id));

    let terminal = registry.get(&id).expect("registered");
    assert!(futures::executor::block_on(terminal.wait_for_exit()).is_none());
}

// ------------------------------------------------------------------- limits

/// A display-only terminal, announced through `terminal_info` meta with no
/// `outputByteLimit` the agent could ever have declared.
fn display_only_unlimited(id: &acp::TerminalId) -> TerminalProviderEvent {
    TerminalProviderEvent::Created {
        terminal_id: id.clone(),
        label: "agent-run".into(),
        cwd: None,
        output_byte_limit: None,
        terminal: None,
    }
}

/// Regression, ATL-215. `output_byte_limit` was stored, exposed by a getter
/// nothing called, and never enforced. A display-only terminal has no
/// `CommandTerminal`, so the PTY buffer's cap does not apply to it and the
/// buffer grew for the life of the session — while `truncated` was read off
/// the PTY alone and so reported `false` no matter how much had accumulated.
#[test]
fn a_display_only_terminal_bounds_its_buffer_and_admits_the_truncation() {
    let mut registry = TerminalRegistry::new();
    let id = terminal_id("emb");
    registry.handle_event(TerminalProviderEvent::Created {
        terminal_id: id.clone(),
        label: "agent-run".into(),
        cwd: None,
        output_byte_limit: Some(64),
        terminal: None,
    });

    for _ in 0..100 {
        registry.handle_event(TerminalProviderEvent::Output {
            terminal_id: id.clone(),
            data: vec![b'x'; 64],
        });
    }

    let response = registry.get(&id).expect("registered").current_output();
    assert!(response.truncated, "a trimmed buffer must say so");
    assert_eq!(
        response.output.len(),
        64,
        "the retained window is the declared limit, not everything that arrived"
    );
}

/// The same bound applies when the agent declares nothing, which for a
/// display-only terminal is always: `handle_session_update` has no field to
/// read a limit from. `None` must mean the default, not "unbounded".
#[test]
fn an_undeclared_limit_still_bounds_a_display_only_terminal() {
    let mut registry = TerminalRegistry::new();
    let id = terminal_id("emb");
    registry.handle_event(display_only_unlimited(&id));

    // Comfortably past the 1 MiB default.
    for _ in 0..40 {
        registry.handle_event(TerminalProviderEvent::Output {
            terminal_id: id.clone(),
            data: vec![b'x'; 64 * 1024],
        });
    }

    let response = registry.get(&id).expect("registered").current_output();
    assert!(response.truncated);
    assert_eq!(response.output.len(), 1024 * 1024);
}

/// Truncation never manufactures a replacement character: the window is walked
/// forward off any UTF-8 continuation byte before it is kept.
#[test]
fn trimming_a_display_only_buffer_keeps_it_valid_utf8() {
    let mut registry = TerminalRegistry::new();
    let id = terminal_id("emb");
    registry.handle_event(TerminalProviderEvent::Created {
        terminal_id: id.clone(),
        label: "agent-run".into(),
        cwd: None,
        output_byte_limit: Some(16),
        terminal: None,
    });

    for _ in 0..20 {
        registry.handle_event(TerminalProviderEvent::Output {
            terminal_id: id.clone(),
            // 4 bytes each, so the naive cut lands mid-character.
            data: "🌍".as_bytes().to_vec(),
        });
    }

    let output = registry.get(&id).expect("registered").current_output().output;
    assert!(!output.contains('\u{fffd}'), "cut a character in half: {output:?}");
    assert!(output.chars().all(|c| c == '🌍'));
}

/// Regression, ATL-216. Output parked for an id that is never announced was
/// retained for the life of the session with no cap of any kind — and
/// `handle_session_update` takes the id straight off agent-supplied meta with
/// no membership check, so a buggy agent could park output for ids that will
/// never exist.
#[test]
fn parked_output_for_ids_that_never_arrive_is_bounded() {
    let mut registry = TerminalRegistry::new();

    for n in 0..512 {
        registry.handle_event(TerminalProviderEvent::Output {
            terminal_id: terminal_id(&format!("ghost-{n}")),
            data: vec![b'x'; 16 * 1024],
        });
    }

    let (ids, bytes) = registry.pending_output_stats();
    assert!(ids <= 64, "parked ids unbounded: {ids}");
    assert!(bytes <= 1024 * 1024, "parked bytes unbounded: {bytes}");
}

/// Eviction is oldest-first, so the id most likely to still be announced — the
/// one that just arrived — is the one that survives.
#[test]
fn evicting_parked_output_keeps_the_newest_id() {
    let mut registry = TerminalRegistry::new();

    for n in 0..200 {
        registry.handle_event(TerminalProviderEvent::Output {
            terminal_id: terminal_id(&format!("t{n}")),
            data: b"chunk".to_vec(),
        });
    }

    assert_eq!(registry.pending_output_len(&terminal_id("t0")), 0);
    assert_eq!(registry.pending_output_len(&terminal_id("t199")), 1);
}

/// Parked exit statuses are capped the same way. Nothing prunes them either:
/// `terminal/release` errors out for an id it does not know.
#[test]
fn parked_exit_statuses_are_bounded() {
    let mut registry = TerminalRegistry::new();

    for n in 0..512 {
        registry.handle_event(TerminalProviderEvent::Exit {
            terminal_id: terminal_id(&format!("ghost-{n}")),
            status: exit_status(0),
        });
    }

    assert!(registry.pending_exit_len() <= 64);
    assert!(registry.has_pending_exit(&terminal_id("ghost-511")));
}

/// The cap must not break the thing the side-tables exist for: output that
/// arrives just before its `Created` is still replayed in full.
#[test]
fn bounding_the_side_tables_does_not_break_ordinary_out_of_order_replay() {
    let mut registry = TerminalRegistry::new();
    let id = terminal_id("t1");

    registry.handle_event(TerminalProviderEvent::Output {
        terminal_id: id.clone(),
        data: b"early".to_vec(),
    });
    registry.handle_event(display_only_unlimited(&id));

    let (ids, bytes) = registry.pending_output_stats();
    assert_eq!((ids, bytes), (0, 0), "draining must clear the accounting");
    assert_eq!(
        registry.get(&id).expect("registered").current_output().output,
        "early"
    );
}

/// Regression, ATL-214. A session torn down with a command still running left
/// the child as an orphan of the Atlas process: nothing on the path killed it,
/// `portable-pty`'s unix child does not kill on drop, and the reader thread
/// holds the master fd open so there is no SIGHUP either.
///
/// Uses `sleep`, because `true(1)` would exit on its own and prove nothing.
#[tokio::test]
async fn dropping_the_registry_kills_a_running_command() {
    let mut registry = TerminalRegistry::new();
    let id = terminal_id("t1");
    let terminal = Arc::new(
        CommandTerminal::spawn("sleep", &["30".into()], &[], None, 1024)
            .expect("failed to spawn sleep"),
    );
    registry.handle_event(TerminalProviderEvent::Created {
        terminal_id: id.clone(),
        label: "sleep 30".into(),
        cwd: None,
        output_byte_limit: Some(1024),
        terminal: Some(terminal.clone()),
    });
    assert!(terminal.exit_status().is_none(), "sleep exited early");

    // What `close_session` does: drop the last handle on the thread, which
    // drops the registry, which drops the terminal.
    drop(registry);

    let exit = tokio::time::timeout(std::time::Duration::from_secs(10), terminal.wait_for_exit())
        .await
        .expect("the child outlived the registry that owned it");
    assert!(
        exit.signal.is_some() || exit.exit_code != Some(0),
        "sleep(1) should have died by signal, got {exit:?}"
    );
}

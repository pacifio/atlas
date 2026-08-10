//! The capture-health signal — each of the three states driven through the
//! public API by causing the real condition, not by setting a flag.

use std::path::Path;
use std::process::Command;

use atlas_checkpoint::model::WorkspaceMode;
use atlas_checkpoint::{
    bind, disable, evaluate_health, Capture, CaptureHealth, HealthState, HostSignals, SessionKey,
    Source, Store, SPILL_THRESHOLD_BYTES,
};

const WORKSPACE: &str = "ws-atlas";

/// A Workspace whose git watcher is attached and healthy.
fn watching() -> HostSignals {
    HostSignals {
        watcher_attached: true,
        expects_watcher: true,
        holds_writer: Some(true),
        worker_alive: true,
    }
}

/// A Workspace that needs no watcher — not a git repository.
fn no_watcher_needed() -> HostSignals {
    HostSignals {
        watcher_attached: false,
        expects_watcher: false,
        holds_writer: Some(true),
        worker_alive: true,
    }
}

fn store_in(root: &Path) -> Store {
    Store::open(root.join(".atlas")).expect("store opens")
}

fn bound(root: &Path) -> Store {
    let store = store_in(root);
    bind(&store, WORKSPACE, root, WorkspaceMode::Local).expect("binds");
    store
}

fn health(store: &Store, host: HostSignals) -> CaptureHealth {
    evaluate_health(store, WORKSPACE, host).expect("health evaluates")
}

fn init_repo(root: &Path) {
    for args in [
        vec!["init", "--initial-branch=main"],
        vec!["config", "user.name", "Test"],
        vec!["config", "user.email", "t@example.com"],
    ] {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(&args)
            .output()
            .expect("git runs");
        assert!(output.status.success());
    }
}

fn record_session(store: &mut Store, native_id: &str) -> String {
    record_session_in(store, native_id, WorkspaceMode::Local)
}

fn record_session_in(store: &mut Store, native_id: &str, mode: WorkspaceMode) -> String {
    let mut capture = Capture::new(store, mode);
    capture
        .record_prompt(
            &SessionKey {
                workspace_id: WORKSPACE.into(),
                source: Source::Acp,
                native_session_id: native_id.into(),
            },
            "do some work",
            1,
            None,
            None,
            None,
        )
        .expect("prompt")
}

// ── OK ──────────────────────────────────────────────────────────────────────

#[test]
fn a_healthy_workspace_reports_ok_with_no_issues() {
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());
    let mut store = bound(dir.path());
    record_session(&mut store, "s1");

    let health = health(&store, watching());
    assert_eq!(health.state, HealthState::Ok);
    assert!(health.issues.is_empty(), "{:?}", health.issues);
    assert_eq!(health.summary, "Synced");
}

#[test]
fn a_non_git_workspace_is_healthy_without_a_watcher() {
    // It never has one, and reporting that as a failure would make every
    // notebook folder permanently look broken.
    let dir = tempfile::tempdir().unwrap();
    let store = bound(dir.path());
    assert_eq!(health(&store, no_watcher_needed()).state, HealthState::Ok);
}

#[test]
fn a_healthy_workspace_still_surfaces_its_pending_count() {
    // Not a problem — the one number a developer wants continuously is whether
    // their work has reached their team.
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(dir.path());
    bind(&store, WORKSPACE, dir.path(), WorkspaceMode::Cloud).unwrap();

    let mut store = store;
    record_session_in(&mut store, "s1", WorkspaceMode::Cloud);

    let health = health(&store, no_watcher_needed());
    assert_eq!(health.state, HealthState::Ok);
    assert!(health.pending_rows > 0);
    assert!(health.summary.contains("pending"), "{}", health.summary);
}

// ── Degraded ────────────────────────────────────────────────────────────────

#[test]
fn a_flagged_session_moves_the_workspace_to_degraded() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = bound(dir.path());
    let session = record_session(&mut store, "s1");

    // The condition a redaction or storage failure produces.
    store
        .flag_needs_attention(&session, "redaction failed on this turn")
        .unwrap();

    let health = health(&store, no_watcher_needed());
    assert_eq!(health.state, HealthState::Degraded);
    assert_eq!(health.flagged_sessions, 1);
    assert!(
        health.issues.iter().any(|i| i.reason.contains("could not be fully recorded")),
        "{:?}",
        health.issues
    );
    // Every issue tells the developer what to do about it.
    assert!(health.issues.iter().all(|i| !i.next_step.is_empty()));
}

#[test]
fn a_storage_failure_flags_the_session_and_surfaces_as_degraded() {
    // Driven by causing the real failure rather than setting the flag directly.
    let dir = tempfile::tempdir().unwrap();
    let mut store = bound(dir.path());
    let session = record_session(&mut store, "s1");

    let blobs = dir.path().join(".atlas").join("blobs");
    std::fs::create_dir_all(&blobs).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&blobs).unwrap().permissions();
        perms.set_mode(0o500);
        std::fs::set_permissions(&blobs, perms).unwrap();
    }

    {
        let mut capture = Capture::new(&mut store, WorkspaceMode::Local);
        let _ = capture.record_turn(
            &session,
            atlas_checkpoint::TurnContent {
                turn_seq: 1,
                native_message_id: None,
                role: atlas_checkpoint::Role::Assistant,
                mode: atlas_checkpoint::Mode::Text,
                body: "x".repeat(SPILL_THRESHOLD_BYTES + 1),
                created_at: None,
            },
        );
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&blobs).unwrap().permissions();
        perms.set_mode(0o700);
        std::fs::set_permissions(&blobs, perms).unwrap();

        let health = health(&store, no_watcher_needed());
        assert_eq!(health.state, HealthState::Degraded);
        assert_eq!(health.flagged_sessions, 1);
    }
}

#[test]
fn a_recovered_commit_cursor_surfaces_as_degraded_with_a_note() {
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());
    let store = bound(dir.path());

    store.set_commit_cursor(WORKSPACE, "deadbeef", true).unwrap();

    let health = health(&store, watching());
    assert_eq!(health.state, HealthState::Degraded);
    assert!(
        health.issues.iter().any(|i| i.reason.contains("lost this Workspace's place")),
        "{:?}",
        health.issues
    );
}

#[test]
fn a_normal_cursor_is_not_degraded() {
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());
    let store = bound(dir.path());
    store.set_commit_cursor(WORKSPACE, "deadbeef", false).unwrap();
    assert_eq!(health(&store, watching()).state, HealthState::Ok);
}

// ── Stopped ─────────────────────────────────────────────────────────────────

#[test]
fn a_dead_watcher_moves_the_workspace_to_stopped() {
    // The historical clear-all path made this reachable through normal UI flow,
    // and it was invisible because a dead watcher and a quiet repository look
    // identical from the event stream. This is why liveness is checked against
    // actual watcher state rather than inferred from silence.
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());
    let store = bound(dir.path());

    let stopped = HostSignals {
        watcher_attached: false,
        expects_watcher: true,
        holds_writer: Some(true),
        worker_alive: true,
    };
    let health = health(&store, stopped);

    assert_eq!(health.state, HealthState::Stopped);
    assert!(
        health.issues.iter().any(|i| i.reason.contains("Git watcher")),
        "{:?}",
        health.issues
    );
}

#[test]
fn a_workspace_that_was_never_enabled_is_off_rather_than_broken() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(dir.path());
    let health = health(&store, no_watcher_needed());

    // Not `Stopped`. Nobody asked this Workspace to record anything, so there is
    // no fault to report — and reporting one lights three alarms (no binding, no
    // watcher, no writer lock) on the very first Workspace a new user opens.
    assert_eq!(health.state, HealthState::Off);
    assert!(health.issues.is_empty(), "{:?}", health.issues);
    assert_eq!(health.summary, "Session capture is off");
}

#[test]
fn a_paused_workspace_is_off_and_still_reports_what_it_holds() {
    let dir = tempfile::tempdir().unwrap();
    let store = bound(dir.path());
    disable(&store).unwrap();

    let health = health(&store, no_watcher_needed());
    // Pausing is a choice the developer made. Nothing is wrong.
    assert_eq!(health.state, HealthState::Off);
    assert!(health.issues.is_empty(), "{:?}", health.issues);
    assert_eq!(health.summary, "Session capture is paused");
    // The counts survive the pause — work captured before it is still there.
    assert_eq!(health.pending_rows, 0);
    assert_eq!(health.flagged_sessions, 0);
}

#[test]
fn a_second_window_reports_stopped_rather_than_silently_not_recording() {
    let dir = tempfile::tempdir().unwrap();
    let _holder = bound(dir.path());

    let second = store_in(dir.path());
    assert!(!second.is_writer());

    // Writer-ness is a host signal, not something read off the store: the health
    // read runs against a reader connection that never asked for the lock.
    // `Some(false)` — a *lost* acquisition, not merely an unopened store.
    let health = health(
        &second,
        HostSignals {
            watcher_attached: false,
            expects_watcher: false,
            holds_writer: Some(false),
            worker_alive: true,
        },
    );
    assert_eq!(health.state, HealthState::Stopped);
    assert!(
        health.issues.iter().any(|i| i.reason.contains("Another Atlas window")),
        "{:?}",
        health.issues
    );
}

#[test]
fn a_workspace_never_opened_this_process_is_not_another_window() {
    // Before the first capture event lands, the host's store registry has no
    // entry for the Workspace — no claim on the writer lock either way. The old
    // boolean signal read that as "lost the lock" and reported a phantom second
    // window on every health poll after app start.
    let dir = tempfile::tempdir().unwrap();
    let store = bound(dir.path());

    let health = health(
        &store,
        HostSignals {
            watcher_attached: false,
            expects_watcher: false,
            holds_writer: None,
            worker_alive: true,
        },
    );
    assert_eq!(health.state, HealthState::Ok, "{:?}", health.issues);
    assert!(
        !health.issues.iter().any(|i| i.reason.contains("Another Atlas window")),
        "{:?}",
        health.issues
    );
}

#[test]
fn a_dead_capture_worker_reports_stopped() {
    // A dead worker is total silent capture loss — every write funnels through
    // it — and previously health kept reporting whatever the store last said.
    let dir = tempfile::tempdir().unwrap();
    let store = bound(dir.path());

    let health = health(
        &store,
        HostSignals {
            watcher_attached: false,
            expects_watcher: false,
            holds_writer: Some(true),
            worker_alive: false,
        },
    );
    assert_eq!(health.state, HealthState::Stopped);
    assert!(
        health.issues.iter().any(|i| i.reason.contains("capture worker")),
        "{:?}",
        health.issues
    );
}

#[test]
fn a_revoked_drain_authorization_surfaces_without_stopping_capture() {
    // Degraded, not Stopped: capture keeps recording locally — only the drain
    // is gated — and the reason still says work is not reaching the team.
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(dir.path());
    bind(&store, WORKSPACE, dir.path(), WorkspaceMode::Cloud).unwrap();
    store
        .set_drain_state(atlas_checkpoint::model::DrainGate::NotAuthorized)
        .unwrap();

    let health = health(&store, no_watcher_needed());
    assert_eq!(health.state, HealthState::Degraded);
    assert!(
        health.issues.iter().any(|i| i.reason.contains("authorized")),
        "{:?}",
        health.issues
    );
    assert!(health.issues.iter().all(|i| !i.next_step.is_empty()));
}

#[test]
fn a_mass_orphan_reconcile_note_surfaces_as_degraded_with_the_count() {
    let dir = tempfile::tempdir().unwrap();
    let store = bound(dir.path());
    store
        .set_reconcile_note(WORKSPACE, r#"{"relinked":0,"orphaned":12,"recovered":0}"#)
        .unwrap();

    let health = health(&store, no_watcher_needed());
    assert_eq!(health.state, HealthState::Degraded);
    assert!(
        health.issues.iter().any(|i| i.reason.contains("12 Checkpoint")),
        "{:?}",
        health.issues
    );
}

#[test]
fn a_quiet_reconcile_note_is_not_an_issue() {
    // An ordinary squash orphaning one Checkpoint is correct behaviour, not an
    // incident; only bulk detachment or a wedged pass is worth an alarm.
    let dir = tempfile::tempdir().unwrap();
    let store = bound(dir.path());
    store
        .set_reconcile_note(WORKSPACE, r#"{"relinked":2,"orphaned":1,"failed":0}"#)
        .unwrap();

    assert_eq!(health(&store, no_watcher_needed()).state, HealthState::Ok);
}

#[test]
fn a_partly_failed_reconcile_pass_surfaces_as_degraded() {
    let dir = tempfile::tempdir().unwrap();
    let store = bound(dir.path());
    store
        .set_reconcile_note(WORKSPACE, r#"{"relinked":0,"orphaned":0,"failed":3}"#)
        .unwrap();

    let health = health(&store, no_watcher_needed());
    assert_eq!(health.state, HealthState::Degraded);
    assert!(
        health.issues.iter().any(|i| i.reason.contains("reconciliation")),
        "{:?}",
        health.issues
    );
}

#[test]
fn an_unreadable_reconcile_note_never_breaks_the_signal() {
    let dir = tempfile::tempdir().unwrap();
    let store = bound(dir.path());
    store.set_reconcile_note(WORKSPACE, "not json at all").unwrap();

    // Tolerant parse: the health signal must never itself become the failure.
    assert_eq!(health(&store, no_watcher_needed()).state, HealthState::Ok);
}

#[test]
fn an_unwritable_store_reports_stopped_with_the_cause() {
    let dir = tempfile::tempdir().unwrap();
    let store = bound(dir.path());

    let atlas = dir.path().join(".atlas");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&atlas).unwrap().permissions();
        perms.set_mode(0o500);
        std::fs::set_permissions(&atlas, perms).unwrap();
    }

    #[cfg(unix)]
    let result = health(&store, no_watcher_needed());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&atlas).unwrap().permissions();
        perms.set_mode(0o700);
        std::fs::set_permissions(&atlas, perms).unwrap();

        assert_eq!(result.state, HealthState::Stopped);
        assert!(
            result.issues.iter().any(|i| i.reason.contains("cannot be written")),
            "{:?}",
            result.issues
        );
    }
}

// ── Precedence and recovery ─────────────────────────────────────────────────

#[test]
fn stopped_outranks_degraded_in_the_summary() {
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());
    let mut store = bound(dir.path());
    let session = record_session(&mut store, "s1");
    store.flag_needs_attention(&session, "redaction failed").unwrap();

    let both = HealthSignalsBoth(&store);
    let health = both.evaluate();
    assert_eq!(health.state, HealthState::Stopped, "the worse state wins");
    assert!(health.issues.len() >= 2, "both conditions are still listed");
    assert_eq!(health.issues[0].state, HealthState::Stopped, "worst first");
}

/// A Workspace that is both watcher-dead and has a flagged Session.
struct HealthSignalsBoth<'a>(&'a Store);

impl HealthSignalsBoth<'_> {
    fn evaluate(&self) -> CaptureHealth {
        evaluate_health(
            self.0,
            WORKSPACE,
            HostSignals {
                watcher_attached: false,
                expects_watcher: true,
                holds_writer: Some(true),
                worker_alive: true,
            },
        )
        .expect("health evaluates")
    }
}

#[test]
fn health_returns_to_ok_by_itself_once_the_condition_clears() {
    // Recovery is automatic where possible — no restart, no acknowledgement
    // step for a condition that fixed itself.
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());
    let store = bound(dir.path());

    let stopped = HealthSignalsBoth(&store).evaluate();
    assert_eq!(stopped.state, HealthState::Stopped);

    // The watcher comes back.
    assert_eq!(health(&store, watching()).state, HealthState::Ok);
}

#[test]
fn evaluating_health_never_fails_on_a_workspace_with_no_history() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(dir.path());
    let health = health(&store, no_watcher_needed());
    assert_eq!(health.flagged_sessions, 0);
    assert_eq!(health.failed_rows, 0);
    assert_eq!(health.pending_rows, 0);
}

#[test]
fn evaluation_is_cheap_enough_to_run_on_every_turn() {
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());
    let mut store = bound(dir.path());
    for i in 0..50 {
        record_session(&mut store, &format!("s{i}"));
    }

    let started = std::time::Instant::now();
    for _ in 0..100 {
        health(&store, watching());
    }
    let per_call = started.elapsed() / 100;
    assert!(
        per_call.as_millis() < 20,
        "{per_call:?} per evaluation is too slow to run on every turn"
    );
}

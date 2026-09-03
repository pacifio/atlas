//! Seam 1 — the `atlas-checkpoint` public API, exercised against real I/O.
//!
//! A real temporary directory, a real SQLite database, real blob files. No mock
//! traits, no assertions on internal call ordering. What is asserted is what
//! ends up in the store, read back through the same public API a consumer would
//! use — a secret is proven absent by reading the row, not by inspecting the
//! redactor.
//!
//! This follows the existing auth-core tests, which drive the real client and
//! real file I/O against a temporary directory for the same reason.

use atlas_checkpoint::model::WorkspaceMode;
use atlas_checkpoint::{
    Capture, Error, Mode, Role, SessionKey, Source, Store, SyncState, TokenTotals, TurnContent,
    SPILL_THRESHOLD_BYTES,
};

const WORKSPACE: &str = "ws-atlas";

fn store_in(dir: &std::path::Path) -> Store {
    Store::open(dir.join(".atlas")).expect("store opens")
}

fn key(native: &str) -> SessionKey {
    SessionKey {
        workspace_id: WORKSPACE.to_string(),
        source: Source::Acp,
        native_session_id: native.to_string(),
    }
}

fn assistant(turn_seq: i64, body: &str) -> TurnContent {
    TurnContent {
        turn_seq,
        native_message_id: None,
        role: Role::Assistant,
        mode: Mode::Text,
        body: body.to_string(),
        created_at: None,
    }
}

// ── The tracer bullet ───────────────────────────────────────────────────────

#[test]
fn a_session_with_several_turns_produces_one_session_and_one_message_per_turn() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let session_id = capture
        .record_prompt(
            &key("sess-1"),
            "Add rate limiting to the upload endpoint",
            1,
            Some("claude-code"),
            Some("opus-5"),
            Some("/tmp/atlas"),
        )
        .expect("prompt recorded");
    capture
        .record_turn(&session_id, assistant(1, "I've added a token bucket."))
        .expect("turn recorded");
    capture.finish_turn(&session_id, 1).unwrap();

    capture
        .record_prompt(&key("sess-1"), "Now cover the burst case", 2, None, None, None)
        .unwrap();
    capture
        .record_turn(&session_id, assistant(2, "Added a burst allowance."))
        .unwrap();
    capture.finish_turn(&session_id, 2).unwrap();

    let sessions = store.sessions_for_workspace(WORKSPACE).unwrap();
    assert_eq!(sessions.len(), 1, "one conversation, one Session row");

    let messages = store.messages_for_session(&session_id).unwrap();
    // Two prompts and two responses.
    assert_eq!(messages.len(), 4);
    assert!(messages.windows(2).all(|w| w[0].seq < w[1].seq), "seq must be ordered");
}

#[test]
fn the_session_row_carries_its_identifying_facts() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let session_id = capture
        .record_prompt(
            &key("sess-abc"),
            "Fix the flaky auth test in CI",
            1,
            Some("claude-code"),
            Some("opus-5"),
            Some("/Users/nafiz/dev/atlas"),
        )
        .unwrap();
    capture
        .record_usage(
            &session_id,
            &TokenTotals { input_tokens: 1200, output_tokens: 340, ..Default::default() },
        )
        .unwrap();

    let session = store.session(&session_id).unwrap().expect("session");
    assert_eq!(session.title.as_deref(), Some("Fix the flaky auth test in CI"));
    assert_eq!(session.source, Source::Acp);
    assert_eq!(session.native_session_id, "sess-abc");
    assert_eq!(session.agent.as_deref(), Some("claude-code"));
    assert_eq!(session.model.as_deref(), Some("opus-5"));
    assert_eq!(session.cwd.as_deref(), Some("/Users/nafiz/dev/atlas"));
    assert_eq!(session.token_totals.input_tokens, 1200);
    assert_eq!(session.token_totals.output_tokens, 340);
    assert!(session.token_totals.has_usage_split());
    // Reserved for a later opt-in pass; generation must never block a write.
    assert_eq!(session.summary, None);
}

#[test]
fn the_title_derives_from_the_user_prompt_which_is_not_on_the_delta_stream() {
    // The prompt reaches capture through an explicit call from the send path,
    // because the session actor never emits it as a delta. If that call were
    // ever dropped, this test is what fails.
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let session_id = capture
        .record_prompt(&key("s"), "Investigate why the watcher misses renames", 1, None, None, None)
        .unwrap();

    let session = store.session(&session_id).unwrap().unwrap();
    assert_eq!(
        session.title.as_deref(),
        Some("Investigate why the watcher misses renames")
    );

    let prompts = store
        .messages_for_session(&session_id)
        .unwrap()
        .into_iter()
        .filter(|m| m.role == Role::User)
        .count();
    assert_eq!(prompts, 1, "the prompt itself is stored, not only its title");
}

#[test]
fn the_title_is_present_the_moment_the_first_turn_completes() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let session_id = capture
        .record_prompt(&key("s"), "Add rate limiting", 1, None, None, None)
        .unwrap();
    // No model call, no async enrichment, nothing to wait for.
    assert!(store.session(&session_id).unwrap().unwrap().title.is_some());
}

#[test]
fn a_later_prompt_does_not_rewrite_the_title() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let session_id = capture
        .record_prompt(&key("s"), "First question", 1, None, None, None)
        .unwrap();
    capture
        .record_prompt(&key("s"), "Second question", 2, None, None, None)
        .unwrap();

    assert_eq!(
        store.session(&session_id).unwrap().unwrap().title.as_deref(),
        Some("First question")
    );
}

// ── Queryable facets ────────────────────────────────────────────────────────

#[test]
fn role_and_mode_are_columns_so_the_sidebar_counts_need_no_body_read() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let session_id = capture
        .record_prompt(&key("s"), "Add rate limiting", 1, None, None, None)
        .unwrap();
    capture.record_turn(&session_id, assistant(1, "Here is the plan.")).unwrap();
    capture
        .record_turn(
            &session_id,
            TurnContent {
                turn_seq: 1,
                native_message_id: None,
                role: Role::Assistant,
                mode: Mode::Thinking,
                body: "Considering a token bucket versus a leaky bucket.".into(),
                created_at: None,
            },
        )
        .unwrap();
    capture.record_turn(&session_id, assistant(1, "Done.")).unwrap();

    let counts = store.facet_counts(&session_id).unwrap();
    let lookup = |role, mode| {
        counts
            .iter()
            .find(|((r, m), _)| *r == role && *m == mode)
            .map(|(_, c)| *c)
            .unwrap_or(0)
    };

    assert_eq!(lookup(Role::User, Mode::Text), 1, "Prompts");
    assert_eq!(lookup(Role::Assistant, Mode::Text), 2, "Responses");
    assert_eq!(lookup(Role::Assistant, Mode::Thinking), 1, "Intermediate steps");
}

#[test]
fn the_indexes_the_store_promises_actually_exist() {
    // An index silently lost in a migration is a full scan nobody notices until
    // a developer with a year of history opens the board.
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(dir.path());
    let present = store.index_names().unwrap();
    for required in atlas_checkpoint::REQUIRED_INDEXES {
        assert!(
            present.iter().any(|name| name == required),
            "missing index {required}; have {present:?}"
        );
    }
}

// ── Redaction on the way in ─────────────────────────────────────────────────

#[test]
fn a_secret_in_a_turn_is_absent_from_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let session_id = capture
        .record_prompt(&key("s"), "check the config", 1, None, None, None)
        .unwrap();
    capture
        .record_turn(
            &session_id,
            assistant(1, "I read .env and found API_KEY=supersecretvalue123"),
        )
        .unwrap();

    // Read the row back — the assertion is about what is stored, not about what
    // the redactor claims to do.
    let messages = store.messages_for_session(&session_id).unwrap();
    let stored = messages.iter().find(|m| m.role == Role::Assistant).unwrap();
    let body = store.message_body(stored).unwrap();
    assert!(!body.contains("supersecretvalue123"), "secret stored: {body}");
    assert!(body.contains("[REDACTED]"));
    assert!(!stored.preview.contains("supersecretvalue123"));
}

#[test]
fn a_secret_pasted_into_the_first_prompt_is_absent_from_the_stored_title() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let session_id = capture
        .record_prompt(
            &key("s"),
            "here's my key sk-ABCDEF0123456789ABCDEF, why is it failing",
            1,
            None,
            None,
            None,
        )
        .unwrap();

    // The title is the single most visible string in the product — it renders on
    // the shared Organisation board.
    let title = store.session(&session_id).unwrap().unwrap().title.unwrap();
    assert!(!title.contains("sk-ABCDEF0123456789ABCDEF"), "{title}");

    let body = {
        let messages = store.messages_for_session(&session_id).unwrap();
        store.message_body(&messages[0]).unwrap()
    };
    assert!(!body.contains("sk-ABCDEF0123456789ABCDEF"));
}

#[test]
fn the_redaction_tally_accumulates_on_the_session() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let session_id = capture
        .record_prompt(&key("s"), "deploy notes", 1, None, None, None)
        .unwrap();
    capture
        .record_turn(&session_id, assistant(1, "API_KEY=supersecretvalue123"))
        .unwrap();
    capture
        .record_turn(&session_id, assistant(1, "DB_PASSWORD=anothersecretvalue"))
        .unwrap();

    // This is what the promotion and import confirmations show a developer
    // before a bulk disclosure.
    let counts = store.session(&session_id).unwrap().unwrap().redaction_counts;
    let total: u64 = counts
        .as_object()
        .unwrap()
        .values()
        .filter_map(serde_json::Value::as_u64)
        .sum();
    assert_eq!(total, 2);
}

// ── Spill ───────────────────────────────────────────────────────────────────

#[test]
fn a_body_over_the_threshold_is_spilled_and_referenced_with_a_preview_retained() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let session_id = capture
        .record_prompt(&key("s"), "read the log", 1, None, None, None)
        .unwrap();

    // The measured corpus's largest single message is 2.02 MB.
    let huge = "log line with some content\n".repeat(90_000);
    assert!(huge.len() > SPILL_THRESHOLD_BYTES);
    capture.record_turn(&session_id, assistant(1, &huge)).unwrap();

    let messages = store.messages_for_session(&session_id).unwrap();
    let stored = messages.iter().find(|m| m.role == Role::Assistant).unwrap();

    assert!(stored.is_spilled(), "large body should not sit on the row");
    assert!(stored.body.is_none());
    assert!(!stored.preview.is_empty(), "a preview is what a list renders");
    assert!(stored.preview.len() <= atlas_checkpoint::PREVIEW_BYTES);
    // Round-trips in full: the detail view must show what actually happened.
    assert_eq!(store.message_body(stored).unwrap().len(), huge.len());
}

#[test]
fn a_small_body_stays_inline() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let session_id = capture.record_prompt(&key("s"), "hi", 1, None, None, None).unwrap();
    capture.record_turn(&session_id, assistant(1, "hello")).unwrap();

    let messages = store.messages_for_session(&session_id).unwrap();
    let stored = messages.iter().find(|m| m.role == Role::Assistant).unwrap();
    assert!(!stored.is_spilled());
    assert_eq!(stored.body.as_deref(), Some("hello"));
}

// ── Identity and idempotency ────────────────────────────────────────────────

#[test]
fn two_concurrent_sessions_in_one_workspace_stay_separate() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let first = capture
        .record_prompt(&key("sess-a"), "Work on the parser", 1, None, None, None)
        .unwrap();
    let second = capture
        .record_prompt(&key("sess-b"), "Work on the watcher", 1, None, None, None)
        .unwrap();
    assert_ne!(first, second);

    capture.record_turn(&first, assistant(1, "parser change")).unwrap();
    capture.record_turn(&second, assistant(1, "watcher change")).unwrap();

    assert_eq!(store.sessions_for_workspace(WORKSPACE).unwrap().len(), 2);
    assert_eq!(store.messages_for_session(&first).unwrap().len(), 2);
    assert_eq!(store.messages_for_session(&second).unwrap().len(), 2);
}

#[test]
fn a_resubmitted_prompt_does_not_duplicate_the_user_message() {
    // A frontend retry of the send, or a re-processed delta: same turn, same
    // text. The prompt has no agent-issued id, so capture synthesises a
    // deterministic one — without it every retry would insert a second row.
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let first = capture
        .record_prompt(&key("s"), "Add rate limiting", 1, None, None, None)
        .unwrap();
    let second = capture
        .record_prompt(&key("s"), "Add rate limiting", 1, None, None, None)
        .unwrap();
    assert_eq!(first, second);

    let prompts = store
        .messages_for_session(&first)
        .unwrap()
        .into_iter()
        .filter(|m| m.role == Role::User)
        .count();
    assert_eq!(prompts, 1, "a retried send is one prompt, not two");
}

#[test]
fn distinct_prompts_on_later_turns_still_record() {
    // The synthesised id must dedupe retries without swallowing real prompts.
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let session_id = capture
        .record_prompt(&key("s"), "First question", 1, None, None, None)
        .unwrap();
    capture
        .record_prompt(&key("s"), "Second question", 2, None, None, None)
        .unwrap();
    // Same turn number resubmitted with edited text is a different prompt too.
    capture
        .record_prompt(&key("s"), "Second question, edited", 2, None, None, None)
        .unwrap();

    let prompts = store
        .messages_for_session(&session_id)
        .unwrap()
        .into_iter()
        .filter(|m| m.role == Role::User)
        .count();
    assert_eq!(prompts, 3);
}

#[test]
fn a_turn_recorded_with_its_own_timestamp_keeps_it() {
    // The importer passes the transcript's clock; live capture passes None and
    // gets "now". This is what keeps a year of imported history from all dating
    // to the day the import ran.
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let session_id = capture.record_prompt(&key("s"), "hi", 1, None, None, None).unwrap();
    let then = chrono::DateTime::parse_from_rfc3339("2025-03-04T05:06:07Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    capture
        .record_turn(
            &session_id,
            TurnContent {
                turn_seq: 1,
                native_message_id: Some("m-1".into()),
                role: Role::Assistant,
                mode: Mode::Text,
                body: "an old answer".into(),
                created_at: Some(then),
            },
        )
        .unwrap();

    let stored = store
        .messages_for_session(&session_id)
        .unwrap()
        .into_iter()
        .find(|m| m.role == Role::Assistant)
        .unwrap();
    assert_eq!(stored.created_at, then);
}

#[test]
fn re_processing_the_same_turn_does_not_duplicate_the_message() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let session_id = capture.record_prompt(&key("s"), "hi", 1, None, None, None).unwrap();
    let content = TurnContent {
        turn_seq: 1,
        native_message_id: Some("msg-from-the-agent".into()),
        role: Role::Assistant,
        mode: Mode::Text,
        body: "the answer".into(),
        created_at: None,
    };

    assert!(capture.record_turn(&session_id, content.clone()).unwrap().is_some());
    assert!(
        capture.record_turn(&session_id, content).unwrap().is_none(),
        "a second sighting of the same message is a no-op"
    );

    let assistant_messages = store
        .messages_for_session(&session_id)
        .unwrap()
        .into_iter()
        .filter(|m| m.role == Role::Assistant)
        .count();
    assert_eq!(assistant_messages, 1);
}

#[test]
fn the_same_conversation_seen_twice_reuses_its_session_row() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let first = capture.record_prompt(&key("sess-1"), "one", 1, None, None, None).unwrap();
    let second = capture.record_prompt(&key("sess-1"), "two", 2, None, None, None).unwrap();
    assert_eq!(first, second, "identity is (workspace, source, native id)");
    assert_eq!(store.sessions_for_workspace(WORKSPACE).unwrap().len(), 1);
}

#[test]
fn the_same_native_id_under_a_different_source_is_a_different_row() {
    // Deliberate: Atlas's ACP-hosted Claude Code also writes its own JSONL, so
    // ('acp', id) and ('external_jsonl', id) are both legitimate. Skipping that
    // duplicate is the importer's explicit job, not the schema's.
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    capture.record_prompt(&key("shared-id"), "live", 1, None, None, None).unwrap();
    capture
        .record_prompt(
            &SessionKey {
                workspace_id: WORKSPACE.into(),
                source: Source::ExternalJsonl,
                native_session_id: "shared-id".into(),
            },
            "imported",
            1,
            None,
            None,
            None,
        )
        .unwrap();

    assert_eq!(store.sessions_for_workspace(WORKSPACE).unwrap().len(), 2);
    // …and this is the query the importer uses to catch it.
    assert!(store.native_session_exists(WORKSPACE, "shared-id").unwrap());
}

// ── Sync state ──────────────────────────────────────────────────────────────

#[test]
fn every_row_starts_local_in_a_local_workspace_and_nothing_is_uploaded() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let session_id = capture.record_prompt(&key("s"), "hi", 1, None, None, None).unwrap();
    capture.record_turn(&session_id, assistant(1, "hello")).unwrap();

    assert_eq!(
        store.session(&session_id).unwrap().unwrap().sync_state,
        SyncState::Local
    );
    for message in store.messages_for_session(&session_id).unwrap() {
        assert_eq!(message.sync_state, SyncState::Local);
    }
}

#[test]
fn a_cloud_workspace_starts_rows_pending_for_the_drain() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let mut capture = Capture::new(&mut store, WorkspaceMode::Cloud);

    let session_id = capture.record_prompt(&key("s"), "hi", 1, None, None, None).unwrap();
    capture.record_turn(&session_id, assistant(1, "hello")).unwrap();

    assert_eq!(
        store.session(&session_id).unwrap().unwrap().sync_state,
        SyncState::Pending
    );
}

// ── Durability ──────────────────────────────────────────────────────────────

#[test]
fn completed_turns_survive_reopening_the_store() {
    let dir = tempfile::tempdir().unwrap();
    let session_id = {
        let mut store = store_in(dir.path());
        let mut capture = Capture::new(&mut store, WorkspaceMode::Local);
        let session_id = capture
            .record_prompt(&key("s"), "Add rate limiting", 1, None, None, None)
            .unwrap();
        capture.record_turn(&session_id, assistant(1, "done")).unwrap();
        capture.finish_turn(&session_id, 1).unwrap();
        session_id
    };

    let reopened = store_in(dir.path());
    assert_eq!(reopened.messages_for_session(&session_id).unwrap().len(), 2);
    assert!(reopened.session(&session_id).unwrap().unwrap().title.is_some());
}

#[test]
fn a_turn_left_open_is_reconciled_as_aborted_rather_than_read_as_finished() {
    let dir = tempfile::tempdir().unwrap();
    let session_id = {
        let mut store = store_in(dir.path());
        let mut capture = Capture::new(&mut store, WorkspaceMode::Local);
        let session_id = capture
            .record_prompt(&key("s"), "long running task", 1, None, None, None)
            .unwrap();
        capture.record_turn(&session_id, assistant(1, "partial")).unwrap();
        // No `finish_turn` — the agent died mid-turn.
        session_id
    };

    let reopened = store_in(dir.path());
    assert_eq!(
        reopened.turn_state(&session_id, 1).unwrap(),
        Some(atlas_checkpoint::TurnState::Aborted),
        "an abandoned turn must be distinguishable from a completed one"
    );
}

#[test]
fn a_completed_turn_stays_completed_across_a_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let session_id = {
        let mut store = store_in(dir.path());
        let mut capture = Capture::new(&mut store, WorkspaceMode::Local);
        let session_id = capture.record_prompt(&key("s"), "task", 1, None, None, None).unwrap();
        capture.finish_turn(&session_id, 1).unwrap();
        session_id
    };

    let reopened = store_in(dir.path());
    assert_eq!(
        reopened.turn_state(&session_id, 1).unwrap(),
        Some(atlas_checkpoint::TurnState::Completed)
    );
}

// ── One writer per Workspace ────────────────────────────────────────────────

#[test]
fn a_second_store_on_the_same_workspace_cannot_become_a_second_writer() {
    // Multi-window is normal usage, and two capture loops writing one SQLite
    // file with no coordination corrupts the outbox state machine.
    let dir = tempfile::tempdir().unwrap();
    let first = store_in(dir.path());
    assert!(first.is_writer());

    let second = store_in(dir.path());
    assert!(!second.is_writer(), "second window must not become a writer");

    // …but it can still read, so the timeline browses in both windows.
    assert!(second.sessions_for_workspace(WORKSPACE).is_ok());
}

#[test]
fn a_non_writer_refuses_to_record_rather_than_writing_anyway() {
    let dir = tempfile::tempdir().unwrap();
    let _holder = store_in(dir.path());

    let mut second = store_in(dir.path());
    let mut capture = Capture::new(&mut second, WorkspaceMode::Local);
    let result = capture.record_prompt(&key("s"), "hi", 1, None, None, None);

    assert!(
        matches!(result, Err(Error::AlreadyLocked)),
        "expected a refusal, got {result:?}"
    );
}

#[test]
fn the_writer_lock_is_released_when_the_first_window_closes() {
    let dir = tempfile::tempdir().unwrap();
    drop(store_in(dir.path()));
    assert!(store_in(dir.path()).is_writer());
}

// ── Failure handling ────────────────────────────────────────────────────────

#[test]
fn a_storage_failure_flags_the_session_and_does_not_panic() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);

    let session_id = capture.record_prompt(&key("s"), "hi", 1, None, None, None).unwrap();

    // Make the blob directory unwritable, so spilling a large body fails the
    // way a full disk or a permissions problem would.
    let blobs = dir.path().join(".atlas").join("blobs");
    std::fs::create_dir_all(&blobs).unwrap();
    let mut perms = std::fs::metadata(&blobs).unwrap().permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o500);
    }
    std::fs::set_permissions(&blobs, perms).unwrap();

    let huge = "x".repeat(SPILL_THRESHOLD_BYTES + 1);
    let result = capture.record_turn(&session_id, assistant(1, &huge));

    // Restore before asserting, so a failure here does not leave an
    // undeletable temp directory behind.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&blobs).unwrap().permissions();
        perms.set_mode(0o700);
        std::fs::set_permissions(&blobs, perms).unwrap();
    }

    #[cfg(unix)]
    {
        assert!(result.is_err(), "expected the write to fail");
        let session = store.session(&session_id).unwrap().unwrap();
        assert!(session.needs_attention, "the developer must be told");
        assert!(session.attention_reason.is_some());
    }
    #[cfg(not(unix))]
    let _ = result;
}

#[test]
fn a_workspace_with_no_prior_store_opens_clean() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(dir.path());
    assert!(store.sessions_for_workspace(WORKSPACE).unwrap().is_empty());
    assert!(store.root().join("sessions.db").exists());
}

// ── Latency ─────────────────────────────────────────────────────────────────

#[test]
fn capture_adds_no_perceptible_latency_to_a_turn() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    let mut capture = Capture::new(&mut store, WorkspaceMode::Local);
    let session_id = capture.record_prompt(&key("s"), "go", 1, None, None, None).unwrap();

    // A realistic assistant turn, recorded a hundred times.
    let body = "I've added a token bucket keyed on org_id.\n".repeat(40);
    let started = std::time::Instant::now();
    for turn in 0..100 {
        capture.record_turn(&session_id, assistant(turn, &body)).unwrap();
    }
    let per_turn = started.elapsed() / 100;

    assert!(
        per_turn.as_millis() < 50,
        "{per_turn:?} per turn is enough to be felt at the end of a turn"
    );
}

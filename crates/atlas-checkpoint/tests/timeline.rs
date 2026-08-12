//! The read model, exercised against a store filled the way capture fills it.
//!
//! These tests exist because the recorder shipped without one. Every assertion
//! below is a fact a developer reads off the Sessions list or the Session
//! timeline, checked end to end: written through `Capture`, read back through
//! `timeline`, with nothing mocked in between.

use chrono::{DateTime, Duration, TimeZone, Utc};

use atlas_checkpoint::model::WorkspaceMode;
use atlas_checkpoint::timeline::{self, EntryKind};
use atlas_checkpoint::{
    Capture, CheckpointInput, Mode, Role, SessionKey, Source, Store, TokenTotals, TurnContent,
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

/// One Session with two turns and a response in each.
fn seeded(dir: &std::path::Path) -> (Store, String) {
    let mut store = store_in(dir);
    let session_id = {
        let mut capture = Capture::new(&mut store, WorkspaceMode::Local);
        let id = capture
            .record_prompt(
                &key("sess-1"),
                "Add rate limiting to the upload endpoint",
                1,
                Some("claude-code"),
                Some("opus-5"),
                Some("/tmp/atlas"),
            )
            .expect("prompt recorded");
        capture.record_turn(&id, assistant(1, "Added a token bucket.")).unwrap();
        capture.record_prompt(&key("sess-1"), "Now cover it with tests", 2, None, None, None).unwrap();
        capture.record_turn(&id, assistant(2, "Tests added.")).unwrap();
        id
    };
    (store, session_id)
}

fn no_subjects(_: &str) -> Option<String> {
    None
}

// ── The Sessions list ───────────────────────────────────────────────────────

#[test]
fn a_captured_session_appears_in_the_list_with_the_facts_the_row_shows() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = seeded(dir.path());

    let sessions = timeline::sessions(&store, WORKSPACE).expect("sessions read");
    assert_eq!(sessions.len(), 1);

    let row = &sessions[0];
    assert_eq!(row.title.as_deref(), Some("Add rate limiting to the upload endpoint"));
    assert_eq!(row.agent.as_deref(), Some("claude-code"));
    assert_eq!(row.model.as_deref(), Some("opus-5"));
    assert_eq!(row.source, "acp");
    assert_eq!(row.message_count, 4);
    assert_eq!(row.checkpoint_count, 0);
    assert!(!row.needs_attention);
}

#[test]
fn a_workspace_with_nothing_captured_lists_nothing_rather_than_failing() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(dir.path());
    assert!(timeline::sessions(&store, WORKSPACE).unwrap().is_empty());
}

#[test]
fn sessions_are_newest_first_by_last_activity() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    {
        let mut capture = Capture::new(&mut store, WorkspaceMode::Local);
        capture.record_prompt(&key("older"), "First thing", 1, None, None, None).unwrap();
        capture.record_prompt(&key("newer"), "Second thing", 1, None, None, None).unwrap();
    }

    let sessions = timeline::sessions(&store, WORKSPACE).unwrap();
    assert_eq!(sessions.len(), 2);
    // The Session touched last leads, whatever order they were created in.
    assert!(sessions[0].updated_at >= sessions[1].updated_at);
}

#[test]
fn the_list_reports_a_flagged_session_so_a_hole_is_visible_where_it_is_read() {
    let dir = tempfile::tempdir().unwrap();
    let (store, session_id) = seeded(dir.path());
    store.flag_needs_attention(&session_id, "a tool result could not be scrubbed").unwrap();

    let row = &timeline::sessions(&store, WORKSPACE).unwrap()[0];
    assert!(row.needs_attention);
    assert_eq!(row.attention_reason.as_deref(), Some("a tool result could not be scrubbed"));
}

#[test]
fn token_totals_reach_the_row() {
    let dir = tempfile::tempdir().unwrap();
    let (store, session_id) = seeded(dir.path());
    store
        .set_token_totals(
            &session_id,
            &TokenTotals { input_tokens: 1200, output_tokens: 340, ..Default::default() },
        )
        .unwrap();

    assert_eq!(timeline::sessions(&store, WORKSPACE).unwrap()[0].total_tokens, 1540);
}

// ── The Session timeline ────────────────────────────────────────────────────

#[test]
fn the_timeline_reads_back_in_the_order_the_work_happened() {
    let dir = tempfile::tempdir().unwrap();
    let (store, session_id) = seeded(dir.path());

    let detail = timeline::detail(&store, &session_id, no_subjects).unwrap().expect("a session");
    let kinds: Vec<_> = detail.entries.iter().map(|e| e.kind).collect();
    assert_eq!(
        kinds,
        vec![EntryKind::Prompt, EntryKind::Response, EntryKind::Prompt, EntryKind::Response]
    );
    assert_eq!(detail.counts.prompts, 2);
    assert_eq!(detail.counts.responses, 2);
}

#[test]
fn message_text_survives_the_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let (store, session_id) = seeded(dir.path());

    let detail = timeline::detail(&store, &session_id, no_subjects).unwrap().unwrap();
    let prompt = detail.entries.iter().find(|e| e.kind == EntryKind::Prompt).unwrap();
    assert_eq!(prompt.text.as_deref(), Some("Add rate limiting to the upload endpoint"));
    assert!(!prompt.truncated);
}

#[test]
fn a_body_too_large_to_inline_arrives_as_a_preview_marked_truncated() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    // Comfortably over the inline limit, and over the spill threshold too.
    let huge = "log line that is not a secret\n".repeat(6_000);
    let session_id = {
        let mut capture = Capture::new(&mut store, WorkspaceMode::Local);
        let id = capture.record_prompt(&key("sess-big"), "Here is the log", 1, None, None, None).unwrap();
        capture.record_turn(&id, assistant(1, &huge)).unwrap();
        id
    };

    let detail = timeline::detail(&store, &session_id, no_subjects).unwrap().unwrap();
    let response = detail.entries.iter().find(|e| e.kind == EntryKind::Response).unwrap();
    assert!(response.truncated, "a body over the inline limit must be marked");
    assert!(response.body_bytes > timeline::INLINE_LIMIT_BYTES);
    // What arrives is the preview — enough to recognise, not the whole payload.
    let text = response.text.as_deref().unwrap_or_default();
    assert!(!text.is_empty());
    assert!((text.len() as i64) < response.body_bytes);
}

#[test]
fn a_checkpoint_closes_the_turn_whose_files_it_carries() {
    let dir = tempfile::tempdir().unwrap();
    let (store, session_id) = seeded(dir.path());
    store
        .upsert_checkpoint(CheckpointInput {
            session_id: &session_id,
            commit_sha: "0f1e2d3c4b5a69788796a5b4c3d2e1f001234567",
            patch_id: None,
            branch: Some("main"),
            git_author_name: Some("Nafiz"),
            git_author_email: Some("nafiz@example.com"),
            files_touched: &["src/upload.rs".into()],
            insertions: 42,
            deletions: 7,
            sync_state: atlas_checkpoint::SyncState::Local,
        })
        .expect("checkpoint recorded");

    let detail = timeline::detail(&store, &session_id, |sha| {
        Some(format!("Add rate limiting ({})", &sha[..7]))
    })
    .unwrap()
    .unwrap();

    let checkpoint = detail.entries.iter().find(|e| e.kind == EntryKind::Checkpoint).unwrap();
    assert_eq!(checkpoint.branch.as_deref(), Some("main"));
    assert_eq!(checkpoint.insertions, 42);
    assert_eq!(checkpoint.deletions, 7);
    // The subject comes from git at display time, not from a stale copy.
    assert_eq!(checkpoint.commit_subject.as_deref(), Some("Add rate limiting (0f1e2d3)"));
    assert_eq!(detail.counts.checkpoints, 1);
}

#[test]
fn a_checkpoint_still_renders_when_the_repository_can_no_longer_be_read() {
    let dir = tempfile::tempdir().unwrap();
    let (store, session_id) = seeded(dir.path());
    store
        .upsert_checkpoint(CheckpointInput {
            session_id: &session_id,
            commit_sha: "1111111111111111111111111111111111111111",
            patch_id: None,
            branch: None,
            git_author_name: None,
            git_author_email: None,
            files_touched: &[],
            insertions: 0,
            deletions: 0,
            sync_state: atlas_checkpoint::SyncState::Local,
        })
        .unwrap();

    // A moved or deleted repository resolves no subject. The Checkpoint is still
    // a real record and must not disappear from the timeline with it.
    let detail = timeline::detail(&store, &session_id, no_subjects).unwrap().unwrap();
    let checkpoint = detail.entries.iter().find(|e| e.kind == EntryKind::Checkpoint).unwrap();
    assert!(checkpoint.commit_subject.is_none());
    assert_eq!(checkpoint.commit_sha.as_deref().map(|s| &s[..4]), Some("1111"));
}

#[test]
fn an_unknown_session_reads_as_absent_rather_than_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_in(dir.path());
    assert!(timeline::detail(&store, "as-nope", no_subjects).unwrap().is_none());
}

// ── Reading while another store in this process holds the writer lock ───────

#[test]
fn a_reader_never_takes_the_writer_lock_from_the_store_that_holds_it() {
    // The bug this pins: the host opened a second `Store` on the same directory
    // for every command, which contended with its own capture worker for the
    // writer lock and lost. `capture_enable` then reported "another Atlas window
    // is already recording this workspace" — naming a window that did not exist
    // — and could never succeed on a Workspace the user had sent a prompt in.
    let dir = tempfile::tempdir().unwrap();
    let (writer, session_id) = seeded(dir.path());
    assert!(writer.is_writer(), "the first store must hold the lock");

    let reader = Store::open_reader(dir.path().join(".atlas")).expect("reader opens");
    assert!(!reader.is_writer(), "a reader must never claim the lock");
    // And crucially, the writer still holds it.
    assert!(writer.is_writer(), "opening a reader must not disturb the writer");

    // The reader sees everything the writer wrote.
    let sessions = timeline::sessions(&reader, WORKSPACE).unwrap();
    assert_eq!(sessions.len(), 1);
    assert!(timeline::detail(&reader, &session_id, no_subjects).unwrap().is_some());
}

#[test]
fn the_writer_keeps_writing_while_a_reader_is_open() {
    let dir = tempfile::tempdir().unwrap();
    let mut writer = store_in(dir.path());
    let reader = Store::open_reader(dir.path().join(".atlas")).expect("reader opens");

    // A write taken *after* the reader attached must still succeed — this is
    // what `require_writer` was rejecting.
    let session_id = {
        let mut capture = Capture::new(&mut writer, WorkspaceMode::Local);
        capture
            .record_prompt(&key("after-reader"), "Still recording", 1, None, None, None)
            .expect("the writer keeps its lock while a reader is attached")
    };

    // WAL: the reader opened before the write still sees it on a fresh query.
    let sessions = timeline::sessions(&reader, WORKSPACE).unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].id, session_id);
}

/// The recent-Checkpoints jump list.
///
/// Worth its own test because the query is the only one in the store that
/// JOINs, and it builds its column list by prefixing `CHECKPOINT_COLUMNS` — a
/// hand-assembled SELECT whose column order the row mapper depends on. A typo
/// there is a runtime error no type checks.
#[test]
fn recent_checkpoints_are_newest_first_and_carry_their_session_title() {
    let dir = tempfile::tempdir().unwrap();
    let (store, session_id) = seeded(dir.path());

    for (i, sha) in ["aaaaaaa1111111111111111111111111111111111", "bbbbbbb2222222222222222222222222222222222"]
        .iter()
        .enumerate()
    {
        store
            .upsert_checkpoint(CheckpointInput {
                session_id: &session_id,
                commit_sha: sha,
                patch_id: None,
                branch: Some("main"),
                git_author_name: None,
                git_author_email: None,
                files_touched: &["src/lib.rs".into()],
                insertions: (i as i64 + 1) * 10,
                deletions: i as i64,
                sync_state: atlas_checkpoint::SyncState::Local,
            })
            .expect("checkpoint recorded");
    }

    let rows = timeline::recent_checkpoints(&store, WORKSPACE, 10, |sha| {
        Some(format!("subject for {}", &sha[..4]))
    })
    .expect("read");

    assert_eq!(rows.len(), 2);
    // Newest first — the whole point of the ordering.
    assert!(rows[0].at >= rows[1].at, "{rows:?}");
    // The JOIN actually landed a title rather than a NULL.
    assert!(rows.iter().all(|r| r.session_title.is_some()), "{rows:?}");
    // Column order survived the `c.`-prefixing: these come from different
    // positions in the SELECT and a shifted mapper would cross them.
    let by_sha = rows.iter().find(|r| r.commit_sha.starts_with("bbb")).expect("row");
    assert_eq!(by_sha.insertions, 20);
    assert_eq!(by_sha.deletions, 1);
    assert_eq!(by_sha.branch.as_deref(), Some("main"));
    assert_eq!(by_sha.files, 1);
    assert_eq!(by_sha.commit_subject.as_deref(), Some("subject for bbbb"));

    // The limit is honoured, and honoured against the *newest*.
    let one = timeline::recent_checkpoints(&store, WORKSPACE, 1, |_| None).expect("read");
    assert_eq!(one.len(), 1);
    assert_eq!(one[0].commit_sha, rows[0].commit_sha);
}

/// Another Workspace's Checkpoints are not this Workspace's — the scoping runs
/// through the JOIN, which is the easiest thing to get wrong when adding one.
#[test]
fn recent_checkpoints_are_scoped_to_their_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let (store, session_id) = seeded(dir.path());
    store
        .upsert_checkpoint(CheckpointInput {
            session_id: &session_id,
            commit_sha: "ccccccc3333333333333333333333333333333333",
            patch_id: None,
            branch: None,
            git_author_name: None,
            git_author_email: None,
            files_touched: &[],
            insertions: 0,
            deletions: 0,
            sync_state: atlas_checkpoint::SyncState::Local,
        })
        .expect("checkpoint recorded");

    let mine = timeline::recent_checkpoints(&store, WORKSPACE, 10, |_| None).expect("read");
    assert_eq!(mine.len(), 1);

    let other = timeline::recent_checkpoints(&store, "ws-someone-else", 10, |_| None).expect("read");
    assert!(other.is_empty(), "{other:?}");
}

/// The branch a Session started on reaches the row even with no commit.
///
/// `branches` used to come only from Checkpoints, so the overwhelming majority
/// of Sessions — the ones that never produced a commit — had none, and the
/// Timeline's branch filter could not see them.
#[test]
fn a_session_carries_its_starting_branch_without_any_checkpoint() {
    let dir = tempfile::tempdir().unwrap();
    let (mut store, session_id) = seeded(dir.path());

    {
        let mut capture = Capture::new(&mut store, WorkspaceMode::Local);
        capture.note_branch(&session_id, Some("feat/atlas-tokens")).expect("branch recorded");
        // Idempotent: a checkout mid-conversation must not retro-label the row.
        capture.note_branch(&session_id, Some("main")).expect("second note is a no-op");
    }

    let rows = timeline::sessions(&store, WORKSPACE).expect("read");
    let row = rows.iter().find(|r| r.id == session_id).expect("row");
    assert_eq!(row.branches, vec!["feat/atlas-tokens".to_string()]);
    assert_eq!(row.checkpoint_count, 0, "no commit, and still a branch");
}

/// An agent that reports only context occupancy is not reported as token spend.
///
/// ACP agents (Claude Code, Codex) emit no input/output split, so `totalTokens`
/// stays 0 and the gauge travels in its own fields. Folding it into the total
/// would inflate every ACP row — and a compaction would make the number go
/// *down*, which no cumulative counter should ever do.
#[test]
fn context_occupancy_travels_separately_from_a_token_split() {
    let dir = tempfile::tempdir().unwrap();
    let (mut store, session_id) = seeded(dir.path());

    {
        let mut capture = Capture::new(&mut store, WorkspaceMode::Local);
        capture
            .record_usage(
                &session_id,
                &TokenTotals { context_used: Some(853_100), context_size: Some(1_000_000), ..Default::default() },
            )
            .expect("usage recorded");
    }

    let rows = timeline::sessions(&store, WORKSPACE).expect("read");
    let row = rows.iter().find(|r| r.id == session_id).expect("row");
    assert_eq!(row.total_tokens, 0, "occupancy is not consumption");
    assert_eq!(row.context_used, Some(853_100));
    assert_eq!(row.context_size, Some(1_000_000));
}

// ── Active time ─────────────────────────────────────────────────────────────
//
// The Timeline reported `updated_at - started_at` as a Session's duration.
// `updated_at` is stamped with the wall clock by every write there is, so a
// transcript that ran in June and was imported in July read as 1395 hours, and
// the board's stat rail summed 474 of those into 42488h. These pin the two
// facts that replaced it: agent time, and an honest span beside it.

/// A turn stamped with the transcript's own clock, the way the importer writes.
fn assistant_at(turn_seq: i64, body: &str, at: DateTime<Utc>) -> TurnContent {
    TurnContent {
        turn_seq,
        native_message_id: Some(format!("msg-{turn_seq}-{}", at.timestamp())),
        role: Role::Assistant,
        mode: Mode::Text,
        body: body.to_string(),
        created_at: Some(at),
    }
}

fn june(day: u32, hour: u32, minute: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 6, day, hour, minute, 0).unwrap()
}

/// Messages at the given times, on a Session with no closed turns — the shape
/// every imported transcript has.
fn imported_session(dir: &std::path::Path, native: &str, stamps: &[DateTime<Utc>]) -> (Store, String) {
    let mut store = store_in(dir);
    let id = {
        let mut capture = Capture::new(&mut store, WorkspaceMode::Local);
        // `ensure_session` + `record_turn`, exactly as the importer does it —
        // never `record_prompt`, which opens a turn and stamps the prompt with
        // the wall clock because it is the live-capture path.
        let id = capture
            .ensure_session(&key(native), Some("claude-code"), None, None, None)
            .expect("session");
        for (i, at) in stamps.iter().enumerate() {
            capture.record_turn(&id, assistant_at(i as i64 + 1, "Looked at it.", *at)).unwrap();
        }
        id
    };
    // What the importer does at the end of a file.
    store.backdate_session(&id, stamps[0]).expect("backdated");
    (store, id)
}

#[test]
fn an_imported_sessions_duration_is_its_work_not_the_time_since_it_ran() {
    let dir = tempfile::tempdir().unwrap();
    // Two minutes of work on the 1st of June, read back today.
    let (mut store, session_id) = imported_session(
        dir.path(),
        "june-1",
        &[june(1, 16, 10), june(1, 16, 11), june(1, 16, 12)],
    );

    // Every one of these bumps `updated_at` to now — which is exactly how the
    // old duration became "weeks".
    {
        let mut capture = Capture::new(&mut store, WorkspaceMode::Local);
        capture.record_usage(&session_id, &TokenTotals { input_tokens: 10, ..Default::default() }).unwrap();
    }

    let rows = timeline::sessions(&store, WORKSPACE).expect("read");
    let row = rows.iter().find(|r| r.id == session_id).expect("row");

    assert!(
        row.active_seconds <= 180,
        "two minutes of messages, not the weeks since: {}s",
        row.active_seconds
    );
    assert!(
        row.wall_seconds < 3 * 3600,
        "the honest span is the transcript's own, not the time since the import: {}s",
        row.wall_seconds
    );
    assert!(
        row.last_activity_at.starts_with("2026-06-01"),
        "activity is June, whatever day the row was written: {}",
        row.last_activity_at
    );
}

#[test]
fn idle_time_between_messages_is_capped_rather_than_counted() {
    let dir = tempfile::tempdir().unwrap();
    let base = june(2, 9, 0);
    let (store, session_id) = imported_session(
        dir.path(),
        "gappy",
        &[
            base,
            base + Duration::seconds(60),
            // Lunch. Contributes the cap, not four hours.
            base + Duration::hours(4),
            base + Duration::hours(4) + Duration::seconds(60),
        ],
    );

    let rows = timeline::sessions(&store, WORKSPACE).expect("read");
    let row = rows.iter().find(|r| r.id == session_id).expect("row");

    // The prompt shares the first stamp, so the intervals are 0, 60, capped, 60.
    assert_eq!(row.active_seconds, 60 + timeline::IDLE_CAP_SECONDS + 60);
    assert!(row.wall_seconds >= 4 * 3600, "the span still tells the truth");
}

#[test]
fn a_bulk_import_does_not_file_a_years_history_under_today() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());
    {
        let mut capture = Capture::new(&mut store, WorkspaceMode::Local);
        for (i, day) in [1u32, 15, 29].iter().enumerate() {
            let at = june(*day, 11, 0);
            let id = capture
                .ensure_session(&key(&format!("day-{day}")), Some("claude-code"), None, None, None)
                .unwrap();
            capture.record_turn(&id, assistant_at(i as i64 + 1, "Done.", at)).unwrap();
        }
    }

    let rows = timeline::sessions(&store, WORKSPACE).expect("read");
    let days: std::collections::HashSet<&str> =
        rows.iter().map(|r| &r.last_activity_at[..10]).collect();
    assert_eq!(days.len(), 3, "three days of work stay three days: {days:?}");
    // And the rows written moments ago all share one `updated_at` day, which is
    // precisely why grouping on it was wrong.
    assert!(rows.iter().all(|r| r.updated_at != r.last_activity_at));
}

#[test]
fn recording_usage_does_not_count_as_activity() {
    let dir = tempfile::tempdir().unwrap();
    let (mut store, session_id) =
        imported_session(dir.path(), "quiet", &[june(3, 8, 0), june(3, 8, 5)]);

    let before = timeline::sessions(&store, WORKSPACE)
        .unwrap()
        .into_iter()
        .find(|r| r.id == session_id)
        .unwrap()
        .last_activity_at;

    {
        let mut capture = Capture::new(&mut store, WorkspaceMode::Local);
        capture.record_usage(&session_id, &TokenTotals { input_tokens: 42, ..Default::default() }).unwrap();
    }

    let after = timeline::sessions(&store, WORKSPACE)
        .unwrap()
        .into_iter()
        .find(|r| r.id == session_id)
        .unwrap()
        .last_activity_at;
    assert_eq!(before, after, "bookkeeping is not work");
}

#[test]
fn cache_tokens_reach_the_row_without_inflating_the_split() {
    let dir = tempfile::tempdir().unwrap();
    let (mut store, session_id) = seeded(dir.path());

    {
        let mut capture = Capture::new(&mut store, WorkspaceMode::Local);
        capture
            .record_usage(
                &session_id,
                &TokenTotals {
                    input_tokens: 1_000,
                    output_tokens: 500,
                    cache_creation_tokens: 29_002,
                    cache_read_tokens: 15_565,
                    ..Default::default()
                },
            )
            .unwrap();
    }

    let rows = timeline::sessions(&store, WORKSPACE).expect("read");
    let row = rows.iter().find(|r| r.id == session_id).expect("row");
    assert_eq!(row.total_tokens, 1_500, "\"in + out\" means in + out");
    assert_eq!(row.cache_creation_tokens, 29_002);
    assert_eq!(row.cache_read_tokens, 15_565);
}

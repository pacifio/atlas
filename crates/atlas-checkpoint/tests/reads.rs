//! Reads other features build on: what memory needs to place a write inside
//! a turn (memory plan M3).

use atlas_checkpoint::model::ProjectMode;
use atlas_checkpoint::{Capture, SessionKey, Source, Store, TurnState};

#[test]
fn turn_spans_report_every_turn_with_its_state_and_times() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join(".atlas")).expect("store opens");
    let key = SessionKey {
        workspace_id: "ws-atlas".to_string(),
        source: Source::Acp,
        native_session_id: "sess-1".to_string(),
    };
    let id = {
        let mut capture = Capture::new(&mut store, ProjectMode::Local);
        let id = capture
            .record_prompt(&key, "First", 1, Some("claude-code"), None, None)
            .unwrap();
        capture
            .record_prompt(&key, "Second", 2, Some("claude-code"), None, None)
            .unwrap();
        capture
            .record_prompt(&key, "Third", 3, Some("claude-code"), None, None)
            .unwrap();
        id
    };
    store.complete_turn(&id, 1).unwrap();
    store.mark_turns_rewound(&id, 1).unwrap();

    let spans = store.turn_spans(&id).unwrap();
    let states: Vec<(i64, TurnState, bool)> = spans
        .iter()
        .map(|s| (s.turn_seq, s.state, s.ended_at.is_some()))
        .collect();
    assert_eq!(
        states,
        vec![
            (1, TurnState::Completed, true),
            (2, TurnState::Open, false),
            (3, TurnState::Rewound, true),
        ]
    );
    assert!(spans
        .iter()
        .all(|s| s.ended_at.is_none_or(|e| e >= s.started_at)));
    assert!(store.turn_spans("no-such-session").unwrap().is_empty());
}

#[test]
fn failed_calls_and_written_paths_read_newest_first_and_bounded() {
    use atlas_checkpoint::tools::{resolve_path, ToolName};
    use atlas_checkpoint::{FileWrite, ToolCallContent, ToolStatus};
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join(".atlas")).expect("store opens");
    let key = SessionKey {
        workspace_id: "ws-atlas".to_string(),
        source: Source::Acp,
        native_session_id: "sess-1".to_string(),
    };
    let mut capture = Capture::new(&mut store, ProjectMode::Local);
    let row = capture
        .record_prompt(&key, "First", 1, Some("claude-code"), None, None)
        .unwrap();
    let none = serde_json::json!([]);
    for (i, status) in [
        ToolStatus::Failed,
        ToolStatus::Completed,
        ToolStatus::Failed,
    ]
    .into_iter()
    .enumerate()
    {
        capture
            .record_tool_call(
                &row,
                ToolCallContent {
                    turn_seq: 1,
                    native_call_id: Some(&format!("c{i}")),
                    tool_name: ToolName::Bash,
                    title: Some("Bash(cargo test)"),
                    kind: Some("execute"),
                    status,
                    locations: &none,
                    arguments: Some(r#"{"command":"cargo test -p auth"}"#),
                    result: Some(b"error: test failed\nmore"),
                },
            )
            .unwrap();
    }
    for (path, deleted) in [("src/a.rs", false), ("src/b.rs", false), ("src/a.rs", true)] {
        let call = capture
            .record_tool_call(
                &row,
                ToolCallContent {
                    turn_seq: 1,
                    native_call_id: Some(&format!("w-{path}-{deleted}")),
                    tool_name: ToolName::Edit,
                    title: None,
                    kind: Some("edit"),
                    status: ToolStatus::Completed,
                    locations: &none,
                    arguments: None,
                    result: None,
                },
            )
            .unwrap();
        let resolved = resolve_path(path, dir.path());
        capture
            .record_file_write(
                &row,
                &call,
                1,
                FileWrite {
                    path: &resolved,
                    sha256_after: None,
                    sketch_after: None,
                    existed_before: true,
                    deleted,
                },
            )
            .unwrap();
    }
    let failed = store.failed_tool_calls(&row, 10).unwrap();
    assert_eq!(failed.len(), 2);
    assert_eq!(failed[0].tool_name, ToolName::Bash);
    assert!(failed[0]
        .result
        .as_deref()
        .is_some_and(|r| r.starts_with("error: test failed")));
    assert_eq!(
        store.written_paths(&row, 10).unwrap(),
        [
            ("src/a.rs".to_string(), true),
            ("src/b.rs".to_string(), false)
        ]
    );
    assert_eq!(store.written_paths(&row, 1).unwrap().len(), 1, "bounded");
}

/// A recorded session in `store` with one completed write of `path`.
fn session_writing(store: &mut Store, root: &std::path::Path, native: &str, path: &str) -> String {
    use atlas_checkpoint::tools::{resolve_path, ToolName};
    use atlas_checkpoint::{FileWrite, ToolCallContent, ToolStatus};
    let key = SessionKey {
        workspace_id: "ws-atlas".to_string(),
        source: Source::Acp,
        native_session_id: native.to_string(),
    };
    let mut capture = Capture::new(store, ProjectMode::Local);
    let row = capture
        .record_prompt(&key, "Edit", 1, Some("claude-code"), None, None)
        .unwrap();
    let call = capture
        .record_tool_call(
            &row,
            ToolCallContent {
                turn_seq: 1,
                native_call_id: Some("w"),
                tool_name: ToolName::Edit,
                title: None,
                kind: Some("edit"),
                status: ToolStatus::Completed,
                locations: &serde_json::json!([]),
                arguments: None,
                result: None,
            },
        )
        .unwrap();
    capture
        .record_file_write(
            &row,
            &call,
            1,
            FileWrite {
                path: &resolve_path(path, root),
                sha256_after: None,
                sketch_after: None,
                existed_before: true,
                deleted: false,
            },
        )
        .unwrap();
    row
}

fn checkpoint(store: &Store, row: &str, sha: &str, files: &[&str]) {
    let files: Vec<String> = files.iter().map(|f| (*f).to_string()).collect();
    store
        .upsert_checkpoint(atlas_checkpoint::CheckpointInput {
            session_id: row,
            commit_sha: sha,
            patch_id: Some("patch"),
            branch: Some("main"),
            git_author_name: None,
            git_author_email: None,
            files_touched: &files,
            insertions: 1,
            deletions: 0,
            sync_state: ProjectMode::Local.initial_sync_state(),
        })
        .unwrap();
}

#[test]
fn sessions_touching_a_path_are_newest_first_and_a_renamed_file_is_found_through_its_checkpoint() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join(".atlas")).expect("store opens");
    let first = session_writing(&mut store, dir.path(), "s-1", "src/a.rs");
    std::thread::sleep(std::time::Duration::from_millis(5));
    let second = session_writing(&mut store, dir.path(), "s-2", "src/a.rs");
    let touching: Vec<String> = store
        .sessions_touching_path("src/a.rs", 5)
        .unwrap()
        .into_iter()
        .map(|(s, _)| s)
        .collect();
    assert_eq!(touching, [second.clone(), first]);
    checkpoint(
        &store,
        &second,
        "3f9c2ab1d4e0aa11bb22cc33dd44ee55ff660011",
        &["src/b.rs"],
    );
    let carried = store.checkpoints_touching_path("src/b.rs", 5).unwrap();
    assert_eq!(carried.len(), 1);
    assert_eq!(carried[0].session_id, second);
    assert!(store
        .checkpoints_touching_path("src/c.rs", 5)
        .unwrap()
        .is_empty());
}

#[test]
fn a_commit_prefix_finds_its_checkpoints_and_a_short_or_non_hex_prefix_finds_none() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join(".atlas")).expect("store opens");
    let row = session_writing(&mut store, dir.path(), "s-1", "src/a.rs");
    checkpoint(
        &store,
        &row,
        "3f9c2ab1d4e0aa11bb22cc33dd44ee55ff660011",
        &["src/a.rs"],
    );
    assert_eq!(
        store
            .checkpoints_for_commit_prefix("3F9C2AB")
            .unwrap()
            .len(),
        1
    );
    assert!(store
        .checkpoints_for_commit_prefix("3f9c2a")
        .unwrap()
        .is_empty());
    assert!(store
        .checkpoints_for_commit_prefix("zzzzzzz")
        .unwrap()
        .is_empty());
    assert!(store
        .checkpoints_for_commit_prefix("3f9c2ac")
        .unwrap()
        .is_empty());
}

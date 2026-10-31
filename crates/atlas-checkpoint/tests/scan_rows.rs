//! Security-scan rows beside the Checkpoint they describe (ATL-985).
//!
//! The scanner's queue is "checkpoints with no finished row for this scanner
//! version", so these tests pin exactly what enters and leaves that backlog.

use atlas_checkpoint::model::{ProjectMode, ScanRow};
use atlas_checkpoint::{CheckpointInput, Source, Store};
use chrono::{DateTime, Utc};

fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join(".atlas")).expect("store opens");
    (dir, store)
}

fn session(store: &Store) -> String {
    store
        .upsert_session(
            "ws-atlas",
            Source::Native,
            "native-1",
            None,
            None,
            Some("main"),
            None,
            ProjectMode::Local,
        )
        .unwrap()
}

fn checkpoint(store: &Store, session_id: &str, sha: &str) -> String {
    let id = store
        .upsert_checkpoint(CheckpointInput {
            session_id,
            commit_sha: sha,
            patch_id: Some(sha),
            branch: Some("main"),
            git_author_name: None,
            git_author_email: None,
            files_touched: &["src/a.rs".to_string()],
            insertions: 1,
            deletions: 0,
            sync_state: ProjectMode::Local.initial_sync_state(),
        })
        .unwrap();
    // created_at is the wall clock; keep consecutive checkpoints distinct.
    std::thread::sleep(std::time::Duration::from_millis(5));
    id
}

fn row(checkpoint_id: &str, version: &str, status: &str) -> ScanRow {
    ScanRow {
        checkpoint_id: checkpoint_id.to_string(),
        scanner_version: version.to_string(),
        status: status.to_string(),
        level: "none".to_string(),
        blocking: false,
        result_json: "{}".to_string(),
        attempts: 1,
        created_at: Utc::now(),
    }
}

fn created_at(store: &Store, id: &str) -> DateTime<Utc> {
    store
        .checkpoint(id)
        .unwrap()
        .expect("checkpoint exists")
        .created_at
}

fn ids(list: Vec<atlas_checkpoint::model::Checkpoint>) -> Vec<String> {
    list.into_iter().map(|c| c.id).collect()
}

#[test]
fn migrates_and_creates_scan_tables() {
    let (dir, store) = store();
    drop(store);
    let conn = rusqlite::Connection::open(dir.path().join(".atlas/sessions.db")).unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert!(version >= 12);
    for table in ["checkpoint_scan", "security_scan_state"] {
        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "{table} exists");
    }
}

#[test]
fn backlog_lists_unscanned_checkpoints_since_oldest_first() {
    let (_dir, store) = store();
    let s = session(&store);
    let _t0 = checkpoint(&store, &s, "aaa0");
    let t1 = checkpoint(&store, &s, "aaa1");
    let t2 = checkpoint(&store, &s, "aaa2");
    let since = created_at(&store, &t1);
    let backlog = store.scan_backlog("local-1", since, 20).unwrap();
    assert_eq!(ids(backlog), vec![t1, t2]);
}

#[test]
fn done_row_removes_checkpoint_from_backlog() {
    let (_dir, store) = store();
    let s = session(&store);
    let c = checkpoint(&store, &s, "bbb0");
    let since = created_at(&store, &c);
    store.put_scan(&row(&c, "local-1", "done")).unwrap();
    assert!(store.scan_backlog("local-1", since, 20).unwrap().is_empty());
    assert_eq!(
        ids(store.scan_backlog("local-2", since, 20).unwrap()),
        vec![c]
    );
}

#[test]
fn failed_row_retries_until_three_attempts() {
    let (_dir, store) = store();
    let s = session(&store);
    let c = checkpoint(&store, &s, "ccc0");
    let since = created_at(&store, &c);
    for expected_attempts in 1..=3 {
        store.put_scan(&row(&c, "local-1", "failed")).unwrap();
        let saved = store.scan_for(&c, "local-1").unwrap().expect("row saved");
        assert_eq!(saved.attempts, expected_attempts);
        let in_backlog = !store.scan_backlog("local-1", since, 20).unwrap().is_empty();
        assert_eq!(
            in_backlog,
            expected_attempts < 3,
            "attempt {expected_attempts}"
        );
    }
}

#[test]
fn orphaned_checkpoint_is_not_in_backlog() {
    let (_dir, store) = store();
    let s = session(&store);
    let c = checkpoint(&store, &s, "ddd0");
    let since = created_at(&store, &c);
    store.orphan_checkpoint(&c).unwrap();
    assert!(store.scan_backlog("local-1", since, 20).unwrap().is_empty());
}

#[test]
fn scans_for_project_pairs_checkpoint_and_row() {
    let (_dir, store) = store();
    let s = session(&store);
    let c = checkpoint(&store, &s, "eee0");
    store.put_scan(&row(&c, "local-1", "done")).unwrap();
    let all = store.scans_for_project("ws-atlas").unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].0.id, c);
    assert_eq!(all[0].1.status, "done");
    assert!(store.scans_for_project("ws-other").unwrap().is_empty());
}

#[test]
fn scan_state_round_trips() {
    let (_dir, store) = store();
    assert_eq!(store.scan_state("since").unwrap(), None);
    store
        .set_scan_state("since", "2026-10-31T00:00:00Z")
        .unwrap();
    assert_eq!(
        store.scan_state("since").unwrap().as_deref(),
        Some("2026-10-31T00:00:00Z")
    );
}

// ── Labels: "Not useful" on a finding ───────────────────────────────────────

#[test]
fn migrates_to_v13_with_the_label_table() {
    let (dir, store) = store();
    drop(store);
    let conn = rusqlite::Connection::open(dir.path().join(".atlas/sessions.db")).unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 13);
    let n: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'security_label'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1);
}

#[test]
fn a_finding_can_be_marked_not_useful_and_restored() {
    let (_dir, store) = store();
    assert!(store.not_useful_fingerprints().unwrap().is_empty());
    store
        .set_not_useful("fp-1", "pkg.install_script", "local-1", true)
        .unwrap();
    store
        .set_not_useful("fp-2", "secret.entropy", "local-1", true)
        .unwrap();
    let got = store.not_useful_fingerprints().unwrap();
    assert!(got.contains("fp-1") && got.contains("fp-2"));
    // Marking again is idempotent; restoring removes it.
    store
        .set_not_useful("fp-1", "pkg.install_script", "local-1", true)
        .unwrap();
    store
        .set_not_useful("fp-1", "pkg.install_script", "local-1", false)
        .unwrap();
    let got = store.not_useful_fingerprints().unwrap();
    assert!(!got.contains("fp-1") && got.contains("fp-2"));
}

//! `touch_sessions`: activity seen outside Atlas (a terminal session writing
//! its transcript) bumps a known row's `updated_at`, only ever forward, and the
//! sidebar hears about it once per batch (ADR-0001 amendment, ATL-423). New
//! activity on an archived row inside the recency window brings it back to the
//! sidebar; anything less leaves the user's archive alone.

use std::path::PathBuf;

use agent_client_protocol::schema::v1 as acp;
use atlas_thread_metadata::{
    PathList, ThreadId, ThreadMetadata, ThreadMetadataStore, ThreadStoreEvent,
};
use chrono::{TimeZone, Utc};

fn open(dir: &tempfile::TempDir) -> ThreadMetadataStore {
    ThreadMetadataStore::open(dir.path().join("threads.db")).expect("store opens")
}

fn thread() -> ThreadMetadata {
    let mut thread = ThreadMetadata::new(
        ThreadId::new(),
        "some-agent".into(),
        PathList::new(&[PathBuf::from("/tmp/atlas")]),
    );
    thread.session_id = Some(acp::SessionId::new(thread.thread_id.to_key_string()));
    thread
}

#[test]
fn touching_a_session_moves_it_forward_but_never_back() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let mut row = thread();
    row.updated_at = Utc.with_ymd_and_hms(2026, 10, 1, 12, 0, 0).unwrap();
    let session = row.session_id.clone().unwrap();
    let thread_id = row.thread_id;
    store.save_all(vec![row]);

    let later = Utc.with_ymd_and_hms(2026, 10, 2, 12, 0, 0).unwrap();
    assert_eq!(store.touch_sessions(&[(session.clone(), later)], None), 1);
    assert_eq!(store.thread(thread_id).unwrap().updated_at, later);

    let earlier = Utc.with_ymd_and_hms(2026, 9, 1, 12, 0, 0).unwrap();
    assert_eq!(store.touch_sessions(&[(session.clone(), earlier)], None), 0);
    assert_eq!(store.touch_sessions(&[(session, later)], None), 0);
    assert_eq!(store.thread(thread_id).unwrap().updated_at, later);
}

#[test]
fn touching_an_unknown_session_does_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let mut changes = store.subscribe();

    let moved = store.touch_sessions(&[(acp::SessionId::new("nope"), Utc::now())], None);

    assert_eq!(moved, 0);
    assert!(
        changes.try_recv().is_err(),
        "nothing moved, nothing announced"
    );
}

#[test]
fn touching_a_batch_announces_once() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let (a, b) = (thread(), thread());
    let ids = [a.session_id.clone().unwrap(), b.session_id.clone().unwrap()];
    store.save_all(vec![a, b]);
    let mut changes = store.subscribe();
    // Drain whatever the seeding announced.
    while changes.try_recv().is_ok() {}

    let future = Utc::now() + chrono::Duration::hours(1);
    let updates: Vec<_> = ids.into_iter().map(|id| (id, future)).collect();
    assert_eq!(store.touch_sessions(&updates, None), 2);

    assert_eq!(changes.try_recv().unwrap(), ThreadStoreEvent::Changed);
    assert!(changes.try_recv().is_err(), "one event for the whole batch");
}

/// An archived row with the given `updated_at`; answers it and its session.
fn archived_row(
    store: &ThreadMetadataStore,
    updated_at: chrono::DateTime<Utc>,
) -> (ThreadId, acp::SessionId) {
    let mut row = thread();
    row.updated_at = updated_at;
    row.archived = true;
    let ids = (row.thread_id, row.session_id.clone().unwrap());
    store.save_all(vec![row]);
    ids
}

#[test]
fn new_activity_inside_the_window_unarchives_a_row() {
    // The first-run backfill lands everything archived; a session the user
    // then picks up in a terminal must reach the sidebar.
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let now = Utc::now();
    let (thread_id, session) = archived_row(&store, now - chrono::Duration::hours(2));
    let cutoff = now - chrono::Duration::days(7);

    assert_eq!(store.touch_sessions(&[(session, now)], Some(cutoff)), 1);

    let row = store.thread(thread_id).unwrap();
    assert!(!row.archived, "new activity brings it back");
    assert_eq!(row.updated_at, now);
}

#[test]
fn an_archived_row_stays_archived_without_a_recency_window() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let now = Utc::now();
    let before = now - chrono::Duration::hours(2);
    let (thread_id, session) = archived_row(&store, before);
    let mut changes = store.subscribe();
    while changes.try_recv().is_ok() {}

    assert_eq!(store.touch_sessions(&[(session, now)], None), 0);

    let row = store.thread(thread_id).unwrap();
    assert!(row.archived);
    assert_eq!(
        row.updated_at, before,
        "an archived row's time is left alone"
    );
    assert!(
        changes.try_recv().is_err(),
        "nothing moved, nothing announced"
    );
}

#[test]
fn activity_older_than_the_window_does_not_unarchive() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let now = Utc::now();
    let (thread_id, session) = archived_row(&store, now - chrono::Duration::days(30));
    let cutoff = now - chrono::Duration::days(7);

    let observed = now - chrono::Duration::days(10);
    assert_eq!(
        store.touch_sessions(&[(session, observed)], Some(cutoff)),
        0
    );
    assert!(store.thread(thread_id).unwrap().archived);
}

#[test]
fn a_trailing_write_just_after_the_archived_time_does_not_unarchive() {
    // Atlas stamps `updated_at` when its turn stops; the agent flushes its
    // transcript a moment later. The user archived that thread, and nothing
    // new has happened since.
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let now = Utc::now();
    let ended = now - chrono::Duration::minutes(5);
    let (thread_id, session) = archived_row(&store, ended);
    let cutoff = now - chrono::Duration::days(7);

    let trailing = ended + chrono::Duration::seconds(2);
    assert_eq!(
        store.touch_sessions(&[(session.clone(), trailing)], Some(cutoff)),
        0
    );
    assert!(store.thread(thread_id).unwrap().archived);

    // Activity at or before the archived time is not new either.
    assert_eq!(
        store.touch_sessions(&[(session.clone(), ended)], Some(cutoff)),
        0
    );

    // Well past it is.
    let later = ended + atlas_thread_metadata::NEW_ACTIVITY_SLACK + chrono::Duration::seconds(1);
    assert_eq!(store.touch_sessions(&[(session, later)], Some(cutoff)), 1);
    assert!(!store.thread(thread_id).unwrap().archived);
}

#[test]
fn unarchiving_survives_a_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let now = Utc::now();
    let thread_id = {
        let store = open(&dir);
        let (thread_id, session) = archived_row(&store, now - chrono::Duration::hours(1));
        store.touch_sessions(&[(session, now)], Some(now - chrono::Duration::days(7)));
        store.flush().unwrap();
        thread_id
    };
    assert!(!open(&dir).thread(thread_id).unwrap().archived);
}

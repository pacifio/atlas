//! `touch_sessions`: activity seen outside Atlas (a terminal session writing
//! its transcript) bumps a known row's `updated_at`, only ever forward, and the
//! sidebar hears about it once per batch (ADR-0001 amendment, ATL-423).

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
    assert_eq!(store.touch_sessions(&[(session.clone(), later)]), 1);
    assert_eq!(store.thread(thread_id).unwrap().updated_at, later);

    let earlier = Utc.with_ymd_and_hms(2026, 9, 1, 12, 0, 0).unwrap();
    assert_eq!(store.touch_sessions(&[(session.clone(), earlier)]), 0);
    assert_eq!(store.touch_sessions(&[(session, later)]), 0);
    assert_eq!(store.thread(thread_id).unwrap().updated_at, later);
}

#[test]
fn touching_an_unknown_session_does_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let mut changes = store.subscribe();

    let moved = store.touch_sessions(&[(acp::SessionId::new("nope"), Utc::now())]);

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
    assert_eq!(store.touch_sessions(&updates), 2);

    assert_eq!(changes.try_recv().unwrap(), ThreadStoreEvent::Changed);
    assert!(changes.try_recv().is_err(), "one event for the whole batch");
}

//! Session lineage: "Branch from here" records which session a fork came
//! from, so the session context overlay can show the parent and the forks.
//! The record is keyed by agent session ids and outlives a reopen; it may be
//! written before the child has a row of its own.

use agent_client_protocol::schema::v1 as acp;
use atlas_thread_metadata::ThreadMetadataStore;

#[test]
fn a_fork_survives_a_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("threads.db");
    let parent = acp::SessionId::new("parent-session");
    let child = acp::SessionId::new("child-session");
    {
        let store = ThreadMetadataStore::open(&path).unwrap();
        assert!(store.record_session_fork(&child, &parent));
        store.flush().unwrap();
    }
    let store = ThreadMetadataStore::open(&path).unwrap();
    assert_eq!(store.session_fork_parent(&child), Some(parent.clone()));
    assert_eq!(store.session_forks().len(), 1);
    assert_eq!(store.session_fork_parent(&parent), None);
}

#[test]
fn a_session_is_never_its_own_parent_and_a_repeat_is_a_no_op() {
    let dir = tempfile::tempdir().unwrap();
    let store = ThreadMetadataStore::open(dir.path().join("threads.db")).unwrap();
    let a = acp::SessionId::new("a");
    let b = acp::SessionId::new("b");
    assert!(!store.record_session_fork(&a, &a));
    assert!(store.record_session_fork(&b, &a));
    assert!(!store.record_session_fork(&b, &a));
    assert_eq!(store.session_forks().len(), 1);
}

#[test]
fn recording_a_fork_announces_a_change() {
    let dir = tempfile::tempdir().unwrap();
    let store = ThreadMetadataStore::open(dir.path().join("threads.db")).unwrap();
    let mut events = store.subscribe();
    store.record_session_fork(
        &acp::SessionId::new("child"),
        &acp::SessionId::new("parent"),
    );
    assert!(events.try_recv().is_ok());
}

//! Confirmed transcript aliases: another on-disk id of a session Atlas ran (an
//! adapter writing a conversation's continuation under a fresh id). Once
//! confirmed they are durable, they keep the continuation out of every import,
//! and they go — without resurrecting anything — when their owner is deleted
//! (ADR-0001, "Attribution when an agent switches transcript files").

use std::path::PathBuf;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::AgentSessionInfo;
use atlas_thread_metadata::{
    importable_threads, PathList, ThreadId, ThreadMetadata, ThreadMetadataStore,
};
use chrono::Utc;

fn owner_row(session: &str) -> ThreadMetadata {
    let mut row = ThreadMetadata::new(
        ThreadId::new(),
        "some-agent".into(),
        PathList::new(&[PathBuf::from("/tmp/atlas")]),
    );
    row.session_id = Some(acp::SessionId::new(session));
    row
}

fn listed(id: &str) -> AgentSessionInfo {
    AgentSessionInfo {
        session_id: acp::SessionId::new(id),
        work_dirs: Some(vec![PathBuf::from("/tmp/atlas")]),
        title: None,
        updated_at: Some(Utc::now()),
        created_at: None,
        meta: None,
    }
}

#[test]
fn a_confirmed_alias_survives_a_reopen_and_is_never_imported() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("threads.db");
    let (owner, alias) = (acp::SessionId::new("owner"), acp::SessionId::new("fresh"));
    {
        let store = ThreadMetadataStore::open(&path).unwrap();
        store.save_all(vec![owner_row("owner")]);
        assert!(store.record_session_alias(&alias, &owner));
        store.flush().unwrap();
    }

    let store = ThreadMetadataStore::open(&path).unwrap();
    assert_eq!(store.session_aliases().get(&alias), Some(&owner));
    let rows = importable_threads(
        vec![listed("fresh"), listed("other")],
        &"some-agent".into(),
        &store.known_session_ids(),
        Some(Utc::now() - chrono::Duration::days(7)),
    );
    let ids: Vec<_> = rows.iter().filter_map(|r| r.session_id.clone()).collect();
    assert_eq!(
        ids,
        [acp::SessionId::new("other")],
        "the alias is not a session of its own"
    );
}

#[test]
fn deleting_the_owner_removes_its_aliases_without_resurrecting_them() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("threads.db");
    let (owner, alias) = (acp::SessionId::new("owner"), acp::SessionId::new("fresh"));
    {
        let store = ThreadMetadataStore::open(&path).unwrap();
        let row = owner_row("owner");
        let thread_id = row.thread_id;
        store.save_all(vec![row]);
        store.record_session_alias(&alias, &owner);
        store.delete(thread_id);
        assert!(store.session_aliases().is_empty());
        store.flush().unwrap();
    }

    let store = ThreadMetadataStore::open(&path).unwrap();
    assert!(store.session_aliases().is_empty(), "gone on disk too");
    assert!(
        store.is_session_deleted(&alias),
        "the continuation is deleted with its owner, not freed for import"
    );
    let rows = store.insert_new_sessions(importable_threads(
        vec![listed("fresh")],
        &"some-agent".into(),
        &Default::default(),
        None,
    ));
    assert_eq!(rows, 0);
}

#[test]
fn an_alias_needs_a_live_owner_row() {
    let dir = tempfile::tempdir().unwrap();
    let store = ThreadMetadataStore::open(dir.path().join("threads.db")).unwrap();
    assert!(
        !store.record_session_alias(&acp::SessionId::new("fresh"), &acp::SessionId::new("ghost")),
        "an owner without a row (never seen, or deleted) cannot own an alias"
    );
    store.save_all(vec![owner_row("owner")]);
    let owner = acp::SessionId::new("owner");
    assert!(
        !store.record_session_alias(&owner, &owner),
        "not its own alias"
    );
}

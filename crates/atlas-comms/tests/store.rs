//! The watermark and the paint-before-connect snapshot.
//!
//! Asserted by **reopening** the database rather than by reading rows back from
//! the same handle: what matters is that the next launch sees it.

use atlas_comms::store::CommsStore;
use atlas_comms::wire::{Conversation, ConversationKind, ReadState, Visibility};

fn conv(id: &str, name: &str) -> Conversation {
    Conversation {
        id: id.into(),
        kind: ConversationKind::Channel,
        name: Some(name.into()),
        visibility: Visibility::PublicOrg,
        workspace_ref_ids: vec![],
        created_by: "u_me".into(),
        created_at: 1,
        archived_at: None,
        seq: 1,
        member_ids: None,
        last_activity_seq: 7,
    }
}

#[test]
fn an_unknown_org_resumes_from_zero() {
    let store = CommsStore::open_in_memory().unwrap();
    assert_eq!(store.watermark("org_new").unwrap(), 0);
    let snap = store.snapshot("org_new").unwrap();
    assert!(snap.conversations.is_empty());
}

#[test]
fn the_watermark_survives_a_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("comms.db");
    {
        let store = CommsStore::open(&path).unwrap();
        store.set_watermark("org_1", 5_120).unwrap();
    }
    let reopened = CommsStore::open(&path).unwrap();
    assert_eq!(reopened.watermark("org_1").unwrap(), 5_120);
}

#[test]
fn the_watermark_never_goes_backwards_on_a_normal_advance() {
    // An out-of-order frame must not rewind history and cause a replay storm.
    let store = CommsStore::open_in_memory().unwrap();
    store.set_watermark("org_1", 500).unwrap();
    store.set_watermark("org_1", 400).unwrap();
    assert_eq!(store.watermark("org_1").unwrap(), 500);
}

#[test]
fn cold_sync_may_rewind_the_watermark() {
    // `too_old` hands back a `snapshot_from` that can be lower than what we
    // hold. Refusing that rewind would leave us asking for a resume point the
    // server has just said it no longer has.
    let store = CommsStore::open_in_memory().unwrap();
    store.set_watermark("org_1", 9_000).unwrap();
    store.reset_watermark("org_1", 5_000).unwrap();
    assert_eq!(store.watermark("org_1").unwrap(), 5_000);
}

#[test]
fn the_sidebar_snapshot_survives_a_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("comms.db");
    let reads = vec![ReadState {
        conv_id: "c1".into(),
        last_read_seq: 90,
        unread: 3,
        mentions: 1,
    }];
    {
        let store = CommsStore::open(&path).unwrap();
        store
            .save_snapshot("org_1", &[conv("c1", "eng")], &[conv("c2", "design")], &reads)
            .unwrap();
    }
    let reopened = CommsStore::open(&path).unwrap();
    let snap = reopened.snapshot("org_1").unwrap();
    assert_eq!(snap.conversations.len(), 1);
    assert_eq!(snap.conversations[0].name.as_deref(), Some("eng"));
    // The two lists stay apart on disk exactly as they do on the wire.
    assert_eq!(snap.discoverable.len(), 1);
    assert_eq!(snap.reads[0].unread, 3);
}

#[test]
fn saving_a_snapshot_does_not_clobber_the_watermark() {
    let store = CommsStore::open_in_memory().unwrap();
    store.set_watermark("org_1", 777).unwrap();
    store.save_snapshot("org_1", &[conv("c1", "eng")], &[], &[]).unwrap();
    assert_eq!(store.watermark("org_1").unwrap(), 777);
}

#[test]
fn watermarks_are_per_organisation() {
    let store = CommsStore::open_in_memory().unwrap();
    store.set_watermark("org_1", 100).unwrap();
    store.set_watermark("org_2", 200).unwrap();
    assert_eq!(store.watermark("org_1").unwrap(), 100);
    assert_eq!(store.watermark("org_2").unwrap(), 200);
}

#[test]
fn forgetting_an_org_removes_everything_for_it() {
    let store = CommsStore::open_in_memory().unwrap();
    store.set_watermark("org_1", 100).unwrap();
    store.save_snapshot("org_1", &[conv("c1", "eng")], &[], &[]).unwrap();
    store.forget("org_1").unwrap();
    assert_eq!(store.watermark("org_1").unwrap(), 0);
    assert!(store.snapshot("org_1").unwrap().conversations.is_empty());
}

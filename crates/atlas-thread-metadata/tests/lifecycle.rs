//! A session's lifecycle beyond settling: pinning, snoozing and waking,
//! unread tracking. Every rule is the store's, so these drive the store's
//! public API, and the live feed's events where a rule hangs off one (a raised
//! hand wakes a snooze, a completed turn does not).

use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::thread::{AcpThreadEvent, TurnRecord};
use atlas_acp_thread::ElicitationEntryId;
use atlas_thread_metadata::{
    lifecycle_signal, LifecycleSignal, MarkUnread, PathList, ThreadId, ThreadMetadata,
    ThreadMetadataStore, ThreadRecorder, ThreadSnapshot, ThreadStoreEvent,
};
use chrono::{DateTime, Duration, Utc};

fn open(dir: &tempfile::TempDir) -> ThreadMetadataStore {
    ThreadMetadataStore::open(dir.path().join("threads.db")).expect("store opens")
}

/// A sent session, last active an hour ago, saved into `store`.
fn saved(store: &ThreadMetadataStore) -> ThreadId {
    let mut thread = ThreadMetadata::new(
        ThreadId::new(),
        "some-agent".into(),
        PathList::new(&[PathBuf::from("/tmp/atlas")]),
    );
    thread.session_id = Some(acp::SessionId::new(thread.thread_id.to_key_string()));
    let at = Utc::now() - Duration::hours(1);
    thread.updated_at = at;
    thread.interacted_at = Some(at);
    let id = thread.thread_id;
    store.save_all(vec![thread]);
    id
}

fn row(store: &ThreadMetadataStore, id: ThreadId) -> ThreadMetadata {
    store.thread(id).expect("the row exists")
}

fn soon() -> DateTime<Utc> {
    Utc::now() + Duration::hours(1)
}

// ------------------------------------------------------------------ pinning

#[test]
fn pinning_records_the_order_key_and_survives_a_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let id = {
        let store = open(&dir);
        let id = saved(&store);
        assert!(store.pin(id, Some("m".into())));
        assert!(
            !store.pin(id, Some("z".into())),
            "pinning a pinned session is a no-op, and keeps its key"
        );
        store.flush().unwrap();
        id
    };
    let row = row(&open(&dir), id);
    assert!(row.is_pinned());
    assert_eq!(row.pin_order.as_deref(), Some("m"));
}

#[test]
fn a_pin_brings_a_settled_or_snoozed_session_back() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);

    let settled = saved(&store);
    store.settle(settled);
    assert!(store.pin(settled, None));
    let after = row(&store, settled);
    assert!(after.is_pinned() && !after.is_settled());
    assert!(
        after.unsettled_at.is_some(),
        "an un-settle the sweep must respect, like any other"
    );

    let snoozed = saved(&store);
    store.snooze(snoozed, soon());
    assert!(store.pin(snoozed, None));
    let after = row(&store, snoozed);
    assert!(after.is_pinned() && !after.is_snoozed());
    assert!(after.is_woke(), "it counts as woken until viewed");
}

#[test]
fn unpinning_clears_the_key_and_a_reorder_needs_a_pin() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let id = saved(&store);

    assert!(
        !store.reorder_pin(id, "c".into()),
        "an unpinned session has no slot to move"
    );
    store.pin(id, Some("m".into()));
    assert!(store.reorder_pin(id, "c".into()));
    assert!(!store.reorder_pin(id, "c".into()), "same key, no write");
    assert_eq!(row(&store, id).pin_order.as_deref(), Some("c"));

    assert!(store.unpin(id));
    let after = row(&store, id);
    assert!(!after.is_pinned() && after.pin_order.is_none());
    assert!(
        !store.reorder_pin(id, "d".into()),
        "a reorder racing the unpin does not resurrect it"
    );
    assert!(!row(&store, id).is_pinned());
}

#[test]
fn pin_order_keys_sort_as_plain_strings_across_a_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let ids = {
        let store = open(&dir);
        let ids: Vec<ThreadId> = (0..3).map(|_| saved(&store)).collect();
        // Midpoint keys, as the frontend mints them: one between each pair.
        store.pin(ids[0], Some("n".into()));
        store.pin(ids[1], Some("g".into()));
        store.pin(ids[2], Some("gn".into()));
        store.flush().unwrap();
        ids
    };
    let store = open(&dir);
    let mut pinned: Vec<ThreadMetadata> = store
        .threads()
        .into_iter()
        .filter(atlas_thread_metadata::ThreadMetadata::is_pinned)
        .collect();
    pinned.sort_by(|a, b| a.pin_order.cmp(&b.pin_order));
    let order: Vec<ThreadId> = pinned.iter().map(|t| t.thread_id).collect();
    assert_eq!(order, [ids[1], ids[2], ids[0]]);
}

// ---------------------------------------------------------------- snoozing

#[test]
fn a_snooze_needs_a_time_in_the_future_and_restamps_when_repeated() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let id = saved(&store);

    assert!(!store.snooze(id, Utc::now() - Duration::minutes(1)));
    assert!(!row(&store, id).is_snoozed());

    let until = soon();
    assert!(store.snooze(id, until));
    let first = row(&store, id);
    assert_eq!(first.snoozed_until, Some(until));
    std::thread::sleep(std::time::Duration::from_millis(5));
    assert!(
        store.snooze(id, until),
        "the same time again still restamps"
    );
    assert!(row(&store, id).snoozed_at > first.snoozed_at);
}

#[test]
fn a_send_unsnoozes_and_unsettles_without_a_woke_mark() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let snoozed = saved(&store);
    store.snooze(snoozed, soon());
    let settled = saved(&store);
    store.settle(settled);

    store.update_interacted_at(snoozed, Utc::now());
    store.update_interacted_at(settled, Utc::now());

    let after = row(&store, snoozed);
    assert!(!after.is_snoozed() && after.snoozed_at.is_none());
    assert!(
        after.last_snooze_wake_at.is_none() && !after.is_woke(),
        "the user is looking at it; there is nothing to announce"
    );
    assert!(!row(&store, settled).is_settled());
}

/// The Undo on "Session snoozed": the snooze is gone and nothing marks the
/// session as having woken — it never slept.
#[test]
fn undoing_a_snooze_leaves_no_woke_mark() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let id = saved(&store);
    assert!(store.snooze(id, soon()));

    assert!(store.unsnooze(id));
    let after = row(&store, id);
    assert!(!after.is_snoozed() && after.snoozed_at.is_none());
    assert!(after.last_snooze_wake_at.is_none() && !after.is_woke());
    assert!(!store.unsnooze(id), "nothing left to undo");
}

#[test]
fn a_hand_wake_ends_the_snooze_and_reads_as_woke_until_viewed() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let id = saved(&store);
    assert!(!store.wake(id), "nothing to wake");

    store.snooze(id, soon());
    assert!(store.wake(id));
    let after = row(&store, id);
    assert!(!after.is_snoozed() && after.is_woke());

    store.mark_viewed(id, Utc::now() + Duration::seconds(1));
    assert!(!row(&store, id).is_woke(), "viewing clears it");
}

// ----------------------------------------------------------- wake scheduler

#[test]
fn the_next_wake_is_the_soonest_snooze() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    assert_eq!(store.next_snooze_wake(), None);

    let (a, b) = (saved(&store), saved(&store));
    let later = Utc::now() + Duration::hours(3);
    let sooner = Utc::now() + Duration::hours(1);
    store.snooze(a, later);
    store.snooze(b, sooner);
    assert_eq!(store.next_snooze_wake(), Some(sooner));

    store.wake(b);
    assert_eq!(
        store.next_snooze_wake(),
        Some(later),
        "re-read after a change"
    );
}

#[test]
fn due_snoozes_wake_at_their_own_time_with_one_event() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let (first, second, later) = (saved(&store), saved(&store), saved(&store));
    let now = Utc::now();
    let (t1, t2) = (now + Duration::minutes(1), now + Duration::minutes(2));
    store.snooze(first, t1);
    store.snooze(second, t2);
    store.snooze(later, now + Duration::hours(5));
    let mut changes = store.subscribe();

    assert_eq!(store.wake_due(now), 0, "nothing is due yet");
    assert!(changes.try_recv().is_err());

    assert_eq!(store.wake_due(now + Duration::minutes(3)), 2);
    assert_eq!(changes.try_recv().unwrap(), ThreadStoreEvent::Changed);
    assert!(changes.try_recv().is_err(), "one event for the batch");

    assert_eq!(row(&store, first).last_snooze_wake_at, Some(t1));
    assert_eq!(row(&store, second).last_snooze_wake_at, Some(t2));
    assert!(row(&store, first).is_woke());
    assert!(row(&store, later).is_snoozed(), "the later one sleeps on");
    assert_eq!(store.next_snooze_wake(), Some(now + Duration::hours(5)));
}

// --------------------------------------------------------- raising a hand

fn live(store: &ThreadMetadataStore) -> (ThreadRecorder, acp::SessionId, ThreadId) {
    let recorder = ThreadRecorder::new(store.clone());
    let session = acp::SessionId::new("ses-live");
    recorder.record(
        &"some-agent".into(),
        &session,
        &AcpThreadEvent::NewEntry,
        snapshot(),
    );
    let id = store.thread_for_session(&session).unwrap().thread_id;
    (recorder, session, id)
}

fn snapshot() -> ThreadSnapshot {
    ThreadSnapshot {
        is_draft: false,
        title: Some(Arc::from("Work")),
        work_dirs: vec![PathBuf::from("/tmp/atlas")],
    }
}

fn stopped(at: DateTime<Utc>) -> AcpThreadEvent {
    AcpThreadEvent::Stopped(
        acp::StopReason::EndTurn,
        TurnRecord {
            started_at: Some(at - Duration::seconds(30)),
            ended_at: at,
            stop_reason: acp::StopReason::EndTurn,
            entries: 0..0,
            worked_ms: Some(30_000),
        },
    )
}

#[test]
fn a_raised_hand_wakes_a_snoozed_session_early() {
    for (name, event) in [
        (
            "a question",
            AcpThreadEvent::ElicitationRequested(ElicitationEntryId(Arc::from("q-1"))),
        ),
        ("a failure", AcpThreadEvent::Error),
        ("a refusal", AcpThreadEvent::Refusal),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        let (recorder, session, id) = live(&store);
        store.snooze(id, Utc::now() + Duration::days(1));

        recorder.record(&"some-agent".into(), &session, &event, snapshot());

        let after = row(&store, id);
        assert!(!after.is_snoozed(), "{name} wakes it");
        assert!(after.is_woke(), "{name}: and it reads as woke");
    }
}

#[test]
fn a_permission_request_is_a_raised_hand() {
    let event = AcpThreadEvent::ToolAuthorizationRequested {
        id: acp::ToolCallId::new("call-1"),
        options: atlas_acp_thread::PermissionOptions::Flat(Vec::new()),
    };
    assert_eq!(lifecycle_signal(&event), Some(LifecycleSignal::RaisedHand));
}

#[test]
fn a_failed_send_is_a_raised_hand() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let (recorder, session, id) = live(&store);
    store.snooze(id, soon());

    recorder.note_failure(&session, Utc::now());

    assert!(!row(&store, id).is_snoozed());
}

#[test]
fn a_completed_turn_does_not_wake_a_snooze_but_is_unread() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let (recorder, session, id) = live(&store);
    store.mark_viewed(id, Utc::now() - Duration::minutes(5));
    store.snooze(id, soon());

    let done = Utc::now();
    recorder.record(&"some-agent".into(), &session, &stopped(done), snapshot());

    let after = row(&store, id);
    assert!(
        after.is_snoozed(),
        "background work finishing is not a hand"
    );
    assert_eq!(after.last_turn_completed_at, Some(done));
    assert!(after.is_unread());
    assert!(!after.is_woke());
}

// ------------------------------------------------------------------ unread

#[test]
fn unread_is_a_completion_after_the_last_view() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let id = saved(&store);
    assert!(
        !row(&store, id).is_unread(),
        "no completed turn, never unread"
    );

    let done = Utc::now() - Duration::minutes(1);
    store.note_turn_completed(id, done);
    assert!(row(&store, id).is_unread(), "never viewed since");

    store.mark_viewed(id, Utc::now());
    assert!(!row(&store, id).is_unread());
    assert!(
        !store.mark_viewed(id, Utc::now() - Duration::hours(1)),
        "a stale view never moves it back"
    );
}

#[test]
fn mark_unread_puts_the_last_view_just_before_the_latest_completion() {
    let dir = tempfile::tempdir().unwrap();
    let id;
    {
        let store = open(&dir);
        id = saved(&store);
        assert_eq!(store.mark_unread(id), MarkUnread::NoCompletedTurn);
        assert_eq!(store.mark_unread(ThreadId::new()), MarkUnread::Missing);

        let done = Utc::now() - Duration::minutes(2);
        store.note_turn_completed(id, done);
        store.mark_viewed(id, Utc::now());
        assert_eq!(store.mark_unread(id), MarkUnread::Marked);
        assert_eq!(
            row(&store, id).last_viewed_at,
            Some(done - Duration::milliseconds(1))
        );
        assert_eq!(store.mark_unread(id), MarkUnread::AlreadyUnread);
        store.flush().unwrap();
    }
    assert!(open(&dir).thread(id).unwrap().is_unread(), "durable");
}

#[test]
fn viewing_through_the_live_feed_marks_the_bound_row() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let (recorder, session, id) = live(&store);
    store.note_turn_completed(id, Utc::now() - Duration::seconds(5));

    assert!(recorder.note_viewed(&session, Utc::now()));
    assert!(!row(&store, id).is_unread());
    assert!(
        !recorder.note_viewed(&acp::SessionId::new("unknown"), Utc::now()),
        "a session with no row has nothing to mark"
    );
}

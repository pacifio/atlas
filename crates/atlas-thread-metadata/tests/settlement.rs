//! Settling: a session the user (or the idle sweep) is done with moves to the
//! sidebar's Settled shelf. It stays listed and resumable; a user send brings
//! it back, and nothing else does — not agent output, not a terminal writing
//! the transcript. An un-settle holds off the sweep until something new
//! happens in the session, and the sweep never touches a pinned or snoozed
//! session.

use std::collections::HashSet;
use std::path::PathBuf;

use agent_client_protocol::schema::v1 as acp;
use atlas_thread_metadata::{
    LiveThreadUpdate, PathList, PullRequestLink, PullRequestLinkSource, ThreadId, ThreadMetadata,
    ThreadMetadataStore, ThreadStoreEvent, WorktreePaths,
};
use chrono::{Duration, Utc};

fn open(dir: &tempfile::TempDir) -> ThreadMetadataStore {
    ThreadMetadataStore::open(dir.path().join("threads.db")).expect("store opens")
}

/// A sent session, last active `idle` ago.
fn thread(idle: Duration) -> ThreadMetadata {
    let mut thread = ThreadMetadata::new(
        ThreadId::new(),
        "some-agent".into(),
        PathList::new(&[PathBuf::from("/tmp/atlas")]),
    );
    thread.session_id = Some(acp::SessionId::new(thread.thread_id.to_key_string()));
    let at = Utc::now() - idle;
    thread.updated_at = at;
    thread.interacted_at = Some(at);
    thread
}

fn drain(changes: &mut tokio::sync::broadcast::Receiver<ThreadStoreEvent>) {
    while changes.try_recv().is_ok() {}
}

#[test]
fn settling_marks_the_row_announces_once_and_survives_a_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let row = thread(Duration::hours(1));
    let id = row.thread_id;
    {
        let store = open(&dir);
        store.save_all(vec![row]);
        let mut changes = store.subscribe();

        assert!(store.settle(id));
        assert_eq!(changes.try_recv().unwrap(), ThreadStoreEvent::Changed);
        assert!(store.thread(id).unwrap().is_settled());

        assert!(!store.settle(id), "settling twice is a no-op");
        assert!(changes.try_recv().is_err(), "and announces nothing");
        store.flush().unwrap();
    }
    let store = open(&dir);
    assert!(store.thread(id).unwrap().is_settled(), "settled is durable");
}

#[test]
fn a_settled_session_is_still_in_the_sidebar_list() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let row = thread(Duration::hours(1));
    let id = row.thread_id;
    store.save_all(vec![row]);
    store.settle(id);

    let listed: Vec<_> = store
        .projects()
        .into_iter()
        .flat_map(|p| p.threads)
        .collect();
    assert_eq!(listed.len(), 1);
    assert!(listed[0].is_settled());
}

#[test]
fn unsettling_clears_it_and_records_when() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let row = thread(Duration::hours(1));
    let id = row.thread_id;
    store.save_all(vec![row]);
    assert!(
        !store.unsettle(id),
        "an active row has nothing to un-settle"
    );

    store.settle(id);
    let mut changes = store.subscribe();
    assert!(store.unsettle(id));
    assert_eq!(changes.try_recv().unwrap(), ThreadStoreEvent::Changed);
    let row = store.thread(id).unwrap();
    assert!(!row.is_settled());
    assert!(row.unsettled_at.is_some());
}

#[test]
fn a_user_send_unsettles_but_agent_and_outside_activity_do_not() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let row = thread(Duration::hours(1));
    let (id, session) = (row.thread_id, row.session_id.clone().unwrap());
    store.save_all(vec![row.clone()]);
    store.settle(id);

    // The agent produces output: the live feed rewrites the row.
    store.record_live_update(LiveThreadUpdate {
        thread_id: id,
        is_draft: false,
        session_id: Some(session.clone()),
        agent_id: row.agent_id.clone(),
        title: Some("A title".into()),
        worktree_paths: WorktreePaths::from_folder_paths(row.folder_paths()),
        remote_connection: None,
    });
    assert!(store.thread(id).unwrap().is_settled(), "agent output");

    // A terminal writes the transcript.
    store.touch_sessions(&[(session, Utc::now() + Duration::minutes(1))]);
    assert!(store.thread(id).unwrap().is_settled(), "outside activity");

    // The user sends.
    store.update_interacted_at(id, Utc::now());
    assert!(!store.thread(id).unwrap().is_settled(), "a send un-settles");
}

#[test]
fn the_idle_sweep_settles_old_sessions_at_their_last_activity() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let old = thread(Duration::days(5));
    let fresh = thread(Duration::hours(2));
    let (old_id, fresh_id) = (old.thread_id, fresh.thread_id);
    let old_activity = old.last_activity();
    store.save_all(vec![old, fresh]);
    let mut changes = store.subscribe();
    drain(&mut changes);

    let cutoff = Utc::now() - Duration::days(3);
    assert_eq!(store.auto_settle_idle(cutoff, &HashSet::new()), 1);
    assert_eq!(changes.try_recv().unwrap(), ThreadStoreEvent::Changed);
    assert!(changes.try_recv().is_err(), "one event for the sweep");

    assert_eq!(store.thread(old_id).unwrap().settled_at, Some(old_activity));
    assert!(!store.thread(fresh_id).unwrap().is_settled());

    assert_eq!(
        store.auto_settle_idle(cutoff, &HashSet::new()),
        0,
        "a second sweep finds nothing"
    );
    assert!(changes.try_recv().is_err());
}

#[test]
fn the_idle_sweep_skips_pinned_snoozed_busy_and_unsettled_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);

    let mut pinned = thread(Duration::days(5));
    pinned.pinned_at = Some(Utc::now() - Duration::days(5));
    let mut snoozed = thread(Duration::days(5));
    snoozed.snoozed_until = Some(Utc::now() + Duration::hours(1));
    snoozed.snoozed_at = Some(Utc::now() - Duration::days(5));
    let busy = thread(Duration::days(5));
    let mut unsettled = thread(Duration::days(5));
    unsettled.unsettled_at = Some(Utc::now() - Duration::days(4));
    // Un-settled, and then something happened: the hold is spent.
    let mut stale_hold = thread(Duration::days(5));
    stale_hold.unsettled_at = Some(Utc::now() - Duration::days(6));
    let mut draft = thread(Duration::days(5));
    draft.session_id = None;

    let busy_ids = HashSet::from([busy.session_id.clone().unwrap()]);
    let ids = [
        pinned.thread_id,
        snoozed.thread_id,
        busy.thread_id,
        unsettled.thread_id,
        stale_hold.thread_id,
    ];
    store.save_all(vec![pinned, snoozed, busy, unsettled, stale_hold, draft]);

    let cutoff = Utc::now() - Duration::days(3);
    assert_eq!(store.auto_settle_idle(cutoff, &busy_ids), 1);
    let settled: Vec<bool> = ids
        .iter()
        .map(|id| store.thread(*id).unwrap().is_settled())
        .collect();
    assert_eq!(settled, [false, false, false, false, true]);
}

#[test]
fn settling_clears_a_pin_and_a_snooze() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let mut row = thread(Duration::hours(1));
    row.pinned_at = Some(Utc::now() - Duration::minutes(30));
    row.pin_order = Some("m".into());
    row.snoozed_until = Some(Utc::now() + Duration::hours(1));
    row.snoozed_at = Some(Utc::now() - Duration::minutes(5));
    let id = row.thread_id;
    store.save_all(vec![row]);

    assert!(store.settle(id));
    let row = store.thread(id).unwrap();
    assert!(row.is_settled());
    assert!(!row.is_pinned() && row.pin_order.is_none(), "the pin goes");
    assert!(
        !row.is_snoozed() && row.snoozed_at.is_none(),
        "so does the snooze"
    );
    assert!(!row.is_woke(), "settling is not a wake");
}

#[test]
fn a_session_sent_to_a_moment_ago_is_not_settled() {
    // The send records the interaction before the host counts the turn in;
    // the store refuses a settle in that gap, under its own lock.
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let row = thread(Duration::hours(1));
    let id = row.thread_id;
    store.save_all(vec![row]);
    store.update_interacted_at(id, Utc::now());

    assert!(store.sent_to_recently(id));
    assert!(!store.settle(id));
    assert!(!store.thread(id).unwrap().is_settled());
}

#[test]
fn idle_sessions_lists_only_what_the_sweep_could_settle() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let old = thread(Duration::days(5));
    let fresh = thread(Duration::hours(2));
    let old_session = old.session_id.clone().unwrap();
    store.save_all(vec![old, fresh]);

    let cutoff = Utc::now() - Duration::days(3);
    let idle = store.idle_sessions(cutoff);
    assert_eq!(idle.len(), 1);
    assert_eq!(idle[0].0, old_session);
    assert_eq!(
        idle[0].1.paths(),
        [PathBuf::from("/tmp/atlas")],
        "with the folders it ran in"
    );
}

/// Snoozed while two days idle, woken a week later: nine days idle by the
/// clock, but the snooze held it out of the sweep. The wake gives it a full
/// window again, and its Woke mark survives the next sweep.
#[test]
fn a_session_woken_from_a_snooze_gets_a_full_idle_window() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let mut snoozed = thread(Duration::days(9));
    let wake_at = Utc::now() - Duration::seconds(5);
    snoozed.snoozed_at = Some(Utc::now() - Duration::days(7));
    snoozed.snoozed_until = Some(wake_at);
    let id = snoozed.thread_id;
    store.save_all(vec![snoozed]);

    assert_eq!(store.wake_due(Utc::now()), 1);
    assert!(store.thread(id).unwrap().is_woke());

    let cutoff = Utc::now() - Duration::days(3);
    assert_eq!(store.auto_settle_idle(cutoff, &HashSet::new()), 0);
    assert!(store.idle_sessions(cutoff).is_empty());
    let row = store.thread(id).unwrap();
    assert!(
        !row.is_settled() && row.is_woke(),
        "still active, still woke"
    );

    // A full window after the wake, it settles like any idle session.
    assert_eq!(
        store.auto_settle_idle(wake_at + Duration::seconds(1), &HashSet::new()),
        1
    );
}

/// Unpinning a session idle for a week does not hand it to the next sweep.
#[test]
fn an_unpinned_session_gets_a_full_idle_window() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let mut pinned = thread(Duration::days(7));
    pinned.pinned_at = Some(Utc::now() - Duration::days(7));
    let id = pinned.thread_id;
    store.save_all(vec![pinned]);

    assert!(store.unpin(id));
    let row = store.thread(id).unwrap();
    assert!(row.unpinned_at.is_some() && !row.is_pinned());

    let cutoff = Utc::now() - Duration::days(3);
    assert_eq!(store.auto_settle_idle(cutoff, &HashSet::new()), 0);
    assert!(!store.thread(id).unwrap().is_settled());

    // The release time is durable: a reopen still holds it off.
    drop(store);
    let store = open(&dir);
    assert_eq!(store.thread(id).unwrap().unpinned_at, row.unpinned_at);
    assert_eq!(store.auto_settle_idle(cutoff, &HashSet::new()), 0);
    assert_eq!(
        store.auto_settle_idle(Utc::now() + Duration::seconds(1), &HashSet::new()),
        1
    );
}

fn with_pull_request(mut thread: ThreadMetadata, number: u32) -> ThreadMetadata {
    thread.pull_requests.push(PullRequestLink::new(
        "acme/shop",
        number,
        format!("https://github.com/acme/shop/pull/{number}"),
        PullRequestLinkSource::Agent,
    ));
    thread
}

/// A session waiting on its pull request is not idle: a watched one never
/// settles for inactivity, and with `autoSettleKeepPullRequests` no session
/// with a pull request does.
#[test]
fn the_idle_sweep_leaves_sessions_with_pull_requests_to_their_pull_request() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let watched = with_pull_request(thread(Duration::days(5)), 1);
    let linked = with_pull_request(thread(Duration::days(5)), 2);
    let plain = thread(Duration::days(5));
    let (watched_id, linked_id, plain_id) = (watched.thread_id, linked.thread_id, plain.thread_id);
    store.save_all(vec![watched, linked, plain]);
    assert!(store.set_pull_request_watch(watched_id, "acme/shop", 1, true));

    let cutoff = Utc::now() - Duration::days(3);
    assert_eq!(
        store.idle_sessions_keeping(cutoff, true).len(),
        1,
        "only the session with no pull request"
    );
    assert_eq!(
        store.auto_settle_idle_keeping(cutoff, &HashSet::new(), true),
        1
    );
    assert!(store.thread(plain_id).unwrap().is_settled());
    assert!(!store.thread(linked_id).unwrap().is_settled());

    // With the setting off, a linked one settles; a watched one still does not.
    assert_eq!(store.auto_settle_idle(cutoff, &HashSet::new()), 1);
    assert!(store.thread(linked_id).unwrap().is_settled());
    assert!(!store.thread(watched_id).unwrap().is_settled());
}

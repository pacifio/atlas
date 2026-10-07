//! Pulling an agent's own sessions into Atlas's history.
//!
//! Driven against fake session lists advertising capability subsets, and a real
//! temporary store. Metadata only: nothing here fetches a transcript, and there
//! is no agent name anywhere in this file.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{
    AgentSessionInfo, AgentSessionList, AgentSessionListRequest, AgentSessionListResponse,
};
use atlas_thread_metadata::{
    collect_all_sessions, importable_threads, ThreadFilter, ThreadMetadataStore,
};
use chrono::{TimeZone, Utc};
use futures::future::BoxFuture;
use futures::FutureExt;

/// One page of a scripted session list: what it returns, and the cursor it
/// hands back for the next one.
type Page = (Vec<AgentSessionInfo>, Option<String>);

/// The cursors an agent was actually asked with, in order.
type AskedWith = Arc<Mutex<Vec<Option<String>>>>;

/// An agent's session list, scripted page by page.
struct Pages {
    pages: Mutex<Vec<Page>>,
    cursors: AskedWith,
}

impl Pages {
    fn new(pages: Vec<Page>) -> (Arc<Self>, AskedWith) {
        let cursors = Arc::new(Mutex::new(Vec::new()));
        (
            Arc::new(Self {
                pages: Mutex::new(pages),
                cursors: cursors.clone(),
            }),
            cursors,
        )
    }
}

impl AgentSessionList for Pages {
    fn list_sessions(
        &self,
        request: AgentSessionListRequest,
    ) -> BoxFuture<'static, Result<AgentSessionListResponse, anyhow::Error>> {
        self.cursors.lock().unwrap().push(request.cursor);
        let page = self.pages.lock().unwrap();
        let index = self.cursors.lock().unwrap().len() - 1;
        let (sessions, next_cursor) = page
            .get(index)
            .cloned()
            .unwrap_or_else(|| (Vec::new(), None));
        async move {
            Ok(AgentSessionListResponse {
                sessions,
                next_cursor,
                meta: None,
            })
        }
        .boxed()
    }

    fn into_any(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
        self
    }
}

fn session(id: &str, dirs: &[&str]) -> AgentSessionInfo {
    AgentSessionInfo {
        session_id: acp::SessionId::new(id),
        work_dirs: Some(dirs.iter().map(PathBuf::from).collect()),
        title: Some(Arc::from(format!("{id} title").as_str())),
        updated_at: Some(Utc.with_ymd_and_hms(2026, 8, 20, 9, 0, 0).unwrap()),
        created_at: None,
        meta: None,
    }
}

#[tokio::test]
async fn every_page_is_fetched_before_anything_is_imported() {
    let (list, cursors) = Pages::new(vec![
        (vec![session("a", &["/tmp/atlas"])], Some("p2".into())),
        (vec![session("b", &["/tmp/atlas"])], Some("p3".into())),
        (vec![session("c", &["/tmp/atlas"])], None),
    ]);

    let sessions = collect_all_sessions(list.as_ref(), None).await.unwrap();

    assert_eq!(sessions.len(), 3);
    assert_eq!(
        *cursors.lock().unwrap(),
        vec![None, Some("p2".to_string()), Some("p3".to_string())],
        "each page is asked for with the cursor the last one returned"
    );
}

#[tokio::test]
async fn an_agent_that_repeats_its_cursor_does_not_loop_forever() {
    // Real adapters do this: claude-agent-acp ignores the cursor entirely and
    // returns the same full set every time.
    let (list, _) = Pages::new(vec![
        (vec![session("a", &["/tmp/atlas"])], Some("same".into())),
        (vec![session("a", &["/tmp/atlas"])], Some("same".into())),
        (vec![session("a", &["/tmp/atlas"])], Some("same".into())),
    ]);

    let sessions = collect_all_sessions(list.as_ref(), None).await.unwrap();

    assert_eq!(
        sessions.len(),
        2,
        "it stopped as soon as the cursor repeated"
    );
}

#[test]
fn import_writes_metadata_only_and_lands_in_history_not_the_active_list() {
    let dir = tempfile::tempdir().unwrap();
    let store = ThreadMetadataStore::open(dir.path().join("threads.db")).unwrap();

    let rows = importable_threads(
        vec![session("a", &["/tmp/atlas"])],
        &"some-agent".into(),
        &store.known_session_ids(),
        None,
    );
    store.save_all(rows);
    store.flush().unwrap();

    let imported = store.threads();
    assert_eq!(imported.len(), 1);
    assert!(
        imported[0].archived,
        "imports land in history, not the sidebar"
    );
    assert_eq!(imported[0].agent_id.as_str(), "some-agent");
    assert_eq!(imported[0].display_title().as_ref(), "a title");
    assert_eq!(
        imported[0].session_id,
        Some(acp::SessionId::new("a")),
        "the id resume will use"
    );
    assert!(
        store
            .threads_for_path(&atlas_thread_metadata::PathList::new(&[PathBuf::from(
                "/tmp/atlas"
            )]))
            .is_empty(),
        "and nothing appears in the project's active list"
    );
    assert_eq!(store.history(ThreadFilter::ArchivedOnly).len(), 1);
}

#[test]
fn importing_twice_never_duplicates_a_row() {
    let dir = tempfile::tempdir().unwrap();
    let store = ThreadMetadataStore::open(dir.path().join("threads.db")).unwrap();
    let listed = vec![session("a", &["/tmp/atlas"]), session("b", &["/tmp/atlas"])];

    store.save_all(importable_threads(
        listed.clone(),
        &"some-agent".into(),
        &store.known_session_ids(),
        None,
    ));
    store.flush().unwrap();

    let second = importable_threads(
        listed,
        &"some-agent".into(),
        &store.known_session_ids(),
        None,
    );

    assert!(second.is_empty(), "everything was already known");
    assert_eq!(store.threads().len(), 2);
}

#[test]
fn a_session_that_belongs_nowhere_is_not_imported() {
    let dir = tempfile::tempdir().unwrap();
    let store = ThreadMetadataStore::open(dir.path().join("threads.db")).unwrap();

    let rows = importable_threads(
        vec![
            session("homeless", &[]),
            AgentSessionInfo {
                work_dirs: None,
                ..session("also-homeless", &[])
            },
            session("real", &["/tmp/atlas"]),
        ],
        &"some-agent".into(),
        &store.known_session_ids(),
        None,
    );

    assert_eq!(
        rows.len(),
        1,
        "a thread with no directory has no project to show under"
    );
    assert_eq!(rows[0].session_id, Some(acp::SessionId::new("real")));
}

#[test]
fn an_imported_row_keeps_the_time_the_agent_reported() {
    let dir = tempfile::tempdir().unwrap();
    let store = ThreadMetadataStore::open(dir.path().join("threads.db")).unwrap();
    let when = Utc.with_ymd_and_hms(2026, 3, 14, 15, 9, 26).unwrap();

    let rows = importable_threads(
        vec![AgentSessionInfo {
            updated_at: Some(when),
            ..session("a", &["/tmp/atlas"])
        }],
        &"some-agent".into(),
        &store.known_session_ids(),
        None,
    );

    assert_eq!(rows[0].updated_at, when);
    assert_eq!(
        rows[0].created_at,
        Some(when),
        "without an agent-reported start, the reported activity time pins the \
         row's place in History, so a later touch does not move it"
    );
    assert_eq!(
        rows[0].interacted_at, None,
        "Atlas did not see the user send anything — it was not here"
    );
}

#[test]
fn a_backfill_runs_once_per_agent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("threads.db");
    {
        let store = ThreadMetadataStore::open(&path).unwrap();
        assert!(!store.has_backfilled(&"some-agent".into()));
        store.mark_backfilled(&"some-agent".into());
        store.flush().unwrap();
        assert!(store.has_backfilled(&"some-agent".into()));
        assert!(!store.has_backfilled(&"another-agent".into()));
    }

    // And it stays done across launches — the whole point of "once".
    let store = ThreadMetadataStore::open(&path).unwrap();
    assert!(store.has_backfilled(&"some-agent".into()));
    assert!(!store.has_backfilled(&"another-agent".into()));
}

#[test]
fn an_agent_that_lists_the_same_session_twice_produces_one_row() {
    let dir = tempfile::tempdir().unwrap();
    let store = ThreadMetadataStore::open(dir.path().join("threads.db")).unwrap();

    // What a cursor-ignoring adapter actually hands back: its whole set, once
    // per page.
    let rows = importable_threads(
        vec![
            session("a", &["/tmp/atlas"]),
            session("b", &["/tmp/atlas"]),
            session("a", &["/tmp/atlas"]),
            session("b", &["/tmp/atlas"]),
        ],
        &"some-agent".into(),
        &store.known_session_ids(),
        None,
    );
    store.save_all(rows);
    store.flush().unwrap();

    assert_eq!(store.threads().len(), 2, "two conversations, two rows");
}

fn session_updated(id: &str, updated_at: chrono::DateTime<Utc>) -> AgentSessionInfo {
    AgentSessionInfo {
        updated_at: Some(updated_at),
        ..session(id, &["/tmp/atlas"])
    }
}

#[test]
fn the_cutoff_splits_rows_into_sidebar_and_history() {
    let cutoff = Utc.with_ymd_and_hms(2026, 10, 1, 0, 0, 0).unwrap();
    let rows = importable_threads(
        vec![
            session_updated("old", cutoff - chrono::Duration::days(30)),
            session_updated("just-before", cutoff - chrono::Duration::seconds(1)),
            session_updated("exactly-at", cutoff),
            session_updated("new", cutoff + chrono::Duration::days(2)),
        ],
        &"some-agent".into(),
        &Default::default(),
        Some(cutoff),
    );

    let archived_of = |id: &str| {
        rows.iter()
            .find(|row| row.session_id == Some(acp::SessionId::new(id)))
            .unwrap()
            .archived
    };
    assert!(archived_of("old"));
    assert!(archived_of("just-before"));
    assert!(!archived_of("exactly-at"), "the cutoff itself is recent");
    assert!(!archived_of("new"));
}

#[test]
fn without_a_cutoff_everything_is_archived() {
    let rows = importable_threads(
        vec![session_updated("fresh", Utc::now())],
        &"some-agent".into(),
        &Default::default(),
        None,
    );

    assert_eq!(rows.len(), 1);
    assert!(rows[0].archived, "no cutoff means the old behaviour");
}

#[test]
fn a_recent_session_that_is_already_known_is_still_skipped() {
    let known = [acp::SessionId::new("seen")].into_iter().collect();
    let rows = importable_threads(
        vec![
            session_updated("seen", Utc::now()),
            session_updated("unseen", Utc::now()),
        ],
        &"some-agent".into(),
        &known,
        Some(Utc::now() - chrono::Duration::days(7)),
    );

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].session_id, Some(acp::SessionId::new("unseen")));
}

#[test]
fn an_agent_reported_start_time_is_kept() {
    let started = Utc.with_ymd_and_hms(2026, 3, 1, 9, 0, 0).unwrap();
    let rows = importable_threads(
        vec![AgentSessionInfo {
            created_at: Some(started),
            ..session_updated("a", Utc::now())
        }],
        &"some-agent".into(),
        &Default::default(),
        None,
    );
    assert_eq!(rows[0].created_at, Some(started));
}

/// History orders by `created_at`; an imported row must not move in it when
/// later activity bumps `updated_at`.
#[test]
fn an_imported_row_keeps_its_place_in_history_when_touched() {
    let dir = tempfile::tempdir().unwrap();
    let store = ThreadMetadataStore::open(dir.path().join("threads.db")).unwrap();
    let t0 = Utc.with_ymd_and_hms(2026, 9, 1, 0, 0, 0).unwrap();
    let older = session_updated("older", t0);
    let newer = session_updated("newer", t0 + chrono::Duration::days(1));
    store.insert_new_sessions(importable_threads(
        vec![older, newer],
        &"some-agent".into(),
        &store.known_session_ids(),
        Some(t0 - chrono::Duration::days(7)),
    ));

    store.touch_sessions(
        &[(acp::SessionId::new("older"), t0 + chrono::Duration::days(5))],
        None,
    );

    let order: Vec<_> = store
        .history(ThreadFilter::All)
        .into_iter()
        .map(|t| t.session_id.unwrap().0.to_string())
        .collect();
    assert_eq!(
        order,
        ["newer", "older"],
        "started order, not activity order"
    );
}

/// Two imports racing each filter against the same snapshot of known ids; the
/// atomic insert is what keeps one row per session.
#[test]
fn concurrent_imports_of_one_session_make_one_row() {
    let dir = tempfile::tempdir().unwrap();
    let store = ThreadMetadataStore::open(dir.path().join("threads.db")).unwrap();
    let snapshot = store.known_session_ids();
    let first = importable_threads(
        vec![session("a", &["/tmp/atlas"])],
        &"some-agent".into(),
        &snapshot,
        None,
    );
    let second = importable_threads(
        vec![session("a", &["/tmp/atlas"]), session("b", &["/tmp/atlas"])],
        &"some-agent".into(),
        &snapshot,
        None,
    );

    // Both spawned before either is joined, so they genuinely race.
    let spawn = |rows: Vec<_>| {
        let store = store.clone();
        std::thread::spawn(move || store.insert_new_sessions(rows))
    };
    let (a, b) = (spawn(first), spawn(second));
    let inserted = a.join().unwrap() + b.join().unwrap();

    assert_eq!(inserted, 2);
    assert_eq!(store.threads().len(), 2, "a once, b once");
}

/// The review finding: a deleted row came straight back on the next sync,
/// because the agent still listed the session. Deletion is remembered, across
/// a restart, and every import path skips it.
#[test]
fn a_deleted_session_is_never_imported_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("threads.db");
    {
        let store = ThreadMetadataStore::open(&path).unwrap();
        store.insert_new_sessions(importable_threads(
            vec![session_updated("gone", Utc::now())],
            &"some-agent".into(),
            &store.known_session_ids(),
            Some(Utc::now() - chrono::Duration::days(7)),
        ));
        let thread_id = store.threads()[0].thread_id;
        store.delete(thread_id);
        store.flush().unwrap();
    }

    let store = ThreadMetadataStore::open(&path).unwrap();
    assert!(store.is_session_deleted(&acp::SessionId::new("gone")));
    let listed_again = vec![session_updated("gone", Utc::now())];
    assert!(
        importable_threads(
            listed_again.clone(),
            &"some-agent".into(),
            &store.known_session_ids(),
            Some(Utc::now() - chrono::Duration::days(7)),
        )
        .is_empty(),
        "the filter skips it"
    );
    // Even rows built without the filter are refused at insert.
    let unfiltered = importable_threads(
        listed_again,
        &"some-agent".into(),
        &Default::default(),
        None,
    );
    assert_eq!(store.insert_new_sessions(unfiltered), 0);
    assert_eq!(
        store.touch_sessions(&[(acp::SessionId::new("gone"), Utc::now())], None),
        0
    );
    assert!(store.threads().is_empty());
}

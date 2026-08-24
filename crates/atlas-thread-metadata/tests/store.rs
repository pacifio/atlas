//! The thread-metadata store, exercised only through its public API against a
//! real temporary SQLite database.
//!
//! Nothing here reads a SQL row or touches private state: persistence is
//! asserted by closing the store and opening it again, which is what the app
//! does across launches.

use std::path::PathBuf;

use agent_client_protocol::schema::v1 as acp;
use chrono::{TimeZone, Utc};
use atlas_thread_metadata::{
    LiveThreadUpdate, PathList, ThreadFilter, ThreadId, ThreadMetadata, ThreadMetadataStore,
    ThreadStoreEvent, WorktreePaths,
};

fn open(dir: &tempfile::TempDir) -> ThreadMetadataStore {
    ThreadMetadataStore::open(dir.path().join("threads.db")).expect("store opens")
}

/// Import's bulk insert is the only wholesale write the store exposes; these
/// tests use it to seed one row at a time.
trait SaveOne {
    fn save_one(&self, metadata: ThreadMetadata);
}

impl SaveOne for ThreadMetadataStore {
    fn save_one(&self, metadata: ThreadMetadata) {
        self.save_all(vec![metadata]);
    }
}

/// A thread that has been sent to — the ordinary case, and the only kind that
/// survives a restart (a draft has no session id to be re-found by).
fn thread(agent: &str, paths: &[&str]) -> ThreadMetadata {
    let mut thread = draft(agent, paths);
    thread.session_id = Some(acp::SessionId::new(thread.thread_id.to_key_string()));
    thread
}

/// A thread before its first send.
fn draft(agent: &str, paths: &[&str]) -> ThreadMetadata {
    ThreadMetadata::new(
        ThreadId::new(),
        agent.into(),
        PathList::new(&paths.iter().map(PathBuf::from).collect::<Vec<_>>()),
    )
}

#[test]
fn a_saved_thread_is_still_there_after_reopening_the_store() {
    let dir = tempfile::tempdir().unwrap();
    let saved = thread("cersei", &["/tmp/atlas"]);

    {
        let store = open(&dir);
        store.save_one(saved.clone());
        store.flush().expect("queued writes drain");
    }

    let store = open(&dir);
    let threads = store.threads();
    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].thread_id, saved.thread_id);
    assert_eq!(threads[0].agent_id.as_str(), "cersei");
    assert_eq!(
        threads[0].folder_paths().paths(),
        &[PathBuf::from("/tmp/atlas")]
    );
}

#[test]
fn a_thread_is_a_draft_until_it_has_a_session_id_and_the_draft_is_never_persisted_with_one() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let draft = draft("cersei", &["/tmp/atlas"]);
    assert!(draft.is_draft(), "a new thread starts as a draft");

    store.save_one(draft.clone());
    store.flush().unwrap();
    assert!(store.thread(draft.thread_id).unwrap().is_draft());
    assert!(
        store.known_session_ids().is_empty(),
        "a draft contributes no session id to import dedup"
    );

    // First send: the thread is promoted with the agent's session id.
    let promoted = ThreadMetadata {
        session_id: Some(acp::SessionId::new("ses-1")),
        ..store.thread(draft.thread_id).unwrap()
    };
    store.save_one(promoted);
    store.flush().unwrap();

    let found = store
        .thread_for_session(&acp::SessionId::new("ses-1"))
        .expect("promoted thread is findable by its session id");
    assert_eq!(found.thread_id, draft.thread_id);
    assert!(!found.is_draft());
}

#[test]
fn a_users_rename_survives_every_later_agent_title() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let saved = thread("claude-code", &["/tmp/atlas"]);
    store.save_one(saved.clone());
    store.set_title_override(saved.thread_id, "Parser work");

    // A later agent title arrives, as one does on every turn.
    store.record_live_update(live(&saved, Some("Fix the tokenizer")));
    store.flush().unwrap();

    let after = store.thread(saved.thread_id).unwrap();
    assert_eq!(
        after.display_title().as_ref(),
        "Parser work",
        "the rename wins over the agent's title"
    );
    assert_eq!(
        after.title.as_deref(),
        Some("Fix the tokenizer"),
        "the agent's title is still recorded underneath"
    );
}

#[test]
fn regenerating_the_title_is_the_users_latest_word_and_drops_their_rename() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let saved = thread("claude-code", &["/tmp/atlas"]);
    store.save_one(saved.clone());
    store.set_title_override(saved.thread_id, "Parser work");

    // The user asks for a fresh title — the only caller of this path.
    store.set_generated_title(saved.thread_id, "Rewrite the tokenizer");
    store.flush().unwrap();

    let after = store.thread(saved.thread_id).unwrap();
    assert_eq!(after.display_title().as_ref(), "Rewrite the tokenizer");
    assert_eq!(after.title_override, None);
}

/// One live conversation event for an existing thread.
fn live(from: &ThreadMetadata, title: Option<&str>) -> LiveThreadUpdate {
    LiveThreadUpdate {
        thread_id: from.thread_id,
        is_draft: from.is_draft(),
        session_id: from.session_id.clone(),
        agent_id: from.agent_id.clone(),
        title: title.map(std::sync::Arc::from),
        worktree_paths: from.worktree_paths.clone(),
        remote_connection: None,
    }
}

#[test]
fn an_untitled_thread_shows_the_default_title() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let saved = thread("cersei", &["/tmp/atlas"]);
    store.save_one(saved.clone());

    assert_eq!(
        store.thread(saved.thread_id).unwrap().display_title().as_ref(),
        atlas_thread_metadata::DEFAULT_THREAD_TITLE
    );
}

#[test]
fn threads_are_grouped_by_project_across_every_project() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let atlas_one = thread("cersei", &["/tmp/atlas"]);
    let atlas_two = thread("claude-code", &["/tmp/atlas"]);
    let other = thread("cersei", &["/tmp/other"]);
    store.save_all(vec![atlas_one.clone(), atlas_two.clone(), other.clone()]);
    store.flush().unwrap();

    let atlas = PathList::new(&[PathBuf::from("/tmp/atlas")]);
    let ids: Vec<_> = store
        .threads_for_path(&atlas)
        .into_iter()
        .map(|t| t.thread_id)
        .collect();
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&atlas_one.thread_id) && ids.contains(&atlas_two.thread_id));

    // The other project is still there — the store is app-level, not
    // per-workspace, which is the whole point of ADR-0001.
    assert_eq!(
        store
            .threads_for_path(&PathList::new(&[PathBuf::from("/tmp/other")]))
            .len(),
        1
    );
    assert_eq!(store.threads().len(), 3);
}

#[test]
fn a_project_opened_in_either_order_is_the_same_group() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let saved = thread("cersei", &["/tmp/b", "/tmp/a"]);
    store.save_one(saved.clone());
    store.flush().unwrap();

    let queried = PathList::new(&[PathBuf::from("/tmp/a"), PathBuf::from("/tmp/b")]);
    assert_eq!(store.threads_for_path(&queried).len(), 1);
}

#[test]
fn a_thread_in_a_linked_worktree_is_findable_under_its_main_project() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let mut saved = thread("cersei", &["/tmp/atlas-feature"]);
    saved.worktree_paths = WorktreePaths::from_path_lists(
        PathList::new(&[PathBuf::from("/tmp/atlas")]),
        PathList::new(&[PathBuf::from("/tmp/atlas-feature")]),
    )
    .unwrap();
    store.save_one(saved.clone());
    store.flush().unwrap();

    let main = PathList::new(&[PathBuf::from("/tmp/atlas")]);
    assert_eq!(store.threads_for_main_worktree_path(&main).len(), 1);
    // …and still under the linked worktree it actually lives in.
    assert_eq!(
        store
            .threads_for_path(&PathList::new(&[PathBuf::from("/tmp/atlas-feature")]))
            .len(),
        1
    );
}

#[test]
fn archiving_takes_a_thread_out_of_the_project_list_but_keeps_it_in_history() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let saved = thread("cersei", &["/tmp/atlas"]);
    store.save_one(saved.clone());
    let atlas = PathList::new(&[PathBuf::from("/tmp/atlas")]);

    store.archive(saved.thread_id);
    store.flush().unwrap();
    assert!(store.threads_for_path(&atlas).is_empty());
    assert_eq!(store.history(ThreadFilter::ArchivedOnly).len(), 1);
    assert_eq!(store.threads().len(), 1, "history keeps it");

    store.unarchive(saved.thread_id);
    store.flush().unwrap();
    assert_eq!(store.threads_for_path(&atlas).len(), 1);
    assert!(store.history(ThreadFilter::ArchivedOnly).is_empty());
}

#[test]
fn a_thread_with_no_project_is_archived_so_it_is_never_lost() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let orphan = ThreadId::new();
    store.record_live_update(LiveThreadUpdate {
        thread_id: orphan,
        is_draft: false,
        session_id: Some(acp::SessionId::new("ses-orphan")),
        agent_id: "cersei".into(),
        title: None,
        worktree_paths: WorktreePaths::default(),
        remote_connection: None,
    });
    store.flush().unwrap();

    assert!(
        store.thread(orphan).unwrap().archived,
        "it belongs to no project, so only the history view could ever show it"
    );
}

#[test]
fn a_live_update_never_re_archives_a_thread_the_user_unarchived() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let saved = thread("cersei", &["/tmp/atlas"]);
    store.save_one(saved.clone());
    store.archive(saved.thread_id);
    store.unarchive(saved.thread_id);

    store.record_live_update(live(&saved, Some("Still here")));
    store.flush().unwrap();

    assert!(!store.thread(saved.thread_id).unwrap().archived);
}

#[test]
fn a_live_update_keeps_the_paths_an_archived_thread_was_archived_with() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let saved = thread("cersei", &["/tmp/atlas"]);
    store.save_one(saved.clone());
    store.archive(saved.thread_id);

    // The project no longer has the worktree — an update carrying no paths
    // must not erase the record of where the thread lived.
    store.record_live_update(LiveThreadUpdate {
        worktree_paths: WorktreePaths::default(),
        ..live(&saved, Some("Archived"))
    });
    store.flush().unwrap();

    assert_eq!(
        store.thread(saved.thread_id).unwrap().folder_paths().paths(),
        &[PathBuf::from("/tmp/atlas")]
    );
}

#[test]
fn a_live_update_keeps_when_the_thread_was_created() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let saved = thread("cersei", &["/tmp/atlas"]);
    store.save_one(saved.clone());
    let created_at = store.thread(saved.thread_id).unwrap().created_at;

    store.record_live_update(live(&saved, Some("Working")));
    store.flush().unwrap();

    let after = store.thread(saved.thread_id).unwrap();
    assert_eq!(after.created_at, created_at);
    assert!(after.updated_at >= created_at.unwrap());
}

#[test]
fn deleting_a_thread_removes_it_everywhere() {
    let dir = tempfile::tempdir().unwrap();
    let saved = ThreadMetadata {
        session_id: Some(acp::SessionId::new("ses-9")),
        ..thread("cersei", &["/tmp/atlas"])
    };
    let atlas = PathList::new(&[PathBuf::from("/tmp/atlas")]);

    {
        let store = open(&dir);
        store.save_one(saved.clone());
        store.delete(saved.thread_id);
        store.flush().unwrap();
        assert!(store.threads().is_empty());
        assert!(store.threads_for_path(&atlas).is_empty());
        assert!(store
            .thread_for_session(&acp::SessionId::new("ses-9"))
            .is_none());
    }

    assert!(open(&dir).threads().is_empty(), "and it stays deleted");
}



#[test]
fn rapid_updates_leave_the_newest_value_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    let saved = thread("cersei", &["/tmp/atlas"]);
    {
        let store = open(&dir);
        store.save_one(saved.clone());
        for n in 0..50 {
            store.set_generated_title(saved.thread_id, format!("turn {n}"));
        }
        store.flush().unwrap();
    }

    assert_eq!(
        open(&dir).thread(saved.thread_id).unwrap().title.as_deref(),
        Some("turn 49")
    );
}

#[test]
fn entries_come_back_newest_first() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let older = ThreadMetadata {
        updated_at: Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap(),
        ..thread("cersei", &["/tmp/atlas"])
    };
    let newer = ThreadMetadata {
        updated_at: Utc.with_ymd_and_hms(2026, 8, 22, 0, 0, 0).unwrap(),
        ..thread("claude-code", &["/tmp/atlas"])
    };
    store.save_all(vec![older.clone(), newer.clone()]);
    store.flush().unwrap();

    let order: Vec<_> = store.threads().into_iter().map(|t| t.thread_id).collect();
    assert_eq!(order, vec![newer.thread_id, older.thread_id]);
    assert_eq!(
        open(&dir)
            .threads()
            .into_iter()
            .map(|t| t.thread_id)
            .collect::<Vec<_>>(),
        order,
        "and the order survives a reopen"
    );
}

#[test]
fn the_project_grouping_survives_a_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let mut linked = thread("cersei", &["/tmp/atlas-feature"]);
    linked.worktree_paths = WorktreePaths::from_path_lists(
        PathList::new(&[PathBuf::from("/tmp/atlas")]),
        PathList::new(&[PathBuf::from("/tmp/atlas-feature")]),
    )
    .unwrap();
    {
        let store = open(&dir);
        store.save_all(vec![thread("cersei", &["/tmp/atlas"]), linked]);
        store.flush().unwrap();
    }

    let store = open(&dir);
    assert_eq!(
        store
            .threads_for_main_worktree_path(&PathList::new(&[PathBuf::from("/tmp/atlas")]))
            .len(),
        2,
        "the linked worktree's thread still groups under its main project"
    );
}

#[test]
fn every_mutation_announces_itself_so_the_sidebar_can_refresh() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let mut changes = store.subscribe();
    let saved = thread("cersei", &["/tmp/atlas"]);

    store.save_one(saved.clone());
    assert_eq!(changes.try_recv().unwrap(), ThreadStoreEvent::Changed);

    store.archive(saved.thread_id);
    assert_eq!(
        changes.try_recv().unwrap(),
        ThreadStoreEvent::ThreadArchived(saved.thread_id)
    );
    assert_eq!(changes.try_recv().unwrap(), ThreadStoreEvent::Changed);

    store.delete(saved.thread_id);
    assert_eq!(changes.try_recv().unwrap(), ThreadStoreEvent::Changed);

    // A no-op mutation is not a change.
    store.unarchive(saved.thread_id);
    assert!(changes.try_recv().is_err());
}

#[test]
fn a_store_written_by_a_newer_build_is_refused_rather_than_migrated_blind() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("threads.db");
    {
        let store = ThreadMetadataStore::open(&path).unwrap();
        store.save_one(thread("cersei", &["/tmp/atlas"]));
        store.flush().unwrap();
    }
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.pragma_update(None, "user_version", 99i64).unwrap();
    drop(conn);

    let err = match ThreadMetadataStore::open(&path) {
        Err(e) => e,
        Ok(_) => panic!("a future schema must be refused, not opened"),
    };
    assert!(
        matches!(err, atlas_thread_metadata::Error::SchemaTooNew { found: 99, .. }),
        "got {err}"
    );
}

#[test]
fn a_drafts_session_id_is_never_written_even_when_the_caller_offers_one() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let draft = ThreadId::new();

    // A draft session exists agent-side but is recreated on reload, so its id
    // is worthless the moment it is stored.
    store.record_live_update(LiveThreadUpdate {
        thread_id: draft,
        is_draft: true,
        session_id: Some(acp::SessionId::new("ses-draft")),
        agent_id: "cersei".into(),
        title: None,
        worktree_paths: WorktreePaths::from_folder_paths(&PathList::new(&[PathBuf::from(
            "/tmp/atlas",
        )])),
        remote_connection: None,
    });
    store.flush().unwrap();

    assert!(store.thread(draft).unwrap().is_draft());
    assert!(store
        .thread_for_session(&acp::SessionId::new("ses-draft"))
        .is_none());
}

#[test]
fn the_history_view_orders_by_when_a_thread_started() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    // Started long ago, touched a moment ago.
    let old_but_busy = ThreadMetadata {
        created_at: Some(Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap()),
        updated_at: Utc.with_ymd_and_hms(2026, 8, 22, 0, 0, 0).unwrap(),
        ..thread("cersei", &["/tmp/atlas"])
    };
    // Started recently, idle since.
    let new_but_idle = ThreadMetadata {
        created_at: Some(Utc.with_ymd_and_hms(2026, 6, 1, 0, 0, 0).unwrap()),
        updated_at: Utc.with_ymd_and_hms(2026, 6, 1, 0, 0, 0).unwrap(),
        ..thread("claude-code", &["/tmp/atlas"])
    };
    store.save_all(vec![old_but_busy.clone(), new_but_idle.clone()]);

    assert_eq!(
        store
            .history(ThreadFilter::All)
            .into_iter()
            .map(|t| t.thread_id)
            .collect::<Vec<_>>(),
        vec![new_but_idle.thread_id, old_but_busy.thread_id],
        "the history view buckets by when work started"
    );
    assert_eq!(
        store.threads().into_iter().map(|t| t.thread_id).collect::<Vec<_>>(),
        vec![old_but_busy.thread_id, new_but_idle.thread_id],
        "the active list orders by when work last happened"
    );
}

#[test]
fn clearing_a_rename_falls_back_to_the_agents_title() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let saved = thread("claude-code", &["/tmp/atlas"]);
    store.save_one(saved.clone());
    store.record_live_update(live(&saved, Some("Fix the tokenizer")));
    store.set_title_override(saved.thread_id, "Parser work");

    store.set_title_override(saved.thread_id, "   ");
    store.flush().unwrap();

    let after = store.thread(saved.thread_id).unwrap();
    assert_eq!(after.title_override, None);
    assert_eq!(after.display_title().as_ref(), "Fix the tokenizer");
}

#[test]
fn interacted_at_records_the_users_last_send_without_moving_created_at() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let saved = thread("cersei", &["/tmp/atlas"]);
    store.save_one(saved.clone());
    let sent_at = Utc.with_ymd_and_hms(2026, 8, 22, 12, 0, 0).unwrap();

    store.update_interacted_at(saved.thread_id, sent_at);
    store.flush().unwrap();

    let after = open(&dir).thread(saved.thread_id).unwrap();
    assert_eq!(after.interacted_at, Some(sent_at));
    assert_eq!(after.created_at, saved.created_at);
}

#[test]
fn a_project_that_gains_a_worktree_moves_its_threads_but_not_its_archived_ones() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let active = thread("cersei", &["/tmp/atlas"]);
    let shelved = thread("cersei", &["/tmp/atlas"]);
    store.save_all(vec![active.clone(), shelved.clone()]);
    store.archive(shelved.thread_id);

    let widened = WorktreePaths::from_folder_paths(&PathList::new(&[
        PathBuf::from("/tmp/atlas"),
        PathBuf::from("/tmp/atlas-docs"),
    ]));
    store.update_worktree_paths(&[active.thread_id, shelved.thread_id], widened.clone());
    store.flush().unwrap();

    let reopened = open(&dir);
    assert_eq!(reopened.thread(active.thread_id).unwrap().worktree_paths, widened);
    assert_eq!(
        reopened.thread(shelved.thread_id).unwrap().folder_paths().paths(),
        &[PathBuf::from("/tmp/atlas")],
        "an archived thread keeps the paths it was archived with"
    );
    assert_eq!(
        reopened
            .threads_for_path(&PathList::new(&[
                PathBuf::from("/tmp/atlas"),
                PathBuf::from("/tmp/atlas-docs"),
            ]))
            .len(),
        1,
        "and the moved thread is findable under its new project"
    );
}

#[test]
fn working_directories_are_not_rewritten_under_an_archived_thread() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let shelved = thread("cersei", &["/tmp/atlas"]);
    store.save_one(shelved.clone());
    store.archive(shelved.thread_id);

    store.update_working_directories(
        shelved.thread_id,
        PathList::new(&[PathBuf::from("/tmp/somewhere-else")]),
    );
    store.flush().unwrap();

    assert_eq!(
        store.thread(shelved.thread_id).unwrap().folder_paths().paths(),
        &[PathBuf::from("/tmp/atlas")]
    );
}

#[test]
fn clearing_the_history_view_deletes_every_thread_it_showed() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let one = thread("cersei", &["/tmp/atlas"]);
    let two = thread("claude-code", &["/tmp/other"]);
    store.save_all(vec![one.clone(), two.clone()]);
    store.archive(two.thread_id);

    store.delete_all(store.history(ThreadFilter::All).into_iter().map(|t| t.thread_id));
    store.flush().unwrap();

    assert!(open(&dir).threads().is_empty());
}

#[test]
fn the_sidebar_sees_every_project_at_once_newest_first() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let older_project = ThreadMetadata {
        updated_at: Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap(),
        ..thread("cersei", &["/tmp/other"])
    };
    let this_project_old = ThreadMetadata {
        updated_at: Utc.with_ymd_and_hms(2026, 8, 1, 0, 0, 0).unwrap(),
        ..thread("cersei", &["/tmp/atlas"])
    };
    let this_project_new = ThreadMetadata {
        updated_at: Utc.with_ymd_and_hms(2026, 8, 22, 0, 0, 0).unwrap(),
        ..thread("claude-code", &["/tmp/atlas"])
    };
    let shelved = thread("cersei", &["/tmp/atlas"]);
    store.save_all(vec![
        older_project.clone(),
        this_project_old.clone(),
        this_project_new.clone(),
        shelved.clone(),
    ]);
    store.archive(shelved.thread_id);
    store.flush().unwrap();

    let projects = store.projects();

    assert_eq!(projects.len(), 2, "work in another worktree is visible");
    assert_eq!(
        projects[0].paths.paths(),
        &[PathBuf::from("/tmp/atlas")],
        "the project worked in most recently comes first"
    );
    assert_eq!(
        projects[0]
            .threads
            .iter()
            .map(|t| t.thread_id)
            .collect::<Vec<_>>(),
        vec![this_project_new.thread_id, this_project_old.thread_id],
        "and its threads are newest first, with the archived one absent"
    );
    assert_eq!(projects[1].paths.paths(), &[PathBuf::from("/tmp/other")]);
}

#[test]
fn a_linked_worktree_is_listed_under_the_project_it_belongs_to() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let mut linked = thread("cersei", &["/tmp/atlas-feature"]);
    linked.worktree_paths = WorktreePaths::from_path_lists(
        PathList::new(&[PathBuf::from("/tmp/atlas")]),
        PathList::new(&[PathBuf::from("/tmp/atlas-feature")]),
    )
    .unwrap();
    store.save_all(vec![thread("cersei", &["/tmp/atlas"]), linked]);
    store.flush().unwrap();

    let projects = store.projects();

    assert_eq!(projects.len(), 1, "one project, not two");
    assert_eq!(projects[0].threads.len(), 2);
}

#[test]
fn the_chat_you_are_looking_at_is_not_also_listed_beneath_itself() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let sent = thread("cersei", &["/tmp/atlas"]);
    store.save_all(vec![sent.clone(), draft("cersei", &["/tmp/atlas"])]);
    store.flush().unwrap();

    let projects = store.projects();

    assert_eq!(projects.len(), 1);
    assert_eq!(
        projects[0].threads.iter().map(|t| t.thread_id).collect::<Vec<_>>(),
        vec![sent.thread_id],
        "a draft is the open tab, not a history row"
    );
}

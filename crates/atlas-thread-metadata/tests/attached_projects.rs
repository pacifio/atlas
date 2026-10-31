//! The projects attached to a session: attach, detach and change access,
//! through the store's public API, with persistence asserted by reopening.

use std::path::{Path, PathBuf};

use agent_client_protocol::schema::v1 as acp;
use atlas_thread_metadata::{
    AttachSource, AttachedProject, LiveThreadUpdate, PathList, ProjectAccess, ThreadId,
    ThreadMetadata, ThreadMetadataStore, WorktreePaths,
};

fn open(dir: &tempfile::TempDir) -> ThreadMetadataStore {
    ThreadMetadataStore::open(dir.path().join("threads.db")).expect("store opens")
}

fn saved(store: &ThreadMetadataStore) -> ThreadId {
    let mut thread = ThreadMetadata::new(
        ThreadId::new(),
        "some-agent".into(),
        PathList::new(&[PathBuf::from("/work/app")]),
    );
    thread.session_id = Some(acp::SessionId::new(thread.thread_id.to_key_string()));
    let id = thread.thread_id;
    store.save_all(vec![thread]);
    id
}

fn server(access: ProjectAccess) -> AttachedProject {
    AttachedProject::new("/work/server", "server", access, AttachSource::Mention)
}

#[test]
fn an_attached_project_survives_a_reopen_with_every_field() {
    let dir = tempfile::tempdir().unwrap();
    let (id, attached) = {
        let store = open(&dir);
        let id = saved(&store);
        let project = AttachedProject::new(
            "/work/server",
            "server",
            ProjectAccess::ReadWrite,
            AttachSource::AgentRequest,
        );
        assert!(store.attach_project(id, project.clone()));
        store.flush().unwrap();
        (id, project)
    };
    let store = open(&dir);
    let projects = store.attached_projects(id);
    assert_eq!(projects.len(), 1);
    // RFC 3339 through JSON keeps sub-second precision, so the whole entry
    // round-trips — including when it was attached.
    assert_eq!(projects[0], attached);
}

#[test]
fn attaching_is_read_only_by_default() {
    let project = AttachedProject::new("/x", "x", ProjectAccess::default(), AttachSource::Mention);
    assert_eq!(project.access, ProjectAccess::ReadOnly);
}

#[test]
fn attaching_a_path_twice_keeps_the_first_entry_and_its_access() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let id = saved(&store);
    assert!(store.attach_project(id, server(ProjectAccess::ReadWrite)));
    assert!(
        !store.attach_project(id, server(ProjectAccess::ReadOnly)),
        "a second mention must not quietly take write access away",
    );
    let projects = store.attached_projects(id);
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].access, ProjectAccess::ReadWrite);
}

#[test]
fn a_sessions_own_folder_is_never_attached_to_it() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let id = saved(&store);
    let own = AttachedProject::new(
        "/work/app",
        "app",
        ProjectAccess::ReadWrite,
        AttachSource::Mention,
    );
    assert!(!store.attach_project(id, own));
    assert!(store.attached_projects(id).is_empty());
}

#[test]
fn access_changes_and_detach_persist_and_answer_whether_anything_changed() {
    let dir = tempfile::tempdir().unwrap();
    let id = {
        let store = open(&dir);
        let id = saved(&store);
        assert!(store.attach_project(id, server(ProjectAccess::ReadOnly)));
        let other = AttachedProject::new(
            "/work/docs",
            "docs",
            ProjectAccess::ReadOnly,
            AttachSource::Clone,
        );
        assert!(store.attach_project(id, other));
        assert!(store.set_project_access(id, Path::new("/work/server"), ProjectAccess::ReadWrite));
        assert!(
            !store.set_project_access(id, Path::new("/work/server"), ProjectAccess::ReadWrite),
            "no change, no write"
        );
        assert!(!store.set_project_access(id, Path::new("/nowhere"), ProjectAccess::ReadWrite));
        assert!(store.detach_project(id, Path::new("/work/docs")));
        assert!(!store.detach_project(id, Path::new("/work/docs")));
        store.flush().unwrap();
        id
    };
    let projects = open(&dir).attached_projects(id);
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].path, PathBuf::from("/work/server"));
    assert_eq!(projects[0].access, ProjectAccess::ReadWrite);
}

#[test]
fn attaching_does_not_move_the_row_in_the_sidebar() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let id = saved(&store);
    let before = store.thread(id).unwrap().updated_at;
    assert!(store.attach_project(id, server(ProjectAccess::ReadOnly)));
    assert_eq!(store.thread(id).unwrap().updated_at, before);
}

#[test]
fn a_live_update_keeps_the_attachments() {
    // The conversation does not own the attachments: its next event must not
    // write a row without them.
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let id = saved(&store);
    assert!(store.attach_project(id, server(ProjectAccess::ReadWrite)));
    store.record_live_update(LiveThreadUpdate {
        thread_id: id,
        is_draft: false,
        session_id: Some(acp::SessionId::new(id.to_key_string())),
        agent_id: "some-agent".into(),
        title: Some("Renamed by the agent".into()),
        worktree_paths: WorktreePaths::from_folder_paths(&PathList::new(&[PathBuf::from(
            "/work/app",
        )])),
        remote_connection: None,
    });
    assert_eq!(store.attached_projects(id).len(), 1);
}

#[test]
fn a_missing_row_has_nothing_attached_and_attaches_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let ghost = ThreadId::new();
    assert!(!store.attach_project(ghost, server(ProjectAccess::ReadOnly)));
    assert!(store.attached_projects(ghost).is_empty());
}

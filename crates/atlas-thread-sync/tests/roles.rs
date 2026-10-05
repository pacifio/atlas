//! Roles, join approval and close on the desktop (ATL-406), through the
//! crate's public API: the fake thread server keeps the real one's role and
//! status rules — a viewer's writes and every write to a closed thread are
//! refused — and announces role and status changes to every socket.

use std::time::Duration;

use atlas_thread_sync::wire::Role;
use atlas_thread_sync::{FakeThreadServer, FakeTransport, LocalChange, ThreadEvent, ThreadSession};
use tokio::sync::mpsc;

mod common;
use common::*;

const QUIET: Duration = Duration::from_millis(50);

/// Joy owns and shared; Monzim joined with `role`. Both checked out.
async fn thread_with(
    w: &World,
    server: &FakeThreadServer,
    role: Role,
) -> (ThreadSession<FakeTransport>, ThreadSession<FakeTransport>) {
    server.set_owner("joy");
    server.set_role("monzim", role);
    let mut joy = open(server, &w.joy, &w.base, &w.replicas.join("joy"), "joy").await;
    joy.share_working_changes(&w.joy, &[]).await.unwrap();
    let mut monzim = open(
        server,
        &w.monzim,
        &w.base,
        &w.replicas.join("monzim"),
        "monzim",
    )
    .await;
    joy.materialize().await.unwrap();
    monzim.materialize().await.unwrap();
    (joy, monzim)
}

#[tokio::test]
async fn a_viewers_edits_are_not_sent_and_the_status_says_why() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim) = thread_with(&w, &server, Role::Viewer).await;
    let joy_root = joy.replica().root().to_path_buf();
    let monzim_root = monzim.replica().root().to_path_buf();

    let why = monzim.read_only().expect("a viewer is read-only");
    assert!(why.contains("viewer"), "{why}");

    // His edit and his new file stay on his machine, and he is told which.
    write(
        &monzim_root,
        "src/banner.css",
        ".banner {\n  color: teal;\n}\n",
    );
    write(&monzim_root, "src/idea.ts", "export const idea = 1;\n");
    assert_eq!(
        monzim.file_saved("src/banner.css").await.unwrap(),
        LocalChange::Ignored
    );
    monzim.file_saved("src/idea.ts").await.unwrap();
    assert_eq!(monzim.updates_sent(), 0);
    assert_eq!(
        monzim.unsent(),
        vec!["src/banner.css".to_string(), "src/idea.ts".to_string()]
    );

    // He still watches: Joy's change reaches him — without touching his
    // held edit on disk.
    write(
        &joy_root,
        "src/banner.css",
        "/* brand */\n.banner {\n  color: green;\n}\n",
    );
    joy.file_saved("src/banner.css").await.unwrap();
    monzim.pump(QUIET).await.unwrap();
    assert_eq!(
        read(&monzim_root, "src/banner.css"),
        ".banner {\n  color: teal;\n}\n"
    );
    assert!(!server.tree().iter().any(|e| e.path == "src/idea.ts"));
    // A file he deletes stays in the thread too, until he may change it.
    std::fs::remove_file(monzim_root.join("notes.md")).unwrap();
    monzim.file_saved("notes.md").await.unwrap();
    assert!(monzim.settle_removals().await.unwrap().is_empty());
    assert!(!server
        .tree()
        .iter()
        .any(|e| e.path == "notes.md" && e.deleted));

    // Promoted: what he held goes, merged with what Joy did meanwhile.
    server.set_role("monzim", Role::Participant);
    monzim.pump(QUIET).await.unwrap();
    assert!(monzim.read_only().is_none());
    assert!(monzim.wants_flush());
    monzim.flush_unsent().await.unwrap();
    assert!(monzim.unsent().is_empty());
    let merged = "/* brand */\n.banner {\n  color: teal;\n}\n";
    assert_eq!(read(&monzim_root, "src/banner.css"), merged);
    joy.pump(QUIET).await.unwrap();
    assert_eq!(read(&joy_root, "src/banner.css"), merged);
    assert_eq!(read(&joy_root, "src/idea.ts"), "export const idea = 1;\n");
    assert!(server
        .tree()
        .iter()
        .any(|e| e.path == "notes.md" && e.deleted));
}

#[tokio::test]
async fn close_turns_every_replica_read_only_and_reopen_lets_edits_through() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim) = thread_with(&w, &server, Role::Participant).await;
    let joy_root = joy.replica().root().to_path_buf();
    let monzim_root = monzim.replica().root().to_path_buf();

    server.set_closed(true);
    joy.pump(QUIET).await.unwrap();
    monzim.pump(QUIET).await.unwrap();
    for replica in [&joy, &monzim] {
        assert!(replica.is_closed());
        assert!(replica.read_only().unwrap().contains("closed"));
    }
    write(&joy_root, "notes.md", "todo: after close\n");
    assert_eq!(
        joy.file_saved("notes.md").await.unwrap(),
        LocalChange::Ignored
    );
    assert_eq!(joy.unsent(), vec!["notes.md".to_string()]);
    monzim.pump(QUIET).await.unwrap();
    assert_eq!(read(&monzim_root, "notes.md"), "todo: red?\n");

    server.set_closed(false);
    joy.pump(QUIET).await.unwrap();
    assert!(joy.read_only().is_none());
    joy.flush_unsent().await.unwrap();
    monzim.pump(QUIET).await.unwrap();
    assert_eq!(read(&monzim_root, "notes.md"), "todo: after close\n");
}

#[tokio::test]
async fn approving_a_join_request_lets_the_joiner_in_and_declining_does_not() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim) = thread_with(&w, &server, Role::Viewer).await;
    let (events, mut heard) = mpsc::unbounded_channel();
    joy.set_events(events);
    monzim.set_awaiting_approval(true);
    assert!(monzim
        .read_only()
        .unwrap()
        .contains("Waiting for the owner"));

    // The owner hears the request.
    server.request_join("monzim");
    joy.pump(QUIET).await.unwrap();
    // Presence comes and goes too (ATL-407); the request is among it.
    let mut requests = Vec::new();
    while let Ok(event) = heard.try_recv() {
        if !matches!(event, ThreadEvent::Presence(_)) {
            requests.push(event);
        }
    }
    assert_eq!(
        requests,
        vec![ThreadEvent::JoinRequested {
            user_id: "monzim".into()
        }]
    );

    // Declined: he stays a viewer, and is no longer told he is waiting.
    server.set_role("monzim", Role::Viewer);
    monzim.pump(QUIET).await.unwrap();
    let why = monzim.read_only().unwrap();
    assert!(why.contains("viewer") && !why.contains("Waiting"), "{why}");

    // Approved later: he is in.
    monzim.set_awaiting_approval(true);
    server.set_role("monzim", Role::Participant);
    monzim.pump(QUIET).await.unwrap();
    assert!(monzim.read_only().is_none());
    let root = monzim.replica().root().to_path_buf();
    write(&root, "README.md", "# Site\n\napproved\n");
    assert!(matches!(
        monzim.file_saved("README.md").await.unwrap(),
        LocalChange::NewFile { .. }
    ));
}

#[tokio::test]
async fn somebody_elses_role_change_is_not_taken_as_ones_own() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim) = thread_with(&w, &server, Role::Participant).await;
    assert_eq!(monzim.user_id(), Some("monzim"));
    server.set_role("someone-else", Role::Viewer);
    joy.pump(QUIET).await.unwrap();
    monzim.pump(QUIET).await.unwrap();
    assert!(monzim.read_only().is_none());
    assert_eq!(monzim.role(), Some(Role::Participant));
}

//! Presence, the Atlas editor and the sync indicator (ATL-407), through the
//! crate's public API on the fake thread server, which relays awareness the
//! way the real one does — kept with the connection, never stored.

use std::time::Duration;

use atlas_thread_sync::doc::{random_client_id, FileDoc};
use atlas_thread_sync::wire::Role;
use atlas_thread_sync::{
    FakeThreadServer, FakeTransport, RunSpec, RunWorktree, SessionError, SyncState, ThreadEvent,
    ThreadSession,
};
use tokio::sync::mpsc;

mod common;
use common::*;

const QUIET: Duration = Duration::from_millis(50);

async fn pair(
    server: &FakeThreadServer,
    w: &World,
) -> (ThreadSession<FakeTransport>, ThreadSession<FakeTransport>) {
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
    joy.pump(QUIET).await.unwrap();
    (joy, monzim)
}

/// What the Atlas editor does: edit its own copy of the document and hand
/// the session the update.
fn edit(state: &[u8], next: &str) -> (FileDoc, Vec<u8>) {
    let doc = FileDoc::from_snapshot(random_client_id(), state).unwrap();
    let mut updates = doc.set_content(next);
    assert_eq!(updates.len(), 1);
    (doc, updates.remove(0))
}

#[tokio::test]
async fn a_second_participants_cursor_appears_and_moves() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim) = pair(&server, &w).await;
    let banner = monzim.replica().file_id("src/banner.css").unwrap();

    monzim.set_cursors(banner, vec![(2, 5)]);
    monzim.set_typing(Some(banner));
    monzim.flush_awareness().await.unwrap();
    joy.pump(QUIET).await.unwrap();
    let peers = joy.peers();
    assert_eq!(peers.len(), 1);
    let him = &peers[0];
    assert_eq!(him.user_id, "monzim");
    assert_eq!(him.typing.as_deref(), Some("src/banner.css"));
    assert_eq!(him.cursors[0].path.as_deref(), Some("src/banner.css"));
    assert_eq!((him.cursors[0].anchor, him.cursors[0].head), (2, 5));
    assert_eq!(him.sync, Some(SyncState::Current));

    // It moves; saying the same thing twice sends nothing new.
    monzim.set_cursors(banner, vec![(9, 9)]);
    monzim.flush_awareness().await.unwrap();
    monzim.flush_awareness().await.unwrap();
    joy.pump(QUIET).await.unwrap();
    assert_eq!(joy.peers()[0].cursors[0].head, 9);

    // He leaves: so does his presence.
    drop(monzim);
    joy.pump(QUIET).await.unwrap();
    assert!(joy.peers().is_empty());
}

#[tokio::test]
async fn typing_in_the_atlas_editor_reaches_the_other_replica_and_its_editor() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim) = pair(&server, &w).await;
    let (events, mut heard) = mpsc::unbounded_channel();
    monzim.set_events(events);

    let opened = joy.open_doc("src/banner.css").unwrap();
    let theirs = monzim.open_doc("src/banner.css").unwrap();
    assert_eq!(opened.file_id, theirs.file_id);
    let typed = ".banner {\n  color: green;\n  margin: 0;\n}\n";
    let (_, update) = edit(&opened.state, typed);
    joy.editor_update(opened.file_id, update).await.unwrap();
    // Joy's replica holds it, on disk too, for any other editor.
    assert_eq!(read(joy.replica().root(), "src/banner.css"), typed);

    monzim.pump(QUIET).await.unwrap();
    assert_eq!(read(monzim.replica().root(), "src/banner.css"), typed);
    // His Atlas editor hears it as an update to its own copy.
    monzim.flush_docs();
    let editor = FileDoc::from_snapshot(random_client_id(), &theirs.state).unwrap();
    let mut got = false;
    while let Ok(event) = heard.try_recv() {
        if let ThreadEvent::DocUpdate { file_id, update } = event {
            assert_eq!(file_id, theirs.file_id);
            editor.apply(&update).unwrap();
            got = true;
        }
    }
    assert!(got, "no DocUpdate for the open file");
    assert_eq!(editor.content(), typed);
    // Nothing new, nothing sent.
    monzim.flush_docs();
    assert!(!matches!(
        heard.try_recv(),
        Ok(ThreadEvent::DocUpdate { .. })
    ));
}

#[tokio::test]
async fn the_editor_is_refused_where_a_save_would_not_sync() {
    let w = world();
    let server = FakeThreadServer::new();
    server.set_role("monzim", Role::Viewer);
    let (mut joy, mut monzim) = pair(&server, &w).await;
    let opened = monzim.open_doc("src/banner.css").unwrap();
    let (_, update) = edit(&opened.state, "viewers cannot\n");
    assert!(matches!(
        monzim.editor_update(opened.file_id, update).await,
        Err(SessionError::ReadOnly(_))
    ));

    // A keystroke that makes the file look like it holds a secret.
    let sent = joy.updates_sent();
    let opened = joy.open_doc("src/banner.css").unwrap();
    let (_, update) = edit(
        &opened.state,
        "AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n",
    );
    let refused = joy.editor_update(opened.file_id, update).await;
    assert!(
        matches!(refused, Err(SessionError::ReadOnly(ref why)) if why.contains("secret")),
        "{refused:?}"
    );
    assert_eq!(joy.updates_sent(), sent);
    assert_eq!(
        read(joy.replica().root(), "src/banner.css"),
        ".banner {\n  color: green;\n}\n"
    );
}

#[tokio::test]
async fn a_save_not_yet_read_is_judged_with_the_keystrokes_that_follow_it() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, _monzim) = pair(&server, &w).await;
    let sent = joy.updates_sent();
    let opened = joy.open_doc("src/banner.css").unwrap();
    // Another editor saved a credential; the watcher has not told anyone yet.
    write(
        joy.replica().root(),
        "src/banner.css",
        ".banner {}\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n",
    );
    let (_, update) = edit(&opened.state, ".banner {\n  color: green;\n}\n/* ok */\n");
    let refused = joy.editor_update(opened.file_id, update).await;
    assert!(
        matches!(refused, Err(SessionError::ReadOnly(_))),
        "{refused:?}"
    );
    assert_eq!(joy.updates_sent(), sent);
    assert!(joy
        .replica()
        .held_files()
        .contains(&"src/banner.css".to_string()));
}

#[tokio::test]
async fn a_runs_current_file_shows_for_everyone() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim) = pair(&server, &w).await;
    let runs = RunWorktree::new(&w.monzim, &w.base, &w.replicas.join("monzim-run"));
    let run = monzim
        .start_run(
            &runs,
            RunSpec {
                run_id: RunSpec::new_id(),
                agent: "codex".into(),
                model: "m".into(),
                context_anchor: None,
                remote_request_id: None,
            },
        )
        .await
        .unwrap();
    monzim.set_run_file(&run.run_id, Some("src/banner.css"));
    monzim.flush_awareness().await.unwrap();
    joy.pump(QUIET).await.unwrap();
    let current = |s: &ThreadSession<FakeTransport>| {
        s.runs()
            .into_iter()
            .find(|r| r.run.run_id == run.run_id)
            .and_then(|r| r.current_file)
    };
    assert_eq!(current(&joy).as_deref(), Some("src/banner.css"));
    assert_eq!(current(&monzim).as_deref(), Some("src/banner.css"));
    assert_eq!(
        joy.peers()[0].runs[0].path.as_deref(),
        Some("src/banner.css")
    );

    // Its turn over, the badge goes.
    monzim.finish_run(&run, &runs).await.unwrap();
    monzim.flush_awareness().await.unwrap();
    joy.pump(QUIET).await.unwrap();
    assert_eq!(current(&joy), None);
    assert!(joy.peers()[0].runs.is_empty());
}

#[tokio::test]
async fn going_offline_shows_behind_and_reconnecting_clears_it() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim) = pair(&server, &w).await;
    assert_eq!(monzim.sync_state(), SyncState::Current);

    server.cut("monzim");
    monzim.mark_disconnected();
    assert_eq!(monzim.sync_state(), SyncState::Behind);
    // A save made offline waits, and says so once back.
    write(monzim.replica().root(), "notes.md", "offline\n");
    monzim.file_saved("notes.md").await.unwrap();
    assert_eq!(monzim.sync_state(), SyncState::Behind);
    joy.pump(QUIET).await.unwrap();
    assert!(joy.peers().is_empty(), "his presence left with his socket");

    monzim.reconnect(server.connect("monzim")).await.unwrap();
    monzim.pump(QUIET).await.unwrap();
    assert_eq!(monzim.sync_state(), SyncState::Current);
    monzim.flush_awareness().await.unwrap();
    joy.pump(QUIET).await.unwrap();
    assert_eq!(joy.peers()[0].sync, Some(SyncState::Current));
    assert_eq!(read(joy.replica().root(), "notes.md"), "offline\n");
}

//! Surviving network drops and never drifting silently (ATL-404), through the
//! crate's public API: the fake thread server drops sockets, refuses
//! connections, compacts its journal, forgets history and loses frames, and
//! the replicas are real worktrees.

use std::time::Duration;

use atlas_thread_sync::{
    run_with, Command as SyncCommand, FakeThreadServer, FakeTransport, LocalChange, SyncStatus,
    ThreadSession, Verification,
};
use tokio::sync::{mpsc, oneshot, watch};

mod common;
use common::*;

const QUIET: Duration = Duration::from_millis(50);
const GREEN: &str = ".banner {\n  color: green;\n}\n";

/// Joy shared; Monzim joined. Both are checked out.
async fn pair(
    w: &World,
    server: &FakeThreadServer,
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
    (joy, monzim)
}

#[tokio::test]
async fn edits_made_while_disconnected_land_after_reconnect_and_both_converge() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim) = pair(&w, &server).await;
    let monzim_root = monzim.replica().root().to_path_buf();
    let joy_root = joy.replica().root().to_path_buf();

    // Monzim's network drops. He keeps working; so does Joy.
    server.cut("monzim");
    monzim.mark_disconnected();
    write(
        &monzim_root,
        "src/banner.css",
        ".banner {\n  color: teal;\n}\n",
    );
    assert_eq!(
        monzim.file_saved("src/banner.css").await.unwrap(),
        LocalChange::Buffered
    );
    write(
        &monzim_root,
        "src/offline.ts",
        "export const offline = true;\n",
    );
    monzim.file_saved("src/offline.ts").await.unwrap();
    write(&joy_root, "notes.md", "todo: red?\ntodo: ship it\n");
    joy.file_saved("notes.md").await.unwrap();
    assert_eq!(monzim.offline_saves(), 2);

    // Back: the tail since his last seq arrives, and his saves go out.
    monzim.reconnect(server.connect("monzim")).await.unwrap();
    assert!(monzim.is_connected());
    assert_eq!(monzim.offline_saves(), 0);
    assert_eq!(
        read(&monzim_root, "notes.md"),
        "todo: red?\ntodo: ship it\n"
    );

    joy.pump(QUIET).await.unwrap();
    assert_eq!(
        read(&joy_root, "src/banner.css"),
        ".banner {\n  color: teal;\n}\n"
    );
    assert_eq!(
        read(&joy_root, "src/offline.ts"),
        "export const offline = true;\n"
    );
    for path in ["src/banner.css", "notes.md", "src/offline.ts"] {
        assert_eq!(
            joy.replica().text(path),
            monzim.replica().text(path),
            "{path}"
        );
    }
}

#[tokio::test]
async fn an_update_whose_send_failed_is_resent_and_stored_once() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim) = pair(&w, &server).await;
    let monzim_root = monzim.replica().root().to_path_buf();

    // The socket is already gone when the save goes out; nobody has told the
    // session yet.
    server.cut("monzim");
    write(
        &monzim_root,
        "src/banner.css",
        ".banner {\n  color: lost;\n}\n",
    );
    assert_eq!(
        monzim.file_saved("src/banner.css").await.unwrap(),
        LocalChange::Buffered
    );
    assert!(!monzim.is_connected());

    let received = server.updates_received();
    monzim.reconnect(server.connect("monzim")).await.unwrap();
    // Resent — and the same frame twice would still be stored once.
    assert_eq!(server.updates_received(), received + 1);
    joy.pump(QUIET).await.unwrap();
    assert_eq!(
        joy.replica().text("src/banner.css").unwrap(),
        ".banner {\n  color: lost;\n}\n"
    );
}

#[tokio::test]
async fn a_replica_behind_a_compacted_range_catches_up_via_snapshot_plus_tail() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim) = pair(&w, &server).await;
    let joy_root = joy.replica().root().to_path_buf();
    let monzim_root = monzim.replica().root().to_path_buf();

    server.cut("monzim");
    monzim.mark_disconnected();
    for color in ["red", "orange", "purple"] {
        write(
            &joy_root,
            "src/banner.css",
            &format!(".banner {{\n  color: {color};\n}}\n"),
        );
        joy.file_saved("src/banner.css").await.unwrap();
    }
    // Everything so far is folded into snapshots; then one more edit, the tail.
    server.compact();
    write(&joy_root, "notes.md", "todo: after the compaction\n");
    joy.file_saved("notes.md").await.unwrap();

    monzim.reconnect(server.connect("monzim")).await.unwrap();
    assert_eq!(
        read(&monzim_root, "src/banner.css"),
        ".banner {\n  color: purple;\n}\n"
    );
    assert_eq!(
        read(&monzim_root, "notes.md"),
        "todo: after the compaction\n"
    );

    // Somebody new joins after the compaction, from nothing.
    let mut late = open(
        &server,
        &w.monzim,
        &w.base,
        &w.replicas.join("late"),
        "late",
    )
    .await;
    assert_eq!(
        late.replica().text("src/banner.css").unwrap(),
        ".banner {\n  color: purple;\n}\n"
    );
    // And checks out against the thread: the snapshot plus the tail is
    // canonical state.
    assert_eq!(late.verify().await.unwrap(), Verification::Match);
}

#[tokio::test]
async fn a_replica_ahead_of_the_thread_rebuilds_from_it_without_touching_the_checkout() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim) = pair(&w, &server).await;
    let joy_root = joy.replica().root().to_path_buf();
    let monzim_root = monzim.replica().root().to_path_buf();
    let kept = server.head();

    write(
        &joy_root,
        "src/banner.css",
        ".banner {\n  color: black;\n}\n",
    );
    joy.file_saved("src/banner.css").await.unwrap();
    monzim.pump(QUIET).await.unwrap();
    assert_eq!(
        read(&monzim_root, "src/banner.css"),
        ".banner {\n  color: black;\n}\n"
    );

    // The thread is restored to before that edit: Monzim saw changes it no
    // longer has.
    server.forget_after(kept);
    server.cut("monzim");
    monzim.mark_disconnected();
    monzim.reconnect(server.connect("monzim")).await.unwrap();

    assert_eq!(monzim.head(), kept);
    assert_eq!(monzim.replica().text("src/banner.css").unwrap(), GREEN);
    assert_eq!(read(&monzim_root, "src/banner.css"), GREEN);
    // His own checkout was never part of it.
    assert_eq!(
        read(&w.monzim, "src/banner.css"),
        ".banner {\n  color: blue;\n}\n"
    );
}

#[tokio::test]
async fn a_corrupted_replica_is_detected_and_repaired_and_says_so() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim) = pair(&w, &server).await;
    let joy_root = joy.replica().root().to_path_buf();
    let monzim_root = monzim.replica().root().to_path_buf();
    assert_eq!(monzim.verify().await.unwrap(), Verification::Match);

    // One of Joy's edits never reaches Monzim, and nothing says so.
    server.lose_next_update_to("monzim");
    write(
        &joy_root,
        "src/banner.css",
        ".banner {\n  color: navy;\n}\n",
    );
    joy.file_saved("src/banner.css").await.unwrap();
    write(
        &joy_root,
        "src/banner.css",
        ".banner {\n  color: navy;\n  margin: 0;\n}\n",
    );
    joy.file_saved("src/banner.css").await.unwrap();
    monzim.pump(QUIET).await.unwrap();
    assert_ne!(
        monzim.replica().text("src/banner.css"),
        joy.replica().text("src/banner.css")
    );

    assert_eq!(
        monzim.verify().await.unwrap(),
        Verification::Repaired(vec!["src/banner.css".to_string()])
    );
    assert_eq!(
        read(&monzim_root, "src/banner.css"),
        ".banner {\n  color: navy;\n  margin: 0;\n}\n"
    );
    assert!(monzim
        .notices()
        .iter()
        .any(|n| n.contains("Repaired 1 file") && n.contains("src/banner.css")));
    assert_eq!(monzim.verify().await.unwrap(), Verification::Match);
}

async fn wait_for(
    status: &mut watch::Receiver<SyncStatus>,
    what: impl Fn(&SyncStatus) -> bool,
) -> SyncStatus {
    tokio::time::timeout(Duration::from_secs(10), status.wait_for(|s| what(s)))
        .await
        .expect("status in time")
        .expect("loop alive")
        .clone()
}

#[tokio::test]
async fn the_loop_redials_by_itself_and_sends_what_was_saved_offline() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, monzim) = pair(&w, &server).await;
    let monzim_root = monzim.replica().root().to_path_buf();
    let (commands, rx) = mpsc::unbounded_channel();
    let (status_tx, mut status) = watch::channel(SyncStatus::default());
    tokio::spawn(run_with(monzim, rx, status_tx, server.connector("monzim")));
    let (reply, opened) = oneshot::channel();
    commands.send(SyncCommand::Materialize(reply)).unwrap();
    opened.await.unwrap().unwrap();

    // Offline: the socket drops and redialling fails for a while.
    server.set_offline("monzim", true);
    server.cut("monzim");
    wait_for(&mut status, |s| !s.connected).await;
    write(&monzim_root, "notes.md", "todo: written on a plane\n");
    tokio::time::sleep(Duration::from_millis(300)).await;

    server.set_offline("monzim", false);
    wait_for(&mut status, |s| s.connected).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        joy.pump(QUIET).await.unwrap();
        if joy.replica().text("notes.md").as_deref() == Some("todo: written on a plane\n") {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the offline save never arrived"
        );
    }
    drop(commands);
}

#[tokio::test]
async fn a_revoked_member_stops_syncing_and_is_told_why() {
    let w = world();
    let server = FakeThreadServer::new();
    let (_joy, monzim) = pair(&w, &server).await;
    let (_commands, rx) = mpsc::unbounded_channel::<SyncCommand>();
    let (status_tx, mut status) = watch::channel(SyncStatus::default());
    let loop_done = tokio::spawn(run_with(monzim, rx, status_tx, server.connector("monzim")));
    server.close("monzim", 1008);
    let last = wait_for(&mut status, |s| !s.connected && s.error.is_some()).await;
    assert!(last.error.unwrap().contains("access to this thread ended"));
    // No redialling: the loop is over.
    tokio::time::timeout(Duration::from_secs(5), loop_done)
        .await
        .expect("the loop ends")
        .unwrap();
}

#[tokio::test]
async fn a_resync_keeps_the_persons_offline_saves_and_sends_them() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim) = pair(&w, &server).await;
    let joy_root = joy.replica().root().to_path_buf();
    let monzim_root = monzim.replica().root().to_path_buf();
    let kept = server.head();
    write(
        &joy_root,
        "src/banner.css",
        ".banner {\n  color: black;\n}\n",
    );
    joy.file_saved("src/banner.css").await.unwrap();
    monzim.pump(QUIET).await.unwrap();

    // Offline, Monzim edits a file the lost history never touched.
    server.cut("monzim");
    monzim.mark_disconnected();
    write(&monzim_root, "notes.md", "todo: kept through a resync\n");
    monzim.file_saved("notes.md").await.unwrap();
    server.forget_after(kept);
    monzim.reconnect(server.connect("monzim")).await.unwrap();

    // The lost change is gone from his replica; his own edit is not.
    assert_eq!(read(&monzim_root, "src/banner.css"), GREEN);
    assert_eq!(
        read(&monzim_root, "notes.md"),
        "todo: kept through a resync\n"
    );
    let mut late = open(
        &server,
        &w.monzim,
        &w.base,
        &w.replicas.join("late"),
        "late",
    )
    .await;
    late.pump(QUIET).await.unwrap();
    assert_eq!(
        late.replica().text("notes.md").unwrap(),
        "todo: kept through a resync\n"
    );
}

#[tokio::test]
async fn an_edit_the_thread_lost_is_kept_beside_the_file_and_said() {
    let w = world();
    let server = FakeThreadServer::new();
    let (_joy, mut monzim) = pair(&w, &server).await;
    let monzim_root = monzim.replica().root().to_path_buf();
    let kept = server.head();

    // Monzim's edit reached the thread — and then the thread lost it.
    write(
        &monzim_root,
        "src/banner.css",
        ".banner {\n  color: violet;\n}\n",
    );
    monzim.file_saved("src/banner.css").await.unwrap();
    monzim.pump(QUIET).await.unwrap();
    server.forget_after(kept);
    server.cut("monzim");
    monzim.mark_disconnected();
    monzim.reconnect(server.connect("monzim")).await.unwrap();

    assert_eq!(read(&monzim_root, "src/banner.css"), GREEN);
    assert_eq!(
        read(&monzim_root, "src/banner.css.atlas-mine"),
        ".banner {\n  color: violet;\n}\n"
    );
    assert!(monzim
        .notices()
        .iter()
        .any(|n| n.contains("lost recent changes to src/banner.css")));
}

#[cfg(unix)]
#[tokio::test]
async fn a_kept_copy_is_as_private_as_the_file_it_came_from() {
    use std::os::unix::fs::PermissionsExt;
    let w = world();
    let server = FakeThreadServer::new();
    let (_joy, mut monzim) = pair(&w, &server).await;
    let monzim_root = monzim.replica().root().to_path_buf();
    let kept = server.head();
    let file = monzim_root.join("src/banner.css");
    write(
        &monzim_root,
        "src/banner.css",
        ".banner {\n  color: private;\n}\n",
    );
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    monzim.file_saved("src/banner.css").await.unwrap();
    monzim.pump(QUIET).await.unwrap();
    server.forget_after(kept);
    server.cut("monzim");
    monzim.mark_disconnected();
    monzim.reconnect(server.connect("monzim")).await.unwrap();

    let copy = monzim_root.join("src/banner.css.atlas-mine");
    let mode = std::fs::metadata(&copy).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
}

#[tokio::test]
async fn a_large_offline_edit_and_a_large_new_file_go_in_frame_sized_pieces() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim) = pair(&w, &server).await;
    let monzim_root = monzim.replica().root().to_path_buf();
    // Under the 1 MiB text limit, over the 256 KiB a frame carries.
    let big = "a line of generated text that keeps going\n".repeat(15_000);
    assert!(big.len() > 512 * 1024 && big.len() < 1024 * 1024);

    server.cut("monzim");
    monzim.mark_disconnected();
    write(&monzim_root, "notes.md", &big);
    monzim.file_saved("notes.md").await.unwrap();
    write(&monzim_root, "src/generated.ts", &big);
    monzim.file_saved("src/generated.ts").await.unwrap();
    monzim.reconnect(server.connect("monzim")).await.unwrap();

    joy.pump(QUIET).await.unwrap();
    assert_eq!(joy.replica().text("notes.md").unwrap(), big);
    assert_eq!(joy.replica().text("src/generated.ts").unwrap(), big);
}

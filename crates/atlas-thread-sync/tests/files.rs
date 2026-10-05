//! Binary files, large files, renames and deletions (ATL-403), through the
//! crate's public API: real temporary repositories and the fake thread
//! server, which keeps the real one's tree rules.

use std::fs;
use std::sync::Arc;
use std::time::Duration;

use atlas_thread_sync::wire::FileKind;
use atlas_thread_sync::{
    FakeThreadServer, FakeTransport, LocalChange, SessionError, ThreadSession,
};

mod common;
use common::*;

const QUIET: Duration = Duration::from_millis(50);

/// Joy shared and both replicas are checked out, with the thread's object
/// doors attached.
async fn both(
    w: &World,
    server: &FakeThreadServer,
) -> (
    ThreadSession<FakeTransport>,
    ThreadSession<FakeTransport>,
    std::path::PathBuf,
    std::path::PathBuf,
) {
    let mut joy = open(server, &w.joy, &w.base, &w.replicas.join("joy"), "joy").await;
    joy.set_store(Arc::new(server.store()));
    joy.share_working_changes(&w.joy, &[]).await.unwrap();
    let mut monzim = open(
        server,
        &w.monzim,
        &w.base,
        &w.replicas.join("monzim"),
        "monzim",
    )
    .await;
    monzim.set_store(Arc::new(server.store()));
    let joy_root = joy.materialize().await.unwrap();
    let monzim_root = monzim.materialize().await.unwrap();
    (joy, monzim, joy_root, monzim_root)
}

fn png(seed: u8) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    bytes.extend((0..4096u32).map(|i| (i as u8).wrapping_mul(seed)));
    bytes
}

#[tokio::test]
async fn a_changed_png_appears_byte_identical_on_the_other_replica() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim, joy_root, monzim_root) = both(&w, &server).await;

    fs::write(joy_root.join("logo.png"), png(3)).unwrap();
    assert!(matches!(
        joy.file_saved("logo.png").await.unwrap(),
        LocalChange::NewFile { .. }
    ));
    monzim.pump(QUIET).await.unwrap();
    assert_eq!(fs::read(monzim_root.join("logo.png")).unwrap(), png(3));
    let entry = server
        .tree()
        .into_iter()
        .find(|e| e.path == "logo.png")
        .unwrap();
    assert_eq!(entry.kind, FileKind::Binary);

    // Changed: last writer wins, byte for byte.
    fs::write(joy_root.join("logo.png"), png(7)).unwrap();
    assert!(matches!(
        joy.file_saved("logo.png").await.unwrap(),
        LocalChange::Blob { .. }
    ));
    monzim.pump(QUIET).await.unwrap();
    assert_eq!(fs::read(monzim_root.join("logo.png")).unwrap(), png(7));

    // Monzim's watcher reporting that write is an echo, not a change.
    let sent = monzim.updates_sent();
    assert_eq!(
        monzim.file_saved("logo.png").await.unwrap(),
        LocalChange::Echo
    );
    assert_eq!(monzim.updates_sent(), sent);

    // His own change goes the other way.
    fs::write(monzim_root.join("logo.png"), png(11)).unwrap();
    monzim.file_saved("logo.png").await.unwrap();
    joy.pump(QUIET).await.unwrap();
    assert_eq!(fs::read(joy_root.join("logo.png")).unwrap(), png(11));
}

#[tokio::test]
async fn a_lockfile_over_one_megabyte_syncs_as_a_blob_not_as_text() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim, joy_root, monzim_root) = both(&w, &server).await;

    let line =
        "\"resolved\": \"https://registry.npmjs.org/some-package/-/some-package-1.0.0.tgz\",\n";
    let lockfile = line.repeat(1024 * 1024 / line.len() + 10);
    assert!(lockfile.len() > 1024 * 1024);
    let updates_before = server.updates_received();
    fs::write(joy_root.join("package-lock.json"), &lockfile).unwrap();
    joy.file_saved("package-lock.json").await.unwrap();

    let entry = server
        .tree()
        .into_iter()
        .find(|e| e.path == "package-lock.json")
        .unwrap();
    assert_eq!(entry.kind, FileKind::Binary);
    assert!(entry.blob.is_some());
    // Not a single text update for it went over the wire.
    assert_eq!(server.updates_received(), updates_before);

    monzim.pump(QUIET).await.unwrap();
    assert_eq!(
        fs::read_to_string(monzim_root.join("package-lock.json")).unwrap(),
        lockfile
    );
}

#[tokio::test]
async fn moving_a_file_is_a_rename_with_the_same_id_on_the_other_replica() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim, joy_root, monzim_root) = both(&w, &server).await;
    let id = joy.replica().file_id("src/banner.css").unwrap();

    // `mv`: the watcher reports the new path, then the old one's removal.
    fs::rename(
        joy_root.join("src/banner.css"),
        joy_root.join("src/brand.css"),
    )
    .unwrap();
    assert!(matches!(
        joy.file_saved("src/brand.css").await.unwrap(),
        LocalChange::Renamed { file_id, .. } if file_id == id
    ));
    // The removal half is not a deletion any more.
    joy.file_saved("src/banner.css").await.unwrap();
    assert!(joy.settle_removals().await.unwrap().is_empty());

    let entry = server.tree().into_iter().find(|e| e.file_id == id).unwrap();
    assert_eq!(entry.path, "src/brand.css");
    assert!(!entry.deleted);

    monzim.pump(QUIET).await.unwrap();
    assert_eq!(monzim.replica().file_id("src/brand.css"), Some(id));
    assert_eq!(monzim.replica().file_id("src/banner.css"), None);
    assert_eq!(
        read(&monzim_root, "src/brand.css"),
        ".banner {\n  color: green;\n}\n"
    );
    assert!(!monzim_root.join("src/banner.css").exists());

    // Somebody checking out later gets the moved file — and not the Base's
    // copy at the old path.
    let mut late = open(
        &server,
        &w.monzim,
        &w.base,
        &w.replicas.join("late"),
        "late",
    )
    .await;
    let late_root = late.materialize().await.unwrap();
    assert!(late_root.join("src/brand.css").exists());
    assert!(!late_root.join("src/banner.css").exists());
}

#[tokio::test]
async fn a_removal_reported_before_the_new_path_is_still_a_rename() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, _monzim, joy_root, _) = both(&w, &server).await;
    let id = joy.replica().file_id("notes.md").unwrap();
    fs::rename(joy_root.join("notes.md"), joy_root.join("docs-notes.md")).unwrap();
    assert_eq!(
        joy.file_saved("notes.md").await.unwrap(),
        LocalChange::Missing { file_id: id }
    );
    assert!(matches!(
        joy.file_saved("docs-notes.md").await.unwrap(),
        LocalChange::Renamed { file_id, .. } if file_id == id
    ));
    assert!(joy.settle_removals().await.unwrap().is_empty());
    assert_eq!(
        server
            .tree()
            .into_iter()
            .find(|e| e.file_id == id)
            .unwrap()
            .path,
        "docs-notes.md"
    );
}

#[tokio::test]
async fn a_concurrent_rename_and_edit_converge() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim, joy_root, monzim_root) = both(&w, &server).await;

    // Joy moves the file while Monzim, not having heard, edits it.
    fs::rename(
        joy_root.join("src/banner.css"),
        joy_root.join("src/brand.css"),
    )
    .unwrap();
    joy.file_saved("src/brand.css").await.unwrap();
    write(
        &monzim_root,
        "src/banner.css",
        ".banner {\n  color: gold;\n}\n",
    );
    monzim.file_saved("src/banner.css").await.unwrap();

    monzim.pump(QUIET).await.unwrap();
    joy.pump(QUIET).await.unwrap();

    for root in [&joy_root, &monzim_root] {
        assert_eq!(
            read(root, "src/brand.css"),
            ".banner {\n  color: gold;\n}\n"
        );
        assert!(!root.join("src/banner.css").exists());
    }
    assert_eq!(
        joy.replica().text("src/brand.css"),
        monzim.replica().text("src/brand.css")
    );
}

#[tokio::test]
async fn a_deleted_file_is_deleted_everywhere_and_comes_back_under_its_id() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim, joy_root, monzim_root) = both(&w, &server).await;
    let id = joy.replica().file_id("notes.md").unwrap();

    fs::remove_file(joy_root.join("notes.md")).unwrap();
    joy.file_saved("notes.md").await.unwrap();
    assert_eq!(
        joy.settle_removals().await.unwrap(),
        vec!["notes.md".to_string()]
    );
    monzim.pump(QUIET).await.unwrap();
    assert!(!monzim_root.join("notes.md").exists());
    assert!(server.tree().iter().any(|e| e.file_id == id && e.deleted));

    // Created again: the same file, history and all.
    write(&monzim_root, "notes.md", "todo: blue\n");
    monzim.file_saved("notes.md").await.unwrap();
    joy.pump(QUIET).await.unwrap();
    assert_eq!(joy.replica().file_id("notes.md"), Some(id));
    assert_eq!(read(&joy_root, "notes.md"), "todo: blue\n");
}

#[tokio::test]
async fn a_share_carries_deletions_and_binary_files() {
    let w = world();
    fs::remove_file(w.joy.join("README.md")).unwrap();
    fs::write(w.joy.join("logo.png"), png(5)).unwrap();
    let server = FakeThreadServer::new();
    let (_joy, _monzim, _joy_root, monzim_root) = both(&w, &server).await;
    assert!(!monzim_root.join("README.md").exists());
    assert_eq!(fs::read(monzim_root.join("logo.png")).unwrap(), png(5));
}

#[tokio::test]
async fn touching_more_files_than_the_limit_is_refused_with_the_limit_named() {
    let w = world();
    let server = FakeThreadServer::new();
    // Joy's share touches two files; the plan allows two.
    server.set_touched_files_limit(Some(2));
    let (mut joy, _monzim, joy_root, _) = both(&w, &server).await;
    write(&joy_root, "src/third.ts", "export {};\n");
    let refused = joy.file_saved("src/third.ts").await.unwrap_err();
    let SessionError::Refused { code, message } = refused else {
        panic!("expected a refusal, got {refused:?}");
    };
    assert_eq!(code, "limit_reached");
    assert!(message.contains("touched files per thread: 2"), "{message}");
}

#[tokio::test]
async fn a_move_onto_a_path_the_person_uses_keeps_their_file_and_never_sends_it() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim, joy_root, monzim_root) = both(&w, &server).await;
    // Monzim has a file of his own at the path, not in the thread.
    write(
        &monzim_root,
        "src/brand.css",
        "/* monzim's private notes */\n",
    );

    fs::rename(
        joy_root.join("src/banner.css"),
        joy_root.join("src/brand.css"),
    )
    .unwrap();
    joy.file_saved("src/brand.css").await.unwrap();
    monzim.pump(QUIET).await.unwrap();

    // His file is beside it, untouched, and he is told.
    assert_eq!(
        read(&monzim_root, "src/brand.css.atlas-mine"),
        "/* monzim's private notes */\n"
    );
    assert_eq!(
        read(&monzim_root, "src/brand.css"),
        ".banner {\n  color: green;\n}\n"
    );
    assert!(monzim
        .notices()
        .iter()
        .any(|n| n.contains("src/brand.css.atlas-mine")));
    // And nothing of it reached the thread — not when the watcher reports
    // the file set aside, nor the path it left.
    let sent = monzim.updates_sent();
    assert_eq!(
        monzim.file_saved("src/brand.css.atlas-mine").await.unwrap(),
        LocalChange::Ignored
    );
    monzim.file_saved("src/brand.css").await.unwrap();
    assert_eq!(monzim.updates_sent(), sent);
    assert!(!server.tree().iter().any(|e| e.path.contains("atlas-mine")));
    assert!(!server
        .journaled_payloads()
        .iter()
        .any(|p| p.windows(7).any(|w| w == b"private")));
}

#[tokio::test]
async fn a_file_moved_to_a_secret_name_leaves_the_thread_and_stays_home() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim, joy_root, monzim_root) = both(&w, &server).await;
    let id = joy.replica().file_id("notes.md").unwrap();
    fs::rename(joy_root.join("notes.md"), joy_root.join(".env.production")).unwrap();
    assert_eq!(
        joy.file_saved(".env.production").await.unwrap(),
        LocalChange::Ignored
    );
    joy.file_saved("notes.md").await.unwrap();
    joy.settle_removals().await.unwrap();
    let entry = server.tree().into_iter().find(|e| e.file_id == id).unwrap();
    assert!(entry.deleted);
    assert_eq!(entry.path, "notes.md");
    assert!(!server.tree().iter().any(|e| e.path.contains(".env")));

    // Edits there stay home too.
    write(&joy_root, ".env.production", "SECRET=1\n");
    assert_eq!(
        joy.file_saved(".env.production").await.unwrap(),
        LocalChange::Ignored
    );
    monzim.pump(QUIET).await.unwrap();
    assert!(!monzim_root.join(".env.production").exists());
}

#[tokio::test]
async fn a_teammates_new_file_never_folds_in_an_ignored_file_of_the_persons() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim, joy_root, monzim_root) = both(&w, &server).await;
    // Monzim keeps build output in his replica; `dist/` is ignored.
    write(
        &monzim_root,
        "dist/config.js",
        "window.KEY = 'monzim-only';\n",
    );

    // A teammate's client puts a file at that path in the thread.
    write(&joy_root, "dist/config.js", "window.KEY = 'shared';\n");
    joy.share_working_changes(&joy_root, &[]).await.ok();
    let mut t = server.connect("mallory");
    use atlas_thread_sync::{Message, Transport};
    t.send(Message::Text(
        r#"{"t":"hello","protocol":1,"clientId":"mallory-replica-1","since":0}"#.into(),
    ))
    .await
    .unwrap();
    t.send(Message::Text(
        r#"{"t":"tree.ensure","clientSeq":1,"path":"dist/config.js","kind":"text"}"#.into(),
    ))
    .await
    .unwrap();
    monzim.pump(QUIET).await.unwrap();

    // His file was set aside, not read as the thread's — and nothing of it
    // left his machine.
    assert_eq!(
        read(&monzim_root, "dist/config.js.atlas-mine"),
        "window.KEY = 'monzim-only';\n"
    );
    let sent = monzim.updates_sent();
    monzim.file_saved("dist/config.js").await.unwrap();
    assert_eq!(monzim.updates_sent(), sent);
    assert!(!server
        .journaled_payloads()
        .iter()
        .any(|p| p.windows(11).any(|w| w == b"monzim-only")));
}

#[tokio::test]
async fn a_rename_onto_the_persons_file_sets_it_aside_even_when_the_source_is_gone() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, mut monzim, joy_root, monzim_root) = both(&w, &server).await;
    // Monzim already removed the file locally (not yet settled), and keeps a
    // file of his own where Joy is about to move it.
    fs::remove_file(monzim_root.join("notes.md")).unwrap();
    write(&monzim_root, "todo.md", "monzim's own list\n");

    fs::rename(joy_root.join("notes.md"), joy_root.join("todo.md")).unwrap();
    joy.file_saved("todo.md").await.unwrap();
    monzim.pump(QUIET).await.unwrap();

    assert_eq!(
        read(&monzim_root, "todo.md.atlas-mine"),
        "monzim's own list\n"
    );
    let sent = monzim.updates_sent();
    monzim.file_saved("todo.md").await.unwrap();
    assert!(!server
        .journaled_payloads()
        .iter()
        .any(|p| p.windows(9).any(|w| w == b"own list\n")));
    let _ = sent;
}

#[tokio::test]
async fn a_text_file_that_grows_past_the_text_limit_is_said_to_have_stopped_syncing() {
    let w = world();
    let server = FakeThreadServer::new();
    let (mut joy, _monzim, joy_root, _) = both(&w, &server).await;
    write(&joy_root, "notes.md", &"x".repeat(1024 * 1024 + 1));
    assert_eq!(joy.file_saved("notes.md").await.unwrap(), LocalChange::Echo);
    assert_eq!(joy.replica().outgrown_files(), vec!["notes.md".to_string()]);
    // Back under the limit, it syncs again and is no longer listed.
    write(&joy_root, "notes.md", "todo: smaller\n");
    assert!(matches!(
        joy.file_saved("notes.md").await.unwrap(),
        LocalChange::Update { .. }
    ));
    assert!(joy.replica().outgrown_files().is_empty());
}

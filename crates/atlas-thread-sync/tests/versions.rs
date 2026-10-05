//! Thread Versions on the desktop (ATL-419) through the crate's public API:
//! the thread's files diffed against the Base and against a Thread Version as
//! the server captured it, and a Restore — the server's change — landing on
//! every replica with each file's merge version moved on.

use std::time::Duration;

use atlas_thread_sync::doc::{random_client_id, FileDoc};
use atlas_thread_sync::versions::{DiffChange, VersionFile, VersionFiles};
use atlas_thread_sync::wire::FileKind;
use atlas_thread_sync::{FakeThreadServer, FakeTransport, ObjectStore, ThreadEvent, ThreadSession};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

mod common;
use common::*;

const QUIET: Duration = Duration::from_millis(50);
const BLUE: &str = ".banner {\n  color: blue;\n}\n";
const GREEN: &str = ".banner {\n  color: green;\n}\n";

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

struct Pair {
    w: World,
    server: FakeThreadServer,
    joy: ThreadSession<FakeTransport>,
    monzim: ThreadSession<FakeTransport>,
}

/// Joy shares her work (the banner turned green, a new `notes.md`); Monzim joins.
async fn pair() -> Pair {
    let w = world();
    let server = FakeThreadServer::new();
    let mut joy = open(&server, &w.joy, &w.base, &w.replicas.join("joy"), "joy").await;
    joy.share_working_changes(&w.joy, &[]).await.unwrap();
    let mut monzim = open(&server, &w.monzim, &w.base, &w.replicas.join("monzim"), "monzim").await;
    monzim.pump(QUIET).await.unwrap();
    Pair { w, server, joy, monzim }
}

#[tokio::test]
async fn against_the_base_every_replica_sees_the_same_changes() {
    let Pair { w: _w, mut joy, monzim, .. } = pair().await;
    joy.pump(QUIET).await.unwrap();
    for session in [&joy, &monzim] {
        let diffs = session.diff_against_base();
        let summary: Vec<_> = diffs.iter().map(|d| (d.path.as_str(), d.change, d.restorable)).collect();
        assert_eq!(
            summary,
            vec![
                ("notes.md", DiffChange::Added, false),
                ("src/banner.css", DiffChange::Modified, false),
            ]
        );
        let banner = &diffs[1].diff;
        assert!(banner.starts_with("diff --git a/src/banner.css b/src/banner.css\n"), "{banner}");
        assert!(banner.contains("\n-  color: blue;\n+  color: green;\n"), "{banner}");
    }
}

#[tokio::test]
async fn against_a_version_the_captured_files_are_read_by_their_blobs() {
    let Pair { w: _w, server, monzim, .. } = pair().await;
    let banner = monzim.replica().file_id("src/banner.css").unwrap();
    let notes = monzim.replica().file_id("notes.md").unwrap();
    // Version 1, as the server captured it: the banner still blue, no notes.
    let store = server.store();
    store.put_blob(sha256_hex(BLUE.as_bytes()), BLUE.as_bytes().to_vec()).await.unwrap();
    let at = VersionFiles {
        version: 1,
        files: vec![VersionFile {
            file_id: banner,
            path: "src/banner.css".into(),
            kind: FileKind::Text,
            blob: Some(sha256_hex(BLUE.as_bytes())),
        }],
    };
    let diffs = monzim.diff_against_version(&at).await;
    let summary: Vec<_> = diffs.iter().map(|d| (d.file_id, d.change, d.restorable)).collect();
    assert_eq!(
        summary,
        vec![(notes, DiffChange::Added, false), (banner, DiffChange::Modified, true)]
    );
    assert!(diffs[1].diff.contains("\n-  color: blue;\n+  color: green;\n"));

    // A file whose content was not captured says so, and cannot be restored.
    let lost = VersionFiles {
        version: 1,
        files: vec![VersionFile { blob: None, ..at.files[0].clone() }],
    };
    let diffs = monzim.diff_against_version(&lost).await;
    let banner_diff = diffs.iter().find(|d| d.file_id == banner).unwrap();
    assert_eq!((banner_diff.change, banner_diff.restorable), (DiffChange::Unavailable, false));

    // Unchanged since the Version: nothing to show.
    let same = VersionFiles {
        version: 2,
        files: vec![
            VersionFile {
                blob: Some(sha256_hex(GREEN.as_bytes())),
                ..at.files[0].clone()
            },
            VersionFile {
                file_id: notes,
                path: "notes.md".into(),
                kind: FileKind::Text,
                blob: Some(sha256_hex(b"todo: red?\n")),
            },
        ],
    };
    store.put_blob(sha256_hex(GREEN.as_bytes()), GREEN.as_bytes().to_vec()).await.unwrap();
    store.put_blob(sha256_hex(b"todo: red?\n"), b"todo: red?\n".to_vec()).await.unwrap();
    assert!(monzim.diff_against_version(&same).await.is_empty());
}

#[tokio::test]
async fn a_restore_lands_on_every_replica_and_moves_the_merge_version_on() {
    let Pair { w: _w, server, mut joy, mut monzim } = pair().await;
    let (tx, mut heard) = mpsc::unbounded_channel();
    monzim.set_events(tx);
    let banner = monzim.replica().file_id("src/banner.css").unwrap();
    let before = monzim.merge_version(banner);

    // The server's restore: canonical state's document, set back to blue.
    let doc = FileDoc::new(random_client_id());
    for u in FileDoc::seed_updates(BLUE) {
        doc.apply(&u).unwrap();
    }
    for u in server.journaled_for(banner) {
        doc.apply(&u).unwrap();
    }
    assert_eq!(doc.content(), GREEN);
    let sv = doc.state_vector();
    doc.set_content(BLUE);
    let update = doc.diff(&sv).unwrap();
    let version = server.restore("joy", 1, banner, update, &sha256_hex(BLUE.as_bytes()));

    joy.pump(QUIET).await.unwrap();
    monzim.pump(QUIET).await.unwrap();
    for (session, root) in [(&joy, "joy"), (&monzim, "monzim")] {
        assert_eq!(session.replica().text("src/banner.css").as_deref(), Some(BLUE), "{root}");
        assert_eq!(session.merge_version(banner), before + 1, "{root}");
        assert!(session.head() >= version, "{root}");
    }
    let mut told = false;
    while let Ok(event) = heard.try_recv() {
        told |= matches!(event, ThreadEvent::VersionsChanged);
    }
    assert!(told, "the replica did not say the Versions changed");
    // Against the Base, the banner is no longer a change.
    assert!(monzim.diff_against_base().iter().all(|d| d.path != "src/banner.css"));
}

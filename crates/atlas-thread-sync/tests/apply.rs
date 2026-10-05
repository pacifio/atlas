//! Apply (ATL-408) through the crate's public API, on real temporary
//! repositories: a thread's changes since the Base land in a checkout as
//! uncommitted changes, three-way onto whatever commit it is at; overlaps
//! with newer commits get conflict markers; uncommitted edits are never
//! overwritten; and nothing is applied while Conflicts are open.

use std::fs;
use std::path::Path;

use atlas_thread_sync::apply::{apply, ApplyError, ThreadChange, THREAD_COPY};
use atlas_thread_sync::wire::{ConflictInvolved, ThreadConflict};
use atlas_thread_sync::{ApplyOutcome, FakeThreadServer};

mod common;
use common::*;

fn ten(edits: &[(usize, &str)]) -> String {
    (1..=10)
        .map(|n| {
            edits
                .iter()
                .find(|(at, _)| *at == n)
                .map_or_else(|| format!("line {n}\n"), |(_, t)| format!("{t}\n"))
        })
        .collect()
}

/// A repository with a committed Base: `app.ts` (ten lines), `util.ts`,
/// `old.ts`, `gone.ts` and a binary `logo.png`. Answers its path and the Base.
fn repo(dir: &Path) -> String {
    init_repo(dir);
    write(dir, "app.ts", &ten(&[]));
    write(dir, "util.ts", "export const a = 1;\nexport const b = 2;\n");
    write(dir, "old.ts", "moved();\n");
    write(dir, "gone.ts", "bye();\n");
    fs::write(dir.join("logo.png"), b"\x89PNG\0base").unwrap();
    write(dir, ".gitignore", "local/\n");
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "--quiet", "-m", "base"]);
    git(dir, &["rev-parse", "HEAD"])
}

/// What the thread did: an edit, a new file, a deletion, a move, a new logo.
fn thread_changes() -> Vec<ThreadChange> {
    let text = |path: &str, content: &str| ThreadChange {
        path: path.into(),
        origin: None,
        content: Some(content.as_bytes().to_vec()),
    };
    vec![
        text("app.ts", &ten(&[(8, "thread 8")])),
        text("util.ts", "export const a = 10;\nexport const b = 2;\n"),
        text("src/new.ts", "fresh();\n"),
        ThreadChange {
            path: "gone.ts".into(),
            origin: None,
            content: None,
        },
        ThreadChange {
            path: "lib/moved.ts".into(),
            origin: Some("old.ts".into()),
            content: Some(b"moved();\n".to_vec()),
        },
        ThreadChange {
            path: "logo.png".into(),
            origin: None,
            content: Some(b"\x89PNG\0thread".to_vec()),
        },
    ]
}

fn status(dir: &Path) -> String {
    git(dir, &["status", "--porcelain", "--untracked-files=all"])
}

#[test]
fn on_a_clean_checkout_at_the_base_it_leaves_exactly_canonical_state_uncommitted() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("repo");
    let base = repo(&dir);
    let applied = apply(&dir, &base, &thread_changes(), None).unwrap();

    assert!(applied.conflicted.is_empty(), "{applied:?}");
    assert_eq!(read(&dir, "app.ts"), ten(&[(8, "thread 8")]));
    assert_eq!(
        read(&dir, "util.ts"),
        "export const a = 10;\nexport const b = 2;\n"
    );
    assert_eq!(read(&dir, "src/new.ts"), "fresh();\n");
    assert_eq!(read(&dir, "lib/moved.ts"), "moved();\n");
    assert!(!dir.join("gone.ts").exists());
    assert!(!dir.join("old.ts").exists());
    assert_eq!(fs::read(dir.join("logo.png")).unwrap(), b"\x89PNG\0thread");
    // Uncommitted: HEAD is still the Base, and git sees every change.
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), base);
    let st = status(&dir);
    for path in [
        "app.ts",
        "util.ts",
        "src/new.ts",
        "gone.ts",
        "old.ts",
        "lib/moved.ts",
        "logo.png",
    ] {
        assert!(st.contains(path), "{path} missing from:\n{st}");
    }
    // Applying the same state again is no conflict with itself.
    let again = apply(&dir, &base, &thread_changes(), None).unwrap();
    assert!(
        again.conflicted.is_empty() && again.stashed.is_none(),
        "{again:?}"
    );
    assert_eq!(read(&dir, "app.ts"), ten(&[(8, "thread 8")]));
}

#[test]
fn on_a_moved_checkout_the_rest_applies_and_overlaps_get_conflict_markers() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("repo");
    let base = repo(&dir);
    // The person committed since the Base: line 2 of app.ts (far from the
    // thread's line 8), the line of util.ts the thread changed, and the logo.
    write(&dir, "app.ts", &ten(&[(2, "mine 2")]));
    write(
        &dir,
        "util.ts",
        "export const a = 99;\nexport const b = 2;\n",
    );
    fs::write(dir.join("logo.png"), b"\x89PNG\0mine").unwrap();
    git(&dir, &["commit", "--quiet", "-am", "mine"]);

    let applied = apply(&dir, &base, &thread_changes(), None).unwrap();
    assert_eq!(read(&dir, "app.ts"), ten(&[(2, "mine 2"), (8, "thread 8")]));
    let util = read(&dir, "util.ts");
    assert!(util.contains("<<<<<<< yours"), "{util}");
    assert!(util.contains("export const a = 99;"));
    assert!(util.contains("export const a = 10;"));
    assert!(util.contains(">>>>>>> shared thread"));
    // A binary file keeps the person's version; the thread's goes beside it.
    assert_eq!(fs::read(dir.join("logo.png")).unwrap(), b"\x89PNG\0mine");
    let beside = format!("logo.png{THREAD_COPY}");
    assert_eq!(fs::read(dir.join(&beside)).unwrap(), b"\x89PNG\0thread");
    assert_eq!(applied.beside, vec![beside]);
    assert_eq!(
        applied.conflicted,
        vec!["logo.png".to_string(), "util.ts".to_string()]
    );
    assert!(applied.files.contains(&"app.ts".to_string()));
    assert_eq!(read(&dir, "src/new.ts"), "fresh();\n");
}

#[test]
fn uncommitted_edits_refuse_it_and_stash_and_apply_keeps_them() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("repo");
    let base = repo(&dir);
    write(&dir, "app.ts", &ten(&[(8, "my unsaved 8")]));
    write(&dir, "unrelated.txt", "mine\n");

    match apply(&dir, &base, &thread_changes(), None) {
        Err(ApplyError::Dirty(files)) => assert_eq!(files, vec!["app.ts".to_string()]),
        other => panic!("expected a refusal, got {other:?}"),
    }
    // A file the thread holds but left as the Base had it is not in the way.
    let mut with_unchanged = thread_changes();
    with_unchanged.retain(|c| c.path != "app.ts");
    with_unchanged.push(ThreadChange {
        path: "app.ts".into(),
        origin: None,
        content: Some(ten(&[]).into_bytes()),
    });
    let applied = apply(&dir, &base, &with_unchanged, None).unwrap();
    assert!(!applied.files.contains(&"app.ts".to_string()));
    assert_eq!(read(&dir, "app.ts"), ten(&[(8, "my unsaved 8")]));
    // Back to before, for the stash below.
    git(
        &dir,
        &["checkout", "--", "util.ts", "logo.png", "gone.ts", "old.ts"],
    );
    for extra in ["src/new.ts", "lib/moved.ts"] {
        fs::remove_file(dir.join(extra)).unwrap();
    }
    // Nothing was written.
    assert_eq!(read(&dir, "app.ts"), ten(&[(8, "my unsaved 8")]));
    assert!(!dir.join("src/new.ts").exists());

    let applied = apply(&dir, &base, &thread_changes(), Some("atlas: set aside")).unwrap();
    assert_eq!(applied.stashed.as_deref(), Some("atlas: set aside"));
    assert_eq!(read(&dir, "app.ts"), ten(&[(8, "thread 8")]));
    // Only the overlapping file was set aside; the rest of their work is there.
    assert_eq!(read(&dir, "unrelated.txt"), "mine\n");
    assert!(git(&dir, &["stash", "list"]).contains("atlas: set aside"));
    let kept = git(&dir, &["stash", "show", "-p", "stash@{0}"]);
    assert!(kept.contains("my unsaved 8"), "{kept}");
}

#[test]
fn an_ignored_file_of_the_persons_is_never_overwritten() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("repo");
    let base = repo(&dir);
    // git status does not show it; Apply still sees it.
    write(&dir, "local/settings.json", "{\"mine\": true}\n");
    let changes = vec![ThreadChange {
        path: "local/settings.json".into(),
        origin: None,
        content: Some(b"{\"thread\": true}\n".to_vec()),
    }];
    match apply(&dir, &base, &changes, None) {
        Err(ApplyError::Dirty(files)) => assert_eq!(files, vec!["local/settings.json".to_string()]),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert_eq!(read(&dir, "local/settings.json"), "{\"mine\": true}\n");
    // Stash and apply sets it aside too — git cannot stash an ignored file by
    // path, so it is moved under .git, never beside itself where it would no
    // longer be ignored, and never written over.
    let applied = apply(&dir, &base, &changes, Some("atlas: set aside")).unwrap();
    assert_eq!(read(&dir, "local/settings.json"), "{\"thread\": true}\n");
    assert_eq!(applied.set_aside.len(), 1);
    let kept = std::path::Path::new(&applied.set_aside[0]);
    assert!(kept.starts_with(dir.join(".git")), "{kept:?}");
    assert!(kept.ends_with("local/settings.json"));
    assert_eq!(fs::read_to_string(kept).unwrap(), "{\"mine\": true}\n");
    assert_eq!(applied.stashed, None);
    // Nothing new for git to see but the thread's file itself.
    assert!(!status(&dir).contains("atlas-mine"));
}

#[test]
fn a_binary_conflict_never_writes_over_a_file_beside_it() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("repo");
    let base = repo(&dir);
    fs::write(dir.join("logo.png"), b"\x89PNG\0mine").unwrap();
    git(&dir, &["commit", "--quiet", "-am", "mine"]);
    // Something of the person's already has the obvious name.
    let taken = format!("logo.png{THREAD_COPY}");
    write(&dir, "notes-to-self.txt", "x\n");
    fs::write(dir.join(&taken), b"my own").unwrap();
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "--quiet", "-m", "keep"]);
    let changes = vec![ThreadChange {
        path: "logo.png".into(),
        origin: None,
        content: Some(b"\x89PNG\0thread".to_vec()),
    }];
    let applied = apply(&dir, &base, &changes, None).unwrap();
    assert_eq!(fs::read(dir.join(&taken)).unwrap(), b"my own");
    let second = format!("{taken}-2");
    assert_eq!(applied.beside, vec![second.clone()]);
    assert_eq!(fs::read(dir.join(second)).unwrap(), b"\x89PNG\0thread");
}

#[test]
fn a_checkout_without_the_base_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("repo");
    repo(&dir);
    let other = "1".repeat(40);
    assert!(matches!(
        apply(&dir, &other, &thread_changes(), None),
        Err(ApplyError::BaseMissing(_))
    ));
}

#[tokio::test]
async fn a_participant_applies_the_thread_and_open_conflicts_block_it() {
    let w = world();
    let server = FakeThreadServer::new();
    let mut joy = open(&server, &w.joy, &w.base, &w.replicas.join("joy"), "joy").await;
    joy.share_working_changes(&w.joy, &[]).await.unwrap();
    let mut monzim = open(
        &server,
        &w.monzim,
        &w.base,
        &w.replicas.join("monzim"),
        "monzim",
    )
    .await;
    monzim
        .pump(std::time::Duration::from_millis(50))
        .await
        .unwrap();

    // Monzim's own clone, still at the Base, gets Joy's shared work.
    match monzim.apply_to(&w.monzim, false).await.unwrap() {
        ApplyOutcome::Applied(applied) => assert!(applied.conflicted.is_empty()),
        other => panic!("{other:?}"),
    }
    assert_eq!(
        read(&w.monzim, "src/banner.css"),
        ".banner {\n  color: green;\n}\n"
    );
    assert_eq!(read(&w.monzim, "notes.md"), "todo: red?\n");
    // Ignored and secret-looking files never were in the thread.
    assert!(!w.monzim.join(".env.local").exists());
    assert!(!w.monzim.join("dist/bundle.js").exists());

    // An open Conflict blocks it, and says how many.
    monzim.seed_conflicts(vec![ThreadConflict {
        conflict_id: 1,
        file_id: 1,
        path: "src/banner.css".into(),
        run_id: "run-00000001".into(),
        status: atlas_thread_sync::wire::ConflictStatus::Open,
        lines: None,
        binary: false,
        base: None,
        canonical: None,
        run: None,
        involved: ConflictInvolved {
            runs: vec![],
            people: vec![],
        },
        raised_by: "joy".into(),
        raised_at: 1,
        resolution: None,
    }]);
    assert_eq!(
        monzim.apply_to(&w.monzim, true).await.unwrap(),
        ApplyOutcome::ConflictsOpen { count: 1 }
    );
}

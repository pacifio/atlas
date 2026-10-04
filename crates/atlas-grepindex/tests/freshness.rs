//! Read-your-writes, fallbacks and HEAD moves: the index must never hide a match the plain
//! scan finds.

mod common;

use std::sync::Arc;

use atlas_grepindex::{BuildOutcome, GrepIndex, HeadAction, IndexOptions};
use atlas_search::{grep, CancelToken, CandidateSource};
use common::{both, rels, request, Repo};

/// 40 committed files, one of which holds `unique_token_xyz`.
fn fixture() -> Repo {
    let repo = Repo::new();
    for i in 0..40 {
        repo.write(
            &format!("src/mod{i:02}.rs"),
            format!("pub fn handler_{i}() -> u32 {{ {i} }}\n"),
        );
    }
    repo.write(
        "src/special.rs",
        "const MARK: &str = \"unique_token_xyz\";\n",
    );
    repo.commit_all("init");
    repo.backdate();
    repo
}

#[test]
fn selective_literal_skips_files() {
    let repo = fixture();
    let idx = repo.index();
    let (scan, indexed) = both(&idx, &request(&repo.root, "unique_token_xyz", None));
    assert_eq!(rels(&indexed), vec!["src/special.rs"]);
    assert_eq!(rels(&indexed), rels(&scan));
    assert!(
        indexed.skipped_by_index >= 40,
        "skipped {}",
        indexed.skipped_by_index
    );
}

#[test]
fn read_your_writes_after_note_write() {
    let repo = fixture();
    let idx = repo.index();
    let path = repo.write(
        "src/mod07.rs",
        "pub fn handler_7() { fresh_agent_symbol_42(); }\n",
    );
    idx.note_write(&path);
    let (scan, indexed) = both(&idx, &request(&repo.root, "fresh_agent_symbol_42", None));
    assert_eq!(rels(&indexed), vec!["src/mod07.rs"]);
    assert_eq!(rels(&indexed), rels(&scan));
}

#[test]
fn write_without_notification_is_still_found() {
    // A shell command (sed -i, codegen) rewrote a tracked file and nobody told the index.
    let repo = fixture();
    let idx = repo.index();
    repo.write("src/mod08.rs", "pub fn shell_written_symbol() {}\n");
    repo.write("src/brand_new.rs", "pub fn shell_written_symbol_two() {}\n");
    let (scan, indexed) = both(&idx, &request(&repo.root, "shell_written_symbol", None));
    assert_eq!(rels(&indexed), vec!["src/brand_new.rs", "src/mod08.rs"]);
    assert_eq!(rels(&indexed), rels(&scan));
}

#[test]
fn deleted_file_is_not_returned() {
    let repo = fixture();
    let idx = repo.index();
    let path = repo.root.join("src/special.rs");
    std::fs::remove_file(&path).unwrap();
    idx.note_write(&path);
    let (scan, indexed) = both(&idx, &request(&repo.root, "unique_token_xyz", None));
    assert!(rels(&indexed).is_empty());
    assert_eq!(rels(&indexed), rels(&scan));
}

#[test]
fn regex_without_literal_falls_back_to_scan() {
    let repo = fixture();
    let idx = repo.index();
    let (scan, indexed) = both(&idx, &request(&repo.root, r"\w+\s*\(", None));
    assert_eq!(indexed.skipped_by_index, 0);
    assert_eq!(rels(&indexed), rels(&scan));
    assert_eq!(rels(&scan).len(), 40);
}

#[test]
fn case_insensitive_kelvin_sign() {
    let repo = fixture();
    repo.write("src/units.rs", "// \u{212A}elvin_scale_factor is K\n");
    repo.commit_all("units");
    repo.backdate();
    let idx = repo.index();
    let (scan, indexed) = both(&idx, &request(&repo.root, "kelvin_scale", Some(true)));
    assert_eq!(rels(&scan), vec!["src/units.rs"]);
    assert_eq!(rels(&indexed), rels(&scan));
}

#[test]
fn gitignored_but_tracked_file_is_not_returned() {
    let repo = fixture();
    repo.write(
        "generated/out.rs",
        "const G: &str = \"unique_token_xyz\";\n",
    );
    repo.commit_all("generated");
    repo.write(".gitignore", "generated/\n");
    repo.commit_all("ignore generated");
    repo.backdate();
    let idx = repo.index();
    let (scan, indexed) = both(&idx, &request(&repo.root, "unique_token_xyz", None));
    assert_eq!(rels(&scan), vec!["src/special.rs"]);
    assert_eq!(rels(&indexed), rels(&scan));
}

#[test]
fn watcher_overflow_falls_back_until_resync() {
    let repo = fixture();
    let idx = repo.index();
    idx.mark_untrusted();
    let req = request(&repo.root, "unique_token_xyz", None);
    let (scan, indexed) = both(&idx, &req);
    assert_eq!(
        indexed.skipped_by_index, 0,
        "an untrusted index must not filter"
    );
    assert_eq!(rels(&indexed), rels(&scan));
    idx.resync().unwrap();
    let (_, indexed) = both(&idx, &req);
    assert!(indexed.skipped_by_index > 0);
}

#[test]
fn head_switch_overlays_changed_files() {
    let repo = fixture();
    let idx = repo.index();
    repo.git(&["checkout", "-q", "-b", "feature"]);
    repo.write("src/mod09.rs", "pub fn branch_only_symbol() {}\n");
    repo.commit_all("feature");
    repo.backdate();
    assert_eq!(idx.refresh_head().unwrap(), HeadAction::Overlaid(1));
    let (scan, indexed) = both(&idx, &request(&repo.root, "branch_only_symbol", None));
    assert_eq!(rels(&indexed), vec!["src/mod09.rs"]);
    assert_eq!(rels(&indexed), rels(&scan));
    repo.git(&["checkout", "-q", "-"]);
    assert_eq!(idx.refresh_head().unwrap(), HeadAction::Unchanged);
}

#[test]
fn large_head_move_requests_rebuild() {
    let repo = fixture();
    let opts = IndexOptions {
        head_rebuild_min_files: 0,
        head_rebuild_ratio: 0.0,
        ..IndexOptions::always()
    };
    let idx = GrepIndex::open(&repo.root, opts).unwrap();
    idx.ensure_built(&CancelToken::new()).unwrap();
    let old_tree = idx.status().base_tree.unwrap();
    repo.write("src/mod10.rs", "pub fn after_rebuild() {}\n");
    repo.commit_all("next");
    repo.backdate();
    assert_eq!(idx.refresh_head().unwrap(), HeadAction::RebuildNeeded);
    assert_eq!(
        idx.ensure_built(&CancelToken::new()).unwrap(),
        BuildOutcome::Built
    );
    let new_tree = idx.status().base_tree.unwrap();
    assert_ne!(old_tree, new_tree);
    assert!(
        !idx.grep_dir().join(&old_tree).exists(),
        "stale snapshot removed"
    );
    let (scan, indexed) = both(&Arc::new(idx), &request(&repo.root, "after_rebuild", None));
    assert_eq!(rels(&indexed), rels(&scan));
    assert!(indexed.skipped_by_index > 0);
}

#[test]
fn snapshot_is_reused_by_a_second_open() {
    let repo = fixture();
    drop(repo.index());
    let idx = GrepIndex::open(&repo.root, IndexOptions::always()).unwrap();
    assert_eq!(
        idx.ensure_built(&CancelToken::new()).unwrap(),
        BuildOutcome::Loaded
    );
}

#[test]
fn small_repo_is_below_threshold() {
    let repo = fixture();
    let idx = Arc::new(GrepIndex::open(&repo.root, IndexOptions::default()).unwrap());
    assert_eq!(
        idx.ensure_built(&CancelToken::new()).unwrap(),
        BuildOutcome::BelowThreshold
    );
    let mut req = request(&repo.root, "unique_token_xyz", None);
    req.candidates = Some(idx as Arc<dyn CandidateSource>);
    assert_eq!(grep(&req, &CancelToken::new()).unwrap().skipped_by_index, 0);
}

#[test]
fn unindexable_files_are_always_searched() {
    let repo = fixture();
    repo.write("assets/blob.bin", b"unique_token_xyz\0\x01\x02");
    repo.write(
        "dist/app.min.js",
        format!("var a=\"unique_token_xyz\";{}\n", "x".repeat(3000)),
    );
    repo.write("docs/utf16.txt", [0xFF, 0xFE, b'u', 0, b'n', 0]);
    repo.commit_all("odd files");
    repo.backdate();
    let idx = repo.index();
    let (scan, indexed) = both(&idx, &request(&repo.root, "unique_token_xyz", None));
    assert_eq!(rels(&indexed), rels(&scan));
    assert!(rels(&scan).contains(&"dist/app.min.js".to_string()));
}

#[test]
fn request_rooted_in_a_subdirectory() {
    let repo = fixture();
    repo.write("pkg/inner/lib.rs", "pub fn nested_unique_fn() {}\n");
    repo.commit_all("pkg");
    repo.backdate();
    let idx = repo.index();
    let (scan, indexed) = both(
        &idx,
        &request(&repo.root.join("pkg"), "nested_unique_fn", None),
    );
    assert_eq!(rels(&scan), vec!["inner/lib.rs"]);
    assert_eq!(rels(&indexed), rels(&scan));
}

#[test]
fn index_files_are_git_excluded() {
    let repo = fixture();
    drop(repo.index());
    let exclude = std::fs::read_to_string(repo.root.join(".git/info/exclude")).unwrap();
    assert!(exclude.lines().any(|l| l == "/.atlas/"));
    let out = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&repo.root)
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&out.stdout).trim().is_empty(),
        "index files leaked into git status"
    );
}

#[test]
fn worktree_root_is_found_from_a_subdirectory() {
    let repo = fixture();
    assert_eq!(
        atlas_grepindex::worktree_root(&repo.root.join("src")),
        Some(repo.root.clone())
    );
    let outside = tempfile::tempdir().unwrap();
    assert_eq!(atlas_grepindex::worktree_root(outside.path()), None);
}

#[test]
fn not_a_worktree_root_is_refused() {
    let repo = fixture();
    let err = GrepIndex::open(&repo.root.join("src"), IndexOptions::always()).unwrap_err();
    assert!(
        matches!(err, atlas_grepindex::Error::NotWorktreeRoot(_)),
        "{err}"
    );
}

#[test]
fn an_edit_that_restores_mtime_is_still_found() {
    // `cp -p`, `rsync -t` and `touch -r` put the old mtime back. With an equal size,
    // only ctime and the inode show the edit.
    let repo = fixture();
    let idx = repo.index();
    let path = repo.root.join("src/mod05.rs");
    let old = std::fs::metadata(&path).unwrap().modified().unwrap();
    let original = std::fs::read_to_string(&path).unwrap();
    let edited = original.replace("handler_5", "hidden_x5");
    assert_eq!(edited.len(), original.len());
    std::fs::write(&path, &edited).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(old)
        .unwrap();
    let (scan, indexed) = both(&idx, &request(&repo.root, "hidden_x5", None));
    assert_eq!(rels(&scan), vec!["src/mod05.rs"]);
    assert_eq!(rels(&indexed), rels(&scan));
}

#[test]
fn the_overlay_respects_its_byte_cap() {
    let repo = fixture();
    let opts = IndexOptions {
        max_overlay_bytes: 1,
        ..IndexOptions::always()
    };
    let idx = Arc::new(GrepIndex::open(&repo.root, opts).unwrap());
    idx.ensure_built(&CancelToken::new()).unwrap();
    let a = repo.write("src/mod01.rs", "pub fn over_cap_one() {}\n");
    let b = repo.write("src/mod02.rs", "pub fn over_cap_two() {}\n");
    idx.note_paths(&[a, b]);
    assert_eq!(
        idx.status().overlay_docs,
        0,
        "nothing fits in a 1-byte overlay"
    );
    // Files that don't fit lose their stamps, so they are searched: still correct.
    let (scan, indexed) = both(&idx, &request(&repo.root, "over_cap_", None));
    assert_eq!(rels(&indexed), vec!["src/mod01.rs", "src/mod02.rs"]);
    assert_eq!(rels(&indexed), rels(&scan));
}

#[test]
fn a_repo_without_commits_gets_an_index_after_its_first_commit() {
    let repo = Repo::new();
    repo.write("src/a.rs", "pub fn first() {}\n");
    let idx = GrepIndex::open(&repo.root, IndexOptions::always()).unwrap();
    assert!(
        idx.ensure_built(&CancelToken::new()).is_err(),
        "no HEAD yet"
    );
    repo.commit_all("first");
    assert_eq!(idx.refresh_head().unwrap(), HeadAction::RebuildNeeded);
    assert!(matches!(
        idx.ensure_built(&CancelToken::new()).unwrap(),
        BuildOutcome::Built | BuildOutcome::Loaded
    ));
    assert!(idx.status().ready);
}

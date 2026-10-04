//! `find_files` against real temp trees.

mod support;

use atlas_search::{find_files, CancelToken, FindMode, FindRequest, SearchError};
use support::{git_tree, set_mtime, tree};

fn run(req: &FindRequest) -> atlas_search::FindResult {
    find_files(req, &CancelToken::new()).expect("find runs")
}

#[test]
fn a_glob_without_a_slash_matches_names_at_any_depth_newest_first() {
    let dir = tree(&[
        ("Cargo.toml", b""),
        ("crates/a/Cargo.toml", b""),
        ("crates/a/src/lib.rs", b""),
    ]);
    set_mtime(dir.path(), "Cargo.toml", 1_000);
    set_mtime(dir.path(), "crates/a/Cargo.toml", 2_000);
    let res = run(&FindRequest::new(dir.path(), "*.toml"));
    assert_eq!(res.paths, ["crates/a/Cargo.toml", "Cargo.toml"]);
    assert_eq!(res.total, 2);
}

#[test]
fn a_glob_with_a_slash_is_matched_against_the_whole_path() {
    let dir = tree(&[
        ("src/a.rs", b""),
        ("src/deep/b.rs", b""),
        ("other/c.rs", b""),
    ]);
    let res = run(&FindRequest::new(dir.path(), "src/*.rs"));
    assert_eq!(res.paths, ["src/a.rs"]);
    let deep = run(&FindRequest::new(dir.path(), "src/**/*.rs"));
    assert_eq!(deep.total, 2);
}

#[test]
fn fuzzy_text_ranks_the_closest_path_first() {
    let dir = tree(&[
        ("src/commands/fileindex.rs", b""),
        ("src/commands/file_ops.rs", b""),
        ("docs/index.md", b""),
    ]);
    let res = run(&FindRequest::new(dir.path(), "fileindex"));
    assert_eq!(res.paths[0], "src/commands/fileindex.rs");
    let forced = FindRequest {
        mode: FindMode::Fuzzy,
        ..FindRequest::new(dir.path(), "*")
    };
    assert_eq!(run(&forced).total, 0, "fuzzy mode treats * as text");
}

#[test]
fn secrets_and_vcs_dirs_are_never_listed() {
    let dir = git_tree(&[
        (".env", b""),
        (".env.example", b""),
        (".git/HEAD", b""),
        ("a.rs", b""),
    ]);
    let mut res = run(&FindRequest::new(dir.path(), "*")).paths;
    res.sort();
    assert_eq!(res, [".env.example", "a.rs"]);
}

#[test]
fn directories_only_when_asked_and_marked_with_a_slash() {
    let dir = tree(&[("src/a.rs", b"")]);
    assert_eq!(
        run(&FindRequest::new(dir.path(), "src")).total,
        1,
        "src/a.rs fuzzy-matches"
    );
    let dirs = FindRequest {
        include_dirs: true,
        mode: FindMode::Glob,
        ..FindRequest::new(dir.path(), "src")
    };
    assert_eq!(run(&dirs).paths, ["src/"]);
}

#[test]
fn offset_and_limit_page_the_ranked_list() {
    let dir = tree(&[("a.rs", b""), ("b.rs", b""), ("c.rs", b"")]);
    for (i, name) in ["a.rs", "b.rs", "c.rs"].iter().enumerate() {
        set_mtime(dir.path(), name, 1_000 + i as u64);
    }
    let first = FindRequest {
        limit: 2,
        ..FindRequest::new(dir.path(), "*.rs")
    };
    assert_eq!(run(&first).paths, ["c.rs", "b.rs"]);
    let second = FindRequest { offset: 2, ..first };
    let res = run(&second);
    assert_eq!(
        (res.paths.as_slice(), res.total),
        (&["a.rs".to_string()][..], 3)
    );
}

#[test]
fn find_refuses_paths_outside_the_root_and_files() {
    let dir = tree(&[("a.rs", b"")]);
    let out = FindRequest {
        path: Some("../".into()),
        ..FindRequest::new(dir.path(), "*")
    };
    assert!(matches!(
        find_files(&out, &CancelToken::new()),
        Err(SearchError::Path(_))
    ));
    let file = FindRequest {
        path: Some("a.rs".into()),
        ..FindRequest::new(dir.path(), "*")
    };
    assert!(matches!(
        find_files(&file, &CancelToken::new()),
        Err(SearchError::Path(_))
    ));
}

use std::path::Path;
use std::process::Command;

use atlas_security::repo::{GitCli, Repo, RepoError};

fn git(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.com"])
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

fn repo_with_two_commits() -> (tempfile::TempDir, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    git(root, &["init", "-q"]);
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    git(root, &["add", "a.txt"]);
    git(root, &["commit", "-q", "-m", "first"]);
    let first = git(root, &["rev-parse", "HEAD"]);
    std::fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
    git(root, &["commit", "-q", "-am", "second"]);
    let second = git(root, &["rev-parse", "HEAD"]);
    (dir, first, second)
}

#[test]
fn root_commit_diff_works() {
    let (dir, first, _) = repo_with_two_commits();
    let repo = GitCli {
        root: dir.path().to_path_buf(),
    };
    let diff = String::from_utf8(repo.commit_diff(&first).unwrap()).unwrap();
    assert!(diff.contains("+++ b/a.txt"), "{diff}");
    assert!(diff.contains("+one"), "{diff}");
    assert_eq!(repo.parent(&first).unwrap(), None);
}

#[test]
fn second_commit_diff_and_parent() {
    let (dir, first, second) = repo_with_two_commits();
    let repo = GitCli {
        root: dir.path().to_path_buf(),
    };
    let diff = String::from_utf8(repo.commit_diff(&second).unwrap()).unwrap();
    assert!(diff.contains("+two"), "{diff}");
    assert!(!diff.contains("+one"), "{diff}");
    assert_eq!(repo.parent(&second).unwrap(), Some(first.clone()));
    assert_eq!(
        repo.file_at(&first, "a.txt").unwrap(),
        Some(b"one\n".to_vec())
    );
}

#[test]
fn missing_commit_is_missing_commit_error() {
    let (dir, _, _) = repo_with_two_commits();
    let repo = GitCli {
        root: dir.path().to_path_buf(),
    };
    let err = repo
        .commit_diff("0123456789abcdef0123456789abcdef01234567")
        .unwrap_err();
    assert!(matches!(err, RepoError::MissingCommit(_)), "{err:?}");
}

#[test]
fn file_at_missing_path_is_none() {
    let (dir, first, _) = repo_with_two_commits();
    let repo = GitCli {
        root: dir.path().to_path_buf(),
    };
    assert_eq!(repo.file_at(&first, "nope.txt").unwrap(), None);
}

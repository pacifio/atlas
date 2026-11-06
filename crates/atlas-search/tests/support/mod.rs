//! Temp project trees for the integration tests.
#![allow(dead_code)]

use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime};

use tempfile::TempDir;

/// A temp dir holding `files` (relative path, bytes). Not a git repo, so
/// `.gitignore` is not consulted (`require_git(true)`); see [`git_tree`].
pub fn tree(files: &[(&str, &[u8])]) -> TempDir {
    let dir = tempfile::tempdir().expect("temp dir");
    for (rel, body) in files {
        write(dir.path(), rel, body);
    }
    dir
}

/// [`tree`] inside a git repo (an empty `.git/` is enough for `ignore`).
pub fn git_tree(files: &[(&str, &[u8])]) -> TempDir {
    let dir = tree(files);
    fs::create_dir_all(dir.path().join(".git")).expect(".git");
    dir
}

pub fn write(root: &Path, rel: &str, body: &[u8]) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
    fs::write(&path, body).expect("write");
}

/// Set `rel`'s mtime to `secs` after the epoch, so ordering tests are exact.
pub fn set_mtime(root: &Path, rel: &str, secs: u64) {
    let file = fs::File::options()
        .write(true)
        .open(root.join(rel))
        .expect("open for mtime");
    file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(secs))
        .expect("set mtime");
}

pub fn rels(res: &atlas_search::GrepResult) -> Vec<&str> {
    res.files.iter().map(|f| f.rel.as_str()).collect()
}

/// [`rels`], sorted: for tests where newest-first order is not the point.
pub fn sorted_rels(res: &atlas_search::GrepResult) -> Vec<&str> {
    let mut out = rels(res);
    out.sort_unstable();
    out
}

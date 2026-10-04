//! Fixture repositories for the integration tests. Needs the `git` binary.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use atlas_grepindex::{BuildOutcome, GrepIndex, IndexOptions};
use atlas_search::{grep, CancelToken, CandidateSource, GrepRequest, GrepResult, OutputMode};

pub struct Repo {
    _dir: tempfile::TempDir,
    pub root: PathBuf,
}

impl Repo {
    pub fn new() -> Repo {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let repo = Repo { _dir: dir, root };
        repo.git(&["init", "-q"]);
        repo
    }

    pub fn git(&self, args: &[&str]) {
        let out = Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(&self.root)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    pub fn write(&self, rel: &str, content: impl AsRef<[u8]>) -> PathBuf {
        let path = self.root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, content).unwrap();
        path
    }

    pub fn commit_all(&self, msg: &str) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", msg]);
    }

    /// Moves every work-tree file's mtime a minute back, past the index's racy window, so the
    /// index may vouch for it (files written within the last 2 s are always searched).
    pub fn backdate(&self) {
        let old = SystemTime::now() - Duration::from_secs(60);
        for entry in walk(&self.root) {
            std::fs::File::options()
                .write(true)
                .open(&entry)
                .unwrap()
                .set_modified(old)
                .unwrap();
        }
    }

    /// A built, resynced index that indexes regardless of size.
    pub fn index(&self) -> Arc<GrepIndex> {
        let idx = GrepIndex::open(&self.root, IndexOptions::always()).unwrap();
        let outcome = idx.ensure_built(&CancelToken::new()).unwrap();
        assert!(matches!(
            outcome,
            BuildOutcome::Built | BuildOutcome::Loaded
        ));
        Arc::new(idx)
    }
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if entry.file_name() == ".git" || entry.file_name() == ".atlas" {
            continue;
        }
        if entry.file_type().unwrap().is_dir() {
            out.extend(walk(&path));
        } else if entry.file_type().unwrap().is_file() {
            out.push(path);
        }
    }
    out
}

pub fn request(root: &Path, pattern: &str, case_insensitive: Option<bool>) -> GrepRequest {
    GrepRequest {
        root: root.to_path_buf(),
        path: None,
        pattern: pattern.to_string(),
        globs: Vec::new(),
        file_type: None,
        mode: OutputMode::FilesWithMatches,
        case_insensitive,
        literal: false,
        word: false,
        multiline: false,
        before: 0,
        after: 0,
        limit: Some(1_000_000),
        offset: 0,
        include_ignored: false,
        deny_globs: Vec::new(),
        candidates: None,
    }
}

/// `(scan, indexed)` results for the same request.
pub fn both(idx: &Arc<GrepIndex>, req: &GrepRequest) -> (GrepResult, GrepResult) {
    let cancel = CancelToken::new();
    let scan = grep(req, &cancel).unwrap();
    let mut with = req.clone();
    with.candidates = Some(Arc::clone(idx) as Arc<dyn CandidateSource>);
    let indexed = grep(&with, &cancel).unwrap();
    (scan, indexed)
}

pub fn rels(res: &GrepResult) -> Vec<String> {
    let mut v: Vec<String> = res.files.iter().map(|f| f.rel.clone()).collect();
    v.sort();
    v
}

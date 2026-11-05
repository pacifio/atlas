//! Reading a commit from the repository.
//!
//! The scanner reads git objects only, never the working tree, so what it
//! judges is exactly what was committed. [`GitCli`] shells out to `git`; call
//! it from a blocking context. [`StaticRepo`] serves fixed bytes to the
//! harness and to tests.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Output};

use atlas_process::NoWindow;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RepoError {
    /// The commit is not in the repository (rewritten history, a gc'd object).
    MissingCommit(String),
    Git(String),
}

impl std::fmt::Display for RepoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingCommit(sha) => write!(f, "commit not found: {sha}"),
            Self::Git(msg) => write!(f, "git failed: {msg}"),
        }
    }
}

impl std::error::Error for RepoError {}

pub trait Repo {
    /// The commit's patch against its first parent (against nothing for a
    /// root commit).
    fn commit_diff(&self, sha: &str) -> Result<Vec<u8>, RepoError>;
    /// A file's bytes at `rev`; `None` when the path does not exist there.
    fn file_at(&self, rev: &str, path: &str) -> Result<Option<Vec<u8>>, RepoError>;
    /// The first parent; `None` for a root commit.
    fn parent(&self, sha: &str) -> Result<Option<String>, RepoError>;
}

/// The repository at `root`, read through the `git` CLI.
pub struct GitCli {
    pub root: PathBuf,
}

impl GitCli {
    fn run(&self, args: &[&str]) -> Result<Output, RepoError> {
        Command::new("git")
            .no_window()
            .arg("-C")
            .arg(&self.root)
            .args(["-c", "core.quotepath=off"])
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .output()
            .map_err(|e| RepoError::Git(e.to_string()))
    }

    fn commit_exists(&self, sha: &str) -> Result<bool, RepoError> {
        let spec = format!("{sha}^{{commit}}");
        Ok(self.run(&["cat-file", "-e", &spec])?.status.success())
    }

    /// The commits on `head` that `base` does not have (`git rev-list
    /// base..head`): a branch's own commits since it left its base. `None`
    /// when either ref is unknown here.
    pub fn commits_since(&self, base: &str, head: &str) -> Result<Option<Vec<String>>, RepoError> {
        let range = format!("{base}..{head}");
        let out = self.run(&["rev-list", &range, "--"])?;
        if !out.status.success() {
            return Ok(None);
        }
        Ok(Some(
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(str::to_string)
                .collect(),
        ))
    }

    fn require_commit(&self, sha: &str) -> Result<(), RepoError> {
        if self.commit_exists(sha)? {
            Ok(())
        } else {
            Err(RepoError::MissingCommit(sha.to_string()))
        }
    }
}

impl Repo for GitCli {
    fn commit_diff(&self, sha: &str) -> Result<Vec<u8>, RepoError> {
        self.require_commit(sha)?;
        let out = self.run(&[
            "diff-tree",
            "-p",
            "-M",
            "-r",
            "-U3",
            "--root",
            "--no-commit-id",
            "--no-color",
            "--no-ext-diff",
            sha,
        ])?;
        if !out.status.success() {
            return Err(RepoError::Git(
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            ));
        }
        Ok(out.stdout)
    }

    fn file_at(&self, rev: &str, path: &str) -> Result<Option<Vec<u8>>, RepoError> {
        let spec = format!("{rev}:{path}");
        if !self.run(&["cat-file", "-e", &spec])?.status.success() {
            return Ok(None);
        }
        let out = self.run(&["cat-file", "blob", &spec])?;
        if !out.status.success() {
            return Err(RepoError::Git(
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            ));
        }
        Ok(Some(out.stdout))
    }

    fn parent(&self, sha: &str) -> Result<Option<String>, RepoError> {
        self.require_commit(sha)?;
        let spec = format!("{sha}^1");
        let out = self.run(&["rev-parse", "--verify", "--quiet", &spec])?;
        if !out.status.success() {
            return Ok(None);
        }
        Ok(Some(
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
        ))
    }
}

/// Fixed bytes: one diff for every sha, files keyed by `(rev, path)`.
#[derive(Debug, Clone, Default)]
pub struct StaticRepo {
    pub diff: Vec<u8>,
    pub files: HashMap<(String, String), Vec<u8>>,
    pub parent: Option<String>,
}

impl Repo for StaticRepo {
    fn commit_diff(&self, _sha: &str) -> Result<Vec<u8>, RepoError> {
        Ok(self.diff.clone())
    }

    fn file_at(&self, rev: &str, path: &str) -> Result<Option<Vec<u8>>, RepoError> {
        Ok(self
            .files
            .get(&(rev.to_string(), path.to_string()))
            .cloned())
    }

    fn parent(&self, _sha: &str) -> Result<Option<String>, RepoError> {
        Ok(self.parent.clone())
    }
}

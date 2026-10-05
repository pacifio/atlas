//! Runs on the desktop (ADR-0022, ATL-405): a participant's own agent works in
//! a **Run worktree** of its own, never in the replica people type in, and its
//! result is merged back into canonical state when the turn ends.
//!
//! The Run worktree is stable per participant Session — one directory reused
//! Run after Run, so the agent's session `cwd` never changes — and is reset to
//! canonical state at the fork `seq` when each Run starts. Ignored directories
//! survive the reset, so dependencies and build output stay warm.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::git;
use crate::replica::{looks_textual, write_atomic, ForkFile, ReplicaError};
use crate::secrets::secret_reason;

/// What a Run says about itself when it starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunSpec {
    /// Chosen by the Runner, so a resent `run.start` is recognised. 8–64 of
    /// `[A-Za-z0-9_-]`; [`RunSpec::new_id`] makes one.
    pub run_id: String,
    pub agent: String,
    pub model: String,
    /// A timeline event to "continue from here".
    pub context_anchor: Option<String>,
    /// The approved Remote Run this Run executes (ATL-417).
    pub remote_request_id: Option<String>,
}

impl RunSpec {
    pub fn new_id() -> String {
        format!("run-{}", uuid::Uuid::new_v4().simple())
    }
}

/// Canonical state as a Run forked it.
#[derive(Debug, Clone)]
pub struct Fork {
    /// The thread's `seq` the Run forked at.
    pub seq: u64,
    pub files: BTreeMap<u64, ForkFile>,
    /// Paths the Base has and canonical state does not: deleted files, and
    /// where renamed ones used to be (ATL-403).
    pub removed: Vec<String>,
    /// The thread's binary files at the fork (ATL-410): a Run that changes
    /// one either lands it whole or, if somebody changed it since, raises a
    /// whole-file Conflict.
    pub binaries: BTreeMap<u64, ForkBinary>,
}

/// One binary file as a Run forked it.
#[derive(Debug, Clone)]
pub struct ForkBinary {
    pub path: String,
    /// Its canonical blob at the fork; `None` when it holds its Base content.
    pub blob: Option<String>,
    /// The canonical bytes, written into the Run worktree when this machine
    /// has them; otherwise the worktree keeps the Base's.
    pub bytes: Option<Vec<u8>>,
    /// The hash of what the worktree holds for it after the reset: what the
    /// Run's result is compared with. `None` when nothing is there.
    pub start: Option<String>,
}

/// A Run this replica started and has not finished.
#[derive(Debug, Clone)]
pub struct ActiveRun {
    pub run_id: String,
    /// The thread-local number live Run frames carry.
    pub run_no: u64,
    pub fork: Fork,
    pub worktree: PathBuf,
}

/// One participant's Run worktree: a detached worktree of their repository at
/// the thread's Base, reset to the fork at each Run start.
pub struct RunWorktree {
    repo: PathBuf,
    base: String,
    root: PathBuf,
}

impl RunWorktree {
    pub fn new(repo: &Path, base: &str, root: &Path) -> Self {
        Self {
            repo: repo.to_path_buf(),
            base: base.to_string(),
            root: root.to_path_buf(),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Make the worktree hold exactly the fork: the Base, with every file the
    /// thread has touched at its canonical text. Created on first use; after
    /// that tracked changes are reset and untracked files removed, but
    /// ignored ones are kept.
    pub fn reset(&self, fork: &Fork) -> Result<(), ReplicaError> {
        if self.root.join(".git").exists() {
            git::reset_worktree(&self.root, &self.base)?;
        } else {
            if let Some(parent) = self.root.parent() {
                fs::create_dir_all(parent).map_err(|source| ReplicaError::Io {
                    path: parent.to_path_buf(),
                    source,
                })?;
            }
            git::add_worktree(&self.repo, &self.root, &self.base)?;
        }
        for rel in &fork.removed {
            let target = crate::path::resolve(&self.root, rel)?;
            match fs::remove_file(&target) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(source) => {
                    return Err(ReplicaError::Io {
                        path: target,
                        source,
                    })
                }
            }
        }
        for file in fork.files.values() {
            let target = crate::path::resolve(&self.root, &file.path)?;
            write_atomic(&target, file.content.as_bytes())?;
        }
        for file in fork.binaries.values() {
            if let Some(bytes) = &file.bytes {
                let target = crate::path::resolve(&self.root, &file.path)?;
                write_atomic(&target, bytes)?;
            }
        }
        Ok(())
    }

    /// What the Run left in the worktree: every text file that differs from
    /// the fork — a file the thread holds whose text changed, or a new text
    /// file — with its content, and every binary file whose bytes changed
    /// (ATL-410). Deletions are not a Run's to make; files that look like
    /// secrets stay on this machine, as at share time.
    pub fn changes(&self, fork: &Fork) -> Result<Vec<RunChange>, ReplicaError> {
        let mut out = Vec::new();
        let tracked: BTreeMap<&str, (u64, &ForkFile)> = fork
            .files
            .iter()
            .map(|(id, f)| (f.path.as_str(), (*id, f)))
            .collect();
        let binaries: BTreeMap<&str, (u64, &ForkBinary)> = fork
            .binaries
            .iter()
            .map(|(id, f)| (f.path.as_str(), (*id, f)))
            .collect();
        let mut seen = std::collections::BTreeSet::new();
        // Anything git sees as changed against the Base, plus every file the
        // thread holds (its fork text already differs from the Base).
        // A removed path the Run left alone shows as deleted and is skipped;
        // one it wrote again comes back into the thread.
        let mut candidates: Vec<String> = git::dirty_paths(&self.root)?
            .into_iter()
            .filter(|d| !d.deleted)
            .map(|d| d.path)
            .collect();
        candidates.extend(tracked.keys().map(|p| (*p).to_string()));
        candidates.extend(binaries.keys().map(|p| (*p).to_string()));
        for path in candidates {
            if !seen.insert(path.clone()) || !crate::path::is_valid(&path) {
                continue;
            }
            let Ok(target) = crate::path::resolve(&self.root, &path) else {
                continue;
            };
            let Ok(bytes) = fs::read(&target) else {
                continue;
            };
            if let Some((file_id, f)) = binaries.get(path.as_str()) {
                if f.start.as_deref() != Some(crate::bootstrap::sha256_hex(&bytes).as_str()) {
                    out.push(RunChange::binary(Some(*file_id), path, bytes));
                }
                continue;
            }
            if !looks_textual(&bytes) {
                // A new binary file. One the thread holds as text and the
                // Run turned binary does not sync, as for a person's save.
                if !tracked.contains_key(path.as_str()) && secret_reason(&path, "").is_none() {
                    out.push(RunChange::binary(None, path, bytes));
                }
                continue;
            }
            let content = String::from_utf8_lossy(&bytes).into_owned();
            match tracked.get(path.as_str()) {
                Some((file_id, f)) => {
                    if f.content != content {
                        out.push(RunChange {
                            file_id: Some(*file_id),
                            path,
                            content,
                            binary: None,
                        });
                    }
                }
                None => {
                    if secret_reason(&path, &content).is_some() {
                        tracing::info!(target: "atlas_thread_sync", %path, "a Run's new file looks secret; kept on this machine");
                        continue;
                    }
                    out.push(RunChange {
                        file_id: None,
                        path,
                        content,
                        binary: None,
                    });
                }
            }
        }
        Ok(out)
    }
}

/// One file a Run changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunChange {
    /// `None` for a file the thread did not hold at the fork.
    pub file_id: Option<u64>,
    pub path: String,
    /// A text file's content; empty for a binary one.
    pub content: String,
    /// A binary file's bytes (ATL-410).
    pub binary: Option<Vec<u8>>,
}

impl RunChange {
    fn binary(file_id: Option<u64>, path: String, bytes: Vec<u8>) -> Self {
        Self {
            file_id,
            path,
            content: String::new(),
            binary: Some(bytes),
        }
    }
}

/// What finishing a Run did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunReport {
    /// The Thread Version its merge created; `None` when it changed nothing.
    pub version: Option<u64>,
    /// The files it merged.
    pub files: Vec<String>,
    /// How many times the merge was rejected and recomputed.
    pub retries: u32,
    /// Blobs that could not be uploaded for the Thread Version. The merge
    /// stands; the Version's content is missing until they are.
    pub unuploaded: Vec<String>,
    /// Conflicts the merge raised (ATL-410): hunks that overlapped changes
    /// made since the Run forked, held for somebody to resolve. The rest of
    /// the Run landed.
    pub conflicts: Vec<u64>,
}

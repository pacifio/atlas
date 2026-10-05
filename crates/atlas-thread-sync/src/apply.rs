//! Apply (ATL-408): how work leaves a Shared Thread. The thread's changes
//! since the Base are written into the person's own checkout as uncommitted
//! changes, three-way onto whatever commit it is at; they commit and push
//! their usual way. Atlas never touches a git remote, and never the person's
//! branches, index or commits.
//!
//! Per file, against the Base:
//! - the checkout left it as the Base had it → the thread's version is written;
//! - the checkout's commit changed it too → `git merge-file` merges the two,
//!   leaving standard conflict markers where they overlap;
//! - the person has **uncommitted** edits to it → the whole Apply is refused
//!   with the files listed, unless they asked to stash those first. Their
//!   work is never overwritten.

use std::fs;
use std::path::{Path, PathBuf};

use crate::git::{self, GitError};
use crate::path::{self, PathError};
use crate::replica::{write_atomic, ReplicaError};

/// One file the thread changed, as canonical state holds it now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadChange {
    /// Where it is in the thread now.
    pub path: String,
    /// Where it was in the Base, when it moved there from elsewhere.
    pub origin: Option<String>,
    /// Its content now; `None` when the thread deleted it.
    pub content: Option<Vec<u8>>,
}

/// What Apply did.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    /// Files written, created or deleted cleanly.
    pub files: Vec<String>,
    /// Files left with conflict markers, or kept as the checkout had them
    /// where a merge is impossible (a binary file, a delete against an edit).
    pub conflicted: Vec<String>,
    /// For a binary conflict, where the thread's version was put beside it.
    pub beside: Vec<String>,
    /// The message the person's own edits were stashed under, if they were.
    pub stashed: Option<String>,
    /// Ignored files of the person's that were in the way — git cannot
    /// stash them by path — moved under the repository's git directory
    /// (`.git/atlas-set-aside/<time>/<path>`), where nothing is committed
    /// from. Absolute paths.
    pub set_aside: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ApplyError {
    /// Uncommitted edits in the checkout touch files the thread changed.
    /// Nothing was written; [`apply`] with `stash` set moves them aside first.
    #[error("you have uncommitted changes to files this thread changed: {}", .0.join(", "))]
    Dirty(Vec<String>),
    /// The checkout's repository does not hold the thread's Base commit.
    #[error("this repository does not have the thread's starting commit {0}; fetch or pull first")]
    BaseMissing(String),
    #[error(transparent)]
    Git(#[from] GitError),
    #[error(transparent)]
    Path(#[from] PathError),
    #[error(transparent)]
    Replica(#[from] ReplicaError),
    #[error("could not write {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// What asking to Apply came to: done, or refused with what to do about it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum ApplyOutcome {
    Applied(Applied),
    /// Uncommitted edits touch these files; stash-and-apply moves them aside.
    Dirty {
        files: Vec<String>,
    },
    /// Conflicts are open in the thread: resolve them first.
    ConflictsOpen {
        count: usize,
    },
}

/// Suffix of the file a binary conflict leaves the thread's version in.
pub const THREAD_COPY: &str = ".atlas-thread";

/// Write `changes` — the thread's state of every file it touched — into
/// `checkout`, three-way against `base`. With `stash`, uncommitted edits to
/// those files are stashed first (and only those); without it they refuse
/// the Apply.
///
/// Everything is decided before anything is written: every target path is
/// checked (no symlinks, nothing outside the checkout), and every file Apply
/// would write or remove must hold what the checkout's commit has there — so
/// an ignored or untracked file of the person's, which `git status` does not
/// show, is never overwritten either. A refusal writes nothing.
pub fn apply(
    checkout: &Path,
    base: &str,
    changes: &[ThreadChange],
    stash: Option<&str>,
) -> Result<Applied, ApplyError> {
    if !git::has_commit(checkout, base) {
        return Err(ApplyError::BaseMissing(base.to_string()));
    }
    let head = git::head_commit(checkout)?;
    // Only what the thread changed since the Base: a file it holds unchanged
    // (touched, then put back) is nothing to apply — and an edit of the
    // person's to it is nothing in the way.
    let mut kept = Vec::new();
    for c in changes {
        if !path::is_valid(&c.path) || !c.origin.as_deref().is_none_or(path::is_valid) {
            continue;
        }
        let moved = c.origin.as_deref().is_some_and(|o| o != c.path);
        if !moved && c.content == git::blob_at(checkout, base, &c.path)? {
            continue;
        }
        kept.push(c);
    }
    let changes = kept;

    // Every path Apply may write: where files are now, and where moved ones were.
    let mut touched: Vec<String> = changes
        .iter()
        .flat_map(|c| std::iter::once(c.path.clone()).chain(c.origin.clone()))
        .collect();
    touched.sort();
    touched.dedup();
    // The person's work in the way: what git sees as changed, and any file on
    // disk that differs from the commit — ignored ones included. A file
    // already as Apply would leave it (an earlier Apply of the same state)
    // is not in the way.
    let mut dirty = git::dirty_among(checkout, &touched)?;
    for rel in &touched {
        if on_disk(checkout, rel)? != git::blob_at(checkout, &head, rel)? {
            dirty.push(rel.clone());
        }
    }
    dirty.sort();
    dirty.dedup();
    let mut kept_dirty = Vec::new();
    for rel in dirty {
        if !already_applied(checkout, &rel, &changes)? {
            kept_dirty.push(rel);
        }
    }
    let mut applied = Applied::default();
    if !kept_dirty.is_empty() {
        match stash {
            None => return Err(ApplyError::Dirty(kept_dirty)),
            Some(message) => {
                // What git sees goes into a stash; git does not stash an
                // ignored file by path, so those are moved into the
                // repository's git directory instead — never overwritten, and
                // never beside themselves, where a name like `.env.atlas-mine`
                // would escape the ignore rule that kept `.env` out of commits.
                let visible: Vec<String> = git::dirty_among(checkout, &kept_dirty)?;
                if !visible.is_empty() {
                    git::stash_paths(checkout, &visible, message)?;
                    applied.stashed = Some(message.to_string());
                }
                let aside_root = git::git_path(checkout, "atlas-set-aside")?.join(
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_or(0, |d| d.as_millis())
                        .to_string(),
                );
                for rel in &kept_dirty {
                    if on_disk(checkout, rel)? == git::blob_at(checkout, &head, rel)? {
                        continue;
                    }
                    let to = aside_root.join(rel);
                    if let Some(dir) = to.parent() {
                        fs::create_dir_all(dir).map_err(|source| ApplyError::Io {
                            path: dir.to_path_buf(),
                            source,
                        })?;
                    }
                    fs::rename(path::resolve(checkout, rel)?, &to).map_err(|source| {
                        ApplyError::Io {
                            path: checkout.join(rel),
                            source,
                        }
                    })?;
                    applied.set_aside.push(to.to_string_lossy().into_owned());
                }
                // Anything still in the way stops Apply before it writes.
                let mut left = Vec::new();
                for rel in kept_dirty {
                    if on_disk(checkout, &rel)? != git::blob_at(checkout, &head, &rel)? {
                        left.push(rel);
                    }
                }
                if !left.is_empty() {
                    return Err(ApplyError::Dirty(left));
                }
            }
        }
    }

    // Plan.
    let mut writes: Vec<(String, Option<Vec<u8>>)> = Vec::new();
    let now_at: std::collections::BTreeSet<&str> =
        changes.iter().map(|c| c.path.as_str()).collect();
    for change in &changes {
        // A file moved in the thread leaves its old place, if the checkout
        // still has it as the Base did — and no file of the thread is there now.
        if let Some(origin) = change.origin.as_deref().filter(|o| *o != change.path) {
            if !now_at.contains(origin) {
                let base_old = git::blob_at(checkout, base, origin)?;
                let head_old = git::blob_at(checkout, &head, origin)?;
                if base_old.is_some() && head_old == base_old {
                    writes.push((origin.to_string(), None));
                    applied.files.push(origin.to_string());
                } else if head_old.is_some() {
                    // Changed in the checkout since, and moved in the thread.
                    applied.conflicted.push(origin.to_string());
                }
            }
        }
        // What the Base had at this path decides who changed it; a moved
        // file's content merges against what the Base had where it came from.
        let base_here = git::blob_at(checkout, base, &change.path)?;
        let from = change.origin.as_deref().unwrap_or(&change.path);
        let merge_base = git::blob_at(checkout, base, from)?;
        let head_bytes = git::blob_at(checkout, &head, &change.path)?;
        let theirs = change.content.as_ref();

        if head_bytes.as_ref() == theirs {
            continue; // Already so.
        }
        if head_bytes == base_here {
            writes.push((change.path.clone(), theirs.cloned()));
            applied.files.push(change.path.clone());
            continue;
        }
        if theirs == base_here.as_ref() {
            continue; // The thread left this path as the Base had it.
        }
        // Both changed it since the Base.
        match (&head_bytes, theirs) {
            (Some(ours), Some(theirs)) if is_text(ours) && is_text(theirs) => {
                let base_text = merge_base.clone().unwrap_or_default();
                let (merged, conflicts) = git::merge_file(
                    checkout,
                    ours,
                    &base_text,
                    theirs,
                    ["yours", "base", "shared thread"],
                )?;
                writes.push((change.path.clone(), Some(merged)));
                if conflicts {
                    applied.conflicted.push(change.path.clone());
                } else {
                    applied.files.push(change.path.clone());
                }
            }
            (Some(_), Some(theirs)) => {
                // Binary: no markers to leave. Yours stays; the thread's goes
                // beside it, under a name nothing of the person's holds.
                if let Some(beside) = beside_name(checkout, &change.path, theirs)? {
                    writes.push((beside.clone(), Some(theirs.clone())));
                    applied.beside.push(beside);
                }
                applied.conflicted.push(change.path.clone());
            }
            (None, Some(theirs)) => {
                // Gone from the checkout, changed in the thread: the thread's
                // version comes back for the person to decide.
                writes.push((change.path.clone(), Some(theirs.clone())));
                applied.conflicted.push(change.path.clone());
            }
            (Some(_), None) => {
                // Changed in the checkout, deleted in the thread: theirs stays.
                applied.conflicted.push(change.path.clone());
            }
            (None, None) => {}
        }
    }
    // Every target is checked before the first write.
    for (rel, _) in &writes {
        path::resolve(checkout, rel)?;
    }

    // Write.
    for (rel, bytes) in &writes {
        match bytes {
            Some(bytes) => write(checkout, rel, bytes)?,
            None => remove(checkout, rel)?,
        }
    }
    applied.files.sort();
    applied.files.dedup();
    applied.conflicted.sort();
    applied.conflicted.dedup();
    Ok(applied)
}

/// A file's bytes in the checkout now; `None` when there is none. A path
/// through a symlink, or anything else `resolve` refuses, is an error.
fn on_disk(checkout: &Path, rel: &str) -> Result<Option<Vec<u8>>, ApplyError> {
    let target = path::resolve(checkout, rel)?;
    match fs::read(&target) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(ApplyError::Io {
            path: target,
            source,
        }),
    }
}

/// Where a binary file's thread version goes beside it: `<path>.atlas-thread`,
/// or the first `<path>.atlas-thread-N` nothing of the person's holds. `None`
/// when one already holds exactly these bytes (an earlier Apply).
fn beside_name(checkout: &Path, rel: &str, bytes: &[u8]) -> Result<Option<String>, ApplyError> {
    for n in 1..=100 {
        let name = if n == 1 {
            format!("{rel}{THREAD_COPY}")
        } else {
            format!("{rel}{THREAD_COPY}-{n}")
        };
        if !path::is_valid(&name) {
            return Ok(None);
        }
        match on_disk(checkout, &name)? {
            None => return Ok(Some(name)),
            Some(existing) if existing == bytes => return Ok(None),
            Some(_) => {}
        }
    }
    Ok(None)
}

/// Does `rel` in the checkout already hold what the thread has there — the
/// thread's content, or nothing where the thread removed or moved it away?
fn already_applied(
    checkout: &Path,
    rel: &str,
    changes: &[&ThreadChange],
) -> Result<bool, ApplyError> {
    let disk = on_disk(checkout, rel)?;
    if let Some(change) = changes.iter().find(|c| c.path == rel) {
        return Ok(disk == change.content);
    }
    // Only a move's old place: applied once it is gone.
    Ok(disk.is_none())
}

/// Text, for merging: no NUL in the first 8 KiB, as git decides.
fn is_text(bytes: &[u8]) -> bool {
    !bytes.iter().take(8000).any(|b| *b == 0)
}

fn write(root: &Path, rel: &str, bytes: &[u8]) -> Result<(), ApplyError> {
    let target = path::resolve(root, rel)?;
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir).map_err(|source| ApplyError::Io {
            path: dir.to_path_buf(),
            source,
        })?;
    }
    Ok(write_atomic(&target, bytes)?)
}

fn remove(root: &Path, rel: &str) -> Result<(), ApplyError> {
    let target = path::resolve(root, rel)?;
    match fs::remove_file(&target) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(ApplyError::Io {
            path: target,
            source,
        }),
    }
}

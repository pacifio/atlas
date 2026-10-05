//! One participant's copy of a Shared Thread's canonical state.
//!
//! A replica is a **detached git worktree at the Base**, created out of the way
//! of the person's own checkout, plus one [`FileDoc`] per file the thread has
//! touched. It is created lazily: joining only builds the documents in memory,
//! and nothing is checked out until the person first opens a file or prompts
//! ([`Replica::materialize`]) — watching a thread is free.
//!
//! Two rules keep disk and documents honest with each other:
//!
//! * **Remote writes are atomic** — a temporary file in the same directory,
//!   then a rename — so an editor or a build never reads half a file.
//! * **A remote write is never echoed back.** The hash of what this replica
//!   last wrote (or last read) is kept per file; a watcher event for a file
//!   whose bytes still hash the same is our own write, and produces nothing.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::doc::{random_client_id, FileDoc};
use crate::git;
use crate::path;
use crate::secrets::secret_reason;
use crate::wire::{FileKind, TreeEntry};

/// Prefix of the temporary files atomic writes go through. The watcher and
/// [`path::relative`] ignore anything named like this.
pub const TEMP_PREFIX: &str = ".atlas-sync-tmp-";

/// Marks a file of the person's that a remote change moved out of its way
/// (`notes.md.atlas-mine`). Such a file is theirs alone: it never syncs, and
/// [`path::relative`] ignores it, across restarts too.
pub const ASIDE_MARK: &str = ".atlas-mine";

/// Is this a file a remote change set aside?
pub fn is_set_aside(rel: &str) -> bool {
    rel.rsplit('/')
        .next()
        .is_some_and(|name| name.contains(ASIDE_MARK))
}

/// Files at or above this size are not co-edited as text: they sync whole, as
/// blobs (ATL-403).
pub const MAX_TEXT_BYTES: usize = 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum ReplicaError {
    #[error(transparent)]
    Git(#[from] git::GitError),
    #[error(transparent)]
    Path(#[from] path::PathError),
    #[error(transparent)]
    Doc(#[from] crate::doc::DocError),
    #[error("i/o on {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("this repository does not have the thread's Base commit {0}")]
    BaseMissing(String),
    #[error("{0:?} is not a commit id")]
    BadBase(String),
    #[error("no file {0} in this thread")]
    UnknownFile(u64),
    #[error("{0} did not hash to the blob it was fetched as")]
    CorruptBlob(String),
    #[error("{path} is already file {holder} in this replica")]
    PathTaken { path: String, holder: u64 },
}

fn io(path: &Path) -> impl FnOnce(std::io::Error) -> ReplicaError + '_ {
    move |source| ReplicaError::Io {
        path: path.to_path_buf(),
        source,
    }
}

type Hash = [u8; 32];

fn hash(bytes: &[u8]) -> Hash {
    Sha256::digest(bytes).into()
}

fn hex(hash: &Hash) -> String {
    hash.iter().map(|b| format!("{b:02x}")).collect()
}

/// How `bytes` sync: as co-edited text, or whole (ATL-403).
pub fn kind_of(bytes: &[u8]) -> FileKind {
    if looks_textual(bytes) {
        FileKind::Text
    } else {
        FileKind::Binary
    }
}

/// Git's own heuristic: a NUL in the first 8000 bytes means binary.
pub fn looks_textual(bytes: &[u8]) -> bool {
    bytes.len() < MAX_TEXT_BYTES
        && !bytes.iter().take(8000).any(|b| *b == 0)
        && std::str::from_utf8(bytes).is_ok()
}

struct TrackedFile {
    path: String,
    kind: FileKind,
    /// The text, for a text file; unused for a binary one.
    doc: FileDoc,
    /// What this replica last wrote to, or read from, disk for this file.
    /// `None` until the worktree exists.
    disk: Option<Hash>,
    /// Set while the file on disk holds something that looks like a secret:
    /// the document as it was at that moment. Nothing from disk is sent and
    /// nothing is written to disk until the secret is gone; then the person's
    /// edit is made relative to this snapshot and merged, so changes the
    /// thread took meanwhile survive.
    held: Option<Vec<u8>>,
    /// Held because this replica may not change the thread (a viewer, a
    /// closed thread) rather than because of a secret (ATL-406).
    held_read_only: bool,
    /// A text file whose bytes on disk are no longer text — past 1 MiB, or
    /// binary — so its saves do not sync (a file's kind is fixed when it
    /// enters the thread). Said in the status rather than dropped quietly.
    outgrown: bool,
    /// A binary file's canonical content: the hex SHA-256 of its blob.
    blob: Option<String>,
    /// Deleted in the thread. The entry and document stay, so a revival
    /// brings the same file back.
    deleted: bool,
    /// The path it entered the thread under; a checkout at the Base still
    /// holds the file there after a rename.
    origin: String,
}

/// What a save on disk amounts to.
#[derive(Debug, PartialEq, Eq)]
pub enum LocalChange {
    /// The bytes are what this replica wrote: our own echo. Nothing to send.
    Echo,
    /// An edit to a file the thread already holds: send these updates, in
    /// order (more than one only for an edit too large for one frame).
    Update { file_id: u64, updates: Vec<Vec<u8>> },
    /// A file the thread does not hold yet: it needs a tree entry first.
    NewFile { path: String },
    /// A binary file's bytes changed: upload them, then set the blob.
    Blob {
        file_id: u64,
        sha256: String,
        bytes: Vec<u8>,
    },
    /// A file the thread holds is gone from disk. A deletion — unless the
    /// same bytes turn up at a new path, which makes it a rename.
    Missing { file_id: u64 },
    /// The same bytes as a file that went missing, at a new path: a rename.
    Renamed {
        file_id: u64,
        from: String,
        to: String,
    },
    /// Not something that syncs (a file that turned binary or grew past the
    /// text limit, or the worktree does not exist yet).
    Ignored,
    /// Saved while the socket is down: read and sent when it is back.
    Buffered,
}

/// What the Atlas editor's edit came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditorEdit {
    /// Applied; these updates (a save from another editor) go out first.
    Applied(Vec<Vec<u8>>),
    /// Not applied, and why. A save from another editor read on the way
    /// still goes out: `pending`.
    Refused { why: String, pending: Vec<Vec<u8>> },
}

/// One file of the thread, for Apply.
#[derive(Debug, Clone)]
pub struct ThreadFile {
    pub path: String,
    /// The path it entered the thread under.
    pub origin: String,
    pub deleted: bool,
    pub kind: FileKind,
    /// A live text file's content.
    pub text: Option<String>,
    /// A binary file's blob; `None` while it holds its Base content.
    pub blob: Option<String>,
}

/// One tracked file as a Run forked it.
#[derive(Debug, Clone)]
pub struct ForkFile {
    pub path: String,
    pub snapshot: Vec<u8>,
    pub content: String,
}

/// A file's work the thread may not have, kept across a rebuild.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsyncedWork {
    pub path: String,
    /// The text the replica held for it: what the work was made against.
    pub before: String,
    /// The person's bytes now.
    pub content: String,
}

/// What a remote change moved out of the way so it would not overwrite the
/// person's own file: where the file was, and where it is now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetAside {
    pub path: String,
    pub moved_to: String,
}

pub struct Replica {
    /// The repository the worktree comes from: the person's own, or the
    /// thread repository a bundle was fetched into (ATL-402). `None` while
    /// this machine lacks the Base — the replica can then only watch.
    repo: Option<PathBuf>,
    base: String,
    root: PathBuf,
    client_id: u64,
    materialized: bool,
    files: BTreeMap<u64, TrackedFile>,
    by_path: HashMap<String, u64>,
    /// Files of the person's that remote changes moved aside.
    set_aside: Vec<SetAside>,
    /// Rebuilding from the thread (ATL-404): remote changes go into the
    /// documents only, and disk gets canonical state once at the end.
    rebuilding: bool,
    /// What this replica last knew of each path's bytes before a rebuild, so
    /// its own (drifted) bytes are replaced rather than set aside as the
    /// person's.
    known_before: HashMap<String, Hash>,
    /// The person may not change the thread right now (ATL-406): their saves
    /// are held on this machine, and merged in once they may.
    read_only: bool,
}

impl Replica {
    /// A replica of a thread whose Base is `base`, backed by the person's own
    /// repository at `repo`, to be checked out at `root` when first needed.
    ///
    /// Refuses when the repository lacks the Base: see
    /// [`Replica::without_base`] and [`crate::bootstrap`].
    pub fn new(repo: &Path, base: &str, root: &Path) -> Result<Self, ReplicaError> {
        let mut replica = Self::without_base(base, root)?;
        replica.attach_repo(repo)?;
        Ok(replica)
    }

    /// A replica on a machine that does not have the Base yet. It follows the
    /// thread — every file rebuilt from the journal alone, since the replica
    /// that introduces a file also publishes its Base seed — but cannot be
    /// checked out, and so cannot edit, until [`Replica::attach_repo`].
    pub fn without_base(base: &str, root: &Path) -> Result<Self, ReplicaError> {
        if !git::is_commit_sha(base) {
            return Err(ReplicaError::BadBase(base.to_string()));
        }
        Ok(Self {
            repo: None,
            base: base.to_string(),
            root: root.to_path_buf(),
            client_id: random_client_id(),
            materialized: false,
            files: BTreeMap::new(),
            by_path: HashMap::new(),
            set_aside: Vec::new(),
            rebuilding: false,
            known_before: HashMap::new(),
            read_only: false,
        })
    }

    /// Whether the person may change the thread from this replica. While they
    /// may not, a save is held like a secret is — kept on disk, never sent —
    /// and the next save once they may merges it with what the thread did
    /// meanwhile.
    pub fn set_read_only(&mut self, read_only: bool) {
        self.read_only = read_only;
    }

    /// Text files whose saves stopped syncing because they are no longer text
    /// (past 1 MiB, or binary).
    pub fn outgrown_files(&self) -> Vec<String> {
        self.files
            .values()
            .filter(|f| f.outgrown && !f.deleted)
            .map(|f| f.path.clone())
            .collect()
    }

    /// Files with saves held because this replica may not change the thread.
    pub fn unsent_files(&self) -> Vec<String> {
        self.files
            .values()
            .filter(|f| f.held.is_some() && f.held_read_only && !f.deleted)
            .map(|f| f.path.clone())
            .collect()
    }

    /// Forget every document, to build them again from the thread: this
    /// replica's state can no longer be trusted (ATL-404).
    pub fn begin_rebuild(&mut self) {
        self.known_before = self
            .files
            .values()
            .filter_map(|f| f.disk.map(|d| (f.path.clone(), d)))
            .collect();
        self.files.clear();
        self.by_path.clear();
        self.rebuilding = true;
    }

    /// The rebuild is done: write canonical state over the worktree — except
    /// at `keep`, where the person's own bytes stay, to be read as a save.
    /// Anywhere else the replica's bytes lose: they are what drifted.
    pub fn finish_rebuild(
        &mut self,
        keep: &std::collections::HashSet<String>,
    ) -> Result<(), ReplicaError> {
        self.rebuilding = false;
        if !self.materialized {
            return Ok(());
        }
        for rel in self.removed_paths() {
            self.remove_on_disk(&rel)?;
        }
        let ids: Vec<u64> = self
            .files
            .iter()
            .filter(|(_, f)| !f.deleted && f.kind == FileKind::Text)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            let file = self.files.get_mut(&id).expect("listed");
            if keep.contains(&file.path) {
                // Unknown, so the next read takes disk as the person's edit.
                file.disk = None;
                continue;
            }
            self.sync_disk(id)?;
        }
        Ok(())
    }

    /// Text files carrying work of the person's the thread may not have:
    /// whose bytes on disk are not what this replica last read or wrote, or
    /// that have edits on their way (`in_flight`). Each with the text the
    /// replica held for it — what that work was made against.
    ///
    /// With `everything`, every text file counts: after the thread lost
    /// history, this replica's text is the only copy of it.
    pub fn unsynced_work(
        &self,
        in_flight: &std::collections::HashSet<u64>,
        everything: bool,
    ) -> Vec<UnsyncedWork> {
        if !self.materialized {
            return Vec::new();
        }
        let mut out = Vec::new();
        for (id, f) in &self.files {
            if f.deleted || f.kind != FileKind::Text {
                continue;
            }
            let Ok(target) = path::resolve(&self.root, &f.path) else {
                continue;
            };
            let Ok(bytes) = fs::read(&target) else {
                continue;
            };
            let unread = f.disk != Some(hash(&bytes));
            if (everything || unread || in_flight.contains(id) || f.held.is_some())
                && looks_textual(&bytes)
            {
                out.push(UnsyncedWork {
                    path: f.path.clone(),
                    before: f.doc.content(),
                    content: String::from_utf8_lossy(&bytes).into_owned(),
                });
            }
        }
        out
    }

    /// Keep a copy of the person's `bytes` for `rel` beside it, under a name
    /// that never syncs. Answers that name.
    pub fn keep_copy(&mut self, rel: &str, bytes: &[u8]) -> Result<String, ReplicaError> {
        let mut n = 0;
        let name = loop {
            let candidate = if n == 0 {
                format!("{rel}{ASIDE_MARK}")
            } else {
                format!("{rel}{ASIDE_MARK}-{n}")
            };
            if !path::resolve(&self.root, &candidate)?.exists() {
                break candidate;
            }
            n += 1;
        };
        let target = path::resolve(&self.root, &name)?;
        // The copy is as private as the file it came from — a 0600 file stays
        // 0600 — and owner-only when that is gone. Set before it appears.
        let like = path::resolve(&self.root, rel)
            .ok()
            .and_then(|original| fs::metadata(original).ok())
            .map(|meta| meta.permissions());
        write_atomic_as(&target, bytes, like)?;
        Ok(name)
    }

    /// Each live file's hash as this replica holds it — a text file's UTF-8
    /// text, a binary file's blob — for a checksum (ATL-404).
    pub fn hashes(&self) -> Vec<(u64, String)> {
        self.files
            .iter()
            .filter(|(_, f)| !f.deleted)
            .filter_map(|(id, f)| match f.kind {
                FileKind::Text => Some((*id, hex(&hash(f.doc.content().as_bytes())))),
                FileKind::Binary => f.blob.clone().map(|b| (*id, b)),
            })
            .collect()
    }

    pub fn path_of(&self, file_id: u64) -> Option<String> {
        self.files.get(&file_id).map(|f| f.path.clone())
    }

    /// Files of the person's that remote changes moved out of the way, since
    /// this was last asked.
    pub fn take_set_aside(&mut self) -> Vec<SetAside> {
        std::mem::take(&mut self.set_aside)
    }

    /// Move a file of the person's at `rel` to a free name beside it, so a
    /// remote change can take the path without overwriting it.
    fn set_aside(&mut self, rel: &str) -> Result<(), ReplicaError> {
        let target = path::resolve(&self.root, rel)?;
        if !target.exists() {
            return Ok(());
        }
        let mut n = 0;
        let moved_to = loop {
            let candidate = if n == 0 {
                format!("{rel}{ASIDE_MARK}")
            } else {
                format!("{rel}{ASIDE_MARK}-{n}")
            };
            if !path::resolve(&self.root, &candidate)?.exists() {
                break candidate;
            }
            n += 1;
        };
        let dest = path::resolve(&self.root, &moved_to)?;
        fs::rename(&target, &dest).map_err(io(&dest))?;
        tracing::info!(target: "atlas_thread_sync", %rel, %moved_to, "moved the person's file aside for a remote change");
        self.set_aside.push(SetAside {
            path: rel.to_string(),
            moved_to,
        });
        Ok(())
    }

    /// The Base arrived (or was always in `repo`): worktrees come from `repo`
    /// from now on. Every file already followed is seeded from its Base
    /// content too — harmless, since seeds are identical everywhere.
    pub fn attach_repo(&mut self, repo: &Path) -> Result<(), ReplicaError> {
        if !git::has_commit(repo, &self.base) {
            return Err(ReplicaError::BaseMissing(self.base.clone()));
        }
        self.repo = Some(repo.to_path_buf());
        self.materialized = self.root.join(".git").exists();
        let files: Vec<(u64, String)> = self
            .files
            .iter()
            .map(|(id, f)| (*id, f.path.clone()))
            .collect();
        for (id, path) in files {
            for update in self.seed_for(&path)? {
                self.files[&id].doc.apply(&update)?;
            }
        }
        Ok(())
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    /// The repository the replica's worktrees come from, once it has the Base.
    pub fn repo(&self) -> Option<&Path> {
        self.repo.as_deref()
    }

    /// Can this machine check the thread out and edit it? Not until it holds
    /// the Base.
    pub fn has_base(&self) -> bool {
        self.repo.is_some()
    }

    /// Every tracked file as it is now, to fork a Run from (ATL-405).
    pub fn fork_files(&self) -> BTreeMap<u64, ForkFile> {
        self.files
            .iter()
            .filter(|(_, f)| !f.deleted && f.kind == FileKind::Text)
            .map(|(id, f)| {
                (
                    *id,
                    ForkFile {
                        path: f.path.clone(),
                        snapshot: f.doc.snapshot(),
                        content: f.doc.content(),
                    },
                )
            })
            .collect()
    }

    /// One file's document as a snapshot.
    pub fn snapshot(&self, file_id: u64) -> Option<Vec<u8>> {
        Some(self.files.get(&file_id)?.doc.snapshot())
    }

    /// The document a file starts from in this thread — its Base content, or
    /// nothing — as a snapshot. A Run that creates a file forks from this.
    pub fn seed_snapshot(&self, path: &str) -> Result<Vec<u8>, ReplicaError> {
        let doc = FileDoc::new(random_client_id());
        for update in self.seed_for(path)? {
            doc.apply(&update)?;
        }
        Ok(doc.snapshot())
    }

    /// Where the worktree is (or will be).
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn is_materialized(&self) -> bool {
        self.materialized
    }

    pub fn file_id(&self, path: &str) -> Option<u64> {
        self.by_path.get(path).copied()
    }

    /// Every live file the thread holds, by id and path.
    pub fn files(&self) -> impl Iterator<Item = (u64, &str)> {
        self.files
            .iter()
            .filter(|(_, f)| !f.deleted)
            .map(|(id, f)| (*id, f.path.as_str()))
    }

    pub fn kind(&self, file_id: u64) -> Option<FileKind> {
        self.files.get(&file_id).map(|f| f.kind)
    }

    pub fn is_deleted(&self, file_id: u64) -> bool {
        self.files.get(&file_id).is_some_and(|f| f.deleted)
    }

    /// A binary file's canonical blob.
    pub fn blob(&self, file_id: u64) -> Option<&str> {
        self.files.get(&file_id)?.blob.as_deref()
    }

    /// Paths a checkout at the Base holds that canonical state does not:
    /// deleted files, and where renamed ones used to be.
    pub fn removed_paths(&self) -> Vec<String> {
        let mut out = Vec::new();
        for f in self.files.values() {
            if f.deleted && !self.by_path.contains_key(&f.path) {
                out.push(f.path.clone());
            }
            if f.origin != f.path && !self.by_path.contains_key(&f.origin) {
                out.push(f.origin.clone());
            }
        }
        out.sort();
        out.dedup();
        out
    }

    /// Every file the thread holds — deleted ones too — as Apply needs it
    /// (ATL-408). A deleted file whose path a live one holds again is left
    /// out: the live one speaks for that path.
    pub fn thread_files(&self) -> Vec<ThreadFile> {
        self.files
            .iter()
            .filter(|(id, f)| {
                !f.deleted || self.by_path.get(&f.path).is_none_or(|live| live == *id)
            })
            .map(|(_, f)| ThreadFile {
                path: f.path.clone(),
                origin: f.origin.clone(),
                deleted: f.deleted,
                kind: f.kind,
                text: (f.kind == FileKind::Text && !f.deleted).then(|| f.doc.content()),
                blob: f.blob.clone(),
            })
            .collect()
    }

    /// Every file the thread holds, deleted ones too, by id — what a diff
    /// against the Base or a Thread Version compares (ATL-419).
    pub fn file_states(&self) -> Vec<(u64, ThreadFile)> {
        self.files
            .iter()
            .map(|(id, f)| {
                (
                    *id,
                    ThreadFile {
                        path: f.path.clone(),
                        origin: f.origin.clone(),
                        deleted: f.deleted,
                        kind: f.kind,
                        text: (f.kind == FileKind::Text && !f.deleted).then(|| f.doc.content()),
                        blob: f.blob.clone(),
                    },
                )
            })
            .collect()
    }

    /// A live text file's document, for anchoring and resolving line
    /// comments (ATL-416).
    pub fn doc_of(&self, file_id: u64) -> Option<&FileDoc> {
        self.files
            .get(&file_id)
            .filter(|f| f.kind == FileKind::Text && !f.deleted)
            .map(|f| &f.doc)
    }

    /// A file's canonical text as this replica holds it.
    pub fn text(&self, path: &str) -> Option<String> {
        let id = self.by_path.get(path)?;
        Some(self.files.get(id)?.doc.content())
    }

    /// The deterministic seed updates for `path` at the Base (see `doc.rs`):
    /// empty for a file the Base does not have.
    pub fn seed_for(&self, path: &str) -> Result<Vec<Vec<u8>>, ReplicaError> {
        let base = self.base_bytes(path)?.unwrap_or_default();
        if !looks_textual(&base) {
            return Ok(Vec::new());
        }
        Ok(FileDoc::seed_updates(&String::from_utf8_lossy(&base)))
    }

    /// A file's bytes at the Base, or `None` when the Base has no such file —
    /// or this machine does not have the Base yet.
    pub fn base_bytes(&self, path: &str) -> Result<Option<Vec<u8>>, ReplicaError> {
        match &self.repo {
            Some(repo) => Ok(git::blob_at(repo, &self.base, path)?),
            None => Ok(None),
        }
    }

    /// Learn a tree entry: create its document and seed it from the Base. A
    /// file already known is left alone. Answers whether it was new.
    pub fn add_entry(
        &mut self,
        file_id: u64,
        rel: &str,
        kind: FileKind,
    ) -> Result<bool, ReplicaError> {
        if self.files.contains_key(&file_id) {
            return Ok(false);
        }
        if !path::is_valid(rel) {
            return Err(path::PathError::Invalid(rel.to_string()).into());
        }
        // One live file per path: a second would write over the first.
        if let Some(holder) = self.by_path.get(rel).copied() {
            return Err(ReplicaError::PathTaken {
                path: rel.to_string(),
                holder,
            });
        }
        let doc = FileDoc::new(self.client_id);
        if kind == FileKind::Text {
            for update in self.seed_for(rel)? {
                doc.apply(&update)?;
            }
        }
        // Nothing is written here, even with the worktree checked out: what is
        // on disk at this path is either the Base (equal to the seed) or the
        // person's own new file, which the next save or remote update folds in
        // before anything is written back. `disk: None` makes sure it is read.
        let disk = self.known_before.remove(rel);
        self.files.insert(
            file_id,
            TrackedFile {
                path: rel.to_string(),
                kind,
                doc,
                disk,
                held: None,
                held_read_only: false,
                outgrown: false,
                blob: None,
                deleted: false,
                origin: rel.to_string(),
            },
        );
        self.by_path.insert(rel.to_string(), file_id);
        Ok(true)
    }

    /// Bring one tree entry into this replica — a new file, a rename, a
    /// deletion, a revival or a binary file's new blob — moving or removing
    /// the file on disk to match. Answers a blob to fetch and write with
    /// [`Replica::write_blob`] when disk does not hold the canonical one.
    pub fn learn(&mut self, entry: &TreeEntry) -> Result<Option<String>, ReplicaError> {
        let id = entry.file_id;
        if !path::is_valid(&entry.path) {
            return Err(path::PathError::Invalid(entry.path.clone()).into());
        }
        if self.add_entry(id, &entry.path, entry.kind)? {
            let file = self
                .files
                .get_mut(&id)
                .ok_or(ReplicaError::UnknownFile(id))?;
            if let Some(origin) = entry.origin.as_ref().filter(|o| path::is_valid(o)) {
                file.origin.clone_from(origin);
            }
            // A file the person keeps where git (or `.atlas/shareignore`)
            // ignores it — build output, a local config — is theirs, not this
            // file's content: set it aside rather than fold it in and send it.
            if self.materialized && !entry.deleted && self.ignores_on_disk(&entry.path)? {
                self.set_aside(&entry.path)?;
            }
        }
        // The path must not be another live file's here.
        if !entry.deleted {
            if let Some(holder) = self.by_path.get(&entry.path).copied().filter(|h| *h != id) {
                return Err(ReplicaError::PathTaken {
                    path: entry.path.clone(),
                    holder,
                });
            }
        }
        // A rename: the bytes move with the file.
        let old_path = self.files[&id].path.clone();
        if old_path != entry.path {
            if self.by_path.get(&old_path) == Some(&id) {
                self.by_path.remove(&old_path);
            }
            if self.materialized && !self.files[&id].deleted {
                self.move_on_disk(&old_path, &entry.path)?;
            }
            self.files
                .get_mut(&id)
                .expect("known")
                .path
                .clone_from(&entry.path);
        }
        // Deleted, or back.
        let was_deleted = self.files[&id].deleted;
        // Coming back where the person has put a file of their own since.
        if was_deleted && !entry.deleted && self.materialized {
            let target = path::resolve(&self.root, &entry.path)?;
            if target.exists() {
                self.set_aside(&entry.path)?;
            }
        }
        if entry.deleted && !was_deleted {
            self.by_path.remove(&entry.path);
            if self.materialized {
                self.remove_on_disk(&entry.path)?;
            }
        } else if !entry.deleted {
            self.by_path.insert(entry.path.clone(), id);
        }
        {
            let file = self.files.get_mut(&id).expect("known");
            file.deleted = entry.deleted;
            if file.kind == FileKind::Binary {
                file.blob.clone_from(&entry.blob);
            }
        }
        if entry.deleted || !self.materialized {
            return Ok(None);
        }
        match self.files[&id].kind {
            FileKind::Text => {
                if was_deleted {
                    self.sync_disk(id)?;
                }
                Ok(None)
            }
            FileKind::Binary => Ok(self.blob_to_fetch(id)),
        }
    }

    /// The canonical blob of a binary file, if disk does not hold it.
    fn blob_to_fetch(&self, file_id: u64) -> Option<String> {
        let file = self.files.get(&file_id)?;
        let sha = file.blob.clone()?;
        if file.deleted || file.disk.as_ref().map(hex).as_deref() == Some(sha.as_str()) {
            return None;
        }
        Some(sha)
    }

    /// Every binary file's blob the worktree does not hold yet.
    pub fn blobs_to_fetch(&self) -> Vec<(u64, String)> {
        if !self.materialized {
            return Vec::new();
        }
        self.files
            .keys()
            .filter_map(|id| self.blob_to_fetch(*id).map(|sha| (*id, sha)))
            .collect()
    }

    /// Write a binary file's canonical bytes, fetched from the thread. Refused
    /// unless they hash to the blob canonical state names.
    pub fn write_blob(&mut self, file_id: u64, bytes: &[u8]) -> Result<(), ReplicaError> {
        let file = self
            .files
            .get_mut(&file_id)
            .ok_or(ReplicaError::UnknownFile(file_id))?;
        let seen = hash(bytes);
        if file.blob.as_deref() != Some(hex(&seen).as_str()) {
            return Err(ReplicaError::CorruptBlob(file.path.clone()));
        }
        if file.deleted || !self.materialized {
            return Ok(());
        }
        let rel = file.path.clone();
        let ours = file.disk;
        let target = path::resolve(&self.root, &rel)?;
        // Bytes this replica never wrote or read are the person's own: set
        // them aside rather than overwrite them.
        if ours.is_none() {
            if let Ok(existing) = fs::read(&target) {
                if hash(&existing) != seen {
                    self.set_aside(&rel)?;
                }
            }
        }
        let file = self.files.get_mut(&file_id).expect("known");
        file.disk = Some(seen);
        write_atomic(&target, bytes)
    }

    /// This replica renamed a file itself (the person moved it on disk).
    pub fn rename(&mut self, file_id: u64, to: &str) -> Result<(), ReplicaError> {
        if !path::is_valid(to) {
            return Err(path::PathError::Invalid(to.to_string()).into());
        }
        let file = self
            .files
            .get_mut(&file_id)
            .ok_or(ReplicaError::UnknownFile(file_id))?;
        self.by_path.remove(&file.path);
        file.path = to.to_string();
        self.by_path.insert(to.to_string(), file_id);
        Ok(())
    }

    /// The server answered this replica's `tree.ensure` with a file it knew
    /// was deleted: the same file is back, at `rel`.
    pub fn revive(&mut self, file_id: u64, rel: &str) -> Result<(), ReplicaError> {
        if !path::is_valid(rel) {
            return Err(path::PathError::Invalid(rel.to_string()).into());
        }
        let file = self
            .files
            .get_mut(&file_id)
            .ok_or(ReplicaError::UnknownFile(file_id))?;
        file.deleted = false;
        file.path = rel.to_string();
        self.by_path.insert(rel.to_string(), file_id);
        Ok(())
    }

    /// This replica deleted a file itself (the person removed it on disk).
    pub fn delete(&mut self, file_id: u64) -> Result<(), ReplicaError> {
        let file = self
            .files
            .get_mut(&file_id)
            .ok_or(ReplicaError::UnknownFile(file_id))?;
        file.deleted = true;
        file.disk = None;
        self.by_path.remove(&file.path);
        Ok(())
    }

    /// This replica set a binary file's blob itself.
    pub fn set_blob(&mut self, file_id: u64, sha256: &str) -> Result<(), ReplicaError> {
        let file = self
            .files
            .get_mut(&file_id)
            .ok_or(ReplicaError::UnknownFile(file_id))?;
        file.blob = Some(sha256.to_string());
        Ok(())
    }

    fn move_on_disk(&mut self, from: &str, to: &str) -> Result<(), ReplicaError> {
        let source = path::resolve(&self.root, from)?;
        let target = path::resolve(&self.root, to)?;
        // Whatever is at the new path is the person's own (no live file of
        // the thread holds it): keep it, beside, rather than lose it — or,
        // worse, read it back later as an edit of the moved file. Even when
        // there is nothing to move: the file is the thread's path from now on.
        if target.exists() {
            self.set_aside(to)?;
        }
        if !source.exists() {
            return Ok(());
        }
        if let Some(dir) = target.parent() {
            fs::create_dir_all(dir).map_err(io(dir))?;
        }
        fs::rename(&source, &target).map_err(io(&target))
    }

    /// Is there a file at `rel` that git, or `.atlas/shareignore`, ignores?
    fn ignores_on_disk(&self, rel: &str) -> Result<bool, ReplicaError> {
        if !path::resolve(&self.root, rel)?.exists() {
            return Ok(false);
        }
        let ignored = git::ignored(
            &self.root,
            &[rel.to_string()],
            Some(&self.root.join(crate::share::SHAREIGNORE)),
        )?;
        Ok(ignored.contains(rel))
    }

    fn remove_on_disk(&mut self, rel: &str) -> Result<(), ReplicaError> {
        let target = path::resolve(&self.root, rel)?;
        match fs::remove_file(&target) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io(&target)(e)),
        }
    }

    /// A worktree file's text as it is on disk now (lossy UTF-8), for checks
    /// made before it is synced.
    pub fn read_disk(&self, rel: &str) -> Result<String, ReplicaError> {
        let target = path::resolve(&self.root, rel)?;
        let bytes = fs::read(&target).map_err(io(&target))?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    /// Make a file's document hold `content` (the sharer's working copy, read
    /// from their own checkout) and answer the update. The replica's disk is
    /// brought along when it exists.
    pub fn set_text(&mut self, file_id: u64, content: &str) -> Result<Vec<Vec<u8>>, ReplicaError> {
        let file = self
            .files
            .get(&file_id)
            .ok_or(ReplicaError::UnknownFile(file_id))?;
        let updates = file.doc.set_content(content);
        if self.materialized && !updates.is_empty() {
            self.sync_disk(file_id)?;
        }
        Ok(updates)
    }

    /// The Atlas editor's keystrokes in a file (ATL-407): a Yjs update made
    /// on a copy of this file's document, applied here and written to disk so
    /// every other editor sees it. A save from another editor that this
    /// replica has not read yet is folded in first and returned, to send.
    ///
    /// Refused — nothing applied — where a save would not sync either: a
    /// replica that may only watch, a file held or outgrown, or an edit that
    /// would make the file look like it holds a secret or grow past 1 MiB.
    /// The editor then writes to disk instead, and the usual rules take over.
    pub fn apply_editor(
        &mut self,
        file_id: u64,
        update: &[u8],
    ) -> Result<EditorEdit, ReplicaError> {
        let refuse = |why: String, pending: Vec<Vec<u8>>| Ok(EditorEdit::Refused { why, pending });
        {
            let file = self
                .files
                .get(&file_id)
                .ok_or(ReplicaError::UnknownFile(file_id))?;
            if self.read_only {
                return refuse("this replica may only watch".into(), Vec::new());
            }
            if file.kind != FileKind::Text || file.deleted || !self.materialized {
                return refuse(
                    format!("{} is not syncing keystrokes", file.path),
                    Vec::new(),
                );
            }
        }
        // A save from another editor goes in first, through the checks every
        // save gets; the edit is then judged on the text it would really make.
        let pending = self.ingest_disk(file_id)?;
        let file = &self.files[&file_id];
        if file.held.is_some() || file.outgrown {
            return refuse(format!("{} is not syncing keystrokes", file.path), pending);
        }
        let after = FileDoc::from_snapshot(random_client_id(), &file.doc.snapshot())?;
        after.apply(update)?;
        let content = after.content();
        if content.len() >= MAX_TEXT_BYTES {
            return refuse(format!("{} is past 1 MB", file.path), pending);
        }
        if secret_reason(&file.path, &content).is_some() {
            return refuse(
                format!("{} now looks like it holds a secret", file.path),
                pending,
            );
        }
        file.doc.apply(update)?;
        self.sync_disk(file_id)?;
        Ok(EditorEdit::Applied(pending))
    }

    /// A file's document as one update, and its state vector — what an
    /// editor binding to it starts from.
    pub fn doc_state(&self, file_id: u64) -> Option<(Vec<u8>, Vec<u8>)> {
        let file = self.files.get(&file_id)?;
        (file.kind == FileKind::Text).then(|| (file.doc.snapshot(), file.doc.state_vector()))
    }

    /// What `file_id`'s document has beyond `state_vector`, and its state
    /// vector now; `None` when nothing is new.
    pub fn doc_diff(&self, file_id: u64, state_vector: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
        let file = self.files.get(&file_id)?;
        let now = file.doc.state_vector();
        if now == state_vector {
            return None;
        }
        Some((file.doc.diff(state_vector).ok()?, now))
    }

    /// Apply an update from the thread. When the worktree exists the file is
    /// rewritten; if the person had saved over it meanwhile, that save is folded
    /// in first and returned as an update to send.
    pub fn apply_remote(
        &mut self,
        file_id: u64,
        update: &[u8],
    ) -> Result<Vec<Vec<u8>>, ReplicaError> {
        let file = self
            .files
            .get(&file_id)
            .ok_or(ReplicaError::UnknownFile(file_id))?;
        // A deleted file's document still follows (a revival brings it back),
        // but nothing is written where it used to be.
        if !self.materialized || file.deleted || self.rebuilding {
            file.doc.apply(update)?;
            return Ok(Vec::new());
        }
        // A save we have not seen yet goes into the document before the
        // remote change, or writing the merge back would erase it.
        let pending = self.ingest_disk(file_id)?;
        let file = &self.files[&file_id];
        file.doc.apply(update)?;
        // A held file keeps the person's bytes on disk; the change waits in
        // the document and lands with the merge when the secret is removed.
        if file.held.is_none() {
            self.sync_disk(file_id)?;
        }
        Ok(pending)
    }

    /// The person saved, created, moved or removed `rel` in their replica
    /// (from any editor, or a shell).
    pub fn local_change(&mut self, rel: &str) -> Result<LocalChange, ReplicaError> {
        if !self.materialized || !path::is_valid(rel) || is_set_aside(rel) {
            return Ok(LocalChange::Ignored);
        }
        let target = path::resolve(&self.root, rel)?;
        let bytes = match fs::read(&target) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            // A directory, or unreadable: nothing to sync.
            Err(_) => return Ok(LocalChange::Ignored),
        };
        match (self.by_path.get(rel).copied(), bytes) {
            (Some(file_id), None) => Ok(LocalChange::Missing { file_id }),
            (Some(file_id), Some(bytes)) => match self.files[&file_id].kind {
                FileKind::Text => {
                    let updates = self.ingest_disk(file_id)?;
                    Ok(if updates.is_empty() {
                        LocalChange::Echo
                    } else {
                        LocalChange::Update { file_id, updates }
                    })
                }
                FileKind::Binary => {
                    let seen = hash(&bytes);
                    let file = self.files.get_mut(&file_id).expect("known");
                    if file.disk == Some(seen) {
                        return Ok(LocalChange::Echo);
                    }
                    file.disk = Some(seen);
                    Ok(LocalChange::Blob {
                        file_id,
                        sha256: hex(&seen),
                        bytes,
                    })
                }
            },
            (None, None) => Ok(LocalChange::Ignored),
            (None, Some(bytes)) => {
                // The same bytes as a file that is gone from where it was: the
                // person moved it.
                let seen = hash(&bytes);
                if let Some(file_id) = self.vanished_with(&seen) {
                    let from = self.files[&file_id].path.clone();
                    return Ok(LocalChange::Renamed {
                        file_id,
                        from,
                        to: rel.to_string(),
                    });
                }
                Ok(LocalChange::NewFile {
                    path: rel.to_string(),
                })
            }
        }
    }

    /// A live file whose bytes, as this replica last saw them, were `seen`,
    /// and which is no longer on disk where it was.
    fn vanished_with(&self, seen: &Hash) -> Option<u64> {
        self.files.iter().find_map(|(id, f)| {
            let gone = !f.deleted
                && f.disk.as_ref() == Some(seen)
                && path::resolve(&self.root, &f.path).is_ok_and(|p| !p.exists());
            gone.then_some(*id)
        })
    }

    /// Is a tracked file still missing from disk?
    pub fn is_missing(&self, file_id: u64) -> bool {
        self.files.get(&file_id).is_some_and(|f| {
            !f.deleted && path::resolve(&self.root, &f.path).is_ok_and(|p| !p.exists())
        })
    }

    /// Read a new file's bytes to introduce it.
    pub fn read_bytes(&self, rel: &str) -> Result<Vec<u8>, ReplicaError> {
        let target = path::resolve(&self.root, rel)?;
        fs::read(&target).map_err(io(&target))
    }

    /// Remember the bytes this replica just introduced a binary file with.
    pub fn saw_bytes(&mut self, file_id: u64, bytes: &[u8]) {
        if let Some(file) = self.files.get_mut(&file_id) {
            file.disk = Some(hash(bytes));
        }
    }

    /// Read the file's bytes off disk and, unless they are what this replica
    /// already knows, make the document match them. Answers the update.
    fn ingest_disk(&mut self, file_id: u64) -> Result<Vec<Vec<u8>>, ReplicaError> {
        let file = self
            .files
            .get_mut(&file_id)
            .ok_or(ReplicaError::UnknownFile(file_id))?;
        let target = path::resolve(&self.root, &file.path)?;
        let bytes = match fs::read(&target) {
            Ok(bytes) => bytes,
            // Deletion is a tree change (ATL-403); until then a missing file
            // is left to the next remote write to restore.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(source) => {
                return Err(ReplicaError::Io {
                    path: target,
                    source,
                })
            }
        };
        let seen = hash(&bytes);
        if file.disk == Some(seen) {
            return Ok(Vec::new());
        }
        // A text file that turned binary, or grew past the text limit, stays
        // as it was in the thread — a file's kind is fixed when it enters —
        // and the status says it stopped syncing.
        file.outgrown = !looks_textual(&bytes);
        if file.outgrown {
            return Ok(Vec::new());
        }
        let content = String::from_utf8_lossy(&bytes).into_owned();

        // The same gate as sharing and new files, for every later save: a
        // credential pasted into a tracked file is held on this machine.
        let secret = secret_reason(&file.path, &content).is_some();
        if secret || self.read_only {
            if file.held.is_none() {
                tracing::info!(target: "atlas_thread_sync", path = %file.path, secret, "holding a save on this machine");
                file.held = Some(file.doc.snapshot());
            }
            file.held_read_only = !secret;
            return Ok(Vec::new());
        }

        file.disk = Some(seen);
        file.held_read_only = false;
        match file.held.take() {
            None => Ok(file.doc.set_content(&content)),
            Some(snapshot) => {
                // Resume: the person's edit, relative to the moment the file
                // was held, merged into whatever the thread did since. Then
                // disk gets the merge.
                let fork = FileDoc::from_snapshot(self.client_id, &snapshot)?;
                let updates = fork.set_content(&content);
                for update in &updates {
                    file.doc.apply(update)?;
                }
                self.sync_disk(file_id)?;
                Ok(updates)
            }
        }
    }

    /// Files held back because they now look like they contain a secret.
    pub fn held_files(&self) -> Vec<String> {
        self.files
            .values()
            .filter(|f| f.held.is_some() && !f.held_read_only && !f.deleted)
            .map(|f| f.path.clone())
            .collect()
    }

    /// Write the document to disk if disk differs, atomically, and remember
    /// what was written so the watcher's report of it is recognised as ours.
    fn sync_disk(&mut self, file_id: u64) -> Result<(), ReplicaError> {
        let file = self
            .files
            .get_mut(&file_id)
            .ok_or(ReplicaError::UnknownFile(file_id))?;
        let target = path::resolve(&self.root, &file.path)?;
        let content = file.doc.content();
        let wanted = hash(content.as_bytes());
        let on_disk = fs::read(&target).ok().map(|b| hash(&b));
        file.disk = Some(wanted);
        if on_disk == Some(wanted) {
            return Ok(());
        }
        write_atomic(&target, content.as_bytes())
    }

    /// Check out the worktree, if it is not already, and bring every tracked
    /// file on it up to the thread's canonical state. Answers its root.
    ///
    /// A worktree that already existed (the app restarted) is left as it is:
    /// it may hold saves the thread has not heard yet, and every later remote
    /// update reads disk before writing, so nothing there is lost.
    pub fn materialize(&mut self) -> Result<&Path, ReplicaError> {
        if self.materialized {
            return Ok(&self.root);
        }
        let repo = self
            .repo
            .clone()
            .ok_or_else(|| ReplicaError::BaseMissing(self.base.clone()))?;
        if let Some(parent) = self.root.parent() {
            fs::create_dir_all(parent).map_err(io(parent))?;
        }
        git::add_worktree(&repo, &self.root, &self.base)?;
        self.materialized = true;
        // Renamed and deleted files leave the Base's copy behind.
        for rel in self.removed_paths() {
            self.remove_on_disk(&rel)?;
        }
        let ids: Vec<u64> = self
            .files
            .iter()
            .filter(|(_, f)| !f.deleted && f.kind == FileKind::Text)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            self.sync_disk(id)?;
        }
        // Binary files are fetched by the session: see `blobs_to_fetch`.
        Ok(&self.root)
    }
}

/// Write `bytes` to `target` through a temporary file in the same directory
/// and a rename, so a reader sees the old file or the new one and never half.
pub fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), ReplicaError> {
    let existing = fs::metadata(target).ok().map(|meta| meta.permissions());
    write_atomic_inner(target, bytes, existing, 0o644)
}

/// [`write_atomic`] for a new file that must be no more readable than one
/// with permissions `like` — owner-only when there is none. The mode is set
/// before the file appears under its name.
pub fn write_atomic_as(
    target: &Path,
    bytes: &[u8],
    like: Option<fs::Permissions>,
) -> Result<(), ReplicaError> {
    write_atomic_inner(target, bytes, like, 0o600)
}

fn write_atomic_inner(
    target: &Path,
    bytes: &[u8],
    like: Option<fs::Permissions>,
    #[cfg_attr(not(unix), allow(unused_variables))] fallback_mode: u32,
) -> Result<(), ReplicaError> {
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir).map_err(io(dir))?;
    let temp = dir.join(format!("{TEMP_PREFIX}{}", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        // Created owner-only, so the bytes are never readable by anybody the
        // finished file would not be; the target's own mode is applied before
        // the rename (an executable script stays one, a 0600 file stays 0600).
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        match like {
            Some(permissions) => fs::set_permissions(&temp, permissions)?,
            #[cfg(unix)]
            None => fs::set_permissions(
                &temp,
                std::os::unix::fs::PermissionsExt::from_mode(fallback_mode),
            )?,
            #[cfg(not(unix))]
            None => {}
        }
        fs::rename(&temp, target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(io(target))
}

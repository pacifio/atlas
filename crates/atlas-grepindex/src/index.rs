//! [`GrepIndex`]: one project's base snapshot + overlay, and the [`CandidateSource`] that
//! `atlas_search::grep` consults.
//!
//! Soundness does not depend on the overlay being current. Every file the index vouches for
//! carries a [`FileStamp`] taken when its content was known (from git for base files, from a
//! read for overlay files); `grep` hands the walked file's live stamp to
//! [`CandidateFilter::must_search`], and any mismatch means "search it". The overlay, the
//! write notifications and the watcher only decide how many files can be skipped.

use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::SystemTime;

use atlas_search::{CancelToken, CandidateFilter, CandidateSource, FileStamp, GrepRequest};
use rayon::prelude::*;

use crate::build;
use crate::error::{git_err, Error};
use crate::exec::{difference, eval_base, union, Cands};
use crate::format::BaseIndex;
use crate::git;
use crate::overlay::{trusted_stamp, OverlayDoc};
use crate::plan::{plan_pattern, Query};

#[derive(Debug, Clone, PartialEq)]
pub struct IndexOptions {
    /// Build a snapshot only when HEAD has at least this many files ...
    pub min_files: usize,
    /// ... or at least this many bytes. Below both, a plain parallel scan is as fast.
    pub min_bytes: u64,
    /// Overlay caps; dirty files beyond them are simply always searched.
    pub max_overlay_docs: usize,
    pub max_overlay_bytes: u64,
    /// When more than this fraction of documents are candidates, `grep` scans instead.
    pub max_candidate_ratio: f64,
    /// A HEAD move touching more than `max(head_rebuild_min_files, head_rebuild_ratio x docs)`
    /// files asks for a rebuild instead of growing the overlay.
    pub head_rebuild_min_files: usize,
    pub head_rebuild_ratio: f64,
}

impl Default for IndexOptions {
    fn default() -> Self {
        IndexOptions {
            min_files: 20_000,
            min_bytes: 200 * 1024 * 1024,
            max_overlay_docs: 2_000,
            max_overlay_bytes: 64 * 1024 * 1024,
            max_candidate_ratio: 0.30,
            head_rebuild_min_files: 500,
            head_rebuild_ratio: 0.05,
        }
    }
}

impl IndexOptions {
    /// Index regardless of repository size (tests, `ATLAS_GREP_INDEX=force`).
    pub fn always() -> Self {
        IndexOptions {
            min_files: 0,
            min_bytes: 0,
            ..IndexOptions::default()
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildOutcome {
    /// A valid snapshot for HEAD's tree was already on disk.
    Loaded,
    Built,
    /// The repository is below both size thresholds; no index is kept.
    BelowThreshold,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeadAction {
    Unchanged,
    /// HEAD's tree differs from the base; this many changed paths went into the overlay.
    Overlaid(usize),
    /// Too many changes for the overlay; call [`GrepIndex::ensure_built`] (in the background).
    RebuildNeeded,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexStatus {
    pub ready: bool,
    pub trusted: bool,
    pub base_docs: u32,
    pub overlay_docs: usize,
    pub base_tree: Option<String>,
}

type Overlay = HashMap<String, Arc<OverlayDoc>>;

#[derive(Clone)]
struct Snapshot {
    base: Arc<BaseIndex>,
    /// Per base doc: the work-tree stamp at which the file was known to equal its blob.
    stamps: Arc<Vec<Option<FileStamp>>>,
    overlay: Arc<Overlay>,
    /// Ascending ids of base docs shadowed by an overlay entry.
    masked: Arc<Vec<u32>>,
}

pub struct GrepIndex {
    root: PathBuf,
    opts: IndexOptions,
    state: RwLock<Option<Snapshot>>,
    trusted: AtomicBool,
    building: Mutex<()>,
}

impl std::fmt::Debug for GrepIndex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GrepIndex")
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

impl GrepIndex {
    /// Cheap: validates that `root` is a git work-tree root. Nothing is built or loaded until
    /// [`ensure_built`](Self::ensure_built); until then [`candidates`](CandidateSource::candidates)
    /// returns `None`.
    pub fn open(root: &Path, opts: IndexOptions) -> Result<GrepIndex, Error> {
        let root = root.canonicalize()?;
        let repo = gix::open(&root).map_err(|_| Error::NotWorktreeRoot(root.clone()))?;
        let workdir = repo
            .workdir()
            .ok_or_else(|| Error::NotWorktreeRoot(root.clone()))?
            .canonicalize()?;
        if workdir != root {
            return Err(Error::NotWorktreeRoot(root));
        }
        Ok(GrepIndex {
            root,
            opts,
            state: RwLock::new(None),
            trusted: AtomicBool::new(false),
            building: Mutex::new(()),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `<root>/.atlas/code-index/grep`
    pub fn grep_dir(&self) -> PathBuf {
        self.root.join(".atlas").join("code-index").join("grep")
    }

    /// Loads (or builds) the snapshot for HEAD's tree, then resyncs the overlay. Blocking;
    /// run it on a background thread. Concurrent calls serialize.
    pub fn ensure_built(&self, cancel: &CancelToken) -> Result<BuildOutcome, Error> {
        let _building = self.building.lock().unwrap_or_else(PoisonError::into_inner);
        let repo = gix::open(&self.root).map_err(git_err)?;
        let (commit, tree) = build::head(&repo)?;
        ensure_excluded(repo.common_dir())?;
        let grep_dir = self.grep_dir();
        let dir = grep_dir.join(tree.to_string());
        let (base, outcome) = match load_valid(&dir, &tree.to_string()) {
            Some(base) => (base, BuildOutcome::Loaded),
            None => {
                let files = build::list_tree(&repo, tree)?;
                let bytes: u64 = files.iter().map(|f| f.size).sum();
                if files.len() < self.opts.min_files && bytes < self.opts.min_bytes {
                    return Ok(BuildOutcome::BelowThreshold);
                }
                let _ = fs::remove_dir_all(&dir);
                build::build_snapshot(&self.root, &files, commit, tree, &grep_dir, cancel)?;
                (BaseIndex::open(&dir)?, BuildOutcome::Built)
            }
        };
        build::remove_stale_snapshots(&grep_dir, &tree.to_string());
        self.install(Arc::new(base))?;
        Ok(outcome)
    }

    /// Recomputes stamps and the overlay from scratch (startup, after a watcher overflow).
    pub fn resync(&self) -> Result<(), Error> {
        match self.current() {
            Some(snap) => self.install(snap.base),
            None => Ok(()),
        }
    }

    fn install(&self, base: Arc<BaseIndex>) -> Result<(), Error> {
        // 1. Stamps first. A file changed after its stat no longer matches its stamp; one
        //    changed before `git status` runs is reported dirty by it.
        let observed: Vec<(Option<FileStamp>, bool)> = (0..base.n_docs())
            .into_par_iter()
            .map(|id| {
                let doc = base.doc(id);
                match fs::symlink_metadata(self.root.join(&doc.path)) {
                    // A size that differs from the blob means a clean/smudge filter (LFS, eol,
                    // working-tree-encoding) or an edit: treat the file as dirty.
                    Ok(m) if m.is_file() => (
                        trusted_stamp(&m, SystemTime::now()),
                        !doc.is_forced() && m.len() != doc.size,
                    ),
                    _ => (None, false),
                }
            })
            .collect();
        let mut stamps: Vec<Option<FileStamp>> = observed.iter().map(|o| o.0).collect();
        // 2. Every path whose work-tree content may differ from the base blob.
        let mut dirty: BTreeSet<String> = observed
            .iter()
            .enumerate()
            .filter(|(_, o)| o.1)
            .map(|(id, _)| base.doc(id as u32).path.clone())
            .collect();
        dirty.extend(git::status_paths(&self.root)?);
        let repo = gix::open(&self.root).map_err(git_err)?;
        let (_, head_tree) = build::head(&repo)?;
        let base_tree = hex(&base.meta().base_tree);
        if head_tree.to_string() != base_tree {
            dirty.extend(git::diff_tree_paths(
                &self.root,
                &base_tree,
                &head_tree.to_string(),
            )?);
        }
        dirty.retain(|p| !is_atlas_path(p));
        // 3. Overlay, up to its caps; beyond them a base file is simply never vouched for.
        let mut overlay = Overlay::new();
        let mut bytes = 0u64;
        for path in dirty {
            if overlay.len() >= self.opts.max_overlay_docs || bytes >= self.opts.max_overlay_bytes {
                if let Some(id) = base.doc_id(&path) {
                    stamps[id as usize] = None;
                }
                continue;
            }
            let doc = OverlayDoc::load(&self.root.join(&path));
            bytes += doc.bytes;
            overlay.insert(path, Arc::new(doc));
        }
        let mut masked: Vec<u32> = overlay.keys().filter_map(|p| base.doc_id(p)).collect();
        masked.sort_unstable();
        *self.state.write().unwrap_or_else(PoisonError::into_inner) = Some(Snapshot {
            base,
            stamps: Arc::new(stamps),
            overlay: Arc::new(overlay),
            masked: Arc::new(masked),
        });
        self.trusted.store(true, Ordering::Release);
        Ok(())
    }

    /// Re-reads one written file into the overlay. Call it synchronously from write paths.
    pub fn note_write(&self, path: &Path) {
        self.note_paths(&[path.to_path_buf()]);
    }

    /// Re-reads changed files (absolute, or relative to the root) into the overlay.
    pub fn note_paths(&self, paths: &[PathBuf]) {
        let loaded: Vec<(String, OverlayDoc)> = paths
            .iter()
            .filter_map(|p| self.rel(p))
            .map(|rel| {
                let doc = OverlayDoc::load(&self.root.join(&rel));
                (rel, doc)
            })
            .collect();
        if loaded.is_empty() {
            return;
        }
        let mut state = self.state.write().unwrap_or_else(PoisonError::into_inner);
        let Some(snap) = state.as_mut() else { return };
        let mut overlay = (*snap.overlay).clone();
        let mut masked = (*snap.masked).clone();
        let mut stamps: Option<Vec<Option<FileStamp>>> = None;
        let mut bytes: u64 = overlay.values().map(|d| d.bytes).sum();
        for (rel, doc) in loaded {
            let id = snap.base.doc_id(&rel);
            // A file already in the overlay is always refreshed: leaving its old
            // grams would be wrong, while letting it grow by one file is not.
            let replaced = overlay.get(&rel).map_or(0, |d| d.bytes);
            let over_cap = overlay.len() >= self.opts.max_overlay_docs
                || bytes - replaced + doc.bytes > self.opts.max_overlay_bytes;
            if over_cap && !overlay.contains_key(&rel) {
                // It does not fit: its stamp goes too, so it is searched (correct,
                // just not skipped).
                if let Some(id) = id {
                    stamps.get_or_insert_with(|| (*snap.stamps).clone())[id as usize] = None;
                }
                continue;
            }
            if let Some(id) = id {
                if let Err(at) = masked.binary_search(&id) {
                    masked.insert(at, id);
                }
            }
            bytes = bytes - replaced + doc.bytes;
            overlay.insert(rel, Arc::new(doc));
        }
        snap.overlay = Arc::new(overlay);
        snap.masked = Arc::new(masked);
        if let Some(stamps) = stamps {
            snap.stamps = Arc::new(stamps);
        }
    }

    /// The watcher lost events (queue overflow, rescan): stop serving candidates until
    /// [`resync`](Self::resync) succeeds.
    pub fn mark_untrusted(&self) {
        self.trusted.store(false, Ordering::Release);
    }

    /// Call when `.git/HEAD` or refs change. Cheap when HEAD's tree still equals the base.
    pub fn refresh_head(&self) -> Result<HeadAction, Error> {
        // No snapshot: the repository had no commits at open, or a build failed. Let the
        // caller try again; `ensure_built` is serialized and returns `BelowThreshold` cheaply
        // (a tree listing, no file reads) for small repositories.
        let Some(snap) = self.current() else {
            return Ok(HeadAction::RebuildNeeded);
        };
        let repo = gix::open(&self.root).map_err(git_err)?;
        let (_, tree) = build::head(&repo)?;
        let base_tree = hex(&snap.base.meta().base_tree);
        if tree.to_string() == base_tree {
            return Ok(HeadAction::Unchanged);
        }
        let mut changed = git::diff_tree_paths(&self.root, &base_tree, &tree.to_string())?;
        changed.retain(|p| !is_atlas_path(p));
        let limit = self
            .opts
            .head_rebuild_min_files
            .max((f64::from(snap.base.n_docs()) * self.opts.head_rebuild_ratio) as usize);
        if changed.len() > limit {
            return Ok(HeadAction::RebuildNeeded);
        }
        let paths: Vec<PathBuf> = changed.iter().map(PathBuf::from).collect();
        self.note_paths(&paths);
        Ok(HeadAction::Overlaid(changed.len()))
    }

    pub fn status(&self) -> IndexStatus {
        let snap = self.current();
        IndexStatus {
            ready: snap.is_some(),
            trusted: self.trusted.load(Ordering::Acquire),
            base_docs: snap.as_ref().map_or(0, |s| s.base.n_docs()),
            overlay_docs: snap.as_ref().map_or(0, |s| s.overlay.len()),
            base_tree: snap.map(|s| hex(&s.base.meta().base_tree)),
        }
    }

    fn current(&self) -> Option<Snapshot> {
        self.state
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// `/`-separated root-relative form of `p`; `None` outside the root, under `.git` or
    /// `.atlas`, or not UTF-8.
    fn rel(&self, p: &Path) -> Option<String> {
        let rel_path = if p.is_absolute() {
            match p.strip_prefix(&self.root) {
                Ok(r) => r.to_path_buf(),
                Err(_) => {
                    let parent = p.parent()?.canonicalize().ok()?;
                    parent.strip_prefix(&self.root).ok()?.join(p.file_name()?)
                }
            }
        } else {
            p.to_path_buf()
        };
        let mut parts = Vec::new();
        for c in rel_path.components() {
            match c {
                Component::Normal(s) => parts.push(s.to_str()?),
                _ => return None,
            }
        }
        match parts.first() {
            None | Some(&".git") | Some(&".atlas") => None,
            Some(_) => Some(parts.join("/")),
        }
    }

    /// Prefix that turns a path relative to `req_root` into one relative to the index root.
    fn request_prefix(&self, req_root: &Path) -> Option<String> {
        let canonical = req_root.canonicalize().ok()?;
        let sub = canonical.strip_prefix(&self.root).ok()?;
        let mut prefix = String::new();
        for c in sub.components() {
            match c {
                Component::Normal(s) => {
                    prefix.push_str(s.to_str()?);
                    prefix.push('/');
                }
                _ => return None,
            }
        }
        Some(prefix)
    }
}

/// The index's own files, which must never feed back into it.
fn is_atlas_path(rel: &str) -> bool {
    rel == ".atlas" || rel.starts_with(".atlas/")
}

/// Adds `/.atlas/` to `<common git dir>/info/exclude` (never to `.gitignore`) so snapshots
/// never show up as untracked files. Idempotent; Phase 2's code index relies on the same line.
fn ensure_excluded(common_dir: &Path) -> Result<(), Error> {
    let path = common_dir.join("info").join("exclude");
    let existing = fs::read_to_string(&path).unwrap_or_default();
    if existing
        .lines()
        .any(|l| matches!(l.trim(), "/.atlas/" | ".atlas/" | "/.atlas" | ".atlas"))
    {
        return Ok(());
    }
    fs::create_dir_all(common_dir.join("info"))?;
    let mut text = existing;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str("/.atlas/\n");
    fs::write(&path, text)?;
    Ok(())
}

/// The work-tree root of the repository containing `path` (canonical), if any.
pub fn worktree_root(path: &Path) -> Option<PathBuf> {
    let repo = gix::discover(path).ok()?;
    repo.workdir()?.canonicalize().ok()
}

fn load_valid(dir: &Path, tree_hex: &str) -> Option<BaseIndex> {
    let base = BaseIndex::open(dir).ok()?;
    (base.meta().is_current_scheme() && hex(&base.meta().base_tree) == tree_hex).then_some(base)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl CandidateSource for GrepIndex {
    fn candidates(
        &self,
        req: &GrepRequest,
        cancel: &CancelToken,
    ) -> Option<Arc<dyn CandidateFilter>> {
        if !self.trusted.load(Ordering::Acquire) {
            return None;
        }
        let snap = self.current()?;
        let prefix = self.request_prefix(&req.root)?;
        let query = plan_pattern(&req.pattern, req.literal, req.case_insensitive)?;
        if query == Query::All {
            return None;
        }
        let base_hits = match eval_base(&query, &snap.base) {
            Ok(Cands::Docs(d)) => d,
            Ok(Cands::All) => return None,
            Err(e) => {
                tracing::warn!(target: "atlas_grepindex", "posting lookup failed, scanning instead: {e}");
                return None;
            }
        };
        let base_hits = union(&difference(&base_hits, &snap.masked), snap.base.forced());
        let overlay_hits: HashSet<String> = snap
            .overlay
            .iter()
            .filter(|(_, d)| d.matches(&query))
            .map(|(p, _)| p.clone())
            .collect();
        let docs = snap.base.n_docs() as usize + snap.overlay.len() - snap.masked.len();
        let candidates = base_hits.len() + overlay_hits.len();
        if candidates as f64 > self.opts.max_candidate_ratio * docs as f64 || cancel.is_cancelled()
        {
            return None;
        }
        Some(Arc::new(Filter {
            prefix,
            base: snap.base,
            stamps: snap.stamps,
            overlay: snap.overlay,
            base_hits,
            overlay_hits,
        }))
    }
}

struct Filter {
    prefix: String,
    base: Arc<BaseIndex>,
    stamps: Arc<Vec<Option<FileStamp>>>,
    overlay: Arc<Overlay>,
    base_hits: Vec<u32>,
    overlay_hits: HashSet<String>,
}

impl CandidateFilter for Filter {
    fn must_search(&self, rel: &str, stamp: &dyn Fn() -> Option<FileStamp>) -> bool {
        let path: Cow<'_, str> = if self.prefix.is_empty() {
            Cow::Borrowed(rel)
        } else {
            Cow::Owned(format!("{}{rel}", self.prefix))
        };
        if let Some(doc) = self.overlay.get(path.as_ref()) {
            return self.overlay_hits.contains(path.as_ref())
                || doc.stamp.is_none()
                || doc.stamp != stamp();
        }
        match self.base.doc_id(&path) {
            Some(id) => {
                let known = self.stamps[id as usize];
                self.base_hits.binary_search(&id).is_ok() || known.is_none() || known != stamp()
            }
            // Never indexed (untracked, symlink, submodule, new since the last resync).
            None => true,
        }
    }
}

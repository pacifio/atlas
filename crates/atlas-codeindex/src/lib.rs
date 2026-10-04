//! `atlas-codeindex` v2: a per-project symbol index in SQLite.
//!
//! - **Extraction** (`lang`, `extract`): one tree-sitter cursor walk per file
//!   driven by per-language tables resolved to kind-id bitsets. It yields
//!   definitions with qualified names, parents, ranges, signatures, docs and
//!   export/test flags, plus normalized imports.
//! - **Scan** (`scan`, `skip`): a parallel gitignore-respecting walk; paths
//!   sorted for deterministic row ids; vendored, generated, minified and
//!   oversized files skipped with a reason; extraction on a rayon pool.
//! - **Store** (`store`, `update`): `<root>/.atlas/code-index/index.db`,
//!   schema v1, a stat → BLAKE3 gate so only changed files re-parse.
//! - **Query** (`query`, `docs`): FTS5 BM25 symbol search with exact-name
//!   boosts, outlines, symbol source read from disk, the grep locator, and
//!   file-level docs for the memory corpus.
//!
//! Pure: no Tauri. The app owns the registry, worker thread and watchers.

mod docs;
mod error;
mod extract;
mod lang;
mod query;
mod scan;
mod skip;
mod store;
mod update;

#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};

use rusqlite::Connection;

pub use docs::{read_file_docs, FileDoc, SummaryTarget};
pub use error::IndexError;
pub use lang::Lang;
pub use query::{SymbolHit, SymbolQuery, SymbolSource};
pub use skip::{SkipReason, MAX_FILE_BYTES};
pub use store::{split_name, EXTRACTOR_VERSION, SCHEMA_VERSION};
pub use update::{BuildProgress, BuildStats, IndexStatus, UpdateStats};

use skip::{IgnoreChain, Rules};

/// Idle query connections kept for reuse.
const MAX_IDLE_READERS: usize = 4;

/// One project's code index. Cheap to share behind an `Arc`; every method
/// takes `&self`. Writes serialize on one connection; reads use a small pool.
pub struct CodeIndex {
    inner: Arc<Inner>,
}

pub(crate) struct Inner {
    /// Canonical root, then the root as given (watcher paths may use either).
    roots: [PathBuf; 2],
    writer: Mutex<Connection>,
    readers: Mutex<Vec<Connection>>,
    rules: RwLock<Arc<Rules>>,
    ignore: RwLock<Arc<IgnoreChain>>,
    generation: AtomicU64,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Inner {
    pub(crate) fn with_reader<R>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
    ) -> Result<R, IndexError> {
        let conn = lock(&self.readers).pop();
        let conn = match conn {
            Some(c) => c,
            None => store::open_reader(&self.roots[0])?,
        };
        let out = f(&conn);
        let mut idle = lock(&self.readers);
        if idle.len() < MAX_IDLE_READERS {
            idle.push(conn);
        }
        Ok(out?)
    }
}

impl CodeIndex {
    /// Open (creating if needed) the index of the project at `project_root`.
    /// Also makes sure git ignores `.atlas/` via `.git/info/exclude`.
    /// Does not build: check [`IndexStatus::needs_full_build`].
    pub fn open(project_root: &Path) -> Result<Self, IndexError> {
        let canonical = dunce::canonicalize(project_root)?;
        // Best effort: a read-only `.git` must not stop the index.
        let _ = store::ensure_git_exclude(&canonical);
        let writer = store::open_writer(&canonical)?;
        Ok(Self {
            inner: Arc::new(Inner {
                rules: RwLock::new(Arc::new(Rules::load(&canonical))),
                ignore: RwLock::new(Arc::new(IgnoreChain::new(&canonical))),
                roots: [canonical, project_root.to_path_buf()],
                writer: Mutex::new(writer),
                readers: Mutex::new(Vec::new()),
                generation: AtomicU64::new(1),
            }),
        })
    }

    /// The canonical project root.
    pub fn root(&self) -> &Path {
        &self.inner.roots[0]
    }

    /// Bumped after every write that changed rows; caches key on it.
    pub fn generation(&self) -> u64 {
        self.inner.generation.load(Ordering::SeqCst)
    }

    pub(crate) fn bump(&self) {
        self.inner.generation.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn roots(&self) -> &[PathBuf; 2] {
        &self.inner.roots
    }

    pub(crate) fn writer(&self) -> MutexGuard<'_, Connection> {
        lock(&self.inner.writer)
    }

    pub(crate) fn with_writer<R>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
    ) -> Result<R, IndexError> {
        Ok(f(&self.writer())?)
    }

    pub(crate) fn with_reader<R>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
    ) -> Result<R, IndexError> {
        self.inner.with_reader(f)
    }

    pub(crate) fn rules(&self) -> Arc<Rules> {
        self.inner
            .rules
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn ignore_chain(&self) -> Arc<IgnoreChain> {
        self.inner
            .ignore
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Re-read `.atlasignore` and drop cached gitignore matchers.
    pub(crate) fn reload_rules(&self) {
        let root = self.root();
        *self
            .inner
            .rules
            .write()
            .unwrap_or_else(PoisonError::into_inner) = Arc::new(Rules::load(root));
        *self
            .inner
            .ignore
            .write()
            .unwrap_or_else(PoisonError::into_inner) = Arc::new(IgnoreChain::new(root));
    }
}

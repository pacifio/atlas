//! One usearch HNSW file per model: a projection, never the source of
//! truth. It is saved atomically (temp + rename); opening a missing,
//! corrupt or other-dimension file yields an empty index and says which,
//! so the owner rebuilds it from its cache.
//!
//! The file I/O is Rust's: usearch serializes to and from a buffer. Its own
//! path API opens the path with C `fopen`, which on Windows reads a UTF-8
//! path in the ANSI code page and fails under non-ASCII project folders.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use usearch::{Index, IndexOptions, MetricKind, ScalarKind};

use crate::RetrievalError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Opened {
    /// Read from disk.
    Loaded,
    /// No file yet.
    Fresh,
    /// A file was there but unusable (corrupt, another dimension): empty now.
    Reset,
}

pub struct VectorFile {
    index: Index,
    path: PathBuf,
    dims: usize,
    /// Changed since the last successful [`save`](Self::save): a save that
    /// failed (a file locked on Windows) is retried by the next caller.
    unsaved: AtomicBool,
}

impl VectorFile {
    fn options(dims: usize) -> IndexOptions {
        IndexOptions {
            dimensions: dims,
            metric: MetricKind::Cos,
            quantization: ScalarKind::F16,
            ..Default::default()
        }
    }

    fn fresh(dims: usize) -> Result<Index, RetrievalError> {
        Index::new(&Self::options(dims)).map_err(|e| RetrievalError::Index(e.to_string()))
    }

    fn with(index: Index, path: PathBuf, dims: usize) -> Self {
        Self {
            index,
            path,
            dims,
            unsaved: AtomicBool::new(false),
        }
    }

    pub fn open(path: PathBuf, dims: usize) -> Result<(Self, Opened), RetrievalError> {
        if !path.is_file() {
            return Ok((Self::with(Self::fresh(dims)?, path, dims), Opened::Fresh));
        }
        let index = Self::fresh(dims)?;
        let ok = std::fs::read(&path).is_ok_and(|bytes| index.load_from_buffer(&bytes).is_ok())
            && index.dimensions() == dims;
        if ok {
            Ok((Self::with(index, path, dims), Opened::Loaded))
        } else {
            Ok((Self::with(Self::fresh(dims)?, path, dims), Opened::Reset))
        }
    }

    pub fn add(&self, key: i64, v: &[f32]) -> Result<(), RetrievalError> {
        if v.len() != self.dims {
            return Err(RetrievalError::Index(format!(
                "vector dim {} != {}",
                v.len(),
                self.dims
            )));
        }
        if self.index.size() + 1 > self.index.capacity() {
            self.index
                .reserve((self.index.capacity() * 2).max(1024))
                .map_err(|e| RetrievalError::Index(e.to_string()))?;
        }
        let _ = self.index.remove(key as u64);
        self.unsaved.store(true, Ordering::SeqCst);
        self.index
            .add(key as u64, v)
            .map_err(|e| RetrievalError::Index(e.to_string()))
    }

    pub fn remove(&self, key: i64) {
        if self.index.remove(key as u64).is_ok_and(|n| n > 0) {
            self.unsaved.store(true, Ordering::SeqCst);
        }
    }

    /// Whether the index holds changes [`save`](Self::save) has not written.
    pub fn has_unsaved(&self) -> bool {
        self.unsaved.load(Ordering::SeqCst)
    }

    pub fn contains(&self, key: i64) -> bool {
        self.index.contains(key as u64)
    }

    /// `(key, cosine similarity)`, best first.
    pub fn search(&self, q: &[f32], k: usize) -> Vec<(i64, f32)> {
        if k == 0 || self.index.size() == 0 || q.len() != self.dims {
            return Vec::new();
        }
        match self.index.search(q, k) {
            Ok(m) => m
                .keys
                .iter()
                .zip(m.distances.iter())
                .map(|(&key, &d)| (key as i64, 1.0 - d))
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    pub fn save(&self) -> Result<(), RetrievalError> {
        // Cleared first: a change landing while this writes stays unsaved.
        let was = self.unsaved.swap(false, Ordering::SeqCst);
        let saved = self.write();
        if saved.is_err() && was {
            self.unsaved.store(true, Ordering::SeqCst);
        }
        saved
    }

    fn write(&self) -> Result<(), RetrievalError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut bytes = vec![0; self.index.serialized_length()];
        self.index
            .save_to_buffer(&mut bytes)
            .map_err(|e| RetrievalError::Index(e.to_string()))?;
        let tmp = self.path.with_extension("usearch.tmp");
        let written = std::fs::write(&tmp, &bytes).and_then(|()| std::fs::rename(&tmp, &self.path));
        if written.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        written.map_err(RetrievalError::from)
    }

    pub fn len(&self) -> usize {
        self.index.size()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn dims(&self) -> usize {
        self.dims
    }
}

const _: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<VectorFile>();
};

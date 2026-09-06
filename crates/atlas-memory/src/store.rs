//! `HnswStore` — a thin owner of a persistent [`usearch::Index`] (HNSW).
//!
//! Cersei's `EmbeddingStore`/`VectorIndex` are in-memory only (no save/load/remove —
//! verified in Step 0), so persistence is built directly on `usearch 2.25.3`:
//! `Index::save` / `Index::load` / `Index::remove` (hard deletes). Keys are `u64`;
//! the id↔key bijection lives in [`crate::manifest::Manifest`].
//!
//! Metric is cosine (`MetricKind::Cos`). usearch returns cosine **distance**
//! (`1 - cos_sim`); [`HnswStore::search`] converts that back to a similarity in
//! `[0, 1]`-ish so callers can apply the legacy 0.30 cosine floor.

use std::path::Path;

use anyhow::{anyhow, Result};
use usearch::{Index, IndexOptions, MetricKind, ScalarKind};

/// Owns a usearch HNSW index for one project. `Send + Sync` (usearch's `Index`
/// is), so it can sit behind an `Arc<RwLock<_>>` shared by the retrieve closure
/// (read) and the indexer (write).
pub struct HnswStore {
    index: Index,
    dim: usize,
}

impl HnswStore {
    fn options(dim: usize) -> IndexOptions {
        IndexOptions {
            dimensions: dim,
            metric: MetricKind::Cos,
            // F32: vectors are already L2-normalized f32; keep full precision.
            quantization: ScalarKind::F32,
            ..Default::default()
        }
    }

    /// Create an empty in-memory index for `dim`-dimensional vectors. Nothing
    /// touches disk until [`save`](Self::save).
    pub fn open(dim: usize) -> Result<Self> {
        let index = Index::new(&Self::options(dim)).map_err(|e| anyhow!("usearch new: {e}"))?;
        Ok(Self { index, dim })
    }

    /// Reload a persisted index from `path`, validating its dimensionality.
    pub fn load(path: &Path, dim: usize) -> Result<Self> {
        let index = Index::new(&Self::options(dim)).map_err(|e| anyhow!("usearch new: {e}"))?;
        let p = path.to_str().ok_or_else(|| anyhow!("non-utf8 path"))?;
        index.load(p).map_err(|e| anyhow!("usearch load: {e}"))?;
        let loaded_dim = index.dimensions();
        if loaded_dim != dim {
            return Err(anyhow!(
                "dimension mismatch: index has {loaded_dim}, expected {dim}"
            ));
        }
        Ok(Self { index, dim })
    }

    /// Persist the index to `path` (caller handles atomic temp+rename of the
    /// pair {hnsw, manifest}). Ensures the parent dir exists.
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let p = path.to_str().ok_or_else(|| anyhow!("non-utf8 path"))?;
        self.index.save(p).map_err(|e| anyhow!("usearch save: {e}"))
    }

    /// Number of live vectors.
    pub fn len(&self) -> usize {
        self.index.size()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Insert/overwrite a vector under `key`. Grows reserved capacity as needed
    /// (usearch requires `reserve` before `add`).
    pub fn add(&self, key: u64, vector: &[f32]) -> Result<()> {
        if vector.len() != self.dim {
            return Err(anyhow!(
                "vector dim {} != index dim {}",
                vector.len(),
                self.dim
            ));
        }
        let needed = self.index.size() + 1;
        if needed > self.index.capacity() {
            let cap = needed.max(16).next_power_of_two();
            self.index
                .reserve(cap)
                .map_err(|e| anyhow!("usearch reserve: {e}"))?;
        }
        self.index
            .add(key, vector)
            .map_err(|e| anyhow!("usearch add: {e}"))
    }

    /// Hard-delete a key. Returns the number of vectors removed (0 if absent).
    pub fn remove(&self, key: u64) -> Result<usize> {
        self.index
            .remove(key)
            .map_err(|e| anyhow!("usearch remove: {e}"))
    }

    /// Top-`k` `(key, similarity)` pairs, best first. usearch returns cosine
    /// **distance** (`1 - cos`); we convert to similarity (`1 - distance`).
    pub fn search(&self, query: &[f32], k: usize) -> Result<Vec<(u64, f32)>> {
        if k == 0 || self.is_empty() {
            return Ok(Vec::new());
        }
        let matches = self
            .index
            .search(query, k)
            .map_err(|e| anyhow!("usearch search: {e}"))?;
        Ok(matches
            .keys
            .into_iter()
            .zip(matches.distances)
            .map(|(key, dist)| (key, 1.0 - dist))
            .collect())
    }
}

// Compile-time guarantee the store is shareable across the retrieve/indexer split.
const _: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<HnswStore>();
};

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic unit vector pointing mostly along axis `seed`, so nearest
    /// neighbor is predictable.
    fn unit_vec(seed: usize) -> Vec<f32> {
        let mut v = vec![0.0f32; DIM_TEST];
        v[seed % DIM_TEST] = 1.0;
        // small noise on another axis to keep them distinct but separable
        v[(seed + 1) % DIM_TEST] = 0.01;
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        v.iter().map(|x| x / norm).collect()
    }

    const DIM_TEST: usize = 384;

    fn tmp_path(name: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "atlas-memory-store-{}-{}.usearch",
            std::process::id(),
            name
        ));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn add_save_load_search_roundtrip() {
        let store = HnswStore::open(DIM_TEST).unwrap();
        for i in 0..10u64 {
            store.add(i, &unit_vec(i as usize)).unwrap();
        }
        assert_eq!(store.len(), 10);

        let path = tmp_path("roundtrip");
        store.save(&path).unwrap();

        let reloaded = HnswStore::load(&path, DIM_TEST).unwrap();
        assert_eq!(reloaded.len(), 10);

        // Query near key 5 → key 5 should be the top hit, both before & after reload.
        let q = unit_vec(5);
        let hits = reloaded.search(&q, 3).unwrap();
        assert!(!hits.is_empty());
        assert_eq!(hits[0].0, 5, "nearest key should be 5, got {hits:?}");
        // Cosine similarity of the (near-)identical vector should be ~1.
        assert!(hits[0].1 > 0.9, "similarity too low: {}", hits[0].1);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn remove_drops_key_from_results() {
        let store = HnswStore::open(DIM_TEST).unwrap();
        for i in 0..5u64 {
            store.add(i, &unit_vec(i as usize)).unwrap();
        }
        let q = unit_vec(3);
        let before = store.search(&q, 5).unwrap();
        assert!(before.iter().any(|(k, _)| *k == 3));

        let removed = store.remove(3).unwrap();
        assert_eq!(removed, 1);

        let after = store.search(&q, 5).unwrap();
        assert!(
            !after.iter().any(|(k, _)| *k == 3),
            "key 3 should be gone: {after:?}"
        );
    }
}

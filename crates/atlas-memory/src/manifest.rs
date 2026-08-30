//! `Manifest` — the durable id↔key bookkeeping that sits beside the HNSW file.
//!
//! usearch keys are `u64`, but Atlas doc ids are strings, so the manifest carries
//! the bijection (a `HashMap<String, u64>` + reverse) plus a content-hash per
//! entry to compute incremental `(add, update, delete)` sets against the current
//! corpus. Persisted as `manifest.json` with an **atomic** write (temp + rename)
//! so it never half-writes alongside the HNSW save.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

/// One indexed document's bookkeeping.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub key: u64,
    pub content_hash: String,
    pub corpus: String,
    pub mtime: u64,
}

/// The on-disk manifest. `entries` is the source of truth; the id↔key maps are
/// derived from it on load (and kept in sync as entries/keys are mutated).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub provider_name: String,
    pub dim: usize,
    pub next_key: u64,
    pub entries: Vec<Entry>,

    /// Derived id→key lookup. Rebuilt from `entries` on load; also tracks keys
    /// handed out by `assign_key` before an entry exists.
    #[serde(skip)]
    id_to_key: HashMap<String, u64>,
    /// Derived reverse lookup.
    #[serde(skip)]
    key_to_id: HashMap<u64, String>,
}

/// The result of diffing the current corpus against the manifest.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Diff {
    /// Ids present in the corpus but not in the manifest.
    pub add: Vec<String>,
    /// Ids present in both but whose content hash changed.
    pub update: Vec<String>,
    /// Ids in the manifest no longer present in the corpus.
    pub delete: Vec<String>,
}

impl Manifest {
    /// A fresh, empty manifest for `provider_name` / `dim`.
    pub fn new(provider_name: impl Into<String>, dim: usize) -> Self {
        Self {
            provider_name: provider_name.into(),
            dim,
            next_key: 0,
            entries: Vec::new(),
            id_to_key: HashMap::new(),
            key_to_id: HashMap::new(),
        }
    }

    /// Load from JSON at `path`, rebuilding the derived maps. Missing file is an
    /// error — callers decide whether to fall back to [`Manifest::new`].
    pub fn load(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path).map_err(|e| anyhow!("read manifest: {e}"))?;
        let mut m: Manifest =
            serde_json::from_slice(&bytes).map_err(|e| anyhow!("parse manifest: {e}"))?;
        m.rebuild_index();
        Ok(m)
    }

    /// Atomically persist to JSON at `path`: write `*.tmp`, then `rename` over
    /// the target so a reader never observes a partial file.
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_vec_pretty(self).map_err(|e| anyhow!("serialize: {e}"))?;
        let tmp = tmp_sibling(path);
        std::fs::write(&tmp, &json).map_err(|e| anyhow!("write tmp: {e}"))?;
        std::fs::rename(&tmp, path).map_err(|e| anyhow!("rename: {e}"))?;
        Ok(())
    }

    fn rebuild_index(&mut self) {
        self.id_to_key.clear();
        self.key_to_id.clear();
        let mut max_key = 0u64;
        for e in &self.entries {
            self.id_to_key.insert(e.id.clone(), e.key);
            self.key_to_id.insert(e.key, e.id.clone());
            max_key = max_key.max(e.key + 1);
        }
        // Never hand back a key already used by an entry.
        self.next_key = self.next_key.max(max_key);
    }

    /// Stable, monotonic key assignment: returns the existing key for `id`, or
    /// allocates the next one and bumps `next_key`.
    pub fn assign_key(&mut self, id: &str) -> u64 {
        if let Some(&k) = self.id_to_key.get(id) {
            return k;
        }
        let key = self.next_key;
        self.next_key += 1;
        self.id_to_key.insert(id.to_string(), key);
        self.key_to_id.insert(key, id.to_string());
        key
    }

    /// Key for an id, if one has been assigned.
    pub fn key_for(&self, id: &str) -> Option<u64> {
        self.id_to_key.get(id).copied()
    }

    /// Id for a key, if known.
    pub fn id_for(&self, key: u64) -> Option<&str> {
        self.key_to_id.get(&key).map(std::string::String::as_str)
    }

    /// Insert or update the entry for `id` (assigning a key if needed) and keep
    /// the derived maps in sync. Returns the entry's key.
    pub fn upsert(&mut self, id: &str, content_hash: &str, corpus: &str, mtime: u64) -> u64 {
        let key = self.assign_key(id);
        match self.entries.iter_mut().find(|e| e.id == id) {
            Some(e) => {
                e.content_hash = content_hash.to_string();
                e.corpus = corpus.to_string();
                e.mtime = mtime;
            }
            None => self.entries.push(Entry {
                id: id.to_string(),
                key,
                content_hash: content_hash.to_string(),
                corpus: corpus.to_string(),
                mtime,
            }),
        }
        key
    }

    /// Remove the entry (and its bimap rows) for `id`. Returns its freed key, if
    /// it existed. The key is **not** recycled (`next_key` only grows).
    pub fn remove(&mut self, id: &str) -> Option<u64> {
        let key = self.id_to_key.remove(id)?;
        self.key_to_id.remove(&key);
        self.entries.retain(|e| e.id != id);
        Some(key)
    }

    /// Compute `(add, update, delete)` against the current corpus, expressed as
    /// `(id, content_hash)` pairs. Order within each set is deterministic
    /// (sorted) for stable tests.
    pub fn diff(&self, current: &[(String, String)]) -> Diff {
        let current_map: HashMap<&str, &str> = current
            .iter()
            .map(|(id, h)| (id.as_str(), h.as_str()))
            .collect();
        let existing: HashMap<&str, &str> = self
            .entries
            .iter()
            .map(|e| (e.id.as_str(), e.content_hash.as_str()))
            .collect();

        let mut add = Vec::new();
        let mut update = Vec::new();
        let mut delete = Vec::new();

        for (id, hash) in current {
            match existing.get(id.as_str()) {
                None => add.push(id.clone()),
                Some(&old) if old != hash.as_str() => update.push(id.clone()),
                Some(_) => {}
            }
        }
        for e in &self.entries {
            if !current_map.contains_key(e.id.as_str()) {
                delete.push(e.id.clone());
            }
        }
        add.sort();
        update.sort();
        delete.sort();
        Diff {
            add,
            update,
            delete,
        }
    }
}

/// `<path>.tmp` sibling for atomic writes.
fn tmp_sibling(path: &Path) -> std::path::PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".tmp");
    std::path::PathBuf::from(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("atlas-memory-manifest-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn json_roundtrip_preserves_entries_and_bimap() {
        let mut m = Manifest::new("atlas-minilm-384", 384);
        m.upsert("a", "h1", "codebase", 100);
        m.upsert("b", "h2", "md", 200);
        assert_eq!(m.dim, 384);

        let dir = tmp_dir("roundtrip");
        let path = dir.join("manifest.json");
        m.save(&path).unwrap();

        let loaded = Manifest::load(&path).unwrap();
        assert_eq!(loaded.provider_name, "atlas-minilm-384");
        assert_eq!(loaded.entries.len(), 2);
        // bimap survives reload
        assert_eq!(loaded.key_for("a"), m.key_for("a"));
        assert_eq!(loaded.id_for(loaded.key_for("b").unwrap()), Some("b"));
        // next_key is at least past the highest used key
        assert!(loaded.next_key >= 2);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn assign_key_is_stable_and_monotonic() {
        let mut m = Manifest::new("p", 384);
        let ka1 = m.assign_key("a");
        let kb = m.assign_key("b");
        let ka2 = m.assign_key("a");
        assert_eq!(ka1, ka2, "same id → same key");
        assert!(kb > ka1, "distinct ids → monotonic keys");
        assert_eq!(m.next_key, 2);
    }

    #[test]
    fn diff_computes_add_update_delete() {
        let mut m = Manifest::new("p", 384);
        m.upsert("keep", "h_keep", "c", 1);
        m.upsert("change", "h_old", "c", 1);
        m.upsert("gone", "h_gone", "c", 1);

        let current = vec![
            ("keep".to_string(), "h_keep".to_string()),   // unchanged
            ("change".to_string(), "h_new".to_string()),  // updated
            ("brand_new".to_string(), "h_new".to_string()), // added
        ];
        let d = m.diff(&current);
        assert_eq!(d.add, vec!["brand_new".to_string()]);
        assert_eq!(d.update, vec!["change".to_string()]);
        assert_eq!(d.delete, vec!["gone".to_string()]);
    }

    #[test]
    fn atomic_write_leaves_no_tmp_file() {
        let dir = tmp_dir("atomic");
        let path = dir.join("manifest.json");
        let mut m = Manifest::new("p", 384);
        m.upsert("a", "h", "c", 1);
        m.save(&path).unwrap();

        assert!(path.exists());
        let tmp = tmp_sibling(&path);
        assert!(!tmp.exists(), "stray .tmp left behind: {}", tmp.display());

        std::fs::remove_dir_all(&dir).unwrap();
    }
}

//! `migrate` — one-shot import of the **legacy** on-disk vector index into the
//! new HNSW store, with **zero re-embedding**.
//!
//! The pre-replan memory feature persisted embeddings as a flat JSON blob at
//! `<project>/.atlas/memory-index/index.json` (written by
//! `src-tauri/.../commands/memory_graph.rs`). Those vectors were produced by the
//! same on-device `all-MiniLM-L6-v2` model at 384 dims as [`MiniLmProvider`], so
//! when the model + dim match we can lift the vectors straight into the usearch
//! index and the manifest — no model load, no network, instant upgrade.
//!
//! This crate must NOT depend on `src-tauri`/`atlas-cersei`, so the legacy shape
//! is mirrored here as a **deserialize-only** struct ([`LegacyIndex`]) matching
//! the exact serde field names of the original writer.
//!
//! Idempotency: after a successful import the legacy file is renamed to
//! `index.json.bak`, so a migrated project has no `index.json` left to re-import.
//! [`MemoryEngine::open`] calls [`migrate`] on every open; the rename guarantees
//! it only ever does real work once.

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::Deserialize;

use crate::provider::DIM;
use crate::MemoryEngine;

/// The legacy model name as written by `memory_graph.rs` (`MODEL_NAME`).
const LEGACY_MODEL: &str = "all-MiniLM-L6-v2";

/// One doc in the legacy `index.json`. Mirror of `memory_graph::StoredDoc`
/// (deserialize-only). Extra fields in the file are ignored.
#[derive(Debug, Deserialize)]
struct LegacyDoc {
    id: String,
    hash: String,
    vector: Vec<f32>,
}

/// The legacy on-disk index. Mirror of `memory_graph::StoredIndex`
/// (deserialize-only) — `{ model, dim, docs: [...] }`.
#[derive(Debug, Deserialize)]
struct LegacyIndex {
    model: String,
    dim: usize,
    docs: Vec<LegacyDoc>,
}

/// What [`migrate`] did, so callers (and tests) can branch/log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MigrationOutcome {
    /// No legacy `index.json` present (fresh project, or already migrated).
    NothingToDo,
    /// Imported `count` legacy docs into the HNSW store + manifest.
    Imported { count: usize },
    /// A legacy index exists but its model/dim don't match the current provider,
    /// so its vectors can't be reused. Left in place for a future re-embed.
    NeedsRebuild,
}

fn legacy_index_path(project_root: &std::path::Path) -> PathBuf {
    project_root
        .join(".atlas")
        .join("memory-index")
        .join("index.json")
}

/// Import the legacy `index.json` into `engine`'s HNSW store + manifest with no
/// re-embedding, then archive the legacy file so this never re-runs.
///
/// - Missing file → [`MigrationOutcome::NothingToDo`].
/// - Model/dim mismatch → [`MigrationOutcome::NeedsRebuild`] (file untouched).
/// - Match → add every vector under a freshly-assigned key, upsert the manifest
///   entry (`corpus = "legacy"`), [`MemoryEngine::persist`], and rename the
///   legacy file to `index.json.bak`.
pub fn migrate(engine: &mut MemoryEngine) -> Result<MigrationOutcome> {
    let path = legacy_index_path(&engine.project_root);
    if !path.exists() {
        return Ok(MigrationOutcome::NothingToDo);
    }

    let bytes = std::fs::read(&path).with_context(|| format!("read legacy index {path:?}"))?;
    let legacy: LegacyIndex =
        serde_json::from_slice(&bytes).with_context(|| format!("parse legacy index {path:?}"))?;

    // Only reuse vectors produced by the same model + dimensionality. Anything
    // else would corrupt cosine search, so signal a rebuild and leave the file.
    if legacy.model != LEGACY_MODEL || legacy.dim != DIM {
        tracing::warn!(
            model = %legacy.model,
            dim = legacy.dim,
            "legacy memory index model/dim mismatch; needs rebuild"
        );
        return Ok(MigrationOutcome::NeedsRebuild);
    }

    let mut imported = 0usize;
    for doc in &legacy.docs {
        if doc.vector.len() != DIM {
            // Defensive: a doc whose vector width disagrees with the header dim
            // can't go into the fixed-dim index. Skip it rather than abort.
            tracing::warn!(id = %doc.id, len = doc.vector.len(), "skipping legacy doc with wrong vector dim");
            continue;
        }
        let key = engine.manifest.assign_key(&doc.id);
        engine
            .store
            .add(key, &doc.vector)
            .with_context(|| format!("add legacy vector for {}", doc.id))?;
        // Vectors are already embedded — corpus tag marks their origin so a later
        // rebuild can tell legacy-imported docs from freshly-indexed ones.
        engine.manifest.upsert(&doc.id, &doc.hash, "legacy", 0);
        imported += 1;
    }

    engine.persist().context("persist after legacy migration")?;

    // Archive the legacy file so migration is idempotent (a migrated project has
    // no `index.json` for the next `open` to re-import).
    let bak = path.with_extension("json.bak");
    std::fs::rename(&path, &bak)
        .with_context(|| format!("archive legacy index {path:?} -> {bak:?}"))?;

    Ok(MigrationOutcome::Imported { count: imported })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::Path;

    /// A deterministic L2-normalized 384-d vector pointing mostly along `seed`.
    fn unit_vec(seed: usize) -> Vec<f32> {
        let mut v = vec![0.0f32; DIM];
        v[seed % DIM] = 1.0;
        v[(seed + 7) % DIM] = 0.05;
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        v.iter().map(|x| x / norm).collect()
    }

    fn tmp_root(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "atlas-memory-migrate-{}-{}",
            std::process::id(),
            name
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// Write a legacy `index.json` under `root/.atlas/memory-index/`.
    fn write_legacy(root: &Path, model: &str, dim: usize, docs: &[(&str, &str, Vec<f32>)]) {
        let dir = root.join(".atlas").join("memory-index");
        std::fs::create_dir_all(&dir).unwrap();
        let docs_json: Vec<_> = docs
            .iter()
            .map(|(id, hash, v)| json!({ "id": id, "hash": hash, "vector": v }))
            .collect();
        let blob = json!({ "model": model, "dim": dim, "docs": docs_json });
        std::fs::write(
            dir.join("index.json"),
            serde_json::to_vec(&blob).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn migrates_legacy_index_without_reembedding() {
        let root = tmp_root("happy");
        let va = unit_vec(3);
        let vb = unit_vec(50);
        write_legacy(
            &root,
            LEGACY_MODEL,
            DIM,
            &[("doc-a", "hash-a", va.clone()), ("doc-b", "hash-b", vb)],
        );

        // `open` runs migration internally.
        let engine = MemoryEngine::open(root.clone());

        // Both vectors are searchable and map back to their ids.
        let key_a = engine.manifest.key_for("doc-a").expect("doc-a key");
        let key_b = engine.manifest.key_for("doc-b").expect("doc-b key");
        assert_ne!(key_a, key_b);
        assert_eq!(engine.store.len(), 2);

        let hits = engine.store.search(&va, 1).unwrap();
        assert_eq!(hits[0].0, key_a, "nearest to va should be doc-a's key");
        assert!(hits[0].1 > 0.9, "similarity too low: {}", hits[0].1);

        // Manifest entry carries the legacy hash + corpus tag.
        let entry = engine
            .manifest
            .entries
            .iter()
            .find(|e| e.id == "doc-a")
            .unwrap();
        assert_eq!(entry.content_hash, "hash-a");
        assert_eq!(entry.corpus, "legacy");

        // Legacy file archived → .bak, original gone.
        let mi = root.join(".atlas").join("memory-index");
        assert!(!mi.join("index.json").exists(), "index.json should be gone");
        assert!(mi.join("index.json.bak").exists(), "index.json.bak expected");

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn second_open_is_a_noop() {
        let root = tmp_root("idempotent");
        write_legacy(&root, LEGACY_MODEL, DIM, &[("only", "h", unit_vec(11))]);

        let first = MemoryEngine::open(root.clone());
        assert_eq!(first.store.len(), 1);
        drop(first);

        // Re-open: no index.json to import, store still has exactly the one doc
        // (loaded from persisted hnsw + manifest), no error, no duplicate.
        let second = MemoryEngine::open(root.clone());
        assert_eq!(second.store.len(), 1, "should not re-import");
        assert!(second.manifest.key_for("only").is_some());

        // Calling migrate directly again is a clean no-op.
        let mut third = MemoryEngine::open(root.clone());
        assert_eq!(migrate(&mut third).unwrap(), MigrationOutcome::NothingToDo);

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn mismatched_model_needs_rebuild_and_leaves_file() {
        let root = tmp_root("mismatch");
        // Wrong model name → cannot reuse vectors.
        write_legacy(&root, "some-other-model", DIM, &[("x", "h", unit_vec(1))]);

        let mut engine = MemoryEngine::open(root.clone());
        let outcome = migrate(&mut engine).unwrap();
        assert_eq!(outcome, MigrationOutcome::NeedsRebuild);
        assert_eq!(engine.store.len(), 0, "no vectors imported on mismatch");

        // Legacy file untouched.
        let idx = root.join(".atlas").join("memory-index").join("index.json");
        assert!(idx.exists(), "legacy index.json must remain on mismatch");

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn mismatched_dim_needs_rebuild() {
        let root = tmp_root("dim");
        // Correct model, wrong dim header → rebuild.
        write_legacy(&root, LEGACY_MODEL, 256, &[("x", "h", vec![0.1f32; 256])]);

        let mut engine = MemoryEngine::open(root.clone());
        assert_eq!(migrate(&mut engine).unwrap(), MigrationOutcome::NeedsRebuild);

        std::fs::remove_dir_all(&root).unwrap();
    }
}

//! atlas-memory — Atlas's on-device RAG/memory engine.
//!
//! Per-project engine that owns a persistent **usearch HNSW** index fed by an
//! on-device MiniLM [`provider::MiniLmProvider`] (Cersei's `EmbeddingProvider`
//! trait), plus Cersei **graph memory** for structured facts. Retrieval fuses
//! the two and returns [`RetrievedDoc`]s; the Tauri layer maps those onto
//! `atlas_cersei::MemDoc` so the frozen `MemorySearchFn` seam — and all three
//! agents — are unchanged.
//!
//! This is a LOW crate: it has **no Tauri dependency** and never depends on
//! `atlas-cersei` (the dependency only ever points the other way, app-side).
//!
//! Build order (see `plans/atlas-cersei-rag-replan.md`): the modules below are
//! stubs filled in step by step.

use std::path::PathBuf;

// ─── Modules ─────────────────────────────────────────────────────────────────
// Step 2 (implemented): provider (MiniLmProvider), store (usearch HNSW), manifest.
pub mod manifest;
pub mod provider;
pub mod store;

// Step 3 (implemented): migrate (legacy index.json import, zero re-embedding).
pub mod migrate;

// Step 6 (implemented): docstore (id→display-text side-map) + retrieve (RRF fuse
// of HNSW + graph). `retrieve` only adds an `impl MemoryEngine`, so it is a plain
// child module (private) — it reaches the engine's private fields as a descendant.
pub mod docstore;
mod retrieve;

// Step 7 (implemented): extract (gated session extraction → memdir + graph).
// BYOK-free: the LLM call is injected by the Tauri layer via a closure.
pub mod extract;

// Step 8 (implemented): shared_import (one-time, idempotent fold of the legacy
// `.atlas/shared-memory/events.jsonl` log into graph memory).
pub mod shared_import;

// Step 9a (implemented): consolidate (AutoDream-gated idle consolidation + our
// own memdir prune; the graph has no delete API, so the prune targets the
// extracted/*.md memdir we own — see the module docs).
pub mod consolidate;

// Step 9b (implemented): global cross-project memory under `~/.atlas/memory/`.
// Deterministic, conservative promotion (preference/constraint, conf ≥ 0.8, seen
// in ≥2 distinct projects) fed from `consolidate`, blended into `retrieve` when
// local memory is sparse. Tauri-free; resolves `$HOME` (or an env override).
pub mod global;

pub use consolidate::{consolidate, ConsolidateOutcome};
pub use global::{global_recall, record_candidates, CandidateEntry};
pub use docstore::{DocStore, DocText};
pub use extract::{
    category_to_memory_type, extract_and_store, should_extract, ExtractState, TranscriptTurn,
};
pub use manifest::{Diff, Entry, Manifest};
pub use migrate::{migrate, MigrationOutcome};
pub use provider::{MiniLmProvider, DIM, PROVIDER_NAME};
pub use shared_import::{import_shared_memory, ImportOutcome};
pub use store::HnswStore;

// Step 10: offline 3-agent retrieval-parity tests + an HNSW-vs-brute-force
// micro-benchmark (no live app). The LIVE 3-agent verification is a MANUAL
// runtime step documented in `MIGRATION.md`.
#[cfg(test)]
mod parity_bench;

use cersei_embeddings::EmbeddingProvider;
use cersei_memory::graph::GraphMemory;

/// One corpus document handed to [`MemoryEngine::index_corpus`]. The Tauri layer
/// builds these by flattening `agent_memory::collect_corpus` (Claude/Codex/Cersei
/// memory + codebase index + shared memory) into this neutral shape.
///
/// `content_hash` is the caller's stable hash of the embeddable `text` — the
/// manifest diffs on it, so an unchanged doc is never re-embedded. `corpus` is a
/// free-form origin tag (`"claude"`, `"codebase"`, `"legacy"`, …) recorded on the
/// manifest entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorpusDoc {
    pub id: String,
    pub text: String,
    pub content_hash: String,
    pub corpus: String,
}

/// What one [`MemoryEngine::index_corpus`] pass did, for logging / tests.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct IndexStats {
    /// Docs new to the manifest (embedded + added to HNSW).
    pub added: usize,
    /// Docs whose `content_hash` changed (re-embedded; old vector replaced).
    pub updated: usize,
    /// Docs gone from the corpus (removed from HNSW + manifest).
    pub deleted: usize,
    /// Docs whose hash matched the manifest — skipped, no embedding.
    pub unchanged: usize,
}

/// One retrieved memory snippet. Neutral shape (NOT `atlas_cersei::MemDoc` —
/// this crate must not depend on `atlas-cersei`); the Tauri layer maps it onto
/// `MemDoc` at the `MemorySearchFn` boundary.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RetrievedDoc {
    /// Stable doc id (the corpus id for embedding hits, a synthetic `graph::…`
    /// hash for graph-only hits). Carried so the Tauri layer can dedup site-C
    /// pushes per session; the `MemDoc` seam drops it.
    pub id: String,
    pub title: String,
    pub source: String,
    pub text: String,
}

/// One candidate from a retrieval list this crate does not own (today: the
/// lexical FTS5 tier in `atlas-codeindex`, handed across by the Tauri layer so
/// the two crates never link). `bonus` is the caller-computed IDF + recency
/// tie-break for this doc–query pair; the engine clamps it so a bonus can
/// reorder near-ties but never outvote a rank.
#[derive(Debug, Clone)]
pub struct ExternalHit {
    /// Fusion id. Use the same id the dense corpus uses for the same content
    /// (`code:<rel>#<hash12>`) so a doc found by both lists accumulates rank
    /// contributions instead of appearing twice.
    pub id: String,
    pub title: String,
    pub source: String,
    pub text: String,
    pub bonus: f32,
}

/// Query-time namespace filter — the corpus tag is one store filtered per
/// query, not four indexes. Splitting code and memory into separate RRF lists
/// is also the per-class budget: rank-based fusion means fifty preference
/// facts are never outvoted by thousands of code chunks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetrievalClass {
    /// Everything: code + memory + graph + global.
    All,
    /// Code chunks and codebase summaries only (`search_code`).
    Code,
    /// Memory classes only — facts, notes, sessions (`search_memory`).
    Memory,
}

/// A fused result with its score decomposition — what makes "why did this
/// rank third?" answerable. `score = rrf + bonus`.
#[derive(Debug, Clone)]
pub struct ScoredDoc {
    pub doc: RetrievedDoc,
    pub score: f32,
    /// Accumulated reciprocal-rank contributions across every list.
    pub rrf: f32,
    /// Clamped external bonus (IDF + recency tie-break).
    pub bonus: f32,
}

/// Per-project memory engine. One instance per project root, shared behind an
/// `Arc<RwLock<_>>` by the retrieve closure (read) and the indexer (write).
/// Holds the HNSW store + manifest (graph memory added in later steps).
pub struct MemoryEngine {
    #[allow(dead_code)]
    project_root: PathBuf,
    /// `<project_root>/.atlas/memory/` — created lazily on first persist.
    memory_dir: PathBuf,
    store: HnswStore,
    manifest: Manifest,
    /// id → display text ({title, source, text}), persisted beside the manifest so
    /// retrieval can build [`RetrievedDoc`]s without re-gathering the corpus.
    docstore: DocStore,
    /// Cersei graph memory (relationships / topic tags). **Empty until Steps 7/9a**
    /// populate it; [`retrieve`](Self::retrieve) handles an empty graph as a no-op.
    graph: GraphMemory,
}

impl MemoryEngine {
    /// Open-or-create the engine for a project. Loads the persisted HNSW +
    /// manifest if present under `<project_root>/.atlas/memory/`, otherwise
    /// starts empty (the dir is created lazily on first [`persist`](Self::persist)).
    /// Later steps run legacy migration (Step 3) and load the graph here.
    pub fn open(project_root: PathBuf) -> Self {
        let memory_dir = project_root.join(".atlas").join("memory");
        let manifest_path = memory_dir.join("manifest.json");
        let hnsw_path = memory_dir.join("hnsw.usearch");

        let manifest = Manifest::load(&manifest_path)
            .unwrap_or_else(|_| Manifest::new(PROVIDER_NAME, DIM));

        let docstore =
            DocStore::load(&memory_dir.join("docstore.json")).unwrap_or_else(|_| DocStore::new());

        // Graph memory persists at `<memory_dir>/graph`. Open-or-create the dir
        // first; if Grafeo can't open the path (e.g. a stale/corrupt file), fall
        // back to an in-memory graph so retrieval still works — it's empty until
        // Steps 7/9a populate it, so losing persistence here is non-fatal.
        let graph = open_graph(&memory_dir);

        // Open the store at the dim the manifest recorded — a project rebuilt with
        // a 768-d model reopens at 768, a legacy/fresh project at the 384 default.
        // A model switch is reconciled later by `index_params_match` + `reset_index`.
        let store_dim = manifest.dim;
        let store = if hnsw_path.exists() {
            HnswStore::load(&hnsw_path, store_dim).unwrap_or_else(|e| {
                tracing::warn!("failed to load HNSW index ({e}); starting empty");
                HnswStore::open(store_dim).expect("usearch index create")
            })
        } else {
            HnswStore::open(store_dim).expect("usearch index create")
        };

        let mut engine = Self {
            project_root,
            memory_dir,
            store,
            manifest,
            docstore,
            graph,
        };

        // Step 3: import a legacy `.atlas/memory-index/index.json` (if present)
        // into the HNSW store + manifest with zero re-embedding. Idempotent — a
        // successful import archives the legacy file to `.bak`, so this is a
        // no-op on every subsequent open. A model/dim mismatch leaves the legacy
        // file in place for a future rebuild.
        match migrate::migrate(&mut engine) {
            Ok(migrate::MigrationOutcome::Imported { count }) => {
                tracing::info!(count, "migrated legacy memory index into HNSW store");
            }
            Ok(_) => {}
            Err(e) => tracing::warn!("legacy memory migration failed: {e}"),
        }

        // Step 8: one-time, idempotent fold of the legacy shared cross-agent memory
        // log (`.atlas/shared-memory/events.jsonl`) into graph memory, AFTER the
        // Step-3 index migration so the graph already exists. A marker file makes
        // this a cheap no-op on every subsequent open; the original log is kept in
        // place (readable for one release) for rollback.
        match shared_import::import_shared_memory(&mut engine) {
            Ok(shared_import::ImportOutcome::Imported { count, skipped }) => {
                tracing::info!(count, skipped, "imported legacy shared-memory log into graph");
            }
            Ok(_) => {}
            Err(e) => tracing::warn!("legacy shared-memory import failed: {e}"),
        }

        engine
    }

    /// On-disk memory dir for this project (`<root>/.atlas/memory/`).
    pub fn memory_dir(&self) -> &std::path::Path {
        &self.memory_dir
    }

    /// Read access to the HNSW store (retrieve path).
    pub fn store(&self) -> &HnswStore {
        &self.store
    }

    /// Read access to the project's graph memory (Step 7 session extraction
    /// writes through this under the engine read lock — `GraphMemory`'s writes
    /// are `&self`, so the indexer never needs the write lock just to store an
    /// extracted memory).
    pub fn graph(&self) -> &GraphMemory {
        &self.graph
    }

    /// Mutable access to the manifest (indexer path).
    pub fn manifest_mut(&mut self) -> &mut Manifest {
        &mut self.manifest
    }

    /// Whether this project's index was built with `provider`'s exact model + dim.
    /// The indexer calls this before each pass; a `false` means the user switched
    /// embedding models (or it's a fresh project whose default tag doesn't match),
    /// so the index must be wiped and rebuilt via [`reset_index`](Self::reset_index).
    pub fn index_params_match(&self, provider: &MiniLmProvider) -> bool {
        self.manifest.provider_name == provider.name() && self.manifest.dim == provider.dimensions()
    }

    /// Wipe the embedding index (HNSW + manifest + docstore) and reopen it empty at
    /// `dim`, tagged with `provider_name`. Used when the selected embedding model
    /// changes: a different model produces vectors in a different space (and often a
    /// different dimension), so old vectors are invalid and must be re-embedded. The
    /// graph memory (model-independent text facts) is intentionally left untouched.
    /// The caller re-indexes afterward to repopulate.
    pub fn reset_index(&mut self, provider_name: &str, dim: usize) -> anyhow::Result<()> {
        self.store = HnswStore::open(dim)?;
        self.manifest = Manifest::new(provider_name, dim);
        self.docstore = DocStore::new();
        // Drop the stale on-disk index so a crash before the first re-index can't
        // reload vectors from the old model; persist the fresh empty state.
        let _ = std::fs::remove_file(self.memory_dir.join("hnsw.usearch"));
        self.persist()?;
        tracing::info!(provider_name, dim, "reset memory index for new embedding model");
        Ok(())
    }

    /// Persist HNSW + manifest together under the memory dir, creating it lazily.
    /// The manifest write is atomic (temp + rename); usearch save writes whole.
    pub fn persist(&self) -> anyhow::Result<()> {
        std::fs::create_dir_all(&self.memory_dir)?;
        self.store.save(&self.memory_dir.join("hnsw.usearch"))?;
        self.manifest.save(&self.memory_dir.join("manifest.json"))?;
        self.docstore.save(&self.memory_dir.join("docstore.json"))?;
        Ok(())
    }

    /// Incrementally index `docs` into the HNSW store + manifest, embedding only
    /// what actually changed.
    ///
    /// Diffs `docs` against the current manifest (by `content_hash`), then:
    /// - **add + update** → `provider.embed_batch` the changed texts, assign keys
    ///   via the manifest, and `store.add` (updates first drop the old vector so a
    ///   re-embed never leaves a stale duplicate under the same key);
    /// - **delete** → remove the key from both the manifest and the store.
    ///
    /// Persists HNSW + manifest atomically at the end. Off the hot path: the
    /// indexer task (Step 4) calls this under the engine **write lock**, while the
    /// retrieve closure reads under the read lock.
    pub async fn index_corpus(
        &mut self,
        docs: &[CorpusDoc],
        provider: &MiniLmProvider,
    ) -> anyhow::Result<IndexStats> {
        use std::collections::HashMap;

        // Safety net: the indexer resets the index when the model changes, so this
        // should already hold. Bail rather than corrupt the index if a caller feeds
        // a provider whose dim disagrees with the store.
        if provider.dimensions() != self.manifest.dim {
            anyhow::bail!(
                "embedding dim {} != index dim {} (embedding model changed; reset_index required)",
                provider.dimensions(),
                self.manifest.dim
            );
        }

        let current: Vec<(String, String)> = docs
            .iter()
            .map(|d| (d.id.clone(), d.content_hash.clone()))
            .collect();
        let diff = self.manifest.diff(&current);
        let by_id: HashMap<&str, &CorpusDoc> =
            docs.iter().map(|d| (d.id.as_str(), d)).collect();

        let added = diff.add.len();
        let updated = diff.update.len();
        let deleted = diff.delete.len();
        let unchanged = current.len().saturating_sub(added + updated);

        // Collect the texts to (re)embed for add + update in a stable order.
        let mut embed_ids: Vec<&str> = Vec::with_capacity(added + updated);
        let mut texts: Vec<String> = Vec::with_capacity(added + updated);
        for id in diff.add.iter().chain(diff.update.iter()) {
            if let Some(d) = by_id.get(id.as_str()) {
                embed_ids.push(id.as_str());
                texts.push(d.text.clone());
            }
        }

        if !texts.is_empty() {
            let vecs = provider
                .embed_batch(&texts)
                .await
                .map_err(|e| anyhow::anyhow!("embed_batch failed: {e}"))?;
            if vecs.len() != texts.len() {
                anyhow::bail!(
                    "embedding count mismatch: got {}, expected {}",
                    vecs.len(),
                    texts.len()
                );
            }
            for (id, vec) in embed_ids.iter().zip(vecs.iter()) {
                let Some(doc) = by_id.get(*id) else { continue };
                let key = self.manifest.assign_key(id);
                // An update reuses the same key; drop any prior vector first so
                // usearch never keeps a stale embedding alongside the new one.
                let _ = self.store.remove(key);
                self.store.add(key, vec)?;
                self.manifest.upsert(id, &doc.content_hash, &doc.corpus, 0);
                // Mirror the display text so retrieval can render the doc without
                // re-gathering the corpus. `corpus` is the source tag; title/body
                // are recovered from the folded embed text.
                let (title, body) = docstore::split_embedded(&doc.text);
                self.docstore.upsert(
                    id,
                    DocText {
                        title,
                        source: doc.corpus.clone(),
                        text: body,
                    },
                );
            }
        }

        for id in &diff.delete {
            if let Some(key) = self.manifest.remove(id) {
                let _ = self.store.remove(key);
            }
            self.docstore.remove(id);
        }

        self.persist()?;

        Ok(IndexStats {
            added,
            updated,
            deleted,
            unchanged,
        })
    }

    // `retrieve` (Step 6) is implemented in `retrieve.rs` as an `impl MemoryEngine`.
}

/// Open the per-project graph at `<memory_dir>/graph`, creating the dir first.
/// Falls back to an in-memory graph (with a warning) if the on-disk open fails —
/// the graph is empty until Steps 7/9a populate it, so persistence here is not yet
/// load-bearing and must never block engine construction.
fn open_graph(memory_dir: &std::path::Path) -> GraphMemory {
    let graph_path = memory_dir.join("graph");
    if let Err(e) = std::fs::create_dir_all(memory_dir) {
        tracing::warn!("could not create memory dir for graph ({e}); using in-memory graph");
        return GraphMemory::open_in_memory().expect("in-memory graph");
    }
    match GraphMemory::open(&graph_path) {
        Ok(g) => g,
        Err(e) => {
            tracing::warn!("graph open at {graph_path:?} failed ({e}); using in-memory graph");
            GraphMemory::open_in_memory().expect("in-memory graph")
        }
    }
}

// Compile-time guarantee the engine can sit behind `Arc<RwLock<_>>` shared
// across the retrieve callback and the indexer task (Step 4).
const _: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<MemoryEngine>();
};

#[cfg(test)]
mod index_corpus_tests {
    use super::*;

    fn tmp_root(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "atlas-memory-index-{}-{}",
            std::process::id(),
            name
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn find_model_dir() -> Option<PathBuf> {
        let dir = std::env::var("ATLAS_MINILM_DIR").ok()?;
        let p = PathBuf::from(dir);
        p.join("model.safetensors").exists().then_some(p)
    }

    fn doc(id: &str, text: &str, hash: &str) -> CorpusDoc {
        CorpusDoc {
            id: id.into(),
            text: text.into(),
            content_hash: hash.into(),
            corpus: "test".into(),
        }
    }

    /// The add/update/delete plumbing `index_corpus` performs, exercised against
    /// the manifest + store directly (no model needed). Mirrors the real method's
    /// diff → assign_key → store.add / manifest.upsert / remove sequence, so a
    /// regression in that bookkeeping is caught without an embedder.
    #[test]
    fn diff_drives_manifest_and_store_without_embedding() {
        let root = tmp_root("plumbing");
        let mut engine = MemoryEngine::open(root.clone());

        // Seed: two docs already indexed (simulate a prior pass).
        let v = |seed: usize| -> Vec<f32> {
            let mut x = vec![0.0f32; DIM];
            x[seed % DIM] = 1.0;
            x
        };
        for (i, (id, hash)) in [("a", "h_a"), ("b", "h_b")].iter().enumerate() {
            let key = engine.manifest.assign_key(id);
            engine.store.add(key, &v(i)).unwrap();
            engine.manifest.upsert(id, hash, "test", 0);
        }
        assert_eq!(engine.store.len(), 2);

        // New corpus: "a" unchanged, "b" updated, "c" added, (implicit) nothing deleted.
        let current = vec![
            ("a".to_string(), "h_a".to_string()),
            ("b".to_string(), "h_b2".to_string()),
            ("c".to_string(), "h_c".to_string()),
        ];
        let diff = engine.manifest.diff(&current);
        assert_eq!(diff.add, vec!["c".to_string()]);
        assert_eq!(diff.update, vec!["b".to_string()]);
        assert!(diff.delete.is_empty());

        // Apply add + update exactly like index_corpus (replace old vector on update).
        for (id, seed) in [("b", 9usize), ("c", 10usize)] {
            let key = engine.manifest.assign_key(id);
            let _ = engine.store.remove(key);
            engine.store.add(key, &v(seed)).unwrap();
            engine.manifest.upsert(id, "h_new", "test", 0);
        }
        assert_eq!(engine.store.len(), 3, "c added, b replaced in place");

        // Now drop "a": a delete must clear both manifest + store.
        let current2 = vec![
            ("b".to_string(), "h_new".to_string()),
            ("c".to_string(), "h_new".to_string()),
        ];
        let diff2 = engine.manifest.diff(&current2);
        assert_eq!(diff2.delete, vec!["a".to_string()]);
        for id in &diff2.delete {
            if let Some(key) = engine.manifest.remove(id) {
                engine.store.remove(key).unwrap();
            }
        }
        assert_eq!(engine.store.len(), 2);
        assert!(engine.manifest.key_for("a").is_none());

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// Full `index_corpus` against a real MiniLM model — only runs when
    /// `ATLAS_MINILM_DIR` points at an installed model (skips cleanly otherwise,
    /// no network). Asserts the add/update/delete counts and that re-running with
    /// an identical corpus re-embeds nothing.
    #[test]
    fn index_corpus_end_to_end_when_model_available() {
        let Some(model) = find_model_dir() else {
            eprintln!("skipping: no MiniLM model dir (set ATLAS_MINILM_DIR)");
            return;
        };
        let embedder = atlas_embed::Embedder::load(&model).expect("load MiniLM");
        let provider = MiniLmProvider::new(std::sync::Arc::new(embedder), "all-MiniLM-L6-v2");
        let rt = tokio::runtime::Runtime::new().unwrap();

        let root = tmp_root("e2e");
        let mut engine = MemoryEngine::open(root.clone());

        let docs = vec![
            doc("a", "rust borrow checker notes", "h1"),
            doc("b", "tauri ipc command registration", "h2"),
        ];
        let stats = rt.block_on(engine.index_corpus(&docs, &provider)).unwrap();
        assert_eq!(stats.added, 2);
        assert_eq!(stats.updated, 0);
        assert_eq!(engine.store.len(), 2);

        // Re-run unchanged → no add/update, nothing re-embedded.
        let stats2 = rt.block_on(engine.index_corpus(&docs, &provider)).unwrap();
        assert_eq!(stats2.added, 0);
        assert_eq!(stats2.updated, 0);
        assert_eq!(stats2.unchanged, 2);

        // Change one, drop the other.
        let docs3 = vec![doc("a", "rust lifetimes and the borrow checker", "h1b")];
        let stats3 = rt.block_on(engine.index_corpus(&docs3, &provider)).unwrap();
        assert_eq!(stats3.updated, 1);
        assert_eq!(stats3.deleted, 1);
        assert_eq!(engine.store.len(), 1);

        std::fs::remove_dir_all(&root).unwrap();
    }
}

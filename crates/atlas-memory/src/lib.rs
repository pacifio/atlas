//! atlas-memory — Atlas's on-device RAG/memory engine.
//!
//! Per-project engine that owns a persistent **usearch HNSW** index fed by an
//! on-device MiniLM [`provider::MiniLmProvider`] (the old SDK's `EmbeddingProvider`
//! trait). Retrieval returns [`RetrievedDoc`]s, blending in promoted global
//! memory when local memory is sparse; the Tauri layer maps those onto
//! the old wrapper's `MemDoc` so the frozen `MemorySearchFn` seam — and all three
//! agents — are unchanged. The shared-memory record store (`record`) and the
//! global promotion over it (`global`) live here too.
//!
//! This is a LOW crate: it has **no Tauri dependency** and never depends on
//! the agent seam (the dependency only ever points the other way, app-side).
//!
//! Build order (see `plans/atlas-atlas-agent-rag-replan.md`): the modules below are
//! stubs filled in step by step.

use std::path::PathBuf;

// ─── Modules ─────────────────────────────────────────────────────────────────
// Step 2 (implemented): provider (MiniLmProvider), store (usearch HNSW), manifest.
pub mod manifest;
pub mod provider;
pub mod store;

// Step 6 (implemented): docstore (id→display-text side-map) + retrieve (HNSW,
// with the global blend). `retrieve` adds an `impl MemoryEngine` — a child
// module, so it reaches the engine's private fields as a descendant — and the
// query-term relevance floor and excerpt window `memory_search` shares.
pub mod docstore;
pub mod retrieve;

// The corpus index behind `MemoryEngine`: documents, BM25 and cached vectors
// in `corpus.sqlite`, a per-model vector file that heals from the cache.
pub mod corpus;

// The extractor's gates, prompt and parser (it writes record entries). The LLM
// call is injected by the Tauri layer via a closure.
pub mod extract;

// Global cross-repository memory under `~/.atlas/memory/`. Deterministic,
// conservative promotion over the record table (Fact, conf ≥ 0.8, seen in ≥2
// repositories), blended into `retrieve` when local memory is sparse.
// Tauri-free; resolves `$HOME` (or an env override).
pub mod global;

// Shared memory 03 (#80): the SQLite record store behind the Shared tab — one
// database per repository scope, with the one-time legacy migration.
pub mod record;

// The reconciler's checks and deterministic repairs over the record, and its
// daily snapshot (M2).
pub mod health;

// Evidence for a memory: cited code, checked at read time (M3, ADR-0018).
pub mod citation;

// Idle-time consolidation: merge proposals and contradiction links (M4).
pub mod consolidate;

// The handoff note each finished session leaves for the next agent (M4).
pub mod handoff;

// The dream pass: a daily model review that only proposes (M4).
pub mod dream;

// The Agent Memory Repo line format, for the mirror and its import (M4).
pub mod amr;

// ─── Ported-from-the-old-SDK modules ───────────────────────────────────────────────
//
// These were the old SDK's embeddings and memory crates until 2026-08-22; they are
// now Atlas's own. `tests/behaviour.rs` pins their observable behaviour (it
// was written against the SDK versions and passed unchanged after the port).
pub mod embedding;
pub mod session;

pub use docstore::{DocStore, DocText};
pub use extract::{
    extract, parse_extracted, should_extract, ExtractState, Extracted, TranscriptTurn, Trigger,
};
pub use global::{global_recall, promote_facts, CandidateEntry};
pub use manifest::{Diff, Entry, Manifest};
pub use provider::{MiniLmProvider, DIM, PROVIDER_NAME};
pub use store::HnswStore;

// Step 10: offline 3-agent retrieval-parity tests + an HNSW-vs-brute-force
// micro-benchmark (no live app). The LIVE 3-agent verification is a MANUAL
// runtime step documented in `MIGRATION.md`.
#[cfg(test)]
mod parity_bench;

use embedding::EmbeddingProvider;

/// One corpus document handed to [`MemoryEngine::index_corpus`]. The Tauri layer
/// builds these by flattening `agent_memory::collect_corpus` (Claude/Codex/native
/// memory + codebase index + shared memory) into this neutral shape.
///
/// `content_hash` is the caller's stable hash of the embeddable `text` — the
/// manifest diffs on it, so an unchanged doc is never re-embedded. `corpus` is a
/// free-form origin tag (`"claude"`, `"codebase"`, `"note"`, …) recorded on the
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

/// One retrieved memory snippet. Neutral shape (NOT the old wrapper's `MemDoc` —
/// this crate must not depend on the agent seam); the Tauri layer maps it onto
/// `MemDoc` at the `MemorySearchFn` boundary.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RetrievedDoc {
    /// Stable doc id (the corpus id for embedding hits, a synthetic `global::…`
    /// hash for global hits). Carried so the Tauri layer can dedup site-C
    /// pushes per session; the `MemDoc` seam drops it.
    pub id: String,
    pub title: String,
    pub source: String,
    pub text: String,
}

/// Per-project memory engine. One instance per project root, shared behind an
/// `Arc<RwLock<_>>` by the retrieve closure (read) and the indexer (write).
/// Holds the corpus index (`corpus.sqlite` + a per-model vector file).
pub struct MemoryEngine {
    #[allow(dead_code)]
    project_root: PathBuf,
    /// `<project_root>/.atlas/memory/`.
    memory_dir: PathBuf,
    corpus: corpus::CorpusIndex,
}

/// What a corpus health pass did.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusHealth {
    /// Vectors a rebuild of the vector file wrote (0 when it was in step).
    pub rebuilt_vectors: usize,
    pub rebuilt_fts: bool,
    /// The database was damaged and started again on open.
    pub recreated: bool,
}

impl MemoryEngine {
    /// Open-or-create the engine for a project: the corpus index under
    /// `<project_root>/.atlas/memory/`, its vector file healed from the cache.
    /// Never fails: an unwritable project dir indexes into a per-process temp
    /// dir instead (rebuilt next launch).
    pub fn open(project_root: PathBuf) -> Self {
        let memory_dir = atlas_profile::dir_in(&project_root).join("memory");
        let corpus = corpus::CorpusIndex::open(&memory_dir).unwrap_or_else(|e| {
            tracing::warn!(
                target: "atlas_memory",
                "corpus index at {} unavailable ({e:#}); using a temp index",
                memory_dir.display()
            );
            let fallback =
                std::env::temp_dir().join(format!("atlas-corpus-{}", std::process::id()));
            corpus::CorpusIndex::open(&fallback).expect("a corpus index in the temp dir")
        });
        Self {
            project_root,
            memory_dir,
            corpus,
        }
    }

    /// On-disk memory dir for this project (`<root>/.atlas/memory/`).
    pub fn memory_dir(&self) -> &std::path::Path {
        &self.memory_dir
    }

    /// Whether this project's index is on `provider`'s exact model + dim.
    /// The indexer calls this before each pass; a `false` means the user
    /// switched embedding models, so the index must move to the new one via
    /// [`reset_index`](Self::reset_index).
    pub fn index_params_match(&self, provider: &MiniLmProvider) -> bool {
        self.corpus.model() == provider.name() && self.corpus.dims() == provider.dimensions()
    }

    /// Point the index at another embedding model. The docs stay; vectors the
    /// model already cached come back at once, the rest are embedded by the
    /// next pass. Switching back to an earlier model re-embeds nothing.
    pub fn reset_index(&mut self, provider_name: &str, dim: usize) -> anyhow::Result<()> {
        self.corpus.switch_model(provider_name, dim)?;
        tracing::info!(provider_name, dim, "memory index on a new embedding model");
        Ok(())
    }

    /// Remove one document from the index, immediately.
    ///
    /// [`Self::index_corpus`] only deletes by diffing a freshly gathered corpus
    /// against the index, so a record deleted between two passes stays
    /// searchable until the next pass runs. `memory_forget` is documented as
    /// deleting an entry, and a delete that reports success while its text is
    /// still retrievable is not one — so the forget path evicts here rather
    /// than waiting for a pass to notice the record is gone.
    ///
    /// Returns whether the document was indexed at all.
    pub fn evict(&mut self, doc_id: &str) -> anyhow::Result<bool> {
        self.corpus.evict(doc_id)
    }

    /// Kept for callers of the file-based index: every write is transactional
    /// now, so there is nothing left to flush.
    pub fn persist(&self) -> anyhow::Result<()> {
        Ok(())
    }

    /// Incrementally index `docs` (the whole corpus), embedding only texts
    /// whose vector the cache does not hold for the current model. Docs gone
    /// from `docs` are removed. Off the hot path: the indexer calls this
    /// under the engine **write lock**, while retrieval reads under the read
    /// lock.
    pub async fn index_corpus(
        &mut self,
        docs: &[CorpusDoc],
        provider: &MiniLmProvider,
    ) -> anyhow::Result<IndexStats> {
        use std::collections::HashMap;

        // Safety net: the indexer moves the index when the model changes, so
        // this should already hold. Bail rather than mix vector spaces.
        if provider.dimensions() != self.corpus.dims() {
            anyhow::bail!(
                "embedding dim {} != index dim {} (embedding model changed; reset_index required)",
                provider.dimensions(),
                self.corpus.dims()
            );
        }
        let plan = self.corpus.plan(docs)?;
        let by_id: HashMap<&str, &CorpusDoc> = docs.iter().map(|d| (d.id.as_str(), d)).collect();
        let ids: Vec<&String> = plan
            .need_embed
            .iter()
            .filter(|id| by_id.contains_key(id.as_str()))
            .collect();
        let texts: Vec<String> = ids
            .iter()
            .filter_map(|id| by_id.get(id.as_str()).map(|d| d.text.clone()))
            .collect();
        let mut fresh = HashMap::new();
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
            fresh = ids.into_iter().cloned().zip(vecs).collect();
        }
        if plan.upsert.is_empty() && plan.delete.is_empty() {
            return Ok(IndexStats {
                unchanged: plan.unchanged,
                ..IndexStats::default()
            });
        }
        self.corpus.apply(&plan, docs, &fresh)
    }

    /// The cached vector for `id` while its indexed content still hashes to
    /// `content_hash`; `None` when the doc is unindexed or its content changed.
    /// Lets Memory ▸ Graph and the Policy view reuse the index instead of
    /// re-embedding.
    pub fn cached_vector(&self, id: &str, content_hash: &str) -> Option<Vec<f32>> {
        self.corpus.vector(id, content_hash)
    }

    /// Add docs the caller has already embedded (Memory ▸ Graph embeds what the
    /// indexer has not reached yet), replacing any prior vector for the same
    /// id. Unlike [`index_corpus`](Self::index_corpus) this never deletes docs
    /// missing from `docs`.
    pub fn add_embedded(&mut self, docs: &[(CorpusDoc, Vec<f32>)]) -> anyhow::Result<()> {
        let mut fresh = std::collections::HashMap::new();
        let mut upsert = Vec::with_capacity(docs.len());
        for (doc, vector) in docs {
            if vector.len() != self.corpus.dims() {
                anyhow::bail!(
                    "embedding dim {} != index dim {}",
                    vector.len(),
                    self.corpus.dims()
                );
            }
            upsert.push(doc.id.clone());
            fresh.insert(doc.id.clone(), vector.clone());
        }
        let plan = corpus::Plan {
            upsert,
            delete: vec![],
            need_embed: vec![],
            unchanged: 0,
        };
        let docs: Vec<CorpusDoc> = docs.iter().map(|(d, _)| d.clone()).collect();
        self.corpus.apply(&plan, &docs, &fresh)?;
        Ok(())
    }

    /// Top-`k` `(doc id, similarity)` for an already-embedded query, best first,
    /// skipping docs whose corpus is in `exclude_corpora`. Memory ▸ Graph's
    /// natural-language query.
    pub fn search_ids(
        &self,
        query: &[f32],
        k: usize,
        exclude_corpora: &[&str],
    ) -> anyhow::Result<Vec<(String, f32)>> {
        let total = self.corpus.len();
        // Excluded corpora can dominate the index, so widen the search until
        // `k` eligible hits survive the filter or the whole index has been
        // ranked — rather than always scanning everything.
        let mut fetch = (k * 4).max(32);
        loop {
            let fetch_now = fetch.min(total.max(1));
            let hits: Vec<(String, f32)> = self
                .corpus
                .search_dense(query, fetch_now)
                .into_iter()
                .filter(|(id, _)| {
                    self.corpus
                        .corpus_of(id)
                        .is_none_or(|c| !exclude_corpora.contains(&c.as_str()))
                })
                .take(k)
                .collect();
            if hits.len() >= k || fetch_now >= total {
                return Ok(hits);
            }
            fetch = fetch.saturating_mul(4);
        }
    }

    /// The corpus side of the reconciler: the vector file against the cache,
    /// FTS against the docs, and whether the database was started again.
    pub fn heal(&mut self) -> anyhow::Result<CorpusHealth> {
        Ok(CorpusHealth {
            rebuilt_vectors: self.corpus.heal()?,
            rebuilt_fts: self.corpus.repair_fts()?,
            recreated: std::mem::take(&mut self.corpus.recreated),
        })
    }

    // `retrieve` (Step 6) is implemented in `retrieve.rs` as an `impl MemoryEngine`.
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

    /// A fresh temp dir. Keep the `TempDir` alive for the test: dropping it
    /// deletes the directory, panic or not.
    fn tmp_root(name: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("atlas-memory-{name}-"))
            .tempdir()
            .unwrap();
        let path = dir.path().to_path_buf();
        (dir, path)
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

    fn axis(seed: usize) -> Vec<f32> {
        let mut x = vec![0.0f32; DIM];
        x[seed % DIM] = 1.0;
        x
    }

    fn engine_with_two(root: &std::path::Path) -> MemoryEngine {
        let mut engine = MemoryEngine::open(root.to_path_buf());
        engine
            .add_embedded(&[
                (
                    doc("note:a", "Alpha\n\nalpha body about tokens", "h_a"),
                    axis(1),
                ),
                (
                    doc("note:b", "Beta\n\nbeta body about deploys", "h_b"),
                    axis(2),
                ),
            ])
            .unwrap();
        engine
    }

    /// The Memory ▸ Graph view embeds docs the indexer hasn't reached yet and
    /// hands those vectors back, so neither it nor the indexer embeds them again.
    #[test]
    fn embedded_docs_are_reused_only_while_their_content_is_unchanged() {
        let (_tmp, root) = tmp_root("reuse");
        let mut engine = MemoryEngine::open(root.clone());
        engine
            .add_embedded(&[(doc("note:a", "Title\n\nbody a", "h_a"), axis(3))])
            .unwrap();

        assert_eq!(engine.cached_vector("note:a", "h_a"), Some(axis(3)));
        assert_eq!(
            engine.cached_vector("note:a", "h_changed"),
            None,
            "stale content"
        );
        assert_eq!(engine.cached_vector("note:missing", "h_a"), None);

        // Durable: a reopened engine still has it, and plans no re-embed.
        drop(engine);
        let reopened = MemoryEngine::open(root);
        assert_eq!(reopened.cached_vector("note:a", "h_a"), Some(axis(3)));
        let plan = reopened
            .corpus
            .plan(&[doc("note:a", "Title\n\nbody a", "h_a")])
            .unwrap();
        assert!(plan.upsert.is_empty() && plan.need_embed.is_empty());
        assert_eq!(plan.unchanged, 1);
    }

    /// `memory_forget` deletes the record; the indexed document has to go with
    /// it. Leaving the text behind is a delete that reports success while the
    /// content is still searchable, which is the whole of #292.
    #[test]
    fn evicting_a_document_removes_its_vector_and_its_text_for_good() {
        let (_tmp, root) = tmp_root("evict");
        let mut engine = MemoryEngine::open(root.clone());
        engine
            .add_embedded(&[
                (
                    doc("shared:fact:44", "Keep me\n\nstill true", "h_keep"),
                    axis(1),
                ),
                (
                    doc("shared:fact:45", "Forget me\n\nQUOKKA-9042", "h_gone"),
                    axis(2),
                ),
            ])
            .unwrap();

        assert!(engine.evict("shared:fact:45").unwrap());
        assert!(
            !engine.evict("shared:fact:45").unwrap(),
            "a second evict has nothing to remove"
        );
        assert!(engine.corpus.doc("shared:fact:45").is_none());
        assert!(engine.corpus.search_bm25("QUOKKA", 5).unwrap().is_empty());
        assert!(
            engine.corpus.doc("shared:fact:44").is_some(),
            "the neighbour is untouched"
        );

        // And it stays gone, rather than coming back from disk on reopen.
        drop(engine);
        let reopened = MemoryEngine::open(root);
        assert!(reopened.corpus.doc("shared:fact:45").is_none());
        assert!(reopened.corpus.doc("shared:fact:44").is_some());
        assert!(reopened
            .search_ids(&axis(2), 1, &[])
            .unwrap()
            .iter()
            .all(|(id, _)| id != "shared:fact:45"));
    }

    /// Adding the Graph's vectors never drops docs the indexer already holds
    /// (unlike `index_corpus`, which deletes whatever the given corpus lacks).
    #[test]
    fn adding_embedded_docs_keeps_everything_else() {
        let (_tmp, root) = tmp_root("keep");
        let mut engine = MemoryEngine::open(root);
        engine
            .add_embedded(&[(doc("codebase:src/a.rs", "a", "h1"), axis(1))])
            .unwrap();
        engine
            .add_embedded(&[(doc("note:b", "b", "h2"), axis(2))])
            .unwrap();
        assert_eq!(
            engine.cached_vector("codebase:src/a.rs", "h1"),
            Some(axis(1))
        );
        assert_eq!(engine.cached_vector("note:b", "h2"), Some(axis(2)));

        // Re-adding with new content replaces the vector in place.
        engine
            .add_embedded(&[(doc("note:b", "b2", "h3"), axis(9))])
            .unwrap();
        assert_eq!(engine.cached_vector("note:b", "h3"), Some(axis(9)));
        assert_eq!(engine.corpus.len(), 2);
    }

    /// Natural-language query over the indexed memory: best first, by doc id,
    /// skipping the corpora the caller excludes.
    #[test]
    fn search_ids_ranks_docs_and_skips_excluded_corpora() {
        let (_tmp, root) = tmp_root("search");
        let mut engine = MemoryEngine::open(root);
        let mut near_code = doc("codebase:src/x.rs", "x", "hx");
        near_code.corpus = "codebase".into();
        let mut note = doc("note:y", "y", "hy");
        note.corpus = "note".into();
        let mut claude = doc("claude:z", "z", "hz");
        claude.corpus = "claude".into();
        let mut v_note = axis(5);
        v_note[6] = 0.4;
        engine
            .add_embedded(&[(near_code, axis(5)), (note, v_note), (claude, axis(40))])
            .unwrap();

        let hits = engine.search_ids(&axis(5), 2, &["codebase"]).unwrap();
        let ids: Vec<&str> = hits.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids, vec!["note:y", "claude:z"]);
        assert!(hits[0].1 > hits[1].1);
    }

    /// A torn or truncated vector file (a crash mid-save, a sync tool) is
    /// rebuilt from the cache on open, without the model: retrieval is never
    /// silently empty because a projection broke (M0 D4, folded into M1).
    #[test]
    fn a_corrupt_vector_file_heals_from_the_cache_without_a_model() {
        let (_tmp, root) = tmp_root("heal");
        drop(engine_with_two(&root));
        let file = std::fs::read_dir(atlas_profile::dir_in(&root).join("memory"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.extension().is_some_and(|x| x == "usearch"))
            .expect("a corpus vector file");
        std::fs::write(&file, b"torn").unwrap();
        let engine = MemoryEngine::open(root);
        assert_eq!(
            engine.search_ids(&axis(1), 1, &[]).unwrap()[0].0,
            "note:a",
            "rebuilt from embed_cache"
        );
    }

    #[test]
    fn legacy_index_files_are_dropped_on_first_open() {
        let (_tmp, root) = tmp_root("legacy");
        let dir = atlas_profile::dir_in(&root).join("memory");
        std::fs::create_dir_all(&dir).unwrap();
        for f in ["hnsw.usearch", "manifest.json", "docstore.json"] {
            std::fs::write(dir.join(f), b"{}").unwrap();
        }
        let _ = MemoryEngine::open(root);
        for f in ["hnsw.usearch", "manifest.json", "docstore.json"] {
            assert!(
                !dir.join(f).exists(),
                "{f} is derived and replaced by corpus.sqlite"
            );
        }
    }

    #[test]
    fn a_model_switch_keeps_docs_and_reuses_cached_vectors() {
        let (_tmp, root) = tmp_root("switch");
        let mut engine = engine_with_two(&root);
        engine.reset_index("other-model", 4).unwrap();
        assert!(
            engine
                .search_ids(&[1.0, 0.0, 0.0, 0.0], 1, &[])
                .unwrap()
                .is_empty(),
            "no vectors for the new model yet"
        );
        assert_eq!(engine.corpus.len(), 2, "the docs stay");
        engine.reset_index(PROVIDER_NAME, DIM).unwrap();
        assert_eq!(
            engine.search_ids(&axis(2), 1, &[]).unwrap()[0].0,
            "note:b",
            "back to the old model: cached"
        );
        assert!(engine.cached_vector("note:b", "h_b").is_some());
    }

    #[test]
    fn bm25_finds_corpus_docs_by_their_words() {
        let (_tmp, root) = tmp_root("bm25");
        let engine = engine_with_two(&root);
        let got = engine.retrieve_with_vector("deploys body", None, 5, &root.join("no-global"));
        assert_eq!(got[0].id, "note:b");
    }

    /// Full `index_corpus` against a real MiniLM model. Ignored by default; run
    /// with `ATLAS_MINILM_DIR` pointing at an installed model and `--ignored`
    /// (no network). Asserts the add/update/delete counts and that re-running
    /// with an identical corpus re-embeds nothing.
    #[test]
    #[ignore = "needs ATLAS_MINILM_DIR"]
    fn index_corpus_end_to_end_when_model_available() {
        let model = find_model_dir().expect("set ATLAS_MINILM_DIR to a MiniLM model dir");
        let embedder = atlas_embed::Embedder::load(&model).expect("load MiniLM");
        let provider = MiniLmProvider::new(std::sync::Arc::new(embedder), "all-MiniLM-L6-v2");
        let rt = tokio::runtime::Runtime::new().unwrap();

        let (_tmp, root) = tmp_root("e2e");
        let mut engine = MemoryEngine::open(root);

        let docs = vec![
            doc("a", "rust borrow checker notes", "h1"),
            doc("b", "tauri ipc command registration", "h2"),
        ];
        let stats = rt.block_on(engine.index_corpus(&docs, &provider)).unwrap();
        assert_eq!(stats.added, 2);
        assert_eq!(stats.updated, 0);
        assert_eq!(engine.corpus.len(), 2);

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
        assert_eq!(engine.corpus.len(), 1);
    }
}

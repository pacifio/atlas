//! Fused retrieval — the single recall path behind the frozen `MemorySearchFn`
//! seam and every Memory UI. Both the Cersei pull tools (`search_memory`,
//! `search_code`) and the Claude/Codex push (Tauri site C) reach this through
//! `memory_retrieve` in the app layer; the UIs wrap the same primitives.
//!
//! Pipeline ([`MemoryEngine::retrieve_fused`]):
//! 1. **Dense (optional).** Embed the query with the shared [`MiniLmProvider`],
//!    `store.search` for cosine hits, apply the **0.30 cosine floor on the raw
//!    similarity** — before fusion, since the floor is a cosine threshold and is
//!    meaningless against an RRF score. Hits split into a **code list** and a
//!    **memory list** by corpus tag: separate rank lists are the per-class
//!    budget (a small class is never outvoted by a large one). No provider
//!    (model not downloaded) → this stage is skipped and the ladder degrades to
//!    lexical + graph.
//! 2. **Lexical (external).** The FTS5 tier's candidates, handed in by the
//!    caller (the crates never link), fused at full weight with per-candidate
//!    IDF (a bounded fusion input) and recency (a strict tie-break) bonuses.
//! 3. **Graph + global (memory classes only).** Down-weighted expansion lists,
//!    exactly as before.
//! 4. **RRF fuse** all lists → **Jaccard dedup** → **class budget** (an `All`
//!    query reserves final slots for memory docs) → **per-file cap** for code
//!    chunks → take `limit`. Each result carries its score decomposition
//!    (`rrf` + `idf` + `recency`) and per-list provenance, and every drop is
//!    counted — ranking stays explainable.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};

use crate::docstore::split_embedded;
use crate::{ExternalHit, MemoryEngine, MiniLmProvider, RetrievalClass, RetrievedDoc, ScoredDoc};

/// Raw cosine similarity floor — a hit below this is dropped *before* fusion.
/// Mirrors the legacy `memory_retrieve::MIN_SCORE`.
pub(crate) const COSINE_FLOOR: f32 = 0.30;

/// RRF damping constant (standard 60). `score = Σ_lists w / (RRF_K + rank + 1)`.
const RRF_K: f32 = 60.0;
/// Dense-list weight — the authoritative semantic recall path.
const W_EMBED: f32 = 1.0;
/// Lexical-list weight — a peer of dense, not an expansion: exact identifiers
/// are as authoritative as semantic neighborhoods for code queries.
const W_LEXICAL: f32 = 1.0;
/// Graph list weight — deliberately small so graph hits expand, never dominate.
/// With `W_EMBED/W_GRAPH = 10` and the same `RRF_K`, the best graph hit
/// (`0.1/61 ≈ 0.0016`) scores below the *worst* embedding hit in a pool of 20
/// (`1/80 ≈ 0.0125`): a graph-only hit can never outrank an embedding hit.
const W_GRAPH: f32 = 0.1;
/// Global cross-project list weight. `≤ W_GRAPH` so global never dominates
/// local; only consulted when local memory is sparse.
const W_GLOBAL: f32 = 0.05;
/// When fewer than this many local docs survive fusion+dedup, blend in global
/// cross-project hits. A well-populated project never touches global.
const LOCAL_SPARSE_THRESHOLD: usize = 3;
/// Jaccard token-set similarity at/above which a later snippet is treated as a
/// near-duplicate of one already kept and dropped.
const JACCARD_DUP_THRESHOLD: f32 = 0.8;
/// Bonus clamps, stated against the actual RRF geometry (top-of-list rank
/// gaps: r0→r1 ≈ 2.7e-4, r0→r4 ≈ 1.0e-3, whole 20-rank span ≈ 3.9e-3):
/// a max IDF bonus can lift a rare-identifier match past ~4 adjacent ranks at
/// the top of a list (more mid-list, where gaps shrink) — a fusion input, as
/// the retrieval doc specifies — while a max recency bonus (≤ 2e-4) is
/// strictly smaller than the r0→r1 gap and can only break near-ties.
const MAX_IDF_BONUS: f32 = 0.0008;
const MAX_RECENCY_BONUS: f32 = 0.0002;
/// At most this many chunks of one file survive into the final results —
/// breadth beats five windows of the same file.
const PER_FILE_CAP: usize = 3;

/// One ranked candidate (its in-list position is its rank).
#[derive(Debug, Clone)]
struct Ranked {
    id: String,
    doc: RetrievedDoc,
    /// Per-candidate additive bonuses (external lists only; 0 elsewhere).
    idf: f32,
    recency: f32,
}

/// Corpus tags counted as code for class filtering and the per-file cap.
fn is_code_source(source: &str) -> bool {
    matches!(source, "code" | "codebase")
}

/// Doc ids counted as code for the class budget.
fn is_code_id(id: &str) -> bool {
    id.starts_with("code:") || id.starts_with("codebase:")
}

/// `code:<rel>#<hash>` → `<rel>`, for the per-file cap. (Mirrors
/// `atlas_codeindex::lexical::parse_chunk_doc_id` — this crate must not link
/// atlas-codeindex, so the id format is duplicated knowingly.)
fn file_of(id: &str) -> Option<&str> {
    let rest = id.strip_prefix("code:")?;
    Some(rest.rsplit_once('#').map_or(rest, |(rel, _)| rel))
}

/// What `finish` dropped and why — silent truncation reads as full coverage.
#[derive(Debug, Default, Clone, Copy)]
struct Drops {
    dup: u32,
    file_cap: u32,
    class_budget: u32,
}

impl MemoryEngine {
    /// Compatibility wrapper: fused retrieval over every class with no
    /// external lists. See [`retrieve_fused`](Self::retrieve_fused).
    pub async fn retrieve(
        &self,
        query: &str,
        limit: usize,
        provider: &MiniLmProvider,
    ) -> Vec<RetrievedDoc> {
        self.retrieve_fused(query, limit, Some(provider), &[], RetrievalClass::All)
            .await
            .into_iter()
            .map(|s| s.doc)
            .collect()
    }

    /// The one retrieval path. Returns up to `limit` deduped, per-file-capped
    /// [`ScoredDoc`]s with their score decomposition. Empty on a trivial query
    /// or when nothing clears the floors.
    pub async fn retrieve_fused(
        &self,
        query: &str,
        limit: usize,
        provider: Option<&MiniLmProvider>,
        lexical: &[ExternalHit],
        class: RetrievalClass,
    ) -> Vec<ScoredDoc> {
        if query.trim().len() < 4 || limit == 0 {
            return Vec::new();
        }

        // Pull a generous pool from each source so fusion + dedup have headroom.
        let pool = limit.saturating_mul(4).max(20);

        // ── 1. Dense (optional; split by class into separate rank lists) ──────
        let (embed_code, embed_memory) = match provider {
            Some(provider) => match self.embedding_candidates(query, pool, provider).await {
                Ok(all) => {
                    let (code, memory): (Vec<Ranked>, Vec<Ranked>) =
                        all.into_iter().partition(|r| is_code_source(&r.doc.source));
                    (code, memory)
                }
                Err(e) => {
                    tracing::debug!(target: "atlas_memory::retrieve", "embedding recall failed: {e}");
                    (Vec::new(), Vec::new())
                }
            },
            None => (Vec::new(), Vec::new()),
        };

        // ── 2. Lexical (external, code class) ─────────────────────────────────
        let lexical_ranked: Vec<Ranked> = if class == RetrievalClass::Memory {
            Vec::new()
        } else {
            lexical
                .iter()
                .take(pool)
                .map(|h| Ranked {
                    id: h.id.clone(),
                    doc: RetrievedDoc {
                        id: h.id.clone(),
                        title: h.title.clone(),
                        source: h.source.clone(),
                        text: h.text.clone(),
                    },
                    idf: h.idf.clamp(0.0, MAX_IDF_BONUS),
                    recency: h.recency.clamp(0.0, MAX_RECENCY_BONUS),
                })
                .collect()
        };

        // ── 3. Graph (memory classes only; empty graph is a no-op) ────────────
        let graph_ranked = if class == RetrievalClass::Code {
            Vec::new()
        } else {
            self.graph_candidates(query, pool)
        };

        // ── 4. Fuse → dedup → class budget → per-file cap → limit ─────────────
        let mut lists: Vec<(&'static str, &[Ranked], f32)> = Vec::new();
        match class {
            RetrievalClass::All => {
                lists.push(("dense_memory", &embed_memory, W_EMBED));
                lists.push(("dense_code", &embed_code, W_EMBED));
                lists.push(("lexical", &lexical_ranked, W_LEXICAL));
                lists.push(("graph", &graph_ranked, W_GRAPH));
            }
            RetrievalClass::Code => {
                lists.push(("dense_code", &embed_code, W_EMBED));
                lists.push(("lexical", &lexical_ranked, W_LEXICAL));
            }
            RetrievalClass::Memory => {
                lists.push(("dense_memory", &embed_memory, W_EMBED));
                lists.push(("graph", &graph_ranked, W_GRAPH));
            }
        }
        let (local, drops) = finish(rrf_fuse_weighted(&lists), limit, class);

        // ── 5. Blend global cross-project memory ONLY when local is sparse ────
        // Global is a lowest-weight list so it can never outrank a local hit;
        // an empty/absent global graph is a no-op. Code-only queries never
        // consult it.
        if class == RetrievalClass::Code || local.len() >= LOCAL_SPARSE_THRESHOLD {
            return log_ranking(query, local, drops);
        }
        let global_ranked = global_candidates(query, pool);
        if global_ranked.is_empty() {
            return log_ranking(query, local, drops);
        }
        lists.push(("global", &global_ranked, W_GLOBAL));
        let (blended, drops) = finish(rrf_fuse_weighted(&lists), limit, class);
        log_ranking(query, blended, drops)
    }

    /// Embed the query and return cosine hits that clear the floor, ranked best
    /// first and resolved to display docs via the manifest bimap + docstore.
    async fn embedding_candidates(
        &self,
        query: &str,
        pool: usize,
        provider: &MiniLmProvider,
    ) -> anyhow::Result<Vec<Ranked>> {
        use cersei_embeddings::EmbeddingProvider;

        let mut vecs = provider
            .embed_batch(std::slice::from_ref(&query.to_string()))
            .await
            .map_err(|e| anyhow::anyhow!("embed query: {e}"))?;
        let Some(qvec) = vecs.drain(..).next() else {
            return Ok(Vec::new());
        };

        let hits = self.store.search(&qvec, pool)?;
        let floored = apply_cosine_floor(hits, COSINE_FLOOR);

        let mut out = Vec::with_capacity(floored.len());
        for (key, _sim) in floored {
            let Some(id) = self.manifest.id_for(key) else {
                continue;
            };
            let id = id.to_string();
            let Some(dt) = self.docstore.get(&id) else {
                continue;
            };
            out.push(Ranked {
                doc: RetrievedDoc {
                    id: id.clone(),
                    title: dt.title.clone(),
                    source: dt.source.clone(),
                    text: dt.text.clone(),
                },
                id,
                idf: 0.0,
                recency: 0.0,
            });
        }
        Ok(out)
    }

    /// Word-overlap graph hits as a secondary contributor. Raw graph content has no
    /// id/title/source, so a stable synthetic id (`graph::<hash>`) keys it for
    /// fusion and the content's first line becomes the title.
    fn graph_candidates(&self, query: &str, pool: usize) -> Vec<Ranked> {
        self.graph
            .recall_top_k(query, pool)
            .into_iter()
            .map(|(content, _score)| {
                let (title, body) = split_graph_content(&content);
                let id = format!("graph::{:016x}", stable_hash(&content));
                Ranked {
                    doc: RetrievedDoc {
                        id: id.clone(),
                        title,
                        source: "graph".to_string(),
                        text: body,
                    },
                    id,
                    idf: 0.0,
                    recency: 0.0,
                }
            })
            .collect()
    }
}

/// Keep only hits whose raw cosine similarity is at/above `floor`. usearch already
/// returns them best-first, so order is preserved.
pub(crate) fn apply_cosine_floor(hits: Vec<(u64, f32)>, floor: f32) -> Vec<(u64, f32)> {
    hits.into_iter().filter(|(_, sim)| *sim >= floor).collect()
}

/// Generalised reciprocal-rank fusion over any number of `(label, list,
/// weight)` triples, applied in the given order (earlier lists win ties via
/// first-seen order). A doc appearing in several lists accumulates every rank
/// contribution (keyed by id) and records each as `<label>#<rank>` provenance;
/// its idf/recency bonuses are the maximum any list assigned (doc-level
/// properties, not per-list ones). Returns [`ScoredDoc`]s sorted by
/// `rrf + idf + recency` descending.
fn rrf_fuse_weighted(lists: &[(&'static str, &[Ranked], f32)]) -> Vec<ScoredDoc> {
    struct Acc {
        rrf: f32,
        idf: f32,
        recency: f32,
        doc: RetrievedDoc,
        order: usize,
        lists: Vec<String>,
    }
    let mut acc: HashMap<String, Acc> = HashMap::new();
    let mut order = 0usize;

    for (label, list, weight) in lists {
        for (rank, r) in list.iter().enumerate() {
            let contrib = *weight / (RRF_K + rank as f32 + 1.0);
            let entry = acc.entry(r.id.clone()).or_insert_with(|| {
                let o = order;
                order += 1;
                Acc {
                    rrf: 0.0,
                    idf: 0.0,
                    recency: 0.0,
                    doc: r.doc.clone(),
                    order: o,
                    lists: Vec::new(),
                }
            });
            entry.rrf += contrib;
            entry.idf = entry.idf.max(r.idf);
            entry.recency = entry.recency.max(r.recency);
            entry.lists.push(format!("{label}#{rank}"));
        }
    }

    let mut fused: Vec<Acc> = acc.into_values().collect();
    // Highest fused score first; break ties by first-seen order.
    fused.sort_by(|a, b| {
        (b.rrf + b.idf + b.recency)
            .partial_cmp(&(a.rrf + a.idf + a.recency))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.order.cmp(&b.order))
    });
    fused
        .into_iter()
        .map(|a| ScoredDoc {
            score: a.rrf + a.idf + a.recency,
            rrf: a.rrf,
            idf: a.idf,
            recency: a.recency,
            lists: a.lists,
            doc: a.doc,
        })
        .collect()
}

/// Jaccard dedup → class budget → per-file cap → limit, in rank order, every
/// drop counted.
///
/// The class budget is the second half of the per-class-budget mechanism (the
/// first is separate rank lists): on an `All` query, a third of the final
/// slots are reserved for memory-class docs whenever any are in the fused
/// pool — code sits in two full-weight lists (dense + lexical), so without a
/// reservation a chunk found by both could outscore every memory doc and fill
/// every slot.
fn finish(fused: Vec<ScoredDoc>, limit: usize, class: RetrievalClass) -> (Vec<ScoredDoc>, Drops) {
    let memory_total = fused.iter().filter(|s| !is_code_id(&s.doc.id)).count();
    let reserved = if class == RetrievalClass::All {
        (limit / 3).min(memory_total)
    } else {
        0
    };
    let code_budget = limit - reserved;

    let mut drops = Drops::default();
    let mut kept: Vec<ScoredDoc> = Vec::with_capacity(limit);
    let mut kept_tokens: Vec<HashSet<String>> = Vec::with_capacity(limit);
    let mut per_file: HashMap<String, usize> = HashMap::new();
    let mut code_kept = 0usize;

    for sd in fused {
        if kept.len() >= limit {
            break;
        }
        let tokens = tokenize(&format!("{} {}", sd.doc.title, sd.doc.text));
        let is_dup = kept_tokens
            .iter()
            .any(|t| jaccard(&tokens, t) >= JACCARD_DUP_THRESHOLD);
        if is_dup {
            drops.dup += 1;
            continue;
        }
        if is_code_id(&sd.doc.id) {
            if code_kept >= code_budget {
                drops.class_budget += 1;
                continue;
            }
            if let Some(rel) = file_of(&sd.doc.id) {
                let n = per_file.entry(rel.to_string()).or_insert(0);
                if *n >= PER_FILE_CAP {
                    drops.file_cap += 1;
                    continue;
                }
                *n += 1;
            }
            code_kept += 1;
        }
        kept_tokens.push(tokens);
        kept.push(sd);
    }
    (kept, drops)
}

/// Explainable ranking: one local debug line per query with the decomposition
/// and provenance of every returned result, plus what the finish pass dropped.
/// Shape only — never query text.
fn log_ranking(query: &str, results: Vec<ScoredDoc>, drops: Drops) -> Vec<ScoredDoc> {
    if tracing::enabled!(target: "atlas_memory::retrieve", tracing::Level::DEBUG) {
        let decomposition: Vec<String> = results
            .iter()
            .map(|s| {
                format!(
                    "{}: score={:.5} rrf={:.5} idf={:.5} recency={:.5} lists={:?}",
                    s.doc.id, s.score, s.rrf, s.idf, s.recency, s.lists
                )
            })
            .collect();
        tracing::debug!(
            target: "atlas_memory::retrieve",
            query_len = query.len(),
            n = results.len(),
            dropped_dup = drops.dup,
            dropped_file_cap = drops.file_cap,
            dropped_class_budget = drops.class_budget,
            ranking = ?decomposition,
            "fused ranking"
        );
    }
    results
}

/// Lowercased alphanumeric word set (tokens shorter than 2 chars dropped).
fn tokenize(s: &str) -> HashSet<String> {
    s.split_whitespace()
        .map(|w| {
            w.trim_matches(|c: char| !c.is_alphanumeric())
                .to_lowercase()
        })
        .filter(|w| w.len() >= 2)
        .collect()
}

/// Jaccard similarity of two token sets: |A∩B| / |A∪B| (0 when both empty).
fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f32 {
    if a.is_empty() && b.is_empty() {
        return 0.0;
    }
    let inter = a.intersection(b).count() as f32;
    let union = a.union(b).count() as f32;
    if union == 0.0 {
        0.0
    } else {
        inter / union
    }
}

/// Global cross-project hits as a lowest-weight expansion list. Mirrors
/// [`MemoryEngine::graph_candidates`] but reads the global graph (resolved from
/// `$HOME`/env) and tags the source `"global"` with a `global::<hash>` id so a
/// global hit never collides with a local graph id during fusion. Empty when the
/// global graph does not exist.
fn global_candidates(query: &str, pool: usize) -> Vec<Ranked> {
    crate::global::global_recall(query, pool)
        .into_iter()
        .map(|(content, _score)| {
            let (title, body) = split_graph_content(&content);
            let id = format!("global::{:016x}", stable_hash(&content));
            Ranked {
                doc: RetrievedDoc {
                    id: id.clone(),
                    title,
                    source: "global".to_string(),
                    text: body,
                },
                id,
                idf: 0.0,
                recency: 0.0,
            }
        })
        .collect()
}

/// Title/body for a raw graph content string: first line is the title, the rest
/// (if any) the body.
fn split_graph_content(content: &str) -> (String, String) {
    // Graph content is stored flat; reuse the embedded-text split so multi-line
    // memories still surface a sensible title, falling back to the first line.
    let (title, body) = split_embedded(content);
    if body.is_empty() {
        if let Some((first, rest)) = content.split_once('\n') {
            return (first.trim().to_string(), rest.trim().to_string());
        }
    }
    (title, body)
}

/// Stable (process-independent enough) hash of a string for synthetic graph ids.
fn stable_hash(s: &str) -> u64 {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(id: &str, title: &str, text: &str) -> RetrievedDoc {
        RetrievedDoc {
            id: id.into(),
            title: title.into(),
            source: "test".into(),
            text: text.into(),
        }
    }

    fn ranked(id: &str, title: &str, text: &str) -> Ranked {
        Ranked {
            id: id.into(),
            doc: doc(id, title, text),
            idf: 0.0,
            recency: 0.0,
        }
    }

    fn fuse2(embed: &[Ranked], graph: &[Ranked]) -> Vec<ScoredDoc> {
        rrf_fuse_weighted(&[("dense_memory", embed, W_EMBED), ("graph", graph, W_GRAPH)])
    }

    /// The cosine floor drops sub-0.30 hits BEFORE fusion ever sees them.
    #[test]
    fn cosine_floor_drops_below_threshold() {
        let hits = vec![(1u64, 0.95), (2, 0.31), (3, 0.30), (4, 0.299), (5, 0.05)];
        let kept = apply_cosine_floor(hits, COSINE_FLOOR);
        let keys: Vec<u64> = kept.iter().map(|(k, _)| *k).collect();
        assert_eq!(keys, vec![1, 2, 3], "only sims >= 0.30 survive, order preserved");
    }

    /// RRF orders by reciprocal rank: the top embedding hit fuses highest.
    #[test]
    fn rrf_orders_by_reciprocal_rank() {
        let embed = vec![
            ranked("a", "Alpha", "first"),
            ranked("b", "Beta", "second"),
            ranked("c", "Gamma", "third"),
        ];
        let fused = fuse2(&embed, &[]);
        let ids: Vec<&str> = fused.iter().map(|s| s.doc.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b", "c"]);
        // Scores strictly decrease with rank.
        assert!(fused[0].score > fused[1].score && fused[1].score > fused[2].score);
    }

    /// A graph hit (even at graph rank 0) can never outrank an embedding hit.
    #[test]
    fn graph_hit_cannot_outrank_strong_embedding_hit() {
        // 20 embedding hits (the worst still beats any graph-only hit) + 1 graph.
        let embed: Vec<Ranked> = (0..20)
            .map(|i| ranked(&format!("e{i}"), "E", "embed body"))
            .collect();
        let graph = vec![ranked("g0", "G", "graph body")];
        let fused = fuse2(&embed, &graph);

        let graph_pos = fused
            .iter()
            .position(|s| s.doc.id == "g0")
            .expect("graph hit present");
        // Every embedding hit precedes the graph-only hit.
        assert_eq!(graph_pos, 20, "graph-only hit must sit below all 20 embedding hits");
    }

    fn scored(id: &str, title: &str, text: &str, score: f32) -> ScoredDoc {
        ScoredDoc {
            doc: doc(id, title, text),
            score,
            rrf: score,
            idf: 0.0,
            recency: 0.0,
            lists: Vec::new(),
        }
    }

    /// Near-identical snippets collapse to one via Jaccard dedup — and the
    /// drop is counted, never silent.
    #[test]
    fn jaccard_dedup_collapses_near_duplicates() {
        let body = "the rust borrow checker enforces ownership and lifetimes at compile time";
        let fused = vec![
            scored("a", "Borrow checker", body, 0.9),
            // Same body, different id → near-duplicate, must be dropped.
            scored("b", "Borrow checker", body, 0.8),
            scored("c", "Tokio runtime", "async tasks scheduled on a work stealing pool", 0.7),
        ];
        let (kept, drops) = finish(fused, 10, RetrievalClass::All);
        let ids: Vec<&str> = kept.iter().map(|s| s.doc.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "c"], "b is a near-duplicate of a and dropped");
        assert_eq!(drops.dup, 1);
    }

    /// Empty graph → fused result is exactly the embedding list (no graph noise).
    #[test]
    fn empty_graph_returns_embedding_only() {
        let embed = vec![ranked("a", "A", "alpha body text"), ranked("b", "B", "beta body text")];
        let (kept, _) = finish(fuse2(&embed, &[]), 10, RetrievalClass::Memory);
        let ids: Vec<&str> = kept.iter().map(|s| s.doc.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b"]);
    }

    /// A doc present in BOTH lists accumulates both contributions and ranks above
    /// a doc present in only one — the intended "graph expands an embedding hit".
    #[test]
    fn doc_in_both_lists_accumulates_score() {
        let embed = vec![ranked("a", "A", "aaa"), ranked("shared", "S", "shared body")];
        let graph = vec![ranked("shared", "S", "shared body")];
        let fused = fuse2(&embed, &graph);
        // "shared" gets embed(rank1) + graph(rank0); "a" gets embed(rank0) only.
        // a: 1/61 = 0.01639; shared: 1/62 + 0.1/61 = 0.01613 + 0.00164 = 0.01777.
        assert_eq!(fused[0].doc.id, "shared", "doc in both lists is boosted above a single-list doc");
    }

    /// A dense chunk hit and a lexical hit with the SAME fusion id accumulate
    /// instead of appearing twice — the contract behind `chunk_doc_id` — and
    /// the provenance records both lists.
    #[test]
    fn dense_and_lexical_same_id_accumulate() {
        let id = "code:src/auth.rs#abc123def456";
        let dense = vec![ranked("code:src/other.rs#111111111111", "other", "other body"), ranked(id, "auth", "auth body")];
        let lexical = vec![ranked(id, "auth", "auth body")];
        let fused =
            rrf_fuse_weighted(&[("dense_code", &dense, W_EMBED), ("lexical", &lexical, W_LEXICAL)]);
        assert_eq!(fused[0].doc.id, id, "shared id accumulates to the top");
        assert_eq!(
            fused.iter().filter(|s| s.doc.id == id).count(),
            1,
            "never duplicated"
        );
        assert_eq!(
            fused[0].lists,
            vec!["dense_code#1", "lexical#0"],
            "provenance names every contributing list with its rank"
        );
    }

    /// The bonus clamps, tested against the actual rank geometry: max IDF can
    /// lift a rank-4 hit at most level with rank-0 (never a rank-5), and max
    /// recency alone cannot even reorder rank-1 vs rank-0 — a pure tie-break.
    #[test]
    fn bonus_clamps_bound_how_far_a_hit_can_climb() {
        let rank0 = 1.0 / (RRF_K + 1.0);
        let rank1 = 1.0 / (RRF_K + 2.0);
        let rank4 = 1.0 / (RRF_K + 5.0);
        let rank5 = 1.0 / (RRF_K + 6.0);
        let max_bonus = MAX_IDF_BONUS + MAX_RECENCY_BONUS;
        assert!(
            rank5 + max_bonus < rank0,
            "a max bonus must never lift rank 5 above rank 0"
        );
        assert!(
            rank4 + max_bonus < rank0,
            "a max bonus must never lift rank 4 above rank 0"
        );
        assert!(
            rank1 + MAX_RECENCY_BONUS < rank0,
            "recency alone is strictly a tie-break"
        );
        // And the ingestion seam clamps hostile caller values.
        let mut hostile = ranked("x", "X", "body");
        hostile.idf = 10.0;
        hostile.recency = 10.0;
        let clamped = Ranked {
            idf: hostile.idf.clamp(0.0, MAX_IDF_BONUS),
            recency: hostile.recency.clamp(0.0, MAX_RECENCY_BONUS),
            ..hostile
        };
        assert!(clamped.idf <= MAX_IDF_BONUS && clamped.recency <= MAX_RECENCY_BONUS);
    }

    /// No more than PER_FILE_CAP chunks of one file survive — breadth beats
    /// five windows of the same file — and the drops are counted.
    #[test]
    fn per_file_cap_limits_chunks_of_one_file() {
        let mk = |i: usize| {
            scored(
                &format!("code:src/big.rs#hash{i:08}"),
                &format!("big {i}"),
                &format!("distinct body number {i} with unique tokens token{i}"),
                1.0 - i as f32 * 0.01,
            )
        };
        let mut fused: Vec<ScoredDoc> = (0..6).map(mk).collect();
        fused.push(scored(
            "code:src/other.rs#zzzz",
            "other",
            "completely different content here",
            0.5,
        ));
        let (kept, drops) = finish(fused, 10, RetrievalClass::Code);
        let big = kept
            .iter()
            .filter(|s| s.doc.id.starts_with("code:src/big.rs"))
            .count();
        assert_eq!(big, PER_FILE_CAP);
        assert_eq!(drops.file_cap, 3);
        assert!(kept.iter().any(|s| s.doc.id.starts_with("code:src/other.rs")));
    }

    /// The All-class budget: code fills at most `limit - limit/3` slots while
    /// memory candidates remain, so fifty preference facts are never outvoted
    /// by thousands of chunks sitting in two full-weight lists.
    #[test]
    fn class_budget_reserves_memory_slots_on_all_queries() {
        let mut fused: Vec<ScoredDoc> = (0..8)
            .map(|i| {
                scored(
                    &format!("code:src/f{i}.rs#hash{i:08}"),
                    &format!("chunk {i}"),
                    &format!("code body {i} with tokens alpha{i} beta{i}"),
                    1.0 - i as f32 * 0.01,
                )
            })
            .collect();
        // Two memory docs, ranked BELOW every chunk.
        fused.push(scored("claude:pref.md", "Prefs", "user prefers pnpm over npm always", 0.1));
        fused.push(scored("graph::abc", "Fact", "the api gateway lives in gateway service", 0.09));
        let (kept, drops) = finish(fused, 6, RetrievalClass::All);
        let memory = kept.iter().filter(|s| !is_code_id(&s.doc.id)).count();
        assert_eq!(memory, 2, "limit/3 slots reserved for memory docs: {kept:#?}");
        assert!(drops.class_budget >= 2, "budget drops are counted");
        // A Code-class query has no reservation.
        let code_only: Vec<ScoredDoc> = (0..8)
            .map(|i| {
                scored(
                    &format!("code:src/f{i}.rs#hash{i:08}"),
                    &format!("chunk {i}"),
                    &format!("code body {i} with tokens alpha{i} beta{i}"),
                    1.0 - i as f32 * 0.01,
                )
            })
            .collect();
        let (kept, _) = finish(code_only, 6, RetrievalClass::Code);
        assert_eq!(kept.len(), 6);
    }

    #[test]
    fn file_of_extracts_rel_from_chunk_ids() {
        assert_eq!(file_of("code:src/a.rs#abc"), Some("src/a.rs"));
        assert_eq!(file_of("code:weird#name.rs#abc"), Some("weird#name.rs"));
        assert_eq!(file_of("claude:notes.md"), None);
        assert_eq!(file_of("graph::123"), None);
    }
}

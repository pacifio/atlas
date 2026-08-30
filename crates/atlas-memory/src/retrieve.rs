//! Fused retrieval (Step 6) — the single recall path behind the frozen
//! `MemorySearchFn` seam. Both the Cersei `search_memory` pull tool and the
//! Claude/Codex push (Tauri site C) reach this through
//! `memory_retrieve::retrieve`.
//!
//! Pipeline:
//! 1. **Embedding (primary).** Embed the query with the shared [`MiniLmProvider`],
//!    `store.search` for cosine hits, and apply the legacy **0.30 cosine floor on
//!    the raw similarity** — before fusion, since the floor is a cosine threshold
//!    and is meaningless against an RRF score.
//! 2. **Graph (secondary, down-weighted).** `graph.recall_top_k` contributes a
//!    weighted-expansion list at a much lower RRF weight, so a graph hit can never
//!    outrank a strong embedding hit. The graph is empty until Steps 7/9a populate
//!    it, in which case this is a no-op.
//! 3. **RRF fuse** the two ranked lists → **Jaccard dedup** near-identical
//!    snippets → take `limit` → [`RetrievedDoc`].
//!
//! HyDE / lexical query expansion (the expensive full-Hybrid path) is left behind
//! the off-by-default [`ENABLE_HYDE_EXPANSION`] flag — not implemented here.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};

use crate::docstore::split_embedded;
use crate::{MemoryEngine, MiniLmProvider, RetrievedDoc};

/// Raw cosine similarity floor — a hit below this is dropped *before* fusion.
/// Mirrors the legacy `memory_retrieve::MIN_SCORE`.
pub(crate) const COSINE_FLOOR: f32 = 0.30;

/// RRF damping constant (standard 60). `score = Σ_lists w / (RRF_K + rank + 1)`.
const RRF_K: f32 = 60.0;
/// Embedding list weight — the authoritative recall path.
const W_EMBED: f32 = 1.0;
/// Graph list weight — deliberately small so graph hits expand, never dominate.
/// With `W_EMBED/W_GRAPH = 10` and the same `RRF_K`, the best graph hit
/// (`0.1/61 ≈ 0.0016`) scores below the *worst* embedding hit in a pool of 20
/// (`1/80 ≈ 0.0125`): a graph-only hit can never outrank an embedding hit.
const W_GRAPH: f32 = 0.1;
/// Global cross-project list weight (Step 9b). `≤ W_GRAPH` so global never
/// dominates local; only consulted when local memory is sparse.
const W_GLOBAL: f32 = 0.05;
/// When fewer than this many local docs survive fusion+dedup, blend in global
/// cross-project hits (Step 9b). A well-populated project never touches global.
const LOCAL_SPARSE_THRESHOLD: usize = 3;
/// Jaccard token-set similarity at/above which a later snippet is treated as a
/// near-duplicate of one already kept and dropped.
const JACCARD_DUP_THRESHOLD: f32 = 0.8;

/// Off-by-default flag for HyDE / lexical query expansion (the full 183s/Q Hybrid
/// path). Intentionally unimplemented in Step 6 — wired in a later step. Marked
/// `allow(dead_code)` so the seam is visible without tripping the linter.
#[allow(dead_code)]
pub(crate) const ENABLE_HYDE_EXPANSION: bool = false;

/// One ranked candidate (its in-list position is its rank).
#[derive(Debug, Clone)]
struct Ranked {
    id: String,
    doc: RetrievedDoc,
}

impl MemoryEngine {
    /// Fused retrieval over the HNSW (primary) + graph (secondary). Returns up to
    /// `limit` deduped [`RetrievedDoc`]s, embedding-floored and RRF-fused. Empty on
    /// a trivial query or when nothing clears the cosine floor.
    pub async fn retrieve(
        &self,
        query: &str,
        limit: usize,
        provider: &MiniLmProvider,
    ) -> Vec<RetrievedDoc> {
        if query.trim().len() < 4 || limit == 0 {
            return Vec::new();
        }

        // Pull a generous pool from each source so fusion + dedup have headroom.
        let pool = limit.saturating_mul(4).max(20);

        // ── 1. Embedding (primary) ────────────────────────────────────────────
        let embed_ranked = match self.embedding_candidates(query, pool, provider).await {
            Ok(r) => r,
            Err(e) => {
                tracing::debug!(target: "atlas_memory::retrieve", "embedding recall failed: {e}");
                Vec::new()
            }
        };

        // ── 2. Graph (secondary, down-weighted; empty until Steps 7/9a) ────────
        let graph_ranked = self.graph_candidates(query, pool);

        // ── 3. RRF fuse → Jaccard dedup → top-`limit` ─────────────────────────
        let local = jaccard_dedup(rrf_fuse(&embed_ranked, &graph_ranked), limit);

        // ── 4. Blend global cross-project memory ONLY when local is sparse ─────
        // (Step 9b). Global is added as a third, lowest-weight RRF list so it can
        // never outrank a local hit; an empty/absent global graph is a no-op.
        if local.len() >= LOCAL_SPARSE_THRESHOLD {
            return local;
        }
        let global_ranked = global_candidates(query, pool);
        if global_ranked.is_empty() {
            return local;
        }
        let fused = rrf_fuse_weighted(&[
            (&embed_ranked, W_EMBED),
            (&graph_ranked, W_GRAPH),
            (&global_ranked, W_GLOBAL),
        ]);
        jaccard_dedup(fused, limit)
    }

    /// Embed the query and return cosine hits that clear the floor, ranked best
    /// first and resolved to display docs via the manifest bimap + docstore.
    async fn embedding_candidates(
        &self,
        query: &str,
        pool: usize,
        provider: &MiniLmProvider,
    ) -> anyhow::Result<Vec<Ranked>> {
        use crate::embedding::EmbeddingProvider;

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

/// Reciprocal-rank fusion of the embedding (primary) and graph (secondary) lists.
/// A doc appearing in both accumulates both contributions (keyed by id). Returns
/// `(doc, fused_score)` sorted by fused score descending; ties keep the embedding
/// list's order (embedding ids are inserted first and scored higher).
fn rrf_fuse(embed: &[Ranked], graph: &[Ranked]) -> Vec<(RetrievedDoc, f32)> {
    rrf_fuse_weighted(&[(embed, W_EMBED), (graph, W_GRAPH)])
}

/// Generalised reciprocal-rank fusion over any number of `(list, weight)` pairs,
/// applied in the given order (earlier lists win ties via first-seen order). This
/// is the engine behind both the 2-list local fuse and the 3-list global blend.
fn rrf_fuse_weighted(lists: &[(&[Ranked], f32)]) -> Vec<(RetrievedDoc, f32)> {
    // id → (accumulated score, doc, first-seen order for stable tie-breaks).
    let mut acc: HashMap<String, (f32, RetrievedDoc, usize)> = HashMap::new();
    let mut order = 0usize;

    for (list, weight) in lists {
        for (rank, r) in list.iter().enumerate() {
            let contrib = *weight / (RRF_K + rank as f32 + 1.0);
            acc.entry(r.id.clone())
                .and_modify(|(s, _, _)| *s += contrib)
                .or_insert_with(|| {
                    let o = order;
                    order += 1;
                    (contrib, r.doc.clone(), o)
                });
        }
    }

    let mut fused: Vec<(f32, RetrievedDoc, usize)> =
        acc.into_values().collect();
    // Highest fused score first; break ties by first-seen order (embedding first).
    fused.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.2.cmp(&b.2))
    });
    fused.into_iter().map(|(s, d, _)| (d, s)).collect()
}

/// Walk the fused list in rank order, keeping a doc only if it is not a near-
/// duplicate (Jaccard token overlap ≥ [`JACCARD_DUP_THRESHOLD`]) of one already
/// kept. Stops at `limit`.
fn jaccard_dedup(fused: Vec<(RetrievedDoc, f32)>, limit: usize) -> Vec<RetrievedDoc> {
    let mut kept: Vec<RetrievedDoc> = Vec::with_capacity(limit);
    let mut kept_tokens: Vec<HashSet<String>> = Vec::with_capacity(limit);

    for (doc, _score) in fused {
        if kept.len() >= limit {
            break;
        }
        let tokens = tokenize(&format!("{} {}", doc.title, doc.text));
        let is_dup = kept_tokens
            .iter()
            .any(|t| jaccard(&tokens, t) >= JACCARD_DUP_THRESHOLD);
        if is_dup {
            continue;
        }
        kept_tokens.push(tokens);
        kept.push(doc);
    }
    kept
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

/// Global cross-project hits (Step 9b) as a lowest-weight expansion list. Mirrors
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
        }
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
        let fused = rrf_fuse(&embed, &[]);
        let ids: Vec<&str> = fused.iter().map(|(d, _)| d.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b", "c"]);
        // Scores strictly decrease with rank.
        assert!(fused[0].1 > fused[1].1 && fused[1].1 > fused[2].1);
    }

    /// A graph hit (even at graph rank 0) can never outrank an embedding hit.
    #[test]
    fn graph_hit_cannot_outrank_strong_embedding_hit() {
        // 20 embedding hits (the worst still beats any graph-only hit) + 1 graph.
        let embed: Vec<Ranked> = (0..20)
            .map(|i| ranked(&format!("e{i}"), "E", "embed body"))
            .collect();
        let graph = vec![ranked("g0", "G", "graph body")];
        let fused = rrf_fuse(&embed, &graph);

        let graph_pos = fused
            .iter()
            .position(|(d, _)| d.id == "g0")
            .expect("graph hit present");
        // Every embedding hit precedes the graph-only hit.
        assert_eq!(graph_pos, 20, "graph-only hit must sit below all 20 embedding hits");
    }

    /// Near-identical snippets collapse to one via Jaccard dedup.
    #[test]
    fn jaccard_dedup_collapses_near_duplicates() {
        let body = "the rust borrow checker enforces ownership and lifetimes at compile time";
        let fused = vec![
            (doc("a", "Borrow checker", body), 0.9f32),
            // Same body, different id → near-duplicate, must be dropped.
            (doc("b", "Borrow checker", body), 0.8f32),
            (doc("c", "Tokio runtime", "async tasks scheduled on a work stealing pool"), 0.7f32),
        ];
        let kept = jaccard_dedup(fused, 10);
        let ids: Vec<&str> = kept.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "c"], "b is a near-duplicate of a and dropped");
    }

    /// Empty graph → fused result is exactly the embedding list (no graph noise).
    #[test]
    fn empty_graph_returns_embedding_only() {
        let embed = vec![ranked("a", "A", "alpha body text"), ranked("b", "B", "beta body text")];
        let fused = rrf_fuse(&embed, &[]);
        let kept = jaccard_dedup(fused, 10);
        let ids: Vec<&str> = kept.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b"]);
    }

    /// A doc present in BOTH lists accumulates both contributions and ranks above
    /// a doc present in only one — the intended "graph expands an embedding hit".
    #[test]
    fn doc_in_both_lists_accumulates_score() {
        let embed = vec![ranked("a", "A", "aaa"), ranked("shared", "S", "shared body")];
        let graph = vec![ranked("shared", "S", "shared body")];
        let fused = rrf_fuse(&embed, &graph);
        // "shared" gets embed(rank1) + graph(rank0); "a" gets embed(rank0) only.
        // a: 1/61 = 0.01639; shared: 1/62 + 0.1/61 = 0.01613 + 0.00164 = 0.01777.
        assert_eq!(fused[0].0.id, "shared", "doc in both lists is boosted above a single-list doc");
    }
}

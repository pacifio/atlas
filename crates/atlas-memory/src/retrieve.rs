//! Fused retrieval (Step 6) — the single recall path over the project's memory
//! index. Every agent reaches it the same way: the `memory_search` tool on the
//! memory tool server, whose `IndexSearch` closure (`src-tauri` `agents.rs`)
//! calls `memory_retrieve::retrieve`. Nothing is pushed into prompts (ADR-0010).
//!
//! Pipeline:
//! 1. **Embedding.** Embed the query with the shared [`MiniLmProvider`],
//!    `store.search` for cosine hits, and apply the legacy **0.30 cosine floor on
//!    the raw similarity** — before fusion, since the floor is a cosine threshold
//!    and is meaningless against an RRF score.
//! 2. **Jaccard dedup** near-identical snippets → take `limit` → [`RetrievedDoc`].
//! 3. **Global blend.** Only when fewer than [`LOCAL_SPARSE_THRESHOLD`] local docs
//!    survive, the promoted cross-repository memories (`crate::global`) join as a
//!    second, lowest-weight RRF list, so a global hit never outranks a local one.
//!
//! The graph memory that used to be a down-weighted secondary list was removed
//! (#89): what it held (the legacy shared log) lives in the record store, whose
//! entries are in the HNSW corpus.
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
/// Global cross-repository list weight. With `W_EMBED/W_GLOBAL = 20` and the
/// same `RRF_K`, the best global hit (`0.05/61 ≈ 0.0008`) scores below the
/// *worst* embedding hit in a pool of 20 (`1/80 ≈ 0.0125`): a global hit can
/// never outrank a local one. Only consulted when local memory is sparse.
const W_GLOBAL: f32 = 0.05;
/// When fewer than this many local docs survive dedup, blend in global
/// cross-repository hits. A well-populated repository never touches global.
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
    /// Retrieval over the HNSW, with global memory blended in when local is
    /// sparse. Returns up to `limit` deduped [`RetrievedDoc`]s, embedding-floored.
    /// Empty on a trivial query or when nothing clears the cosine floor.
    pub async fn retrieve(
        &self,
        query: &str,
        limit: usize,
        provider: &MiniLmProvider,
    ) -> Vec<RetrievedDoc> {
        // Also checked by `retrieve_with_vector`; here it spares the model call.
        if query.trim().len() < 4 || limit == 0 {
            return Vec::new();
        }

        let qvec = match embed_query(query, provider).await {
            Ok(v) => v,
            Err(e) => {
                tracing::debug!(target: "atlas_memory::retrieve", "embedding recall failed: {e}");
                None
            }
        };
        self.retrieve_with_vector(query, qvec.as_deref(), limit, &crate::global::global_dir())
    }

    /// [`retrieve`](Self::retrieve) once the query is embedded (`None` when it
    /// could not be), against the global memory dir `global_dir`. The seam the
    /// fixture-corpus tests drive without a model.
    pub(crate) fn retrieve_with_vector(
        &self,
        query: &str,
        qvec: Option<&[f32]>,
        limit: usize,
        global_dir: &std::path::Path,
    ) -> Vec<RetrievedDoc> {
        if query.trim().len() < 4 || limit == 0 {
            return Vec::new();
        }

        // Pull a generous pool from each source so fusion + dedup have headroom.
        let pool = limit.saturating_mul(4).max(20);

        // ── 1. Embedding (primary) ────────────────────────────────────────────
        let embed_ranked = match qvec.map(|v| self.vector_candidates(v, pool)) {
            Some(Ok(r)) => r,
            Some(Err(e)) => {
                tracing::debug!(target: "atlas_memory::retrieve", "embedding recall failed: {e}");
                Vec::new()
            }
            None => Vec::new(),
        };

        // ── 2. Jaccard dedup → top-`limit` ────────────────────────────────────
        let local = jaccard_dedup(rrf_fuse_weighted(&[(&embed_ranked, W_EMBED)]), limit);

        // ── 3. Blend global cross-repository memory ONLY when local is sparse ──
        // Global is a second, lowest-weight RRF list so it can never outrank a
        // local hit; nothing promoted yet is a no-op.
        if local.len() >= LOCAL_SPARSE_THRESHOLD {
            return local;
        }
        let global_ranked = global_candidates(global_dir, query, pool);
        if global_ranked.is_empty() {
            return local;
        }
        let fused = rrf_fuse_weighted(&[(&embed_ranked, W_EMBED), (&global_ranked, W_GLOBAL)]);
        jaccard_dedup(fused, limit)
    }

    /// Cosine hits for an embedded query that clear the floor, ranked best
    /// first and resolved to display docs via the manifest bimap + docstore.
    fn vector_candidates(&self, qvec: &[f32], pool: usize) -> anyhow::Result<Vec<Ranked>> {
        let hits = self.store.search(qvec, pool)?;
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
}

/// The query's embedding, or `None` when the model returned none.
async fn embed_query(query: &str, provider: &MiniLmProvider) -> anyhow::Result<Option<Vec<f32>>> {
    use crate::embedding::EmbeddingProvider;

    let vecs = provider
        .embed_batch(std::slice::from_ref(&query.to_string()))
        .await
        .map_err(|e| anyhow::anyhow!("embed query: {e}"))?;
    Ok(vecs.into_iter().next())
}

/// Keep only hits whose raw cosine similarity is at/above `floor`. usearch already
/// returns them best-first, so order is preserved.
pub(crate) fn apply_cosine_floor(hits: Vec<(u64, f32)>, floor: f32) -> Vec<(u64, f32)> {
    hits.into_iter().filter(|(_, sim)| *sim >= floor).collect()
}

/// Generalised reciprocal-rank fusion over any number of `(list, weight)` pairs,
/// applied in the given order (earlier lists win ties via first-seen order). This
/// is the engine behind both the local ranking and the global blend.
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

    let mut fused: Vec<(f32, RetrievedDoc, usize)> = acc.into_values().collect();
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

/// Global cross-repository hits as a lowest-weight expansion list, tagged with
/// source `"global"` and a `global::<hash>` id so a global hit never collides
/// with a local id during fusion. Empty when nothing has been promoted.
fn global_candidates(global_dir: &std::path::Path, query: &str, pool: usize) -> Vec<Ranked> {
    crate::global::global_recall_in(global_dir, query, pool)
        .into_iter()
        .map(|(content, _score)| {
            let (title, body) = split_memory_text(&content);
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

/// Title/body for a global memory's text: first line is the title, the rest
/// (if any) the body.
fn split_memory_text(content: &str) -> (String, String) {
    // Reuse the embedded-text split so multi-line memories still surface a
    // sensible title, falling back to the first line.
    let (title, body) = split_embedded(content);
    if body.is_empty() {
        if let Some((first, rest)) = content.split_once('\n') {
            return (first.trim().to_string(), rest.trim().to_string());
        }
    }
    (title, body)
}

/// Stable (process-independent enough) hash of a string for synthetic global ids.
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
        assert_eq!(
            keys,
            vec![1, 2, 3],
            "only sims >= 0.30 survive, order preserved"
        );
    }

    /// RRF orders by reciprocal rank: the top embedding hit fuses highest.
    #[test]
    fn rrf_orders_by_reciprocal_rank() {
        let embed = vec![
            ranked("a", "Alpha", "first"),
            ranked("b", "Beta", "second"),
            ranked("c", "Gamma", "third"),
        ];
        let fused = rrf_fuse_weighted(&[(&embed, W_EMBED)]);
        let ids: Vec<&str> = fused.iter().map(|(d, _)| d.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b", "c"]);
        // Scores strictly decrease with rank.
        assert!(fused[0].1 > fused[1].1 && fused[1].1 > fused[2].1);
    }

    /// A global hit (even at global rank 0) can never outrank an embedding hit.
    #[test]
    fn global_hit_cannot_outrank_strong_embedding_hit() {
        // 20 embedding hits (the worst still beats any global hit) + 1 global.
        let embed: Vec<Ranked> = (0..20)
            .map(|i| ranked(&format!("e{i}"), "E", "embed body"))
            .collect();
        let global = vec![ranked("g0", "G", "global body")];
        let fused = rrf_fuse_weighted(&[(&embed, W_EMBED), (&global, W_GLOBAL)]);

        let global_pos = fused
            .iter()
            .position(|(d, _)| d.id == "g0")
            .expect("global hit present");
        // Every embedding hit precedes the global hit.
        assert_eq!(
            global_pos, 20,
            "global hit must sit below all 20 embedding hits"
        );
    }

    /// Near-identical snippets collapse to one via Jaccard dedup.
    #[test]
    fn jaccard_dedup_collapses_near_duplicates() {
        let body = "the rust borrow checker enforces ownership and lifetimes at compile time";
        let fused = vec![
            (doc("a", "Borrow checker", body), 0.9f32),
            // Same body, different id → near-duplicate, must be dropped.
            (doc("b", "Borrow checker", body), 0.8f32),
            (
                doc(
                    "c",
                    "Tokio runtime",
                    "async tasks scheduled on a work stealing pool",
                ),
                0.7f32,
            ),
        ];
        let kept = jaccard_dedup(fused, 10);
        let ids: Vec<&str> = kept.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["a", "c"],
            "b is a near-duplicate of a and dropped"
        );
    }

    /// Embedding only → the fused result is exactly the embedding list.
    #[test]
    fn embedding_only_keeps_its_order() {
        let embed = vec![
            ranked("a", "A", "alpha body text"),
            ranked("b", "B", "beta body text"),
        ];
        let fused = rrf_fuse_weighted(&[(&embed, W_EMBED)]);
        let kept = jaccard_dedup(fused, 10);
        let ids: Vec<&str> = kept.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b"]);
    }

    /// A doc present in BOTH lists accumulates both contributions and ranks above
    /// a doc present in only one.
    #[test]
    fn doc_in_both_lists_accumulates_score() {
        let embed = vec![
            ranked("a", "A", "aaa"),
            ranked("shared", "S", "shared body"),
        ];
        let second = vec![ranked("shared", "S", "shared body")];
        let fused = rrf_fuse_weighted(&[(&embed, W_EMBED), (&second, 0.1)]);
        // "shared" gets embed(rank1) + second(rank0); "a" gets embed(rank0) only.
        // a: 1/61 = 0.01639; shared: 1/62 + 0.1/61 = 0.01613 + 0.00164 = 0.01777.
        assert_eq!(
            fused[0].0.id, "shared",
            "doc in both lists is boosted above a single-list doc"
        );
    }
}

/// Retrieval over a fixed fixture corpus, driven through the vector seam so no
/// model is needed. The expected results are literal goldens recorded on the
/// commit before the graph memory was removed (#89), when this same fixture's
/// legacy log was folded into the graph and the graph answered every keyword
/// query below; they must not move.
#[cfg(test)]
mod fixture_corpus {
    use crate::docstore::DocText;
    use crate::{MemoryEngine, DIM};
    use std::path::PathBuf;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "atlas-memory-fixture-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// Unit vector along the blend of basis axes `(axis, weight)`.
    fn vec_of(parts: &[(usize, f32)]) -> Vec<f32> {
        let mut v = vec![0.0f32; DIM];
        for (axis, w) in parts {
            v[*axis] += *w;
        }
        let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        v.iter().map(|x| x / n).collect()
    }

    /// The fixture corpus: agent memory, the record's entries as the corpus
    /// reader folds them (`shared:<kind>:<id>`, text `[agent] content`), and a
    /// codebase doc. The same record entries also sit in the legacy shared log,
    /// which the engine used to fold into its graph on open; that log is now
    /// read only by the record store's migration.
    fn fixture_engine(root: &std::path::Path) -> MemoryEngine {
        let log = root.join(".atlas").join("shared-memory");
        std::fs::create_dir_all(&log).unwrap();
        std::fs::write(
            log.join("events.jsonl"),
            [
                r#"{"seq":1,"ts":1,"agent":"codex","sessionId":"s1","kind":"decision","payload":{"text":"Use RS256 for JWT signing"}}"#,
                r#"{"seq":2,"ts":2,"agent":"claude","sessionId":"s1","kind":"fact","payload":{"text":"The build uses bun and vitest for tests"}}"#,
                r#"{"seq":3,"ts":3,"agent":"claude","sessionId":"s2","kind":"failure","payload":{"text":"cargo test hangs when the model dir is missing"}}"#,
            ]
            .join("\n"),
        )
        .unwrap();

        let mut engine = MemoryEngine::open(root.to_path_buf());
        let docs: [(&str, &str, &str, &str, usize); 5] = [
            (
                "claude:auth.md",
                "Auth design",
                "claude",
                "Better Auth with DB-backed sessions",
                0,
            ),
            (
                "shared:decision:1",
                "Use RS256 for JWT signing",
                "shared",
                "[codex] Use RS256 for JWT signing",
                1,
            ),
            (
                "shared:fact:2",
                "The build uses bun and vitest for tests",
                "shared",
                "[claude] The build uses bun and vitest for tests",
                2,
            ),
            (
                "shared:failure:3",
                "cargo test hangs when the model dir is missing",
                "shared",
                "[claude] cargo test hangs when the model dir is missing",
                3,
            ),
            (
                "codebase:src/lib.rs",
                "src/lib.rs",
                "codebase",
                "Tauri command registration",
                4,
            ),
        ];
        for (id, title, source, text, axis) in docs {
            let key = engine.manifest.assign_key(id);
            engine.store.add(key, &vec_of(&[(axis, 1.0)])).unwrap();
            engine.manifest.upsert(id, id, source, 0);
            engine.docstore.upsert(
                id,
                DocText {
                    title: title.into(),
                    source: source.into(),
                    text: text.into(),
                },
            );
        }
        engine
    }

    fn ids(
        engine: &MemoryEngine,
        query: &str,
        qvec: &[f32],
        limit: usize,
        global: &std::path::Path,
    ) -> Vec<String> {
        engine
            .retrieve_with_vector(query, Some(qvec), limit, global)
            .into_iter()
            .map(|d| format!("{} | {} | {} | {}", d.id, d.title, d.source, d.text))
            .collect()
    }

    #[test]
    fn retrieval_over_the_fixture_corpus_is_unchanged() {
        let root = tmp("corpus");
        let global = tmp("corpus-global");
        let engine = fixture_engine(&root);

        // A prompt-shaped query: two embedding hits clear the floor.
        assert_eq!(
            ids(&engine, "how is JWT signing configured", &vec_of(&[(1, 1.0), (0, 0.5)]), 5, &global),
            vec![
                "shared:decision:1 | Use RS256 for JWT signing | shared | [codex] Use RS256 for JWT signing",
                "claude:auth.md | Auth design | claude | Better Auth with DB-backed sessions",
            ]
        );
        // A keyword that is a substring of a recorded decision.
        assert_eq!(
            ids(&engine, "RS256", &vec_of(&[(1, 1.0)]), 5, &global),
            vec!["shared:decision:1 | Use RS256 for JWT signing | shared | [codex] Use RS256 for JWT signing"]
        );
        // A phrase from a recorded fact, near a codebase doc too.
        assert_eq!(
            ids(&engine, "bun and vitest", &vec_of(&[(2, 1.0), (4, 0.8)]), 5, &global),
            vec![
                "shared:fact:2 | The build uses bun and vitest for tests | shared | [claude] The build uses bun and vitest for tests",
                "codebase:src/lib.rs | src/lib.rs | codebase | Tauri command registration",
            ]
        );
        // The limit caps a query every doc answers.
        assert_eq!(
            ids(
                &engine,
                "cargo test hangs",
                &vec_of(&[(3, 1.0), (2, 0.6), (0, 0.5), (1, 0.4), (4, 0.3)]),
                2,
                &global
            ),
            vec![
                "shared:failure:3 | cargo test hangs when the model dir is missing | shared | [claude] cargo test hangs when the model dir is missing",
                "shared:fact:2 | The build uses bun and vitest for tests | shared | [claude] The build uses bun and vitest for tests",
            ]
        );
        // Nothing clears the cosine floor.
        assert!(ids(
            &engine,
            "unrelated question",
            &vec_of(&[(9, 1.0)]),
            5,
            &global
        )
        .is_empty());

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&global).ok();
    }

    /// Sparse local results take promoted global memory below every local hit;
    /// a well-populated query never consults it.
    #[test]
    fn promoted_memory_fills_in_when_local_is_sparse() {
        let root = tmp("global-blend");
        let global = tmp("global-blend-global");
        std::fs::write(
            global.join("MEMORY.md"),
            "# Global Memory (promoted, cross-project)\n\n- **[fact]** JWT tokens expire after one hour *(confidence: 90%)*\n",
        )
        .unwrap();
        let engine = fixture_engine(&root);

        assert_eq!(
            ids(&engine, "JWT tokens", &vec_of(&[(1, 1.0)]), 5, &global),
            vec![
                "shared:decision:1 | Use RS256 for JWT signing | shared | [codex] Use RS256 for JWT signing".to_string(),
                format!(
                    "global::{:016x} | JWT tokens expire after one hour | global | ",
                    super::stable_hash("JWT tokens expire after one hour")
                ),
            ]
        );
        assert_eq!(
            ids(
                &engine,
                "JWT tokens",
                &vec_of(&[(0, 1.0), (1, 0.9), (2, 0.8), (3, 0.7)]),
                5,
                &global
            )
            .len(),
            4,
            "four local hits: global is not consulted"
        );

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&global).ok();
    }
}

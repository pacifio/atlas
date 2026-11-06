//! Fused retrieval (Step 6) — the single recall path over the project's memory
//! index. Every agent reaches it the same way: the `memory_search` tool on the
//! memory tool server, whose `IndexSearch` closure (`src-tauri` `agents.rs`)
//! calls `memory_retrieve::retrieve`. Nothing is pushed into prompts (ADR-0010).
//!
//! Pipeline:
//! 1. **Embedding.** Embed the query with the shared [`MiniLmProvider`],
//!    search the corpus index's vector file for cosine hits, and apply the
//!    legacy **0.30 cosine floor on the raw similarity** — before fusion, since
//!    the floor is a cosine threshold and is meaningless against an RRF score.
//!    **Keywords.** BM25 over the docs' words (`docs_fts`), fused with the
//!    embedding list at the same weight: an exact term finds its doc with no
//!    model loaded.
//! 2. **Jaccard dedup** near-identical snippets → take `limit` → [`RetrievedDoc`].
//! 3. **Global blend.** Only when fewer than [`LOCAL_SPARSE_THRESHOLD`] local docs
//!    survive, the promoted cross-repository memories (`crate::global`) join as a
//!    second, lowest-weight RRF list, so a global hit never outranks a local one.
//!
//! The graph memory that used to be a down-weighted secondary list was removed
//! (#89): what it held (the legacy shared log) lives in the record store, whose
//! entries are in the HNSW corpus.
//!
//! 4. **Relevance floor.** RRF ranks; it never says "nothing here". So a hit
//!    is admitted only on evidence of its own: its text carries query terms
//!    worth at least [`MIN_TERM_COVERAGE`] of the query's IDF weight
//!    ([`QueryTerms`]), or its meaning stands out of the corpus — a cosine at
//!    least [`DENSE_OUTLIER_Z`] standard deviations above the query's mean
//!    similarity to every doc. The z-score, not a raw cosine, because a raw
//!    cosine is model-specific (bge puts unrelated text at 0.5–0.7, MiniLM at
//!    0.1–0.3). A query with no evidence anywhere returns nothing.
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
/// Keyword list weight (BM25 over the docs' words): an exact identifier or
/// term finds its doc even when the model is not loaded or the meaning is
/// below the cosine floor.
const W_BM25: f32 = 1.0;
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

/// The share of a query's IDF weight a hit's text must carry to be admitted on
/// words alone. A third: an entry that shares only `repository` with "grep
/// index prefilter large repositories" carries ~0.1 of it and is dropped; one
/// that names the rare terms (`grep`, `prefilter`) clears it without needing
/// every word of a chatty question.
pub const MIN_TERM_COVERAGE: f32 = 1.0 / 3.0;
/// The share a document needs on words alone when the query was embedded and
/// the dense leg did not find it at all: one signal, so a stronger one. A
/// transcript's passage that happens to say `large` and `repository` carries
/// ~0.35 of "grep index prefilter large repositories" and nothing about it.
/// With no embedding there is nothing to corroborate with, and a third holds.
pub const MIN_UNCORROBORATED_COVERAGE: f32 = 0.5;
/// How far (in standard deviations of the query's similarity to the whole
/// corpus) a hit found only by meaning must stand out to be admitted. Measured
/// on a live bge-base store: the best dense hit of a query with no answer sat
/// at z 2.2–3.6, of one with an answer at z 4.1–6.4.
pub const DENSE_OUTLIER_Z: f32 = 4.0;
/// The passage a document's words are judged on by the relevance floor
/// (about 300 tokens, `memory_search`'s excerpt size). A query's terms
/// scattered across a long transcript are not an answer.
pub const PASSAGE_BYTES: usize = 1200;
/// Below this many embedded docs a mean and deviation say nothing, so the
/// dense leg is admitted on the cosine floor alone, as before the floor.
const MIN_BACKGROUND_DOCS: usize = 30;
/// The most corpus vectors read to estimate the background. A larger corpus
/// samples its best-scoring part, which raises the mean: stricter, never laxer.
const BACKGROUND_SAMPLE_MAX: usize = 20_000;

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
        let (embed_ranked, outliers) = qvec
            .map(|v| self.vector_candidates(v, pool))
            .unwrap_or_default();

        // ── 1b. Keywords (BM25) ───────────────────────────────────────────────
        let bm25_ranked = self.bm25_candidates(query, pool);

        // ── 2. Floor → Jaccard dedup → top-`limit` ────────────────────────────
        let terms = self.query_terms(query);
        let dense: HashSet<&str> = embed_ranked.iter().map(|r| r.id.as_str()).collect();
        let embedded_query = qvec.is_some();
        let admitted = |fused: Vec<(RetrievedDoc, f32)>| -> Vec<(RetrievedDoc, f32)> {
            fused
                .into_iter()
                .filter(|(d, _)| {
                    let by_meaning = dense.contains(d.id.as_str())
                        && outliers.as_ref().is_none_or(|o| o.contains(&d.id));
                    let corroborated = !embedded_query || dense.contains(d.id.as_str());
                    let min = if corroborated {
                        MIN_TERM_COVERAGE
                    } else {
                        MIN_UNCORROBORATED_COVERAGE
                    };
                    by_meaning || terms.supports_passage(&d.title, &d.text, min)
                })
                .collect()
        };
        let local = jaccard_dedup(
            admitted(rrf_fuse_weighted(&[
                (&embed_ranked, W_EMBED),
                (&bm25_ranked, W_BM25),
            ])),
            limit,
        );

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
        let fused = rrf_fuse_weighted(&[
            (&embed_ranked, W_EMBED),
            (&bm25_ranked, W_BM25),
            (&global_ranked, W_GLOBAL),
        ]);
        jaccard_dedup(admitted(fused), limit)
    }

    /// Cosine hits for an embedded query that clear the floor, ranked best
    /// first and resolved to display docs through the corpus index — plus the
    /// ids among them that stand out of the corpus by [`DENSE_OUTLIER_Z`]
    /// (`None` when the corpus is too small to say: then every one does).
    fn vector_candidates(
        &self,
        qvec: &[f32],
        pool: usize,
    ) -> (Vec<Ranked>, Option<HashSet<String>>) {
        let embedded = self.corpus.len();
        if embedded < MIN_BACKGROUND_DOCS {
            let hits = self.corpus.search_dense(qvec, pool);
            let ranked = apply_cosine_floor(hits, COSINE_FLOOR)
                .into_iter()
                .filter_map(|(id, _sim)| self.ranked(id))
                .collect();
            return (ranked, None);
        }
        let mut all = self
            .corpus
            .search_dense(qvec, embedded.min(BACKGROUND_SAMPLE_MAX));
        let outliers = dense_outliers(&all, DENSE_OUTLIER_Z);
        all.truncate(pool);
        let ranked = apply_cosine_floor(all, COSINE_FLOOR)
            .into_iter()
            .filter_map(|(id, _sim)| self.ranked(id))
            .collect();
        (ranked, Some(outliers))
    }

    /// The query's terms, weighted by their rarity in the corpus.
    fn query_terms(&self, query: &str) -> QueryTerms {
        let docs = self.corpus.len();
        QueryTerms::new(query).weighted(docs, |word| {
            self.corpus
                .search_bm25(word, docs)
                .map_or(0, |ids| ids.len())
        })
    }

    /// Docs whose words match the query (BM25), best first.
    fn bm25_candidates(&self, query: &str, pool: usize) -> Vec<Ranked> {
        match self.corpus.search_bm25(query, pool) {
            Ok(ids) => ids.into_iter().filter_map(|id| self.ranked(id)).collect(),
            Err(e) => {
                tracing::debug!(target: "atlas_memory::retrieve", "keyword recall failed: {e}");
                Vec::new()
            }
        }
    }

    /// Doc `id` as a ranked candidate, when the index still holds it.
    fn ranked(&self, id: String) -> Option<Ranked> {
        let dt = self.corpus.doc(&id)?;
        Some(Ranked {
            doc: RetrievedDoc {
                id: id.clone(),
                title: dt.title,
                source: dt.source,
                text: dt.text,
            },
            id,
        })
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
pub(crate) fn apply_cosine_floor<K>(hits: Vec<(K, f32)>, floor: f32) -> Vec<(K, f32)> {
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

/// The ids of `hits` (`(id, cosine)`, a sample of the corpus) whose cosine is
/// at least `z` standard deviations above the sample's mean.
fn dense_outliers(hits: &[(String, f32)], z: f32) -> HashSet<String> {
    let n = hits.len() as f32;
    if hits.is_empty() {
        return HashSet::new();
    }
    let mean = hits.iter().map(|(_, s)| *s).sum::<f32>() / n;
    let sd = (hits.iter().map(|(_, s)| (*s - mean).powi(2)).sum::<f32>() / n).sqrt();
    if sd <= f32::EPSILON {
        return HashSet::new();
    }
    hits.iter()
        .filter(|(_, s)| (*s - mean) / sd >= z)
        .map(|(id, _)| id.clone())
        .collect()
}

// ── Query terms: the relevance floor and the excerpt window ─────────────────

/// Words that carry no topic, left out of a query's terms so "how does the
/// memory server time out" is judged on `memory`, `server`, `time`.
const STOPWORDS: &[&str] = &[
    "about", "again", "all", "also", "and", "any", "are", "been", "being", "both", "but", "can",
    "could", "did", "does", "doing", "done", "each", "for", "from", "get", "gets", "got", "had",
    "has", "have", "having", "her", "here", "his", "how", "into", "its", "just", "may", "might",
    "more", "most", "must", "nor", "not", "now", "off", "once", "only", "onto", "other", "our",
    "out", "over", "own", "same", "shall", "she", "should", "some", "such", "than", "that", "the",
    "their", "them", "then", "there", "these", "they", "this", "those", "too", "under", "very",
    "was", "were", "what", "when", "where", "which", "while", "who", "whom", "whose", "why",
    "will", "with", "would", "yet", "you", "your",
];

/// `word`'s comparison key: lowercased, one inflection off (`-ies`→`-y`,
/// `-ing`, `-ed`, `-es`, `-s`, then a final `-e`), first six letters — so
/// `repositories`/`repository`, `handled`/`handle`, `tokens`/`token` meet,
/// and `prefilter`/`prefix` do not.
pub fn term_stem(word: &str) -> String {
    let w = word.to_lowercase();
    let long = |b: &str| b.chars().count() >= 3;
    let mut base: String = w.clone();
    if let Some(b) = w.strip_suffix("ies").filter(|b| long(b)) {
        base = format!("{b}y");
    } else if !w.ends_with("ss") {
        for suffix in ["ing", "ed", "es", "s"] {
            if let Some(b) = w.strip_suffix(suffix).filter(|b| long(b)) {
                base = b.to_string();
                break;
            }
        }
    }
    if let Some(b) = base.strip_suffix('e').filter(|b| long(b)) {
        base = b.to_string();
    }
    base.chars().take(6).collect()
}

/// `text`'s words with their byte spans, split on anything not alphanumeric
/// (so `prompt_too_large` is three words).
fn words_with_spans(text: &str) -> impl Iterator<Item = (usize, usize, &str)> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    for (i, c) in text.char_indices() {
        match (c.is_alphanumeric(), start) {
            (true, None) => start = Some(i),
            (false, Some(s)) => {
                out.push((s, i, &text[s..i]));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        out.push((s, text.len(), &text[s..]));
    }
    out.into_iter()
}

/// A query's distinct topic terms and what each is worth: the relevance
/// floor ([`supports`](Self::supports)) and the excerpt window
/// ([`excerpt`](Self::excerpt)) of `memory_search`.
///
/// Terms are the query's words of three letters or more (all of them when it
/// has none that long, as the FTS query does), less [`STOPWORDS`], compared by
/// [`term_stem`]. Unweighted, every term counts the same; [`weighted`]
/// (Self::weighted) gives each its BM25 IDF, so a word every entry uses
/// (`repository`) counts for little and one nothing uses counts for a lot.
#[derive(Debug, Clone)]
pub struct QueryTerms {
    /// The first spelling of each term in the query (what the FTS is asked).
    words: Vec<String>,
    stems: Vec<String>,
    weights: Vec<f32>,
}

impl QueryTerms {
    pub fn new(query: &str) -> Self {
        let all: Vec<&str> = words_with_spans(query).map(|(_, _, w)| w).collect();
        let long: Vec<&str> = all
            .iter()
            .copied()
            .filter(|w| w.chars().count() >= 3)
            .collect();
        let chosen = if long.is_empty() { all } else { long };
        let mut words = Vec::new();
        let mut stems: Vec<String> = Vec::new();
        for w in chosen {
            if STOPWORDS.contains(&w.to_lowercase().as_str()) {
                continue;
            }
            let stem = term_stem(w);
            if !stems.contains(&stem) {
                stems.push(stem);
                words.push(w.to_string());
            }
        }
        let weights = vec![1.0; stems.len()];
        Self {
            words,
            stems,
            weights,
        }
    }

    /// Weigh each term by its BM25 IDF over `docs` documents, `df(word)` of
    /// which contain it: `ln(1 + (N − df + ½) / (df + ½))`, always positive.
    ///
    /// A term no document uses is weighed as one used once, the rarest the
    /// corpus can show. BM25 gives `df = 0` the largest weight of all, which
    /// is harmless in a score (no document collects it) but wrong in a share:
    /// against a small record, the words of a paraphrase nothing uses
    /// ("database decision") would outweigh the one word that does match
    /// ("Postgres") — in a one-entry record, by 5 to 1.
    #[must_use]
    pub fn weighted(mut self, docs: usize, df: impl Fn(&str) -> usize) -> Self {
        self.weights = self
            .words
            .iter()
            .map(|w| {
                let df = (df(w) as f32).max(1.0);
                let n = (docs as f32).max(df);
                (1.0 + (n - df + 0.5) / (df + 0.5)).ln()
            })
            .collect();
        self
    }

    /// Whether the query has no topic term (then nothing can be judged).
    pub fn is_empty(&self) -> bool {
        self.stems.is_empty()
    }

    /// The query's topic terms, as compared ([`term_stem`]).
    pub fn stems(&self) -> &[String] {
        &self.stems
    }

    fn index_of(&self, word: &str) -> Option<usize> {
        if word.is_empty() {
            return None;
        }
        let stem = term_stem(word);
        self.stems.iter().position(|s| *s == stem)
    }

    /// The share (0–1) of the query's term weight that `text` carries.
    pub fn coverage(&self, text: &str) -> f32 {
        let total: f32 = self.weights.iter().sum();
        if total <= 0.0 {
            return 0.0;
        }
        let mut seen = vec![false; self.stems.len()];
        for (_, _, w) in words_with_spans(text) {
            if let Some(i) = self.index_of(w) {
                seen[i] = true;
            }
        }
        seen.iter()
            .zip(&self.weights)
            .filter(|(hit, _)| **hit)
            .map(|(_, w)| w)
            .sum::<f32>()
            / total
    }

    /// Whether `text` is evidence enough to be shown as a match: it carries
    /// [`MIN_TERM_COVERAGE`] of the query's weight. A query with no topic term
    /// cannot be judged, so everything passes.
    pub fn supports(&self, text: &str) -> bool {
        self.meets(text, MIN_TERM_COVERAGE)
    }

    /// Whether `text` carries at least `min` of the query's weight.
    fn meets(&self, text: &str, min: f32) -> bool {
        // The epsilon: one term of three equally weighted is exactly a third,
        // and an f32 division can land a hair under it.
        self.is_empty() || self.coverage(text) + 1e-6 >= min
    }

    /// The `room`-byte span of `text` (byte offsets) whose words carry the
    /// most of the query's weight; the head when no term occurs.
    fn best_window(&self, text: &str, room: usize) -> (usize, usize) {
        let hits: Vec<(usize, usize, usize)> = words_with_spans(text)
            .filter_map(|(s, e, w)| self.index_of(w).map(|i| (s, e, i)))
            .collect();
        // The run of hits that fits in `room` and is worth the most.
        let (mut from, mut to) = (0, room.min(text.len()));
        let mut best = 0.0f32;
        let mut counts = vec![0usize; self.stems.len()];
        let mut worth = 0.0f32;
        let mut left = 0;
        for right in 0..hits.len() {
            let (_, end, i) = hits[right];
            if counts[i] == 0 {
                worth += self.weights[i];
            }
            counts[i] += 1;
            while end - hits[left].0 > room {
                let j = hits[left].2;
                counts[j] -= 1;
                if counts[j] == 0 {
                    worth -= self.weights[j];
                }
                left += 1;
            }
            if worth > best {
                best = worth;
                let span = end - hits[left].0;
                let start = hits[left].0.saturating_sub((room - span) / 2);
                let stop = (start + room).min(text.len());
                (from, to) = (stop.saturating_sub(room), stop);
            }
        }
        (from, to)
    }

    /// Whether `title` plus the best [`PASSAGE_BYTES`] of `text` carry at
    /// least `min` of the query's weight. A whole session transcript uses
    /// nearly every word there is, so a share counted over all of it admits
    /// it for any query; the terms have to meet where it would be excerpted.
    pub fn supports_passage(&self, title: &str, text: &str, min: f32) -> bool {
        if self.is_empty() || text.len() <= PASSAGE_BYTES {
            return self.meets(&format!("{title} {text}"), min);
        }
        let (mut from, mut to) = self.best_window(text, PASSAGE_BYTES);
        while !text.is_char_boundary(from) {
            from += 1;
        }
        while !text.is_char_boundary(to) {
            to -= 1;
        }
        self.meets(&format!("{title} {}", &text[from..to]), min)
    }

    /// At most `max_bytes` of `text`, from the window that carries the most of
    /// the query's weight (the head when no term occurs), cut at word
    /// boundaries and marked `…` where text was dropped. `None` when the whole
    /// text fits.
    pub fn excerpt(&self, text: &str, max_bytes: usize) -> Option<String> {
        const MARK: &str = "…";
        if text.len() <= max_bytes {
            return None;
        }
        let room = max_bytes.saturating_sub(2 * MARK.len()).max(1);
        let (mut from, mut to) = self.best_window(text, room);
        // Whole words only: start after a space, stop before one.
        while !text.is_char_boundary(from) {
            from += 1;
        }
        while !text.is_char_boundary(to) {
            to -= 1;
        }
        if from > 0 {
            if let Some(sp) = text[from..to].find(char::is_whitespace) {
                if sp < 64 {
                    from += sp;
                }
            }
        }
        if to < text.len() {
            if let Some(sp) = text[from..to].rfind(char::is_whitespace) {
                if to - (from + sp) < 64 {
                    to = from + sp;
                }
            }
        }
        let body = text[from..to].trim();
        Some(format!(
            "{}{body}{}",
            if from > 0 { MARK } else { "" },
            if to < text.len() { MARK } else { "" }
        ))
    }
}

/// [`QueryTerms`] for searching the shared-memory record, weighted by how
/// many of its entries use each term.
pub fn record_query_terms(store: &crate::record::RecordStore, query: &str) -> QueryTerms {
    let terms = QueryTerms::new(query);
    if terms.is_empty() {
        return terms;
    }
    let conn = store.conn();
    let count = |sql: &str, arg: Option<&str>| -> usize {
        let n: rusqlite::Result<i64> = match arg {
            Some(a) => conn.query_row(sql, [a], |r| r.get(0)),
            None => conn.query_row(sql, [], |r| r.get(0)),
        };
        n.map_or(0, |n| n.max(0) as usize)
    };
    let docs = count(
        "SELECT COUNT(*) FROM entries WHERE state != 'archived'",
        None,
    );
    terms.weighted(docs, |word| {
        crate::record::fts_query(word).map_or(0, |m| {
            count(
                "SELECT COUNT(*) FROM entries_fts WHERE entries_fts MATCH ?1",
                Some(&m),
            )
        })
    })
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

    #[test]
    fn term_stems_meet_across_inflections() {
        for (a, b) in [
            ("repositories", "repository"),
            ("handled", "handle"),
            ("tokens", "token"),
            ("minutes", "minute"),
            ("configured", "configure"),
            ("signing", "signed"),
        ] {
            assert_eq!(term_stem(a), term_stem(b), "{a} / {b}");
        }
        assert_ne!(term_stem("prefilter"), term_stem("prefix"));
        assert_ne!(term_stem("class"), term_stem("cla"));
    }

    /// The live miss: "grep index prefilter large repositories" returned a
    /// branch fact whose only shared word was `repository`, used everywhere.
    #[test]
    fn coverage_is_weighted_by_rarity() {
        let terms =
            QueryTerms::new("grep index prefilter large repositories").weighted(200, |w| match w {
                "grep" => 3,
                "index" => 20,
                "prefilter" => 0,
                "large" => 10,
                _ => 120,
            });
        assert!(!terms.supports("The repository has a local branch named '0.3.4'"));
        assert!(!terms.supports("prompt_too_large vs request_too_large error"));
        assert!(terms.supports("The grep prefilter skips files that cannot match"));
        // Stopwords are not terms; a query of only stopwords judges nothing.
        assert_eq!(QueryTerms::new("how does the").stems().len(), 0);
        assert!(QueryTerms::new("how does the").supports("anything"));
    }

    /// AtlasMemBench's clobber probe: a one-entry record, and a query whose
    /// other words nothing uses. The word it shares still counts.
    #[test]
    fn unused_query_words_do_not_drown_the_one_that_matches() {
        let terms = QueryTerms::new("database decision Postgres")
            .weighted(1, |w| usize::from(w == "Postgres"));
        assert!(terms.supports("db Use Postgres"));
        // One term in five, as in the live miss, is still not enough.
        let five =
            QueryTerms::new("grep index prefilter large repositories").weighted(4, |w| match w {
                "large" => 1,
                "repositories" => 3,
                _ => 0,
            });
        assert!(!five.supports("prompt_too_large 413 is a recoverable signal"));
    }

    /// A long transcript that uses the query's words far apart is not an
    /// answer; one where they meet in a passage is.
    #[test]
    fn a_long_document_is_judged_on_one_passage() {
        let filler = "lorem ipsum dolor sit amet ".repeat(200);
        let terms = QueryTerms::new("grep prefilter large repositories");
        let scattered = format!("grep {filler} prefilter {filler} large {filler}");
        assert!(
            terms.supports(&scattered),
            "the whole text carries them all"
        );
        assert!(!terms.supports_passage("session", &scattered, MIN_TERM_COVERAGE));
        let together = format!("{filler} the grep prefilter for large repos {filler}");
        assert!(terms.supports_passage("session", &together, MIN_TERM_COVERAGE));
    }

    /// The excerpt is the window around the matching passage, not the head,
    /// and stays inside its budget.
    #[test]
    fn the_excerpt_is_the_matching_passage() {
        let filler = "lorem ipsum dolor sit amet ".repeat(400);
        let text = format!("HEAD {filler}the grep prefilter skips files in large repos {filler}");
        let terms = QueryTerms::new("grep prefilter large repositories");
        let cut = terms.excerpt(&text, 600).expect("too long to keep whole");
        assert!(cut.len() <= 600, "{} bytes", cut.len());
        assert!(
            cut.contains("grep prefilter skips files in large repos"),
            "{cut}"
        );
        assert!(cut.starts_with('…') && cut.ends_with('…'), "{cut}");
        assert!(!cut.contains("HEAD"));
        // No term at all: the head.
        let none = QueryTerms::new("sourdough").excerpt(&text, 600).unwrap();
        assert!(none.starts_with("HEAD"), "{none}");
        // Short enough: kept whole.
        assert_eq!(terms.excerpt("grep prefilter", 600), None);
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
        let embedded: Vec<(crate::CorpusDoc, Vec<f32>)> = docs
            .iter()
            .map(|(id, title, source, text, axis)| {
                (
                    crate::CorpusDoc {
                        id: (*id).into(),
                        text: format!("{title}\n\n{text}"),
                        content_hash: (*id).into(),
                        corpus: (*source).into(),
                    },
                    vec_of(&[(*axis, 1.0)]),
                )
            })
            .collect();
        engine.add_embedded(&embedded).unwrap();
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

/// The relevance floor over a corpus big enough to have a background (40
/// docs): every doc sits at cosine 0.5 from every other, so a query can be
/// near all of them at once (no answer) or stand out near one (an answer).
#[cfg(test)]
mod relevance_floor {
    use crate::{MemoryEngine, DIM};
    use std::path::PathBuf;

    fn tmp(name: &str) -> PathBuf {
        let p =
            std::env::temp_dir().join(format!("atlas-memory-floor-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn vec_of(parts: &[(usize, f32)]) -> Vec<f32> {
        let mut v = vec![0.0f32; DIM];
        for (axis, w) in parts {
            v[*axis] += *w;
        }
        let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        v.iter().map(|x| x / n).collect()
    }

    /// Doc `i` (1–40) is about `topic<i>`, mentions `repository` like every
    /// other, and embeds on the shared axis 0 plus its own axis `i`. Doc 7
    /// also names the grep `prefilter`.
    fn engine(root: &std::path::Path) -> MemoryEngine {
        let mut engine = MemoryEngine::open(root.to_path_buf());
        let docs: Vec<(crate::CorpusDoc, Vec<f32>)> = (1..=40)
            .map(|i| {
                let extra = if i == 7 {
                    " the grep prefilter skips files"
                } else {
                    ""
                };
                (
                    crate::CorpusDoc {
                        id: format!("doc:{i}"),
                        text: format!("Note {i}\n\ntopic{i} in this repository{extra}"),
                        content_hash: format!("h{i}"),
                        corpus: "test".into(),
                    },
                    vec_of(&[(0, 1.0), (i, 1.0)]),
                )
            })
            .collect();
        engine.add_embedded(&docs).unwrap();
        engine
    }

    fn ids(
        engine: &MemoryEngine,
        query: &str,
        qvec: &[f32],
        global: &std::path::Path,
    ) -> Vec<String> {
        engine
            .retrieve_with_vector(query, Some(qvec), 5, global)
            .into_iter()
            .map(|d| d.id)
            .collect()
    }

    /// A query near every doc alike and sharing none of their words has no
    /// answer: nothing is returned, though every doc clears the cosine floor.
    #[test]
    fn a_query_with_no_answer_returns_nothing() {
        let (root, global) = (tmp("none"), tmp("none-global"));
        let engine = engine(&root);
        assert_eq!(
            ids(
                &engine,
                "how do I bake sourdough bread",
                &vec_of(&[(0, 1.0)]),
                &global
            ),
            Vec::<String>::new()
        );
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&global).ok();
    }

    /// Found by words alone while the query's meaning found nothing near it,
    /// a doc needs half the query's weight; with no embedding, a third.
    #[test]
    fn words_alone_must_say_more_when_meaning_disagrees() {
        let (root, global) = (tmp("uncorroborated"), tmp("uncorroborated-global"));
        let engine = engine(&root);
        // Orthogonal to every doc: the dense leg finds nothing.
        let elsewhere = vec_of(&[(100, 1.0)]);
        let query = "grep large index"; // doc 7 carries one term of three
        assert_eq!(
            ids(&engine, query, &elsewhere, &global),
            Vec::<String>::new()
        );
        let unembedded: Vec<String> = engine
            .retrieve_with_vector(query, None, 5, &global)
            .into_iter()
            .map(|d| d.id)
            .collect();
        assert_eq!(unembedded, vec!["doc:7".to_string()]);
        // Two terms of four is half: enough on words alone.
        assert_eq!(
            ids(&engine, "grep prefilter large index", &elsewhere, &global),
            vec!["doc:7".to_string()]
        );
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&global).ok();
    }

    /// Sharing only a word every doc uses is not evidence; naming the rare
    /// term is.
    #[test]
    fn a_common_word_alone_does_not_make_a_match() {
        let (root, global) = (tmp("common"), tmp("common-global"));
        let engine = engine(&root);
        assert_eq!(
            ids(
                &engine,
                "grep prefilter large repositories",
                &vec_of(&[(0, 1.0)]),
                &global
            ),
            vec!["doc:7".to_string()]
        );
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&global).ok();
    }

    /// Found by meaning alone, a doc that stands out of the corpus is still an
    /// answer — and only that one, not the four that merely clear the floor.
    #[test]
    fn a_doc_that_stands_out_by_meaning_is_kept_alone() {
        let (root, global) = (tmp("outlier"), tmp("outlier-global"));
        let engine = engine(&root);
        assert_eq!(
            ids(
                &engine,
                "something phrased differently",
                &vec_of(&[(0, 1.0), (5, 2.0)]),
                &global
            ),
            vec!["doc:5".to_string()]
        );
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&global).ok();
    }
}

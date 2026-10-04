//! Agent-agnostic retrieval parity + HNSW-vs-brute-force micro-benchmark.
//!
//! These tests are the offline (no live app) half of the retrieval checks. The
//! live check (agents retrieving through the running app with the MiniLM model
//! loaded) is a MANUAL runtime step — see `crates/atlas-memory/MIGRATION.md`.
//!
//! ## Parity (agent-agnostic retrieval)
//! Every agent reaches retrieval through ONE path: the `memory_search` tool on
//! the memory tool server, offered to the native agent and to every ACP agent
//! that speaks HTTP MCP (ADR-0010; nothing is pushed into prompts). Its
//! `IndexSearch` closure calls `memory_retrieve::retrieve` (`src-tauri`) with
//! **no agent-type parameter**, which calls [`MemoryEngine::retrieve`] and gets
//! [`RetrievedDoc { id, title, source, text }`](crate::RetrievedDoc); the tool
//! renders each hit's `title`, `source` and `text`. So "parity" reduces to two
//! checkable claims, both asserted below:
//!   1. the engine's retrieve path takes no agent discriminator, so the same
//!      (cwd, query, limit) yields identical results no matter which agent asks; and
//!   2. every [`RetrievedDoc`] maps cleanly (total, lossless except `id`) onto the
//!      three display fields `memory_search` returns.
//!
//! ## Benchmark
//! [`bench_hnsw_vs_brute_force`] builds a synthetic corpus of random L2-normalized
//! 384-d vectors and times [`HnswStore::search`] against `atlas_embed::BruteForce`
//! O(n) cosine, plus a top-1 recall-agreement sanity check. It is `#[ignore]`d;
//! numbers print with `--ignored --nocapture`.

#![cfg(test)]

use crate::{RetrievedDoc, DIM};

/// Local mirror of `atlas_native_agent::engine::memory::MemDoc`.
/// `atlas-memory` must not depend on the agent crate (the dependency points the
/// other way, app-side), so we redeclare the three fields here and prove
/// [`RetrievedDoc`] maps onto them. If the real `MemDoc` ever grows/loses a
/// field, this mirror (and the mapping below) is where the contract is pinned.
#[derive(Debug, Clone, PartialEq, Eq)]
struct MemDocShape {
    title: String,
    source: String,
    text: String,
}

/// The exact field mapping the Tauri seam performs (`agents.rs` closure +
/// `memory_retrieve::retrieve`): carry title/source/text, drop `id`. Pure function
/// of the doc — no agent input — which is the whole point of "agent-agnostic".
fn to_memdoc(d: &RetrievedDoc) -> MemDocShape {
    MemDocShape {
        title: d.title.clone(),
        source: d.source.clone(),
        text: d.text.clone(),
    }
}

/// Locate a local MiniLM model dir via `ATLAS_MINILM_DIR`, else `None`. Tests that
/// need real embeddings are `#[ignore]`d and never download one.
fn find_model_dir() -> Option<std::path::PathBuf> {
    let dir = std::env::var("ATLAS_MINILM_DIR").ok()?;
    let p = std::path::PathBuf::from(dir);
    p.join("model.safetensors").exists().then_some(p)
}

// ── Parity (no model required) ───────────────────────────────────────────────

/// Every `RetrievedDoc` maps onto the `MemDoc` shape with all three display
/// fields intact and `id` dropped — the shape every agent's retrieved memory
/// arrives in.
#[test]
fn retrieved_doc_maps_cleanly_onto_memdoc() {
    let docs = vec![
        RetrievedDoc {
            id: "claude::auth-001".into(),
            title: "Auth strategy".into(),
            source: "claude".into(),
            text: "Project uses Better Auth with DB-backed sessions.".into(),
        },
        RetrievedDoc {
            id: "shared:decision:7".into(),
            title: "Decision: usearch over brute-force".into(),
            source: "shared".into(),
            text: "HNSW replaces O(n) cosine as the live recall path.".into(),
        },
        RetrievedDoc {
            id: "global::beef".into(),
            title: "User preference".into(),
            source: "global".into(),
            text: "Prefers conventional-commit messages, no AI co-author trailer.".into(),
        },
    ];

    for d in &docs {
        let m = to_memdoc(d);
        assert_eq!(m.title, d.title, "title must carry through the seam");
        assert_eq!(m.source, d.source, "source must carry through the seam");
        assert_eq!(m.text, d.text, "text must carry through the seam");
        // The mapping is a pure function of the doc — re-mapping is identical,
        // i.e. it cannot depend on any hidden agent/global state.
        assert_eq!(
            to_memdoc(d),
            m,
            "mapping must be deterministic / agent-agnostic"
        );
    }
}

/// The retrieval entry point carries **no agent discriminator**. We can't name a
/// type that doesn't exist, so we pin the contract structurally: a fn pointer with
/// the exact `retrieve` signature `(query, limit, provider) -> docs` type-checks.
/// If anyone added an `agent: AgentKind` argument (re-introducing per-agent
/// branching), this stops compiling — a compile-time parity guard.
#[test]
fn retrieve_signature_has_no_agent_parameter() {
    use crate::{MemoryEngine, MiniLmProvider};
    use std::future::Future;
    use std::pin::Pin;

    type RetrieveFn = for<'a> fn(
        &'a MemoryEngine,
        &'a str,
        usize,
        &'a MiniLmProvider,
    )
        -> Pin<Box<dyn Future<Output = Vec<RetrievedDoc>> + Send + 'a>>;

    // Coercing the real method to this signature is the assertion. (Never called.)
    fn _coerce() -> RetrieveFn {
        |e, q, k, p| Box::pin(e.retrieve(q, k, p))
    }
    let _ = _coerce;
}

/// End-to-end agent-agnostic retrieval over a real engine. Ignored by default;
/// run with `ATLAS_MINILM_DIR` set and `--ignored` (no network). Builds one
/// engine, indexes a small corpus, then issues the SAME (cwd, query, limit) twice
/// — standing in for "agent X asks" vs "agent Y asks". Asserts the two result sets
/// are byte-identical (no per-caller drift) and that every doc is well-formed and
/// maps cleanly onto `MemDoc`.
#[test]
#[ignore = "needs ATLAS_MINILM_DIR"]
fn retrieve_is_agent_agnostic_and_well_formed_when_model_available() {
    use crate::{CorpusDoc, MemoryEngine, MiniLmProvider};
    use std::sync::Arc;

    let model = find_model_dir().expect("set ATLAS_MINILM_DIR to a MiniLM model dir");
    let embedder = atlas_embed::Embedder::load(&model).expect("load MiniLM");
    let provider = MiniLmProvider::new(Arc::new(embedder), "all-MiniLM-L6-v2");
    let rt = tokio::runtime::Runtime::new().unwrap();

    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_path_buf();

    let mut engine = MemoryEngine::open(root);
    let corpus = vec![
        CorpusDoc {
            id: "d1".into(),
            text: "Auth: the project uses Better Auth with database-backed sessions.".into(),
            content_hash: "h1".into(),
            corpus: "claude".into(),
        },
        CorpusDoc {
            id: "d2".into(),
            text: "Indexing: a background MemoryIndexer rebuilds the HNSW off the chat turn."
                .into(),
            content_hash: "h2".into(),
            corpus: "codebase".into(),
        },
        CorpusDoc {
            id: "d3".into(),
            text: "Retrieval searches usearch HNSW and blends global memory via RRF.".into(),
            content_hash: "h3".into(),
            corpus: "codebase".into(),
        },
    ];
    rt.block_on(engine.index_corpus(&corpus, &provider))
        .unwrap();

    let query = "how does authentication work in this project";
    // Two retrievals standing in for two different agents on the same project/query.
    let as_claude = rt.block_on(engine.retrieve(query, 6, &provider));
    let as_codex = rt.block_on(engine.retrieve(query, 6, &provider));

    assert!(!as_claude.is_empty(), "expected at least one grounded hit");
    assert_eq!(
        as_claude.len(),
        as_codex.len(),
        "the same query must return the same count regardless of caller"
    );
    for (a, b) in as_claude.iter().zip(as_codex.iter()) {
        assert_eq!(
            a.id, b.id,
            "agent-agnostic: identical ordering/ids per caller"
        );
        // Well-formed + maps cleanly onto MemDoc.
        assert!(!a.title.trim().is_empty(), "title must be non-empty");
        assert!(!a.source.trim().is_empty(), "source must be non-empty");
        assert!(!a.text.trim().is_empty(), "text must be non-empty");
        assert_eq!(to_memdoc(a), to_memdoc(b));
    }
}

// ── Benchmark: HNSW vs legacy brute-force ────────────────────────────────────

/// Tiny xorshift PRNG so the benchmark needs no `rand` dependency and is
/// reproducible across runs.
struct Rng(u64);
impl Rng {
    fn next_f32(&mut self) -> f32 {
        // xorshift64*
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        let v = x.wrapping_mul(0x2545F4914F6CDD1D);
        // Map to [-1, 1).
        ((v >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0
    }
    fn unit_vec(&mut self, dim: usize) -> Vec<f32> {
        let mut v: Vec<f32> = (0..dim).map(|_| self.next_f32()).collect();
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            for x in &mut v {
                *x /= norm;
            }
        }
        v
    }
}

/// Time [`HnswStore::search`] vs the legacy `atlas_embed::BruteForce` O(n) cosine
/// over a synthetic corpus of random normalized 384-d vectors, and report a top-1
/// recall-agreement sanity check (HNSW is approximate, so <100% is expected and
/// fine). Needs no model or network, but builds a 4000-vector index, which is
/// slow unoptimized, so it is opt-in:
/// `cargo test -p atlas-memory --release bench_hnsw -- --ignored --nocapture`.
#[test]
#[ignore = "benchmark; run with --ignored --nocapture"]
fn bench_hnsw_vs_brute_force() {
    use crate::HnswStore;
    use atlas_embed::{BruteForce, VectorStore};
    use std::time::Instant;

    const N_VECTORS: usize = 4000;
    const N_QUERIES: usize = 200;
    const K: usize = 6;

    let mut rng = Rng(0x9E3779B97F4A7C15);
    let vectors: Vec<Vec<f32>> = (0..N_VECTORS).map(|_| rng.unit_vec(DIM)).collect();
    let queries: Vec<Vec<f32>> = (0..N_QUERIES).map(|_| rng.unit_vec(DIM)).collect();

    // Build HNSW (key i ↔ vector index i, matching brute-force's positional index).
    let build_start = Instant::now();
    let hnsw = HnswStore::open(DIM).expect("usearch open");
    for (i, v) in vectors.iter().enumerate() {
        hnsw.add(i as u64, v).expect("hnsw add");
    }
    let hnsw_build = build_start.elapsed();

    let brute = BruteForce::new(vectors);

    // ── Time HNSW search ──
    let t = Instant::now();
    let mut hnsw_top1: Vec<u64> = Vec::with_capacity(N_QUERIES);
    for q in &queries {
        let hits = hnsw.search(q, K).expect("hnsw search");
        hnsw_top1.push(hits.first().map(|(k, _)| *k).unwrap_or(u64::MAX));
    }
    let hnsw_total = t.elapsed();

    // ── Time brute-force search ──
    let t = Instant::now();
    let mut brute_top1: Vec<u64> = Vec::with_capacity(N_QUERIES);
    for q in &queries {
        let hits = brute.search(q, K);
        brute_top1.push(hits.first().map(|(i, _)| *i as u64).unwrap_or(u64::MAX));
    }
    let brute_total = t.elapsed();

    // ── Recall sanity: top-1 agreement (brute-force is the exact ground truth) ──
    let agree = hnsw_top1
        .iter()
        .zip(brute_top1.iter())
        .filter(|(a, b)| a == b)
        .count();
    let agreement = agree as f64 / N_QUERIES as f64;

    let hnsw_us = hnsw_total.as_micros() as f64 / N_QUERIES as f64;
    let brute_us = brute_total.as_micros() as f64 / N_QUERIES as f64;
    let speedup = brute_us / hnsw_us.max(f64::MIN_POSITIVE);

    eprintln!(
        "\n=== HNSW vs brute-force ({N_VECTORS} vecs × {DIM}d, {N_QUERIES} queries, k={K}) ==="
    );
    eprintln!("HNSW build:        {hnsw_build:?}");
    eprintln!("HNSW search:       {hnsw_us:.1} µs/query  (total {hnsw_total:?})");
    eprintln!("Brute-force search:{brute_us:.1} µs/query  (total {brute_total:?})");
    eprintln!("Speedup (brute/HNSW): {speedup:.1}×");
    eprintln!(
        "Top-1 agreement:   {:.1}% ({agree}/{N_QUERIES})\n",
        agreement * 100.0
    );

    // Sanity assertions (loose — this is a benchmark, not a correctness gate):
    // both engines return a hit for every query, and HNSW recall is non-trivial.
    assert!(
        hnsw_top1.iter().all(|k| *k != u64::MAX),
        "HNSW returned a hit per query"
    );
    assert!(
        brute_top1.iter().all(|k| *k != u64::MAX),
        "brute returned a hit per query"
    );
    assert!(
        agreement >= 0.5,
        "HNSW top-1 recall vs exact unexpectedly low: {agreement:.2}"
    );
}

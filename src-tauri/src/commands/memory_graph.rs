//! `memory_graph` — on-device semantic index + graph map over agent memory.
//!
//! Pipeline: `agent_memory::collect_corpus` → embed each doc with a local
//! BERT sentence-transformer (`atlas-embed`, candle) → build a similarity graph
//! (kNN edges) augmented with explicit `[[wikilink]]` edges → answer
//! natural-language queries by embedding the query and ranking.
//!
//! The model (`all-MiniLM-L6-v2`, ~90 MB) is downloaded on demand into the
//! global app-data dir. Vectors live in the project's retrieval index (the
//! `atlas-memory` HNSW engine under `.atlas/memory/`, the same one the indexer
//! and per-turn retrieval use): the graph reuses the vectors it already holds
//! for unchanged docs and adds the ones it had to embed, and a query searches
//! it directly.

use std::path::PathBuf;
use std::sync::Arc;

use atlas_embed::{BruteForce, Embedder};
use atlas_memory::CorpusDoc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use super::agent_memory::{collect_corpus, MemoryDoc};
use super::memory_indexer::{indexed_vectors, to_corpus_doc, MemoryRegistry};

/// Corpora Memory ▸ Graph leaves out (see `memory_index_build`).
const GRAPH_EXCLUDED_CORPORA: [&str; 1] = ["codebase"];

/// Files every BERT sentence-transformer ships — constant across embedding models;
/// only the source repo (and dir) vary by the user's selection.
pub(crate) const MODEL_FILES: [&str; 3] = ["config.json", "tokenizer.json", "model.safetensors"];

/// kNN fan-out per node when building similarity edges.
const TOPK: usize = 4;
/// Minimum cosine for a similarity edge to be drawn.
const SIM_THRESHOLD: f32 = 0.35;

// ── Model location + status ─────────────────────────────────────────────────

/// Dir of the **selected** embedding model (`app_data/models/<embedding_model_id>`).
/// Delegates to the model manager so every embedding consumer follows the user's
/// choice. See `super::models`.
pub(crate) fn model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    super::models::model_dir_for(app, &super::models::selected_embedding_id(app))
}

#[derive(Debug, Serialize)]
pub struct EmbedStatus {
    downloaded: bool,
    model: String,
    model_dir: String,
}

#[tauri::command]
pub async fn memory_embed_status(app: AppHandle) -> Result<EmbedStatus, String> {
    let dir = model_dir(&app)?;
    let downloaded = MODEL_FILES.iter().all(|f| dir.join(f).exists());
    Ok(EmbedStatus {
        downloaded,
        model: super::models::selected_embedding_id(&app),
        model_dir: dir.to_string_lossy().to_string(),
    })
}

// ── Download (streamed, with throttled progress events) ─────────────────────

#[derive(Debug, Clone, Serialize)]
struct DownloadDone {
    success: bool,
    error: Option<String>,
}

/// Download the **selected** embedding model in the background (Memory ▸ Graph
/// gate). The frontend listens for `atlas:memory-embed:progress` and `:done`.
/// The Local Model Manager uses the generic `models::model_download` instead.
#[tauri::command]
pub async fn memory_embed_download(app: AppHandle) -> Result<(), String> {
    let id = super::models::selected_embedding_id(&app);
    let entry =
        super::models::find_entry(&id).ok_or_else(|| format!("unknown embedding model '{id}'"))?;
    let dir = model_dir(&app)?;
    tokio::spawn(async move {
        let result = super::models::download_files(
            &app,
            &id,
            &dir,
            &entry.files,
            "atlas:memory-embed:progress",
        )
        .await;
        let _ = app.emit(
            "atlas:memory-embed:done",
            DownloadDone {
                success: result.is_ok(),
                error: result.err(),
            },
        );
        let _ = app.emit("atlas:models-changed", ());
    });
    Ok(())
}

// ── Graph build ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct GraphNode {
    id: String,
    title: String,
    /// Natural-language one-liner for display (falls back to title).
    summary: String,
    kind: String,
    source: String,
    snippet: String,
    degree: usize,
    /// Unix ms this memory was created (0 if unknown). Drives the temporal view.
    #[serde(rename = "timestampMs")]
    timestamp_ms: i64,
}

#[derive(Debug, Serialize)]
pub struct GraphEdge {
    /// Oriented older → newer: `from` is the earlier memory that plausibly
    /// influenced the later `to`. Lets the UI trace impact forward in time.
    from: String,
    to: String,
    weight: f32,
    kind: String, // "similarity" | "link"
}

#[derive(Debug, Serialize)]
pub struct MemoryGraph {
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    dim: usize,
    doc_count: usize,
}

/// Build (or incrementally refresh) the vector index for the project's memory
/// and return the similarity graph. Errors with `"model-not-downloaded"` if the
/// embedding model isn't present yet (the frontend gates on that).
#[tauri::command]
pub async fn memory_index_build(
    app: AppHandle,
    project_path: String,
    registry: State<'_, Arc<MemoryRegistry>>,
) -> Result<MemoryGraph, String> {
    let dir = model_dir(&app)?;
    let model_ready = MODEL_FILES.iter().all(|f| dir.join(f).exists());
    if !model_ready {
        return Err("model-not-downloaded".into());
    }

    // Exclude the codebase index (source "codebase") — the memory graph is about
    // sessions / preferences / notes, not source files (a dedicated Code Graph was
    // intentionally dropped). Folding the whole codebase in (added in 0.1.18)
    // ballooned this corpus from dozens of docs to hundreds, making "Indexing
    // memory…" crawl on the CPU embedder. The codebase still feeds the
    // `memory_retrieve` HNSW path, which genuinely needs it.
    let docs: Vec<MemoryDoc> = collect_corpus(&project_path)
        .await
        .into_iter()
        .filter(|d| !GRAPH_EXCLUDED_CORPORA.contains(&d.source.as_str()))
        .collect();
    if docs.is_empty() {
        return Ok(MemoryGraph {
            nodes: vec![],
            edges: vec![],
            dim: 0,
            doc_count: 0,
        });
    }

    // Shared, load-once MiniLM (reused by the indexer, retrieve, query, policy and
    // the indexer) instead of loading a fresh ~90 MB model per graph build.
    let provider = registry
        .provider(&app)
        .await
        .ok_or("model-not-downloaded")?;
    let embedder = provider.embedder();

    // Reuse what the retrieval index already holds for unchanged docs; only the
    // rest is embedded below, and handed back to the index afterwards.
    let cached = indexed_vectors(&registry, &provider, &project_path, &docs).await;

    let (graph, fresh) =
        tokio::task::spawn_blocking(move || build_graph_blocking(embedder, docs, cached))
            .await
            .map_err(|e| format!("index task: {e}"))??;

    if !fresh.is_empty() {
        let engine = registry.engine_for(&project_path);
        let mut guard = engine.write().await;
        // A model switch since the lookup leaves this batch in the old space;
        // the indexer re-embeds everything after its reset instead.
        if guard.index_params_match(&provider) {
            if let Err(e) = guard.add_embedded(&fresh) {
                tracing::warn!(target: "atlas::memory", "graph vectors not kept in the index: {e}");
            }
        }
    }
    Ok(graph)
}

/// The graph over `docs`, plus the `(doc, vector)` pairs it had to embed
/// because `cached` (id → vector from the retrieval index) lacked them.
fn build_graph_blocking(
    embedder: Arc<Embedder>,
    docs: Vec<MemoryDoc>,
    cached: std::collections::HashMap<String, Vec<f32>>,
) -> Result<(MemoryGraph, Vec<(CorpusDoc, Vec<f32>)>), String> {
    use std::collections::HashMap;

    let mut vectors: Vec<Vec<f32>> = Vec::with_capacity(docs.len());
    let mut fresh: Vec<(CorpusDoc, Vec<f32>)> = Vec::new();
    let mut dim = 0;
    for doc in &docs {
        if let Some(v) = cached.get(&doc.id) {
            dim = v.len();
            vectors.push(v.clone());
        } else {
            let corpus = to_corpus_doc(doc);
            let v = embedder
                .embed_one(&corpus.text)
                .map_err(|e| format!("embed: {e}"))?;
            dim = v.len();
            vectors.push(v.clone());
            fresh.push((corpus, v));
        }
    }

    // ── Edges ──────────────────────────────────────────────────────────────
    let id_of: Vec<&str> = docs.iter().map(|d| d.id.as_str()).collect();
    // alias → node index, for resolving [[wikilinks]].
    let mut alias_to_idx: HashMap<String, usize> = HashMap::new();
    for (i, d) in docs.iter().enumerate() {
        for a in &d.aliases {
            if !a.is_empty() {
                alias_to_idx.insert(a.to_lowercase(), i);
            }
        }
    }

    // Dedup undirected edges by ordered (min,max) pair; explicit links win.
    let mut edge_map: HashMap<(usize, usize), (f32, &'static str)> = HashMap::new();
    let key = |a: usize, b: usize| if a < b { (a, b) } else { (b, a) };

    // Similarity (kNN) edges.
    let store = BruteForce::new(vectors.clone());
    for (i, neighbors) in store.all_pairs_topk(TOPK).into_iter().enumerate() {
        for (j, score) in neighbors {
            if score < SIM_THRESHOLD {
                continue;
            }
            edge_map.entry(key(i, j)).or_insert((score, "similarity"));
        }
    }
    // Explicit wikilink edges (override similarity for that pair).
    for (i, d) in docs.iter().enumerate() {
        for link in &d.links {
            if let Some(&j) = alias_to_idx.get(&link.to_lowercase()) {
                if i != j {
                    edge_map.insert(key(i, j), (1.0, "link"));
                }
            }
        }
    }

    // Degree per node from the final edge set.
    let mut degree = vec![0usize; docs.len()];
    for &(a, b) in edge_map.keys() {
        degree[a] += 1;
        degree[b] += 1;
    }

    let nodes: Vec<GraphNode> = docs
        .iter()
        .enumerate()
        .map(|(i, d)| GraphNode {
            id: d.id.clone(),
            title: d.title.clone(),
            summary: if d.summary.trim().is_empty() {
                d.title.clone()
            } else {
                d.summary.clone()
            },
            kind: d.kind.clone(),
            source: d.source.clone(),
            snippet: snippet(&d.text),
            degree: degree[i],
            timestamp_ms: d.timestamp_ms,
        })
        .collect();

    // Orient each edge older → newer so the UI can trace influence forward in
    // time. Unknown timestamps (0) sort oldest; ties break by index for stability.
    let ts: Vec<i64> = docs.iter().map(|d| d.timestamp_ms).collect();
    let edges: Vec<GraphEdge> = edge_map
        .into_iter()
        .map(|((a, b), (w, k))| {
            let (older, newer) = if (ts[a], a) <= (ts[b], b) {
                (a, b)
            } else {
                (b, a)
            };
            GraphEdge {
                from: id_of[older].to_string(),
                to: id_of[newer].to_string(),
                weight: w,
                kind: k.to_string(),
            }
        })
        .collect();

    Ok((
        MemoryGraph {
            doc_count: nodes.len(),
            dim,
            nodes,
            edges,
        },
        fresh,
    ))
}

fn snippet(s: &str) -> String {
    let collapsed: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > 240 {
        let head: String = collapsed.chars().take(240).collect();
        format!("{head}…")
    } else {
        collapsed
    }
}

// ── Query ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct QueryHit {
    id: String,
    score: f32,
}

/// Embed `query` and rank the project's indexed memory docs (the Graph's
/// corpora: everything but the codebase) against it.
#[tauri::command]
pub async fn memory_index_query(
    app: AppHandle,
    project_path: String,
    query: String,
    top_k: Option<usize>,
    registry: State<'_, Arc<MemoryRegistry>>,
) -> Result<Vec<QueryHit>, String> {
    let dir = model_dir(&app)?;
    if !MODEL_FILES.iter().all(|f| dir.join(f).exists()) {
        return Err("model-not-downloaded".into());
    }
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let k = top_k.unwrap_or(10);

    // Shared, load-once MiniLM — no per-query model reload (this is the interactive
    // search hot path).
    let provider = registry
        .provider(&app)
        .await
        .ok_or("model-not-downloaded")?;
    let embedder = provider.embedder();
    let qv = tokio::task::spawn_blocking(move || embedder.embed_one(&q))
        .await
        .map_err(|e| format!("query task: {e}"))?
        .map_err(|e| format!("embed query: {e}"))?;

    let engine = registry.engine_for(&project_path);
    let guard = engine.read().await;
    // Vectors from another embedding model live in a different space; until the
    // indexer rebuilds, there is nothing comparable to rank.
    if !guard.index_params_match(&provider) {
        return Ok(vec![]);
    }
    let hits = guard
        .search_ids(&qv, k, &GRAPH_EXCLUDED_CORPORA)
        .map_err(|e| format!("query: {e}"))?;
    Ok(hits
        .into_iter()
        .map(|(id, score)| QueryHit { id, score })
        .collect())
}

// ── Graph layout persistence (mirrors knowledge_graph_layout.rs) ────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Pos {
    x: f64,
    y: f64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct GraphLayout {
    positions: std::collections::HashMap<String, Pos>,
}

fn layout_path(project_path: &str) -> PathBuf {
    atlas_profile::dir_in(std::path::Path::new(project_path)).join("memory-graph-layout.json")
}

#[tauri::command]
pub async fn memory_graph_layout_load(project_path: String) -> Result<GraphLayout, String> {
    Ok(std::fs::read_to_string(layout_path(&project_path))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default())
}

#[tauri::command]
pub async fn memory_graph_layout_save(
    project_path: String,
    layout: GraphLayout,
) -> Result<(), String> {
    let path = layout_path(&project_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create .atlas: {e}"))?;
    }
    let json = serde_json::to_string(&layout).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("write layout: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("finalize layout: {e}"))
}

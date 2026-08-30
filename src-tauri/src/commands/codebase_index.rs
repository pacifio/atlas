//! Codebase indexer for Memory ▸ Chat.
//!
//! Turns the live source tree into fresh, embeddable docs and folds them into the
//! same RAG corpus the chat retrieves from — so answers reflect the codebase as it
//! is *now*, not stale agent memory. Two tiers:
//! - **structural** (always): tree-sitter (`atlas-codeindex`) → per-file language +
//!   imports + symbols. Deterministic, offline, incremental via content hash.
//! - **summaries** (optional): a 1–2 sentence plain-English summary per important
//!   file via the local model or a BYOK provider, prepended to the doc text.
//!
//! After building, it re-runs `memory_index_build` to embed the unified corpus;
//! `collect_corpus` already folds in `.atlas/codebase-index/docs.json`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use atlas_codeindex::{compose_text, scan, structural_text, CodebaseDoc, CodebaseIndex, ScannedFile};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use super::byok::byok_get;
use super::memory_graph::memory_index_build;
use super::memory_indexer::MemoryRegistry;

/// Caps on how many files get an LLM summary per build (structural is uncapped).
const PROVIDER_SUMMARY_CAP: usize = 150;
/// Provider summaries run concurrently (each file is an independent API call).
const PROVIDER_CONCURRENCY: usize = 8;
const SNIPPET_CHARS: usize = 1600;

const SUMMARY_SYSTEM: &str = "You summarize a source file's role in one or two plain sentences — what it is responsible for in the project. Output only the summary: no preamble, no markdown, no code.";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodebaseIndexStatus {
    pub indexed: bool,
    pub file_count: usize,
    pub summary_count: usize,
    pub built_at_ms: i64,
}

#[tauri::command]
pub async fn codebase_index_status(project_path: String) -> Result<CodebaseIndexStatus, String> {
    let pp = project_path.trim_end_matches('/').to_string();
    let idx = tokio::task::spawn_blocking(move || atlas_codeindex::load_index(&pp))
        .await
        .map_err(|e| e.to_string())?;
    Ok(status_of(&idx))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildOpts {
    /// "full" | "incremental" (default).
    #[serde(default)]
    pub mode: String,
    /// "structural" (default) | "provider".
    #[serde(default)]
    pub backend: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    phase: &'static str,
    current: usize,
    total: usize,
}

fn emit(app: &AppHandle, phase: &'static str, current: usize, total: usize) {
    let _ = app.emit("atlas:codebase-index:progress", Progress { phase, current, total });
}

#[tauri::command]
pub async fn codebase_index_build(
    app: AppHandle,
    project_path: String,
    opts: BuildOpts,
    registry: State<'_, Arc<MemoryRegistry>>,
) -> Result<CodebaseIndexStatus, String> {
    let pp = project_path.trim_end_matches('/').to_string();
    let full = opts.mode == "full";

    // 1. Scan (tree-sitter, blocking).
    emit(&app, "scanning", 0, 0);
    let scan_pp = pp.clone();
    let scanned: Vec<ScannedFile> =
        tokio::task::spawn_blocking(move || scan(Path::new(&scan_pp), mtime_ms))
            .await
            .map_err(|e| format!("scan join: {e}"))?;

    // 2. Cheap importance ranking (how many files import each file).
    let ranks = compute_ranks(&scanned);

    // 3. Build structural docs; reuse a prior summary when the file is unchanged.
    let prior = if full {
        CodebaseIndex::default()
    } else {
        let prior_pp = pp.clone();
        tokio::task::spawn_blocking(move || atlas_codeindex::load_index(&prior_pp))
            .await
            .map_err(|e| e.to_string())?
    };
    let prior_by_rel: HashMap<String, CodebaseDoc> =
        prior.docs.into_iter().map(|d| (d.rel.clone(), d)).collect();

    let mut docs: Vec<CodebaseDoc> = Vec::with_capacity(scanned.len());
    let mut to_summarize: Vec<usize> = Vec::new();
    for sf in &scanned {
        let structural = structural_text(&sf.rel, &sf.language, &sf.symbols, &sf.imports);
        let reuse = prior_by_rel.get(&sf.rel).filter(|p| p.hash == sf.hash);
        let summary = reuse.map(|p| p.summary.clone()).unwrap_or_default();
        let doc = CodebaseDoc {
            rel: sf.rel.clone(),
            abs_path: sf.abs_path.clone(),
            language: sf.language.clone(),
            imports: sf.imports.clone(),
            symbols: sf.symbols.clone(),
            hash: sf.hash.clone(),
            mtime_ms: sf.mtime_ms,
            text: compose_text(&summary, &structural),
            summary,
            import_rank: *ranks.get(&sf.rel).unwrap_or(&0),
        };
        if opts.backend != "structural" && doc.summary.is_empty() {
            to_summarize.push(docs.len());
        }
        docs.push(doc);
    }

    // 4. Tier-2 summaries (BYOK; `structural` skips this entirely).
    if opts.backend == "provider" {
        provider_summaries(&app, &opts, &mut docs, &to_summarize).await;
    }

    // 5. Persist.
    let index = CodebaseIndex {
        built_at_ms: chrono::Utc::now().timestamp_millis(),
        docs,
    };
    let save_pp = pp.clone();
    let save_index = index.clone();
    let _ = tokio::task::spawn_blocking(move || atlas_codeindex::save_index(&save_pp, &save_index)).await;

    // 6. Re-embed the unified corpus (codebase docs are now in collect_corpus).
    emit(&app, "embedding", 0, 0);
    let _ = memory_index_build(app.clone(), pp.clone(), registry).await;

    emit(&app, "done", index.docs.len(), index.docs.len());
    Ok(status_of(&index))
}

// ── Summary backends ──────────────────────────────────────────────────────────

async fn provider_summaries(
    app: &AppHandle,
    opts: &BuildOpts,
    docs: &mut [CodebaseDoc],
    to_summarize: &[usize],
) {
    if opts.provider.is_empty() || opts.model.is_empty() {
        return;
    }
    // Guard only: `run_completion` resolves the key itself, but bail before
    // fanning out rather than firing N calls that each fail on a missing key.
    if !matches!(byok_get(app.clone(), opts.provider.clone()), Ok(Some(_))) {
        return;
    }

    let targets = top_targets(docs, to_summarize, PROVIDER_SUMMARY_CAP);
    if targets.is_empty() {
        return;
    }
    let total = targets.len();
    emit(app, "summarizing", 0, total);

    use futures::stream::{self, StreamExt};
    use std::sync::atomic::{AtomicUsize, Ordering};
    let done = Arc::new(AtomicUsize::new(0));
    // Concurrent API calls; emit progress live as each completes so the
    // parallelism is visible.
    let results: Vec<(usize, String)> = stream::iter(targets.into_iter().map(|i| {
        // `run_completion` sends a single user turn, so the system prompt is
        // folded into it (same shape `memory_summarize::summarize` uses).
        let prompt = format!("{SUMMARY_SYSTEM}\n\n{}", build_summary_user(&docs[i]));
        let provider = opts.provider.clone();
        let model = opts.model.clone();
        let app = app.clone();
        let done = done.clone();
        async move {
            let out = super::memory_summarize::run_completion(&app, prompt, &provider, &model)
                .await
                .unwrap_or_default();
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            emit(&app, "summarizing", n, total);
            (i, clean_summary(&out))
        }
    }))
    .buffer_unordered(PROVIDER_CONCURRENCY)
    .collect()
    .await;

    for (i, summary) in results {
        apply_summary(docs, i, summary);
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn status_of(idx: &CodebaseIndex) -> CodebaseIndexStatus {
    CodebaseIndexStatus {
        indexed: !idx.docs.is_empty(),
        file_count: idx.docs.len(),
        summary_count: idx.docs.iter().filter(|d| !d.summary.trim().is_empty()).count(),
        built_at_ms: idx.built_at_ms,
    }
}

/// The highest-ranked `cap` files among those needing a fresh summary.
fn top_targets(docs: &[CodebaseDoc], to_summarize: &[usize], cap: usize) -> Vec<usize> {
    let mut t = to_summarize.to_vec();
    t.sort_by_key(|&i| std::cmp::Reverse(docs[i].import_rank));
    t.truncate(cap);
    t
}

fn apply_summary(docs: &mut [CodebaseDoc], i: usize, summary: String) {
    if summary.is_empty() {
        return;
    }
    let structural = structural_text(&docs[i].rel, &docs[i].language, &docs[i].symbols, &docs[i].imports);
    docs[i].text = compose_text(&summary, &structural);
    docs[i].summary = summary;
}

fn build_summary_user(doc: &CodebaseDoc) -> String {
    let structural = structural_text(&doc.rel, &doc.language, &doc.symbols, &doc.imports);
    let snippet = std::fs::read_to_string(&doc.abs_path)
        .ok()
        .map(|s| s.chars().take(SNIPPET_CHARS).collect::<String>())
        .unwrap_or_default();
    format!("{structural}\n\nSource (truncated):\n{snippet}")
}

fn clean_summary(t: &str) -> String {
    let one_line = t.split_whitespace().collect::<Vec<_>>().join(" ");
    one_line.chars().take(400).collect()
}

/// rel → number of other files that import it (by basename match) — cheap proxy
/// for importance / which files to summarize first.
fn compute_ranks(files: &[ScannedFile]) -> HashMap<String, u32> {
    let mut count: HashMap<String, u32> = HashMap::new();
    for f in files {
        for imp in &f.imports {
            let seg = imp
                .rsplit(['/', ':', '\\'])
                .next()
                .unwrap_or(imp)
                .trim_end_matches(".js")
                .trim_end_matches(".jsx")
                .trim_end_matches(".ts")
                .trim_end_matches(".tsx")
                .trim_end_matches(".py")
                .trim_end_matches(".go")
                .trim_end_matches(".rs");
            if !seg.is_empty() {
                *count.entry(seg.to_string()).or_default() += 1;
            }
        }
    }
    let mut ranks = HashMap::new();
    for f in files {
        let stem = Path::new(&f.rel)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        ranks.insert(f.rel.clone(), count.get(stem).copied().unwrap_or(0));
    }
    ranks
}

fn mtime_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

//! The app side of the code index (atlas-codeindex v2): who owns each
//! project's index, how file changes reach it, and the agent tools and
//! commands that read it.
//!
//! - [`registry`]: one [`CodeIndex`](atlas_codeindex::CodeIndex) and one
//!   worker thread per open project, fed by a coalescing job queue.
//! - [`watch`]: the file and git watchers' change feed.
//! - [`symbols`]: `find_symbol`, `outline`, `read_symbol` on `atlas_code`,
//!   and the locator that names grep hits by their enclosing symbol.
//! - The `codebase_index_status` / `codebase_index_build` commands the
//!   composer's index pill and the turn-end refresh call.

mod registry;
mod symbols;
mod watch;

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

pub use registry::{CodeIndexRegistry, Job, ProjectIndex};
pub use symbols::{call as call_symbol_tool, grep_locator, symbol_tool_specs, Scope, SYMBOL_TOOLS};
pub use watch::feed_from;

use super::byok::byok_get;
use super::memory_indexer::MemoryRegistry;

/// Caps on how many files get an LLM summary per build (structural is uncapped).
const PROVIDER_SUMMARY_CAP: usize = 150;
/// Provider summaries run concurrently (each file is an independent API call).
const PROVIDER_CONCURRENCY: usize = 8;
const SNIPPET_CHARS: usize = 1600;
const SUMMARY_SYSTEM: &str = "You summarize a source file's role in one or two plain sentences — what it is responsible for in the project. Output only the summary: no preamble, no markdown, no code.";

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CodebaseIndexStatus {
    pub indexed: bool,
    pub file_count: usize,
    pub summary_count: usize,
    pub built_at_ms: i64,
}

impl From<&atlas_codeindex::IndexStatus> for CodebaseIndexStatus {
    fn from(s: &atlas_codeindex::IndexStatus) -> Self {
        Self {
            indexed: s.files > 0,
            file_count: s.files,
            summary_count: s.summaries,
            built_at_ms: s.built_at_ms,
        }
    }
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

fn open(registry: &CodeIndexRegistry, project_path: &str) -> Result<Arc<ProjectIndex>, String> {
    registry.ensure_open(Path::new(project_path.trim_end_matches('/')))
}

#[tauri::command]
pub async fn codebase_index_status(
    project_path: String,
    registry: State<'_, Arc<CodeIndexRegistry>>,
) -> Result<CodebaseIndexStatus, String> {
    let registry = registry.inner().clone();
    tokio::task::spawn_blocking(move || {
        let project = open(&registry, &project_path)?;
        let status = project.index.status().map_err(|e| e.to_string())?;
        Ok(CodebaseIndexStatus::from(&status))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn codebase_index_build(
    app: AppHandle,
    project_path: String,
    opts: BuildOpts,
    registry: State<'_, Arc<CodeIndexRegistry>>,
    memory: State<'_, Arc<MemoryRegistry>>,
) -> Result<CodebaseIndexStatus, String> {
    let registry = registry.inner().clone();
    let path = project_path.clone();
    let project = tokio::task::spawn_blocking(move || open(&registry, &path))
        .await
        .map_err(|e| e.to_string())??;
    let _ = app.emit(
        "atlas:codebase-index:progress",
        serde_json::json!({ "phase": "scanning", "current": 0, "total": 0 }),
    );
    let job = if opts.mode == "full" {
        Job::FullBuild
    } else {
        Job::Reconcile
    };
    project
        .enqueue_and_wait(job)
        .await
        .map_err(|e| e.to_string())??;
    if opts.backend == "provider" {
        provider_summaries(&app, &opts, &project).await;
    }
    // Code docs reach the memory corpus through the next IndexCorpus pass.
    memory.request_reindex(project_path.trim_end_matches('/'));
    let status = {
        let project = project.clone();
        tokio::task::spawn_blocking(move || project.index.status())
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?
    };
    let out = CodebaseIndexStatus::from(&status);
    let _ = app.emit(
        "atlas:codebase-index:progress",
        serde_json::json!({ "phase": "done", "current": out.file_count, "total": out.file_count }),
    );
    Ok(out)
}

fn summary_user(doc: &atlas_codeindex::FileDoc, source: &str) -> String {
    let snippet: String = source.chars().take(SNIPPET_CHARS).collect();
    format!(
        "{}\n\nSource (truncated):\n{snippet}",
        doc.structural_text()
    )
}

fn clean_summary(t: &str) -> String {
    t.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(400)
        .collect()
}

/// Tier-2 summaries from the user's provider for the files that need one,
/// stored against each file's content hash so unchanged files keep theirs.
async fn provider_summaries(app: &AppHandle, opts: &BuildOpts, project: &Arc<ProjectIndex>) {
    if opts.provider.is_empty() || opts.model.is_empty() {
        return;
    }
    // Guard only: `run_completion` resolves the key itself, but bail before
    // fanning out rather than firing N calls that each fail on a missing key.
    if !matches!(byok_get(app.clone(), opts.provider.clone()), Ok(Some(_))) {
        return;
    }
    let targets = {
        let project = project.clone();
        match tokio::task::spawn_blocking(move || {
            project.index.summary_targets(PROVIDER_SUMMARY_CAP)
        })
        .await
        {
            Ok(Ok(t)) => t,
            Ok(Err(e)) => {
                tracing::warn!(target: "atlas::code_index", "summary targets: {e}");
                return;
            }
            Err(e) => {
                tracing::warn!(target: "atlas::code_index", "summary targets: {e}");
                return;
            }
        }
    };
    let total = targets.len();
    let _ = app.emit(
        "atlas:codebase-index:progress",
        serde_json::json!({ "phase": "summarizing", "current": 0, "total": total }),
    );
    use futures::stream::{self, StreamExt};
    let done = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let root = project.index.root().to_path_buf();
    let results: Vec<(i64, Vec<u8>, String)> = stream::iter(targets.into_iter().map(|t| {
        let source = std::fs::read_to_string(root.join(&t.doc.rel)).unwrap_or_default();
        // `run_completion` sends a single user turn, so the system prompt is
        // folded into it (same shape `memory_summarize::summarize` uses).
        let prompt = format!("{SUMMARY_SYSTEM}\n\n{}", summary_user(&t.doc, &source));
        let (app, provider, model, done) = (
            app.clone(),
            opts.provider.clone(),
            opts.model.clone(),
            done.clone(),
        );
        async move {
            let out = super::memory_summarize::run_completion(&app, prompt, &provider, &model)
                .await
                .unwrap_or_default();
            let n = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            let _ = app.emit(
                "atlas:codebase-index:progress",
                serde_json::json!({ "phase": "summarizing", "current": n, "total": total }),
            );
            (t.doc.file_id, t.content_hash, clean_summary(&out))
        }
    }))
    .buffer_unordered(PROVIDER_CONCURRENCY)
    .collect()
    .await;
    let project = project.clone();
    let _ = tokio::task::spawn_blocking(move || {
        for (file_id, hash, summary) in results.into_iter().filter(|r| !r.2.is_empty()) {
            if let Err(e) = project.index.put_summary(file_id, &hash, &summary) {
                tracing::warn!(target: "atlas::code_index", "store summary: {e}");
            }
        }
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_maps_index_counts_for_the_pill() {
        let s = atlas_codeindex::IndexStatus {
            files: 3,
            symbols: 9,
            summaries: 1,
            built_at_ms: 42,
            ..Default::default()
        };
        let out = CodebaseIndexStatus::from(&s);
        assert!(out.indexed);
        assert_eq!(
            (out.file_count, out.summary_count, out.built_at_ms),
            (3, 1, 42)
        );
        let empty = CodebaseIndexStatus::from(&atlas_codeindex::IndexStatus::default());
        assert!(!empty.indexed);
    }

    #[test]
    fn summary_prompt_carries_structure_and_a_bounded_snippet() {
        let doc = atlas_codeindex::FileDoc {
            file_id: 1,
            rel: "src/a.rs".into(),
            lang: "rust".into(),
            mtime_ms: 0,
            symbols: vec![("fn".into(), "a".into())],
            imports: vec![],
            summary: String::new(),
        };
        let p = summary_user(&doc, &"x".repeat(5000));
        assert!(p.starts_with("File src/a.rs (rust). Defines: fn a."));
        assert!(p.len() < 1700 + 100);
    }
}

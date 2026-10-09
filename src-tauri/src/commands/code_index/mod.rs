//! The app side of the code index (atlas-codeindex v2): who owns each
//! project's index, how file changes reach it, and the agent tools and
//! commands that read it.
//!
//! - [`registry`]: one [`CodeIndex`](atlas_codeindex::CodeIndex) and one
//!   worker thread per open project, fed by a coalescing job queue.
//! - [`watch`]: the file and git watchers' change feed.
//! - [`symbols`]: `find_symbol`, `outline`, `read_symbol` on `atlas_code`,
//!   and the locator that names grep hits by their enclosing symbol.
//! - [`graph_tools`]: `related`, `impact_of_diff`, `repo_map`.
//! - [`semantic_tools`]: `semantic_search` and the pulled `task_context`
//!   seed (ADR-0016); [`embed`] loads the code embedding model.
//! - The `codebase_index_status` / `codebase_index_build` commands the
//!   composer's index pill and the turn-end refresh call.

pub mod citations;
pub mod embed;
mod graph_tools;
pub mod grep_index;
mod registry;
mod semantic_tools;
mod symbols;
mod watch;

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

pub use registry::{CodeIndexRegistry, Job, ProjectIndex};
pub use symbols::{grep_locator, Scope};
pub use watch::feed_from;

/// `(name, description, input schema)` of every tool the code index serves
/// on `atlas_code`, in listing order.
pub fn index_tool_specs() -> Vec<(&'static str, &'static str, serde_json::Value)> {
    let mut specs = symbols::symbol_tool_specs();
    specs.extend(graph_tools::graph_tool_specs());
    specs.extend(semantic_tools::semantic_tool_specs());
    specs
}

/// Whether `name` is one of [`index_tool_specs`]'s tools.
pub fn is_index_tool(name: &str) -> bool {
    symbols::SYMBOL_TOOLS.contains(&name)
        || graph_tools::GRAPH_TOOLS.contains(&name)
        || semantic_tools::SEMANTIC_TOOLS.contains(&name)
}

/// The tool error while an empty index is being built.
const STILL_BUILDING: &str =
    "the code index is still being built for this project; use grep meanwhile and retry shortly";
/// The first line of an answer read from rows a full build will replace.
const REBUILDING_NOTE: &str =
    "note: the code index is being rebuilt; these results may be outdated\n";

/// Run one code index tool for a session. Blocking (SQLite, file reads,
/// `git diff`). `Err` is the text of a tool error.
///
/// Never waits on the worker: an empty index it is still building is a tool
/// error, and an answer from rows a full build is about to replace carries
/// [`REBUILDING_NOTE`]. Watcher edits (`Paths`, `Reconcile`) and vector
/// syncs get no note: they run all the time and leave the rows current.
pub fn call_index_tool(
    scope: &Scope,
    registry: &CodeIndexRegistry,
    name: &str,
    args: &serde_json::Value,
) -> Result<String, String> {
    let status = scope.project.index.status().map_err(|e| e.to_string())?;
    if status.files == 0 && scope.project.is_indexing() {
        return Err(STILL_BUILDING.into());
    }
    let rebuilding = scope.project.is_rebuilding();
    let out = if graph_tools::GRAPH_TOOLS.contains(&name) {
        graph_tools::call(scope, name, args)
    } else if semantic_tools::SEMANTIC_TOOLS.contains(&name) {
        semantic_tools::call(scope, registry, name, args)
    } else {
        symbols::call(scope, name, args)
    };
    if !rebuilding {
        return out;
    }
    // Errors too: "no symbol named X" from the old rows misleads just the same.
    out.map(|t| format!("{REBUILDING_NOTE}{t}"))
        .map_err(|e| format!("{REBUILDING_NOTE}{e}"))
}

use super::byok::byok_get;

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
) -> Result<CodebaseIndexStatus, String> {
    let registry = registry.inner().clone();
    let project = tokio::task::spawn_blocking(move || open(&registry, &project_path))
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

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(
            dir.path().join("src/a.rs"),
            "pub fn alpha() {}\npub fn beta() {\n    alpha();\n}\n",
        )
        .unwrap();
        dir
    }

    /// Every index tool, with arguments it accepts on the fixture.
    fn every_tool() -> Vec<(&'static str, serde_json::Value)> {
        use serde_json::json;
        let tools = vec![
            ("find_symbol", json!({ "query": "alpha" })),
            ("outline", json!({ "path": "src/a.rs" })),
            ("read_symbol", json!({ "name": "alpha" })),
            ("related", json!({ "symbol": "alpha" })),
            ("impact_of_diff", json!({})),
            ("repo_map", json!({})),
            ("semantic_search", json!({ "query": "alpha" })),
            ("task_context", json!({ "task": "change alpha_fn" })),
        ];
        let names: Vec<_> = tools.iter().map(|t| t.0).collect();
        let listed: Vec<_> = index_tool_specs().into_iter().map(|t| t.0).collect();
        assert_eq!(names, listed, "a new index tool needs a row here");
        tools
    }

    fn built(dir: &Path) -> (CodeIndexRegistry, Scope) {
        let reg = CodeIndexRegistry::new(None);
        reg.ensure_open(dir)
            .unwrap()
            .enqueue_and_wait(Job::Reconcile)
            .blocking_recv()
            .unwrap()
            .unwrap();
        let scope = Scope::resolve(&reg, dir).unwrap();
        (reg, scope)
    }

    fn wait_for(mut cond: impl FnMut() -> bool) {
        let start = std::time::Instant::now();
        while !cond() {
            assert!(
                start.elapsed() < std::time::Duration::from_secs(10),
                "timed out"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    #[test]
    fn every_tool_refuses_an_empty_index_still_being_built() {
        let dir = fixture();
        let reg = CodeIndexRegistry::new(None);
        let gate = reg.hold_jobs();
        let scope = Scope::resolve(&reg, dir.path()).unwrap(); // queues the first build
        assert!(scope.project.is_rebuilding());
        for (name, args) in every_tool() {
            assert_eq!(
                call_index_tool(&scope, &reg, name, &args),
                Err(STILL_BUILDING.to_string()),
                "{name}"
            );
        }
        drop(gate);
        wait_for(|| !scope.project.is_busy());
    }

    #[test]
    fn a_vector_sync_over_an_empty_index_is_not_a_build() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        let (reg, scope) = built(dir.path());
        let gate = reg.hold_jobs();
        scope.project.enqueue(Job::Vectors);
        wait_for(|| scope.project.queue_drained());
        for (name, args) in every_tool() {
            let out = call_index_tool(&scope, &reg, name, &args);
            let text = out.as_ref().unwrap_or_else(|e| e);
            assert_ne!(text, STILL_BUILDING, "{name}");
            assert!(!text.starts_with(REBUILDING_NOTE), "{name}: {text}");
        }
        drop(gate);
        wait_for(|| !scope.project.is_busy());
    }

    #[test]
    fn answers_from_old_rows_carry_the_rebuild_note() {
        let dir = fixture();
        let (reg, scope) = built(dir.path());
        let gate = reg.hold_jobs();
        scope.project.enqueue(Job::FullBuild);
        let check = |when: &str| {
            for (name, args) in every_tool() {
                let out = call_index_tool(&scope, &reg, name, &args);
                let text = out.as_ref().unwrap_or_else(|e| e);
                assert!(text.starts_with(REBUILDING_NOTE), "{when} {name}: {text}");
            }
            let map = call_index_tool(&scope, &reg, "repo_map", &serde_json::json!({})).unwrap();
            assert!(map.contains("alpha"), "{when}: {map}");
        };
        check("queued");
        wait_for(|| scope.project.queue_drained());
        assert!(scope.project.is_rebuilding());
        check("running");
        drop(gate);
        wait_for(|| !scope.project.is_busy());
        let map = call_index_tool(&scope, &reg, "repo_map", &serde_json::json!({})).unwrap();
        assert!(!map.starts_with(REBUILDING_NOTE), "{map}");
    }

    #[test]
    fn edits_and_vector_syncs_in_flight_add_no_note() {
        let dir = fixture();
        let (reg, scope) = built(dir.path());
        for job in [
            Job::Paths(vec![dir.path().join("src/a.rs")]),
            Job::Reconcile,
            Job::Vectors,
        ] {
            let gate = reg.hold_jobs();
            scope.project.enqueue(job.clone());
            wait_for(|| scope.project.queue_drained());
            assert!(!scope.project.is_rebuilding(), "{job:?}");
            for name in ["find_symbol", "related", "repo_map", "semantic_search"] {
                let args = &every_tool().into_iter().find(|t| t.0 == name).unwrap().1;
                let out = call_index_tool(&scope, &reg, name, args)
                    .unwrap_or_else(|e| panic!("{job:?} {name}: {e}"));
                assert!(!out.starts_with(REBUILDING_NOTE), "{job:?} {name}: {out}");
            }
            drop(gate);
            wait_for(|| !scope.project.is_busy());
        }
    }
}

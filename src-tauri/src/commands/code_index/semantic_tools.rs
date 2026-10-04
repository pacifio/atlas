//! `semantic_search` and `task_context`: natural-language code search and the
//! pulled first-look seed (ADR-0016) on `atlas_code`.

use atlas_codeindex::{RepoMapFocus, SemanticQuery};
use atlas_search::compact::{render, Page, Table};
use serde_json::{json, Value};

use super::symbols::{arg_str, arg_usize, budget, Scope};
use super::CodeIndexRegistry;

pub const SEMANTIC_TOOLS: [&str; 2] = ["semantic_search", "task_context"];

pub fn semantic_tool_specs() -> Vec<(&'static str, &'static str, Value)> {
    let budget = json!({ "type": "integer", "description": "Output budget in tokens (1000-12000; default 4096)." });
    vec![
        (
            "semantic_search",
            "Search code by meaning: describe behaviour in plain words (\"where do we retry failed uploads\"). Fuses \
             embeddings, keyword and symbol matches; returns path:lines, the enclosing symbol and a short preview. Use \
             grep instead when you know an exact identifier or string.",
            json!({ "type": "object", "properties": {
                "query": { "type": "string" },
                "path_glob": { "type": "string", "description": "Only paths matching this glob, e.g. \"src-tauri/**\"." },
                "lang": { "type": "string", "enum": ["rust", "typescript", "javascript", "python", "go"] },
                "limit": { "type": "integer", "minimum": 1, "maximum": 50 },
                "offset": { "type": "integer", "minimum": 0 },
                "max_output_tokens": budget },
                "required": ["query"] }),
        ),
        (
            "task_context",
            "First look for a coding task: a repo map personalized to the task's identifiers plus the top matching code. \
             Call it once at the start of a non-trivial code task in an unfamiliar area; skip it for questions that need no code.",
            json!({ "type": "object", "properties": {
                "task": { "type": "string", "description": "The task in the user's words." },
                "files": { "type": "array", "items": { "type": "string" }, "description": "Files already open or mentioned." },
                "max_output_tokens": budget },
                "required": ["task"] }),
        ),
    ]
}

fn hits_table(scope: &Scope, hits: &[atlas_codeindex::ChunkHit]) -> Table {
    Table {
        name: "results".into(),
        cols: vec!["location", "symbol", "via", "preview"],
        rows: hits
            .iter()
            .map(|h| {
                vec![
                    format!(
                        "{}:{}-{}",
                        scope.to_session(&h.rel),
                        h.start_line,
                        h.end_line
                    ),
                    h.header.split(" :: ").nth(1).unwrap_or("").to_string(),
                    h.legs.clone(),
                    h.preview
                        .lines()
                        .map(str::trim)
                        .collect::<Vec<_>>()
                        .join(" ⏎ "),
                ]
            })
            .collect(),
    }
}

pub fn call(
    scope: &Scope,
    registry: &CodeIndexRegistry,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    let index = &scope.project.index;
    let embedder = registry.embedder();
    let mode_note = if embedder.is_some() {
        ""
    } else {
        "mode: keyword+symbol only (code embedding model not downloaded: Settings → Models)\n"
    };
    match name {
        "semantic_search" => {
            let q = SemanticQuery {
                query: arg_str(args, "query")
                    .ok_or("semantic_search needs `query`")?
                    .to_string(),
                path_glob: arg_str(args, "path_glob").map(|g| scope.to_index(g)),
                lang: arg_str(args, "lang").map(str::to_string),
                within: scope.within(),
                limit: arg_usize(args, "limit").unwrap_or(10),
                offset: arg_usize(args, "offset").unwrap_or(0),
            };
            let (hits, page) = index
                .semantic_search(&q, embedder.as_deref())
                .map_err(|e| e.to_string())?;
            Ok(format!(
                "{mode_note}{}",
                render(&[hits_table(scope, &hits)], &page, budget(args))
            ))
        }
        "task_context" => {
            let task = arg_str(args, "task").ok_or("task_context needs `task`")?;
            let idents: Vec<String> = task
                .split(|c: char| !c.is_alphanumeric() && c != '_')
                .filter(|w| w.len() >= 4 && (w.contains('_') || w.chars().any(char::is_uppercase)))
                .map(str::to_string)
                .collect();
            let files: Vec<String> = args
                .get("files")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(|f| scope.to_index(f))
                        .collect()
                })
                .unwrap_or_default();
            let budget = budget(args);
            let map = index
                .repo_map(
                    &RepoMapFocus {
                        files,
                        idents,
                        within: scope.within(),
                    },
                    budget / 4 / 2,
                )
                .map_err(|e| e.to_string())?;
            let q = SemanticQuery {
                query: task.to_string(),
                within: scope.within(),
                limit: 5,
                ..Default::default()
            };
            let (hits, _) = index
                .semantic_search(&q, embedder.as_deref())
                .map_err(|e| e.to_string())?;
            let page = Page {
                total: hits.len(),
                total_exact: true,
                offset: 0,
                next_offset: None,
                truncation: None,
            };
            Ok(format!(
                "{mode_note}repo_map:\n{map}\n{}",
                render(&[hits_table(scope, &hits)], &page, budget / 2)
            ))
        }
        other => Err(format!("unknown tool `{other}`")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semantic_search_and_task_context_answer_without_a_model() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(
            dir.path().join("src/net.rs"),
            "/// Retry with exponential backoff.\npub fn retry_with_backoff() {}\n",
        )
        .unwrap();
        let reg = std::sync::Arc::new(super::super::CodeIndexRegistry::new(None));
        reg.ensure_open(dir.path())
            .unwrap()
            .enqueue_and_wait(super::super::Job::FullBuild)
            .blocking_recv()
            .unwrap()
            .unwrap();
        let scope = super::super::Scope::resolve(&reg, dir.path()).unwrap();
        let out = call(
            &scope,
            &reg,
            "semantic_search",
            &serde_json::json!({ "query": "how do we retry with backoff" }),
        )
        .unwrap();
        assert!(
            out.contains("src/net.rs") && out.contains("keyword+symbol only"),
            "{out}"
        );
        let ctx = call(
            &scope,
            &reg,
            "task_context",
            &serde_json::json!({ "task": "make retry_with_backoff jittered" }),
        )
        .unwrap();
        assert!(
            ctx.contains("repo_map:") && ctx.contains("retry_with_backoff"),
            "{ctx}"
        );
    }
}

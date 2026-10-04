//! `related`, `impact_of_diff` and `repo_map`: the code graph as `atlas_code`
//! tools. Paths in and out are session-relative (see `Scope`).

use atlas_codeindex::{git_diff_hunks, RelatedHit, RelatedQuery, Relation, RepoMapFocus};
use atlas_search::compact::{render, Page, Table};
use serde_json::{json, Value};

use super::symbols::{arg_str, arg_usize, budget, Scope};

pub const GRAPH_TOOLS: [&str; 3] = ["related", "impact_of_diff", "repo_map"];
const RELATIONS: &str = "callers, callees, importers, imports, implementations, tests";

pub fn graph_tool_specs() -> Vec<(&'static str, &'static str, Value)> {
    let budget = json!({ "type": "integer", "description": "Output budget in tokens (1000-12000; default 4096)." });
    vec![
        (
            "related",
            "Walk the code graph from a symbol (or a file, for importers/imports): callers, callees, implementations, tests, \
             importers, imports, up to 3 hops. Rows carry hop, risk (CRITICAL=direct) and resolution confidence. Use before \
             editing or renaming to see the ripple.",
            json!({ "type": "object", "properties": {
                "symbol": { "type": "string", "description": "Qualified or plain name, or a path for importers/imports." },
                "relation": { "type": "string", "enum": ["callers","callees","importers","imports","implementations","tests"] },
                "hops": { "type": "integer", "minimum": 1, "maximum": 3, "description": "Default 1." },
                "include_tests": { "type": "boolean" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 500 },
                "offset": { "type": "integer", "minimum": 0 },
                "max_output_tokens": budget },
                "required": ["symbol", "relation"] }),
        ),
        (
            "impact_of_diff",
            "What the uncommitted changes (or the changes since `base`) touch: changed definitions and everything that calls \
             them, by hop with risk labels. Run it before finishing a change to check what else needs updating or testing.",
            json!({ "type": "object", "properties": {
                "base": { "type": "string", "description": "Branch or commit to diff against (merge-base). Default: HEAD." },
                "depth": { "type": "integer", "minimum": 1, "maximum": 3, "description": "Default 2." },
                "max_output_tokens": budget } }),
        ),
        (
            "repo_map",
            "A ranked map of the repository's most important definitions with signatures, personalized to the files and \
             identifiers you name. Cheap orientation at the start of a task or when tracing a failure.",
            json!({ "type": "object", "properties": {
                "focus_files": { "type": "array", "items": { "type": "string" } },
                "focus_idents": { "type": "array", "items": { "type": "string" } },
                "max_output_tokens": budget } }),
        ),
    ]
}

fn rows(scope: &Scope, hits: &[RelatedHit]) -> Vec<Vec<String>> {
    hits.iter()
        .map(|h| {
            vec![
                h.qualified_name.clone(),
                h.kind.clone(),
                format!(
                    "{}:{}-{}",
                    scope.to_session(&h.rel),
                    h.start_line,
                    h.end_line
                ),
                h.hop.to_string(),
                h.risk().to_string(),
                format!("{:.2}", h.confidence),
            ]
        })
        .collect()
}

const COLS: [&str; 6] = ["symbol", "kind", "location", "hop", "risk", "confidence"];

pub fn call(scope: &Scope, name: &str, args: &Value) -> Result<String, String> {
    let index = &scope.project.index;
    match name {
        "related" => {
            let target = arg_str(args, "symbol").ok_or("related needs `symbol`")?;
            let relation = arg_str(args, "relation")
                .and_then(Relation::parse)
                .ok_or_else(|| format!("related needs `relation`: one of {RELATIONS}"))?;
            // Importers/imports take a session-relative path; every other relation a name
            // (Python qualified names contain dots, so dots alone do not make a path).
            let file_level = matches!(relation, Relation::Importers | Relation::Imports);
            let target = if file_level && (target.contains('/') || target.contains('.')) {
                scope.to_index(target)
            } else {
                target.to_string()
            };
            let q = RelatedQuery {
                target,
                relation,
                hops: u8::try_from(arg_usize(args, "hops").unwrap_or(1)).unwrap_or(3),
                include_tests: args
                    .get("include_tests")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                within: scope.within(),
                limit: arg_usize(args, "limit").unwrap_or(50),
                offset: arg_usize(args, "offset").unwrap_or(0),
            };
            let (hits, page) = index.related(&q).map_err(|e| match e {
                atlas_codeindex::IndexError::NotFound { query, suggestions }
                    if !suggestions.is_empty() =>
                {
                    format!(
                        "no symbol named `{query}`. Closest: {}",
                        suggestions.join(", ")
                    )
                }
                e => e.to_string(),
            })?;
            let table = Table {
                name: arg_str(args, "relation").unwrap_or("related").into(),
                cols: COLS.to_vec(),
                rows: rows(scope, &hits),
            };
            Ok(render(&[table], &page, budget(args)))
        }
        "impact_of_diff" => {
            let hunks =
                git_diff_hunks(index.root(), arg_str(args, "base")).map_err(|e| e.to_string())?;
            let depth = u8::try_from(arg_usize(args, "depth").unwrap_or(2)).unwrap_or(3);
            let mut r = index
                .impact_of_diff(&hunks, depth)
                .map_err(|e| e.to_string())?;
            // Changes and impact outside the session root are not shown.
            r.changed_files.retain(|f| scope.contains(f));
            r.changed.retain(|h| scope.contains(&h.rel));
            r.impacted.retain(|h| scope.contains(&h.rel));
            let changed_files = Table {
                name: "changed_files".into(),
                cols: vec!["path"],
                rows: r
                    .changed_files
                    .iter()
                    .map(|f| vec![scope.to_session(f)])
                    .collect(),
            };
            let changed = Table {
                name: "changed".into(),
                cols: COLS.to_vec(),
                rows: rows(scope, &r.changed),
            };
            let impacted = Table {
                name: "impacted".into(),
                cols: COLS.to_vec(),
                rows: rows(scope, &r.impacted),
            };
            let total = r.changed_files.len() + r.changed.len() + r.impacted.len();
            let page = Page {
                total,
                total_exact: !r.truncated,
                offset: 0,
                next_offset: None,
                truncation: r.truncated.then_some("row_cap"),
            };
            Ok(render(
                &[changed_files, changed, impacted],
                &page,
                budget(args),
            ))
        }
        "repo_map" => {
            let list = |key: &str| -> Vec<String> {
                args.get(key)
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default()
            };
            let focus = RepoMapFocus {
                files: list("focus_files")
                    .iter()
                    .map(|f| scope.to_index(f))
                    .collect(),
                idents: list("focus_idents"),
                within: scope.within(),
            };
            let tokens = budget(args) / 4;
            let map = index.repo_map(&focus, tokens).map_err(|e| e.to_string())?;
            Ok(if map.is_empty() {
                "repo_map: empty (the index has no definitions yet)".into()
            } else {
                format!("repo_map:\n{map}")
            })
        }
        other => Err(format!("unknown graph tool `{other}`")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn related_impact_and_repo_map_answer_in_compact_tables() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        let w = |rel: &str, body: &str| {
            let p = dir.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        };
        w("src/lib.rs", "pub mod a;\npub mod b;\n");
        w("src/a.rs", "pub fn leaf() {}\n");
        w(
            "src/b.rs",
            "use crate::a::leaf;\npub fn top() { leaf(); }\n",
        );
        let reg = std::sync::Arc::new(super::super::CodeIndexRegistry::new(None));
        reg.ensure_open(dir.path())
            .unwrap()
            .enqueue_and_wait(super::super::Job::FullBuild)
            .blocking_recv()
            .unwrap()
            .unwrap();
        let scope = super::super::Scope::resolve(&reg, dir.path()).unwrap();
        let callers = call(
            &scope,
            "related",
            &serde_json::json!({ "symbol": "leaf", "relation": "callers" }),
        )
        .unwrap();
        assert!(callers.starts_with("callers: 1"), "{callers}");
        assert!(
            callers.contains("top") && callers.contains("CRITICAL"),
            "{callers}"
        );
        let map = call(
            &scope,
            "repo_map",
            &serde_json::json!({ "max_output_tokens": 1000 }),
        )
        .unwrap();
        assert!(map.contains("src/a.rs:") && map.contains("leaf"), "{map}");
        let bad = call(
            &scope,
            "related",
            &serde_json::json!({ "symbol": "leaf", "relation": "friends" }),
        )
        .unwrap_err();
        assert!(bad.contains("callers, callees"), "{bad}");
    }
}

//! `find_symbol`, `outline` and `read_symbol`: the code index as `atlas_code`
//! tools, plus the locator that annotates grep hits with their enclosing
//! symbol. Paths in and out are relative to the session root; the index may
//! sit higher (a session launched in a subdirectory of an open project).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use atlas_codeindex::{IndexError, SymbolHit, SymbolQuery};
use atlas_search::compact::{render, Page, Table};
use atlas_search::{EnclosingSymbol, SymbolLocator, DEFAULT_BUDGET_BYTES};
use serde_json::{json, Value};

use super::registry::{CodeIndexRegistry, Job, ProjectIndex};

pub const SYMBOL_TOOLS: [&str; 3] = ["find_symbol", "outline", "read_symbol"];
const DEFAULT_MAX_LINES: usize = 200;
const MAX_FIND_LIMIT: usize = 100;

/// `(name, description, input schema)` for each symbol tool.
pub fn symbol_tool_specs() -> Vec<(&'static str, &'static str, Value)> {
    let budget = json!({ "type": "integer", "description": "Output budget in tokens (1000-12000; default 4096)." });
    vec![
        (
            "find_symbol",
            "Find definitions by name: exact names first, then camelCase/snake_case word matches. Returns qualified \
             name, kind, path:lines and signature. Use it before grep when you know part of a name.",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Name, qualified name (Type::method, Class.method) or words." },
                    "kind": { "type": "string", "description": "Only this kind: fn, method, struct, class, trait, interface, enum, type, const, mod, macro." },
                    "path": { "type": "string", "description": "Only under this path prefix." },
                    "include_tests": { "type": "boolean", "description": "Default true; tests rank last." },
                    "limit": { "type": "integer", "description": "Default 20, max 100." },
                    "offset": { "type": "integer" },
                    "max_output_tokens": budget
                },
                "required": ["query"]
            }),
        ),
        (
            "outline",
            "The symbols one file defines, nested, with line ranges and signatures. Cheaper than reading the file.",
            json!({
                "type": "object",
                "properties": { "path": { "type": "string" }, "max_output_tokens": budget },
                "required": ["path"]
            }),
        ),
        (
            "read_symbol",
            "The source of one definition, by name or qualified name, read from disk now with line numbers. A symbol \
             longer than max_lines returns its members instead; read one of those next.",
            json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Name or qualified name, e.g. CodeIndex::open." },
                    "path": { "type": "string", "description": "Pick the definition in this file when the name is ambiguous." },
                    "max_lines": { "type": "integer", "description": "Default 200." },
                    "max_output_tokens": budget
                },
                "required": ["name"]
            }),
        ),
    ]
}

/// Files whose presence marks a folder as a project root.
const PROJECT_MARKERS: [&str; 8] = [
    ".git",
    "Cargo.toml",
    "package.json",
    "go.mod",
    "pyproject.toml",
    "setup.py",
    "tsconfig.json",
    "deno.json",
];

/// Whether an agent's working folder may get a code index opened for it on
/// first use: only a folder that looks like a project, so an agent launched
/// in some large plain folder does not have all of it parsed.
fn looks_like_project(root: &Path) -> bool {
    PROJECT_MARKERS.iter().any(|m| root.join(m).exists())
}

/// Where a session sits inside an indexed project.
pub struct Scope {
    pub project: Arc<ProjectIndex>,
    /// The session root relative to the index root ("" when they match).
    prefix: String,
}

fn rel_string(p: &Path) -> String {
    p.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

impl Scope {
    /// The project whose index covers `session_root`, opening one at the
    /// session root when none does. Blocking.
    pub fn resolve(registry: &CodeIndexRegistry, session_root: &Path) -> Result<Scope, String> {
        let session = dunce::canonicalize(session_root)
            .map_err(|e| format!("{}: {e}", session_root.display()))?;
        let project = match registry.root_for(&session) {
            Some(p) => p,
            None if looks_like_project(&session) => registry.ensure_open(&session)?,
            None => {
                return Err(format!(
                    "no code index for {}: it is not an open project and has no .git or project manifest. \
                     grep and find_files still work here.",
                    session.display()
                ))
            }
        };
        let prefix = session
            .strip_prefix(project.index.root())
            .map(rel_string)
            .unwrap_or_default();
        Ok(Scope { project, prefix })
    }

    /// The session root as a `within` filter: `None` when it is the index root.
    pub(super) fn within(&self) -> Option<String> {
        (!self.prefix.is_empty()).then(|| self.prefix.clone())
    }

    /// Whether an index-relative path lies inside the session root.
    pub(super) fn contains(&self, index_rel: &str) -> bool {
        atlas_codeindex::is_within(index_rel, Some(&self.prefix))
    }

    /// A path an agent passed, as an index-relative `/` path: relative to the
    /// session root, or absolute inside the project (`\\` separators on Windows).
    pub(super) fn to_index(&self, session_rel: &str) -> String {
        let root = self.project.index.root();
        let given = Path::new(session_rel);
        if given.is_absolute() {
            let inside = given.strip_prefix(root).map(rel_string).or_else(|_| {
                dunce::canonicalize(given)
                    .map_err(|_| ())
                    .and_then(|p| p.strip_prefix(root).map(rel_string).map_err(|_| ()))
            });
            if let Ok(rel) = inside {
                return rel;
            }
        }
        let normalized = if cfg!(windows) {
            session_rel.replace('\\', "/")
        } else {
            session_rel.to_string()
        };
        let rel = normalized.trim_start_matches("./").trim_end_matches('/');
        if self.prefix.is_empty() {
            rel.to_string()
        } else {
            format!("{}/{rel}", self.prefix)
        }
    }

    pub(super) fn to_session(&self, index_rel: &str) -> String {
        if self.prefix.is_empty() {
            return index_rel.to_string();
        }
        match index_rel
            .strip_prefix(&self.prefix)
            .and_then(|r| r.strip_prefix('/'))
        {
            Some(r) => r.to_string(),
            None => self
                .project
                .index
                .root()
                .join(index_rel)
                .to_string_lossy()
                .into_owned(),
        }
    }
}

pub(super) fn budget(args: &Value) -> usize {
    args.get("max_output_tokens")
        .and_then(Value::as_u64)
        .map_or(DEFAULT_BUDGET_BYTES, |t| {
            usize::try_from(t.clamp(1000, 12_000) * 4).unwrap_or(DEFAULT_BUDGET_BYTES)
        })
}

pub(super) fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

pub(super) fn arg_usize(args: &Value, key: &str) -> Option<usize> {
    args.get(key)
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
}

/// Run one symbol tool (blocking: SQLite and file reads). `Err` is the text
/// of a tool error.
pub fn call(scope: &Scope, name: &str, args: &Value) -> Result<String, String> {
    let index = &scope.project.index;
    let status = index.status().map_err(|e| e.to_string())?;
    if status.files == 0 && scope.project.is_busy() {
        return Err("the code index is still being built for this project; use grep meanwhile and retry shortly".into());
    }
    match name {
        "find_symbol" => find_symbol(scope, args),
        "outline" => outline(scope, args),
        "read_symbol" => read_symbol(scope, args),
        other => Err(format!("unknown tool `{other}`")),
    }
}

fn loc(scope: &Scope, h: &SymbolHit) -> String {
    format!(
        "{}:{}-{}",
        scope.to_session(&h.rel),
        h.start_line,
        h.end_line
    )
}

fn kind_cell(h: &SymbolHit) -> String {
    if h.is_test {
        format!("{} test", h.kind)
    } else {
        h.kind.clone()
    }
}

fn find_symbol(scope: &Scope, args: &Value) -> Result<String, String> {
    let query = arg_str(args, "query").ok_or("find_symbol needs `query`")?;
    let q = SymbolQuery {
        query: query.to_string(),
        kind: arg_str(args, "kind").map(str::to_string),
        path_prefix: arg_str(args, "path").map(|p| scope.to_index(p)),
        exclude_tests: args.get("include_tests").and_then(Value::as_bool) == Some(false),
        within: scope.within(),
        limit: arg_usize(args, "limit").unwrap_or(20).min(MAX_FIND_LIMIT),
        offset: arg_usize(args, "offset").unwrap_or(0),
    };
    let (hits, page) = scope
        .project
        .index
        .find_symbol(&q)
        .map_err(|e| e.to_string())?;
    if hits.is_empty() {
        return Ok(format!(
            "symbols: 0 for {query:?}. Try fewer words, another spelling, or grep."
        ));
    }
    let rows = hits
        .iter()
        .map(|h| {
            vec![
                h.qualified_name.clone(),
                kind_cell(h),
                loc(scope, h),
                h.signature.clone(),
            ]
        })
        .collect();
    let table = Table {
        name: "symbols".into(),
        cols: vec!["symbol", "kind", "loc", "signature"],
        rows,
    };
    Ok(render(&[table], &page, budget(args)))
}

/// One row per symbol, names indented under their parent.
fn outline_rows(hits: &[SymbolHit]) -> Vec<Vec<String>> {
    let mut depth: HashMap<i64, usize> = HashMap::new();
    hits.iter()
        .map(|h| {
            let d = h.parent_id.and_then(|p| depth.get(&p)).map_or(0, |d| d + 1);
            depth.insert(h.id, d);
            vec![
                format!("{}{}", "  ".repeat(d), h.name),
                kind_cell(h),
                format!("{}-{}", h.start_line, h.end_line),
                h.signature.clone(),
            ]
        })
        .collect()
}

fn outline(scope: &Scope, args: &Value) -> Result<String, String> {
    let path = arg_str(args, "path").ok_or("outline needs `path`")?;
    let rel = scope.to_index(path);
    if !scope.contains(&rel) {
        return Err(format!("`{path}` is outside the session root"));
    }
    let hits = scope
        .project
        .index
        .outline(&rel)
        .map_err(|e| e.to_string())?;
    if hits.is_empty() {
        return Ok(format!(
            "outline: 0 for {path}. The file has no indexed definitions, is skipped (vendor/generated/too large), or does not exist."
        ));
    }
    let rows = outline_rows(&hits);
    let page = Page {
        total: rows.len(),
        total_exact: true,
        offset: 0,
        next_offset: None,
        truncation: None,
    };
    let table = Table {
        name: "outline".into(),
        cols: vec!["symbol", "kind", "lines", "signature"],
        rows,
    };
    Ok(render(&[table], &page, budget(args)))
}

fn read_symbol(scope: &Scope, args: &Value) -> Result<String, String> {
    let name = arg_str(args, "name").ok_or("read_symbol needs `name`")?;
    let key = match arg_str(args, "path") {
        Some(p) => format!("{}#{name}", scope.to_index(p)),
        None => name.to_string(),
    };
    let max_lines = arg_usize(args, "max_lines")
        .unwrap_or(DEFAULT_MAX_LINES)
        .max(1);
    let src =
        match scope
            .project
            .index
            .read_symbol_within(&key, max_lines, scope.within().as_deref())
        {
            Ok(s) => s,
            Err(IndexError::NotFound { suggestions, .. }) if !suggestions.is_empty() => {
                return Err(format!(
                    "no symbol named `{name}`. Closest: {}",
                    suggestions.join(", ")
                ));
            }
            Err(e) => return Err(e.to_string()),
        };
    let budget = budget(args);
    let s = &src.symbol;
    let mut out = format!(
        "{} ({}) {}\n",
        s.qualified_name,
        kind_cell(s),
        loc(scope, s)
    );
    if let Some(first) = s.doc.lines().next().filter(|l| !l.is_empty()) {
        out.push_str(&format!("doc: {first}\n"));
    }
    if src.stale {
        out.push_str("note: the file changed since it was indexed; line numbers may be off (re-indexing now)\n");
        scope
            .project
            .enqueue(Job::Paths(vec![scope.project.index.root().join(&s.rel)]));
    }
    match &src.source {
        Some(text) => {
            let mut body = String::new();
            let mut cut = None;
            for (i, line) in text.lines().enumerate() {
                let n = s.start_line as usize + i;
                let numbered = format!("{n:>6}  {line}\n");
                if out.len() + body.len() + numbered.len() > budget {
                    cut = Some(n);
                    break;
                }
                body.push_str(&numbered);
            }
            out.push_str(&body);
            if let Some(n) = cut {
                out.push_str(&format!("… cut at line {n} (output_budget); read a member, or raise max_output_tokens\n"));
            } else if src.truncated {
                out.push_str(&format!(
                    "… cut at max_lines={max_lines}; it has no members to list\n"
                ));
            }
        }
        None => {
            let lines = s.end_line + 1 - s.start_line;
            out.push_str(&format!(
                "{lines} lines > max_lines={max_lines}; its members (read one with read_symbol):\n"
            ));
            let rows = outline_rows(&src.members);
            let page = Page {
                total: rows.len(),
                total_exact: true,
                offset: 0,
                next_offset: None,
                truncation: None,
            };
            let table = Table {
                name: "members".into(),
                cols: vec!["symbol", "kind", "lines", "signature"],
                rows,
            };
            out.push_str(&render(&[table], &page, budget.saturating_sub(out.len())));
        }
    }
    if !src.alternatives.is_empty() {
        let alts: Vec<String> = src
            .alternatives
            .iter()
            .map(|h| format!("{} ({})", h.qualified_name, loc(scope, h)))
            .collect();
        out.push_str(&format!("also named {name}: {}\n", alts.join(", ")));
    }
    Ok(out)
}

/// grep's annotator for a session, when an open project covers it.
pub fn grep_locator(
    registry: &CodeIndexRegistry,
    session_root: &Path,
) -> Option<Arc<dyn SymbolLocator>> {
    let session = dunce::canonicalize(session_root).ok()?;
    let project = registry.root_for(&session)?;
    let prefix = session
        .strip_prefix(project.index.root())
        .map(rel_string)
        .ok()?;
    let inner = project.index.locator();
    if prefix.is_empty() {
        return Some(inner);
    }
    Some(Arc::new(ScopedLocator { inner, prefix }))
}

/// Maps session-relative grep paths onto an index rooted higher up.
struct ScopedLocator {
    inner: Arc<dyn SymbolLocator>,
    prefix: String,
}

impl SymbolLocator for ScopedLocator {
    fn enclosing(&self, rel_path: &str, line: u32) -> Option<EnclosingSymbol> {
        self.inner
            .enclosing(&format!("{}/{rel_path}", self.prefix), line)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        let w = |rel: &str, body: &str| {
            let p = dir.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        };
        w("crates/store/src/lib.rs", "/// Opens stores.\npub struct Store;\nimpl Store {\n    pub fn open() -> Self {\n        Store\n    }\n}\n");
        w("web/app.ts", "export function openStore() {}\n");
        dir
    }

    fn ready(dir: &Path) -> Arc<CodeIndexRegistry> {
        let reg = Arc::new(CodeIndexRegistry::new(None));
        let p = reg.ensure_open(dir).unwrap();
        p.enqueue_and_wait(Job::Reconcile)
            .blocking_recv()
            .unwrap()
            .unwrap();
        reg
    }

    #[test]
    fn find_outline_and_read_from_the_project_root() {
        let dir = project();
        let reg = ready(dir.path());
        let scope = Scope::resolve(&reg, dir.path()).unwrap();
        // Cell text only: the table layout is atlas_search::compact's.
        let found = call(&scope, "find_symbol", &json!({ "query": "Store" })).unwrap();
        assert!(
            found.contains("crates/store/src/lib.rs:2-2") && found.contains("pub struct Store"),
            "{found}"
        );
        let outline = call(
            &scope,
            "outline",
            &json!({ "path": "crates/store/src/lib.rs" }),
        )
        .unwrap();
        assert!(outline.contains("pub fn open() -> Self"), "{outline}");
        let rows = outline_rows(
            &scope
                .project
                .index
                .outline("crates/store/src/lib.rs")
                .unwrap(),
        );
        assert_eq!(
            rows[2][..3],
            [
                "  open".to_string(),
                "method".to_string(),
                "4-6".to_string()
            ]
        );
        let read = call(&scope, "read_symbol", &json!({ "name": "Store::open" })).unwrap();
        assert!(
            read.starts_with("Store::open (method) crates/store/src/lib.rs:4-6\n"),
            "{read}"
        );
        assert!(read.contains("     5          Store\n"), "{read}");
    }

    #[test]
    fn session_in_a_subdirectory_sees_relative_paths() {
        let dir = project();
        let reg = ready(dir.path());
        let scope = Scope::resolve(&reg, &dir.path().join("crates/store")).unwrap();
        let found = call(&scope, "find_symbol", &json!({ "query": "Store" })).unwrap();
        assert!(found.contains("src/lib.rs:2-2"), "{found}");
        assert!(!found.contains("crates/store/src"), "{found}");
        let outline = call(&scope, "outline", &json!({ "path": "src/lib.rs" })).unwrap();
        assert!(outline.contains("Store"), "{outline}");
        // An absolute path inside the project names the same file.
        let abs = dir.path().join("crates/store/src/lib.rs");
        let outline = call(&scope, "outline", &json!({ "path": abs.to_string_lossy() })).unwrap();
        assert!(outline.contains("Store"), "{outline}");
        let read = call(
            &scope,
            "read_symbol",
            &json!({ "name": "open", "path": abs.to_string_lossy() }),
        );
        assert!(read.is_ok_and(|r| r.contains("Store::open")));
        let loc = grep_locator(&reg, &dir.path().join("crates/store")).unwrap();
        assert_eq!(
            loc.enclosing("src/lib.rs", 5).unwrap().qualified_name,
            "Store::open"
        );
    }

    #[test]
    fn a_subdirectory_session_never_sees_code_outside_it() {
        let dir = project();
        let reg = ready(dir.path());
        let scope = Scope::resolve(&reg, &dir.path().join("crates/store")).unwrap();
        let found = call(&scope, "find_symbol", &json!({ "query": "openStore" })).unwrap();
        assert!(!found.contains("app.ts"), "{found}");
        let read = call(&scope, "read_symbol", &json!({ "name": "openStore" })).unwrap_err();
        assert!(!read.contains("app.ts"), "{read}");
        let outline = call(&scope, "outline", &json!({ "path": "../../web/app.ts" })).unwrap_err();
        assert!(outline.contains("outside the session root"), "{outline}");
    }

    #[test]
    fn long_symbol_lists_members_and_unknown_name_suggests() {
        let dir = project();
        let reg = ready(dir.path());
        let scope = Scope::resolve(&reg, dir.path()).unwrap();
        let read = call(
            &scope,
            "read_symbol",
            &json!({ "name": "Store", "path": "crates/store/src/lib.rs", "max_lines": 1 }),
        )
        .unwrap();
        assert!(read.contains("doc: Opens stores."), "{read}");
        assert!(
            read.contains("also named Store: Store (crates/store/src/lib.rs:3-7)"),
            "{read}"
        );
        let err = call(&scope, "read_symbol", &json!({ "name": "openStor" })).unwrap_err();
        assert!(
            err.starts_with("no symbol named `openStor`. Closest: openStore (web/app.ts:1)"),
            "{err}"
        );
        let impl_read = call(
            &scope,
            "read_symbol",
            &json!({ "name": "Store", "max_lines": 1 }),
        )
        .unwrap();
        assert!(impl_read.starts_with("Store (struct)"), "{impl_read}");
    }

    #[test]
    fn tool_specs_are_named_and_require_their_key() {
        let specs = symbol_tool_specs();
        assert_eq!(specs.iter().map(|s| s.0).collect::<Vec<_>>(), SYMBOL_TOOLS);
        for (_, _, schema) in specs {
            assert_eq!(schema["required"].as_array().map(Vec::len), Some(1));
        }
    }
}

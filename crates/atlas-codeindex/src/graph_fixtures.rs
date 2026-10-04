//! Shared fixtures for Phase 3 tests: parse helpers and fixture projects.

use crate::graph_extract::{extract_graph, GraphExtract};

/// Parse `src` with the grammar Phase 2 uses for `lang` and run graph extraction.
pub(crate) fn extract(lang: &str, src: &str) -> GraphExtract {
    let language: tree_sitter::Language = match lang {
        "rust" => tree_sitter_rust::LANGUAGE.into(),
        "typescript" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "python" => tree_sitter_python::LANGUAGE.into(),
        "go" => tree_sitter_go::LANGUAGE.into(),
        other => panic!("no grammar for {other}"),
    };
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&language).expect("grammar loads");
    let tree = parser.parse(src, None).expect("parses");
    extract_graph(lang, tree.root_node(), src.as_bytes())
}

/// `(kind, name, receiver)` triples, in extraction order.
pub(crate) fn refs_of(g: &GraphExtract) -> Vec<(String, String, String)> {
    g.refs
        .iter()
        .map(|r| {
            (
                r.kind.as_str().to_string(),
                r.name.clone(),
                r.receiver.clone(),
            )
        })
        .collect()
}

pub(crate) fn has_ref(g: &GraphExtract, kind: &str, name: &str, receiver: &str) -> bool {
    refs_of(g)
        .iter()
        .any(|(k, n, r)| k == kind && n == name && r == receiver)
}

/// `(local, module, imported, is_pub)` tuples.
pub(crate) fn imports_of(g: &GraphExtract) -> Vec<(String, String, String, bool)> {
    g.imports
        .iter()
        .map(|i| {
            (
                i.local_name.clone(),
                i.module_path.clone(),
                i.imported_name.clone(),
                i.is_pub,
            )
        })
        .collect()
}

/// Write `(rel, content)` files under `root`, creating directories.
pub(crate) fn write_tree(root: &std::path::Path, files: &[(&str, &str)]) {
    for (rel, content) in files {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().expect("has parent")).expect("mkdir");
        std::fs::write(path, content).expect("write fixture");
    }
}

/// Two-crate workspace: `mod.rs` + `lib.rs` + `#[path]` layouts, `pub use` (named and glob)
/// re-exports, and the ambiguous names `new`/`run` defined several times.
pub(crate) const RUST_WORKSPACE: &[(&str, &str)] = &[
    ("Cargo.toml", "[workspace]\nmembers = [\"crates/*\"]\nresolver = \"2\"\n"),
    ("crates/core-lib/Cargo.toml", "[package]\nname = \"core-lib\"\nversion = \"0.1.0\"\nedition = \"2021\"\n"),
    (
        "crates/core-lib/src/lib.rs",
        "pub mod engine;\nmod util;\n#[path = \"gen/wire_impl.rs\"]\npub mod wire;\npub use engine::Engine;\npub use util::*;\n\npub fn run() -> u32 {\n    engine::start() + helper()\n}\n",
    ),
    (
        "crates/core-lib/src/engine/mod.rs",
        "mod parts;\npub use parts::Part;\n\npub struct Engine {\n    pub n: u32,\n}\n\nimpl Engine {\n    pub fn new() -> Self {\n        Engine { n: 0 }\n    }\n    pub fn run(&self) -> u32 {\n        self.step()\n    }\n    fn step(&self) -> u32 {\n        Part::new().size()\n    }\n}\n\npub fn start() -> u32 {\n    let e = Engine::new();\n    e.run()\n}\n",
    ),
    (
        "crates/core-lib/src/engine/parts.rs",
        "pub struct Part;\n\nimpl Part {\n    pub fn new() -> Self {\n        Part\n    }\n    pub fn size(&self) -> u32 {\n        1\n    }\n}\n",
    ),
    ("crates/core-lib/src/util.rs", "pub fn helper() -> u32 {\n    2\n}\n\npub trait Shape {\n    fn area(&self) -> u32;\n}\n"),
    ("crates/core-lib/src/gen/wire_impl.rs", "pub fn encode() -> u32 {\n    crate::util::helper()\n}\n"),
    (
        "crates/tool/Cargo.toml",
        "[package]\nname = \"tool\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[dependencies]\ncore-lib = { path = \"../core-lib\" }\n",
    ),
    (
        "crates/tool/src/lib.rs",
        "use core_lib::Engine;\n\npub struct Square;\n\nimpl core_lib::Shape for Square {\n    fn area(&self) -> u32 {\n        4\n    }\n}\n\npub fn new() -> Engine {\n    Engine::new()\n}\n\npub fn go() -> u32 {\n    core_lib::run() + core_lib::wire::encode()\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn go_works() {\n        assert_eq!(go(), 6);\n    }\n}\n",
    ),
    ("crates/tool/src/main.rs", "fn main() {\n    let _ = tool::go();\n    run();\n}\n\nfn run() {}\n"),
];

/// tsconfig `paths` + `baseUrl` (JSONC), npm workspaces, index files, `export … from`, `require`.
pub(crate) const TS_PROJECT: &[(&str, &str)] = &[
    ("tsconfig.json", "{\n  // aliases\n  \"compilerOptions\": { \"baseUrl\": \".\", \"paths\": { \"@/*\": [\"src/*\"] }, },\n}\n"),
    ("package.json", "{ \"name\": \"app\", \"workspaces\": [\"packages/*\"] }\n"),
    ("packages/ui/package.json", "{ \"name\": \"@acme/ui\", \"main\": \"src/index.ts\" }\n"),
    ("packages/ui/src/index.ts", "export { Button } from './button';\n"),
    ("packages/ui/src/button.tsx", "export function Button() {\n  return null;\n}\n"),
    (
        "src/app.tsx",
        "import { Button } from '@acme/ui';\nimport { fmt } from '@/lib/format';\nimport * as api from './api';\n\nexport function App() {\n  api.load();\n  return <Button label={fmt(1)} />;\n}\n",
    ),
    ("src/lib/format.ts", "export function fmt(n: number) {\n  return String(n);\n}\n"),
    ("src/api/index.ts", "export function load() {\n  return fetchAll();\n}\n\nfunction fetchAll() {\n  return 1;\n}\n"),
    ("src/legacy.js", "const api = require('./api');\n\nfunction old() {\n  api.load();\n}\n"),
];

/// Packages with `__init__` re-exports, relative and absolute imports, a test file.
pub(crate) const PY_PROJECT: &[(&str, &str)] = &[
    ("app/__init__.py", "from .engine import Engine\n"),
    (
        "app/engine.py",
        "class Base:\n    def start(self):\n        pass\n\n\nclass Engine(Base):\n    def run(self):\n        self.start()\n        return helper()\n\n\ndef helper():\n    return 1\n",
    ),
    (
        "app/cli.py",
        "from app import Engine\nfrom . import engine\nimport app.engine\n\n\ndef main():\n    e = Engine()\n    e.run()\n    engine.helper()\n    app.engine.helper()\n",
    ),
    ("tests/test_engine.py", "from app.engine import Engine\n\n\ndef test_run():\n    Engine().run()\n"),
];

/// go.mod module path, a two-file package, method receivers.
pub(crate) const GO_PROJECT: &[(&str, &str)] = &[
    ("go.mod", "module example.com/m\n\ngo 1.22\n"),
    ("pkg/util/util.go", "package util\n\nfunc Do() int {\n\treturn helper()\n}\n\nfunc helper() int {\n\treturn 1\n}\n"),
    ("pkg/util/more.go", "package util\n\nfunc Other() int {\n\treturn helper()\n}\n"),
    (
        "cmd/main.go",
        "package main\n\nimport \"example.com/m/pkg/util\"\n\ntype Repo struct{}\n\nfunc (r *Repo) Save() int {\n\treturn r.load() + util.Do()\n}\n\nfunc (r *Repo) load() int {\n\treturn 0\n}\n\nfunc main() {\n\tr := &Repo{}\n\tr.Save()\n}\n",
    ),
];

/// Write `files` into a temp project and fully index it.
pub(crate) fn build_index(files: &[(&str, &str)]) -> (tempfile::TempDir, crate::CodeIndex) {
    let dir = tempfile::tempdir().expect("tempdir");
    write_tree(dir.path(), files);
    let idx = crate::CodeIndex::open(dir.path()).expect("open");
    idx.full_build(&atlas_search::CancelToken::new(), &|_| {})
        .expect("full build");
    (dir, idx)
}

/// The edge from the symbol with qualified name `src` to the one with qualified name `dst`:
/// `(kind, confidence, strategy)`.
pub(crate) fn edge(idx: &crate::CodeIndex, src: &str, dst: &str) -> Option<(String, f64, String)> {
    idx.with_reader(|c| {
        Ok(c.query_row(
            "SELECT e.kind, e.confidence, e.strategy FROM edges e
             JOIN symbols s ON s.id = e.src_symbol_id JOIN symbols d ON d.id = e.dst_symbol_id
             WHERE s.qualified_name = ?1 AND d.qualified_name = ?2 ORDER BY e.confidence DESC LIMIT 1",
            [src, dst],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok())
    })
    .expect("query")
}

/// Where `local` imported in `rel` resolved to (rel path of the target file).
pub(crate) fn import_target(idx: &crate::CodeIndex, rel: &str, local: &str) -> Option<String> {
    idx.with_reader(|c| {
        Ok(c.query_row(
            "SELECT t.rel FROM imports i JOIN files f ON f.id = i.file_id JOIN files t ON t.id = i.resolved_file_id
             WHERE f.rel = ?1 AND i.local_name = ?2",
            [rel, local],
            |r| r.get(0),
        )
        .ok())
    })
    .expect("query")
}

pub(crate) fn module_of(idx: &crate::CodeIndex, rel: &str) -> String {
    idx.with_reader(|c| {
        c.query_row("SELECT module FROM files WHERE rel = ?1", [rel], |r| {
            r.get(0)
        })
    })
    .expect("module")
}

/// A Phase 2 (schema v1) index with one file and one Tier-2 summary, for the migration test.
/// The DDL is v1 frozen as Phase 2 shipped it.
pub(crate) fn create_v1_only(root: &std::path::Path) {
    let dir = root.join(".atlas").join("code-index");
    std::fs::create_dir_all(&dir).expect("mkdir");
    let conn = rusqlite::Connection::open(dir.join("index.db")).expect("open v1");
    conn.execute_batch(
        "CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
         CREATE TABLE files(
           id INTEGER PRIMARY KEY, rel TEXT NOT NULL UNIQUE, lang TEXT NOT NULL,
           size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, hash BLOB NOT NULL,
           surface_hash BLOB, parse_partial INTEGER NOT NULL DEFAULT 0, indexed_at_ms INTEGER NOT NULL);
         CREATE TABLE symbols(
           id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
           parent_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
           kind TEXT NOT NULL, name TEXT NOT NULL, qualified_name TEXT NOT NULL,
           start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL,
           signature TEXT NOT NULL DEFAULT '', doc TEXT NOT NULL DEFAULT '',
           exported INTEGER NOT NULL DEFAULT 0, is_test INTEGER NOT NULL DEFAULT 0, importance REAL NOT NULL DEFAULT 0);
         CREATE INDEX symbols_name ON symbols(name);
         CREATE INDEX symbols_file ON symbols(file_id, start_line);
         CREATE INDEX symbols_qn ON symbols(qualified_name);
         CREATE INDEX symbols_parent ON symbols(parent_id);
         CREATE TABLE imports(file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
           local_name TEXT NOT NULL, module_path TEXT NOT NULL, line INTEGER NOT NULL,
           resolved_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL);
         CREATE INDEX imports_file ON imports(file_id);
         CREATE INDEX imports_resolved ON imports(resolved_file_id);
         CREATE VIRTUAL TABLE symbols_fts USING fts5(name_split, qualified_name, path, doc,
           content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
         CREATE TABLE file_summaries(file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
           content_hash BLOB NOT NULL, summary TEXT NOT NULL);
         INSERT INTO files(rel, lang, size, mtime_ns, hash, indexed_at_ms) VALUES ('a.rs', 'rust', 1, 1, x'00', 0);
         INSERT INTO file_summaries(file_id, content_hash, summary) VALUES (1, x'00', 'kept');
         PRAGMA user_version = 1;",
    )
    .expect("v1 schema");
}

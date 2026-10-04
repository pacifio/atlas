//! The languages the index understands, and the per-language tables that drive
//! the one generic walk in `extract.rs`.
//!
//! A [`LangSpec`] names node kinds and fields as strings, the way a grammar's
//! `node-types.json` does. [`Spec::resolve`] turns each table into kind-id
//! bitsets and field ids once per grammar, so the walk compares integers.
//! Anything a table cannot express (impl naming, Go receivers, import shapes)
//! lives in that language's module as a small function.

mod go;
mod python;
mod rust;
mod typescript;

use std::path::Path;
use std::sync::OnceLock;

use tree_sitter::{Language as Grammar, Node};

use crate::extract::ImportRec;

/// A source language, at the granularity the parser cares about. `.js`/`.jsx`
/// parse with the TSX grammar (a superset of JavaScript syntax).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Lang {
    Rust,
    TypeScript,
    Tsx,
    JavaScript,
    Python,
    Go,
}

/// Number of distinct grammars (TSX serves both `.tsx` and JavaScript).
pub(crate) const GRAMMARS: usize = 5;

impl Lang {
    pub fn from_path(rel: &str) -> Option<Self> {
        let ext = Path::new(rel).extension()?.to_str()?;
        Some(match ext {
            "rs" => Self::Rust,
            "ts" | "mts" | "cts" => Self::TypeScript,
            "tsx" => Self::Tsx,
            "js" | "jsx" | "mjs" | "cjs" => Self::JavaScript,
            "py" | "pyi" => Self::Python,
            "go" => Self::Go,
            _ => return None,
        })
    }

    /// Stable lowercase name stored in `files.lang`.
    pub fn label(self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::TypeScript | Self::Tsx => "typescript",
            Self::JavaScript => "javascript",
            Self::Python => "python",
            Self::Go => "go",
        }
    }

    pub(crate) fn grammar_index(self) -> usize {
        match self {
            Self::Rust => 0,
            Self::TypeScript => 1,
            Self::Tsx | Self::JavaScript => 2,
            Self::Python => 3,
            Self::Go => 4,
        }
    }

    pub(crate) fn grammar(self) -> Grammar {
        grammar_at(self.grammar_index())
    }

    pub(crate) fn spec(self) -> &'static Spec {
        &specs()[self.grammar_index()]
    }

    /// Whether every symbol in this file is test code, judged from the path.
    pub(crate) fn is_test_path(self, rel: &str) -> bool {
        let file = rel.rsplit('/').next().unwrap_or(rel);
        let in_dir = |d: &str| rel.split('/').rev().skip(1).any(|c| c == d);
        match self {
            Self::Rust => in_dir("tests"),
            Self::TypeScript | Self::Tsx | Self::JavaScript => {
                file.contains(".test.") || file.contains(".spec.") || in_dir("__tests__")
            }
            Self::Python => {
                file.starts_with("test_")
                    || file.ends_with("_test.py")
                    || file == "conftest.py"
                    || in_dir("tests")
            }
            Self::Go => file.ends_with("_test.go"),
        }
    }
}

fn grammar_at(i: usize) -> Grammar {
    match i {
        0 => tree_sitter_rust::LANGUAGE.into(),
        1 => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        2 => tree_sitter_typescript::LANGUAGE_TSX.into(),
        3 => tree_sitter_python::LANGUAGE.into(),
        _ => tree_sitter_go::LANGUAGE.into(),
    }
}

fn table_at(i: usize) -> &'static LangSpec {
    match i {
        0 => &rust::SPEC,
        1 | 2 => &typescript::SPEC,
        3 => &python::SPEC,
        _ => &go::SPEC,
    }
}

fn specs() -> &'static [Spec] {
    static SPECS: OnceLock<Vec<Spec>> = OnceLock::new();
    SPECS.get_or_init(|| {
        (0..GRAMMARS)
            .map(|i| Spec::resolve(&grammar_at(i), table_at(i)))
            .collect()
    })
}

/// One language's extraction table, in grammar node-kind names.
pub(crate) struct LangSpec {
    /// Definition node kinds and the symbol kind each one emits.
    pub defs: &'static [(&'static str, &'static str)],
    /// Definitions whose children are members (classes, impls, traits).
    pub type_scopes: &'static [&'static str],
    /// Definitions whose children are namespaced items (Rust `mod`, TS `namespace`).
    pub module_scopes: &'static [&'static str],
    /// Never descended into: function bodies, comments, strings.
    pub opaque: &'static [&'static str],
    /// Hand a pending doc comment to the definition inside them; the
    /// definition's range starts at the wrapper when both start on one row.
    pub wrappers: &'static [&'static str],
    /// Wrappers whose start always begins the definition's range (Python
    /// `decorated_definition`).
    pub decorated: &'static [&'static str],
    /// Wrappers that make the definition inside them exported (TS `export`).
    pub exporting: &'static [&'static str],
    /// Nodes between a doc comment and its definition (Rust `#[..]`, Python `@..`).
    pub attributes: &'static [&'static str],
    pub comments: &'static [&'static str],
    pub imports: &'static [&'static str],
    /// Separator between the segments of a qualified name.
    pub sep: &'static str,
}

/// Field ids resolved once per grammar; 0 when the grammar has no such field
/// (`child_by_field_id(0)` finds nothing).
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct Fields {
    pub name: u16,
    pub body: u16,
    pub value: u16,
    pub ty: u16,
    pub trait_: u16,
    pub receiver: u16,
    pub argument: u16,
    pub alias: u16,
    pub path: u16,
    pub list: u16,
    pub source: u16,
    pub module_name: u16,
    pub kind: u16,
}

/// A set of node-kind ids.
#[derive(Debug, Default)]
pub(crate) struct KindSet(Vec<u64>);

impl KindSet {
    fn insert(&mut self, id: u16) {
        let (word, bit) = (usize::from(id) / 64, id % 64);
        if self.0.len() <= word {
            self.0.resize(word + 1, 0);
        }
        self.0[word] |= 1 << bit;
    }

    pub(crate) fn contains(&self, id: u16) -> bool {
        self.0
            .get(usize::from(id) / 64)
            .is_some_and(|w| (w >> (id % 64)) & 1 == 1)
    }
}

/// A [`LangSpec`] resolved against its grammar.
pub(crate) struct Spec {
    pub table: &'static LangSpec,
    def_kind: Vec<Option<&'static str>>,
    pub type_scope: KindSet,
    pub module_scope: KindSet,
    pub opaque: KindSet,
    pub wrapper: KindSet,
    pub decorated: KindSet,
    pub exporting: KindSet,
    pub attribute: KindSet,
    pub comment: KindSet,
    pub import: KindSet,
    pub f: Fields,
}

impl Spec {
    /// Resolve every kind name to ALL its ids: a grammar can alias several
    /// ids to one visible name, so a single `id_for_node_kind` is not enough.
    fn resolve(grammar: &Grammar, table: &'static LangSpec) -> Self {
        let count = grammar.node_kind_count();
        let mut spec = Spec {
            table,
            def_kind: vec![None; count],
            type_scope: KindSet::default(),
            module_scope: KindSet::default(),
            opaque: KindSet::default(),
            wrapper: KindSet::default(),
            decorated: KindSet::default(),
            exporting: KindSet::default(),
            attribute: KindSet::default(),
            comment: KindSet::default(),
            import: KindSet::default(),
            f: Fields::default(),
        };
        for id in 0..count {
            let Ok(id16) = u16::try_from(id) else { break };
            if !grammar.node_kind_is_named(id16) {
                continue;
            }
            let Some(name) = grammar.node_kind_for_id(id16) else {
                continue;
            };
            if let Some((_, kind)) = table.defs.iter().find(|(k, _)| *k == name) {
                spec.def_kind[id] = Some(kind);
            }
            for (list, set) in [
                (table.type_scopes, &mut spec.type_scope),
                (table.module_scopes, &mut spec.module_scope),
                (table.opaque, &mut spec.opaque),
                (table.wrappers, &mut spec.wrapper),
                (table.decorated, &mut spec.decorated),
                (table.exporting, &mut spec.exporting),
                (table.attributes, &mut spec.attribute),
                (table.comments, &mut spec.comment),
                (table.imports, &mut spec.import),
            ] {
                if list.contains(&name) {
                    set.insert(id16);
                }
            }
        }
        let field = |n: &str| {
            grammar
                .field_id_for_name(n)
                .map_or(0, std::num::NonZeroU16::get)
        };
        spec.f = Fields {
            name: field("name"),
            body: field("body"),
            value: field("value"),
            ty: field("type"),
            trait_: field("trait"),
            receiver: field("receiver"),
            argument: field("argument"),
            alias: field("alias"),
            path: field("path"),
            list: field("list"),
            source: field("source"),
            module_name: field("module_name"),
            kind: field("kind"),
        };
        spec
    }

    pub(crate) fn def_kind(&self, id: u16) -> Option<&'static str> {
        self.def_kind.get(usize::from(id)).copied().flatten()
    }
}

/// What a definition node is called, once per name it declares (Go's
/// `const a, b = 1, 2` declares two).
pub(crate) struct DefName {
    pub kind: &'static str,
    pub name: String,
    /// Replaces the scope-derived qualified name (Go `Recv.Method`).
    pub qualified: Option<String>,
}

/// Facts about the enclosing scope a language hook may need.
pub(crate) struct ScopeView {
    pub members: bool,
}

pub(crate) fn def_names(
    lang: Lang,
    node: Node,
    kind: &'static str,
    src: &[u8],
    f: &Fields,
    scope: &ScopeView,
) -> Vec<DefName> {
    match lang {
        Lang::Rust => rust::def_names(node, kind, src, f, scope),
        Lang::TypeScript | Lang::Tsx | Lang::JavaScript => {
            typescript::def_names(node, kind, src, f, scope)
        }
        Lang::Python => python::def_names(node, kind, src, f, scope),
        Lang::Go => go::def_names(node, kind, src, f, scope),
    }
}

pub(crate) fn imports(lang: Lang, node: Node, src: &[u8], f: &Fields, out: &mut Vec<ImportRec>) {
    match lang {
        Lang::Rust => rust::imports(node, src, f, out),
        Lang::TypeScript | Lang::Tsx | Lang::JavaScript => typescript::imports(node, src, f, out),
        Lang::Python => python::imports(node, src, f, out),
        Lang::Go => go::imports(node, src, f, out),
    }
}

/// The text of a doc comment with its markers removed, or `None` when the
/// comment is not documentation in this language.
pub(crate) fn doc_text(lang: Lang, comment: &str) -> Option<String> {
    match lang {
        Lang::Rust => {
            if let Some(rest) = comment.strip_prefix("///") {
                (!rest.starts_with('/')).then(|| strip_one_space(rest).trim_end().to_string())
            } else if comment.starts_with("/**") && !comment.starts_with("/***") {
                Some(block_doc(comment))
            } else {
                None
            }
        }
        Lang::TypeScript | Lang::Tsx | Lang::JavaScript => {
            (comment.starts_with("/**") && !comment.starts_with("/***")).then(|| block_doc(comment))
        }
        Lang::Go => {
            if let Some(rest) = comment.strip_prefix("//") {
                Some(strip_one_space(rest).trim_end().to_string())
            } else {
                Some(block_doc(comment))
            }
        }
        Lang::Python => None,
    }
}

/// Whether attributes mark the definition as test code (Rust `#[test]`,
/// `#[tokio::test]`, `#[cfg(test)]`).
pub(crate) fn attrs_mark_test(lang: Lang, attrs: &[String]) -> bool {
    lang == Lang::Rust && attrs.iter().any(|a| rust::attr_is_test(a))
}

/// Whether the definition is visible outside its file/module.
pub(crate) fn is_exported(
    lang: Lang,
    node: Node,
    name: &str,
    src: &[u8],
    wrapped_export: bool,
    member_exported: Option<bool>,
    attrs: &[String],
) -> bool {
    match lang {
        Lang::Rust => rust::is_exported(node, src, member_exported, attrs),
        Lang::TypeScript | Lang::Tsx | Lang::JavaScript => {
            typescript::is_exported(node, src, wrapped_export, member_exported)
        }
        Lang::Python => !name.starts_with('_') && member_exported.unwrap_or(true),
        Lang::Go => name.chars().next().is_some_and(char::is_uppercase),
    }
}

/// Docs that live inside the definition (Python docstrings).
pub(crate) fn inner_doc(lang: Lang, node: Node, src: &[u8], f: &Fields) -> Option<String> {
    (lang == Lang::Python)
        .then(|| python::docstring(node, src, f))
        .flatten()
}

/// Text before the signature that a language implies but the node omits
/// (Go's `type`, `const`, `var`; the TS declaration keyword).
pub(crate) fn signature_prefix(lang: Lang, node: Node, src: &[u8], f: &Fields) -> String {
    match lang {
        Lang::Go => go::signature_prefix(node).to_string(),
        Lang::TypeScript | Lang::Tsx | Lang::JavaScript => {
            typescript::signature_prefix(node, src, f)
        }
        _ => String::new(),
    }
}

/// Where a signature stops: the start of the body, when the node has one.
pub(crate) fn body_start(lang: Lang, node: Node, f: &Fields) -> Option<usize> {
    if matches!(lang, Lang::TypeScript | Lang::Tsx | Lang::JavaScript) {
        if let Some(b) = typescript::value_body(node, f) {
            return Some(b);
        }
    }
    node.child_by_field_id(f.body).map(|b| b.start_byte())
}

// ── small text helpers shared by the language modules ───────────────────────

pub(crate) fn text<'a>(node: Node, src: &'a [u8]) -> &'a str {
    std::str::from_utf8(&src[node.byte_range()]).unwrap_or("")
}

/// `a :: b` → `a::b`: a path with every whitespace character removed.
pub(crate) fn squash(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

pub(crate) fn unquote(s: &str) -> String {
    s.trim_matches(|c| c == '"' || c == '\'' || c == '`')
        .to_string()
}

pub(crate) fn join_qn(prefix: &str, sep: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}{sep}{name}")
    }
}

/// Children of `node` attached under `field` (a field may repeat).
pub(crate) fn field_children<'t>(node: Node<'t>, field: u16) -> Vec<Node<'t>> {
    let mut out = Vec::new();
    if field == 0 {
        return out;
    }
    let mut cursor = node.walk();
    if cursor.goto_first_child() {
        loop {
            // Separators (`,`) can carry the field too; keep named nodes only.
            if cursor.field_id().map(std::num::NonZeroU16::get) == Some(field)
                && cursor.node().is_named()
            {
                out.push(cursor.node());
            }
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }
    out
}

pub(crate) fn named_children(node: Node) -> Vec<Node> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).collect()
}

pub(crate) fn push_import(out: &mut Vec<ImportRec>, local: &str, module: &str, node: Node) {
    out.push(ImportRec {
        local_name: local.to_string(),
        module_path: module.to_string(),
        line: u32::try_from(node.start_position().row + 1).unwrap_or(u32::MAX),
    });
}

fn strip_one_space(s: &str) -> &str {
    s.strip_prefix(' ').unwrap_or(s)
}

/// `/** a\n * b */` → `a\nb`.
fn block_doc(comment: &str) -> String {
    let inner = comment
        .trim_start_matches("/**")
        .trim_start_matches("/*")
        .trim_end_matches("*/");
    inner
        .lines()
        .map(|l| {
            let l = l.trim();
            strip_one_space(l.strip_prefix('*').unwrap_or(l)).trim_end()
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

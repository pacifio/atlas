//! One `TreeCursor` walk per file. It yields every definition (with its
//! qualified name, parent, byte and line range, signature, doc comment,
//! export and test flags) and every import, in source order.
//!
//! The walk never enters a function body: the index is "what does this file
//! declare". Phase 3 widens it to calls and references.

use std::cell::RefCell;
use std::ops::ControlFlow;
use std::time::Instant;

use tree_sitter::{Node, ParseOptions, ParseState, Parser, Point, Tree};

use crate::lang::{self, Lang, ScopeView, Spec};

pub(crate) const MAX_SIGNATURE_CHARS: usize = 240;
pub(crate) const MAX_DOC_CHARS: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SymbolRec {
    /// Index of the enclosing definition in the same file's list.
    pub parent: Option<usize>,
    pub kind: &'static str,
    pub name: String,
    pub qualified_name: String,
    pub start_line: u32,
    pub end_line: u32,
    pub start_byte: u32,
    pub end_byte: u32,
    pub signature: String,
    pub doc: String,
    pub exported: bool,
    pub is_test: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ImportRec {
    pub local_name: String,
    pub module_path: String,
    pub line: u32,
}

#[derive(Debug, Default)]
pub(crate) struct Extracted {
    pub symbols: Vec<SymbolRec>,
    pub imports: Vec<ImportRec>,
    /// The tree has ERROR/MISSING nodes, or the parse was abandoned.
    pub partial: bool,
    pub timed_out: bool,
    /// References, rich imports and `mod` declarations from the same tree (Phase 3).
    pub graph: crate::graph_extract::GraphExtract,
}

thread_local! {
    /// One parser per grammar per worker thread, reused across files.
    static PARSERS: RefCell<Vec<Option<Parser>>> =
        RefCell::new((0..lang::GRAMMARS).map(|_| None).collect());
}

/// Parse and extract one file. A parse past `deadline` is abandoned and the
/// file comes back empty with `partial` and `timed_out` set.
pub(crate) fn extract(lang: Lang, rel: &str, src: &[u8], deadline: Instant) -> Extracted {
    let (tree, timed_out) = parse(lang, src, deadline);
    let Some(tree) = tree else {
        return Extracted {
            partial: true,
            timed_out,
            ..Extracted::default()
        };
    };
    let mut walker = Walker::new(lang, src, lang.is_test_path(rel));
    walker.walk(&tree);
    walker.out.partial = tree.root_node().has_error();
    walker.out.graph = crate::graph_extract::extract_graph(lang.label(), tree.root_node(), src);
    walker.out
}

fn parse(lang: Lang, src: &[u8], deadline: Instant) -> (Option<Tree>, bool) {
    PARSERS.with(|cell| {
        let mut parsers = cell.borrow_mut();
        let slot = &mut parsers[lang.grammar_index()];
        if slot.is_none() {
            let mut p = Parser::new();
            if p.set_language(&lang.grammar()).is_err() {
                return (None, false);
            }
            *slot = Some(p);
        }
        let Some(parser) = slot.as_mut() else {
            return (None, false);
        };
        let mut timed_out = false;
        let mut on_progress = |_: &ParseState| {
            if Instant::now() >= deadline {
                timed_out = true;
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            }
        };
        let len = src.len();
        let tree = parser.parse_with_options(
            &mut |i: usize, _: Point| if i < len { &src[i..] } else { &[] },
            None,
            Some(ParseOptions::new().progress_callback(&mut on_progress)),
        );
        if tree.is_none() {
            // An abandoned parse resumes on the next call unless reset.
            parser.reset();
        }
        (tree, timed_out)
    })
}

/// An open scope: the definition that opened it and what its members inherit.
struct Frame {
    depth: usize,
    qn: String,
    sym: Option<usize>,
    /// Children are members (methods), not free functions.
    members: bool,
    /// Export state members inherit (`None` = decide per member).
    member_exported: Option<bool>,
    is_test: bool,
}

/// Doc comments, attributes and wrapper starts seen among siblings, waiting
/// for the definition they belong to.
#[derive(Default)]
struct Pending {
    active: bool,
    depth: usize,
    last_row: usize,
    doc: Vec<String>,
    attrs: Vec<String>,
    /// Where the definition's range should start (attribute / wrapper start).
    start: Option<(usize, usize)>,
    /// `start` applies even when the definition begins on a later row.
    start_any_row: bool,
    exported: bool,
}

impl Pending {
    fn clear(&mut self) {
        *self = Pending::default();
    }

    /// Continue the current run if `row` follows it at the same depth;
    /// otherwise start a new run there.
    fn extend_to(&mut self, depth: usize, row: usize) {
        if !(self.active && self.depth == depth && self.last_row + 1 >= row) {
            self.clear();
            self.active = true;
            self.depth = depth;
        }
    }
}

struct Taken {
    doc: String,
    attrs: Vec<String>,
    start: Option<(usize, usize)>,
    exported: bool,
}

struct Walker<'a> {
    lang: Lang,
    spec: &'static Spec,
    src: &'a [u8],
    file_test: bool,
    frames: Vec<Frame>,
    pending: Pending,
    out: Extracted,
}

impl<'a> Walker<'a> {
    fn new(lang: Lang, src: &'a [u8], file_test: bool) -> Self {
        Self {
            lang,
            spec: lang.spec(),
            src,
            file_test,
            frames: vec![Frame {
                depth: 0,
                qn: String::new(),
                sym: None,
                members: false,
                member_exported: None,
                is_test: false,
            }],
            pending: Pending::default(),
            out: Extracted::default(),
        }
    }

    fn walk(&mut self, tree: &Tree) {
        let mut cursor = tree.walk();
        let mut depth = 0usize;
        'walk: loop {
            if self.visit(cursor.node(), depth) && cursor.goto_first_child() {
                depth += 1;
                continue;
            }
            loop {
                // Leaving the node at `depth`: close the scope it opened.
                while self.frames.len() > 1 && self.frames.last().is_some_and(|f| f.depth >= depth)
                {
                    self.frames.pop();
                }
                if cursor.goto_next_sibling() {
                    continue 'walk;
                }
                if !cursor.goto_parent() {
                    break 'walk;
                }
                depth -= 1;
                if self.pending.depth > depth {
                    self.pending.clear();
                }
            }
        }
    }

    /// Handle one node; `true` = descend into its children.
    fn visit(&mut self, node: Node, depth: usize) -> bool {
        let spec = self.spec;
        let id = node.kind_id();
        if spec.comment.contains(id) {
            self.note_comment(node, depth);
            return false;
        }
        if spec.attribute.contains(id) {
            self.note_attribute(node, depth);
            return false;
        }
        let wrapper = spec.wrapper.contains(id) || spec.decorated.contains(id);
        if spec.import.contains(id) {
            lang::imports(self.lang, node, self.src, &spec.f, &mut self.out.imports);
            if !wrapper {
                self.pending.clear();
                return false;
            }
        }
        if wrapper {
            self.pass_down(
                node,
                depth,
                spec.decorated.contains(id),
                spec.exporting.contains(id),
            );
            return true;
        }
        if let Some(kind) = spec.def_kind(id) {
            let taken = self.take_pending(node, depth);
            self.emit(node, depth, kind, &taken);
            return !spec.opaque.contains(id);
        }
        if node.is_named() && self.pending.active && self.pending.depth == depth {
            self.pending.clear();
        }
        !spec.opaque.contains(id)
    }

    fn note_comment(&mut self, node: Node, depth: usize) {
        let row = node.start_position().row;
        let Some(doc) = lang::doc_text(self.lang, lang::text(node, self.src)) else {
            if self.pending.depth == depth {
                self.pending.clear();
            }
            return;
        };
        self.pending.extend_to(depth, row);
        self.pending.doc.push(doc);
        self.pending.last_row = end_row(node);
    }

    fn note_attribute(&mut self, node: Node, depth: usize) {
        let row = node.start_position().row;
        self.pending.extend_to(depth, row);
        if self.pending.start.is_none() {
            self.pending.start = Some((node.start_byte(), row));
            self.pending.start_any_row = true;
        }
        self.pending
            .attrs
            .push(lang::text(node, self.src).to_string());
        self.pending.last_row = end_row(node);
    }

    /// A wrapper (TS `export`, Python decorated definition, Go `type (…)`)
    /// hands what is pending to the definition one level down.
    fn pass_down(&mut self, node: Node, depth: usize, decorated: bool, exporting: bool) {
        let row = node.start_position().row;
        self.pending.extend_to(depth, row);
        self.pending.depth = depth + 1;
        self.pending.last_row = row;
        if self.pending.start.is_none() {
            self.pending.start = Some((node.start_byte(), row));
            self.pending.start_any_row = decorated;
        }
        self.pending.exported |= exporting;
    }

    fn take_pending(&mut self, node: Node, depth: usize) -> Taken {
        let p = std::mem::take(&mut self.pending);
        let row = node.start_position().row;
        if !(p.active && p.depth == depth && p.last_row + 1 >= row) {
            return Taken {
                doc: String::new(),
                attrs: Vec::new(),
                start: None,
                exported: false,
            };
        }
        let start = p.start.filter(|(_, r)| p.start_any_row || *r == row);
        Taken {
            doc: p.doc.join("\n"),
            attrs: p.attrs,
            start,
            exported: p.exported,
        }
    }

    fn emit(&mut self, node: Node, depth: usize, kind: &'static str, taken: &Taken) {
        let spec = self.spec;
        let f = &spec.f;
        let (parent, scope_qn, members, member_exported, scope_test) = match self.frames.last() {
            Some(fr) => (
                fr.sym,
                fr.qn.clone(),
                fr.members,
                fr.member_exported,
                fr.is_test,
            ),
            None => (None, String::new(), false, None, false),
        };
        let view = ScopeView { members };
        let names = lang::def_names(self.lang, node, kind, self.src, f, &view);
        if names.is_empty() {
            return;
        }
        let start_byte = taken.start.map_or(node.start_byte(), |(b, _)| b);
        let start_row = taken.start.map_or(node.start_position().row, |(_, r)| r);
        let signature = signature(self.lang, node, self.src, f);
        let doc = if taken.doc.is_empty() {
            lang::inner_doc(self.lang, node, self.src, f).unwrap_or_default()
        } else {
            taken.doc.clone()
        };
        let doc = clip(&doc, MAX_DOC_CHARS);
        let is_test =
            self.file_test || scope_test || lang::attrs_mark_test(self.lang, &taken.attrs);
        let opens_scope =
            spec.type_scope.contains(node.kind_id()) || spec.module_scope.contains(node.kind_id());
        for def in names {
            let qualified_name = def
                .qualified
                .unwrap_or_else(|| lang::join_qn(&scope_qn, spec.table.sep, &def.name));
            let exported = lang::is_exported(
                self.lang,
                node,
                &def.name,
                self.src,
                taken.exported,
                if members { member_exported } else { None },
                &taken.attrs,
            );
            self.out.symbols.push(SymbolRec {
                parent,
                kind: def.kind,
                name: def.name,
                qualified_name,
                start_line: line_of(start_row),
                end_line: end_line(node, start_row),
                start_byte: u32::try_from(start_byte).unwrap_or(u32::MAX),
                end_byte: u32::try_from(node.end_byte()).unwrap_or(u32::MAX),
                signature: signature.clone(),
                doc: doc.clone(),
                exported,
                is_test,
            });
        }
        if opens_scope {
            let idx = self.out.symbols.len() - 1;
            let sym = &self.out.symbols[idx];
            let members_of_type = spec.type_scope.contains(node.kind_id());
            let member_exported =
                members_of_type.then(|| self.members_exported(node, sym.exported));
            self.frames.push(Frame {
                depth,
                qn: sym.qualified_name.clone(),
                sym: Some(idx),
                members: members_of_type,
                member_exported,
                is_test: sym.is_test,
            });
        }
    }

    /// What a scope's members inherit. Rust: trait members follow the trait,
    /// trait-impl members are public by contract, inherent-impl members need
    /// their own `pub`. Elsewhere members follow their class.
    fn members_exported(&self, node: Node, scope_exported: bool) -> bool {
        match (self.lang, node.kind()) {
            (Lang::Rust, "impl_item") => node.child_by_field_id(self.spec.f.trait_).is_some(),
            _ => scope_exported,
        }
    }
}

/// Header text: from the definition's own start to its body (or the end of
/// its first line), whitespace collapsed.
fn signature(lang: Lang, node: Node, src: &[u8], f: &lang::Fields) -> String {
    let start = node.start_byte();
    let end = lang::body_start(lang, node, f).unwrap_or_else(|| {
        src[start..node.end_byte()]
            .iter()
            .position(|&b| b == b'\n')
            .map_or(node.end_byte(), |p| start + p)
    });
    let raw = String::from_utf8_lossy(&src[start..end.max(start)]);
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed =
        collapsed.trim_end_matches(|c: char| matches!(c, '{' | ':' | ';') || c.is_whitespace());
    let prefix = lang::signature_prefix(lang, node, src, f);
    clip(&format!("{prefix}{trimmed}"), MAX_SIGNATURE_CHARS)
}

fn clip(s: &str, max_chars: usize) -> String {
    match s.char_indices().nth(max_chars) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

fn line_of(row: usize) -> u32 {
    u32::try_from(row + 1).unwrap_or(u32::MAX)
}

/// Last row a node covers; a node ending at column 0 ends on the row before.
fn end_row(node: Node) -> usize {
    let end = node.end_position();
    if end.column == 0 && end.row > node.start_position().row {
        end.row - 1
    } else {
        end.row
    }
}

fn end_line(node: Node, start_row: usize) -> u32 {
    line_of(end_row(node).max(start_row))
}

//! AST-boundary chunking — the unit of retrieval.
//!
//! One [`CodeChunk`] carries a synthesized context **header** (path · language ·
//! enclosing item · imports), the **actual source body**, exact byte and line
//! ranges (what makes citations `file:start-end` instead of guesses), and a
//! blake3 content address over `header + body` (what makes re-indexing
//! idempotent).
//!
//! Boundary rules, in order:
//! 1. Top-level functions / structs / classes / impls become chunks.
//! 2. An oversized container (impl / class / mod / trait) explodes into its
//!    members, each carrying the container as `enclosing` context.
//! 3. Small adjacent siblings merge up to a byte budget.
//! 4. An oversized leaf splits at statement boundaries (line windows as the
//!    last resort), each later piece overlapping a few lines back for context.
//!
//! Degradation: an unsupported language or a failed parse falls back to
//! whole-file line windows — never to silence. Every cap that drops content is
//! counted on [`ChunkOutcome`].

use serde::{Deserialize, Serialize};

/// Merge adjacent small siblings until the combined chunk would exceed this.
pub const MERGE_TARGET_BYTES: usize = 900;
/// A chunk larger than this is split (statement boundaries, then lines).
pub const MAX_CHUNK_BYTES: usize = 2400;
/// Later pieces of a split reach this many lines back for context.
const SPLIT_OVERLAP_LINES: usize = 6;
/// Hard cap per file; drops beyond it are counted, never silent.
const MAX_CHUNKS_PER_FILE: usize = 200;
/// Symbols shown in a header before "…".
const HEADER_SYMBOLS: usize = 4;
/// Imports shown in a header.
const HEADER_IMPORTS: usize = 8;

/// One retrieval unit. `body` is the exact source slice
/// `source[start_byte..end_byte]`; lines are 1-based and inclusive.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeChunk {
    pub rel: String,
    pub language: String,
    /// "fn" | "struct" | "class" | "impl" | "misc" | "file" | …
    pub kind: String,
    /// Primary symbol name; empty for merged/misc chunks.
    pub symbol: String,
    /// Synthesized context: path · language · enclosing · symbols · imports.
    pub header: String,
    /// The actual source text of the chunk.
    pub body: String,
    pub start_line: u32,
    pub end_line: u32,
    pub start_byte: u32,
    pub end_byte: u32,
    /// blake3(header + "\n" + body), hex — the chunk's content address.
    pub hash: String,
}

/// What one file chunked into, with every lossy step counted.
#[derive(Debug, Clone, Default)]
pub struct ChunkOutcome {
    pub chunks: Vec<CodeChunk>,
    /// True when parsing failed / language unsupported and the file fell back
    /// to whole-file line windows.
    pub fallback_whole_file: bool,
    /// Chunks dropped by [`MAX_CHUNKS_PER_FILE`].
    pub dropped_over_cap: u32,
}

/// Chunk one source file. Pure: same input → same chunks, same hashes.
/// `imports` (from the structural scan) season every header so a body match
/// still carries file context into the embedder.
pub fn chunk_source(rel: &str, ext: &str, source: &str, imports: &[String]) -> ChunkOutcome {
    if source.trim().is_empty() {
        return ChunkOutcome::default();
    }
    let Some((language, label)) = grammar_for(ext) else {
        return whole_file(rel, "text", source, imports);
    };
    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&language).is_err() {
        return whole_file(rel, label, source, imports);
    }
    let Some(tree) = parser.parse(source, None) else {
        return whole_file(rel, label, source, imports);
    };
    let root = tree.root_node();
    if root.named_child_count() == 0 {
        return whole_file(rel, label, source, imports);
    }

    let starts = line_starts(source);

    // ── 1+2. Contiguous segments, oversized containers exploded inline ──────
    let mut segs: Vec<Seg> = Vec::new();
    let mut cursor = root.walk();
    let mut prev_end = 0usize;
    for node in root.named_children(&mut cursor) {
        let start = prev_end;
        prev_end = node.end_byte();
        push_segments(&mut segs, node, start, node.end_byte(), None, source, &starts);
    }
    if let Some(last) = segs.last_mut() {
        last.end = source.len(); // trailing trivia travels with the final item
    }

    // ── 3. Merge small adjacent siblings up to the byte budget ──────────────
    let segs = merge_small(segs);

    // ── 4. Emit; anything still oversized gets line windows ─────────────────
    let mut out = ChunkOutcome::default();
    emit(&mut out, rel, label, segs, source, &starts, imports);
    if out.chunks.is_empty() {
        return whole_file(rel, label, source, imports);
    }
    out
}

// ── Language tables ──────────────────────────────────────────────────────────

fn grammar_for(ext: &str) -> Option<(tree_sitter::Language, &'static str)> {
    Some(match ext {
        "rs" => (tree_sitter_rust::LANGUAGE.into(), "rust"),
        "ts" | "mts" | "cts" => {
            (tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(), "typescript")
        }
        "tsx" => (tree_sitter_typescript::LANGUAGE_TSX.into(), "typescript"),
        // JS parses cleanly under the TSX grammar (mirrors the parse probe).
        "js" | "jsx" | "mjs" | "cjs" => {
            (tree_sitter_typescript::LANGUAGE_TSX.into(), "javascript")
        }
        "py" | "pyi" => (tree_sitter_python::LANGUAGE.into(), "python"),
        "go" => (tree_sitter_go::LANGUAGE.into(), "go"),
        _ => return None,
    })
}

/// kind label + whether the node is a container worth exploding when oversized.
fn classify(kind: &str) -> (&'static str, bool) {
    match kind {
        // Rust
        "function_item" | "function_signature_item" => ("fn", false),
        "struct_item" => ("struct", false),
        "enum_item" => ("enum", false),
        "union_item" => ("union", false),
        "trait_item" => ("trait", true),
        "impl_item" => ("impl", true),
        "mod_item" => ("mod", true),
        "macro_definition" => ("macro", false),
        "type_item" => ("type", false),
        "const_item" | "static_item" => ("const", false),
        // TypeScript / JavaScript
        "function_declaration" | "generator_function_declaration" => ("fn", false),
        "class_declaration" | "abstract_class_declaration" => ("class", true),
        "interface_declaration" => ("interface", true),
        "enum_declaration" => ("enum", false),
        "type_alias_declaration" => ("type", false),
        "module" | "internal_module" => ("namespace", true),
        "method_definition" => ("method", false),
        "lexical_declaration" | "variable_declaration" => ("const", false),
        // Python
        "function_definition" => ("fn", false),
        "class_definition" => ("class", true),
        "decorated_definition" => ("fn", false),
        // Go
        "method_declaration" => ("fn", false),
        "type_declaration" => ("type", false),
        "const_declaration" | "var_declaration" => ("const", false),
        _ => ("misc", false),
    }
}

/// Unwrap export/decorator wrappers to the node that carries kind + name.
fn effective_node(node: tree_sitter::Node) -> tree_sitter::Node {
    match node.kind() {
        "export_statement" => node.child_by_field_name("declaration").unwrap_or(node),
        "decorated_definition" => node.child_by_field_name("definition").unwrap_or(node),
        _ => node,
    }
}

/// The name labelling a chunk: `name` field, an impl's type, or the first
/// declarator/spec of a var/const/type declaration.
fn name_of(node: tree_sitter::Node, source: &str) -> String {
    let target = effective_node(node);
    if let Some(name) = target.child_by_field_name("name") {
        return name.utf8_text(source.as_bytes()).unwrap_or("").to_string();
    }
    if target.kind() == "impl_item" {
        if let Some(ty) = target.child_by_field_name("type") {
            return ty.utf8_text(source.as_bytes()).unwrap_or("").to_string();
        }
    }
    let mut cursor = target.walk();
    for child in target.named_children(&mut cursor) {
        if matches!(
            child.kind(),
            "variable_declarator" | "type_spec" | "const_spec" | "var_spec"
        ) {
            if let Some(name) = child.child_by_field_name("name") {
                return name.utf8_text(source.as_bytes()).unwrap_or("").to_string();
            }
        }
    }
    String::new()
}

// ── Segmentation ─────────────────────────────────────────────────────────────

/// A candidate chunk: a byte range plus what it is.
struct Seg {
    start: usize,
    end: usize,
    kind: &'static str,
    symbols: Vec<String>,
    enclosing: Option<String>,
}

/// Turn one top-level (or container-member) node into segments, exploding
/// oversized containers into their members and splitting oversized leaves at
/// statement boundaries. `start..end` is the contiguous span this node owns
/// (leading trivia attached, container braces included at the edges).
fn push_segments(
    out: &mut Vec<Seg>,
    node: tree_sitter::Node,
    start: usize,
    end: usize,
    enclosing: Option<String>,
    source: &str,
    starts: &[usize],
) {
    let effective = effective_node(node);
    let (kind, container) = classify(effective.kind());
    let symbol = name_of(node, source);
    let len = end.saturating_sub(start);

    // Oversized container → one segment per member, each labelled with the
    // container as enclosing context. Signature travels with the first member,
    // the closing brace with the last.
    if container && len > MAX_CHUNK_BYTES {
        if let Some(body) = effective.child_by_field_name("body") {
            let mut cursor = body.walk();
            let members: Vec<tree_sitter::Node> = body.named_children(&mut cursor).collect();
            if members.len() >= 2 {
                let enc = if symbol.is_empty() {
                    kind.to_string()
                } else {
                    format!("{kind} {symbol}")
                };
                let last = members.len() - 1;
                let mut prev = start;
                for (i, member) in members.into_iter().enumerate() {
                    let m_start = prev;
                    prev = member.end_byte();
                    let m_end = if i == last { end } else { member.end_byte() };
                    push_segments(out, member, m_start, m_end, Some(enc.clone()), source, starts);
                }
                return;
            }
        }
    }

    let symbols = if symbol.is_empty() { Vec::new() } else { vec![symbol] };

    // Oversized leaf → statement-boundary windows with line overlap.
    if len > MAX_CHUNK_BYTES {
        if let Some(points) = statement_points(effective, end) {
            for (s, e) in windows_from_points(start, end, &points, starts) {
                out.push(Seg {
                    start: s,
                    end: e,
                    kind,
                    symbols: symbols.clone(),
                    enclosing: enclosing.clone(),
                });
            }
            return;
        }
        // No statement structure — the emit pass line-windows it.
    }

    out.push(Seg {
        start,
        end,
        kind,
        symbols,
        enclosing,
    });
}

/// Split points at the node's body-statement boundaries (2+ statements), for
/// statement-aligned windows. `None` when the node has no usable body.
fn statement_points(node: tree_sitter::Node, end: usize) -> Option<Vec<usize>> {
    let body = node.child_by_field_name("body")?;
    let mut cursor = body.walk();
    let kids: Vec<tree_sitter::Node> = body.named_children(&mut cursor).collect();
    if kids.len() < 2 {
        return None;
    }
    let mut points: Vec<usize> = kids.iter().skip(1).map(|k| k.start_byte()).collect();
    points.push(end);
    Some(points)
}

/// Merge adjacent small segments (same enclosing) up to the byte budget.
fn merge_small(segs: Vec<Seg>) -> Vec<Seg> {
    let mut out: Vec<Seg> = Vec::new();
    for seg in segs {
        if let Some(prev) = out.last_mut() {
            let combined = seg.end - prev.start;
            if prev.enclosing == seg.enclosing && combined <= MERGE_TARGET_BYTES {
                prev.end = seg.end;
                if prev.kind == "misc" {
                    prev.kind = seg.kind;
                }
                prev.symbols.extend(seg.symbols);
                continue;
            }
        }
        out.push(seg);
    }
    out
}

// ── Windows ──────────────────────────────────────────────────────────────────

/// Greedy windows over ascending split `points` (each an offset in
/// `(start, end]`, ending with `end`): every window packs as many points as fit
/// under [`MAX_CHUNK_BYTES`], and each later window starts
/// [`SPLIT_OVERLAP_LINES`] back into the previous one. A single span larger
/// than the cap becomes its own window — exact ranges beat truncated bodies.
fn windows_from_points(
    start: usize,
    end: usize,
    points: &[usize],
    starts: &[usize],
) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    let mut win_start = start;
    let mut i = 0usize;
    while i < points.len() {
        let mut j = i;
        while j + 1 < points.len() && points[j + 1] - win_start <= MAX_CHUNK_BYTES {
            j += 1;
        }
        let win_end = points[j].min(end);
        out.push((win_start, win_end));
        i = j + 1;
        if i >= points.len() || win_end >= end {
            break;
        }
        // Overlap: back up a few lines into the window just emitted. The next
        // start must be a real boundary (a line start, or `win_end` itself —
        // a statement/node boundary) strictly after the previous start, so a
        // window over few long lines can never yield an arbitrary byte offset
        // that would slice mid-character.
        let line_idx = starts.partition_point(|&s| s < win_end);
        let back = line_idx.saturating_sub(SPLIT_OVERLAP_LINES);
        let mut candidate = starts.get(back).copied().unwrap_or(win_end);
        if candidate <= win_start {
            let next_idx = starts.partition_point(|&s| s <= win_start);
            candidate = starts.get(next_idx).copied().unwrap_or(win_end);
        }
        win_start = candidate.min(win_end);
    }
    out
}

/// Line-boundary windows — the universal fallback for spans with no statement
/// structure (and for unparseable files).
fn line_windows(start: usize, end: usize, starts: &[usize]) -> Vec<(usize, usize)> {
    let points: Vec<usize> = starts
        .iter()
        .copied()
        .filter(|&s| s > start && s < end)
        .chain(std::iter::once(end))
        .collect();
    windows_from_points(start, end, &points, starts)
}

// ── Emission ─────────────────────────────────────────────────────────────────

fn line_starts(source: &str) -> Vec<usize> {
    let mut starts = vec![0usize];
    for (i, b) in source.bytes().enumerate() {
        if b == b'\n' {
            starts.push(i + 1);
        }
    }
    starts
}

/// 1-based line containing byte offset `at`.
fn line_of(at: usize, starts: &[usize]) -> u32 {
    starts.partition_point(|&s| s <= at) as u32
}

fn emit(
    out: &mut ChunkOutcome,
    rel: &str,
    language: &str,
    segs: Vec<Seg>,
    source: &str,
    starts: &[usize],
    imports: &[String],
) {
    for seg in segs {
        let ranges = if seg.end - seg.start > MAX_CHUNK_BYTES {
            line_windows(seg.start, seg.end, starts)
        } else {
            vec![(seg.start, seg.end)]
        };
        for (start, end) in ranges {
            let body = &source[start..end];
            if body.trim().is_empty() {
                continue;
            }
            if out.chunks.len() >= MAX_CHUNKS_PER_FILE {
                out.dropped_over_cap += 1;
                continue;
            }
            out.chunks
                .push(make_chunk(rel, language, &seg, body, start, end, starts, imports));
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn make_chunk(
    rel: &str,
    language: &str,
    seg: &Seg,
    body: &str,
    start: usize,
    end: usize,
    starts: &[usize],
    imports: &[String],
) -> CodeChunk {
    let header = build_header(
        rel,
        language,
        seg.enclosing.as_deref(),
        seg.kind,
        &seg.symbols,
        imports,
    );
    let hash = chunk_hash(&header, body);
    CodeChunk {
        rel: rel.to_string(),
        language: language.to_string(),
        kind: seg.kind.to_string(),
        symbol: seg.symbols.first().cloned().unwrap_or_default(),
        header,
        body: body.to_string(),
        start_line: line_of(start, starts),
        end_line: line_of(end.saturating_sub(1).max(start), starts),
        start_byte: start as u32,
        end_byte: end as u32,
        hash,
    }
}

/// The load-bearing context header: what makes a bare function body
/// retrievable once it is separated from its file.
fn build_header(
    rel: &str,
    language: &str,
    enclosing: Option<&str>,
    kind: &str,
    symbols: &[String],
    imports: &[String],
) -> String {
    let mut s = format!("{rel} ({language})");
    if let Some(enc) = enclosing {
        s.push_str(" · ");
        s.push_str(enc);
    }
    if !symbols.is_empty() {
        let shown: Vec<&str> = symbols
            .iter()
            .take(HEADER_SYMBOLS)
            .map(|x| x.as_str())
            .collect();
        s.push_str(" · ");
        s.push_str(kind);
        s.push(' ');
        s.push_str(&shown.join(", "));
        if symbols.len() > HEADER_SYMBOLS {
            s.push('…');
        }
    }
    if !imports.is_empty() {
        let shown: Vec<&str> = imports
            .iter()
            .take(HEADER_IMPORTS)
            .map(|x| x.as_str())
            .collect();
        s.push_str(" · imports: ");
        s.push_str(&shown.join(", "));
    }
    s
}

/// The chunk's content address. Header changes (rename, moved file, new
/// imports) re-address the chunk on purpose — the embedded text changed.
pub fn chunk_hash(header: &str, body: &str) -> String {
    let mut h = blake3::Hasher::new();
    h.update(header.as_bytes());
    h.update(b"\n");
    h.update(body.as_bytes());
    h.finalize().to_hex().to_string()
}

/// Degradation floor: the whole file as line windows (never silence).
fn whole_file(rel: &str, language: &str, source: &str, imports: &[String]) -> ChunkOutcome {
    let starts = line_starts(source);
    let seg = Seg {
        start: 0,
        end: source.len(),
        kind: "file",
        symbols: Vec::new(),
        enclosing: None,
    };
    let mut out = ChunkOutcome {
        fallback_whole_file: true,
        ..Default::default()
    };
    emit(&mut out, rel, language, vec![seg], source, &starts, imports);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn imports() -> Vec<String> {
        vec!["serde".into(), "tokio".into()]
    }

    /// Chunks cover the file: first starts at 0, last ends at EOF, and every
    /// chunk begins at or before the previous one's end (overlap allowed,
    /// gaps not).
    fn assert_coverage(source: &str, chunks: &[CodeChunk]) {
        assert!(!chunks.is_empty());
        assert_eq!(chunks[0].start_byte, 0, "first chunk starts at 0");
        assert_eq!(
            chunks.last().unwrap().end_byte as usize,
            source.len(),
            "last chunk ends at EOF"
        );
        for pair in chunks.windows(2) {
            assert!(
                pair[1].start_byte <= pair[0].end_byte,
                "gap between chunks: {} .. {}",
                pair[0].end_byte,
                pair[1].start_byte
            );
        }
    }

    #[test]
    fn small_rust_items_merge_into_one_chunk() {
        let src = "use std::io;\n\npub fn alpha() -> u32 { 1 }\n\npub fn beta() -> u32 { 2 }\n";
        let out = chunk_source("src/a.rs", "rs", src, &imports());
        assert!(!out.fallback_whole_file);
        assert_eq!(out.chunks.len(), 1, "small siblings merge: {:#?}", out.chunks);
        let c = &out.chunks[0];
        assert!(c.body.contains("alpha") && c.body.contains("beta"));
        assert!(c.header.contains("src/a.rs (rust)"), "header: {}", c.header);
        assert!(c.header.contains("imports: serde, tokio"), "header: {}", c.header);
        assert_coverage(src, &out.chunks);
    }

    #[test]
    fn body_is_exact_source_slice_and_lines_are_right() {
        let src = "pub fn one() {}\n\npub fn two() {\n    let x = 1;\n}\n";
        let out = chunk_source("src/b.rs", "rs", src, &[]);
        for c in &out.chunks {
            assert_eq!(
                c.body,
                &src[c.start_byte as usize..c.end_byte as usize],
                "body must be the exact slice"
            );
        }
        assert_eq!(out.chunks[0].start_line, 1);
        assert_eq!(out.chunks.last().unwrap().end_line, 5);
        assert_coverage(src, &out.chunks);
    }

    #[test]
    fn large_functions_get_their_own_chunks() {
        // Two functions each larger than the merge budget → two chunks.
        let big_stmt = "    let value = compute_something_reasonably_long(1, 2, 3);\n";
        let f1 = format!("pub fn first() {{\n{}}}\n", big_stmt.repeat(12));
        let f2 = format!("pub fn second() {{\n{}}}\n", big_stmt.repeat(12));
        let src = format!("{f1}\n{f2}");
        let out = chunk_source("src/c.rs", "rs", &src, &[]);
        assert_eq!(
            out.chunks.len(),
            2,
            "{:#?}",
            out.chunks.iter().map(|c| &c.symbol).collect::<Vec<_>>()
        );
        assert_eq!(out.chunks[0].symbol, "first");
        assert_eq!(out.chunks[1].symbol, "second");
        assert_eq!(out.chunks[0].kind, "fn");
        assert_coverage(&src, &out.chunks);
    }

    #[test]
    fn oversized_impl_explodes_into_methods_with_enclosing_context() {
        let method = |name: &str| {
            format!(
                "    pub fn {name}(&self) -> u64 {{\n{}    }}\n",
                "        let a = self.value + 1; let b = a * 2; let c = b - 3;\n".repeat(14)
            )
        };
        let src = format!(
            "pub struct Engine {{ value: u64 }}\n\nimpl Engine {{\n{}{}{}}}\n",
            method("start"),
            method("stop"),
            method("restart"),
        );
        assert!(src.len() > MAX_CHUNK_BYTES, "test premise: impl is oversized");
        let out = chunk_source("src/engine.rs", "rs", &src, &[]);
        let with_enclosing: Vec<&CodeChunk> = out
            .chunks
            .iter()
            .filter(|c| c.header.contains("impl Engine"))
            .collect();
        assert!(
            with_enclosing.len() >= 3,
            "each method chunk carries its impl: {:#?}",
            out.chunks.iter().map(|c| &c.header).collect::<Vec<_>>()
        );
        assert!(with_enclosing.iter().any(|c| c.symbol == "start"));
        assert_coverage(&src, &out.chunks);
    }

    #[test]
    fn oversized_leaf_splits_with_overlap() {
        let line = "    call_a_function_with_a_reasonably_long_name(argument_one, argument_two);\n";
        let src = format!("pub fn giant() {{\n{}}}\n", line.repeat(80));
        assert!(src.len() > MAX_CHUNK_BYTES);
        let out = chunk_source("src/giant.rs", "rs", &src, &[]);
        assert!(out.chunks.len() >= 2, "oversized leaf must split");
        // Every window after the first overlaps back into the previous one.
        for pair in out.chunks.windows(2) {
            assert!(
                pair[1].start_byte < pair[0].end_byte,
                "split windows must overlap: {} !< {}",
                pair[1].start_byte,
                pair[0].end_byte
            );
        }
        // Statement-aligned: every chunk after the first starts at a line start.
        for c in &out.chunks[1..] {
            let at = c.start_byte as usize;
            assert!(
                at == 0 || src.as_bytes()[at - 1] == b'\n',
                "window starts mid-line at {at}"
            );
        }
        assert_coverage(&src, &out.chunks);
    }

    #[test]
    fn python_class_and_typescript_class_chunk() {
        let py = "import os\n\nclass Store:\n    def get(self):\n        return 1\n\n    def put(self):\n        return 2\n\ndef main():\n    pass\n";
        let out = chunk_source("store.py", "py", py, &[]);
        assert!(!out.fallback_whole_file);
        assert!(out.chunks.iter().any(|c| c.body.contains("class Store")));
        assert_coverage(py, &out.chunks);

        let ts = "import { x } from './x';\n\nexport class Widget {\n  render(): string { return 'w'; }\n}\n\nexport function helper(): number { return 1; }\n";
        let out = chunk_source("widget.ts", "ts", ts, &[]);
        assert!(!out.fallback_whole_file);
        assert!(
            out.chunks
                .iter()
                .any(|c| c.symbol == "Widget" || c.header.contains("Widget")),
            "{:#?}",
            out.chunks.iter().map(|c| &c.header).collect::<Vec<_>>()
        );
        assert_coverage(ts, &out.chunks);
    }

    #[test]
    fn go_functions_chunk() {
        let go = "package main\n\nimport \"fmt\"\n\nfunc Alpha() int {\n\treturn 1\n}\n\nfunc (s *Server) Beta() int {\n\treturn 2\n}\n";
        let out = chunk_source("main.go", "go", go, &[]);
        assert!(!out.fallback_whole_file);
        assert!(out.chunks.iter().any(|c| c.body.contains("func Alpha")));
        assert_coverage(go, &out.chunks);
    }

    #[test]
    fn unsupported_extension_falls_back_to_whole_file() {
        let src = "some plain text\nwith two lines\n";
        let out = chunk_source("notes.txt", "txt", src, &[]);
        assert!(out.fallback_whole_file);
        assert_eq!(out.chunks.len(), 1);
        assert_eq!(out.chunks[0].kind, "file");
        assert_eq!(out.chunks[0].body, src);
    }

    /// Oversized statements packed onto ONE line (minified-style), with
    /// multibyte chars: the overlap back-off has no line start to land on and
    /// must fall through to a real boundary instead of an arbitrary byte
    /// offset (which sliced mid-character and panicked).
    #[test]
    fn single_line_oversized_body_with_multibyte_chars_does_not_panic() {
        let stmt = format!("let s = \"{}\"; ", "é".repeat(400));
        let src = format!("pub fn packed() {{ {}}}\n", stmt.repeat(5));
        assert!(src.len() > MAX_CHUNK_BYTES);
        let out = chunk_source("src/packed.rs", "rs", &src, &[]);
        assert!(!out.chunks.is_empty());
        for c in &out.chunks {
            assert_eq!(c.body, &src[c.start_byte as usize..c.end_byte as usize]);
        }
        assert_coverage(&src, &out.chunks);
    }

    #[test]
    fn chunking_is_deterministic_and_content_addressed() {
        let src = "pub fn stable() -> &'static str { \"same\" }\n";
        let a = chunk_source("src/d.rs", "rs", src, &imports());
        let b = chunk_source("src/d.rs", "rs", src, &imports());
        let ha: Vec<&str> = a.chunks.iter().map(|c| c.hash.as_str()).collect();
        let hb: Vec<&str> = b.chunks.iter().map(|c| c.hash.as_str()).collect();
        assert_eq!(ha, hb, "same input → same content addresses");
        // A body edit re-addresses the chunk.
        let c = chunk_source(
            "src/d.rs",
            "rs",
            "pub fn stable() -> &'static str { \"changed\" }\n",
            &imports(),
        );
        assert_ne!(a.chunks[0].hash, c.chunks[0].hash);
    }
}

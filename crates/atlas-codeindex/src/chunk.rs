//! cAST chunking (Zhang et al., EMNLP 2025 Findings, arXiv 2506.15655): split a
//! file's syntax tree into chunks of at most `BUDGET_NWS` non-whitespace
//! characters. Whole definitions stay together where they fit, larger nodes
//! are split by recursing into their children, and adjacent small siblings
//! merge greedily. Chunks cover whole lines; each gets a breadcrumb header and
//! the hash of exactly the text that is embedded.

use tree_sitter::Node;

use crate::extract::SymbolRec;

pub const BUDGET_NWS: usize = 1800;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChunkRec {
    pub start_line: u32,
    pub end_line: u32,
    /// Index into the file's symbols: innermost enclosing, else the first starting inside.
    pub symbol: Option<usize>,
    pub header: String,
    pub content_hash: [u8; 32],
}

fn nws(src: &[u8]) -> usize {
    src.iter().filter(|c| !c.is_ascii_whitespace()).count()
}

/// The exact text embedded, hashed and indexed for a chunk.
pub(crate) fn chunk_text(header: &str, body: &str) -> String {
    format!("{header}\n{body}")
}

fn split(node: Node, src: &[u8], out: &mut Vec<(usize, usize)>) {
    let mut cursor = node.walk();
    let children: Vec<Node> = node.children(&mut cursor).collect();
    if children.is_empty() {
        out.push((node.start_byte(), node.end_byte()));
        return;
    }
    let mut cur: Option<(usize, usize, usize)> = None;
    for child in children {
        let (a, b) = (child.start_byte(), child.end_byte());
        let size = nws(&src[a..b]);
        if size > BUDGET_NWS {
            if let Some((s, e, _)) = cur.take() {
                out.push((s, e));
            }
            split(child, src, out);
            continue;
        }
        cur = match cur {
            Some((s, _, n)) if n + size <= BUDGET_NWS => Some((s, b, n + size)),
            Some((s, e, _)) => {
                out.push((s, e));
                Some((a, b, size))
            }
            None => Some((a, b, size)),
        };
    }
    if let Some((s, e, _)) = cur {
        out.push((s, e));
    }
}

pub(crate) fn chunk_file(
    root: Node,
    src: &[u8],
    rel: &str,
    symbols: &[SymbolRec],
) -> Vec<ChunkRec> {
    if nws(src) == 0 {
        return Vec::new();
    }
    let mut spans = Vec::new();
    split(root, src, &mut spans);
    let line_starts: Vec<usize> = std::iter::once(0)
        .chain(
            src.iter()
                .enumerate()
                .filter(|(_, &c)| c == b'\n')
                .map(|(i, _)| i + 1),
        )
        .collect();
    let line_of = |byte: usize| line_starts.partition_point(|&s| s <= byte) as u32; // 1-based
    let text = String::from_utf8_lossy(src);
    let lines: Vec<&str> = text.lines().collect();
    let mut out: Vec<ChunkRec> = Vec::new();
    for (a, b) in spans {
        if nws(&src[a..b]) == 0 {
            continue;
        }
        let (start_line, end_line) = (line_of(a), line_of(b.saturating_sub(1)).max(line_of(a)));
        // Whole lines; merge with the previous chunk when spans share a line.
        if let Some(prev) = out.last_mut() {
            if start_line <= prev.end_line {
                prev.end_line = prev.end_line.max(end_line);
                continue;
            }
        }
        let (a32, b32) = (a as u32, b as u32);
        let enclosing = symbols
            .iter()
            .enumerate()
            .filter(|(_, s)| s.kind != "impl" && s.start_byte <= a32 && s.end_byte >= b32)
            .min_by_key(|(_, s)| s.end_byte - s.start_byte)
            .map(|(i, _)| i);
        let first_inside = symbols
            .iter()
            .enumerate()
            .filter(|(_, s)| s.kind != "impl" && s.start_byte >= a32 && s.start_byte < b32)
            .min_by_key(|(_, s)| (s.start_byte, std::cmp::Reverse(s.end_byte)))
            .map(|(i, _)| i);
        let symbol = enclosing.or(first_inside);
        out.push(ChunkRec {
            start_line,
            end_line,
            symbol,
            header: String::new(),
            content_hash: [0; 32],
        });
    }
    for c in &mut out {
        c.header = match c.symbol.map(|i| &symbols[i]) {
            Some(s) => match s
                .signature
                .lines()
                .next()
                .map(str::trim)
                .filter(|l| !l.is_empty())
            {
                Some(sig) => format!("{rel} :: {} :: {sig}", s.qualified_name),
                None => format!("{rel} :: {}", s.qualified_name),
            },
            None => rel.to_string(),
        };
        let body = lines
            [(c.start_line as usize - 1).min(lines.len())..(c.end_line as usize).min(lines.len())]
            .join("\n");
        c.content_hash = *blake3::hash(chunk_text(&c.header, &body).as_bytes()).as_bytes();
    }
    out
}

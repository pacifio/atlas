//! Typed traversal over the resolved graph: who calls, is called by,
//! imports, implements or tests a symbol, and what a diff puts at risk.
//! Every walk is a breadth-first search capped at `MAX_HOPS` hops and
//! `MAX_ROWS` visited nodes, and says when it stopped early.

use std::collections::{BTreeSet, VecDeque};

use atlas_search::compact::Page;
use rusqlite::{params, Connection, OptionalExtension};

use crate::diff::{changed_paths, DiffHunk};
use crate::{CodeIndex, IndexError};

pub const MAX_ROWS: usize = 4096;
pub const MAX_HOPS: u8 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Relation {
    Callers,
    Callees,
    Importers,
    Imports,
    Implementations,
    Tests,
}

impl Relation {
    pub fn parse(s: &str) -> Option<Relation> {
        Some(match s {
            "callers" => Relation::Callers,
            "callees" => Relation::Callees,
            "importers" => Relation::Importers,
            "imports" => Relation::Imports,
            "implementations" => Relation::Implementations,
            "tests" => Relation::Tests,
            _ => return None,
        })
    }

    fn is_file_level(self) -> bool {
        matches!(self, Relation::Importers | Relation::Imports)
    }
}

#[derive(Debug, Clone)]
pub struct RelatedQuery {
    /// Qualified name, plain name, or (for importers/imports) a root-relative path.
    pub target: String,
    pub relation: Relation,
    pub hops: u8,
    pub include_tests: bool,
    /// Only hits in files inside this root-relative directory; the walk still
    /// passes through code outside it.
    pub within: Option<String>,
    pub limit: usize,
    pub offset: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RelatedHit {
    pub qualified_name: String,
    /// Symbol kind, or "file" for importers/imports.
    pub kind: String,
    pub rel: String,
    pub start_line: u32,
    pub end_line: u32,
    pub hop: u8,
    /// Best edge confidence on the path's last step (1.0 for imports).
    pub confidence: f64,
    pub is_test: bool,
    pub importance: f64,
}

impl RelatedHit {
    /// CMM's hop-distance risk labels (hop 0 = the changed symbol itself).
    pub fn risk(&self) -> &'static str {
        match self.hop {
            0 => "CHANGED",
            1 => "CRITICAL",
            2 => "HIGH",
            3 => "MEDIUM",
            _ => "LOW",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ImpactReport {
    pub changed_files: Vec<String>,
    pub changed: Vec<RelatedHit>,
    pub impacted: Vec<RelatedHit>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Node {
    Sym(i64),
    File(i64),
}

fn sym_seeds(c: &Connection, target: &str) -> rusqlite::Result<Vec<i64>> {
    for sql in [
        "SELECT id FROM symbols WHERE qualified_name = ?1 AND kind <> 'impl' ORDER BY id",
        "SELECT id FROM symbols WHERE name = ?1 AND kind <> 'impl' ORDER BY id",
        "SELECT id FROM symbols WHERE lower(name) = lower(?1) AND kind <> 'impl' ORDER BY id",
    ] {
        let ids: Vec<i64> = c
            .prepare_cached(sql)?
            .query_map([target], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        if !ids.is_empty() {
            return Ok(ids);
        }
    }
    Ok(Vec::new())
}

fn file_seed(c: &Connection, target: &str) -> rusqlite::Result<Option<i64>> {
    let by_rel = c
        .query_row("SELECT id FROM files WHERE rel = ?1", [target], |r| {
            r.get(0)
        })
        .optional()?;
    if by_rel.is_some() {
        return Ok(by_rel);
    }
    // A symbol name: its defining file.
    Ok(sym_seeds(c, target)?.first().copied().and_then(|id| {
        c.query_row("SELECT file_id FROM symbols WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .ok()
    }))
}

fn suggestions(c: &Connection, target: &str) -> rusqlite::Result<Vec<String>> {
    // Same-prefix names: cheap and good enough for typos at the end ("lef" → "leaf").
    let needle = format!(
        "{}%",
        target.chars().take(2).collect::<String>().to_lowercase()
    );
    c.prepare_cached("SELECT DISTINCT name FROM symbols WHERE lower(name) LIKE ?1 AND kind <> 'impl' ORDER BY importance DESC, name LIMIT 5")?
        .query_map([needle], |r| r.get(0))?
        .collect()
}

fn neighbours(
    c: &Connection,
    node: Node,
    relation: Relation,
) -> rusqlite::Result<Vec<(Node, f64)>> {
    let (sql, wrap): (&str, fn(i64) -> Node) = match (relation, node) {
        (Relation::Callers | Relation::Tests, Node::Sym(_)) => (
            "SELECT src_symbol_id, MAX(confidence) FROM edges WHERE dst_symbol_id = ?1 AND kind IN ('call','value') GROUP BY src_symbol_id ORDER BY src_symbol_id",
            Node::Sym,
        ),
        (Relation::Callees, Node::Sym(_)) => (
            "SELECT dst_symbol_id, MAX(confidence) FROM edges WHERE src_symbol_id = ?1 AND kind IN ('call','value') GROUP BY dst_symbol_id ORDER BY dst_symbol_id",
            Node::Sym,
        ),
        (Relation::Implementations, Node::Sym(_)) => (
            "SELECT src_symbol_id, MAX(confidence) FROM edges WHERE dst_symbol_id = ?1 AND kind IN ('impl','inherit') GROUP BY src_symbol_id ORDER BY src_symbol_id",
            Node::Sym,
        ),
        (Relation::Importers, Node::File(_)) => (
            "SELECT DISTINCT file_id, 1.0 FROM imports WHERE resolved_file_id = ?1 AND file_id <> ?1 ORDER BY file_id",
            Node::File,
        ),
        (Relation::Imports, Node::File(_)) => (
            "SELECT DISTINCT resolved_file_id, 1.0 FROM imports WHERE file_id = ?1 AND resolved_file_id IS NOT NULL AND resolved_file_id <> ?1 ORDER BY resolved_file_id",
            Node::File,
        ),
        _ => return Ok(Vec::new()),
    };
    let id = match node {
        Node::Sym(i) | Node::File(i) => i,
    };
    c.prepare_cached(sql)?
        .query_map([id], |r| Ok((wrap(r.get(0)?), r.get(1)?)))?
        .collect()
}

/// Nodes a walk reached: (node, hop, confidence).
type Reached = Vec<(Node, u8, f64)>;

/// Breadth-first from `seeds`; returns (node, hop, confidence) without the seeds. A node's
/// confidence is its path's weakest edge: a hop-2 caller is no surer than the hop-1 edge
/// it was reached through.
fn bfs(
    c: &Connection,
    seeds: &[Node],
    relation: Relation,
    hops: u8,
) -> rusqlite::Result<(Reached, bool)> {
    let mut seen: BTreeSet<Node> = seeds.iter().copied().collect();
    let mut queue: VecDeque<(Node, u8, f64)> = seeds.iter().map(|&n| (n, 0, 1.0)).collect();
    let mut out = Vec::new();
    while let Some((node, hop, path)) = queue.pop_front() {
        if hop >= hops {
            continue;
        }
        for (next, conf) in neighbours(c, node, relation)? {
            if !seen.insert(next) {
                continue;
            }
            if seen.len() > MAX_ROWS {
                return Ok((out, true));
            }
            let conf = conf.min(path);
            out.push((next, hop + 1, conf));
            queue.push_back((next, hop + 1, conf));
        }
    }
    Ok((out, false))
}

fn hit(
    c: &Connection,
    node: Node,
    hop: u8,
    confidence: f64,
) -> rusqlite::Result<Option<RelatedHit>> {
    match node {
        Node::Sym(id) => c
            .query_row(
                "SELECT s.qualified_name, s.kind, f.rel, s.start_line, s.end_line, s.is_test, s.importance
                 FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?1",
                [id],
                |r| {
                    Ok(RelatedHit {
                        qualified_name: r.get(0)?,
                        kind: r.get(1)?,
                        rel: r.get(2)?,
                        start_line: r.get(3)?,
                        end_line: r.get(4)?,
                        hop,
                        confidence,
                        is_test: r.get(5)?,
                        importance: r.get(6)?,
                    })
                },
            )
            .optional(),
        Node::File(id) => c
            .query_row("SELECT rel FROM files WHERE id = ?1", [id], |r| r.get::<_, String>(0))
            .optional()
            .map(|rel| {
                rel.map(|rel| RelatedHit {
                    qualified_name: rel.clone(),
                    kind: "file".into(),
                    rel,
                    start_line: 1,
                    end_line: 1,
                    hop,
                    confidence,
                    is_test: false,
                    importance: 0.0,
                })
            }),
    }
}

fn order(hits: &mut [RelatedHit]) {
    hits.sort_by(|a, b| {
        a.hop
            .cmp(&b.hop)
            .then(b.importance.total_cmp(&a.importance))
            .then_with(|| a.rel.cmp(&b.rel))
            .then(a.start_line.cmp(&b.start_line))
            .then_with(|| a.qualified_name.cmp(&b.qualified_name))
            // Total order: hits that tie on everything above (same name and
            // line, e.g. a Rust `impl` pair) must still page identically.
            .then_with(|| a.kind.cmp(&b.kind))
            .then(a.end_line.cmp(&b.end_line))
            .then(b.confidence.total_cmp(&a.confidence))
            .then(a.is_test.cmp(&b.is_test))
    });
}

impl CodeIndex {
    pub fn related(&self, q: &RelatedQuery) -> Result<(Vec<RelatedHit>, Page), IndexError> {
        let hops = q.hops.clamp(1, MAX_HOPS);
        let limit = if q.limit == 0 { 50 } else { q.limit.min(500) };
        let (rows, truncated) = self
            .with_reader(|c| {
                let seeds: Vec<Node> = if q.relation.is_file_level() {
                    file_seed(c, &q.target)?
                        .into_iter()
                        .map(Node::File)
                        .collect()
                } else {
                    sym_seeds(c, &q.target)?
                        .into_iter()
                        .map(Node::Sym)
                        .collect()
                };
                if seeds.is_empty() {
                    return Ok(Err(suggestions(c, &q.target)?));
                }
                let (found, truncated) = bfs(c, &seeds, q.relation, hops)?;
                let mut hits = Vec::new();
                for (node, hop, conf) in found {
                    if let Some(h) = hit(c, node, hop, conf)? {
                        let keep = match q.relation {
                            Relation::Tests => h.is_test,
                            _ => q.include_tests || !h.is_test,
                        } && crate::is_within(&h.rel, q.within.as_deref());
                        if keep {
                            hits.push(h);
                        }
                    }
                }
                Ok(Ok((hits, truncated)))
            })?
            .map_err(|suggestions| IndexError::NotFound {
                query: q.target.clone(),
                suggestions,
            })?;
        let mut hits = rows;
        order(&mut hits);
        let total = hits.len();
        let page_hits: Vec<RelatedHit> = hits.into_iter().skip(q.offset).take(limit).collect();
        let next = (q.offset + page_hits.len() < total).then_some(q.offset + page_hits.len());
        let page = Page {
            total,
            total_exact: !truncated,
            offset: q.offset,
            next_offset: next,
            truncation: if truncated {
                Some("row_cap")
            } else if next.is_some() {
                Some("page_limit")
            } else {
                None
            },
        };
        Ok((page_hits, page))
    }

    pub fn impact_of_diff(
        &self,
        hunks: &[DiffHunk],
        depth: u8,
    ) -> Result<ImpactReport, IndexError> {
        let depth = depth.clamp(1, MAX_HOPS);
        self.with_reader(|c| {
            let mut seeds: BTreeSet<i64> = BTreeSet::new();
            for h in hunks.iter().filter(|h| !h.deleted_file) {
                let (from, to) = h.line_range();
                // Innermost definitions touched by the hunk.
                let touched: Vec<i64> = c
                    .prepare_cached(
                        "SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id
                         WHERE f.rel = ?1 AND s.kind <> 'impl' AND s.start_line <= ?3 AND s.end_line >= ?2
                           AND NOT EXISTS (SELECT 1 FROM symbols k WHERE k.parent_id = s.id AND k.kind <> 'impl'
                                           AND k.start_line <= ?3 AND k.end_line >= ?2)
                         ORDER BY s.id",
                    )?
                    .query_map(params![h.rel, from, to], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?;
                if touched.is_empty() {
                    // Changed lines outside any definition (imports, attributes): the
                    // file's top-level definitions stand in, as in CMM detect_changes.
                    let top: Vec<i64> = c
                        .prepare_cached(
                            "SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id
                             WHERE f.rel = ?1 AND s.parent_id IS NULL AND s.kind <> 'impl' ORDER BY s.id",
                        )?
                        .query_map([&h.rel], |r| r.get(0))?
                        .collect::<rusqlite::Result<_>>()?;
                    seeds.extend(top);
                } else {
                    seeds.extend(touched);
                }
            }
            let seed_nodes: Vec<Node> = seeds.iter().map(|&id| Node::Sym(id)).collect();
            let (found, truncated) = bfs(c, &seed_nodes, Relation::Callers, depth)?;
            let mut changed = Vec::new();
            for &id in &seeds {
                if let Some(h) = hit(c, Node::Sym(id), 0, 1.0)? {
                    changed.push(h);
                }
            }
            let mut impacted = Vec::new();
            for (node, hop, conf) in found {
                if let Some(h) = hit(c, node, hop, conf)? {
                    impacted.push(h);
                }
            }
            order(&mut changed);
            order(&mut impacted);
            Ok(ImpactReport { changed_files: changed_paths(hunks), changed, impacted, truncated })
        })
    }
}

#[cfg(test)]
mod order_tests {
    use super::{order, RelatedHit};

    fn hit(kind: &str, end_line: u32) -> RelatedHit {
        RelatedHit {
            qualified_name: "a::Foo".into(),
            kind: kind.into(),
            rel: "src/a.rs".into(),
            start_line: 10,
            end_line,
            hop: 1,
            confidence: 0.9,
            is_test: false,
            importance: 0.5,
        }
    }

    #[test]
    fn ties_on_name_and_line_still_sort_the_same_way() {
        let mut a = vec![hit("struct", 20), hit("impl", 40), hit("impl", 30)];
        let mut b = vec![hit("impl", 30), hit("struct", 20), hit("impl", 40)];
        order(&mut a);
        order(&mut b);
        let key = |v: &[RelatedHit]| {
            v.iter()
                .map(|h| (h.kind.clone(), h.end_line))
                .collect::<Vec<_>>()
        };
        assert_eq!(key(&a), key(&b));
        assert_eq!(
            key(&a),
            vec![
                ("impl".into(), 30),
                ("impl".into(), 40),
                ("struct".into(), 20)
            ]
        );
    }
}

//! Reading the index: symbol search, file outlines, symbol source, and the
//! enclosing-symbol locator grep uses to annotate hits.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::sync::Arc;

use atlas_search::compact::Page;
use atlas_search::{EnclosingSymbol, SymbolLocator};
use rusqlite::{params, Connection, Row};

use crate::store::split_words;
use crate::{CodeIndex, IndexError, Inner};

/// FTS candidates considered per query before boosts (two-stage ranking).
const FTS_CANDIDATES: usize = 2000;
/// Exact name / qualified-name matches always considered, even past the FTS cap.
const EXACT_CANDIDATES: usize = 200;
const DEFAULT_LIMIT: usize = 20;
pub(crate) const MAX_LIMIT: usize = 200;
/// File systems that ignore case by default: a path that differs from the indexed one
/// only in case names the same file there.
const CASE_BLIND_FS: bool = cfg!(any(windows, target_os = "macos"));
const MAX_ALTERNATIVES: usize = 8;

#[derive(Debug, Clone, PartialEq)]
pub struct SymbolHit {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    pub qualified_name: String,
    pub kind: String,
    pub rel: String,
    pub start_line: u32,
    pub end_line: u32,
    pub signature: String,
    pub doc: String,
    pub exported: bool,
    pub is_test: bool,
    pub importance: f64,
}

#[derive(Debug, Clone, Default)]
pub struct SymbolQuery {
    /// A name, a qualified name (`CodeIndex::open`), or words (`open index`).
    pub query: String,
    /// Exact `symbols.kind` filter ("fn", "struct", …).
    pub kind: Option<String>,
    /// Only symbols in files under this root-relative prefix.
    pub path_prefix: Option<String>,
    /// Leave test code out entirely (it is otherwise ranked last).
    pub exclude_tests: bool,
    /// Only symbols in files inside this root-relative directory (a session
    /// launched in a subdirectory of the project); see [`is_within`].
    pub within: Option<String>,
    /// Page size; 0 means the default (20). Capped at 200.
    pub limit: usize,
    pub offset: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SymbolSource {
    pub symbol: SymbolHit,
    /// Source lines `start_line..=end_line` as on disk now (`None` when the
    /// symbol is longer than `max_lines` and `members` are returned instead).
    pub source: Option<String>,
    /// `source` was cut at `max_lines` because the symbol has no members.
    pub truncated: bool,
    /// Direct members, when the symbol was too long to return whole.
    pub members: Vec<SymbolHit>,
    /// Other definitions with the same name, best first.
    pub alternatives: Vec<SymbolHit>,
    /// The file changed on disk since it was indexed; lines may be off.
    pub stale: bool,
}

const HIT_COLUMNS: &str =
    "s.id, s.parent_id, s.name, s.qualified_name, s.kind, f.rel, s.start_line, \
     s.end_line, s.signature, s.doc, s.exported, s.is_test, s.importance";

fn hit(r: &Row) -> rusqlite::Result<SymbolHit> {
    Ok(SymbolHit {
        id: r.get(0)?,
        parent_id: r.get(1)?,
        name: r.get(2)?,
        qualified_name: r.get(3)?,
        kind: r.get(4)?,
        rel: r.get(5)?,
        start_line: r.get(6)?,
        end_line: r.get(7)?,
        signature: r.get(8)?,
        doc: r.get(9)?,
        exported: r.get(10)?,
        is_test: r.get(11)?,
        importance: r.get(12)?,
    })
}

/// Declarations first, then functions, methods, values, impl blocks.
pub(crate) fn kind_rank(kind: &str) -> u8 {
    match kind {
        "struct" | "class" | "trait" | "interface" | "enum" | "type" | "union" => 0,
        "fn" => 1,
        "method" => 2,
        "impl" => 4,
        _ => 3,
    }
}

/// 0 = exact name or qualified name (or qualified-name suffix), 1 = name
/// equal ignoring case, 2 = name prefix, 3 = anything else FTS matched.
fn tier(h: &SymbolHit, q: &str) -> u8 {
    let ql = q.to_lowercase();
    let suffix = |sep: &str| h.qualified_name.ends_with(&format!("{sep}{q}"));
    if h.name == q
        || h.qualified_name == q
        || ((q.contains("::") || q.contains('.')) && (suffix("::") || suffix(".")))
    {
        0
    } else if h.name.to_lowercase() == ql {
        1
    } else if h.name.to_lowercase().starts_with(&ql) {
        2
    } else {
        3
    }
}

/// `"code"* "index"*`: every word must prefix-match some column.
fn match_expr(query: &str) -> Option<String> {
    let words = split_words(query);
    (!words.is_empty()).then(|| {
        words
            .iter()
            .map(|w| format!("\"{w}\"*"))
            .collect::<Vec<_>>()
            .join(" ")
    })
}

fn last_segment(q: &str) -> &str {
    q.rsplit([':', '.']).next().unwrap_or(q)
}

/// Whether root-relative `rel` lies inside root-relative directory `dir`
/// (`None` or "" is the whole project). Component-wise: `sub` holds
/// `sub/a.rs`, not `sub2/a.rs`, nor `sub/../a.rs`.
pub fn is_within(rel: &str, dir: Option<&str>) -> bool {
    match dir.map(|d| d.trim_matches('/')) {
        None | Some("") => true,
        Some(d) => {
            !rel.split('/').any(|c| c == "..")
                && rel
                    .strip_prefix(d)
                    .is_some_and(|r| r.is_empty() || r.starts_with('/'))
        }
    }
}

impl CodeIndex {
    /// Ranked symbol search: FTS5 BM25 over (split name, qualified name,
    /// path, doc) takes the best 2000, exact name matches are added, then
    /// exact-name and kind tiers, tests last, BM25, and id give a total order.
    pub fn find_symbol(&self, q: &SymbolQuery) -> Result<(Vec<SymbolHit>, Page), IndexError> {
        let query = q.query.trim();
        let Some(expr) = match_expr(query) else {
            return Err(IndexError::Invalid("query has no letters or digits".into()));
        };
        let limit = if q.limit == 0 {
            DEFAULT_LIMIT
        } else {
            q.limit.min(MAX_LIMIT)
        };
        let (mut scored, fts_full) = self.with_reader(|c| candidates(c, &expr, query))?;
        scored.retain(|(h, _)| {
            q.kind.as_deref().is_none_or(|k| h.kind == k)
                && q.path_prefix
                    .as_deref()
                    .is_none_or(|p| h.rel.starts_with(p.trim_start_matches("./")))
                && !(q.exclude_tests && h.is_test)
                && is_within(&h.rel, q.within.as_deref())
        });
        scored.sort_by(|(a, ra), (b, rb)| {
            let (ta, tb) = (tier(a, query), tier(b, query));
            ta.cmp(&tb)
                .then(a.is_test.cmp(&b.is_test))
                .then(if ta < 3 {
                    kind_rank(&a.kind).cmp(&kind_rank(&b.kind))
                } else {
                    Ordering::Equal
                })
                .then(ra.total_cmp(rb))
                .then(b.importance.total_cmp(&a.importance))
                .then(a.id.cmp(&b.id))
        });
        let total = scored.len();
        let page_hits: Vec<SymbolHit> = scored
            .into_iter()
            .skip(q.offset)
            .take(limit)
            .map(|(h, _)| h)
            .collect();
        let next = q.offset + page_hits.len();
        let next_offset = (next < total).then_some(next);
        let page = Page {
            total,
            total_exact: !fts_full,
            offset: q.offset,
            next_offset,
            truncation: next_offset.map(|_| "page_limit"),
        };
        Ok((page_hits, page))
    }

    /// Every symbol in one file, in source order (parents before members).
    pub fn outline(&self, rel: &str) -> Result<Vec<SymbolHit>, IndexError> {
        let rel = rel.trim_start_matches("./").to_string();
        self.with_reader(|c| {
            let query = |collate: &str| -> rusqlite::Result<Vec<SymbolHit>> {
                let mut stmt = c.prepare_cached(&format!(
                    "SELECT {HIT_COLUMNS} FROM symbols s JOIN files f ON f.id = s.file_id
                     WHERE f.rel = ?1{collate} ORDER BY s.start_byte, s.id"
                ))?;
                let rows = stmt.query_map([&rel], hit)?;
                rows.collect()
            };
            let hits = query("")?;
            if hits.is_empty() && CASE_BLIND_FS {
                return query(" COLLATE NOCASE");
            }
            Ok(hits)
        })
    }

    /// The source of one symbol, read from disk now. `name_or_qn` is a name,
    /// a qualified name, or `path#name` to pick the definition in one file.
    /// Longer than `max_lines`: its members instead (or the first
    /// `max_lines` lines when it has none).
    pub fn read_symbol(
        &self,
        name_or_qn: &str,
        max_lines: usize,
    ) -> Result<SymbolSource, IndexError> {
        self.read_symbol_within(name_or_qn, max_lines, None)
    }

    /// [`CodeIndex::read_symbol`] restricted to definitions inside `within`
    /// (root-relative directory); one outside it is never read.
    pub fn read_symbol_within(
        &self,
        name_or_qn: &str,
        max_lines: usize,
        within: Option<&str>,
    ) -> Result<SymbolSource, IndexError> {
        let (path, name) = match name_or_qn.split_once('#') {
            Some((p, n)) => (Some(p.trim_start_matches("./")), n.trim()),
            None => (None, name_or_qn.trim()),
        };
        // Filtered before the cap: a common name (`new`, `run`) can have more
        // definitions than the cap, and `path#name` exists to pick one of them.
        let keep = |h: &SymbolHit| {
            path.is_none_or(|p| h.rel == p || (CASE_BLIND_FS && h.rel.eq_ignore_ascii_case(p)))
                && is_within(&h.rel, within)
        };
        let mut found = self.with_reader(|c| exact(c, name, &keep))?;
        if found.is_empty() {
            let suggestions = self
                .find_symbol(&SymbolQuery {
                    query: name.to_string(),
                    within: within.map(str::to_string),
                    limit: 5,
                    ..SymbolQuery::default()
                })
                .map(|(hits, _)| {
                    hits.into_iter()
                        .map(|h| format!("{} ({}:{})", h.qualified_name, h.rel, h.start_line))
                        .collect()
                })
                .unwrap_or_default();
            return Err(IndexError::NotFound {
                query: name_or_qn.to_string(),
                suggestions,
            });
        }
        found.sort_by(|a, b| {
            kind_rank(&a.kind)
                .cmp(&kind_rank(&b.kind))
                .then(a.is_test.cmp(&b.is_test))
                .then(a.rel.cmp(&b.rel))
                .then(a.start_line.cmp(&b.start_line))
                .then(a.id.cmp(&b.id))
        });
        let symbol = found.remove(0);
        found.truncate(MAX_ALTERNATIVES);
        // Read the file the path resolves to now, and only inside the project and
        // `within`: a file swapped for a symlink since indexing is not followed out.
        let abs = dunce::canonicalize(self.root().join(&symbol.rel))?;
        let inside = abs
            .strip_prefix(self.root())
            .is_ok_and(|r| is_within(&crate::scan::rel_string(r), within));
        if !inside {
            return Err(IndexError::Invalid(format!(
                "{} now resolves outside the project",
                symbol.rel
            )));
        }
        let bytes = std::fs::read(&abs)?;
        let stale = self
            .with_reader(|c| {
                c.query_row(
                    "SELECT size, mtime_ns FROM files WHERE rel = ?1",
                    [&symbol.rel],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
                )
            })
            .map(|(size, mtime)| {
                let md = std::fs::metadata(&abs).ok();
                md.is_none_or(|m| {
                    i64::try_from(m.len()).ok() != Some(size) || crate::scan::mtime_ns(&m) != mtime
                })
            })
            .unwrap_or(true);
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text
            .lines()
            .skip(symbol.start_line.saturating_sub(1) as usize)
            .take((symbol.end_line + 1).saturating_sub(symbol.start_line) as usize)
            .collect();
        let max_lines = max_lines.max(1);
        let (source, truncated, members) = if lines.len() <= max_lines {
            (Some(lines.join("\n")), false, Vec::new())
        } else {
            let members = self.with_reader(|c| children(c, symbol.id))?;
            if members.is_empty() {
                (Some(lines[..max_lines].join("\n")), true, Vec::new())
            } else {
                (None, false, members)
            }
        };
        Ok(SymbolSource {
            symbol,
            source,
            truncated,
            members,
            alternatives: found,
            stale,
        })
    }

    /// Symbols for the @-mention picker: important, exported, non-test first.
    /// `impl` blocks are left out (the type itself is listed).
    pub fn picker_symbols(&self, limit: usize) -> Result<Vec<SymbolHit>, IndexError> {
        self.with_reader(|c| {
            let mut stmt = c.prepare_cached(&format!(
                "SELECT {HIT_COLUMNS} FROM symbols s JOIN files f ON f.id = s.file_id
                 WHERE s.kind != 'impl'
                 ORDER BY s.importance DESC, s.exported DESC, s.is_test ASC, f.rel ASC, s.start_line ASC, s.id ASC
                 LIMIT ?1"
            ))?;
            let rows = stmt.query_map([i64::try_from(limit).unwrap_or(i64::MAX)], hit)?;
            rows.collect()
        })
    }

    /// The index as a grep annotator: the smallest symbol enclosing a line.
    pub fn locator(&self) -> Arc<dyn SymbolLocator> {
        Arc::new(Locator(self.inner.clone()))
    }
}

/// FTS top candidates plus exact matches, each with its BM25 (lower is
/// better; exact-only rows get +inf). Returns whether the FTS stage was full.
fn candidates(
    c: &Connection,
    expr: &str,
    query: &str,
) -> rusqlite::Result<(Vec<(SymbolHit, f64)>, bool)> {
    let mut stmt = c.prepare_cached(&format!(
        "SELECT {HIT_COLUMNS}, m.r FROM
           (SELECT rowid AS id, bm25(symbols_fts, 8.0, 4.0, 1.0, 1.0) AS r FROM symbols_fts
            WHERE symbols_fts MATCH ?1 ORDER BY r LIMIT ?2) m
         JOIN symbols s ON s.id = m.id JOIN files f ON f.id = s.file_id"
    ))?;
    let mut out: Vec<(SymbolHit, f64)> = stmt
        .query_map(params![expr, FTS_CANDIDATES as i64], |r| {
            Ok((hit(r)?, r.get::<_, f64>(13)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let fts_full = out.len() >= FTS_CANDIDATES;
    let seen: HashSet<i64> = out.iter().map(|(h, _)| h.id).collect();
    let mut stmt = c.prepare_cached(&format!(
        "SELECT {HIT_COLUMNS} FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE (s.name = ?1 OR s.qualified_name = ?1 OR s.name = ?2) AND s.kind != 'impl'
         ORDER BY s.id LIMIT ?3"
    ))?;
    let exact = stmt
        .query_map(
            params![query, last_segment(query), EXACT_CANDIDATES as i64],
            hit,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    out.extend(
        exact
            .into_iter()
            .filter(|h| !seen.contains(&h.id))
            .map(|h| (h, f64::INFINITY)),
    );
    Ok((out, fts_full))
}

/// The first 50 definitions `keep` accepts whose qualified name, then name,
/// equals `name`.
fn exact(
    c: &Connection,
    name: &str,
    keep: &dyn Fn(&SymbolHit) -> bool,
) -> rusqlite::Result<Vec<SymbolHit>> {
    for col in ["qualified_name", "name"] {
        let mut stmt = c.prepare_cached(&format!(
            "SELECT {HIT_COLUMNS} FROM symbols s JOIN files f ON f.id = s.file_id
             WHERE s.{col} = ?1 ORDER BY s.id"
        ))?;
        let mut rows = Vec::new();
        for h in stmt.query_map([name], hit)? {
            let h = h?;
            if keep(&h) {
                rows.push(h);
                if rows.len() == 50 {
                    break;
                }
            }
        }
        if !rows.is_empty() {
            return Ok(rows);
        }
    }
    Ok(Vec::new())
}

fn children(c: &Connection, id: i64) -> rusqlite::Result<Vec<SymbolHit>> {
    let mut stmt = c.prepare_cached(&format!(
        "SELECT {HIT_COLUMNS} FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.parent_id = ?1 ORDER BY s.start_byte, s.id"
    ))?;
    let rows = stmt.query_map([id], hit)?;
    rows.collect()
}

struct Locator(Arc<Inner>);

impl SymbolLocator for Locator {
    fn enclosing(&self, rel_path: &str, line: u32) -> Option<EnclosingSymbol> {
        self.0
            .with_reader(|c| {
                let (id, mut sym) = c.query_row(
                    "SELECT s.id, s.qualified_name, s.kind, s.start_line, s.end_line
                     FROM symbols s JOIN files f ON f.id = s.file_id
                     WHERE f.rel = ?1 AND s.start_line <= ?2 AND s.end_line >= ?2
                     ORDER BY (s.end_line - s.start_line) ASC, s.start_line DESC, s.id ASC LIMIT 1",
                    params![rel_path, line],
                    |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            EnclosingSymbol {
                                qualified_name: r.get(1)?,
                                kind: r.get(2)?,
                                start_line: r.get(3)?,
                                end_line: r.get(4)?,
                                callers: 0,
                            },
                        ))
                    },
                )?;
                // A missing edges table or a failed count only loses the
                // annotation's caller count, never the annotation.
                sym.callers = crate::importance::caller_count(c, id).unwrap_or(0);
                Ok(sym)
            })
            .ok()
    }
}

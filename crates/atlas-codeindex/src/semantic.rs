//! Hybrid code search: reciprocal-rank fusion (k = 60) of BM25 over chunk
//! text, symbols named by identifiers in the query, dense vectors (when a
//! model is loaded), and a light importance prior; one result per symbol,
//! deterministic order.

use std::collections::{BTreeSet, HashMap, HashSet};

use atlas_retrieval::rrf::Fusion;
use atlas_search::compact::Page;
use rusqlite::{params, OptionalExtension};

use crate::store::split_words;
use crate::vectors::Embedder;
use crate::{CodeIndex, IndexError, SymbolQuery};

const DEPTH: usize = 100;
const PRIOR_WEIGHT: f64 = 0.5;
const PREVIEW_LINES: usize = 6;

#[derive(Debug, Clone, Default)]
pub struct SemanticQuery {
    pub query: String,
    pub path_glob: Option<String>,
    pub lang: Option<String>,
    pub limit: usize,
    pub offset: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChunkHit {
    pub chunk_id: i64,
    pub rel: String,
    pub start_line: u32,
    pub end_line: u32,
    pub header: String,
    pub preview: String,
    pub score: f64,
    /// Which rankings found it, e.g. "bm25+dense".
    pub legs: String,
}

struct Row {
    rel: String,
    lang: String,
    start: u32,
    end: u32,
    header: String,
    symbol: Option<i64>,
    importance: f64,
}

/// Identifier-shaped tokens of the query (`retry_with_backoff`, `CodeIndex::open`,
/// `loadSettings`), or the whole query when it is a single token. Plain words
/// never reach the symbol leg: on natural-language questions it only adds noise.
fn identifiers(query: &str) -> Vec<&str> {
    let tokens: Vec<&str> = query
        .split(|c: char| !(c.is_alphanumeric() || matches!(c, '_' | ':' | '.')))
        .map(|t| t.trim_matches(|c: char| matches!(c, ':' | '.')))
        .filter(|t| t.chars().any(char::is_alphanumeric))
        .collect();
    if tokens.len() == 1 {
        return tokens;
    }
    tokens
        .into_iter()
        .filter(|t| {
            t.contains('_')
                || t.contains("::")
                || t.contains('.')
                || t.chars()
                    .zip(t.chars().skip(1))
                    .any(|(a, b)| a.is_lowercase() && b.is_uppercase())
        })
        .collect()
}

impl CodeIndex {
    pub fn semantic_search(
        &self,
        q: &SemanticQuery,
        embedder: Option<&dyn Embedder>,
    ) -> Result<(Vec<ChunkHit>, Page), IndexError> {
        let mut words: Vec<String> = q
            .query
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .filter(|w| !w.is_empty())
            .flat_map(|w| std::iter::once(w.to_lowercase()).chain(split_words(w)))
            .filter(|w| w.len() > 1)
            .collect();
        words.sort();
        words.dedup();
        if words.is_empty() {
            return Err(IndexError::Invalid(
                "the query has no words to search for".into(),
            ));
        }
        let limit = if q.limit == 0 { 10 } else { q.limit.min(50) };
        // Leg 1: BM25 over chunk header + body.
        let fts = words
            .iter()
            .map(|w| format!("\"{}\"", w.replace('"', "")))
            .collect::<Vec<_>>()
            .join(" OR ");
        let bm25: Vec<i64> = self.with_reader(|c| {
            c.prepare_cached(&format!(
                "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?1 ORDER BY bm25(chunks_fts, 2.0, 1.0), rowid LIMIT {DEPTH}"
            ))?
            .query_map([&fts], |r| r.get(0))?
            .collect()
        })?;
        // Leg 2: symbols named by identifiers in the query, mapped to their chunks.
        let mut sym_ids: Vec<i64> = Vec::new();
        for ident in identifiers(&q.query) {
            let hits = self
                .find_symbol(&SymbolQuery {
                    query: ident.to_string(),
                    limit: 50,
                    ..Default::default()
                })
                .map(|(hits, _)| hits)
                .unwrap_or_default();
            for h in hits {
                if !sym_ids.contains(&h.id) {
                    sym_ids.push(h.id);
                }
            }
        }
        let by_symbol: Vec<i64> = self.with_reader(|c| {
            let mut stmt = c.prepare_cached(
                "SELECT id FROM chunks WHERE symbol_id = ?1 ORDER BY start_line, id LIMIT 1",
            )?;
            let mut out = Vec::new();
            for id in &sym_ids {
                if let Ok(cid) = stmt.query_row([id], |r| r.get::<_, i64>(0)) {
                    out.push(cid);
                }
            }
            Ok(out)
        })?;
        // Leg 3: dense, when a model and its vectors exist.
        let mut dense: Vec<i64> = Vec::new();
        if let Some(e) = embedder {
            let qv = e.embed_query(&q.query).map_err(IndexError::Invalid)?;
            let v = self.vectors_for(e.model_id(), e.dims())?;
            let keys = v
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .search(&qv, DEPTH);
            dense = self.with_reader(|c| {
                let mut stmt =
                    c.prepare_cached("SELECT id FROM chunks WHERE vkey = ?1 ORDER BY id")?;
                let mut out = Vec::new();
                for (k, _) in &keys {
                    out.extend(
                        stmt.query_map([k], |r| r.get::<_, i64>(0))?
                            .filter_map(Result::ok),
                    );
                }
                Ok(out)
            })?;
        }
        // Every candidate, then its row: a chunk a concurrent write removed
        // since its leg ran is left out rather than failing the search.
        let ids: BTreeSet<i64> = bm25
            .iter()
            .chain(&by_symbol)
            .chain(&dense)
            .copied()
            .collect();
        let rows: HashMap<i64, Row> = self.with_reader(|c| {
            let mut stmt = c.prepare_cached(
                "SELECT f.rel, f.lang, c.start_line, c.end_line, c.header, c.symbol_id, COALESCE(s.importance, 0)
                 FROM chunks c JOIN files f ON f.id = c.file_id LEFT JOIN symbols s ON s.id = c.symbol_id WHERE c.id = ?1",
            )?;
            let mut out = HashMap::new();
            for id in &ids {
                let r = stmt
                    .query_row(params![id], |r| {
                        Ok(Row {
                            rel: r.get(0)?,
                            lang: r.get(1)?,
                            start: r.get(2)?,
                            end: r.get(3)?,
                            header: r.get(4)?,
                            symbol: r.get(5)?,
                            importance: r.get(6)?,
                        })
                    })
                    .optional()?;
                if let Some(r) = r {
                    out.insert(*id, r);
                }
            }
            Ok(out)
        })?;
        let live = |leg: &[i64]| {
            leg.iter()
                .copied()
                .filter(|id| rows.contains_key(id))
                .collect::<Vec<_>>()
        };
        // Fuse: reciprocal ranks over the legs, then the importance prior,
        // which only boosts chunks some leg found.
        let mut fusion: Fusion<i64> = Fusion::new();
        fusion.leg("dense", 1.0, live(&dense));
        fusion.leg("bm25", 1.0, live(&bm25));
        fusion.leg("symbol", 1.0, live(&by_symbol));
        let mut by_importance: Vec<i64> = rows
            .iter()
            .filter(|(_, r)| r.importance > 0.0)
            .map(|(id, _)| *id)
            .collect();
        by_importance.sort_by(|a, b| {
            rows[b]
                .importance
                .total_cmp(&rows[a].importance)
                .then(a.cmp(b))
        });
        fusion.prior("importance", PRIOR_WEIGHT, by_importance);
        let fused = fusion.finish();
        let glob = match &q.path_glob {
            Some(g) => Some(
                globset::Glob::new(g)
                    .map_err(|e| IndexError::Invalid(format!("path_glob: {e}")))?
                    .compile_matcher(),
            ),
            None => None,
        };
        let legs_of: HashMap<i64, String> = fused
            .iter()
            .map(|f| {
                let mut names: Vec<&str> = f.legs.iter().map(|(name, _)| *name).collect();
                names.sort_unstable();
                (f.id, names.join("+"))
            })
            .collect();
        let mut ranked: Vec<(i64, f64)> = fused
            .iter()
            .filter(|f| {
                let r = &rows[&f.id];
                glob.as_ref().is_none_or(|g| g.is_match(&r.rel))
                    && q.lang.as_ref().is_none_or(|l| &r.lang == l)
            })
            .map(|f| (f.id, f.score))
            .collect();
        // Total order: score, then path, line and id.
        ranked.sort_by(|a, b| {
            b.1.total_cmp(&a.1)
                .then_with(|| rows[&a.0].rel.cmp(&rows[&b.0].rel))
                .then(rows[&a.0].start.cmp(&rows[&b.0].start))
                .then(a.0.cmp(&b.0))
        });
        // One result per symbol (or per chunk when it has none).
        let mut seen = HashSet::new();
        ranked.retain(|(id, _)| seen.insert(rows[id].symbol.map_or((1, *id), |s| (0, s))));
        let total = ranked.len();
        let mut files: HashMap<String, Vec<String>> = HashMap::new();
        let hits: Vec<ChunkHit> = ranked
            .into_iter()
            .skip(q.offset)
            .take(limit)
            .map(|(id, s)| {
                let r = &rows[&id];
                let lines = files.entry(r.rel.clone()).or_insert_with(|| {
                    std::fs::read_to_string(self.root().join(&r.rel))
                        .map(|t| t.lines().map(str::to_string).collect())
                        .unwrap_or_default()
                });
                let from = (r.start as usize).saturating_sub(1).min(lines.len());
                let to = (from + PREVIEW_LINES)
                    .min(r.end as usize)
                    .min(lines.len())
                    .max(from);
                let preview = lines[from..to]
                    .iter()
                    .map(|l| l.chars().take(160).collect::<String>())
                    .collect::<Vec<_>>()
                    .join("\n");
                let legs = legs_of.get(&id).cloned().unwrap_or_default();
                ChunkHit {
                    chunk_id: id,
                    rel: r.rel.clone(),
                    start_line: r.start,
                    end_line: r.end,
                    header: r.header.clone(),
                    preview,
                    score: s,
                    legs,
                }
            })
            .collect();
        let next = (q.offset + hits.len() < total).then_some(q.offset + hits.len());
        Ok((
            hits,
            Page {
                total,
                total_exact: true,
                offset: q.offset,
                next_offset: next,
                truncation: next.map(|_| "page_limit"),
            },
        ))
    }
}

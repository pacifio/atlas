//! File-level documents built from the index: the memory corpus's
//! `codebase` docs (until Phase 4 replaces them with chunks) and the
//! targets for optional Tier-2 LLM summaries.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::Connection;

use crate::{store, CodeIndex, IndexError};

const DOC_SYMBOLS: usize = 60;
const DOC_IMPORTS: usize = 30;
const ALIAS_SYMBOLS: usize = 40;

/// One indexed file, flattened for embedding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDoc {
    pub file_id: i64,
    pub rel: String,
    pub lang: String,
    pub mtime_ms: i64,
    /// (kind, name) in source order, `impl` blocks left out.
    pub symbols: Vec<(String, String)>,
    /// Distinct imported module paths in source order.
    pub imports: Vec<String>,
    /// Tier-2 summary, present only while the content hash matches.
    pub summary: String,
}

impl FileDoc {
    /// `File src/a.rs (rust). Defines: fn a, struct B. Imports: std::fmt.`
    pub fn structural_text(&self) -> String {
        let mut s = format!("File {} ({}).", self.rel, self.lang);
        if !self.symbols.is_empty() {
            let defs: Vec<String> = self
                .symbols
                .iter()
                .take(DOC_SYMBOLS)
                .map(|(k, n)| format!("{k} {n}"))
                .collect();
            s.push_str(" Defines: ");
            s.push_str(&defs.join(", "));
            s.push('.');
        }
        if !self.imports.is_empty() {
            let imps: Vec<&str> = self
                .imports
                .iter()
                .take(DOC_IMPORTS)
                .map(String::as_str)
                .collect();
            s.push_str(" Imports: ");
            s.push_str(&imps.join(", "));
            s.push('.');
        }
        s
    }

    /// The embeddable text: summary (when there is one) over the structure.
    pub fn text(&self) -> String {
        let structural = self.structural_text();
        if self.summary.trim().is_empty() {
            structural
        } else {
            format!("{}\n{structural}", self.summary.trim())
        }
    }

    /// File stem plus symbol names, for `[[wikilink]]` aliases.
    pub fn aliases(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(stem) = Path::new(&self.rel).file_stem().and_then(|s| s.to_str()) {
            out.push(stem.to_string());
        }
        out.extend(
            self.symbols
                .iter()
                .take(ALIAS_SYMBOLS)
                .map(|(_, n)| n.clone()),
        );
        out
    }
}

/// A file that has no summary for its current content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SummaryTarget {
    pub doc: FileDoc,
    pub content_hash: Vec<u8>,
}

/// The `limit` files with the most exported symbols (then by path), as docs
/// sorted by path.
fn file_docs(c: &Connection, limit: usize) -> rusqlite::Result<Vec<FileDoc>> {
    let mut stmt = c.prepare(
        "SELECT f.id, f.rel, f.lang, f.mtime_ns,
                COALESCE((SELECT s.summary FROM file_summaries s WHERE s.file_id = f.id AND s.content_hash = f.hash), '')
         FROM files f
         ORDER BY (SELECT count(*) FROM symbols x WHERE x.file_id = f.id AND x.exported = 1) DESC, f.rel ASC
         LIMIT ?1",
    )?;
    let mut docs: Vec<FileDoc> = stmt
        .query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |r| {
            Ok(FileDoc {
                file_id: r.get(0)?,
                rel: r.get(1)?,
                lang: r.get(2)?,
                mtime_ms: r.get::<_, i64>(3)? / 1_000_000,
                symbols: Vec::new(),
                imports: Vec::new(),
                summary: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    docs.sort_by(|a, b| a.rel.cmp(&b.rel));
    let index: HashMap<i64, usize> = docs
        .iter()
        .enumerate()
        .map(|(i, d)| (d.file_id, i))
        .collect();
    let mut syms = c.prepare(
        "SELECT file_id, kind, name FROM symbols WHERE kind != 'impl' ORDER BY file_id, start_byte, id",
    )?;
    let mut rows = syms.query([])?;
    while let Some(r) = rows.next()? {
        if let Some(&i) = index.get(&r.get::<_, i64>(0)?) {
            docs[i].symbols.push((r.get(1)?, r.get(2)?));
        }
    }
    let mut imps =
        c.prepare("SELECT file_id, module_path FROM imports ORDER BY file_id, line, rowid")?;
    let mut rows = imps.query([])?;
    while let Some(r) = rows.next()? {
        if let Some(&i) = index.get(&r.get::<_, i64>(0)?) {
            let m: String = r.get(1)?;
            if !docs[i].imports.contains(&m) {
                docs[i].imports.push(m);
            }
        }
    }
    Ok(docs)
}

/// File docs straight from `<root>/.atlas/code-index/index.db`, without
/// opening a [`CodeIndex`] (no writer, no schema changes). Empty when the
/// project has no index or one from another schema version.
pub fn read_file_docs(project_root: &Path, limit: usize) -> Result<Vec<FileDoc>, IndexError> {
    if !store::db_path(project_root).is_file() {
        return Ok(Vec::new());
    }
    let conn = store::open_reader(project_root)?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version != store::SCHEMA_VERSION {
        return Ok(Vec::new());
    }
    Ok(file_docs(&conn, limit)?)
}

impl CodeIndex {
    pub fn file_docs(&self, limit: usize) -> Result<Vec<FileDoc>, IndexError> {
        self.with_reader(|c| file_docs(c, limit))
    }

    /// Up to `limit` files lacking a summary for their current content, most
    /// exported symbols first.
    pub fn summary_targets(&self, limit: usize) -> Result<Vec<SummaryTarget>, IndexError> {
        self.with_reader(|c| {
            let mut stmt = c.prepare(
                "SELECT f.id, f.hash FROM files f
                 LEFT JOIN file_summaries s ON s.file_id = f.id AND s.content_hash = f.hash
                 WHERE s.file_id IS NULL
                 ORDER BY (SELECT count(*) FROM symbols x WHERE x.file_id = f.id AND x.exported = 1) DESC, f.rel ASC
                 LIMIT ?1",
            )?;
            let wanted: Vec<(i64, Vec<u8>)> = stmt
                .query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            let docs = file_docs(c, usize::MAX >> 1)?;
            let by_id: HashMap<i64, &FileDoc> = docs.iter().map(|d| (d.file_id, d)).collect();
            Ok(wanted
                .into_iter()
                .filter_map(|(id, hash)| by_id.get(&id).map(|d| SummaryTarget { doc: (*d).clone(), content_hash: hash }))
                .collect())
        })
    }

    /// Store a Tier-2 summary, unless the file changed since `content_hash`
    /// was read. Returns whether it was stored.
    pub fn put_summary(
        &self,
        file_id: i64,
        content_hash: &[u8],
        summary: &str,
    ) -> Result<bool, IndexError> {
        let mut conn = self.writer();
        let tx = conn.transaction()?;
        let n = store::put_summary_row(&tx, file_id, content_hash, summary)?;
        tx.commit()?;
        if n > 0 {
            self.bump();
        }
        Ok(n > 0)
    }
}

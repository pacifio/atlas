//! The SQLite file: location, pragmas, the schema and the row writers.
//!
//! The schema version lives in `PRAGMA user_version`. A known older version
//! is upgraded in place (v1 → v2 adds the graph, keeping Tier-2 summaries);
//! anything else is deleted and rebuilt: the index is a cache of the source
//! tree, so a rebuild loses nothing but time.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};

use crate::extract::{ImportRec, SymbolRec};
use crate::IndexError;

pub const SCHEMA_VERSION: i64 = 2;
/// Bump when extraction output changes; a mismatch forces a full build.
pub const EXTRACTOR_VERSION: &str = "2.0";

const SCHEMA_V1: &str = "
CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
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
";

pub(crate) fn index_dir(root: &Path) -> PathBuf {
    root.join(".atlas").join("code-index")
}

pub(crate) fn db_path(root: &Path) -> PathBuf {
    index_dir(root).join("index.db")
}

fn pragmas(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY;
         PRAGMA mmap_size=67108864; PRAGMA busy_timeout=5000;",
    )
}

/// Open the writer, creating or rebuilding the schema as needed.
pub(crate) fn open_writer(root: &Path) -> Result<Connection, IndexError> {
    std::fs::create_dir_all(index_dir(root))?;
    let path = db_path(root);
    let conn = Connection::open(&path)?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    // A fresh file (version 0, no tables), the current schema or a known
    // older one (upgraded below) is kept; anything else is another version's
    // cache and is deleted.
    let current = version == SCHEMA_VERSION
        || version == 1
        || (version == 0 && !table_exists(&conn, "files")?);
    let conn = if current {
        conn
    } else {
        drop(conn);
        for suffix in ["", "-wal", "-shm"] {
            let mut p = path.clone().into_os_string();
            p.push(suffix);
            match std::fs::remove_file(PathBuf::from(p)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        Connection::open(&path)?
    };
    conn.pragma_update(None, "journal_mode", "WAL")?;
    pragmas(&conn)?;
    if !table_exists(&conn, "files")? {
        conn.execute_batch(SCHEMA_V1)?;
        conn.pragma_update(None, "user_version", 1)?;
        crate::schema_v2::upgrade_to_v2(&conn, 0)?;
        set_meta(&conn, "schema", &SCHEMA_VERSION.to_string())?;
    } else if version == 1 {
        // A Phase 2 index: add the graph tables in place; every file
        // re-extracts on the next reconcile, and Tier-2 summaries are kept.
        crate::schema_v2::upgrade_to_v2(&conn, 1)?;
        set_meta(&conn, "schema", &SCHEMA_VERSION.to_string())?;
    }
    Ok(conn)
}

/// A query-only connection. Opened read-write without CREATE so a WAL
/// database whose `-shm` was cleaned up on exit still opens.
pub(crate) fn open_reader(root: &Path) -> Result<Connection, IndexError> {
    let conn = Connection::open_with_flags(
        db_path(root),
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    pragmas(&conn)?;
    conn.pragma_update(None, "query_only", true)?;
    Ok(conn)
}

fn table_exists(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
        [name],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
}

pub(crate) fn set_meta(conn: &Connection, k: &str, v: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO meta(k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        params![k, v],
    )
    .map(|_| ())
}

pub(crate) fn get_meta(conn: &Connection, k: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT v FROM meta WHERE k = ?1", [k], |r| r.get(0))
        .optional()
}

/// One file's extraction, ready to write.
#[derive(Debug)]
pub(crate) struct FileRecord {
    pub rel: String,
    pub lang: &'static str,
    pub size: u64,
    pub mtime_ns: i64,
    pub hash: [u8; 32],
    pub partial: bool,
    pub symbols: Vec<SymbolRec>,
    pub imports: Vec<ImportRec>,
    /// The graph half of the extraction, written by `GraphBatch` hooks.
    pub graph: crate::graph_extract::GraphExtract,
}

/// The stored identity of one file, for the stat → hash gate.
#[derive(Debug, Clone)]
pub(crate) struct FileRow {
    pub id: i64,
    pub size: u64,
    pub mtime_ns: i64,
    pub hash: Vec<u8>,
    pub indexed_at_ms: i64,
}

pub(crate) fn load_file_rows(conn: &Connection) -> rusqlite::Result<HashMap<String, FileRow>> {
    let mut stmt =
        conn.prepare("SELECT rel, id, size, mtime_ns, hash, indexed_at_ms FROM files")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            FileRow {
                id: r.get(1)?,
                size: r.get::<_, i64>(2)?.max(0).unsigned_abs(),
                mtime_ns: r.get(3)?,
                hash: r.get(4)?,
                indexed_at_ms: r.get(5)?,
            },
        ))
    })?;
    rows.collect()
}

/// Stored rows for just these paths (a watcher batch).
pub(crate) fn file_rows_for(
    conn: &Connection,
    rels: &[&str],
) -> rusqlite::Result<HashMap<String, FileRow>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, size, mtime_ns, hash, indexed_at_ms FROM files WHERE rel = ?1",
    )?;
    let mut out = HashMap::new();
    for rel in rels {
        let row = stmt
            .query_row([rel], |r| {
                Ok(FileRow {
                    id: r.get(0)?,
                    size: r.get::<_, i64>(1)?.max(0).unsigned_abs(),
                    mtime_ns: r.get(2)?,
                    hash: r.get(3)?,
                    indexed_at_ms: r.get(4)?,
                })
            })
            .optional()?;
        if let Some(row) = row {
            out.insert((*rel).to_string(), row);
        }
    }
    Ok(out)
}

pub(crate) fn file_id(conn: &Connection, rel: &str) -> rusqlite::Result<Option<i64>> {
    conn.query_row("SELECT id FROM files WHERE rel = ?1", [rel], |r| r.get(0))
        .optional()
}

/// Indexed paths strictly under directory `dir`.
pub(crate) fn rels_under(conn: &Connection, dir: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare_cached(
        "SELECT rel FROM files WHERE substr(rel, 1, length(?1) + 1) = ?1 || '/' ORDER BY rel",
    )?;
    let rows = stmt.query_map([dir], |r| r.get(0))?;
    rows.collect()
}

/// `updateCloudClient` → `updateCloudClient update cloud client`;
/// `HTTPServer` → `HTTPServer http server`. FTS5's unicode61 tokenizer already
/// splits on `_`, so snake_case needs nothing.
pub fn split_name(name: &str) -> String {
    let words = split_words(name);
    if words.len() <= 1 {
        return name.to_string();
    }
    format!("{name} {}", words.join(" "))
}

/// Lowercase word parts of an identifier or a free-text query.
pub(crate) fn split_words(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for run in s.split(|c: char| !c.is_alphanumeric()) {
        let chars: Vec<char> = run.chars().collect();
        let mut word = String::new();
        for (i, &c) in chars.iter().enumerate() {
            let prev = i.checked_sub(1).map(|j| chars[j]);
            let next = chars.get(i + 1).copied();
            let boundary = match prev {
                None => false,
                Some(p) => {
                    (c.is_uppercase() && (p.is_lowercase() || p.is_ascii_digit()))
                        || (c.is_uppercase()
                            && p.is_uppercase()
                            && next.is_some_and(char::is_lowercase))
                }
            };
            if boundary && !word.is_empty() {
                out.push(std::mem::take(&mut word).to_lowercase());
            }
            word.push(c);
        }
        if !word.is_empty() {
            out.push(word.to_lowercase());
        }
    }
    out
}

/// Replace one file's rows. The `files` row keeps its id (other rows point at
/// it); its symbols, FTS rows and imports are replaced; a summary survives
/// only while the content hash matches.
pub(crate) fn upsert_file(
    tx: &Transaction,
    rec: &FileRecord,
    existing: Option<i64>,
    now_ms: i64,
) -> rusqlite::Result<i64> {
    let file_id = match existing {
        Some(id) => {
            delete_file_contents(tx, id)?;
            tx.execute(
                "UPDATE files SET lang=?2, size=?3, mtime_ns=?4, hash=?5, parse_partial=?6, indexed_at_ms=?7 WHERE id=?1",
                params![id, rec.lang, size_i64(rec.size), rec.mtime_ns, &rec.hash[..], rec.partial, now_ms],
            )?;
            tx.execute(
                "DELETE FROM file_summaries WHERE file_id=?1 AND content_hash != ?2",
                params![id, &rec.hash[..]],
            )?;
            id
        }
        None => {
            tx.execute(
                "INSERT INTO files(rel, lang, size, mtime_ns, hash, parse_partial, indexed_at_ms) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![rec.rel, rec.lang, size_i64(rec.size), rec.mtime_ns, &rec.hash[..], rec.partial, now_ms],
            )?;
            tx.last_insert_rowid()
        }
    };
    let mut ids: Vec<i64> = Vec::with_capacity(rec.symbols.len());
    let mut ins = tx.prepare_cached(
        "INSERT INTO symbols(file_id, parent_id, kind, name, qualified_name, start_line, end_line,
           start_byte, end_byte, signature, doc, exported, is_test) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
    )?;
    let mut fts = tx.prepare_cached(
        "INSERT INTO symbols_fts(rowid, name_split, qualified_name, path, doc) VALUES (?1,?2,?3,?4,?5)",
    )?;
    for s in &rec.symbols {
        let parent = s.parent.and_then(|p| ids.get(p).copied());
        ins.execute(params![
            file_id,
            parent,
            s.kind,
            s.name,
            s.qualified_name,
            s.start_line,
            s.end_line,
            s.start_byte,
            s.end_byte,
            s.signature,
            s.doc,
            s.exported,
            s.is_test
        ])?;
        let id = tx.last_insert_rowid();
        ids.push(id);
        // impl blocks are structure for outlines, not search targets.
        if s.kind != "impl" {
            fts.execute(params![
                id,
                split_name(&s.name),
                s.qualified_name,
                rec.rel,
                s.doc
            ])?;
        }
    }
    let mut imp = tx.prepare_cached(
        "INSERT INTO imports(file_id, local_name, module_path, line) VALUES (?1,?2,?3,?4)",
    )?;
    for i in &rec.imports {
        imp.execute(params![file_id, i.local_name, i.module_path, i.line])?;
    }
    Ok(file_id)
}

/// Only the stat changed: record it so the next check is a stat compare.
pub(crate) fn touch_file(
    tx: &Transaction,
    id: i64,
    size: u64,
    mtime_ns: i64,
    now_ms: i64,
) -> rusqlite::Result<()> {
    tx.execute(
        "UPDATE files SET size=?2, mtime_ns=?3, indexed_at_ms=?4 WHERE id=?1",
        params![id, size_i64(size), mtime_ns, now_ms],
    )
    .map(|_| ())
}

fn delete_file_contents(tx: &Transaction, file_id: i64) -> rusqlite::Result<()> {
    tx.execute(
        "DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_id=?1)",
        [file_id],
    )?;
    tx.execute("DELETE FROM symbols WHERE file_id=?1", [file_id])?;
    tx.execute("DELETE FROM imports WHERE file_id=?1", [file_id])?;
    Ok(())
}

pub(crate) fn delete_file(tx: &Transaction, file_id: i64) -> rusqlite::Result<()> {
    delete_file_contents(tx, file_id)?;
    tx.execute("DELETE FROM files WHERE id=?1", [file_id])
        .map(|_| ())
}

/// Empty every table so a full build re-numbers rows from 1 in path order.
pub(crate) fn clear_all(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        "INSERT INTO symbols_fts(symbols_fts) VALUES('delete-all');
         DELETE FROM file_summaries; DELETE FROM imports; DELETE FROM symbols; DELETE FROM files;",
    )
}

/// rel → (content hash, summary), to carry summaries across a full build.
pub(crate) fn load_summaries(
    conn: &Connection,
) -> rusqlite::Result<HashMap<String, (Vec<u8>, String)>> {
    let mut stmt = conn.prepare(
        "SELECT f.rel, s.content_hash, s.summary FROM file_summaries s JOIN files f ON f.id = s.file_id",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?;
    rows.collect()
}

pub(crate) fn put_summary_row(
    tx: &Transaction,
    file_id: i64,
    hash: &[u8],
    summary: &str,
) -> rusqlite::Result<usize> {
    tx.execute(
        "INSERT INTO file_summaries(file_id, content_hash, summary)
           SELECT id, hash, ?3 FROM files WHERE id = ?1 AND hash = ?2
         ON CONFLICT(file_id) DO UPDATE SET content_hash = excluded.content_hash, summary = excluded.summary",
        params![file_id, hash, summary],
    )
}

fn size_i64(size: u64) -> i64 {
    i64::try_from(size).unwrap_or(i64::MAX)
}

/// Keep `.atlas/` out of git without touching the user's `.gitignore`:
/// append it to `info/exclude` once. Returns whether a line was added.
pub(crate) fn ensure_git_exclude(root: &Path) -> std::io::Result<bool> {
    let Some(git_dir) = crate::skip::git_common_dir(root) else {
        return Ok(false);
    };
    let info = git_dir.join("info");
    let path = info.join("exclude");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    if existing
        .lines()
        .any(|l| matches!(l.trim(), ".atlas/" | "/.atlas/" | ".atlas" | "/.atlas"))
    {
        return Ok(false);
    }
    std::fs::create_dir_all(&info)?;
    let mut text = existing;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str("# Atlas per-project data (code index, memory)\n.atlas/\n");
    std::fs::write(&path, text)?;
    Ok(true)
}

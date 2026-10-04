//! Schema v3 (Phase 4): chunks for hybrid search, the embedding cache and the
//! per-model vector membership table. Applied on top of v2.

use rusqlite::Connection;

pub const SCHEMA_V3: i64 = 3;

const V3_DDL: &str = "
CREATE TABLE IF NOT EXISTS chunks(
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
  content_hash BLOB NOT NULL, vkey INTEGER NOT NULL, header TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file_id);
CREATE INDEX IF NOT EXISTS chunks_vkey ON chunks(vkey);
CREATE INDEX IF NOT EXISTS chunks_symbol ON chunks(symbol_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(header, body,
  content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS embed_cache(key BLOB PRIMARY KEY, dims INTEGER NOT NULL, vec BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS chunk_vectors(model_id TEXT NOT NULL, vkey INTEGER NOT NULL, PRIMARY KEY(model_id, vkey));
";

/// `from` 2 = an existing index: force re-extraction (chunks need trees), keep summaries.
pub fn upgrade_to_v3(conn: &Connection, from: i64) -> rusqlite::Result<bool> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(V3_DDL)?;
    let reextract = from == 2;
    if reextract {
        tx.execute("UPDATE files SET mtime_ns = -1, hash = x''", [])?;
    }
    tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_V3};"))?;
    tx.commit()?;
    Ok(reextract)
}

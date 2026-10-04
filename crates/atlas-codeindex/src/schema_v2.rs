//! Schema v2 (Phase 3): references, resolved edges, Rust `mod` declarations, per-file module
//! paths and the import details resolution needs. Applied on top of Phase 2's v1 schema.

use rusqlite::Connection;

pub const SCHEMA_V2: i64 = 2;

const V2_DDL: &str = "
CREATE TABLE IF NOT EXISTS refs(
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  src_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, name TEXT NOT NULL, receiver TEXT NOT NULL DEFAULT '',
  line INTEGER NOT NULL, start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS refs_name ON refs(name);
CREATE INDEX IF NOT EXISTS refs_file ON refs(file_id);
CREATE INDEX IF NOT EXISTS refs_src ON refs(src_symbol_id);
CREATE TABLE IF NOT EXISTS edges(
  src_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  dst_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  ref_id INTEGER NOT NULL REFERENCES refs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, confidence REAL NOT NULL, strategy TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst_symbol_id, kind);
CREATE INDEX IF NOT EXISTS edges_src ON edges(src_symbol_id, kind);
CREATE INDEX IF NOT EXISTS edges_ref ON edges(ref_id);
CREATE TABLE IF NOT EXISTS rust_mods(
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL, path_attr TEXT, inline_parent TEXT NOT NULL DEFAULT '', line INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS rust_mods_file ON rust_mods(file_id);
CREATE INDEX IF NOT EXISTS imports_resolved ON imports(resolved_file_id);
";

/// Bring a database at `from` (0 = freshly created v1 tables, 1 = an existing Phase 2 index)
/// to v2. Idempotent. Returns `true` when every file must be re-extracted: a migrated v1
/// index has symbols but no refs.
pub fn upgrade_to_v2(conn: &Connection, from: i64) -> rusqlite::Result<bool> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(V2_DDL)?;
    add_column(&tx, "files", "module", "TEXT NOT NULL DEFAULT ''")?;
    add_column(&tx, "imports", "imported_name", "TEXT NOT NULL DEFAULT ''")?;
    add_column(&tx, "imports", "is_pub", "INTEGER NOT NULL DEFAULT 0")?;
    let reextract = from == 1;
    if reextract {
        // Neither stat nor hash can match now, so the next reconcile re-extracts every file.
        tx.execute("UPDATE files SET mtime_ns = -1, hash = x''", [])?;
    }
    tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_V2};"))?;
    tx.commit()?;
    Ok(reextract)
}

fn add_column(conn: &Connection, table: &str, col: &str, decl: &str) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(&format!(
        "SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1"
    ))?;
    if !stmt.exists([col])? {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {col} {decl};"))?;
    }
    Ok(())
}

//! The SQLite layer: list, upsert, delete. Nothing else.
//!
//! Ported from Zed's `ThreadMetadataDb` (`thread_metadata_store.rs:1468-1581`).
//! Every statement here is one of those three, because the store keeps the
//! whole table in memory and answers reads from there — the database is the
//! durable copy, not the query engine.

use std::path::Path;
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use chrono::{DateTime, Utc};
use rusqlite::Connection;

use crate::error::{Error, Result};
use crate::model::{ThreadId, ThreadMetadata};
use crate::paths::{PathList, SerializedPathList, WorktreePaths};
use crate::schema;

const LIST_QUERY: &str = "SELECT thread_id, session_id, agent_id, title, title_override, \
     updated_at, created_at, interacted_at, folder_paths, folder_paths_order, \
     main_worktree_paths, main_worktree_paths_order, remote_connection, archived \
     FROM threads \
     ORDER BY updated_at DESC";

const UPSERT: &str = "INSERT INTO threads(thread_id, session_id, agent_id, title, \
         title_override, updated_at, created_at, interacted_at, folder_paths, \
         folder_paths_order, main_worktree_paths, main_worktree_paths_order, \
         remote_connection, archived) \
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14) \
     ON CONFLICT(thread_id) DO UPDATE SET \
         session_id = excluded.session_id, \
         agent_id = excluded.agent_id, \
         title = excluded.title, \
         title_override = excluded.title_override, \
         updated_at = excluded.updated_at, \
         created_at = excluded.created_at, \
         interacted_at = excluded.interacted_at, \
         folder_paths = excluded.folder_paths, \
         folder_paths_order = excluded.folder_paths_order, \
         main_worktree_paths = excluded.main_worktree_paths, \
         main_worktree_paths_order = excluded.main_worktree_paths_order, \
         remote_connection = excluded.remote_connection, \
         archived = excluded.archived";

/// The durable half of the store.
pub(crate) struct Db {
    conn: Connection,
}

impl Db {
    /// Open (creating if needed) the database at `db_path`, and migrate it.
    pub(crate) fn open(db_path: &Path) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| Error::Storage(format!("{}: {e}", parent.display())))?;
        }
        let conn = Connection::open(db_path)
            .map_err(|e| Error::Storage(format!("{}: {e}", db_path.display())))?;
        // WAL so a read never blocks the write queue and vice versa; NORMAL
        // because a lost final upsert costs a stale sidebar row, not a record.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        schema::migrate(&conn)?;
        let db = Self { conn };
        db.prune_drafts()?;
        Ok(db)
    }

    /// Every row, newest first.
    pub(crate) fn list(&self) -> Result<Vec<ThreadMetadata>> {
        let mut stmt = self.conn.prepare(LIST_QUERY)?;
        let rows = stmt.query_map([], decode)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub(crate) fn save(&self, row: &ThreadMetadata) -> Result<()> {
        let folders = optional(row.folder_paths());
        let mains = optional(row.main_worktree_paths());
        let remote = row
            .remote_connection
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| Error::Storage(format!("serialize remote_connection: {e}")))?;

        self.conn.execute(
            UPSERT,
            rusqlite::params![
                row.thread_id.as_uuid().as_bytes().as_slice(),
                row.session_id.as_ref().map(|s| s.0.to_string()),
                row.agent_id.as_str(),
                row.title.as_deref().unwrap_or_default(),
                row.title_override.as_deref(),
                row.updated_at.to_rfc3339(),
                row.created_at.map(|dt| dt.to_rfc3339()),
                row.interacted_at.map(|dt| dt.to_rfc3339()),
                folders.as_ref().map(|s| &s.paths),
                folders.as_ref().map(|s| &s.order),
                mains.as_ref().map(|s| &s.paths),
                mains.as_ref().map(|s| &s.order),
                remote,
                row.archived,
            ],
        )?;
        Ok(())
    }

    /// Drop every row that never got a session id.
    ///
    /// A draft row is only reachable through the in-memory binding its process
    /// held: with no session id there is nothing to re-find it by, so one left
    /// behind by a crash is an empty row the user can never open and never
    /// clear. Zed prunes session-less rows in a migration for the same reason
    /// (`thread_metadata_store.rs:1446-1458`); Atlas does it on every open,
    /// because Atlas mints a fresh session per chat tab and so produces them
    /// routinely rather than once.
    fn prune_drafts(&self) -> Result<()> {
        self.conn
            .execute("DELETE FROM threads WHERE session_id IS NULL", [])?;
        Ok(())
    }

    pub(crate) fn delete(&self, thread_id: ThreadId) -> Result<()> {
        self.conn.execute(
            "DELETE FROM threads WHERE thread_id = ?1",
            rusqlite::params![thread_id.as_uuid().as_bytes().as_slice()],
        )?;
        Ok(())
    }

}

/// An empty path list is stored as `NULL`, not as two empty strings — Zed's
/// shape (`:1512-1524`), and the difference matters because `NULL` is what a
/// row written before the column existed also reads as.
fn optional(list: &PathList) -> Option<SerializedPathList> {
    if list.is_empty() {
        None
    } else {
        Some(list.serialize())
    }
}

fn decode(row: &rusqlite::Row<'_>) -> rusqlite::Result<ThreadMetadata> {
    let thread_id: Vec<u8> = row.get(0)?;
    let thread_id = uuid::Uuid::from_slice(&thread_id)
        .map(ThreadId::from_uuid)
        .map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Blob, Box::new(e))
        })?;

    let session_id: Option<String> = row.get(1)?;
    let agent_id: String = row.get(2)?;
    let title: String = row.get(3)?;
    let title_override: Option<String> = row.get(4)?;
    let updated_at: String = row.get(5)?;
    let created_at: Option<String> = row.get(6)?;
    let interacted_at: Option<String> = row.get(7)?;
    let folder_paths: Option<String> = row.get(8)?;
    let folder_paths_order: Option<String> = row.get(9)?;
    let main_paths: Option<String> = row.get(10)?;
    let main_paths_order: Option<String> = row.get(11)?;
    let remote_connection: Option<String> = row.get(12)?;
    let archived: bool = row.get(13)?;

    let folder_paths = path_list(serialized(folder_paths, folder_paths_order));
    let main_paths = path_list(serialized(main_paths, main_paths_order));
    // A row written before `main_worktree_paths` existed — or by a build that
    // never set it — has folder paths only. Zed's fallback (`:1745-1760`).
    let worktree_paths = if main_paths.is_empty() {
        WorktreePaths::from_folder_paths(&folder_paths)
    } else {
        WorktreePaths::from_path_lists(main_paths, folder_paths.clone())
            .unwrap_or_else(|_| WorktreePaths::from_folder_paths(&folder_paths))
    };

    Ok(ThreadMetadata {
        thread_id,
        session_id: session_id.map(acp::SessionId::new),
        agent_id: agent_id.into(),
        // `''` is how "no title" is stored, and a persisted default title is
        // not a title either — it is what the row already renders as when it
        // has none (Zed's decode, `:1776`, `:1782`).
        title: name(Some(title)),
        title_override: name(title_override),
        updated_at: timestamp(Some(updated_at)).unwrap_or_else(Utc::now),
        created_at: timestamp(created_at),
        interacted_at: timestamp(interacted_at),
        worktree_paths,
        remote_connection: remote_connection.and_then(|s| serde_json::from_str(&s).ok()),
        archived,
    })
}

/// The two columns a path list occupies, or `None` when it was stored empty.
fn serialized(paths: Option<String>, order: Option<String>) -> Option<SerializedPathList> {
    paths.map(|paths| SerializedPathList {
        paths,
        order: order.unwrap_or_default(),
    })
}

fn path_list(serialized: Option<SerializedPathList>) -> PathList {
    serialized
        .as_ref()
        .map(PathList::deserialize)
        .unwrap_or_default()
}

/// A stored name, or `None` when it carries no information.
fn name(value: Option<String>) -> Option<Arc<str>> {
    value
        .filter(|t| !t.trim().is_empty() && t != crate::model::DEFAULT_THREAD_TITLE)
        .map(|t| Arc::from(t.as_str()))
}

fn timestamp(value: Option<String>) -> Option<DateTime<Utc>> {
    value
        .as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&Utc))
}

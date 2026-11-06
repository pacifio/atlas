//! The SQLite layer: list, upsert, delete. Nothing else.
//!
//! Every thread statement here is one of those three, because the store keeps the
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

/// `archived` is not read: archiving was retired, and the column is left in the
/// table only so older builds at this epoch can still write (see `schema`).
const LIST_QUERY: &str = "SELECT thread_id, session_id, agent_id, title, title_override, \
     updated_at, created_at, interacted_at, folder_paths, folder_paths_order, \
     main_worktree_paths, main_worktree_paths_order, remote_connection, \
     branch, settled_at, unsettled_at, pinned_at, pin_order, snoozed_until, snoozed_at, \
     last_snooze_wake_at, last_viewed_at, last_turn_completed_at, model, \
     attached_projects, pull_requests, unpinned_at \
     FROM threads \
     ORDER BY updated_at DESC";

/// `archived` is never named, so a new row takes its default (`0`) and an
/// existing one keeps whatever an older build wrote.
const UPSERT: &str = "INSERT INTO threads(thread_id, session_id, agent_id, title, \
         title_override, updated_at, created_at, interacted_at, folder_paths, \
         folder_paths_order, main_worktree_paths, main_worktree_paths_order, \
         remote_connection, branch, settled_at, unsettled_at, pinned_at, pin_order, \
         snoozed_until, snoozed_at, last_snooze_wake_at, last_viewed_at, \
         last_turn_completed_at, model, attached_projects, pull_requests, unpinned_at) \
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, \
         ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27) \
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
         branch = excluded.branch, \
         settled_at = excluded.settled_at, \
         unsettled_at = excluded.unsettled_at, \
         pinned_at = excluded.pinned_at, \
         pin_order = excluded.pin_order, \
         snoozed_until = excluded.snoozed_until, \
         snoozed_at = excluded.snoozed_at, \
         last_snooze_wake_at = excluded.last_snooze_wake_at, \
         last_viewed_at = excluded.last_viewed_at, \
         last_turn_completed_at = excluded.last_turn_completed_at, \
         model = excluded.model, \
         attached_projects = excluded.attached_projects, \
         pull_requests = excluded.pull_requests, \
         unpinned_at = excluded.unpinned_at";

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
        if schema::needs_migration(&conn)? {
            backup_before_migrating(&conn, db_path)?;
        }
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
                row.branch.as_deref(),
                rfc3339(row.settled_at),
                rfc3339(row.unsettled_at),
                rfc3339(row.pinned_at),
                row.pin_order.as_deref(),
                rfc3339(row.snoozed_until),
                rfc3339(row.snoozed_at),
                rfc3339(row.last_snooze_wake_at),
                rfc3339(row.last_viewed_at),
                rfc3339(row.last_turn_completed_at),
                row.model.as_deref(),
                crate::projects::encode(&row.attached_projects),
                crate::pull_requests::encode(&row.pull_requests),
                rfc3339(row.unpinned_at),
            ],
        )?;
        Ok(())
    }

    /// Drop every row that never got a session id.
    ///
    /// A draft row is only reachable through the in-memory binding its process
    /// held: with no session id there is nothing to re-find it by, so one left
    /// behind by a crash is an empty row the user can never open and never
    /// clear. Pruning them once in a migration would not be enough: this runs on every
    /// open, because Atlas mints a fresh session per chat tab and so produces them
    /// routinely rather than once.
    fn prune_drafts(&self) -> Result<()> {
        self.conn
            .execute("DELETE FROM threads WHERE session_id IS NULL", [])?;
        Ok(())
    }

    /// Which agents the first-run backfill has already run for.
    pub(crate) fn backfilled_agents(&self) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT agent_id FROM backfilled_agents")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub(crate) fn mark_backfilled(&self, agent_id: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO backfilled_agents(agent_id, at) VALUES (?1, ?2) \
             ON CONFLICT(agent_id) DO NOTHING",
            rusqlite::params![agent_id, chrono::Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// Session ids whose rows the user deleted (schema V4).
    pub(crate) fn deleted_sessions(&self) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT session_id FROM deleted_sessions")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub(crate) fn mark_session_deleted(&self, session_id: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO deleted_sessions(session_id, at) VALUES (?1, ?2) \
             ON CONFLICT(session_id) DO NOTHING",
            rusqlite::params![session_id, chrono::Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub(crate) fn unmark_session_deleted(&self, session_id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM deleted_sessions WHERE session_id = ?1",
            rusqlite::params![session_id],
        )?;
        Ok(())
    }

    /// Confirmed transcript aliases, `(alias, owner)` (schema V5).
    pub(crate) fn session_aliases(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT alias_id, owner_session_id FROM session_aliases")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub(crate) fn save_session_alias(&self, alias: &str, owner: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO session_aliases(alias_id, owner_session_id, at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(alias_id) DO UPDATE SET owner_session_id = excluded.owner_session_id",
            rusqlite::params![alias, owner, chrono::Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub(crate) fn delete_session_alias(&self, alias: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM session_aliases WHERE alias_id = ?1",
            rusqlite::params![alias],
        )?;
        Ok(())
    }

    /// Recorded forks, `(child, parent)` session ids.
    pub(crate) fn session_forks(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT child_session_id, parent_session_id FROM session_forks")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub(crate) fn save_session_fork(&self, child: &str, parent: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO session_forks(child_session_id, parent_session_id, at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(child_session_id) DO UPDATE SET parent_session_id = excluded.parent_session_id",
            rusqlite::params![child, parent, chrono::Utc::now().to_rfc3339()],
        )?;
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

/// An empty path list is stored as `NULL`, not as two empty strings — and the difference matters because `NULL` is what a
/// row written before the column existed also reads as.
fn optional(list: &PathList) -> Option<SerializedPathList> {
    if list.is_empty() {
        None
    } else {
        Some(list.serialize())
    }
}

/// Copy the database aside before a migration changes it, so no build is
/// ever the only holder of a user's history.
///
/// `VACUUM INTO` rather than a file copy: the database runs in WAL mode, and
/// copying `threads.db` alone would miss whatever sits in the `-wal` file. One
/// copy per starting version (`threads.db.bak-v5`): the first one is the
/// state before anything touched it, and a later open from the same version
/// keeps it rather than overwriting it. Failing to take the copy fails the
/// open — the error reaches the sidebar — rather than migrating without one.
fn backup_before_migrating(conn: &Connection, db_path: &Path) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let mut name = db_path.as_os_str().to_owned();
    name.push(format!(".bak-v{version}"));
    let backup = std::path::PathBuf::from(name);
    if backup.exists() {
        return Ok(());
    }
    match conn.execute("VACUUM INTO ?1", [backup.to_string_lossy()]) {
        Ok(_) => Ok(()),
        // A second connection racing the same open got there first.
        Err(_) if backup.exists() => Ok(()),
        Err(e) => Err(Error::Storage(format!(
            "could not back up {} before migrating it: {e}",
            db_path.display()
        ))),
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
    let branch: Option<String> = row.get(13)?;
    let time = |index: usize| -> rusqlite::Result<Option<DateTime<Utc>>> {
        Ok(timestamp(row.get::<_, Option<String>>(index)?))
    };
    let pin_order: Option<String> = row.get(17)?;
    let model: Option<String> = row.get(23)?;

    let folder_paths = path_list(serialized(folder_paths, folder_paths_order));
    let main_paths = path_list(serialized(main_paths, main_paths_order));
    // A row written before `main_worktree_paths` existed — or by a build that
    // never set it — has folder paths only.
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
        // has none.
        title: name(Some(title)),
        title_override: name(title_override),
        updated_at: timestamp(Some(updated_at)).unwrap_or_else(Utc::now),
        created_at: timestamp(created_at),
        interacted_at: timestamp(interacted_at),
        worktree_paths,
        remote_connection: remote_connection.and_then(|s| serde_json::from_str(&s).ok()),
        branch: branch
            .filter(|b| !b.trim().is_empty())
            .map(|b| Arc::from(b.as_str())),
        settled_at: time(14)?,
        unsettled_at: time(15)?,
        pinned_at: time(16)?,
        pin_order: pin_order
            .filter(|key| !key.is_empty())
            .map(|key| Arc::from(key.as_str())),
        unpinned_at: time(26)?,
        snoozed_until: time(18)?,
        snoozed_at: time(19)?,
        last_snooze_wake_at: time(20)?,
        last_viewed_at: time(21)?,
        last_turn_completed_at: time(22)?,
        model: model
            .filter(|m| !m.trim().is_empty())
            .map(|m| Arc::from(m.as_str())),
        attached_projects: crate::projects::decode(row.get(24)?),
        pull_requests: crate::pull_requests::decode(row.get(25)?),
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

fn rfc3339(value: Option<DateTime<Utc>>) -> Option<String> {
    value.map(|dt| dt.to_rfc3339())
}

fn timestamp(value: Option<String>) -> Option<DateTime<Utc>> {
    value
        .as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&Utc))
}

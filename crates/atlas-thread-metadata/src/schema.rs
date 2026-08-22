//! Schema and migrations.
//!
//! The versioning policy is atlas-checkpoint's, deliberately: an integer in
//! `user_version`, forward-only migrations, and a hard refusal to open a
//! database written by a newer build.
//!
//! Zed's table arrived through eight migrations
//! (`thread_metadata_store.rs:1373-1465`) because it re-keyed a shipped table
//! from `session_id` to `thread_id` and grew columns over releases. Atlas has
//! no shipped predecessor, so V1 below *is* Zed's end state — the same columns,
//! the same nullability, in one `CREATE TABLE`. Two of Zed's migrations are
//! deliberately absent: the `archived_git_worktrees` side tables (out of scope
//! per the spec — they serve a worktree lifecycle Atlas does not have), and the
//! session-less-row prune, which Atlas does on every open instead (see
//! `Db::prune_drafts`).
//!
//! V2 adds `backfilled_agents`, which Zed has no equivalent of: the one-time
//! import pass is Atlas's own (spec #15) and needs somewhere durable to
//! remember it already ran.

use rusqlite::Connection;

use crate::error::{Error, Result};

/// Bump when adding a migration, and add the matching arm in [`migrate`].
pub const SCHEMA_VERSION: i64 = 2;

pub fn migrate(conn: &Connection) -> Result<()> {
    // Fast path, outside any transaction: the common case is a database
    // already at the current version.
    let found: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if found > SCHEMA_VERSION {
        return Err(Error::SchemaTooNew {
            found,
            supported: SCHEMA_VERSION,
        });
    }
    if found == SCHEMA_VERSION {
        return Ok(());
    }

    // One IMMEDIATE transaction, with the version re-read inside it: two
    // connections racing an open both arrive here believing the database is
    // behind, and without the lock the loser fails on a duplicate column.
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> Result<()> {
        let found: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if found >= SCHEMA_VERSION {
            return Ok(());
        }
        if found < 1 {
            conn.execute_batch(V1)?;
        }
        if found < 2 {
            conn.execute_batch(V2)?;
        }
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT")?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// The whole store.
///
/// `title` is `NOT NULL` with `''` standing for "no title" — Zed's shape
/// (`:1376`). Every other absent value is a real SQL `NULL`.
///
/// The table is `threads`, not Zed's `sidebar_threads`: the sidebar is one of
/// three surfaces that read it, and CONTEXT.md's noun for the thing is a
/// Thread.
const V1: &str = "
CREATE TABLE IF NOT EXISTS threads(
    thread_id                 BLOB PRIMARY KEY,
    session_id                TEXT,
    agent_id                  TEXT NOT NULL,
    title                     TEXT NOT NULL DEFAULT '',
    title_override            TEXT,
    updated_at                TEXT NOT NULL,
    created_at                TEXT,
    interacted_at             TEXT,
    folder_paths              TEXT,
    folder_paths_order        TEXT,
    main_worktree_paths       TEXT,
    main_worktree_paths_order TEXT,
    remote_connection         TEXT,
    archived                  INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX IF NOT EXISTS idx_threads_updated_at
    ON threads(updated_at DESC);
";

/// Which agents the one-time first-run backfill has already run for.
///
/// In the store rather than in a settings file so it is written in the same
/// transaction-scoped place as the rows it produced: a backfill that inserted
/// rows and then failed to record itself would run again and (thanks to the
/// session-id dedup) do nothing — but a marker written where the rows are not
/// could claim a backfill that never happened.
const V2: &str = "
CREATE TABLE IF NOT EXISTS backfilled_agents(
    agent_id TEXT PRIMARY KEY,
    at       TEXT NOT NULL
) STRICT;
";

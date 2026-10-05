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
//!
//! V3 is a data step, not a shape change: the native agent's stored id was
//! renamed (ADR-0011) and, by decision, rows under the retired id are dropped
//! rather than aliased. Nothing resolves them any more, so leaving them would
//! only put unopenable rows in the sidebar.

use rusqlite::Connection;

use crate::error::{Error, Result};

/// Bump when adding a migration, and add the matching arm in [`migrate`].
pub const SCHEMA_VERSION: i64 = 4;

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
        if found < 3 {
            conn.execute_batch(V3)?;
        }
        if found < 4 {
            conn.execute_batch(V4)?;
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

/// Drop the rows recorded under the native agent's retired id.
///
/// The id is the literal it used to be, spelled out here and nowhere else in
/// the tree: this is the one place that still needs to know it, and the guard
/// test that keeps the old names out of the code allowlists exactly this
/// file for it. The backfill marker goes with the rows, so a backfill under
/// the new id is free to run.
const V3: &str = "
DELETE FROM threads WHERE agent_id = 'cersei';
DELETE FROM backfilled_agents WHERE agent_id = 'cersei';
";

/// A thread shared as a Shared Thread (ATL-395): its id on the server, the
/// Base commit, and this person's role. Three nullable columns rather than a
/// JSON blob, because the app looks threads up by `shared_thread_id`.
const V4: &str = "
ALTER TABLE threads ADD COLUMN shared_thread_id TEXT;
ALTER TABLE threads ADD COLUMN shared_base TEXT;
ALTER TABLE threads ADD COLUMN shared_role TEXT;
";

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Barrier};

    use atlas_acp_thread::connection::AgentId;

    use super::*;
    use crate::paths::PathList;
    use crate::store::ThreadMetadataStore;

    fn version_of(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap()
    }

    fn has_table(conn: &Connection, table: &str) -> bool {
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
            > 0
    }

    const SENT: [u8; 16] = [1; 16];
    const ARCHIVED: [u8; 16] = [2; 16];
    const DRAFT: [u8; 16] = [3; 16];

    /// A database exactly as a V1 build left it, with three rows: a sent
    /// thread carrying every optional column, an archived one carrying none,
    /// and a draft (no session id).
    fn seed_v1(db_path: &Path) {
        let conn = Connection::open(db_path).unwrap();
        conn.execute_batch(V1).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        let folders =
            PathList::new(&[PathBuf::from("/work/b"), PathBuf::from("/work/a")]).serialize();
        conn.execute(
            "INSERT INTO threads (thread_id, session_id, agent_id, title, title_override, \
                 updated_at, created_at, interacted_at, folder_paths, folder_paths_order, archived) \
             VALUES (?1, 'sess-1', 'atlas-agent', 'Fix the build', 'My rename', \
                 '2026-05-02T00:00:00+00:00', '2026-05-01T00:00:00+00:00', \
                 '2026-05-02T00:00:00+00:00', ?2, ?3, 0)",
            rusqlite::params![SENT.as_slice(), folders.paths, folders.order],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO threads (thread_id, session_id, agent_id, updated_at, archived) \
             VALUES (?1, 'sess-2', 'claude-code', '2026-05-01T00:00:00+00:00', 1)",
            [ARCHIVED.as_slice()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO threads (thread_id, agent_id, updated_at) \
             VALUES (?1, 'atlas-agent', '2026-05-03T00:00:00+00:00')",
            [DRAFT.as_slice()],
        )
        .unwrap();
    }

    #[test]
    fn a_v1_database_gains_the_backfill_table_and_keeps_every_row() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("threads.db");
        seed_v1(&path);

        let conn = Connection::open(&path).unwrap();
        migrate(&conn).unwrap();
        assert_eq!(version_of(&conn), SCHEMA_VERSION);
        assert!(has_table(&conn, "backfilled_agents"));
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM threads", [], |r| r.get(0))
            .unwrap();
        // The migration itself drops nothing; pruning drafts is the store's
        // job on open, not the schema's.
        assert_eq!(rows, 3);

        // Current, so a second run is the fast path.
        migrate(&conn).unwrap();
        assert_eq!(version_of(&conn), SCHEMA_VERSION);
    }

    /// The same upgrade through the public store, which is what the app runs
    /// at launch: the V1 rows decode, and the new table works and persists.
    #[test]
    fn a_v1_database_opens_through_the_store_with_its_threads_intact() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("threads.db");
        seed_v1(&path);

        let agent = AgentId::new("atlas-agent");
        {
            let store = ThreadMetadataStore::open(&path).expect("a V1 store opens");
            let mut threads = store.threads();
            threads.sort_by_key(|t| *t.thread_id.as_uuid().as_bytes());
            assert_eq!(
                threads.len(),
                2,
                "the two sent threads survive; the draft is pruned"
            );

            let sent = &threads[0];
            assert_eq!(sent.thread_id.as_uuid().as_bytes(), &SENT);
            assert_eq!(
                sent.session_id.as_ref().map(|s| s.0.to_string()).as_deref(),
                Some("sess-1")
            );
            assert_eq!(sent.agent_id.as_str(), "atlas-agent");
            assert_eq!(sent.title.as_deref(), Some("Fix the build"));
            assert_eq!(sent.title_override.as_deref(), Some("My rename"));
            assert!(sent.created_at.is_some() && sent.interacted_at.is_some());
            assert_eq!(
                sent.folder_paths(),
                &PathList::new(&[PathBuf::from("/work/b"), PathBuf::from("/work/a")]),
                "folder order survives"
            );
            assert!(!sent.archived);

            let archived = &threads[1];
            assert_eq!(archived.agent_id.as_str(), "claude-code");
            assert_eq!(archived.title, None);
            assert!(archived.archived);

            assert!(!store.has_backfilled(&agent));
            store.mark_backfilled(&agent);
            store.flush().unwrap();
        }

        let store = ThreadMetadataStore::open(&path).unwrap();
        assert_eq!(store.threads().len(), 2);
        assert!(store.has_backfilled(&agent), "the V2 table is durable");
    }

    /// A V2 database carrying rows under the retired native id next to rows
    /// under the current one: the upgrade drops exactly the former.
    #[test]
    fn a_v2_database_loses_the_rows_under_the_retired_native_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("threads.db");
        seed_v1(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(V2).unwrap();
            conn.pragma_update(None, "user_version", 2).unwrap();
            conn.execute(
                "INSERT INTO threads (thread_id, session_id, agent_id, updated_at) \
                 VALUES (?1, 'sess-old', 'cersei', '2026-05-04T00:00:00+00:00')",
                [[4u8; 16].as_slice()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO backfilled_agents (agent_id, at) VALUES ('cersei', 'then')",
                [],
            )
            .unwrap();
        }

        let conn = Connection::open(&path).unwrap();
        migrate(&conn).unwrap();
        assert_eq!(version_of(&conn), SCHEMA_VERSION);
        let retired: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM threads WHERE agent_id = 'cersei'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            retired, 0,
            "rows under the retired id are dropped, not aliased"
        );
        let kept: i64 = conn
            .query_row("SELECT COUNT(*) FROM threads", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, 3, "every row under a live id survives");
        let marker: i64 = conn
            .query_row("SELECT COUNT(*) FROM backfilled_agents", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            marker, 0,
            "the retired id's backfill marker goes with its rows"
        );
    }

    #[test]
    fn a_database_from_a_newer_build_is_refused_untouched() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(V1).unwrap();
        conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        assert!(matches!(
            migrate(&conn),
            Err(Error::SchemaTooNew { found, supported })
                if found == SCHEMA_VERSION + 1 && supported == SCHEMA_VERSION
        ));
        assert!(!has_table(&conn, "backfilled_agents"));
    }

    /// Two connections released at once against a V1 file: the IMMEDIATE lock
    /// and the in-lock re-read mean both succeed and the upgrade lands once.
    #[test]
    fn two_connections_racing_the_upgrade_both_succeed() {
        for round in 0..8 {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("threads.db");
            seed_v1(&path);

            let barrier = Arc::new(Barrier::new(2));
            let handles: Vec<_> = (0..2)
                .map(|_| {
                    let path = path.clone();
                    let barrier = Arc::clone(&barrier);
                    std::thread::spawn(move || {
                        let conn = Connection::open(&path).unwrap();
                        conn.busy_timeout(std::time::Duration::from_secs(5))
                            .unwrap();
                        barrier.wait();
                        migrate(&conn).map_err(|e| e.to_string())
                    })
                })
                .collect();
            for handle in handles {
                handle
                    .join()
                    .unwrap()
                    .unwrap_or_else(|e| panic!("round {round}: {e}"));
            }
            let conn = Connection::open(&path).unwrap();
            assert_eq!(version_of(&conn), SCHEMA_VERSION);
            assert!(has_table(&conn, "backfilled_agents"));
        }
    }
}

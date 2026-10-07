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
//!
//! V4 adds `branch`, the git branch the thread's working directory was on the
//! last time Atlas looked (on bind and at every turn start). Zed has no
//! equivalent; the history cards show it. Nullable, and `NULL` means "not
//! known" — a row from before the column, a detached HEAD, or a folder that is
//! not a repository all read the same, because Atlas never guesses a branch.
//!
//! # Named migrations and the epoch
//!
//! The linear integer above stopped working the moment two branches each
//! added "the next" migration: both called theirs V4, a build of one bumped
//! the user's database past what a build of the other understood, and the
//! hard refusal turned a harmless extra table into an empty sidebar. One
//! database is opened by many builds — the installed app, `tauri dev`, every
//! branch someone builds — so the scheme has to survive divergent histories.
//!
//! So migrations are now *named* and recorded in a `schema_migrations`
//! ledger. A build applies the names it knows that the ledger lacks, and
//! ignores names it does not know. Two branches can each add one without
//! colliding, in either order, and an older build opens a database a newer
//! one has extended.
//!
//! That only holds while every named migration is *additive*: a new table, a
//! nullable or defaulted column, an index, or an idempotent data fix — a shape
//! every build at the same epoch can still read and write. (The write path is
//! safe against columns it does not know: `UPSERT` names its columns and
//! updates only those.) Anything else — a dropped or renamed column, a new
//! `NOT NULL` column without a default, a changed meaning — bumps
//! [`SCHEMA_EPOCH`], and a build refuses a database from a newer epoch,
//! untouched.
//!
//! `user_version` now holds the epoch. Values up to [`LEGACY_MAX`] are the old
//! linear versions, which all predate the ledger and all read as compatible:
//! the first ledger-aware open works out what is actually there (every
//! migration is idempotent, so it simply runs them) and moves the database to
//! the current epoch. Whether a database is pre-ledger is read from the
//! ledger table's presence, never from the number, which is why the first
//! epoch can *equal* `LEGACY_MAX`: a pre-ledger build that understood linear
//! version 5 — the session-discovery branch — still opens a ledger database
//! instead of refusing it, and since its writes name their columns it leaves
//! `branch` alone. Stamping 6 would have refused every such build for no
//! change it could not read.
//!
//! Every migration first leaves a copy behind (`Db::open`, via
//! [`needs_migration`]), so no build is ever the only holder of a history.

use rusqlite::{Connection, OptionalExtension};

use crate::error::{Error, Result};

/// The highest number the pre-ledger linear scheme ever wrote — `5`, by the
/// session-discovery branch. Every `user_version` at or below it is a
/// pre-ledger database, compatible with this build.
pub const LEGACY_MAX: i64 = 5;

/// The schema epoch, kept in `user_version`. Bump it ONLY for a change an
/// older build at the previous epoch could not read or write safely; additive
/// changes are a new entry in [`MIGRATIONS`] instead. It starts at
/// [`LEGACY_MAX`] on purpose (see the module docs).
pub const SCHEMA_EPOCH: i64 = 5;

/// One additive, idempotent step, known by its name in the ledger.
struct Migration {
    /// Recorded in `schema_migrations`. Never rename or reuse one: a database
    /// that has the name has the change.
    name: &'static str,
    /// Must be safe to run on a database that already has the change — a
    /// pre-ledger database records nothing about what it has.
    apply: fn(&Connection) -> Result<()>,
}

/// Every migration this build knows, in the order a new database gets them.
const MIGRATIONS: &[Migration] = &[
    Migration {
        name: "threads",
        apply: |conn| Ok(conn.execute_batch(V1)?),
    },
    Migration {
        name: "backfilled_agents",
        apply: |conn| Ok(conn.execute_batch(V2)?),
    },
    Migration {
        name: "drop_retired_native_id",
        apply: |conn| Ok(conn.execute_batch(V3)?),
    },
    Migration {
        name: "threads_branch",
        apply: add_branch_column,
    },
];

const LEDGER: &str = "
CREATE TABLE IF NOT EXISTS schema_migrations(
    name TEXT PRIMARY KEY,
    at   TEXT NOT NULL
) STRICT;
";

/// Refuse a database from a newer epoch; anything else is ours to open.
fn check_epoch(found: i64) -> Result<()> {
    if found > SCHEMA_EPOCH {
        return Err(Error::SchemaTooNew {
            found,
            supported: SCHEMA_EPOCH,
        });
    }
    Ok(())
}

fn user_version(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?)
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// The migrations this build knows that the database has not recorded. A
/// database without a ledger has recorded none — including a pre-ledger one
/// that has in fact run some, which is why every step is idempotent.
fn pending(conn: &Connection) -> Result<Vec<&'static Migration>> {
    if !table_exists(conn, "schema_migrations")? {
        return Ok(MIGRATIONS.iter().collect());
    }
    let mut stmt = conn.prepare("SELECT 1 FROM schema_migrations WHERE name = ?1")?;
    let mut out = Vec::new();
    for migration in MIGRATIONS {
        if !stmt.exists([migration.name])? {
            out.push(migration);
        }
    }
    Ok(out)
}

/// Whether opening this database will change it — the caller's cue to take a
/// copy first. A brand-new, empty database needs migrating but has nothing to
/// lose, so it reads `false`. A database from a newer epoch is not refused
/// here; [`migrate`] does that.
pub fn needs_migration(conn: &Connection) -> Result<bool> {
    let found = user_version(conn)?;
    if found > SCHEMA_EPOCH {
        return Ok(false);
    }
    if found == 0 && !table_exists(conn, "threads")? {
        return Ok(false);
    }
    Ok(found != SCHEMA_EPOCH || !pending(conn)?.is_empty())
}

pub fn migrate(conn: &Connection) -> Result<()> {
    // Fast path, outside any transaction: the common case is a database
    // already at the current epoch with every known migration recorded.
    let found = user_version(conn)?;
    check_epoch(found)?;
    if found == SCHEMA_EPOCH && pending(conn)?.is_empty() {
        return Ok(());
    }

    // One IMMEDIATE transaction, with the state re-read inside it: two
    // connections racing an open both arrive here believing the database is
    // behind, and without the lock the loser fails on a duplicate column.
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> Result<()> {
        check_epoch(user_version(conn)?)?;
        conn.execute_batch(LEDGER)?;
        let now = chrono::Utc::now().to_rfc3339();
        for migration in pending(conn)? {
            (migration.apply)(conn)?;
            conn.execute(
                "INSERT INTO schema_migrations(name, at) VALUES (?1, ?2)",
                rusqlite::params![migration.name, now],
            )?;
        }
        conn.pragma_update(None, "user_version", SCHEMA_EPOCH)?;
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

/// `ALTER TABLE … ADD COLUMN` has no `IF NOT EXISTS`, so the check is ours: a
/// pre-ledger database from a build that already added it must not fail here.
fn add_branch_column(conn: &Connection) -> Result<()> {
    let present = conn
        .query_row(
            "SELECT 1 FROM pragma_table_info('threads') WHERE name = 'branch'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !present {
        conn.execute_batch(V4)?;
    }
    Ok(())
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

/// The git branch the thread ran on. Existing rows read `NULL` — unknown —
/// rather than being back-filled with whatever the folder is on today, which
/// would be a claim about the past Atlas never observed.
const V4: &str = "
ALTER TABLE threads ADD COLUMN branch TEXT;
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
        assert_eq!(version_of(&conn), SCHEMA_EPOCH);
        assert!(has_table(&conn, "backfilled_agents"));
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM threads", [], |r| r.get(0))
            .unwrap();
        // The migration itself drops nothing; pruning drafts is the store's
        // job on open, not the schema's.
        assert_eq!(rows, 3);

        // Current, so a second run is the fast path.
        migrate(&conn).unwrap();
        assert_eq!(version_of(&conn), SCHEMA_EPOCH);
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
        assert_eq!(version_of(&conn), SCHEMA_EPOCH);
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

    /// A V3 database gains the `branch` column, every existing row reading
    /// `NULL` for it, and the store decodes those rows as "branch unknown".
    #[test]
    fn a_v3_database_gains_a_null_branch_column() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("threads.db");
        seed_v1(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(V2).unwrap();
            conn.execute_batch(V3).unwrap();
            conn.pragma_update(None, "user_version", 3).unwrap();
        }

        {
            let conn = Connection::open(&path).unwrap();
            migrate(&conn).unwrap();
            assert_eq!(version_of(&conn), SCHEMA_EPOCH);
            let (rows, with_branch): (i64, i64) = conn
                .query_row("SELECT COUNT(*), COUNT(branch) FROM threads", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .unwrap();
            assert_eq!(rows, 3, "the migration keeps every row");
            assert_eq!(with_branch, 0, "no existing row is given a branch");
        }

        let store = ThreadMetadataStore::open(&path).unwrap();
        let threads = store.threads();
        assert_eq!(threads.len(), 2);
        assert!(threads.iter().all(|t| t.branch.is_none()));
    }

    fn ledger(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT name FROM schema_migrations ORDER BY name")
            .unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    fn known_names() -> Vec<String> {
        let mut names: Vec<String> = MIGRATIONS.iter().map(|m| m.name.to_string()).collect();
        names.sort();
        names
    }

    /// The database that emptied a real sidebar: linear version 5, written by
    /// the session-discovery branch, which added two tables of its own and
    /// never the `branch` column. It must open, keep every row and both
    /// foreign tables, gain the column, and land on the current epoch.
    #[test]
    fn a_legacy_v5_database_from_another_branch_opens_and_keeps_its_tables() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("threads.db");
        seed_v1(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(V2).unwrap();
            conn.execute_batch(V3).unwrap();
            conn.execute_batch(
                "CREATE TABLE deleted_sessions(session_id TEXT PRIMARY KEY, at TEXT NOT NULL) STRICT;
                 CREATE TABLE session_aliases(alias_id TEXT PRIMARY KEY, \
                     owner_session_id TEXT NOT NULL, at TEXT NOT NULL) STRICT;
                 INSERT INTO deleted_sessions VALUES ('gone', 'then');",
            )
            .unwrap();
            conn.pragma_update(None, "user_version", LEGACY_MAX)
                .unwrap();
        }

        {
            let conn = Connection::open(&path).unwrap();
            assert!(needs_migration(&conn).unwrap());
            migrate(&conn).unwrap();
            assert_eq!(version_of(&conn), SCHEMA_EPOCH);
            assert_eq!(ledger(&conn), known_names());
            let (rows, with_branch): (i64, i64) = conn
                .query_row("SELECT COUNT(*), COUNT(branch) FROM threads", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .unwrap();
            assert_eq!((rows, with_branch), (3, 0));
            let tombstones: i64 = conn
                .query_row("SELECT COUNT(*) FROM deleted_sessions", [], |r| r.get(0))
                .unwrap();
            assert_eq!(
                tombstones, 1,
                "a table this build does not know is left alone"
            );
            assert!(has_table(&conn, "session_aliases"));
            assert!(!needs_migration(&conn).unwrap(), "current now");
        }

        let store = ThreadMetadataStore::open(&path).unwrap();
        assert_eq!(store.threads().len(), 2);
    }

    /// Linear version 4 from a build that already added `branch`: re-running
    /// the step must not fail on a duplicate column.
    #[test]
    fn a_legacy_database_that_already_has_the_branch_column_opens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("threads.db");
        seed_v1(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(V2).unwrap();
            conn.execute_batch(V3).unwrap();
            conn.execute_batch(V4).unwrap();
            conn.execute("UPDATE threads SET branch = 'main'", [])
                .unwrap();
            conn.pragma_update(None, "user_version", 4).unwrap();
        }
        let conn = Connection::open(&path).unwrap();
        migrate(&conn).unwrap();
        assert_eq!(version_of(&conn), SCHEMA_EPOCH);
        let with_branch: i64 = conn
            .query_row("SELECT COUNT(branch) FROM threads", [], |r| r.get(0))
            .unwrap();
        assert_eq!(with_branch, 3, "the branches already recorded survive");
    }

    /// A newer build at the same epoch recorded a migration this one has never
    /// heard of (an extra table). That is additive by the epoch rule, so this
    /// build opens the database without touching it.
    #[test]
    fn an_unknown_migration_at_the_same_epoch_is_ignored() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE from_the_future(x TEXT) STRICT;
             INSERT INTO schema_migrations(name, at) VALUES ('from_the_future', 'later');",
        )
        .unwrap();

        assert!(!needs_migration(&conn).unwrap());
        migrate(&conn).unwrap();
        assert_eq!(version_of(&conn), SCHEMA_EPOCH);
        assert!(ledger(&conn).contains(&"from_the_future".to_string()));
        assert!(has_table(&conn, "from_the_future"));
    }

    /// A migration this build knows but the ledger lacks — the shape a branch
    /// adding one lands in — runs on open even at the current epoch.
    #[test]
    fn a_known_migration_missing_from_the_ledger_runs_at_the_current_epoch() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute_batch(
            "ALTER TABLE threads DROP COLUMN branch;
             DELETE FROM schema_migrations WHERE name = 'threads_branch';",
        )
        .unwrap();

        assert!(needs_migration(&conn).unwrap());
        migrate(&conn).unwrap();
        assert_eq!(ledger(&conn), known_names());
        let present: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('threads') WHERE name = 'branch'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(present, 1);
    }

    /// A pre-ledger build that understood linear version 5 refuses anything
    /// above it and fast-paths exactly 5. Until a breaking change bumps the
    /// epoch, a ledger database must read as 5, so such a build — the
    /// session-discovery branch, built and run against real history — still
    /// opens it rather than emptying the sidebar.
    #[test]
    fn a_ledger_database_still_reads_as_linear_version_5() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        assert_eq!(version_of(&conn), LEGACY_MAX);
    }

    /// A fresh database has nothing to lose, so it asks for no backup.
    #[test]
    fn a_new_database_needs_no_backup() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(!needs_migration(&conn).unwrap());
    }

    /// Opening a database that needs migrating leaves a copy of it as it was;
    /// the copy is not overwritten by a later open from the same version, and
    /// an already-current database leaves none.
    #[test]
    fn migrating_through_the_store_leaves_a_backup_of_the_old_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("threads.db");
        seed_v1(&path);

        drop(ThreadMetadataStore::open(&path).unwrap());
        let backup = dir.path().join("threads.db.bak-v1");
        assert!(backup.exists(), "a pre-migration copy is taken");
        let conn = Connection::open(&backup).unwrap();
        assert_eq!(
            version_of(&conn),
            1,
            "the copy is the database before migrating"
        );
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM threads", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 3, "the copy holds every row, the draft included");
        drop(conn);

        drop(ThreadMetadataStore::open(&path).unwrap());
        let backups = std::fs::read_dir(dir.path())
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".bak-")
            })
            .count();
        assert_eq!(backups, 1, "a current database takes no further copy");
    }

    #[test]
    fn a_database_from_a_newer_build_is_refused_untouched() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(V1).unwrap();
        conn.pragma_update(None, "user_version", SCHEMA_EPOCH + 1)
            .unwrap();
        assert!(matches!(
            migrate(&conn),
            Err(Error::SchemaTooNew { found, supported })
                if found == SCHEMA_EPOCH + 1 && supported == SCHEMA_EPOCH
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
            assert_eq!(version_of(&conn), SCHEMA_EPOCH);
            assert!(has_table(&conn, "backfilled_agents"));
        }
    }
}

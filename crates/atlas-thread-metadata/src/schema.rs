//! Schema and migrations.
//!
//! The versioning policy is atlas-checkpoint's, deliberately: an integer in
//! `user_version`, forward-only migrations, and a hard refusal to open a
//! database written by a newer build.
//!
//! There is no shipped predecessor, so V1 below is the whole table in one
//! `CREATE TABLE`. Two things are deliberately absent: `archived_git_worktrees`
//! side tables (out of scope per the spec — they serve a worktree lifecycle
//! Atlas does not have), and a one-time session-less-row prune, which is done
//! on every open instead (see `Db::prune_drafts`).
//!
//! V2 adds `backfilled_agents`: the one-time import pass (spec #15) needs somewhere durable to
//! remember it already ran.
//!
//! V3 is a data step, not a shape change: the native agent's stored id was
//! renamed (ADR-0011) and, by decision, rows under the retired id are dropped
//! rather than aliased. Nothing resolves them any more, so leaving them would
//! only put unopenable rows in the sidebar.
//!
//! V4 adds `branch`, the git branch the thread's working directory was on the
//! last time Atlas looked (on bind and at every turn start). The history cards show it. Nullable, and
//! `NULL` means "not known" — a row from before the column, a detached HEAD, or a folder that is
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
//! The session-discovery work adds two more, both plain tables:
//! `deleted_sessions` — the session ids whose rows the user deleted, so that
//! "delete" outlasts the next sync (an agent that could not or would not
//! forget the session keeps listing it, and without a durable record the row
//! would be back within seconds) — and `session_aliases` — on-disk session
//! ids confirmed to be another transcript of a session Atlas ran (an adapter
//! that writes a conversation's continuation under a fresh id). Only
//! confirmed aliases are written; the provisional guess that precedes
//! confirmation is never persisted. Before the ledger these were that
//! branch's linear V4 and V5.
//!
//! `threads_settlement` adds `settled_at` and `unsettled_at`, both nullable:
//! a session can be settled (moved to the sidebar's Settled shelf) and
//! un-settled again. Every existing row reads `NULL` for both — active, and
//! never un-settled — which is what it was.
//!
//! `threads_lifecycle` adds the rest of a session's lifecycle — `pinned_at`,
//! `pin_order`, `snoozed_until`, `snoozed_at`, `last_snooze_wake_at`,
//! `last_viewed_at` and `last_turn_completed_at`, all nullable — and retires
//! archiving, which Settled replaced. Every archived row is settled, at its
//! `updated_at` (the store never recorded an archive time; `updated_at` is
//! what it always stood in for one with, and it is the last-activity time the
//! idle sweep settles at too), and its `archived` flag is cleared.
//!
//! The `archived` column itself stays in the table, and nothing in this build
//! reads or writes it. Dropping it would be a non-additive change: an older
//! build at this epoch names it in every upsert, so dropping it means bumping
//! [`SCHEMA_EPOCH`], and a bumped epoch makes the installed app refuse the
//! database a dev build opened — the empty sidebar the ledger exists to
//! prevent. A row an older build archives afterwards reads as active here,
//! which is the one cost, and a harmless one.
//!
//! `threads_attached_projects` adds `attached_projects`, nullable: the
//! projects attached to a session besides its own folder, as one JSON array
//! (path, display name, access, when, and how it was attached). `NULL` is
//! "nothing attached", which is what every existing row is, so no row is
//! rewritten. An older build at this epoch names its columns in every upsert
//! and so leaves the column alone; a session it writes keeps its attachments.
//!
//! `session_forks` records lineage: which session a branched session ("Branch
//! from here") was forked from, as a child → parent pair of agent session
//! ids. A plain table; older builds never read it.
//!
//! `threads_pull_requests` adds `pull_requests`, nullable: the pull requests
//! linked to a session, as one JSON array (repository, number, URL, how it
//! was linked, and the host's last reported state). `NULL` is "none linked",
//! which is what every existing row is, so no row is rewritten and the epoch
//! stays. An older build at this epoch names its columns in every upsert and
//! so leaves the column alone.
//!
//! `threads_unpinned_at` adds `unpinned_at`, nullable: when the session was
//! last unpinned, which restarts its idle clock for the sweep. `NULL` is
//! "never unpinned", what every existing row is, so no row is rewritten and
//! the epoch stays. An older build at this epoch names its columns in every
//! upsert and so leaves the column alone.
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
    Migration {
        name: "deleted_sessions",
        apply: |conn| Ok(conn.execute_batch(DELETED_SESSIONS)?),
    },
    Migration {
        name: "session_aliases",
        apply: |conn| Ok(conn.execute_batch(SESSION_ALIASES)?),
    },
    Migration {
        name: "threads_settlement",
        apply: add_settlement_columns,
    },
    Migration {
        name: "threads_lifecycle",
        apply: add_lifecycle_columns,
    },
    Migration {
        name: "threads_model",
        apply: add_model_column,
    },
    Migration {
        name: "threads_attached_projects",
        apply: add_attached_projects_column,
    },
    Migration {
        name: "session_forks",
        apply: |conn| Ok(conn.execute_batch(SESSION_FORKS)?),
    },
    Migration {
        name: "threads_pull_requests",
        apply: add_pull_requests_column,
    },
    Migration {
        name: "threads_unpinned_at",
        apply: add_unpinned_at_column,
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

/// `model`, the model the latest turn ran on, added only when absent — the
/// same guard as [`add_branch_column`]. Existing rows read `NULL`: unknown,
/// never back-filled with a guess.
fn add_model_column(conn: &Connection) -> Result<()> {
    if !has_column(conn, "threads", "model")? {
        conn.execute_batch("ALTER TABLE threads ADD COLUMN model TEXT;")?;
    }
    Ok(())
}

/// `settled_at` and `unsettled_at`, each added only when absent — the same
/// guard as [`add_branch_column`], for the same reason.
fn add_settlement_columns(conn: &Connection) -> Result<()> {
    for column in ["settled_at", "unsettled_at"] {
        if !has_column(conn, "threads", column)? {
            conn.execute_batch(&format!("ALTER TABLE threads ADD COLUMN {column} TEXT;"))?;
        }
    }
    Ok(())
}

/// The lifecycle columns this build reads and writes beyond settling.
pub(crate) const LIFECYCLE_COLUMNS: [&str; 7] = [
    "pinned_at",
    "pin_order",
    "snoozed_until",
    "snoozed_at",
    "last_snooze_wake_at",
    "last_viewed_at",
    "last_turn_completed_at",
];

/// The lifecycle columns, each added only when absent, then archived rows
/// moved to Settled. The data step is idempotent: after it no row has
/// `archived = 1`, and a row already settled keeps its own time.
fn add_lifecycle_columns(conn: &Connection) -> Result<()> {
    for column in LIFECYCLE_COLUMNS {
        if !has_column(conn, "threads", column)? {
            conn.execute_batch(&format!("ALTER TABLE threads ADD COLUMN {column} TEXT;"))?;
        }
    }
    conn.execute_batch(ARCHIVED_TO_SETTLED)?;
    Ok(())
}

/// `pull_requests`, added only when absent — the same guard as
/// [`add_branch_column`]. A shape change only: every existing row reads
/// `NULL`, nothing linked, and none is rewritten.
fn add_pull_requests_column(conn: &Connection) -> Result<()> {
    if !has_column(conn, "threads", "pull_requests")? {
        conn.execute_batch("ALTER TABLE threads ADD COLUMN pull_requests TEXT;")?;
    }
    Ok(())
}

/// `unpinned_at`, added only when absent — the same guard as
/// [`add_branch_column`]. Existing rows read `NULL`: never unpinned.
fn add_unpinned_at_column(conn: &Connection) -> Result<()> {
    if !has_column(conn, "threads", "unpinned_at")? {
        conn.execute_batch("ALTER TABLE threads ADD COLUMN unpinned_at TEXT;")?;
    }
    Ok(())
}

/// `attached_projects`, added only when absent — the same guard as
/// [`add_branch_column`]. A shape change only: every existing row reads
/// `NULL`, nothing attached, and none is rewritten.
fn add_attached_projects_column(conn: &Connection) -> Result<()> {
    if !has_column(conn, "threads", "attached_projects")? {
        conn.execute_batch("ALTER TABLE threads ADD COLUMN attached_projects TEXT;")?;
    }
    Ok(())
}

/// Archive is retired: every archived row becomes a settled one. See the
/// module docs for why `updated_at` is its settled time and why the column
/// stays.
const ARCHIVED_TO_SETTLED: &str = "
UPDATE threads SET settled_at = COALESCE(settled_at, updated_at), archived = 0
    WHERE archived <> 0;
";

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2",
            [table, column],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// The whole store.
///
/// `title` is `NOT NULL` with `''` standing for "no title". Every other absent
/// value is a real SQL `NULL`.
///
/// The table is `threads`, not `sidebar_threads`: the sidebar is one of
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

/// Session ids the user deleted, so no import brings them back.
///
/// Keyed by session id, not thread id: the thread id is Atlas's and is gone
/// with the row, while the session id is what an agent's `session/list` and the
/// session watcher both name. A row Atlas itself writes again for the session
/// (its conversation is still open, and continued) removes the entry.
const DELETED_SESSIONS: &str = "
CREATE TABLE IF NOT EXISTS deleted_sessions(
    session_id TEXT PRIMARY KEY,
    at         TEXT NOT NULL
) STRICT;
";

/// Transcript ids confirmed to belong to another session, alias → owner.
///
/// Both columns are agent session ids, not thread ids: the alias never has a
/// row of its own, and the owner's row is found through its session id. A
/// row's delete removes its aliases (and records each alias id as deleted, so
/// the continuation is not imported in the owner's place).
const SESSION_ALIASES: &str = "
CREATE TABLE IF NOT EXISTS session_aliases(
    alias_id         TEXT PRIMARY KEY,
    owner_session_id TEXT NOT NULL,
    at               TEXT NOT NULL
) STRICT;
";

/// Which session each branched session came from, child → parent.
///
/// Keyed by agent session ids, like `session_aliases`, and for the same
/// reason: a fork is recorded the moment the agent answers with the child's
/// id, before Atlas has written a row for it, and the child's row is found
/// through its session id once it has one. A plain table, so it rides the
/// ledger as an additive migration.
const SESSION_FORKS: &str = "
CREATE TABLE IF NOT EXISTS session_forks(
    child_session_id  TEXT PRIMARY KEY,
    parent_session_id TEXT NOT NULL,
    at                TEXT NOT NULL
) STRICT;
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
        assert!(has_table(&conn, "deleted_sessions"));
        assert!(has_table(&conn, "session_aliases"));
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
            assert!(!sent.is_settled());

            let archived = &threads[1];
            assert_eq!(archived.agent_id.as_str(), "claude-code");
            assert_eq!(archived.title, None);
            assert_eq!(
                archived.settled_at,
                Some(archived.updated_at),
                "the archived row is settled now, at its last activity"
            );

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

    /// A database from before settling gains both columns, every row reading
    /// `NULL` — active, never un-settled — and the store decodes them so.
    #[test]
    fn a_database_before_settlement_gains_two_null_columns() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("threads.db");
        seed_v1(&path);
        {
            let conn = Connection::open(&path).unwrap();
            migrate(&conn).unwrap();
            conn.execute_batch(
                "ALTER TABLE threads DROP COLUMN settled_at;
                 ALTER TABLE threads DROP COLUMN unsettled_at;
                 DELETE FROM schema_migrations WHERE name = 'threads_settlement';",
            )
            .unwrap();
        }
        {
            let conn = Connection::open(&path).unwrap();
            assert!(needs_migration(&conn).unwrap());
            migrate(&conn).unwrap();
            assert_eq!(ledger(&conn), known_names());
            let (rows, settled, unsettled): (i64, i64, i64) = conn
                .query_row(
                    "SELECT COUNT(*), COUNT(settled_at), COUNT(unsettled_at) FROM threads",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap();
            assert_eq!((rows, settled, unsettled), (3, 0, 0));
            // Re-running the step on a database that has the columns is a no-op.
            add_settlement_columns(&conn).unwrap();
        }
        let store = ThreadMetadataStore::open(&path).unwrap();
        assert!(store
            .threads()
            .iter()
            .all(|t| t.settled_at.is_none() && t.unsettled_at.is_none()));
    }

    /// A database from before attached projects gains the column with every
    /// row `NULL` — nothing attached — at the same epoch, and no row is
    /// rewritten. The store decodes them as empty lists.
    #[test]
    fn a_database_before_attached_projects_gains_a_null_column_at_the_same_epoch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("threads.db");
        seed_v1(&path);
        {
            let conn = Connection::open(&path).unwrap();
            migrate(&conn).unwrap();
            conn.execute_batch(
                "ALTER TABLE threads DROP COLUMN attached_projects;
                 DELETE FROM schema_migrations WHERE name = 'threads_attached_projects';",
            )
            .unwrap();
        }
        {
            let conn = Connection::open(&path).unwrap();
            assert!(needs_migration(&conn).unwrap());
            migrate(&conn).unwrap();
            assert_eq!(version_of(&conn), SCHEMA_EPOCH);
            assert_eq!(ledger(&conn), known_names());
            let (rows, attached): (i64, i64) = conn
                .query_row(
                    "SELECT COUNT(*), COUNT(attached_projects) FROM threads",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!((rows, attached), (3, 0));
            add_attached_projects_column(&conn).unwrap();
        }
        let store = ThreadMetadataStore::open(&path).unwrap();
        assert!(store
            .threads()
            .iter()
            .all(|t| t.attached_projects.is_empty()));
    }

    /// A database from before linked pull requests gains the column with
    /// every row `NULL` at the same epoch, and no row is rewritten. The store
    /// decodes them as empty lists.
    #[test]
    fn a_database_before_pull_request_links_gains_a_null_column_at_the_same_epoch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("threads.db");
        seed_v1(&path);
        {
            let conn = Connection::open(&path).unwrap();
            migrate(&conn).unwrap();
            conn.execute_batch(
                "ALTER TABLE threads DROP COLUMN pull_requests;
                 DELETE FROM schema_migrations WHERE name = 'threads_pull_requests';",
            )
            .unwrap();
        }
        {
            let conn = Connection::open(&path).unwrap();
            assert!(needs_migration(&conn).unwrap());
            migrate(&conn).unwrap();
            assert_eq!(version_of(&conn), SCHEMA_EPOCH);
            assert_eq!(ledger(&conn), known_names());
            let (rows, linked): (i64, i64) = conn
                .query_row(
                    "SELECT COUNT(*), COUNT(pull_requests) FROM threads",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!((rows, linked), (3, 0));
            add_pull_requests_column(&conn).unwrap();
        }
        let store = ThreadMetadataStore::open(&path).unwrap();
        assert!(store.threads().iter().all(|t| t.pull_requests.is_empty()));
    }

    /// Archive is retired: the lifecycle migration settles every archived row
    /// at its `updated_at`, keeps an already-settled row's own time, clears
    /// the flag, and adds the lifecycle columns empty. Running it again
    /// changes nothing.
    #[test]
    fn the_lifecycle_migration_moves_archived_rows_to_settled() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("threads.db");
        seed_v1(&path);
        let earlier_settle = "2026-04-01T00:00:00+00:00";
        {
            let conn = Connection::open(&path).unwrap();
            migrate(&conn).unwrap();
            // Back to the state before the lifecycle migration: the flag set
            // again on two rows, one of them already settled, and the
            // lifecycle columns gone.
            for column in LIFECYCLE_COLUMNS {
                conn.execute_batch(&format!("ALTER TABLE threads DROP COLUMN {column};"))
                    .unwrap();
            }
            conn.execute_batch("DELETE FROM schema_migrations WHERE name = 'threads_lifecycle';")
                .unwrap();
            conn.execute(
                "UPDATE threads SET archived = 1 WHERE thread_id = ?1",
                [SENT.as_slice()],
            )
            .unwrap();
            conn.execute(
                "UPDATE threads SET archived = 1, settled_at = ?2 WHERE thread_id = ?1",
                rusqlite::params![ARCHIVED.as_slice(), earlier_settle],
            )
            .unwrap();
        }
        {
            let conn = Connection::open(&path).unwrap();
            assert!(needs_migration(&conn).unwrap());
            migrate(&conn).unwrap();
            assert_eq!(ledger(&conn), known_names());
            let still_archived: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM threads WHERE archived <> 0",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(still_archived, 0, "no row is archived any more");
            let settled_of = |id: [u8; 16]| -> Option<String> {
                conn.query_row(
                    "SELECT settled_at FROM threads WHERE thread_id = ?1",
                    [id.as_slice()],
                    |r| r.get(0),
                )
                .unwrap()
            };
            assert_eq!(
                settled_of(SENT).as_deref(),
                Some("2026-05-02T00:00:00+00:00"),
                "settled at its updated_at"
            );
            assert_eq!(
                settled_of(ARCHIVED).as_deref(),
                Some(earlier_settle),
                "an already-settled row keeps its own time"
            );
            assert_eq!(settled_of(DRAFT), None, "an unarchived row is untouched");
            // Idempotent: a second application is a no-op.
            add_lifecycle_columns(&conn).unwrap();
            assert_eq!(
                settled_of(SENT).as_deref(),
                Some("2026-05-02T00:00:00+00:00")
            );
        }
        let store = ThreadMetadataStore::open(&path).unwrap();
        for thread in store.threads() {
            assert!(thread.is_settled());
            assert!(thread.pinned_at.is_none() && thread.pin_order.is_none());
            assert!(thread.snoozed_until.is_none() && thread.last_viewed_at.is_none());
            assert!(thread.last_turn_completed_at.is_none());
            assert!(!thread.is_unread(), "a migrated row is never unread");
        }
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

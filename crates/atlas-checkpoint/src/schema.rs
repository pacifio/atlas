//! Schema and migrations.
//!
//! Atlas has never created a SQLite database before — the one existing rusqlite
//! call site reads Codex's own store read-only — so the versioning policy is
//! established here. It is deliberately the simplest thing that can survive a
//! downgrade: an integer in `user_version`, forward-only migrations, and a hard
//! refusal to touch a database written by a newer build. Silently operating on a
//! schema you do not understand is how you corrupt the record you exist to keep.
//!
//! Indexes are part of the schema rather than an afterthought. The two queries
//! that must never full-scan are the outbox drain and the ordered read behind
//! the session-detail sidebar, and both are covered below.

use rusqlite::Connection;

use crate::error::{Error, Result};

/// Bump when adding a migration, and add the matching arm in [`migrate`].
pub const SCHEMA_VERSION: i64 = 7;

pub fn migrate(conn: &Connection) -> Result<()> {
    // Fast path, outside any transaction: the overwhelmingly common case is a
    // database already at the current version.
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

    // The migration itself runs inside one IMMEDIATE transaction, and the
    // version is re-read *inside* it. Two connections — a writer and a reader,
    // or two commands racing an open — both reach here believing the database
    // is behind; without the lock and the re-check, both apply the same ALTER
    // TABLEs and the loser fails with "duplicate column name" while the store
    // reports itself unavailable. The IMMEDIATE lock serialises them, and the
    // re-check turns the loser into a no-op. DDL is transactional in SQLite,
    // so a failure mid-migration rolls back whole rather than leaving columns
    // added with the version still behind — which would wedge every later open.
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
        if found < 5 {
            conn.execute_batch(V5)?;
        }
        if found < 6 {
            apply_v6_tolerant(conn)?;
        }
        if found < 7 {
            // Same tolerance as V6, for the same reason: pure ALTER TABLE, and
            // a store that half-applied it must still be openable.
            apply_tolerant(conn, V7)?;
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

/// Apply V6 one statement at a time, tolerating columns that already exist.
///
/// V6 is pure ALTER TABLE / CREATE INDEX IF NOT EXISTS. An earlier build ran
/// these outside a transaction, so a crash or a concurrent-open race could add
/// some columns and then fail before stamping the version — after which every
/// re-run failed with "duplicate column name" and the store reported itself
/// unavailable forever. Skipping exactly that error makes the migration
/// idempotent for every tear shape while still surfacing anything real.
fn apply_v6_tolerant(conn: &Connection) -> Result<()> {
    apply_tolerant(conn, V6)
}

/// Run an ALTER-TABLE-only migration statement by statement, skipping columns
/// that a half-applied earlier run already added.
///
/// **The split is a naive `;`, so no comment in one of these migrations may
/// contain a semicolon.** One in prose cuts the comment in half and feeds the
/// remainder to SQLite as a statement, which fails the migration and leaves the
/// store reporting itself unavailable — for every user, on the next launch.
fn apply_tolerant(conn: &Connection, sql: &str) -> Result<()> {
    for statement in sql.split(';') {
        let statement = statement.trim();
        if statement.is_empty() {
            continue;
        }
        if let Err(e) = conn.execute_batch(&format!("{statement};")) {
            if e.to_string().contains("duplicate column name") {
                continue;
            }
            return Err(e.into());
        }
    }
    Ok(())
}

const V7: &str = r#"
-- The branch the repository was on when the Session started.
--
-- `SessionSummary.branches` was derived purely from a Session's Checkpoints, so
-- a Session that produced no commit (most of them) had no branch at all, and
-- the Timeline's branch filter could not see it. The branch is known at the
-- moment the prompt is sent, so recording it there gives every Session one, and
-- a Session that later lands commits on other branches shows the union.
ALTER TABLE agent_session ADD COLUMN branch TEXT;
"#;

const V1: &str = r#"
-- One row per Session. Named `agent_session`, never `session`: the server's
-- `session` table belongs to Better Auth, and the local schema mirrors the
-- server shape so that syncing is a copy rather than a translation.
CREATE TABLE IF NOT EXISTS agent_session (
    id                TEXT PRIMARY KEY,
    workspace_id      TEXT NOT NULL,
    source            TEXT NOT NULL,
    native_session_id TEXT NOT NULL,
    title             TEXT,
    agent             TEXT,
    model             TEXT,
    cwd               TEXT,
    token_totals      TEXT NOT NULL DEFAULT '{}',
    summary           TEXT,
    started_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    needs_attention   INTEGER NOT NULL DEFAULT 0,
    attention_reason  TEXT,
    redaction_counts  TEXT NOT NULL DEFAULT '{}',
    sync_state        TEXT NOT NULL DEFAULT 'local',
    sync_attempts     INTEGER NOT NULL DEFAULT 0,

    -- Identity. Dedupes a re-import *within* a source; deliberately NOT across
    -- sources, because Atlas's ACP-hosted agents also write their own JSONL and
    -- ('acp', id) / ('external_jsonl', id) are both legitimate rows. Skipping
    -- the cross-source duplicate is the importer's explicit job.
    UNIQUE (workspace_id, source, native_session_id)
);

-- One row per finalized turn. The only place transcript text lives — a
-- Checkpoint carries none of its own, so there is exactly one copy to redact,
-- one to sync, and one to keep consistent.
CREATE TABLE IF NOT EXISTS agent_message (
    id                TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL REFERENCES agent_session(id) ON DELETE CASCADE,
    seq               INTEGER NOT NULL,
    turn_seq          INTEGER NOT NULL,
    -- The agent's own id for this message, when it has one. This is what makes
    -- re-processing a turn idempotent rather than duplicating it.
    native_message_id TEXT,
    role              TEXT NOT NULL,
    mode              TEXT NOT NULL,
    preview           TEXT NOT NULL,
    body              TEXT,
    body_ref          TEXT,
    body_bytes        INTEGER NOT NULL DEFAULT 0,
    content_hash      TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    sync_state        TEXT NOT NULL DEFAULT 'local',
    sync_attempts     INTEGER NOT NULL DEFAULT 0,

    UNIQUE (session_id, seq)
);

-- Turn lifecycle, so an agent that died mid-turn is distinguishable from one
-- that finished. Without this an abandoned turn's rows are indistinguishable
-- from a completed turn's, and the record quietly asserts something false.
CREATE TABLE IF NOT EXISTS turn (
    session_id TEXT NOT NULL REFERENCES agent_session(id) ON DELETE CASCADE,
    turn_seq   INTEGER NOT NULL,
    state      TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at   TEXT,
    PRIMARY KEY (session_id, turn_seq)
);

-- Monotonic sequence source. A single row updated inside the same transaction
-- as the rows it numbers, so a crash cannot leave a gap that looks like a lost
-- row to the drain.
CREATE TABLE IF NOT EXISTS counter (
    name  TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);
INSERT OR IGNORE INTO counter (name, value) VALUES ('seq', 0);

-- The outbox drain: pending rows in sequence order, per workspace.
CREATE INDEX IF NOT EXISTS idx_session_outbox
    ON agent_session (workspace_id, sync_state);
CREATE INDEX IF NOT EXISTS idx_message_outbox
    ON agent_message (sync_state, seq);

-- Ordered reads for one Session.
CREATE INDEX IF NOT EXISTS idx_message_session_seq
    ON agent_message (session_id, seq);

-- The session-detail sidebar's Prompts / Responses / Intermediate counts.
-- Covering, so the counts are answerable without reading a single body.
CREATE INDEX IF NOT EXISTS idx_message_facets
    ON agent_message (session_id, role, mode);

-- Re-processing the same turn must not duplicate it. Partial, because a message
-- the agent gave no id to still deserves a row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_native_id
    ON agent_message (session_id, native_message_id)
    WHERE native_message_id IS NOT NULL;

-- Timeline ordering across a Workspace.
CREATE INDEX IF NOT EXISTS idx_session_started
    ON agent_session (workspace_id, started_at);
"#;

const V2: &str = r#"
-- What the agent actually did. A row per invocation, never content embedded in
-- a Message body — three independent reasons, any one sufficient:
--
--   * The session-detail sidebar's live counts (Tool calls 4 · File edits 1 ·
--     Bash 1 · Read 2) have to be a GROUP BY. Inside a body they would mean
--     parsing a blob per Session, and board-level filters would full-scan.
--   * A tool `result` is the largest payload in a Session — a read of a big
--     file, a verbose test run. Spilling it independently of the row is what
--     actually keeps rows under the storage row cap.
--   * `arguments` and `result` are the highest-risk content for secrets, so
--     redaction needs them individually addressable.
CREATE TABLE IF NOT EXISTS tool_call (
    id             TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL REFERENCES agent_session(id) ON DELETE CASCADE,
    seq            INTEGER NOT NULL,
    turn_seq       INTEGER NOT NULL,
    -- The agent's own id for the call — the idempotency key across the
    -- first-sighting event and every later update.
    native_call_id TEXT,
    -- Derived, not handed over: the wire has no canonical tool name. Grouping by
    -- the raw wire value would produce one bucket per file the agent touched.
    tool_name      TEXT NOT NULL,
    -- The human display string, kept separately so the detail view can show what
    -- the agent called it without the facet counts inheriting the churn.
    title          TEXT,
    kind           TEXT,
    status         TEXT NOT NULL,
    locations      TEXT NOT NULL DEFAULT '[]',
    arguments      TEXT,
    arguments_ref  TEXT,
    result         TEXT,
    result_ref     TEXT,
    -- A non-UTF8 result (a compiled binary, an image) is stored verbatim and
    -- skipped by string redaction rather than lossily decoded and corrupted.
    result_binary  INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    sync_state     TEXT NOT NULL DEFAULT 'local',
    sync_attempts  INTEGER NOT NULL DEFAULT 0,

    UNIQUE (session_id, seq)
);

-- The derived subset produced by file-writing calls. A shell command or a file
-- read yields neither this nor an edit patch, which is exactly why they cannot
-- stand in for a general tool-call record.
--
-- `existed_before` and `sha256_after` are captured at write time and are
-- unrecoverable afterwards: by the time a commit lands the file exists either
-- way, and the agent's version has been overwritten. The asymmetric link rule
-- is built entirely on those two facts.
CREATE TABLE IF NOT EXISTS file_touch (
    id             TEXT PRIMARY KEY,
    tool_call_id   TEXT NOT NULL REFERENCES tool_call(id) ON DELETE CASCADE,
    session_id     TEXT NOT NULL REFERENCES agent_session(id) ON DELETE CASCADE,
    turn_seq       INTEGER NOT NULL,
    seq            INTEGER NOT NULL,
    -- NFC-normalised, workspace-relative. macOS hands back NFD while git stores
    -- NFC, and a byte comparison of the two fails silently.
    path           TEXT NOT NULL,
    sha256_after   TEXT,
    existed_before INTEGER NOT NULL,
    deleted        INTEGER NOT NULL DEFAULT 0,
    -- Written outside the Workspace root. Can never match a commit, and is
    -- flagged so it is not counted as pending agent work forever.
    out_of_repo    INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL
);

-- Attribution's input. The metric — the agent-versus-human line split — is a
-- pure function over stored rows and can be computed and backfilled whenever;
-- the patch cannot be recaptured once the Session ends and the file moves on.
CREATE TABLE IF NOT EXISTS agent_edit (
    id           TEXT PRIMARY KEY,
    tool_call_id TEXT NOT NULL REFERENCES tool_call(id) ON DELETE CASCADE,
    session_id   TEXT NOT NULL REFERENCES agent_session(id) ON DELETE CASCADE,
    turn_seq     INTEGER NOT NULL,
    path         TEXT NOT NULL,
    patch        TEXT,
    patch_ref    TEXT,
    created_at   TEXT NOT NULL
);

-- The sidebar's per-kind counts.
CREATE INDEX IF NOT EXISTS idx_tool_call_facets
    ON tool_call (session_id, tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_call_session_seq
    ON tool_call (session_id, seq);
CREATE INDEX IF NOT EXISTS idx_tool_call_outbox
    ON tool_call (sync_state, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_call_native_id
    ON tool_call (session_id, native_call_id)
    WHERE native_call_id IS NOT NULL;

-- The link rule's lookup: every path a Session touched.
CREATE INDEX IF NOT EXISTS idx_file_touch_path
    ON file_touch (session_id, path);
-- …and the reverse, which is what turns an observed commit into candidate
-- Sessions without scanning every Session in the Workspace.
CREATE INDEX IF NOT EXISTS idx_file_touch_by_path
    ON file_touch (path);
CREATE INDEX IF NOT EXISTS idx_agent_edit_session
    ON agent_edit (session_id, turn_seq);
"#;

const V3: &str = r#"
-- The slice of one Session whose work landed in one git commit.
--
-- Identified by the (Session, commit) pair, and that pair is the point: two
-- Sessions contributing to one commit produce two Checkpoints sharing the
-- commit, not one Checkpoint with two owners. One Session spanning five commits
-- produces five. The pair is also the idempotency key, so re-running the walk
-- over commits already seen is a no-op.
--
-- A Checkpoint carries no transcript of its own. The Messages remain the single
-- copy — a relational store has no need of the self-contained snapshots that a
-- git-stored checkpoint requires in order to survive a rebase.
CREATE TABLE IF NOT EXISTS checkpoint (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES agent_session(id) ON DELETE CASCADE,
    -- May change: a rewrite re-points this at the new commit carrying the same
    -- change.
    commit_sha      TEXT NOT NULL,
    -- Stable across rebase and amend, because it hashes the diff rather than the
    -- commit. Null for an empty diff, which never participates in matching.
    patch_id        TEXT,
    link_state      TEXT NOT NULL DEFAULT 'linked',
    -- Empty on a detached HEAD. The timeline's branch filter simply does not
    -- claim those Checkpoints.
    branch          TEXT,
    -- Verbatim from the commit, display-only. This is the identity ON the
    -- commit, which is a different fact from the Atlas account whose agent ran:
    -- pairing, rebasing a colleague's branch and bot commits all diverge. There
    -- is deliberately no mapping from git email to Organisation member — git
    -- emails are self-asserted and never verified, so treating one as proof of
    -- identity would let anyone render commits as a colleague.
    git_author_name  TEXT,
    git_author_email TEXT,
    files_touched   TEXT NOT NULL DEFAULT '[]',
    insertions      INTEGER NOT NULL DEFAULT 0,
    deletions       INTEGER NOT NULL DEFAULT 0,
    -- The agent-versus-human line split. Stays null: this feature captures the
    -- inputs and does not compute the metric, which is a pure function over
    -- stored rows and can be backfilled across every existing Checkpoint later.
    attribution     TEXT,
    created_at      TEXT NOT NULL,
    sync_state      TEXT NOT NULL DEFAULT 'local',
    sync_attempts   INTEGER NOT NULL DEFAULT 0,

    UNIQUE (session_id, commit_sha)
);

-- How far the commit walk has got, per Workspace. Advanced only after the
-- Checkpoints for a range are durably written, so a crash mid-walk re-processes
-- rather than skips.
CREATE TABLE IF NOT EXISTS workspace_cursor (
    workspace_id     TEXT PRIMARY KEY,
    last_seen_commit TEXT,
    -- Set when the cursor could not be resolved and a bounded re-scan was used
    -- instead. Surfaces through the capture-health signal, because a Workspace
    -- that silently stopped detecting commits is the failure this whole design
    -- exists to avoid.
    recovered        INTEGER NOT NULL DEFAULT 0,
    updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_checkpoint_commit
    ON checkpoint (commit_sha);
CREATE INDEX IF NOT EXISTS idx_checkpoint_session
    ON checkpoint (session_id);
CREATE INDEX IF NOT EXISTS idx_checkpoint_patch
    ON checkpoint (patch_id);
CREATE INDEX IF NOT EXISTS idx_checkpoint_outbox
    ON checkpoint (sync_state);
"#;

const V4: &str = r#"
-- How this Workspace is bound, and whether it is capturing at all.
--
-- One row: a store belongs to exactly one Workspace, so `id = 1` is a
-- singleton, enforced by the CHECK rather than by convention.
--
-- The identity signals are evidence, never gates. A repository with no remote,
-- a shallow clone whose grafted boundary is not the true root, a squashed
-- history, a fresh repository joining existing work — every one of those is a
-- legitimate repository someone actually has, and every one of them would be
-- locked out by treating a fingerprint as proof. They pre-select and they warn.
CREATE TABLE IF NOT EXISTS binding (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    workspace_id    TEXT NOT NULL,
    root            TEXT NOT NULL,
    mode            TEXT NOT NULL DEFAULT 'local',
    -- Set once the Workspace is registered to an Organisation.
    slug            TEXT,
    org_id          TEXT,
    -- Advisory. Null for a non-git Workspace, or one with no commits yet.
    root_commit_sha TEXT,
    -- The grafted boundary of a shallow clone is not the true root, so the
    -- fingerprint it yields is stored but flagged as not authoritative.
    fingerprint_is_shallow INTEGER NOT NULL DEFAULT 0,
    -- Advisory, normalised. Null when there is no remote — which binds fine.
    git_url         TEXT,
    -- Disabling stops new records without deleting existing ones.
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
"#;

const V5: &str = r#"
-- Per-file import progress, so a multi-hundred-megabyte backfill resumes rather
-- than restarts when Atlas is closed mid-import.
--
-- Keyed on size rather than a line offset: a transcript that has not grown has
-- nothing new, which is the cheap check that makes the ongoing watch affordable
-- to run on every tick. A file that HAS grown is re-read from the start, which
-- is safe because every turn carries the agent's own message id and re-recording
-- one is a no-op.
CREATE TABLE IF NOT EXISTS import_progress (
    path          TEXT PRIMARY KEY,
    imported_size INTEGER NOT NULL,
    updated_at    TEXT NOT NULL
);
"#;

const V6: &str = r#"
-- The Cloud bulk-import disclosure is a real gate, not ceremony: the background
-- transcript scan must refuse to import for a Cloud Workspace until the user has
-- explicitly confirmed the disclosure. Local needs no approval and the flag is
-- set at enable time.
ALTER TABLE binding ADD COLUMN import_approved INTEGER NOT NULL DEFAULT 0;

-- 'ok' or 'not_authorized'. Losing Organisation membership is a terminal state
-- the drain must remember across ticks and restarts — not an infinite 30-second
-- retry loop — and the capture-health signal needs to render it.
ALTER TABLE binding ADD COLUMN drain_state TEXT NOT NULL DEFAULT 'ok';

-- The server-assigned Workspace id from registration. The wire identity of every
-- artifact: without it two teammates' pushes can never converge on one timeline,
-- and the local filesystem path would leak to the whole Organisation.
ALTER TABLE binding ADD COLUMN remote_workspace_id TEXT;

-- Link-rule consumption. Once a commit has carried a touch's work, that touch is
-- spent: without this, a Session's touches link every future commit that happens
-- to modify the same path — for the lifetime of the store — and human work gets
-- confidently attributed to a long-dead Session.
ALTER TABLE file_touch ADD COLUMN consumed_by_commit TEXT;

CREATE INDEX IF NOT EXISTS idx_file_touch_unconsumed
    ON file_touch (session_id, path)
    WHERE consumed_by_commit IS NULL;

-- What the last reconciliation pass did, as a small JSON note. A history-wide
-- rewrite that orphans half the timeline must surface through the capture-health
-- signal, not vanish into a log file.
ALTER TABLE workspace_cursor ADD COLUMN reconcile_note TEXT;
"#;

/// Index names the store guarantees. Exposed so a test can assert they survived
/// a migration — an index silently dropped is a full scan nobody notices until
/// a developer with a year of history opens the board.
pub const REQUIRED_INDEXES: &[&str] = &[
    "idx_session_outbox",
    "idx_message_outbox",
    "idx_message_session_seq",
    "idx_message_facets",
    "idx_message_native_id",
    "idx_session_started",
    "idx_tool_call_facets",
    "idx_tool_call_session_seq",
    "idx_tool_call_outbox",
    "idx_tool_call_native_id",
    "idx_file_touch_path",
    "idx_file_touch_by_path",
    "idx_agent_edit_session",
    "idx_checkpoint_commit",
    "idx_checkpoint_session",
    "idx_checkpoint_patch",
    "idx_checkpoint_outbox",
    "idx_file_touch_unconsumed",
];

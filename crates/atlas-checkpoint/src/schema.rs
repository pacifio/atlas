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
///
/// A note on 9: it existed twice. Unreleased 0.3.0-x dev builds stamped 9 for
/// one additive nullable column (`import_progress.resume_state`, an
/// import-resume cache that moved to a sidecar file), and that number was
/// withdrawn; the real V9 (`file_touch.sketch_after`) then reused it. A store
/// stamped 9 may therefore be either shape, which is why `migrate` re-runs V9
/// tolerantly on a 9 rather than trusting the stamp — see the comment there.
pub const SCHEMA_VERSION: i64 = 13;

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
        if found < 8 {
            // Same tolerance again: one ALTER TABLE, two indexes, and three
            // repair statements that are all safe to re-run.
            apply_tolerant(conn, V8)?;
        }
        if found <= 9 {
            // One ALTER TABLE; tolerant for the same reason as V7/V8 — and
            // `<=` rather than `<` on purpose. A store stamped 9 may be the
            // withdrawn dev-only 9 (an orphan `import_progress.resume_state`
            // column and NO `file_touch.sketch_after`), which an earlier build
            // re-stamped as the real 9 without ever running this migration.
            // Re-running it is what repairs those stores: the tolerant apply
            // skips the column where it already exists and adds it where it
            // does not. The orphan column is harmless and stays.
            apply_tolerant(conn, V9)?;
        }
        if found < 10 {
            conn.execute_batch(V10)?;
        }
        if found < 11 {
            // One ALTER TABLE and a backfill, both safe to re-run.
            apply_tolerant(conn, V11)?;
        }
        if found < 12 {
            conn.execute_batch(V12)?;
        }
        if found < 13 {
            conn.execute_batch(V13)?;
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

const V8: &str = r#"
-- When the Session last did work, as opposed to when its row was last written.
--
-- `updated_at` is stamped with the wall clock by every write there is: an
-- upsert, a title derivation, a token update, an import. The Timeline read it
-- as the end of the Session and got `updated_at - started_at` as a duration,
-- so a transcript that ran in June and was imported in July reported 1395
-- hours, and the day grouping filed a year of history under Today. Activity
-- and mutation are two different facts and now live in two different columns.
ALTER TABLE agent_session ADD COLUMN last_activity_at TEXT;

-- Backfill from the only timestamps in the store that were never the wall clock
-- at write time: a message carries the transcript's own stamp, and a turn ends
-- when the turn ended.
UPDATE agent_session SET last_activity_at = (
    SELECT MAX(stamp) FROM (
        SELECT MAX(created_at) AS stamp FROM agent_message WHERE session_id = agent_session.id
        UNION ALL
        SELECT MAX(ended_at) AS stamp FROM turn WHERE session_id = agent_session.id
    )
);

-- A Session with no message and no closed turn has nothing better to offer.
UPDATE agent_session SET last_activity_at = updated_at WHERE last_activity_at IS NULL;

-- Board ordering and day bucketing.
CREATE INDEX IF NOT EXISTS idx_session_activity
    ON agent_session (workspace_id, last_activity_at);

-- Covers the gap-capped active-time scan, which reads (session_id, created_at)
-- and nothing else.
CREATE INDEX IF NOT EXISTS idx_message_activity
    ON agent_message (session_id, created_at);

-- Re-read every transcript once. Token usage was never parsed out of the JSONL,
-- so every imported Session carries an empty total — and progress is keyed on
-- file size, which means a naive re-run skips the entire corpus. Clearing this
-- is the whole token backfill. Re-reading is idempotent: every line carries the
-- agent's own message id, and the usage write is a replace rather than a sum.
DELETE FROM import_progress;
"#;

const V9: &str = r#"
-- A bounded fingerprint of what the agent wrote, for the link rule's strict arm.
--
-- That arm governs files the agent *created*, and it used to require the
-- committed blob to equal the agent's bytes exactly. The everyday loop — agent
-- scaffolds a file, developer adjusts a line while reviewing, commits — failed
-- that test, so the Checkpoint silently never appeared.
--
-- `sha256_after` alone cannot answer "how much of this survived", and keeping
-- whole files would mirror the worktree into sessions.db. This column stores a
-- bottom-k sample of the content's distinct line hashes instead (see
-- `sketch.rs`), which is bounded and comparable.
--
-- Nullable and NOT backfilled: the content it summarises is long gone for
-- existing rows. A NULL sketch falls back to the exact-hash comparison, so old
-- Sessions behave exactly as they did before this migration.
ALTER TABLE file_touch ADD COLUMN sketch_after TEXT;
"#;

const V10: &str = r#"
-- The per-turn usage ledger.
--
-- `agent_session.token_totals` is ONE cumulative figure per Session, so a
-- Session that ran for a week could only ever be dated to the day it was last
-- active. This table records what each turn ADDED: the difference between two
-- consecutive cumulative reports, attributed to the turn that was open when
-- the report arrived. One row per (Session, turn), summed in place, because a
-- cumulative report lands several times within one turn (after every model
-- call) and each of those is a further increment to the same turn.
--
-- `usage_cursor` is the last cumulative figure the ledger has seen, per
-- Session. It is kept apart from `token_totals` on purpose: the importer
-- overwrites `token_totals` wholesale (`replace_usage_totals`) with what it
-- parsed out of the transcript, and a live delta computed against THAT figure
-- would be garbage. The cursor only ever moves when a live report arrives.
--
-- Reasoning tokens are carried but never priced or added to a total -- every
-- provider that reports them already counts them inside output_tokens.
CREATE TABLE IF NOT EXISTS usage_delta (
    session_id            TEXT NOT NULL REFERENCES agent_session(id) ON DELETE CASCADE,
    turn_seq              INTEGER NOT NULL,
    model                 TEXT,
    recorded_at           TEXT NOT NULL,
    input_tokens          INTEGER NOT NULL DEFAULT 0,
    output_tokens         INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, turn_seq)
);

CREATE TABLE IF NOT EXISTS usage_cursor (
    session_id            TEXT PRIMARY KEY REFERENCES agent_session(id) ON DELETE CASCADE,
    input_tokens          INTEGER NOT NULL DEFAULT 0,
    output_tokens         INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens      INTEGER NOT NULL DEFAULT 0
);

-- The dashboard's "ledger since" figure, and any date-ranged read.
CREATE INDEX IF NOT EXISTS idx_usage_delta_recorded
    ON usage_delta (recorded_at);
"#;

const V13: &str = r#"
-- Findings a developer marked "Not useful" (ATL-985). Keyed by the finding's
-- fingerprint, which is stable across commits, so one mark covers the same
-- issue on the same line wherever it is seen again. Local only: these are
-- the labels that measure the scanner's false alarms.
CREATE TABLE IF NOT EXISTS security_label (
    fingerprint     TEXT PRIMARY KEY,
    rule_id         TEXT NOT NULL,
    scanner_version TEXT NOT NULL,
    created_at      TEXT NOT NULL
);
"#;
const V12: &str = r#"
-- Security scans of a Checkpoint's commit (ATL-985), one row per Checkpoint
-- and scanner version. A new scanner version rescans, so its rules and
-- thresholds are always judged against their own results. The row is local:
-- there is no sync_state, so the outbox drain never sees it.
CREATE TABLE IF NOT EXISTS checkpoint_scan (
    checkpoint_id   TEXT NOT NULL REFERENCES checkpoint(id) ON DELETE CASCADE,
    scanner_version TEXT NOT NULL,
    status          TEXT NOT NULL,
    level           TEXT NOT NULL,
    blocking        INTEGER NOT NULL,
    result_json     TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    PRIMARY KEY (checkpoint_id, scanner_version)
);

-- Small per-Project facts the scanner keeps, such as when scanning began.
CREATE TABLE IF NOT EXISTS security_scan_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;
const V11: &str = r#"
-- When a Session was flagged, apart from when its record last changed.
-- Capture health counts recent flags, and `updated_at` moves with every prompt
-- and message, so a Session flagged weeks ago that is still in use would keep
-- counting as freshly flagged and hold the Project's health down for as long
-- as anyone worked in it.
ALTER TABLE agent_session ADD COLUMN flagged_at TEXT;

-- Flags from before this column: the last change is the closest thing to the
-- flag's time there is, and it can only be later than the flag, so these age
-- out of the window no later than they would have.
UPDATE agent_session SET flagged_at = updated_at
 WHERE needs_attention = 1 AND flagged_at IS NULL;
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

-- The outbox drain: pending rows in sequence order, per project.
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

-- Timeline ordering across a Project.
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
    -- NFC-normalised, project-relative. macOS hands back NFD while git stores
    -- NFC, and a byte comparison of the two fails silently.
    path           TEXT NOT NULL,
    sha256_after   TEXT,
    existed_before INTEGER NOT NULL,
    deleted        INTEGER NOT NULL DEFAULT 0,
    -- Written outside the Project root. Can never match a commit, and is
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
-- Sessions without scanning every Session in the Project.
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

-- How far the commit walk has got, per Project. Advanced only after the
-- Checkpoints for a range are durably written, so a crash mid-walk re-processes
-- rather than skips.
CREATE TABLE IF NOT EXISTS workspace_cursor (
    workspace_id     TEXT PRIMARY KEY,
    last_seen_commit TEXT,
    -- Set when the cursor could not be resolved and a bounded re-scan was used
    -- instead. Surfaces through the capture-health signal, because a Project
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
-- How this Project is bound, and whether it is capturing at all.
--
-- One row: a store belongs to exactly one Project, so `id = 1` is a
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
    -- Set once the Project is registered to an Organisation.
    slug            TEXT,
    org_id          TEXT,
    -- Advisory. Null for a non-git Project, or one with no commits yet.
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
-- transcript scan must refuse to import for a Cloud Project until the user has
-- explicitly confirmed the disclosure. Local needs no approval and the flag is
-- set at enable time.
ALTER TABLE binding ADD COLUMN import_approved INTEGER NOT NULL DEFAULT 0;

-- 'ok' or 'not_authorized'. Losing Organisation membership is a terminal state
-- the drain must remember across ticks and restarts — not an infinite 30-second
-- retry loop — and the capture-health signal needs to render it.
ALTER TABLE binding ADD COLUMN drain_state TEXT NOT NULL DEFAULT 'ok';

-- The server-assigned Project id from registration. The wire identity of every
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
    "idx_session_activity",
    "idx_message_activity",
    "idx_usage_delta_recorded",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let names: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        names.iter().any(|n| n == column)
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

    /// A store stamped with the withdrawn dev-only 9 (see the note on
    /// `SCHEMA_VERSION`) has the orphan `import_progress.resume_state` column
    /// and never ran the real V9. It must reach the current version with BOTH
    /// the real V9 column and the V10 tables, and must not trip the too-new
    /// gate — that gate once locked every older build out of the store, which
    /// read as total capture loss.
    #[test]
    fn a_store_stamped_with_the_withdrawn_schema_9_is_repaired_to_the_current_version() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap(); // fresh store at the current version
        if !has_column(&conn, "import_progress", "resume_state") {
            conn.execute_batch("ALTER TABLE import_progress ADD COLUMN resume_state TEXT")
                .unwrap();
        }
        // Simulate the withdrawn shape as closely as an in-memory store can:
        // drop the real V9 column and the V10 tables, then stamp 9.
        conn.execute_batch("ALTER TABLE file_touch DROP COLUMN sketch_after")
            .unwrap();
        conn.execute_batch("DROP TABLE usage_delta; DROP TABLE usage_cursor;")
            .unwrap();
        conn.pragma_update(None, "user_version", 9).unwrap();
        assert!(!has_column(&conn, "file_touch", "sketch_after"));

        migrate(&conn).expect("the withdrawn version must not read as too-new");
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        assert!(
            has_column(&conn, "file_touch", "sketch_after"),
            "the real V9 ran"
        );
        assert!(has_table(&conn, "usage_delta"), "V10 ran");
        assert!(has_table(&conn, "usage_cursor"), "V10 ran");

        // Running again on a genuine current-version store is a no-op.
        migrate(&conn).unwrap();

        // A genuinely newer store still refuses.
        conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        assert!(matches!(
            migrate(&conn),
            Err(Error::SchemaTooNew { found, .. }) if found == SCHEMA_VERSION + 1
        ));
    }

    #[test]
    fn a_fresh_store_has_the_ledger_tables() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        assert!(has_table(&conn, "usage_delta"));
        assert!(has_table(&conn, "usage_cursor"));
        for column in [
            "session_id",
            "turn_seq",
            "model",
            "recorded_at",
            "input_tokens",
            "output_tokens",
            "cache_creation_tokens",
            "cache_read_tokens",
            "reasoning_tokens",
        ] {
            assert!(has_column(&conn, "usage_delta", column), "{column}");
        }
        let idx: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_usage_delta_recorded'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(idx, 1);
    }

    // ── Upgrades from every older version ──────────────────────────────────

    /// Every migration, in order, as the arm in `migrate` applies it on a
    /// fresh database. Index `n - 1` is the SQL that takes a store to `n`.
    const STEPS: [&str; 13] = [V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11, V12, V13];

    /// A connection holding exactly the schema an older build left behind:
    /// V1..=`version` applied and `version` stamped.
    fn seeded_at(conn: &Connection, version: i64) {
        for sql in &STEPS[..version as usize] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", version).unwrap();
    }

    const T0: &str = "2026-06-01T10:00:00+00:00";
    const T1: &str = "2026-06-01T10:05:00+00:00";

    /// Representative rows for every table that exists at `version`, filling
    /// the columns a later migration added only when they already exist.
    fn seed_rows(conn: &Connection, version: i64) {
        conn.execute_batch(&format!(
            "INSERT INTO agent_session (id, workspace_id, source, native_session_id, title, \
                 started_at, updated_at, token_totals) \
             VALUES ('s1', 'ws', 'acp', 'native-1', 'Old title', '{T0}', '2026-07-01T00:00:00+00:00', \
                 '{{\"input_tokens\":7}}'); \
             INSERT INTO agent_message (id, session_id, seq, turn_seq, native_message_id, role, \
                 mode, preview, body, content_hash, created_at) \
             VALUES ('m1', 's1', 1, 1, 'n1', 'user', 'text', 'hello', 'hello', 'h1', '{T0}'), \
                    ('m2', 's1', 2, 1, 'n2', 'assistant', 'text', 'hi', 'hi', 'h2', '{T1}'); \
             INSERT INTO turn (session_id, turn_seq, state, started_at, ended_at) \
             VALUES ('s1', 1, 'completed', '{T0}', '{T1}'); \
             UPDATE counter SET value = 2 WHERE name = 'seq';"
        ))
        .unwrap();
        if version >= 2 {
            conn.execute_batch(&format!(
                "INSERT INTO tool_call (id, session_id, seq, turn_seq, native_call_id, tool_name, \
                     status, created_at) \
                 VALUES ('tc1', 's1', 3, 1, 'call-1', 'write', 'completed', '{T1}'); \
                 INSERT INTO file_touch (id, tool_call_id, session_id, turn_seq, seq, path, \
                     sha256_after, existed_before, created_at) \
                 VALUES ('ft1', 'tc1', 's1', 1, 4, 'src/lib.rs', 'abc', 0, '{T1}'); \
                 INSERT INTO agent_edit (id, tool_call_id, session_id, turn_seq, path, patch, created_at) \
                 VALUES ('ae1', 'tc1', 's1', 1, 'src/lib.rs', '+fn x() {{}}', '{T1}');"
            ))
            .unwrap();
        }
        if version >= 3 {
            conn.execute_batch(&format!(
                "INSERT INTO checkpoint (id, session_id, commit_sha, patch_id, branch, created_at) \
                 VALUES ('cp1', 's1', 'deadbeef', 'p1', 'main', '{T1}'); \
                 INSERT INTO workspace_cursor (workspace_id, last_seen_commit, updated_at) \
                 VALUES ('ws', 'deadbeef', '{T1}');"
            ))
            .unwrap();
        }
        if version >= 4 {
            conn.execute_batch(&format!(
                "INSERT INTO binding (id, workspace_id, root, mode, created_at, updated_at) \
                 VALUES (1, 'ws', '/tmp/project', 'local', '{T0}', '{T0}');"
            ))
            .unwrap();
        }
        if version >= 5 {
            conn.execute_batch(&format!(
                "INSERT INTO import_progress (path, imported_size, updated_at) \
                 VALUES ('/tmp/t.jsonl', 42, '{T0}');"
            ))
            .unwrap();
        }
        if version >= 6 {
            conn.execute_batch(
                "UPDATE binding SET import_approved = 1, remote_workspace_id = 'remote-ws'; \
                 UPDATE file_touch SET consumed_by_commit = 'deadbeef';",
            )
            .unwrap();
        }
        if version >= 7 {
            conn.execute_batch("UPDATE agent_session SET branch = 'feature';")
                .unwrap();
        }
        if version >= 9 {
            conn.execute_batch("UPDATE file_touch SET sketch_after = 'sketch';")
                .unwrap();
        }
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    /// `(type, name)` for every table and index, plus each table's columns —
    /// the whole shape of a store, comparable between two databases.
    fn shape(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare(
                "SELECT type, name FROM sqlite_master \
                 WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
            )
            .unwrap();
        let objects: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let mut out = Vec::new();
        for (kind, name) in objects {
            out.push(format!("{kind} {name}"));
            if kind == "table" {
                let mut cols = conn.prepare(&format!("PRAGMA table_info({name})")).unwrap();
                let cols: Vec<String> = cols
                    .query_map([], |r| {
                        Ok(format!(
                            "  {name}.{} {} notnull={} default={:?} pk={}",
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, i64>(3)?,
                            r.get::<_, Option<String>>(4)?,
                            r.get::<_, i64>(5)?,
                        ))
                    })
                    .unwrap()
                    .collect::<rusqlite::Result<_>>()
                    .unwrap();
                out.extend(cols);
            }
        }
        out
    }

    fn version_of(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap()
    }

    /// A store written by every older build upgrades to exactly the shape a
    /// fresh store has, and keeps its rows. The shape comparison is what
    /// catches a migration that was edited after it shipped: a fresh store and
    /// an upgraded one would then disagree.
    #[test]
    fn a_store_seeded_at_every_older_version_upgrades_to_the_current_shape_with_its_rows() {
        let fresh = Connection::open_in_memory().unwrap();
        migrate(&fresh).unwrap();
        let fresh_shape = shape(&fresh);

        for version in 1..SCHEMA_VERSION {
            let conn = Connection::open_in_memory().unwrap();
            conn.pragma_update(None, "foreign_keys", "ON").unwrap();
            seeded_at(&conn, version);
            seed_rows(&conn, version);

            migrate(&conn).unwrap_or_else(|e| panic!("upgrade from V{version}: {e}"));
            assert_eq!(version_of(&conn), SCHEMA_VERSION, "from V{version}");
            assert_eq!(shape(&conn), fresh_shape, "from V{version}");
            for index in REQUIRED_INDEXES {
                let n: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
                        [index],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(n, 1, "{index} missing after upgrade from V{version}");
            }

            // V1 rows, byte for byte.
            let (title, totals): (String, String) = conn
                .query_row(
                    "SELECT title, token_totals FROM agent_session WHERE id = 's1'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(title, "Old title", "from V{version}");
            assert_eq!(totals, r#"{"input_tokens":7}"#, "from V{version}");
            assert_eq!(count(&conn, "agent_message"), 2, "from V{version}");
            assert_eq!(count(&conn, "turn"), 1, "from V{version}");
            let seq: i64 = conn
                .query_row("SELECT value FROM counter WHERE name = 'seq'", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(
                seq, 2,
                "the sequence source must not reset (from V{version})"
            );

            if version >= 2 {
                assert_eq!(count(&conn, "tool_call"), 1, "from V{version}");
                assert_eq!(count(&conn, "file_touch"), 1, "from V{version}");
                assert_eq!(count(&conn, "agent_edit"), 1, "from V{version}");
            }
            if version >= 3 {
                assert_eq!(count(&conn, "checkpoint"), 1, "from V{version}");
                assert_eq!(count(&conn, "workspace_cursor"), 1, "from V{version}");
            }
            if version >= 4 {
                let (root, approved, drain): (String, i64, String) = conn
                    .query_row(
                        "SELECT root, import_approved, drain_state FROM binding",
                        [],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .unwrap();
                assert_eq!(root, "/tmp/project");
                // V6's defaults for a binding that predates it; the seeded
                // value for one that does not.
                assert_eq!(approved, i64::from(version >= 6), "from V{version}");
                assert_eq!(drain, "ok");
            }

            // V8 deliberately clears import progress once, to force the token
            // backfill; a store already past V8 keeps it.
            if version >= 5 {
                let expected = if version < 8 { 0 } else { 1 };
                assert_eq!(count(&conn, "import_progress"), expected, "from V{version}");
            }

            // V8's backfill: the latest message or turn-end stamp, never the
            // row's wall-clock `updated_at`.
            if version < 8 {
                let activity: String = conn
                    .query_row(
                        "SELECT last_activity_at FROM agent_session WHERE id = 's1'",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(activity, T1, "from V{version}");
            }

            // Columns added after the seed version read as their defaults,
            // columns that existed keep their values.
            let branch: Option<String> = conn
                .query_row(
                    "SELECT branch FROM agent_session WHERE id = 's1'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                branch.as_deref(),
                (version >= 7).then_some("feature"),
                "from V{version}"
            );
            if version >= 2 {
                let (consumed, sketch): (Option<String>, Option<String>) = conn
                    .query_row(
                        "SELECT consumed_by_commit, sketch_after FROM file_touch",
                        [],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .unwrap();
                assert_eq!(consumed.as_deref(), (version >= 6).then_some("deadbeef"));
                assert_eq!(sketch.as_deref(), (version >= 9).then_some("sketch"));
            }

            let fk_violations: i64 = conn
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(fk_violations, 0, "from V{version}");

            // Idempotent once current.
            migrate(&conn).unwrap();
            assert_eq!(version_of(&conn), SCHEMA_VERSION);
        }
    }

    /// An upgraded store is readable through the real `Store`, not only through
    /// raw SQL: the model decoders accept the old rows with the new columns
    /// defaulted.
    #[test]
    fn a_store_upgraded_from_v1_opens_and_reads_through_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let atlas = dir.path().join(".atlas");
        std::fs::create_dir_all(&atlas).unwrap();
        {
            let conn = Connection::open(atlas.join("sessions.db")).unwrap();
            seeded_at(&conn, 1);
            seed_rows(&conn, 1);
        }

        let store = crate::Store::open(&atlas).expect("an old store opens");
        let sessions = store.sessions_for_project("ws").unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title.as_deref(), Some("Old title"));
        assert_eq!(sessions[0].branch, None);
        let bodies: Vec<String> = store
            .messages_for_session("s1")
            .unwrap()
            .iter()
            .map(|m| store.message_body(m).unwrap())
            .collect();
        assert_eq!(bodies, ["hello", "hi"]);
        assert_eq!(
            store.turn_state("s1", 1).unwrap(),
            Some(crate::TurnState::Completed)
        );
    }

    // ── Half-applied migrations ────────────────────────────────────────────

    /// The case the tolerant apply exists for: an earlier build ran some of a
    /// migration's ALTERs outside a transaction and died before stamping the
    /// version, so the store has the new columns at the old number. Every
    /// re-run used to fail with "duplicate column name".
    #[test]
    fn a_half_applied_alter_migration_is_completed_rather_than_wedged() {
        // (stamped version, the statements that had already run)
        let tears: &[(i64, &str)] = &[
            (
                5,
                "ALTER TABLE binding ADD COLUMN import_approved INTEGER NOT NULL DEFAULT 0; \
                 ALTER TABLE binding ADD COLUMN drain_state TEXT NOT NULL DEFAULT 'ok';",
            ),
            (6, "ALTER TABLE agent_session ADD COLUMN branch TEXT;"),
            (
                7,
                "ALTER TABLE agent_session ADD COLUMN last_activity_at TEXT;",
            ),
            (8, "ALTER TABLE file_touch ADD COLUMN sketch_after TEXT;"),
        ];
        let fresh = Connection::open_in_memory().unwrap();
        migrate(&fresh).unwrap();

        for (stamped, already_ran) in tears {
            let conn = Connection::open_in_memory().unwrap();
            seeded_at(&conn, *stamped);
            seed_rows(&conn, *stamped);
            conn.execute_batch(already_ran).unwrap();

            migrate(&conn).unwrap_or_else(|e| panic!("torn V{}: {e}", stamped + 1));
            assert_eq!(version_of(&conn), SCHEMA_VERSION);
            assert_eq!(shape(&conn), shape(&fresh), "torn V{}", stamped + 1);
            assert_eq!(count(&conn, "agent_message"), 2);
        }
    }

    /// Tolerance is for exactly one error. Anything else still fails the
    /// migration, and the transaction rolls it back whole — no column added
    /// with the version still behind, which is the wedge the transaction
    /// exists to prevent.
    #[test]
    fn a_real_failure_mid_migration_rolls_back_every_step() {
        let conn = Connection::open_in_memory().unwrap();
        seeded_at(&conn, 6);
        seed_rows(&conn, 6);
        // A view squatting on a V10 table name: V10's `CREATE TABLE IF NOT
        // EXISTS` is a no-op against it, and its index then cannot be built.
        conn.execute_batch("CREATE VIEW usage_delta AS SELECT 1 AS recorded_at;")
            .unwrap();

        let err = migrate(&conn).expect_err("a genuine failure must surface");
        assert!(matches!(err, Error::Storage(_)), "{err:?}");
        assert_eq!(version_of(&conn), 6);
        assert!(
            !has_column(&conn, "agent_session", "branch"),
            "V7 rolled back"
        );
        assert!(
            !has_column(&conn, "agent_session", "last_activity_at"),
            "V8 rolled back"
        );
        assert!(
            !has_column(&conn, "file_touch", "sketch_after"),
            "V9 rolled back"
        );
        assert_eq!(
            count(&conn, "import_progress"),
            1,
            "V8's DELETE rolled back"
        );
    }

    #[test]
    fn the_tolerant_apply_skips_duplicate_columns_and_nothing_else() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (a TEXT);").unwrap();
        apply_tolerant(
            &conn,
            "ALTER TABLE t ADD COLUMN a TEXT; ALTER TABLE t ADD COLUMN b TEXT;",
        )
        .unwrap();
        assert!(has_column(&conn, "t", "b"));
        assert!(apply_tolerant(&conn, "ALTER TABLE missing ADD COLUMN c TEXT;").is_err());
    }

    /// `apply_tolerant` splits on a bare `;`, so a semicolon inside a comment
    /// of any tolerant migration would feed half a comment to SQLite. Checked
    /// here rather than trusted to review.
    #[test]
    fn no_tolerant_migration_has_a_semicolon_in_a_comment() {
        for (name, sql) in [("V6", V6), ("V7", V7), ("V8", V8), ("V9", V9)] {
            for line in sql.lines() {
                if let Some(comment) = line.trim_start().strip_prefix("--") {
                    assert!(!comment.contains(';'), "{name}: {line}");
                }
            }
        }
    }
}

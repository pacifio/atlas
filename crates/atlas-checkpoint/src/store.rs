//! The local store: `.atlas/sessions.db` plus its blob sidecar.
//!
//! `.atlas/` is the established per-project state directory — auto-gitignored,
//! already used by a dozen features — but this is the first SQLite database
//! Atlas has ever created, so WAL setup, versioning and corruption handling are
//! established here.
//!
//! Two properties are worth stating because everything else follows from them:
//!
//! * **The store is on the critical path; the network is not.** Nothing in this
//!   module can block on a network call, because Local mode and offline capture
//!   are the same code path as everything else.
//! * **One turn is one transaction.** A crash mid-write rolls back to the last
//!   completed turn rather than leaving a torn record that reads as finished.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension};

use crate::blobs::{self, BlobStore};
use crate::error::{Error, Result};
use crate::lock::WriterLock;
use crate::model::*;
use crate::tools::ToolName;
use crate::schema;

/// A Workspace's recorded Sessions.
pub struct Store {
    conn: Connection,
    blobs: BlobStore,
    root: PathBuf,
    /// `None` when this process attached read-only because another window holds
    /// the writer lock.
    writer_lock: Option<WriterLock>,
}

impl Store {
    /// Open (creating if needed) the store under a Workspace's `.atlas/`.
    ///
    /// Takes the writer lock. If another Atlas window already holds it, this
    /// still succeeds — attached read-only — because a second window must
    /// remain able to *browse* the timeline. Capture checks
    /// [`Store::is_writer`] and defers rather than double-writing.
    pub fn open(atlas_dir: impl AsRef<Path>) -> Result<Self> {
        Self::open_inner(atlas_dir.as_ref(), true, true)
    }

    /// Open the store for reading only, without touching the writer lock.
    ///
    /// The writer lock arbitrates between **processes**. A second `Store` opened
    /// inside the *same* process contends for it exactly as hard as a second
    /// window would, and loses — so a read path that used [`Store::open`] would
    /// make the host lock itself out of its own Workspace and then report
    /// "another Atlas window is already recording", which is both false and
    /// unactionable.
    ///
    /// So reads get their own connection and never ask for the lock. WAL is what
    /// makes that safe: a reader sees a consistent snapshot and neither blocks
    /// the writer nor is blocked by it.
    ///
    /// [`Store::is_writer`] is always `false` here, and that answer is
    /// meaningless — a reader was never trying to be the writer. Anything that
    /// needs to know whether *this process* holds the lock must ask the owner of
    /// the writing store, not a reader.
    ///
    /// Unlike [`Store::open`] this **creates nothing** and errors if the store
    /// does not exist. Capture is opt-in, and a read — listing Sessions, polling
    /// a status line — must never be what silently plants an `.atlas/` directory
    /// in a Workspace the developer never enabled.
    pub fn open_reader(atlas_dir: impl AsRef<Path>) -> Result<Self> {
        Self::open_inner(atlas_dir.as_ref(), false, false)
    }

    fn open_inner(atlas_dir: &Path, take_lock: bool, create: bool) -> Result<Self> {
        let root = atlas_dir.to_path_buf();
        if create {
            fs::create_dir_all(&root)
                .map_err(|e| Error::Storage(format!("{}: {e}", root.display())))?;
            ensure_self_ignored(&root);
        }

        let writer_lock = if take_lock {
            match WriterLock::acquire(&root.join("sessions.lock")) {
                Ok(lock) => Some(lock),
                Err(Error::AlreadyLocked) => None,
                Err(e) => return Err(e),
            }
        } else {
            None
        };

        let db_path = root.join("sessions.db");
        let conn = Self::open_connection(&db_path, create)?;
        schema::migrate(&conn)?;

        let store = Self {
            conn,
            blobs: BlobStore::new(root.join("blobs")),
            root,
            writer_lock,
        };

        // A turn that was open when the process last died is not a completed
        // turn, and must never be readable as one.
        if store.is_writer() {
            store.reconcile_aborted_turns()?;
        }
        Ok(store)
    }

    fn open_connection(db_path: &Path, create: bool) -> Result<Connection> {
        // A reader opens read-write-without-create rather than read-only: the
        // schema migration below is idempotent and must still be able to run on
        // a database written by an older build, but a *missing* database is an
        // absent Workspace and must stay absent.
        let mut flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
            | rusqlite::OpenFlags::SQLITE_OPEN_URI
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
        if create {
            flags |= rusqlite::OpenFlags::SQLITE_OPEN_CREATE;
        }
        let conn = Connection::open_with_flags(db_path, flags)
            .map_err(|e| Error::Storage(format!("{}: {e}", db_path.display())))?;

        // WAL so a reader (the timeline) never blocks the writer (capture), and
        // NORMAL because the extra fsync of FULL buys durability against OS
        // crash that we do not need — a lost trailing turn is recoverable from
        // the agent's own transcript, and capture must not add latency to a turn.
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| Error::Storage(format!("WAL: {e}")))?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        // A brief wait absorbs the checkpointer and the read side; the *writer*
        // contention this would otherwise mask is prevented by the writer lock.
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(conn)
    }

    /// Does this process own the Workspace's writer lock?
    ///
    /// Capture must check this. A second window attaches read-only so the
    /// timeline still browses, but writing from both is what corrupts the
    /// outbox state machine.
    pub fn is_writer(&self) -> bool {
        self.writer_lock.is_some()
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn blobs(&self) -> &BlobStore {
        &self.blobs
    }

    /// Read a Message's body, from the row or from its blob.
    pub fn message_body(&self, message: &Message) -> Result<String> {
        if let Some(key) = &message.body_ref {
            let bytes = self.blobs.get(key)?;
            return String::from_utf8(bytes)
                .map_err(|e| Error::Blob(format!("spilled body is not text: {e}")));
        }
        Ok(message.body.clone().unwrap_or_default())
    }

    // ── Sessions ────────────────────────────────────────────────────────────

    /// Find or create the Session for an agent conversation.
    ///
    /// Keyed on (workspace, source, native id), so a second sighting of the same
    /// conversation updates rather than duplicating — which is what makes both
    /// re-processing and re-import no-ops.
    #[allow(clippy::too_many_arguments)]
    pub fn upsert_session(
        &self,
        workspace_id: &str,
        source: Source,
        native_session_id: &str,
        agent: Option<&str>,
        model: Option<&str>,
        branch: Option<&str>,
        cwd: Option<&str>,
        mode: WorkspaceMode,
    ) -> Result<String> {
        // `branch` is the branch at the moment of this prompt. It is COALESCEd
        // onto the EXISTING value below, so the first one seen sticks: a
        // Session belongs to the branch it started on, and a checkout
        // mid-conversation must not retro-label it.
        self.require_writer()?;
        let now = Utc::now();

        if let Some(id) = self.session_id_for(workspace_id, source, native_session_id)? {
            self.conn.execute(
                // `model` takes the NEW value when there is one — switching
                // model mid-conversation should be visible — while `branch`
                // keeps the first. They differ on purpose.
                "UPDATE agent_session
                    SET agent = COALESCE(?2, agent),
                        model = COALESCE(?3, model),
                        branch = COALESCE(branch, ?4),
                        cwd = COALESCE(?5, cwd),
                        updated_at = ?6
                  WHERE id = ?1",
                rusqlite::params![id, agent, model, branch, cwd, now.to_rfc3339()],
            )?;
            return Ok(id);
        }

        let id = format!("as-{}", uuid::Uuid::new_v4().simple());
        self.conn.execute(
            "INSERT INTO agent_session
                (id, workspace_id, source, native_session_id, agent, model, branch, cwd,
                 started_at, updated_at, sync_state)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10)",
            rusqlite::params![
                id,
                workspace_id,
                source.as_str(),
                native_session_id,
                agent,
                model,
                branch,
                cwd,
                now.to_rfc3339(),
                mode.initial_sync_state().as_str(),
            ],
        )?;
        Ok(id)
    }

    pub fn session_id_for(
        &self,
        workspace_id: &str,
        source: Source,
        native_session_id: &str,
    ) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id FROM agent_session
                  WHERE workspace_id = ?1 AND source = ?2 AND native_session_id = ?3",
                rusqlite::params![workspace_id, source.as_str(), native_session_id],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Is this native session id already recorded under *any* source?
    ///
    /// The UNIQUE constraint only dedupes within a source, by design — an
    /// ACP-hosted Claude Code session and its own on-disk JSONL are legitimately
    /// two different rows to the schema. Skipping that duplicate is explicit
    /// importer logic, and this is the query it needs.
    pub fn native_session_exists(
        &self,
        workspace_id: &str,
        native_session_id: &str,
    ) -> Result<bool> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM agent_session
              WHERE workspace_id = ?1 AND native_session_id = ?2",
            rusqlite::params![workspace_id, native_session_id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    pub fn session(&self, id: &str) -> Result<Option<Session>> {
        Ok(self
            .conn
            .query_row(
                &format!("SELECT {SESSION_COLUMNS} FROM agent_session WHERE id = ?1"),
                [id],
                row_to_session,
            )
            .optional()?)
    }

    pub fn sessions_for_workspace(&self, workspace_id: &str) -> Result<Vec<Session>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {SESSION_COLUMNS} FROM agent_session
              WHERE workspace_id = ?1 ORDER BY started_at"
        ))?;
        let rows = stmt.query_map([workspace_id], row_to_session)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Set the title, if the Session does not already have one.
    ///
    /// First prompt wins: a Session's title is what it was first asked, and a
    /// later turn overwriting it would make the board's rows change under the
    /// reader.
    pub fn set_title_if_absent(&self, session_id: &str, title: &str) -> Result<()> {
        self.require_writer()?;
        self.conn.execute(
            &format!(
                "UPDATE agent_session SET title = ?2, updated_at = ?3{RESYNC_SESSION}
                  WHERE id = ?1 AND (title IS NULL OR title = '')"
            ),
            rusqlite::params![session_id, title, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// Merge token totals into a Session's record.
    ///
    /// A merge rather than a replace, because the gauge and the split arrive on
    /// different events: a `ContextUsage` gauge carries zeros for the split, and
    /// replacing wholesale would let it erase a real usage split recorded
    /// moments earlier. Non-zero fields win; a genuine larger cumulative value
    /// always lands.
    pub fn set_token_totals(&self, session_id: &str, totals: &TokenTotals) -> Result<()> {
        self.require_writer()?;
        let existing: Option<String> = self
            .conn
            .query_row(
                "SELECT token_totals FROM agent_session WHERE id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .optional()?;
        let mut merged: TokenTotals = existing
            .as_deref()
            .and_then(|raw| serde_json::from_str(raw).ok())
            .unwrap_or_default();

        if totals.input_tokens > 0 {
            merged.input_tokens = totals.input_tokens;
        }
        if totals.output_tokens > 0 {
            merged.output_tokens = totals.output_tokens;
        }
        if totals.cache_creation_tokens > 0 {
            merged.cache_creation_tokens = totals.cache_creation_tokens;
        }
        if totals.cache_read_tokens > 0 {
            merged.cache_read_tokens = totals.cache_read_tokens;
        }
        if totals.context_used.is_some() {
            merged.context_used = totals.context_used;
        }
        if totals.context_size.is_some() {
            merged.context_size = totals.context_size;
        }

        let json = serde_json::to_string(&merged).unwrap_or_else(|_| "{}".into());
        self.conn.execute(
            &format!(
                "UPDATE agent_session SET token_totals = ?2, updated_at = ?3{RESYNC_SESSION}
                  WHERE id = ?1"
            ),
            rusqlite::params![session_id, json, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// Replace a Session's usage split with a freshly recomputed one.
    ///
    /// The importer's path, and a replace rather than the merge above on
    /// purpose: the importer always re-reads a transcript from its first byte,
    /// so the number it hands over is the whole truth for that file. An
    /// additive path would double every total on the next tick that saw the
    /// file grow.
    ///
    /// The context gauge is preserved — it is a different measurement, written
    /// by a different producer — and neither timestamp moves: re-parsing a June
    /// transcript in July is not work happening in July.
    pub fn replace_usage_totals(&self, session_id: &str, usage: &TokenTotals) -> Result<()> {
        self.require_writer()?;
        let existing: Option<String> = self
            .conn
            .query_row(
                "SELECT token_totals FROM agent_session WHERE id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .optional()?;
        let mut merged: TokenTotals = existing
            .as_deref()
            .and_then(|raw| serde_json::from_str(raw).ok())
            .unwrap_or_default();

        merged.input_tokens = usage.input_tokens;
        merged.output_tokens = usage.output_tokens;
        merged.cache_creation_tokens = usage.cache_creation_tokens;
        merged.cache_read_tokens = usage.cache_read_tokens;

        let json = serde_json::to_string(&merged).unwrap_or_else(|_| "{}".into());
        self.conn.execute(
            &format!("UPDATE agent_session SET token_totals = ?2{RESYNC_SESSION} WHERE id = ?1"),
            rusqlite::params![session_id, json],
        )?;
        Ok(())
    }

    /// Move a Session's `started_at` earlier, when a better source of truth
    /// (the transcript's own timestamps) knows when it really began.
    ///
    /// Only ever moves backwards: live capture stamped "now" at first sighting,
    /// and the transcript can only prove the conversation is older than that.
    pub fn backdate_session(&self, session_id: &str, started_at: DateTime<Utc>) -> Result<()> {
        self.require_writer()?;
        self.conn.execute(
            "UPDATE agent_session SET started_at = ?2
              WHERE id = ?1 AND started_at > ?2",
            rusqlite::params![session_id, started_at.to_rfc3339()],
        )?;
        Ok(())
    }

    /// Flag a Session as needing a human's attention.
    ///
    /// The two callers are a redaction failure and a storage failure, and both
    /// share a rule: never silently drop the Session. Losing a turn is bad;
    /// losing a turn without telling anyone is how a record grows holes that are
    /// only discovered when someone needs the history and it is not there.
    pub fn flag_needs_attention(&self, session_id: &str, reason: &str) -> Result<()> {
        // Deliberately not gated on `require_writer`: this is the path that runs
        // *because* something went wrong, and refusing to record why would be
        // the same silence it exists to prevent.
        self.conn.execute(
            "UPDATE agent_session
                SET needs_attention = 1, attention_reason = ?2, updated_at = ?3
              WHERE id = ?1",
            rusqlite::params![session_id, reason, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// Add a redaction tally to a Session's cumulative counts.
    pub fn add_redaction_counts(
        &self,
        session_id: &str,
        counts: &atlas_redact::RedactionCounts,
    ) -> Result<()> {
        if counts.is_empty() {
            return Ok(());
        }
        let existing: String = self.conn.query_row(
            "SELECT redaction_counts FROM agent_session WHERE id = ?1",
            [session_id],
            |row| row.get(0),
        )?;
        let mut merged: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(&existing).unwrap_or_default();
        for (category, count) in counts.entries() {
            let running = merged
                .get(category)
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0);
            merged.insert(
                category.to_string(),
                serde_json::Value::from(running + u64::from(count)),
            );
        }
        self.conn.execute(
            "UPDATE agent_session SET redaction_counts = ?2 WHERE id = ?1",
            rusqlite::params![
                session_id,
                serde_json::Value::Object(merged).to_string()
            ],
        )?;
        Ok(())
    }

    // ── Turns and messages ──────────────────────────────────────────────────

    /// Mark a turn as started.
    pub fn begin_turn(&self, session_id: &str, turn_seq: i64) -> Result<()> {
        self.require_writer()?;
        self.conn.execute(
            "INSERT INTO turn (session_id, turn_seq, state, started_at)
             VALUES (?1, ?2, 'open', ?3)
             ON CONFLICT (session_id, turn_seq) DO NOTHING",
            rusqlite::params![session_id, turn_seq, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn turn_state(&self, session_id: &str, turn_seq: i64) -> Result<Option<TurnState>> {
        Ok(self
            .conn
            .query_row(
                "SELECT state FROM turn WHERE session_id = ?1 AND turn_seq = ?2",
                rusqlite::params![session_id, turn_seq],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .and_then(|raw| TurnState::parse(&raw)))
    }

    /// Write one finalized turn's Message and close the turn — atomically.
    ///
    /// The transaction boundary is the whole turn, so killing the process
    /// mid-write rolls back to the last *completed* turn. A partially-written
    /// turn that survived would be indistinguishable from a complete one, and
    /// the record would quietly assert something false.
    ///
    /// Returns `None` when the turn was already recorded — re-processing the
    /// same turn is a no-op rather than a duplicate.
    pub fn record_message(&mut self, input: MessageInput<'_>) -> Result<Option<String>> {
        self.require_writer()?;

        // Spill outside the transaction: a blob write is filesystem work, and
        // holding a write transaction across it would serialise capture behind
        // the slowest disk operation in the path. Content addressing makes an
        // orphaned blob from a rolled-back transaction harmless — it is
        // unreferenced bytes, reaped later, never a dangling reference.
        let body_bytes = input.body.len() as i64;
        let (body, body_ref) = if blobs::should_spill(input.body) {
            (None, Some(self.blobs.put(input.body.as_bytes())?))
        } else {
            (Some(input.body.to_string()), None)
        };
        let preview = blobs::preview_of(input.body);
        let content_hash = blobs::key_for(input.body.as_bytes());

        let tx = self.conn.transaction()?;

        // Idempotency, when the agent gave the message an id we can key on.
        if let Some(native_id) = input.native_message_id {
            let existing: Option<String> = tx
                .query_row(
                    "SELECT id FROM agent_message
                      WHERE session_id = ?1 AND native_message_id = ?2",
                    rusqlite::params![input.session_id, native_id],
                    |row| row.get(0),
                )
                .optional()?;
            if existing.is_some() {
                return Ok(None);
            }
        }

        let seq = next_seq(&tx)?;
        let id = format!("am-{}", uuid::Uuid::new_v4().simple());
        let now = Utc::now();
        // Imported turns carry the transcript's own timestamp; live capture
        // stamps now. The distinction is what keeps a year of imported history
        // from all dating to the day the import ran.
        let created_at = input.created_at.unwrap_or(now);

        tx.execute(
            "INSERT INTO agent_message
                (id, session_id, seq, turn_seq, native_message_id, role, mode,
                 preview, body, body_ref, body_bytes, content_hash, created_at, sync_state)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            rusqlite::params![
                id,
                input.session_id,
                seq,
                input.turn_seq,
                input.native_message_id,
                input.role.as_str(),
                input.mode.as_str(),
                preview,
                body,
                body_ref,
                body_bytes,
                content_hash,
                created_at.to_rfc3339(),
                input.sync_state.as_str(),
            ],
        )?;

        // Two clocks, on purpose. `updated_at` is when the row was written and
        // drives liveness and the outbox. `last_activity_at` is when the work
        // happened, which for an imported transcript is months earlier — and it
        // only ever moves forward, because a re-import walks a file from the
        // top and must not drag a Session's activity back to its first line.
        tx.execute(
            "UPDATE agent_session
                SET updated_at = ?2,
                    last_activity_at = CASE
                        WHEN last_activity_at IS NULL OR last_activity_at < ?3 THEN ?3
                        ELSE last_activity_at END
              WHERE id = ?1",
            rusqlite::params![input.session_id, now.to_rfc3339(), created_at.to_rfc3339()],
        )?;

        tx.commit()?;
        Ok(Some(id))
    }

    /// Close a turn as completed.
    ///
    /// Only an `open` turn can complete. A turn reconciled to `aborted` after a
    /// crash keeps that verdict — a later event with a recycled turn number must
    /// not quietly erase the record that the original turn was torn.
    pub fn complete_turn(&self, session_id: &str, turn_seq: i64) -> Result<()> {
        self.require_writer()?;
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE turn SET state = 'completed', ended_at = ?3
              WHERE session_id = ?1 AND turn_seq = ?2 AND state = 'open'",
            rusqlite::params![session_id, turn_seq, now],
        )?;
        // A turn ending is the clearest activity signal there is. Monotonic for
        // the same reason as in `record_message`.
        self.conn.execute(
            "UPDATE agent_session
                SET last_activity_at = CASE
                        WHEN last_activity_at IS NULL OR last_activity_at < ?2 THEN ?2
                        ELSE last_activity_at END
              WHERE id = ?1",
            rusqlite::params![session_id, now],
        )?;
        Ok(())
    }

    /// The highest turn number this Session has ever used.
    ///
    /// Seeds the in-memory counter after a restart, so a resumed conversation
    /// continues from turn N+1 instead of colliding with the turns already
    /// recorded.
    pub fn max_turn_seq(&self, session_id: &str) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT COALESCE(MAX(turn_seq), 0) FROM turn WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )?)
    }

    pub fn messages_for_session(&self, session_id: &str) -> Result<Vec<Message>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {MESSAGE_COLUMNS} FROM agent_message
              WHERE session_id = ?1 ORDER BY seq"
        ))?;
        let rows = stmt.query_map([session_id], row_to_message)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// How many Messages a Session holds. Index-only — no body is read.
    pub fn message_count(&self, session_id: &str) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM agent_message WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )?)
    }

    /// Message totals for every Session in a Workspace, as `session_id -> n`.
    ///
    /// The list view needs one of these per row. Asking per Session made the
    /// read cost `3n + 1` queries, which is invisible at one Workspace and the
    /// dominant cost once the board spans every project in an Organisation.
    /// One `GROUP BY` over the same covering index answers all of them.
    pub fn message_counts(&self, workspace_id: &str) -> Result<HashMap<String, i64>> {
        self.counts_by_session("agent_message", workspace_id)
    }

    /// Tool-call totals for every Session in a Workspace. See [`Self::message_counts`].
    pub fn tool_call_counts_by_session(
        &self,
        workspace_id: &str,
    ) -> Result<HashMap<String, i64>> {
        self.counts_by_session("tool_call", workspace_id)
    }

    /// Turn time per Session, as `session_id -> (seconds, closed turns)`.
    ///
    /// Each turn span is clamped to `cap_seconds` before it is summed, because
    /// `complete_turn` stamps the wall clock: a turn whose completion event
    /// arrived after a laptop sleep would otherwise report the sleep as
    /// thinking. The turn count travels with the seconds so the read model can
    /// tell "this Session worked for zero seconds" from "this Session has no
    /// turn rows at all" — imported transcripts are entirely the latter.
    ///
    /// One `GROUP BY`, like the count aggregates above and for the same reason.
    pub fn turn_active_seconds(
        &self,
        workspace_id: &str,
        cap_seconds: i64,
    ) -> Result<HashMap<String, (i64, i64)>> {
        let mut stmt = self.conn.prepare(
            "SELECT t.session_id,
                    CAST(ROUND(SUM(MIN(MAX((julianday(t.ended_at) - julianday(t.started_at))
                                           * 86400.0, 0.0), ?2))) AS INTEGER),
                    COUNT(*)
               FROM turn t
               JOIN agent_session s ON s.id = t.session_id
              WHERE s.workspace_id = ?1 AND t.ended_at IS NOT NULL
              GROUP BY t.session_id",
        )?;
        let rows = stmt.query_map(rusqlite::params![workspace_id, cap_seconds as f64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (row.get::<_, i64>(1)?, row.get::<_, i64>(2)?),
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<HashMap<_, _>>>()?)
    }

    /// Gap-capped message time per Session, as `session_id -> seconds`.
    ///
    /// The fallback for every Session with no turn rows — which is every
    /// imported transcript. Sums the gaps between consecutive messages, each
    /// clamped to `idle_cap_seconds`: a gap longer than that is a developer who
    /// walked away, not an agent that thought for three hours. Summing the
    /// unclamped span is how a June transcript reported four hundred hours.
    pub fn message_active_seconds(
        &self,
        workspace_id: &str,
        idle_cap_seconds: i64,
    ) -> Result<HashMap<String, i64>> {
        let mut stmt = self.conn.prepare(
            "WITH stamps AS (
                 SELECT m.session_id AS sid,
                        julianday(m.created_at) AS t,
                        LAG(julianday(m.created_at))
                            OVER (PARTITION BY m.session_id ORDER BY m.created_at, m.seq) AS prev
                   FROM agent_message m
                   JOIN agent_session s ON s.id = m.session_id
                  WHERE s.workspace_id = ?1
             )
             SELECT sid,
                    CAST(ROUND(SUM(MIN(MAX((t - prev) * 86400.0, 0.0), ?2))) AS INTEGER)
               FROM stamps
              WHERE prev IS NOT NULL
              GROUP BY sid",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![workspace_id, idle_cap_seconds as f64],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )?;
        Ok(rows.collect::<rusqlite::Result<HashMap<_, _>>>()?)
    }

    /// [`Self::turn_active_seconds`] for one Session — the detail view's path.
    pub fn turn_active_seconds_for(
        &self,
        session_id: &str,
        cap_seconds: i64,
    ) -> Result<(i64, i64)> {
        Ok(self.conn.query_row(
            "SELECT COALESCE(CAST(ROUND(SUM(MIN(MAX((julianday(ended_at) - julianday(started_at))
                                                     * 86400.0, 0.0), ?2))) AS INTEGER), 0),
                    COUNT(*)
               FROM turn
              WHERE session_id = ?1 AND ended_at IS NOT NULL",
            rusqlite::params![session_id, cap_seconds as f64],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?)
    }

    /// [`Self::message_active_seconds`] for one Session.
    pub fn message_active_seconds_for(
        &self,
        session_id: &str,
        idle_cap_seconds: i64,
    ) -> Result<i64> {
        Ok(self.conn.query_row(
            "WITH stamps AS (
                 SELECT julianday(created_at) AS t,
                        LAG(julianday(created_at)) OVER (ORDER BY created_at, seq) AS prev
                   FROM agent_message
                  WHERE session_id = ?1
             )
             SELECT COALESCE(CAST(ROUND(SUM(MIN(MAX((t - prev) * 86400.0, 0.0), ?2))) AS INTEGER), 0)
               FROM stamps
              WHERE prev IS NOT NULL",
            rusqlite::params![session_id, idle_cap_seconds as f64],
            |row| row.get(0),
        )?)
    }

    /// `session_id -> COUNT(*)` for one child table, scoped to a Workspace.
    ///
    /// `table` is a hardcoded literal at both call sites, never user input.
    fn counts_by_session(&self, table: &str, workspace_id: &str) -> Result<HashMap<String, i64>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT c.session_id, COUNT(*) FROM {table} c
               JOIN agent_session s ON s.id = c.session_id
              WHERE s.workspace_id = ?1
              GROUP BY c.session_id"
        ))?;
        let rows = stmt.query_map([workspace_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<HashMap<_, _>>>()?)
    }

    /// How many tool calls a Session holds. Index-only.
    pub fn tool_call_count(&self, session_id: &str) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM tool_call WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )?)
    }

    /// Count messages by role and mode — the session-detail sidebar's numbers.
    ///
    /// Answerable from the covering index alone: no body is read, and no blob is
    /// touched. That property is the entire reason `role` and `mode` are columns.
    pub fn facet_counts(&self, session_id: &str) -> Result<Vec<((Role, Mode), i64)>> {
        let mut stmt = self.conn.prepare(
            "SELECT role, mode, COUNT(*) FROM agent_message
              WHERE session_id = ?1 GROUP BY role, mode",
        )?;
        let rows = stmt.query_map([session_id], |row| {
            let role: String = row.get(0)?;
            let mode: String = row.get(1)?;
            let count: i64 = row.get(2)?;
            Ok((role, mode, count))
        })?;

        let mut out = Vec::new();
        for row in rows {
            let (role, mode, count) = row?;
            if let (Some(role), Some(mode)) = (Role::parse(&role), Mode::parse(&mode)) {
                out.push(((role, mode), count));
            }
        }
        Ok(out)
    }

    // ── Tool calls, file touches and edit patches ───────────────────────────

    /// Record one tool invocation, or update the one already recorded.
    ///
    /// A call arrives at least twice — a first sighting and one or more updates
    /// carrying the status, the result, and (often only now) the locations. The
    /// agent's own call id is the idempotency key that makes the second sighting
    /// an update rather than a duplicate row.
    ///
    /// `arguments` and `result` are **already redacted** and, if binary, already
    /// marked as such: the store does not scrub, `capture` does.
    pub fn upsert_tool_call(&mut self, input: ToolCallInput<'_>) -> Result<String> {
        self.require_writer()?;

        // Spill outside the transaction, for the same reason message bodies do:
        // a tool result is the largest payload in a Session, and holding a write
        // transaction across a file write serialises capture behind the disk.
        let (arguments, arguments_ref) = self.split_payload(input.arguments)?;
        let (result, result_ref) = match input.result {
            ToolPayload::Text(text) => self.split_payload(Some(text))?,
            ToolPayload::Binary(bytes) => (None, Some(self.blobs.put(bytes)?)),
            ToolPayload::None => (None, None),
        };
        let result_binary = matches!(input.result, ToolPayload::Binary(_));
        let locations = serde_json::to_string(input.locations).unwrap_or_else(|_| "[]".into());
        let now = Utc::now();

        let tx = self.conn.transaction()?;

        if let Some(native_id) = input.native_call_id {
            let existing: Option<String> = tx
                .query_row(
                    "SELECT id FROM tool_call WHERE session_id = ?1 AND native_call_id = ?2",
                    rusqlite::params![input.session_id, native_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(id) = existing {
                // An update carrying only a status must not erase the payload or
                // the locations we already have — `COALESCE` on a NULL argument
                // means "no news", not "cleared". This is the store-side half of
                // the same rule the runtime now follows for locations.
                tx.execute(
                    "UPDATE tool_call
                        SET tool_name = ?2,
                            title = COALESCE(?3, title),
                            kind = COALESCE(?4, kind),
                            status = ?5,
                            locations = CASE WHEN ?6 = '[]' THEN locations ELSE ?6 END,
                            arguments = COALESCE(?7, arguments),
                            arguments_ref = COALESCE(?8, arguments_ref),
                            result = COALESCE(?9, result),
                            result_ref = COALESCE(?10, result_ref),
                            result_binary = CASE WHEN ?11 = 1 THEN 1 ELSE result_binary END
                      WHERE id = ?1",
                    rusqlite::params![
                        id,
                        input.tool_name.as_str(),
                        input.title,
                        input.kind,
                        input.status.as_str(),
                        locations,
                        arguments,
                        arguments_ref,
                        result,
                        result_ref,
                        i64::from(result_binary),
                    ],
                )?;
                tx.commit()?;
                return Ok(id);
            }
        }

        let seq = next_seq(&tx)?;
        let id = format!("tc-{}", uuid::Uuid::new_v4().simple());
        tx.execute(
            "INSERT INTO tool_call
                (id, session_id, seq, turn_seq, native_call_id, tool_name, title, kind,
                 status, locations, arguments, arguments_ref, result, result_ref,
                 result_binary, created_at, sync_state)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            rusqlite::params![
                id,
                input.session_id,
                seq,
                input.turn_seq,
                input.native_call_id,
                input.tool_name.as_str(),
                input.title,
                input.kind,
                input.status.as_str(),
                locations,
                arguments,
                arguments_ref,
                result,
                result_ref,
                i64::from(result_binary),
                now.to_rfc3339(),
                input.sync_state.as_str(),
            ],
        )?;
        tx.commit()?;
        Ok(id)
    }

    /// Record a file the agent wrote.
    ///
    /// One record per write, so a file written twice in one turn produces two —
    /// and the link rule consumes the *last*, since that is the content the turn
    /// left behind.
    pub fn record_file_touch(&mut self, input: FileTouchInput<'_>) -> Result<String> {
        self.require_writer()?;
        let tx = self.conn.transaction()?;
        let seq = next_seq(&tx)?;
        let id = format!("ft-{}", uuid::Uuid::new_v4().simple());
        tx.execute(
            "INSERT INTO file_touch
                (id, tool_call_id, session_id, turn_seq, seq, path, sha256_after,
                 existed_before, deleted, out_of_repo, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            rusqlite::params![
                id,
                input.tool_call_id,
                input.session_id,
                input.turn_seq,
                seq,
                input.path,
                input.sha256_after,
                i64::from(input.existed_before),
                i64::from(input.deleted),
                i64::from(input.out_of_repo),
                Utc::now().to_rfc3339(),
            ],
        )?;
        tx.commit()?;
        Ok(id)
    }

    /// Record the patch an edit-shaped call applied.
    pub fn record_agent_edit(&mut self, input: AgentEditInput<'_>) -> Result<String> {
        self.require_writer()?;
        let (patch, patch_ref) = self.split_payload(input.patch)?;
        let id = format!("ae-{}", uuid::Uuid::new_v4().simple());
        self.conn.execute(
            "INSERT INTO agent_edit
                (id, tool_call_id, session_id, turn_seq, path, patch, patch_ref, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                id,
                input.tool_call_id,
                input.session_id,
                input.turn_seq,
                input.path,
                patch,
                patch_ref,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(id)
    }

    pub fn tool_calls_for_session(&self, session_id: &str) -> Result<Vec<ToolCall>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {TOOL_CALL_COLUMNS} FROM tool_call WHERE session_id = ?1 ORDER BY seq"
        ))?;
        let rows = stmt.query_map([session_id], row_to_tool_call)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Count tool calls by canonical name — the sidebar's *Bash 1 · Read 2 ·
    /// File edits 1*.
    ///
    /// Answerable from the covering index alone. No message body is read and no
    /// blob is touched, which is the entire reason tool calls are rows.
    pub fn tool_call_counts(&self, session_id: &str) -> Result<Vec<(ToolName, i64)>> {
        let mut stmt = self.conn.prepare(
            "SELECT tool_name, COUNT(*) FROM tool_call WHERE session_id = ?1 GROUP BY tool_name",
        )?;
        let rows = stmt.query_map([session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (name, count) = row?;
            out.push((ToolName::parse(&name).unwrap_or(ToolName::Other), count));
        }
        Ok(out)
    }

    /// Read a tool call's result, from the row or its blob.
    ///
    /// Returns raw bytes because the result may not be text — a binary payload
    /// round-trips byte-identically rather than being lossily decoded.
    pub fn tool_call_result(&self, call: &ToolCall) -> Result<Option<Vec<u8>>> {
        if let Some(key) = &call.result_ref {
            return self.blobs.get(key).map(Some);
        }
        Ok(call.result.clone().map(String::into_bytes))
    }

    pub fn file_touches_for_session(&self, session_id: &str) -> Result<Vec<FileTouch>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {FILE_TOUCH_COLUMNS} FROM file_touch WHERE session_id = ?1 ORDER BY seq"
        ))?;
        let rows = stmt.query_map([session_id], row_to_file_touch)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The last touch of each path in a turn — what the turn left behind, and
    /// therefore what the link rule compares against a commit.
    pub fn latest_file_touches(&self, session_id: &str) -> Result<Vec<FileTouch>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {FILE_TOUCH_COLUMNS} FROM file_touch
              WHERE session_id = ?1
                AND seq IN (
                    SELECT MAX(seq) FROM file_touch
                     WHERE session_id = ?1 GROUP BY turn_seq, path
                )
              ORDER BY seq"
        ))?;
        let rows = stmt.query_map([session_id], row_to_file_touch)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn agent_edits_for_session(&self, session_id: &str) -> Result<Vec<AgentEdit>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, tool_call_id, session_id, turn_seq, path, patch, patch_ref, created_at
               FROM agent_edit WHERE session_id = ?1 ORDER BY created_at",
        )?;
        let rows = stmt.query_map([session_id], |row| {
            Ok(AgentEdit {
                id: row.get(0)?,
                tool_call_id: row.get(1)?,
                session_id: row.get(2)?,
                turn_seq: row.get(3)?,
                path: row.get(4)?,
                patch: row.get(5)?,
                patch_ref: row.get(6)?,
                created_at: parse_time(row.get::<_, String>(7)?),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Inline it, or spill it and return the key.
    fn split_payload(&self, value: Option<&str>) -> Result<(Option<String>, Option<String>)> {
        match value {
            None => Ok((None, None)),
            Some(text) if blobs::should_spill(text) => {
                Ok((None, Some(self.blobs.put(text.as_bytes())?)))
            }
            Some(text) => Ok((Some(text.to_string()), None)),
        }
    }

    // ── Binding ─────────────────────────────────────────────────────────────

    /// How this Workspace is bound, or `None` if capture was never enabled.
    pub fn binding(&self) -> Result<Option<Binding>> {
        Ok(self
            .conn
            .query_row(
                "SELECT workspace_id, root, mode, slug, org_id, root_commit_sha,
                        fingerprint_is_shallow, git_url, enabled, created_at,
                        import_approved, drain_state, remote_workspace_id
                   FROM binding WHERE id = 1",
                [],
                |row| {
                    let mode: String = row.get(2)?;
                    let drain_state: String = row.get(11)?;
                    Ok(Binding {
                        workspace_id: row.get(0)?,
                        root: row.get(1)?,
                        mode: WorkspaceMode::parse(&mode).unwrap_or(WorkspaceMode::Local),
                        slug: row.get(3)?,
                        org_id: row.get(4)?,
                        root_commit_sha: row.get(5)?,
                        fingerprint_is_shallow: row.get::<_, i64>(6)? != 0,
                        git_url: row.get(7)?,
                        enabled: row.get::<_, i64>(8)? != 0,
                        import_approved: row.get::<_, i64>(10)? != 0,
                        drain_state: DrainGate::parse(&drain_state).unwrap_or(DrainGate::Ok),
                        remote_workspace_id: row.get(12)?,
                        created_at: parse_time(row.get::<_, String>(9)?),
                    })
                },
            )
            .optional()?)
    }

    /// Bind, or refresh an existing binding's detected signals.
    ///
    /// Idempotent by construction — the singleton row is upserted rather than
    /// inserted, so re-opening the popover for an already-bound Workspace shows
    /// its state instead of offering to create a second one. `created_at` is
    /// preserved so "capturing since" stays true.
    pub fn upsert_binding(
        &self,
        workspace_id: &str,
        root: &str,
        mode: WorkspaceMode,
        root_commit_sha: Option<&str>,
        fingerprint_is_shallow: bool,
        git_url: Option<&str>,
    ) -> Result<()> {
        self.require_writer()?;
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO binding
                (id, workspace_id, root, mode, root_commit_sha, fingerprint_is_shallow,
                 git_url, enabled, created_at, updated_at)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)
             ON CONFLICT (id) DO UPDATE SET
                 workspace_id = ?1,
                 root = ?2,
                 mode = ?3,
                 root_commit_sha = ?4,
                 fingerprint_is_shallow = ?5,
                 git_url = ?6,
                 enabled = 1,
                 updated_at = ?7",
            rusqlite::params![
                workspace_id,
                root,
                mode.as_str(),
                root_commit_sha,
                i64::from(fingerprint_is_shallow),
                git_url,
                now,
            ],
        )?;
        Ok(())
    }

    /// Record the Organisation this Workspace was registered to.
    ///
    /// Separate from [`Store::upsert_binding`] because it is a different event:
    /// binding is local and immediate, registration is a server round-trip that
    /// must succeed before anything local changes.
    ///
    /// Becoming Cloud revokes any earlier import approval — the disclosure class
    /// changed, so the confirmation must be given again — and clears a stale
    /// `not_authorized` drain gate, since this is a fresh registration.
    pub fn set_cloud_binding(
        &self,
        org_id: &str,
        slug: &str,
        remote_workspace_id: Option<&str>,
    ) -> Result<()> {
        self.require_writer()?;
        self.conn.execute(
            "UPDATE binding
                SET mode = 'cloud', org_id = ?1, slug = ?2,
                    remote_workspace_id = COALESCE(?3, remote_workspace_id),
                    import_approved = 0, drain_state = 'ok', updated_at = ?4
              WHERE id = 1",
            rusqlite::params![org_id, slug, remote_workspace_id, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// Promote to Cloud atomically: the binding flip and the row flip commit
    /// together, so a crash can never leave a Cloud Workspace whose history is
    /// stranded as `local` — invisible to the drain forever, after the user was
    /// told it would be shared.
    pub fn promote_to_cloud(
        &self,
        workspace_id: &str,
        org_id: &str,
        slug: &str,
        remote_workspace_id: Option<&str>,
    ) -> Result<i64> {
        self.require_writer()?;
        let now = Utc::now().to_rfc3339();
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE binding
                SET mode = 'cloud', org_id = ?1, slug = ?2,
                    remote_workspace_id = COALESCE(?3, remote_workspace_id),
                    import_approved = 0, drain_state = 'ok', updated_at = ?4
              WHERE id = 1",
            rusqlite::params![org_id, slug, remote_workspace_id, now],
        )?;
        let moved = promote_local_rows_in(&tx, workspace_id)?;
        tx.commit()?;
        Ok(moved)
    }

    /// Was promotion interrupted? A Cloud Workspace should have no `local` rows;
    /// any that exist were stranded by a crash between registration and the row
    /// flip on an older build, and flipping them is always correct.
    pub fn heal_stranded_local_rows(&self, workspace_id: &str) -> Result<i64> {
        self.require_writer()?;
        promote_local_rows_in(&self.conn, workspace_id)
    }

    /// Record or revoke the bulk-import disclosure confirmation.
    pub fn set_import_approved(&self, approved: bool) -> Result<()> {
        self.require_writer()?;
        self.conn.execute(
            "UPDATE binding SET import_approved = ?1, updated_at = ?2 WHERE id = 1",
            rusqlite::params![i64::from(approved), Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// Remember whether the server rejected this identity.
    pub fn set_drain_state(&self, state: DrainGate) -> Result<()> {
        self.require_writer()?;
        self.conn.execute(
            "UPDATE binding SET drain_state = ?1, updated_at = ?2 WHERE id = 1",
            rusqlite::params![state.as_str(), Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// Stop or resume capture. Never deletes what is already recorded.
    pub fn set_binding_enabled(&self, enabled: bool) -> Result<()> {
        self.require_writer()?;
        self.conn.execute(
            "UPDATE binding SET enabled = ?1, updated_at = ?2 WHERE id = 1",
            rusqlite::params![i64::from(enabled), Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    // ── The outbox ──────────────────────────────────────────────────────────

    /// The next batch of pending rows, in sequence order.
    ///
    /// Ordered by `seq` so a Session's own rows arrive in the order they
    /// happened, and bounded by **both** a count and a byte ceiling — a hundred
    /// artifacts can be enormous, and a request the server refuses on size would
    /// otherwise be retried forever.
    ///
    /// Rows already marked `failed` are excluded, which is what lets one poison
    /// row be skipped while everything behind it keeps draining.
    pub fn pending_artifacts(
        &self,
        workspace_id: &str,
        wire_workspace_id: &str,
        org_id: &str,
        max_count: usize,
        max_bytes: usize,
    ) -> Result<Vec<crate::artifacts::AtlasArtifact>> {
        use crate::artifacts::*;

        let mut out: Vec<AtlasArtifact> = Vec::new();
        let mut bytes = 0usize;

        // The byte ceiling is checked *before* appending, so a batch never
        // overshoots the limit the server enforces — except for a single
        // artifact that is alone over the ceiling, which still ships by itself
        // rather than deadlocking the queue.
        macro_rules! push_or_stop {
            ($artifact:expr) => {{
                let artifact = $artifact;
                let cost = artifact.approx_bytes();
                if !out.is_empty() && (out.len() >= max_count || bytes + cost > max_bytes) {
                    return Ok(out);
                }
                bytes += cost;
                out.push(artifact);
                if out.len() >= max_count || bytes >= max_bytes {
                    return Ok(out);
                }
            }};
        }

        // Sessions first: a Message referencing a Session the server has not
        // seen is a dangling reference of a different kind.
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {SESSION_COLUMNS} FROM agent_session
              WHERE workspace_id = ?1 AND sync_state = 'pending'
              ORDER BY started_at LIMIT ?2"
        ))?;
        let sessions = stmt
            .query_map(rusqlite::params![workspace_id, max_count as i64], row_to_session)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for session in sessions {
            // The hash covers the fields that can change after a first send —
            // title, totals, model — so a mutated Session re-sends as new
            // content instead of being dropped by the server's replay dedupe.
            let token_totals = serde_json::to_value(session.token_totals)
                .unwrap_or(serde_json::Value::Null);
            let content_hash = blobs::key_for(
                format!(
                    "{}:{}:{}:{}:{}",
                    session.id,
                    session.title.as_deref().unwrap_or(""),
                    session.agent.as_deref().unwrap_or(""),
                    session.model.as_deref().unwrap_or(""),
                    token_totals
                )
                .as_bytes(),
            );
            push_or_stop!(AtlasArtifact::AgentSession(SessionArtifact {
                base: ArtifactBase {
                    row_id: session.id.clone(),
                    org_id: org_id.to_string(),
                    workspace_id: wire_workspace_id.to_string(),
                    seq: 0,
                    content_hash,
                    created_at: session.started_at.to_rfc3339(),
                },
                session_id: session.id.clone(),
                source: session.source.as_str().to_string(),
                native_session_id: session.native_session_id.clone(),
                title: session.title.clone(),
                agent: session.agent.clone(),
                model: session.model.clone(),
                token_totals,
                started_at: session.started_at.to_rfc3339(),
            }));
        }

        // Rows from aborted turns stay home: a turn the process died inside is
        // not a completed turn, and uploading its fragments would present them
        // to the Organisation as finished work. The abort verdict lives only in
        // the local `turn` table, so the server could never learn otherwise.
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {MESSAGE_COLUMNS} FROM agent_message m
              WHERE sync_state = 'pending'
                AND session_id IN (SELECT id FROM agent_session WHERE workspace_id = ?1)
                AND NOT EXISTS (
                    SELECT 1 FROM turn t
                     WHERE t.session_id = m.session_id
                       AND t.turn_seq = m.turn_seq
                       AND t.state = 'aborted')
              ORDER BY seq LIMIT ?2"
        ))?;
        let messages = stmt
            .query_map(rusqlite::params![workspace_id, max_count as i64], row_to_message)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for message in messages {
            push_or_stop!(AtlasArtifact::AgentMessage(MessageArtifact {
                base: ArtifactBase {
                    row_id: message.id.clone(),
                    org_id: org_id.to_string(),
                    workspace_id: wire_workspace_id.to_string(),
                    seq: message.seq,
                    content_hash: message.content_hash.clone(),
                    created_at: message.created_at.to_rfc3339(),
                },
                session_id: message.session_id.clone(),
                turn_seq: message.turn_seq,
                role: message.role.as_str().to_string(),
                mode: message.mode.as_str().to_string(),
                preview: message.preview.clone(),
                body: message.body.clone(),
                body_ref: message.body_ref.clone(),
            }));
        }

        let mut stmt = self.conn.prepare(&format!(
            "SELECT {TOOL_CALL_COLUMNS} FROM tool_call c
              WHERE sync_state = 'pending'
                AND session_id IN (SELECT id FROM agent_session WHERE workspace_id = ?1)
                AND NOT EXISTS (
                    SELECT 1 FROM turn t
                     WHERE t.session_id = c.session_id
                       AND t.turn_seq = c.turn_seq
                       AND t.state = 'aborted')
              ORDER BY seq LIMIT ?2"
        ))?;
        let calls = stmt
            .query_map(rusqlite::params![workspace_id, max_count as i64], row_to_tool_call)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for call in calls {
            // Status and payload refs change across a call's lifetime; hash them
            // so a completed call re-sends over its earlier pending sighting.
            let content_hash = blobs::key_for(
                format!(
                    "{}:{}:{}:{}",
                    call.id,
                    call.status.as_str(),
                    call.result_ref.as_deref().unwrap_or(""),
                    call.result.as_deref().unwrap_or("")
                )
                .as_bytes(),
            );
            push_or_stop!(AtlasArtifact::ToolCall(ToolCallArtifact {
                base: ArtifactBase {
                    row_id: call.id.clone(),
                    org_id: org_id.to_string(),
                    workspace_id: wire_workspace_id.to_string(),
                    seq: call.seq,
                    content_hash,
                    created_at: call.created_at.to_rfc3339(),
                },
                session_id: call.session_id.clone(),
                turn_seq: call.turn_seq,
                tool_name: call.tool_name.as_str().to_string(),
                title: call.title.clone(),
                kind: call.kind.clone(),
                status: call.status.as_str().to_string(),
                locations: call.locations.clone(),
                arguments: call.arguments.clone(),
                arguments_ref: call.arguments_ref.clone(),
                result: call.result.clone(),
                result_ref: call.result_ref.clone(),
                result_binary: call.result_binary,
            }));
        }

        let mut stmt = self.conn.prepare(&format!(
            "SELECT {CHECKPOINT_COLUMNS} FROM checkpoint
              WHERE sync_state = 'pending'
                AND session_id IN (SELECT id FROM agent_session WHERE workspace_id = ?1)
              ORDER BY created_at LIMIT ?2"
        ))?;
        let checkpoints = stmt
            .query_map(rusqlite::params![workspace_id, max_count as i64], row_to_checkpoint)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for checkpoint in checkpoints {
            let artifact = AtlasArtifact::Checkpoint(CheckpointArtifact {
                base: ArtifactBase {
                    row_id: checkpoint.id.clone(),
                    org_id: org_id.to_string(),
                    workspace_id: wire_workspace_id.to_string(),
                    seq: 0,
                    // (session, commit) is the Checkpoint's natural key; the
                    // link state is folded in so a re-point or an orphaning
                    // re-sends as changed content rather than being dropped by
                    // the server's replay dedupe.
                    content_hash: blobs::key_for(
                        format!(
                            "{}:{}:{}",
                            checkpoint.session_id,
                            checkpoint.commit_sha,
                            checkpoint.link_state.as_str()
                        )
                        .as_bytes(),
                    ),
                    created_at: checkpoint.created_at.to_rfc3339(),
                },
                session_id: checkpoint.session_id.clone(),
                commit_sha: checkpoint.commit_sha.clone(),
                patch_id: checkpoint.patch_id.clone(),
                link_state: checkpoint.link_state.as_str().to_string(),
                branch: checkpoint.branch.clone(),
                git_author_name: checkpoint.git_author_name.clone(),
                git_author_email: checkpoint.git_author_email.clone(),
                files_touched: checkpoint.files_touched.clone(),
                insertions: checkpoint.insertions,
                deletions: checkpoint.deletions,
            });
            push_or_stop!(artifact);
        }

        Ok(out)
    }

    /// Mark every pending row that has exhausted its attempts as `failed`.
    ///
    /// This is what makes the poison-row guarantee real for *batch-level*
    /// rejections, where the server never names the offending row: attempts
    /// accrue per pass, and once a row crosses the cap it leaves the queue so
    /// everything behind it drains. Returns how many rows were failed.
    pub fn mark_exhausted_rows_failed(
        &self,
        workspace_id: &str,
        max_attempts: i64,
    ) -> Result<i64> {
        self.require_writer()?;
        let mut failed = 0i64;
        failed += self.conn.execute(
            "UPDATE agent_session SET sync_state = 'failed'
              WHERE workspace_id = ?1 AND sync_state = 'pending' AND sync_attempts >= ?2",
            rusqlite::params![workspace_id, max_attempts],
        )? as i64;
        for table in ["agent_message", "tool_call", "checkpoint"] {
            failed += self.conn.execute(
                &format!(
                    "UPDATE {table} SET sync_state = 'failed'
                      WHERE sync_state = 'pending' AND sync_attempts >= ?2
                        AND session_id IN (SELECT id FROM agent_session WHERE workspace_id = ?1)"
                ),
                rusqlite::params![workspace_id, max_attempts],
            )? as i64;
        }
        Ok(failed)
    }

    /// Give every `failed` row another chance: flip it back to `pending` with a
    /// fresh attempt count. The `failed → pending` transition of the outbox
    /// state machine — a deliberate human action, never automatic.
    pub fn retry_failed_rows(&self, workspace_id: &str) -> Result<i64> {
        self.require_writer()?;
        let mut retried = 0i64;
        retried += self.conn.execute(
            "UPDATE agent_session SET sync_state = 'pending', sync_attempts = 0
              WHERE workspace_id = ?1 AND sync_state = 'failed'",
            [workspace_id],
        )? as i64;
        for table in ["agent_message", "tool_call", "checkpoint"] {
            retried += self.conn.execute(
                &format!(
                    "UPDATE {table} SET sync_state = 'pending', sync_attempts = 0
                      WHERE sync_state = 'failed'
                        AND session_id IN (SELECT id FROM agent_session WHERE workspace_id = ?1)"
                ),
                [workspace_id],
            )? as i64;
        }
        Ok(retried)
    }

    /// Re-key every row after the project folder moved.
    ///
    /// The Workspace's identity must survive renaming the repo folder: `.atlas/`
    /// travels with the directory, but rows written under the old absolute path
    /// would be invisible to every query keyed on the new one — the timeline,
    /// the health counts and the promotion preview would all silently read as
    /// empty. One transaction, so a crash re-keys nothing rather than half.
    pub fn rekey_workspace(&self, old_workspace_id: &str, new_workspace_id: &str, new_root: &str) -> Result<()> {
        if old_workspace_id == new_workspace_id {
            return Ok(());
        }
        self.require_writer()?;
        let now = Utc::now().to_rfc3339();
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE agent_session SET workspace_id = ?2 WHERE workspace_id = ?1",
            rusqlite::params![old_workspace_id, new_workspace_id],
        )?;
        tx.execute(
            "UPDATE workspace_cursor SET workspace_id = ?2 WHERE workspace_id = ?1",
            rusqlite::params![old_workspace_id, new_workspace_id],
        )?;
        tx.execute(
            "UPDATE binding SET workspace_id = ?1, root = ?2, updated_at = ?3 WHERE id = 1",
            rusqlite::params![new_workspace_id, new_root, now],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Mark a row as durably accepted by the server.
    ///
    /// The row id identifies its table by prefix, so one call handles every
    /// artifact kind without the caller tracking which is which.
    pub fn mark_sent(&self, row_id: &str) -> Result<()> {
        self.set_row_sync_state(row_id, SyncState::Sent)
    }

    /// Mark a row as permanently rejected — skipped, never retried at the head
    /// of the queue, so one poison row cannot stall everything behind it.
    pub fn mark_failed(&self, row_id: &str) -> Result<()> {
        self.set_row_sync_state(row_id, SyncState::Failed)
    }

    /// Count one more attempt against a row.
    pub fn record_attempt(&self, row_id: &str) -> Result<()> {
        self.require_writer()?;
        let Some(table) = table_for(row_id) else { return Ok(()) };
        self.conn.execute(
            &format!("UPDATE {table} SET sync_attempts = sync_attempts + 1 WHERE id = ?1"),
            [row_id],
        )?;
        Ok(())
    }

    pub fn attempts(&self, row_id: &str) -> Result<i64> {
        let Some(table) = table_for(row_id) else { return Ok(0) };
        Ok(self.conn.query_row(
            &format!("SELECT sync_attempts FROM {table} WHERE id = ?1"),
            [row_id],
            |row| row.get(0),
        )?)
    }

    fn set_row_sync_state(&self, row_id: &str, state: SyncState) -> Result<()> {
        self.require_writer()?;
        let Some(table) = table_for(row_id) else { return Ok(()) };
        self.conn.execute(
            &format!("UPDATE {table} SET sync_state = ?2 WHERE id = ?1"),
            rusqlite::params![row_id, state.as_str()],
        )?;
        Ok(())
    }

    /// Flip every `local` row to `pending`, atomically.
    ///
    /// Promotion's whole mechanism. There is deliberately **no separate backfill
    /// path**: the accumulated history joins the same queue as everything else,
    /// so there is one drain to keep correct rather than two. Prefer
    /// [`Store::promote_to_cloud`], which also flips the binding in the same
    /// transaction.
    pub fn promote_local_rows(&self, workspace_id: &str) -> Result<i64> {
        self.require_writer()?;
        let tx = self.conn.unchecked_transaction()?;
        let moved = promote_local_rows_in(&tx, workspace_id)?;
        tx.commit()?;
        Ok(moved)
    }

    // ── Import progress ─────────────────────────────────────────────────────

    /// How many bytes of this transcript have already been imported.
    pub fn import_progress(&self, path: &str) -> Result<Option<u64>> {
        Ok(self
            .conn
            .query_row(
                "SELECT imported_size FROM import_progress WHERE path = ?1",
                [path],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .map(|size| size as u64))
    }

    /// Record how far a transcript has been imported.
    ///
    /// Written only after the content is durably stored, so an interrupted
    /// import resumes rather than skipping the part it had not finished.
    pub fn set_import_progress(&self, path: &str, size: u64) -> Result<()> {
        self.require_writer()?;
        self.conn.execute(
            "INSERT INTO import_progress (path, imported_size, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT (path) DO UPDATE SET imported_size = ?2, updated_at = ?3",
            rusqlite::params![path, size as i64, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// The `.atlas` directory this store lives in — home for import sidecars
    /// (cache files that must NOT live in the schema-gated database).
    pub(crate) fn atlas_root(&self) -> &Path {
        &self.root
    }

    // ── Checkpoints and the commit cursor ───────────────────────────────────

    /// Create a Checkpoint, or leave the existing one alone.
    ///
    /// `(Session, commit)` is the idempotency key, so re-running the walk over
    /// commits already seen creates nothing — which is what makes the bounded
    /// re-scan recovery path safe.
    pub fn upsert_checkpoint(&self, input: CheckpointInput<'_>) -> Result<String> {
        self.require_writer()?;

        if let Some(id) = self.checkpoint_id_for(input.session_id, input.commit_sha)? {
            return Ok(id);
        }

        let id = format!("cp-{}", uuid::Uuid::new_v4().simple());
        self.conn.execute(
            "INSERT INTO checkpoint
                (id, session_id, commit_sha, patch_id, link_state, branch,
                 git_author_name, git_author_email, files_touched, insertions,
                 deletions, created_at, sync_state)
             VALUES (?1, ?2, ?3, ?4, 'linked', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            rusqlite::params![
                id,
                input.session_id,
                input.commit_sha,
                input.patch_id,
                input.branch,
                input.git_author_name,
                input.git_author_email,
                serde_json::to_string(input.files_touched).unwrap_or_else(|_| "[]".into()),
                input.insertions,
                input.deletions,
                Utc::now().to_rfc3339(),
                input.sync_state.as_str(),
            ],
        )?;
        Ok(id)
    }

    pub fn checkpoint_id_for(&self, session_id: &str, commit_sha: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id FROM checkpoint WHERE session_id = ?1 AND commit_sha = ?2",
                rusqlite::params![session_id, commit_sha],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn checkpoints_for_session(&self, session_id: &str) -> Result<Vec<Checkpoint>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {CHECKPOINT_COLUMNS} FROM checkpoint WHERE session_id = ?1 ORDER BY created_at"
        ))?;
        let rows = stmt.query_map([session_id], row_to_checkpoint)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn checkpoints_for_commit(&self, commit_sha: &str) -> Result<Vec<Checkpoint>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {CHECKPOINT_COLUMNS} FROM checkpoint WHERE commit_sha = ?1"
        ))?;
        let rows = stmt.query_map([commit_sha], row_to_checkpoint)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Every Checkpoint belonging to a Workspace's Sessions.
    pub fn checkpoints_for_workspace(&self, workspace_id: &str) -> Result<Vec<Checkpoint>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {CHECKPOINT_COLUMNS} FROM checkpoint
              WHERE session_id IN (SELECT id FROM agent_session WHERE workspace_id = ?1)
              ORDER BY created_at"
        ))?;
        let rows = stmt.query_map([workspace_id], row_to_checkpoint)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The newest Checkpoints in this Workspace, with the title of the Session
    /// that produced each.
    ///
    /// The title is joined here rather than looked up per row: the picker this
    /// feeds shows every Checkpoint with the work it came from, and N+1 reads
    /// for a list that is capped anyway is a query the store can just answer.
    pub fn recent_checkpoints(
        &self,
        workspace_id: &str,
        limit: i64,
    ) -> Result<Vec<(Checkpoint, Option<String>)>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {}, s.title
               FROM checkpoint c
               JOIN agent_session s ON s.id = c.session_id
              WHERE s.workspace_id = ?1
              ORDER BY c.created_at DESC
              LIMIT ?2",
            CHECKPOINT_COLUMNS
                .split(", ")
                .map(|c| format!("c.{}", c.trim()))
                .collect::<Vec<_>>()
                .join(", "),
        ))?;
        let rows = stmt.query_map(rusqlite::params![workspace_id, limit], |row| {
            Ok((row_to_checkpoint(row)?, row.get::<_, Option<String>>(14)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Set the Session's starting branch, keeping any value already there.
    pub fn set_branch_if_absent(&self, session_id: &str, branch: &str) -> Result<()> {
        self.require_writer()?;
        self.conn.execute(
            "UPDATE agent_session SET branch = COALESCE(branch, ?2) WHERE id = ?1",
            rusqlite::params![session_id, branch],
        )?;
        Ok(())
    }

    /// Re-point a Checkpoint at the commit now carrying its change.
    ///
    /// If a row for `(session, commit_sha)` already exists — the walk saw the
    /// rewritten commit before reconciliation ran, which is the production
    /// ordering — the stale row is **absorbed** into it rather than UPDATE-ing
    /// into a UNIQUE violation that would wedge reconciliation for every later
    /// pass. A row that was already `sent` flips back to `pending` so the
    /// Organisation timeline learns the commit moved.
    pub fn relink_checkpoint(&self, id: &str, commit_sha: &str, branch: Option<&str>) -> Result<()> {
        self.require_writer()?;
        let tx = self.conn.unchecked_transaction()?;

        let session_id: Option<String> = tx
            .query_row(
                "SELECT session_id FROM checkpoint WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(session_id) = session_id else {
            return Ok(());
        };

        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM checkpoint WHERE session_id = ?1 AND commit_sha = ?2",
                rusqlite::params![session_id, commit_sha],
                |row| row.get(0),
            )
            .optional()?;

        match existing {
            Some(target_id) if target_id != id => {
                // The walk already created the row at the new sha. Keep that one
                // (it carries the freshly-computed diff stats). The stale row is
                // deleted only if the server never saw it; a row already `sent`
                // becomes an orphan tombstone that re-syncs, because deleting it
                // locally would leave the server permanently claiming a live
                // link to a commit that no longer exists.
                let stale_state: String = tx.query_row(
                    "SELECT sync_state FROM checkpoint WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )?;
                if stale_state == "sent" {
                    tx.execute(
                        "UPDATE checkpoint SET link_state = 'orphaned', sync_state = 'pending'
                          WHERE id = ?1",
                        [id],
                    )?;
                } else {
                    tx.execute("DELETE FROM checkpoint WHERE id = ?1", [id])?;
                }
                tx.execute(
                    &format!(
                        "UPDATE checkpoint SET link_state = 'linked',
                                branch = COALESCE(?2, branch){RESYNC_ROW}
                          WHERE id = ?1"
                    ),
                    rusqlite::params![target_id, branch],
                )?;
            }
            _ => {
                tx.execute(
                    &format!(
                        "UPDATE checkpoint SET commit_sha = ?2, link_state = 'linked',
                                branch = COALESCE(?3, branch){RESYNC_ROW}
                          WHERE id = ?1"
                    ),
                    rusqlite::params![id, commit_sha, branch],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Mark a Checkpoint's commit as gone.
    ///
    /// Never deletes the row and never drops the Session link: losing the link
    /// is a real event the record should be honest about, and it is recoverable
    /// if the commit becomes reachable again. A row already `sent` flips back to
    /// `pending`, because the Organisation timeline claiming a live link to a
    /// vanished commit is exactly the confident lie orphaning exists to avoid.
    pub fn orphan_checkpoint(&self, id: &str) -> Result<()> {
        self.require_writer()?;
        self.conn.execute(
            &format!("UPDATE checkpoint SET link_state = 'orphaned'{RESYNC_ROW} WHERE id = ?1"),
            [id],
        )?;
        Ok(())
    }

    /// How far the commit walk has got for this Workspace.
    pub fn commit_cursor(&self, workspace_id: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT last_seen_commit FROM workspace_cursor WHERE workspace_id = ?1",
                [workspace_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    /// Advance the cursor.
    ///
    /// Called only after the Checkpoints for the range are durably written, so a
    /// crash mid-walk re-processes rather than skips. `recovered` records that a
    /// bounded re-scan was needed, which the capture-health signal surfaces.
    pub fn set_commit_cursor(
        &self,
        workspace_id: &str,
        commit: &str,
        recovered: bool,
    ) -> Result<()> {
        self.require_writer()?;
        self.conn.execute(
            "INSERT INTO workspace_cursor (workspace_id, last_seen_commit, recovered, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (workspace_id) DO UPDATE
                SET last_seen_commit = ?2,
                    recovered = ?3,
                    updated_at = ?4",
            rusqlite::params![
                workspace_id,
                commit,
                i64::from(recovered),
                Utc::now().to_rfc3339()
            ],
        )?;
        Ok(())
    }

    /// Record what the last reconciliation pass did (a small JSON note), so the
    /// capture-health signal can surface a mass-orphan or a wedged pass instead
    /// of leaving it in a log file nobody reads.
    pub fn set_reconcile_note(&self, workspace_id: &str, note: &str) -> Result<()> {
        self.require_writer()?;
        self.conn.execute(
            "INSERT INTO workspace_cursor (workspace_id, last_seen_commit, recovered, reconcile_note, updated_at)
             VALUES (?1, NULL, 0, ?2, ?3)
             ON CONFLICT (workspace_id) DO UPDATE
                SET reconcile_note = ?2, updated_at = ?3",
            rusqlite::params![workspace_id, note, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn reconcile_note(&self, workspace_id: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT reconcile_note FROM workspace_cursor WHERE workspace_id = ?1",
                [workspace_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    /// Did the last walk have to recover its cursor by re-scanning?
    pub fn cursor_recovered(&self, workspace_id: &str) -> Result<bool> {
        Ok(self
            .conn
            .query_row(
                "SELECT recovered FROM workspace_cursor WHERE workspace_id = ?1",
                [workspace_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0)
            != 0)
    }

    /// Live Sessions in a Workspace, with the *unconsumed* files each left
    /// behind.
    ///
    /// Only live Sessions: an imported one has no write-time `existed_before`,
    /// and the link rule cannot honestly run without it.
    ///
    /// Only unconsumed touches: once a commit has carried a touch's work, that
    /// touch is spent. Without consumption, every future commit that happens to
    /// modify the same path — including purely human work months later, and
    /// teammate commits arriving via pull — would be attributed to the Session
    /// forever. This mirrors the carry-forward rule in Entire's link engine,
    /// which is the load-bearing half of the asymmetric rule.
    pub fn link_candidates(&self, workspace_id: &str) -> Result<Vec<LinkCandidate>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, started_at FROM agent_session
              WHERE workspace_id = ?1 AND source IN ('acp', 'cersei')",
        )?;
        let ids: Vec<(String, String)> = stmt
            .query_map([workspace_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut out = Vec::new();
        for (id, started_at) in ids {
            let touches = self.unconsumed_file_touches(&id)?;
            if !touches.is_empty() {
                out.push(LinkCandidate {
                    session_id: id,
                    started_at: parse_time(started_at),
                    touches,
                });
            }
        }
        Ok(out)
    }

    /// The last touch of each path in a turn that no commit has consumed yet.
    fn unconsumed_file_touches(&self, session_id: &str) -> Result<Vec<FileTouch>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {FILE_TOUCH_COLUMNS} FROM file_touch
              WHERE session_id = ?1
                AND consumed_by_commit IS NULL
                AND seq IN (
                    SELECT MAX(seq) FROM file_touch
                     WHERE session_id = ?1 GROUP BY turn_seq, path
                )
              ORDER BY seq"
        ))?;
        let rows = stmt.query_map([session_id], row_to_file_touch)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Mark a Session's touches on these paths as consumed by a commit.
    ///
    /// Called after the walk links (or deliberately skips) a commit carrying
    /// them. From then on the touches no longer nominate the Session for later
    /// commits — the work landed; what happens to those files afterwards is not
    /// the Session's doing.
    ///
    /// Bounded by `up_to`: a commit consumes only touches that existed when it
    /// was made. A Session that edits a file, sees it committed, edits it again
    /// and sees that committed spans two commits — and must produce a
    /// Checkpoint for each, even when both commits are walked in one batch
    /// after Atlas was closed. The second touch postdates the first commit, so
    /// the first commit cannot consume it.
    pub fn consume_touches(
        &self,
        session_id: &str,
        commit_sha: &str,
        paths: &[String],
        up_to: DateTime<Utc>,
    ) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        self.require_writer()?;
        let tx = self.conn.unchecked_transaction()?;
        for path in paths {
            tx.execute(
                "UPDATE file_touch SET consumed_by_commit = ?3
                  WHERE session_id = ?1 AND path = ?2 AND consumed_by_commit IS NULL
                    AND created_at <= ?4",
                rusqlite::params![session_id, path, commit_sha, up_to.to_rfc3339()],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    // ── Maintenance ─────────────────────────────────────────────────────────

    /// Turns still marked open on startup were abandoned — the process died
    /// mid-turn. Mark them so nothing downstream reads them as finished.
    fn reconcile_aborted_turns(&self) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE turn SET state = 'aborted', ended_at = ?1 WHERE state = 'open'",
            [Utc::now().to_rfc3339()],
        )?)
    }

    /// Can this store actually be written to right now?
    ///
    /// Distinct from holding the writer lock: the lock says another window is
    /// recording, this says the disk is full or the directory is read-only. Both
    /// stop capture, and a developer needs to be told which.
    ///
    /// Verified by writing rather than by inspecting permissions — a read-only
    /// volume, a full disk and a revoked directory permission all look fine to a
    /// metadata check and all fail at the moment it matters.
    pub fn check_writable(&self) -> Result<()> {
        let probe = self.root.join(".write-probe");
        std::fs::write(&probe, b"")
            .map_err(|e| Error::Storage(format!("{}: {e}", self.root.display())))?;
        let _ = std::fs::remove_file(&probe);
        Ok(())
    }

    /// Sessions flagged during capture — a redaction or storage failure.
    pub fn flagged_session_count(&self, workspace_id: &str) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM agent_session
              WHERE workspace_id = ?1 AND needs_attention = 1",
            [workspace_id],
            |row| row.get(0),
        )?)
    }

    /// How many rows across every synced table are in `state`.
    ///
    /// Counts Sessions, Messages, tool calls and Checkpoints together, because
    /// "3 pending" should mean three things waiting rather than three of one
    /// arbitrary kind.
    pub fn row_count_in_state(&self, workspace_id: &str, state: SyncState) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT
               (SELECT COUNT(*) FROM agent_session
                 WHERE workspace_id = ?1 AND sync_state = ?2)
             + (SELECT COUNT(*) FROM agent_message
                 WHERE sync_state = ?2
                   AND session_id IN (SELECT id FROM agent_session WHERE workspace_id = ?1))
             + (SELECT COUNT(*) FROM tool_call
                 WHERE sync_state = ?2
                   AND session_id IN (SELECT id FROM agent_session WHERE workspace_id = ?1))
             + (SELECT COUNT(*) FROM checkpoint
                 WHERE sync_state = ?2
                   AND session_id IN (SELECT id FROM agent_session WHERE workspace_id = ?1))",
            rusqlite::params![workspace_id, state.as_str()],
            |row| row.get(0),
        )?)
    }

    /// Every index the store guarantees, as the database actually has them.
    pub fn index_names(&self) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn require_writer(&self) -> Result<()> {
        if self.is_writer() {
            Ok(())
        } else {
            Err(Error::AlreadyLocked)
        }
    }
}

/// Appended to an UPDATE's SET list: a row the server already accepted flips
/// back to `pending` when its content changes, so the Organisation's copy does
/// not go permanently stale. A `local` row stays `local`.
const RESYNC_SESSION: &str =
    ", sync_state = CASE WHEN sync_state = 'sent' THEN 'pending' ELSE sync_state END";
const RESYNC_ROW: &str =
    ", sync_state = CASE WHEN sync_state = 'sent' THEN 'pending' ELSE sync_state END";

/// A live Session nominated for the link rule by touches no commit has
/// consumed yet.
pub struct LinkCandidate {
    pub session_id: String,
    pub started_at: DateTime<Utc>,
    pub touches: Vec<FileTouch>,
}

/// Everything needed to write one Message.
pub struct MessageInput<'a> {
    pub session_id: &'a str,
    pub turn_seq: i64,
    /// The agent's own id for this message, when it has one — the idempotency key.
    pub native_message_id: Option<&'a str>,
    pub role: Role,
    pub mode: Mode,
    /// **Already redacted.** The store does not scrub; `capture` does, before
    /// calling here, so there is exactly one place that can be forgotten.
    pub body: &'a str,
    pub sync_state: SyncState,
    /// When this turn actually happened. `None` means "now" — live capture.
    /// The importer passes the transcript's own timestamp so history keeps its
    /// real dates.
    pub created_at: Option<DateTime<Utc>>,
}

/// A tool call's result payload, which is not always text.
pub enum ToolPayload<'a> {
    None,
    /// Already redacted.
    Text(&'a str),
    /// Not valid UTF-8 — a compiled binary, an image, a truncated read. Stored
    /// verbatim and skipped by string redaction, because lossy-decoding it to
    /// scan would corrupt the payload on the way back out for no benefit: there
    /// is no secret to find in bytes that cannot be read as text.
    Binary(&'a [u8]),
}

/// Everything needed to record or update one tool call.
pub struct ToolCallInput<'a> {
    pub session_id: &'a str,
    pub turn_seq: i64,
    /// The agent's own id for the call — the idempotency key across its first
    /// sighting and every later update.
    pub native_call_id: Option<&'a str>,
    /// Derived; see [`crate::tools::canonical_name`].
    pub tool_name: ToolName,
    pub title: Option<&'a str>,
    pub kind: Option<&'a str>,
    pub status: ToolStatus,
    pub locations: &'a serde_json::Value,
    /// **Already redacted.**
    pub arguments: Option<&'a str>,
    pub result: ToolPayload<'a>,
    pub sync_state: SyncState,
}

pub struct FileTouchInput<'a> {
    pub tool_call_id: &'a str,
    pub session_id: &'a str,
    pub turn_seq: i64,
    /// NFC-normalised, workspace-relative.
    pub path: &'a str,
    pub sha256_after: Option<&'a str>,
    pub existed_before: bool,
    pub deleted: bool,
    pub out_of_repo: bool,
}

pub struct AgentEditInput<'a> {
    pub tool_call_id: &'a str,
    pub session_id: &'a str,
    pub turn_seq: i64,
    pub path: &'a str,
    /// **Already redacted.**
    pub patch: Option<&'a str>,
}

const TOOL_CALL_COLUMNS: &str = "id, session_id, seq, turn_seq, tool_name, title, kind, status, \
     locations, arguments, arguments_ref, result, result_ref, result_binary, created_at, sync_state";

fn row_to_tool_call(row: &rusqlite::Row<'_>) -> rusqlite::Result<ToolCall> {
    let tool_name: String = row.get(4)?;
    let status: String = row.get(7)?;
    let locations: String = row.get(8)?;
    let sync_state: String = row.get(15)?;
    Ok(ToolCall {
        id: row.get(0)?,
        session_id: row.get(1)?,
        seq: row.get(2)?,
        turn_seq: row.get(3)?,
        tool_name: ToolName::parse(&tool_name).unwrap_or(ToolName::Other),
        title: row.get(5)?,
        kind: row.get(6)?,
        status: ToolStatus::parse(&status).unwrap_or(ToolStatus::Completed),
        locations: serde_json::from_str(&locations).unwrap_or(serde_json::Value::Array(Vec::new())),
        arguments: row.get(9)?,
        arguments_ref: row.get(10)?,
        result: row.get(11)?,
        result_ref: row.get(12)?,
        result_binary: row.get::<_, i64>(13)? != 0,
        created_at: parse_time(row.get::<_, String>(14)?),
        sync_state: SyncState::parse(&sync_state).unwrap_or(SyncState::Local),
    })
}

const FILE_TOUCH_COLUMNS: &str = "id, tool_call_id, session_id, turn_seq, seq, path, \
     sha256_after, existed_before, deleted, out_of_repo, created_at";

fn row_to_file_touch(row: &rusqlite::Row<'_>) -> rusqlite::Result<FileTouch> {
    Ok(FileTouch {
        id: row.get(0)?,
        tool_call_id: row.get(1)?,
        session_id: row.get(2)?,
        turn_seq: row.get(3)?,
        seq: row.get(4)?,
        path: row.get(5)?,
        sha256_after: row.get(6)?,
        existed_before: row.get::<_, i64>(7)? != 0,
        deleted: row.get::<_, i64>(8)? != 0,
        out_of_repo: row.get::<_, i64>(9)? != 0,
        created_at: parse_time(row.get::<_, String>(10)?),
    })
}

/// Flip every `local` row of a Workspace to `pending`, on any connection-like
/// handle — the shared body of [`Store::promote_to_cloud`],
/// [`Store::promote_local_rows`] and [`Store::heal_stranded_local_rows`].
fn promote_local_rows_in(conn: &Connection, workspace_id: &str) -> Result<i64> {
    let mut moved = 0i64;
    moved += conn.execute(
        "UPDATE agent_session SET sync_state = 'pending'
          WHERE workspace_id = ?1 AND sync_state = 'local'",
        [workspace_id],
    )? as i64;
    for table in ["agent_message", "tool_call", "checkpoint"] {
        moved += conn.execute(
            &format!(
                "UPDATE {table} SET sync_state = 'pending'
                  WHERE sync_state = 'local'
                    AND session_id IN (SELECT id FROM agent_session WHERE workspace_id = ?1)"
            ),
            [workspace_id],
        )? as i64;
    }
    Ok(moved)
}

/// Which table a row id belongs to.
///
/// Ids are prefixed at creation (`as-`, `am-`, `tc-`, `cp-`) precisely so the
/// drain can mark a row without also tracking which kind it was — the server's
/// per-artifact result carries only the id.
fn table_for(row_id: &str) -> Option<&'static str> {
    match row_id.split('-').next()? {
        "as" => Some("agent_session"),
        "am" => Some("agent_message"),
        "tc" => Some("tool_call"),
        "cp" => Some("checkpoint"),
        _ => None,
    }
}

/// Make `.atlas/` ignore itself.
///
/// The app separately offers to append `.atlas/` to the *project's* `.gitignore`,
/// but that is a user-toggleable setting and a no-op on a repository that has no
/// `.gitignore` yet — so it cannot be relied on. It matters much more now than it
/// did when this directory only held small JSON files: a SQLite database brings
/// `-wal` and `-shm` sidecars that change on every write, and if they are not
/// ignored then `git add -A` sweeps them into the developer's commits, breaks
/// `git checkout` with "local changes would be overwritten", and pushes the
/// session store itself to a shared remote.
///
/// A `.gitignore` *inside* the directory ignores everything in it regardless of
/// what the project's rules say, needs no setting, and needs no cooperation from
/// a repository that may not exist yet. Best-effort: failing to write it is not
/// worth refusing to record a Session over.
fn ensure_self_ignored(root: &Path) {
    let marker = root.join(".gitignore");
    if marker.exists() {
        return;
    }
    let _ = fs::write(
        &marker,
        "# Atlas per-project state. Never committed: it holds the local session\n\
         # store (plus its SQLite -wal/-shm sidecars) and is machine-specific.\n\
         *\n",
    );
}

pub struct CheckpointInput<'a> {
    pub session_id: &'a str,
    pub commit_sha: &'a str,
    pub patch_id: Option<&'a str>,
    pub branch: Option<&'a str>,
    pub git_author_name: Option<&'a str>,
    pub git_author_email: Option<&'a str>,
    pub files_touched: &'a [String],
    pub insertions: i64,
    pub deletions: i64,
    pub sync_state: SyncState,
}

const CHECKPOINT_COLUMNS: &str = "id, session_id, commit_sha, patch_id, link_state, branch, \
     git_author_name, git_author_email, files_touched, insertions, deletions, attribution, \
     created_at, sync_state";

fn row_to_checkpoint(row: &rusqlite::Row<'_>) -> rusqlite::Result<Checkpoint> {
    let link_state: String = row.get(4)?;
    let files: String = row.get(8)?;
    let attribution: Option<String> = row.get(11)?;
    let sync_state: String = row.get(13)?;
    Ok(Checkpoint {
        id: row.get(0)?,
        session_id: row.get(1)?,
        commit_sha: row.get(2)?,
        patch_id: row.get(3)?,
        link_state: LinkState::parse(&link_state).unwrap_or(LinkState::Linked),
        branch: row.get(5)?,
        git_author_name: row.get(6)?,
        git_author_email: row.get(7)?,
        files_touched: serde_json::from_str(&files).unwrap_or_default(),
        insertions: row.get(9)?,
        deletions: row.get(10)?,
        attribution: attribution.and_then(|a| serde_json::from_str(&a).ok()),
        created_at: parse_time(row.get::<_, String>(12)?),
        sync_state: SyncState::parse(&sync_state).unwrap_or(SyncState::Local),
    })
}

/// Next value of the store-wide monotonic sequence.
///
/// Taken inside the caller's transaction so the number and the row it labels
/// commit together — a gap would look to the drain like a row it had already
/// seen and skipped.
fn next_seq(tx: &rusqlite::Transaction<'_>) -> Result<i64> {
    tx.execute("UPDATE counter SET value = value + 1 WHERE name = 'seq'", [])?;
    Ok(tx.query_row("SELECT value FROM counter WHERE name = 'seq'", [], |row| {
        row.get(0)
    })?)
}

const SESSION_COLUMNS: &str = "id, workspace_id, source, native_session_id, title, agent, model, \
     cwd, token_totals, summary, started_at, updated_at, needs_attention, \
     attention_reason, redaction_counts, sync_state, branch, last_activity_at";

fn row_to_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<Session> {
    let source: String = row.get(2)?;
    let token_totals: String = row.get(8)?;
    let redaction_counts: String = row.get(14)?;
    let sync_state: String = row.get(15)?;
    Ok(Session {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        source: Source::parse(&source).unwrap_or(Source::Acp),
        native_session_id: row.get(3)?,
        title: row.get(4)?,
        agent: row.get(5)?,
        model: row.get(6)?,
        cwd: row.get(7)?,
        token_totals: serde_json::from_str(&token_totals).unwrap_or_default(),
        summary: row.get(9)?,
        started_at: parse_time(row.get::<_, String>(10)?),
        updated_at: parse_time(row.get::<_, String>(11)?),
        needs_attention: row.get::<_, i64>(12)? != 0,
        attention_reason: row.get(13)?,
        redaction_counts: serde_json::from_str(&redaction_counts)
            .unwrap_or(serde_json::Value::Null),
        sync_state: SyncState::parse(&sync_state).unwrap_or(SyncState::Local),
        branch: row.get(16)?,
        last_activity_at: row.get::<_, Option<String>>(17)?.map(parse_time),
    })
}

const MESSAGE_COLUMNS: &str = "id, session_id, seq, turn_seq, role, mode, preview, body, \
     body_ref, body_bytes, content_hash, created_at, sync_state";

fn row_to_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<Message> {
    let role: String = row.get(4)?;
    let mode: String = row.get(5)?;
    let sync_state: String = row.get(12)?;
    Ok(Message {
        id: row.get(0)?,
        session_id: row.get(1)?,
        seq: row.get(2)?,
        turn_seq: row.get(3)?,
        role: Role::parse(&role).unwrap_or(Role::Assistant),
        mode: Mode::parse(&mode).unwrap_or(Mode::Text),
        preview: row.get(6)?,
        body: row.get(7)?,
        body_ref: row.get(8)?,
        body_bytes: row.get(9)?,
        content_hash: row.get(10)?,
        created_at: parse_time(row.get::<_, String>(11)?),
        sync_state: SyncState::parse(&sync_state).unwrap_or(SyncState::Local),
    })
}

/// A stored timestamp we wrote ourselves. A clock that cannot be parsed is not
/// worth losing a row over, so it falls back to the epoch rather than erroring.
fn parse_time(raw: String) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(&raw)
        .map(|t| t.with_timezone(&Utc))
        .unwrap_or_else(|_| DateTime::<Utc>::from_timestamp(0, 0).expect("epoch is valid"))
}

//! The shared-memory **record store**: one SQLite database per scope.
//!
//! Every agent on a repository — native and ACP — writes into this one record,
//! through the Tauri backend, which is its only writer. It replaces the JSONL
//! event log (`.atlas/shared-memory/events.jsonl` + `state.json`) and absorbs
//! the extracted-memory markdown (`.atlas/memory/extracted/*.md`) on first open
//! (see [`legacy`]).
//!
//! Three tables (`<scope root>/.atlas/memory/memory.sqlite`, WAL):
//!
//! - **events** — the append-only log (`seq`, `ts`, `kind`, `key`, `agent`,
//!   `session`, `payload`). The Shared tab's event list, query and append are
//!   served straight from it, byte-compatible with the JSONL log.
//! - **entries** — the record itself: one row per live memory with its kind,
//!   key, content, provenance (`source`, `agent`, `session`), `confidence`,
//!   timestamps, `uses` and a normalised `content_hash`. Appending an event
//!   folds it into entries with the log's replace rules (same key replaces, a
//!   finished plan clears the active plan, a repeat edit to a path replaces the
//!   earlier one). Nothing is ever evicted: the old per-kind caps are display
//!   limits applied by [`RecordStore::list`].
//! - **sessions** — which agent owned which session, and when it started and
//!   ended.
//!
//! Every write passes through `atlas_redact` before it lands, whoever wrote it.
//!
//! **Concurrency.** One connection per scope per process, behind a mutex:
//! [`open_scope`] hands every caller the same `Arc<RecordStore>` for a root, so
//! the single-writer invariant is a lock, never cross-process coordination.
//! Every method is synchronous and may touch disk; async callers run it on the
//! blocking pool.
//!
//! Entry ids are `INTEGER AUTOINCREMENT` and never reused, so a vector index
//! can key embeddings by entry id; a replaced entry keeps its id.
//!
//! **Near-duplicates.** With an [`Embedder`] installed ([`RecordStore::set_embedder`]),
//! a direct write of a durable kind that matches no key and no content hash is
//! compared by cosine against the scope's stored vectors (the `entry_vectors`
//! table, searched through an in-memory [`HnswStore`] keyed by entry id). At
//! [`NEAR_DUPLICATE`] or above it merges into the surviving entry instead of
//! inserting, bumping that entry's use count. With no model (not downloaded,
//! or it cannot embed a text) dedup is key-or-hash only; a write never fails
//! for want of an embedding. Event-log folds keep the log's exact replace
//! rules and are not near-duplicate merged, so the Shared tab's state view is
//! unchanged by this; their durable entries are embedded all the same, so a
//! later direct write can merge into a captured memory.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock};

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::store::HnswStore;

pub mod legacy;

/// File name of the record database inside `<scope root>/.atlas/memory/`.
pub const DB_FILE: &str = "memory.sqlite";

/// Today's display caps, per durable/working kind. Storage is unbounded; these
/// only limit what a summary view shows (newest first).
pub const CAP_DECISIONS: usize = 50;
pub const CAP_FILES_CHANGED: usize = 50;
pub const CAP_FACTS: usize = 50;
pub const CAP_FAILURES: usize = 30;
pub const CAP_ARCHITECTURE: usize = 30;

// ── Vocabulary ───────────────────────────────────────────────────────────────

/// Typed kinds of event in the shared log. The snake_case names are the wire
/// and on-disk spelling (`memory_append_event`'s `kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    PlanSet,
    Decision,
    FileChanged,
    Fact,
    /// Something that was tried and failed / an anti-pattern to avoid — so a
    /// second agent doesn't repeat a dead end.
    Failure,
    /// A durable architecture/structure note about the system.
    Architecture,
    SessionStart,
    SessionEnd,
    TodoAdded,
    TodoDone,
    /// Any kind string this build doesn't recognise — e.g. a retired kind
    /// (like the old `skill_used`) still sitting in a migrated log. It folds
    /// into nothing but keeps its place (and its `seq`) in the log; its raw
    /// spelling is kept in the events table.
    #[serde(other)]
    Unknown,
}

impl EventKind {
    /// Parse a stored kind string; anything unrecognised is [`EventKind::Unknown`].
    pub fn parse(raw: &str) -> Self {
        serde_json::from_value(serde_json::Value::String(raw.to_string())).unwrap_or(Self::Unknown)
    }

    /// The snake_case spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PlanSet => "plan_set",
            Self::Decision => "decision",
            Self::FileChanged => "file_changed",
            Self::Fact => "fact",
            Self::Failure => "failure",
            Self::Architecture => "architecture",
            Self::SessionStart => "session_start",
            Self::SessionEnd => "session_end",
            Self::TodoAdded => "todo_added",
            Self::TodoDone => "todo_done",
            Self::Unknown => "unknown",
        }
    }
}

/// The six kinds of shared-memory entry (CONTEXT.md § "Shared memory domain").
/// Active plan and File changed are working memory; the other four are durable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Plan,
    Decision,
    FileChanged,
    Fact,
    Failure,
    Architecture,
}

impl EntryKind {
    /// Every kind, working memory first.
    pub const ALL: [EntryKind; 6] = [
        Self::Plan,
        Self::FileChanged,
        Self::Decision,
        Self::Fact,
        Self::Failure,
        Self::Architecture,
    ];

    /// The display cap of this kind (the Active plan shows one).
    pub fn cap(self) -> usize {
        match self {
            Self::Plan => 1,
            Self::Decision => CAP_DECISIONS,
            Self::FileChanged => CAP_FILES_CHANGED,
            Self::Fact => CAP_FACTS,
            Self::Failure => CAP_FAILURES,
            Self::Architecture => CAP_ARCHITECTURE,
        }
    }

    /// The event kind a write of this entry kind is logged as.
    pub fn event_kind(self) -> EventKind {
        match self {
            Self::Plan => EventKind::PlanSet,
            Self::Decision => EventKind::Decision,
            Self::FileChanged => EventKind::FileChanged,
            Self::Fact => EventKind::Fact,
            Self::Failure => EventKind::Failure,
            Self::Architecture => EventKind::Architecture,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Decision => "decision",
            Self::FileChanged => "file_changed",
            Self::Fact => "fact",
            Self::Failure => "failure",
            Self::Architecture => "architecture",
        }
    }

    /// Parse the snake_case spelling.
    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "plan" => Self::Plan,
            "decision" => Self::Decision,
            "file_changed" => Self::FileChanged,
            "fact" => Self::Fact,
            "failure" => Self::Failure,
            "architecture" => Self::Architecture,
            _ => return None,
        })
    }

    /// The four durable kinds (accumulate, searchable, promotable).
    pub fn is_durable(self) -> bool {
        matches!(
            self,
            Self::Decision | Self::Fact | Self::Failure | Self::Architecture
        )
    }
}

/// One event to append. `seq` and `ts` are assigned by the store.
#[derive(Debug, Clone)]
pub struct NewEvent {
    pub agent: String,
    pub session_id: String,
    pub kind: EventKind,
    /// Supersession key (`"plan"`, a decision topic, a file path). Empty = none.
    pub key: String,
    pub payload: serde_json::Value,
}

/// One stored event.
#[derive(Debug, Clone, PartialEq)]
pub struct EventRow {
    pub seq: u64,
    pub ts: i64,
    pub agent: String,
    pub session_id: String,
    /// The kind as stored — a retired kind keeps its original spelling.
    pub kind: String,
    pub key: String,
    pub payload: serde_json::Value,
}

/// One live entry in the record.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub id: i64,
    pub kind: EntryKind,
    /// Writer-supplied key; empty when the writer gave none (identity is then
    /// the content hash). For File changed, the path.
    pub key: String,
    /// The memory text. For File changed, the summary of the edit.
    pub content: String,
    /// Active plan only: its status (`active`, `in_progress`, …); else empty.
    pub status: String,
    /// Provenance: an agent id, `extractor`, `user`, or `import:<origin>`.
    pub source: String,
    pub agent: String,
    pub session_id: String,
    pub confidence: f64,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_used_at: Option<i64>,
    pub uses: u32,
    pub content_hash: String,
    /// The event whose fold last wrote this entry; `None` for entries written
    /// directly (imports, and later tools/extractor/user edits).
    pub seq: Option<u64>,
}

/// One entry to upsert directly (not through the event log).
#[derive(Debug, Clone)]
pub struct NewEntry {
    pub kind: EntryKind,
    /// Empty = identity by normalised content hash.
    pub key: String,
    pub content: String,
    pub source: String,
    pub agent: String,
    pub session_id: String,
    pub confidence: f64,
    /// Write time (ms since epoch).
    pub at: i64,
}

/// One session's bookkeeping row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRow {
    pub session_id: String,
    pub agent: String,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
}

/// Which entries a listing covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// Only entries folded from the event log (what the Shared-tab state view
    /// has always shown).
    EventLog,
    /// Every entry, including imports and direct writes.
    Any,
}

/// Cosine similarity at or above which a new durable entry is a
/// near-duplicate of a stored one of the same kind and merges into it.
pub const NEAR_DUPLICATE: f32 = 0.92;

/// Turns text into a vector for near-duplicate detection and search.
/// Synchronous: record writes already run off the async runtime.
pub trait Embedder: Send + Sync {
    /// The text's embedding, or `None` when it cannot be embedded right now
    /// (no model downloaded, a failed forward pass). Never an error.
    fn embed(&self, text: &str) -> Option<Embedding>;
}

/// One text's vector, tagged with the model that produced it: vectors from
/// different models are never compared.
#[derive(Debug, Clone, PartialEq)]
pub struct Embedding {
    pub model: String,
    pub vector: Vec<f32>,
}

/// What a direct write did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteOutcome {
    /// A new entry.
    Inserted,
    /// An entry with the same key was replaced in place (same id).
    Replaced,
    /// The same content (by hash) or a near-duplicate (by cosine) was already
    /// stored: that entry survives and its use count went up.
    Merged,
}

impl WriteOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Inserted => "inserted",
            Self::Replaced => "replaced",
            Self::Merged => "merged",
        }
    }
}

/// The result of [`RecordStore::remember`].
#[derive(Debug, Clone, PartialEq)]
pub struct Remembered {
    /// The surviving entry, as stored.
    pub entry: Entry,
    pub outcome: WriteOutcome,
}

// ── Scope registry ───────────────────────────────────────────────────────────

fn registry() -> &'static Mutex<HashMap<PathBuf, Arc<RecordStore>>> {
    static REG: OnceLock<Mutex<HashMap<PathBuf, Arc<RecordStore>>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The one in-process handle for the record store rooted at `root` (a scope
/// root: the main worktree, or a non-git launch directory). Opens (and
/// creates) the database on first use; later calls share the handle.
pub fn open_scope(root: &Path) -> Result<Arc<RecordStore>> {
    // Spelling variants of one directory (`/a/b/`, a symlinked `/tmp`) must
    // share one handle, or two connections would race on one sequence.
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let root = root.as_path();
    let mut reg = registry()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(store) = reg.get(root) {
        return Ok(store.clone());
    }
    let store = Arc::new(RecordStore::open(root)?);
    reg.insert(root.to_path_buf(), store.clone());
    Ok(store)
}

/// `<root>/.atlas/memory` — the directory holding the database and markers
/// (`.atlas-dev` under the dev profile, see `atlas-profile`).
pub fn memory_dir(root: &Path) -> PathBuf {
    atlas_profile::dir_in(root).join("memory")
}

// ── Store ────────────────────────────────────────────────────────────────────

/// The record store for one scope. See the module docs.
pub struct RecordStore {
    root: PathBuf,
    conn: Mutex<Connection>,
    embedder: RwLock<Option<Arc<dyn Embedder>>>,
    /// The HNSW over `entry_vectors` for one model, built on first need.
    /// Always locked after `conn`, never before.
    vectors: Mutex<Option<VectorIndex>>,
}

struct VectorIndex {
    model: String,
    dim: usize,
    hnsw: HnswStore,
}

impl std::fmt::Debug for RecordStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RecordStore")
            .field("root", &self.root)
            .finish()
    }
}

impl RecordStore {
    /// Open (creating if needed) `<root>/.atlas/memory/memory.sqlite`. Prefer
    /// [`open_scope`], which keeps one handle per root per process.
    pub fn open(root: &Path) -> Result<Self> {
        let dir = memory_dir(root);
        std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
        let path = dir.join(DB_FILE);
        let conn = Connection::open(&path).with_context(|| format!("open {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrate_schema(&conn)?;
        Ok(Self {
            root: root.to_path_buf(),
            conn: Mutex::new(conn),
            embedder: RwLock::new(None),
            vectors: Mutex::new(None),
        })
    }

    /// Install (or remove) the embedder used for near-duplicate merging and
    /// search. `None` = key-or-hash dedup only.
    pub fn set_embedder(&self, embedder: Option<Arc<dyn Embedder>>) {
        *self
            .embedder
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = embedder;
    }

    /// Whether an embedder is installed.
    pub fn has_embedder(&self) -> bool {
        self.embedder().is_some()
    }

    fn embedder(&self) -> Option<Arc<dyn Embedder>> {
        self.embedder
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn vectors(&self) -> MutexGuard<'_, Option<VectorIndex>> {
        self.vectors
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// `text` embedded by the installed model, unit length; `None` when there
    /// is no model or it cannot embed the text.
    fn embed(&self, text: &str) -> Option<(String, Vec<f32>)> {
        let Embedding { model, vector } = self.embedder()?.embed(text)?;
        Some((model, unit(vector)?))
    }

    /// The scope root this store belongs to.
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    // ── Events ───────────────────────────────────────────────────────────────

    /// Append one event at time `ts`, redacted, and fold it into the entries
    /// and sessions it affects — one transaction. Returns the stored row.
    pub fn append_event(&self, ev: NewEvent, ts: i64) -> Result<EventRow> {
        let key = redact_text(&ev.key);
        let payload = redact_value(ev.payload);
        // A durable memory captured through the log gets a vector too, so a
        // later direct write can merge into it (the fold itself keeps the
        // log's exact replace rules). Embedded before the lock is taken.
        let durable = matches!(
            ev.kind,
            EventKind::Decision | EventKind::Fact | EventKind::Failure | EventKind::Architecture
        );
        let vector = payload
            .get("text")
            .and_then(|t| t.as_str())
            .map(str::trim)
            .filter(|t| durable && !t.is_empty())
            .and_then(|t| self.embed(t));

        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let seq = last_seq_tx(&tx)? + 1;
        let row = EventRow {
            seq,
            ts,
            agent: ev.agent,
            session_id: ev.session_id,
            kind: ev.kind.as_str().to_string(),
            key,
            payload,
        };
        insert_event(&tx, &row)?;
        let vectors_before = vector_count(&tx)?;
        fold(&tx, &row)?;
        // A fold that rewrote or removed indexed entries leaves stale ids in
        // the in-memory index; rebuild it on next need rather than let them
        // crowd out real candidates.
        let stale = vector_count(&tx)? < vectors_before;
        let folded = match &vector {
            Some((model, v)) => {
                let id: Option<i64> = tx
                    .query_row("SELECT id FROM entries WHERE seq = ?1", [seq as i64], |r| {
                        r.get(0)
                    })
                    .optional()?;
                if let Some(id) = id {
                    put_vector(&tx, id, model, v)?;
                }
                id.map(|id| (id, model, v))
            }
            None => None,
        };
        tx.commit()?;
        if stale {
            *self.vectors() = None;
        } else if let Some((id, model, v)) = folded {
            self.index_put(id, model, v);
        }
        Ok(row)
    }

    /// Put `id`'s new vector in the in-memory index, if one is built for
    /// `model` (an unbuilt index picks it up from the table when built).
    fn index_put(&self, id: i64, model: &str, v: &[f32]) {
        let mut index = self.vectors();
        if let Some(index) = index
            .as_mut()
            .filter(|i| i.model == model && i.dim == v.len())
        {
            let _ = index.hnsw.remove(id as u64);
            if let Err(e) = index.hnsw.add(id as u64, v) {
                tracing::warn!(target: "atlas::memory", "vector index add failed: {e:#}");
            }
        }
    }

    /// `(last seq, its ts)`, or `None` for an empty log.
    pub fn last_event(&self) -> Result<Option<(u64, i64)>> {
        let conn = self.conn();
        Ok(conn
            .query_row(
                "SELECT seq, ts FROM events ORDER BY seq DESC LIMIT 1",
                [],
                |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)?)),
            )
            .optional()?)
    }

    /// Up to `limit` events, newest first.
    pub fn events_newest(&self, limit: usize) -> Result<Vec<EventRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            &format!("SELECT seq, ts, agent, session, kind, key, payload FROM events {LIVE_EVENTS} ORDER BY seq DESC LIMIT ?1"),
        )?;
        let rows = stmt.query_map([limit as i64], event_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Events whose payload, key or agent contains `query` (case-insensitive,
    /// Unicode-aware), newest first, at most `limit`. An empty query matches
    /// everything.
    pub fn search_events(&self, query: &str, limit: usize) -> Result<Vec<EventRow>> {
        let q = query.trim().to_lowercase();
        let conn = self.conn();
        let mut stmt = conn.prepare(
            &format!("SELECT seq, ts, agent, session, kind, key, payload FROM events {LIVE_EVENTS} ORDER BY seq DESC"),
        )?;
        let mut out = Vec::new();
        for row in stmt.query_map([], event_from_row)? {
            let e = row?;
            let hit = q.is_empty()
                || e.payload.to_string().to_lowercase().contains(&q)
                || e.key.to_lowercase().contains(&q)
                || e.agent.to_lowercase().contains(&q);
            if hit {
                out.push(e);
                if out.len() >= limit {
                    break;
                }
            }
        }
        Ok(out)
    }

    // ── Entries ──────────────────────────────────────────────────────────────

    /// The newest `limit` entries of `kind` (by the order they were last
    /// written), returned oldest → newest. `limit` is a display cap only.
    pub fn list(&self, kind: EntryKind, limit: usize, origin: Origin) -> Result<Vec<Entry>> {
        let conn = self.conn();
        let sql = match origin {
            Origin::EventLog => {
                "SELECT * FROM entries WHERE kind = ?1 AND seq IS NOT NULL ORDER BY seq DESC LIMIT ?2"
            }
            Origin::Any => {
                "SELECT * FROM entries WHERE kind = ?1 ORDER BY updated_at DESC, id DESC LIMIT ?2"
            }
        };
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![kind.as_str(), limit as i64], entry_from_row)?;
        let mut out = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        out.reverse();
        Ok(out)
    }

    /// Every entry of `kind`, however many (storage is unbounded).
    pub fn count(&self, kind: EntryKind) -> Result<usize> {
        let conn = self.conn();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM entries WHERE kind = ?1",
            [kind.as_str()],
            |r| r.get(0),
        )?;
        Ok(n as usize)
    }

    /// Entries whose content or key contains `query` (case-insensitive),
    /// optionally restricted to `kinds`, most recently written first.
    pub fn query(&self, query: &str, kinds: &[EntryKind], limit: usize) -> Result<Vec<Entry>> {
        let q = query.trim().to_lowercase();
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT * FROM entries ORDER BY updated_at DESC, id DESC")?;
        let mut out = Vec::new();
        for row in stmt.query_map([], entry_from_row)? {
            let e = row?;
            if !kinds.is_empty() && !kinds.contains(&e.kind) {
                continue;
            }
            if q.is_empty()
                || e.content.to_lowercase().contains(&q)
                || e.key.to_lowercase().contains(&q)
            {
                out.push(e);
                if out.len() >= limit {
                    break;
                }
            }
        }
        Ok(out)
    }

    /// Write one entry directly (not through the log), redacted. Identity is
    /// the key when given, else the normalised content hash; an existing entry
    /// with the same identity is replaced in place (same id). Re-writing
    /// identical content is a merge: the entry's `uses` is bumped and its
    /// confidence becomes the higher of the two.
    ///
    /// A durable kind is also near-duplicate merged when an embedder is
    /// installed (see the module docs).
    pub fn upsert(&self, e: NewEntry) -> Result<Entry> {
        Ok(self.write_entry(e, None)?.entry)
    }

    /// [`upsert`](Self::upsert), saying what the write did (inserted,
    /// replaced, or merged into an entry already stored).
    pub fn upsert_outcome(&self, e: NewEntry) -> Result<Remembered> {
        self.write_entry(e, None)
    }

    /// Write one entry as an agent's deliberate memory (a tool write): the
    /// [`upsert`](Self::upsert) rules — key replaces, same hash or a
    /// near-duplicate merges — plus, when something new was stored (not a
    /// merge), an event in the log at `ts`, so the write shows in the Shared
    /// tab's event list and state view like any other.
    pub fn remember(&self, e: NewEntry, ts: i64) -> Result<Remembered> {
        self.write_entry(e, Some(ts))
    }

    fn write_entry(&self, e: NewEntry, log_at: Option<i64>) -> Result<Remembered> {
        let e = redacted(e);
        // Embedding is the slow part; done before the connection is locked.
        let vector = if e.kind.is_durable() {
            self.embed(&e.content)
        } else {
            None
        };

        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let (id, outcome) = match find_identity(&tx, &e)? {
            Some(found) => write_identity(&tx, &e, found)?,
            None => match vector
                .as_ref()
                .map(|(m, v)| self.near_duplicate(&tx, &e, m, v))
                .transpose()?
                .flatten()
            {
                Some(survivor) => {
                    merge_into(&tx, survivor, &e)?;
                    (survivor, WriteOutcome::Merged)
                }
                None => (insert_entry(&tx, &e)?, WriteOutcome::Inserted),
            },
        };
        // The survivor of a merge keeps its own vector (its content stands);
        // anything written anew gets the new one.
        let new_vector = match (&vector, outcome) {
            (Some((model, v)), WriteOutcome::Inserted | WriteOutcome::Replaced) => {
                put_vector(&tx, id, model, v)?;
                Some((model, v))
            }
            _ => None,
        };
        // A merge stores nothing new, so it logs nothing: the log never shows
        // a phrasing the record does not hold.
        if let Some(ts) = log_at.filter(|_| outcome != WriteOutcome::Merged) {
            let seq = last_seq_tx(&tx)? + 1;
            let row = EventRow {
                seq,
                ts,
                agent: e.agent.clone(),
                session_id: e.session_id.clone(),
                kind: e.kind.event_kind().as_str().to_string(),
                key: e.key.clone(),
                payload: serde_json::json!({ "text": e.content }),
            };
            insert_event(&tx, &row)?;
            tx.execute(
                "UPDATE entries SET seq = ?2 WHERE id = ?1",
                params![id, seq as i64],
            )?;
        }
        let entry = tx.query_row("SELECT * FROM entries WHERE id = ?1", [id], entry_from_row)?;
        tx.commit()?;
        if let Some((model, v)) = new_vector {
            self.index_put(id, model, v);
        }
        Ok(Remembered { entry, outcome })
    }

    /// The stored entry of `e`'s kind most similar to `v`, if at or above
    /// [`NEAR_DUPLICATE`]. Keyed entries only merge with keyless ones (two
    /// different keys are two different memories).
    fn near_duplicate(
        &self,
        tx: &Transaction<'_>,
        e: &NewEntry,
        model: &str,
        v: &[f32],
    ) -> Result<Option<i64>> {
        const CANDIDATES: usize = 32;
        let hits = {
            let mut index = self.vectors();
            if !index
                .as_ref()
                .is_some_and(|i| i.model == model && i.dim == v.len())
            {
                *index = Some(build_index(tx, model, v.len())?);
            }
            let Some(index) = index.as_ref() else {
                return Ok(None);
            };
            index.hnsw.search(v, CANDIDATES)?
        };
        // The index only proposes; the table is the truth (a candidate may
        // have been forgotten or rewritten since it was indexed).
        let mut best: Option<(i64, f32)> = None;
        for (id, _) in hits {
            let row: Option<(String, String, Vec<u8>)> = tx
                .query_row(
                    "SELECT e.kind, e.key, v.vec FROM entries e JOIN entry_vectors v ON v.id = e.id \
                     WHERE e.id = ?1 AND v.model = ?2",
                    params![id as i64, model],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            let Some((kind, key, blob)) = row else {
                continue;
            };
            if kind != e.kind.as_str() || (!e.key.is_empty() && !key.is_empty()) {
                continue;
            }
            let sim = cosine(v, &decode_vec(&blob));
            if sim >= NEAR_DUPLICATE && best.is_none_or(|(_, b)| sim > b) {
                best = Some((id as i64, sim));
            }
        }
        Ok(best.map(|(id, _)| id))
    }

    /// Rewrite entry `id`'s content as `source` (the user's edit from the
    /// Memory panel): redacted, confidence 1.0, attributed to `source` as both
    /// source and agent, stamped `ts`, and logged as an event of the entry's
    /// kind so the Shared tab's event list and every session's delta carry
    /// the new wording; the events carrying the wording it corrects are
    /// retracted, as on forget. Key and kind stay; the id stays. `None` when no entry
    /// has that id; an error for empty content (forget removes an entry).
    pub fn edit(&self, id: i64, content: &str, source: &str, ts: i64) -> Result<Option<Entry>> {
        let content = redact_text(content.trim());
        if content.is_empty() {
            anyhow::bail!("an edit needs content; forget the entry to remove it");
        }
        let kind = {
            let conn = self.conn();
            conn.query_row("SELECT kind FROM entries WHERE id = ?1", [id], |r| {
                r.get::<_, String>(0)
            })
            .optional()?
        };
        let Some(kind) = kind.and_then(|k| EntryKind::parse(&k)) else {
            return Ok(None);
        };
        // Embedding is the slow part; done before the connection is locked.
        let vector = if kind.is_durable() {
            self.embed(&content)
        } else {
            None
        };

        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let Some(old) = tx
            .query_row("SELECT * FROM entries WHERE id = ?1", [id], entry_from_row)
            .optional()?
        else {
            return Ok(None);
        };
        // A correction: the wording it replaces no longer surfaces from the
        // log (retracted before the edit's own event is written).
        retract_events_of(&tx, &old)?;
        let seq = last_seq_tx(&tx)? + 1;
        let payload = edit_payload(&old, &content);
        insert_event(
            &tx,
            &EventRow {
                seq,
                ts,
                agent: source.to_string(),
                session_id: String::new(),
                kind: old.kind.event_kind().as_str().to_string(),
                key: old.key,
                payload,
            },
        )?;
        tx.execute(
            "UPDATE entries SET content = ?2, content_hash = ?3, source = ?4, agent = ?4, session = '', \
             confidence = 1.0, updated_at = ?5, seq = ?6 WHERE id = ?1",
            params![id, content, content_hash(&content), source, ts, seq as i64],
        )?;
        match &vector {
            Some((model, v)) => put_vector(&tx, id, model, v)?,
            None => {
                tx.execute("DELETE FROM entry_vectors WHERE id = ?1", [id])?;
            }
        }
        let entry = tx.query_row("SELECT * FROM entries WHERE id = ?1", [id], entry_from_row)?;
        tx.commit()?;
        match &vector {
            Some((model, v)) => self.index_put(id, model, v),
            None => {
                if let Some(index) = self.vectors().as_ref() {
                    let _ = index.hnsw.remove(id as u64);
                }
            }
        }
        Ok(Some(entry))
    }

    /// Remove one entry (and its vector). Returns it, or `None` when no entry
    /// has that id.
    ///
    /// The log keeps its sequence, but the events that carried the entry (its
    /// identity's events, see `retract_events_of`) are **retracted**: the
    /// log's list and search no longer show them, so a forgotten memory
    /// surfaces nowhere. Nothing new is logged.
    pub fn forget(&self, id: i64) -> Result<Option<Entry>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let entry = tx
            .query_row("SELECT * FROM entries WHERE id = ?1", [id], entry_from_row)
            .optional()?;
        if let Some(e) = &entry {
            tx.execute("DELETE FROM entries WHERE id = ?1", [id])?;
            tx.execute("DELETE FROM entry_vectors WHERE id = ?1", [id])?;
            retract_events_of(&tx, e)?;
        }
        tx.commit()?;
        if entry.is_some() {
            if let Some(index) = self.vectors().as_ref() {
                let _ = index.hnsw.remove(id as u64);
            }
        }
        Ok(entry)
    }

    /// Whether an entry of `kind` already holds `content` (by the redacted,
    /// normalised content hash — the identity a keyless write would merge on).
    pub fn holds_content(&self, kind: EntryKind, content: &str) -> Result<bool> {
        let hash = content_hash(&redact_text(content.trim()));
        let conn = self.conn();
        Ok(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM entries WHERE kind = ?1 AND content_hash = ?2)",
            params![kind.as_str(), hash],
            |r| r.get(0),
        )?)
    }

    /// Whether the one-time import from `source` has run (the `legacy_imports`
    /// gate the legacy migration uses; any source name works).
    pub fn import_recorded(&self, source: &str) -> Result<bool> {
        let conn = self.conn();
        Ok(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM legacy_imports WHERE source = ?1)",
            [source],
            |r| r.get(0),
        )?)
    }

    /// Record that the one-time import from `source` ran at `at`. Idempotent.
    pub fn mark_imported(&self, source: &str, at: i64) -> Result<()> {
        let conn = self.conn();
        conn.execute(
            "INSERT OR IGNORE INTO legacy_imports (source, at) VALUES (?1, ?2)",
            params![source, at],
        )?;
        Ok(())
    }

    /// Entries relevant to `query`, best first, at most `limit`, optionally
    /// restricted to `kinds`. Relevance is the share of the query's terms an
    /// entry contains, plus its cosine to the query when an embedder is
    /// installed. An empty query lists the most recently written entries.
    /// Every entry returned is stamped as used at `now`.
    pub fn search(
        &self,
        query: &str,
        kinds: &[EntryKind],
        limit: usize,
        now: i64,
    ) -> Result<Vec<Entry>> {
        const MIN_SIMILARITY: f32 = 0.35;
        if query.trim().is_empty() {
            let out = self.query("", kinds, limit)?;
            self.mark_used(&out, now)?;
            return Ok(out);
        }
        let terms = terms(query);
        let vector = self.embed(query.trim());
        let conn = self.conn();
        let similar: HashMap<i64, f32> = match &vector {
            Some((model, v)) => {
                let mut stmt =
                    conn.prepare("SELECT id, vec FROM entry_vectors WHERE model = ?1")?;
                let rows = stmt.query_map([model], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
                })?;
                let mut out = HashMap::new();
                for row in rows {
                    let (id, blob) = row?;
                    let sim = cosine(v, &decode_vec(&blob));
                    if sim >= MIN_SIMILARITY {
                        out.insert(id, sim);
                    }
                }
                out
            }
            None => HashMap::new(),
        };
        let mut stmt = conn.prepare("SELECT * FROM entries ORDER BY updated_at DESC, id DESC")?;
        let mut scored: Vec<(f32, Entry)> = Vec::new();
        for row in stmt.query_map([], entry_from_row)? {
            let e = row?;
            if !kinds.is_empty() && !kinds.contains(&e.kind) {
                continue;
            }
            let haystack = format!("{} {}", e.key, e.content).to_lowercase();
            let hit = terms
                .iter()
                .filter(|t| haystack.contains(t.as_str()))
                .count();
            let term_score = if terms.is_empty() {
                0.0
            } else {
                hit as f32 / terms.len() as f32
            };
            let score = term_score + similar.get(&e.id).copied().unwrap_or(0.0);
            if score > 0.0 {
                scored.push((score, e));
            }
        }
        drop(stmt);
        drop(conn);
        // Stable: equal scores keep newest-first.
        scored.sort_by(|a, b| b.0.total_cmp(&a.0));
        let out: Vec<Entry> = scored.into_iter().take(limit).map(|(_, e)| e).collect();
        self.mark_used(&out, now)?;
        Ok(out
            .into_iter()
            .map(|e| Entry {
                last_used_at: Some(now),
                ..e
            })
            .collect())
    }

    /// One entry by id, stamped as used at `now`; `None` when there is no
    /// such entry.
    pub fn get(&self, id: i64, now: i64) -> Result<Option<Entry>> {
        let entry = self
            .conn()
            .query_row("SELECT * FROM entries WHERE id = ?1", [id], entry_from_row)
            .optional()?;
        let Some(entry) = entry else {
            return Ok(None);
        };
        self.mark_used(std::slice::from_ref(&entry), now)?;
        Ok(Some(Entry {
            last_used_at: Some(now),
            ..entry
        }))
    }

    /// Whether `id` is still a live entry, WITHOUT stamping it as used.
    ///
    /// [`Self::get`] marks an entry used, and use count feeds ranking, so the
    /// search-side liveness filter cannot read through `get` without inflating
    /// the score of every entry it checks.
    pub fn exists(&self, id: i64) -> Result<bool> {
        Ok(self
            .conn()
            .query_row("SELECT 1 FROM entries WHERE id = ?1", [id], |_| Ok(()))
            .optional()?
            .is_some())
    }

    fn mark_used(&self, entries: &[Entry], now: i64) -> Result<()> {
        if entries.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for e in entries {
            tx.execute(
                "UPDATE entries SET last_used_at = ?2 WHERE id = ?1",
                params![e.id, now],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    // ── Sessions ─────────────────────────────────────────────────────────────

    /// Record that `session_id` (run by `agent`) started at `ts`: a
    /// `session_start` event plus its sessions row.
    pub fn session_started(&self, session_id: &str, agent: &str, ts: i64) -> Result<EventRow> {
        self.append_event(
            NewEvent {
                agent: agent.into(),
                session_id: session_id.into(),
                kind: EventKind::SessionStart,
                key: String::new(),
                payload: serde_json::json!({}),
            },
            ts,
        )
    }

    /// Record that `session_id` ended at `ts`: a `session_end` event and the
    /// row's end time.
    pub fn session_ended(&self, session_id: &str, agent: &str, ts: i64) -> Result<EventRow> {
        self.append_event(
            NewEvent {
                agent: agent.into(),
                session_id: session_id.into(),
                kind: EventKind::SessionEnd,
                key: String::new(),
                payload: serde_json::json!({}),
            },
            ts,
        )
    }

    /// Every session row.
    pub fn sessions(&self) -> Result<Vec<SessionRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT session_id, agent, started_at, ended_at FROM sessions ORDER BY session_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(SessionRow {
                session_id: r.get(0)?,
                agent: r.get(1)?,
                started_at: r.get(2)?,
                ended_at: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // ── Wipe ─────────────────────────────────────────────────────────────────

    /// Wipe the scope's shared memory: events, entries and sessions. The log's
    /// sequence starts again at 1. Migration markers stay, so a cleared scope
    /// is not refilled from legacy files.
    pub fn clear(&self) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute_batch(
            "DELETE FROM events; DELETE FROM entries; DELETE FROM sessions; DELETE FROM entry_vectors; \
             DELETE FROM retracted_events;",
        )?;
        tx.commit()?;
        *self.vectors() = None;
        Ok(())
    }
}

// ── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA_VERSION: i64 = 3;

/// The log as the Shared tab lists and searches it: every event not retracted.
const LIVE_EVENTS: &str = "WHERE seq NOT IN (SELECT seq FROM retracted_events)";

fn migrate_schema(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }
    if version < 1 {
        migrate_v1(conn)?;
    }
    if version < 2 {
        // v2: one embedding per entry (by entry id), tagged with its model.
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS entry_vectors (
                 id     INTEGER PRIMARY KEY,
                 model  TEXT NOT NULL,
                 vec    BLOB NOT NULL
             );
             PRAGMA user_version = 2;
             COMMIT;",
        )?;
    }
    // v3: events whose content was forgotten, hidden from the log's list and
    // search (the rows stay, so the sequence never goes back).
    conn.execute_batch(
        "BEGIN;
         CREATE TABLE IF NOT EXISTS retracted_events (
             seq  INTEGER PRIMARY KEY
         );
         PRAGMA user_version = 3;
         COMMIT;",
    )?;
    Ok(())
}

/// The payload field an event of `kind` carries an entry's content in: a file
/// change's summary, every other kind's text.
fn content_field(kind: EntryKind) -> &'static str {
    if kind == EntryKind::FileChanged {
        "summary"
    } else {
        "text"
    }
}

/// The log event a user's edit of `e` to `content` is recorded as: the
/// entry's own kind and key, in the payload shape its fold reads.
fn edit_payload(e: &Entry, content: &str) -> serde_json::Value {
    match e.kind {
        EntryKind::Plan => serde_json::json!({ "text": content, "status": e.status }),
        EntryKind::FileChanged => serde_json::json!({ "path": e.key, "summary": content }),
        _ => serde_json::json!({ content_field(e.kind): content }),
    }
}

/// Retract the events that carried `e` — the ones its identity folded from:
/// its last write; for a file change, every event on its path; for a keyed
/// decision, every event under its key; and every event of its kind whose
/// wording is the same memory (by normalised hash) and names no other key.
/// Another entry's events are never touched.
fn retract_events_of(tx: &Transaction<'_>, e: &Entry) -> Result<()> {
    let mut seqs: Vec<i64> = e.seq.map(|s| s as i64).into_iter().collect();
    {
        let mut stmt = tx.prepare("SELECT seq, key, payload FROM events WHERE kind = ?1")?;
        let rows = stmt.query_map([e.kind.event_kind().as_str()], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (seq, key, payload) = row?;
            let payload: serde_json::Value =
                serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null);
            let text = payload
                .get(content_field(e.kind))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let same_wording = !text.is_empty() && content_hash(text) == e.content_hash;
            let ours = match e.kind {
                EntryKind::FileChanged => {
                    payload.get("path").and_then(|v| v.as_str()).unwrap_or(&key) == e.key
                }
                EntryKind::Decision if !e.key.is_empty() => {
                    key == e.key || (same_wording && key.is_empty())
                }
                EntryKind::Decision => same_wording && key.is_empty(),
                _ => same_wording,
            };
            if ours {
                seqs.push(seq);
            }
        }
    }
    for seq in seqs {
        tx.execute(
            "INSERT OR IGNORE INTO retracted_events (seq) VALUES (?1)",
            [seq],
        )?;
    }
    Ok(())
}

fn migrate_v1(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "BEGIN;
         CREATE TABLE IF NOT EXISTS events (
             seq      INTEGER PRIMARY KEY,
             ts       INTEGER NOT NULL,
             kind     TEXT NOT NULL,
             key      TEXT NOT NULL DEFAULT '',
             agent    TEXT NOT NULL DEFAULT '',
             session  TEXT NOT NULL DEFAULT '',
             payload  TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS entries (
             id            INTEGER PRIMARY KEY AUTOINCREMENT,
             kind          TEXT NOT NULL,
             key           TEXT NOT NULL DEFAULT '',
             content       TEXT NOT NULL,
             status        TEXT NOT NULL DEFAULT '',
             source        TEXT NOT NULL DEFAULT '',
             agent         TEXT NOT NULL DEFAULT '',
             session       TEXT NOT NULL DEFAULT '',
             confidence    REAL NOT NULL DEFAULT 1.0,
             created_at    INTEGER NOT NULL,
             updated_at    INTEGER NOT NULL,
             last_used_at  INTEGER,
             uses          INTEGER NOT NULL DEFAULT 0,
             content_hash  TEXT NOT NULL,
             seq           INTEGER
         );
         CREATE INDEX IF NOT EXISTS entries_kind_seq  ON entries(kind, seq);
         CREATE INDEX IF NOT EXISTS entries_kind_key  ON entries(kind, key);
         CREATE INDEX IF NOT EXISTS entries_kind_hash ON entries(kind, content_hash);
         CREATE TABLE IF NOT EXISTS sessions (
             session_id  TEXT PRIMARY KEY,
             agent       TEXT NOT NULL DEFAULT '',
             started_at  INTEGER,
             ended_at    INTEGER
         );
         CREATE TABLE IF NOT EXISTS legacy_imports (
             source  TEXT PRIMARY KEY,
             at      INTEGER NOT NULL
         );
         PRAGMA user_version = 1;
         COMMIT;",
    )?;
    Ok(())
}

// ── Row mapping ──────────────────────────────────────────────────────────────

fn event_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<EventRow> {
    let payload: String = r.get(6)?;
    Ok(EventRow {
        seq: r.get::<_, i64>(0)? as u64,
        ts: r.get(1)?,
        agent: r.get(2)?,
        session_id: r.get(3)?,
        kind: r.get(4)?,
        key: r.get(5)?,
        payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
    })
}

fn entry_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Entry> {
    let kind: String = r.get("kind")?;
    Ok(Entry {
        id: r.get("id")?,
        kind: EntryKind::parse(&kind).unwrap_or(EntryKind::Fact),
        key: r.get("key")?,
        content: r.get("content")?,
        status: r.get("status")?,
        source: r.get("source")?,
        agent: r.get("agent")?,
        session_id: r.get("session")?,
        confidence: r.get("confidence")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
        last_used_at: r.get("last_used_at")?,
        uses: r.get::<_, i64>("uses")? as u32,
        content_hash: r.get("content_hash")?,
        seq: r.get::<_, Option<i64>>("seq")?.map(|s| s as u64),
    })
}

fn last_seq_tx(tx: &Transaction<'_>) -> Result<u64> {
    let seq: Option<i64> = tx.query_row("SELECT MAX(seq) FROM events", [], |r| r.get(0))?;
    Ok(seq.unwrap_or(0) as u64)
}

fn insert_event(tx: &Transaction<'_>, row: &EventRow) -> Result<()> {
    tx.execute(
        "INSERT INTO events (seq, ts, kind, key, agent, session, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            row.seq as i64,
            row.ts,
            row.kind,
            row.key,
            row.agent,
            row.session_id,
            serde_json::to_string(&row.payload)?,
        ],
    )?;
    Ok(())
}

// ── Redaction ────────────────────────────────────────────────────────────────

/// Scrub a text through `atlas_redact` — the one redactor every record write
/// uses. Returned unchanged when there was nothing to scrub.
pub fn redact(s: &str) -> String {
    redact_text(s)
}

fn redact_text(s: &str) -> String {
    let r = atlas_redact::redact(s);
    if r.changed() {
        r.text
    } else {
        s.to_string()
    }
}

/// Redact every string inside a JSON value; the value is returned untouched
/// (same key order, same numbers) when nothing needed scrubbing.
fn redact_value(v: serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::String(s) => serde_json::Value::String(redact_text(&s)),
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(redact_value).collect())
        }
        serde_json::Value::Object(map) => {
            serde_json::Value::Object(map.into_iter().map(|(k, v)| (k, redact_value(v))).collect())
        }
        other => other,
    }
}

// ── Identity ─────────────────────────────────────────────────────────────────

/// Whitespace-collapsed, lower-cased — the dedup form of a text.
pub fn normalize(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Hex sha256 of the normalised text.
pub fn content_hash(s: &str) -> String {
    Sha256::digest(normalize(s).as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Lower-cased alphanumeric words of two or more characters, deduplicated.
fn terms(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in s.to_lowercase().split(|c: char| !c.is_alphanumeric()) {
        if t.chars().count() >= 2 && !out.iter().any(|o| o == t) {
            out.push(t.to_string());
        }
    }
    out
}

// ── Vectors ──────────────────────────────────────────────────────────────────

/// `v` scaled to unit length; `None` for an empty or all-zero vector.
fn unit(v: Vec<f32>) -> Option<Vec<f32>> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    (norm > 0.0 && norm.is_finite()).then(|| v.into_iter().map(|x| x / norm).collect())
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na * nb)
    }
}

fn encode_vec(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

fn decode_vec(b: &[u8]) -> Vec<f32> {
    b.as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes(*c))
        .collect()
}

fn put_vector(tx: &Transaction<'_>, id: i64, model: &str, v: &[f32]) -> Result<()> {
    tx.execute(
        "INSERT INTO entry_vectors (id, model, vec) VALUES (?1, ?2, ?3) \
         ON CONFLICT(id) DO UPDATE SET model = excluded.model, vec = excluded.vec",
        params![id, model, encode_vec(v)],
    )?;
    Ok(())
}

/// An HNSW over every stored `dim`-dimensional vector of `model`.
fn build_index(tx: &Transaction<'_>, model: &str, dim: usize) -> Result<VectorIndex> {
    let hnsw = HnswStore::open(dim)?;
    let mut stmt = tx.prepare("SELECT id, vec FROM entry_vectors WHERE model = ?1")?;
    let rows = stmt.query_map([model], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
    })?;
    for row in rows {
        let (id, blob) = row?;
        let v = decode_vec(&blob);
        if v.len() == dim {
            hnsw.add(id as u64, &v)?;
        }
    }
    Ok(VectorIndex {
        model: model.to_string(),
        dim,
        hnsw,
    })
}

// ── Fold: event → entries ────────────────────────────────────────────────────

fn payload_str<'a>(ev: &'a EventRow, field: &str) -> Option<&'a str> {
    ev.payload.get(field).and_then(|v| v.as_str())
}

/// Fold one event into entries/sessions with the log's replace rules — the
/// same rules the JSONL store applied to its bounded view, minus eviction.
fn fold(tx: &Transaction<'_>, ev: &EventRow) -> Result<()> {
    let text = || payload_str(ev, "text").unwrap_or("").trim().to_string();
    match EventKind::parse(&ev.kind) {
        EventKind::PlanSet => {
            let text = payload_str(ev, "text").unwrap_or("").to_string();
            let status = payload_str(ev, "status").unwrap_or("active").to_string();
            if status == "abandoned" || status == "done" {
                // A finished or abandoned plan clears the active plan.
                tx.execute("DELETE FROM entries WHERE kind = 'plan'", [])?;
            } else if !text.is_empty() {
                let matches = ids(tx, "SELECT id FROM entries WHERE kind = 'plan'", params![])?;
                write_folded(tx, ev, EntryKind::Plan, "plan", &text, &status, &matches)?;
            }
        }
        EventKind::Decision => {
            let text = text();
            if text.is_empty() {
                return Ok(());
            }
            // Same non-empty key supersedes; keyless dedups by normalised text.
            let matches = ids(
                tx,
                "SELECT id FROM entries WHERE kind = 'decision' \
                 AND ((?1 <> '' AND key = ?1) OR content_hash = ?2)",
                params![ev.key, content_hash(&text)],
            )?;
            write_folded(tx, ev, EntryKind::Decision, &ev.key, &text, "", &matches)?;
        }
        EventKind::FileChanged => {
            let path = payload_str(ev, "path").unwrap_or(&ev.key).to_string();
            if path.is_empty() {
                return Ok(());
            }
            let summary = payload_str(ev, "summary").unwrap_or("").to_string();
            let matches = ids(
                tx,
                "SELECT id FROM entries WHERE kind = 'file_changed' AND key = ?1",
                params![path],
            )?;
            write_folded(
                tx,
                ev,
                EntryKind::FileChanged,
                &path,
                &summary,
                "",
                &matches,
            )?;
        }
        EventKind::Fact => {
            let text = text();
            if text.is_empty() {
                return Ok(());
            }
            let matches = ids(
                tx,
                "SELECT id FROM entries WHERE kind = 'fact' AND content_hash = ?1",
                params![content_hash(&text)],
            )?;
            write_folded(tx, ev, EntryKind::Fact, &ev.key, &text, "", &matches)?;
        }
        kind @ (EventKind::Failure | EventKind::Architecture) => {
            let text = text();
            if text.is_empty() {
                return Ok(());
            }
            let entry_kind = if kind == EventKind::Failure {
                EntryKind::Failure
            } else {
                EntryKind::Architecture
            };
            // The JSONL fold compared an incoming key against the stored
            // entry's *text* for these two kinds; kept as-is so replacement
            // stays identical.
            let matches = ids(
                tx,
                "SELECT id FROM entries WHERE kind = ?1 \
                 AND ((?2 <> '' AND content = ?2) OR content_hash = ?3)",
                params![entry_kind.as_str(), ev.key, content_hash(&text)],
            )?;
            write_folded(tx, ev, entry_kind, &ev.key, &text, "", &matches)?;
        }
        // A start on a known session is a reopen (a resumed conversation keeps
        // its id): it is live again, so its old end no longer holds.
        EventKind::SessionStart => {
            tx.execute(
                "INSERT INTO sessions (session_id, agent, started_at) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(session_id) DO UPDATE SET agent = excluded.agent, started_at = excluded.started_at, \
                 ended_at = NULL",
                params![ev.session_id, ev.agent, ev.ts],
            )?;
        }
        EventKind::SessionEnd => {
            tx.execute(
                "UPDATE sessions SET ended_at = ?2 WHERE session_id = ?1",
                params![ev.session_id, ev.ts],
            )?;
        }
        EventKind::TodoAdded | EventKind::TodoDone | EventKind::Unknown => {
            // Kept in the log for audit; no entry.
        }
    }
    Ok(())
}

fn ids(tx: &Transaction<'_>, sql: &str, p: impl rusqlite::Params) -> Result<Vec<i64>> {
    let mut stmt = tx.prepare(sql)?;
    let rows = stmt.query_map(p, |r| r.get::<_, i64>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Replace `matches` with one entry written by `ev`: the oldest match keeps
/// its id (and creation time), the rest are removed; no match inserts.
fn write_folded(
    tx: &Transaction<'_>,
    ev: &EventRow,
    kind: EntryKind,
    key: &str,
    content: &str,
    status: &str,
    matches: &[i64],
) -> Result<()> {
    let hash = content_hash(content);
    if let Some(&keep) = matches.iter().min() {
        for id in matches.iter().filter(|id| **id != keep) {
            tx.execute("DELETE FROM entries WHERE id = ?1", [id])?;
        }
        tx.execute(
            "UPDATE entries SET key = ?2, content = ?3, status = ?4, source = ?5, agent = ?5, session = ?6, \
             confidence = 1.0, updated_at = ?7, content_hash = ?8, seq = ?9 WHERE id = ?1",
            params![keep, key, content, status, ev.agent, ev.session_id, ev.ts, hash, ev.seq as i64],
        )?;
        // The content may have changed under its vector: drop it rather than
        // let a stale embedding match.
        tx.execute("DELETE FROM entry_vectors WHERE id = ?1", [keep])?;
    } else {
        tx.execute(
            "INSERT INTO entries (kind, key, content, status, source, agent, session, confidence, \
             created_at, updated_at, content_hash, seq) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, 1.0, ?7, ?7, ?8, ?9)",
            params![
                kind.as_str(),
                key,
                content,
                status,
                ev.agent,
                ev.session_id,
                ev.ts,
                hash,
                ev.seq as i64
            ],
        )?;
    }
    Ok(())
}

/// Key-or-hash upsert without near-duplicate matching or logging (the legacy
/// memdir import).
fn upsert_tx(tx: &Transaction<'_>, e: NewEntry) -> Result<i64> {
    let e = redacted(e);
    match find_identity(tx, &e)? {
        Some(found) => Ok(write_identity(tx, &e, found)?.0),
        None => insert_entry(tx, &e),
    }
}

/// `e` as it may land: key and trimmed content scrubbed by `atlas_redact`.
fn redacted(e: NewEntry) -> NewEntry {
    NewEntry {
        key: redact_text(&e.key),
        content: redact_text(e.content.trim()),
        ..e
    }
}

fn vector_count(tx: &Transaction<'_>) -> Result<i64> {
    Ok(tx.query_row("SELECT COUNT(*) FROM entry_vectors", [], |r| r.get(0))?)
}

/// The stored entry a write is the same memory as (by key, else by content
/// hash).
struct Found {
    id: i64,
    content_hash: String,
}

fn find_identity(tx: &Transaction<'_>, e: &NewEntry) -> Result<Option<Found>> {
    let hash = content_hash(&e.content);
    let found = if e.key.is_empty() {
        tx.query_row(
            "SELECT id, content_hash FROM entries WHERE kind = ?1 AND content_hash = ?2 ORDER BY id LIMIT 1",
            params![e.kind.as_str(), hash],
            |r| Ok(Found { id: r.get(0)?, content_hash: r.get(1)? }),
        )
        .optional()?
    } else {
        tx.query_row(
            "SELECT id, content_hash FROM entries WHERE kind = ?1 AND key = ?2 ORDER BY id LIMIT 1",
            params![e.kind.as_str(), e.key],
            |r| {
                Ok(Found {
                    id: r.get(0)?,
                    content_hash: r.get(1)?,
                })
            },
        )
        .optional()?
    };
    Ok(found)
}

/// Write `e` over the entry it is the same memory as: identical content
/// merges (uses bumped, the higher confidence kept), different content
/// replaces.
fn write_identity(tx: &Transaction<'_>, e: &NewEntry, found: Found) -> Result<(i64, WriteOutcome)> {
    let hash = content_hash(&e.content);
    if found.content_hash == hash {
        merge_into(tx, found.id, e)?;
        return Ok((found.id, WriteOutcome::Merged));
    }
    tx.execute(
        "UPDATE entries SET content = ?2, source = ?3, agent = ?4, session = ?5, confidence = ?6, \
         updated_at = ?7, content_hash = ?8 WHERE id = ?1",
        params![
            found.id,
            e.content,
            e.source,
            e.agent,
            e.session_id,
            e.confidence,
            e.at,
            hash
        ],
    )?;
    Ok((found.id, WriteOutcome::Replaced))
}

/// `e` restated an existing entry: that entry survives with its content, its
/// use count bumped and the higher confidence kept. A keyless survivor takes
/// `e`'s key.
fn merge_into(tx: &Transaction<'_>, id: i64, e: &NewEntry) -> Result<()> {
    tx.execute(
        "UPDATE entries SET uses = uses + 1, confidence = MAX(confidence, ?2), \
         updated_at = MAX(updated_at, ?3), key = CASE WHEN key = '' THEN ?4 ELSE key END WHERE id = ?1",
        params![id, e.confidence, e.at, e.key],
    )?;
    Ok(())
}

fn insert_entry(tx: &Transaction<'_>, e: &NewEntry) -> Result<i64> {
    tx.execute(
        "INSERT INTO entries (kind, key, content, source, agent, session, confidence, created_at, \
         updated_at, content_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)",
        params![
            e.kind.as_str(),
            e.key,
            e.content,
            e.source,
            e.agent,
            e.session_id,
            e.confidence,
            e.at,
            content_hash(&e.content)
        ],
    )?;
    Ok(tx.last_insert_rowid())
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn temp_root(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("atlas-record-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ev(kind: EventKind, key: &str, payload: serde_json::Value) -> NewEvent {
        NewEvent {
            agent: "codex".into(),
            session_id: "s1".into(),
            kind,
            key: key.into(),
            payload,
        }
    }

    #[test]
    fn a_secret_in_any_write_lands_redacted() {
        let root = temp_root("redact");
        let store = open_scope(&root).unwrap();
        let secret = "sk-proj-AbCdEf0123456789GhIjKlMnOpQrStUv";

        store
            .append_event(
                ev(
                    EventKind::Fact,
                    "",
                    serde_json::json!({"text": format!("the key is {secret}")}),
                ),
                1,
            )
            .unwrap();
        store
            .upsert(NewEntry {
                kind: EntryKind::Decision,
                key: String::new(),
                content: format!("rotate {secret} monthly"),
                source: "user".into(),
                agent: String::new(),
                session_id: String::new(),
                confidence: 1.0,
                at: 2,
            })
            .unwrap();

        let events = store.events_newest(10).unwrap();
        assert!(
            !events[0].payload.to_string().contains(secret),
            "{:?}",
            events[0]
        );
        let everything = store.query("", &[], 100).unwrap();
        assert_eq!(everything.len(), 2);
        for e in everything {
            assert!(!e.content.contains(secret), "{e:?}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn caps_are_display_limits_and_nothing_is_evicted() {
        let root = temp_root("caps");
        let store = open_scope(&root).unwrap();
        for i in 1..=60 {
            store
                .append_event(
                    ev(
                        EventKind::Decision,
                        &format!("k{i}"),
                        serde_json::json!({"text": format!("d{i}")}),
                    ),
                    i,
                )
                .unwrap();
        }
        assert_eq!(store.count(EntryKind::Decision).unwrap(), 60);
        let shown = store
            .list(EntryKind::Decision, CAP_DECISIONS, Origin::EventLog)
            .unwrap();
        assert_eq!(shown.len(), 50);
        assert_eq!(shown.first().unwrap().content, "d11");
        assert_eq!(shown.last().unwrap().content, "d60");
        // The first decision is still searchable.
        assert_eq!(
            store
                .query("d1", &[EntryKind::Decision], 100)
                .unwrap()
                .iter()
                .filter(|e| e.content == "d1")
                .count(),
            1
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_replaced_entry_keeps_its_id() {
        let root = temp_root("replace");
        let store = open_scope(&root).unwrap();
        store
            .append_event(
                ev(
                    EventKind::Decision,
                    "alg",
                    serde_json::json!({"text": "HS256"}),
                ),
                1,
            )
            .unwrap();
        let before = store.list(EntryKind::Decision, 10, Origin::Any).unwrap();
        store
            .append_event(
                ev(
                    EventKind::Decision,
                    "alg",
                    serde_json::json!({"text": "RS256"}),
                ),
                2,
            )
            .unwrap();
        let after = store.list(EntryKind::Decision, 10, Origin::Any).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].id, before[0].id);
        assert_eq!(after[0].content, "RS256");
        assert_eq!(after[0].seq, Some(2));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn session_hooks_record_start_and_end() {
        let root = temp_root("sessions");
        let store = open_scope(&root).unwrap();
        store.session_started("s1", "codex", 10).unwrap();
        store.session_ended("s1", "codex", 20).unwrap();
        assert_eq!(
            store.sessions().unwrap(),
            vec![SessionRow {
                session_id: "s1".into(),
                agent: "codex".into(),
                started_at: Some(10),
                ended_at: Some(20)
            }]
        );
        let kinds: Vec<String> = store
            .events_newest(10)
            .unwrap()
            .into_iter()
            .map(|e| e.kind)
            .collect();
        assert_eq!(kinds, vec!["session_end", "session_start"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A session reopened after it ended (a resumed conversation keeps its
    /// id) is live again: its row carries the new start and no end.
    #[test]
    fn a_reopened_session_is_live_again() {
        let root = temp_root("sessions-reopen");
        let store = open_scope(&root).unwrap();
        store.session_started("s1", "codex", 10).unwrap();
        store.session_ended("s1", "codex", 20).unwrap();
        store.session_started("s1", "codex", 30).unwrap();
        assert_eq!(
            store.sessions().unwrap(),
            vec![SessionRow {
                session_id: "s1".into(),
                agent: "codex".into(),
                started_at: Some(30),
                ended_at: None
            }]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A fixed text → vector table, so near-duplicate tests do not depend on a
    /// downloaded model. Unknown text has no embedding (like a model that is
    /// not downloaded yet).
    struct TableEmbedder(Vec<(&'static str, Vec<f32>)>);

    impl Embedder for TableEmbedder {
        fn embed(&self, text: &str) -> Option<Embedding> {
            self.0
                .iter()
                .find(|(t, _)| *t == text)
                .map(|(_, v)| Embedding {
                    model: "table-3".into(),
                    vector: v.clone(),
                })
        }
    }

    fn table() -> Arc<dyn Embedder> {
        Arc::new(TableEmbedder(vec![
            ("JWTs are signed with RS256", vec![1.0, 0.0, 0.0]),
            // cosine 0.96 with the first: a near-duplicate.
            ("JWT signing uses RS256", vec![0.96, 0.28, 0.0]),
            // cosine 0.80: related, not a duplicate.
            ("JWT expiry is fifteen minutes", vec![0.8, 0.6, 0.0]),
            ("Deploys go through Fly", vec![0.0, 0.0, 1.0]),
        ]))
    }

    fn tool_write(kind: EntryKind, key: &str, content: &str, at: i64) -> NewEntry {
        NewEntry {
            kind,
            key: key.into(),
            content: content.into(),
            source: "claude".into(),
            agent: "claude".into(),
            session_id: "s1".into(),
            confidence: 1.0,
            at,
        }
    }

    #[test]
    fn a_near_duplicate_merges_into_the_surviving_entry_and_bumps_its_uses() {
        let root = temp_root("near-dup");
        let store = open_scope(&root).unwrap();
        store.set_embedder(Some(table()));

        let first = store
            .remember(
                tool_write(EntryKind::Fact, "", "JWTs are signed with RS256", 1),
                1,
            )
            .unwrap();
        assert_eq!(first.outcome, WriteOutcome::Inserted);
        let again = store
            .remember(
                tool_write(EntryKind::Fact, "", "JWT signing uses RS256", 2),
                2,
            )
            .unwrap();
        assert_eq!(again.outcome, WriteOutcome::Merged);
        assert_eq!(again.entry.id, first.entry.id);
        assert_eq!(again.entry.uses, 1);
        assert_eq!(again.entry.content, "JWTs are signed with RS256");

        let related = store
            .remember(
                tool_write(EntryKind::Fact, "", "JWT expiry is fifteen minutes", 3),
                3,
            )
            .unwrap();
        assert_eq!(related.outcome, WriteOutcome::Inserted);
        // Same text, other kind: kinds never merge.
        let other_kind = store
            .remember(
                tool_write(EntryKind::Decision, "", "JWT signing uses RS256", 4),
                4,
            )
            .unwrap();
        assert_eq!(other_kind.outcome, WriteOutcome::Inserted);
        assert_eq!(store.count(EntryKind::Fact).unwrap(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The vectors are kept with the record: a reopened store (a new process)
    /// still finds the near-duplicate.
    #[test]
    fn near_duplicates_are_found_after_a_reopen() {
        let root = temp_root("near-dup-reopen");
        {
            let store = RecordStore::open(&root).unwrap();
            store.set_embedder(Some(table()));
            store
                .remember(
                    tool_write(EntryKind::Fact, "", "JWTs are signed with RS256", 1),
                    1,
                )
                .unwrap();
        }
        let store = RecordStore::open(&root).unwrap();
        store.set_embedder(Some(table()));
        let again = store
            .remember(
                tool_write(EntryKind::Fact, "", "JWT signing uses RS256", 2),
                2,
            )
            .unwrap();
        assert_eq!(again.outcome, WriteOutcome::Merged);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn without_an_embedding_model_dedup_falls_back_to_the_content_hash() {
        let root = temp_root("near-dup-no-model");
        let store = open_scope(&root).unwrap();
        store
            .remember(
                tool_write(EntryKind::Fact, "", "JWTs are signed with RS256", 1),
                1,
            )
            .unwrap();
        let near = store
            .remember(
                tool_write(EntryKind::Fact, "", "JWT signing uses RS256", 2),
                2,
            )
            .unwrap();
        assert_eq!(near.outcome, WriteOutcome::Inserted);
        let exact = store
            .remember(
                tool_write(EntryKind::Fact, "", "jwts are  signed with RS256", 3),
                3,
            )
            .unwrap();
        assert_eq!(exact.outcome, WriteOutcome::Merged);
        // A model that cannot embed a text (unknown to the table) is no error.
        store.set_embedder(Some(table()));
        let unknown = store
            .remember(tool_write(EntryKind::Fact, "", "Tabs, not spaces", 4), 4)
            .unwrap();
        assert_eq!(unknown.outcome, WriteOutcome::Inserted);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_remembered_entry_with_an_existing_key_replaces_it_and_is_logged() {
        let root = temp_root("remember-key");
        let store = open_scope(&root).unwrap();
        store.set_embedder(Some(table()));
        let first = store
            .remember(
                tool_write(EntryKind::Decision, "deploy", "Deploys go through Fly", 1),
                1,
            )
            .unwrap();
        let second = store
            .remember(
                tool_write(
                    EntryKind::Decision,
                    "deploy",
                    "JWTs are signed with RS256",
                    2,
                ),
                2,
            )
            .unwrap();
        assert_eq!(second.outcome, WriteOutcome::Replaced);
        assert_eq!(second.entry.id, first.entry.id);
        assert_eq!(second.entry.content, "JWTs are signed with RS256");
        assert_eq!(second.entry.source, "claude");
        assert_eq!(second.entry.confidence, 1.0);

        // Visible where the Shared tab looks: the log and the event-log view.
        let events = store.events_newest(10).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, "decision");
        assert_eq!(events[0].key, "deploy");
        assert_eq!(
            events[0].payload,
            serde_json::json!({"text": "JWTs are signed with RS256"})
        );
        let shown = store
            .list(EntryKind::Decision, CAP_DECISIONS, Origin::EventLog)
            .unwrap();
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0].seq, Some(events[0].seq));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A merge stores nothing new, so it logs nothing: the event list never
    /// shows a phrasing the record does not hold.
    #[test]
    fn a_merge_logs_no_event_and_keeps_the_survivors_place() {
        let root = temp_root("merge-log");
        let store = open_scope(&root).unwrap();
        store.set_embedder(Some(table()));
        let first = store
            .remember(
                tool_write(EntryKind::Fact, "", "JWTs are signed with RS256", 1),
                1,
            )
            .unwrap();
        store
            .remember(
                tool_write(EntryKind::Fact, "", "JWT signing uses RS256", 2),
                2,
            )
            .unwrap();
        let events = store.events_newest(10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(
            store.list(EntryKind::Fact, 10, Origin::EventLog).unwrap()[0].seq,
            first.entry.seq
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Entries captured through the event log get vectors too, so an agent's
    /// paraphrase of a captured memory merges into it.
    #[test]
    fn a_tool_write_merges_into_a_near_duplicate_captured_through_the_log() {
        let root = temp_root("near-dup-log");
        let store = open_scope(&root).unwrap();
        store.set_embedder(Some(table()));
        store
            .append_event(
                ev(
                    EventKind::Fact,
                    "",
                    serde_json::json!({"text": "JWTs are signed with RS256"}),
                ),
                1,
            )
            .unwrap();
        let near = store
            .remember(
                tool_write(EntryKind::Fact, "", "JWT signing uses RS256", 2),
                2,
            )
            .unwrap();
        assert_eq!(near.outcome, WriteOutcome::Merged);
        assert_eq!(near.entry.content, "JWTs are signed with RS256");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn forget_removes_an_entry_and_its_vector() {
        let root = temp_root("forget");
        let store = open_scope(&root).unwrap();
        store.set_embedder(Some(table()));
        let first = store
            .remember(
                tool_write(EntryKind::Fact, "", "JWTs are signed with RS256", 1),
                1,
            )
            .unwrap();
        assert_eq!(
            store.forget(first.entry.id).unwrap().map(|e| e.id),
            Some(first.entry.id)
        );
        assert_eq!(store.forget(first.entry.id).unwrap(), None);
        // Nothing left to merge into.
        let near = store
            .remember(
                tool_write(EntryKind::Fact, "", "JWT signing uses RS256", 2),
                2,
            )
            .unwrap();
        assert_eq!(near.outcome, WriteOutcome::Inserted);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A user's edit rewrites the entry in place, attributed to the user at
    /// full confidence, and is logged so every session's delta carries it.
    #[test]
    fn an_edit_rewrites_the_entry_as_the_user() {
        let root = temp_root("edit");
        let store = open_scope(&root).unwrap();
        store
            .append_event(
                ev(
                    EventKind::Decision,
                    "alg",
                    serde_json::json!({"text": "HS256"}),
                ),
                1,
            )
            .unwrap();
        let id = store.list(EntryKind::Decision, 10, Origin::Any).unwrap()[0].id;

        let edited = store
            .edit(id, "  RS256, rotated monthly ", "user", 5)
            .unwrap()
            .expect("the entry exists");
        assert_eq!(edited.id, id);
        assert_eq!(
            (edited.content.as_str(), edited.key.as_str()),
            ("RS256, rotated monthly", "alg")
        );
        assert_eq!(
            (edited.source.as_str(), edited.agent.as_str()),
            ("user", "user")
        );
        assert_eq!((edited.confidence, edited.updated_at), (1.0, 5));
        assert_eq!(edited.seq, Some(2));

        let logged = &store.events_newest(1).unwrap()[0];
        assert_eq!(
            (logged.seq, logged.kind.as_str(), logged.key.as_str()),
            (2, "decision", "alg")
        );
        assert_eq!(logged.agent, "user");
        assert_eq!(
            logged.payload,
            serde_json::json!({"text": "RS256, rotated monthly"})
        );

        assert_eq!(store.edit(9_999, "anything", "user", 6).unwrap(), None);
        assert!(
            store.edit(id, "   ", "user", 6).is_err(),
            "an edit never empties an entry"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A file-changed entry's content is its summary: the logged edit keeps
    /// the event shape the fold and the Shared tab read.
    #[test]
    fn an_edited_file_change_logs_path_and_summary() {
        let root = temp_root("edit-file");
        let store = open_scope(&root).unwrap();
        store
            .append_event(
                ev(
                    EventKind::FileChanged,
                    "",
                    serde_json::json!({"path": "a.ts", "summary": "x"}),
                ),
                1,
            )
            .unwrap();
        let id = store.list(EntryKind::FileChanged, 10, Origin::Any).unwrap()[0].id;
        store.edit(id, "renamed the export", "user", 2).unwrap();
        assert_eq!(
            store.events_newest(1).unwrap()[0].payload,
            serde_json::json!({"path": "a.ts", "summary": "renamed the export"})
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Forgetting an entry takes its words out of the log's search and list
    /// too — the entry is gone, so is what carried it — while the sequence
    /// never goes back.
    #[test]
    fn a_forgotten_entry_no_longer_surfaces_from_the_log() {
        let root = temp_root("forget-log");
        let store = open_scope(&root).unwrap();
        store
            .append_event(
                ev(
                    EventKind::Fact,
                    "",
                    serde_json::json!({"text": "The staging DB is on port 6543"}),
                ),
                1,
            )
            .unwrap();
        store
            .append_event(
                ev(
                    EventKind::Fact,
                    "",
                    serde_json::json!({"text": "the staging db is on port 6543"}),
                ),
                2,
            )
            .unwrap();
        store
            .append_event(
                ev(
                    EventKind::Fact,
                    "",
                    serde_json::json!({"text": "Deploys go through Fly"}),
                ),
                3,
            )
            .unwrap();
        let entry = store.query("6543", &[], 10).unwrap().remove(0);

        store.forget(entry.id).unwrap().expect("forgotten");
        assert!(store.search_events("6543", 10).unwrap().is_empty());
        let listed: Vec<u64> = store
            .events_newest(10)
            .unwrap()
            .iter()
            .map(|e| e.seq)
            .collect();
        assert_eq!(listed, vec![3]);
        assert_eq!(store.search_events("fly", 10).unwrap().len(), 1);
        assert_eq!(store.last_event().unwrap().map(|(seq, _)| seq), Some(3));

        // A fresh write of the same words is a new memory, and shows.
        store
            .append_event(
                ev(
                    EventKind::Fact,
                    "",
                    serde_json::json!({"text": "The staging DB is on port 6543"}),
                ),
                4,
            )
            .unwrap();
        assert_eq!(
            store
                .search_events("6543", 10)
                .unwrap()
                .iter()
                .map(|e| e.seq)
                .collect::<Vec<_>>(),
            vec![4]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Retraction follows the entry's identity: forgetting one path's entry
    /// leaves another path with the same summary alone, and a correction
    /// (edit) takes the wording it replaced out of the log's search.
    #[test]
    fn retraction_follows_the_entry_identity() {
        let root = temp_root("retract-identity");
        let store = open_scope(&root).unwrap();
        for (i, path) in ["a.ts", "b.ts"].into_iter().enumerate() {
            store
                .append_event(
                    ev(
                        EventKind::FileChanged,
                        "",
                        serde_json::json!({"path": path, "summary": "formatted"}),
                    ),
                    i as i64,
                )
                .unwrap();
        }
        let a = store
            .list(EntryKind::FileChanged, 10, Origin::Any)
            .unwrap()
            .into_iter()
            .find(|e| e.key == "a.ts")
            .unwrap();
        store.forget(a.id).unwrap();
        let left = store.search_events("formatted", 10).unwrap().len();
        assert_eq!(left, 1);
        assert!(store.events_newest(10).unwrap()[0]
            .payload
            .to_string()
            .contains("b.ts"));

        store
            .append_event(
                ev(
                    EventKind::Fact,
                    "",
                    serde_json::json!({"text": "Staging is on port 6543"}),
                ),
                5,
            )
            .unwrap();
        let fact = store.query("6543", &[], 1).unwrap().remove(0);
        store
            .edit(fact.id, "Staging is on port 5432", "user", 6)
            .unwrap();
        assert!(
            store.search_events("6543", 10).unwrap().is_empty(),
            "the corrected wording is gone"
        );
        assert_eq!(store.search_events("5432", 10).unwrap().len(), 1);
        store.forget(fact.id).unwrap();
        assert!(store.search_events("staging", 10).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_ranks_term_matches_and_near_meanings() {
        let root = temp_root("search");
        let store = open_scope(&root).unwrap();
        store.set_embedder(Some(table()));
        for (i, (kind, text)) in [
            (EntryKind::Fact, "JWTs are signed with RS256"),
            (EntryKind::Decision, "Deploys go through Fly"),
            (EntryKind::Failure, "JWT expiry is fifteen minutes"),
        ]
        .into_iter()
        .enumerate()
        {
            store
                .remember(tool_write(kind, "", text, i as i64), i as i64)
                .unwrap();
        }
        let hits = store.search("rs256 signing", &[], 10, 100).unwrap();
        assert_eq!(
            hits.first().map(|e| e.content.as_str()),
            Some("JWTs are signed with RS256")
        );
        assert!(
            hits.iter().all(|e| e.content != "Deploys go through Fly"),
            "{hits:?}"
        );
        assert_eq!(hits[0].last_used_at, Some(100));

        let only_decisions = store
            .search("fly", &[EntryKind::Decision], 10, 100)
            .unwrap();
        assert_eq!(only_decisions.len(), 1);
        let none = store.search("fly", &[EntryKind::Fact], 10, 100).unwrap();
        assert!(none.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn one_handle_per_scope() {
        let root = temp_root("handle");
        let a = open_scope(&root).unwrap();
        let b = open_scope(&root).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        let _ = std::fs::remove_dir_all(&root);
    }
}

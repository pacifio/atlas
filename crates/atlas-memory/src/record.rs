//! The shared-memory **record store**: one SQLite database per scope.
//!
//! Every agent on a repository — native and ACP — writes into this one record,
//! through the Tauri backend, which is its only writer. It replaces the JSONL
//! event log (`.atlas/shared-memory/events.jsonl` + `state.json`) and absorbs
//! the extracted-memory markdown (`.atlas/memory/extracted/*.md`) on first open
//! (see [`legacy`]).
//!
//! The tables (`<scope root>/.atlas/memory/memory.sqlite`, WAL; schema v5):
//!
//! - **revisions** — canonical and immutable: every write to an entry
//!   (insert, replace, merge, edit, fold, import, forget, …) appends one row
//!   holding the entry as it then stood, sealed into a blake3 hash chain over
//!   the previous row. Only [`RecordStore::clear`] and [`RecordStore::purge`]
//!   ever delete one.
//! - **entries** — the current state: one row per live memory with its kind,
//!   key, content, provenance (`source`, `agent`, `session`), `confidence`,
//!   `state` (active, candidate, archived), `scope`, `evidence`, timestamps,
//!   `uses`, a normalised `content_hash` and the revision it currently is.
//!   Rebuildable from the revisions ([`RecordStore::rebuild_entries_from_revisions`]).
//!   Nothing is ever evicted: the old per-kind caps are display limits
//!   applied by [`RecordStore::list`].
//! - **events** — the append-only log (`seq`, `ts`, `kind`, `key`, `agent`,
//!   `session`, `payload`). The Shared tab's event list, query and append are
//!   served straight from it, byte-compatible with the JSONL log. Appending an
//!   event folds it into entries with the log's replace rules (same key
//!   replaces, a finished plan clears the active plan, a repeat edit to a path
//!   replaces the earlier one).
//! - **entries_fts** (BM25, rewritten in the same transaction as its entry)
//!   and **embed_cache** (f16 vectors keyed by model + text) are projections.
//! - **forgotten** — tombstones, so other sessions hear about a forget; and
//!   **sessions** — which agent owned which session, and when.
//!
//! Every write passes through [`clean`] and `atlas_redact` before it lands,
//! whoever wrote it.
//!
//! **Concurrency.** One connection per scope per process, behind a mutex:
//! [`open_scope`] hands every caller the same `Arc<RecordStore>` for a root, so
//! the single-writer invariant is a lock, never cross-process coordination.
//! Every method is synchronous and may touch disk; async callers run it on the
//! blocking pool. A keyed agent write that would replace another writer's
//! memory is refused unless it names the current revision
//! ([`RecordStore::remember_guarded`], [`Conflict`]).
//!
//! Entry ids are `INTEGER AUTOINCREMENT` and never reused, so a vector index
//! can key embeddings by entry id; a replaced entry keeps its id.
//!
//! **Near-duplicates.** With an [`Embedder`] installed ([`RecordStore::set_embedder`]),
//! a direct write of a durable kind that matches no key and no content hash is
//! compared by cosine against the live entries' cached vectors (searched
//! through an in-memory [`HnswStore`] keyed by entry id, built from the
//! cache). At [`NEAR_DUPLICATE`] or above it merges into the surviving entry
//! instead of inserting, bumping that entry's use count. With no model (not
//! downloaded, or it cannot embed a text) dedup is key-or-hash only; a write
//! never fails for want of an embedding. Event-log folds keep the log's exact
//! replace rules and are not near-duplicate merged, so the Shared tab's state
//! view is unchanged by this; their durable entries are embedded all the
//! same, so a later direct write can merge into a captured memory.

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
pub const CAP_PREFERENCES: usize = 30;

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
    /// How the user wants things done, or a correction with the rule to
    /// follow next time.
    Preference,
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
            Self::Preference => "preference",
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Plan,
    Decision,
    FileChanged,
    #[default]
    Fact,
    Failure,
    Architecture,
    /// How the user wants things done (a preference, or a correction with the
    /// rule to follow next time). Briefed first, and never aged by recency.
    Preference,
}

impl EntryKind {
    /// Every kind, working memory first.
    pub const ALL: [EntryKind; 7] = [
        Self::Plan,
        Self::FileChanged,
        Self::Decision,
        Self::Fact,
        Self::Failure,
        Self::Architecture,
        Self::Preference,
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
            Self::Preference => CAP_PREFERENCES,
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
            Self::Preference => EventKind::Preference,
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
            Self::Preference => "preference",
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
            "preference" => Self::Preference,
            _ => return None,
        })
    }

    /// The four durable kinds (accumulate, searchable, promotable).
    pub fn is_durable(self) -> bool {
        matches!(
            self,
            Self::Decision | Self::Fact | Self::Failure | Self::Architecture | Self::Preference
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
#[derive(Debug, Clone, PartialEq, Default)]
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
    /// The revision this row currently is (v5).
    pub rev: i64,
    pub state: State,
    /// `repo` (shared by the repository's agents) or `user` (this user, every repo).
    pub scope: String,
    /// JSON array of citations; `[]` when the memory cites nothing.
    pub evidence: String,
}

/// Where an entry stands. Tombstones are not a state of a live entry: a
/// forgotten entry leaves `entries`, and its last revision says `tombstoned`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    #[default]
    Active,
    /// Captured, not confirmed (below [`TRUSTED_CONFIDENCE`]).
    Candidate,
    /// Out of briefings and default search (expiry, feedback); kept.
    Archived,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Candidate => "candidate",
            Self::Archived => "archived",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw {
            "candidate" => Self::Candidate,
            "archived" => Self::Archived,
            _ => Self::Active,
        }
    }
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

/// One search result and the legs that found it (`(leg, 1-based rank)`).
#[derive(Debug, Clone)]
pub struct SearchHit {
    pub entry: Entry,
    pub why: Vec<(&'static str, usize)>,
}

/// How deep each search leg reads before fusion.
const LEG_DEPTH: usize = 100;
/// Cosine below which the meaning leg ignores an entry.
const MIN_SIMILARITY: f32 = 0.35;

/// The FTS5 tokenizer of every memory full-text index: Porter stemming over
/// unicode61, so `JWTs` finds `JWT` and `signing` finds `sign`.
pub(crate) const FTS_TOKENIZE: &str = "porter unicode61 remove_diacritics 2";

/// An FTS5 MATCH expression for free text: its words, each quoted, OR-ed.
/// One- and two-letter words (`is`, `a`, `of`) are left out when the text has
/// a longer one, so they do not pull in every entry that uses them. `None`
/// when the text has no word. Quoting makes every user string safe: no FTS5
/// syntax can leak in.
pub(crate) fn fts_query(text: &str) -> Option<String> {
    let all: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect();
    let long: Vec<&String> = all.iter().filter(|w| w.chars().count() >= 3).collect();
    let chosen: Vec<&String> = if long.is_empty() {
        all.iter().collect()
    } else {
        long
    };
    let mut words: Vec<String> = Vec::new();
    for w in chosen {
        let quoted = format!("\"{w}\"");
        if !words.contains(&quoted) {
            words.push(quoted);
        }
    }
    (!words.is_empty()).then(|| words.join(" OR "))
}

/// Provenance of a memory captured from an assistant's own words by a
/// marker (`note:`, `we will use`, …) rather than recorded on purpose.
pub const CAPTURE_SOURCE: &str = "capture";
/// Provenance of a memory the extractor distilled from a session (the app's
/// extraction pass writes with it).
pub const EXTRACTOR_SOURCE: &str = "extractor";
/// Confidence a captured line lands with: a candidate, not a trusted fact.
pub const CANDIDATE_CONFIDENCE: f64 = 0.3;
/// At or above this an entry is trusted (briefed, promotable); below it is
/// a candidate that a restatement, a user edit or (later) evidence and use
/// can promote.
pub const TRUSTED_CONFIDENCE: f64 = 0.5;

impl Entry {
    /// Whether this entry is still a candidate (captured, not confirmed).
    pub fn is_candidate(&self) -> bool {
        self.state == State::Candidate
    }

    /// The code this memory cites (empty when none, or when `evidence` is
    /// unreadable).
    pub fn citations(&self) -> Vec<crate::citation::Citation> {
        serde_json::from_str(&self.evidence).unwrap_or_default()
    }
}

/// Turns text into a vector for near-duplicate detection and search.
/// Synchronous: record writes already run off the async runtime.
pub trait Embedder: Send + Sync {
    /// The text's embedding, or `None` when it cannot be embedded right now
    /// (no model downloaded, a failed forward pass). Never an error.
    fn embed(&self, text: &str) -> Option<Embedding>;

    /// The model this embedder runs, when known without embedding anything:
    /// what the cache is keyed by for a backfill or a lookup.
    fn model_id(&self) -> Option<String> {
        None
    }
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
    /// The revision op this outcome is recorded as.
    fn op(self) -> &'static str {
        match self {
            Self::Inserted => "insert",
            Self::Replaced => "replace",
            Self::Merged => "merge",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Inserted => "inserted",
            Self::Replaced => "replaced",
            Self::Merged => "merged",
        }
    }
}

/// A keyed write refused because the memory it would replace changed under
/// the writer, or was last written by another agent or session.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error(
    "memory {id} is at revision {current_rev} (by {by}): \"{content}\". Read both versions, write \
     one that keeps what is still true, and pass expected_revision={current_rev} to replace it."
)]
pub struct Conflict {
    pub id: i64,
    pub current_rev: i64,
    pub by: String,
    pub content: String,
}

/// Who may replace a keyed entry.
#[derive(Debug, Clone, Copy)]
enum Guard {
    /// Internal writes (extractor, imports, capture): last writer wins.
    Open,
    /// An agent's write: the current revision, or its own entry.
    Expect(Option<i64>),
}

/// A merge of the same words by the entry's own last writer (same source,
/// same session) within this long is a retry, not a restatement.
const RETRY_WINDOW_MS: i64 = 5 * 60 * 1000;

/// Whether writing `e` over entry `id` (same content) is a retry of the
/// entry's last write: same source and session, within [`RETRY_WINDOW_MS`],
/// and the entry is active. A candidate's restatement is never a retry: it
/// is what confirms the candidate.
fn is_retry(tx: &Transaction<'_>, e: &NewEntry, id: i64) -> Result<bool> {
    let (source, session, updated_at, state): (String, String, i64, String) = tx.query_row(
        "SELECT source, session, updated_at, state FROM entries WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    Ok(source == e.source
        && session == e.session_id
        && state == State::Active.as_str()
        && (e.at - updated_at).abs() < RETRY_WINDOW_MS)
}

/// Whether entry `id` already cites every one of `evidence` (by path and
/// hash).
fn holds_evidence(
    tx: &Transaction<'_>,
    id: i64,
    evidence: &[crate::citation::Citation],
) -> Result<bool> {
    if evidence.is_empty() {
        return Ok(true);
    }
    let raw: String = tx.query_row("SELECT evidence FROM entries WHERE id = ?1", [id], |r| {
        r.get(0)
    })?;
    let held: Vec<crate::citation::Citation> = serde_json::from_str(&raw).unwrap_or_default();
    Ok(evidence
        .iter()
        .all(|c| held.iter().any(|h| h.path == c.path && h.hash == c.hash)))
}

/// Refuse a keyed replace of entry `id` that `guard` does not allow.
fn check_guard(tx: &Transaction<'_>, e: &NewEntry, id: i64, guard: Guard) -> Result<()> {
    let Guard::Expect(expected) = guard else {
        return Ok(());
    };
    let (rev, source, agent, session, content): (i64, String, String, String, String) = tx
        .query_row(
            "SELECT rev, source, agent, session, content FROM entries WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )?;
    let allowed = match expected {
        Some(want) => want == rev,
        // Own entry = same agent AND same session. A parallel session of the
        // same agent (another worktree) must read before it replaces.
        None => source == e.source && session == e.session_id,
    };
    if allowed {
        return Ok(());
    }
    let by = if agent.is_empty() { source } else { agent };
    Err(Conflict {
        id,
        current_rev: rev,
        by,
        content,
    }
    .into())
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
    /// The HNSW over the live entries' cached vectors for one model, built on
    /// first need.
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
    ///
    /// A database that fails to open, migrate or pass `PRAGMA quick_check` is
    /// never written: it is renamed to `memory.sqlite.corrupt-<ms>` (with its
    /// `-wal`/`-shm`), the daily snapshot (or an empty store) takes its place,
    /// and a `restored.json` marker tells the app once
    /// ([`restored_marker`](Self::restored_marker)). Quarantined files are kept.
    pub fn open(root: &Path) -> Result<Self> {
        match Self::open_checked(root) {
            Ok(store) => Ok(store),
            Err(e) => {
                let dir = memory_dir(root);
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_millis() as i64);
                tracing::warn!(
                    target: "atlas::memory",
                    "memory database at {} is damaged ({e:#}); quarantining",
                    dir.display()
                );
                for suffix in ["", "-wal", "-shm"] {
                    let from = dir.join(format!("{DB_FILE}{suffix}"));
                    if from.exists() {
                        std::fs::rename(
                            &from,
                            dir.join(format!("{DB_FILE}{suffix}.corrupt-{now}")),
                        )?;
                    }
                }
                let snapshot = dir.join(crate::health::SNAPSHOT_FILE);
                let from_snapshot =
                    snapshot.exists() && std::fs::copy(&snapshot, dir.join(DB_FILE)).is_ok();
                std::fs::write(
                    dir.join("restored.json"),
                    serde_json::json!({ "at": now, "from_snapshot": from_snapshot }).to_string(),
                )?;
                Self::open_checked(root)
            }
        }
    }

    /// `(when, whether from a snapshot)` if an open restored a damaged
    /// database since the last call; reading it clears it, so the app
    /// reports it once.
    pub fn restored_marker(root: &Path) -> Option<(i64, bool)> {
        let path = memory_dir(root).join("restored.json");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
        let _ = std::fs::remove_file(&path);
        Some((v["at"].as_i64()?, v["from_snapshot"].as_bool()?))
    }

    fn open_checked(root: &Path) -> Result<Self> {
        let dir = memory_dir(root);
        std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
        let path = dir.join(DB_FILE);
        let conn = Connection::open(&path).with_context(|| format!("open {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrate_schema(&conn)?;
        let quick: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if quick != "ok" {
            anyhow::bail!("quick_check: {quick}");
        }
        // One handle per scope per process, and a claim lives only while one
        // accept runs: a proposal still applying here was left by a run that
        // stopped mid-accept.
        conn.execute(
            "UPDATE dream_proposals SET status = ?1 WHERE status = ?2",
            params![PROPOSAL_PENDING, PROPOSAL_APPLYING],
        )?;
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

    pub(crate) fn embedder(&self) -> Option<Arc<dyn Embedder>> {
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

    /// The directories whose files are this scope's: the root and every
    /// worktree of its repository — the main one and each linked one (read
    /// from `<common git dir>/worktrees/*/gitdir`, no git process), found the
    /// same way when the root is itself a linked worktree. Each in its given
    /// and its canonical spelling.
    pub fn scope_dirs(&self) -> Vec<PathBuf> {
        let mut dirs = vec![self.root.clone()];
        if let Some(common) = git_common_dir(&self.root) {
            // A non-bare repository's common dir is its main worktree's `.git`.
            if common.file_name().is_some_and(|n| n == ".git") {
                if let Some(main) = common.parent() {
                    dirs.push(main.to_path_buf());
                }
            }
            if let Ok(entries) = std::fs::read_dir(common.join("worktrees")) {
                for entry in entries.flatten() {
                    let Ok(gitdir) = std::fs::read_to_string(entry.path().join("gitdir")) else {
                        continue;
                    };
                    // `gitdir` names the worktree's `.git` file.
                    if let Some(worktree) = Path::new(gitdir.trim()).parent() {
                        dirs.push(normalize_lexically(worktree));
                    }
                }
            }
        }
        let canonical: Vec<PathBuf> = dirs.iter().filter_map(|d| d.canonicalize().ok()).collect();
        dirs.extend(canonical);
        dirs.sort();
        dirs.dedup();
        dirs
    }

    /// Whether `path` names a file of this scope (see [`path_in_dirs`]).
    pub fn in_scope(&self, path: &str) -> bool {
        path_in_dirs(path, &self.scope_dirs())
    }

    pub(crate) fn conn(&self) -> MutexGuard<'_, Connection> {
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
            EventKind::Decision
                | EventKind::Fact
                | EventKind::Failure
                | EventKind::Architecture
                | EventKind::Preference
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
        // A fold that rewrote or removed existing entries leaves stale ids in
        // the in-memory index; rebuild it on next need rather than let them
        // crowd out real candidates.
        let stale = fold(&tx, &row)?;
        let folded = match &vector {
            Some((model, v)) => {
                let found: Option<(i64, String)> = tx
                    .query_row(
                        "SELECT id, content FROM entries WHERE seq = ?1",
                        [seq as i64],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                if let Some((_, content)) = &found {
                    put_cache(&tx, model, content, v)?;
                }
                found.map(|(id, _)| (id, model, v))
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

    /// Each session's newest event at or after `since`, by session id: when
    /// it last did anything this scope's log saw. Sessions with no event
    /// since then are absent.
    pub fn last_event_by_session(
        &self,
        since: i64,
    ) -> Result<std::collections::HashMap<String, i64>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT session, MAX(ts) FROM events WHERE session <> '' AND ts >= ?1 \
             GROUP BY session",
        )?;
        let rows = stmt.query_map([since], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
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

    /// Every live event one session logged, oldest first.
    pub fn events_of_session(&self, session: &str) -> Result<Vec<EventRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT seq, ts, agent, session, kind, key, payload FROM events {LIVE_EVENTS} \
             AND session = ?1 ORDER BY seq"
        ))?;
        let rows = stmt.query_map([session], event_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Keep a finished session's handoff note (one per session; a resumed
    /// session's later end replaces it).
    pub fn record_episode(&self, note: &crate::handoff::HandoffNote) -> Result<()> {
        self.conn().execute(
            "INSERT OR REPLACE INTO episodes (session, agent, started_at, ended_at, note) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                note.session,
                note.agent,
                note.started_at,
                note.ended_at,
                serde_json::to_string(note)?
            ],
        )?;
        Ok(())
    }

    /// The newest handoff note of any session but `except_session`, holding
    /// only what memory still trusts (see `live_note`) and only this scope's
    /// files.
    ///
    /// A note is stored when a session's end is recorded, and many sessions
    /// never get one: one still open in another tab, one cut off by a crash,
    /// one that ran before notes existed. So when a session without a note
    /// logged work after the newest stored note ended, its note is built now
    /// from its events ([`crate::handoff::build_handoff`]), `ended_at` being
    /// its last event, and that one is handed on instead.
    pub fn last_episode(
        &self,
        except_session: &str,
    ) -> Result<Option<crate::handoff::HandoffNote>> {
        let stored: Option<(String, i64)> = self
            .conn()
            .query_row(
                "SELECT note, ended_at FROM episodes WHERE session <> ?1 \
                 ORDER BY ended_at DESC LIMIT 1",
                [except_session],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let since = stored.as_ref().map_or(i64::MIN, |(_, at)| *at);
        let mut note = match self.unrecorded_handoff(except_session, since)? {
            Some(built) => Some(built),
            None => match stored {
                Some((raw, _)) => live_note(&self.conn(), &raw)?,
                None => None,
            },
        };
        if let Some(note) = &mut note {
            let dirs = self.scope_dirs();
            note.files
                .retain(|f| path_in_dirs(f.strip_suffix(" (deleted)").unwrap_or(f), &dirs));
        }
        Ok(note)
    }

    /// The note of the newest session other than `except_session` that has
    /// no stored note and logged work (anything but its start and end) after
    /// `since`, built from its events; `None` when there is none, or when the
    /// few newest such sessions left nothing to hand on.
    fn unrecorded_handoff(
        &self,
        except_session: &str,
        since: i64,
    ) -> Result<Option<crate::handoff::HandoffNote>> {
        /// How many such sessions are tried, newest first.
        const TRIED: i64 = 5;
        let candidates: Vec<(String, String, i64, Option<i64>)> = {
            let conn = self.conn();
            let mut stmt = conn.prepare(&format!(
                "SELECT e.session, MAX(e.agent), MAX(e.ts) AS last, \
                        (SELECT s.ended_at FROM sessions s WHERE s.session_id = e.session) \
                 FROM events e {LIVE_EVENTS} \
                   AND e.session <> '' AND e.session <> ?1 \
                   AND e.kind NOT IN ('session_start', 'session_end') \
                   AND e.session NOT IN (SELECT session FROM episodes) \
                 GROUP BY e.session HAVING last > ?2 \
                 ORDER BY last DESC LIMIT ?3"
            ))?;
            let rows = stmt.query_map(params![except_session, since, TRIED], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (session, agent, last, ended_at) in candidates {
            let built = crate::handoff::build_handoff(
                self,
                &session,
                &agent,
                ended_at.unwrap_or(last).max(last),
            )?;
            let Some(note) = live_note(&self.conn(), &serde_json::to_string(&built)?)? else {
                continue;
            };
            if !note.is_empty() {
                return Ok(Some(note));
            }
        }
        Ok(None)
    }

    /// Handoff notes that ended after `since`, oldest first, at most `limit`,
    /// each holding only what memory still trusts (see `live_note`).
    pub fn episodes_since(
        &self,
        since: i64,
        limit: usize,
    ) -> Result<Vec<crate::handoff::HandoffNote>> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT note FROM episodes WHERE ended_at > ?1 ORDER BY ended_at LIMIT ?2")?;
        let rows = stmt.query_map(params![since, limit as i64], |r| r.get::<_, String>(0))?;
        let raws: Vec<String> = rows.filter_map(Result::ok).collect();
        live_notes(&conn, raws)
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

    /// Entries of `kind` changed after `since` by any session but
    /// `exclude_session`, oldest first by `(updated_at, id)`, at most `limit`.
    /// What a changes call pages through. The session is whoever made the
    /// latest change (`changed_by`), not the entry's last content writer: an
    /// archive, a verdict or a rewind by another session reaches the writer,
    /// and a session never hears its own.
    pub fn changed_since(
        &self,
        kind: EntryKind,
        since: i64,
        exclude_session: &str,
        limit: usize,
    ) -> Result<Vec<Entry>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT * FROM entries WHERE kind = ?1 AND updated_at > ?2 AND changed_by <> ?3 \
             ORDER BY updated_at ASC, id ASC LIMIT ?4",
        )?;
        let rows = stmt.query_map(
            params![kind.as_str(), since, exclude_session, limit as i64],
            entry_from_row,
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The newest `updated_at` of any entry (0 for an empty record).
    pub fn max_updated_at(&self) -> Result<i64> {
        let conn = self.conn();
        Ok(conn.query_row(
            "SELECT COALESCE(MAX(updated_at), 0) FROM entries",
            [],
            |r| r.get(0),
        )?)
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
        Ok(self.write_entry(e, None, Guard::Open, &[], "")?.entry)
    }

    /// [`upsert`](Self::upsert), saying what the write did (inserted,
    /// replaced, or merged into an entry already stored).
    pub fn upsert_outcome(&self, e: NewEntry) -> Result<Remembered> {
        self.write_entry(e, None, Guard::Open, &[], "")
    }

    /// [`upsert_outcome`](Self::upsert_outcome) for a line imported from
    /// outside Atlas, with `note` (where it came from and the line's own
    /// metadata, untrusted) kept on the revision the write makes. The note is
    /// only shown: the entry's source, agent and state come from `e` alone.
    pub fn upsert_imported(&self, e: NewEntry, note: &str) -> Result<Remembered> {
        self.write_entry(e, None, Guard::Open, &[], note)
    }

    /// Write one entry as an agent's deliberate memory (a tool write): the
    /// [`upsert`](Self::upsert) rules — key replaces, same hash or a
    /// near-duplicate merges — plus, when something new was stored (not a
    /// merge), an event in the log at `ts`, so the write shows in the Shared
    /// tab's event list and state view like any other.
    pub fn remember(&self, e: NewEntry, ts: i64) -> Result<Remembered> {
        self.write_entry(e, Some(ts), Guard::Open, &[], "")
    }

    /// [`remember`](Self::remember) as an agent's write: a keyed replace
    /// goes through only when `expected_rev` is the entry's current revision,
    /// or, with none given, when the entry's last writer is this writer —
    /// the same agent **and** the same session (a parallel session of the
    /// same agent, in another worktree, is another writer). Otherwise the
    /// error is a [`Conflict`] naming the current revision.
    ///
    /// `evidence` is the code the memory rests on, already hashed by
    /// [`crate::citation::cite`]: an insert or a replace stores exactly it (a
    /// replace drops the old wording's evidence), a merge adds it to the
    /// survivor's (deduplicated by path and hash, at most
    /// [`crate::citation::MAX_CITATIONS`]).
    pub fn remember_guarded(
        &self,
        e: NewEntry,
        ts: i64,
        expected_rev: Option<i64>,
        evidence: &[crate::citation::Citation],
    ) -> Result<Remembered> {
        self.write_entry(e, Some(ts), Guard::Expect(expected_rev), evidence, "")
    }

    fn write_entry(
        &self,
        e: NewEntry,
        log_at: Option<i64>,
        guard: Guard,
        evidence: &[crate::citation::Citation],
        note: &str,
    ) -> Result<Remembered> {
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
            Some(found) => {
                if !e.key.is_empty() && found.content_hash != content_hash(&e.content) {
                    check_guard(&tx, &e, found.id, guard)?;
                }
                if found.content_hash == content_hash(&e.content)
                    && is_retry(&tx, &e, found.id)?
                    && holds_evidence(&tx, found.id, evidence)?
                {
                    // The same writer saying the same thing again moments
                    // later (a retried tool call) is not a restatement: no
                    // revision, no use bump. A repeat that brings new
                    // evidence goes on as a merge, so the evidence is kept.
                    let entry = tx.query_row(
                        "SELECT * FROM entries WHERE id = ?1",
                        [found.id],
                        entry_from_row,
                    )?;
                    tx.commit()?;
                    return Ok(Remembered {
                        entry,
                        outcome: WriteOutcome::Merged,
                    });
                }
                write_identity(&tx, &e, found)?
            }
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
        // The survivor of a merge keeps its own content, so its cached vector
        // stands; anything written anew gets the new text's vector. Vectors
        // are keyed by (model, text), so none can describe text it was not
        // computed from.
        let new_vector = match (&vector, outcome) {
            (Some((model, v)), WriteOutcome::Inserted | WriteOutcome::Replaced) => {
                put_cache(&tx, model, &e.content, v)?;
                Some((model, v))
            }
            _ => None,
        };
        if !evidence.is_empty() || outcome != WriteOutcome::Merged {
            let mut merged: Vec<crate::citation::Citation> = if outcome == WriteOutcome::Merged {
                let raw: String =
                    tx.query_row("SELECT evidence FROM entries WHERE id = ?1", [id], |r| {
                        r.get(0)
                    })?;
                serde_json::from_str(&raw).unwrap_or_default()
            } else {
                Vec::new()
            };
            for c in evidence {
                if !merged.iter().any(|m| m.path == c.path && m.hash == c.hash) {
                    merged.push(c.clone());
                }
            }
            merged.truncate(crate::citation::MAX_CITATIONS);
            tx.execute(
                "UPDATE entries SET evidence = ?2 WHERE id = ?1",
                params![id, serde_json::to_string(&merged)?],
            )?;
        }
        let rev = after_write(&tx, id, outcome.op(), false, Some(By::of(&e)))?;
        let note = redact_text(note.trim());
        if !note.is_empty() {
            tx.execute(
                "UPDATE revisions SET note = ?2 WHERE rev = ?1",
                params![rev, note],
            )?;
        }
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
        match (new_vector, outcome) {
            (Some((model, v)), _) => self.index_put(id, model, v),
            // A replace that could not be embedded: the index's vector for
            // this id described the old words.
            (None, WriteOutcome::Replaced) => {
                if let Some(index) = self.vectors().as_ref() {
                    let _ = index.hnsw.remove(id as u64);
                }
            }
            _ => {}
        }
        Ok(Remembered { entry, outcome })
    }

    /// The stored entry of `e`'s kind most similar to `v`, if at or above
    /// [`NEAR_DUPLICATE`]. Keyed entries only merge with keyless ones (two
    /// different keys are two different memories), and an entry the write
    /// contradicts (a different number, one side negated) is never merged
    /// into: the write is stored, and consolidation pairs the two.
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
            let row: Option<(String, String, String)> = tx
                .query_row(
                    "SELECT kind, key, content FROM entries WHERE id = ?1",
                    [id as i64],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            let Some((kind, key, content)) = row else {
                continue;
            };
            if kind != e.kind.as_str()
                || (!e.key.is_empty() && !key.is_empty())
                || crate::consolidate::contradicts_text(&e.content, &content)
            {
                continue;
            }
            let Some(stored) = cached(tx, model, &content)? else {
                continue;
            };
            let sim = cosine(v, &stored);
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
        self.edit_with(id, content, source, ts, None)
    }

    /// A content-only rewrite of entry `id` by `source` (an accepted dream
    /// proposal), only while the entry is still at revision `expected_rev`:
    /// redacted, logged and retracted like [`edit`](Self::edit), but its
    /// confidence, state, provenance (source, agent, session) and key stay
    /// as they are. The revision is an `edit` by `source` in no session.
    /// `Ok(None)` when no entry has that id or it has moved on from
    /// `expected_rev` (nothing is written); `Ok(Some(entry))` as stored.
    pub fn edit_guarded(
        &self,
        id: i64,
        content: &str,
        source: &str,
        ts: i64,
        expected_rev: i64,
    ) -> Result<Option<Entry>> {
        self.edit_with(id, content, source, ts, Some(expected_rev))
    }

    /// [`edit`](Self::edit) (`expected_rev` none) or
    /// [`edit_guarded`](Self::edit_guarded).
    fn edit_with(
        &self,
        id: i64,
        content: &str,
        source: &str,
        ts: i64,
        expected_rev: Option<i64>,
    ) -> Result<Option<Entry>> {
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
        if expected_rev.is_some_and(|rev| rev != old.rev) {
            return Ok(None);
        }
        let archived = old.state == State::Archived;
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
        if expected_rev.is_some() {
            tx.execute(
                "UPDATE entries SET content = ?2, content_hash = ?3, updated_at = ?4, seq = ?5 \
                 WHERE id = ?1",
                params![id, content, content_hash(&content), ts, seq as i64],
            )?;
            after_write(
                &tx,
                id,
                "edit",
                archived,
                Some(By {
                    source,
                    agent: source,
                    session: "",
                }),
            )?;
        } else {
            tx.execute(
                "UPDATE entries SET content = ?2, content_hash = ?3, source = ?4, agent = ?4, session = '', \
                 confidence = 1.0, updated_at = ?5, seq = ?6 WHERE id = ?1",
                params![id, content, content_hash(&content), source, ts, seq as i64],
            )?;
            after_write(&tx, id, "edit", false, None)?;
        }
        if let Some((model, v)) = &vector {
            put_cache(&tx, model, &content, v)?;
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

    /// Remove one entry (and its vector) at `at`, by `session` (empty for the
    /// Memory panel). Returns it, or `None` when no entry has that id.
    ///
    /// The log keeps its sequence, but the events that carried the entry (its
    /// identity's events, see `retract_events_of`) are **retracted**: the
    /// log's list and search no longer show them, so a forgotten memory
    /// surfaces nowhere. Nothing new is logged. A tombstone
    /// `(id, kind, session, at)` is kept so other sessions' `memory_changes`
    /// can report the forget.
    pub fn forget(&self, id: i64, at: i64, session: &str) -> Result<Option<Entry>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let entry = tx
            .query_row("SELECT * FROM entries WHERE id = ?1", [id], entry_from_row)
            .optional()?;
        if let Some(e) = &entry {
            before_delete(&tx, id, "forget", at, session)?;
            tx.execute("DELETE FROM entries WHERE id = ?1", [id])?;
            let seqs = retract_events_of(&tx, e)?;
            // The retracted seqs ride the tombstone, so purge can reach the
            // log's copies of the text later.
            tx.execute(
                "INSERT INTO forgotten (id, kind, session, at, seqs) VALUES (?1, ?2, ?3, ?4, ?5) \
                 ON CONFLICT(id) DO UPDATE SET session = excluded.session, at = excluded.at, \
                 seqs = excluded.seqs",
                params![
                    id,
                    e.kind.as_str(),
                    session,
                    at,
                    serde_json::to_string(&seqs)?
                ],
            )?;
        }
        tx.commit()?;
        if entry.is_some() {
            if let Some(index) = self.vectors().as_ref() {
                let _ = index.hnsw.remove(id as u64);
            }
        }
        Ok(entry)
    }

    /// Entries forgotten after `since` by any session but `exclude_session`:
    /// `(id, at)`, oldest first.
    pub fn forgotten_since(&self, since: i64, exclude_session: &str) -> Result<Vec<(i64, i64)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, at FROM forgotten WHERE at > ?1 AND session <> ?2 ORDER BY at ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![since, exclude_session], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
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

    /// When the import from `source` was recorded, if it was.
    pub fn import_recorded_at(&self, source: &str) -> Result<Option<i64>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT at FROM legacy_imports WHERE source = ?1",
                [source],
                |r| r.get(0),
            )
            .optional()?)
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
    /// restricted to `kinds` (see [`search_explained`](Self::search_explained)).
    /// Every entry returned is stamped as used at `now`.
    pub fn search(
        &self,
        query: &str,
        kinds: &[EntryKind],
        limit: usize,
        now: i64,
    ) -> Result<Vec<Entry>> {
        Ok(self
            .search_explained(query, kinds, limit, now)?
            .into_iter()
            .map(|h| h.entry)
            .collect())
    }

    /// Entries relevant to `query`, best first, at most `limit`, each with the
    /// legs that found it. Reciprocal-rank fusion of two legs — BM25 over the
    /// entries' words (FTS5) and meaning (cosine ≥ [`MIN_SIMILARITY`] over the
    /// content-keyed cache), each [`LEG_DEPTH`] deep — then two priors that
    /// only reorder what a leg found: trust (active before candidate, then
    /// confidence) and recency (last use or write). Archived entries are left
    /// out. An empty query lists the most recently written entries (no `why`).
    /// Every entry returned is stamped as used at `now`.
    pub fn search_explained(
        &self,
        query: &str,
        kinds: &[EntryKind],
        limit: usize,
        now: i64,
    ) -> Result<Vec<SearchHit>> {
        if query.trim().is_empty() {
            let out = self.query("", kinds, limit)?;
            self.mark_used(&out, now)?;
            return Ok(out
                .into_iter()
                .map(|entry| SearchHit {
                    entry,
                    why: Vec::new(),
                })
                .collect());
        }
        let qvec = self.embed(query.trim());
        let bm25: Vec<i64> = match fts_query(query) {
            Some(m) => {
                let conn = self.conn();
                let mut stmt = conn.prepare(
                    "SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?1 ORDER BY rank LIMIT ?2",
                )?;
                let ids = stmt
                    .query_map(params![m, LEG_DEPTH as i64], |r| r.get(0))?
                    .collect::<rusqlite::Result<Vec<i64>>>()?;
                ids
            }
            None => Vec::new(),
        };
        let dense: Vec<i64> = match &qvec {
            Some((model, v)) => self
                .dense_ids(model, v, LEG_DEPTH)?
                .into_iter()
                .filter(|(_, sim)| *sim >= MIN_SIMILARITY)
                .map(|(id, _)| id)
                .collect(),
            None => Vec::new(),
        };
        let mut candidates: HashMap<i64, Entry> = HashMap::new();
        {
            let conn = self.conn();
            for id in bm25.iter().chain(dense.iter()) {
                if candidates.contains_key(id) {
                    continue;
                }
                if let Some(e) = conn
                    .query_row("SELECT * FROM entries WHERE id = ?1", [id], entry_from_row)
                    .optional()?
                {
                    if e.state != State::Archived && (kinds.is_empty() || kinds.contains(&e.kind)) {
                        candidates.insert(*id, e);
                    }
                }
            }
        }
        let mut fusion: atlas_retrieval::rrf::Fusion<i64> = atlas_retrieval::rrf::Fusion::new();
        fusion.leg(
            "bm25",
            1.0,
            bm25.into_iter().filter(|id| candidates.contains_key(id)),
        );
        fusion.leg(
            "dense",
            1.0,
            dense.into_iter().filter(|id| candidates.contains_key(id)),
        );
        let mut by_trust: Vec<&Entry> = candidates.values().collect();
        by_trust.sort_by(|a, b| {
            (a.state == State::Candidate)
                .cmp(&(b.state == State::Candidate))
                .then(b.confidence.total_cmp(&a.confidence))
                .then(a.id.cmp(&b.id))
        });
        fusion.prior("trust", 0.5, by_trust.iter().map(|e| e.id));
        let mut by_recent: Vec<&Entry> = candidates.values().collect();
        by_recent.sort_by_key(|e| {
            (
                std::cmp::Reverse(e.last_used_at.unwrap_or(0).max(e.updated_at)),
                e.id,
            )
        });
        fusion.prior("recent", 0.3, by_recent.iter().map(|e| e.id));
        let hits: Vec<SearchHit> = fusion
            .finish()
            .into_iter()
            .take(limit)
            .filter_map(|f| {
                candidates
                    .remove(&f.id)
                    .map(|entry| SearchHit { entry, why: f.legs })
            })
            .collect();
        let used: Vec<Entry> = hits.iter().map(|h| h.entry.clone()).collect();
        self.mark_used(&used, now)?;
        Ok(hits
            .into_iter()
            .map(|h| SearchHit {
                entry: Entry {
                    last_used_at: Some(now),
                    ..h.entry
                },
                why: h.why,
            })
            .collect())
    }

    /// Entry ids nearest `v` among `model`'s cached vectors, `(id, cosine)`,
    /// best first. Lock order is `conn` then `vectors`, as everywhere here.
    fn dense_ids(&self, model: &str, v: &[f32], k: usize) -> Result<Vec<(i64, f32)>> {
        let conn = self.conn();
        let mut index = self.vectors();
        if !index
            .as_ref()
            .is_some_and(|i| i.model == model && i.dim == v.len())
        {
            *index = Some(build_index(&conn, model, v.len())?);
        }
        Ok(match index.as_ref() {
            Some(i) => i
                .hnsw
                .search(v, k)?
                .into_iter()
                .map(|(id, sim)| (id as i64, sim))
                .collect(),
            None => Vec::new(),
        })
    }

    /// Embed every live entry whose current text has no cached vector for the
    /// installed model. Returns how many were added; 0 without a model.
    pub fn sync_vectors(&self) -> Result<usize> {
        let Some(embedder) = self.embedder() else {
            return Ok(0);
        };
        let Some(model) = embedder.model_id() else {
            return Ok(0);
        };
        let missing: Vec<(i64, String)> = {
            let conn = self.conn();
            let mut stmt = conn.prepare("SELECT id, content FROM entries")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
            let mut out = Vec::new();
            for row in rows {
                let (id, content) = row?;
                if cached(&conn, &model, &content)?.is_none() {
                    out.push((id, content));
                }
            }
            out
        };
        let mut added = 0;
        for (id, content) in missing {
            let Some((m, v)) = self.embed(&content) else {
                continue;
            };
            {
                let mut conn = self.conn();
                let tx = conn.transaction()?;
                put_cache(&tx, &m, &content, &v)?;
                tx.commit()?;
            }
            self.index_put(id, &m, &v);
            added += 1;
        }
        Ok(added)
    }

    /// The cached vector of entry `id`'s current text for the installed model.
    #[cfg(test)]
    pub(crate) fn vector_of(&self, id: i64) -> Option<Vec<f32>> {
        let model = self.embedder()?.model_id()?;
        let conn = self.conn();
        let content: String = conn
            .query_row("SELECT content FROM entries WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .ok()?;
        cached(&conn, &model, &content).ok().flatten()
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
            "DELETE FROM events; DELETE FROM entries; DELETE FROM sessions; \
             DELETE FROM retracted_events; DELETE FROM forgotten; DELETE FROM revisions; \
             DELETE FROM entries_fts; DELETE FROM embed_cache; DELETE FROM links; \
             DELETE FROM episodes; DELETE FROM feedback; DELETE FROM dreams; \
             DELETE FROM dream_proposals; DELETE FROM dream_attempt;",
        )?;
        tx.commit()?;
        *self.vectors() = None;
        Ok(())
    }
}

/// Who wrote a memory, in which session, and when. `title` and `commits`
/// describe that session as the capture record has it; the app fills them
/// at read time and they are never stored here.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Source {
    pub agent: String,
    pub session: String,
    pub at: i64,
    pub title: Option<String>,
    pub commits: Vec<String>,
}

/// Whether `path` lies in one of `dirs`: a relative path that does not climb
/// out (`..`) always does; an absolute one (or `~/…`, read from `$HOME`)
/// only under one of them, compared component by component after `.` and
/// `..` are resolved, as given and canonicalised. An agent's edits to
/// another checkout, `/tmp` or `~/.claude` are not this scope's files, and
/// `<root>/../elsewhere` is not under the root.
pub fn path_in_dirs(path: &str, dirs: &[PathBuf]) -> bool {
    let path = path.trim();
    if path.is_empty() {
        return false;
    }
    let expanded;
    let p = if let Some(rest) = path.strip_prefix('~') {
        // `~user/…` names someone else's home: never this scope's.
        let rest = match rest.strip_prefix(['/', '\\']) {
            Some(rest) => rest,
            None if rest.is_empty() => "",
            None => return false,
        };
        let Some(home) = home_dir() else {
            return false;
        };
        expanded = home.join(rest);
        expanded.as_path()
    } else {
        Path::new(path)
    };
    let p = normalize_lexically(p);
    if !p.has_root() {
        return !p
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir));
    }
    let dirs: Vec<PathBuf> = dirs.iter().map(|d| normalize_lexically(d)).collect();
    if dirs.iter().any(|d| p.starts_with(d)) {
        return true;
    }
    // A symlinked spelling (`/tmp` → `/private/tmp`): the file, else its
    // directory, canonicalised. A deleted file's directory usually remains.
    let canonical = p.canonicalize().ok().or_else(|| {
        let parent = p.parent()?.canonicalize().ok()?;
        Some(parent.join(p.file_name()?))
    });
    canonical.is_some_and(|c| dirs.iter().any(|d| c.starts_with(d)))
}

/// The user's home directory, from the environment.
fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

/// `path` with `.` dropped and each `..` taking off the component before it,
/// without touching the filesystem. A `..` with nothing to take off stays
/// (relative) or is dropped (at the root, where `/..` is `/`).
fn normalize_lexically(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out: Vec<Component<'_>> = Vec::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => match out.last() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                Some(Component::RootDir | Component::Prefix(_)) => {}
                _ => out.push(c),
            },
            c => out.push(c),
        }
    }
    out.iter().collect()
}

/// The repository's common git directory for a checkout at `root`: its
/// `.git` directory, or — for a linked worktree, whose `.git` is a file
/// naming `<common>/worktrees/<name>` — the directory that file's
/// `commondir` points back to. Read from the files, no git process.
fn git_common_dir(root: &Path) -> Option<PathBuf> {
    let dot_git = root.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    let pointer = std::fs::read_to_string(&dot_git).ok()?;
    let gitdir = pointer.trim().strip_prefix("gitdir:")?.trim();
    let gitdir = root.join(gitdir);
    let common = match std::fs::read_to_string(gitdir.join("commondir")) {
        Ok(common) => gitdir.join(common.trim()),
        Err(_) => gitdir,
    };
    Some(normalize_lexically(&common))
}

/// A stable reference to the session a memory came from, in the spirit of
/// the Agent Memory Repo `source` key. Opaque: Atlas has no URL scheme.
pub fn source_uri(s: &Source) -> String {
    if s.agent == "user" {
        "atlas-user".to_string()
    } else if s.session.is_empty() {
        s.agent.clone()
    } else {
        format!("atlas-session:{}/{}", s.agent, s.session)
    }
}

/// One immutable revision of an entry.
#[derive(Debug, Clone, PartialEq)]
pub struct Revision {
    pub rev: i64,
    pub op: String,
    pub content: String,
    pub source: String,
    pub agent: String,
    pub state: String,
    pub confidence: f64,
    pub at: i64,
    /// Untrusted provenance kept with the revision (an imported line's own
    /// metadata); empty for most. Never read as who wrote it.
    pub note: String,
}

impl RecordStore {
    /// Rebuild `entries` (and its FTS rows) from the revisions: each entry's
    /// latest revision, unless that revision is a tombstone. The repair the
    /// reconciler runs when the current-state table and the history
    /// disagree. `uses`, `last_used_at`, `seq` and `changed_by` are not
    /// revisioned: a row that was still there keeps its own, so a repair
    /// neither makes a used memory look unused (expiry) nor empties the
    /// Shared tab's state view; a row that was missing takes its `seq` from
    /// the live log (the newest event that carried its words) and the
    /// defaults (0, null) for the rest. `created_at` is the entry's first
    /// revision's time.
    pub fn rebuild_entries_from_revisions(&self) -> Result<usize> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute_batch(
            "DROP TABLE IF EXISTS temp.rebuild_keep;
             CREATE TEMP TABLE rebuild_keep AS \
               SELECT id, uses, last_used_at, seq, changed_by FROM entries;
             DELETE FROM entries; DELETE FROM entries_fts;",
        )?;
        let n = tx.execute(
            &format!(
                "INSERT INTO entries (id, {SNAPSHOT_COLUMNS}, created_at, updated_at, rev, changed_by) \
                 SELECT r.entry_id, r.kind, r.key, r.content, r.content_hash, r.status, r.source, \
                        r.agent, r.session, r.confidence, r.state, r.scope, r.evidence, \
                        (SELECT MIN(f.at) FROM revisions f WHERE f.entry_id = r.entry_id), r.at, r.rev, \
                        r.session \
                 FROM revisions r \
                 WHERE r.rev = (SELECT MAX(m.rev) FROM revisions m WHERE m.entry_id = r.entry_id) \
                   AND r.state <> 'tombstoned'"
            ),
            [],
        )?;
        tx.execute(
            "UPDATE entries SET uses = k.uses, last_used_at = k.last_used_at, seq = k.seq, \
             changed_by = k.changed_by FROM temp.rebuild_keep k WHERE k.id = entries.id",
            [],
        )?;
        let missing: Vec<i64> = {
            let mut stmt = tx.prepare(
                "SELECT id FROM entries WHERE id NOT IN (SELECT id FROM temp.rebuild_keep)",
            )?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for id in missing {
            let e = tx.query_row("SELECT * FROM entries WHERE id = ?1", [id], entry_from_row)?;
            if let Some(seq) = logged_seq(&tx, &e)? {
                tx.execute(
                    "UPDATE entries SET seq = ?2 WHERE id = ?1",
                    params![id, seq],
                )?;
            }
        }
        tx.execute_batch(
            "DROP TABLE temp.rebuild_keep;
             INSERT INTO entries_fts (rowid, key, content) SELECT id, key, content FROM entries;",
        )?;
        tx.commit()?;
        drop(conn);
        *self.vectors() = None;
        Ok(n)
    }

    /// The first revision whose chain link doesn't match its row and the link
    /// before it, or `None` when the whole history verifies. One pass.
    pub fn verify_chain(&self) -> Result<Option<i64>> {
        first_bad(&self.conn())
    }

    /// The distinct writers of each entry, oldest first, at most five each:
    /// every revision that put words in it (a restatement by another session
    /// is a second source).
    pub fn sources_for(&self, ids: &[i64]) -> Result<HashMap<i64, Vec<Source>>> {
        let mut out: HashMap<i64, Vec<Source>> = HashMap::new();
        if ids.is_empty() {
            return Ok(out);
        }
        let conn = self.conn();
        let marks = vec!["?"; ids.len()].join(",");
        let mut stmt = conn.prepare(&format!(
            "SELECT entry_id, CASE WHEN agent = '' THEN source ELSE agent END AS who, session, \
                    MIN(at) AS first_at, MIN(rev) AS first_rev FROM revisions \
             WHERE entry_id IN ({marks}) \
               AND op IN ('insert','replace','merge','edit','fold','import','baseline','promote') \
             GROUP BY entry_id, who, session ORDER BY entry_id, first_at, first_rev"
        ))?;
        let rows = stmt.query_map(rusqlite::params_from_iter(ids), |r| {
            Ok((
                r.get::<_, i64>(0)?,
                Source {
                    agent: r.get(1)?,
                    session: r.get(2)?,
                    at: r.get(3)?,
                    ..Default::default()
                },
            ))
        })?;
        for row in rows {
            let (id, s) = row?;
            let list = out.entry(id).or_default();
            if list.len() < 5 {
                list.push(s);
            }
        }
        Ok(out)
    }

    /// Every revision of entry `id`, oldest first (empty for an unknown id).
    pub fn history(&self, id: i64) -> Result<Vec<Revision>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT rev, op, content, source, agent, state, confidence, at, note FROM revisions \
             WHERE entry_id = ?1 ORDER BY rev",
        )?;
        let rows = stmt.query_map([id], |r| {
            Ok(Revision {
                rev: r.get(0)?,
                op: r.get(1)?,
                content: r.get(2)?,
                source: r.get(3)?,
                agent: r.get(4)?,
                state: r.get(5)?,
                confidence: r.get(6)?,
                at: r.get(7)?,
                note: r.get(8)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Erase a forgotten entry's text everywhere it survives: its revisions,
    /// the log events forget retracted, its cached vectors (every model),
    /// with SQLite's secure delete on and the WAL truncated, so the bytes are
    /// overwritten rather than left in free pages. The tombstone row stays,
    /// textless, and history keeps one textless `purge` marker; the hash
    /// chain is re-sealed from the first removed revision. The full-text
    /// index is merged so no segment keeps its words, and the daily snapshot
    /// is removed. For secrets. Refused for a live entry (forget it first),
    /// and while a revision from the entry's first on was edited outside
    /// Atlas (re-sealing would hide that). Returns whether anything was
    /// erased.
    pub fn purge(&self, id: i64) -> Result<bool> {
        let mut conn = self.conn();
        if conn
            .query_row("SELECT 1 FROM entries WHERE id = ?1", [id], |_| Ok(()))
            .optional()?
            .is_some()
        {
            anyhow::bail!("memory {id} is live; forget it before purging");
        }
        conn.pragma_update(None, "secure_delete", "ON")?;
        let erased = (|| -> Result<bool> {
            let tx = conn.transaction()?;
            let texts: Vec<String> = {
                let mut stmt = tx.prepare(
                    "SELECT DISTINCT content FROM revisions WHERE entry_id = ?1 AND op <> 'purge'",
                )?;
                let rows = stmt.query_map([id], |r| r.get(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            if texts.is_empty() {
                return Ok(false);
            }
            let (first, kind, at): (i64, String, i64) = tx.query_row(
                "SELECT MIN(rev), \
                        (SELECT kind FROM revisions WHERE entry_id = ?1 ORDER BY rev DESC LIMIT 1), \
                        (SELECT MAX(at) FROM revisions WHERE entry_id = ?1) \
                 FROM revisions WHERE entry_id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
            // Re-sealing from `first` would seal over an outside edit of any
            // later revision too, and the reconciler would then rebuild the
            // view from it. Only the user's accept may do that.
            if let Some(bad) = first_bad(&tx)? {
                if bad >= first {
                    anyhow::bail!(
                        "history was edited outside Atlas at revision {bad}; accept or restore \
                         it before purging"
                    );
                }
            }
            let mut seqs: Vec<i64> = tx
                .query_row("SELECT seqs FROM forgotten WHERE id = ?1", [id], |r| {
                    r.get::<_, String>(0)
                })
                .optional()?
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            // An edit retracted the wording it replaced without the tombstone
            // knowing: every logged event of the entry's kinds whose text is
            // one of its wordings goes too.
            let hashes: std::collections::HashSet<String> =
                texts.iter().map(|t| content_hash(t)).collect();
            let kinds: Vec<String> = {
                let mut stmt =
                    tx.prepare("SELECT DISTINCT kind FROM revisions WHERE entry_id = ?1")?;
                let rows = stmt.query_map([id], |r| r.get(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            for kind in kinds.iter().filter_map(|k| EntryKind::parse(k)) {
                let mut stmt = tx.prepare("SELECT seq, payload FROM events WHERE kind = ?1")?;
                let rows = stmt.query_map([kind.event_kind().as_str()], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
                })?;
                for row in rows {
                    let (seq, payload) = row?;
                    let payload: serde_json::Value =
                        serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null);
                    let text = payload
                        .get(content_field(kind))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim();
                    if !text.is_empty() && hashes.contains(&content_hash(text)) {
                        seqs.push(seq);
                    }
                }
            }
            for seq in &seqs {
                tx.execute("DELETE FROM events WHERE seq = ?1", [seq])?;
                tx.execute("DELETE FROM retracted_events WHERE seq = ?1", [seq])?;
            }
            let models: Vec<String> = {
                let mut stmt = tx.prepare("SELECT DISTINCT model FROM embed_cache")?;
                let rows = stmt.query_map([], |r| r.get(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            for text in &texts {
                for model in &models {
                    tx.execute(
                        "DELETE FROM embed_cache WHERE key = ?1",
                        [&atlas_retrieval::codec::cache_key(model, text)[..]],
                    )?;
                }
            }
            tx.execute("DELETE FROM revisions WHERE entry_id = ?1", [id])?;
            tx.execute(
                "INSERT INTO revisions (entry_id, op, kind, key, content, content_hash, source, agent, \
                 session, confidence, state, at) \
                 VALUES (?1, 'purge', ?2, '', '', '', 'user', '', '', 0, 'tombstoned', ?3)",
                params![id, kind, at],
            )?;
            reseal_from(&tx, first)?;
            tx.execute("UPDATE forgotten SET seqs = '[]' WHERE id = ?1", [id])?;
            // Everything else that could carry its words or name it.
            tx.execute("DELETE FROM feedback WHERE entry_id = ?1", [id])?;
            tx.execute("DELETE FROM links WHERE a = ?1 OR b = ?1", [id])?;
            let proposals: Vec<(i64, String)> = {
                let mut stmt = tx.prepare("SELECT id, op FROM dream_proposals")?;
                let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            for (pid, op) in proposals {
                let op_json: serde_json::Value = serde_json::from_str(&op).unwrap_or_default();
                if json_names_id(&op_json, id) || texts.iter().any(|t| json_mentions(&op, t)) {
                    tx.execute("DELETE FROM dream_proposals WHERE id = ?1", [pid])?;
                }
            }
            let episodes: Vec<(String, String)> = {
                let mut stmt = tx.prepare("SELECT session, note FROM episodes")?;
                let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            for (session, note) in episodes {
                if texts.iter().any(|t| json_mentions(&note, t)) {
                    tx.execute("DELETE FROM episodes WHERE session = ?1", [session])?;
                }
            }
            // A dream's dropped operations quote what the model was shown.
            let dreams: Vec<(i64, String)> = {
                let mut stmt = tx.prepare("SELECT id, dropped FROM dreams")?;
                let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            for (dream, dropped) in dreams {
                let kept = match serde_json::from_str::<Vec<serde_json::Value>>(&dropped) {
                    Ok(items) => {
                        let kept: Vec<&serde_json::Value> = items
                            .iter()
                            .filter(|item| {
                                !json_names_id(&item["op"], id)
                                    && !texts.iter().any(|t| json_mentions(&item.to_string(), t))
                            })
                            .collect();
                        if kept.len() == items.len() {
                            continue;
                        }
                        serde_json::to_string(&kept)?
                    }
                    Err(_) if texts.iter().any(|t| json_mentions(&dropped, t)) => "[]".to_string(),
                    Err(_) => continue,
                };
                tx.execute(
                    "UPDATE dreams SET dropped = ?2 WHERE id = ?1",
                    params![dream, kept],
                )?;
            }
            // Tombstoned FTS rows keep their terms in the index's segments
            // until a merge; merge them now, while secure delete is on.
            tx.execute(
                "INSERT INTO entries_fts(entries_fts) VALUES('optimize')",
                [],
            )?;
            tx.commit()?;
            Ok(true)
        })();
        conn.pragma_update(None, "secure_delete", "OFF")?;
        let erased = erased?;
        if erased {
            let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
            // The daily snapshot still holds the entry, and an open that
            // finds the database damaged would restore it from there. The
            // next health pass takes a fresh one.
            let snapshot = memory_dir(&self.root).join(crate::health::SNAPSHOT_FILE);
            if let Err(e) = std::fs::remove_file(&snapshot) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(
                        target: "atlas::memory",
                        "purged, but the snapshot at {} was not removed: {e}",
                        snapshot.display()
                    );
                }
            }
        }
        Ok(erased)
    }
}

/// A memory neither written nor used for this long is due for expiry: a
/// candidate archives, an active memory archives only when its citations are
/// stale (M3, ADR-0018).
pub const EXPIRE_AFTER_MS: i64 = 28 * 24 * 3600 * 1000;

impl RecordStore {
    /// Memories not written or used within [`EXPIRE_AFTER_MS`] of `now`
    /// (active or candidate), by id.
    pub fn expiry_candidates(&self, now: i64) -> Result<Vec<Entry>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT * FROM entries WHERE state IN ('active', 'candidate') \
             AND MAX(updated_at, COALESCE(last_used_at, 0)) < ?1 ORDER BY id",
        )?;
        let rows = stmt.query_map([now - EXPIRE_AFTER_MS], entry_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Move `ids` to the archive: out of briefings and default search, kept,
    /// one `archive` revision each. Archiving stamps `updated_at`, so other
    /// sessions hear about it through `memory_changes`. Returns how many
    /// changed.
    pub fn archive(&self, ids: &[i64], at: i64) -> Result<usize> {
        self.archive_as(ids, at, "archive")
    }

    /// [`archive`](Self::archive), recorded as revision op `op`.
    pub(crate) fn archive_as(&self, ids: &[i64], at: i64, op: &str) -> Result<usize> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut n = 0;
        for id in ids {
            if tx.execute(
                "UPDATE entries SET updated_at = ?2 WHERE id = ?1 AND state <> 'archived'",
                params![id, at],
            )? == 1
            {
                after_write(&tx, *id, op, true, None)?;
                // No session archived it (expiry, the user, a dream): every
                // session hears about it, the writer's included.
                tx.execute("UPDATE entries SET changed_by = '' WHERE id = ?1", [id])?;
                n += 1;
            }
        }
        tx.commit()?;
        Ok(n)
    }

    /// Each entry's latest content write (`insert`, `replace`, `merge`,
    /// `edit`): `(agent, session, at)`. One query on `revisions_entry`.
    pub fn last_writes(&self, ids: &[i64]) -> Result<HashMap<i64, (String, String, i64)>> {
        let mut out = HashMap::new();
        if ids.is_empty() {
            return Ok(out);
        }
        let conn = self.conn();
        let marks = vec!["?"; ids.len()].join(",");
        let mut stmt = conn.prepare(&format!(
            "SELECT r.entry_id, r.agent, r.session, r.at FROM revisions r \
             WHERE r.entry_id IN ({marks}) AND r.rev = (SELECT MAX(m.rev) FROM revisions m \
               WHERE m.entry_id = r.entry_id AND m.op IN ('insert','replace','merge','edit'))"
        ))?;
        let rows = stmt.query_map(rusqlite::params_from_iter(ids), |r| {
            Ok((r.get::<_, i64>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?)))
        })?;
        for row in rows {
            let (id, write) = row?;
            out.insert(id, write);
        }
        Ok(out)
    }
}

// ── Feedback, review and links (M4) ──────────────────────────────────────────

/// What a memory was worth to the agent (or user) that used it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Useful,
    Wrong,
    Stale,
}

impl Verdict {
    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw.trim() {
            "useful" => Self::Useful,
            "wrong" => Self::Wrong,
            "stale" => Self::Stale,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Useful => "useful",
            Self::Wrong => "wrong",
            Self::Stale => "stale",
        }
    }
}

/// The confidence a promotion raises a memory to.
pub const PROMOTED_CONFIDENCE: f64 = 0.7;

/// How two memories relate: one replaced the other, they disagree, or the
/// user said they are different things (so neither is proposed again).
pub const LINK_SUPERSEDES: &str = "supersedes";
pub const LINK_CONTRADICTS: &str = "contradicts";
pub const LINK_DISTINCT: &str = "distinct";

/// How a link between `a` and `b` is stored: `(min, max)` for the
/// symmetric relations, as given for `supersedes`.
fn link_order(a: i64, b: i64, rel: &str) -> (i64, i64) {
    if rel == LINK_CONTRADICTS || rel == LINK_DISTINCT {
        (a.min(b), a.max(b))
    } else {
        (a, b)
    }
}

impl RecordStore {
    /// An agent's or the user's verdict on a memory it used. Useful: counted,
    /// and a candidate another session vouches for is promoted. Wrong:
    /// archived at a candidate's confidence, kept in history. Stale: back to a candidate until confirmed
    /// again. Every verdict is kept as a `feedback` row. `None` for an
    /// unknown id.
    pub fn feedback(
        &self,
        id: i64,
        verdict: Verdict,
        note: &str,
        by: &str,
        session: &str,
        at: i64,
    ) -> Result<Option<Entry>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let Some(e) = tx
            .query_row("SELECT * FROM entries WHERE id = ?1", [id], entry_from_row)
            .optional()?
        else {
            return Ok(None);
        };
        tx.execute(
            "INSERT INTO feedback (entry_id, verdict, note, by, session, at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                verdict.as_str(),
                redact_text(note.trim()),
                by,
                session,
                at
            ],
        )?;
        let who = By {
            source: by,
            agent: by,
            session,
        };
        match verdict {
            Verdict::Useful => {
                tx.execute(
                    "UPDATE entries SET uses = uses + 1, last_used_at = ?2 WHERE id = ?1",
                    params![id, at],
                )?;
                // The writer's own session can't vouch for itself.
                if e.state == State::Candidate && e.session_id != session {
                    tx.execute(
                        "UPDATE entries SET confidence = MAX(confidence, ?2), updated_at = ?3 \
                         WHERE id = ?1",
                        params![id, PROMOTED_CONFIDENCE, at],
                    )?;
                    after_write(&tx, id, "promote", false, Some(who))?;
                }
            }
            Verdict::Wrong => {
                // Down to a candidate's confidence as well, so a later merge
                // (a captured echo, an extractor line) can bring it back at
                // most as a candidate; only a trusted write makes it active.
                tx.execute(
                    "UPDATE entries SET confidence = MIN(confidence, ?2), updated_at = ?3 \
                     WHERE id = ?1",
                    params![id, CANDIDATE_CONFIDENCE, at],
                )?;
                after_write(&tx, id, "feedback", true, Some(who))?;
            }
            Verdict::Stale => {
                tx.execute(
                    "UPDATE entries SET confidence = MIN(confidence, ?2), updated_at = ?3 \
                     WHERE id = ?1",
                    params![id, CANDIDATE_CONFIDENCE, at],
                )?;
                after_write(&tx, id, "feedback", false, Some(who))?;
            }
        }
        let out = tx.query_row("SELECT * FROM entries WHERE id = ?1", [id], entry_from_row)?;
        tx.commit()?;
        Ok(Some(out))
    }

    /// The user's approval from the review queue: a candidate or archived
    /// memory becomes active. Returns whether the entry exists.
    pub fn promote(&self, id: i64, at: i64) -> Result<bool> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let n = tx.execute(
            "UPDATE entries SET confidence = MAX(confidence, ?2), updated_at = ?3 WHERE id = ?1",
            params![id, PROMOTED_CONFIDENCE, at],
        )?;
        if n == 1 {
            after_write(
                &tx,
                id,
                "promote",
                false,
                Some(By {
                    source: "user",
                    agent: "user",
                    session: "",
                }),
            )?;
        }
        tx.commit()?;
        Ok(n == 1)
    }

    /// One entry by id, without stamping it as used.
    pub fn peek(&self, id: i64) -> Result<Option<Entry>> {
        Ok(self
            .conn()
            .query_row("SELECT * FROM entries WHERE id = ?1", [id], entry_from_row)
            .optional()?)
    }

    /// Entries in `state`, newest first.
    pub fn list_state(&self, state: State, limit: usize) -> Result<Vec<Entry>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT * FROM entries WHERE state = ?1 ORDER BY updated_at DESC, id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![state.as_str(), limit as i64], entry_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Record that `a` relates to `b` (`supersedes`, `contradicts`,
    /// `distinct`). Idempotent; returns whether the link is new. The
    /// symmetric relations are stored as `(min, max)`, so either order names
    /// the same link; `supersedes` keeps its direction.
    pub fn link(&self, a: i64, b: i64, rel: &str, at: i64, by: &str) -> Result<bool> {
        let (a, b) = link_order(a, b, rel);
        Ok(self.conn().execute(
            "INSERT OR IGNORE INTO links (a, b, rel, at, by) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![a, b, rel, at, by],
        )? == 1)
    }

    /// Every pair linked by one of `rels`, as `(min, max)`.
    pub fn linked_pairs(&self, rels: &[&str]) -> Result<std::collections::BTreeSet<(i64, i64)>> {
        let mut out = std::collections::BTreeSet::new();
        for rel in rels {
            for (a, b) in self.links(rel)? {
                out.insert((a.min(b), a.max(b)));
            }
        }
        Ok(out)
    }

    /// Active entries of the durable kinds, by id.
    pub fn durable_active(&self) -> Result<Vec<Entry>> {
        let kinds: Vec<&str> = EntryKind::ALL
            .into_iter()
            .filter(|k| k.is_durable())
            .map(EntryKind::as_str)
            .collect();
        let marks = vec!["?"; kinds.len()].join(",");
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT * FROM entries WHERE state = 'active' AND kind IN ({marks}) ORDER BY id"
        ))?;
        let rows = stmt.query_map(rusqlite::params_from_iter(kinds), entry_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The installed model's cached vector of `text`, if any. Never embeds.
    pub fn vector_for_text(&self, text: &str) -> Option<Vec<f32>> {
        let model = self.embedder()?.model_id()?;
        cached(&self.conn(), &model, text).ok().flatten()
    }

    /// Remove one link (a symmetric one in either order). Returns whether it
    /// existed.
    pub fn unlink(&self, a: i64, b: i64, rel: &str) -> Result<bool> {
        let (a, b) = link_order(a, b, rel);
        Ok(self.conn().execute(
            "DELETE FROM links WHERE a = ?1 AND b = ?2 AND rel = ?3",
            params![a, b, rel],
        )? == 1)
    }

    /// Every link touching `id`, as `(other, rel)`.
    pub fn links_of(&self, id: i64) -> Result<Vec<(i64, String)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT CASE WHEN a = ?1 THEN b ELSE a END, rel FROM links \
             WHERE a = ?1 OR b = ?1 ORDER BY at, rel",
        )?;
        let rows = stmt.query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Every link with relation `rel`, as `(a, b)`.
    pub fn links(&self, rel: &str) -> Result<Vec<(i64, i64)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT a, b FROM links WHERE rel = ?1 ORDER BY a, b")?;
        let rows = stmt.query_map([rel], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

/// One write a session made to memory, as the "Memory updated" card lists it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWrite {
    pub id: i64,
    pub rev: i64,
    pub op: String,
    pub kind: String,
    pub content: String,
    /// The state at this revision.
    pub state: String,
    pub at: i64,
    /// Whether the entry is still live now (exists and is not archived),
    /// whoever changed it since.
    pub live: bool,
}

impl RecordStore {
    /// What one session wrote to memory after `since`, newest first, at most
    /// 20 (the "Memory updated" card). Read from the revisions, so replaced
    /// and forgotten entries are listed too; `live` says whether each entry
    /// still stands.
    pub fn session_writes(&self, session: &str, since: i64) -> Result<Vec<SessionWrite>> {
        if session.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT r.entry_id, r.rev, r.op, r.kind, r.content, r.state, r.at, \
                    e.id IS NOT NULL AND e.state <> 'archived' \
             FROM revisions r LEFT JOIN entries e ON e.id = r.entry_id \
             WHERE r.session = ?1 AND r.at > ?2 \
               AND r.op IN ('insert','replace','merge','edit','forget','feedback','rewind') \
             ORDER BY r.rev DESC LIMIT 20",
        )?;
        let rows = stmt.query_map(params![session, since], |r| {
            Ok(SessionWrite {
                id: r.get(0)?,
                rev: r.get(1)?,
                op: r.get(2)?,
                kind: r.get(3)?,
                content: r.get(4)?,
                state: r.get(5)?,
                at: r.get(6)?,
                live: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Drop to candidates the active entries whose latest content write was
    /// made by `session` inside one of `windows` (ms, inclusive): turns the
    /// agent took back. An entry written again afterwards (by anyone) is
    /// left alone, and so is an extractor write: it lands whenever the model
    /// answers, and it was distilled from earlier turns. The `rewind`
    /// revision is filed under `session` and the write it takes back.
    /// Idempotent. Returns the ids demoted, ascending.
    pub fn demote_rewound(
        &self,
        session: &str,
        windows: &[(i64, i64)],
        at: i64,
    ) -> Result<Vec<i64>> {
        if session.is_empty() || windows.is_empty() {
            return Ok(Vec::new());
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        // (id, the taken-back write's source and agent)
        let mut found: Vec<(i64, String, String)> = Vec::new();
        {
            let mut stmt = tx.prepare(
                "SELECT e.id, r.source, r.agent FROM entries e JOIN revisions r ON r.entry_id = e.id \
                 WHERE r.session = ?1 AND r.at BETWEEN ?2 AND ?3 AND e.state = 'active' \
                   AND r.source <> ?4 \
                   AND r.rev = (SELECT MAX(m.rev) FROM revisions m WHERE m.entry_id = e.id \
                                AND m.op IN ('insert','replace','merge','edit')) \
                 ORDER BY e.id",
            )?;
            for (from, to) in windows {
                let rows = stmt.query_map(params![session, from, to, EXTRACTOR_SOURCE], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })?;
                for row in rows {
                    let row = row?;
                    if !found.iter().any(|(id, ..)| *id == row.0) {
                        found.push(row);
                    }
                }
            }
        }
        found.sort_unstable_by_key(|(id, ..)| *id);
        for (id, source, agent) in &found {
            tx.execute(
                "UPDATE entries SET confidence = MIN(confidence, ?2), updated_at = ?3 WHERE id = ?1",
                params![id, CANDIDATE_CONFIDENCE, at],
            )?;
            after_write(
                &tx,
                *id,
                "rewind",
                false,
                Some(By {
                    source,
                    agent,
                    session,
                }),
            )?;
        }
        tx.commit()?;
        Ok(found.into_iter().map(|(id, ..)| id).collect())
    }

    /// Live (not archived) entries that `sessions` wrote (any content
    /// write), newest first, at most `limit`. Uses `revisions_session`.
    pub fn entries_by_sessions(&self, sessions: &[String], limit: usize) -> Result<Vec<Entry>> {
        if sessions.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn();
        let marks = vec!["?"; sessions.len()].join(",");
        let mut stmt = conn.prepare(&format!(
            "SELECT * FROM entries WHERE id IN (SELECT DISTINCT entry_id FROM revisions \
               WHERE session IN ({marks}) \
                 AND op IN ('insert','replace','merge','edit','import','promote')) \
             AND state <> 'archived' ORDER BY updated_at DESC, id DESC LIMIT {limit}"
        ))?;
        let rows = stmt.query_map(rusqlite::params_from_iter(sessions), entry_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Live entries with a citation of `path` (scope-root relative), newest
    /// first, at most `limit`.
    pub fn entries_citing(&self, path: &str, limit: usize) -> Result<Vec<Entry>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT * FROM entries WHERE state <> 'archived' AND json_valid(evidence) AND EXISTS \
               (SELECT 1 FROM json_each(entries.evidence) \
                 WHERE json_extract(value, '$.path') = ?1) \
             ORDER BY updated_at DESC, id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![path, limit as i64], entry_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The handoff note `session` left, if it left one, holding only what
    /// memory still trusts (see `live_note`).
    pub fn episode_of(&self, session: &str) -> Result<Option<crate::handoff::HandoffNote>> {
        let conn = self.conn();
        let note: Option<String> = conn
            .query_row(
                "SELECT note FROM episodes WHERE session = ?1",
                [session],
                |r| r.get(0),
            )
            .optional()?;
        match note {
            Some(n) => live_note(&conn, &n),
            None => Ok(None),
        }
    }

    /// Sessions still live, or that started or ended at or after `since`,
    /// most recent first. A live session that started long ago is included:
    /// it may still be working.
    pub fn sessions_since(&self, since: i64, limit: usize) -> Result<Vec<String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT session_id FROM sessions \
             WHERE ended_at IS NULL OR ended_at >= ?1 OR started_at >= ?1 \
             ORDER BY COALESCE(ended_at, started_at) DESC, session_id LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![since, limit as i64], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

/// A pending dream proposal is `pending` until the user accepts or dismisses
/// it, or an accept finds it `obsolete` (an id gone, a revision moved on).
pub const PROPOSAL_PENDING: &str = "pending";
/// A proposal an accept has claimed ([`RecordStore::claim_proposal`]) and is
/// applying; it ends `accepted` or `obsolete`, or goes back to `pending`.
pub const PROPOSAL_APPLYING: &str = "applying";

/// One stored dream proposal.
#[derive(Debug, Clone, PartialEq)]
pub struct DreamProposal {
    pub id: i64,
    pub op: crate::dream::DreamOp,
    pub status: String,
    /// The revision each entry the op names was at when the dream was
    /// recorded, by entry id (an id already gone then is absent).
    pub revs: std::collections::BTreeMap<i64, i64>,
}

/// A proposed operation as JSON without the model's `why`, so the same
/// operation proposed twice compares equal.
fn without_why(mut op: serde_json::Value) -> serde_json::Value {
    if let Some(fields) = op.as_object_mut() {
        fields.remove("why");
    }
    op
}

impl RecordStore {
    /// The newest dream: `(at, episodes_to)`, the newest episode end it read.
    pub fn last_dream(&self) -> Result<Option<(i64, i64)>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT at, episodes_to FROM dreams ORDER BY at DESC, id DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
    }

    /// The newest `limit` handoff notes, oldest first, each holding only what
    /// memory still trusts (see `live_note`).
    pub fn recent_episodes(&self, limit: usize) -> Result<Vec<crate::handoff::HandoffNote>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT note FROM episodes ORDER BY ended_at DESC LIMIT ?1")?;
        let rows = stmt.query_map([limit as i64], |r| r.get::<_, String>(0))?;
        let mut raws: Vec<String> = rows.filter_map(Result::ok).collect();
        raws.reverse();
        live_notes(&conn, raws)
    }

    /// Note that a dream was attempted at `at`, before the model is called,
    /// so a dream that fails or times out is not retried on every health
    /// pass. One row: a later attempt replaces it.
    pub fn record_dream_attempt(&self, at: i64) -> Result<()> {
        self.conn().execute(
            "INSERT OR REPLACE INTO dream_attempt (id, at) VALUES (1, ?1)",
            [at],
        )?;
        Ok(())
    }

    /// When a dream was last attempted ([`record_dream_attempt`](Self::record_dream_attempt)),
    /// whether or not it finished.
    pub fn last_dream_attempt(&self) -> Result<Option<i64>> {
        Ok(self
            .conn()
            .query_row("SELECT at FROM dream_attempt WHERE id = 1", [], |r| {
                r.get(0)
            })
            .optional()?)
    }

    /// Keep one dream and its surviving operations as pending proposals, in
    /// one transaction. Each proposal keeps the revision every entry it
    /// names was at when the model saw it (`seen`, by id; the current one for
    /// an entry the model was not shown), so an accept can tell the entry
    /// changed since. An
    /// operation the same as one already pending or applying (ignoring the
    /// model's `why`) is not proposed again: it joins the dropped ones as
    /// `already proposed`. Returns the dream id.
    pub fn record_dream(
        &self,
        at: i64,
        model: &str,
        episodes_to: i64,
        kept: &[crate::dream::DreamOp],
        dropped: &[(crate::dream::DreamOp, &str)],
        seen: &std::collections::BTreeMap<i64, i64>,
    ) -> Result<i64> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut dropped_json: Vec<serde_json::Value> = dropped
            .iter()
            .map(|(op, why)| serde_json::json!({ "op": op, "why": why }))
            .collect();
        let mut open: Vec<serde_json::Value> = {
            let mut stmt =
                tx.prepare("SELECT op FROM dream_proposals WHERE status IN (?1, ?2) ORDER BY id")?;
            let rows = stmt.query_map([PROPOSAL_PENDING, PROPOSAL_APPLYING], |r| {
                r.get::<_, String>(0)
            })?;
            rows.filter_map(Result::ok)
                .filter_map(|op| serde_json::from_str(&op).ok())
                .map(without_why)
                .collect()
        };
        let mut fresh: Vec<(String, String)> = Vec::new();
        for op in kept {
            let same = without_why(serde_json::to_value(op)?);
            if open.contains(&same) {
                dropped_json.push(serde_json::json!({ "op": op, "why": "already proposed" }));
                continue;
            }
            open.push(same);
            let mut revs: Vec<(i64, i64)> = Vec::new();
            for id in op.ids() {
                let rev: Option<i64> = match seen.get(&id) {
                    Some(rev) => Some(*rev),
                    None => tx
                        .query_row("SELECT rev FROM entries WHERE id = ?1", [id], |r| r.get(0))
                        .optional()?,
                };
                if let Some(rev) = rev {
                    revs.push((id, rev));
                }
            }
            fresh.push((serde_json::to_string(op)?, serde_json::to_string(&revs)?));
        }
        tx.execute(
            "INSERT INTO dreams (at, model, episodes_to, kept, dropped) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                at,
                model,
                episodes_to,
                fresh.len() as i64,
                serde_json::to_string(&dropped_json)?
            ],
        )?;
        let dream = tx.last_insert_rowid();
        for (op, revs) in &fresh {
            tx.execute(
                "INSERT INTO dream_proposals (dream_id, op, status, at, revs) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![dream, op, PROPOSAL_PENDING, at, revs],
            )?;
        }
        tx.commit()?;
        Ok(dream)
    }

    /// Proposals in `status`, oldest first, as `(id, op)`. A row whose op no
    /// longer parses is skipped.
    pub fn dream_proposals(&self, status: &str) -> Result<Vec<(i64, crate::dream::DreamOp)>> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare("SELECT id, op FROM dream_proposals WHERE status = ?1 ORDER BY id")?;
        let rows = stmt.query_map([status], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        Ok(rows
            .filter_map(Result::ok)
            .filter_map(|(id, op)| serde_json::from_str(&op).ok().map(|op| (id, op)))
            .collect())
    }

    /// One proposal and its status.
    pub fn dream_proposal(&self, id: i64) -> Result<Option<(crate::dream::DreamOp, String)>> {
        let row: Option<(String, String)> = self
            .conn()
            .query_row(
                "SELECT op, status FROM dream_proposals WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(row.and_then(|(op, status)| serde_json::from_str(&op).ok().map(|op| (op, status))))
    }

    /// One proposal with its status and the revisions it was made against.
    /// `None` for an unknown id or an op that no longer parses.
    pub fn proposal(&self, id: i64) -> Result<Option<DreamProposal>> {
        let row: Option<(String, String, String)> = self
            .conn()
            .query_row(
                "SELECT op, status, revs FROM dream_proposals WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        Ok(row.and_then(|(op, status, revs)| {
            let op = serde_json::from_str(&op).ok()?;
            let revs: Vec<(i64, i64)> = serde_json::from_str(&revs).unwrap_or_default();
            Some(DreamProposal {
                id,
                op,
                status,
                revs: revs.into_iter().collect(),
            })
        }))
    }

    /// Claim a pending proposal for applying: `pending` → `applying` in one
    /// statement, so of two concurrent accepts only one goes ahead. Returns
    /// whether this call claimed it (false when it was not pending).
    pub fn claim_proposal(&self, id: i64) -> Result<bool> {
        Ok(self.conn().execute(
            "UPDATE dream_proposals SET status = ?2 WHERE id = ?1 AND status = ?3",
            params![id, PROPOSAL_APPLYING, PROPOSAL_PENDING],
        )? == 1)
    }

    /// Set a proposal's status (`accepted`, `dismissed`, `obsolete`, or back
    /// to `pending`) while it is still undecided (`pending` or `applying`);
    /// a decided proposal keeps its status.
    pub fn set_proposal_status(&self, id: i64, status: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE dream_proposals SET status = ?2 WHERE id = ?1 AND status IN (?3, ?4)",
            params![id, status, PROPOSAL_PENDING, PROPOSAL_APPLYING],
        )?;
        Ok(())
    }

    /// Whether the words `id` holds now were written by the user (a dream
    /// never touches it): its latest revision that set its content. A
    /// restatement (merge), a verdict or a promotion by an agent keeps the
    /// user's words, so it keeps them protected.
    pub fn last_written_by_user(&self, id: i64) -> Result<bool> {
        let agent: Option<String> = self
            .conn()
            .query_row(
                "SELECT agent FROM revisions WHERE entry_id = ?1 \
                   AND op IN ('insert','replace','edit','fold','import','baseline') \
                 ORDER BY rev DESC LIMIT 1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(agent.as_deref() == Some("user"))
    }
}

/// A stored handoff note as it may be handed on: every decision, failure,
/// fact and architecture item that no active entry of that kind holds any
/// more (by content hash) is dropped. The note is a snapshot of what the
/// session logged; since then an item may have been forgotten, marked wrong,
/// taken back with its turn, or never been more than a candidate. `None`
/// when the stored JSON no longer parses.
fn live_note(conn: &Connection, raw: &str) -> Result<Option<crate::handoff::HandoffNote>> {
    let Ok(mut note) = serde_json::from_str::<crate::handoff::HandoffNote>(raw) else {
        return Ok(None);
    };
    let mut held = conn.prepare_cached(
        "SELECT EXISTS(SELECT 1 FROM entries WHERE kind = ?1 AND content_hash = ?2 \
         AND state = 'active')",
    )?;
    for (kind, items) in [
        (EntryKind::Decision, &mut note.decisions),
        (EntryKind::Failure, &mut note.failures),
        (EntryKind::Fact, &mut note.facts),
        (EntryKind::Architecture, &mut note.architecture),
    ] {
        let mut kept = Vec::with_capacity(items.len());
        for item in items.drain(..) {
            if held.query_row(params![kind.as_str(), content_hash(&item)], |r| {
                r.get::<_, bool>(0)
            })? {
                kept.push(item);
            }
        }
        *items = kept;
    }
    Ok(Some(note))
}

/// [`live_note`] over several stored notes, in order; unreadable ones are
/// skipped.
fn live_notes(conn: &Connection, raws: Vec<String>) -> Result<Vec<crate::handoff::HandoffNote>> {
    let mut out = Vec::with_capacity(raws.len());
    for raw in raws {
        if let Some(note) = live_note(conn, &raw)? {
            out.push(note);
        }
    }
    Ok(out)
}

/// Whether a stored JSON document carries `text` (as JSON spells it).
fn json_mentions(json: &str, text: &str) -> bool {
    let spelled = serde_json::to_string(text).unwrap_or_default();
    let inner = spelled.trim_matches('"');
    !inner.is_empty() && json.contains(inner)
}

/// Whether a JSON value names entry `id`: any integer equal to it, except
/// under a key about revisions.
fn json_names_id(v: &serde_json::Value, id: i64) -> bool {
    match v {
        serde_json::Value::Number(n) => n.as_i64() == Some(id),
        serde_json::Value::Array(items) => items.iter().any(|x| json_names_id(x, id)),
        serde_json::Value::Object(map) => map
            .iter()
            .any(|(k, x)| !k.contains("rev") && json_names_id(x, id)),
        _ => false,
    }
}

// ── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA_VERSION: i64 = 6;

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
    if version < 3 {
        // v3: events whose content was forgotten, hidden from the log's list
        // and search (the rows stay, so the sequence never goes back).
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS retracted_events (
                 seq  INTEGER PRIMARY KEY
             );
             PRAGMA user_version = 3;
             COMMIT;",
        )?;
    }
    if version < 4 {
        // v4: forgets as tombstones, so other sessions can hear about them.
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS forgotten (
                 id       INTEGER PRIMARY KEY,
                 kind     TEXT NOT NULL,
                 session  TEXT NOT NULL DEFAULT '',
                 at       INTEGER NOT NULL
             );
             PRAGMA user_version = 4;
             COMMIT;",
        )?;
    }
    if version < 5 {
        migrate_v5(conn).inspect_err(|_| {
            let _ = conn.execute_batch("ROLLBACK;");
        })?;
    }
    if version < 6 {
        // v6 (M4): links between memories, one handoff note per finished
        // session, agents' verdicts, and the dream pass's proposals (with
        // the revisions of the entries each names, and when a dream was
        // last attempted). The session index serves memory_why, the
        // rewound-turn check and the "Memory updated" card. `changed_by` is
        // the session of an entry's latest change, which memory_changes
        // filters on. A revision's `note` is untrusted provenance (an
        // imported line's own metadata), outside the hash chain.
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE entries ADD COLUMN changed_by TEXT NOT NULL DEFAULT '';
             UPDATE entries SET changed_by = session;
             ALTER TABLE revisions ADD COLUMN note TEXT NOT NULL DEFAULT '';
             CREATE TABLE IF NOT EXISTS links (
                 a    INTEGER NOT NULL,
                 b    INTEGER NOT NULL,
                 rel  TEXT NOT NULL,
                 at   INTEGER NOT NULL,
                 by   TEXT NOT NULL,
                 PRIMARY KEY (a, b, rel)
             );
             CREATE TABLE IF NOT EXISTS episodes (
                 session     TEXT PRIMARY KEY,
                 agent       TEXT NOT NULL,
                 started_at  INTEGER,
                 ended_at    INTEGER NOT NULL,
                 note        TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS feedback (
                 entry_id  INTEGER NOT NULL,
                 verdict   TEXT NOT NULL,
                 note      TEXT NOT NULL DEFAULT '',
                 by        TEXT NOT NULL,
                 session   TEXT NOT NULL,
                 at        INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS dreams (
                 id           INTEGER PRIMARY KEY AUTOINCREMENT,
                 at           INTEGER NOT NULL,
                 model        TEXT NOT NULL,
                 episodes_to  INTEGER NOT NULL,
                 kept         INTEGER NOT NULL,
                 dropped      TEXT NOT NULL DEFAULT '[]'
             );
             CREATE TABLE IF NOT EXISTS dream_proposals (
                 id        INTEGER PRIMARY KEY AUTOINCREMENT,
                 dream_id  INTEGER NOT NULL,
                 op        TEXT NOT NULL,
                 status    TEXT NOT NULL DEFAULT 'pending',
                 at        INTEGER NOT NULL,
                 revs      TEXT NOT NULL DEFAULT '[]'
             );
             CREATE TABLE IF NOT EXISTS dream_attempt (
                 id  INTEGER PRIMARY KEY CHECK (id = 1),
                 at  INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS revisions_session ON revisions(session, at);
             PRAGMA user_version = 6;
             COMMIT;",
        )
        .inspect_err(|_| {
            let _ = conn.execute_batch("ROLLBACK;");
        })?;
    }
    Ok(())
}

/// v5: canonical revisions, entry state/scope/evidence, BM25, content-keyed
/// vectors. One transaction: every live entry gets a `baseline` revision,
/// every stored vector moves into the cache under (model, text), and the
/// baselines are sealed into the hash chain.
fn migrate_v5(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "BEGIN;
         CREATE TABLE IF NOT EXISTS revisions (
             rev           INTEGER PRIMARY KEY AUTOINCREMENT,
             entry_id      INTEGER NOT NULL,
             op            TEXT NOT NULL,
             kind          TEXT NOT NULL,
             key           TEXT NOT NULL,
             content       TEXT NOT NULL,
             content_hash  TEXT NOT NULL,
             status        TEXT NOT NULL DEFAULT '',
             source        TEXT NOT NULL,
             agent         TEXT NOT NULL,
             session       TEXT NOT NULL,
             confidence    REAL NOT NULL,
             state         TEXT NOT NULL,
             scope         TEXT NOT NULL DEFAULT 'repo',
             evidence      TEXT NOT NULL DEFAULT '[]',
             at            INTEGER NOT NULL,
             chain         BLOB NOT NULL DEFAULT x''
         );
         CREATE INDEX IF NOT EXISTS revisions_entry ON revisions(entry_id, rev);
         ALTER TABLE entries ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
         ALTER TABLE entries ADD COLUMN state TEXT NOT NULL DEFAULT 'active';
         ALTER TABLE entries ADD COLUMN scope TEXT NOT NULL DEFAULT 'repo';
         ALTER TABLE entries ADD COLUMN evidence TEXT NOT NULL DEFAULT '[]';
         ALTER TABLE forgotten ADD COLUMN seqs TEXT NOT NULL DEFAULT '[]';
         UPDATE entries SET state = 'candidate' WHERE confidence < 0.5;
         CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
             key, content, content='', contentless_delete=1,
             tokenize='porter unicode61 remove_diacritics 2');
         INSERT INTO entries_fts(rowid, key, content) SELECT id, key, content FROM entries;
         CREATE TABLE IF NOT EXISTS embed_cache (
             key    BLOB PRIMARY KEY,
             model  TEXT NOT NULL,
             dims   INTEGER NOT NULL,
             vec    BLOB NOT NULL
         );
         INSERT INTO revisions (entry_id, op, kind, key, content, content_hash, status, source, agent,
                                session, confidence, state, scope, evidence, at)
           SELECT id, 'baseline', kind, key, content, content_hash, status, source, agent, session,
                  confidence, state, scope, evidence, updated_at FROM entries ORDER BY id;
         UPDATE entries SET rev = (SELECT MAX(r.rev) FROM revisions r WHERE r.entry_id = entries.id);",
    )?;
    // entry_vectors (f32, keyed by entry id) → embed_cache (f16, keyed by
    // model + text): the vector now names the text it was computed from.
    let moved: Vec<(String, String, Vec<u8>)> = {
        let mut stmt = conn.prepare(
            "SELECT v.model, e.content, v.vec FROM entry_vectors v JOIN entries e ON e.id = v.id",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (model, content, blob) in moved {
        let v = decode_vec(&blob);
        conn.execute(
            "INSERT OR REPLACE INTO embed_cache (key, model, dims, vec) VALUES (?1, ?2, ?3, ?4)",
            params![
                &atlas_retrieval::codec::cache_key(&model, &content)[..],
                model,
                v.len() as i64,
                atlas_retrieval::codec::to_f16(&v)
            ],
        )?;
    }
    conn.execute_batch("DROP TABLE IF EXISTS entry_vectors;")?;
    reseal_from(conn, 0)?;
    conn.execute_batch("PRAGMA user_version = 5; COMMIT;")?;
    Ok(())
}

// ── Revisions ────────────────────────────────────────────────────────────────

/// The entry columns a revision snapshots (besides id, op and time).
const SNAPSHOT_COLUMNS: &str =
    "kind, key, content, content_hash, status, source, agent, session, confidence, state, scope, evidence";

/// Who wrote a revision when it is not the entry row's own writer: a merge
/// keeps the surviving entry's writer, but the revision is the restater's.
#[derive(Clone, Copy)]
struct By<'a> {
    source: &'a str,
    agent: &'a str,
    session: &'a str,
}

impl<'a> By<'a> {
    fn of(e: &'a NewEntry) -> Self {
        Self {
            source: &e.source,
            agent: &e.agent,
            session: &e.session_id,
        }
    }
}

/// After a write to entry `id`: settle its state (`archive` archives it;
/// otherwise its confidence decides, so a real write revives an archived
/// entry), note who changed it (`changed_by`: `by`'s session, else the
/// row's own), append its row as a new immutable revision `op` (by `by` when
/// the writer is not the row's own), seal it into the chain, point
/// `entries.rev` at it, and rewrite its FTS row. Returns the new revision
/// number.
fn after_write(
    tx: &Transaction<'_>,
    id: i64,
    op: &str,
    archive: bool,
    by: Option<By<'_>>,
) -> Result<i64> {
    tx.execute(
        "UPDATE entries SET state = CASE WHEN ?3 THEN 'archived' \
         WHEN confidence < ?2 THEN 'candidate' ELSE 'active' END, \
         changed_by = COALESCE(?4, session) WHERE id = ?1",
        params![id, TRUSTED_CONFIDENCE, archive, by.map(|b| b.session)],
    )?;
    tx.execute(
        "INSERT INTO revisions (entry_id, op, kind, key, content, content_hash, status, source, agent, \
         session, confidence, state, scope, evidence, at) \
         SELECT id, ?2, kind, key, content, content_hash, status, COALESCE(?3, source), \
         COALESCE(?4, agent), COALESCE(?5, session), confidence, state, scope, evidence, updated_at \
         FROM entries WHERE id = ?1",
        params![
            id,
            op,
            by.map(|b| b.source),
            by.map(|b| b.agent),
            by.map(|b| b.session)
        ],
    )?;
    let rev = tx.last_insert_rowid();
    seal(tx, rev)?;
    tx.execute(
        "UPDATE entries SET rev = ?2 WHERE id = ?1",
        params![id, rev],
    )?;
    tx.execute("DELETE FROM entries_fts WHERE rowid = ?1", [id])?;
    tx.execute(
        "INSERT INTO entries_fts (rowid, key, content) SELECT id, key, content FROM entries WHERE id = ?1",
        [id],
    )?;
    Ok(rev)
}

/// Before entry `id` leaves `entries`: its last state as a sealed
/// `tombstoned` revision `op` (by `session`, at `at`), and its FTS row
/// dropped.
fn before_delete(tx: &Transaction<'_>, id: i64, op: &str, at: i64, session: &str) -> Result<()> {
    let n = tx.execute(
        "INSERT INTO revisions (entry_id, op, kind, key, content, content_hash, status, source, agent, \
         session, confidence, state, scope, evidence, at) \
         SELECT id, ?2, kind, key, content, content_hash, status, source, agent, ?4, confidence, \
         'tombstoned', scope, evidence, ?3 FROM entries WHERE id = ?1",
        params![id, op, at, session],
    )?;
    if n == 1 {
        seal(tx, tx.last_insert_rowid())?;
    }
    tx.execute("DELETE FROM entries_fts WHERE rowid = ?1", [id])?;
    Ok(())
}

/// The columns a revision's chain link covers: all of them but `chain` and
/// `note`. The note is untrusted provenance that nothing decides on (an
/// imported line's own metadata), and leaving it out keeps every row's
/// encoding what it was before v6 added the column.
const CHAIN_COLUMNS: &str = "rev, entry_id, op, kind, key, content, content_hash, status, source, \
     agent, session, confidence, state, scope, evidence, at";

/// A row's columns as bytes, each tagged by type and length-prefixed, so no
/// two different rows encode alike.
fn chain_bytes(r: &rusqlite::Row<'_>) -> rusqlite::Result<Vec<u8>> {
    use rusqlite::types::ValueRef;
    let mut out = Vec::new();
    for i in 0..16 {
        let (tag, field): (u8, Vec<u8>) = match r.get_ref(i)? {
            ValueRef::Null => (0, Vec::new()),
            ValueRef::Integer(n) => (1, n.to_le_bytes().to_vec()),
            ValueRef::Real(f) => (2, f.to_bits().to_le_bytes().to_vec()),
            ValueRef::Text(t) => (3, t.to_vec()),
            ValueRef::Blob(b) => (4, b.to_vec()),
        };
        out.push(tag);
        out.extend_from_slice(&(field.len() as u64).to_le_bytes());
        out.extend_from_slice(&field);
    }
    Ok(out)
}

fn chain_link(prev: &[u8], row: &[u8]) -> [u8; 32] {
    let mut h = blake3::Hasher::new();
    h.update(prev);
    h.update(row);
    // Not `h.finalize()`: with `sha2::Digest` in scope and blake3's
    // `traits-preview` feature on, that resolves to `Digest::finalize`.
    *blake3::Hasher::finalize(&h).as_bytes()
}

/// Seal revision `rev` onto the revision before it (32 zero bytes for the
/// first). The chain is unkeyed: it catches rows changed, inserted or
/// deleted by anything but this store (a hand edit, a `sqlite3` one-liner),
/// not a tool that recomputes it.
fn seal(conn: &Connection, rev: i64) -> Result<()> {
    let prev: Vec<u8> = conn
        .query_row(
            "SELECT chain FROM revisions WHERE rev < ?1 ORDER BY rev DESC LIMIT 1",
            [rev],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or_else(|| vec![0; 32]);
    let row = conn.query_row(
        &format!("SELECT {CHAIN_COLUMNS} FROM revisions WHERE rev = ?1"),
        [rev],
        chain_bytes,
    )?;
    conn.execute(
        "UPDATE revisions SET chain = ?2 WHERE rev = ?1",
        params![rev, &chain_link(&prev, &row)[..]],
    )?;
    Ok(())
}

/// The first revision whose chain link doesn't match its row and the link
/// before it, or `None` when the whole history verifies. One pass.
fn first_bad(conn: &Connection) -> Result<Option<i64>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {CHAIN_COLUMNS}, chain FROM revisions ORDER BY rev"
    ))?;
    let mut rows = stmt.query([])?;
    let mut prev = vec![0u8; 32];
    while let Some(r) = rows.next()? {
        let stored: Vec<u8> = r.get(16)?;
        if chain_link(&prev, &chain_bytes(r)?)[..] != stored[..] {
            return Ok(Some(r.get(0)?));
        }
        prev = stored;
    }
    Ok(None)
}

/// Re-seal every revision from `rev` on, in order: the migration's
/// baselines, purge (which removes revisions on purpose), and the user's
/// acceptance of an outside edit.
pub(crate) fn reseal_from(conn: &Connection, rev: i64) -> Result<()> {
    let revs: Vec<i64> = conn
        .prepare("SELECT rev FROM revisions WHERE rev >= ?1 ORDER BY rev")?
        .query_map([rev], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for r in revs {
        seal(conn, r)?;
    }
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
fn retract_events_of(tx: &Transaction<'_>, e: &Entry) -> Result<Vec<i64>> {
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
    seqs.sort_unstable();
    seqs.dedup();
    for seq in &seqs {
        tx.execute(
            "INSERT OR IGNORE INTO retracted_events (seq) VALUES (?1)",
            [seq],
        )?;
    }
    Ok(seqs)
}

/// The newest live event that carried `e`'s words: for a file change, the
/// newest on its path; else the newest of its kind whose text is the same
/// memory (by normalised hash). What a rebuilt row's `seq` is.
fn logged_seq(tx: &Transaction<'_>, e: &Entry) -> Result<Option<i64>> {
    let mut stmt = tx.prepare(&format!(
        "SELECT seq, key, payload FROM events {LIVE_EVENTS} AND kind = ?1 ORDER BY seq DESC"
    ))?;
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
        let carried = if e.kind == EntryKind::FileChanged {
            payload.get("path").and_then(|v| v.as_str()).unwrap_or(&key) == e.key
        } else {
            payload
                .get(content_field(e.kind))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .is_some_and(|t| !t.is_empty() && content_hash(t) == e.content_hash)
        };
        if carried {
            return Ok(Some(seq));
        }
    }
    Ok(None)
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
        rev: r.get("rev")?,
        state: State::parse(&r.get::<_, String>("state")?),
        scope: r.get("scope")?,
        evidence: r.get("evidence")?,
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

/// Scrub a text through [`clean`] and `atlas_redact` — the one scrubber every
/// record write and every text bound for a model uses. Returned unchanged
/// when there was nothing to scrub.
pub fn redact(s: &str) -> String {
    redact_text(s)
}

fn redact_text(s: &str) -> String {
    let cleaned = clean(s);
    let r = atlas_redact::redact(&cleaned);
    if r.changed() {
        r.text
    } else {
        cleaned
    }
}

/// `s` without the characters that hide text from a person while a model
/// still reads it: zero-width and bidi controls (U+200B–U+200F,
/// U+202A–U+202E, U+2060–U+2064, U+2066–U+2069, U+FEFF) and the Unicode tag
/// block (U+E0000–U+E007F). An `<atlas-memory` tag is defanged to
/// `‹atlas-memory`, so recalled text can't pose as a harness block.
pub fn clean(s: &str) -> String {
    let hidden = |c: char| {
        matches!(
            c,
            '\u{200B}'..='\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2060}'..='\u{2064}'
                | '\u{2066}'..='\u{2069}'
                | '\u{FEFF}'
                | '\u{E0000}'..='\u{E007F}'
        )
    };
    if !s.chars().any(hidden) && !s.contains("<atlas-memory") && !s.contains("</atlas-memory") {
        return s.to_string();
    }
    s.chars()
        .filter(|c| !hidden(*c))
        .collect::<String>()
        .replace("</atlas-memory", "‹/atlas-memory")
        .replace("<atlas-memory", "‹atlas-memory")
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

#[cfg(test)]
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

/// Cache `v` as `model`'s embedding of `text` (f16, keyed by model + text).
fn put_cache(tx: &Transaction<'_>, model: &str, text: &str, v: &[f32]) -> Result<()> {
    tx.execute(
        "INSERT OR REPLACE INTO embed_cache (key, model, dims, vec) VALUES (?1, ?2, ?3, ?4)",
        params![
            &atlas_retrieval::codec::cache_key(model, text)[..],
            model,
            v.len() as i64,
            atlas_retrieval::codec::to_f16(v)
        ],
    )?;
    Ok(())
}

/// `model`'s cached embedding of `text`, if any.
fn cached(conn: &Connection, model: &str, text: &str) -> Result<Option<Vec<f32>>> {
    Ok(conn
        .prepare_cached("SELECT vec FROM embed_cache WHERE key = ?1")?
        .query_row([&atlas_retrieval::codec::cache_key(model, text)[..]], |r| {
            r.get::<_, Vec<u8>>(0)
        })
        .optional()?
        .map(|b| atlas_retrieval::codec::from_f16(&b)))
}

/// An HNSW over the cached `model` vectors of every live entry's current
/// text, keyed by entry id. Built from the cache, so it can never hold a
/// vector for text the entry no longer has.
fn build_index(conn: &Connection, model: &str, dim: usize) -> Result<VectorIndex> {
    let hnsw = HnswStore::open(dim)?;
    let mut entries = conn.prepare("SELECT id, content FROM entries")?;
    for row in entries.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
        let (id, content) = row?;
        if let Some(v) = cached(conn, model, &content)? {
            if v.len() == dim {
                hnsw.add(id as u64, &v)?;
            }
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
/// Fold one event into the entries it affects. Returns whether it rewrote or
/// removed an existing entry (so an in-memory vector index may be stale).
fn fold(tx: &Transaction<'_>, ev: &EventRow) -> Result<bool> {
    let text = || payload_str(ev, "text").unwrap_or("").trim().to_string();
    match EventKind::parse(&ev.kind) {
        EventKind::PlanSet => {
            let text = payload_str(ev, "text").unwrap_or("").to_string();
            let status = payload_str(ev, "status").unwrap_or("active").to_string();
            let plans = ids(tx, "SELECT id FROM entries WHERE kind = 'plan'", params![])?;
            if status == "abandoned" || status == "done" {
                // A finished or abandoned plan clears the active plan.
                for id in &plans {
                    before_delete(tx, *id, "fold", ev.ts, &ev.session_id)?;
                }
                tx.execute("DELETE FROM entries WHERE kind = 'plan'", [])?;
                return Ok(!plans.is_empty());
            } else if !text.is_empty() {
                return write_folded(tx, ev, EntryKind::Plan, "plan", &text, &status, &plans);
            }
        }
        EventKind::Decision => {
            let text = text();
            if text.is_empty() {
                return Ok(false);
            }
            // Same non-empty key supersedes; keyless dedups by normalised text.
            let matches = ids(
                tx,
                "SELECT id FROM entries WHERE kind = 'decision' \
                 AND ((?1 <> '' AND key = ?1) OR content_hash = ?2)",
                params![ev.key, content_hash(&text)],
            )?;
            return write_folded(tx, ev, EntryKind::Decision, &ev.key, &text, "", &matches);
        }
        EventKind::FileChanged => {
            let path = payload_str(ev, "path").unwrap_or(&ev.key).to_string();
            if path.is_empty() {
                return Ok(false);
            }
            let summary = payload_str(ev, "summary").unwrap_or("").to_string();
            let matches = ids(
                tx,
                "SELECT id FROM entries WHERE kind = 'file_changed' AND key = ?1",
                params![path],
            )?;
            return write_folded(
                tx,
                ev,
                EntryKind::FileChanged,
                &path,
                &summary,
                "",
                &matches,
            );
        }
        kind @ (EventKind::Fact | EventKind::Preference) => {
            let text = text();
            if text.is_empty() {
                return Ok(false);
            }
            let entry_kind = if kind == EventKind::Fact {
                EntryKind::Fact
            } else {
                EntryKind::Preference
            };
            let matches = ids(
                tx,
                "SELECT id FROM entries WHERE kind = ?1 AND content_hash = ?2",
                params![entry_kind.as_str(), content_hash(&text)],
            )?;
            return write_folded(tx, ev, entry_kind, &ev.key, &text, "", &matches);
        }
        kind @ (EventKind::Failure | EventKind::Architecture) => {
            let text = text();
            if text.is_empty() {
                return Ok(false);
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
            return write_folded(tx, ev, entry_kind, &ev.key, &text, "", &matches);
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
    Ok(false)
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
) -> Result<bool> {
    let hash = content_hash(content);
    if let Some(&keep) = matches.iter().min() {
        for id in matches.iter().filter(|id| **id != keep) {
            before_delete(tx, *id, "fold", ev.ts, &ev.session_id)?;
            tx.execute("DELETE FROM entries WHERE id = ?1", [id])?;
        }
        tx.execute(
            "UPDATE entries SET key = ?2, content = ?3, status = ?4, source = ?5, agent = ?5, session = ?6, \
             confidence = 1.0, updated_at = ?7, content_hash = ?8, seq = ?9 WHERE id = ?1",
            params![keep, key, content, status, ev.agent, ev.session_id, ev.ts, hash, ev.seq as i64],
        )?;
        after_write(tx, keep, "fold", false, None)?;
        Ok(true)
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
        after_write(tx, tx.last_insert_rowid(), "fold", false, None)?;
        Ok(false)
    }
}

/// Key-or-hash upsert without near-duplicate matching or logging (the legacy
/// memdir import).
fn upsert_tx(tx: &Transaction<'_>, e: NewEntry) -> Result<i64> {
    let e = redacted(e);
    let id = match find_identity(tx, &e)? {
        Some(found) => write_identity(tx, &e, found)?.0,
        None => insert_entry(tx, &e)?,
    };
    after_write(tx, id, "import", false, Some(By::of(&e)))?;
    Ok(id)
}

/// `e` as it may land: key and trimmed content scrubbed by `atlas_redact`.
fn redacted(e: NewEntry) -> NewEntry {
    NewEntry {
        key: redact_text(&e.key),
        content: redact_text(e.content.trim()).trim().to_string(),
        ..e
    }
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

    #[test]
    fn a_path_that_climbs_out_of_the_root_is_not_in_it() {
        let dirs = [PathBuf::from("/work/repo")];
        assert!(path_in_dirs("/work/repo/src/a.rs", &dirs));
        assert!(path_in_dirs("/work/repo/./src/../src/a.rs", &dirs));
        assert!(!path_in_dirs("/work/repo/../other/x.rs", &dirs));
        assert!(!path_in_dirs("/work/repo/src/../../other/x.rs", &dirs));
        assert!(path_in_dirs("src/../lib.rs", &dirs));
        assert!(!path_in_dirs("src/../../lib.rs", &dirs));
        // A root spelled with a `..` of its own still contains its files.
        assert!(path_in_dirs(
            "/work/repo/a.rs",
            &[PathBuf::from("/work/x/../repo")]
        ));
    }

    #[test]
    fn a_home_relative_path_is_read_from_home() {
        let Some(home) = home_dir() else {
            return;
        };
        let inside = home.join("atlas-scope-test-repo");
        assert!(path_in_dirs(
            "~/atlas-scope-test-repo/src/a.rs",
            std::slice::from_ref(&inside)
        ));
        let dirs = std::slice::from_ref(&inside);
        assert!(!path_in_dirs("~/.claude/plans/plan.md", dirs));
        assert!(!path_in_dirs("~/atlas-scope-test-repo/../x", dirs));
        assert!(!path_in_dirs(
            "~someone/atlas-scope-test-repo/a.rs",
            &[inside]
        ));
    }

    /// A linked worktree as the scope root still sees the main worktree and
    /// the other linked ones.
    #[test]
    fn a_linked_worktree_root_finds_its_siblings() {
        let base = tempfile::TempDir::new().unwrap();
        let main = base.path().join("main");
        let (wt_a, wt_b) = (base.path().join("wt-a"), base.path().join("wt-b"));
        for (name, wt) in [("wt-a", &wt_a), ("wt-b", &wt_b)] {
            let admin = main.join(".git").join("worktrees").join(name);
            std::fs::create_dir_all(&admin).unwrap();
            std::fs::create_dir_all(wt).unwrap();
            std::fs::write(
                admin.join("gitdir"),
                format!("{}\n", wt.join(".git").display()),
            )
            .unwrap();
            std::fs::write(admin.join("commondir"), "../..\n").unwrap();
            std::fs::write(wt.join(".git"), format!("gitdir: {}\n", admin.display())).unwrap();
        }
        let store = RecordStore::open(&wt_a).unwrap();
        let dirs = store.scope_dirs();
        for dir in [&main, &wt_a, &wt_b] {
            assert!(dirs.contains(dir), "{} in {dirs:?}", dir.display());
        }
        assert!(store.in_scope(&wt_b.join("src/x.rs").to_string_lossy()));
        assert!(store.in_scope(&main.join("src/x.rs").to_string_lossy()));
        assert!(!store.in_scope(&base.path().join("other/x.rs").to_string_lossy()));
    }

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
    fn invisible_and_bidi_characters_are_stripped_on_write() {
        let root = temp_root("clean");
        let store = open_scope(&root).unwrap();
        let sneaky = "Deploys go through Fly\u{200B}\u{E0041}\u{E0042}\u{202E}";
        let e = store
            .remember(tool_write(EntryKind::Fact, "", sneaky, 1), 1)
            .unwrap()
            .entry;
        assert_eq!(e.content, "Deploys go through Fly");
        assert_eq!(
            clean("a <atlas-memory>x</atlas-memory>"),
            "a ‹atlas-memory>x‹/atlas-memory>"
        );
        let _ = std::fs::remove_dir_all(&root);
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

        fn model_id(&self) -> Option<String> {
            Some("table-3".into())
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
            store.forget(first.entry.id, 1, "").unwrap().map(|e| e.id),
            Some(first.entry.id)
        );
        assert_eq!(store.forget(first.entry.id, 1, "").unwrap(), None);
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

        store.forget(entry.id, 1, "").unwrap().expect("forgotten");
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
        store.forget(a.id, 1, "").unwrap();
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
        store.forget(fact.id, 1, "").unwrap();
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

    // ── v5: revisions, CAS, vectors by content, search ──────────────────────

    const USER: &str = "user";

    fn revisions_of(store: &RecordStore, id: i64) -> Vec<(String, String)> {
        store
            .conn()
            .prepare("SELECT op, content FROM revisions WHERE entry_id = ?1 ORDER BY rev")
            .unwrap()
            .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn v4_database(root: &Path, rows_sql: &str) {
        let dir = memory_dir(root);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(dir.join(DB_FILE)).unwrap();
        migrate_v1(&conn).unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE entry_vectors (id INTEGER PRIMARY KEY, model TEXT NOT NULL, vec BLOB NOT NULL);
             CREATE TABLE retracted_events (seq INTEGER PRIMARY KEY);
             CREATE TABLE forgotten (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, session TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL);
             {rows_sql}
             PRAGMA user_version = 4;"
        ))
        .unwrap();
    }

    /// A v4 database migrates in place: every live entry gets a sealed
    /// baseline revision and a state from its confidence, the FTS index is
    /// filled, and stored vectors move into the cache under (model, text).
    #[test]
    fn a_v4_record_migrates_to_v5_keeping_everything() {
        let root = temp_root("migrate-v5");
        v4_database(
            &root,
            "INSERT INTO entries (kind, key, content, source, confidence, created_at, updated_at, content_hash)
               VALUES ('fact', '', 'JWTs are signed with RS256', 'codex', 1.0, 1, 1, 'h1'),
                      ('fact', '', 'always force-push', 'capture', 0.3, 2, 2, 'h2');",
        );
        {
            let dir = memory_dir(&root);
            let conn = Connection::open(dir.join(DB_FILE)).unwrap();
            conn.execute(
                "INSERT INTO entry_vectors (id, model, vec) VALUES (1, 'table-3', ?1)",
                [encode_vec(&[1.0, 0.0, 0.0])],
            )
            .unwrap();
        }
        let store = RecordStore::open(&root).unwrap();
        {
            let conn = store.conn();
            let v: i64 = conn
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
            assert_eq!(v, SCHEMA_VERSION);
            let revs: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM revisions WHERE op = 'baseline'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(revs, 2);
            let states: Vec<String> = conn
                .prepare("SELECT state FROM entries ORDER BY id")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            assert_eq!(states, ["active", "candidate"]);
            let fts: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM entries_fts WHERE entries_fts MATCH 'rs256'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(fts, 1);
            let gone: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name = 'entry_vectors'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(gone, 0);
        }
        assert_eq!(store.verify_chain().unwrap(), None, "baselines are sealed");
        store.set_embedder(Some(table()));
        assert!(
            store.vector_of(1).is_some(),
            "the v4 vector is in the cache under (model, text)"
        );
        drop(store);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn switching_models_back_reuses_the_cache() {
        let root = temp_root("switch-back");
        let store = open_scope(&root).unwrap();
        store.set_embedder(Some(table()));
        let e = store
            .remember(
                tool_write(EntryKind::Fact, "", "JWTs are signed with RS256", 1),
                1,
            )
            .unwrap();
        assert!(store.vector_of(e.entry.id).is_some());
        struct Other;
        impl Embedder for Other {
            fn embed(&self, _: &str) -> Option<Embedding> {
                None
            }
            fn model_id(&self) -> Option<String> {
                Some("other".into())
            }
        }
        store.set_embedder(Some(Arc::new(Other)));
        assert!(store.vector_of(e.entry.id).is_none());
        store.set_embedder(Some(table()));
        assert!(
            store.vector_of(e.entry.id).is_some(),
            "found again without re-embedding"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sync_vectors_backfills_entries_written_without_a_model() {
        let root = temp_root("backfill");
        let store = open_scope(&root).unwrap();
        let e = store
            .remember(
                tool_write(EntryKind::Fact, "", "Deploys go through Fly", 1),
                1,
            )
            .unwrap();
        store.set_embedder(Some(table()));
        assert!(store.vector_of(e.entry.id).is_none());
        assert_eq!(store.sync_vectors().unwrap(), 1);
        assert!(store.vector_of(e.entry.id).is_some());
        assert_eq!(store.sync_vectors().unwrap(), 0, "idempotent");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A keyed replace whose new text cannot be embedded has no vector: its
    /// id never carries the old text's meaning (folded in from M0, D5).
    #[test]
    fn a_replace_without_a_vector_drops_the_old_one() {
        let root = temp_root("stale-vector");
        let store = open_scope(&root).unwrap();
        store.set_embedder(Some(table()));
        let first = store
            .remember(
                tool_write(EntryKind::Decision, "deploy", "Deploys go through Fly", 1),
                1,
            )
            .unwrap();
        assert!(store.vector_of(first.entry.id).is_some());
        let second = store
            .remember(
                tool_write(
                    EntryKind::Decision,
                    "deploy",
                    "Deploys go through Render",
                    2,
                ),
                2,
            )
            .unwrap();
        assert_eq!(second.outcome, WriteOutcome::Replaced);
        assert!(
            store.vector_of(first.entry.id).is_none(),
            "the old meaning is gone"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A fold that collapses several matching entries into one removes the
    /// others, and none of them keeps a vector in the index (M0, D6).
    #[test]
    fn a_fold_that_collapses_matches_leaves_no_orphan_vectors() {
        let root = temp_root("orphan-vector");
        let store = open_scope(&root).unwrap();
        store.set_embedder(Some(table()));
        let keyed = store
            .upsert(tool_write(
                EntryKind::Decision,
                "deploy",
                "Deploys go through Fly",
                1,
            ))
            .unwrap();
        let keyless = store
            .upsert(tool_write(
                EntryKind::Decision,
                "",
                "JWTs are signed with RS256",
                2,
            ))
            .unwrap();
        // Same key as one, same text as the other: both match, one survives.
        store
            .append_event(
                ev(
                    EventKind::Decision,
                    "deploy",
                    serde_json::json!({"text": "JWTs are signed with RS256"}),
                ),
                3,
            )
            .unwrap();
        let survivor = keyed.id.min(keyless.id);
        let removed = keyed.id.max(keyless.id);
        assert!(!store.exists(removed).unwrap());
        assert!(
            store.vector_of(removed).is_none(),
            "no vector outlives its entry"
        );
        assert!(store.exists(survivor).unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn every_write_leaves_a_revision() {
        let root = temp_root("revisions");
        let store = open_scope(&root).unwrap();
        let a = store
            .remember(
                tool_write(EntryKind::Decision, "deploy", "Deploys go through Fly", 1),
                1,
            )
            .unwrap();
        store
            .remember(
                tool_write(
                    EntryKind::Decision,
                    "deploy",
                    "Deploys go through Render",
                    2,
                ),
                2,
            )
            .unwrap();
        let other = NewEntry {
            source: "codex".into(),
            agent: "codex".into(),
            session_id: "s2".into(),
            ..tool_write(
                EntryKind::Decision,
                "deploy",
                "Deploys go through Render",
                3,
            )
        };
        store.remember(other, 3).unwrap(); // a restatement: merge
        store
            .edit(a.entry.id, "Deploys go through Render (eu)", USER, 4)
            .unwrap();
        store.forget(a.entry.id, 5, "s9").unwrap();
        let ops: Vec<String> = revisions_of(&store, a.entry.id)
            .into_iter()
            .map(|(op, _)| op)
            .collect();
        assert_eq!(ops, ["insert", "replace", "merge", "edit", "forget"]);
        assert_eq!(
            revisions_of(&store, a.entry.id)[0].1,
            "Deploys go through Fly",
            "the replaced wording survives"
        );
        let hits: i64 = store
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM entries_fts WHERE entries_fts MATCH 'render'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 0, "FTS follows the live row");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn entries_can_be_rebuilt_from_revisions() {
        let root = temp_root("rebuild");
        let store = open_scope(&root).unwrap();
        store
            .remember(tool_write(EntryKind::Fact, "", "The API speaks JSON", 1), 1)
            .unwrap();
        let gone = store
            .remember(tool_write(EntryKind::Fact, "", "Staging is on Fly", 2), 2)
            .unwrap();
        store.forget(gone.entry.id, 3, "").unwrap();
        store
            .append_event(
                ev(
                    EventKind::Decision,
                    "db",
                    serde_json::json!({"text": "Use Postgres"}),
                ),
                4,
            )
            .unwrap();
        let shape = |v: Vec<Entry>| {
            v.into_iter()
                .map(|e| (e.id, e.kind, e.key, e.content, e.rev, e.state, e.confidence))
                .collect::<Vec<_>>()
        };
        let before = shape(store.list(EntryKind::Fact, 50, Origin::Any).unwrap());
        store.conn().execute("DELETE FROM entries", []).unwrap();
        assert_eq!(store.rebuild_entries_from_revisions().unwrap(), 2);
        assert_eq!(
            shape(store.list(EntryKind::Fact, 50, Origin::Any).unwrap()),
            before
        );
        assert_eq!(
            store
                .list(EntryKind::Decision, 50, Origin::Any)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .list(EntryKind::Decision, 50, Origin::EventLog)
                .unwrap()
                .len(),
            1,
            "the state view keeps its entries"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_edit_outside_the_store_breaks_the_chain() {
        let root = temp_root("chain");
        let store = open_scope(&root).unwrap();
        let a = store
            .remember(
                tool_write(EntryKind::Fact, "", "Deploys go through Fly", 1),
                1,
            )
            .unwrap();
        store
            .edit(a.entry.id, "Deploys go through Fly, never by hand", USER, 2)
            .unwrap();
        store
            .remember(tool_write(EntryKind::Fact, "", "The API speaks JSON", 3), 3)
            .unwrap();
        assert_eq!(
            store.verify_chain().unwrap(),
            None,
            "every write through the store seals"
        );

        let first: i64 = store
            .conn()
            .query_row("SELECT MIN(rev) FROM revisions", [], |r| r.get(0))
            .unwrap();
        let set = |text: &str| {
            store
                .conn()
                .execute(
                    "UPDATE revisions SET content = ?2 WHERE rev = ?1",
                    params![first, text],
                )
                .unwrap();
        };
        set("Deploys go through Heroku");
        assert_eq!(
            store.verify_chain().unwrap(),
            Some(first),
            "a rewritten revision"
        );
        set("Deploys go through Fly");
        assert_eq!(
            store.verify_chain().unwrap(),
            None,
            "the original text verifies again"
        );

        store
            .conn()
            .execute("DELETE FROM revisions WHERE rev = ?1", [first + 1])
            .unwrap();
        assert_eq!(
            store.verify_chain().unwrap(),
            Some(first + 2),
            "a deleted revision breaks the next link"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_keyed_replace_needs_the_current_revision_or_the_same_writer() {
        let root = temp_root("cas");
        let store = open_scope(&root).unwrap();
        let mine = store
            .remember(tool_write(EntryKind::Decision, "db", "Use Postgres", 1), 1)
            .unwrap();
        // Same writer (source "claude", same session): its own update needs no revision.
        store
            .remember_guarded(
                tool_write(EntryKind::Decision, "db", "Use Postgres 16", 2),
                2,
                None,
                &[],
            )
            .unwrap();
        // The same agent in a parallel session (another worktree) is another writer.
        let twin = NewEntry {
            session_id: "s-twin".into(),
            ..tool_write(EntryKind::Decision, "db", "Use MySQL", 2)
        };
        let twin_err = store.remember_guarded(twin, 2, None, &[]).unwrap_err();
        assert!(
            twin_err.downcast_ref::<Conflict>().is_some(),
            "a parallel session of the same agent must not clobber"
        );
        let other = |c: &str, at| NewEntry {
            source: "codex".into(),
            agent: "codex".into(),
            ..tool_write(EntryKind::Decision, "db", c, at)
        };
        let err = store
            .remember_guarded(other("Use SQLite", 3), 3, None, &[])
            .unwrap_err();
        let conflict = err.downcast_ref::<Conflict>().expect("a conflict").clone();
        assert_eq!(conflict.content, "Use Postgres 16");
        let stale = store
            .remember_guarded(other("Use SQLite", 4), 4, Some(mine.entry.rev), &[])
            .unwrap_err();
        assert!(
            stale.downcast_ref::<Conflict>().is_some(),
            "an old revision is stale"
        );
        let ok = store
            .remember_guarded(other("Use SQLite", 5), 5, Some(conflict.current_rev), &[])
            .unwrap();
        assert_eq!(ok.outcome, WriteOutcome::Replaced);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sources_follow_every_writer_oldest_first() {
        let root = temp_root("sources");
        let store = open_scope(&root).unwrap();
        let a = store
            .remember(
                tool_write(EntryKind::Fact, "", "CI runs on GitHub Actions", 1),
                1,
            )
            .unwrap()
            .entry;
        let codex = NewEntry {
            source: "codex".into(),
            agent: "codex".into(),
            session_id: "s2".into(),
            ..tool_write(EntryKind::Fact, "", "CI runs on GitHub Actions", 2)
        };
        store.remember(codex, 2).unwrap(); // a restatement from another session
        let got = store.sources_for(&[a.id]).unwrap().remove(&a.id).unwrap();
        let uris: Vec<String> = got.iter().map(source_uri).collect();
        assert_eq!(uris, ["atlas-session:claude/s1", "atlas-session:codex/s2"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_preference_is_its_own_kind_and_round_trips() {
        let root = temp_root("preference");
        let store = open_scope(&root).unwrap();
        store
            .remember(
                tool_write(EntryKind::Preference, "", "Use bun, not npm", 1),
                1,
            )
            .unwrap();
        let prefs = store.list(EntryKind::Preference, 10, Origin::Any).unwrap();
        assert_eq!(prefs.len(), 1);
        assert_eq!(prefs[0].content, "Use bun, not npm");
        assert_eq!(EntryKind::parse("preference"), Some(EntryKind::Preference));
        assert!(EntryKind::Preference.is_durable());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn purge_removes_the_text_from_every_table() {
        let root = temp_root("purge");
        let store = open_scope(&root).unwrap();
        let secret = "the staging password is hunter2-staging";
        store.set_embedder(Some(Arc::new(TableEmbedder(vec![(
            secret,
            vec![0.0, 1.0, 0.0],
        )]))));
        let e = store
            .remember(tool_write(EntryKind::Fact, "", secret, 1), 1)
            .unwrap();
        store
            .edit(e.entry.id, "staging credentials live in 1Password", USER, 2)
            .unwrap();
        assert!(
            store.purge(e.entry.id).is_err(),
            "only a forgotten entry can be purged"
        );
        // A dream dropped a rewrite that repeats it, and a snapshot holds it.
        store
            .record_dream(
                2,
                "m",
                2,
                &[],
                &[(
                    crate::dream::DreamOp::Rewrite {
                        id: e.entry.id,
                        revision: 0,
                        content: secret.into(),
                        why: String::new(),
                    },
                    "stale revision",
                )],
                &Default::default(),
            )
            .unwrap();
        assert!(store.snapshot_if_due(2).unwrap());
        store.forget(e.entry.id, 3, "").unwrap();
        assert!(store.purge(e.entry.id).unwrap());
        {
            let conn = store.conn();
            let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
            assert_eq!(
                count("SELECT COUNT(*) FROM revisions WHERE content LIKE '%hunter2%'"),
                0,
                "revisions"
            );
            assert_eq!(
                count("SELECT COUNT(*) FROM events WHERE payload LIKE '%hunter2%'"),
                0,
                "events"
            );
            assert_eq!(
                count("SELECT COUNT(*) FROM entries_fts WHERE entries_fts MATCH 'hunter2'"),
                0,
                "fts"
            );
            assert_eq!(
                count(
                    "SELECT COUNT(*) FROM entries_fts_data \
                     WHERE instr(block, CAST('hunter2' AS BLOB)) > 0"
                ),
                0,
                "fts segments"
            );
            assert_eq!(
                count("SELECT COUNT(*) FROM dreams WHERE dropped LIKE '%hunter2%'"),
                0,
                "a dream's dropped ops"
            );
            let secret_key = atlas_retrieval::codec::cache_key("table-3", secret);
            let cached: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM embed_cache WHERE key = ?1",
                    [&secret_key[..]],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(cached, 0, "the secret's cached vector");
        }
        assert!(
            !memory_dir(store.root())
                .join(crate::health::SNAPSHOT_FILE)
                .exists(),
            "the snapshot that held it"
        );
        let h = store.history(e.entry.id).unwrap();
        assert_eq!(
            h.iter()
                .map(|r| (r.op.as_str(), r.content.as_str()))
                .collect::<Vec<_>>(),
            vec![("purge", "")]
        );
        assert_eq!(
            store.verify_chain().unwrap(),
            None,
            "purge re-seals the chain"
        );
        assert!(
            !store.purge(e.entry.id).unwrap(),
            "a second purge has nothing left to erase"
        );
        assert!(store
            .forgotten_since(0, "x")
            .unwrap()
            .iter()
            .any(|(id, _)| *id == e.entry.id));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_clear_and_purge_delete_revisions() {
        let src = include_str!("record.rs");
        let n = src.matches("DELETE FROM revisions").count();
        // clear(), purge(), the two occurrences in this test's own source, and
        // the deliberate tamper in an_edit_outside_the_store_breaks_the_chain.
        assert_eq!(
            n, 5,
            "a new DELETE FROM revisions needs a review: revisions are canonical"
        );
    }

    #[test]
    fn bm25_finds_an_exact_identifier_without_a_model() {
        let root = temp_root("bm25");
        let store = open_scope(&root).unwrap();
        store
            .remember(
                tool_write(
                    EntryKind::Fact,
                    "",
                    "Set RUST_LOG=atlas=debug to trace the indexer",
                    1,
                ),
                1,
            )
            .unwrap();
        store
            .remember(tool_write(EntryKind::Fact, "", "Logs rotate daily", 2), 2)
            .unwrap();
        let hits = store.search_explained("RUST_LOG", &[], 5, 10).unwrap();
        assert!(hits[0].entry.content.contains("RUST_LOG"), "{hits:?}");
        assert_eq!(hits[0].why, vec![("bm25", 1)]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_word_finds_its_other_forms() {
        let root = temp_root("bm25-stem");
        let store = open_scope(&root).unwrap();
        store
            .remember(
                tool_write(EntryKind::Decision, "", "Sign JWTs with EdDSA", 1),
                1,
            )
            .unwrap();
        let hits = store.search_explained("JWT signing", &[], 5, 10).unwrap();
        assert_eq!(
            hits.len(),
            1,
            "jwt finds JWTs, signing finds Sign: {hits:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn short_words_are_left_out_when_the_query_has_longer_ones() {
        assert_eq!(
            fts_query("how is JWT signing").as_deref(),
            Some("\"how\" OR \"jwt\" OR \"signing\"")
        );
        assert_eq!(fts_query("CI").as_deref(), Some("\"ci\""));
        assert_eq!(fts_query("!!"), None);
    }

    #[test]
    fn meaning_and_words_fuse_and_candidates_rank_below_trusted() {
        let root = temp_root("hybrid");
        let store = open_scope(&root).unwrap();
        store.set_embedder(Some(table()));
        // Both keyed, so the 0.96-cosine pair stays two rows (keyed entries never near-dup merge).
        store
            .remember(
                tool_write(EntryKind::Fact, "trusted", "JWTs are signed with RS256", 1),
                1,
            )
            .unwrap();
        store
            .upsert(NewEntry {
                confidence: CANDIDATE_CONFIDENCE,
                source: CAPTURE_SOURCE.into(),
                ..tool_write(EntryKind::Fact, "cand", "JWT signing uses RS256", 2)
            })
            .unwrap();
        let hits = store
            .search_explained("JWTs are signed with RS256", &[], 5, 10)
            .unwrap();
        assert_eq!(
            hits[0].entry.content, "JWTs are signed with RS256",
            "trusted first"
        );
        assert!(hits[0].why.iter().any(|(leg, _)| *leg == "dense"));
        assert!(hits[0].why.iter().any(|(leg, _)| *leg == "bm25"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_retried_write_is_idempotent() {
        let root = temp_root("retry");
        let store = open_scope(&root).unwrap();
        let first = store
            .remember(
                tool_write(EntryKind::Fact, "", "CI runs on GitHub Actions", 1_000),
                1_000,
            )
            .unwrap();
        for i in 1..10 {
            let again = store
                .remember(
                    tool_write(EntryKind::Fact, "", "CI runs on GitHub Actions", 1_000 + i),
                    1_000 + i,
                )
                .unwrap();
            assert_eq!(again.outcome, WriteOutcome::Merged);
        }
        let e = store.get(first.entry.id, 2_000).unwrap().unwrap();
        assert_eq!(e.uses, 0, "a retry is not a restatement");
        assert_eq!(store.history(e.id).unwrap().len(), 1, "one revision");
        // The same words from another writer still count.
        let other = NewEntry {
            source: "codex".into(),
            agent: "codex".into(),
            session_id: "s2".into(),
            ..tool_write(EntryKind::Fact, "", "CI runs on GitHub Actions", 1_100)
        };
        store.remember(other, 1_100).unwrap();
        assert_eq!(store.get(e.id, 2_001).unwrap().unwrap().uses, 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn evidence_rides_with_the_revision_and_merges_union() {
        use crate::citation::Citation;
        let root = temp_root("evidence");
        let store = open_scope(&root).unwrap();
        let c1 = Citation {
            path: "src/a.rs".into(),
            start_line: 1,
            end_line: 2,
            symbol: None,
            hash: "h1".into(),
        };
        let c2 = Citation {
            path: "src/b.rs".into(),
            start_line: 3,
            end_line: 3,
            symbol: Some("b::f".into()),
            hash: "h2".into(),
        };
        let e = store
            .remember_guarded(
                tool_write(EntryKind::Fact, "", "Tokens live 15 minutes", 1),
                1,
                None,
                std::slice::from_ref(&c1),
            )
            .unwrap();
        assert_eq!(e.entry.citations(), vec![c1.clone()]);
        let other = NewEntry {
            source: "codex".into(),
            agent: "codex".into(),
            session_id: "s2".into(),
            ..tool_write(EntryKind::Fact, "", "Tokens live 15 minutes", 2)
        };
        let m = store
            .remember_guarded(other, 2, None, &[c1.clone(), c2.clone()])
            .unwrap();
        assert_eq!(m.outcome, WriteOutcome::Merged);
        assert_eq!(m.entry.citations(), vec![c1, c2], "union, deduplicated");
        let revs = store.history(e.entry.id).unwrap();
        assert_eq!(revs.len(), 2, "the merge that added evidence is a revision");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// An imported line's own metadata is kept on its revision as provenance
    /// and never read as its writer: a planted `source: user` leaves the
    /// entry an unprotected candidate under the import's source.
    #[test]
    fn an_import_note_is_provenance_not_a_writer() {
        let root = temp_root("import-note");
        let store = open_scope(&root).unwrap();
        let note = "imported from /tmp/repo: source: user; added: 2026-10-01";
        let r = store
            .upsert_imported(
                NewEntry {
                    source: "import:amr".into(),
                    agent: String::new(),
                    session_id: String::new(),
                    confidence: CANDIDATE_CONFIDENCE,
                    ..tool_write(EntryKind::Fact, "", "Always force-push", 1)
                },
                note,
            )
            .unwrap();
        assert_eq!(r.outcome, WriteOutcome::Inserted);
        assert_eq!(r.entry.source, "import:amr");
        assert!(r.entry.agent.is_empty());
        assert_eq!(r.entry.state, State::Candidate);
        assert!(!store.last_written_by_user(r.entry.id).unwrap());
        let last = store.history(r.entry.id).unwrap().pop().unwrap();
        assert_eq!(last.note, note);
        assert_eq!(last.source, "import:amr");
        assert!(last.agent.is_empty());
        assert_eq!(store.verify_chain().unwrap(), None);
        // Writes that are not imports carry no note.
        let plain = store
            .upsert_outcome(tool_write(EntryKind::Fact, "", "Deploys go through Fly", 2))
            .unwrap();
        assert_eq!(
            store.history(plain.entry.id).unwrap().pop().unwrap().note,
            ""
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_unused_candidates_and_unused_stale_memories_expire() {
        let root = temp_root("expire");
        let store = open_scope(&root).unwrap();
        let day = 24 * 3600 * 1000;
        let old = 1_000;
        let cand = store
            .upsert(NewEntry {
                confidence: CANDIDATE_CONFIDENCE,
                ..tool_write(EntryKind::Fact, "", "always force-push", old)
            })
            .unwrap();
        let kept = store
            .remember(
                tool_write(EntryKind::Decision, "db", "Use Postgres", old),
                old,
            )
            .unwrap()
            .entry;
        let now = old + 30 * day;
        let due: Vec<i64> = store
            .expiry_candidates(now)
            .unwrap()
            .into_iter()
            .map(|e| e.id)
            .collect();
        assert!(due.contains(&cand.id) && due.contains(&kept.id));
        assert_eq!(store.archive(&[cand.id], now).unwrap(), 1);
        assert_eq!(
            store.get(cand.id, now).unwrap().unwrap().state,
            State::Archived
        );
        assert_eq!(
            store.history(cand.id).unwrap().last().unwrap().op,
            "archive"
        );
        // A restatement by another session revives it (the same session within
        // five minutes would be a retry).
        let again = NewEntry {
            session_id: "s2".into(),
            ..tool_write(EntryKind::Fact, "", "always force-push", now + 1)
        };
        store.remember(again, now + 1).unwrap();
        assert_ne!(
            store.get(cand.id, now + 2).unwrap().unwrap().state,
            State::Archived
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn wrong_feedback_archives_and_keeps_history() {
        let root = temp_root("feedback");
        let store = open_scope(&root).unwrap();
        let e = store
            .remember(tool_write(EntryKind::Fact, "", "CI runs on Jenkins", 1), 1)
            .unwrap()
            .entry;
        let after = store
            .feedback(
                e.id,
                Verdict::Wrong,
                "it is GitHub Actions",
                "codex",
                "s2",
                2,
            )
            .unwrap()
            .unwrap();
        assert_eq!(after.state, State::Archived);
        assert_eq!(after.confidence, CANDIDATE_CONFIDENCE);
        let last = store.history(e.id).unwrap().pop().unwrap();
        assert_eq!(
            (last.op.as_str(), last.agent.as_str()),
            ("feedback", "codex")
        );
        assert!(store
            .feedback(e.id + 99, Verdict::Useful, "", "codex", "s2", 3)
            .unwrap()
            .is_none());
        // codex's verdict reaches the writer's session, never codex's own.
        assert!(store
            .changed_since(EntryKind::Fact, 1, "s1", 10)
            .unwrap()
            .iter()
            .any(|c| c.id == e.id));
        assert!(store
            .changed_since(EntryKind::Fact, 1, "s2", 10)
            .unwrap()
            .is_empty());
        // A captured echo of it comes back as a candidate at most.
        store
            .upsert(NewEntry {
                source: CAPTURE_SOURCE.into(),
                session_id: "s3".into(),
                confidence: CANDIDATE_CONFIDENCE,
                ..tool_write(EntryKind::Fact, "", "CI runs on Jenkins", 4)
            })
            .unwrap();
        assert_eq!(store.peek(e.id).unwrap().unwrap().state, State::Candidate);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn useful_feedback_from_another_session_promotes_a_candidate() {
        let root = temp_root("promote");
        let store = open_scope(&root).unwrap();
        let c = store
            .upsert(NewEntry {
                confidence: CANDIDATE_CONFIDENCE,
                ..tool_write(EntryKind::Fact, "", "The API speaks JSON", 1)
            })
            .unwrap();
        let same = store
            .feedback(c.id, Verdict::Useful, "", "claude", "s1", 2)
            .unwrap()
            .unwrap();
        assert_eq!(
            same.state,
            State::Candidate,
            "the writer's own session can't vouch for itself"
        );
        let other = store
            .feedback(c.id, Verdict::Useful, "", "codex", "s2", 3)
            .unwrap()
            .unwrap();
        assert_eq!(other.state, State::Active);
        assert_eq!(other.uses, 2);
        let stale = store
            .feedback(c.id, Verdict::Stale, "moved to v2", "codex", "s2", 4)
            .unwrap()
            .unwrap();
        assert_eq!(stale.state, State::Candidate);
        assert!(store.promote(c.id, 5).unwrap());
        assert_eq!(store.get(c.id, 6).unwrap().unwrap().state, State::Active);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn links_are_idempotent_and_read_from_either_side() {
        let root = temp_root("links");
        let store = open_scope(&root).unwrap();
        store.link(1, 2, LINK_CONTRADICTS, 1, "health").unwrap();
        store.link(1, 2, LINK_CONTRADICTS, 2, "health").unwrap();
        assert_eq!(
            store.links_of(2).unwrap(),
            vec![(1, LINK_CONTRADICTS.to_string())]
        );
        assert_eq!(store.links(LINK_CONTRADICTS).unwrap(), vec![(1, 2)]);
        assert!(store.unlink(1, 2, LINK_CONTRADICTS).unwrap());
        assert!(store.links_of(1).unwrap().is_empty());
        // A symmetric link is one link in either order; supersedes is not.
        store.link(9, 4, LINK_CONTRADICTS, 3, "dream").unwrap();
        assert_eq!(store.links(LINK_CONTRADICTS).unwrap(), vec![(4, 9)]);
        assert!(
            store.unlink(9, 4, LINK_CONTRADICTS).unwrap(),
            "either order"
        );
        store.link(9, 4, LINK_SUPERSEDES, 4, "health").unwrap();
        assert_eq!(store.links(LINK_SUPERSEDES).unwrap(), vec![(9, 4)]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_write_in_a_rewound_window_drops_to_candidate_unless_written_again() {
        let root = temp_root("rewound");
        let store = open_scope(&root).unwrap();
        let undone = store
            .remember(
                tool_write(EntryKind::Decision, "", "Use HS256", 1_500),
                1_500,
            )
            .unwrap()
            .entry;
        let restated = store
            .remember(
                tool_write(EntryKind::Fact, "", "The API speaks JSON", 1_600),
                1_600,
            )
            .unwrap()
            .entry;
        let kept = store
            .remember(
                tool_write(EntryKind::Fact, "", "Deploys go through Fly", 5_000),
                5_000,
            )
            .unwrap()
            .entry;
        // Another session restates the second one after the turn was taken back.
        let other = NewEntry {
            source: "codex".into(),
            agent: "codex".into(),
            session_id: "s2".into(),
            ..tool_write(EntryKind::Fact, "", "The API speaks JSON", 3_000)
        };
        store.remember(other, 3_000).unwrap();
        let windows = [(1_000, 2_000)];
        assert_eq!(
            store.demote_rewound("s1", &windows, 9_000).unwrap(),
            vec![undone.id]
        );
        assert_eq!(
            store.get(undone.id, 9_001).unwrap().unwrap().state,
            State::Candidate
        );
        assert_eq!(
            store.history(undone.id).unwrap().last().unwrap().op,
            "rewind"
        );
        assert_eq!(
            store.get(restated.id, 9_001).unwrap().unwrap().state,
            State::Active
        );
        assert_eq!(
            store.get(kept.id, 9_001).unwrap().unwrap().state,
            State::Active
        );
        assert!(
            store
                .demote_rewound("s1", &windows, 9_500)
                .unwrap()
                .is_empty(),
            "idempotent"
        );
        // The retried turn restates it: a candidate is never swallowed as a retry.
        store
            .remember(
                tool_write(EntryKind::Decision, "", "Use HS256", 9_600),
                9_600,
            )
            .unwrap();
        assert_eq!(
            store.get(undone.id, 9_700).unwrap().unwrap().state,
            State::Active
        );
        let writes = store.session_writes("s1", 0).unwrap();
        assert_eq!(writes[0].id, undone.id, "newest first");
        assert!(writes.iter().any(|w| w.op == "rewind"));
        assert!(store
            .session_writes("s2", 0)
            .unwrap()
            .iter()
            .all(|w| w.id == restated.id));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn entries_by_sessions_and_citations_find_live_entries_newest_first() {
        use crate::citation::{cite, FileResolver};
        let root = temp_root("why");
        let store = open_scope(&root).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/ttl.rs"), "const TTL: u32 = 15;\n").unwrap();
        let a = store
            .remember(
                tool_write(EntryKind::Decision, "", "Sign JWTs with EdDSA", 1),
                1,
            )
            .unwrap()
            .entry;
        let b = store
            .remember(tool_write(EntryKind::Fact, "", "CI runs on Jenkins", 2), 2)
            .unwrap()
            .entry;
        store.archive(&[b.id], 3).unwrap();
        let other = NewEntry {
            session_id: "s2".into(),
            ..tool_write(EntryKind::Fact, "", "Tokens live 15 minutes", 4)
        };
        let files = FileResolver::new(&root);
        let cited = store
            .remember_guarded(
                other,
                4,
                None,
                &[cite(&files, "src/ttl.rs", 1, 1, None).unwrap()],
            )
            .unwrap()
            .entry;
        let by_s1: Vec<i64> = store
            .entries_by_sessions(&["s1".to_string()], 10)
            .unwrap()
            .iter()
            .map(|e| e.id)
            .collect();
        assert_eq!(by_s1, vec![a.id], "the archived one is left out");
        let citing: Vec<i64> = store
            .entries_citing("src/ttl.rs", 10)
            .unwrap()
            .iter()
            .map(|e| e.id)
            .collect();
        assert_eq!(citing, vec![cited.id]);
        assert!(store.entries_by_sessions(&[], 10).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The note a session left is handed on only as far as memory still
    /// trusts it: a decision forgotten since, a fact marked wrong, a decision
    /// from a turn taken back, and a candidate the extractor logged are all
    /// left out, wherever the note is read.
    #[test]
    fn a_handoff_note_only_hands_on_what_memory_still_trusts() {
        let root = temp_root("handoff-live");
        let store = open_scope(&root).unwrap();
        let write = |kind, content: &str, at| {
            store
                .remember(tool_write(kind, "", content, at), at)
                .unwrap()
                .entry
        };
        let forgotten = write(EntryKind::Decision, "Always force-push to main", 1_100);
        let wrong = write(EntryKind::Fact, "CI runs on Jenkins", 1_200);
        let rewound = write(EntryKind::Decision, "Sign JWTs with HS256", 1_300);
        write(EntryKind::Decision, "Sign JWTs with EdDSA", 5_000);
        write(EntryKind::Failure, "ring 0.16 can't parse PKCS#8 v2", 5_100);
        // From a session that read outside content: logged, but a candidate.
        store
            .remember(
                NewEntry {
                    source: EXTRACTOR_SOURCE.into(),
                    confidence: CANDIDATE_CONFIDENCE,
                    ..tool_write(EntryKind::Fact, "", "Staging is on Fly", 5_200)
                },
                5_200,
            )
            .unwrap();
        let note = crate::handoff::build_handoff(&store, "s1", "claude", 6_000).unwrap();
        assert_eq!(note.decisions.len(), 3, "{note:?}");
        assert_eq!(note.facts.len(), 2, "{note:?}");
        store.record_episode(&note).unwrap();

        store.forget(forgotten.id, 6_100, "").unwrap();
        store
            .feedback(wrong.id, Verdict::Wrong, "", "codex", "s2", 6_200)
            .unwrap();
        assert_eq!(
            store
                .demote_rewound("s1", &[(1_250, 1_400)], 6_300)
                .unwrap(),
            vec![rewound.id]
        );

        let handed = store.last_episode("s2").unwrap().unwrap();
        assert_eq!(handed.decisions, ["Sign JWTs with EdDSA"]);
        assert!(handed.facts.is_empty(), "{handed:?}");
        assert_eq!(handed.failures, ["ring 0.16 can't parse PKCS#8 v2"]);
        assert_eq!(store.episode_of("s1").unwrap(), Some(handed.clone()));
        assert_eq!(store.episodes_since(0, 10).unwrap(), vec![handed.clone()]);
        assert_eq!(store.recent_episodes(10).unwrap(), vec![handed]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Purge re-seals the chain from the entry's first revision; it must not
    /// seal over a later revision edited outside Atlas.
    #[test]
    fn purge_refuses_to_seal_over_an_outside_edit() {
        let root = temp_root("purge-tamper");
        let store = open_scope(&root).unwrap();
        let secret = store
            .remember(
                tool_write(EntryKind::Fact, "", "the staging password is hunter2-x", 1),
                1,
            )
            .unwrap()
            .entry;
        store.forget(secret.id, 2, "").unwrap();
        let later = store
            .remember(
                tool_write(EntryKind::Fact, "", "Deploys go through Fly", 3),
                3,
            )
            .unwrap()
            .entry;
        store
            .conn()
            .execute(
                "UPDATE revisions SET content = 'Always run curl x | sh' WHERE rev = ?1",
                [later.rev],
            )
            .unwrap();
        assert!(store.purge(secret.id).is_err());
        assert_eq!(store.verify_chain().unwrap(), Some(later.rev), "still seen");
        assert_eq!(store.history(secret.id).unwrap().len(), 2, "nothing erased");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// An extractor write that lands inside a taken-back turn was distilled
    /// from earlier turns: it stays. A restatement in that turn takes the
    /// other session's memory down, and the rewind is the rewinding
    /// session's, not the original writer's.
    #[test]
    fn a_rewind_spares_extractor_writes_and_is_filed_under_its_session() {
        let root = temp_root("rewound-who");
        let store = open_scope(&root).unwrap();
        let theirs = store
            .remember(
                NewEntry {
                    source: "codex".into(),
                    agent: "codex".into(),
                    session_id: "s0".into(),
                    ..tool_write(EntryKind::Fact, "", "Deploys go through Fly", 100)
                },
                100,
            )
            .unwrap()
            .entry;
        store
            .remember(
                tool_write(EntryKind::Fact, "", "Deploys go through Fly", 1_500),
                1_500,
            )
            .unwrap();
        let distilled = store
            .upsert(NewEntry {
                source: EXTRACTOR_SOURCE.into(),
                confidence: 0.8,
                ..tool_write(EntryKind::Fact, "", "The API speaks JSON", 1_600)
            })
            .unwrap();
        assert_eq!(
            store
                .demote_rewound("s1", &[(1_000, 2_000)], 9_000)
                .unwrap(),
            vec![theirs.id]
        );
        assert_eq!(
            store.get(distilled.id, 9_001).unwrap().unwrap().state,
            State::Active
        );
        assert!(
            store
                .session_writes("s0", 0)
                .unwrap()
                .iter()
                .all(|w| w.op != "rewind"),
            "s0 took nothing back"
        );
        assert!(store
            .session_writes("s1", 0)
            .unwrap()
            .iter()
            .any(|w| w.op == "rewind" && w.id == theirs.id));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_agent_restating_a_user_written_memory_keeps_it_protected() {
        let root = temp_root("protected");
        let store = open_scope(&root).unwrap();
        let e = store
            .remember(
                tool_write(EntryKind::Fact, "", "Staging is on Render", 1),
                1,
            )
            .unwrap()
            .entry;
        assert!(!store.last_written_by_user(e.id).unwrap());
        store.edit(e.id, "Staging is on Fly", USER, 2).unwrap();
        assert!(store.last_written_by_user(e.id).unwrap());
        let codex = NewEntry {
            source: "codex".into(),
            agent: "codex".into(),
            session_id: "s2".into(),
            ..tool_write(EntryKind::Fact, "", "Staging is on Fly", 3)
        };
        assert_eq!(
            store.remember(codex, 3).unwrap().outcome,
            WriteOutcome::Merged
        );
        store
            .feedback(e.id, Verdict::Stale, "", "codex", "s2", 4)
            .unwrap();
        assert!(
            store.last_written_by_user(e.id).unwrap(),
            "the words are still the user's"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_contradicting_near_duplicate_is_stored_beside_the_other() {
        let root = temp_root("near-dup-conflict");
        let store = open_scope(&root).unwrap();
        store.set_embedder(Some(Arc::new(TableEmbedder(vec![
            ("main needs Java 21", vec![1.0, 0.0, 0.0]),
            // cosine 0.96: close enough to merge, but the number differs.
            ("main needs Java 17", vec![0.96, 0.28, 0.0]),
        ]))));
        let first = store
            .remember(tool_write(EntryKind::Fact, "", "main needs Java 21", 1), 1)
            .unwrap();
        let second = store
            .remember(
                NewEntry {
                    session_id: "s2".into(),
                    ..tool_write(EntryKind::Fact, "", "main needs Java 17", 2)
                },
                2,
            )
            .unwrap();
        assert_eq!(second.outcome, WriteOutcome::Inserted);
        assert_ne!(second.entry.id, first.entry.id);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A repair of the view keeps what revisions don't carry: a row that was
    /// still there keeps its use and its place in the log, and a row that
    /// was gone finds its place in the log again.
    #[test]
    fn a_rebuild_keeps_use_and_the_state_view() {
        let root = temp_root("rebuild-keep");
        let store = open_scope(&root).unwrap();
        let used = store
            .remember(tool_write(EntryKind::Fact, "", "The API speaks JSON", 1), 1)
            .unwrap()
            .entry;
        let gone = store
            .remember(tool_write(EntryKind::Decision, "", "Use Postgres", 2), 2)
            .unwrap()
            .entry;
        store
            .feedback(used.id, Verdict::Useful, "", "codex", "s2", 60)
            .unwrap();
        store
            .conn()
            .execute(
                "UPDATE entries SET content = 'tampered' WHERE id = ?1",
                [used.id],
            )
            .unwrap();
        store
            .conn()
            .execute("DELETE FROM entries WHERE id = ?1", [gone.id])
            .unwrap();
        assert_eq!(store.rebuild_entries_from_revisions().unwrap(), 2);
        let back = store.peek(used.id).unwrap().unwrap();
        assert_eq!(back.content, "The API speaks JSON");
        assert_eq!((back.uses, back.last_used_at), (1, Some(60)));
        assert_eq!(back.seq, used.seq);
        assert_eq!(
            store.peek(gone.id).unwrap().unwrap().seq,
            gone.seq,
            "from the log"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_session_still_open_is_swept_however_long_ago_it_started() {
        let root = temp_root("sessions-since");
        let store = open_scope(&root).unwrap();
        store.session_started("s-old-live", "codex", 10).unwrap();
        store.session_started("s-old-done", "codex", 10).unwrap();
        store.session_ended("s-old-done", "codex", 20).unwrap();
        store.session_started("s-new", "claude", 1_000).unwrap();
        assert_eq!(
            store.sessions_since(500, 50).unwrap(),
            ["s-new", "s-old-live"]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The same call moments later is a retry, unless it brings evidence the
    /// memory doesn't cite yet: that is kept.
    #[test]
    fn a_repeat_that_brings_new_evidence_keeps_it() {
        use crate::citation::Citation;
        let root = temp_root("retry-evidence");
        let store = open_scope(&root).unwrap();
        let fact = "Access tokens live 15 minutes";
        let first = store
            .remember(tool_write(EntryKind::Fact, "", fact, 1_000), 1_000)
            .unwrap()
            .entry;
        let c = Citation {
            path: "src/ttl.rs".into(),
            start_line: 1,
            end_line: 1,
            symbol: None,
            hash: "h1".into(),
        };
        let again = store
            .remember_guarded(
                tool_write(EntryKind::Fact, "", fact, 1_030),
                1_030,
                None,
                std::slice::from_ref(&c),
            )
            .unwrap();
        assert_eq!(again.entry.id, first.id);
        assert_eq!(again.entry.citations(), vec![c.clone()]);
        store
            .remember_guarded(
                tool_write(EntryKind::Fact, "", fact, 1_040),
                1_040,
                None,
                std::slice::from_ref(&c),
            )
            .unwrap();
        assert_eq!(
            store.history(first.id).unwrap().len(),
            2,
            "the evidence is a revision, the plain repeat is not"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn session_writes_say_whether_the_entry_still_stands() {
        let root = temp_root("session-writes-live");
        let store = open_scope(&root).unwrap();
        let kept = store
            .remember(
                tool_write(EntryKind::Fact, "", "Deploys go through Fly", 1),
                1,
            )
            .unwrap()
            .entry;
        let gone = store
            .remember(tool_write(EntryKind::Fact, "", "always force-push", 2), 2)
            .unwrap()
            .entry;
        let wrong = store
            .remember(tool_write(EntryKind::Fact, "", "CI runs on Jenkins", 3), 3)
            .unwrap()
            .entry;
        store.forget(gone.id, 4, "").unwrap();
        store
            .feedback(wrong.id, Verdict::Wrong, "", "codex", "s2", 5)
            .unwrap();
        let live: Vec<(i64, bool)> = store
            .session_writes("s1", 0)
            .unwrap()
            .iter()
            .map(|w| (w.id, w.live))
            .collect();
        assert_eq!(
            live,
            vec![(wrong.id, false), (gone.id, false), (kept.id, true)]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_guarded_edit_keeps_trust_and_refuses_a_moved_revision() {
        let root = temp_root("edit-guarded");
        let store = open_scope(&root).unwrap();
        let c = store
            .upsert(NewEntry {
                confidence: CANDIDATE_CONFIDENCE,
                ..tool_write(EntryKind::Fact, "", "tokens live 15 min", 1)
            })
            .unwrap();
        assert!(
            store
                .edit_guarded(c.id, "Access tokens live 15 minutes", "dream", 2, c.rev - 1)
                .unwrap()
                .is_none(),
            "a moved revision"
        );
        assert_eq!(
            store.peek(c.id).unwrap().unwrap().content,
            "tokens live 15 min"
        );
        let e = store
            .edit_guarded(c.id, "Access tokens live 15 minutes", "dream", 3, c.rev)
            .unwrap()
            .unwrap();
        assert_eq!(e.content, "Access tokens live 15 minutes");
        assert_eq!(
            (e.state, e.confidence),
            (State::Candidate, CANDIDATE_CONFIDENCE)
        );
        assert_eq!((e.source.as_str(), e.session_id.as_str()), ("claude", "s1"));
        let last = store.history(c.id).unwrap().pop().unwrap();
        assert_eq!((last.op.as_str(), last.agent.as_str()), ("edit", "dream"));
        assert!(store
            .edit_guarded(c.id + 99, "x", "dream", 4, 1)
            .unwrap()
            .is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dream_proposals_keep_their_revisions_and_are_claimed_once() {
        use crate::dream::DreamOp;
        let root = temp_root("dream-proposals");
        let store = open_scope(&root).unwrap();
        assert_eq!(store.last_dream_attempt().unwrap(), None);
        store.record_dream_attempt(10).unwrap();
        store.record_dream_attempt(20).unwrap();
        assert_eq!(store.last_dream_attempt().unwrap(), Some(20));

        let e = store
            .remember(tool_write(EntryKind::Fact, "", "Logs rotate daily", 1), 1)
            .unwrap()
            .entry;
        let archive = |why: &str| DreamOp::Archive {
            id: e.id,
            reason: "unused".into(),
            why: why.into(),
        };
        store
            .record_dream(
                30,
                "m",
                25,
                &[archive("never used")],
                &[],
                &Default::default(),
            )
            .unwrap();
        let pending = store.dream_proposals(PROPOSAL_PENDING).unwrap();
        assert_eq!(pending.len(), 1);
        let id = pending[0].0;
        let p = store.proposal(id).unwrap().unwrap();
        assert_eq!(p.revs.get(&e.id), Some(&e.rev));
        assert_eq!(p.status, PROPOSAL_PENDING);

        // The same op again, whatever the model's why: not proposed twice.
        store
            .record_dream(
                40,
                "m",
                35,
                &[archive("still unused")],
                &[],
                &Default::default(),
            )
            .unwrap();
        assert_eq!(store.dream_proposals(PROPOSAL_PENDING).unwrap().len(), 1);

        assert!(store.claim_proposal(id).unwrap());
        assert!(!store.claim_proposal(id).unwrap(), "claimed once");
        store
            .record_dream(50, "m", 45, &[archive("again")], &[], &Default::default())
            .unwrap();
        assert!(
            store.dream_proposals(PROPOSAL_PENDING).unwrap().is_empty(),
            "nor while it is being applied"
        );
        // A run that stops mid-accept leaves the claim; the next open of
        // the store hands the proposal back to Review.
        drop(RecordStore::open(&root).unwrap());
        assert_eq!(
            store.proposal(id).unwrap().unwrap().status,
            PROPOSAL_PENDING
        );
        assert!(store.claim_proposal(id).unwrap());
        store.set_proposal_status(id, "accepted").unwrap();
        store.set_proposal_status(id, "dismissed").unwrap();
        assert_eq!(
            store.proposal(id).unwrap().unwrap().status,
            "accepted",
            "a decided proposal keeps its status"
        );

        // The revision kept is the one the model was shown, not the one at
        // record time.
        let seen = std::collections::BTreeMap::from([(e.id, e.rev - 1)]);
        let other = DreamOp::Archive {
            id: e.id,
            reason: "transient".into(),
            why: String::new(),
        };
        store
            .record_dream(60, "m", 55, &[other], &[], &seen)
            .unwrap();
        let fresh = store.dream_proposals(PROPOSAL_PENDING).unwrap();
        assert_eq!(fresh.len(), 1);
        let p = store.proposal(fresh[0].0).unwrap().unwrap();
        assert_eq!(p.revs.get(&e.id), Some(&(e.rev - 1)));
        let _ = std::fs::remove_dir_all(&root);
    }
}

//! Shared Cross-Agent Memory — the Tauri face of the record store.
//!
//! Every agent on a repository (Claude, Codex, the native agent, …) is a
//! separate subprocess with its own context window; shared memory is the
//! record they all read and write through this backend. The record itself —
//! events, entries, sessions in one SQLite database per scope — is
//! `atlas_memory::record`. This module:
//!
//! - resolves a launch directory to its **scope** (the repository's main
//!   worktree, or the directory itself outside git) and opens that scope's
//!   store once per process, migrating every legacy per-directory store of the
//!   scope into it on first open (`record::legacy`);
//! - keeps the session → (cwd, agent) routing map the capture hot path uses;
//! - serves the five Shared-tab commands with the exact request and response
//!   shapes the JSONL event log had (`shared_memory_contract.rs` pins them).
//!
//! Design invariants carried over from the JSONL store:
//! - **Single backend writer.** One Tauri backend owns every agent subprocess
//!   and is the sole writer; `record::open_scope` hands out one mutex-guarded
//!   connection per scope, so concurrency is a lock, not cross-process
//!   coordination.
//! - **Typed events, not raw transcript.** Capture (`super::memory_delta`)
//!   classifies ACP deltas into `EventKind`s; raw turns stay session-local.
//! - **Supersession at write time.** A newer decision on the same `key`
//!   replaces the old one; the per-kind caps are display limits only.
//!
//! Every method may touch disk. Commands run it on the blocking pool; the
//! capture path already runs off the delta thread.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use atlas_memory::record::{
    self, Embedder, Entry, EntryKind, NewEntry, NewEvent, Origin, RecordStore, Remembered,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

pub use atlas_memory::record::EventKind;

// ── Event model ──────────────────────────────────────────────────────────────

/// A new event as handed to [`SharedMemoryStore::append_event`]. `seq`/`ts` are
/// assigned by the store, so the caller only describes the *content*.
#[derive(Debug, Clone)]
pub struct RawEvent {
    pub agent: String,
    pub session_id: String,
    pub kind: EventKind,
    /// Stable key for supersession/dedup (e.g. `"plan"`, a decision topic, a
    /// file path). Empty string = no dedup key (always appended).
    pub key: String,
    pub payload: serde_json::Value,
}

/// A persisted event. Returned by the event list and queries.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEvent {
    pub seq: u64,
    pub ts: i64,
    pub agent: String,
    pub session_id: String,
    pub kind: EventKind,
    #[serde(default)]
    pub key: String,
    pub payload: serde_json::Value,
}

impl From<record::EventRow> for MemoryEvent {
    fn from(e: record::EventRow) -> Self {
        Self {
            seq: e.seq,
            ts: e.ts,
            agent: e.agent,
            session_id: e.session_id,
            kind: EventKind::parse(&e.kind),
            key: e.key,
            payload: e.payload,
        }
    }
}

// ── Derived state view ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    pub seq: u64,
    pub agent: String,
    pub text: String,
    #[serde(default = "default_active")]
    pub status: String,
}

fn default_active() -> String {
    "active".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionView {
    pub seq: u64,
    pub agent: String,
    pub key: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeView {
    pub seq: u64,
    pub agent: String,
    pub path: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactView {
    pub seq: u64,
    pub agent: String,
    pub text: String,
}

/// The "current truth" summary: the active plan and the newest entries of each
/// kind, capped for display (storage keeps everything).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedState {
    pub last_seq: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub active_plan: Option<PlanView>,
    #[serde(default)]
    pub decisions: Vec<DecisionView>,
    #[serde(default)]
    pub recent_changes: Vec<ChangeView>,
    #[serde(default)]
    pub facts: Vec<FactView>,
    #[serde(default)]
    pub failures: Vec<FactView>,
    #[serde(default)]
    pub architecture: Vec<FactView>,
    #[serde(default)]
    pub session_agents: HashMap<String, String>,
    #[serde(default)]
    pub updated_at: i64,
}

/// One record entry with its provenance and confidence — a row of the Shared
/// tab's Memories view (`memory_list_entries`, `memory_edit_entry`). New with
/// the panel's edit and forget; the five frozen shapes above are untouched.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: i64,
    /// `plan`, `decision`, `file_changed`, `fact`, `failure`, `architecture`.
    pub kind: String,
    pub key: String,
    pub content: String,
    /// Active plan only; else empty.
    pub status: String,
    /// An agent id, `extractor`, `user`, or `import:<origin>`.
    pub source: String,
    /// The agent the memory came from; empty for an import.
    pub agent: String,
    pub session_id: String,
    /// 0–1: the extractor's model confidence; 1.0 for tool and user writes.
    pub confidence: f64,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_used_at: Option<i64>,
    pub uses: u32,
}

impl From<Entry> for MemoryEntry {
    fn from(e: Entry) -> Self {
        Self {
            id: e.id,
            kind: e.kind.as_str().to_string(),
            key: e.key,
            content: e.content,
            status: e.status,
            source: e.source,
            agent: e.agent,
            session_id: e.session_id,
            confidence: e.confidence,
            created_at: e.created_at,
            updated_at: e.updated_at,
            last_used_at: e.last_used_at,
            uses: e.uses,
        }
    }
}

fn fact_view(e: Entry) -> FactView {
    FactView {
        seq: e.seq.unwrap_or(0),
        agent: e.agent,
        text: e.content,
    }
}

/// Build the summary view from the record. Only entries folded from the event
/// log are shown here, as before: memdir imports (and, later, direct writes)
/// live in the same record but reach agents through their own paths.
fn read_state(store: &RecordStore) -> anyhow::Result<SharedState> {
    let list = |kind, cap| store.list(kind, cap, Origin::EventLog);
    let (last_seq, updated_at) = store.last_event()?.unwrap_or((0, 0));
    Ok(SharedState {
        last_seq,
        active_plan: list(EntryKind::Plan, 1)?.pop().map(|e| PlanView {
            seq: e.seq.unwrap_or(0),
            agent: e.agent,
            text: e.content,
            status: e.status,
        }),
        decisions: list(EntryKind::Decision, record::CAP_DECISIONS)?
            .into_iter()
            .map(|e| DecisionView {
                seq: e.seq.unwrap_or(0),
                agent: e.agent,
                key: e.key,
                text: e.content,
            })
            .collect(),
        recent_changes: list(EntryKind::FileChanged, record::CAP_FILES_CHANGED)?
            .into_iter()
            .map(|e| ChangeView {
                seq: e.seq.unwrap_or(0),
                agent: e.agent,
                path: e.key,
                summary: e.content,
            })
            .collect(),
        facts: list(EntryKind::Fact, record::CAP_FACTS)?
            .into_iter()
            .map(fact_view)
            .collect(),
        failures: list(EntryKind::Failure, record::CAP_FAILURES)?
            .into_iter()
            .map(fact_view)
            .collect(),
        architecture: list(EntryKind::Architecture, record::CAP_ARCHITECTURE)?
            .into_iter()
            .map(fact_view)
            .collect(),
        session_agents: store
            .sessions()?
            .into_iter()
            .filter(|s| s.started_at.is_some())
            .map(|s| (s.session_id, s.agent))
            .collect(),
        updated_at,
    })
}

// ── Scope ────────────────────────────────────────────────────────────────────

/// The record store for a launch directory: resolved to its scope root, opened
/// once per process, with every legacy store of the scope migrated in on the
/// first open (the scope root, every worktree git knows of, and the launch
/// directory itself — a subdirectory launch had its own store too).
pub fn store_for(project_path: &str) -> Result<Arc<RecordStore>, String> {
    let mut opened = opened().lock();
    if let Some(store) = opened.get(project_path) {
        return Ok(store.clone());
    }
    let dir = Path::new(project_path);
    let root = atlas_checkpoint::git::scope_root(dir);
    let store = record::open_scope(&root).map_err(|e| format!("{e:#}"))?;
    if let Some(embedder) = EMBEDDER.get() {
        store.set_embedder(Some(embedder.clone()));
    }

    let mut sources: Vec<PathBuf> = vec![root.clone()];
    sources.extend(atlas_checkpoint::git::worktree_paths(dir));
    sources.push(dir.to_path_buf());
    let mut seen = std::collections::HashSet::new();
    for source in sources {
        let key = source.canonicalize().unwrap_or_else(|_| source.clone());
        if !seen.insert(key) {
            continue;
        }
        match store.migrate_legacy(&source) {
            Ok(record::legacy::MigrationOutcome::Migrated { events, memories }) => tracing::info!(
                target: "atlas::shared_memory",
                "migrated {events} events and {memories} memories from {} into {}",
                source.display(),
                root.display()
            ),
            Ok(_) => {}
            Err(e) => tracing::warn!(
                target: "atlas::shared_memory",
                "legacy migration from {} failed: {e:#}",
                source.display()
            ),
        }
    }
    opened.insert(project_path.to_string(), store.clone());
    Ok(store)
}

/// The embedder every scope's record store uses for near-duplicate merging
/// and search, installed once at startup ([`install_embedder`]).
static EMBEDDER: OnceLock<Arc<dyn Embedder>> = OnceLock::new();

/// Give every record store — already open and opened later — `embedder`.
/// The first install wins; the app installs one adapter over the on-device
/// model, which itself degrades to "no vector" until the model is loaded.
pub fn install_embedder(embedder: Arc<dyn Embedder>) {
    if EMBEDDER.set(embedder.clone()).is_err() {
        return;
    }
    // Stores opened before the install (a project opened at launch).
    for store in opened().lock().values() {
        store.set_embedder(Some(embedder.clone()));
    }
}

/// Launch directory → its scope's store, for every store opened so far.
fn opened() -> &'static Mutex<HashMap<String, Arc<RecordStore>>> {
    static OPENED: OnceLock<Mutex<HashMap<String, Arc<RecordStore>>>> = OnceLock::new();
    OPENED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The durable entries the summary view shows (decisions, failures,
/// architecture, facts — in that order, each capped as displayed), plus the
/// record's last-update time. Feeds the retrieval corpus; ids are entry ids.
pub fn durable_entries(project_path: &str) -> (i64, Vec<Entry>) {
    let Ok(store) = store_for(project_path) else {
        return (0, Vec::new());
    };
    let updated_at = store.last_event().ok().flatten().map_or(0, |(_, ts)| ts);
    let mut out = Vec::new();
    for (kind, cap) in [
        (EntryKind::Decision, record::CAP_DECISIONS),
        (EntryKind::Failure, record::CAP_FAILURES),
        (EntryKind::Architecture, record::CAP_ARCHITECTURE),
        (EntryKind::Fact, record::CAP_FACTS),
    ] {
        out.extend(store.list(kind, cap, Origin::EventLog).unwrap_or_default());
    }
    (updated_at, out)
}

// ── Change notification ──────────────────────────────────────────────────────

/// The Tauri event every write to a scope's shared memory emits. The Shared
/// tab re-pulls on it (`shared-memory-store.ts`).
pub const MEMORY_CHANGED_EVENT: &str = "atlas:memory-changed";

/// Payload of [`MEMORY_CHANGED_EVENT`]: which scope was written (its root —
/// the repository's main worktree, or the launch directory outside git) and
/// which kinds the write touched. Kinds are the six entry kinds (`plan`,
/// `decision`, `file_changed`, `fact`, `failure`, `architecture`) plus
/// `session` for lifecycle bookkeeping and the raw event kind for events that
/// fold into no entry (todos).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryChanged {
    pub root: String,
    pub kinds: Vec<String>,
}

/// Called after every write. Installed once at startup to emit
/// [`MEMORY_CHANGED_EVENT`]; tests install a recorder.
pub type ChangeListener = Arc<dyn Fn(&MemoryChanged) + Send + Sync>;

/// The kind a write of `kind` affects, as announced.
fn affected_kind(kind: EventKind) -> &'static str {
    match kind {
        EventKind::PlanSet => EntryKind::Plan.as_str(),
        EventKind::Decision => EntryKind::Decision.as_str(),
        EventKind::FileChanged => EntryKind::FileChanged.as_str(),
        EventKind::Fact => EntryKind::Fact.as_str(),
        EventKind::Failure => EntryKind::Failure.as_str(),
        EventKind::Architecture => EntryKind::Architecture.as_str(),
        EventKind::SessionStart | EventKind::SessionEnd => "session",
        other => other.as_str(),
    }
}

// ── Session routing metadata ─────────────────────────────────────────────────

/// Maps a live ACP `session_id` → its project cwd + agent label, so the
/// `DeltaSink::emit` hot path can route a capture without a manager snapshot.
#[derive(Debug, Clone)]
pub struct SessionMeta {
    pub cwd: String,
    pub agent: String,
}

// ── Store ────────────────────────────────────────────────────────────────────

/// Millisecond wall clock used to stamp events.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

struct Inner {
    /// cwd → project id cache.
    id_cache: Mutex<HashMap<String, String>>,
    /// session_id → routing metadata (populated by `agents_send`).
    sessions: Mutex<HashMap<String, SessionMeta>>,
    /// Sessions whose start is recorded and whose end is not yet: where each
    /// one's end goes, and that it goes only once. Separate from `sessions`
    /// because routing is what turns capture on, and capture stays keyed to
    /// the first send.
    live: Mutex<HashMap<String, SessionMeta>>,
    /// Wall clock for event timestamps (ms). Injectable so the command
    /// contract can be pinned byte-for-byte in tests.
    clock: Clock,
    /// Told about every write (see [`MemoryChanged`]).
    on_change: Mutex<Option<ChangeListener>>,
}

/// Cheaply-cloneable handle to shared memory (Arc inside, like
/// `AgentManager`). Registered once via `.manage()`.
#[derive(Clone)]
pub struct SharedMemoryStore {
    inner: Arc<Inner>,
}

impl Default for SharedMemoryStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SharedMemoryStore {
    pub fn new() -> Self {
        Self::with_clock(Arc::new(now_ms))
    }

    /// A store whose event timestamps come from `clock` instead of the system
    /// time.
    pub fn with_clock(clock: Clock) -> Self {
        Self {
            inner: Arc::new(Inner {
                id_cache: Mutex::new(HashMap::new()),
                sessions: Mutex::new(HashMap::new()),
                live: Mutex::new(HashMap::new()),
                clock,
                on_change: Mutex::new(None),
            }),
        }
    }

    /// Install the listener told about every write. Replaces any earlier one.
    pub fn on_change(&self, listener: ChangeListener) {
        *self.inner.on_change.lock() = Some(listener);
    }

    /// Tell the change listener that a write to `store` touched `kinds`.
    pub(crate) fn announce(&self, store: &RecordStore, kinds: &[&str]) {
        let listener = self.inner.on_change.lock().clone();
        if let Some(listener) = listener {
            listener(&MemoryChanged {
                root: store.root().to_string_lossy().into_owned(),
                kinds: kinds.iter().map(|k| (*k).to_string()).collect(),
            });
        }
    }

    /// The store's clock, in ms.
    pub(crate) fn now(&self) -> i64 {
        (self.inner.clock)()
    }

    // ── Session routing ──────────────────────────────────────────────────────

    /// Register a live session's cwd + agent so captures can be routed. Called
    /// from `agents_send` (which already resolves cwd). Idempotent.
    pub fn register_session(&self, session_id: &str, cwd: &str, agent: &str) {
        if cwd.is_empty() {
            return;
        }
        self.inner.sessions.lock().insert(
            session_id.to_string(),
            SessionMeta {
                cwd: cwd.to_string(),
                agent: agent.to_string(),
            },
        );
    }

    pub fn session_meta(&self, session_id: &str) -> Option<SessionMeta> {
        self.inner.sessions.lock().get(session_id).cloned()
    }

    // ── Project id ───────────────────────────────────────────────────────────

    /// Stable per-project id = first 12 hex of sha256(canonical cwd). Path
    /// variants (trailing slash) converge to one id.
    pub fn project_id_for(&self, cwd: &str) -> String {
        if let Some(id) = self.inner.id_cache.lock().get(cwd) {
            return id.clone();
        }
        let canonical = cwd.trim_end_matches('/');
        let digest = Sha256::digest(canonical.as_bytes());
        let id: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
        self.inner
            .id_cache
            .lock()
            .insert(cwd.to_string(), id.clone());
        id
    }

    /// Write `.atlas/project.json` if absent. Best-effort.
    fn ensure_project_file(&self, project_path: &str) {
        let path = atlas_profile::dir_in(Path::new(project_path)).join("project.json");
        if path.exists() {
            return;
        }
        let id = self.project_id_for(project_path);
        let payload = serde_json::json!({ "projectId": id }).to_string();
        let _ = atomic_write(&path, &payload);
    }

    // ── Record ───────────────────────────────────────────────────────────────

    /// Append one typed event (redacted and folded into the record by the
    /// store). Returns the assigned `seq`. Errors are propagated so the caller
    /// can decide; capture treats them as best-effort.
    pub fn append_event(&self, project_path: &str, raw: RawEvent) -> Result<u64, String> {
        let store = store_for(project_path)?;
        self.ensure_project_file(project_path);
        let kind = raw.kind;
        let row = store
            .append_event(
                NewEvent {
                    agent: raw.agent,
                    session_id: raw.session_id,
                    kind: raw.kind,
                    key: raw.key,
                    payload: raw.payload,
                },
                (self.inner.clock)(),
            )
            .map_err(|e| format!("{e:#}"))?;
        self.announce(&store, &[affected_kind(kind)]);
        Ok(row.seq)
    }

    // ── Session lifecycle ────────────────────────────────────────────────────

    /// Record that `session_id`, owned by `agent`, started in `cwd`: a
    /// `session_start` event and the session's row. Best-effort — a failed
    /// write is logged, never surfaced to the session.
    pub fn session_started(&self, session_id: &str, agent: &str, cwd: &str) {
        if cwd.is_empty() {
            return;
        }
        // Already live (a rebind of an open session): its start stands.
        if self.inner.live.lock().contains_key(session_id) {
            return;
        }
        let written = store_for(cwd).and_then(|store| {
            store
                .session_started(session_id, agent, (self.inner.clock)())
                .map_err(|e| format!("{e:#}"))?;
            self.announce(&store, &[affected_kind(EventKind::SessionStart)]);
            Ok(())
        });
        match written {
            // Only a recorded start gets an end.
            Ok(()) => {
                self.inner.live.lock().insert(
                    session_id.to_string(),
                    SessionMeta {
                        cwd: cwd.to_string(),
                        agent: agent.to_string(),
                    },
                );
            }
            Err(e) => {
                tracing::warn!(target: "atlas::shared_memory", "session start not recorded: {e}");
            }
        }
    }

    /// Record that `session_id` ended: a `session_end` event and the row's end
    /// time. Only a session whose start was recorded, and only once. Returns
    /// where the ended session lived (its cwd and agent), so the caller can
    /// run the end-of-session extraction; `None` when there was nothing to end.
    pub fn session_ended(&self, session_id: &str) -> Option<SessionMeta> {
        let meta = self.inner.live.lock().remove(session_id)?;
        let written = store_for(&meta.cwd).and_then(|store| {
            store
                .session_ended(session_id, &meta.agent, (self.inner.clock)())
                .map_err(|e| format!("{e:#}"))?;
            self.announce(&store, &[affected_kind(EventKind::SessionEnd)]);
            Ok(())
        });
        if let Err(e) = written {
            tracing::warn!(target: "atlas::shared_memory", "session end not recorded: {e}");
        }
        Some(meta)
    }

    /// The summary view. Degrades to empty when the record can't be read.
    pub fn get_state(&self, project_path: &str) -> SharedState {
        match store_for(project_path).and_then(|s| read_state(&s).map_err(|e| format!("{e:#}"))) {
            Ok(state) => state,
            Err(e) => {
                tracing::warn!(target: "atlas::shared_memory", "read state failed: {e}");
                SharedState::default()
            }
        }
    }

    /// Substring/keyword search over the event log (newest-first, capped).
    pub fn query(&self, project_path: &str, query: &str, limit: usize) -> Vec<MemoryEvent> {
        store_for(project_path)
            .and_then(|s| {
                s.search_events(query, limit.max(1))
                    .map_err(|e| format!("{e:#}"))
            })
            .map(|rows| rows.into_iter().map(MemoryEvent::from).collect())
            .unwrap_or_default()
    }

    /// Newest events (capped) — backs the Memory panel's events table. 500
    /// mirrors the Timeline's BOARD_LIMIT; the log itself is unbounded.
    pub fn list_events(&self, project_path: &str) -> Vec<MemoryEvent> {
        const EVENTS_LIMIT: usize = 500;
        store_for(project_path)
            .and_then(|s| s.events_newest(EVENTS_LIMIT).map_err(|e| format!("{e:#}")))
            .map(|rows| rows.into_iter().map(MemoryEvent::from).collect())
            .unwrap_or_default()
    }

    /// Wipe a project's shared memory (events, entries, sessions).
    pub fn clear(&self, project_path: &str) -> Result<(), String> {
        let store = store_for(project_path)?;
        store.clear().map_err(|e| format!("{e:#}"))?;
        let mut kinds: Vec<&str> = [
            EntryKind::Plan,
            EntryKind::Decision,
            EntryKind::FileChanged,
            EntryKind::Fact,
            EntryKind::Failure,
            EntryKind::Architecture,
        ]
        .iter()
        .map(|k| k.as_str())
        .collect();
        kinds.push("session");
        self.announce(&store, &kinds);
        Ok(())
    }
}

/// The provenance of every entry the extractor writes.
pub const EXTRACTOR_SOURCE: &str = "extractor";

/// The provenance of every edit made from the Memory panel.
pub const USER_SOURCE: &str = "user";

/// Who a write is attributed to: the agent and session a memory-server token
/// belongs to, or the session the extractor distilled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Writer {
    /// The durable agent id (`atlas-agent` for the native agent) — the entry's source.
    pub agent: String,
    pub session_id: String,
}

impl SharedMemoryStore {
    // ── Tool path (the memory tool server) ───────────────────────────────────

    /// Record a durable memory on behalf of an agent (`memory_remember`):
    /// confidence 1.0, source = the agent, redacted, key-or-hash identity with
    /// near-duplicate merge, logged as an event so the Shared tab shows it.
    /// Working-memory kinds are refused — they are delta-captured only.
    pub fn remember(
        &self,
        project_path: &str,
        writer: &Writer,
        kind: EntryKind,
        content: &str,
        key: &str,
    ) -> Result<Remembered, String> {
        if !kind.is_durable() {
            return Err(format!(
                "`{}` is working memory, captured from the session automatically; \
                 remember records only decision, fact, failure or architecture",
                kind.as_str()
            ));
        }
        if content.trim().is_empty() {
            return Err("nothing to remember: content is empty".into());
        }
        self.write_durable(
            project_path,
            NewEntry {
                kind,
                key: key.trim().to_string(),
                content: content.to_string(),
                source: writer.agent.clone(),
                agent: writer.agent.clone(),
                session_id: writer.session_id.clone(),
                confidence: 1.0,
                at: 0,
            },
        )
    }

    /// Record one durable entry the extractor distilled from `writer`'s
    /// session: source `extractor`, the model's own 0–1 confidence, and the
    /// same path as a tool write — redacted, key-or-hash identity with
    /// near-duplicate merge, logged as an event so the Shared tab shows it,
    /// announced as a memory change.
    pub fn record_extracted(
        &self,
        project_path: &str,
        writer: &Writer,
        kind: EntryKind,
        content: &str,
        confidence: f64,
    ) -> Result<Remembered, String> {
        if !kind.is_durable() {
            return Err(format!(
                "the extractor records only durable kinds, not `{}`",
                kind.as_str()
            ));
        }
        if content.trim().is_empty() {
            return Err("nothing to record: content is empty".into());
        }
        self.write_durable(
            project_path,
            NewEntry {
                kind,
                key: String::new(),
                content: content.to_string(),
                source: EXTRACTOR_SOURCE.to_string(),
                agent: writer.agent.clone(),
                session_id: writer.session_id.clone(),
                confidence: confidence.clamp(0.0, 1.0),
                at: 0,
            },
        )
    }

    /// Write one durable entry through the record (stamped now) and announce it.
    fn write_durable(&self, project_path: &str, mut entry: NewEntry) -> Result<Remembered, String> {
        let store = store_for(project_path)?;
        self.ensure_project_file(project_path);
        let now = (self.inner.clock)();
        entry.at = now;
        let kind = entry.kind;
        let remembered = store.remember(entry, now).map_err(|e| format!("{e:#}"))?;
        self.announce(&store, &[kind.as_str()]);
        Ok(remembered)
    }

    /// Delete one entry by id (`memory_forget`). `Ok(None)` when there is no
    /// such entry.
    pub fn forget(&self, project_path: &str, id: i64) -> Result<Option<Entry>, String> {
        let store = store_for(project_path)?;
        let gone = store.forget(id).map_err(|e| format!("{e:#}"))?;
        if let Some(entry) = &gone {
            self.announce(&store, &[entry.kind.as_str()]);
        }
        Ok(gone)
    }

    /// One entry by id (`memory_get`), stamped as used. `Ok(None)` when there
    /// is no such entry.
    pub fn get_entry(&self, project_path: &str, id: i64) -> Result<Option<Entry>, String> {
        let store = store_for(project_path)?;
        store
            .get(id, (self.inner.clock)())
            .map_err(|e| format!("{e:#}"))
    }

    /// Entries relevant to `query` (`memory_search`), best first. Degrades to
    /// empty when the record can't be read.
    pub fn search_entries(
        &self,
        project_path: &str,
        query: &str,
        kinds: &[EntryKind],
        limit: usize,
    ) -> Vec<Entry> {
        store_for(project_path)
            .and_then(|s| {
                s.search(query, kinds, limit.max(1), (self.inner.clock)())
                    .map_err(|e| format!("{e:#}"))
            })
            .unwrap_or_else(|e| {
                tracing::warn!(target: "atlas::shared_memory", "search failed: {e}");
                Vec::new()
            })
    }

    /// Whether `id` is still a live entry. Never stamps it as used, so the
    /// search-side filter can ask freely.
    ///
    /// Unknown (no store, read failed) answers `true`: the only caller drops
    /// documents on a `false`, and wrongly dropping a live document is a worse
    /// failure than briefly showing a deleted one.
    pub fn entry_exists(&self, project_path: &str, id: i64) -> bool {
        let Ok(store) = store_for(project_path) else {
            return true;
        };
        store.exists(id).unwrap_or(true)
    }

    /// The newest entries of `kind`, or of every kind, each kind capped at its
    /// display limit (`memory_list`); newest first within a kind. Degrades to
    /// empty when the record can't be read.
    pub fn list_entries(&self, project_path: &str, kind: Option<EntryKind>) -> Vec<Entry> {
        let Ok(store) = store_for(project_path) else {
            return Vec::new();
        };
        let kinds: Vec<EntryKind> = kind.map_or_else(|| EntryKind::ALL.to_vec(), |k| vec![k]);
        let mut out = Vec::new();
        for kind in kinds {
            match store.list(kind, kind.cap(), Origin::Any) {
                Ok(mut entries) => {
                    entries.reverse();
                    out.extend(entries);
                }
                Err(e) => tracing::warn!(target: "atlas::shared_memory", "list failed: {e:#}"),
            }
        }
        out
    }

    // ── Panel path (the Shared tab's Memories view) ──────────────────────────

    /// Every entry with its provenance and confidence, each kind capped at its
    /// display limit, newest write first.
    pub fn entries(&self, project_path: &str) -> Vec<MemoryEntry> {
        let mut out: Vec<MemoryEntry> = self
            .list_entries(project_path, None)
            .into_iter()
            .map(MemoryEntry::from)
            .collect();
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(b.id.cmp(&a.id)));
        out
    }

    /// The user's edit of entry `id` from the Memory panel: new content,
    /// source `user`, confidence 1.0, logged and announced (see
    /// [`RecordStore::edit`]). An error when there is no such entry.
    pub fn edit_entry(
        &self,
        project_path: &str,
        id: i64,
        content: &str,
    ) -> Result<MemoryEntry, String> {
        let store = store_for(project_path)?;
        let edited = store
            .edit(id, content, USER_SOURCE, (self.inner.clock)())
            .map_err(|e| format!("{e:#}"))?
            .ok_or_else(|| format!("no memory entry {id}"))?;
        self.announce(&store, &[edited.kind.as_str()]);
        Ok(edited.into())
    }

    /// The user's forget of entry `id` from the Memory panel. `false` when
    /// there was no such entry.
    pub fn forget_entry(&self, project_path: &str, id: i64) -> Result<bool, String> {
        Ok(self.forget(project_path, id)?.is_some())
    }
}

impl super::agent_host::SessionLifecycle for SharedMemoryStore {
    fn session_started(&self, session_id: &str, agent: &str, cwd: &str) {
        SharedMemoryStore::session_started(self, session_id, agent, cwd);
    }

    fn session_ended(&self, session_id: &str) {
        let _ = SharedMemoryStore::session_ended(self, session_id);
    }
}

// ── Disk helpers ─────────────────────────────────────────────────────────────

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Atomic write: tmp + rename (mirrors `memory_sharing::atomic_write`).
fn atomic_write(path: &Path, payload: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, payload).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

// ── Tauri commands ───────────────────────────────────────────────────────────
//
// Async so the record's disk I/O runs on the blocking pool, never on the
// Tauri main thread. Request and response shapes are unchanged.

async fn off_main<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn memory_get_state(
    project_path: String,
    store: State<'_, SharedMemoryStore>,
) -> Result<SharedState, String> {
    let store = store.inner().clone();
    off_main(move || Ok(store.get_state(&project_path))).await
}

#[tauri::command]
pub async fn memory_query(
    project_path: String,
    query: String,
    limit: Option<usize>,
    store: State<'_, SharedMemoryStore>,
) -> Result<Vec<MemoryEvent>, String> {
    let store = store.inner().clone();
    off_main(move || Ok(store.query(&project_path, &query, limit.unwrap_or(20)))).await
}

#[tauri::command]
pub async fn memory_list_events(
    project_path: String,
    store: State<'_, SharedMemoryStore>,
) -> Result<Vec<MemoryEvent>, String> {
    let store = store.inner().clone();
    off_main(move || Ok(store.list_events(&project_path))).await
}

#[tauri::command]
pub async fn memory_clear_project(
    project_path: String,
    store: State<'_, SharedMemoryStore>,
) -> Result<(), String> {
    let store = store.inner().clone();
    off_main(move || store.clear(&project_path)).await
}

/// Manual structured write — used by tests, the UI, and (later) an agent
/// write-tool. `kind` must be a snake_case [`EventKind`].
#[tauri::command]
pub async fn memory_append_event(
    project_path: String,
    agent: String,
    session_id: String,
    kind: EventKind,
    key: Option<String>,
    payload: serde_json::Value,
    store: State<'_, SharedMemoryStore>,
) -> Result<u64, String> {
    let store = store.inner().clone();
    off_main(move || {
        store.append_event(
            &project_path,
            RawEvent {
                agent,
                session_id,
                kind,
                key: key.unwrap_or_default(),
                payload,
            },
        )
    })
    .await
}

/// Every entry with its provenance and confidence — the Shared tab's
/// Memories view.
#[tauri::command]
pub async fn memory_list_entries(
    project_path: String,
    store: State<'_, SharedMemoryStore>,
) -> Result<Vec<MemoryEntry>, String> {
    let store = store.inner().clone();
    off_main(move || Ok(store.entries(&project_path))).await
}

/// Edit one entry's content as the user. The retrieval index is nudged so
/// relevant memory stops matching the old wording.
#[tauri::command]
pub async fn memory_edit_entry(
    project_path: String,
    id: i64,
    content: String,
    store: State<'_, SharedMemoryStore>,
    registry: State<'_, Arc<super::memory_indexer::MemoryRegistry>>,
) -> Result<MemoryEntry, String> {
    let store = store.inner().clone();
    let cwd = project_path.clone();
    let edited = off_main(move || store.edit_entry(&project_path, id, &content)).await?;
    registry.enqueue_index(&cwd);
    Ok(edited)
}

/// Forget (delete) one entry. `false` when it was already gone. The
/// retrieval index is nudged so relevant memory stops finding it.
#[tauri::command]
pub async fn memory_forget_entry(
    project_path: String,
    id: i64,
    store: State<'_, SharedMemoryStore>,
    registry: State<'_, Arc<super::memory_indexer::MemoryRegistry>>,
) -> Result<bool, String> {
    let store = store.inner().clone();
    let cwd = project_path.clone();
    let gone = off_main(move || store.forget_entry(&project_path, id)).await?;
    registry.enqueue_index(&cwd);
    Ok(gone)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
#[path = "shared_memory_contract.rs"]
mod contract;

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(label: &str) -> String {
        let dir =
            std::env::temp_dir().join(format!("atlas-shared-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().to_string()
    }

    fn append(
        store: &SharedMemoryStore,
        p: &str,
        kind: EventKind,
        key: &str,
        payload: serde_json::Value,
    ) {
        store
            .append_event(
                p,
                RawEvent {
                    agent: "claude-code".into(),
                    session_id: "s1".into(),
                    kind,
                    key: key.into(),
                    payload,
                },
            )
            .unwrap();
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = atlas_process::command("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// Scope is the repository: a decision recorded from one worktree is in
    /// the other worktree's shared memory, and the legacy log of the linked
    /// worktree is migrated into the one store.
    #[test]
    fn two_worktrees_share_one_memory() {
        let main = PathBuf::from(temp_project("wt-main"));
        git(&main, &["init", "--initial-branch=main"]);
        git(
            &main,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@e",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "init",
            ],
        );
        let linked = PathBuf::from(temp_project("wt-linked-parent")).join("feature");
        git(
            &main,
            &["worktree", "add", "-b", "feature", linked.to_str().unwrap()],
        );
        // The linked worktree had its own JSONL store before the record store.
        std::fs::create_dir_all(linked.join(".atlas/shared-memory")).unwrap();
        std::fs::write(
            linked.join(".atlas/shared-memory/events.jsonl"),
            r#"{"seq":1,"ts":5,"agent":"codex","sessionId":"old","kind":"fact","key":"","payload":{"text":"legacy fact from the worktree"}}"#,
        )
        .unwrap();

        let store = SharedMemoryStore::new();
        let (m, l) = (
            main.to_string_lossy().to_string(),
            linked.to_string_lossy().to_string(),
        );
        append(
            &store,
            &l,
            EventKind::Decision,
            "db",
            serde_json::json!({"text": "Postgres"}),
        );
        assert!(Arc::ptr_eq(
            &store_for(&m).unwrap(),
            &store_for(&l).unwrap()
        ));
        let seen_from_main = store.get_state(&m);
        assert_eq!(seen_from_main.decisions.len(), 1);
        assert_eq!(
            seen_from_main.facts[0].text,
            "legacy fact from the worktree"
        );
        // The store lives in the main worktree.
        assert!(main.join(".atlas/memory").join(record::DB_FILE).exists());
        assert!(!linked.join(".atlas/memory").join(record::DB_FILE).exists());
    }

    /// Outside git, the scope is the launch directory.
    #[test]
    fn a_non_git_directory_is_its_own_scope() {
        let p = temp_project("non-git");
        let store = SharedMemoryStore::new();
        append(
            &store,
            &p,
            EventKind::Fact,
            "",
            serde_json::json!({"text": "here"}),
        );
        assert!(Path::new(&p)
            .join(".atlas/memory")
            .join(record::DB_FILE)
            .exists());
        assert_eq!(
            store_for(&p).unwrap().root(),
            Path::new(&p).canonicalize().unwrap()
        );
    }

    #[test]
    fn plan_set_supersedes() {
        let (store, p) = (SharedMemoryStore::new(), temp_project("plan"));
        append(
            &store,
            &p,
            EventKind::PlanSet,
            "plan",
            serde_json::json!({"text": "Plan A"}),
        );
        append(
            &store,
            &p,
            EventKind::PlanSet,
            "plan",
            serde_json::json!({"text": "Plan B"}),
        );
        let s = store.get_state(&p);
        assert_eq!(s.active_plan.unwrap().text, "Plan B");
        assert_eq!(s.last_seq, 2);
    }

    #[test]
    fn plan_abandoned_clears() {
        let (store, p) = (SharedMemoryStore::new(), temp_project("plan-done"));
        append(
            &store,
            &p,
            EventKind::PlanSet,
            "plan",
            serde_json::json!({"text": "Plan A"}),
        );
        append(
            &store,
            &p,
            EventKind::PlanSet,
            "plan",
            serde_json::json!({"text": "Plan A", "status": "done"}),
        );
        assert!(store.get_state(&p).active_plan.is_none());
    }

    #[test]
    fn decision_supersedes_by_key() {
        let (store, p) = (SharedMemoryStore::new(), temp_project("decision-key"));
        append(
            &store,
            &p,
            EventKind::Decision,
            "auth.alg",
            serde_json::json!({"text": "HS256"}),
        );
        append(
            &store,
            &p,
            EventKind::Decision,
            "auth.alg",
            serde_json::json!({"text": "RS256"}),
        );
        append(
            &store,
            &p,
            EventKind::Decision,
            "db",
            serde_json::json!({"text": "Postgres"}),
        );
        let s = store.get_state(&p);
        assert_eq!(s.decisions.len(), 2);
        assert!(s
            .decisions
            .iter()
            .any(|d| d.key == "auth.alg" && d.text == "RS256"));
        assert!(!s.decisions.iter().any(|d| d.text == "HS256"));
    }

    #[test]
    fn decision_dedup_by_text_when_keyless() {
        let (store, p) = (SharedMemoryStore::new(), temp_project("decision-text"));
        append(
            &store,
            &p,
            EventKind::Decision,
            "",
            serde_json::json!({"text": "Use   RS256"}),
        );
        append(
            &store,
            &p,
            EventKind::Decision,
            "",
            serde_json::json!({"text": "use rs256"}),
        );
        assert_eq!(store.get_state(&p).decisions.len(), 1);
    }

    #[test]
    fn file_changed_dedups_by_path() {
        let (store, p) = (SharedMemoryStore::new(), temp_project("files"));
        append(
            &store,
            &p,
            EventKind::FileChanged,
            "",
            serde_json::json!({"path": "a.ts", "summary": "x"}),
        );
        append(
            &store,
            &p,
            EventKind::FileChanged,
            "",
            serde_json::json!({"path": "a.ts", "summary": "y"}),
        );
        append(
            &store,
            &p,
            EventKind::FileChanged,
            "",
            serde_json::json!({"path": "b.ts", "summary": "z"}),
        );
        let s = store.get_state(&p);
        assert_eq!(s.recent_changes.len(), 2);
        assert_eq!(
            s.recent_changes
                .iter()
                .find(|c| c.path == "a.ts")
                .unwrap()
                .summary,
            "y"
        );
    }

    #[test]
    fn project_id_stable_across_trailing_slash() {
        let store = SharedMemoryStore::new();
        assert_eq!(
            store.project_id_for("/Users/x/proj"),
            store.project_id_for("/Users/x/proj/")
        );
        assert_eq!(store.project_id_for("/Users/x/proj").len(), 12);
    }

    #[test]
    fn decision_display_caps_length() {
        let (store, p) = (SharedMemoryStore::new(), temp_project("caps"));
        for i in 1..=record::CAP_DECISIONS + 10 {
            append(
                &store,
                &p,
                EventKind::Decision,
                &format!("k{i}"),
                serde_json::json!({"text": format!("d{i}")}),
            );
        }
        assert_eq!(store.get_state(&p).decisions.len(), record::CAP_DECISIONS);
        // Storage keeps every one of them.
        assert_eq!(
            store_for(&p).unwrap().count(EntryKind::Decision).unwrap(),
            record::CAP_DECISIONS + 10
        );
    }

    /// Every writer announces its write: a manual append, a session's start
    /// and end, and a clear — each with the scope root and what it touched.
    #[test]
    fn every_write_announces_a_change() {
        let (store, p) = (SharedMemoryStore::new(), temp_project("changed"));
        let heard = Arc::new(Mutex::new(Vec::<MemoryChanged>::new()));
        store.on_change({
            let heard = heard.clone();
            Arc::new(move |change: &MemoryChanged| heard.lock().push(change.clone()))
        });

        append(
            &store,
            &p,
            EventKind::Decision,
            "db",
            serde_json::json!({"text": "Postgres"}),
        );
        store.session_started("s9", "codex", &p);
        store.session_started("s9", "codex", &p); // a rebind: already live, no second start
        store.session_ended("s9");
        store.session_ended("s9"); // already ended: no write, no announcement
        store.clear(&p).unwrap();

        let root = Path::new(&p)
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let heard = heard.lock().clone();
        assert!(heard.iter().all(|c| c.root == root), "{heard:?}");
        let kinds: Vec<Vec<String>> = heard.into_iter().map(|c| c.kinds).collect();
        assert_eq!(
            kinds,
            vec![
                vec!["decision".to_string()],
                vec!["session".to_string()],
                vec!["session".to_string()],
                [
                    "plan",
                    "decision",
                    "file_changed",
                    "fact",
                    "failure",
                    "architecture",
                    "session"
                ]
                .map(String::from)
                .to_vec(),
            ]
        );
    }

    /// A session's end says where the session lived — what the end-of-session
    /// extraction needs — and only the first time.
    #[test]
    fn a_session_end_names_the_ended_session_once() {
        let (store, p) = (SharedMemoryStore::new(), temp_project("ended"));
        assert!(store.session_ended("never-started").is_none());
        store.session_started("s1", "codex", &p);
        let ended = store.session_ended("s1").expect("a started session ends");
        assert_eq!(
            (ended.cwd.as_str(), ended.agent.as_str()),
            (p.as_str(), "codex")
        );
        assert!(store.session_ended("s1").is_none());
    }

    /// The event name and payload shape the Shared tab listens for.
    #[test]
    fn the_change_payload_is_root_and_kinds() {
        let change = MemoryChanged {
            root: "/repo".into(),
            kinds: vec!["plan".into()],
        };
        assert_eq!(MEMORY_CHANGED_EVENT, "atlas:memory-changed");
        assert_eq!(
            serde_json::to_value(&change).unwrap(),
            serde_json::json!({"root": "/repo", "kinds": ["plan"]})
        );
    }

    fn writer(agent: &str) -> Writer {
        Writer {
            agent: agent.into(),
            session_id: format!("{agent}-s"),
        }
    }

    /// Every entry on the Shared tab says who wrote it and how sure it is:
    /// an agent's capture, the extractor's model confidence, an import.
    #[test]
    fn entries_carry_provenance_and_confidence() {
        let (store, p) = (
            SharedMemoryStore::with_clock(Arc::new(|| 7_000)),
            temp_project("provenance"),
        );
        append(
            &store,
            &p,
            EventKind::Decision,
            "db",
            serde_json::json!({"text": "Postgres"}),
        );
        store
            .record_extracted(
                &p,
                &writer("codex"),
                EntryKind::Failure,
                "Mocking the DB hid a migration bug",
                0.6,
            )
            .unwrap();
        store_for(&p)
            .unwrap()
            .upsert(NewEntry {
                kind: EntryKind::Fact,
                key: String::new(),
                content: "Prefers small PRs".into(),
                source: "import:claude".into(),
                agent: String::new(),
                session_id: String::new(),
                confidence: 0.7,
                at: 6_000,
            })
            .unwrap();

        let entries = store.entries(&p);
        let by = |content: &str| {
            entries
                .iter()
                .find(|e| e.content == content)
                .unwrap()
                .clone()
        };
        let decision = by("Postgres");
        assert_eq!(
            (
                decision.source.as_str(),
                decision.agent.as_str(),
                decision.confidence
            ),
            ("claude-code", "claude-code", 1.0)
        );
        let failure = by("Mocking the DB hid a migration bug");
        assert_eq!(
            (
                failure.source.as_str(),
                failure.agent.as_str(),
                failure.confidence
            ),
            ("extractor", "codex", 0.6)
        );
        let fact = by("Prefers small PRs");
        assert_eq!(
            (fact.source.as_str(), fact.agent.as_str(), fact.confidence),
            ("import:claude", "", 0.7)
        );
        // Newest write first.
        assert_eq!(entries[0].content, "Mocking the DB hid a migration bug");

        let json = serde_json::to_value(&failure).unwrap();
        for field in [
            "id",
            "kind",
            "key",
            "content",
            "source",
            "agent",
            "sessionId",
            "confidence",
            "createdAt",
            "updatedAt",
            "uses",
        ] {
            assert!(json.get(field).is_some(), "missing {field}: {json}");
        }
        assert_eq!(json["kind"], "failure");
        assert_eq!(json["sessionId"], "codex-s");
    }

    /// An edit from the panel rewrites the entry as the user, at full
    /// confidence, shows in the state view, and is announced.
    #[test]
    fn a_user_edit_updates_the_entry_and_is_announced() {
        let (store, p) = (SharedMemoryStore::new(), temp_project("user-edit"));
        let heard = Arc::new(Mutex::new(Vec::<MemoryChanged>::new()));
        store.on_change({
            let heard = heard.clone();
            Arc::new(move |change: &MemoryChanged| heard.lock().push(change.clone()))
        });
        append(
            &store,
            &p,
            EventKind::Decision,
            "auth.alg",
            serde_json::json!({"text": "HS256"}),
        );
        let id = store.entries(&p)[0].id;

        let edited = store.edit_entry(&p, id, "RS256").unwrap();
        assert_eq!(
            (
                edited.content.as_str(),
                edited.source.as_str(),
                edited.confidence
            ),
            ("RS256", "user", 1.0)
        );
        let state = store.get_state(&p);
        assert_eq!(state.decisions.len(), 1);
        assert_eq!(
            (
                state.decisions[0].text.as_str(),
                state.decisions[0].agent.as_str()
            ),
            ("RS256", "user")
        );
        assert_eq!(
            heard.lock().last().unwrap().kinds,
            vec!["decision".to_string()]
        );

        assert!(store.edit_entry(&p, 9_999, "x").is_err(), "no such entry");
    }

    /// Forgetting from the panel removes the entry from the state view, from
    /// entry search (memory_search, retrieval) and from the log's query.
    #[test]
    fn forgetting_an_entry_removes_it_from_state_and_search() {
        let (store, p) = (SharedMemoryStore::new(), temp_project("user-forget"));
        append(
            &store,
            &p,
            EventKind::Fact,
            "",
            serde_json::json!({"text": "The staging DB is on port 6543"}),
        );
        append(
            &store,
            &p,
            EventKind::Fact,
            "",
            serde_json::json!({"text": "Deploys go through Fly"}),
        );
        let id = store
            .entries(&p)
            .iter()
            .find(|e| e.content.contains("6543"))
            .unwrap()
            .id;

        assert!(store.forget_entry(&p, id).unwrap());
        assert!(!store.forget_entry(&p, id).unwrap(), "already gone");

        let state = store.get_state(&p);
        assert_eq!(
            state
                .facts
                .iter()
                .map(|f| f.text.as_str())
                .collect::<Vec<_>>(),
            vec!["Deploys go through Fly"]
        );
        assert!(store.query(&p, "6543", 20).is_empty());
        assert!(store
            .search_entries(&p, "staging port 6543", &[], 10)
            .is_empty());
        assert!(durable_entries(&p)
            .1
            .iter()
            .all(|e| !e.content.contains("6543")));
        assert!(store.entries(&p).iter().all(|e| e.id != id));
        // The rest of the tab is untouched.
        assert_eq!(store.query(&p, "fly", 20).len(), 1);
    }

    #[test]
    fn session_start_tracks_agent() {
        let (store, p) = (SharedMemoryStore::new(), temp_project("session"));
        store
            .append_event(
                &p,
                RawEvent {
                    agent: "codex".into(),
                    session_id: "abc".into(),
                    kind: EventKind::SessionStart,
                    key: String::new(),
                    payload: serde_json::json!({}),
                },
            )
            .unwrap();
        let s = store.get_state(&p);
        assert_eq!(
            s.session_agents.get("abc").map(std::string::String::as_str),
            Some("codex")
        );
    }
}

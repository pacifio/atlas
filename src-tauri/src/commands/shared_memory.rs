//! Shared Cross-Agent Memory (v2) — append-only event log + derived state view.
//!
//! Every agent on a project (Claude, Codex, opencode) is a separate ACP
//! subprocess with its own isolated context window. This module is the shared
//! memory **bus** between them: a per-project append-only event log
//! (`.atlas/shared-memory/events.jsonl`) continuously fed by every agent's
//! output, folded into a bounded "current truth" view
//! (`.atlas/shared-memory/state.json`) that agents read.
//!
//! Design (see `shared-cross-agent-memory.prd.md`):
//! - **Single backend writer.** One Tauri backend owns every agent subprocess
//!   and is the sole writer, so an in-process `Mutex` per project is enough —
//!   no SQLite / cross-process locking needed at this volume.
//! - **Typed events, not raw transcript.** Capture (`super::memory_delta`)
//!   classifies ACP deltas into `EventKind`s; raw turns stay session-local.
//! - **Supersession + dedup at fold time** keeps the view small and
//!   non-contradictory (a newer decision on the same `key` replaces the old).
//!
//! The store is `Clone` (an `Arc<Inner>`, mirroring `AgentManager`) so the hot
//! `DeltaSink::emit` path can grab it from Tauri state and route a capture
//! without holding a `State` borrow.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

/// Max entries retained per bucket in the derived view (older ones evicted).
const MAX_DECISIONS: usize = 50;
const MAX_CHANGES: usize = 50;
const MAX_FACTS: usize = 50;
const MAX_FAILURES: usize = 30;
const MAX_ARCH: usize = 30;

// ── Event model ──────────────────────────────────────────────────────────────

/// Typed kinds captured into the shared log. Free-form transcript never enters
/// the store — only these structured signals.
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
    /// Catches any kind string this build doesn't recognize — e.g. a retired
    /// kind (like the old `skill_used`) still sitting in an existing
    /// project's `events.jsonl`. Without this, `serde_json::from_str` fails
    /// the WHOLE line on an unknown `kind`, `filter_map(..).ok()` drops it
    /// silently, and if it happened to be the log's last event, the derived
    /// `last_seq` regresses behind the true file tail — the next appended
    /// event then reuses a `seq` still on disk. Folding this into no view
    /// bucket (below) makes it inert either way, but at least `seq` stays
    /// continuous across the upgrade.
    #[serde(other)]
    Unknown,
}

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

/// A persisted event (one JSONL line). Returned by queries.
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

/// The compiled "current truth", rebuilt by folding the event log.
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

impl SharedState {
    /// Fold one event into the view, applying supersession/dedup/eviction.
    fn apply(&mut self, ev: &MemoryEvent) {
        self.last_seq = self.last_seq.max(ev.seq);
        self.updated_at = ev.ts;
        match ev.kind {
            EventKind::PlanSet => {
                let text = ev
                    .payload
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let status = ev
                    .payload
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("active")
                    .to_string();
                if status == "abandoned" || status == "done" {
                    // Completed/abandoned plan: clear the active pointer.
                    self.active_plan = None;
                } else if !text.is_empty() {
                    self.active_plan = Some(PlanView {
                        seq: ev.seq,
                        agent: ev.agent.clone(),
                        text,
                        status,
                    });
                }
            }
            EventKind::Decision => {
                let text = payload_text(ev);
                if text.is_empty() {
                    return;
                }
                // Supersede by key (or dedup by text when keyless).
                self.decisions
                    .retain(|d| !dedup_match(&d.key, &d.text, &ev.key, &text));
                self.decisions.push(DecisionView {
                    seq: ev.seq,
                    agent: ev.agent.clone(),
                    key: ev.key.clone(),
                    text,
                });
                trim_front(&mut self.decisions, MAX_DECISIONS);
            }
            EventKind::FileChanged => {
                let path = ev
                    .payload
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&ev.key)
                    .to_string();
                let summary = ev
                    .payload
                    .get("summary")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if path.is_empty() {
                    return;
                }
                self.recent_changes.retain(|c| c.path != path);
                self.recent_changes.push(ChangeView {
                    seq: ev.seq,
                    agent: ev.agent.clone(),
                    path,
                    summary,
                });
                trim_front(&mut self.recent_changes, MAX_CHANGES);
            }
            EventKind::Fact => {
                let text = payload_text(ev);
                if text.is_empty() {
                    return;
                }
                self.facts
                    .retain(|f| !dedup_match("", &f.text, "", &text));
                self.facts.push(FactView {
                    seq: ev.seq,
                    agent: ev.agent.clone(),
                    text,
                });
                trim_front(&mut self.facts, MAX_FACTS);
            }
            EventKind::Failure => {
                let text = payload_text(ev);
                if text.is_empty() {
                    return;
                }
                self.failures
                    .retain(|f| !dedup_match(&f.text, &f.text, &ev.key, &text));
                self.failures.push(FactView {
                    seq: ev.seq,
                    agent: ev.agent.clone(),
                    text,
                });
                trim_front(&mut self.failures, MAX_FAILURES);
            }
            EventKind::Architecture => {
                let text = payload_text(ev);
                if text.is_empty() {
                    return;
                }
                self.architecture
                    .retain(|a| !dedup_match(&a.text, &a.text, &ev.key, &text));
                self.architecture.push(FactView {
                    seq: ev.seq,
                    agent: ev.agent.clone(),
                    text,
                });
                trim_front(&mut self.architecture, MAX_ARCH);
            }
            EventKind::SessionStart => {
                self.session_agents
                    .insert(ev.session_id.clone(), ev.agent.clone());
            }
            EventKind::SessionEnd | EventKind::TodoAdded | EventKind::TodoDone => {
                // Recorded in the log for audit; no view projection in MVP.
            }
            EventKind::Unknown => {
                // Kept only to advance `last_seq`; no view projection.
            }
        }
    }
}

fn payload_text(ev: &MemoryEvent) -> String {
    ev.payload
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// True when a stored entry should be replaced by an incoming one: same
/// non-empty key, or (keyless) identical normalized text. This is both the
/// supersession rule and the content-hash echo guard.
fn dedup_match(stored_key: &str, stored_text: &str, new_key: &str, new_text: &str) -> bool {
    if !new_key.is_empty() && stored_key == new_key {
        return true;
    }
    normalize(stored_text) == normalize(new_text)
}

fn normalize(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn trim_front<T>(v: &mut Vec<T>, max: usize) {
    if v.len() > max {
        let drop = v.len() - max;
        v.drain(0..drop);
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

struct Inner {
    /// Compiled view cache, keyed by absolute project path.
    states: Mutex<HashMap<String, SharedState>>,
    /// Per-project append serializer (sole-writer invariant is per-process;
    /// this guards against two async tasks racing the same project file).
    file_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// cwd → project id cache.
    id_cache: Mutex<HashMap<String, String>>,
    /// session_id → routing metadata (populated by `agents_send`).
    sessions: Mutex<HashMap<String, SessionMeta>>,
}

/// Cheaply-cloneable handle to the shared-memory store (Arc inside, like
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
        Self {
            inner: Arc::new(Inner {
                states: Mutex::new(HashMap::new()),
                file_locks: Mutex::new(HashMap::new()),
                id_cache: Mutex::new(HashMap::new()),
                sessions: Mutex::new(HashMap::new()),
            }),
        }
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
        let path = project_json_path(project_path);
        if path.exists() {
            return;
        }
        let id = self.project_id_for(project_path);
        let payload = serde_json::json!({ "projectId": id }).to_string();
        let _ = atomic_write(&path, &payload);
    }

    // ── Append + fold ────────────────────────────────────────────────────────

    fn lock_for(&self, project_path: &str) -> Arc<Mutex<()>> {
        let mut locks = self.inner.file_locks.lock();
        locks
            .entry(project_path.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Load the view from cache, else rebuild from `events.jsonl` (and cache it).
    fn load_state(&self, project_path: &str) -> SharedState {
        if let Some(s) = self.inner.states.lock().get(project_path) {
            return s.clone();
        }
        let rebuilt = rebuild_state(project_path);
        self.inner
            .states
            .lock()
            .insert(project_path.to_string(), rebuilt.clone());
        rebuilt
    }

    /// Append one typed event, fold it into the view, and atomically persist
    /// both files. Returns the assigned `seq`. Errors are propagated so the
    /// caller can decide; capture treats them as best-effort.
    pub fn append_event(&self, project_path: &str, raw: RawEvent) -> Result<u64, String> {
        let guard = self.lock_for(project_path);
        let _held = guard.lock();

        self.ensure_project_file(project_path);
        let mut state = self.load_state(project_path);
        let seq = state.last_seq + 1;
        let event = MemoryEvent {
            seq,
            ts: now_ms(),
            agent: raw.agent,
            session_id: raw.session_id,
            kind: raw.kind,
            key: raw.key,
            payload: raw.payload,
        };

        // Append the JSONL line.
        let line = serde_json::to_string(&event).map_err(|e| e.to_string())?;
        append_line(&events_path(project_path), &line)?;

        // Fold + persist the derived view.
        state.apply(&event);
        atomic_write(
            &state_path(project_path),
            &serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?,
        )?;
        self.inner
            .states
            .lock()
            .insert(project_path.to_string(), state);
        Ok(seq)
    }

    pub fn last_seq(&self, project_path: &str) -> u64 {
        self.load_state(project_path).last_seq
    }

    pub fn get_state(&self, project_path: &str) -> SharedState {
        self.load_state(project_path)
    }

    /// Substring/keyword search over the event log (newest-first, capped).
    pub fn query(&self, project_path: &str, query: &str, limit: usize) -> Vec<MemoryEvent> {
        let q = query.trim().to_lowercase();
        let mut events = read_events(project_path);
        if !q.is_empty() {
            events.retain(|e| {
                e.payload.to_string().to_lowercase().contains(&q)
                    || e.key.to_lowercase().contains(&q)
                    || e.agent.to_lowercase().contains(&q)
            });
        }
        events.reverse(); // newest-first
        events.truncate(limit.max(1));
        events
    }

    /// Newest events (capped) — backs the Memory panel's events table. The log
    /// is append-only and written by every agent turn, so returning it whole
    /// was an unbounded JSON payload across IPC plus an unbounded DOM table on
    /// long-lived projects (the same failure shape as the old codebase-corpus
    /// Memory-tab slowdown). 500 mirrors the Timeline's BOARD_LIMIT.
    pub fn list_events(&self, project_path: &str) -> Vec<MemoryEvent> {
        const EVENTS_LIMIT: usize = 500;
        let mut events = read_events(project_path);
        events.reverse(); // newest-first
        events.truncate(EVENTS_LIMIT);
        events
    }

    /// Wipe a project's shared memory (log, view, cached state).
    pub fn clear(&self, project_path: &str) -> Result<(), String> {
        let guard = self.lock_for(project_path);
        let _held = guard.lock();
        let _ = fs::remove_file(events_path(project_path));
        let _ = fs::remove_file(state_path(project_path));
        self.inner.states.lock().remove(project_path);
        Ok(())
    }
}

// ── Disk helpers ─────────────────────────────────────────────────────────────

fn shared_dir(project_path: &str) -> PathBuf {
    Path::new(project_path).join(".atlas").join("shared-memory")
}

fn events_path(project_path: &str) -> PathBuf {
    shared_dir(project_path).join("events.jsonl")
}

fn state_path(project_path: &str) -> PathBuf {
    shared_dir(project_path).join("state.json")
}

fn project_json_path(project_path: &str) -> PathBuf {
    Path::new(project_path).join(".atlas").join("project.json")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Append a single newline-terminated line, creating parent dirs as needed.
fn append_line(path: &Path, line: &str) -> Result<(), String> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())
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

fn read_events(project_path: &str) -> Vec<MemoryEvent> {
    let Ok(raw) = fs::read_to_string(events_path(project_path)) else {
        return Vec::new();
    };
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<MemoryEvent>(l).ok())
        .collect()
}

/// Pure fold of the whole log into the current view. Used on cache miss.
pub fn rebuild_state(project_path: &str) -> SharedState {
    fold_events(read_events(project_path))
}

/// Pure: fold a list of events into a [`SharedState`] (unit-testable).
pub fn fold_events(events: Vec<MemoryEvent>) -> SharedState {
    let mut state = SharedState::default();
    for ev in &events {
        state.apply(ev);
    }
    state
}

// ── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn memory_get_state(
    project_path: String,
    store: State<'_, SharedMemoryStore>,
) -> Result<SharedState, String> {
    Ok(store.get_state(&project_path))
}

#[tauri::command]
pub fn memory_query(
    project_path: String,
    query: String,
    limit: Option<usize>,
    store: State<'_, SharedMemoryStore>,
) -> Result<Vec<MemoryEvent>, String> {
    Ok(store.query(&project_path, &query, limit.unwrap_or(20)))
}

#[tauri::command]
pub fn memory_list_events(
    project_path: String,
    store: State<'_, SharedMemoryStore>,
) -> Result<Vec<MemoryEvent>, String> {
    Ok(store.list_events(&project_path))
}

#[tauri::command]
pub fn memory_clear_project(
    project_path: String,
    store: State<'_, SharedMemoryStore>,
) -> Result<(), String> {
    store.clear(&project_path)
}

/// Manual structured write — used by tests, the UI, and (later) an agent
/// write-tool. `kind` must be a snake_case [`EventKind`].
#[tauri::command]
pub fn memory_append_event(
    project_path: String,
    agent: String,
    session_id: String,
    kind: EventKind,
    key: Option<String>,
    payload: serde_json::Value,
    store: State<'_, SharedMemoryStore>,
) -> Result<u64, String> {
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
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(seq: u64, kind: EventKind, key: &str, payload: serde_json::Value) -> MemoryEvent {
        MemoryEvent {
            seq,
            ts: seq as i64 * 1000,
            agent: "claude-code".into(),
            session_id: "s1".into(),
            kind,
            key: key.into(),
            payload,
        }
    }

    #[test]
    fn plan_set_supersedes() {
        let events = vec![
            ev(1, EventKind::PlanSet, "plan", serde_json::json!({"text": "Plan A"})),
            ev(2, EventKind::PlanSet, "plan", serde_json::json!({"text": "Plan B"})),
        ];
        let s = fold_events(events);
        assert_eq!(s.active_plan.unwrap().text, "Plan B");
        assert_eq!(s.last_seq, 2);
    }

    #[test]
    fn plan_abandoned_clears() {
        let events = vec![
            ev(1, EventKind::PlanSet, "plan", serde_json::json!({"text": "Plan A"})),
            ev(2, EventKind::PlanSet, "plan", serde_json::json!({"text": "Plan A", "status": "done"})),
        ];
        assert!(fold_events(events).active_plan.is_none());
    }

    #[test]
    fn decision_supersedes_by_key() {
        let events = vec![
            ev(1, EventKind::Decision, "auth.alg", serde_json::json!({"text": "HS256"})),
            ev(2, EventKind::Decision, "auth.alg", serde_json::json!({"text": "RS256"})),
            ev(3, EventKind::Decision, "db", serde_json::json!({"text": "Postgres"})),
        ];
        let s = fold_events(events);
        assert_eq!(s.decisions.len(), 2);
        assert!(s.decisions.iter().any(|d| d.key == "auth.alg" && d.text == "RS256"));
        assert!(!s.decisions.iter().any(|d| d.text == "HS256"));
    }

    #[test]
    fn decision_dedup_by_text_when_keyless() {
        let events = vec![
            ev(1, EventKind::Decision, "", serde_json::json!({"text": "Use   RS256"})),
            ev(2, EventKind::Decision, "", serde_json::json!({"text": "use rs256"})),
        ];
        assert_eq!(fold_events(events).decisions.len(), 1);
    }

    #[test]
    fn file_changed_dedups_by_path() {
        let events = vec![
            ev(1, EventKind::FileChanged, "", serde_json::json!({"path": "a.ts", "summary": "x"})),
            ev(2, EventKind::FileChanged, "", serde_json::json!({"path": "a.ts", "summary": "y"})),
            ev(3, EventKind::FileChanged, "", serde_json::json!({"path": "b.ts", "summary": "z"})),
        ];
        let s = fold_events(events);
        assert_eq!(s.recent_changes.len(), 2);
        assert_eq!(s.recent_changes.iter().find(|c| c.path == "a.ts").unwrap().summary, "y");
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
    fn decision_eviction_caps_length() {
        let events: Vec<MemoryEvent> = (1..=MAX_DECISIONS as u64 + 10)
            .map(|i| ev(i, EventKind::Decision, &format!("k{i}"), serde_json::json!({"text": format!("d{i}")})))
            .collect();
        assert_eq!(fold_events(events).decisions.len(), MAX_DECISIONS);
    }

    #[test]
    fn session_start_tracks_agent() {
        let mut e = ev(1, EventKind::SessionStart, "", serde_json::json!({}));
        e.session_id = "abc".into();
        e.agent = "codex".into();
        let s = fold_events(vec![e]);
        assert_eq!(s.session_agents.get("abc").map(|x| x.as_str()), Some("codex"));
    }
}

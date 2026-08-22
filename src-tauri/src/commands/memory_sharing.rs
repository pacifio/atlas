//! Shared Cross-Agent Memory — per-project settings + first-send tracking.
//!
//! The feature injects Atlas's already-unified per-project memory (curated fact
//! pack + recent-session handoff) into an agent's prompt on the **first send**
//! of a session, so a freshly-switched agent (Claude → Codex, or a new session)
//! inherits the conventions and context the previous agent learned. The actual
//! pack/handoff building lives in [`super::memory_pack`]; the optional provider
//! summarization in [`super::memory_summarize`]; the injection call site is
//! `agents_send` in [`super::agents`].
//!
//! This module owns the *state* and *settings*:
//! - [`MemorySharingState`] — in-memory tracking of which sessions have already
//!   had their first send (so turns 2..N are zero-overhead) plus a write-through
//!   cache of the per-project enable toggle.
//! - Two per-project JSON files under `.atlas/` (atomic-written, mirroring the
//!   `plans.rs` / `canvas.rs` convention):
//!     - `.atlas/memory-sharing.json`     → `{ "enabled": bool }` (default true)
//!     - `.atlas/memory-summarizer.json`  → [`SummarizerPref`]
//!
//! State uses `parking_lot::Mutex` + `HashMap`/`HashSet` to match the existing
//! `ModelChatState` pattern (no `dashmap` dependency in `src-tauri`).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use atlas_agents::SessionKey;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::State;

/// Default when no `.atlas/memory-sharing.json` exists: sharing is ON, so users
/// who never open the Memory panel still get cross-agent memory automatically.
const DEFAULT_ENABLED: bool = true;

// ── Summarizer preference ────────────────────────────────────────────────────

/// Per-project handoff-summarizer preference, persisted to
/// `.atlas/memory-summarizer.json`. `mode` is `"raw"` (verbatim tail, the MVP
/// default), `"provider"` (BYOK one-shot summary), or `"local"` (Phase 5 —
/// shown in the UI but currently falls back to raw).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummarizerPref {
    pub mode: String,
    pub provider: String,
    pub model: String,
}

impl Default for SummarizerPref {
    fn default() -> Self {
        Self {
            mode: "raw".into(),
            provider: String::new(),
            model: String::new(),
        }
    }
}

// ── On-disk shape for the toggle file ────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SharingFile {
    enabled: bool,
}

// ── Path helpers ─────────────────────────────────────────────────────────────

fn atlas_dir(project_path: &str) -> PathBuf {
    Path::new(project_path).join(".atlas")
}

fn sharing_path(project_path: &str) -> PathBuf {
    atlas_dir(project_path).join("memory-sharing.json")
}

fn summarizer_path(project_path: &str) -> PathBuf {
    atlas_dir(project_path).join("memory-summarizer.json")
}

/// Atomic write: create `.atlas/`, write to a sibling `.tmp`, then rename over
/// the target (atomic on POSIX). Mirrors `plans.rs`.
fn atomic_write(path: &Path, payload: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, payload).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

fn read_sharing_enabled(project_path: &str) -> bool {
    let path = sharing_path(project_path);
    let Ok(raw) = fs::read_to_string(&path) else {
        return DEFAULT_ENABLED;
    };
    serde_json::from_str::<SharingFile>(&raw)
        .map(|f| f.enabled)
        .unwrap_or(DEFAULT_ENABLED)
}

fn read_summarizer_pref(project_path: &str) -> SummarizerPref {
    let path = summarizer_path(project_path);
    let Ok(raw) = fs::read_to_string(&path) else {
        return SummarizerPref::default();
    };
    serde_json::from_str::<SummarizerPref>(&raw).unwrap_or_default()
}

// ── Managed state ────────────────────────────────────────────────────────────

/// In-memory state for the injection hot path. Registered once via `.manage()`.
#[derive(Default)]
pub struct MemorySharingState {
    /// Sessions that have already had their memory pack injected. Presence ⇒
    /// "not the first send" ⇒ skip the (relatively expensive) build entirely.
    first_sends: Mutex<HashSet<SessionKey>>,
    /// Write-through cache of the per-project enable toggle, keyed by absolute
    /// project path. Avoids a file read on every send.
    toggles: Mutex<HashMap<String, bool>>,
    /// Per-session sync clock for v2 Shared Memory: the last event `seq` this
    /// session has already had injected. 0 (or absent) ⇒ never synced, so the
    /// next send gets the full current shared state. See `super::memory_inject`.
    sync_clocks: Mutex<HashMap<SessionKey, u64>>,
    /// v3 Tier 2: index doc ids already injected into a session, so the same
    /// retrieved doc isn't re-pushed turn after turn.
    injected_docs: Mutex<HashMap<SessionKey, HashSet<String>>>,
}

impl MemorySharingState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether sharing is enabled for `project_path` (cache → file → default ON).
    pub fn is_enabled(&self, project_path: &str) -> bool {
        if let Some(v) = self.toggles.lock().get(project_path) {
            return *v;
        }
        let v = read_sharing_enabled(project_path);
        self.toggles.lock().insert(project_path.to_string(), v);
        v
    }

    /// True if this session has already had its first-send injection.
    pub fn already_sent(&self, key: &SessionKey) -> bool {
        self.first_sends.lock().contains(key)
    }

    /// Record that this session's injection has happened. Idempotent. Called
    /// only AFTER a successful pack build, so a transient build failure leaves
    /// the session eligible to retry on the next send.
    pub fn mark_sent(&self, key: &SessionKey) {
        self.first_sends.lock().insert(key.clone());
    }

    /// Read the per-project summarizer preference from disk (default = raw).
    /// Used by the injection path in `agents_send`.
    pub fn summarizer_pref(&self, project_path: &str) -> SummarizerPref {
        read_summarizer_pref(project_path)
    }

    /// Last shared-memory event `seq` this session has already seen (0 = never).
    pub fn clock_for(&self, key: &SessionKey) -> u64 {
        self.sync_clocks.lock().get(key).copied().unwrap_or(0)
    }

    /// Advance the session's sync clock after an injection. Monotonic.
    pub fn advance_clock(&self, key: &SessionKey, seq: u64) {
        let mut clocks = self.sync_clocks.lock();
        let entry = clocks.entry(key.clone()).or_insert(0);
        if seq > *entry {
            *entry = seq;
        }
    }

    /// Record that index doc `doc_id` was injected into `key`'s session; returns
    /// true the first time (caller should inject it), false on repeats. Dedup
    /// for the v3 Tier 2 retrieval-augmented push.
    pub fn note_index_doc(&self, key: &SessionKey, doc_id: &str) -> bool {
        self.injected_docs
            .lock()
            .entry(key.clone())
            .or_default()
            .insert(doc_id.to_string())
    }

    /// Update the toggle cache after a settings write so the next send sees it.
    fn set_enabled_cache(&self, project_path: &str, enabled: bool) {
        self.toggles
            .lock()
            .insert(project_path.to_string(), enabled);
    }
}

// ── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn memory_sharing_get(
    project_path: String,
    state: State<'_, MemorySharingState>,
) -> Result<bool, String> {
    Ok(state.is_enabled(&project_path))
}

#[tauri::command]
pub fn memory_sharing_set(
    project_path: String,
    enabled: bool,
    state: State<'_, MemorySharingState>,
) -> Result<(), String> {
    let payload =
        serde_json::to_string_pretty(&SharingFile { enabled }).map_err(|e| e.to_string())?;
    atomic_write(&sharing_path(&project_path), &payload)?;
    state.set_enabled_cache(&project_path, enabled);
    Ok(())
}

#[tauri::command]
pub fn memory_summarizer_get(project_path: String) -> Result<SummarizerPref, String> {
    Ok(read_summarizer_pref(&project_path))
}

#[tauri::command]
pub fn memory_summarizer_set(project_path: String, pref: SummarizerPref) -> Result<(), String> {
    let payload = serde_json::to_string_pretty(&pref).map_err(|e| e.to_string())?;
    atomic_write(&summarizer_path(&project_path), &payload)?;
    Ok(())
}

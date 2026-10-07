//! Shared memory — per-project settings.
//!
//! Two per-project JSON files under `.atlas/` (atomic-written, mirroring the
//! `plans.rs` / `canvas.rs` convention):
//!   - `.atlas/memory-sharing.json`     → `{ "enabled": bool }` (default true).
//!     Gates everything: whether a session is handed the memory tool server,
//!     whether its deltas are captured, whether the extractor runs.
//!   - `.atlas/memory-summarizer.json`  → [`SummarizerPref`], the model that
//!     summarises the recent-session handoff `memory_briefing` serves, and
//!     that routes the extractor.
//!
//! [`MemorySharingState`] is the write-through cache of the toggle, so the
//! send path and the server's gate never read a file per call.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

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
///
/// The same preference picks the extractor's model
/// (`super::memory_extract::route_for`): `provider` → this BYOK provider and
/// model; `local` → no extraction (reserved); anything else (`raw`, the
/// default, or `gateway`) → the Atlas gateway when signed in.
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
    atlas_profile::dir_in(Path::new(project_path))
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

/// The per-project toggle, cached. Registered once via `.manage()`.
#[derive(Default)]
pub struct MemorySharingState {
    /// Write-through cache of the per-project enable toggle, keyed by absolute
    /// project path. Avoids a file read on every send and every tool call.
    toggles: Mutex<HashMap<String, bool>>,
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

    /// Read the per-project summarizer preference from disk (default = raw).
    pub fn summarizer_pref(&self, project_path: &str) -> SummarizerPref {
        read_summarizer_pref(project_path)
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

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn memory_summarizer_set(project_path: String, pref: SummarizerPref) -> Result<(), String> {
    let payload = serde_json::to_string_pretty(&pref).map_err(|e| e.to_string())?;
    atomic_write(&summarizer_path(&project_path), &payload)?;
    Ok(())
}

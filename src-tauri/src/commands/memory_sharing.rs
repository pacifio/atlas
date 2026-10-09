//! Shared memory — per-project settings.
//!
//! Two per-project JSON files under `.atlas/` (atomic-written, mirroring the
//! `plans.rs` / `canvas.rs` convention):
//!   - `.atlas/memory-sharing.json`     → `{ "enabled": bool,
//!     "fromExternalSessions": bool }`. `enabled` (default true) gates
//!     everything: whether a session is handed the memory tool server,
//!     whether its deltas are captured, whether the extractor runs.
//!     `fromExternalSessions` (default false) additionally lets the extractor
//!     read the sessions the capture recorder imported from outside Atlas
//!     (a terminal agent's own transcript), which sends their conversation
//!     to the extraction model ([`MemorySharingState::extraction_reach`]).
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

/// Default for `fromExternalSessions`: OFF. Reading a session Atlas never
/// hosted sends a conversation the user did not have in Atlas to the
/// extraction model, so it is asked for, never assumed.
const DEFAULT_FROM_EXTERNAL_SESSIONS: bool = false;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharingFile {
    #[serde(default = "default_enabled")]
    enabled: bool,
    /// Absent in files written before the setting existed: off.
    #[serde(default = "default_from_external_sessions")]
    from_external_sessions: bool,
}

fn default_enabled() -> bool {
    DEFAULT_ENABLED
}

fn default_from_external_sessions() -> bool {
    DEFAULT_FROM_EXTERNAL_SESSIONS
}

impl Default for SharingFile {
    fn default() -> Self {
        Self {
            enabled: DEFAULT_ENABLED,
            from_external_sessions: DEFAULT_FROM_EXTERNAL_SESSIONS,
        }
    }
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

fn read_sharing_file(project_path: &str) -> SharingFile {
    let path = sharing_path(project_path);
    let Ok(raw) = fs::read_to_string(&path) else {
        return SharingFile::default();
    };
    serde_json::from_str::<SharingFile>(&raw).unwrap_or_default()
}

fn read_summarizer_pref(project_path: &str) -> SummarizerPref {
    let path = summarizer_path(project_path);
    let Ok(raw) = fs::read_to_string(&path) else {
        return SummarizerPref::default();
    };
    serde_json::from_str::<SummarizerPref>(&raw).unwrap_or_default()
}

// ── Managed state ────────────────────────────────────────────────────────────

/// The per-project toggles, cached. Registered once via `.manage()`.
#[derive(Default)]
pub struct MemorySharingState {
    /// Write-through cache of the per-project toggles, keyed by absolute
    /// project path. Avoids a file read on every send and every tool call.
    toggles: Mutex<HashMap<String, SharingFile>>,
}

impl MemorySharingState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Both toggles for `project_path` (cache → file → defaults).
    fn toggles(&self, project_path: &str) -> SharingFile {
        if let Some(v) = self.toggles.lock().get(project_path) {
            return *v;
        }
        let v = read_sharing_file(project_path);
        self.toggles.lock().insert(project_path.to_string(), v);
        v
    }

    /// Whether sharing is enabled for `project_path` (default ON).
    pub fn is_enabled(&self, project_path: &str) -> bool {
        self.toggles(project_path).enabled
    }

    /// Whether the user let extraction read `project_path`'s sessions
    /// imported from outside Atlas (default OFF). The stored choice alone;
    /// what extraction may read is [`Self::extraction_reach`].
    pub fn reads_external_sessions(&self, project_path: &str) -> bool {
        self.toggles(project_path).from_external_sessions
    }

    /// Which of the capture recorder's sessions memory extraction may read
    /// in `project_path`, and so send to the extraction model. The one place
    /// that decision is made: the imported (`external_jsonl`) sessions only
    /// when sharing is on AND the user turned `fromExternalSessions` on;
    /// otherwise only the sessions Atlas hosted.
    pub fn extraction_reach(&self, project_path: &str) -> super::memory_capture::Reach {
        let t = self.toggles(project_path);
        if t.enabled && t.from_external_sessions {
            super::memory_capture::Reach::WithImported
        } else {
            super::memory_capture::Reach::Hosted
        }
    }

    /// Read the per-project summarizer preference from disk (default = raw).
    pub fn summarizer_pref(&self, project_path: &str) -> SummarizerPref {
        read_summarizer_pref(project_path)
    }

    /// Persist the `fromExternalSessions` choice for `project_path`.
    pub fn set_from_external_sessions(&self, project_path: &str, on: bool) -> Result<(), String> {
        self.update(project_path, |f| f.from_external_sessions = on)
    }

    /// Change one toggle: read the file, apply `change`, write it back, then
    /// update the cache so the next send sees it. The other toggle keeps its
    /// stored value.
    fn update(
        &self,
        project_path: &str,
        change: impl FnOnce(&mut SharingFile),
    ) -> Result<(), String> {
        let mut file = read_sharing_file(project_path);
        change(&mut file);
        let payload = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
        atomic_write(&sharing_path(project_path), &payload)?;
        self.toggles.lock().insert(project_path.to_string(), file);
        Ok(())
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
    state.update(&project_path, |f| f.enabled = enabled)
}

/// Whether extraction also reads the sessions imported from outside Atlas
/// (`.atlas/memory-sharing.json` → `fromExternalSessions`, default false).
#[tauri::command]
pub fn memory_from_external_sessions_get(
    project_path: String,
    state: State<'_, MemorySharingState>,
) -> Result<bool, String> {
    Ok(state.reads_external_sessions(&project_path))
}

#[tauri::command(async)]
pub fn memory_from_external_sessions_set(
    project_path: String,
    enabled: bool,
    state: State<'_, MemorySharingState>,
) -> Result<(), String> {
    state.set_from_external_sessions(&project_path, enabled)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::memory_capture::Reach;

    fn project(label: &str) -> String {
        let dir =
            std::env::temp_dir().join(format!("atlas-sharing-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    /// Reading sessions imported from outside Atlas is off until asked for,
    /// and only reaches extraction while sharing itself is on.
    #[test]
    fn imported_sessions_are_read_only_when_both_toggles_are_on() {
        let p = project("reach");
        let state = MemorySharingState::new();
        assert!(state.is_enabled(&p));
        assert!(!state.reads_external_sessions(&p));
        assert_eq!(state.extraction_reach(&p), Reach::Hosted);

        state.set_from_external_sessions(&p, true).unwrap();
        assert_eq!(state.extraction_reach(&p), Reach::WithImported);

        state.update(&p, |f| f.enabled = false).unwrap();
        assert_eq!(
            state.extraction_reach(&p),
            Reach::Hosted,
            "sharing off wins"
        );
        assert!(state.reads_external_sessions(&p), "the choice is kept");
        let _ = fs::remove_dir_all(&p);
    }

    /// Each toggle round-trips through the file without touching the other,
    /// and a file written before the setting existed reads as off.
    #[test]
    fn the_toggles_round_trip_through_the_file_independently() {
        let p = project("roundtrip");
        fs::create_dir_all(atlas_dir(&p)).unwrap();
        fs::write(sharing_path(&p), r#"{ "enabled": false }"#).unwrap();
        let state = MemorySharingState::new();
        assert!(!state.is_enabled(&p));
        assert!(!state.reads_external_sessions(&p));

        state.set_from_external_sessions(&p, true).unwrap();
        let fresh = MemorySharingState::new();
        assert!(!fresh.is_enabled(&p), "enabled kept its stored value");
        assert!(fresh.reads_external_sessions(&p));
        let raw = fs::read_to_string(sharing_path(&p)).unwrap();
        assert!(raw.contains("\"fromExternalSessions\": true"), "{raw}");
        let _ = fs::remove_dir_all(&p);
    }
}

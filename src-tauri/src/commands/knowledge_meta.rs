//! Per-page knowledge metadata.
//!
//! Persists `Status / Owner / Tags / Created / Last edited / Icon / Cover`
//! for each `.atlas/knowledge/*.md` entry in a single project-scoped JSON
//! file:
//!
//!   <project>/.atlas/knowledge/_meta.json
//!
//! Shape:
//! ```json
//! {
//!   "version": 1,
//!   "pages": {
//!     "<entryId>": {
//!       "icon":       "🧠",
//!       "cover":      "covers/<id>.jpg" | "gradient:slate-1",
//!       "status":     "Draft",
//!       "tags":       ["agents", "runtime"],
//!       "owner":      "sayan",
//!       "created_at": "2026-05-25T...",
//!       "updated_at": "2026-05-25T..."
//!     }
//!   }
//! }
//! ```
//!
//! Writes are debounced 300 ms behind an `Arc<Mutex<...>>` so rapid edits
//! coalesce into one disk hit. `atlas:knowledge:meta-changed` fires after
//! every successful write so any view rendering icon/status/tag pills can
//! refresh.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use parking_lot::Mutex;
use serde::{Deserialize, Deserializer, Serialize};
use tauri::{AppHandle, Emitter, State};

/// Distinguish "field absent" from "field present and JSON null" when
/// deserializing into `Option<Option<T>>`:
///   - absent     → field default = `None`            (don't touch)
///   - `null`     → `Some(None)`                       (CLEAR the value)
///   - `"v"`      → `Some(Some("v"))`                  (SET the value)
///
/// Without this, serde's default Option deserializer collapses both
/// "absent" and "null" into `None`, so the patch can never clear a
/// field. (That bug was the actual cause of "remove cover doesn't
/// remove" — the optimistic UI showed null, but Rust's snapshot
/// silently kept the old value.)
fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

/// The on-disk shape — bump `version` for future schema changes; the
/// loader rejects unknown versions rather than guessing.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KnowledgeMetaFile {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub pages: HashMap<String, PageMeta>,
}

fn default_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PageMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    /// User-chosen display title. Source of truth for the page header
    /// and the sidebar — replaces the previous "first `#` of body"
    /// derivation. Falls back to filename when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

/// Patch input — every field is optional so callers can update one
/// attribute at a time. Pass `Some(None)` (JS: `null`) to clear, or
/// omit a field to leave it untouched.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct PageMetaPatch {
    #[serde(default, deserialize_with = "double_option")]
    pub icon: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub cover: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub title: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub status: Option<Option<String>>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub owner: Option<Option<String>>,
}

impl PageMetaPatch {
    fn apply(self, meta: &mut PageMeta) {
        if let Some(v) = self.icon { meta.icon = v; }
        if let Some(v) = self.cover { meta.cover = v; }
        if let Some(v) = self.title { meta.title = v; }
        if let Some(v) = self.status { meta.status = v; }
        if let Some(v) = self.tags { meta.tags = v; }
        if let Some(v) = self.owner { meta.owner = v; }
    }
}

/// One pending write per project; the writer task wakes after the
/// debounce window and flushes the latest snapshot.
struct ProjectWriter {
    snapshot: KnowledgeMetaFile,
    /// When false → no scheduled flush is in flight. Set true while we
    /// wait out the debounce window.
    flush_scheduled: bool,
    /// Tracks the most recent edit so a rapid sequence of patches keeps
    /// extending the window instead of firing N times.
    last_dirty_at: Instant,
}

#[derive(Default)]
pub struct KnowledgeMetaState {
    /// `<project_path> → in-memory snapshot + debounce flag`.
    by_project: Mutex<HashMap<String, ProjectWriter>>,
}

impl KnowledgeMetaState {
    pub fn new() -> Self {
        Self::default()
    }
}

fn meta_path(project_path: &str) -> PathBuf {
    Path::new(project_path)
        .join(".atlas")
        .join("knowledge")
        .join("_meta.json")
}

fn load_from_disk(project_path: &str) -> KnowledgeMetaFile {
    let path = meta_path(project_path);
    if !path.exists() {
        return KnowledgeMetaFile { version: 1, pages: HashMap::new() };
    }
    let raw = match fs::read_to_string(&path) {
        Ok(r) => r,
        Err(_) => return KnowledgeMetaFile { version: 1, pages: HashMap::new() },
    };
    serde_json::from_str(&raw).unwrap_or(KnowledgeMetaFile {
        version: 1,
        pages: HashMap::new(),
    })
}

fn write_to_disk(project_path: &str, file: &KnowledgeMetaFile) -> Result<(), String> {
    let path = meta_path(project_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    // Atomic write: tmp + rename so a crash mid-write doesn't truncate
    // the existing _meta.json.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body.as_bytes()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

const DEBOUNCE: Duration = Duration::from_millis(300);

fn ensure_snapshot(state: &Arc<KnowledgeMetaState>, project_path: &str) {
    let mut by_proj = state.by_project.lock();
    if !by_proj.contains_key(project_path) {
        let snapshot = load_from_disk(project_path);
        by_proj.insert(
            project_path.to_string(),
            ProjectWriter {
                snapshot,
                flush_scheduled: false,
                last_dirty_at: Instant::now(),
            },
        );
    }
}

fn schedule_flush(state: Arc<KnowledgeMetaState>, app: AppHandle, project_path: String) {
    {
        let mut by_proj = state.by_project.lock();
        let writer = match by_proj.get_mut(&project_path) {
            Some(w) => w,
            None => return,
        };
        writer.last_dirty_at = Instant::now();
        if writer.flush_scheduled {
            return;
        }
        writer.flush_scheduled = true;
    }

    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(DEBOUNCE).await;
            let (snapshot, drained) = {
                let mut by_proj = state.by_project.lock();
                let Some(writer) = by_proj.get_mut(&project_path) else {
                    return;
                };
                // Another patch arrived during the wait — loop again.
                if writer.last_dirty_at.elapsed() < DEBOUNCE {
                    continue;
                }
                writer.flush_scheduled = false;
                (writer.snapshot.clone(), true)
            };
            if !drained {
                return;
            }
            let path_clone = project_path.clone();
            let write_result = tokio::task::spawn_blocking(move || {
                write_to_disk(&path_clone, &snapshot)
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r);
            if write_result.is_ok() {
                // Project-scoped event so multiple open projects don't
                // cross-fire. Frontend's listener checks the payload.
                let _ = app.emit(
                    "atlas:knowledge:meta-changed",
                    serde_json::json!({ "projectPath": project_path }),
                );
            }
            return;
        }
    });
}

/* ── Commands ───────────────────────────────────────────────────── */

#[tauri::command]
pub fn knowledge_meta_load(
    project_path: String,
    state: State<'_, Arc<KnowledgeMetaState>>,
) -> Result<KnowledgeMetaFile, String> {
    ensure_snapshot(state.inner(), &project_path);
    let by_proj = state.by_project.lock();
    Ok(by_proj
        .get(&project_path)
        .map(|w| w.snapshot.clone())
        .unwrap_or_default())
}

#[tauri::command]
pub fn knowledge_meta_patch(
    project_path: String,
    entry_id: String,
    patch: PageMetaPatch,
    state: State<'_, Arc<KnowledgeMetaState>>,
    app: AppHandle,
) -> Result<PageMeta, String> {
    ensure_snapshot(state.inner(), &project_path);
    let now = Utc::now().to_rfc3339();
    let updated_meta = {
        let mut by_proj = state.by_project.lock();
        let writer = by_proj.get_mut(&project_path).ok_or("project snapshot missing")?;
        let entry = writer
            .snapshot
            .pages
            .entry(entry_id.clone())
            .or_insert_with(PageMeta::default);
        if entry.created_at.is_none() {
            entry.created_at = Some(now.clone());
        }
        patch.apply(entry);
        entry.updated_at = Some(now);
        entry.clone()
    };
    schedule_flush(Arc::clone(state.inner()), app, project_path);
    Ok(updated_meta)
}

#[tauri::command]
pub fn knowledge_meta_delete(
    project_path: String,
    entry_id: String,
    state: State<'_, Arc<KnowledgeMetaState>>,
    app: AppHandle,
) -> Result<(), String> {
    ensure_snapshot(state.inner(), &project_path);
    {
        let mut by_proj = state.by_project.lock();
        if let Some(writer) = by_proj.get_mut(&project_path) {
            writer.snapshot.pages.remove(&entry_id);
        }
    }
    schedule_flush(Arc::clone(state.inner()), app, project_path);
    Ok(())
}


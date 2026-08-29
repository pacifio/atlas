//! Per-project "recently opened files" queue. Owned by Rust so it
//! persists across app restarts (in `<project>/.atlas/recent-files.json`)
//! and survives project switches without the frontend needing to
//! manage two stores.
//!
//! State machine:
//!   - `recent_files_open_project(path)` — load the on-disk list,
//!     swap in as the active project, return current items.
//!   - `recent_files_push(abs_path, rel)` — dedupe by abs_path,
//!     bump to head, cap at 20, save (debounced), emit
//!     `atlas:recent-files-changed`.
//!   - `recent_files_list()` — current snapshot.
//!   - `recent_files_clear()` — empty + save + emit.
//!
//! The frontend listens for the event and mirrors locally; the JS
//! `recent-files-store` is a thin cache that rehydrates from Rust on
//! project change, never the source of truth.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

/// Hard cap on the queue length. Matches the previous JS-side `CAP = 20`.
const QUEUE_CAP: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub abs_path: String,
    /// Path relative to the project root, e.g. `src/foo.ts`. This is
    /// what the picker displays.
    pub rel: String,
    /// Unix milliseconds of the most-recent open.
    pub touched_at: i64,
}

struct ProjectRecents {
    root: PathBuf,
    items: Arc<RwLock<Vec<RecentFile>>>,
}

#[derive(Default)]
pub struct RecentFilesState {
    /// One queue per open workspace (keyed by workspace id), so multiple
    /// resident workspaces each keep their own recent-files list.
    per_workspace: RwLock<HashMap<String, ProjectRecents>>,
}

impl RecentFilesState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Clone the (root, items) handle for a workspace, if open.
    fn snapshot(&self, key: &str) -> Option<(PathBuf, Arc<RwLock<Vec<RecentFile>>>)> {
        self.per_workspace
            .read()
            .get(key)
            .map(|p| (p.root.clone(), p.items.clone()))
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn store_path(project_root: &Path) -> PathBuf {
    project_root.join(".atlas").join("recent-files.json")
}

fn load_from_disk(project_root: &Path) -> Vec<RecentFile> {
    let path = store_path(project_root);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Atomic write — `recent-files.json.tmp` + rename so a crash
/// mid-write doesn't leave a torn JSON file. Best-effort: any error
/// is logged and swallowed (the in-memory list is still correct;
/// next push will retry the write).
fn save_to_disk(project_root: &Path, items: &[RecentFile]) {
    let path = store_path(project_root);
    if let Some(dir) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(dir) {
            tracing::warn!(target: "atlas::recent_files", "mkdir failed: {e}");
            return;
        }
    }
    let tmp = path.with_extension("json.tmp");
    match serde_json::to_string_pretty(items) {
        Ok(raw) => {
            if let Err(e) = std::fs::write(&tmp, raw) {
                tracing::warn!(target: "atlas::recent_files", "write tmp failed: {e}");
                return;
            }
            if let Err(e) = std::fs::rename(&tmp, &path) {
                tracing::warn!(target: "atlas::recent_files", "rename failed: {e}");
            }
        }
        Err(e) => {
            tracing::warn!(target: "atlas::recent_files", "serialize failed: {e}");
        }
    }
}

fn emit_changed(app: &AppHandle, workspace_id: &str, project_root: &Path, items: &[RecentFile]) {
    let _ = app.emit(
        "atlas:recent-files-changed",
        serde_json::json!({
            "workspaceId": workspace_id,
            "project": project_root.to_string_lossy(),
            "items": items,
        }),
    );
}

/// Open (or replace) the active project. Loads `<project>/.atlas/recent-files.json`,
/// makes it the current state, and returns the items so the caller
/// can hydrate the UI without waiting for the change event.
#[tauri::command]
pub async fn recent_files_open_project(
    project_path: String,
    workspace_id: Option<String>,
    state: State<'_, RecentFilesState>,
) -> Result<Vec<RecentFile>, String> {
    let key = workspace_id.unwrap_or_else(|| project_path.clone());
    let root = PathBuf::from(&project_path);
    // Idempotent: a resident workspace's queue is already loaded — return it.
    if let Some((_, items_lock)) = state.snapshot(&key) {
        return Ok(items_lock.read().clone());
    }
    let items = tokio::task::spawn_blocking(move || load_from_disk(&PathBuf::from(&project_path)))
        .await
        .map_err(|e| e.to_string())?;
    let items_arc = Arc::new(RwLock::new(items.clone()));
    state.per_workspace.write().insert(
        key,
        ProjectRecents {
            root,
            items: items_arc,
        },
    );
    Ok(items)
}

#[tauri::command]
pub fn recent_files_close_project(
    workspace_id: Option<String>,
    state: State<'_, RecentFilesState>,
) {
    match workspace_id {
        Some(id) => {
            state.per_workspace.write().remove(&id);
        }
        None => state.per_workspace.write().clear(),
    }
}

/// Push a file onto the front of the queue. Dedupe by abs_path; cap
/// at `QUEUE_CAP`. Persists synchronously (cheap — the file is
/// tiny and writes are infrequent) and emits the change event.
///
/// Silently no-ops if no project is open or if the path doesn't
/// belong to the currently-active project (avoids cross-project
/// pollution during the brief window between switching projects
/// and the frontend dropping stale push intents).
#[tauri::command]
pub async fn recent_files_push(
    abs_path: String,
    rel: String,
    workspace_id: String,
    state: State<'_, RecentFilesState>,
    app: AppHandle,
) -> Result<Vec<RecentFile>, String> {
    let Some((root, items_lock)) = state.snapshot(&workspace_id) else {
        return Ok(Vec::new());
    };

    // Ignore pushes from outside the current project. Frontend tab
    // listeners can fire just after a project switch.
    if !abs_path.starts_with(&format!("{}/", root.to_string_lossy()))
        && abs_path != root.to_string_lossy()
    {
        return Ok(items_lock.read().clone());
    }

    let entry = RecentFile {
        abs_path: abs_path.clone(),
        rel,
        touched_at: now_ms(),
    };

    let updated: Vec<RecentFile> = {
        let mut w = items_lock.write();
        w.retain(|it| it.abs_path != abs_path);
        w.insert(0, entry);
        if w.len() > QUEUE_CAP {
            w.truncate(QUEUE_CAP);
        }
        w.clone()
    };

    let updated_for_disk = updated.clone();
    let root_for_disk = root.clone();
    tokio::task::spawn_blocking(move || save_to_disk(&root_for_disk, &updated_for_disk));

    emit_changed(&app, &workspace_id, &root, &updated);
    Ok(updated)
}

/// Re-point recent-files entries after a rename/move so the picker shows the
/// new name instead of a stale one. Handles a single file (`abs_path == old`)
/// and a directory rename (entries under `old/` are re-prefixed to `new/`).
#[tauri::command]
pub async fn recent_files_rename(
    old_path: String,
    new_path: String,
    workspace_id: String,
    state: State<'_, RecentFilesState>,
    app: AppHandle,
) -> Result<Vec<RecentFile>, String> {
    let Some((root, items_lock)) = state.snapshot(&workspace_id) else {
        return Ok(Vec::new());
    };

    let root_prefix = format!("{}/", root.to_string_lossy());
    let rel_of = |abs: &str| abs.strip_prefix(&root_prefix).unwrap_or(abs).to_string();
    let old_prefix = format!("{old_path}/");
    let new_prefix = format!("{new_path}/");

    let updated: Vec<RecentFile> = {
        let mut w = items_lock.write();
        for it in w.iter_mut() {
            if it.abs_path == old_path {
                it.abs_path = new_path.clone();
                it.rel = rel_of(&new_path);
            } else if it.abs_path.starts_with(&old_prefix) {
                let rest = it.abs_path[old_prefix.len()..].to_string();
                let np = format!("{new_prefix}{rest}");
                it.rel = rel_of(&np);
                it.abs_path = np;
            }
        }
        w.clone()
    };

    let updated_for_disk = updated.clone();
    let root_for_disk = root.clone();
    tokio::task::spawn_blocking(move || save_to_disk(&root_for_disk, &updated_for_disk));
    emit_changed(&app, &workspace_id, &root, &updated);
    Ok(updated)
}

#[tauri::command]
pub async fn recent_files_clear(
    workspace_id: String,
    state: State<'_, RecentFilesState>,
    app: AppHandle,
) -> Result<(), String> {
    let Some((root, items_lock)) = state.snapshot(&workspace_id) else {
        return Ok(());
    };
    items_lock.write().clear();
    let root_for_disk = root.clone();
    tokio::task::spawn_blocking(move || save_to_disk(&root_for_disk, &[]));
    emit_changed(&app, &workspace_id, &root, &[]);
    Ok(())
}

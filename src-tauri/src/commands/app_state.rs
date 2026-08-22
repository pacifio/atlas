//! Tauri command surface for the Rust-owned `AppState`.

use tauri::{AppHandle, State};

use crate::state::{AppState, AppStateHandle, AppStatePatch};

/// One-shot bootstrap: returns the full `AppState` snapshot. Called by the
/// frontend exactly once on app mount, before any UI that depends on
/// `currentProject` / `recentProjects` renders.
#[tauri::command]
pub fn bootstrap_app_state(state: State<'_, AppStateHandle>) -> AppState {
    state.lock().clone()
}

/// Merge a frontend save into the in-memory snapshot and persist it to disk.
/// The disk write runs on a background thread so the IPC reply isn't blocked on
/// fsync — this command resolves as soon as the in-memory state is updated. For
/// the frontend's purposes, that's "saved" — the on-disk copy converges within
/// milliseconds and is only needed on the next app launch.
///
/// Takes an [`AppStatePatch`], **not** an `AppState`: the payload is a subset of
/// the wire shape the frontend already sends, and taking the narrower type is
/// what stops a settings save from wiping Rust-owned fields. See that type's
/// doc for the analytics bug this prevents.
#[tauri::command]
pub fn save_app_state(
    payload: AppStatePatch,
    state: State<'_, AppStateHandle>,
    app: AppHandle,
) -> Result<(), String> {
    {
        let mut guard = state.lock();
        guard.apply_patch(payload);
    }
    let snapshot = state.lock().clone();
    std::thread::spawn(move || {
        if let Err(e) = AppState::save(&app, &snapshot) {
            tracing::warn!(target: "atlas::app_state", "save failed: {e}");
        }
    });
    Ok(())
}

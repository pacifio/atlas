//! No-op auto-updater stand-in for non-macOS targets.
//!
//! The real updater ([`crate::commands::updater`], gated to
//! `#[cfg(target_os = "macos")]`) mounts/verifies/swaps a signed `.app`
//! bundle — none of that has a Windows/Linux equivalent yet. This stub keeps
//! `lib.rs` and the frontend's `invoke()` surface platform-agnostic: every
//! command still exists and returns a well-formed "nothing to do" response
//! instead of failing to compile or erroring at call time.

use serde::Serialize;
use tauri::AppHandle;

/// The running app's version (compile-time), mirrored from the real impl so
/// `UpdaterSnapshot`/`UpdateStatus` payloads stay shaped the same.
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Default)]
pub struct UpdaterState;

impl UpdaterState {
    pub fn new() -> Self {
        Self
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub available: bool,
    pub version: Option<String>,
    pub current_version: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterSnapshot {
    pub phase: String,
    pub version: Option<String>,
    pub current_version: String,
}

pub fn init_on_startup(_app: &AppHandle) {}
pub fn check_in_background(_app: &AppHandle) {}
pub fn spawn_periodic(_app: &AppHandle) {}
pub fn apply_on_exit(_app: &AppHandle) {}

#[tauri::command]
pub async fn update_check_now() -> Result<UpdateStatus, String> {
    Ok(UpdateStatus {
        available: false,
        version: None,
        current_version: CURRENT_VERSION.to_string(),
    })
}

#[tauri::command]
pub fn update_state() -> UpdaterSnapshot {
    UpdaterSnapshot {
        phase: "idle".into(),
        version: None,
        current_version: CURRENT_VERSION.to_string(),
    }
}

#[tauri::command]
pub fn update_ignore(_version: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn update_apply() -> Result<(), String> {
    Err("auto-update isn't available on this platform yet".into())
}

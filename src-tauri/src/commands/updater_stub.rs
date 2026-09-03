//! No-op auto-updater stand-in for non-macOS targets.
//!
//! The real implementation (`updater_macos.rs`) mounts, verifies and swaps a
//! signed `.app` bundle — none of that has a Windows/Linux equivalent yet.
//! This stub keeps `lib.rs` and the frontend's `invoke()` surface
//! platform-agnostic: every verb still exists and reports "no update", so the
//! UI hydrates normally instead of showing a failed call.
//!
//! Signatures here mirror `updater_macos.rs` exactly — including the injected
//! `AppHandle`/`State` arguments and each function's asyncness — because
//! `updater.rs` calls both through one shared `#[tauri::command]` wrapper. A
//! change on one side that isn't mirrored here fails to compile on that
//! platform rather than drifting silently.

use tauri::{AppHandle, State};

use super::{UpdateStatus, UpdaterSnapshot};

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

pub fn init_on_startup(_app: &AppHandle) {}
pub fn check_in_background(_app: &AppHandle) {}
pub fn spawn_periodic(_app: &AppHandle) {}
pub fn apply_on_exit(_app: &AppHandle) {}

pub(super) async fn update_check_now(_app: AppHandle) -> Result<UpdateStatus, String> {
    Ok(UpdateStatus {
        available: false,
        version: None,
        current_version: CURRENT_VERSION.to_string(),
    })
}

pub(super) fn update_state(_app: AppHandle, _state: State<'_, UpdaterState>) -> UpdaterSnapshot {
    UpdaterSnapshot {
        phase: "idle".into(),
        version: None,
        current_version: CURRENT_VERSION.to_string(),
    }
}

pub(super) async fn update_ignore(_version: String, _app: AppHandle) -> Result<(), String> {
    // Nothing ever prompts on this platform, so there is no choice to persist.
    Ok(())
}

/// Deliberately an error rather than a silent `Ok`: nothing can stage an
/// update here, so a call means the UI reached a state it shouldn't have. The
/// frontend only exposes "Restart now" after an `atlas:update-ready` event,
/// which this platform never emits.
pub(super) async fn update_apply(_app: AppHandle) -> Result<(), String> {
    Err("auto-update isn't available on this platform yet".into())
}

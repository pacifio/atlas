//! In-app auto-updater — the IPC surface, plus platform dispatch.
//!
//! Atlas ships as an Apple-signed + notarized + stapled `.dmg` (no Tauri-updater
//! `.app.tar.gz`/minisign artifact), so we don't use the Tauri updater plugin.
//! That flow only makes sense on macOS — mounting a DMG, `codesign`/`spctl`
//! verification, and swapping an `.app` bundle have no Windows/Linux
//! equivalent — so the real implementation (`updater_macos.rs`) is compiled in
//! only there. Every other platform gets `updater_stub.rs`, a no-op carrying
//! the same signatures.
//!
//! The four `#[tauri::command]` verbs and the DTOs they return are declared
//! **here, once**, per the "IPC verbs grouped into a single
//! `commands/<domain>.rs`" convention in CONTRIBUTING.md. The platform modules
//! expose plain `pub(super)` functions with identical signatures, so the two
//! sides cannot drift: a change to one that isn't mirrored in the other stops
//! compiling on that platform instead of failing at runtime. Declaring the
//! commands once also keeps `tests/ipc-contract.test.ts` — which reads source
//! text and cannot evaluate `#[cfg]` — from seeing four duplicate handlers.
//!
//! See `updater_macos.rs` for the staged-update design, the `atlas:update-*`
//! event contract, and the Team-ID signature anchor.

use serde::Serialize;
use tauri::{AppHandle, State};

#[cfg(target_os = "macos")]
#[path = "updater_macos.rs"]
mod imp;

#[cfg(not(target_os = "macos"))]
#[path = "updater_stub.rs"]
mod imp;

/// Opaque per-platform updater state, `manage`d in `lib.rs`.
pub use imp::UpdaterState;

// Lifecycle hooks driven by `lib.rs`. These aren't IPC verbs, so they
// re-export directly rather than going through a wrapper.
pub use imp::{apply_on_exit, check_in_background, init_on_startup, spawn_periodic};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub available: bool,
    pub version: Option<String>,
    pub current_version: String,
}

/// UI-hydration snapshot (Settings / titlebar on mount).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterSnapshot {
    /// "idle" | "downloading" | "ready"
    pub phase: String,
    pub version: Option<String>,
    pub current_version: String,
}

/// Manual "Check for updates" — bypasses the auto_update / ignored gates (an
/// explicit user action). Triggers the background download when newer.
#[tauri::command]
pub async fn update_check_now(app: AppHandle) -> Result<UpdateStatus, String> {
    imp::update_check_now(app).await
}

/// Current updater state for UI hydration on mount.
#[tauri::command]
pub fn update_state(app: AppHandle, state: State<'_, UpdaterState>) -> UpdaterSnapshot {
    imp::update_state(app, state)
}

/// Persist a "don't prompt for this version again" choice.
#[tauri::command]
pub async fn update_ignore(version: String, app: AppHandle) -> Result<(), String> {
    imp::update_ignore(version, app).await
}

/// "Restart now": swap the staged `.app` over the running install and relaunch.
#[tauri::command]
pub async fn update_apply(app: AppHandle) -> Result<(), String> {
    imp::update_apply(app).await
}

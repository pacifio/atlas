//! In-app auto-updater — the IPC surface, plus platform dispatch.
//!
//! Atlas ships as an Apple-signed + notarized + stapled `.dmg` on macOS and a
//! WiX `.msi` on Windows (no Tauri-updater `.app.tar.gz`/minisign artifact),
//! so we don't use the Tauri updater plugin. Each platform has its own
//! implementation of the same staged design — `updater_macos.rs` mounts,
//! verifies and swaps an `.app` bundle; `updater_windows.rs` hands the MSI to
//! Windows Installer after the app quits — over one shared background
//! download engine (`updater_download.rs`). Every other platform gets
//! `updater_stub.rs`, a no-op carrying the same signatures.
//!
//! The four `#[tauri::command]` verbs and the DTOs they return are declared
//! **here, once**, per the "IPC verbs grouped into a single
//! `commands/<domain>.rs`" convention in CONTRIBUTING.md. The platform modules
//! expose plain `pub(super)` functions with identical signatures, so the
//! sides cannot drift: a change to one that isn't mirrored in the others stops
//! compiling on that platform instead of failing at runtime. Declaring the
//! commands once also keeps `tests/ipc-contract.test.ts` — which reads source
//! text and cannot evaluate `#[cfg]` — from seeing duplicate handlers.
//!
//! See `updater_macos.rs` for the staged-update design, the `atlas:update-*`
//! event contract, and the Team-ID signature anchor; `updater_windows.rs` for
//! the MSI hand-off and what (little) anchors an unsigned MSI.

use serde::Serialize;
use tauri::{AppHandle, State};

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[path = "updater_download.rs"]
mod download;

#[cfg(target_os = "macos")]
#[path = "updater_macos.rs"]
mod imp;

#[cfg(target_os = "windows")]
#[path = "updater_windows.rs"]
mod imp;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
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
    refuse_under(atlas_profile::current())?;
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
    refuse_under(atlas_profile::current())?;
    imp::update_apply(app).await
}

/// What the dev profile's update verbs answer instead of running.
const DEV_PROFILE_REFUSAL: &str = "Updates are off in Atlas Dev: a source build \
     (`bun run dev:app`) never downloads or installs a release, because the release \
     would replace your installed Atlas. Update the installed app from itself.";

/// The guard on the two verbs that fetch or install a release. A dev-profile
/// build (`atlas-profile`) must do neither, on request or not: the release it
/// would fetch is the *installed* Atlas's next version, and on Windows applying
/// it runs that MSI over the installed Atlas — exactly what the profile exists
/// to prevent. `lib.rs` already skips the background and periodic checks; this
/// covers "Check for updates" and "Restart to update". (macOS is safe either
/// way — `updater_macos.rs` refuses to swap outside a `.app` — but one rule for
/// every platform is easier to trust than a per-platform accident.)
fn refuse_under(profile: atlas_profile::Profile) -> Result<(), String> {
    if profile.is_dev() {
        Err(DEV_PROFILE_REFUSAL.to_string())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod dev_profile_tests {
    use super::{refuse_under, DEV_PROFILE_REFUSAL};
    use atlas_profile::Profile;

    #[test]
    fn the_dev_profile_refuses_to_check_or_apply() {
        assert_eq!(
            refuse_under(Profile::Dev),
            Err(DEV_PROFILE_REFUSAL.to_string())
        );
    }

    #[test]
    fn the_default_profile_is_untouched() {
        assert_eq!(refuse_under(Profile::Default), Ok(()));
    }
}

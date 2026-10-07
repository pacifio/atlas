//! Tauri command surface for the Rust-owned `AppState`.

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::state::{
    AppSettings, AppState, AppStateHandle, AppStatePatch, AtlasConfigHandle, ConfigStatus,
};

/// Bootstrap response: `AppState` (projects/recents/orgs) plus the
/// `config.toml`-sourced settings snapshot, combined into one payload so the
/// frontend pays a single IPC round trip at boot. The two remain separately
/// stored/versioned on the Rust side — this struct exists only at the wire
/// boundary, matching the issue #64 design record's "bootstrap may combine
/// state and config for latency; they still don't share a source of truth".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapPayload {
    #[serde(flatten)]
    pub state: AppState,
    pub settings: AppSettings,
    pub config_generation: u64,
    /// Whether `config.toml` actually loaded. This is the ONLY signal the UI
    /// gets at boot that the file on disk is broken and the settings on
    /// screen are Atlas's defaults rather than the user's — computed since
    /// #64 but, until now, reachable only through `get_atlas_config_info`,
    /// which nothing called. A malformed config silently reverted every
    /// preference (`shareTelemetry` back to ON included) with no banner.
    pub config_status: ConfigStatus,
}

/// One-shot bootstrap: returns the full `AppState` snapshot plus the current
/// settings. Called by the frontend exactly once on app mount, before any UI
/// that depends on `currentProject` / `recentProjects` / settings renders.
#[tauri::command]
pub fn bootstrap_app_state(
    state: State<'_, AppStateHandle>,
    config: State<'_, AtlasConfigHandle>,
) -> BootstrapPayload {
    let config_guard = config.lock();
    let state = state.lock().clone();
    // `AppState::migrate` seeds a "Personal" org on every load path, and the
    // frontend refuses to create a project without one. If this ever fires
    // again, a load path has stopped migrating — see `AppState::from_raw`.
    if state.organisations.is_empty() {
        tracing::warn!(
            target: "atlas::app_state",
            "bootstrapping with zero organisations; the frontend cannot add a project"
        );
    }
    BootstrapPayload {
        state,
        settings: config_guard.effective().clone(),
        config_generation: config_guard.generation(),
        config_status: config_guard.status().clone(),
    }
}

/// Which data profile this process runs under (`atlas-profile`), for the few
/// places the window names it: the title says "Atlas Dev", and copy that
/// spells out a path says `.atlas-dev/`. The profile is the backend's to know
/// — it comes from the identifier the binary was built with — so the window
/// asks rather than guessing from its own build.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppProfile {
    pub dev: bool,
    pub product_name: &'static str,
    pub dir_name: &'static str,
}

#[tauri::command]
pub fn app_profile() -> AppProfile {
    let profile = atlas_profile::current();
    AppProfile {
        dev: profile.is_dev(),
        product_name: profile.product_name(),
        dir_name: profile.dir_name(),
    }
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

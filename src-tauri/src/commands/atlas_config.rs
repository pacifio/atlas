//! Tauri command surface + file watcher for `config.toml` (issue #64).
//!
//! Pairs with `state::atlas_config`, which owns the actual parsing/
//! validation/migration logic — this module is the thin IPC + filesystem-
//! watching layer on top, mirroring the `commands::app_state` /
//! `state::app_state` split.

use std::sync::Arc;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_full::new_debouncer;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::{
    AppSettings, AtlasConfigHandle, ConfigError, ConfigSnapshot, ConfigStatus, SettingsPatch,
    UpdateOutcome,
};
use crate::telemetry::TelemetryClient;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum ConfigStatusWire {
    Ok,
    UsingLastKnownGood { error: String },
    UsingDefaults { error: String },
}

impl From<&ConfigStatus> for ConfigStatusWire {
    fn from(status: &ConfigStatus) -> Self {
        match status {
            ConfigStatus::Ok => ConfigStatusWire::Ok,
            ConfigStatus::UsingLastKnownGood { error } => {
                ConfigStatusWire::UsingLastKnownGood { error: error.clone() }
            }
            ConfigStatus::UsingDefaults { error } => {
                ConfigStatusWire::UsingDefaults { error: error.clone() }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigInfo {
    pub path: String,
    pub schema_version: u32,
    pub status: ConfigStatusWire,
    pub effective_settings: AppSettings,
    pub generation: u64,
    pub unknown_keys: Vec<String>,
}

/// UI-hydration snapshot of `config.toml` — used both by the standalone
/// `get_atlas_config_info` call and folded into `bootstrap_app_state` for a
/// single boot round-trip (see `commands::app_state::bootstrap_app_state`).
#[tauri::command]
pub fn get_atlas_config_info(state: State<'_, AtlasConfigHandle>) -> ConfigInfo {
    let guard = state.lock();
    ConfigInfo {
        path: guard.path().to_string_lossy().into_owned(),
        schema_version: crate::state::atlas_config::CONFIG_SCHEMA_VERSION,
        status: guard.status().into(),
        effective_settings: guard.effective().clone(),
        generation: guard.generation(),
        unknown_keys: guard.unknown_keys().to_vec(),
    }
}

/// Apply a partial settings change from the Settings UI. `expected_generation`
/// is the generation the UI last saw — a mismatch means something else (an
/// external edit, a hot reload) changed the file first; the write is refused
/// and the caller gets the actual latest snapshot back to reconcile against,
/// same idea as `save_app_state`'s "never blindly overwrite" (`app_state.rs`)
/// applied to a file editable from outside the app.
///
/// The parse/validate/write itself runs on a blocking thread — CLAUDE.md:
/// "every blocking operation ... must run inside `tokio::task::spawn_blocking`
/// — the Tauri command runtime is shared with the UI's IPC channel." Unlike
/// `save_app_state` (which fires the disk write after replying, since the
/// frontend doesn't need the result), the caller here needs the validated
/// outcome back, so this awaits the blocking task rather than detaching it.
#[tauri::command]
pub async fn update_atlas_settings(
    patch: SettingsPatch,
    expected_generation: u64,
    app: AppHandle,
    state: State<'_, AtlasConfigHandle>,
) -> Result<UpdateOutcome, String> {
    let handle = state.inner().clone();
    let outcome = tokio::task::spawn_blocking(move || handle.lock().apply_patch(&patch, Some(expected_generation)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    if let UpdateOutcome::Applied { ref settings, generation } = outcome {
        notify_settings_changed(&app, settings, generation);
    }
    Ok(outcome)
}

/// "Recreate defaults" — the sole action authorized to overwrite a malformed
/// (or just unwanted) `config.toml`. Backs up whatever was there first. See
/// `update_atlas_settings` for why this runs on a blocking thread.
#[tauri::command]
pub async fn reset_atlas_config(app: AppHandle, state: State<'_, AtlasConfigHandle>) -> Result<ConfigSnapshot, String> {
    let handle = state.inner().clone();
    let snapshot = tokio::task::spawn_blocking(move || handle.lock().reset())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    notify_settings_changed(&app, &snapshot.settings, snapshot.generation);
    Ok(snapshot)
}

/// "Open config" — reveal `config.toml` in the OS default editor, for the
/// Settings UI's error-recovery actions and for a user who just wants to
/// hand-edit it.
#[tauri::command]
pub fn open_atlas_config(app: AppHandle, state: State<'_, AtlasConfigHandle>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = state.lock().path().to_string_lossy().into_owned();
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

/// The one thing every committer of a new settings snapshot must do —
/// whichever of the four paths produced it (a UI patch, `reset`, a hot
/// reload, or an internal Rust-side write from `commands::models`/
/// `commands::updater` via `state::atlas_config::update`):
///
/// 1. tell the frontend (`atlas:config-changed`), so its mirrored
///    `settings`/`configGeneration` never goes stale — a stale generation on
///    the frontend is exactly what turns its next legitimate edit into a
///    spurious `Conflict`;
/// 2. re-sync the live telemetry opt-in gate. `TelemetryClient::enabled` is a
///    cached flag, not read fresh from settings per event; without this, a
///    `shareTelemetry` change that didn't come from the Settings UI's own
///    toggle handler (an external edit, the self-configure skill, "Recreate
///    defaults") would leave telemetry emitting — or silently gated off —
///    out of sync with what the file says until restart.
pub fn notify_settings_changed(app: &AppHandle, settings: &AppSettings, generation: u64) {
    let _ = app.emit(
        "atlas:config-changed",
        serde_json::json!({ "settings": settings, "generation": generation }),
    );
    if let Some(client) = app.try_state::<Arc<TelemetryClient>>() {
        client.set_enabled(settings.share_telemetry);
    }
}

fn emit_error(app: &AppHandle, error: &ConfigError) {
    let _ = app.emit("atlas:config-error", serde_json::json!({ "error": error.to_string() }));
}

/// Watch `config.toml`'s parent directory (atomic saves replace the file's
/// inode, so watching the file itself misses the swap) and hot-reload on any
/// change. A valid external edit replaces the effective settings and notifies
/// the frontend; a malformed one is reported without touching anything —
/// `ConfigManager::reload_from_disk` already enforces both halves of that,
/// this is just wiring its result to Tauri events.
///
/// Leaks the debouncer into a background thread for the process lifetime —
/// there is exactly one `config.toml`, unlike the per-workspace git watcher,
/// so there is nothing to ever tear this down for.
pub fn start_watcher(app: &AppHandle, handle: AtlasConfigHandle) {
    let watch_dir = {
        let guard = handle.lock();
        match guard.path().parent() {
            Some(dir) => dir.to_path_buf(),
            None => return,
        }
    };
    let config_file_name = crate::state::atlas_config::CONFIG_FILE_NAME.to_string();
    let app = app.clone();

    std::thread::spawn(move || {
        let handle_for_cb = handle.clone();
        let app_for_cb = app.clone();
        let file_name_for_cb = config_file_name.clone();
        let debouncer = new_debouncer(
            Duration::from_millis(200),
            None,
            move |result: notify_debouncer_full::DebounceEventResult| {
                let Ok(events) = result else {
                    return;
                };
                let touches_config = events.iter().any(|e| {
                    e.paths.iter().any(|p| {
                        p.file_name().map(|n| n.to_string_lossy() == file_name_for_cb.as_str()).unwrap_or(false)
                    })
                });
                if !touches_config {
                    return;
                }
                let mut guard = handle_for_cb.lock();
                match guard.reload_from_disk() {
                    Ok(true) => {
                        let settings = guard.effective().clone();
                        let generation = guard.generation();
                        drop(guard);
                        notify_settings_changed(&app_for_cb, &settings, generation);
                    }
                    Ok(false) => {} // self-write echo or no-op — nothing to do
                    Err(e) => {
                        drop(guard);
                        tracing::warn!(target: "atlas::config", "external config.toml edit rejected: {e}");
                        emit_error(&app_for_cb, &e);
                    }
                }
            },
        );
        let Ok(mut debouncer) = debouncer else {
            tracing::warn!(target: "atlas::config", "failed to start config.toml watcher");
            return;
        };
        if let Err(e) = debouncer.watch(&watch_dir, RecursiveMode::NonRecursive) {
            tracing::warn!(target: "atlas::config", "failed to watch {}: {e}", watch_dir.display());
            return;
        }
        // Park forever, keeping the debouncer (and its OS-level watch) alive
        // for the life of the process.
        loop {
            std::thread::sleep(Duration::from_secs(3600));
        }
    });
}

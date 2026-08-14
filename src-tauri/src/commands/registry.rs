//! ACP registry marketplace commands — list/refresh/install/uninstall of
//! external agents from the official ACP registry, backed by
//! `atlas_registry::RegistryStore` (process-global, `.manage()`d in setup).
//!
//! Icons travel as base64 data URLs inside the listing payload — the asset
//! protocol 403s files under hidden dirs, so file paths are useless to the
//! webview (same constraint as `canvas.rs`).

use atlas_registry::{RegistryEntryView, RegistryListing, RegistryStore};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgress {
    agent_id: String,
    received: u64,
    total: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallDone {
    agent_id: String,
    success: bool,
    error: Option<String>,
}

/// Cached listing — instant (disk cache served from memory), safe to call
/// before any refresh completed.
#[tauri::command]
pub fn acp_registry_list(store: State<'_, RegistryStore>) -> RegistryListing {
    store.list()
}

/// Force a manifest + icon refresh (marketplace open / refresh button).
#[tauri::command]
pub async fn acp_registry_refresh(
    store: State<'_, RegistryStore>,
) -> Result<RegistryListing, String> {
    store.refresh(true).await.map_err(|e| e.to_string())?;
    Ok(store.list())
}

/// Install an agent. Binary distributions download eagerly here (progress via
/// `atlas:registry-install:progress`); npx/uvx installs are instant — their
/// package manager caches on first spawn. Resolves when fully complete, and
/// also emits `atlas:registry-install:done` for listeners not awaiting the
/// invoke promise.
#[tauri::command]
pub async fn acp_registry_install(
    agent_id: String,
    app: AppHandle,
    store: State<'_, RegistryStore>,
) -> Result<(), String> {
    let progress_app = app.clone();
    let progress_id = agent_id.clone();
    let progress = move |received: u64, total: Option<u64>| {
        let _ = progress_app.emit(
            "atlas:registry-install:progress",
            InstallProgress {
                agent_id: progress_id.clone(),
                received,
                total,
            },
        );
    };
    let result = store.install(&agent_id, Some(&progress)).await;
    if result.is_ok() {
        // Seeds the real per-agent download counts behind the marketplace's
        // trend charts. Opt-in gated by the client itself; the payload is a
        // registry id, never user content.
        use tauri::Manager;
        app.state::<std::sync::Arc<crate::telemetry::TelemetryClient>>().capture(
            "acp_agent_installed",
            serde_json::json!({ "agent_id": agent_id }),
        );
    }
    let done = InstallDone {
        agent_id: agent_id.clone(),
        success: result.is_ok(),
        error: result.as_ref().err().map(|e| e.to_string()),
    };
    let _ = app.emit("atlas:registry-install:done", done);
    result.map(|_| ()).map_err(|e| e.to_string())
}

/// Uninstall keeps the metadata row (historical sessions still render its
/// name/icon); `purge_cache` also deletes any downloaded binary payload.
#[tauri::command]
pub fn acp_registry_uninstall(
    agent_id: String,
    purge_cache: bool,
    app: AppHandle,
    store: State<'_, RegistryStore>,
) -> Result<(), String> {
    store.uninstall(&agent_id, purge_cache).map_err(|e| e.to_string())?;
    use tauri::Manager;
    app.state::<std::sync::Arc<crate::telemetry::TelemetryClient>>()
        .capture("acp_agent_uninstalled", serde_json::json!({ "agent_id": agent_id }));
    Ok(())
}

/// Metadata for any id ever known — the timeline/memory fallback for
/// uninstalled-but-captured agents.
#[tauri::command]
pub fn acp_registry_metadata(
    agent_id: String,
    store: State<'_, RegistryStore>,
) -> Option<RegistryEntryView> {
    store.metadata_for(&agent_id)
}

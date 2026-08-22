//! ACP Marketplace — list/refresh/install/uninstall of external agents.
//!
//! Rebuilt on the ported store at Stage 3 of the Zed port. The command names,
//! argument shapes and event names are unchanged; what changed is what an
//! install *is*.
//!
//! # Installing is writing one map entry
//!
//! Zed's model, and now Atlas's: an agent is installed when the installed map
//! says so (`{"some-cli": {"type": "registry"}}`), and the binary is fetched
//! lazily by the first connect. The old store downloaded eagerly here and kept
//! a parallel install ledger; that produced two sources of truth about whether
//! an agent existed, and the ladder that reconciled them is exactly what
//! §D12-3 removed. Progress events still fire so the marketplace's UI is
//! unchanged, but for a registry install there is nothing to download yet — the
//! `:done` event lands immediately.
//!
//! Icons travel as base64 data URLs inside the listing payload: the asset
//! protocol 403s files under hidden dirs, so file paths are useless to the
//! webview (same constraint as `canvas.rs`).

use std::sync::Arc;

use atlas_agent_store::{AgentServerSettings, AgentServerStore, RegistryAgent};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::agent_host::AgentHost;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntryView {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub repository: Option<String>,
    pub website: Option<String>,
    pub icon_data_url: Option<String>,
    pub installed: bool,
    /// Kept for wire compatibility; always false now. Atlas ships no built-in
    /// external agents, so no registry entry can duplicate one (§D12-3).
    pub builtin: bool,
    pub platform_supported: bool,
    /// "" when unsupported; else "binary" | "npx".
    pub distribution_kind: String,
    /// Binary distribution with no published sha256.
    pub unverified: bool,
    /// Why `platform_supported` is false.
    pub unsupported_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryListing {
    pub entries: Vec<RegistryEntryView>,
    pub last_refreshed_at: Option<String>,
    pub last_error: Option<String>,
}

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

/// Read a cached icon as a data URL. Icons are SVG on disk; a missing or
/// unreadable one is simply absent rather than an error.
fn icon_data_url(agent: &RegistryAgent) -> Option<String> {
    let path = agent.icon_path()?;
    let bytes = std::fs::read(path).ok()?;
    use base64::Engine;
    Some(format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn entry_view(agent: &RegistryAgent, store: &AgentServerStore) -> RegistryEntryView {
    let metadata = agent.metadata();
    let installed = store.entry(agent.id()).is_some();
    let platform_supported = agent.supports_current_platform();
    let (distribution_kind, unverified) = match agent {
        // Unverified = a published binary with no sha256 to check it against.
        // Targets are per-platform, so "any target unpinned" is the honest read.
        RegistryAgent::Binary(binary) => (
            "binary",
            binary.targets.values().any(|target| target.sha256.is_none()),
        ),
        RegistryAgent::Npx(_) => ("npx", false),
    };
    RegistryEntryView {
        id: metadata.id.as_str().to_string(),
        name: metadata.name.clone(),
        version: metadata.version.clone(),
        description: (!metadata.description.is_empty()).then(|| metadata.description.clone()),
        repository: metadata.repository.clone(),
        website: metadata.website.clone(),
        icon_data_url: icon_data_url(agent),
        installed,
        builtin: false,
        platform_supported,
        distribution_kind: if platform_supported {
            distribution_kind.to_string()
        } else {
            String::new()
        },
        unverified,
        unsupported_reason: (!platform_supported)
            .then(|| "no published build for this platform".to_string()),
    }
}

fn listing(host: &AgentHost) -> RegistryListing {
    let mut entries: Vec<RegistryEntryView> = host
        .registry()
        .agents()
        .iter()
        .map(|agent| entry_view(agent, host.store()))
        .collect();
    entries.sort_by_key(|entry| entry.name.to_lowercase());
    RegistryListing {
        entries,
        last_refreshed_at: None,
        last_error: host.registry().fetch_error(),
    }
}

/// Cached listing — instant, safe to call before any refresh completed.
#[tauri::command]
pub fn acp_registry_list(host: State<'_, Arc<AgentHost>>) -> RegistryListing {
    listing(&host)
}

/// Force a manifest + icon refresh (marketplace open / refresh button).
#[tauri::command]
pub async fn acp_registry_refresh(app: AppHandle) -> Result<RegistryListing, String> {
    let host = app.state::<Arc<AgentHost>>().inner().clone();
    host.registry().refresh().await.map_err(|e| e.to_string())?;
    // A refreshed catalogue can move an installed agent's version or command.
    host.store().registry_updated();
    Ok(listing(&host))
}

/// Install an agent: write its entry in the installed map.
///
/// The binary (if it has one) is fetched by the first connect, which is where
/// the store already knows how to resolve and cache it. Returning before any
/// download is deliberate — the marketplace's card flips to "Installed"
/// immediately, and a first chat pays the fetch with real progress from the
/// connection instead of a second, parallel download path here.
#[tauri::command]
pub async fn acp_registry_install(agent_id: String, app: AppHandle) -> Result<(), String> {
    let host = app.state::<Arc<AgentHost>>().inner().clone();
    let result = install(&host, &app, &agent_id).await;

    // Fires on every path so a listener that is not awaiting the invoke can
    // still clear its pending state.
    let _ = app.emit(
        "atlas:registry-install:done",
        InstallDone {
            agent_id: agent_id.clone(),
            success: result.is_ok(),
            error: result.as_ref().err().cloned(),
        },
    );
    if result.is_ok() {
        // Seeds the per-agent download counts behind the marketplace's trend
        // charts. Opt-in gated by the client; the payload is a registry id,
        // never user content.
        app.state::<Arc<crate::telemetry::TelemetryClient>>().capture(
            "acp_agent_installed",
            serde_json::json!({ "agent_id": agent_id }),
        );
        super::catalog::emit_catalog_changed(&app, "install");
    }
    result
}

async fn install(host: &Arc<AgentHost>, app: &AppHandle, agent_id: &str) -> Result<(), String> {
    if host.registry().agent(agent_id).is_none() {
        // Refresh once before giving up: the id may be newer than the cache.
        host.registry().refresh_if_stale().await;
        if host.registry().agent(agent_id).is_none() {
            return Err(format!("{agent_id} is not in the registry"));
        }
    }
    // The marketplace UI shows a determinate bar only when it sees byte
    // progress; a map write has none, so it renders as indeterminate.
    let _ = app.emit(
        "atlas:registry-install:progress",
        InstallProgress {
            agent_id: agent_id.to_string(),
            received: 0,
            total: None,
        },
    );
    let mut settings = host.store().settings();
    settings
        .0
        .insert(agent_id.to_string(), AgentServerSettings::registry());
    persist(host, app, settings).await
}

/// Uninstall: drop the entry, and drop any live connection to it.
///
/// `purge_cache` also deletes the agent's downloaded payload. The registry's
/// metadata is untouched either way — historical sessions still render the
/// agent's name and icon after it is gone.
#[tauri::command]
pub async fn acp_registry_uninstall(
    agent_id: String,
    purge_cache: bool,
    app: AppHandle,
) -> Result<(), String> {
    let host = app.state::<Arc<AgentHost>>().inner().clone();
    let mut settings = host.store().settings();
    if settings.0.remove(&agent_id).is_none() {
        return Ok(());
    }
    persist(&host, &app, settings).await?;

    // A connection to an agent that is no longer installed must not survive the
    // uninstall — the next spawn would otherwise reach a process the user
    // believes they removed.
    host.manager().drop_connection(&atlas_agent_manager::Agent::Custom {
        id: atlas_acp_thread::AgentId::new(agent_id.as_str()),
    });

    if purge_cache {
        let dir = atlas_agent_store::registry_dir(&app_data_dir(&app))
            .join(atlas_agent_store::sanitize_path_component(&agent_id));
        if let Err(e) = std::fs::remove_dir_all(&dir) {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(target: "atlas::agents", "purging {}: {e}", dir.display());
            }
        }
    }

    app.state::<Arc<crate::telemetry::TelemetryClient>>().capture(
        "acp_agent_uninstalled",
        serde_json::json!({ "agent_id": agent_id }),
    );
    super::catalog::emit_catalog_changed(&app, "uninstall");
    Ok(())
}

/// Metadata for any id the registry knows — the timeline/memory fallback for
/// uninstalled-but-captured agents.
#[tauri::command]
pub fn acp_registry_metadata(
    agent_id: String,
    host: State<'_, Arc<AgentHost>>,
) -> Option<RegistryEntryView> {
    host.registry()
        .agent(&agent_id)
        .map(|agent| entry_view(&agent, host.store()))
}

/// Write the map to disk and push it into the store, in that order.
///
/// Disk first: the store rebuild is what makes the agent spawnable, and an
/// agent that is spawnable now but gone after a restart is worse than one that
/// failed to install at all.
async fn persist(
    host: &Arc<AgentHost>,
    app: &AppHandle,
    settings: atlas_agent_store::AllAgentServersSettings,
) -> Result<(), String> {
    super::agent_host::save_installed(&app_data_dir(app), &settings)
        .map_err(|e| format!("writing the installed map: {e}"))?;
    host.store().set_settings(settings).await;
    Ok(())
}

fn app_data_dir(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
}

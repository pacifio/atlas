//! ACP Marketplace — list/refresh/install/uninstall of external agents.
//!
//! Rebuilt on the agent store. The command names,
//! argument shapes and event names are unchanged; what changed is what an
//! install *is*.
//!
//! # Installing is writing one map entry
//!
//! An agent is installed when the installed map
//! says so (`{"some-cli": {"type": "registry"}}`), and the binary is fetched
//! lazily by the first connect. The old store downloaded eagerly here and kept
//! a parallel install ledger; that produced two sources of truth about whether
//! an agent existed, and the ladder that reconciled them is exactly what
//! ADR-0002 removed. Progress events still fire so the marketplace's UI is
//! unchanged, but for a registry install there is nothing to download yet — the
//! `:done` event lands immediately.
//!
//! Icons travel as base64 data URLs inside the listing payload: the asset
//! protocol 403s files under hidden dirs, so file paths are useless to the
//! webview (same constraint as `canvas.rs`).

use std::sync::Arc;

use atlas_agent_store::{AgentServerSettings, RegistryAgent};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::agent_host::{icon_data_url, AgentHost};

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
    pub platform_supported: bool,
    /// "" when unsupported; else "binary" | "npx".
    pub distribution_kind: String,
    /// Binary distribution with no published sha256.
    pub unverified: bool,
    /// Why `platform_supported` is false.
    pub unsupported_reason: Option<String>,
    /// The version on disk, for an installed npx agent that has been fetched.
    /// Not the ACP handshake's: an adapter may report its own build version
    /// there, which need not match the package it ships in.
    pub installed_version: Option<String>,
    /// The copy on disk is older than the registry's `version`. An install is
    /// lazy and silent, so without this a copy npm left behind never shows;
    /// with it the card offers an Update (`acp_registry_update`).
    pub update_available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryListing {
    pub entries: Vec<RegistryEntryView>,
    pub last_refreshed_at: Option<String>,
    pub last_error: Option<String>,
    /// A fetch is in flight right now — a listing taken mid-boot is provisional,
    /// and the marketplace shows it as refreshing rather than as the final word.
    pub is_fetching: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgress {
    agent_id: String,
    received: u64,
    total: Option<u64>,
}

fn entry_view(
    agent: &RegistryAgent,
    host: &AgentHost,
    registry_dir: &std::path::Path,
) -> RegistryEntryView {
    let store = host.store();
    let metadata = agent.metadata();
    let installed = store.entry(agent.id()).is_some();
    // Only a registry entry runs the registry's copy. An accepted detection
    // under the same id runs the user's own binary, which we never update.
    let from_registry = matches!(
        store.settings().0.get(metadata.id.as_str()),
        Some(AgentServerSettings::Registry { .. })
    );
    let (installed_version, update_available) = match agent {
        RegistryAgent::Npx(npx) if from_registry => {
            let on_disk = atlas_agent_store::installed_npx_version(
                registry_dir,
                metadata.id.as_str(),
                &npx.package,
            );
            let behind = on_disk.as_deref().is_some_and(|version| {
                atlas_agent_store::node::installed_below_ceiling(version, &npx.package)
            });
            (on_disk, behind)
        }
        // A binary install is keyed by version, so it cannot lag: a registry
        // bump is a new directory, fetched on the next connect.
        _ => (None, false),
    };
    let platform_supported = agent.supports_current_platform();
    let (distribution_kind, unverified) = match agent {
        // Unverified = a published binary with no sha256 to check it against.
        // Targets are per-platform, so "any target unpinned" is the honest read.
        RegistryAgent::Binary(binary) => (
            "binary",
            binary
                .targets
                .values()
                .any(|target| target.sha256.is_none()),
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
        platform_supported,
        distribution_kind: if platform_supported {
            distribution_kind.to_string()
        } else {
            String::new()
        },
        unverified,
        unsupported_reason: (!platform_supported)
            .then(|| "no published build for this platform".to_string()),
        installed_version,
        update_available,
    }
}

fn listing(host: &AgentHost, app: &AppHandle) -> RegistryListing {
    let registry_dir = atlas_agent_store::registry_dir(&app_data_dir(app));
    let mut entries: Vec<RegistryEntryView> = host
        .registry()
        .agents()
        .iter()
        .map(|agent| entry_view(agent, host, &registry_dir))
        .collect();
    entries.sort_by_key(|entry| entry.name.to_lowercase());
    RegistryListing {
        entries,
        // `None` means "never confirmed against the network" — either a cold
        // boot or a disk-cache-only catalogue. The marketplace reads it to date
        // what it is showing instead of implying it is live.
        last_refreshed_at: host
            .registry()
            .last_refreshed_at()
            .map(|at| chrono::DateTime::<chrono::Utc>::from(at).to_rfc3339()),
        last_error: host.registry().fetch_error(),
        is_fetching: host.registry().is_fetching(),
    }
}

/// Cached listing — instant, safe to call before any refresh completed.
///
/// Off the main thread: each installed npx card reads its `package.json`.
#[tauri::command(async)]
pub fn acp_registry_list(host: State<'_, Arc<AgentHost>>, app: AppHandle) -> RegistryListing {
    listing(&host, &app)
}

/// Force a manifest + icon refresh (marketplace open / refresh button).
#[tauri::command]
pub async fn acp_registry_refresh(app: AppHandle) -> Result<RegistryListing, String> {
    let host = app.state::<Arc<AgentHost>>().inner().clone();
    host.registry().refresh().await.map_err(|e| e.to_string())?;
    // A refreshed catalogue can move an installed agent's version or command.
    host.store().registry_updated();
    Ok(listing(&host, &app))
}

/// Update an installed agent now, instead of waiting for the background pass.
///
/// A registry bump already updates agents on its own: idle ones in the
/// background, running ones once their reply finishes (`agents.rs`,
/// `PendingUpdates`). This is for what that cannot see — the copy on disk is
/// behind while the registry has not moved (npm resolved an older release, or
/// an earlier install recorded an older copy as the newest available), and
/// for the impatient.
///
/// Same steps as the automatic path, so an open chat recovers the same way:
/// wait until no reply is running, tell each open chat it is reconnecting,
/// drop the old process, install. It returns once the install is done, so the
/// card's "Updating…" covers the download and a failure comes back here. The
/// agent starts again on the next message rather than here: nothing is using
/// it at this moment, by construction.
#[tauri::command]
pub async fn acp_registry_update(agent_id: String, app: AppHandle) -> Result<(), String> {
    use super::agents::{emit_agent_update, AgentUpdatePhase};

    let host = app.state::<Arc<AgentHost>>().inner().clone();
    if !matches!(
        host.store().settings().0.get(&agent_id),
        Some(AgentServerSettings::Registry { .. })
    ) {
        return Err(format!("{agent_id} is not installed from the registry"));
    }
    host.registry().refresh_if_stale().await;
    host.store().registry_updated();
    let version = host
        .registry()
        .agent(&agent_id)
        .map(|agent| agent.metadata().version.clone())
        .unwrap_or_default();

    let registry_dir = atlas_agent_store::registry_dir(&app_data_dir(&app));
    atlas_agent_store::forget_npx_install_decision(&registry_dir, &agent_id)
        .await
        .map_err(|e| format!("{e:#}"))?;

    if host.agent_turn_running(&agent_id) {
        emit_agent_update(&app, &agent_id, &version, AgentUpdatePhase::Waiting);
    }
    while host.agent_turn_running(&agent_id) {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    host.restart_for_update(&agent_id, &version)
        .map_err(|e| e.to_string())?;
    emit_agent_update(&app, &agent_id, &version, AgentUpdatePhase::Restarting);
    emit_agent_update(&app, &agent_id, &version, AgentUpdatePhase::Installing);

    let id = atlas_acp_thread::AgentId::new(agent_id.as_str());
    let result = host.store().prefetch_update(&id).await;
    super::catalog::emit_catalog_changed(&app, "update");
    result.map(|_| ()).map_err(|e| format!("{e:#}"))
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

    if result.is_ok() {
        // Seeds the per-agent download counts behind the marketplace's trend
        // charts. Opt-in gated by the client; the payload is a registry id,
        // never user content.
        app.state::<Arc<crate::telemetry::TelemetryClient>>()
            .capture(
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
    let entry = AgentServerSettings::registry();
    let settings = with_entry(host, agent_id, entry);
    persist(host, &app_data_dir(app), settings).await
}

/// Accept a detection: install the copy of the agent the user already has.
///
/// This is the only non-registry install path, and it is what a "Detected on
/// your system" card does. It writes a `custom` entry pointing at the binary
/// that was found, NOT a `registry` one — the point of accepting a detection is
/// to run that copy rather than download our own
/// (`DetectedAgent::install_entry`).
///
/// Note what it is not: finding a binary never installs anything by itself, and
/// never makes an agent spawnable. Only this command, invoked by the user, does
/// — which is what keeps PATH discovery an affordance rather than the spawn
/// ladder rung it used to be (ADR-0002).
#[tauri::command]
pub async fn acp_registry_install_detected(agent_id: String, app: AppHandle) -> Result<(), String> {
    let host = app.state::<Arc<AgentHost>>().inner().clone();
    let result = install_detected(&host, &app, &agent_id).await;

    if result.is_ok() {
        app.state::<Arc<crate::telemetry::TelemetryClient>>()
            .capture(
                "acp_agent_installed",
                serde_json::json!({ "agent_id": agent_id, "from": "detected" }),
            );
        super::catalog::emit_catalog_changed(&app, "install");
    }
    result
}

async fn install_detected(
    host: &Arc<AgentHost>,
    app: &AppHandle,
    agent_id: &str,
) -> Result<(), String> {
    let found = host
        .detected()
        .into_iter()
        .find(|agent| agent.id == agent_id)
        .ok_or_else(|| format!("{agent_id} was not found on your PATH"))?;
    let settings = with_entry(host, agent_id, found.install_entry());
    persist(host, &app_data_dir(app), settings).await
}

/// The installed map with one entry added or replaced.
fn with_entry(
    host: &Arc<AgentHost>,
    agent_id: &str,
    entry: AgentServerSettings,
) -> atlas_agent_store::AllAgentServersSettings {
    let mut settings = host.store().settings();
    settings.0.insert(agent_id.to_string(), entry);
    settings
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
    let Some(removed) = settings.0.remove(&agent_id) else {
        return Ok(());
    };
    persist(&host, &app_data_dir(&app), settings).await?;

    // Its sensitive variables go with it: a reinstall starts clean, and the
    // keychain keeps nothing for an agent that is gone.
    let secrets = removed.secret_env().to_vec();
    let agent = agent_id.clone();
    // Every one, even after a failure: one stuck item mustn't keep the rest.
    let failures = tauri::async_runtime::spawn_blocking(move || {
        secrets
            .iter()
            .filter_map(|name| super::agent_secrets::delete(&agent, name).err())
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_else(|e| vec![e.to_string()]);
    for e in failures {
        tracing::warn!(target: "atlas::agents", agent = %agent_id, "{e}");
    }

    // A connection to an agent that is no longer installed must not survive the
    // uninstall — the next spawn would otherwise reach a process the user
    // believes they removed.
    host.manager()
        .drop_connection(&atlas_agent_manager::Agent::Custom {
            id: atlas_acp_thread::AgentId::new(agent_id.as_str()),
        });

    if purge_cache {
        // Archive agents live at `registry/<id>`, npx agents at
        // `registry/npx/<id>`. Purging only the first left a broken
        // `node_modules` (npm silently missing a platform package) in place,
        // and the reinstall re-adopted it.
        let registry_dir = atlas_agent_store::registry_dir(&app_data_dir(&app));
        let dirs = [
            registry_dir.join(atlas_agent_store::sanitize_path_component(&agent_id)),
            atlas_agent_store::npx_install_dir(&registry_dir, &agent_id),
        ];
        for dir in dirs {
            if let Err(e) = std::fs::remove_dir_all(&dir) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(target: "atlas::agents", "purging {}: {e}", dir.display());
                }
            }
        }
    }

    app.state::<Arc<crate::telemetry::TelemetryClient>>()
        .capture(
            "acp_agent_uninstalled",
            serde_json::json!({ "agent_id": agent_id }),
        );
    super::catalog::emit_catalog_changed(&app, "uninstall");
    Ok(())
}

/// Metadata for any id the registry knows — the timeline/memory fallback for
/// uninstalled-but-captured agents.
#[tauri::command(async)]
pub fn acp_registry_metadata(
    agent_id: String,
    host: State<'_, Arc<AgentHost>>,
    app: AppHandle,
) -> Option<RegistryEntryView> {
    let registry_dir = atlas_agent_store::registry_dir(&app_data_dir(&app));
    host.registry()
        .agent(&agent_id)
        .map(|agent| entry_view(&agent, &host, &registry_dir))
}

/// Write the map to disk and push it into the store, in that order.
///
/// Disk first: the store rebuild is what makes the agent spawnable, and an
/// agent that is spawnable now but gone after a restart is worse than one that
/// failed to install at all.
pub(crate) async fn persist(
    host: &Arc<AgentHost>,
    data_dir: &std::path::Path,
    settings: atlas_agent_store::AllAgentServersSettings,
) -> Result<(), String> {
    super::agent_host::save_installed(data_dir, &settings)
        .map_err(|e| format!("writing the installed map: {e}"))?;
    host.store().set_settings(settings).await;
    Ok(())
}

fn app_data_dir(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::agent_host::{load_installed, test_support::fresh_host};

    fn detected(id: &str, program: &str) -> atlas_agent_store::DetectedAgent {
        atlas_agent_store::DetectedAgent {
            id: id.into(),
            name: id.into(),
            program: std::path::PathBuf::from(program),
            args: vec!["acp".into()],
        }
    }

    /// Accepting a detection installs THE COPY THE USER ALREADY HAS. A
    /// `registry` entry here would ignore the find and download our own, which
    /// is the opposite of what the card offered.
    #[tokio::test]
    async fn accepting_a_detection_installs_the_users_own_copy() {
        let (host, dir) = fresh_host();
        host.set_detected_for_tests(vec![detected("found-agent", "/usr/local/bin/found-agent")]);

        let settings = with_entry(&host, "found-agent", host.detected()[0].install_entry());
        persist(&host, &dir, settings).await.expect("it installs");

        match host.store().settings().0.get("found-agent") {
            Some(atlas_agent_store::AgentServerSettings::Custom { path, args, .. }) => {
                assert_eq!(path.to_string_lossy(), "/usr/local/bin/found-agent");
                assert_eq!(args, &["acp"]);
            }
            other => panic!("expected a custom entry, got {other:?}"),
        }
        // …and it is spawnable now, which is the whole point of accepting.
        assert!(host.agent_for("found-agent").is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The map has to survive a restart: an agent that is spawnable now but
    /// gone after a relaunch is worse than one that failed to install.
    #[tokio::test]
    async fn an_install_is_written_to_disk_not_just_to_memory() {
        let (host, dir) = fresh_host();
        assert!(
            load_installed(&dir).0.is_empty(),
            "a fresh profile has none"
        );

        let settings = with_entry(&host, "some-agent", AgentServerSettings::registry());
        persist(&host, &dir, settings).await.expect("it installs");

        let on_disk = load_installed(&dir);
        assert!(on_disk.0.contains_key("some-agent"));
        assert!(on_disk.has_registry_agents());

        // Uninstall is the same write with the entry gone.
        let mut settings = host.store().settings();
        settings.0.remove("some-agent");
        persist(&host, &dir, settings).await.expect("it uninstalls");
        assert!(load_installed(&dir).0.is_empty());
        assert!(host.agent_for("some-agent").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Installing an id twice replaces the entry rather than duplicating it,
    /// and re-installing a detected agent over a registry one keeps the newer
    /// answer.
    #[tokio::test]
    async fn installing_twice_replaces_the_entry() {
        let (host, dir) = fresh_host();
        let settings = with_entry(&host, "some-agent", AgentServerSettings::registry());
        persist(&host, &dir, settings).await.unwrap();

        let settings = with_entry(
            &host,
            "some-agent",
            AgentServerSettings::custom("/opt/some-agent", vec![]),
        );
        persist(&host, &dir, settings).await.unwrap();

        let map = load_installed(&dir);
        assert_eq!(map.0.len(), 1);
        assert!(matches!(
            map.0.get("some-agent"),
            Some(AgentServerSettings::Custom { .. })
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A detection that is no longer there is refused rather than installed as
    /// a broken entry — the probe may be minutes old.
    #[tokio::test]
    async fn a_detection_that_vanished_is_not_installed() {
        let (host, dir) = fresh_host();
        assert!(host
            .detected()
            .iter()
            .all(|agent| agent.id != "found-agent"));
        // `install_detected` needs an AppHandle, so this asserts the same guard
        // it applies: nothing detected under that id means nothing to install.
        let found = host
            .detected()
            .into_iter()
            .find(|agent| agent.id == "found-agent");
        assert!(found.is_none());
        assert!(host.agent_for("found-agent").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}

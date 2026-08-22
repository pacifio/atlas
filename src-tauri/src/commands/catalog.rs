//! The agent catalog — ONE read surface describing every agent Atlas can run
//! and how it would launch right now.
//!
//! Rebuilt on the ported store at Stage 3 of the Zed port. The command names
//! and the entry shape are unchanged, so the frontend keeps working; what
//! changed is where the answers come from, and how many of them there are.
//!
//! # What the port took out
//!
//! The old catalog described a five-rung spawn ladder — a discovered binary
//! beat an Atlas download, which beat a marketplace install, which beat an
//! `npx -y` fallback — and it had to describe that ladder's *outcome* without
//! being a second opinion about it. That ladder is gone (ADR-0002), and
//! with it `auto-acquire`, `managed-binary`, the `builtin` kind, and the
//! `optional`/`disabled` pair that let a first-party agent be switched off.
//! An agent is now in exactly one of three states: it is the native agent, it
//! is in the installed map, or it is not runnable.
//!
//! `source` is now one of `in-process`, `installed`, `npx`, `detected` (an
//! install *affordance*, not a spawn rung — see below), and `unavailable`.
//! `system-path`, `managed-binary`, `auto-acquire` and `uvx` are gone with the
//! ladder and are never emitted.
//!
//! Deliberately **instant and sync**: everything it reads is already in memory.
//! Nothing here probes the shell or touches the network —
//! `agents_catalog_refresh` is the async door for that, and
//! `atlas:agent-catalog:changed` tells the frontend when to come back.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use atlas_agent_store::ExternalAgentSource;
use atlas_agent_transcript::TranscriptKind;

use super::agent_host::AgentHost;

/// How a spawn of this agent would launch it right now.
mod source {
    /// The native in-process agent — no subprocess at all.
    pub const IN_PROCESS: &str = "in-process";
    /// Installed: the installed map has an entry, so it is runnable.
    pub const INSTALLED: &str = "installed";
    /// Installed and launched through `npx` — npm fetches it on first run.
    pub const NPX: &str = "npx";
    /// Found on the user's `PATH` but NOT installed. Not runnable: it is an
    /// offer to install, and installing writes a `custom` entry pointing at
    /// the copy the user already has.
    pub const DETECTED: &str = "detected";
    /// Nothing runnable.
    pub const UNAVAILABLE: &str = "unavailable";
}

/// The CLI login Atlas can run for this agent right now, if any.
///
/// Only ever comes from the agent itself, via `_meta["terminal-auth"]` on an
/// advertised auth method — so it is absent until the agent has connected
/// once. The old catalog filled this from a hardcoded per-agent login table,
/// which died with `BUILTIN_AGENTS`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginSpec {
    pub program: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCatalogEntry {
    /// Plugin/spec id — the id every other agent command takes.
    pub id: String,
    /// Display alias the frontend's stored sessions key off; equal to `id` for
    /// everything except Claude.
    pub agent_type: String,
    pub name: String,
    pub description: Option<String>,
    pub version: Option<String>,
    /// "native" (Cersei) | "external" (everything else). The old "builtin"
    /// value is never emitted: Atlas ships no first-party external agents.
    pub kind: String,
    /// See the [`source`] module.
    pub source: String,
    /// Absolute path to the executable behind `source`, when there is one.
    pub resolved_path: Option<String>,
    /// Has an installed-map entry. A detected-on-PATH agent is
    /// `installed: false, source: "detected"` — Atlas didn't install it and
    /// will not run it until the user says so.
    pub installed: bool,
    pub supports_modes: bool,
    pub supports_models: bool,
    /// "none" | "claude_jsonl" | "cersei_json".
    pub transcript: String,
    pub login: Option<LoginSpec>,
    /// Auth-method kinds this agent advertised at `initialize` — `"agent"`,
    /// `"env_var"`, `"terminal"`. **Empty before the agent has ever been
    /// connected**, because auth methods only exist after the handshake; the
    /// frontend must fall back to `kind` in that window rather than treating
    /// empty as "cannot sign in".
    pub auth_kinds: Vec<String>,
    /// Whether the agent advertised `auth.logout`. Same pre-connect caveat.
    pub supports_logout: bool,
    /// Whether the agent advertised `loadSession`. Same pre-connect caveat;
    /// `transcript` remains the fallback until the handshake.
    pub supports_load_session: bool,
    /// Whether the agent advertised `sessionCapabilities.list`, meaning the
    /// sidebar can ask IT for history instead of scanning disk.
    pub supports_session_list: bool,
    /// Always false: `session/fork` has no equivalent on the ported seam.
    pub supports_fork: bool,
    pub icon_data_url: Option<String>,
    pub help_url: Option<String>,
    pub repository: Option<String>,
    pub website: Option<String>,
    pub platform_supported: bool,
    /// "" when unsupported; else "binary" | "npx".
    pub distribution_kind: String,
    /// Binary distribution with no published sha256.
    pub unverified: bool,
    pub unsupported_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCatalog {
    pub entries: Vec<AgentCatalogEntry>,
    pub last_refreshed_at: Option<String>,
    pub last_discovered_at: Option<String>,
    pub last_error: Option<String>,
}

/// Emit `atlas:agent-catalog:changed`. Every mutation that can alter how an
/// agent launches funnels through here; the frontend re-invokes
/// [`agents_catalog`] in response.
///
/// `reason` is one of "discovery" | "refresh" | "install" | "uninstall" |
/// "settings" | "spawn".
pub fn emit_catalog_changed(app: &AppHandle, reason: &str) {
    let _ = app.emit(
        "atlas:agent-catalog:changed",
        serde_json::json!({ "reason": reason }),
    );
}

fn build(host: &AgentHost) -> AgentCatalog {
    let registry_agents = host.registry().agents();
    let market = |id: &str| {
        registry_agents
            .iter()
            .find(|agent| agent.id().as_str() == id)
            .cloned()
    };

    let mut entries: Vec<AgentCatalogEntry> = host
        .list_plugins()
        .into_iter()
        .map(|plugin| {
            let id = plugin.plugin_id;
            let is_native = plugin.transcript == TranscriptKind::CerseiJson && !plugin.external;
            let market = market(&id);
            let capabilities = host.capabilities(&id);
            let agent_id = atlas_acp_thread::AgentId::new(id.as_str());
            let entry = host.store().entry(&agent_id);
            let distribution_kind = market
                .as_ref()
                .map(|agent| match agent {
                    atlas_agent_store::RegistryAgent::Binary(_) => "binary".to_string(),
                    atlas_agent_store::RegistryAgent::Npx(_) => "npx".to_string(),
                })
                .unwrap_or_default();

            let (source, resolved_path) = if is_native {
                (source::IN_PROCESS, None)
            } else {
                match host.store().agent_source(&agent_id) {
                    // An npx-distributed registry agent is installed but has no
                    // resolved binary until npm fetches it; the frontend shows
                    // that differently, so it keeps its own token.
                    Some(ExternalAgentSource::Registry) if distribution_kind == "npx" => {
                        (source::NPX, None)
                    }
                    Some(_) => (source::INSTALLED, None),
                    None => (source::UNAVAILABLE, None),
                }
            };

            AgentCatalogEntry {
                agent_type: agent_type_for(&id),
                name: plugin.display_name,
                description: market
                    .as_ref()
                    .map(|agent| agent.description().to_string())
                    .filter(|d| !d.is_empty()),
                version: entry
                    .as_ref()
                    .and_then(|entry| entry.version.as_ref().map(|v| v.to_string()))
                    .or_else(|| market.as_ref().map(|agent| agent.version().to_string()))
                    .filter(|v| !v.is_empty()),
                kind: if is_native { "native" } else { "external" }.to_string(),
                source: source.to_string(),
                resolved_path,
                installed: !is_native,
                supports_modes: plugin.supports_modes,
                supports_models: plugin.supports_models,
                transcript: transcript_token(plugin.transcript).to_string(),
                // Filled from the agent's own advertisement, in Stage 4's auth
                // work. There is no table to guess from any more.
                login: None,
                auth_kinds: capabilities.auth_kinds,
                supports_logout: capabilities.supports_logout,
                supports_load_session: capabilities.supports_load_session,
                supports_session_list: capabilities.supports_session_list,
                supports_fork: capabilities.supports_fork,
                icon_data_url: market.as_ref().and_then(super::agent_host::icon_data_url),
                help_url: market.as_ref().and_then(|agent| {
                    agent
                        .repository()
                        .or_else(|| agent.website())
                        .map(str::to_string)
                }),
                repository: market.as_ref().and_then(|a| a.repository().map(str::to_string)),
                website: market.as_ref().and_then(|a| a.website().map(str::to_string)),
                platform_supported: is_native
                    || market
                        .as_ref()
                        .map(|agent| agent.supports_current_platform())
                        .unwrap_or(true),
                distribution_kind,
                unverified: matches!(
                    market.as_ref(),
                    Some(atlas_agent_store::RegistryAgent::Binary(binary))
                        if binary.targets.values().any(|target| target.sha256.is_none())
                ),
                unsupported_reason: None,
                id,
            }
        })
        .collect();

    // Agents the user already has on `PATH` but has not installed. These are
    // OFFERS, never spawn candidates: `installed: false` and a `system-path`
    // source, so nothing can mistake one for a runnable agent.
    let installed: Vec<String> = entries.iter().map(|entry| entry.id.clone()).collect();
    for found in host.detected() {
        if installed.contains(&found.id) {
            continue;
        }
        let market = market(&found.id);
        entries.push(AgentCatalogEntry {
            agent_type: agent_type_for(&found.id),
            name: found.name.clone(),
            description: market
                .as_ref()
                .map(|agent| agent.description().to_string())
                .filter(|d| !d.is_empty()),
            version: market.as_ref().map(|agent| agent.version().to_string()),
            kind: "external".to_string(),
            source: source::DETECTED.to_string(),
            resolved_path: Some(found.program.to_string_lossy().into_owned()),
            installed: false,
            supports_modes: false,
            supports_models: false,
            transcript: transcript_token(super::agent_host::transcript_kind_for(&found.id))
                .to_string(),
            login: None,
            auth_kinds: Vec::new(),
            supports_logout: false,
            supports_load_session: false,
            supports_session_list: false,
            supports_fork: false,
            icon_data_url: market.as_ref().and_then(super::agent_host::icon_data_url),
            help_url: market.as_ref().and_then(|a| a.repository().map(str::to_string)),
            repository: market.as_ref().and_then(|a| a.repository().map(str::to_string)),
            website: market.as_ref().and_then(|a| a.website().map(str::to_string)),
            // Demonstrably runnable on this machine: the binary is right there.
            platform_supported: true,
            distribution_kind: String::new(),
            unverified: false,
            unsupported_reason: None,
            id: found.id,
        });
    }

    AgentCatalog {
        entries,
        last_refreshed_at: None,
        last_discovered_at: None,
        last_error: host.registry().fetch_error(),
    }
}

/// Display alias for stored sessions. Only Claude has one: the frontend has
/// persisted `"claude-code"` against sessions since before the spec id gained
/// its `-ts` suffix.
fn agent_type_for(plugin_id: &str) -> String {
    match plugin_id {
        "claude-code-ts" => "claude-code".to_string(),
        other => other.to_string(),
    }
}

fn transcript_token(kind: TranscriptKind) -> &'static str {
    match kind {
        TranscriptKind::None => "none",
        TranscriptKind::ClaudeJsonl => "claude_jsonl",
        TranscriptKind::CerseiJson => "cersei_json",
    }
}

/// The catalog, served from memory. Safe to call before any refresh or
/// detection pass has completed — entries just describe the pre-detection
/// state and are corrected by `atlas:agent-catalog:changed`.
#[tauri::command]
pub fn agents_catalog(host: State<'_, Arc<AgentHost>>) -> AgentCatalog {
    build(&host)
}

/// Refresh the registry and re-probe `PATH`, then answer with the fresh
/// catalog. The marketplace's refresh button; also the escape hatch after
/// installing a CLI by hand mid-session.
#[tauri::command]
pub async fn agents_catalog_refresh(force: bool, app: AppHandle) -> Result<AgentCatalog, String> {
    let host = app.state::<Arc<AgentHost>>().inner().clone();
    if force {
        let _ = host.registry().refresh().await;
    } else {
        host.registry().refresh_if_stale().await;
    }
    host.store().registry_updated();
    // Detection runs AFTER the refresh on purpose: it probes for the programs
    // the registry names, so a first-run machine with no cached index would
    // otherwise have nothing to look for.
    let probe = host.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || probe.probe_detected()).await;
    emit_catalog_changed(&app, "refresh");
    Ok(build(&host))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::agent_host::test_support::fresh_host;
    use atlas_agent_store::{AgentServerSettings, AllAgentServersSettings};

    fn ids(catalog: &AgentCatalog) -> Vec<&str> {
        catalog.entries.iter().map(|e| e.id.as_str()).collect()
    }

    fn entry<'a>(catalog: &'a AgentCatalog, id: &str) -> &'a AgentCatalogEntry {
        catalog
            .entries
            .iter()
            .find(|e| e.id == id)
            .unwrap_or_else(|| panic!("{id} is in the catalog"))
    }

    /// The acceptance criterion, end to end: a fresh profile offers exactly one
    /// agent, an install makes a second one appear as runnable, and an uninstall
    /// takes it away again.
    #[tokio::test]
    async fn install_then_uninstall_moves_an_agent_in_and_out_of_the_catalog() {
        let (host, dir) = fresh_host();

        // Fresh profile: the native agent, and nothing else. No builtin table,
        // no auto-acquire, nothing pre-seeded (ADR-0002).
        let fresh = build(&host);
        assert_eq!(ids(&fresh), [atlas_native_agent::CERSEI_AGENT_ID]);
        let native = entry(&fresh, atlas_native_agent::CERSEI_AGENT_ID);
        assert_eq!(native.kind, "native");
        assert_eq!(native.source, source::IN_PROCESS);
        assert_eq!(native.transcript, "cersei_json");

        // Installing is writing one map entry.
        let mut settings = AllAgentServersSettings::default();
        settings.0.insert(
            "some-agent".to_string(),
            AgentServerSettings::custom("/bin/echo", vec!["acp".into()]),
        );
        host.store().set_settings(settings).await;

        let after = build(&host);
        assert!(ids(&after).contains(&"some-agent"));
        let installed = entry(&after, "some-agent");
        assert_eq!(installed.kind, "external");
        assert_eq!(installed.source, source::INSTALLED);
        assert!(installed.installed);
        // The ladder's flags are off the WIRE, not merely false: the frontend
        // used to branch on them, and a field that is always false is a
        // question the UI should stop asking.
        let wire = serde_json::to_value(installed).expect("entry serializes");
        for gone in ["autoManaged", "optional", "disabled", "builtin"] {
            assert!(wire.get(gone).is_none(), "{gone} is still on the wire");
        }
        // …and it is genuinely runnable, which is the half a catalog entry
        // cannot prove on its own.
        assert!(host.agent_for("some-agent").is_ok());

        // Uninstalling removes it from both.
        host.store()
            .set_settings(AllAgentServersSettings::default())
            .await;
        assert_eq!(ids(&build(&host)), [atlas_native_agent::CERSEI_AGENT_ID]);
        assert!(host.agent_for("some-agent").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A detected agent is DATA, not a spawn candidate. It appears so the
    /// marketplace can offer to install it, and nothing else: the ladder that
    /// used to spawn a PATH binary directly is gone.
    #[tokio::test]
    async fn a_detected_agent_is_an_offer_rather_than_a_runnable_one() {
        let (host, dir) = fresh_host();
        host.set_detected_for_tests(vec![atlas_agent_store::DetectedAgent {
            id: "found-agent".into(),
            name: "Found Agent".into(),
            program: std::path::PathBuf::from("/usr/local/bin/found-agent"),
            args: vec!["acp".into()],
        }]);

        let catalog = build(&host);
        let found = entry(&catalog, "found-agent");
        assert_eq!(found.source, source::DETECTED);
        assert!(!found.installed, "Atlas did not install it — the user did");
        assert_eq!(
            found.resolved_path.as_deref(),
            Some("/usr/local/bin/found-agent")
        );
        // Demonstrably runnable on this machine: the binary is right there.
        assert!(found.platform_supported);
        // But not runnable BY ATLAS until the user installs it.
        assert!(host.agent_for("found-agent").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Once installed, the detection must not produce a second card for the
    /// same agent — the marketplace renders one row per id.
    #[tokio::test]
    async fn an_installed_agent_is_not_listed_twice_when_it_is_also_on_path() {
        let (host, dir) = fresh_host();
        host.set_detected_for_tests(vec![atlas_agent_store::DetectedAgent {
            id: "found-agent".into(),
            name: "Found Agent".into(),
            program: std::path::PathBuf::from("/usr/local/bin/found-agent"),
            args: vec!["acp".into()],
        }]);
        let mut settings = AllAgentServersSettings::default();
        settings.0.insert(
            "found-agent".to_string(),
            AgentServerSettings::custom("/usr/local/bin/found-agent", vec!["acp".into()]),
        );
        host.store().set_settings(settings).await;

        let catalog = build(&host);
        assert_eq!(
            catalog
                .entries
                .iter()
                .filter(|e| e.id == "found-agent")
                .count(),
            1
        );
        // The installed entry wins: it is the one that can actually spawn.
        assert_eq!(entry(&catalog, "found-agent").source, source::INSTALLED);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Claude keeps its display alias, because the frontend has persisted
    /// `"claude-code"` against stored sessions since before the spec id gained
    /// its `-ts` suffix.
    #[test]
    fn only_claude_has_a_display_alias() {
        assert_eq!(agent_type_for("claude-code-ts"), "claude-code");
        for id in ["codex", "cersei", "some-agent"] {
            assert_eq!(agent_type_for(id), id);
        }
    }
}

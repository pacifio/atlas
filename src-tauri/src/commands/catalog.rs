//! The agent catalog — ONE read surface describing every agent Atlas can run
//! and how it would launch right now.
//!
//! Agent identity used to be assembled by the frontend from two commands
//! (`agents_list_plugins` + `acp_registry_list`) plus four static tables that
//! had to be hand-synced with the Rust side. This command supersedes that: the
//! backend already knows the builtin table, the manifest, the install store,
//! the discovered-on-PATH set and the user's settings, so it answers once,
//! authoritatively.
//!
//! Deliberately **instant and sync**: everything it reads is already in memory
//! (cache-first manifest, cached discovery results). Nothing here probes the
//! shell or touches the network — `agents_catalog_refresh` is the async door
//! for that, and `atlas:agent-catalog:changed` tells the frontend when to come
//! back.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use atlas_agents::{AgentManager, TranscriptKind};
use atlas_registry::RegistryStore;

/// How a spawn of this agent would launch it *right now*. The frontend derives
/// its availability grouping from this rather than being told, so a stale
/// value can only ever be a cosmetic lag corrected by the next changed event.
mod source {
    /// The native in-process agent — no subprocess at all.
    pub const IN_PROCESS: &str = "in-process";
    /// A system install found on the user's `PATH` (system-first, rung 1).
    pub const SYSTEM_PATH: &str = "system-path";
    /// A binary Atlas downloaded into its app-data dir (rung 2).
    pub const MANAGED_BINARY: &str = "managed-binary";
    /// A marketplace install record (rung 3).
    pub const INSTALLED: &str = "installed";
    /// Launches via `npx -y <package>` — npm fetches it on first run.
    pub const NPX: &str = "npx";
    /// Launches via `uvx <package>` — needs uv on the machine.
    pub const UVX: &str = "uvx";
    /// An auto-managed built-in with nothing resolved yet: the next spawn
    /// downloads its official binary.
    pub const AUTO_ACQUIRE: &str = "auto-acquire";
    /// Nothing runnable — no install, no download path, no runner.
    pub const UNAVAILABLE: &str = "unavailable";
}

/// The CLI login Atlas can run for this agent right now, if any. Present only
/// when a binary is actually resolved — an absent `login` is the backend
/// saying "there is no command to offer", not "this agent has no sign-in".
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
    /// Display alias the frontend's stored sessions key off (`claude-code` for
    /// `claude-code-ts`); equal to `id` for everything else.
    pub agent_type: String,
    pub name: String,
    pub description: Option<String>,
    pub version: Option<String>,
    /// "native" (Cersei) | "builtin" (first-party) | "external" (registry).
    pub kind: String,
    /// See the [`source`] module.
    pub source: String,
    /// Absolute path to the executable behind `source`, when there is one.
    pub resolved_path: Option<String>,
    /// Has a marketplace install record. Note a discovered-on-PATH agent is
    /// `installed: false, source: "system-path"` — Atlas didn't install it,
    /// the user did.
    pub installed: bool,
    pub auto_managed: bool,
    /// Can be turned off in Settings → Agents.
    pub optional: bool,
    pub disabled: bool,
    pub supports_modes: bool,
    pub supports_models: bool,
    /// "none" | "claude_jsonl" | "cersei_json".
    pub transcript: String,
    pub login: Option<LoginSpec>,
    /// Auth-method kinds this agent advertised at `initialize` — `"agent"`,
    /// `"env_var"`, `"terminal"` (R6). **Empty before the agent has ever been
    /// spawned**, because auth methods only exist after the handshake; the
    /// frontend must fall back to `login` / `kind` in that window rather than
    /// treating empty as "cannot sign in". Exists so `/login` and `canSignIn`
    /// gate on data instead of hardcoding agent names in TS.
    pub auth_kinds: Vec<String>,
    /// Whether the agent advertised `auth.logout` (A2). Same pre-spawn caveat
    /// as [`Self::auth_kinds`]: false until the handshake has happened.
    pub supports_logout: bool,
    /// Whether the agent advertised `loadSession` (P2.3) — i.e. it can replay a
    /// stored session itself. Same pre-spawn caveat as [`Self::auth_kinds`];
    /// the `transcript` field remains the fallback until the handshake.
    pub supports_load_session: bool,
    /// Whether the agent advertised `sessionCapabilities.list` (P2.3), meaning
    /// the sidebar can ask IT for history instead of scanning disk.
    pub supports_session_list: bool,
    /// Whether the agent advertised `sessionCapabilities.fork` (P3.4).
    pub supports_fork: bool,
    pub icon_data_url: Option<String>,
    pub help_url: Option<String>,
    pub repository: Option<String>,
    pub website: Option<String>,
    pub platform_supported: bool,
    /// "" when unsupported; else "binary" | "npx" | "uvx".
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
/// "settings" | "acquire".
pub fn emit_catalog_changed(app: &AppHandle, reason: &str) {
    let _ = app.emit(
        "atlas:agent-catalog:changed",
        serde_json::json!({ "reason": reason }),
    );
}

/// Assemble the catalog from every source of agent truth the host owns.
fn build(app: &AppHandle) -> AgentCatalog {
    let manager: State<'_, AgentManager> = app.state();
    let registry: State<'_, RegistryStore> = app.state();
    let app_state: State<'_, crate::state::AppStateHandle> = app.state();

    let discovered = registry.discovered_agents();
    let listing = registry.list();
    let disabled_ids: Vec<String> = app_state.lock().settings.disabled_builtin_agents.clone();

    let entries = manager
        .list_plugins()
        .into_iter()
        .map(|plugin| {
            let id = plugin.plugin_id;
            let builtin = atlas_acp::builtin_agent(&id);
            let is_native = id == atlas_agents::CERSEI_PLUGIN_ID;
            // The marketplace view for this id, if the registry knows it —
            // under its own id or under a builtin's manifest alias.
            let market = builtin
                .into_iter()
                .flat_map(|b| b.registry_ids.iter().copied())
                .chain(std::iter::once(id.as_str()))
                .find_map(|rid| listing.entries.iter().find(|e| e.id == rid));

            let discovered_path = discovered.get(&id).map(|d| d.program.clone());
            let managed_path = registry.builtin_binary_path(&id);
            let installed = registry.is_installed(&id);
            let distribution_kind = market
                .map(|m| m.distribution_kind.clone())
                .unwrap_or_default();

            // Precedence mirrors `SpecSource::extra_specs` exactly — this is a
            // description of that ladder's outcome, not a second opinion.
            let (source, resolved_path) = if is_native {
                (source::IN_PROCESS, None)
            } else if let Some(path) = discovered_path.clone() {
                (source::SYSTEM_PATH, Some(path))
            } else if let Some(path) = managed_path.clone() {
                (source::MANAGED_BINARY, Some(path))
            } else if installed {
                (source::INSTALLED, None)
            } else if plugin.command.starts_with("npx ") {
                (source::NPX, None)
            } else if plugin.command.starts_with("uvx ") {
                (source::UVX, None)
            } else if builtin.is_some_and(|b| b.auto_managed) {
                (source::AUTO_ACQUIRE, None)
            } else if distribution_kind == "npx" {
                (source::NPX, None)
            } else if distribution_kind == "uvx" {
                (source::UVX, None)
            } else {
                (source::UNAVAILABLE, None)
            };

            // A login is only offered when there is a binary to run it with;
            // resolution mirrors spawn precedence via `login_binary_path`.
            let login = atlas_acp::builtin_login_args(&id).and_then(|args| {
                registry.login_binary_path(&id).map(|program| LoginSpec {
                    program,
                    args: args.iter().map(|s| s.to_string()).collect(),
                })
            });

            AgentCatalogEntry {
                agent_type: agent_type_for(&id),
                name: plugin.display_name,
                description: market.and_then(|m| m.description.clone()),
                version: market.map(|m| m.version.clone()).filter(|v| !v.is_empty()),
                kind: if is_native {
                    "native".to_string()
                } else if builtin.is_some() {
                    "builtin".to_string()
                } else {
                    "external".to_string()
                },
                source: source.to_string(),
                resolved_path,
                installed,
                auto_managed: builtin.is_some_and(|b| b.auto_managed),
                optional: builtin.is_some_and(|b| b.optional),
                // Reads the raw setting rather than `builtin_disabled` so the
                // catalog answers for externals too; the `optional` guard above
                // is what keeps a hand-edited entry from disabling Claude.
                disabled: builtin.is_some_and(|b| b.optional)
                    && disabled_ids.iter().any(|d| *d == id),
                supports_modes: plugin.supports_modes,
                supports_models: plugin.supports_models,
                transcript: transcript_token(plugin.transcript).to_string(),
                login,
                auth_kinds: manager.auth_kinds_for_plugin(&id),
                supports_logout: manager.plugin_supports_logout(&id),
                supports_load_session: manager.plugin_supports_load_session(&id),
                supports_session_list: manager.plugin_supports_session_list(&id),
                supports_fork: manager.plugin_supports_fork(&id),
                icon_data_url: market.and_then(|m| m.icon_data_url.clone()),
                help_url: discovered
                    .get(&id)
                    .and_then(|d| d.help_url.clone())
                    .or_else(|| market.and_then(|m| m.repository.clone()))
                    .or_else(|| market.and_then(|m| m.website.clone())),
                repository: market.and_then(|m| m.repository.clone()),
                website: market.and_then(|m| m.website.clone()),
                // A discovered binary is runnable here by demonstration, even
                // if the manifest publishes nothing for this platform.
                platform_supported: is_native
                    || discovered_path.is_some()
                    || market.map(|m| m.platform_supported).unwrap_or(true),
                distribution_kind,
                unverified: market.is_some_and(|m| m.unverified),
                unsupported_reason: market.and_then(|m| m.unsupported_reason.clone()),
                id,
            }
        })
        .collect();

    AgentCatalog {
        entries,
        last_refreshed_at: listing.last_refreshed_at,
        last_discovered_at: registry.last_discovered_at(),
        last_error: listing.last_error,
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
/// discovery pass has completed — entries just describe the pre-discovery
/// state and are corrected by `atlas:agent-catalog:changed`.
#[tauri::command]
pub fn agents_catalog(app: AppHandle) -> AgentCatalog {
    build(&app)
}

/// Refresh the manifest and re-probe the system, then answer with the fresh
/// catalog. The marketplace's refresh button; also the escape hatch after
/// installing a CLI by hand mid-session.
#[tauri::command]
pub async fn agents_catalog_refresh(force: bool, app: AppHandle) -> Result<AgentCatalog, String> {
    {
        let registry: State<'_, RegistryStore> = app.state();
        let _ = registry.refresh(force).await;
        registry.discover(force).await;
    }
    emit_catalog_changed(&app, "refresh");
    Ok(build(&app))
}

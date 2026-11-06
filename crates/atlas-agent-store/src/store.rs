//! The store: the installed map, turned into agents.
//!
//! `reregister` is the whole design in one function: drain the table, rebuild
//! it from the settings map, notify.
//!
//! What makes it the *only* source is the shape of that loop — it iterates the
//! settings map, not the registry. A registry agent nobody installed is looked
//! up only when a settings entry names it, so an empty map produces an empty
//! table no matter how large the catalogue is. That is the mechanism behind "a
//! fresh install shows only the native agent", and it is why there is nothing here to
//! disable.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use atlas_acp_thread::AgentId;
use atlas_agent_servers::server::ExternalAgentServer;
use semver::Version;
use tokio::sync::watch;

use crate::http::HttpClient;
use crate::node::NodeRuntime;
use crate::registry::{AgentRegistryStore, RegistryAgent};
use crate::secrets::{SecretEnv, SecretSource};
use crate::servers::{
    npx_install_dir, LocalCustomAgent, LocalRegistryArchiveAgent, LocalRegistryNpxAgent,
    ProjectEnvironment,
};
use crate::settings::{AgentServerSettings, AllAgentServersSettings};
use crate::{registry_dir, sanitize_path_component};

/// An installed agent's resolver, with the registry version it serves.
type VersionedServer = (AgentId, Arc<dyn ExternalAgentServer>, Option<Arc<str>>);

/// Where an installed agent came from. The marketplace uses it to decide
/// whether "Remove" means deleting a registry entry or a hand-written one.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ExternalAgentSource {
    #[default]
    Custom,
    Registry,
}

#[derive(Clone)]
pub struct ExternalAgentEntry {
    pub server: Arc<dyn ExternalAgentServer>,
    pub source: ExternalAgentSource,
    /// Path to the registry's cached icon, when it published one.
    pub icon_path: Option<PathBuf>,
    /// The registry's display name. `None` for a custom entry, whose name is
    /// its key in the installed map.
    pub display_name: Option<String>,
    pub version: Option<Arc<str>>,
    pub default_mode: Option<String>,
}

struct AgentChannels {
    new_version_available: watch::Sender<Option<String>>,
    loading_status: watch::Sender<Option<String>>,
}

impl Default for AgentChannels {
    fn default() -> Self {
        Self {
            new_version_available: watch::channel(None).0,
            loading_status: watch::channel(None).0,
        }
    }
}

#[derive(Default)]
struct State {
    settings: AllAgentServersSettings,
    byok_env: HashMap<String, String>,
    secret_source: Option<Arc<dyn SecretSource>>,
    external_agents: HashMap<AgentId, ExternalAgentEntry>,
    channels: HashMap<AgentId, AgentChannels>,
    generation: u64,
}

pub struct AgentServerStore {
    data_dir: PathBuf,
    http: Arc<dyn HttpClient>,
    node: NodeRuntime,
    project_env: Arc<dyn ProjectEnvironment>,
    registry: Option<Arc<AgentRegistryStore>>,
    state: Mutex<State>,
    updates: watch::Sender<u64>,
}

impl AgentServerStore {
    pub fn new(
        data_dir: PathBuf,
        http: Arc<dyn HttpClient>,
        node: NodeRuntime,
        project_env: Arc<dyn ProjectEnvironment>,
        registry: Option<Arc<AgentRegistryStore>>,
    ) -> Self {
        Self {
            data_dir,
            http,
            node,
            project_env,
            registry,
            state: Mutex::new(State::default()),
            updates: watch::channel(0).0,
        }
    }

    /// Replace the installed map and rebuild.
    ///
    /// Async because of one thing: a map that names registry agents needs the
    /// catalogue to resolve them, so this refreshes it first — throttled, so
    /// calling this on every settings change costs nothing
    /// (`agent_server_store.rs:316-322`).
    /// # This is last-writer-wins, and a lock here would not change that
    ///
    /// Reviewed as a potential lost-update bug and deliberately left alone.
    /// The read-check-write below does span an await, so two callers can both
    /// pass the equality check before either writes. But serialising this
    /// function does not fix it: callers pass the **whole** map, computed from
    /// a read that already happened somewhere else, so the later writer
    /// overwrites the earlier one either way. An install racing an uninstall
    /// collapses to whichever finished last, lock or no lock.
    ///
    /// The real fix is a delta-shaped API — `install(id)` / `uninstall(id)`
    /// rather than `set_settings(whole_map)` — which is a change across every
    /// Tauri command that writes the installed map, not a change here. Until
    /// then the invariant belongs to the caller: **the installed map has one
    /// writer**, and today `src-tauri`'s registry commands are it, because
    /// Tauri runs them one at a time.
    ///
    /// Adding a mutex here would satisfy a reviewer without satisfying the
    /// requirement, which is worse than the honest gap, because it would read
    /// as solved.
    pub async fn set_settings(&self, settings: AllAgentServersSettings) {
        if self.state.lock().unwrap().settings == settings {
            return;
        }

        if settings.has_registry_agents() {
            if let Some(registry) = &self.registry {
                registry.refresh_if_stale().await;
            }
        }

        self.state.lock().unwrap().settings = settings;
        self.reregister();
    }

    pub fn settings(&self) -> AllAgentServersSettings {
        self.state.lock().unwrap().settings.clone()
    }

    /// The catalogue changed — rebuild, because a registry entry's version,
    /// distribution or icon may have moved. This is the path the version-bump
    /// notification runs through.
    ///
    /// Unconditional, unlike [`AgentServerStore::set_settings`] and
    /// [`AgentServerStore::set_byok_env`], which both early-return when nothing
    /// changed. That asymmetry is deliberate. Skipping the rebuild needs a way
    /// to know the catalogue is unchanged, and the only cheap one is a
    /// fingerprint over the entry fields — which would miss an entry whose
    /// archive URL moved while its version stayed put, leaving a live server
    /// object pointing at a URL the registry has retired. The cost of being
    /// wrong there is a stale install; the cost of rebuilding is re-allocating
    /// a few dozen small structs once an hour. Reviewed and left as-is.
    pub fn registry_updated(&self) {
        self.reregister();
    }

    /// Push the current BYOK keys in (the `sync_builtin_agent_env` touchpoint).
    /// Live agents keep the env they were spawned with; this affects the next
    /// command resolution.
    pub fn set_byok_env(&self, env: HashMap<String, String>) {
        {
            let mut state = self.state.lock().unwrap();
            if state.byok_env == env {
                return;
            }
            state.byok_env = env;
        }
        self.reregister();
    }

    /// Where sensitive variables are read from at launch: the OS keychain.
    /// Without one, a variable marked sensitive is simply absent.
    pub fn set_secret_source(&self, source: Arc<dyn SecretSource>) {
        self.state.lock().unwrap().secret_source = Some(source);
        self.reregister();
    }

    /// Every installed external agent, sorted for a stable UI order.
    pub fn external_agents(&self) -> Vec<AgentId> {
        let mut ids = self
            .state
            .lock()
            .unwrap()
            .external_agents
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        ids.sort();
        ids
    }

    pub fn entry(&self, id: &AgentId) -> Option<ExternalAgentEntry> {
        self.state.lock().unwrap().external_agents.get(id).cloned()
    }

    pub fn agent_server(&self, id: &AgentId) -> Option<Arc<dyn ExternalAgentServer>> {
        self.entry(id).map(|entry| entry.server)
    }

    pub fn agent_source(&self, id: &AgentId) -> Option<ExternalAgentSource> {
        self.entry(id).map(|entry| entry.source)
    }

    pub fn agent_icon(&self, id: &AgentId) -> Option<PathBuf> {
        self.entry(id).and_then(|entry| entry.icon_path)
    }

    pub fn agent_display_name(&self, id: &AgentId) -> Option<String> {
        self.entry(id).and_then(|entry| entry.display_name)
    }

    /// Bring every registry agent that already has a copy on disk up to the
    /// registry's version, without starting any of them. Returns the ids that
    /// installed something.
    ///
    /// `skip` names agents to leave alone — the caller's running ones. An npx
    /// install wipes and rebuilds the tree a live process is loading its
    /// modules from; those update after their restart instead.
    ///
    /// One at a time: these are npm installs and archive downloads, and the
    /// point is to be done before the user needs them, not to compete with
    /// whatever they are doing. A failure is logged and left for the next
    /// connect, which retries the same install in the foreground.
    pub async fn prefetch_updates(&self, skip: impl Fn(&AgentId) -> bool) -> Vec<AgentId> {
        let registry_agents: Vec<(AgentId, Arc<dyn ExternalAgentServer>)> = {
            let state = self.state.lock().unwrap();
            state
                .external_agents
                .iter()
                .filter(|(id, entry)| entry.source == ExternalAgentSource::Registry && !skip(id))
                .map(|(id, entry)| (id.clone(), entry.server.clone()))
                .collect()
        };
        let mut updated = Vec::new();
        for (id, server) in registry_agents {
            match server.prefetch_update().await {
                Ok(true) => {
                    tracing::info!(agent = %id, "prefetched agent update");
                    updated.push(id);
                }
                Ok(false) => {}
                Err(error) => tracing::warn!(
                    agent = %id,
                    error = %format!("{error:#}"),
                    "background agent update failed; the next connect retries it"
                ),
            }
        }
        updated
    }

    /// The registry agents among `only` whose copy on disk is behind the
    /// registry ([`ExternalAgentServer::update_pending`]), with the version
    /// each should be on. Installs nothing.
    pub async fn pending_updates(&self, only: impl Fn(&AgentId) -> bool) -> Vec<(AgentId, String)> {
        let candidates: Vec<VersionedServer> = {
            let state = self.state.lock().unwrap();
            state
                .external_agents
                .iter()
                .filter(|(id, entry)| entry.source == ExternalAgentSource::Registry && only(id))
                .map(|(id, entry)| (id.clone(), entry.server.clone(), entry.version.clone()))
                .collect()
        };
        let mut pending = Vec::new();
        for (id, server, version) in candidates {
            if server.update_pending().await {
                pending.push((id, version.map(|v| v.to_string()).unwrap_or_default()));
            }
        }
        pending
    }

    /// [`ExternalAgentServer::prefetch_update`] for one agent. `Ok(false)`
    /// when it is not installed or had nothing to update.
    pub async fn prefetch_update(&self, id: &AgentId) -> anyhow::Result<bool> {
        match self.agent_server(id) {
            Some(server) => server.prefetch_update().await,
            None => Ok(false),
        }
    }

    /// Fires with the new version when a registry refresh moves an installed
    /// agent forward. A live connection watches this and reconnects; that is
    /// the whole purpose of the channel.
    pub fn watch_new_version(&self, id: &AgentId) -> Option<watch::Receiver<Option<String>>> {
        self.state
            .lock()
            .unwrap()
            .channels
            .get(id)
            .map(|channels| channels.new_version_available.subscribe())
    }

    /// Install progress ("Installing 1.2.3…"), for the UI to show while a
    /// registry agent downloads on first run.
    pub fn watch_loading_status(&self, id: &AgentId) -> Option<watch::Receiver<Option<String>>> {
        self.state
            .lock()
            .unwrap()
            .channels
            .get(id)
            .map(|channels| channels.loading_status.subscribe())
    }

    /// Bumps on every rebuild. A `watch` rather than a broadcast because a listener that missed two
    /// rebuilds only needs to know the table changed, not how often.
    pub fn updates(&self) -> watch::Receiver<u64> {
        self.updates.subscribe()
    }

    /// Rebuild `external_agents` from the installed map.
    fn reregister(&self) {
        let registry_agents = self
            .registry
            .as_ref()
            .map(|registry| {
                registry
                    .agents()
                    .into_iter()
                    .map(|agent| (agent.id().as_str().to_string(), agent))
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();

        let generation = {
            let mut state = self.state.lock().unwrap();
            let State {
                settings,
                byok_env,
                secret_source,
                external_agents,
                channels,
                generation,
            } = &mut *state;

            // Remember what each agent was on, then drain: an id that has
            // disappeared from the settings map must not survive the rebuild.
            let previous_versions = external_agents
                .iter()
                .map(|(id, entry)| (id.clone(), entry.version.clone()))
                .collect::<HashMap<_, _>>();
            external_agents.clear();

            for (name, entry_settings) in settings.iter() {
                let id = AgentId::new(name.as_str());
                let agent_channels = channels.entry(id.clone()).or_default();

                let entry = match entry_settings {
                    AgentServerSettings::Custom { .. } => {
                        // `command()` is `Some` for every `Custom` variant.
                        let Some(command) = entry_settings.command() else {
                            continue;
                        };
                        ExternalAgentEntry {
                            server: Arc::new(LocalCustomAgent {
                                command,
                                project_env: self.project_env.clone(),
                                byok_env: byok_env.clone(),
                                secret_env: SecretEnv::new(
                                    name,
                                    entry_settings.secret_env(),
                                    secret_source.clone(),
                                ),
                            }),
                            source: ExternalAgentSource::Custom,
                            icon_path: None,
                            display_name: None,
                            version: None,
                            default_mode: entry_settings.default_mode().map(str::to_owned),
                        }
                    }
                    AgentServerSettings::Registry { .. } => {
                        let Some(agent) = registry_agents.get(name) else {
                            // Installed, but the catalogue has not loaded or no
                            // longer lists it. Not an error: a refresh may
                            // bring it back, and dropping the settings entry
                            // would silently uninstall it.
                            tracing::debug!(
                                agent = %name,
                                "registry agent not found in the ACP registry"
                            );
                            continue;
                        };
                        match self.registry_entry(
                            name,
                            agent,
                            entry_settings,
                            byok_env,
                            secret_source.clone(),
                            agent_channels,
                        ) {
                            Some(entry) => entry,
                            None => continue,
                        }
                    }
                };

                external_agents.insert(id, entry);
            }

            // A version that moved *forward* means the running connection is
            // on the wrong binary. Only the forward direction
            // counts, and `is_upgrade` says why.
            for (id, entry) in external_agents.iter() {
                let (Some(previous), Some(current)) = (
                    previous_versions.get(id).cloned().flatten(),
                    entry.version.clone(),
                ) else {
                    continue;
                };
                if is_upgrade(&previous, &current) {
                    if let Some(agent_channels) = channels.get(id) {
                        agent_channels
                            .new_version_available
                            .send(Some(current.to_string()))
                            .ok();
                    }
                }
            }

            // Channels outlive a single rebuild (an agent briefly missing from
            // the catalogue keeps its watchers) but not an uninstall.
            channels.retain(|id, _| settings.contains_key(id.as_str()));

            *generation += 1;
            *generation
        };

        self.updates.send(generation).ok();
    }

    fn registry_entry(
        &self,
        name: &str,
        agent: &RegistryAgent,
        settings: &AgentServerSettings,
        byok_env: &HashMap<String, String>,
        secret_source: Option<Arc<dyn SecretSource>>,
        channels: &AgentChannels,
    ) -> Option<ExternalAgentEntry> {
        let metadata = agent.metadata();
        let version: Arc<str> = Arc::from(metadata.version.as_str());

        let server: Arc<dyn ExternalAgentServer> = match agent {
            RegistryAgent::Binary(binary) => {
                if !binary.supports_current_platform {
                    tracing::warn!(
                        agent = %name,
                        "registry agent has no compatible binary for this platform"
                    );
                    return None;
                }
                Arc::new(LocalRegistryArchiveAgent {
                    http: self.http.clone(),
                    node: self.node.clone(),
                    project_env: self.project_env.clone(),
                    installation_dir: registry_dir(&self.data_dir)
                        .join(sanitize_path_component(name)),
                    version: version.clone(),
                    targets: binary.targets.clone(),
                    settings_args: settings.args().to_vec(),
                    settings_env: settings.launch_env(),
                    secret_env: SecretEnv::new(name, settings.secret_env(), secret_source.clone()),
                    byok_env: byok_env.clone(),
                    loading_status: Some(channels.loading_status.clone()),
                })
            }
            RegistryAgent::Npx(npx) => Arc::new(LocalRegistryNpxAgent {
                node: self.node.clone(),
                project_env: self.project_env.clone(),
                install_dir: npx_install_dir(&registry_dir(&self.data_dir), name),
                version: version.clone(),
                package: npx.package.clone(),
                args: npx.args.clone(),
                distribution_env: npx.env.clone(),
                settings_args: settings.args().to_vec(),
                settings_env: settings.launch_env(),
                secret_env: SecretEnv::new(name, settings.secret_env(), secret_source),
                byok_env: byok_env.clone(),
                loading_status: Some(channels.loading_status.clone()),
            }),
        };

        Some(ExternalAgentEntry {
            server,
            source: ExternalAgentSource::Registry,
            icon_path: metadata.icon_path.clone(),
            display_name: Some(metadata.name.clone()),
            version: Some(version),
            default_mode: settings.default_mode().map(str::to_owned),
        })
    }
}

/// Whether `current` is a version worth dropping the live connection for.
///
/// Nothing here is cosmetic. Emitting this notification is not a badge: the
/// manager removes the connection entry, cancels any connect in flight and
/// forgets that agent's sessions before it even fires
/// (`atlas-agent-manager/src/manager.rs`), and the next use reinstalls
/// whatever the registry now calls current. There is no confirmation step
/// between a registry publish and that reinstall.
///
/// So a plain `previous != current` — which is what this
/// was — hands a third-party registry two things it should not have:
///
/// - **A downgrade.** Republishing an older version reads as an upgrade, and
///   the older binary is installed with nothing to notice it.
/// - **A re-tag.** `1.2.3` → `v1.2.3` and `2.0` → `2.0.0` are the same
///   release written differently, and each would cost the user their session.
///
/// Versions that are not semver at all — `latest`, date stamps, build ids —
/// keep the old behaviour, because for those there is no order to read and
/// "it changed" is the only signal available.
///
/// One known gap, accepted: semver orders alphanumeric pre-release
/// identifiers lexically, so `1.0.0-rc9` → `1.0.0-rc10` reads as a *decrease*
/// and does not notify. That is semver behaving as specified — `rc.9` →
/// `rc.10`, with the dot, compares numerically and works — and the cost is
/// small, because this channel only tears down a live connection and the new
/// version is picked up on the next start anyway.
fn is_upgrade(previous: &str, current: &str) -> bool {
    match (parse_version(previous), parse_version(current)) {
        (Some(previous), Some(current)) => current > previous,
        _ => normalized(previous) != normalized(current),
    }
}

/// A leading `v` is decoration, not part of the version.
fn normalized(raw: &str) -> &str {
    let trimmed = raw.trim();
    trimmed.strip_prefix(['v', 'V']).unwrap_or(trimmed)
}

/// Parse a published version, tolerating the two shapes registries actually
/// write that semver itself rejects: a `v` prefix, and a truncated `2` or
/// `2.0` standing in for `2.0.0`.
///
/// Padding applies only when the whole string is digits and dots. Anything
/// carrying a pre-release or build suffix goes to semver exactly as published,
/// because that is where guessing would start changing meaning rather than
/// spelling.
fn parse_version(raw: &str) -> Option<Version> {
    let trimmed = normalized(raw);

    let bare_numeric = !trimmed.is_empty()
        && trimmed
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()));

    let candidate = if bare_numeric {
        match trimmed.matches('.').count() {
            0 => format!("{trimmed}.0.0"),
            1 => format!("{trimmed}.0"),
            _ => trimmed.to_owned(),
        }
    } else {
        trimmed.to_owned()
    };

    Version::parse(&candidate).ok()
}

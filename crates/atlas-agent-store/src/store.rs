//! The store: the installed map, turned into agents.
//!
//! Ported from `AgentServerStore` (`agent_server_store.rs:176-489`), and in
//! particular from `reregister_agents`, which is the whole design in one
//! function: drain the table, rebuild it from the settings map, notify.
//!
//! What makes it the *only* source is the shape of that loop — it iterates the
//! settings map, not the registry. A registry agent nobody installed is looked
//! up only when a settings entry names it, so an empty map produces an empty
//! table no matter how large the catalogue is. That is the mechanism behind "a
//! fresh install shows only Cersei", and it is why there is nothing here to
//! disable.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use atlas_acp_thread::AgentId;
use atlas_agent_servers::server::ExternalAgentServer;
use tokio::sync::watch;

use crate::http::HttpClient;
use crate::node::NodeRuntime;
use crate::registry::{AgentRegistryStore, RegistryAgent};
use crate::servers::{
    npx_install_dir, LocalCustomAgent, LocalRegistryArchiveAgent, LocalRegistryNpxAgent,
    ProjectEnvironment,
};
use crate::settings::{AgentServerSettings, AllAgentServersSettings};
use crate::{registry_dir, sanitize_path_component};

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
    /// distribution or icon may have moved. This is the path Zed's version-bump
    /// notification runs through.
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

    /// Bumps on every rebuild. Stands in for Zed's `cx.emit(AgentServersUpdated)`
    /// — a `watch` rather than a broadcast because a listener that missed two
    /// rebuilds only needs to know the table changed, not how often.
    pub fn updates(&self) -> watch::Receiver<u64> {
        self.updates.subscribe()
    }

    /// Rebuild `external_agents` from the installed map.
    ///
    /// Ported from `reregister_agents` (`agent_server_store.rs:294-489`).
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
                            }),
                            source: ExternalAgentSource::Custom,
                            icon_path: None,
                            display_name: None,
                            version: None,
                            default_mode: entry_settings.default_mode().map(str::to_owned),
                        }
                    }
                    AgentServerSettings::Registry { env, .. } => {
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
                            env,
                            byok_env,
                            entry_settings.default_mode(),
                            agent_channels,
                        ) {
                            Some(entry) => entry,
                            None => continue,
                        }
                    }
                };

                external_agents.insert(id, entry);
            }

            // A version that moved forward means the running connection is on
            // the wrong binary; anything else is left alone. Ported from
            // `agent_server_store.rs:441-467`.
            for (id, entry) in external_agents.iter() {
                let (Some(previous), Some(current)) = (
                    previous_versions.get(id).cloned().flatten(),
                    entry.version.clone(),
                ) else {
                    continue;
                };
                if previous != current {
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
        settings_env: &HashMap<String, String>,
        byok_env: &HashMap<String, String>,
        default_mode: Option<&str>,
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
                    settings_env: settings_env.clone(),
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
                settings_env: settings_env.clone(),
                byok_env: byok_env.clone(),
            }),
        };

        Some(ExternalAgentEntry {
            server,
            source: ExternalAgentSource::Registry,
            icon_path: metadata.icon_path.clone(),
            display_name: Some(metadata.name.clone()),
            version: Some(version),
            default_mode: default_mode.map(str::to_owned),
        })
    }
}

//! The ACP registry, as data.
//!
//! Ported from `zed-ref/crates/project/src/agent_registry_store.rs`. This is the
//! marketplace's catalogue and nothing else: it installs nothing, spawns
//! nothing, and an agent appearing here does not make it available. Only an
//! entry in [`crate::settings::AllAgentServersSettings`] does that.
//!
//! Three behaviours are ported deliberately:
//!
//! - **Cache-first.** The last good `registry.json` and its icons live on disk,
//!   so the marketplace renders instantly and offline.
//! - **Throttled refresh.** [`AgentRegistryStore::refresh_if_stale`] fetches at
//!   most once an hour, which is what makes it safe to call on every settings
//!   change.
//! - **A failed refresh keeps the previous catalogue.** The error is recorded
//!   for the UI to show; it never empties the list.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use anyhow::{bail, Context as _, Result};
use atlas_acp_thread::AgentId;
use futures::future::join_all;
use serde::Deserialize;

use crate::http::{get_body, HttpClient};
use crate::registry_dir;

pub const REGISTRY_URL: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const REFRESH_THROTTLE_DURATION: Duration = Duration::from_secs(60 * 60);
// Bound the full request lifecycle, including response body reads; a connect
// timeout alone would let a stalled body hang the marketplace.
const REGISTRY_FETCH_TIMEOUT: Duration = Duration::from_secs(30);
const REGISTRY_ICON_FETCH_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistryAgentMetadata {
    pub id: AgentId,
    pub name: String,
    pub description: String,
    pub version: String,
    pub repository: Option<String>,
    pub website: Option<String>,
    /// Path to the cached SVG on disk, if we have one.
    pub icon_path: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistryTargetConfig {
    pub archive: String,
    pub cmd: String,
    pub args: Vec<String>,
    pub sha256: Option<String>,
    pub env: HashMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistryBinaryAgent {
    pub metadata: RegistryAgentMetadata,
    pub targets: HashMap<String, RegistryTargetConfig>,
    pub supports_current_platform: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistryNpxAgent {
    pub metadata: RegistryAgentMetadata,
    pub package: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RegistryAgent {
    Binary(RegistryBinaryAgent),
    Npx(RegistryNpxAgent),
}

impl RegistryAgent {
    pub fn metadata(&self) -> &RegistryAgentMetadata {
        match self {
            Self::Binary(agent) => &agent.metadata,
            Self::Npx(agent) => &agent.metadata,
        }
    }

    pub fn id(&self) -> &AgentId {
        &self.metadata().id
    }

    pub fn name(&self) -> &str {
        &self.metadata().name
    }

    pub fn description(&self) -> &str {
        &self.metadata().description
    }

    pub fn version(&self) -> &str {
        &self.metadata().version
    }

    pub fn repository(&self) -> Option<&str> {
        self.metadata().repository.as_deref()
    }

    pub fn website(&self) -> Option<&str> {
        self.metadata().website.as_deref()
    }

    pub fn icon_path(&self) -> Option<&Path> {
        self.metadata().icon_path.as_deref()
    }

    /// An npx agent runs anywhere Node runs; a binary agent only where the
    /// registry published a target for this platform.
    pub fn supports_current_platform(&self) -> bool {
        match self {
            Self::Binary(agent) => agent.supports_current_platform,
            Self::Npx(_) => true,
        }
    }
}

#[derive(Default)]
struct State {
    agents: Vec<RegistryAgent>,
    is_fetching: bool,
    fetch_error: Option<String>,
    last_refresh: Option<Instant>,
    /// Wall-clock time of the last SUCCESSFUL fetch, for "showing cached data
    /// from …". `Instant` can't cross the wire, which is why this is separate
    /// from `last_refresh` (a monotonic throttle input).
    last_success: Option<SystemTime>,
    /// Bumped once per *completed* refresh, success or failure. A caller that
    /// waited behind someone else's fetch compares this against the value it
    /// read on entry to know whether that fetch is its answer.
    generation: u64,
}

pub struct AgentRegistryStore {
    data_dir: PathBuf,
    http: Arc<dyn HttpClient>,
    state: Mutex<State>,
    /// Held across the network fetch so concurrent refreshes serialize instead
    /// of racing. Async, because it is held across `.await`.
    refresh_lock: tokio::sync::Mutex<()>,
}

impl AgentRegistryStore {
    pub fn new(data_dir: PathBuf, http: Arc<dyn HttpClient>) -> Self {
        Self {
            data_dir,
            http,
            state: Mutex::new(State::default()),
            refresh_lock: tokio::sync::Mutex::new(()),
        }
    }

    /// Load whatever the last successful fetch wrote. A missing or corrupt
    /// cache just means "empty until the first refresh" — never an error the
    /// caller has to handle at startup.
    pub async fn load_cached(&self) -> Result<()> {
        let cache_path = registry_cache_path(&self.data_dir);
        let Ok(bytes) = tokio::fs::read(&cache_path).await else {
            return Ok(());
        };
        let index: RegistryIndex =
            serde_json::from_slice(&bytes).context("parsing cached registry")?;
        let agents = self.build_registry_agents(index, &bytes, false).await?;
        self.state.lock().unwrap().agents = agents;
        Ok(())
    }

    /// Fetch the registry index and replace the catalogue.
    ///
    /// A refresh already in flight is JOINED, not skipped: the second caller
    /// waits for it and adopts its outcome. Zed's `pending_refresh` guard
    /// (`agent_registry_store.rs:203-206`) can return early because its callers
    /// observe the catalogue reactively; ours returns the catalogue *to the
    /// caller*, so an early `Ok(())` was a lie — it handed back whatever was in
    /// memory (on a cold start, nothing) and reported success. That is what made
    /// the marketplace show "Registry unavailable" on first open and then fill in
    /// on a manual Refresh: its mount-time refresh collided with the one boot had
    /// already started.
    #[expect(
        clippy::await_holding_invalid_type,
        reason = "joining an in-flight refresh IS holding `refresh_lock` across the fetch; see the doc comment"
    )]
    pub async fn refresh(&self) -> Result<()> {
        let generation_on_entry = self.state.lock().unwrap().generation;

        let _guard = self.refresh_lock.lock().await;

        // Someone else's fetch finished while we waited. It is as fresh as one
        // we would start now, so adopt its outcome rather than re-fetching.
        {
            let state = self.state.lock().unwrap();
            if state.generation != generation_on_entry {
                return match &state.fetch_error {
                    Some(error) => bail!("{error}"),
                    None => Ok(()),
                };
            }
        }

        {
            let mut state = self.state.lock().unwrap();
            state.is_fetching = true;
            state.fetch_error = None;
            state.last_refresh = Some(Instant::now());
        }

        let result = self.fetch_and_build().await;

        let mut state = self.state.lock().unwrap();
        state.is_fetching = false;
        state.generation = state.generation.wrapping_add(1);
        match result {
            Ok(agents) => {
                state.agents = agents;
                state.fetch_error = None;
                state.last_success = Some(SystemTime::now());
                Ok(())
            }
            Err(error) => {
                // The previous catalogue stays; the error is for the UI.
                let message = format!("{error:#}");
                tracing::warn!(error = %message, "ACP registry refresh failed");
                state.fetch_error = Some(message);
                Err(error)
            }
        }
    }

    /// Refresh at most once an hour. Called whenever a registry agent is in
    /// play, which is often — the throttle is what makes that free.
    pub async fn refresh_if_stale(&self) {
        let should_refresh = {
            let state = self.state.lock().unwrap();
            state
                .last_refresh
                .map(|last| last.elapsed() >= REFRESH_THROTTLE_DURATION)
                .unwrap_or(true)
        };
        if should_refresh {
            let _ = self.refresh().await;
        }
    }

    /// Replace the catalogue without going to the network. Zed gates the
    /// equivalent behind `test-support`; here it is also how a host that
    /// already has the index (a warm start, a test) seeds the store.
    pub fn set_agents(&self, agents: Vec<RegistryAgent>) {
        self.state.lock().unwrap().agents = agents;
    }

    pub fn agents(&self) -> Vec<RegistryAgent> {
        self.state.lock().unwrap().agents.clone()
    }

    pub fn agent(&self, id: &str) -> Option<RegistryAgent> {
        self.state
            .lock()
            .unwrap()
            .agents
            .iter()
            .find(|agent| agent.id().as_str() == id)
            .cloned()
    }

    pub fn is_fetching(&self) -> bool {
        self.state.lock().unwrap().is_fetching
    }

    pub fn fetch_error(&self) -> Option<String> {
        self.state.lock().unwrap().fetch_error.clone()
    }

    /// Wall-clock time of the last successful fetch — what the marketplace
    /// dates its cached listing by. `None` means the catalogue on hand, if any,
    /// came off disk and has never been confirmed against the network.
    pub fn last_refreshed_at(&self) -> Option<SystemTime> {
        self.state.lock().unwrap().last_success
    }

    async fn fetch_and_build(&self) -> Result<Vec<RegistryAgent>> {
        let (status, body) = get_body(&*self.http, REGISTRY_URL, REGISTRY_FETCH_TIMEOUT)
            .await
            .context("fetching ACP registry")?;

        // Any non-2xx, not just 4xx. A 5xx used to fall through to the parser,
        // so a CDN outage reached the marketplace as "expected value at line 1
        // column 1" instead of as a server error.
        if !(200..300).contains(&status) {
            let text = String::from_utf8_lossy(&body);
            bail!("registry status error {status}, response: {text:?}");
        }

        let index: RegistryIndex =
            serde_json::from_slice(&body).context("parsing ACP registry")?;
        self.build_registry_agents(index, &body, true).await
    }

    /// Ported from `agent_registry_store.rs:344-455`. `update_cache` is what
    /// separates "we just fetched this" (write it down, fetch missing icons)
    /// from "we just read it off disk".
    async fn build_registry_agents(
        &self,
        index: RegistryIndex,
        raw_body: &[u8],
        update_cache: bool,
    ) -> Result<Vec<RegistryAgent>> {
        let cache_dir = registry_dir(&self.data_dir);
        tokio::fs::create_dir_all(&cache_dir).await?;

        if update_cache {
            tokio::fs::write(cache_dir.join("registry.json"), raw_body).await?;
        }

        let icons_dir = cache_dir.join("icons");
        if update_cache {
            tokio::fs::create_dir_all(&icons_dir).await?;
        }

        let current_platform = current_platform_key();
        let icon_paths = self
            .resolve_icon_paths(&index.agents, &icons_dir, update_cache)
            .await;

        let mut agents = Vec::new();
        for (entry, icon_path) in index.agents.into_iter().zip(icon_paths) {
            let metadata = RegistryAgentMetadata {
                id: AgentId::new(entry.id),
                name: entry.name,
                description: entry.description,
                version: entry.version,
                repository: entry.repository,
                website: entry.website,
                icon_path,
            };

            let binary_agent = entry.distribution.binary.as_ref().and_then(|binary| {
                if binary.is_empty() {
                    return None;
                }

                let targets = binary
                    .iter()
                    .map(|(platform, target)| {
                        (
                            platform.clone(),
                            RegistryTargetConfig {
                                archive: target.archive.clone(),
                                cmd: target.cmd.clone(),
                                args: target.args.clone(),
                                sha256: target.sha256.clone(),
                                env: target.env.clone(),
                            },
                        )
                    })
                    .collect::<HashMap<_, _>>();

                let supports_current_platform =
                    current_platform.is_some_and(|platform| targets.contains_key(platform));

                Some(RegistryBinaryAgent {
                    metadata: metadata.clone(),
                    targets,
                    supports_current_platform,
                })
            });

            let npx_agent = entry.distribution.npx.as_ref().map(|npx| RegistryNpxAgent {
                metadata: metadata.clone(),
                package: npx.package.clone(),
                args: npx.args.clone(),
                env: npx.env.clone(),
            });

            // Binary is preferred when it runs here; npx is the fallback, not a
            // second entry. An agent that offers neither is skipped entirely.
            let agent = match (binary_agent, npx_agent) {
                (Some(binary_agent), Some(npx_agent)) => {
                    if binary_agent.supports_current_platform {
                        RegistryAgent::Binary(binary_agent)
                    } else {
                        RegistryAgent::Npx(npx_agent)
                    }
                }
                (Some(binary_agent), None) => RegistryAgent::Binary(binary_agent),
                (None, Some(npx_agent)) => RegistryAgent::Npx(npx_agent),
                (None, None) => continue,
            };

            agents.push(agent);
        }

        Ok(agents)
    }

    async fn resolve_icon_paths(
        &self,
        entries: &[RegistryEntry],
        icons_dir: &Path,
        update_cache: bool,
    ) -> Vec<Option<PathBuf>> {
        join_all(
            entries
                .iter()
                .map(|entry| self.resolve_icon_path(entry, icons_dir, update_cache)),
        )
        .await
    }

    async fn resolve_icon_path(
        &self,
        entry: &RegistryEntry,
        icons_dir: &Path,
        update_cache: bool,
    ) -> Option<PathBuf> {
        let icon_url = resolve_icon_url(entry)?;
        let icon_path = icons_dir.join(format!("{}.svg", sanitize_icon_name(&entry.id)));

        if update_cache && !is_file(&icon_path).await {
            if let Err(error) = self.download_icon(&icon_url, &icon_path).await {
                // An icon is decoration; the agent is still installable without
                // one, so this never fails the refresh.
                tracing::warn!(
                    agent = %entry.id,
                    error = %format!("{error:#}"),
                    "failed to download ACP registry icon"
                );
            }
        }

        is_file(&icon_path).await.then_some(icon_path)
    }

    async fn download_icon(&self, icon_url: &str, icon_path: &Path) -> Result<()> {
        let (status, body) = get_body(&*self.http, icon_url, REGISTRY_ICON_FETCH_TIMEOUT).await?;
        // Same rule as the index fetch — and here it also stops a 5xx error page
        // being written to disk under an `.svg` name and served as an icon.
        if !(200..300).contains(&status) {
            let text = String::from_utf8_lossy(&body);
            bail!("icon status error {status}, response: {text:?}");
        }
        tokio::fs::write(icon_path, &body).await?;
        Ok(())
    }
}

async fn is_file(path: &Path) -> bool {
    tokio::fs::metadata(path)
        .await
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

/// An entry's `icon` is either an absolute URL or a path relative to the
/// agent's directory in the registry repo (`agent_registry_store.rs:560-572`).
fn resolve_icon_url(entry: &RegistryEntry) -> Option<String> {
    let icon = entry.icon.as_ref()?;
    if icon.starts_with("https://") || icon.starts_with("http://") {
        return Some(icon.to_string());
    }

    let relative_icon = icon.trim_start_matches("./");
    Some(format!(
        "https://raw.githubusercontent.com/agentclientprotocol/registry/main/{}/{relative_icon}",
        entry.id
    ))
}

/// Registry ids reach the filesystem as icon file names; Zed writes them raw.
/// This crate sanitizes, for the same reason [`crate::sanitize_path_component`]
/// exists on the install path.
fn sanitize_icon_name(id: &str) -> String {
    crate::sanitize_path_component(id)
}

/// The registry's platform key for this host, or `None` where the registry has
/// no concept of us. Ported from `agent_registry_store.rs:581-618`.
pub fn current_platform_key() -> Option<&'static str> {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        return None;
    };

    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else {
        return None;
    };

    Some(match (os, arch) {
        ("darwin", "aarch64") => "darwin-aarch64",
        ("darwin", "x86_64") => "darwin-x86_64",
        ("linux", "aarch64") => "linux-aarch64",
        ("linux", "x86_64") => "linux-x86_64",
        ("windows", "aarch64") => "windows-aarch64",
        ("windows", "x86_64") => "windows-x86_64",
        _ => return None,
    })
}

fn registry_cache_path(data_dir: &Path) -> PathBuf {
    registry_dir(data_dir).join("registry.json")
}

// ------------------------------------------------------------- the wire shape

#[derive(Deserialize)]
pub(crate) struct RegistryIndex {
    #[serde(rename = "version")]
    _version: String,
    agents: Vec<RegistryEntry>,
}

#[derive(Deserialize)]
struct RegistryEntry {
    id: String,
    name: String,
    version: String,
    description: String,
    #[serde(default)]
    repository: Option<String>,
    #[serde(default)]
    website: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    distribution: RegistryDistribution,
}

#[derive(Deserialize)]
struct RegistryDistribution {
    #[serde(default)]
    binary: Option<HashMap<String, RegistryBinaryTarget>>,
    #[serde(default)]
    npx: Option<RegistryNpxDistribution>,
}

#[derive(Deserialize)]
struct RegistryBinaryTarget {
    archive: String,
    cmd: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    env: HashMap<String, String>,
}

#[derive(Deserialize)]
struct RegistryNpxDistribution {
    package: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
}

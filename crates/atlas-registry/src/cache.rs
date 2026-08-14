//! Manifest fetch + throttle + disk cache, mirroring Zed's model: cache-first
//! at startup (the marketplace renders instantly offline), network refresh at
//! most once an hour unless forced, and a failed refresh keeps serving the
//! last good manifest with the error surfaced non-fatally.

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use parking_lot::RwLock;

use crate::error::{RegistryError, Result};
use crate::manifest::{RegistryAgent, RegistryManifest};

pub const REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const REFRESH_THROTTLE: Duration = Duration::from_secs(60 * 60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);

pub struct RegistryCache {
    dir: PathBuf,
    state: RwLock<CacheState>,
}

#[derive(Default)]
struct CacheState {
    manifest: Option<RegistryManifest>,
    fetched_at: Option<SystemTime>,
    last_error: Option<String>,
}

impl RegistryCache {
    /// Synchronous cache-first load — safe to call from app setup. A corrupt
    /// or missing cache file just means "empty until first refresh".
    pub fn load(dir: PathBuf) -> Self {
        let manifest = std::fs::read(dir.join("registry.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<RegistryManifest>(&bytes).ok());
        Self {
            dir,
            state: RwLock::new(CacheState {
                manifest,
                fetched_at: None,
                last_error: None,
            }),
        }
    }

    pub fn manifest(&self) -> Option<RegistryManifest> {
        self.state.read().manifest.clone()
    }

    pub fn agent(&self, id: &str) -> Option<RegistryAgent> {
        self.state
            .read()
            .manifest
            .as_ref()?
            .agents
            .iter()
            .find(|a| a.id == id)
            .cloned()
    }

    pub fn last_error(&self) -> Option<String> {
        self.state.read().last_error.clone()
    }

    pub fn last_refreshed_at(&self) -> Option<SystemTime> {
        self.state.read().fetched_at
    }

    fn is_stale(&self, force: bool) -> bool {
        if force {
            return true;
        }
        let state = self.state.read();
        if state.manifest.is_none() {
            return true;
        }
        match state.fetched_at {
            None => true,
            Some(at) => at.elapsed().map(|e| e > REFRESH_THROTTLE).unwrap_or(true),
        }
    }

    /// Fetch the manifest if stale (or `force`). On failure the previous
    /// manifest keeps serving and the error is recorded, never propagated as
    /// a hard failure unless there is no cached manifest at all.
    pub async fn refresh(&self, force: bool) -> Result<()> {
        if !self.is_stale(force) {
            return Ok(());
        }
        match self.fetch().await {
            Ok(manifest) => {
                self.persist(&manifest);
                let mut state = self.state.write();
                state.manifest = Some(manifest);
                state.fetched_at = Some(SystemTime::now());
                state.last_error = None;
                Ok(())
            }
            Err(err) => {
                let msg = err.to_string();
                tracing::warn!(target: "atlas_registry", "registry refresh failed: {msg}");
                let mut state = self.state.write();
                state.last_error = Some(msg.clone());
                if state.manifest.is_some() {
                    Ok(()) // stale-serving: cached data still usable
                } else {
                    Err(err)
                }
            }
        }
    }

    async fn fetch(&self) -> Result<RegistryManifest> {
        let client = reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .build()
            .map_err(|e| RegistryError::Fetch(e.to_string()))?;
        let bytes = client
            .get(REGISTRY_URL)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| RegistryError::Fetch(e.to_string()))?
            .bytes()
            .await
            .map_err(|e| RegistryError::Fetch(e.to_string()))?;
        serde_json::from_slice(&bytes).map_err(|e| RegistryError::Parse(e.to_string()))
    }

    /// Atomic tmp+rename write, same pattern as `AppState::save`.
    fn persist(&self, manifest: &RegistryManifest) {
        let _ = std::fs::create_dir_all(&self.dir);
        let path = self.dir.join("registry.json");
        let tmp = self.dir.join("registry.json.tmp");
        if let Ok(json) = serde_json::to_vec_pretty(manifest) {
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
    }

    fn icons_dir(&self) -> PathBuf {
        self.dir.join("icons")
    }

    pub fn icon_path(&self, id: &str) -> Option<PathBuf> {
        let p = self.icons_dir().join(format!("{}.svg", sanitize_id(id)));
        p.is_file().then_some(p)
    }

    /// Download any missing icons for the current manifest. Best-effort and
    /// bounded: icons are treated as immutable per id (matches Zed).
    pub async fn fetch_missing_icons(&self) {
        let agents = match self.manifest() {
            Some(m) => m.agents,
            None => return,
        };
        let dir = self.icons_dir();
        let _ = std::fs::create_dir_all(&dir);
        let client = match reqwest::Client::builder().timeout(FETCH_TIMEOUT).build() {
            Ok(c) => c,
            Err(_) => return,
        };
        for agent in agents {
            let Some(url) = agent.icon_url() else { continue };
            let dest = dir.join(format!("{}.svg", sanitize_id(&agent.id)));
            if dest.is_file() {
                continue;
            }
            match client.get(&url).send().await.and_then(|r| r.error_for_status()) {
                Ok(resp) => {
                    if let Ok(bytes) = resp.bytes().await {
                        let _ = std::fs::write(&dest, &bytes);
                    }
                }
                Err(e) => {
                    tracing::debug!(target: "atlas_registry", "icon fetch failed for {}: {e}", agent.id);
                }
            }
        }
    }
}

/// Registry ids are `[a-z0-9-]` in practice, but never trust remote input in
/// a filesystem path.
pub fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

impl RegistryCache {
    #[cfg(test)]
    pub fn set_manifest_for_tests(&self, manifest: RegistryManifest) {
        let mut state = self.state.write();
        state.manifest = Some(manifest);
        state.fetched_at = Some(SystemTime::now());
    }
}

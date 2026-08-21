//! Persisted install state for external registry agents.
//!
//! Lives in its OWN file (`<app_data>/agent-registry/installed.json`) — this
//! is Rust-owned state and must never ride `AppState`/`AppStatePatch`, or a
//! frontend settings save would wipe it. Uninstall keeps the row (marked with
//! `uninstalled_at`) so historical captured sessions can still resolve the
//! agent's display name and icon.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::manifest::Distribution;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InstallStore {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub installed: HashMap<String, InstalledAgent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledAgent {
    pub id: String,
    pub name: String,
    /// Manifest version at install time.
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
    /// The distribution block frozen at install time, so a later registry
    /// refresh (or the registry disappearing) can't change what we run.
    #[serde(default)]
    pub distribution: Distribution,
    pub installed_at: String,
    /// Set instead of removing the row — see module docs.
    #[serde(default)]
    pub uninstalled_at: Option<String>,
    /// User-supplied env overrides for this agent, layered ON TOP of the
    /// registry manifest's env and Atlas's BYOK keys (Zed's
    /// `CustomAgentServerSettings::{Custom,Registry}.env`). Empty by default.
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// A user-defined **custom** agent: an arbitrary program that speaks ACP
    /// over stdio, with no registry entry behind it (Zed's `Custom` settings
    /// variant / `LocalCustomAgent`). When set it bypasses `distribution`
    /// entirely. `None` = an ordinary registry install.
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    /// Populated after a binary distribution's download+extract completes.
    /// `None` = npx/uvx distribution (nothing cached locally) or a binary
    /// install that was interrupted (self-healed at next spawn).
    #[serde(default)]
    pub resolved_binary: Option<ResolvedBinary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedBinary {
    /// Version-hashed extract dir, absolute.
    pub cache_dir: String,
    /// `"node"` or the absolute path to the entry executable inside `cache_dir`.
    pub entry_cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

impl InstalledAgent {
    pub fn is_active(&self) -> bool {
        self.uninstalled_at.is_none()
    }
}

pub fn load(path: &PathBuf) -> InstallStore {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Atomic tmp+rename, same pattern as `AppState::save`.
pub fn save(path: &PathBuf, store: &InstallStore) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("json.tmp");
    if let Ok(json) = serde_json::to_vec_pretty(store) {
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_load_roundtrip_and_crash_leaves_old_file_intact() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("installed.json");
        let mut store = InstallStore::default();
        store.installed.insert(
            "amp-acp".into(),
            InstalledAgent {
                id: "amp-acp".into(),
                name: "Amp".into(),
                version: "0.9.0".into(),
                description: None,
                repository: None,
                website: None,
                distribution: Distribution::default(),
                env: HashMap::new(),
                command: None,
                args: Vec::new(),
                installed_at: "2026-08-14T00:00:00Z".into(),
                uninstalled_at: None,
                resolved_binary: None,
            },
        );
        save(&path, &store);
        assert_eq!(load(&path).installed.len(), 1);

        // Simulated crash: a half-written tmp file next to the real one must
        // not affect the next load.
        std::fs::write(path.with_extension("json.tmp"), b"{ corrupt").unwrap();
        assert_eq!(load(&path).installed.len(), 1);
    }
}

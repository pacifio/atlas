//! Wire schema for the official ACP registry manifest
//! (`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`).
//!
//! Shapes verified against the LIVE manifest (2026-08-14, version "1.0.0",
//! 38 agents), not just Zed's structs. Every field the registry could drop or
//! add must stay tolerable: all optionals are `#[serde(default)]` and unknown
//! fields are ignored (serde default), so upstream schema drift degrades to
//! "entry missing a nicety", never "refresh fails".

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RegistryManifest {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub agents: Vec<RegistryAgent>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RegistryAgent {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
    #[serde(default)]
    pub authors: Option<Vec<String>>,
    #[serde(default)]
    pub license: Option<String>,
    /// Absolute URL in the live registry; historically also a path relative to
    /// `https://raw.githubusercontent.com/agentclientprotocol/registry/main/{id}/`.
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub distribution: Distribution,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Distribution {
    /// Keyed by platform, e.g. "darwin-aarch64" — see [`crate::platform::platform_key`].
    #[serde(default)]
    pub binary: Option<HashMap<String, BinaryTarget>>,
    #[serde(default)]
    pub npx: Option<PackageTarget>,
    /// Python agents run via uv's `uvx` (present in the live registry, absent
    /// from Zed's schema). Same shape as npx.
    #[serde(default)]
    pub uvx: Option<PackageTarget>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BinaryTarget {
    /// Download URL: .zip / .tar.gz / .tgz, or a raw executable.
    pub archive: String,
    /// `"node"` (run via the resolved Node toolchain) or a `./relative` path
    /// inside the extracted archive.
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub sha256: Option<String>,
}

/// `npx` / `uvx` distribution: a package spec (version usually embedded, e.g.
/// `"agoragentic-mcp@1.3.0"`) plus default args/env.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PackageTarget {
    pub package: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

impl RegistryAgent {
    /// The icon URL to fetch, resolving the legacy relative form.
    pub fn icon_url(&self) -> Option<String> {
        let icon = self.icon.as_deref()?;
        if icon.starts_with("http://") || icon.starts_with("https://") {
            return Some(icon.to_string());
        }
        Some(format!(
            "https://raw.githubusercontent.com/agentclientprotocol/registry/main/{}/{}",
            self.id, icon
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed sample of the LIVE manifest (fetched 2026-08-14) — covers npx,
    /// per-platform binary+sha256, uvx, and extra fields (authors/license).
    const SAMPLE: &str = r#"{
      "version": "1.0.0",
      "agents": [
        {
          "id": "agoragentic-acp", "name": "Agoragentic", "version": "1.3.0",
          "description": "Agent marketplace", "repository": "https://github.com/rhein1/agoragentic-integrations",
          "website": "https://agoragentic.com", "authors": ["ACRE"], "license": "MIT",
          "distribution": { "npx": { "package": "agoragentic-mcp@1.3.0", "args": ["--acp"] } },
          "icon": "https://cdn.agentclientprotocol.com/registry/v1/latest/agoragentic-acp.svg"
        },
        {
          "id": "amp-acp", "name": "Amp", "version": "0.9.0",
          "distribution": { "binary": { "darwin-aarch64": {
            "archive": "https://github.com/tao12345666333/amp-acp/releases/download/v0.9.0/amp-acp-darwin-aarch64.tar.gz",
            "cmd": "./amp-acp",
            "sha256": "240a1a464f2a400ae51e9613b7f52b2abb6e7a29759001e9185291325671ccf1"
          } } }
        },
        {
          "id": "fast-agent", "name": "fast-agent", "version": "0.10.1",
          "distribution": { "uvx": { "package": "fast-agent-mcp@0.10.1", "args": ["acp"] } },
          "some_future_field": { "nested": true }
        }
      ]
    }"#;

    #[test]
    fn parses_live_shapes_and_tolerates_unknown_fields() {
        let m: RegistryManifest = serde_json::from_str(SAMPLE).unwrap();
        assert_eq!(m.agents.len(), 3);
        assert_eq!(m.agents[0].distribution.npx.as_ref().unwrap().package, "agoragentic-mcp@1.3.0");
        let bin = m.agents[1].distribution.binary.as_ref().unwrap();
        assert!(bin["darwin-aarch64"].sha256.is_some());
        assert_eq!(m.agents[2].distribution.uvx.as_ref().unwrap().args, vec!["acp"]);
    }

    #[test]
    fn relative_icon_resolves_against_registry_repo() {
        let a = RegistryAgent {
            id: "x".into(),
            name: "X".into(),
            version: String::new(),
            description: None,
            repository: None,
            website: None,
            authors: None,
            license: None,
            icon: Some("icon.svg".into()),
            distribution: Distribution::default(),
        };
        assert_eq!(
            a.icon_url().unwrap(),
            "https://raw.githubusercontent.com/agentclientprotocol/registry/main/x/icon.svg"
        );
    }
}

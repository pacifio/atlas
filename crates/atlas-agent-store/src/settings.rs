//! The installed map — the only source of external agents.
//!
//! Ported from Zed's `AllAgentServersSettings` / `CustomAgentServerSettings`
//! (`agent_server_store.rs:1508-1596`, wire shape
//! `settings_content/src/agent.rs:734-796`). The JSON is Zed's, verbatim:
//!
//! ```json
//! {
//!   "my-agent":  { "type": "custom",   "command": "~/bin/agent", "args": ["--acp"] },
//!   "some-cli":  { "type": "registry", "env": { "SOME_TOKEN": "…" } }
//! }
//! ```
//!
//! An entry here *is* installation. There is no other way for an external agent
//! to exist, and no entry is ever written by Atlas on the user's behalf.

use std::collections::HashMap;
use std::path::PathBuf;

use atlas_agent_servers::connection::AgentServerCommand;
use serde::{Deserialize, Serialize};

/// One installed agent, as it is written in settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentServerSettings {
    /// A command the user pointed us at. Never written by the marketplace's
    /// registry install — only by a hand edit, or by accepting a
    /// [`crate::detection`] hit.
    Custom {
        #[serde(rename = "command")]
        path: PathBuf,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        args: Vec<String>,
        #[serde(default, skip_serializing_if = "HashMap::is_empty")]
        env: HashMap<String, String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default_mode: Option<String>,
        #[serde(default, skip_serializing_if = "HashMap::is_empty")]
        default_config_options: HashMap<String, serde_json::Value>,
        #[serde(default, skip_serializing_if = "HashMap::is_empty")]
        favorite_config_option_values: HashMap<String, Vec<String>>,
    },
    /// An agent installed from the registry. The key is its registry id; the
    /// distribution, version and command all come from the registry index, so
    /// the only thing worth storing is what the user configured.
    ///
    /// `extension` is accepted as an alias the way Zed accepts it, so a map
    /// written by its ACP-extension migration still reads.
    #[serde(alias = "extension")]
    Registry {
        #[serde(default, skip_serializing_if = "HashMap::is_empty")]
        env: HashMap<String, String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default_mode: Option<String>,
        #[serde(default, skip_serializing_if = "HashMap::is_empty")]
        default_config_options: HashMap<String, serde_json::Value>,
        #[serde(default, skip_serializing_if = "HashMap::is_empty")]
        favorite_config_option_values: HashMap<String, Vec<String>>,
    },
}

impl AgentServerSettings {
    /// A registry install, with nothing configured — what the marketplace's
    /// "Install" button writes (Zed's `agent_registry_ui.rs:507-538`).
    pub fn registry() -> Self {
        Self::Registry {
            env: HashMap::new(),
            default_mode: None,
            default_config_options: HashMap::new(),
            favorite_config_option_values: HashMap::new(),
        }
    }

    /// A custom install pointing at a command already on this machine.
    pub fn custom(path: impl Into<PathBuf>, args: Vec<String>) -> Self {
        Self::Custom {
            path: path.into(),
            args,
            env: HashMap::new(),
            default_mode: None,
            default_config_options: HashMap::new(),
            favorite_config_option_values: HashMap::new(),
        }
    }

    pub fn default_mode(&self) -> Option<&str> {
        match self {
            Self::Custom { default_mode, .. } | Self::Registry { default_mode, .. } => {
                default_mode.as_deref()
            }
        }
    }

    pub fn env(&self) -> &HashMap<String, String> {
        match self {
            Self::Custom { env, .. } | Self::Registry { env, .. } => env,
        }
    }

    pub fn default_config_options(&self) -> &HashMap<String, serde_json::Value> {
        match self {
            Self::Custom {
                default_config_options,
                ..
            }
            | Self::Registry {
                default_config_options,
                ..
            } => default_config_options,
        }
    }

    pub fn favorite_config_option_values(&self, config_id: &str) -> Option<&[String]> {
        match self {
            Self::Custom {
                favorite_config_option_values,
                ..
            }
            | Self::Registry {
                favorite_config_option_values,
                ..
            } => favorite_config_option_values
                .get(config_id)
                .map(Vec::as_slice),
        }
    }

    /// The command a `Custom` entry runs, with `~` expanded (Zed does the same
    /// at `agent_server_store.rs:1637`). `None` for a registry entry, whose
    /// command is resolved from its distribution instead.
    pub fn command(&self) -> Option<AgentServerCommand> {
        match self {
            Self::Custom {
                path, args, env, ..
            } => Some(AgentServerCommand {
                path: expand_tilde(path),
                args: args.clone(),
                env: Some(env.clone()),
            }),
            Self::Registry { .. } => None,
        }
    }
}

/// The whole installed map.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AllAgentServersSettings(pub HashMap<String, AgentServerSettings>);

impl AllAgentServersSettings {
    /// Whether anything here needs the registry index to resolve. Zed uses this
    /// to decide whether a settings change is worth a registry refresh
    /// (`agent_server_store.rs:316-322`) — an install map of only `Custom`
    /// entries never touches the network.
    pub fn has_registry_agents(&self) -> bool {
        self.0
            .values()
            .any(|entry| matches!(entry, AgentServerSettings::Registry { .. }))
    }
}

impl std::ops::Deref for AllAgentServersSettings {
    type Target = HashMap<String, AgentServerSettings>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for AllAgentServersSettings {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl FromIterator<(String, AgentServerSettings)> for AllAgentServersSettings {
    fn from_iter<T: IntoIterator<Item = (String, AgentServerSettings)>>(iter: T) -> Self {
        Self(iter.into_iter().collect())
    }
}

/// Zed calls `shellexpand::tilde`. This is the one case of it that matters — a
/// leading `~/` in a hand-written command path — done without the dependency.
fn expand_tilde(path: &std::path::Path) -> PathBuf {
    let Some(text) = path.to_str() else {
        return path.to_owned();
    };
    let Some(rest) = text.strip_prefix("~/") else {
        return path.to_owned();
    };
    let Some(home) = home_dir() else {
        return path.to_owned();
    };
    home.join(rest)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

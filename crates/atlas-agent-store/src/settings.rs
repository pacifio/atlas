//! The installed map — the only source of external agents.
//!
//! The JSON shape:
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
        /// Off: kept installed, but out of the picker and never started.
        #[serde(default = "on", skip_serializing_if = "is_on")]
        enabled: bool,
        /// The user's name for it, over the registry's or the detection's.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display_name: Option<String>,
        /// Model ids kept out of the model picker.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        hidden_models: Vec<String>,
        /// The order the model picker lists models in; ids not here follow,
        /// in the agent's own order.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        model_order: Vec<String>,
        /// Models the user added that the agent doesn't advertise.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        custom_models: Vec<CustomModel>,
        /// Variables whose values live in the OS keychain, not in this file.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        secret_env: Vec<String>,
    },
    /// An agent installed from the registry. The key is its registry id; the
    /// distribution, version and command all come from the registry index, so
    /// the only thing worth storing is what the user configured.
    ///
    /// `extension` is accepted as an alias, so a map
    /// written by an ACP-extension migration still reads.
    #[serde(alias = "extension")]
    Registry {
        /// Appended after the arguments the registry's distribution gives.
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
        /// Off: kept installed, but out of the picker and never started.
        #[serde(default = "on", skip_serializing_if = "is_on")]
        enabled: bool,
        /// The user's name for it, over the registry's or the detection's.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display_name: Option<String>,
        /// Model ids kept out of the model picker.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        hidden_models: Vec<String>,
        /// The order the model picker lists models in; ids not here follow,
        /// in the agent's own order.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        model_order: Vec<String>,
        /// Models the user added that the agent doesn't advertise.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        custom_models: Vec<CustomModel>,
        /// Variables whose values live in the OS keychain, not in this file.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        secret_env: Vec<String>,
    },
}

impl AgentServerSettings {
    /// A registry install, with nothing configured — what the marketplace's
    /// "Install" button writes.
    pub fn registry() -> Self {
        Self::Registry {
            args: Vec::new(),
            env: HashMap::new(),
            default_mode: None,
            default_config_options: HashMap::new(),
            favorite_config_option_values: HashMap::new(),
            enabled: true,
            display_name: None,
            hidden_models: Vec::new(),
            model_order: Vec::new(),
            custom_models: Vec::new(),
            secret_env: Vec::new(),
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
            enabled: true,
            display_name: None,
            hidden_models: Vec::new(),
            model_order: Vec::new(),
            custom_models: Vec::new(),
            secret_env: Vec::new(),
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

    /// [`Self::env`] as the agent's process gets it: a leading `~/` (or a
    /// lone `~`) is the home directory, as it would be in a shell's
    /// `NAME=~/path`. Agents read `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and the
    /// like literally, and Codex requires its home to exist.
    pub fn launch_env(&self) -> HashMap<String, String> {
        launch_env(self.env())
    }

    /// The arguments the user set: a custom entry's whole list, or what a
    /// registry entry appends to its distribution's.
    pub fn args(&self) -> &[String] {
        match self {
            Self::Custom { args, .. } | Self::Registry { args, .. } => args,
        }
    }

    /// Whether the agent is on. An entry that never said is.
    pub fn enabled(&self) -> bool {
        match self {
            Self::Custom { enabled, .. } | Self::Registry { enabled, .. } => *enabled,
        }
    }

    pub fn display_name(&self) -> Option<&str> {
        match self {
            Self::Custom { display_name, .. } | Self::Registry { display_name, .. } => {
                display_name.as_deref()
            }
        }
    }

    pub fn hidden_models(&self) -> &[String] {
        match self {
            Self::Custom { hidden_models, .. } | Self::Registry { hidden_models, .. } => {
                hidden_models
            }
        }
    }

    pub fn model_order(&self) -> &[String] {
        match self {
            Self::Custom { model_order, .. } | Self::Registry { model_order, .. } => model_order,
        }
    }

    pub fn custom_models(&self) -> &[CustomModel] {
        match self {
            Self::Custom { custom_models, .. } | Self::Registry { custom_models, .. } => {
                custom_models
            }
        }
    }

    /// The names of the variables kept in the keychain. Their values are
    /// added at launch by whoever holds the keychain, never stored here.
    pub fn secret_env(&self) -> &[String] {
        match self {
            Self::Custom { secret_env, .. } | Self::Registry { secret_env, .. } => secret_env,
        }
    }

    /// Everything Settings → Agents may change, borrowed for writing.
    pub fn user_settings_mut(&mut self) -> UserSettingsMut<'_> {
        match self {
            Self::Custom {
                path,
                args,
                env,
                enabled,
                display_name,
                hidden_models,
                model_order,
                custom_models,
                secret_env,
                ..
            } => UserSettingsMut {
                command: Some(path),
                args,
                env,
                enabled,
                display_name,
                hidden_models,
                model_order,
                custom_models,
                secret_env,
            },
            Self::Registry {
                args,
                env,
                enabled,
                display_name,
                hidden_models,
                model_order,
                custom_models,
                secret_env,
                ..
            } => UserSettingsMut {
                command: None,
                args,
                env,
                enabled,
                display_name,
                hidden_models,
                model_order,
                custom_models,
                secret_env,
            },
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

    /// The command a `Custom` entry runs, with `~` expanded. `None` for a registry entry, whose
    /// command is resolved from its distribution instead.
    pub fn command(&self) -> Option<AgentServerCommand> {
        match self {
            Self::Custom {
                path, args, env, ..
            } => Some(AgentServerCommand {
                path: expand_tilde(path),
                args: args.clone(),
                env: Some(launch_env(env)),
            }),
            Self::Registry { .. } => None,
        }
    }
}

/// The fields of one entry the user edits in Settings → Agents.
pub struct UserSettingsMut<'a> {
    /// `None` for a registry entry: its command comes from the registry.
    pub command: Option<&'a mut PathBuf>,
    pub args: &'a mut Vec<String>,
    pub env: &'a mut HashMap<String, String>,
    pub enabled: &'a mut bool,
    pub display_name: &'a mut Option<String>,
    pub hidden_models: &'a mut Vec<String>,
    pub model_order: &'a mut Vec<String>,
    pub custom_models: &'a mut Vec<CustomModel>,
    pub secret_env: &'a mut Vec<String>,
}

/// A model the user added by id. The agent decides whether it accepts it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[allow(clippy::trivially_copy_pass_by_ref)] // serde's skip_serializing_if takes a reference
fn is_on(value: &bool) -> bool {
    *value
}

fn on() -> bool {
    true
}

/// The whole installed map.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AllAgentServersSettings(pub HashMap<String, AgentServerSettings>);

impl AllAgentServersSettings {
    /// Whether anything here needs the registry index to resolve. This decides
    /// whether a settings change is worth a registry refresh — an install map of only `Custom`
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

/// Tilde expansion. This is the one case that matters — a
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

fn launch_env(env: &HashMap<String, String>) -> HashMap<String, String> {
    env.iter()
        .map(|(name, value)| {
            let value = match (value.as_str(), home_dir()) {
                ("~", Some(home)) => home.display().to_string(),
                (v, Some(home)) if v.starts_with("~/") => home.join(&v[2..]).display().to_string(),
                _ => value.clone(),
            };
            (name.clone(), value)
        })
        .collect()
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_variable_starting_with_tilde_reaches_the_agent_under_home() {
        let Some(home) = home_dir() else { return };
        let env = HashMap::from([
            ("CODEX_HOME".to_string(), "~/.codex".to_string()),
            ("BARE".to_string(), "~".to_string()),
            ("MID".to_string(), "a~/b".to_string()),
            ("USER_TILDE".to_string(), "~other/x".to_string()),
        ]);
        let out = launch_env(&env);
        assert_eq!(out["CODEX_HOME"], home.join(".codex").display().to_string());
        assert_eq!(out["BARE"], home.display().to_string());
        assert_eq!(out["MID"], "a~/b");
        assert_eq!(out["USER_TILDE"], "~other/x");
    }

    /// A map written before Settings → Agents could turn agents off has no
    /// `enabled` key, and every agent in it was on.
    #[test]
    fn an_entry_that_never_said_is_on() {
        let entry: AgentServerSettings =
            serde_json::from_value(serde_json::json!({ "type": "registry" })).unwrap();
        assert!(entry.enabled());
        assert_eq!(entry.display_name(), None);
        assert!(entry.args().is_empty());
        assert!(entry.hidden_models().is_empty());
    }

    /// Defaults stay out of the file, so an untouched install still writes
    /// `{ "type": "registry" }` and a hand edit stays readable.
    #[test]
    fn defaults_are_not_written() {
        let json = serde_json::to_value(AgentServerSettings::registry()).unwrap();
        assert_eq!(json, serde_json::json!({ "type": "registry" }));
    }

    #[test]
    fn what_the_user_set_round_trips() {
        let mut entry = AgentServerSettings::custom("/opt/agent", vec!["--acp".into()]);
        {
            let user = entry.user_settings_mut();
            *user.enabled = false;
            *user.display_name = Some("Work agent".into());
            user.hidden_models.push("old-model".into());
            user.env.insert("REGION".into(), "eu".into());
        }
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(json["enabled"], false);
        assert_eq!(json["display_name"], "Work agent");
        let back: AgentServerSettings = serde_json::from_value(json).unwrap();
        assert_eq!(back, entry);
    }

    #[test]
    fn a_registry_entry_has_no_command_to_edit() {
        let mut entry = AgentServerSettings::registry();
        let user = entry.user_settings_mut();
        assert!(user.command.is_none());
        user.args.push("--fast".into());
        assert_eq!(entry.args(), ["--fast"]);
    }
}

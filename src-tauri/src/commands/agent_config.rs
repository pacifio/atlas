//! What the user sets per agent in Settings → Agents: whether it is on, the
//! name it goes by, how it launches, its environment, and how its models show
//! in the picker (hidden, ordered, and any the user added by id).
//!
//! A variable marked sensitive keeps only its name in the installed map; its
//! value goes to the OS keychain ([`super::agent_secrets`]) and never comes
//! back to the webview.
//!
//! An external agent keeps these in its installed-map entry, beside the rest
//! of what the user configured about it, so a hand edit of `installed.json`
//! and the settings page agree. The native agent has no entry there — the map
//! is the list of external agents, and an entry *is* an install — so its two
//! applicable fields live in a small file of their own in Atlas's config
//! directory.
//!
//! One command writes them all, [`agents_configure`], and answers with the
//! agent's catalog entry as it now stands.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use atlas_native_agent::ATLAS_AGENT_ID;

use super::agent_host::AgentHost;
use super::catalog::{self, AgentCatalogEntry};

/// The native agent's share of the per-agent settings. It cannot be turned
/// off and has no command, arguments or environment of its own.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeAgentPrefs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hidden_models: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub model_order: Vec<String>,
}

fn native_prefs_path(config_dir: &Path) -> PathBuf {
    config_dir.join("native-agent.json")
}

/// A missing or unreadable file is the defaults: nothing renamed or hidden.
pub fn load_native_prefs(config_dir: &Path) -> NativeAgentPrefs {
    let path = native_prefs_path(config_dir);
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|e| {
            tracing::warn!(
                target: "atlas::agents",
                path = %path.display(),
                "native agent settings are unreadable ({e}); using the defaults"
            );
            NativeAgentPrefs::default()
        }),
        Err(_) => NativeAgentPrefs::default(),
    }
}

fn save_native_prefs(config_dir: &Path, prefs: &NativeAgentPrefs) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let json = serde_json::to_string_pretty(prefs)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(native_prefs_path(config_dir), json)
}

/// How an external agent launches, as the catalog reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLaunch {
    /// A custom entry's executable. `None` for a registry install, whose
    /// command the registry names.
    pub command: Option<String>,
    pub args: Vec<String>,
    /// Plain variables, then sensitive ones, each sorted by name.
    pub variables: Vec<AgentVariable>,
}

/// One environment variable, as the catalog reports it and a patch sets it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentVariable {
    pub name: String,
    /// Always `None` for a sensitive variable in the catalog. In a patch,
    /// `None` on a sensitive variable keeps the value already stored.
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub sensitive: bool,
}

impl AgentLaunch {
    /// The launch settings of an installed-map entry, without a secret value.
    pub fn of(entry: &atlas_agent_store::AgentServerSettings) -> Self {
        let mut plain = entry
            .env()
            .iter()
            .map(|(name, value)| AgentVariable {
                name: name.clone(),
                value: Some(value.clone()),
                sensitive: false,
            })
            .collect::<Vec<_>>();
        plain.sort_by(|a, b| a.name.cmp(&b.name));
        let mut secret = entry
            .secret_env()
            .iter()
            .map(|name| AgentVariable {
                name: name.clone(),
                value: None,
                sensitive: true,
            })
            .collect::<Vec<_>>();
        secret.sort_by(|a, b| a.name.cmp(&b.name));
        plain.extend(secret);
        Self {
            command: entry.command().map(|c| c.path.display().to_string()),
            args: entry.args().to_vec(),
            variables: plain,
        }
    }
}

/// One `agents_configure` call: only what changes.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigPatch {
    pub enabled: Option<bool>,
    /// `Some(None)` (JSON `null`) and a blank name both go back to the
    /// agent's own name.
    #[serde(default, deserialize_with = "explicit_null")]
    pub display_name: Option<Option<String>>,
    pub hidden_models: Option<Vec<String>>,
    pub model_order: Option<Vec<String>>,
    pub custom_models: Option<Vec<atlas_agent_store::CustomModel>>,
    pub launch: Option<LaunchPatch>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPatch {
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    /// The whole list: a variable left out is removed.
    pub variables: Option<Vec<AgentVariable>>,
}

/// What a patch asks of the keychain, done by the caller after the pure
/// [`apply_to_entry`].
#[derive(Debug, Default, PartialEq, Eq)]
pub struct KeychainWrites {
    pub set: Vec<(String, String)>,
    pub delete: Vec<String>,
}

/// Tell "absent" (keep it) from `null` (clear it): serde reads both as `None`
/// for a plain `Option`.
fn explicit_null<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

/// A name the user typed, or `None` for "use the agent's own".
fn clean_name(name: Option<String>) -> Option<String> {
    name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty())
}

/// A variable name a process environment can carry.
fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Apply a patch to an installed-map entry. Pure, so the rules are tested
/// without a host.
pub fn apply_to_entry(
    entry: &mut atlas_agent_store::AgentServerSettings,
    patch: AgentConfigPatch,
) -> Result<KeychainWrites, String> {
    let mut keychain = KeychainWrites::default();
    let user = entry.user_settings_mut();
    if let Some(enabled) = patch.enabled {
        *user.enabled = enabled;
    }
    if let Some(name) = patch.display_name {
        *user.display_name = clean_name(name);
    }
    if let Some(hidden) = patch.hidden_models {
        *user.hidden_models = hidden;
    }
    if let Some(order) = patch.model_order {
        *user.model_order = order;
    }
    if let Some(custom) = patch.custom_models {
        let mut seen = std::collections::HashSet::new();
        let mut cleaned = Vec::with_capacity(custom.len());
        for model in custom {
            let id = model.id.trim().to_string();
            if id.is_empty() {
                return Err("a custom model needs an id".into());
            }
            if seen.insert(id.clone()) {
                cleaned.push(atlas_agent_store::CustomModel {
                    id,
                    name: clean_name(model.name),
                });
            }
        }
        *user.custom_models = cleaned;
    }
    if let Some(launch) = patch.launch {
        if let Some(command) = launch.command {
            let command = command.trim();
            let Some(path) = user.command else {
                return Err("a registry agent's command comes from the registry".into());
            };
            if command.is_empty() {
                return Err("the command can't be empty".into());
            }
            *path = PathBuf::from(command);
        }
        if let Some(args) = launch.args {
            *user.args = args;
        }
        if let Some(variables) = launch.variables {
            let mut env = HashMap::new();
            let mut secret = Vec::new();
            for variable in variables {
                let name = variable.name.trim().to_string();
                if !valid_env_name(&name) {
                    return Err(format!("`{name}` isn't a valid variable name"));
                }
                if env.contains_key(&name) || secret.contains(&name) {
                    return Err(format!("{name} is set twice"));
                }
                if variable.sensitive {
                    match variable.value {
                        Some(value) => keychain.set.push((name.clone(), value)),
                        None if user.secret_env.contains(&name) => {}
                        None => return Err(format!("{name} needs a value")),
                    }
                    secret.push(name);
                } else {
                    env.insert(name, variable.value.unwrap_or_default());
                }
            }
            keychain.delete = user
                .secret_env
                .iter()
                .filter(|name| !secret.contains(name))
                .cloned()
                .collect();
            secret.sort();
            *user.env = env;
            *user.secret_env = secret;
        }
    }
    Ok(keychain)
}

/// Apply a patch to the native agent's settings.
pub fn apply_to_native(
    prefs: &mut NativeAgentPrefs,
    patch: AgentConfigPatch,
) -> Result<(), String> {
    if patch.enabled == Some(false) {
        return Err("Atlas Agent can't be turned off".into());
    }
    if patch.launch.is_some() {
        return Err("Atlas Agent runs inside Atlas; it has no launch settings".into());
    }
    if patch.custom_models.is_some() {
        return Err("Atlas Agent's models come from its gateway; it takes no custom ones".into());
    }
    if let Some(name) = patch.display_name {
        prefs.display_name = clean_name(name);
    }
    if let Some(hidden) = patch.hidden_models {
        prefs.hidden_models = hidden;
    }
    if let Some(order) = patch.model_order {
        prefs.model_order = order;
    }
    Ok(())
}

/// Change what the user set for one agent, and answer with its catalog entry
/// as it now stands. Emits `atlas:agent-catalog:changed`, so every other
/// agent surface (the picker, labels) follows.
#[tauri::command]
pub async fn agents_configure(
    agent_id: String,
    patch: AgentConfigPatch,
    host: State<'_, Arc<AgentHost>>,
    app: AppHandle,
) -> Result<AgentCatalogEntry, String> {
    let host = host.inner().clone();
    if agent_id == ATLAS_AGENT_ID {
        let config_dir = host.config_dir().to_path_buf();
        let mut prefs = load_native_prefs(&config_dir);
        apply_to_native(&mut prefs, patch)?;
        tauri::async_runtime::spawn_blocking(move || save_native_prefs(&config_dir, &prefs))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("writing Atlas Agent's settings: {e}"))?;
    } else {
        let mut settings = host.store().settings();
        let entry = settings
            .0
            .get_mut(&agent_id)
            .ok_or_else(|| format!("{agent_id} is not installed"))?;
        let turning_off = patch.enabled == Some(false);
        let keychain = apply_to_entry(entry, patch)?;
        // New values before the map that names them: a name the map lists
        // with no stored value would launch the agent without it. Deletes
        // after it, so a failed save can't lose a value the map still names;
        // a failed delete only leaves an item nothing reads.
        let agent = agent_id.clone();
        let set = keychain.set;
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            for (name, value) in &set {
                super::agent_secrets::write(&agent, name, value)?;
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())??;
        let data_dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir());
        super::registry::persist(&host, &data_dir, settings).await?;
        let agent = agent_id.clone();
        let delete = keychain.delete;
        tauri::async_runtime::spawn_blocking(move || {
            for name in &delete {
                if let Err(e) = super::agent_secrets::delete(&agent, name) {
                    tracing::warn!("couldn't remove {agent}/{name} from the keychain: {e}");
                }
            }
        })
        .await
        .map_err(|e| e.to_string())?;
        // Off means not running, not just not started next time.
        if turning_off {
            host.turn_off(&agent_id).map_err(|e| e.to_string())?;
        }
    }
    catalog::emit_catalog_changed(&app, "settings");
    catalog::entry_for(&host, &agent_id).ok_or_else(|| format!("{agent_id} is not in the catalog"))
}

/// `~/…` against the home directory; anything else as given.
fn expand_home(path: &str, home: Option<&Path>) -> PathBuf {
    match (
        path.strip_prefix("~/").or((path == "~").then_some("")),
        home,
    ) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(path),
    }
}

/// Where an agent's own config file is, made to exist so it can open as a
/// tab: `empty` is written to it when it is missing, along with any missing
/// folders. Settings → Agents uses it for "Open settings.json" and the like;
/// what the file says is the agent's business, read by the agent at launch.
#[tauri::command]
pub async fn agents_open_config_file(path: String, empty: String) -> Result<String, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let path = expand_home(path.trim(), home.as_deref());
    if !path.is_absolute() {
        return Err(format!("{} isn't an absolute path", path.display()));
    }
    tauri::async_runtime::spawn_blocking(move || {
        if !path.exists() {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&path, empty)?;
        }
        Ok::<_, std::io::Error>(path.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("opening the config file: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_agent_store::AgentServerSettings;

    fn patch(json: serde_json::Value) -> AgentConfigPatch {
        serde_json::from_value(json).expect("a well-formed patch")
    }

    #[test]
    fn a_patch_changes_only_what_it_names() {
        let mut entry = AgentServerSettings::custom("/opt/agent", vec!["--acp".into()]);
        apply_to_entry(&mut entry, patch(serde_json::json!({ "enabled": false }))).unwrap();
        assert!(!entry.enabled());
        assert_eq!(entry.args(), ["--acp"]);

        apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "launch": { "variables": [{ "name": "REGION", "value": "eu" }] } })),
        )
        .unwrap();
        assert_eq!(entry.env().get("REGION").map(String::as_str), Some("eu"));
        assert_eq!(entry.args(), ["--acp"], "env alone leaves the arguments");
    }

    /// `null` and a blank name both mean "use the agent's own name"; a field
    /// left out keeps what was there.
    #[test]
    fn a_display_name_clears_on_null_or_blank() {
        let mut entry = AgentServerSettings::registry();
        apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "displayName": " Work " })),
        )
        .unwrap();
        assert_eq!(entry.display_name(), Some("Work"));
        apply_to_entry(&mut entry, patch(serde_json::json!({ "enabled": true }))).unwrap();
        assert_eq!(entry.display_name(), Some("Work"));
        apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "displayName": null })),
        )
        .unwrap();
        assert_eq!(entry.display_name(), None);
        apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "displayName": "  " })),
        )
        .unwrap();
        assert_eq!(entry.display_name(), None);
    }

    #[test]
    fn a_registry_agents_command_is_not_the_users_to_set() {
        let mut entry = AgentServerSettings::registry();
        let err = apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "launch": { "command": "/bin/sh" } })),
        )
        .unwrap_err();
        assert!(err.contains("registry"), "{err}");
    }

    #[test]
    fn a_custom_command_can_be_replaced_but_not_emptied() {
        let mut entry = AgentServerSettings::custom("/opt/agent", vec![]);
        apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "launch": { "command": "/opt/other" } })),
        )
        .unwrap();
        assert_eq!(
            entry.command().map(|c| c.path),
            Some(PathBuf::from("/opt/other"))
        );
        assert!(apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "launch": { "command": " " } })),
        )
        .is_err());
    }

    #[test]
    fn an_invalid_variable_name_is_refused() {
        let mut entry = AgentServerSettings::registry();
        let err = apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "launch": { "variables": [{ "name": "1BAD", "value": "x" }] } })),
        )
        .unwrap_err();
        assert!(err.contains("1BAD"), "{err}");
        assert!(entry.env().is_empty(), "nothing is half-written");
    }

    /// A sensitive value goes to the keychain and only its name to the map;
    /// sending it back without a value keeps what is stored, and making it
    /// plain again or dropping it deletes the stored one.
    #[test]
    fn sensitive_variables_keep_only_their_name_in_the_map() {
        let mut entry = AgentServerSettings::registry();
        let writes = apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "launch": { "variables": [
                { "name": "REGION", "value": "eu" },
                { "name": "API_TOKEN", "value": "s3cret", "sensitive": true },
            ] } })),
        )
        .unwrap();
        assert_eq!(
            writes.set,
            [("API_TOKEN".to_string(), "s3cret".to_string())]
        );
        assert!(writes.delete.is_empty());
        assert_eq!(entry.secret_env(), ["API_TOKEN"]);
        assert!(!entry.env().contains_key("API_TOKEN"));
        let json = serde_json::to_string(&entry).unwrap();
        assert!(
            !json.contains("s3cret"),
            "the value never reaches the file: {json}"
        );

        let launch = AgentLaunch::of(&entry);
        assert_eq!(launch.variables[1].name, "API_TOKEN");
        assert_eq!(launch.variables[1].value, None, "nor the webview");

        let writes = apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "launch": { "variables": [
                { "name": "REGION", "value": "eu" },
                { "name": "API_TOKEN", "sensitive": true },
            ] } })),
        )
        .unwrap();
        assert_eq!(
            writes,
            KeychainWrites::default(),
            "an unchanged secret is left alone"
        );

        let writes = apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "launch": { "variables": [
                { "name": "REGION", "value": "eu" },
            ] } })),
        )
        .unwrap();
        assert_eq!(writes.delete, ["API_TOKEN"]);
        assert!(entry.secret_env().is_empty());
    }

    #[test]
    fn a_new_sensitive_variable_needs_a_value_and_names_are_unique() {
        let mut entry = AgentServerSettings::registry();
        assert!(apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "launch": { "variables": [
                { "name": "TOKEN", "sensitive": true },
            ] } })),
        )
        .is_err());
        assert!(apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "launch": { "variables": [
                { "name": "A", "value": "1" },
                { "name": "A", "value": "2", "sensitive": true },
            ] } })),
        )
        .is_err());
    }

    #[test]
    fn custom_models_are_trimmed_and_deduplicated() {
        let mut entry = AgentServerSettings::registry();
        apply_to_entry(
            &mut entry,
            patch(serde_json::json!({
                "customModels": [{ "id": " m1 " }, { "id": "m1", "name": "Again" }, { "id": "m2", "name": " " }],
                "modelOrder": ["m2", "m1"],
            })),
        )
        .unwrap();
        assert_eq!(
            entry.custom_models(),
            [
                atlas_agent_store::CustomModel {
                    id: "m1".into(),
                    name: None
                },
                atlas_agent_store::CustomModel {
                    id: "m2".into(),
                    name: None
                },
            ]
        );
        assert_eq!(entry.model_order(), ["m2", "m1"]);
        assert!(apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "customModels": [{ "id": "  " }] })),
        )
        .is_err());
    }

    #[test]
    fn the_native_agent_can_be_renamed_but_not_turned_off() {
        let mut prefs = NativeAgentPrefs::default();
        apply_to_native(
            &mut prefs,
            patch(serde_json::json!({ "displayName": "Atlas", "hiddenModels": ["m"] })),
        )
        .unwrap();
        assert_eq!(prefs.display_name.as_deref(), Some("Atlas"));
        assert_eq!(prefs.hidden_models, ["m"]);
        assert!(
            apply_to_native(&mut prefs, patch(serde_json::json!({ "enabled": false }))).is_err()
        );
        assert!(apply_to_native(
            &mut prefs,
            patch(serde_json::json!({ "launch": { "args": [] } })),
        )
        .is_err());
    }

    #[test]
    fn a_config_path_expands_home_only_at_the_start() {
        let home = Path::new("/home/u");
        assert_eq!(
            expand_home("~/.claude/settings.json", Some(home)),
            home.join(".claude/settings.json")
        );
        assert_eq!(expand_home("~", Some(home)), home.join(""));
        assert_eq!(expand_home("/etc/x", Some(home)), PathBuf::from("/etc/x"));
        assert_eq!(expand_home("~/x", None), PathBuf::from("~/x"));
    }

    #[test]
    fn native_prefs_round_trip_through_disk() {
        let dir = std::env::temp_dir().join(format!("atlas-native-prefs-{}", uuid::Uuid::new_v4()));
        assert_eq!(load_native_prefs(&dir), NativeAgentPrefs::default());
        let prefs = NativeAgentPrefs {
            display_name: Some("Atlas".into()),
            hidden_models: vec!["m".into()],
            model_order: vec!["b".into(), "a".into()],
        };
        save_native_prefs(&dir, &prefs).unwrap();
        assert_eq!(load_native_prefs(&dir), prefs);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

//! Per-project settings: `<project>/.atlas/config.toml`.
//!
//! A sparse overlay on the global `config.toml`. It holds only the keys a
//! project changes, and only keys the settings registry marks `project = true`
//! (`PROJECT_SETTING_KEYS`) — the ones whose every reader knows which project
//! it is acting in. Anything else in the file is left alone and reported as
//! ignored, never applied.
//!
//! The file lives in `.atlas/`, which Atlas keeps out of git, so an override
//! is normally the user's own. Normally: nothing stops a repository from
//! committing one, and a clone would then carry it. So a key that grants
//! access or sends data (`PROJECT_TIGHTEN_ONLY_KEYS`: the agent permissions,
//! the memory jobs, auto-fetch) can only be turned *off* by a project. A
//! project file that tries to switch one on while the user has it off is
//! refused for that key and reported.
//!
//! Resolution is one function, [`resolve`]: the global settings with each
//! override laid over them, validated as a whole, plus the list of keys the
//! project set. The Settings UI shows that list as each row's source; the
//! Rust readers (the agent tool gates, auto-fetch, the memory jobs) call
//! [`ProjectConfigs::effective`] with the project they are acting in.
//!
//! Writes go through `toml_edit`, like the global file, so a hand-written
//! comment survives the Settings UI. A key the UI adds gets the same comment
//! a fresh global file has above it.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Map, Value};

use super::atlas_config::{
    document_added_keys, settings_keys_in, validate, write_atomic, AppSettings,
    PROJECT_SETTING_KEYS, PROJECT_TIGHTEN_ONLY_KEYS,
};

pub const PROJECT_CONFIG_FILE: &str = "config.toml";

pub(crate) const PROJECT_CONFIG_HEADER: &str = "\
# Atlas settings for this project.
#
# Keys here override your global config.toml while this project is open.
# Only some settings can be set per project; Settings marks them, and Atlas
# ignores any other key here. Delete a line to go back to the global value.
#
# This file is in Atlas's project directory, which Atlas keeps out of git:
# these overrides are yours, not your team's.

schemaVersion = 1

[settings]
";

/// `<project>/.atlas/config.toml` (`.atlas-dev/` under the dev profile).
pub fn project_config_path(project_root: &Path) -> PathBuf {
    atlas_profile::dir_in(project_root).join(PROJECT_CONFIG_FILE)
}

/// What a project's file says, as the Settings UI shows it.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOverrides {
    /// Each override, camelCase key → value, already known to be valid.
    pub values: Map<String, Value>,
    /// Keys in the file that cannot be set per project, or that Atlas does
    /// not know. Left in the file; never applied.
    pub ignored_keys: Vec<String>,
    /// Tighten-only keys the file tries to switch on while the global value
    /// is off. Never applied: a project can only turn these off.
    pub refused_keys: Vec<String>,
    /// Why the file is not being applied at all (bad TOML, a value that
    /// fails validation). `values` is empty while this is set.
    pub error: Option<String>,
}

fn is_project_key(key: &str) -> bool {
    PROJECT_SETTING_KEYS.contains(&key)
}

/// Whether `value` for `key` would switch on, from a project file, something
/// the user has off for all projects.
fn loosens(key: &str, value: &Value, global: &AppSettings) -> bool {
    if !PROJECT_TIGHTEN_ONLY_KEYS.contains(&key) || value != &Value::Bool(true) {
        return false;
    }
    let global = serde_json::to_value(global).unwrap_or(Value::Null);
    global.get(key) == Some(&Value::Bool(false))
}

fn toml_to_json(value: &toml::Value) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// Parse a project file and check its overrides against `global`.
pub fn parse_overrides(raw: &str, global: &AppSettings) -> ProjectOverrides {
    let table: toml::Table = match raw.parse() {
        Ok(table) => table,
        Err(e) => {
            return ProjectOverrides {
                error: Some(format!("not valid TOML: {e}")),
                ..ProjectOverrides::default()
            }
        }
    };
    let Some(settings) = table.get("settings").and_then(toml::Value::as_table) else {
        return ProjectOverrides::default();
    };
    let mut values = Map::new();
    let mut ignored_keys = Vec::new();
    let mut refused_keys = Vec::new();
    for (key, value) in settings {
        let value = toml_to_json(value);
        if !is_project_key(key) {
            ignored_keys.push(key.clone());
        } else if loosens(key, &value, global) {
            refused_keys.push(key.clone());
        } else {
            values.insert(key.clone(), value);
        }
    }
    match apply(global, &values) {
        Ok(_) => ProjectOverrides {
            values,
            ignored_keys,
            refused_keys,
            error: None,
        },
        Err(error) => ProjectOverrides {
            values: Map::new(),
            ignored_keys,
            refused_keys,
            error: Some(error),
        },
    }
}

/// `global` with `values` laid over it, validated as a whole.
pub fn apply(global: &AppSettings, values: &Map<String, Value>) -> Result<AppSettings, String> {
    if values.is_empty() {
        return Ok(global.clone());
    }
    let mut merged = serde_json::to_value(global).map_err(|e| e.to_string())?;
    let object = merged
        .as_object_mut()
        .ok_or("settings did not serialize to an object")?;
    for (key, value) in values {
        object.insert(key.clone(), value.clone());
    }
    let settings: AppSettings =
        serde_json::from_value(merged).map_err(|e| format!("invalid value: {e}"))?;
    validate(&settings).map_err(|issue| format!("{}: {}", issue.key, issue.message))?;
    Ok(settings)
}

/// The settings in effect inside a project, and which keys it set.
pub fn resolve(global: &AppSettings, overrides: &ProjectOverrides) -> (AppSettings, Vec<String>) {
    match apply(global, &overrides.values) {
        Ok(settings) => (settings, overrides.values.keys().cloned().collect()),
        Err(_) => (global.clone(), Vec::new()),
    }
}

/// Set (`Some`) or remove (`None`) overrides in a project's file, creating it
/// when needed. Refuses a key that cannot be set per project, and a result
/// that would not validate, before anything is written.
pub fn write_patch(
    project_root: &Path,
    global: &AppSettings,
    patch: &Map<String, Value>,
) -> Result<ProjectOverrides, String> {
    for (key, value) in patch {
        if !is_project_key(key) {
            return Err(format!("{key} cannot be set per project"));
        }
        if loosens(key, value, global) {
            return Err(format!(
                "{key} is off for all projects; a project can only turn it off"
            ));
        }
    }
    let path = project_config_path(project_root);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => PROJECT_CONFIG_HEADER.to_string(),
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    let mut document: toml_edit::DocumentMut = raw
        .parse()
        .map_err(|e| format!("{} is not valid TOML: {e}", path.display()))?;
    if document
        .get("settings")
        .and_then(|i| i.as_table())
        .is_none()
    {
        document["settings"] = toml_edit::Item::Table(toml_edit::Table::new());
    }
    let present = settings_keys_in(&document);
    let table = document["settings"]
        .as_table_mut()
        .expect("settings table was ensured");
    for (key, value) in patch {
        if value.is_null() {
            table.remove(key);
        } else {
            table[key.as_str()] = toml_edit::value(json_to_toml(value)?);
        }
    }
    document_added_keys(&mut document, &present);
    let text = document.to_string();
    let parsed = parse_overrides(&text, global);
    if let Some(error) = parsed.error {
        return Err(error);
    }
    write_atomic(&path, &text).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(parsed)
}

fn json_to_toml(value: &Value) -> Result<toml_edit::Value, String> {
    Ok(match value {
        Value::Bool(b) => (*b).into(),
        Value::Number(n) if n.is_i64() => n.as_i64().unwrap_or_default().into(),
        Value::Number(n) => n.as_f64().unwrap_or_default().into(),
        Value::String(s) => s.as_str().into(),
        Value::Array(items) => {
            let mut array = toml_edit::Array::new();
            for item in items {
                array.push(json_to_toml(item)?);
            }
            toml_edit::Value::Array(array)
        }
        other => return Err(format!("unsupported value {other}")),
    })
}

/// File identity for the cache: re-read only when it changed on disk.
type Stamp = Option<(SystemTime, u64)>;

fn stamp(path: &Path) -> Stamp {
    let meta = fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

#[derive(Default)]
struct Cached {
    stamp: Stamp,
    raw: Option<String>,
}

/// Every project file Atlas has read, re-read when its mtime or size moves.
/// Readers on hot paths (each agent tool call) cost one `stat`.
#[derive(Default)]
pub struct ProjectConfigs {
    cache: Mutex<HashMap<PathBuf, Cached>>,
}

impl ProjectConfigs {
    fn raw_for(&self, project_root: &Path) -> Option<String> {
        let path = project_config_path(project_root);
        let now = stamp(&path);
        let mut cache = self.cache.lock();
        let entry = cache.entry(path.clone()).or_default();
        if entry.stamp != now || (now.is_some() && entry.raw.is_none()) {
            entry.raw = now.and_then(|_| fs::read_to_string(&path).ok());
            entry.stamp = now;
        }
        entry.raw.clone()
    }

    /// The project's overrides, checked against `global`.
    pub fn overrides(&self, project_root: &Path, global: &AppSettings) -> ProjectOverrides {
        self.raw_for(project_root)
            .map(|raw| parse_overrides(&raw, global))
            .unwrap_or_default()
    }

    /// The settings in effect inside `project_root`.
    pub fn effective(&self, project_root: &Path, global: &AppSettings) -> AppSettings {
        resolve(global, &self.overrides(project_root, global)).0
    }

    /// Forget a file Atlas just wrote, so the next read sees it even when the
    /// write landed within the filesystem's mtime resolution.
    pub fn invalidate(&self, project_root: &Path) {
        self.cache.lock().remove(&project_config_path(project_root));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn patch(pairs: &[(&str, Value)]) -> Map<String, Value> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.clone()))
            .collect()
    }

    #[test]
    fn no_file_means_the_global_settings() {
        let dir = project();
        let global = AppSettings::default();
        let configs = ProjectConfigs::default();
        assert_eq!(
            configs.overrides(dir.path(), &global),
            ProjectOverrides::default()
        );
        assert_eq!(configs.effective(dir.path(), &global), global);
    }

    #[test]
    fn an_override_wins_and_is_reported_as_the_source() {
        let global = AppSettings::default();
        let raw = "schemaVersion = 1\n[settings]\ngitAutoFetch = false\n";
        let overrides = parse_overrides(raw, &global);
        let (effective, sources) = resolve(&global, &overrides);
        assert!(!effective.git_auto_fetch);
        assert_eq!(sources, vec!["gitAutoFetch".to_string()]);
        assert_eq!(effective.enter_to_send, global.enter_to_send);
    }

    #[test]
    fn a_key_that_is_not_per_project_is_ignored_not_applied() {
        let global = AppSettings::default();
        let raw = "[settings]\nenterToSend = false\nnotAKey = 1\nagentCodeTools = false\n";
        let overrides = parse_overrides(raw, &global);
        assert_eq!(overrides.ignored_keys, vec!["enterToSend", "notAKey"]);
        let (effective, _) = resolve(&global, &overrides);
        assert!(effective.enter_to_send, "a global-only key never applies");
        assert!(!effective.agent_code_tools);
    }

    #[test]
    fn an_invalid_value_disables_the_whole_file_and_says_why() {
        let global = AppSettings::default();
        let overrides = parse_overrides("[settings]\ngitAutoFetch = \"yes\"\n", &global);
        assert!(overrides.error.is_some());
        assert!(overrides.values.is_empty());
        assert_eq!(resolve(&global, &overrides).0, global);

        let broken = parse_overrides("this is not toml", &global);
        assert!(broken.error.unwrap().contains("TOML"));
    }

    #[test]
    fn a_patch_creates_a_commented_file_and_removing_the_last_key_inherits_again() {
        let dir = project();
        let global = AppSettings::default();
        let written = write_patch(
            dir.path(),
            &global,
            &patch(&[("gitBlameInline", Value::Bool(false))]),
        )
        .unwrap();
        assert_eq!(written.values["gitBlameInline"], Value::Bool(false));
        let text = fs::read_to_string(project_config_path(dir.path())).unwrap();
        assert!(text.starts_with("# Atlas settings for this project."));
        assert!(text.contains("gitBlameInline = false"));
        assert!(
            text.contains("(default: true)"),
            "the key arrives documented: {text}"
        );

        let cleared = write_patch(
            dir.path(),
            &global,
            &patch(&[("gitBlameInline", Value::Null)]),
        )
        .unwrap();
        assert!(cleared.values.is_empty());
    }

    #[test]
    fn a_patch_keeps_hand_written_comments_and_ignored_keys() {
        let dir = project();
        let path = project_config_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let raw = "[settings]\n# mine\nmemoryDreams = true\nenterToSend = false\n";
        fs::write(&path, raw).unwrap();
        write_patch(
            dir.path(),
            &AppSettings::default(),
            &patch(&[("agentOrgAccess", Value::Bool(false))]),
        )
        .unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("# mine\nmemoryDreams = true"));
        assert!(text.contains("enterToSend = false"));
        assert!(text.contains("agentOrgAccess = false"));
    }

    #[test]
    fn a_patch_refuses_a_global_only_key_and_writes_nothing() {
        let dir = project();
        let error = write_patch(
            dir.path(),
            &AppSettings::default(),
            &patch(&[("enterToSend", Value::Bool(false))]),
        )
        .unwrap_err();
        assert!(error.contains("cannot be set per project"));
        assert!(!project_config_path(dir.path()).exists());
    }

    #[test]
    fn the_cache_sees_an_edit_made_outside_atlas() {
        let dir = project();
        let global = AppSettings::default();
        let configs = ProjectConfigs::default();
        assert!(configs.effective(dir.path(), &global).git_auto_fetch);
        let path = project_config_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "[settings]\ngitAutoFetch = false\n").unwrap();
        assert!(!configs.effective(dir.path(), &global).git_auto_fetch);
    }

    /// A cloned repository can carry a committed `.atlas/config.toml`. It must
    /// not switch on an agent permission or a data-sending job the user has
    /// off — but turning one off, or setting a harmless key, still applies.
    #[test]
    fn a_project_file_can_tighten_a_permission_but_never_loosen_it() {
        let global = AppSettings {
            agent_code_tools: false,
            agent_org_access: true,
            ..AppSettings::default()
        };
        let raw =
            "[settings]\nagentCodeTools = true\nagentOrgAccess = false\ngitBlameInline = false\n";
        let overrides = parse_overrides(raw, &global);
        assert_eq!(overrides.refused_keys, vec!["agentCodeTools"]);
        let (effective, sources) = resolve(&global, &overrides);
        assert!(!effective.agent_code_tools, "stays off");
        assert!(!effective.agent_org_access, "tightened");
        assert!(!effective.git_blame_inline);
        assert_eq!(sources.len(), 2);

        let dir = project();
        let error = write_patch(
            dir.path(),
            &global,
            &patch(&[("agentCodeTools", Value::Bool(true))]),
        )
        .unwrap_err();
        assert!(error.contains("can only turn it off"));
        assert!(!project_config_path(dir.path()).exists());
    }

    #[test]
    fn every_tighten_only_key_is_a_project_boolean() {
        let defaults = serde_json::to_value(AppSettings::default()).unwrap();
        for key in PROJECT_TIGHTEN_ONLY_KEYS {
            assert!(PROJECT_SETTING_KEYS.contains(key), "{key}");
            assert!(defaults[*key].is_boolean(), "{key}");
        }
    }

    /// Every per-project key is a real setting whose type survives a round
    /// trip through the overlay — so a registry flag on a key the overlay
    /// cannot carry fails here, not in a user's project.
    #[test]
    fn every_project_key_round_trips_through_the_overlay() {
        let global = AppSettings::default();
        let as_json = serde_json::to_value(&global).unwrap();
        for key in PROJECT_SETTING_KEYS {
            let value = as_json
                .get(*key)
                .unwrap_or_else(|| panic!("{key} is not an AppSettings field"))
                .clone();
            let values = patch(&[(key, value)]);
            assert_eq!(apply(&global, &values).unwrap(), global, "{key}");
        }
    }
}

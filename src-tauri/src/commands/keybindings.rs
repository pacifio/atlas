//! Persistent user keybinding profiles.
//!
//! Stored as `~/.config/atlas/keybindings.json` — a sibling of `config.toml`,
//! because like it this is a user-authored document people will open and edit
//! by hand (the Settings editor has an "Open keybindings.json" button). Same
//! atomic tmp+rename write as `plans.rs`.
//!
//! Rust owns the file's *shape*: every profile has a non-empty name and a
//! unique id, the built-in `default` profile is always present, locked and
//! empty, `active_profile_id` points at a real profile, and every combo string
//! is syntactically a chord. Rust does NOT know the action registry — that
//! lives in the renderer (`src/features/keybindings/lib/actions.ts`) — so
//! unknown action ids are preserved verbatim: a profile written by a newer
//! build must survive being loaded by an older one.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::state::atlas_config::config_root;

pub const DEFAULT_PROFILE_ID: &str = "default";
const FILE_NAME: &str = "keybindings.json";
const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub built_in: bool,
    /// action id → Some(chords) to override, None (JSON `null`) to unbind.
    /// BTreeMap so the file is written in a stable order.
    #[serde(default)]
    pub bindings: BTreeMap<String, Option<Vec<String>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingsFile {
    #[serde(default = "schema_version")]
    pub version: u32,
    #[serde(default = "default_profile_id")]
    pub active_profile_id: String,
    #[serde(default)]
    pub profiles: Vec<Profile>,
}

fn schema_version() -> u32 {
    SCHEMA_VERSION
}

fn default_profile_id() -> String {
    DEFAULT_PROFILE_ID.to_string()
}

fn default_profile() -> Profile {
    Profile {
        id: DEFAULT_PROFILE_ID.to_string(),
        name: "Default".to_string(),
        built_in: true,
        bindings: BTreeMap::new(),
    }
}

impl Default for KeybindingsFile {
    fn default() -> Self {
        Self {
            version: SCHEMA_VERSION,
            active_profile_id: DEFAULT_PROFILE_ID.to_string(),
            profiles: vec![default_profile()],
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingsLoadResult {
    pub file: KeybindingsFile,
    pub path: String,
    /// Non-fatal problems: a corrupt file we fell back from, repairs made
    /// while normalising. Surfaced in Settings, never blocking.
    pub warnings: Vec<String>,
}

fn keybindings_path() -> Result<PathBuf, String> {
    config_root()
        .map(|root| root.join(FILE_NAME))
        .ok_or_else(|| "could not resolve the Atlas config directory".to_string())
}

/// Repair what can be repaired, reporting each fix. Anything that can't be
/// repaired is left for `validate` to reject.
fn normalize(file: &mut KeybindingsFile) -> Vec<String> {
    let mut warnings = Vec::new();
    if file.version != SCHEMA_VERSION {
        warnings.push(format!(
            "keybindings.json version {} is not {SCHEMA_VERSION}; reading it as v{SCHEMA_VERSION}",
            file.version
        ));
        file.version = SCHEMA_VERSION;
    }

    // The built-in profile: exactly one, first, locked, empty.
    let mut default = file
        .profiles
        .iter()
        .position(|p| p.id == DEFAULT_PROFILE_ID)
        .map(|i| file.profiles.remove(i))
        .unwrap_or_else(|| {
            warnings.push("built-in Default profile was missing; restored".to_string());
            default_profile()
        });
    if !default.bindings.is_empty() {
        warnings.push("built-in Default profile had overrides; they were dropped".to_string());
        default.bindings.clear();
    }
    default.built_in = true;
    default.name = "Default".to_string();
    for p in file.profiles.iter_mut() {
        if p.built_in {
            warnings.push(format!("profile `{}` claimed to be built-in; cleared", p.id));
            p.built_in = false;
        }
    }
    file.profiles.insert(0, default);

    if !file.profiles.iter().any(|p| p.id == file.active_profile_id) {
        warnings.push(format!(
            "active profile `{}` does not exist; switched to Default",
            file.active_profile_id
        ));
        file.active_profile_id = DEFAULT_PROFILE_ID.to_string();
    }
    warnings
}

/// A light syntax check — modifiers from the known set, exactly one key token,
/// no empties. The renderer's parser is the authority on which key tokens
/// exist; this only stops obviously broken strings from being persisted.
fn is_plausible_combo(s: &str) -> bool {
    let s = s.trim().to_ascii_lowercase();
    if s.is_empty() {
        return false;
    }
    // `cmd++` — a literal plus as the key.
    let body = s.strip_suffix("++").map(|b| format!("{b}+=")).unwrap_or(s.clone());
    let mut keys = 0;
    let mut seen = HashSet::new();
    for part in body.split('+') {
        if part.is_empty() {
            return false;
        }
        match part {
            "cmd" | "meta" | "command" | "ctrl" | "control" | "alt" | "option" | "shift" => {
                if !seen.insert(part) {
                    return false;
                }
            }
            _ => keys += 1,
        }
    }
    keys == 1
}

fn validate(file: &KeybindingsFile) -> Result<(), String> {
    let mut ids = HashSet::new();
    for p in &file.profiles {
        if p.id.trim().is_empty() {
            return Err("a profile has an empty id".to_string());
        }
        if p.name.trim().is_empty() {
            return Err(format!("profile `{}` has an empty name", p.id));
        }
        if !ids.insert(p.id.as_str()) {
            return Err(format!("duplicate profile id `{}`", p.id));
        }
        for (action, chords) in &p.bindings {
            if action.trim().is_empty() {
                return Err(format!("profile `{}` binds an empty action id", p.id));
            }
            if let Some(chords) = chords {
                for c in chords {
                    if !is_plausible_combo(c) {
                        return Err(format!(
                            "profile `{}`: `{c}` is not a valid key combination for `{action}`",
                            p.id
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

fn read_file(path: &PathBuf) -> (KeybindingsFile, Vec<String>) {
    match fs::read_to_string(path) {
        Ok(raw) => match serde_json::from_str::<KeybindingsFile>(&raw) {
            Ok(file) => (file, Vec::new()),
            Err(e) => (
                KeybindingsFile::default(),
                vec![format!(
                    "keybindings.json could not be read ({e}); using the Default profile. The file was left untouched."
                )],
            ),
        },
        Err(_) => (KeybindingsFile::default(), Vec::new()),
    }
}

fn write_file(path: &PathBuf, file: &KeybindingsFile) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "keybindings path has no parent".to_string())?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    let payload = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    fs::write(&tmp, payload).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Load the profiles file. A missing file yields the defaults; a corrupt one
/// yields the defaults plus a warning and is NOT overwritten — the user's
/// hand edit stays on disk for them to fix.
#[tauri::command]
pub async fn keybindings_load() -> Result<KeybindingsLoadResult, String> {
    tokio::task::spawn_blocking(move || -> Result<KeybindingsLoadResult, String> {
        let path = keybindings_path()?;
        let (mut file, mut warnings) = read_file(&path);
        warnings.extend(normalize(&mut file));
        if let Err(e) = validate(&file) {
            warnings.push(format!("{e}; using the Default profile"));
            file = KeybindingsFile::default();
        }
        Ok(KeybindingsLoadResult {
            file,
            path: path.to_string_lossy().into_owned(),
            warnings,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Validate, normalise and atomically write the whole file. Returns the
/// normalised file so the renderer mirrors exactly what landed on disk.
#[tauri::command]
pub async fn keybindings_save(mut file: KeybindingsFile) -> Result<KeybindingsFile, String> {
    tokio::task::spawn_blocking(move || -> Result<KeybindingsFile, String> {
        validate(&file)?;
        normalize(&mut file);
        let path = keybindings_path()?;
        write_file(&path, &file)?;
        Ok(file)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reveal `keybindings.json` in the OS default editor, creating it from the
/// defaults first so there is something to open.
#[tauri::command]
pub async fn keybindings_open(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = keybindings_path()?;
    if !path.exists() {
        write_file(&path, &KeybindingsFile::default())?;
    }
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str, bindings: &[(&str, Option<&[&str]>)]) -> Profile {
        Profile {
            id: id.to_string(),
            name: id.to_string(),
            built_in: false,
            bindings: bindings
                .iter()
                .map(|(k, v)| {
                    (
                        k.to_string(),
                        v.map(|c| c.iter().map(|s| s.to_string()).collect()),
                    )
                })
                .collect(),
        }
    }

    #[test]
    fn round_trips_through_json() {
        let mut file = KeybindingsFile::default();
        file.profiles.push(profile(
            "mine",
            &[("panels.left", Some(&["cmd+shift+l"])), ("panels.right", None)],
        ));
        file.active_profile_id = "mine".into();
        let json = serde_json::to_string_pretty(&file).unwrap();
        assert!(json.contains("\"panels.right\": null"));
        let back: KeybindingsFile = serde_json::from_str(&json).unwrap();
        assert_eq!(back, file);
    }

    #[test]
    fn normalize_restores_a_missing_default_profile_first() {
        let mut file = KeybindingsFile {
            version: 1,
            active_profile_id: "mine".into(),
            profiles: vec![profile("mine", &[])],
        };
        let warnings = normalize(&mut file);
        assert_eq!(file.profiles[0].id, DEFAULT_PROFILE_ID);
        assert!(file.profiles[0].built_in);
        assert_eq!(file.profiles.len(), 2);
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn normalize_strips_overrides_from_the_default_profile() {
        let mut file = KeybindingsFile::default();
        file.profiles[0]
            .bindings
            .insert("panels.left".into(), Some(vec!["cmd+x".into()]));
        let warnings = normalize(&mut file);
        assert!(file.profiles[0].bindings.is_empty());
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn normalize_resets_a_dangling_active_profile() {
        let mut file = KeybindingsFile::default();
        file.active_profile_id = "ghost".into();
        normalize(&mut file);
        assert_eq!(file.active_profile_id, DEFAULT_PROFILE_ID);
    }

    #[test]
    fn unknown_action_ids_are_preserved() {
        let mut file = KeybindingsFile::default();
        file.profiles
            .push(profile("mine", &[("future.action", Some(&["cmd+alt+9"]))]));
        validate(&file).unwrap();
        normalize(&mut file);
        assert!(file.profiles[1].bindings.contains_key("future.action"));
    }

    #[test]
    fn corrupt_json_falls_back_with_a_warning() {
        let dir = std::env::temp_dir().join(format!("atlas-kb-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);
        fs::write(&path, "{ not json").unwrap();
        let (file, warnings) = read_file(&path);
        assert_eq!(file, KeybindingsFile::default());
        assert_eq!(warnings.len(), 1);
        // Untouched.
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_is_atomic_and_readable() {
        let dir = std::env::temp_dir().join(format!("atlas-kb-write-{}", std::process::id()));
        let path = dir.join(FILE_NAME);
        let mut file = KeybindingsFile::default();
        file.profiles.push(profile("mine", &[("tabs.close", None)]));
        write_file(&path, &file).unwrap();
        assert!(!path.with_extension("json.tmp").exists());
        let (back, warnings) = read_file(&path);
        assert!(warnings.is_empty());
        assert_eq!(back, file);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_rejects_bad_input() {
        let mut dup = KeybindingsFile::default();
        dup.profiles.push(profile("a", &[]));
        dup.profiles.push(profile("a", &[]));
        assert!(validate(&dup).is_err());

        let mut empty_name = KeybindingsFile::default();
        let mut p = profile("b", &[]);
        p.name = "  ".into();
        empty_name.profiles.push(p);
        assert!(validate(&empty_name).is_err());

        let mut bad_combo = KeybindingsFile::default();
        bad_combo
            .profiles
            .push(profile("c", &[("tabs.close", Some(&["cmd+"]))]));
        assert!(validate(&bad_combo).is_err());
    }

    #[test]
    fn plausible_combo_syntax() {
        for ok in ["cmd+shift+b", "alt+;", "cmd+alt+space", "shift+tab", "f5", "cmd++", "cmd+\\"] {
            assert!(is_plausible_combo(ok), "{ok}");
        }
        for bad in ["", "cmd+", "cmd+shift", "cmd+b+c", "cmd+cmd+b", "+b"] {
            assert!(!is_plausible_combo(bad), "{bad}");
        }
    }
}

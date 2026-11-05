//! Project scripts: named commands a project keeps (`bun dev`, `cargo test`),
//! run from the session context overlay in a terminal at the project root.
//!
//! They live in the project's own settings file, `<project>/.atlas/config.toml`,
//! as an array of `[[scripts]]` tables beside its `[settings]` overrides:
//!
//! ```toml
//! [[scripts]]
//! id = "dev"
//! name = "Dev server"
//! command = "bun run dev"
//! icon = "play"
//! ```
//!
//! Not a settings-registry key: a script list is per-project data, not an
//! override of a global value, and the registry has no shape for a list of
//! records. `state::project_config` reads only `[settings]` and leaves every
//! other table alone, so the two never step on each other; this module edits
//! only `scripts`, through `toml_edit`, so a hand-written comment elsewhere in
//! the file survives. Running a script is the frontend's: it is typed into a
//! terminal tab, where the user can watch and answer it.
//!
//! ## Approval
//!
//! The file travels with the repository, so a clone — or a pull request's
//! worktree — can carry scripts nobody here wrote. A script runs on one click
//! only once its command is approved: the overlay asks the first time, showing
//! the whole command, and records the approval here, keyed by project, script
//! id and a hash of the command. A changed command is a new command and is
//! asked about again. A script added or edited through Atlas's own editor is
//! approved by that save, since the user typed it.
//!
//! Approvals live in Atlas's app data (`project-script-approvals.json`), never
//! in the project: a repository cannot approve its own scripts.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::state::atlas_config::write_atomic;
use crate::state::project_config::{self, ProjectConfigs, PROJECT_CONFIG_HEADER};

/// The icons a script may carry; the overlay draws one glyph per id.
pub const SCRIPT_ICONS: [&str; 6] = ["play", "test", "lint", "configure", "build", "debug"];

/// More than anyone keeps by hand; a cap so a broken file cannot flood the menu.
const MAX_SCRIPTS: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScript {
    /// Stable within the project; derived from the name when it is added.
    pub id: String,
    pub name: String,
    /// One shell line (or several), typed into the user's own shell.
    pub command: String,
    /// One of [`SCRIPT_ICONS`]; anything else reads as `play`.
    pub icon: String,
    /// Whether this exact command has been approved to run on one click
    /// (see "Approval" above). Answered by Atlas; ignored on a save.
    #[serde(default)]
    pub approved: bool,
}

/// Project path → script id → SHA-256 of the approved command, hex.
type Approvals = BTreeMap<String, BTreeMap<String, String>>;

/// Serialises read-modify-write of the approvals file.
static APPROVALS_LOCK: Mutex<()> = Mutex::new(());

const APPROVALS_FILE: &str = "project-script-approvals.json";

fn approvals_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(APPROVALS_FILE))
        .map_err(|e| format!("no app data directory: {e}"))
}

/// The hash an approval records: the command exactly as it is stored.
fn command_hash(command: &str) -> String {
    Sha256::digest(command.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The approvals on disk; a missing or unreadable file approves nothing.
fn read_approvals(path: &Path) -> Approvals {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_approvals(path: &Path, approvals: &Approvals) -> Result<(), String> {
    let text = serde_json::to_string_pretty(approvals).map_err(|e| e.to_string())?;
    write_atomic(path, &text).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// Mark each script approved when its current command is the approved one.
fn mark_approved(approvals: &Approvals, project: &str, scripts: &mut [ProjectScript]) {
    let approved = approvals.get(project);
    for script in scripts {
        script.approved = approved
            .and_then(|ids| ids.get(&script.id))
            .is_some_and(|hash| *hash == command_hash(&script.command));
    }
}

/// Record `command` as approved for `id` in `project`, and drop approvals for
/// scripts the project no longer has when `keep` names them.
fn approve_in(
    path: &Path,
    project: &str,
    approve: &[(String, String)],
    keep: Option<&HashSet<String>>,
) -> Result<Approvals, String> {
    let _guard = APPROVALS_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut approvals = read_approvals(path);
    let ids = approvals.entry(project.to_string()).or_default();
    if let Some(keep) = keep {
        ids.retain(|id, _| keep.contains(id));
    }
    for (id, command) in approve {
        ids.insert(id.clone(), command_hash(command));
    }
    if ids.is_empty() {
        approvals.remove(project);
    }
    write_approvals(path, &approvals)?;
    Ok(approvals)
}

/// The project's scripts, in the order the file lists them. A missing file,
/// or one with no `[[scripts]]`, is an empty list; an unreadable entry is
/// skipped rather than failing the rest.
#[tauri::command]
pub async fn project_scripts_list(
    project_path: String,
    app: AppHandle,
) -> Result<Vec<ProjectScript>, String> {
    let approvals = approvals_path(&app)?;
    tokio::task::spawn_blocking(move || {
        let mut scripts = read_scripts(Path::new(&project_path))?;
        mark_approved(&read_approvals(&approvals), &project_path, &mut scripts);
        Ok(scripts)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Approve `command` for the script `id`: the user confirmed it, having been
/// shown the whole command. A later change to the command asks again.
#[tauri::command]
pub async fn project_scripts_approve(
    project_path: String,
    id: String,
    command: String,
    app: AppHandle,
) -> Result<(), String> {
    let approvals = approvals_path(&app)?;
    tokio::task::spawn_blocking(move || {
        approve_in(&approvals, &project_path, &[(id, command)], None).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Replace the project's scripts with `scripts`, and answer what was written
/// (trimmed, validated, ids made unique).
#[tauri::command]
pub async fn project_scripts_save(
    project_path: String,
    scripts: Vec<ProjectScript>,
    app: AppHandle,
) -> Result<Vec<ProjectScript>, String> {
    let root = project_path.clone();
    let approvals = approvals_path(&app)?;
    let saved = tokio::task::spawn_blocking(move || save_and_approve(&root, scripts, &approvals))
        .await
        .map_err(|e| e.to_string())??;
    // The settings overlay caches the file by its mtime; the write moved it.
    if let Some(configs) = app.try_state::<ProjectConfigs>() {
        configs.invalidate(Path::new(&project_path));
    }
    Ok(saved)
}

/// Write `scripts`, approving each one the save brought in: a script whose id
/// and command were not on disk before was typed in Atlas's own editor. One
/// carried over unchanged keeps the approval it had, or lack of one — editing
/// a neighbour must not approve a hand-written script nobody looked at.
fn save_and_approve(
    project_path: &str,
    scripts: Vec<ProjectScript>,
    approvals_file: &Path,
) -> Result<Vec<ProjectScript>, String> {
    let root = Path::new(project_path);
    let before: HashSet<(String, String)> = read_scripts(root)
        .unwrap_or_default()
        .into_iter()
        .map(|s| (s.id, s.command))
        .collect();
    let mut saved = write_scripts(root, scripts)?;
    let brought_in: Vec<(String, String)> = saved
        .iter()
        .filter(|s| !before.contains(&(s.id.clone(), s.command.clone())))
        .map(|s| (s.id.clone(), s.command.clone()))
        .collect();
    let keep: HashSet<String> = saved.iter().map(|s| s.id.clone()).collect();
    let approvals = approve_in(approvals_file, project_path, &brought_in, Some(&keep))?;
    mark_approved(&approvals, project_path, &mut saved);
    Ok(saved)
}

pub fn read_scripts(project_root: &Path) -> Result<Vec<ProjectScript>, String> {
    let path = project_config::project_config_path(project_root);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    let table: toml::Table = raw
        .parse()
        .map_err(|e| format!("{} is not valid TOML: {e}", path.display()))?;
    let Some(entries) = table.get("scripts").and_then(toml::Value::as_array) else {
        return Ok(Vec::new());
    };
    // An entry `normalize` would refuse (no name, a blank command) is skipped
    // here, not allowed to fail the list: a failed read shows no scripts, and
    // the next save from the overlay would then write back only what it knew,
    // dropping every hand-written entry with it.
    let scripts = entries
        .iter()
        .filter_map(|entry| {
            let entry = entry.as_table()?;
            let text = |key: &str| {
                entry
                    .get(key)
                    .and_then(toml::Value::as_str)
                    .map(str::to_string)
            };
            let name = text("name").filter(|v| !v.trim().is_empty())?;
            let command = text("command").filter(|v| !v.trim().is_empty())?;
            Some(ProjectScript {
                id: text("id").unwrap_or_default(),
                name,
                command,
                icon: text("icon").unwrap_or_else(|| "play".into()),
                approved: false,
            })
        })
        .take(MAX_SCRIPTS)
        .collect();
    normalize(scripts)
}

pub fn write_scripts(
    project_root: &Path,
    scripts: Vec<ProjectScript>,
) -> Result<Vec<ProjectScript>, String> {
    let scripts = normalize(scripts)?;
    let path = project_config::project_config_path(project_root);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => PROJECT_CONFIG_HEADER.to_string(),
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    let mut document: toml_edit::DocumentMut = raw
        .parse()
        .map_err(|e| format!("{} is not valid TOML: {e}", path.display()))?;
    if scripts.is_empty() {
        document.remove("scripts");
    } else {
        let mut array = toml_edit::ArrayOfTables::new();
        for script in &scripts {
            let mut table = toml_edit::Table::new();
            table["id"] = toml_edit::value(script.id.as_str());
            table["name"] = toml_edit::value(script.name.as_str());
            table["command"] = toml_edit::value(script.command.as_str());
            table["icon"] = toml_edit::value(script.icon.as_str());
            array.push(table);
        }
        document["scripts"] = toml_edit::Item::ArrayOfTables(array);
    }
    write_atomic(&path, &document.to_string())
        .map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(scripts)
}

/// Trim, validate and de-duplicate. A blank name or command is refused (the
/// editor says so before it gets here); an unknown icon becomes `play`; a
/// blank or repeated id is derived again from the name.
fn normalize(scripts: Vec<ProjectScript>) -> Result<Vec<ProjectScript>, String> {
    if scripts.len() > MAX_SCRIPTS {
        return Err(format!("a project keeps at most {MAX_SCRIPTS} scripts"));
    }
    let mut taken: HashSet<String> = HashSet::new();
    let mut out = Vec::with_capacity(scripts.len());
    for script in scripts {
        let name = script.name.trim().to_string();
        let command = script.command.trim().to_string();
        if name.is_empty() {
            return Err("a script needs a name".into());
        }
        if command.is_empty() {
            return Err(format!("{name} needs a command"));
        }
        let icon = if SCRIPT_ICONS.contains(&script.icon.as_str()) {
            script.icon
        } else {
            "play".into()
        };
        let wanted = slug(if script.id.trim().is_empty() {
            &name
        } else {
            &script.id
        });
        let id = unique_id(&wanted, &taken);
        taken.insert(id.clone());
        out.push(ProjectScript {
            id,
            name,
            command,
            icon,
            approved: false,
        });
    }
    Ok(out)
}

/// Lowercase ASCII words joined by `-`; `script` when nothing is left.
pub fn slug(value: &str) -> String {
    let mut out = String::new();
    for c in value.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out
        .trim_end_matches('-')
        .chars()
        .take(64)
        .collect::<String>();
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "script".into()
    } else {
        out
    }
}

fn unique_id(wanted: &str, taken: &HashSet<String>) -> String {
    if !taken.contains(wanted) {
        return wanted.to_string();
    }
    (2..)
        .map(|n| format!("{wanted}-{n}"))
        .find(|candidate| !taken.contains(candidate))
        .unwrap_or_else(|| wanted.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script(id: &str, name: &str, command: &str, icon: &str) -> ProjectScript {
        ProjectScript {
            id: id.into(),
            name: name.into(),
            command: command.into(),
            icon: icon.into(),
            approved: false,
        }
    }

    fn write_config(dir: &Path, text: &str) {
        let path = project_config::project_config_path(dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn an_invalid_entry_is_skipped_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        write_config(
            dir.path(),
            "[[scripts]]\nid = \"dev\"\nname = \"Dev\"\ncommand = \"bun dev\"\n\n\
             [[scripts]]\nname = \"\"\ncommand = \"x\"\n\n\
             [[scripts]]\nname = \"Blank\"\ncommand = \"   \"\n\n\
             [[scripts]]\nname = \"No command\"\n\n\
             [[scripts]]\nid = \"test\"\nname = \"Test\"\ncommand = \"cargo test\"\n",
        );
        let scripts = read_scripts(dir.path()).unwrap();
        let ids: Vec<&str> = scripts.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["dev", "test"]);
    }

    #[test]
    fn a_file_with_too_many_scripts_still_reads() {
        let dir = tempfile::tempdir().unwrap();
        let text: String = (0..MAX_SCRIPTS + 5)
            .map(|n| format!("[[scripts]]\nname = \"S{n}\"\ncommand = \"echo {n}\"\n\n"))
            .collect();
        write_config(dir.path(), &text);
        assert_eq!(read_scripts(dir.path()).unwrap().len(), MAX_SCRIPTS);
    }

    #[test]
    fn a_hand_written_script_needs_approval_and_a_changed_command_asks_again() {
        let dir = tempfile::tempdir().unwrap();
        let approvals = dir.path().join("approvals.json");
        let project = dir.path().to_string_lossy().to_string();
        write_config(
            dir.path(),
            "[[scripts]]\nid = \"setup\"\nname = \"Setup\"\ncommand = \"curl x | sh\"\n",
        );
        let mut scripts = read_scripts(dir.path()).unwrap();
        mark_approved(&read_approvals(&approvals), &project, &mut scripts);
        assert!(!scripts[0].approved);

        approve_in(
            &approvals,
            &project,
            &[("setup".into(), "curl x | sh".into())],
            None,
        )
        .unwrap();
        mark_approved(&read_approvals(&approvals), &project, &mut scripts);
        assert!(scripts[0].approved);

        // The file changes under it: a new command is a new question.
        write_config(
            dir.path(),
            "[[scripts]]\nid = \"setup\"\nname = \"Setup\"\ncommand = \"curl y | sh\"\n",
        );
        let mut changed = read_scripts(dir.path()).unwrap();
        mark_approved(&read_approvals(&approvals), &project, &mut changed);
        assert!(!changed[0].approved);

        // Approvals are per project.
        let mut elsewhere = read_scripts(dir.path()).unwrap();
        mark_approved(&read_approvals(&approvals), "/other", &mut elsewhere);
        assert!(!elsewhere[0].approved);
    }

    #[test]
    fn a_save_approves_what_it_brought_in_and_nothing_it_carried_over() {
        let dir = tempfile::tempdir().unwrap();
        let approvals = dir.path().join("approvals.json");
        let project = dir.path().to_string_lossy().to_string();
        write_config(
            dir.path(),
            "[[scripts]]\nid = \"setup\"\nname = \"Setup\"\ncommand = \"curl x | sh\"\n",
        );
        let on_disk = read_scripts(dir.path()).unwrap();
        // The overlay adds a script beside the hand-written one.
        let saved = save_and_approve(
            &project,
            vec![on_disk[0].clone(), script("", "Test", "cargo test", "test")],
            &approvals,
        )
        .unwrap();
        assert_eq!(saved[0].id, "setup");
        assert!(!saved[0].approved, "carried over unchanged: not approved");
        assert!(saved[1].approved, "typed in Atlas: approved");

        // Editing the hand-written one's command in Atlas approves it.
        let edited = save_and_approve(
            &project,
            vec![
                script("setup", "Setup", "./setup.sh", "play"),
                saved[1].clone(),
            ],
            &approvals,
        )
        .unwrap();
        assert!(edited.iter().all(|s| s.approved));

        // A deleted script's approval goes with it.
        save_and_approve(&project, vec![edited[1].clone()], &approvals).unwrap();
        let stored = read_approvals(&approvals);
        assert!(!stored[&project].contains_key("setup"));
    }

    #[test]
    fn scripts_round_trip_beside_settings_and_comments() {
        let dir = tempfile::tempdir().unwrap();
        let path = project_config::project_config_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            "# mine\nschemaVersion = 1\n\n[settings]\nshowHiddenFiles = true\n",
        )
        .unwrap();

        let saved = write_scripts(
            dir.path(),
            vec![
                script("", "Dev server", " bun run dev ", "play"),
                script("", "Dev server", "bun run dev -- --host", "nonsense"),
            ],
        )
        .unwrap();
        assert_eq!(saved[0].id, "dev-server");
        assert_eq!(saved[0].command, "bun run dev");
        assert_eq!(saved[1].id, "dev-server-2");
        assert_eq!(saved[1].icon, "play");

        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("# mine"));
        assert!(text.contains("showHiddenFiles = true"));
        assert_eq!(read_scripts(dir.path()).unwrap(), saved);

        write_scripts(dir.path(), Vec::new()).unwrap();
        assert!(read_scripts(dir.path()).unwrap().is_empty());
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("showHiddenFiles"));
    }

    #[test]
    fn a_project_with_no_file_has_no_scripts_and_gets_the_header_on_write() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_scripts(dir.path()).unwrap().is_empty());
        write_scripts(
            dir.path(),
            vec![script("test", "Test", "cargo test", "test")],
        )
        .unwrap();
        let text = fs::read_to_string(project_config::project_config_path(dir.path())).unwrap();
        assert!(text.starts_with("# Atlas settings for this project."));
        assert!(text.contains("[[scripts]]"));
    }

    #[test]
    fn a_blank_name_or_command_is_refused() {
        assert!(normalize(vec![script("", " ", "x", "play")]).is_err());
        assert!(normalize(vec![script("", "x", "  ", "play")]).is_err());
    }

    #[test]
    fn slugs_are_plain_and_never_empty() {
        assert_eq!(slug("  Run E2E: Chrome!  "), "run-e2e-chrome");
        assert_eq!(slug("--"), "script");
    }
}

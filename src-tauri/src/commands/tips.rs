//! Which Tips the user has seen (CONTEXT.md, "Tip"), and which cohort they
//! belong to.
//!
//! Stored as `~/.config/atlas/tips.json`, beside `keybindings.json` and
//! `config.toml`. Unlike those two it is bookkeeping, not a document anyone
//! edits: the on/off switch is the `showTips` setting in `config.toml`, and
//! this file only remembers what was already shown. A corrupt file is
//! replaced rather than preserved.
//!
//! **The cohort is fixed the first time the file is written.** A user with no
//! `keybindings.json` at that moment is on a fresh install — that file is
//! written by every answer to the First run keymap question, so its absence is
//! the same signal First run uses. Anyone else upgraded from a build without
//! tips: they get only moment tips, never a tip for a place they already know.
//! Replay all tips moves anyone to `fresh`, since asking for the tips back is
//! asking for all of them.
//!
//! Every write goes through `update`, which reads the file, changes it and
//! writes it back under one lock, then tells every window
//! (`atlas:tips-changed`), so a tip seen in one window is never shown in
//! another.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::state::atlas_config::config_root;

const FILE_NAME: &str = "tips.json";
const KEYBINDINGS_FILE_NAME: &str = "keybindings.json";
const SCHEMA_VERSION: u32 = 1;
pub const TIPS_CHANGED_EVENT: &str = "atlas:tips-changed";

/// Serialises read-modify-write across windows' concurrent calls.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn lock() -> std::sync::MutexGuard<'static, ()> {
    WRITE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TipCohort {
    Fresh,
    Upgrade,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TipsState {
    pub version: u32,
    pub cohort: TipCohort,
    /// Tip ids already shown, in the order they were seen. Ids this build
    /// doesn't know are kept, so a newer build's record survives an older one.
    pub seen: Vec<String>,
}

fn config_dir() -> Result<PathBuf, String> {
    config_root().ok_or_else(|| "could not resolve the Atlas config directory".to_string())
}

fn read(dir: &Path) -> Option<TipsState> {
    let raw = fs::read_to_string(dir.join(FILE_NAME)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write(dir: &Path, state: &TipsState) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(FILE_NAME);
    let tmp = path.with_extension("json.tmp");
    let payload = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    fs::write(&tmp, payload).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// The state on disk, creating it (and fixing the cohort) the first time.
fn load_in(dir: &Path) -> Result<TipsState, String> {
    if let Some(state) = read(dir) {
        return Ok(state);
    }
    let cohort = if dir.join(KEYBINDINGS_FILE_NAME).exists() {
        TipCohort::Upgrade
    } else {
        TipCohort::Fresh
    };
    let state = TipsState {
        version: SCHEMA_VERSION,
        cohort,
        seen: Vec::new(),
    };
    write(dir, &state)?;
    Ok(state)
}

fn update_in(dir: &Path, change: impl FnOnce(&mut TipsState)) -> Result<TipsState, String> {
    let _guard = lock();
    let mut state = load_in(dir)?;
    change(&mut state);
    write(dir, &state)?;
    Ok(state)
}

fn mark_seen(state: &mut TipsState, ids: Vec<String>) {
    for id in ids {
        if !state.seen.contains(&id) {
            state.seen.push(id);
        }
    }
}

/// Replay all tips: forget every seen tip except those in `keep` (the ones
/// that must only ever show once), and treat the user as fresh.
fn reset(state: &mut TipsState, keep: &[String]) {
    state.seen.retain(|id| keep.contains(id));
    state.cohort = TipCohort::Fresh;
}

fn update(app: &AppHandle, change: impl FnOnce(&mut TipsState)) -> Result<TipsState, String> {
    let state = update_in(&config_dir()?, change)?;
    let _ = app.emit(TIPS_CHANGED_EVENT, &state);
    Ok(state)
}

#[tauri::command]
pub async fn tips_load() -> Result<TipsState, String> {
    tokio::task::spawn_blocking(|| {
        let _guard = lock();
        load_in(&config_dir()?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tips_mark_seen(app: AppHandle, ids: Vec<String>) -> Result<TipsState, String> {
    tokio::task::spawn_blocking(move || update(&app, |s| mark_seen(s, ids)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tips_reset(app: AppHandle, keep: Vec<String>) -> Result<TipsState, String> {
    tokio::task::spawn_blocking(move || update(&app, |s| reset(s, &keep)))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_first_load_without_keybindings_is_a_fresh_install() {
        let dir = tempfile::tempdir().unwrap();
        let state = load_in(dir.path()).unwrap();
        assert_eq!(state.cohort, TipCohort::Fresh);
        assert!(state.seen.is_empty());
    }

    #[test]
    fn a_first_load_beside_existing_keybindings_is_an_upgrade() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(KEYBINDINGS_FILE_NAME), "{}").unwrap();
        assert_eq!(load_in(dir.path()).unwrap().cohort, TipCohort::Upgrade);
    }

    #[test]
    fn the_cohort_is_fixed_by_the_first_load() {
        let dir = tempfile::tempdir().unwrap();
        load_in(dir.path()).unwrap();
        // First run answered: keybindings.json now exists. Still fresh.
        fs::write(dir.path().join(KEYBINDINGS_FILE_NAME), "{}").unwrap();
        assert_eq!(load_in(dir.path()).unwrap().cohort, TipCohort::Fresh);
    }

    #[test]
    fn seen_tips_persist_once_each() {
        let dir = tempfile::tempdir().unwrap();
        update_in(dir.path(), |s| mark_seen(s, vec!["composer".into()])).unwrap();
        update_in(dir.path(), |s| {
            mark_seen(s, vec!["composer".into(), "palette".into()])
        })
        .unwrap();
        assert_eq!(
            load_in(dir.path()).unwrap().seen,
            vec!["composer", "palette"]
        );
    }

    #[test]
    fn replay_forgets_all_but_the_kept_tips_and_makes_the_user_fresh() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(KEYBINDINGS_FILE_NAME), "{}").unwrap();
        update_in(dir.path(), |s| {
            mark_seen(s, vec!["composer".into(), "sign-in".into()])
        })
        .unwrap();
        let state = update_in(dir.path(), |s| reset(s, &["sign-in".to_string()])).unwrap();
        assert_eq!(state.seen, vec!["sign-in"]);
        assert_eq!(state.cohort, TipCohort::Fresh);
    }

    #[test]
    fn a_corrupt_file_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE_NAME), "not json").unwrap();
        fs::write(dir.path().join(KEYBINDINGS_FILE_NAME), "{}").unwrap();
        let state = load_in(dir.path()).unwrap();
        assert_eq!(state.cohort, TipCohort::Upgrade);
        assert!(read(dir.path()).is_some());
    }
}

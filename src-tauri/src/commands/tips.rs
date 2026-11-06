//! Which Tips the user has seen (CONTEXT.md, "Tip"), which cohort they
//! belong to, and how far through Get started they are.
//!
//! Stored as `~/.config/atlas/tips.json`, beside `keybindings.json` and
//! `config.toml`. Unlike those two it is bookkeeping, not a document anyone
//! edits: the on/off switch is the `showTips` setting in `config.toml`, and
//! this file only remembers what already happened. A corrupt file is
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
//! another. The same commands send the onboarding telemetry (`TELEMETRY.md`,
//! "Onboarding"): ids only, never anything the user wrote.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::atlas_config::config_root;
use crate::telemetry::TelemetryClient;

const FILE_NAME: &str = "tips.json";
const KEYBINDINGS_FILE_NAME: &str = "keybindings.json";
const SCHEMA_VERSION: u32 = 1;
pub const TIPS_CHANGED_EVENT: &str = "atlas:tips-changed";
/// The Get started item a linked commit completes.
const CHECKPOINT_ITEM: &str = "checkpoint";
/// Enough days to tell "has come back a few times"; older ones are dropped.
const ACTIVE_DAYS_KEPT: usize = 7;

/// Serialises read-modify-write across windows' concurrent calls.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn lock() -> std::sync::MutexGuard<'static, ()> {
    WRITE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// For the capture worker, which has no handle of its own to reach the
/// windows through (see `checkpoint_linked`).
static APP: OnceLock<AppHandle> = OnceLock::new();

pub(crate) fn attach(app: AppHandle) {
    let _ = APP.set(app);
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
    /// Get started items already done, in the order they were done.
    #[serde(default)]
    pub checklist: Vec<String>,
    /// The user closed Get started. Replay all tips clears it.
    #[serde(default)]
    pub checklist_dismissed: bool,
    /// The local dates (`YYYY-MM-DD`) Atlas was opened on, oldest first, the
    /// last `ACTIVE_DAYS_KEPT` of them.
    #[serde(default)]
    pub active_days: Vec<String>,
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
        checklist: Vec::new(),
        checklist_dismissed: false,
        active_days: Vec::new(),
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

fn push_once(list: &mut Vec<String>, item: String) -> bool {
    if list.contains(&item) {
        return false;
    }
    list.push(item);
    true
}

/// Record `today` as a day Atlas was used.
fn note_active_day(state: &mut TipsState, today: String) {
    if push_once(&mut state.active_days, today) {
        let excess = state.active_days.len().saturating_sub(ACTIVE_DAYS_KEPT);
        state.active_days.drain(..excess);
    }
}

/// Replay all tips: forget every seen tip except those in `keep` (the ones
/// that must only ever show once), treat the user as fresh, and bring back
/// Get started if it was closed unfinished.
fn reset(state: &mut TipsState, keep: &[String]) {
    state.seen.retain(|id| keep.contains(id));
    state.cohort = TipCohort::Fresh;
    state.checklist_dismissed = false;
}

fn capture(app: &AppHandle, event: &str, properties: serde_json::Value) {
    if let Some(client) = app.try_state::<Arc<TelemetryClient>>() {
        client.capture(event, properties);
    }
}

fn update(app: &AppHandle, change: impl FnOnce(&mut TipsState)) -> Result<TipsState, String> {
    let state = update_in(&config_dir()?, change)?;
    let _ = app.emit(TIPS_CHANGED_EVENT, &state);
    Ok(state)
}

/// Complete a Get started item, announcing it once.
fn complete_item(app: &AppHandle, item: String) -> Result<TipsState, String> {
    let mut newly = false;
    let state = update(app, |s| newly = push_once(&mut s.checklist, item.clone()))?;
    if newly {
        capture(
            app,
            "get_started_item_done",
            serde_json::json!({ "item": item }),
        );
    }
    Ok(state)
}

/// Load the record, and count today as a day Atlas was used.
#[tauri::command]
pub async fn tips_load() -> Result<TipsState, String> {
    tokio::task::spawn_blocking(|| {
        let today = chrono::Local::now().date_naive().to_string();
        update_in(&config_dir()?, |s| note_active_day(s, today))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A tip appeared. Telemetry only; nothing is recorded until it closes.
#[tauri::command]
pub fn tips_shown(app: AppHandle, id: String) {
    capture(&app, "tip_shown", serde_json::json!({ "tip_id": id }));
}

/// A tip closed: `done` (its last step's button, or the action it offered) or
/// `dismissed` (Escape, a click outside, a close button).
#[tauri::command]
pub async fn tips_mark_seen(
    app: AppHandle,
    id: String,
    outcome: String,
) -> Result<TipsState, String> {
    tokio::task::spawn_blocking(move || {
        let state = update(&app, |s| {
            push_once(&mut s.seen, id.clone());
        })?;
        let event = if outcome == "done" {
            "tip_done"
        } else {
            "tip_dismissed"
        };
        capture(&app, event, serde_json::json!({ "tip_id": id }));
        Ok(state)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tips_reset(app: AppHandle, keep: Vec<String>) -> Result<TipsState, String> {
    tokio::task::spawn_blocking(move || update(&app, |s| reset(s, &keep)))
        .await
        .map_err(|e| e.to_string())?
}

/// A Get started item happened.
#[tauri::command]
pub async fn tips_checklist_done(app: AppHandle, item: String) -> Result<TipsState, String> {
    tokio::task::spawn_blocking(move || complete_item(&app, item))
        .await
        .map_err(|e| e.to_string())?
}

/// The user closed Get started.
#[tauri::command]
pub async fn tips_checklist_dismiss(app: AppHandle) -> Result<TipsState, String> {
    tokio::task::spawn_blocking(move || {
        let state = update(&app, |s| s.checklist_dismissed = true)?;
        capture(
            &app,
            "get_started_dismissed",
            serde_json::json!({ "items_done": state.checklist.len() }),
        );
        Ok(state)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// First run finished, with the keymap answer: a preset id, `atlas`, or
/// `later` (Decide later, or Escape).
#[tauri::command]
pub fn first_run_complete(app: AppHandle, keymap: String) {
    capture(
        &app,
        "first_run_completed",
        serde_json::json!({ "keymap": keymap }),
    );
}

/// The capture worker linked a commit to a session: the first time, that is
/// Get started's last item. Called on the worker thread, never blocking it on
/// anything but the file.
pub(crate) fn checkpoint_linked() {
    let Some(app) = APP.get() else { return };
    let Ok(dir) = config_dir() else { return };
    if read(&dir).is_some_and(|s| s.checklist.iter().any(|i| i == CHECKPOINT_ITEM)) {
        return;
    }
    if let Err(e) = complete_item(app, CHECKPOINT_ITEM.to_string()) {
        tracing::warn!(target: "atlas::tips", "recording the first checkpoint failed: {e}");
    }
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
        update_in(dir.path(), |s| {
            push_once(&mut s.seen, "composer".into());
        })
        .unwrap();
        update_in(dir.path(), |s| {
            for id in ["composer", "palette"] {
                push_once(&mut s.seen, id.into());
            }
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
            for id in ["composer", "sign-in"] {
                push_once(&mut s.seen, id.into());
            }
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

    #[test]
    fn replay_brings_back_a_closed_get_started_but_keeps_its_progress() {
        let dir = tempfile::tempdir().unwrap();
        update_in(dir.path(), |s| {
            push_once(&mut s.checklist, "add-project".into());
            s.checklist_dismissed = true;
        })
        .unwrap();
        let state = update_in(dir.path(), |s| reset(s, &[])).unwrap();
        assert!(!state.checklist_dismissed);
        assert_eq!(state.checklist, vec!["add-project"]);
    }

    #[test]
    fn active_days_count_each_day_once_and_keep_the_latest_week() {
        let mut state = load_in(tempfile::tempdir().unwrap().path()).unwrap();
        note_active_day(&mut state, "2026-11-01".into());
        note_active_day(&mut state, "2026-11-01".into());
        assert_eq!(state.active_days, vec!["2026-11-01"]);
        for d in 2..=9 {
            note_active_day(&mut state, format!("2026-11-{d:02}"));
        }
        assert_eq!(state.active_days.len(), ACTIVE_DAYS_KEPT);
        assert_eq!(state.active_days.first().unwrap(), "2026-11-03");
        assert_eq!(state.active_days.last().unwrap(), "2026-11-09");
    }

    #[test]
    fn a_record_from_before_get_started_still_loads() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(FILE_NAME),
            r#"{"version":1,"cohort":"fresh","seen":["composer"]}"#,
        )
        .unwrap();
        let state = load_in(dir.path()).unwrap();
        assert_eq!(state.seen, vec!["composer"]);
        assert!(state.checklist.is_empty() && !state.checklist_dismissed);
    }
}

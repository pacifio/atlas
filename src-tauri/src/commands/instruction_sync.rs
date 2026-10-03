//! Mirrors a project's convention files (`CLAUDE.md`, `.claude/rules/`) into
//! its `AGENTS.md`, for any agent that reads it, while the `instructionSync`
//! setting is on.
//!
//! The mirroring itself (what the managed block holds, how it is spliced into
//! `AGENTS.md`, and every check that keeps the user's text intact) lives in
//! the `atlas-instruction-sync` crate. This module only decides *when* to run
//! it, and nothing here runs while the setting is off:
//!
//! - when a project becomes the active one in a window
//!   (`instruction_sync_start`), so edits made while Atlas was closed are
//!   picked up;
//! - when one of its sources changes, seen by a watcher armed only while the
//!   setting is on. It watches the project root and `.claude` non-recursively,
//!   `.claude/rules` recursively and `.atlas/packs` (the pack ledger)
//!   non-recursively, never all of `.claude/`, which can hold whole checkouts
//!   under `.claude/worktrees/`. A directory that appears later is armed when
//!   its parent's watcher sees it, or on the next activation;
//! - when the setting is switched on: the active project of each window is
//!   synced and watched, and no other open project is touched;
//! - when the setting is switched off: every watcher stops, and the block is
//!   taken back out of the projects that were being kept in sync (watched)
//!   and the active ones, under the same checks as a sync.
//!
//! `AGENTS.md` itself is not a source, and a sync writes only when the block
//! would change, so a sync never triggers another.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use atlas_instruction_sync::{Outcome, SkipReason};
use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer_opt, NoCache};
use parking_lot::Mutex;
use tauri::{AppHandle, Manager, State};

type Debouncer = notify_debouncer_full::Debouncer<notify::RecommendedWatcher, NoCache>;

struct ProjectWatch {
    root: PathBuf,
    /// Keeping the debouncer alive keeps the OS-level watches active.
    debouncer: Debouncer,
    /// The `watch_targets` directories currently watched.
    armed: HashSet<PathBuf>,
}

impl ProjectWatch {
    /// Watch every target directory that exists now and is not yet watched.
    /// With `refresh`, re-watch the ones below the root from scratch: a
    /// directory deleted and recreated keeps its entry here but lost its
    /// OS-level watch.
    fn arm(&mut self, refresh: bool) {
        for target in atlas_instruction_sync::watch_targets(&self.root) {
            let is_root = target.path == self.root;
            if refresh && !is_root && self.armed.remove(&target.path) {
                let _ = self.debouncer.unwatch(&target.path);
            }
            if self.armed.contains(&target.path) || !target.path.is_dir() {
                continue;
            }
            let mode = if target.recursive {
                RecursiveMode::Recursive
            } else {
                RecursiveMode::NonRecursive
            };
            match self.debouncer.watch(&target.path, mode) {
                Ok(()) => {
                    self.armed.insert(target.path);
                }
                Err(e) => tracing::warn!(
                    "instruction sync: failed to watch {}: {e}",
                    target.path.display()
                ),
            }
        }
    }
}

#[derive(Default)]
pub struct InstructionSyncState {
    /// One watcher per project synced while the setting is on, keyed by
    /// project id. Empty while it is off.
    watchers: Mutex<HashMap<String, ProjectWatch>>,
    /// The active project of each window: label -> (project id, root).
    active: Mutex<HashMap<String, (String, PathBuf)>>,
    /// The setting as last applied, to tell a switch from a repeat.
    enabled: AtomicBool,
}

impl InstructionSyncState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Follow the `instructionSync` setting. Called on every settings change;
    /// only a switch does anything. On: sync and watch each window's active
    /// project, and nothing else. Off: stop every watcher and take the block
    /// back out of the projects that were being kept in sync.
    pub fn apply_setting(&self, app: &AppHandle, on: bool) {
        if self.enabled.swap(on, Ordering::SeqCst) == on {
            return;
        }
        let active: Vec<(String, PathBuf)> = self.active.lock().values().cloned().collect();
        if on {
            for (key, root) in active {
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Some(state) = app.try_state::<InstructionSyncState>() {
                        state.watch(&app, &key, &root);
                    }
                    run(&root);
                });
            }
        } else {
            // The projects being kept in sync, then any active one not among
            // them (its watcher could not be armed, but it was still synced).
            let mut roots: Vec<PathBuf> =
                self.watchers.lock().drain().map(|(_, w)| w.root).collect();
            for (_, root) in active {
                if !roots.contains(&root) {
                    roots.push(root);
                }
            }
            tauri::async_runtime::spawn_blocking(move || {
                for root in roots {
                    report(&root, atlas_instruction_sync::remove(&root));
                }
            });
        }
    }

    /// Start watching `root` under `key` (re-arming what is missing when it
    /// already is). Blocking: call off the async runtime.
    fn watch(&self, app: &AppHandle, key: &str, root: &Path) {
        if !self.enabled.load(Ordering::SeqCst) {
            return;
        }
        let mut watchers = self.watchers.lock();
        if let Some(existing) = watchers.get_mut(key) {
            if existing.root == root {
                existing.arm(false);
                return;
            }
        }
        match new_watcher(app.clone(), key.to_string(), root.to_path_buf()) {
            Ok(debouncer) => {
                let mut watch = ProjectWatch {
                    root: root.to_path_buf(),
                    debouncer,
                    armed: HashSet::new(),
                };
                watch.arm(false);
                watchers.insert(key.to_string(), watch);
            }
            Err(e) => tracing::warn!("instruction sync: {e}"),
        }
    }

    /// Re-arm `key`'s watcher after one of its watch directories appeared or
    /// went away.
    fn rearm(&self, key: &str) {
        if let Some(watch) = self.watchers.lock().get_mut(key) {
            watch.arm(true);
        }
    }
}

fn new_watcher(app: AppHandle, key: String, root: PathBuf) -> Result<Debouncer, String> {
    // `NoCache`, as in `fileindex`: the platform cache `stat`s every event
    // path to correlate renames, which buys nothing here.
    new_debouncer_opt::<_, notify::RecommendedWatcher, NoCache>(
        Duration::from_millis(500),
        None,
        move |result: notify_debouncer_full::DebounceEventResult| match result {
            Ok(events) => {
                let paths = || events.iter().flat_map(|e| e.paths.iter());
                let touched = paths().any(|p| atlas_instruction_sync::is_source_path(&root, p));
                let dirs = paths().any(|p| atlas_instruction_sync::is_watch_dir_path(&root, p));
                if !(touched || dirs) || !enabled(&app) {
                    return;
                }
                // Never touch the watcher map from its own callback thread:
                // re-arm and sync from a blocking task instead.
                let app = app.clone();
                let key = key.clone();
                let root = root.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if dirs {
                        if let Some(state) = app.try_state::<InstructionSyncState>() {
                            state.rearm(&key);
                        }
                    }
                    run(&root);
                });
            }
            Err(errors) => {
                for e in errors {
                    tracing::warn!("instruction sync watch error: {e}");
                }
            }
        },
        NoCache::new(),
        notify::Config::default(),
    )
    .map_err(|e| format!("failed to create the watcher: {e}"))
}

fn enabled(app: &AppHandle) -> bool {
    crate::state::atlas_config::read(app).instruction_sync
}

/// Sync `root`, trying again shortly when `AGENTS.md` changed mid-write (an
/// editor save, a pack appending its rule): the newer text was kept, and the
/// retry splices the block into it.
fn run(root: &Path) {
    for attempt in 0..3 {
        let result = atlas_instruction_sync::sync(root);
        if matches!(result, Ok(Outcome::Skipped(SkipReason::ChangedDuringSync))) && attempt < 2 {
            std::thread::sleep(Duration::from_millis(300));
            continue;
        }
        report(root, result);
        return;
    }
}

fn report(root: &Path, result: std::io::Result<Outcome>) {
    let file = root.join("AGENTS.md");
    match result {
        Ok(Outcome::Written) => {
            tracing::info!("instruction sync: updated {}", file.display())
        }
        Ok(Outcome::Removed) => {
            tracing::info!(
                "instruction sync: removed the mirrored block from {}",
                file.display()
            )
        }
        Ok(Outcome::Unchanged | Outcome::NothingToMirror) => {}
        // A deliberate setup: one file already serves every agent.
        Ok(Outcome::Skipped(
            reason @ (SkipReason::Linked | SkipReason::SameFile | SkipReason::ImportsAgentsMd),
        )) => tracing::info!("instruction sync: left {} alone: {reason}", file.display()),
        Ok(Outcome::Skipped(reason)) => {
            tracing::warn!("instruction sync: left {} alone: {reason}", file.display())
        }
        Err(e) => tracing::warn!("instruction sync failed for {}: {e}", root.display()),
    }
}

/// `project_path` became the active project of the calling window. With the
/// setting on, watch its sources and sync it once now; with it off, only
/// remember it, so switching the setting on acts on this project and no
/// other. Idempotent per project.
#[tauri::command]
pub async fn instruction_sync_start(
    project_path: String,
    workspace_id: Option<String>,
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, InstructionSyncState>,
) -> Result<(), String> {
    let key = workspace_id.unwrap_or_else(|| project_path.clone());
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Ok(());
    }
    state
        .active
        .lock()
        .insert(window.label().to_string(), (key.clone(), root.clone()));
    if !enabled(&app) {
        return Ok(());
    }
    // The setting may be on from a previous launch, before any switch was
    // seen here.
    state.enabled.store(true, Ordering::SeqCst);
    tokio::task::spawn_blocking(move || {
        if let Some(state) = app.try_state::<InstructionSyncState>() {
            state.watch(&app, &key, &root);
        }
        run(&root);
    })
    .await
    .map_err(|e| e.to_string())
}

/// Stop watching one project (it was closed). Leaves its `AGENTS.md` as it is.
#[tauri::command(async)]
pub fn instruction_sync_stop(workspace_id: String, state: State<'_, InstructionSyncState>) {
    state.watchers.lock().remove(&workspace_id);
    state
        .active
        .lock()
        .retain(|_, (key, _)| key != &workspace_id);
}

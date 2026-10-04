//! Mirrors a project's convention files (`CLAUDE.md`, `.claude/CLAUDE.md`,
//! `.claude/rules/`, and the project files they import) into its `AGENTS.md`, for any agent that reads it, while the `instructionSync`
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
//!   its parent's watcher sees it, or on the next activation. After each sync
//!   it also watches the directory of every file a source imports (`@path`),
//!   non-recursively, so editing an imported file updates the block;
//! - when the setting is switched on: the active project of each window is
//!   synced and watched, and no other open project is touched;
//! - when the setting is switched off: every watcher stops, and the block is
//!   taken back out of every project a sync ever wrote it into, open or not,
//!   under the same checks as a sync. Those roots are kept in
//!   `instruction-sync.json` in the app config directory, so a project closed
//!   (or not reopened since a restart) is cleaned up too. The ledger also
//!   records whether a sync created the `AGENTS.md`: only then is a file left
//!   empty by the removal deleted, so an `AGENTS.md` the user made is kept.
//!
//! Every sync and removal runs under one gate that also holds the setting, so
//! a sync that was already queued when the setting went off never writes the
//! block back after its removal, and a removal never runs once the setting is
//! back on.
//!
//! `AGENTS.md` itself is not a source, and a sync writes only when the block
//! would change, so a sync never triggers another.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
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
    /// The files the sources import, as of the last sync, shared with the
    /// watcher's callback so an edit to one counts as a source change.
    imports: Arc<Mutex<HashSet<PathBuf>>>,
    /// Directories watched only because an imported file is in one.
    import_dirs: HashSet<PathBuf>,
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

    /// Follow the files the sources now import: watch each one's directory
    /// (unless a target already covers it) and drop the directories no
    /// longer needed.
    fn set_imports(&mut self, files: Vec<PathBuf>) {
        let rules = self.root.join(".claude").join("rules");
        let dirs: HashSet<PathBuf> = files
            .iter()
            .filter_map(|f| f.parent().map(Path::to_path_buf))
            .filter(|d| !self.armed.contains(d) && !d.starts_with(&rules))
            .collect();
        for gone in self.import_dirs.difference(&dirs) {
            let _ = self.debouncer.unwatch(gone);
        }
        self.import_dirs.retain(|d| dirs.contains(d));
        for dir in dirs {
            if self.import_dirs.contains(&dir) {
                continue;
            }
            match self.debouncer.watch(&dir, RecursiveMode::NonRecursive) {
                Ok(()) => {
                    self.import_dirs.insert(dir);
                }
                Err(e) => {
                    tracing::warn!("instruction sync: failed to watch {}: {e}", dir.display())
                }
            }
        }
        *self.imports.lock() = files.into_iter().collect();
    }
}

/// A project as this module tracks it: its id, and its root canonicalized,
/// which is the spelling a watcher reports event paths in.
#[derive(Clone)]
struct Project {
    key: String,
    root: PathBuf,
}

#[derive(Default)]
pub struct InstructionSyncState {
    /// One watcher per project synced while the setting is on, keyed by
    /// project id. Empty while it is off.
    watchers: Mutex<HashMap<String, ProjectWatch>>,
    /// The active project of each window, by window label.
    active: Mutex<HashMap<String, Project>>,
    /// The setting as last applied. Read and written only under `gate`, so a
    /// sync or removal sees the setting it runs under.
    enabled: AtomicBool,
    /// Held around every sync and removal, and around every change of
    /// `enabled`. See the module docs.
    gate: Mutex<()>,
}

impl InstructionSyncState {
    pub fn new() -> Self {
        Self::default()
    }

    /// The setting as Atlas starts, before any switch: with it already on,
    /// switching it off must still take the blocks back out.
    pub fn init(&self, on: bool) {
        let _gate = self.gate.lock();
        self.enabled.store(on, Ordering::SeqCst);
    }

    fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    /// Follow the `instructionSync` setting. Called on every settings change;
    /// only a switch does anything. On: sync and watch each window's active
    /// project, and nothing else. Off: stop every watcher and take the block
    /// back out of every project a sync wrote it into.
    pub fn apply_setting(&self, app: &AppHandle, on: bool) {
        {
            let _gate = self.gate.lock();
            if self.enabled.swap(on, Ordering::SeqCst) == on {
                return;
            }
        }
        if on {
            let active: Vec<Project> = self.active.lock().values().cloned().collect();
            for project in active {
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Some(state) = app.try_state::<InstructionSyncState>() {
                        state.watch(&app, &project);
                        state.sync(&app, &project.root);
                    }
                });
            }
        } else {
            // `enabled` is already off, so no watcher is added after this drain.
            self.watchers.lock().clear();
            let mut roots: Vec<PathBuf> = read_ledger(app).into_iter().map(|e| e.root).collect();
            for project in self.active.lock().values() {
                if !roots.contains(&project.root) {
                    roots.push(project.root.clone());
                }
            }
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Some(state) = app.try_state::<InstructionSyncState>() {
                    for root in roots {
                        state.remove(&app, &root);
                    }
                }
            });
        }
    }

    /// Sync `root` while the setting is on, trying again shortly when
    /// `AGENTS.md` changed mid-write (an editor save, a pack appending its
    /// rule): the newer text was kept, and the retry splices the block into
    /// it. Blocking.
    fn sync(&self, app: &AppHandle, root: &Path) {
        self.retrying(root, |root| {
            let _gate = self.gate.lock();
            if !self.is_enabled() {
                return None;
            }
            let result = atlas_instruction_sync::sync(root);
            match result {
                Ok(Outcome::Created) => update_ledger(app, root, Some(true)),
                Ok(Outcome::Written | Outcome::Unchanged) => update_ledger(app, root, Some(false)),
                _ => {}
            }
            Some(result)
        });
        let imports = atlas_instruction_sync::imported_files(root);
        if let Some(watch) = self.watchers.lock().values_mut().find(|w| w.root == root) {
            watch.set_imports(imports);
        }
    }

    /// Take the block back out of `root` while the setting is off, retrying
    /// like [`Self::sync`]. Blocking.
    fn remove(&self, app: &AppHandle, root: &Path) {
        self.retrying(root, |root| {
            let _gate = self.gate.lock();
            if self.is_enabled() {
                return None;
            }
            let created = read_ledger(app).iter().any(|e| e.root == root && e.created);
            let result = atlas_instruction_sync::remove(root, created);
            if let Ok(Outcome::Removed | Outcome::NothingToMirror) = result {
                update_ledger(app, root, None);
            }
            Some(result)
        });
    }

    /// Run `op` up to three times while it reports `ChangedDuringSync`, then
    /// log the outcome. `op` returns `None` when the setting no longer allows
    /// it. The gate is not held across the pause.
    fn retrying(&self, root: &Path, op: impl Fn(&Path) -> Option<std::io::Result<Outcome>>) {
        for attempt in 0..3 {
            let Some(result) = op(root) else {
                return;
            };
            if matches!(result, Ok(Outcome::Skipped(SkipReason::ChangedDuringSync))) && attempt < 2
            {
                std::thread::sleep(Duration::from_millis(300));
                continue;
            }
            report(root, result);
            return;
        }
    }

    /// Start watching `project` (re-arming what is missing when it already
    /// is). Blocking: call off the async runtime.
    fn watch(&self, app: &AppHandle, project: &Project) {
        let (key, root) = (project.key.as_str(), project.root.as_path());
        // Checked under the map's lock: switching off clears the map after
        // turning `enabled` off, so a watcher added here is either cleared
        // with the rest or never added.
        let mut watchers = self.watchers.lock();
        if !self.is_enabled() {
            return;
        }
        if let Some(existing) = watchers.get_mut(key) {
            if existing.root == root {
                existing.arm(false);
                return;
            }
        }
        let imports = Arc::new(Mutex::new(HashSet::new()));
        match new_watcher(
            app.clone(),
            key.to_string(),
            root.to_path_buf(),
            imports.clone(),
        ) {
            Ok(debouncer) => {
                let mut watch = ProjectWatch {
                    root: root.to_path_buf(),
                    debouncer,
                    armed: HashSet::new(),
                    imports,
                    import_dirs: HashSet::new(),
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

    /// Forget a closed window's active project. Its project stays watched
    /// until the project itself is closed (`instruction_sync_stop`).
    pub fn drop_window(&self, label: &str) {
        self.active.lock().remove(label);
    }
}

fn new_watcher(
    app: AppHandle,
    key: String,
    root: PathBuf,
    imports: Arc<Mutex<HashSet<PathBuf>>>,
) -> Result<Debouncer, String> {
    // `NoCache`, as in `fileindex`: the platform cache `stat`s every event
    // path to correlate renames, which buys nothing here.
    new_debouncer_opt::<_, notify::RecommendedWatcher, NoCache>(
        Duration::from_millis(500),
        None,
        move |result: notify_debouncer_full::DebounceEventResult| match result {
            Ok(events) => {
                let paths = || events.iter().flat_map(|e| e.paths.iter());
                let touched = paths().any(|p| {
                    atlas_instruction_sync::is_source_path(&root, p) || imports.lock().contains(p)
                });
                let dirs = paths().any(|p| atlas_instruction_sync::is_watch_dir_path(&root, p));
                if !(touched || dirs) {
                    return;
                }
                // Never touch the watcher map from its own callback thread:
                // re-arm and sync from a blocking task instead.
                let app = app.clone();
                let key = key.clone();
                let root = root.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let Some(state) = app.try_state::<InstructionSyncState>() else {
                        return;
                    };
                    if dirs {
                        state.rearm(&key);
                    }
                    state.sync(&app, &root);
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

// ── Ledger ──────────────────────────────────────────────────────────────────
//
// The roots a sync has written the block into, so switching the setting off
// reaches projects that are no longer open, and whether a sync created that
// `AGENTS.md`. Machine-managed state, so it sits in the app config directory
// beside `device.json`, not in `~/.config/atlas`. Read and written only under
// the gate.

#[derive(serde::Serialize, serde::Deserialize)]
struct LedgerEntry {
    root: PathBuf,
    /// A sync created this `AGENTS.md`, so removing the block may delete it
    /// when nothing else is left in it.
    #[serde(default)]
    created: bool,
}

fn ledger_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("instruction-sync.json"))
}

fn read_ledger(app: &AppHandle) -> Vec<LedgerEntry> {
    ledger_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Record `root` (`Some(created)`: whether this sync created its
/// `AGENTS.md`; once true it stays true) or forget it (`None`). A failed
/// write is logged and otherwise ignored: the ledger only widens what
/// switching off cleans up.
fn update_ledger(app: &AppHandle, root: &Path, synced: Option<bool>) {
    let Some(path) = ledger_path(app) else {
        return;
    };
    let mut roots = read_ledger(app);
    let at = roots.iter().position(|e| e.root == root);
    match (synced, at) {
        (Some(created), Some(i)) if created && !roots[i].created => roots[i].created = true,
        (Some(created), None) => roots.push(LedgerEntry {
            root: root.to_path_buf(),
            created,
        }),
        (None, Some(i)) => {
            roots.remove(i);
        }
        _ => return,
    }
    let written = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| {
            let json = serde_json::to_string_pretty(&roots).map_err(std::io::Error::other)?;
            std::fs::write(&path, json)
        });
    if let Err(e) = written {
        tracing::warn!("instruction sync: could not update {}: {e}", path.display());
    }
}

/// A common default size past which an agent stops reading `AGENTS.md`
/// (`project_doc_max_bytes` in the bundled engine). The block is at the end
/// of the file, so it is what gets cut.
const AGENTS_MD_READ_LIMIT: u64 = 32 * 1024;

fn report(root: &Path, result: std::io::Result<Outcome>) {
    let file = root.join("AGENTS.md");
    match result {
        Ok(outcome @ (Outcome::Written | Outcome::Created)) => {
            let verb = if outcome == Outcome::Created {
                "created"
            } else {
                "updated"
            };
            tracing::info!("instruction sync: {verb} {}", file.display());
            if let Ok(meta) = std::fs::metadata(&file) {
                if meta.len() > AGENTS_MD_READ_LIMIT {
                    tracing::warn!(
                        "instruction sync: {} is {} KiB; agents that cap AGENTS.md at 32 KiB \
                         will not see the end of the mirrored block",
                        file.display(),
                        meta.len() / 1024
                    );
                }
            }
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
    // Canonical, because that is how a watcher reports event paths (macOS
    // resolves `/var` to `/private/var`, a symlinked checkout to its target):
    // a root spelled any other way would never match one.
    let Some(root) = tokio::task::spawn_blocking(move || {
        dunce::canonicalize(&project_path)
            .ok()
            .filter(|root| root.is_dir())
    })
    .await
    .map_err(|e| e.to_string())?
    else {
        return Ok(());
    };
    let project = Project { key, root };
    state
        .active
        .lock()
        .insert(window.label().to_string(), project.clone());
    if !state.is_enabled() {
        return Ok(());
    }
    tokio::task::spawn_blocking(move || {
        if let Some(state) = app.try_state::<InstructionSyncState>() {
            state.watch(&app, &project);
            state.sync(&app, &project.root);
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Stop watching one project (it was closed). Leaves its `AGENTS.md` as it is;
/// switching the setting off still reaches it through the ledger.
#[tauri::command(async)]
pub fn instruction_sync_stop(workspace_id: String, state: State<'_, InstructionSyncState>) {
    state.watchers.lock().remove(&workspace_id);
    state
        .active
        .lock()
        .retain(|_, project| project.key != workspace_id);
}

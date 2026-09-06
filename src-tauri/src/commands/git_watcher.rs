//! Filesystem watcher for the project's `.git/` metadata. Emits
//! `atlas:git-changed` whenever a commit, checkout, branch
//! create/delete, fetch, or HEAD move happens. The frontend git-store
//! and git-graph-panel listen for it and refresh — no more 3-second
//! polling.
//!
//! We watch four things specifically (NOT all of `.git/`):
//!   - `.git/HEAD`          — checkout / commit moves the symbolic ref
//!   - `.git/packed-refs`   — `git pack-refs` rewrites; rare but
//!                            necessary
//!   - `.git/refs/`         — every branch / tag / remote update lives
//!                            here as a loose ref file
//!   - `.git/index`         — `git add` / `git reset` (stage / unstage)
//!                            — changes the working-tree status the
//!                            Changes panel renders
//!
//! Watching all of `.git/` would surface every blob write inside
//! `.git/objects/…` during `git add` / `git commit` — huge noise for
//! zero signal. The above cover every state change the UI cares about.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_full::new_debouncer;
use parking_lot::RwLock;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::git::{git_refs_compute, GitRefs};

struct ActiveWatcher {
    root: PathBuf,
    /// Keeping the debouncer alive keeps the OS-level watches active.
    /// We never read from it.
    _debouncer: notify_debouncer_full::Debouncer<
        notify::RecommendedWatcher,
        notify_debouncer_full::RecommendedCache,
    >,
}

#[derive(Default)]
pub struct GitWatcherState {
    /// One resident watcher per open workspace (keyed by workspace id) so a
    /// backgrounded workspace's git +/- badge keeps updating live.
    watchers: RwLock<HashMap<String, ActiveWatcher>>,
    /// Cached `GitRefs` for the active project. Populated lazily by
    /// `get_or_compute_refs` and invalidated by the watcher callback
    /// the instant any `.git/HEAD` / refs / packed-refs change lands.
    ///
    /// Lives here (not in a standalone state) because the
    /// invalidation cycle is the watcher itself — they share a
    /// lifecycle and an Arc keeps the watcher closure able to flush
    /// the cache without a JS round-trip.
    refs_cache: Arc<RwLock<Option<(PathBuf, GitRefs)>>>,
}

impl GitWatcherState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Return a cached `GitRefs` snapshot for `project_path`. Computes
    /// + populates the cache on first call (~80 ms — three `git`
    /// shell-outs) and on every call after a watcher-driven
    /// invalidation. Cached reads are sub-microsecond, which is the
    /// difference between the @-mention picker feeling instant and
    /// gating every keystroke on subprocess spawns.
    pub fn get_or_compute_refs(&self, project_path: &str) -> Option<GitRefs> {
        {
            let guard = self.refs_cache.read();
            if let Some((path, refs)) = guard.as_ref() {
                if path.as_os_str() == std::ffi::OsStr::new(project_path) {
                    return Some(refs.clone());
                }
            }
        }
        // Cache miss — compute, install, return. Lock is dropped
        // around the (slow) compute so concurrent callers don't pile
        // up behind us; worst case is two compute calls land at the
        // same time and the second overwrites the first, both with
        // equivalent results.
        let refs = git_refs_compute(project_path).ok()?;
        *self.refs_cache.write() = Some((PathBuf::from(project_path), refs.clone()));
        Some(refs)
    }

    pub fn invalidate_refs(&self) {
        *self.refs_cache.write() = None;
    }

    /// Is a watcher currently attached for this workspace?
    ///
    /// The capture-health signal asks the registry directly rather than
    /// inferring liveness from event silence — a quiet repository and a dead
    /// watcher produce exactly the same (absence of) events, which is why the
    /// clear-all bug went unnoticed for as long as it did.
    pub fn is_watching(&self, workspace_id: &str) -> bool {
        self.watchers.read().contains_key(workspace_id)
    }

    /// Is any watcher attached for this repository root?
    ///
    /// The registry is keyed by the workspace UUID the frontend supplies, but
    /// health callers only reliably know the project path — and looking a path
    /// up in a UUID-keyed map answered `false` forever, turning an omitted
    /// optional parameter into a permanent false "capture stopped". Each
    /// watcher also remembers its root, so liveness is answerable by either
    /// key.
    pub fn is_watching_root(&self, root: &Path) -> bool {
        self.watchers.read().values().any(|w| w.root == root)
    }

    /// Shared handle for the watcher closure to invalidate the cache
    /// from outside `impl GitWatcherState`. Arc-cloning is constant
    /// time; the closure ends up owning a second Arc and writes
    /// through it on every git-side change.
    pub(crate) fn refs_cache_handle(&self) -> Arc<RwLock<Option<(PathBuf, GitRefs)>>> {
        self.refs_cache.clone()
    }
}

#[derive(Debug, Clone, Serialize)]
struct GitChangedPayload {
    project: String,
}

/// Start (or replace) the watcher for `project_path`. Idempotent: if
/// the same project is already being watched, this is effectively a
/// re-arm (drops the old watcher and starts a fresh one). Returns
/// silently if the project isn't a git repo.
#[tauri::command]
pub async fn git_watch_start(
    project_path: String,
    workspace_id: Option<String>,
    app: AppHandle,
    state: State<'_, GitWatcherState>,
) -> Result<(), String> {
    let key = workspace_id.unwrap_or_else(|| project_path.clone());
    let root = PathBuf::from(&project_path);
    // `.git` may be a directory (an ordinary repository) or a file carrying a
    // `gitdir:` pointer (a linked worktree). Both are valid repositories, and
    // refusing the file form left every worktree permanently unwatched — with
    // the health signal telling the user to "reopen the Workspace", which
    // could never fix it.
    let Some(git_dirs) = resolve_git_dirs(&root) else {
        // Not a git project — leave any existing watcher alone (caller
        // may switch projects in/out of a non-repo).
        return Ok(());
    };

    // Idempotent: if this workspace already watches the same root (e.g. on a
    // switch back), don't drop + recreate the watcher.
    if let Some(existing) = state.watchers.read().get(&key) {
        if existing.root == root {
            return Ok(());
        }
    }

    // Cache invalidation runs FROM the watcher callback so the very
    // next `mention_search` (or any cached refs read) recomputes
    // against fresh on-disk state. Cheap — one RwLock write.
    state.invalidate_refs();
    let refs_cache_for_cb = state.refs_cache_handle();

    // Off the main thread: watcher creation does an initial FSEvents
    // scan on macOS.
    let root_for_task = root.clone();
    let app_for_task = app.clone();
    let debouncer = tokio::task::spawn_blocking(
        move || -> Result<
            notify_debouncer_full::Debouncer<
                notify::RecommendedWatcher,
                notify_debouncer_full::RecommendedCache,
            >,
            String,
        > {
            let project_str = root_for_task.to_string_lossy().into_owned();
            let root_for_cb = root_for_task.clone();
            let app_for_cb = app_for_task.clone();
            let mut debouncer = new_debouncer(
                Duration::from_millis(200),
                None,
                move |result: notify_debouncer_full::DebounceEventResult| match result {
                    Ok(_events) => {
                        // Flush the refs cache first — by the time
                        // listeners (mention_search, git-store) see
                        // the event, a fresh compute would be cheap
                        // *and* correct.
                        *refs_cache_for_cb.write() = None;

                        // Session capture's commit walk. The first in-process
                        // consumer of this watcher: everything else here goes
                        // out as a window event for the frontend, but commit
                        // detection must not depend on a window being open or
                        // on a renderer being responsive. This only enqueues —
                        // the walk itself runs on the capture worker thread, so
                        // the debounced callback returns immediately.
                        app_for_cb
                            .state::<super::capture::CaptureState>()
                            .note_git_change(&root_for_cb);

                        let _ = app_for_cb.emit(
                            "atlas:git-changed",
                            GitChangedPayload {
                                project: project_str.clone(),
                            },
                        );
                    }
                    Err(errors) => {
                        for e in errors {
                            tracing::warn!("git watch error: {e}");
                        }
                    }
                },
            )
            .map_err(|e| format!("failed to create git watcher: {e}"))?;

            // Targeted watches — see module doc for rationale. For a linked
            // worktree, HEAD and the index live in its private gitdir while
            // refs and packed-refs live in the shared common dir; watching the
            // shared refs also surfaces commits made from sibling worktrees,
            // which the debounced walk handles as ordinary no-ops.
            let head = git_dirs.git_dir.join("HEAD");
            let packed_refs = git_dirs.common_dir.join("packed-refs");
            let refs_dir = git_dirs.common_dir.join("refs");
            let index = git_dirs.git_dir.join("index");

            for (label, path, recursive) in [
                ("HEAD", head, RecursiveMode::NonRecursive),
                ("packed-refs", packed_refs, RecursiveMode::NonRecursive),
                ("refs/", refs_dir, RecursiveMode::Recursive),
                ("index", index, RecursiveMode::NonRecursive),
            ] {
                if path.exists() {
                    if let Err(e) = debouncer.watch(&path, recursive) {
                        tracing::warn!(
                            "git_watch: failed to watch {label} at {}: {e}",
                            path.display()
                        );
                    }
                }
            }

            Ok(debouncer)
        },
    )
    .await
    .map_err(|e| e.to_string())??;

    // Open-time backfill. This is what catches every commit made while Atlas
    // was closed — the decisive advantage over git hooks, which can only ever
    // see commits made after they were installed. It is also the *only*
    // mechanism for a Workspace that is never activated again, since a watcher
    // exists only for workspaces activated at least once this app session.
    app.state::<super::capture::CaptureState>()
        .note_git_change(&root);

    state.watchers.write().insert(
        key,
        ActiveWatcher {
            root,
            _debouncer: debouncer,
        },
    );
    Ok(())
}

/// Stop watching one workspace.
///
/// The workspace id is **required**. It used to be optional, with a missing id
/// meaning "drop every watcher" — and the frontend called it that way whenever
/// the current project became null, killing commit detection for every open
/// workspace at once. Nothing observed that, because a dead watcher and a quiet
/// repository look identical from the outside. Making the id mandatory puts that
/// failure out of reach rather than relying on call sites to remember; genuine
/// teardown uses [`git_watch_stop_all`], which says what it does.
#[tauri::command(async)]
pub fn git_watch_stop(workspace_id: String, state: State<'_, GitWatcherState>) {
    state.watchers.write().remove(&workspace_id);
}

/// Where a repository's git metadata actually lives.
struct GitDirs {
    /// The repository's own gitdir: `.git/` for an ordinary checkout, or the
    /// `.git/worktrees/<name>/` directory a worktree's `.git` file points at.
    /// HEAD and the index live here.
    git_dir: PathBuf,
    /// The shared directory holding refs and packed-refs. Identical to
    /// `git_dir` except for linked worktrees, whose `commondir` file points
    /// back at the main repository's `.git/`.
    common_dir: PathBuf,
}

/// Resolve the watchable git directories for a project root, accepting both an
/// ordinary `.git/` directory and a worktree's `.git` gitdir-pointer file.
fn resolve_git_dirs(root: &Path) -> Option<GitDirs> {
    let dot_git = root.join(".git");
    if dot_git.is_dir() {
        return Some(GitDirs { git_dir: dot_git.clone(), common_dir: dot_git });
    }
    if !dot_git.is_file() {
        return None;
    }

    // A gitdir pointer: `gitdir: /path/to/repo/.git/worktrees/<name>`.
    let content = std::fs::read_to_string(&dot_git).ok()?;
    let pointer = content.strip_prefix("gitdir:")?.trim();
    let git_dir = {
        let p = Path::new(pointer);
        if p.is_absolute() { p.to_path_buf() } else { root.join(p) }
    };
    if !git_dir.is_dir() {
        return None;
    }

    let common_dir = match std::fs::read_to_string(git_dir.join("commondir")) {
        Ok(raw) => {
            let p = Path::new(raw.trim());
            if p.is_absolute() { p.to_path_buf() } else { git_dir.join(p) }
        }
        Err(_) => git_dir.clone(),
    };
    Some(GitDirs { git_dir, common_dir })
}

/// Allow other modules (e.g. `git_status` post-write or future
/// commands that mutate the repo directly) to ping the watcher
/// channel synthetically.
#[allow(dead_code)]
pub fn emit_synthetic_change(app: &AppHandle, project_path: &Path) {
    let _ = app.emit(
        "atlas:git-changed",
        GitChangedPayload {
            project: project_path.to_string_lossy().into_owned(),
        },
    );
}

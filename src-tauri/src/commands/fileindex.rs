//! In-memory file index per project, with `.gitignore`-respecting initial
//! walk and a debounced filesystem watcher for incremental updates. The
//! frontend's Cmd+P palette queries this — search must feel instant on large
//! repos, so all matching happens in Rust via nucleo and only the top N
//! results cross the IPC boundary.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use ignore::WalkBuilder;
use notify::{event::ModifyKind, EventKind, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebouncedEvent, NoCache};
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::Matcher;
use parking_lot::RwLock;
use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

/// One indexed file. `path` is absolute; `rel` is relative to the project
/// root so the UI can render `crates/foo/src/lib.rs` instead of the full
/// `/Users/.../atlas/crates/foo/src/lib.rs`. `rel` is also what we feed into
/// the fuzzy matcher (users search by relative path, not absolute).
#[derive(Debug, Clone)]
pub struct IndexedFile {
    pub path: PathBuf,
    pub rel: String,
}

/// The derived `(relative, absolute)` folder list. Behind an `Arc` so handing
/// it to a caller is a pointer copy rather than a copy of the list.
type FolderList = Arc<Vec<(String, PathBuf)>>;
/// `None` until the first folder query derives it; cleared by the watcher.
type FolderCache = Arc<RwLock<Option<FolderList>>>;
/// The watcher's debouncer handle; holding it keeps the OS-level watch alive.
type Debouncer = notify_debouncer_full::Debouncer<notify::RecommendedWatcher, NoCache>;
/// What building a project's index yields: the file list, its generation
/// counter, the (empty) folder cache, and the watcher that maintains them.
type BuiltIndex = (
    Arc<RwLock<Vec<IndexedFile>>>,
    Arc<AtomicU64>,
    FolderCache,
    Debouncer,
);

#[derive(Debug, Clone, Serialize)]
pub struct FileMatch {
    pub path: String,
    pub rel: String,
}

/// One project being indexed. The watcher thread is kept alive by the
/// `_debouncer` handle; dropping `ProjectIndex` stops the watcher.
struct ProjectIndex {
    root: PathBuf,
    /// When the last full `walk_project` ran (initial build, watcher-forced
    /// rewalk, or background refresh). Gates the stale-while-revalidate
    /// rebuild in `fileindex_open_project` so rapid project toggles /
    /// picker opens don't stack redundant walks.
    last_walk: Arc<parking_lot::Mutex<std::time::Instant>>,
    /// True while a background rebuild for this project is in flight.
    refreshing: Arc<std::sync::atomic::AtomicBool>,
    files: Arc<RwLock<Vec<IndexedFile>>>,
    /// Bumped whenever `files` is replaced or edited. Lets a derivation that
    /// ran off-lock tell whether the list moved under it before it publishes
    /// (`snapshot_folders`).
    files_gen: Arc<AtomicU64>,
    /// Derived unique-parent-directories list, cached. Lazily built
    /// on first folder query (or first `snapshot_folders` call) and
    /// invalidated in lockstep with `files` via `apply_events`. For
    /// a 5k-file project the derivation walks ~25k parent paths and
    /// does that many HashSet ops; doing it per @-mention keystroke
    /// was a meaningful chunk of the picker's perceived lag.
    folders: FolderCache,
    /// `notify_debouncer_full` returns the debouncer guard; keeping it alive
    /// keeps the OS-level watch active. We never read from it.
    _debouncer: notify_debouncer_full::Debouncer<notify::RecommendedWatcher, NoCache>,
}

/// Per-WINDOW index. Tauri `.manage()` state is one instance per process, so a
/// single `Option<ProjectIndex>` would be shared across every window — opening a
/// project in window B would clobber window A's Cmd+P / @-mention results. We
/// key by the calling webview's label (`main`, `atlas-<ts>`) so each window has
/// its own index. Entries are dropped on `WindowEvent::Destroyed` (see lib.rs).
#[derive(Default)]
pub struct FileIndexState {
    per_window: RwLock<HashMap<String, ProjectIndex>>,
}

impl FileIndexState {
    pub fn new() -> Self {
        Self::default()
    }

    /// A window's project file list + root, for consumers outside this module
    /// (e.g. `mention_search`). Returns `None` when that window has no project
    /// indexed yet.
    ///
    /// The `Arc` is the point: this used to deep-clone every `IndexedFile`
    /// (two `String`/`PathBuf` allocations each) on every @-mention keystroke,
    /// to rank them and keep thirty. `fileindex_search` already takes the
    /// pointer instead and holds the inner read lock across the match; this is
    /// the same move for the other caller. A concurrent re-index inserts a
    /// fresh `ProjectIndex`, so the `Arc` the caller holds stays a safe
    /// snapshot of the list it started with.
    pub fn files_arc(&self, label: &str) -> Option<(Arc<RwLock<Vec<IndexedFile>>>, PathBuf)> {
        let guard = self.per_window.read();
        guard.get(label).map(|p| (p.files.clone(), p.root.clone()))
    }

    /// Drop a window's index (called on window close). Dropping `ProjectIndex`
    /// also drops its `_debouncer`, stopping the fs watcher. Returns the
    /// project root when no other window still has it open, so the caller can
    /// release that root's code index too.
    pub fn drop_window(&self, label: &str) -> Option<PathBuf> {
        let mut per_window = self.per_window.write();
        let gone = per_window.remove(label)?;
        (!root_still_open(per_window.values().map(|p| p.root.as_path()), &gone.root))
            .then_some(gone.root)
    }

    /// The derived unique-folder list. Lazily built on first access
    /// (cost: ~O(files × depth)), cached, invalidated by the fs watcher on the
    /// next file-set change. After warmup this is a pointer copy — what makes
    /// the @-mention picker's folder kind sub-millisecond per keystroke.
    ///
    /// Two things here were costing what the cache was meant to save. The
    /// `per_window` read guard outlived the derivation it was documented as
    /// dropping, so every concurrent search and the watcher's write serialized
    /// behind it; and both the derivation's input and its result were deep
    /// cloned. The guard is now genuinely dropped, and the cache holds an
    /// `Arc` so a hit copies a pointer.
    pub fn snapshot_folders(&self, label: &str) -> Option<FolderList> {
        // Take the three Arcs and let go of the map: nothing below needs it.
        let (folders, files, files_gen, root) = {
            let guard = self.per_window.read();
            let project = guard.get(label)?;
            (
                project.folders.clone(),
                project.files.clone(),
                project.files_gen.clone(),
                project.root.clone(),
            )
        };
        if let Some(cached) = folders.read().as_ref() {
            return Some(cached.clone());
        }
        // Cache miss — derive once, publish, return.
        //
        // The derivation runs OFF the `files` lock: it is an O(files × depth)
        // pass, and `parking_lot` queues readers behind a waiting writer, so
        // holding the lock across it would make the watcher's write — and then
        // every keystroke behind it — wait on the derivation.
        //
        // Which is why the publish is guarded instead. The watcher replaces
        // `files` and THEN clears this cache; a derivation that read the old
        // list and stored after that clear would leave a stale `Some` with the
        // invalidation already spent — new directories missing from `@folder`
        // until some later, unrelated fs event. The generation says whether
        // the list moved while we were deriving; if it did, the result
        // describes a file set that no longer exists, so it is returned to
        // this caller (who asked before the change) and not cached.
        let (generation, snapshot) = {
            let guard = files.read();
            (files_gen.load(Ordering::Acquire), guard.clone())
        };
        let derived = Arc::new(derive_folders(&snapshot, &root));
        {
            let mut slot = folders.write();
            if files_gen.load(Ordering::Acquire) == generation {
                *slot = Some(derived.clone());
            }
        }
        Some(derived)
    }
}

/// Walk each file's parent chain, collect unique relative folders.
/// Pulled out as a free function so the lazy-cache path in
/// `snapshot_folders` can call it without holding the project lock.
fn derive_folders(files: &[IndexedFile], root: &Path) -> Vec<(String, PathBuf)> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<(String, PathBuf)> = Vec::new();
    for f in files {
        let mut cur = Path::new(&f.rel).parent();
        while let Some(p) = cur {
            let rel = p.to_string_lossy();
            if rel.is_empty() {
                break;
            }
            let rel = rel.into_owned();
            if seen.insert(rel.clone()) {
                out.push((rel, root.join(p)));
            }
            cur = p.parent();
        }
    }
    out
}

/// Open (or replace) the indexed project. Returns once the initial walk
/// completes — for very large repos this can take a moment (multi-second on
/// huge monorepos with deep .gitignore trees), but everything after is
/// incremental.
///
/// **Async + `spawn_blocking`**: the recursive walk and the macOS FSEvents
/// stream creation both block. A sync `#[tauri::command]` would run them on
/// the NSApp main thread and produce a 2–3 s beachball during project open.
/// We move the work onto tokio's blocking pool and only write back to the
/// shared `State` once the heavy lifting is done.
#[tauri::command]
pub async fn fileindex_open_project(
    path: String,
    workspace_id: Option<String>,
    app: AppHandle,
    webview: WebviewWindow,
    state: State<'_, FileIndexState>,
) -> Result<usize, String> {
    // The index is keyed by the caller's project id (multiple projects now
    // live in one window). Watcher events still go to the real window, tagged
    // with this id so the frontend can route them to the right project.
    let key = workspace_id.unwrap_or_else(|| webview.label().to_string());
    let window_label = webview.label().to_string();
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }

    // Resident index → return the current count instantly (project
    // switches must stay cheap), but kick off a THROTTLED background
    // rebuild: fresh walk AND fresh watch plan, swapped in atomically when
    // done. The old unconditional early-return made every re-open a no-op,
    // so a single missed watcher event (or a top-level directory created
    // after the watch plan was made — those are never watched) meant the
    // index was stale until the project was closed. Now Cmd+P "Reindex"
    // and the picker's ensure path genuinely recover, stale-while-revalidate.
    let resident = {
        let guard = state.per_window.read();
        guard.get(&key).map(|ex| {
            let stale = ex.last_walk.lock().elapsed() >= REFRESH_MIN_INTERVAL;
            // `swap` claims the refresh slot — only one rebuild in flight.
            let claimed = stale
                && !ex
                    .refreshing
                    .swap(true, std::sync::atomic::Ordering::SeqCst);
            (ex.files.read().len(), claimed, ex.refreshing.clone())
        })
    };
    if let Some((count, claimed, refreshing)) = resident {
        if claimed {
            let app_bg = app.clone();
            let key_bg = key.clone();
            let window_bg = window_label.clone();
            let root_bg = root.clone();
            tauri::async_runtime::spawn(async move {
                match build_project_index(
                    root_bg,
                    app_bg.clone(),
                    key_bg.clone(),
                    window_bg.clone(),
                )
                .await
                {
                    Ok(index) => {
                        let fresh_count = index.files.read().len();
                        let st = app_bg.state::<FileIndexState>();
                        // Swap in the fresh index (dropping the old watcher) —
                        // but ONLY if the project still holds an index for
                        // this same root. If it was closed (or repointed at a
                        // different project) mid-rebuild, inserting would
                        // resurrect a torn-down watcher.
                        let swapped = {
                            let mut guard = st.per_window.write();
                            match guard.get(&key_bg) {
                                Some(existing) if existing.root == index.root => {
                                    guard.insert(key_bg.clone(), index);
                                    true
                                }
                                _ => false,
                            }
                        };
                        if swapped {
                            let _ = app_bg.emit_to(
                                window_bg.as_str(),
                                "atlas:fileindex:updated",
                                serde_json::json!({ "workspaceId": key_bg, "count": fresh_count }),
                            );
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            target: "atlas::fileindex",
                            "background reindex failed: {e}"
                        );
                        // Release the slot so a later open can retry.
                        refreshing.store(false, std::sync::atomic::Ordering::SeqCst);
                    }
                }
            });
        }
        return Ok(count);
    }

    let index = build_project_index(root, app.clone(), key.clone(), window_label.clone()).await?;
    let count = index.files.read().len();
    state.per_window.write().insert(key.clone(), index);

    // Tell the window the index is now searchable. Mirrors the event the
    // watcher fires on file-set changes — palette + mention picker both listen
    // for it, so a re-query lands the user's first results the instant the walk
    // finishes (no manual reopen needed). Tagged with the project id so the
    // frontend ignores it unless it belongs to the active project.
    let _ = app.emit_to(
        window_label.as_str(),
        "atlas:fileindex:updated",
        serde_json::json!({ "workspaceId": key, "count": count }),
    );

    Ok(count)
}

/// Minimum age before a re-open triggers a background rebuild. Guards rapid
/// project toggles and per-keystroke ensure calls from stacking walks.
const REFRESH_MIN_INTERVAL: Duration = Duration::from_secs(10);

/// Build a complete `ProjectIndex` for `root`: full ignore-respecting walk,
/// fresh watcher plan, debounced watcher wired to emit against
/// (`key` = project id, `window_label` = emit target). Shared by the
/// first open and the background refresh path.
async fn build_project_index(
    root: PathBuf,
    app: AppHandle,
    key: String,
    window_label: String,
) -> Result<ProjectIndex, String> {
    // Off the main thread: walk the tree AND build the watcher. Watcher
    // creation isn't free on macOS — FSEvents does an initial scan of the
    // path tree before returning a stream handle.
    let root_for_task = root.clone();
    let app_for_task = app.clone();
    // Capture both: the project id (payload tag) and the window label (emit
    // target) — they differ now that one window hosts many projects.
    let key_for_task = key.clone();
    let window_for_task = window_label.clone();
    let (files, files_gen, folders, debouncer): BuiltIndex =
        tokio::task::spawn_blocking(move || -> Result<_, String> {
            let walked = walk_project(&root_for_task);
            let files = Arc::new(RwLock::new(walked));
            let files_gen = Arc::new(AtomicU64::new(0));
            let gen_for_watch = files_gen.clone();
            // Folder cache starts empty — first folder query fills it.
            // The watcher callback flushes it on any file-set change so
            // the next derivation pass sees fresh data.
            let folders: FolderCache = Arc::new(RwLock::new(None));

            let files_for_watch = files.clone();
            let folders_for_watch = folders.clone();
            let root_for_watch = root_for_task.clone();
            let app_for_watch = app_for_task.clone();
            let key_for_watch = key_for_task.clone();
            let window_for_watch = window_for_task.clone();
            // Resolved once, here: a project opened through a symlink is
            // reported by FSEvents under its resolved path, and nothing below
            // (the ignore filter, the index, the tree's `dirs`) would match it.
            let canonical_for_watch = resolved_alias(&root_for_task);

            // `NoCache`, not the platform default. On macOS `RecommendedCache` is a
            // `FileIdMap`, which `stat`s every event path to correlate renames — on
            // the FSEvents callback thread. We treat renames as a re-walk anyway
            // (see `apply_events`), so that cache bought nothing and cost a syscall
            // per event. It is what Linux already uses.
            let mut debouncer = new_debouncer_opt::<_, notify::RecommendedWatcher, NoCache>(
                Duration::from_millis(150),
                None,
                move |result: notify_debouncer_full::DebounceEventResult| match result {
                    Ok(mut events) => {
                        // Event paths as the project was opened, not as the OS
                        // resolved them.
                        if let Some(canonical) = &canonical_for_watch {
                            for e in &mut events {
                                for p in &mut e.event.paths {
                                    under_given_root(p, &root_for_watch, canonical);
                                }
                            }
                        }
                        // Drop anything under a directory we never index BEFORE any
                        // work happens. Without this a single `npm install` or
                        // `cargo build` turns into a sustained event storm.
                        // Reads go too (see `is_file_change`).
                        let events: Vec<_> = events
                            .into_iter()
                            .filter(|e| {
                                is_file_change(&e.event)
                                    && !e
                                        .event
                                        .paths
                                        .iter()
                                        .all(|p| is_ignored_event_path(&root_for_watch, p))
                            })
                            .collect();
                        if events.is_empty() {
                            return;
                        }
                        // Compute the set of parent dirs touched BEFORE
                        // we hand `events` to `apply_events` (which
                        // consumes them). The explorer uses this to
                        // refetch only the affected, currently-loaded
                        // directories instead of re-walking the whole
                        // project — agent file writes are tiny bursts,
                        // typically one parent dir per debounce.
                        let (dirs_touched, mut full_refresh) = summarise_events(&events);

                        // A `.gitignore` edit changes which entries
                        // `read_directories` flags as ignored, anywhere below
                        // it: drop the cached matcher, and have the explorer
                        // re-read what it has loaded rather than one folder.
                        let gitignore_changed = events.iter().any(|e| {
                            e.event
                                .paths
                                .iter()
                                .any(|p| super::fs_entries::is_gitignore(p))
                        });
                        if gitignore_changed || full_refresh {
                            super::fs_entries::invalidate(
                                &root_for_watch,
                                events
                                    .iter()
                                    .flat_map(|e| e.event.paths.iter().map(PathBuf::as_path)),
                                full_refresh,
                            );
                        }
                        full_refresh |= gitignore_changed;

                        apply_events(&root_for_watch, &files_for_watch, &gen_for_watch, events);
                        // Files just changed — drop the derived folder
                        // cache so the next mention_search rebuilds it.
                        *folders_for_watch.write() = None;
                        let _ = app_for_watch.emit_to(
                            window_for_watch.as_str(),
                            "atlas:fileindex:updated",
                            serde_json::json!({
                                "workspaceId": key_for_watch,
                                "count": files_for_watch.read().len(),
                            }),
                        );
                        let _ = app_for_watch.emit_to(
                            window_for_watch.as_str(),
                            "atlas:explorer:changed",
                            serde_json::json!({
                                "workspaceId": key_for_watch,
                                "dirs": dirs_touched
                                    .iter()
                                    .map(|p| p.to_string_lossy().into_owned())
                                    .collect::<Vec<_>>(),
                                // When `notify` gives us an opaque modify
                                // event (e.g. rename) we can't pinpoint
                                // dirs — the frontend should re-walk the
                                // whole loaded tree in that case.
                                "fullRefresh": full_refresh,
                            }),
                        );
                    }
                    Err(errors) => {
                        for e in errors {
                            tracing::warn!("file watch error: {e}");
                        }
                    }
                },
                NoCache::new(),
                notify::Config::default(),
            )
            .map_err(|e| format!("failed to create watcher: {e}"))?;

            // One watch per non-ignored top-level entry rather than one recursive
            // watch of everything. A failure on a single subtree is not fatal —
            // losing live updates for one directory beats refusing to index at all.
            for (path, mode) in watch_roots(&root_for_task) {
                if let Err(e) = debouncer.watch(&path, mode) {
                    tracing::warn!(
                        target: "atlas::fileindex",
                        "failed to watch {}: {e}", path.display()
                    );
                }
            }

            Ok((files, files_gen, folders, debouncer))
        })
        .await
        .map_err(|e| e.to_string())??;

    Ok(ProjectIndex {
        root,
        files_gen,
        last_walk: Arc::new(parking_lot::Mutex::new(std::time::Instant::now())),
        refreshing: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        files,
        folders,
        _debouncer: debouncer,
    })
}

#[tauri::command(async)]
pub fn fileindex_close_project(
    workspace_id: Option<String>,
    webview: WebviewWindow,
    state: State<'_, FileIndexState>,
) {
    let key = workspace_id.unwrap_or_else(|| webview.label().to_string());
    state.drop_window(&key);
}

/// Whether any window still has `root` open.
fn root_still_open<'a>(roots: impl IntoIterator<Item = &'a Path>, root: &Path) -> bool {
    roots.into_iter().any(|r| r == root)
}

#[derive(Debug, Clone, Serialize)]
pub struct FileIndexStatus {
    pub indexed: bool,
    pub count: usize,
    pub root: Option<String>,
}

#[tauri::command]
pub fn fileindex_status(
    workspace_id: Option<String>,
    webview: WebviewWindow,
    state: State<'_, FileIndexState>,
) -> FileIndexStatus {
    let key = workspace_id.unwrap_or_else(|| webview.label().to_string());
    match state.per_window.read().get(&key) {
        Some(idx) => FileIndexStatus {
            indexed: true,
            count: idx.files.read().len(),
            root: Some(idx.root.to_string_lossy().into_owned()),
        },
        None => FileIndexStatus {
            indexed: false,
            count: 0,
            root: None,
        },
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FolderMatch {
    pub path: String,
    pub rel: String,
}

/// Fuzzy-search the project for **directories**. Derived from the file
/// index's parent paths — no separate directory walk or watcher — and cached
/// in `ProjectIndex` until the watcher sees the file set change
/// (`snapshot_folders`).
#[tauri::command(async)]
pub fn fileindex_search_dirs(
    query: String,
    limit: usize,
    workspace_id: Option<String>,
    webview: WebviewWindow,
    state: State<'_, FileIndexState>,
) -> Vec<FolderMatch> {
    let key = workspace_id.unwrap_or_else(|| webview.label().to_string());
    // The cached derivation `snapshot_folders` maintains (built once, dropped
    // by the watcher on file-set changes). This command predated the cache
    // and kept re-deriving inline — O(files × depth) String allocations per
    // call, which on a large repo was hundreds of thousands of allocations
    // per @-mention keystroke.
    let Some(folders) = state.snapshot_folders(&key) else {
        return Vec::new();
    };

    let to_match = |(rel, abs): &(String, PathBuf)| FolderMatch {
        path: abs.to_string_lossy().into_owned(),
        rel: rel.clone(),
    };

    let trimmed = query.trim();
    if trimmed.is_empty() {
        return folders.iter().take(limit.max(1)).map(to_match).collect();
    }

    let mut matcher = Matcher::default();
    let pattern = Pattern::parse(trimmed, CaseMatching::Smart, Normalization::Smart);
    let mut buf = Vec::new();
    let mut scored: Vec<(u32, &(String, PathBuf))> = folders
        .iter()
        .filter_map(|f| score_rel(&pattern, &mut matcher, &mut buf, &f.0).map(|score| (score, f)))
        .collect();
    scored.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    scored
        .into_iter()
        .take(limit.max(1))
        .map(|(_, f)| to_match(f))
        .collect()
}

/// Fuzzy-search the index. Empty query returns the first `limit` entries —
/// useful for the palette's empty state ("recent files" effect).
#[tauri::command(async)]
pub fn fileindex_search(
    query: String,
    limit: usize,
    workspace_id: Option<String>,
    webview: WebviewWindow,
    state: State<'_, FileIndexState>,
) -> Vec<FileMatch> {
    let key = workspace_id.unwrap_or_else(|| webview.label().to_string());
    // Clone the Arc (a pointer copy), not the whole file Vec, then hold the
    // inner read lock across the match. The old code deep-cloned every
    // IndexedFile (path + rel String) on *each keystroke* just to read it —
    // multi-MB per search on a large repo. Matching is pure CPU (no .await),
    // so holding the read lock is fine; a concurrent re-index inserts a fresh
    // ProjectIndex, leaving this Arc as a safe snapshot.
    let files_arc = {
        let guard = state.per_window.read();
        match guard.get(&key) {
            Some(p) => p.files.clone(),
            None => return Vec::new(),
        }
    };
    let files = files_arc.read();

    let trimmed = query.trim();
    if trimmed.is_empty() {
        return files
            .iter()
            .take(limit.max(1))
            .map(|f| FileMatch {
                path: f.path.to_string_lossy().into_owned(),
                rel: f.rel.clone(),
            })
            .collect();
    }

    let mut matcher = Matcher::default();
    let pattern = Pattern::parse(trimmed, CaseMatching::Smart, Normalization::Smart);
    let mut buf = Vec::new();

    let mut scored: Vec<(u32, &IndexedFile)> = files
        .iter()
        .filter_map(|f| score_rel(&pattern, &mut matcher, &mut buf, &f.rel).map(|score| (score, f)))
        .collect();
    // Highest score first; stable order on ties (insertion = file walk order).
    scored.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    scored
        .into_iter()
        .take(limit.max(1))
        .map(|(_, f)| FileMatch {
            path: f.path.to_string_lossy().into_owned(),
            rel: f.rel.clone(),
        })
        .collect()
}

/// Fuzzy score of a project-relative path. `Utf32Str::new` takes the ASCII
/// fast path when it can and decodes to chars otherwise. Labelling raw UTF-8
/// as `Utf32Str::Ascii` (the old code) broke the type's ASCII-only invariant
/// and made every non-ASCII path unmatchable.
fn score_rel(
    pattern: &Pattern,
    matcher: &mut Matcher,
    buf: &mut Vec<char>,
    rel: &str,
) -> Option<u32> {
    pattern.score(nucleo_matcher::Utf32Str::new(rel, buf), matcher)
}

// ── internals ────────────────────────────────────────────────────────────

/// The paths worth watching under `root`.
///
/// **This is the difference between watching 700 files and watching 350,000.**
/// The initial walk has always honoured `.gitignore`; the watcher did not — it
/// took `RecursiveMode::Recursive` on the project root, so `target/`,
/// `node_modules/` and friends were watched despite never being indexed. On this
/// repo that is 265k files in `src-tauri/target` plus 90k in `node_modules`, to
/// maintain an index of ~700. Every write in those trees woke the FSEvents
/// thread, and the debouncer's file-id cache `stat`-ed each path — which is
/// exactly where a sampled 100%-CPU Atlas was spending its time.
///
/// So: watch the root **non-recursively** (to catch new top-level entries), and
/// each non-ignored top-level directory recursively. `WalkBuilder` at depth 1
/// applies the same ignore rules as [`walk_project`], so what is watched and
/// what is indexed cannot drift.
///
/// Nested ignored directories (`packages/*/node_modules`) still fall inside a
/// watched subtree; [`is_ignored_event_path`] drops their events on arrival.
/// The directories to watch under one root, and how deep each watch goes.
type WatchPlan = Vec<(PathBuf, RecursiveMode)>;

fn watch_roots(root: &Path) -> WatchPlan {
    match plan_watches(root, 0) {
        // Nothing ignored anywhere in reach — one recursive watch is optimal.
        None => vec![(root.to_path_buf(), RecursiveMode::Recursive)],
        // A tree pathological enough to need this many streams is better served
        // by one watch plus the event filter than by hundreds of FSEvents
        // streams; the filter is a string check, and streams are a real resource.
        Some(plan) if plan.len() > MAX_WATCHES => {
            vec![(root.to_path_buf(), RecursiveMode::Recursive)]
        }
        Some(plan) => plan,
    }
}

/// How deep the splitting goes before giving up and taking one recursive watch.
/// Ignored directories live near the top in practice (`node_modules`,
/// `src-tauri/target`, `packages/*/node_modules`), so a shallow bound finds them
/// all while keeping the watch count small.
const MAX_SPLIT_DEPTH: usize = 4;
/// Ceiling on FSEvents streams for one project. A tree pathological enough to
/// hit this gets a plain recursive watch, and [`is_ignored_event_path`] absorbs
/// the noise.
const MAX_WATCHES: usize = 256;

/// Plan the watches for `dir`, or `None` when its whole subtree is clean and the
/// caller can cover it with a single recursive watch.
///
/// The decision is **post-order**: a directory splits if it prunes a child *or*
/// if anything below it does. Deciding on the immediate level alone was not
/// enough — in this very repo `target/` sits at `src-tauri/target`, so the
/// project root looks perfectly clean while 265k files hide two levels down.
fn plan_watches(dir: &Path, depth: usize) -> Option<WatchPlan> {
    if depth >= MAX_SPLIT_DEPTH {
        // Stop splitting; report clean so the caller takes one recursive watch.
        // `is_ignored_event_path` absorbs whatever noise remains below.
        return None;
    }

    // What the ignore rules keep. `WalkBuilder` at depth 1 applies exactly the
    // rules `walk_project` uses, so what is watched and what is indexed cannot
    // drift apart.
    let kept: Vec<PathBuf> = WalkBuilder::new(dir)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .max_depth(Some(1))
        .build()
        .flatten()
        .filter(|e| e.path() != dir && e.file_type().is_some_and(|t| t.is_dir()))
        .map(|e| e.path().to_path_buf())
        // Belt and braces over the ignore rules: `.git` is implicitly ignored by
        // git so it never appears in a `.gitignore`, and a repo that simply
        // forgot to ignore `node_modules` should not cost the user a core.
        .filter(|p| {
            !p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| NOISY_DIRS.contains(&n))
        })
        .collect();

    // What is actually on disk. The difference is what we are avoiding.
    let on_disk = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .count()
        })
        .unwrap_or(kept.len());
    let pruned_here = on_disk != kept.len();

    let child_plans: Vec<(PathBuf, Option<WatchPlan>)> = kept
        .into_iter()
        .map(|c| {
            let plan = plan_watches(&c, depth + 1);
            (c, plan)
        })
        .collect();

    if !pruned_here && child_plans.iter().all(|(_, p)| p.is_none()) {
        return None; // clean all the way down
    }

    let mut out = vec![(dir.to_path_buf(), RecursiveMode::NonRecursive)];
    for (child, plan) in child_plans {
        match plan {
            None => out.push((child, RecursiveMode::Recursive)),
            Some(sub) => out.extend(sub),
        }
    }
    Some(out)
}

/// Directory names that are never indexed and never worth waking for, checked at
/// any depth. A backstop for two cases `watch_roots` cannot cover: a nested
/// ignored directory inside a watched subtree, and one created after the watch
/// began.
const NOISY_DIRS: [&str; 12] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    ".next",
    ".turbo",
    ".venv",
    "__pycache__",
    ".cache",
    ".pytest_cache",
    ".mypy_cache",
    ".svelte-kit",
];

/// True when an event path lies inside a directory we never index.
/// `root` resolved through any symlinks, when that differs from `root`. The
/// project keeps the path it was opened with; this is the one the OS may
/// report events under (macOS FSEvents always answers with resolved paths).
fn resolved_alias(root: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(root).ok().filter(|c| c != root)
}

/// Re-root `path` from `resolved` (see [`resolved_alias`]) onto `root`, the
/// path the project was opened with. Paths not under `resolved` are left as
/// they are.
fn under_given_root(path: &mut PathBuf, root: &Path, resolved: &Path) {
    let Ok(rest) = path.strip_prefix(resolved) else {
        return;
    };
    *path = if rest.as_os_str().is_empty() {
        root.to_path_buf()
    } else {
        root.join(rest)
    };
}

fn is_ignored_event_path(root: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };
    rel.components().any(|c| {
        c.as_os_str()
            .to_str()
            .is_some_and(|s| NOISY_DIRS.contains(&s))
    })
}

/// Whether a filesystem event under the project can mean a file changed.
///
/// Reads are not changes. On Linux inotify reports every `open` and `close`
/// (macOS FSEvents reports neither). Every listener of `atlas:explorer:changed`
/// reads the tree: the explorer re-lists directories, open editor tabs
/// revalidate, and the project git store runs `git status`. Without this
/// filter each of those reads fired the watcher again, about 40 times a
/// second on an idle window (#407). Same rule as `atlas-theme`'s
/// `is_theme_change` and #375's `is_git_change`.
///
/// Closing a file opened for writing still counts. A write always comes with
/// a modify event too, so this is belt and braces, and nothing that only reads
/// produces it.
fn is_file_change(event: &notify::Event) -> bool {
    use notify::event::{AccessKind, AccessMode};
    match event.kind {
        EventKind::Access(AccessKind::Close(AccessMode::Write)) => true,
        EventKind::Access(_) => false,
        _ => true,
    }
}

fn walk_project(root: &Path) -> Vec<IndexedFile> {
    let walker = WalkBuilder::new(root)
        .hidden(false) // dotfiles like .env / .gitignore are valid hits
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .build();

    let mut out = Vec::new();
    for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let path = entry.into_path();
        if let Some(rel) = relative(&path, root) {
            out.push(IndexedFile { path, rel });
        }
    }
    out
}

fn relative(path: &Path, root: &Path) -> Option<String> {
    path.strip_prefix(root)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Bucket a batch of debounced filesystem events into:
///   - the unique parent directories whose contents changed (so the
///     explorer can refetch JUST those), and
///   - a `full_refresh` flag for events `notify` reports as opaque
///     `Modify(_)` (typically renames) that we can't pin to a specific
///     parent. The explorer falls back to re-walking the loaded tree
///     in that case.
fn summarise_events(events: &[DebouncedEvent]) -> (std::collections::HashSet<PathBuf>, bool) {
    use std::collections::HashSet;
    let mut dirs: HashSet<PathBuf> = HashSet::new();
    let mut full_refresh = false;
    for ev in events {
        match ev.event.kind {
            EventKind::Create(_) | EventKind::Remove(_) => {
                for p in &ev.event.paths {
                    if let Some(parent) = p.parent() {
                        dirs.insert(parent.to_path_buf());
                    }
                }
            }
            // Same reasoning as `apply_events`: an edit to a file's contents
            // changes nothing about the tree the explorer draws, so it must not
            // force it to re-walk everything it has open.
            EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Metadata(_)) => {}
            EventKind::Modify(_) => {
                full_refresh = true;
            }
            _ => {}
        }
    }
    (dirs, full_refresh)
}

fn apply_events(
    root: &Path,
    files: &Arc<RwLock<Vec<IndexedFile>>>,
    files_gen: &AtomicU64,
    events: Vec<DebouncedEvent>,
) {
    // Strategy: collect adds/removes/renames separately, then mutate the
    // vec once under a single write lock. For complex events (e.g. branch
    // switch), `notify` may not surface kind-level info, in which case we
    // re-walk the affected subtree.
    let mut to_remove: Vec<PathBuf> = Vec::new();
    let mut to_add: Vec<PathBuf> = Vec::new();
    let mut needs_rewalk = false;

    for ev in events {
        match ev.event.kind {
            EventKind::Create(_) => {
                for p in &ev.event.paths {
                    if p.is_file() {
                        to_add.push(p.clone());
                    } else if p.is_dir() {
                        needs_rewalk = true;
                    }
                }
            }
            EventKind::Remove(_) => {
                for p in &ev.event.paths {
                    to_remove.push(p.clone());
                }
            }
            // A content or metadata edit cannot change the file SET, so it is
            // not this index's business. Only a rename can, and only that is
            // worth a re-walk. Lumping all of `Modify` together meant every
            // saved file — and every one of the thousands a build writes —
            // triggered a full `walk_project`, up to once per 150ms debounce
            // window, forever. That was the second half of the CPU burn.
            EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Metadata(_)) => {}
            EventKind::Modify(_) => {
                // Rename or move shows up here; the cheapest correct fix is
                // a full re-walk of the project. notify-full's rename events
                // are fiddly across platforms.
                needs_rewalk = true;
            }
            _ => {}
        }
    }

    if needs_rewalk {
        let fresh = walk_project(root);
        *files.write() = fresh;
        files_gen.fetch_add(1, Ordering::Release);
        return;
    }

    if to_add.is_empty() && to_remove.is_empty() {
        return;
    }

    let mut w = files.write();
    if !to_remove.is_empty() {
        let remove_set: std::collections::HashSet<_> = to_remove.into_iter().collect();
        w.retain(|f| !remove_set.contains(&f.path));
    }
    for p in to_add {
        // Skip if already present (notify can fire Create twice on macOS).
        if w.iter().any(|f| f.path == p) {
            continue;
        }
        if let Some(rel) = relative(&p, root) {
            w.push(IndexedFile { path: p, rel });
        }
    }
    drop(w);
    files_gen.fetch_add(1, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TmpDir(PathBuf);
    impl TmpDir {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("atlas-fi-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
        fn dir(&self, rel: &str) {
            std::fs::create_dir_all(self.0.join(rel)).unwrap();
        }
        fn file(&self, rel: &str, body: &str) {
            let p = self.0.join(rel);
            if let Some(d) = p.parent() {
                std::fs::create_dir_all(d).unwrap();
            }
            std::fs::write(p, body).unwrap();
        }
    }
    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A project opened through a symlink: FSEvents reports the resolved path,
    /// and the tree only matches paths under the root it was given.
    #[cfg(unix)]
    #[test]
    fn events_under_a_symlinked_root_come_back_under_the_given_root() {
        let t = TmpDir::new();
        t.dir("real/src");
        let link = t.path().join("link");
        std::os::unix::fs::symlink(t.path().join("real"), &link).unwrap();

        let resolved = resolved_alias(&link).expect("a symlinked root resolves elsewhere");
        assert_eq!(
            resolved,
            std::fs::canonicalize(t.path().join("real")).unwrap()
        );
        assert_eq!(
            resolved_alias(&resolved),
            None,
            "a resolved root is its own"
        );

        let mut inside = resolved.join("src/a.ts");
        under_given_root(&mut inside, &link, &resolved);
        assert_eq!(inside, link.join("src/a.ts"));

        let mut at_root = resolved.clone();
        under_given_root(&mut at_root, &link, &resolved);
        assert_eq!(at_root, link);

        let mut outside = PathBuf::from("/elsewhere/b.ts");
        under_given_root(&mut outside, &link, &resolved);
        assert_eq!(outside, PathBuf::from("/elsewhere/b.ts"));
    }

    /// The regression this whole change exists for: the watcher used to take one
    /// recursive watch on the root, so it woke for every write under `target/`
    /// and `node_modules/` — hundreds of thousands of files that are never
    /// indexed — and pegged a core.
    #[test]
    fn watch_roots_skip_ignored_and_noisy_directories() {
        let t = TmpDir::new();
        t.file(".gitignore", "target/\ndist/\n");
        t.dir("src");
        t.dir("crates");
        t.dir("target");
        t.dir("dist");
        t.dir("node_modules");
        t.dir(".git");

        let roots = watch_roots(t.path());
        let watched: Vec<String> = roots
            .iter()
            .filter(|(_, m)| *m == RecursiveMode::Recursive)
            .map(|(p, _)| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();

        assert!(watched.contains(&"src".to_string()));
        assert!(watched.contains(&"crates".to_string()));
        for skipped in ["target", "dist", "node_modules", ".git"] {
            assert!(
                !watched.contains(&skipped.to_string()),
                "{skipped} must not be watched"
            );
        }

        // The root itself is still watched, non-recursively, so a NEW top-level
        // directory is still noticed.
        assert!(roots
            .iter()
            .any(|(p, m)| p == t.path() && *m == RecursiveMode::NonRecursive));
    }

    /// The case that actually bit this repo: `target/` is not top-level, it is
    /// `src-tauri/target/`. Depth-1 filtering alone would still have handed
    /// FSEvents all 265k files inside it.
    #[test]
    fn nested_ignored_directories_are_split_around() {
        let t = TmpDir::new();
        t.file(".gitignore", "target/\n");
        t.file("src-tauri/src/lib.rs", "");
        t.dir("src-tauri/target/debug");
        t.dir("src-tauri/capabilities");
        t.file("src/main.ts", "");

        let roots = watch_roots(t.path());
        let has = |rel: &str, mode: RecursiveMode| {
            roots
                .iter()
                .any(|(p, m)| *p == t.path().join(rel) && *m == mode)
        };

        // `src-tauri` holds an ignored child, so it is split: watched shallowly,
        // with its real children watched recursively...
        assert!(has("src-tauri", RecursiveMode::NonRecursive));
        assert!(has("src-tauri/src", RecursiveMode::Recursive));
        assert!(has("src-tauri/capabilities", RecursiveMode::Recursive));
        // ...and `target` is never handed to FSEvents at all.
        assert!(
            !roots
                .iter()
                .any(|(p, _)| p.starts_with(t.path().join("src-tauri/target"))),
            "the ignored subtree must not be watched in any mode"
        );
        // A clean subtree still gets exactly one recursive watch.
        assert!(has("src", RecursiveMode::Recursive));
    }

    /// `watch_roots` cannot cover a nested `node_modules`, or one created after
    /// the watch began — those events still arrive and must be dropped on sight.
    #[test]
    fn nested_ignored_paths_are_filtered() {
        let root = Path::new("/p");
        assert!(is_ignored_event_path(
            root,
            Path::new("/p/packages/web/node_modules/react/index.js")
        ));
        assert!(is_ignored_event_path(
            root,
            Path::new("/p/a/target/debug/x")
        ));
        assert!(is_ignored_event_path(root, Path::new("/p/.git/index")));

        assert!(!is_ignored_event_path(root, Path::new("/p/src/main.rs")));
        // Substring matches must not trip it: `targets` is not `target`.
        assert!(!is_ignored_event_path(root, Path::new("/p/targets/a.rs")));
        // A path outside the root is not ours to judge.
        assert!(!is_ignored_event_path(root, Path::new("/other/target/x")));
    }

    /// The generation moves whenever the file SET does.
    ///
    /// `snapshot_folders` derives the folder list off the `files` lock — the
    /// pass is O(files × depth), and holding the lock across it would make the
    /// watcher's write, and every keystroke queued behind that write, wait for
    /// it. What makes that safe is this counter: the watcher replaces `files`
    /// and then clears the folder cache, so a derivation that read the old
    /// list and published after that clear would leave a stale entry with the
    /// invalidation already spent. The publish re-reads the generation and
    /// drops its result if the list moved underneath. A counter that failed to
    /// move on a real change would reinstate exactly that bug.
    #[test]
    fn the_generation_moves_when_the_file_set_does() {
        let t = TmpDir::new();
        t.file("a.rs", "fn main() {}");
        let files = Arc::new(RwLock::new(walk_project(t.path())));
        let gen = AtomicU64::new(0);

        let ev = |kind: EventKind, p: PathBuf| DebouncedEvent {
            event: notify::Event {
                kind,
                paths: vec![p],
                attrs: Default::default(),
            },
            time: std::time::Instant::now(),
        };

        // A new file: the set grew, so a folder list derived before this is
        // describing a project that no longer exists.
        t.file("b.rs", "fn b() {}");
        apply_events(
            t.path(),
            &files,
            &gen,
            vec![ev(
                EventKind::Create(notify::event::CreateKind::File),
                t.path().join("b.rs"),
            )],
        );
        let after_create = gen.load(Ordering::Acquire);
        assert!(after_create > 0, "adding a file must move the generation");

        // A rename forces a full re-walk, which replaces the list wholesale.
        apply_events(
            t.path(),
            &files,
            &gen,
            vec![ev(
                EventKind::Modify(ModifyKind::Name(notify::event::RenameMode::Any)),
                t.path().join("b.rs"),
            )],
        );
        assert!(
            gen.load(Ordering::Acquire) > after_create,
            "a re-walk must move the generation too"
        );
    }

    /// A content edit cannot change the file SET. Treating it as a rename meant
    /// a full `walk_project` per debounce window — during a build, forever.
    #[test]
    fn content_edits_do_not_force_a_rewalk() {
        let t = TmpDir::new();
        t.file("a.rs", "fn main() {}");
        let files = Arc::new(RwLock::new(walk_project(t.path())));
        let gen = AtomicU64::new(0);
        let before = files.read().len();

        let ev = |kind: EventKind, p: PathBuf| DebouncedEvent {
            event: notify::Event {
                kind,
                paths: vec![p],
                attrs: Default::default(),
            },
            time: std::time::Instant::now(),
        };

        let data = ev(
            EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content)),
            t.path().join("a.rs"),
        );
        let (dirs, full_refresh) = summarise_events(std::slice::from_ref(&data));
        assert!(
            !full_refresh,
            "a content edit must not force a full refresh"
        );
        assert!(dirs.is_empty());

        apply_events(t.path(), &files, &gen, vec![data]);
        assert_eq!(files.read().len(), before);
        assert_eq!(
            gen.load(Ordering::Acquire),
            0,
            "a content edit leaves the file set alone, so the generation holds"
        );

        // A rename still does, because it genuinely can change the set.
        let renamed = ev(
            EventKind::Modify(ModifyKind::Name(notify::event::RenameMode::Any)),
            t.path().join("b.rs"),
        );
        let (_, full_refresh) = summarise_events(std::slice::from_ref(&renamed));
        assert!(full_refresh, "a rename must still refresh");
    }

    /// Cmd+P and the folder picker fed the matcher raw UTF-8 bytes labelled
    /// as ASCII, so every non-ASCII character became two or three junk
    /// "characters" and `café` or `日本語` paths never matched anything.
    #[test]
    fn fuzzy_score_matches_non_ascii_paths() {
        let mut matcher = Matcher::default();
        let mut buf = Vec::new();
        let pattern = |q: &str| Pattern::parse(q, CaseMatching::Smart, Normalization::Smart);
        let mut score = |q: &str, rel: &str| score_rel(&pattern(q), &mut matcher, &mut buf, rel);

        assert!(score("café", "docs/café.md").is_some());
        assert!(
            score("cafe", "docs/café.md").is_some(),
            "smart normalization folds the accent"
        );
        assert!(score("日本", "notes/日本語.md").is_some());
        // ASCII paths take the same fast path as before.
        assert!(score("readme", "docs/über/README.md").is_some());
        assert!(score("xyz", "docs/café.md").is_none());
    }

    /// What re-listing a directory, revalidating an editor tab or `git status`
    /// does to the project on Linux: open, read, close. None of it may reach
    /// the frontend, or its refresh re-fires the watcher forever (#407).
    #[test]
    fn reads_are_not_file_changes() {
        use notify::event::{AccessKind, AccessMode};
        for kind in [
            AccessKind::Open(AccessMode::Read),
            AccessKind::Open(AccessMode::Any),
            AccessKind::Close(AccessMode::Read),
            AccessKind::Read,
            AccessKind::Any,
        ] {
            assert!(
                !is_file_change(&notify::Event::new(EventKind::Access(kind))),
                "{kind:?} must not count as a change"
            );
        }
    }

    /// Edits, creates, deletes and renames still reach the explorer and the
    /// code index.
    #[test]
    fn writes_are_file_changes() {
        use notify::event::{
            AccessKind, AccessMode, CreateKind, DataChange, RemoveKind, RenameMode,
        };
        for kind in [
            EventKind::Create(CreateKind::File),
            EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            EventKind::Modify(ModifyKind::Name(RenameMode::To)),
            EventKind::Modify(ModifyKind::Any),
            EventKind::Remove(RemoveKind::File),
            EventKind::Access(AccessKind::Close(AccessMode::Write)),
            EventKind::Any,
        ] {
            assert!(
                is_file_change(&notify::Event::new(kind)),
                "{kind:?} must count as a change"
            );
        }
    }

    #[test]
    fn a_root_stays_open_while_another_window_has_it() {
        let repo = Path::new("/p/repo");
        let other = Path::new("/p/other");
        assert!(root_still_open([repo, other], repo));
        assert!(!root_still_open([other], repo));
        assert!(!root_still_open(std::iter::empty::<&Path>(), repo));
    }
}

//! File-watcher for `~/.claude/projects/<encoded-cwd>/` so the sidebar gets
//! push notifications instead of polling.
//!
//! Pre-existing path: the sidebar's `useQuery` polled `list_claude_sessions`
//! every 1.5s while any chat was streaming and every 5s otherwise. Each call
//! re-walked the project's JSONL directory and reopened every file to
//! sidechain-check + count messages. For 50+ historical sessions that's a
//! lot of disk thrashing whose only purpose is "did anything change?" —
//! exactly what the OS already tells us via fs events.
//!
//! New path: one watcher per opened cwd, debounced at 250ms. Any create /
//! modify / remove inside that directory fires a single `atlas:sessions-changed`
//! window event. The sidebar drops the polling timer and refetches only on
//! the event.

use std::path::PathBuf;
use std::time::Duration;

use atlas_agent_transcript::encode_cwd;
use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, Debouncer, RecommendedCache};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// Watch handle. Dropping it stops the OS-level watch — the debouncer is
/// held alive solely for that side effect.
struct WatchHandle {
    cwd: String,
    _debouncer: Debouncer<notify::RecommendedWatcher, RecommendedCache>,
}

#[derive(Default)]
pub struct SessionsWatchState {
    current: Mutex<Option<WatchHandle>>,
}

impl SessionsWatchState {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct WatchStatus {
    pub watching: bool,
    pub cwd: Option<String>,
    pub folder: Option<String>,
}

/// Open (or replace) the per-cwd watcher. Idempotent for the same cwd: if
/// we're already watching this directory we don't recreate the watcher,
/// which would otherwise drop and rebuild the OS handle for a no-op.
/// Async + spawn_blocking for the same reason as `fileindex_open_project`:
/// the `notify` debouncer creation involves FSEvents (macOS) / inotify
/// (Linux) syscalls and an initial subtree scan, which would otherwise run
/// on the NSApp main thread and contribute to the project-open beachball.
#[tauri::command]
pub async fn sessions_watch_open(
    cwd: String,
    app: AppHandle,
    state: State<'_, SessionsWatchState>,
) -> Result<WatchStatus, String> {
    {
        let cur = state.current.lock();
        if let Some(handle) = cur.as_ref() {
            if handle.cwd == cwd {
                let folder = encoded_folder(&cwd);
                return Ok(WatchStatus {
                    watching: true,
                    cwd: Some(cwd),
                    folder: folder.map(|p| p.to_string_lossy().into_owned()),
                });
            }
        }
    }

    let Some(folder) = encoded_folder(&cwd) else {
        return Err("could not resolve ~/.claude/projects".into());
    };

    // `create_dir_all` + watcher creation move off the main thread.
    let folder_for_task = folder.clone();
    let app_for_task = app.clone();
    let cwd_for_task = cwd.clone();
    let folder_str = folder.to_string_lossy().into_owned();
    let debouncer = tokio::task::spawn_blocking(move || -> Result<_, String> {
        // claude-code doesn't create the cwd's project dir until the first
        // session writes a JSONL, so a brand-new project hits this path
        // empty. Create it upfront so the watcher has a target.
        if !folder_for_task.exists() {
            std::fs::create_dir_all(&folder_for_task)
                .map_err(|e| format!("could not create {}: {e}", folder_for_task.display()))?;
        }

        let app_for_watch = app_for_task.clone();
        let cwd_for_watch = cwd_for_task.clone();
        let folder_for_log = folder_for_task.clone();

        let mut debouncer = new_debouncer(
            Duration::from_millis(250),
            None,
            move |result: notify_debouncer_full::DebounceEventResult| match result {
                Ok(_events) => {
                    if let Err(e) = app_for_watch.emit(
                        "atlas:sessions-changed",
                        serde_json::json!({ "cwd": &cwd_for_watch }),
                    ) {
                        tracing::warn!(target: "atlas::sessions_watch", "emit failed: {e}");
                    }
                }
                Err(errors) => {
                    for e in errors {
                        tracing::warn!(target: "atlas::sessions_watch", "watch error: {e}");
                    }
                }
            },
        )
        .map_err(|e| format!("failed to create watcher: {e}"))?;

        debouncer
            .watch(&folder_for_task, RecursiveMode::NonRecursive)
            .map_err(|e| format!("failed to watch {}: {e}", folder_for_log.display()))?;

        // Codex and Cersei stores are NOT watched here: Codex's `~/.codex`
        // SQLite WAL/SHM sidecars churn constantly (stormed the debouncer), and
        // both lists now self-refresh via a short `refetchInterval` poll on the
        // frontend. Only the Claude JSONL dir (the primary watch above) is
        // event-driven.
        Ok(debouncer)
    })
    .await
    .map_err(|e| e.to_string())??;

    *state.current.lock() = Some(WatchHandle {
        cwd: cwd.clone(),
        _debouncer: debouncer,
    });

    Ok(WatchStatus {
        watching: true,
        cwd: Some(cwd),
        folder: Some(folder_str),
    })
}

#[tauri::command]
pub fn sessions_watch_close(state: State<'_, SessionsWatchState>) {
    *state.current.lock() = None;
}

#[tauri::command]
pub fn sessions_watch_status(state: State<'_, SessionsWatchState>) -> WatchStatus {
    match state.current.lock().as_ref() {
        Some(handle) => WatchStatus {
            watching: true,
            cwd: Some(handle.cwd.clone()),
            folder: encoded_folder(&handle.cwd).map(|p| p.to_string_lossy().into_owned()),
        },
        None => WatchStatus {
            watching: false,
            cwd: None,
            folder: None,
        },
    }
}

fn encoded_folder(cwd: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(home.join(".claude").join("projects").join(encode_cwd(cwd)))
}

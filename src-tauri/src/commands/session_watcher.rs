//! Watches the open project's Claude transcript directory so a session started
//! in a terminal reaches the sidebar without anything being clicked.
//!
//! ADR-0001 amendment ("discovery is not replay", ATL-423). This module only
//! lists a directory and reads file times (`atlas_agent_transcript::discovery`);
//! it never opens a transcript. It names no agent: a session id that appears on
//! disk is handed to [`AgentHost::sync_project`], and whichever agent lists it
//! over `session/list` owns the row (ADR-0002, Rule 3).
//!
//! On each debounced batch the directory is rescanned and the sessions split:
//!
//! - **known** to the history store and newer than last seen: their
//!   `updated_at` is bumped (forward only), so ongoing terminal activity moves
//!   the row to the top;
//! - **unknown** and new to us: one forced project sync, so the agent can list
//!   the new session into the store. Ids are remembered for
//!   [`RETRY_AFTER`], so a session no installed agent will list cannot cause a
//!   sync on every write.
//!
//! There is no `#[tauri::command]` here: `threads_sync_project` arms it.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use agent_client_protocol::schema::v1 as acp;
use atlas_agent_transcript::discovery::{claude_sessions_dir, scan_sessions};
use chrono::{DateTime, Utc};
use notify::RecursiveMode;
use notify_debouncer_full::new_debouncer;
use parking_lot::Mutex;

use super::agent_host::AgentHost;

/// A terminal session writes its transcript in bursts; this folds a burst into
/// one rescan while still landing a new session well inside the ~5s target.
const DEBOUNCE: Duration = Duration::from_millis(1500);

/// How long an unknown session id counts as already tried.
const RETRY_AFTER: Duration = Duration::from_secs(60);

type Debouncer = notify_debouncer_full::Debouncer<
    notify::RecommendedWatcher,
    notify_debouncer_full::RecommendedCache,
>;

pub struct SessionWatcher {
    host: Arc<AgentHost>,
    /// The project the watcher is armed for. Set before the (blocking) watch
    /// is installed so a second `arm` for the same cwd is a no-op, and checked
    /// by every callback so one from a replaced watcher does nothing.
    cwd: Mutex<Option<String>>,
    /// Keeping the debouncer alive keeps the OS-level watch active.
    debouncer: Mutex<Option<Debouncer>>,
    modified: Mutex<HashMap<String, DateTime<Utc>>>,
    tried: Mutex<HashMap<String, Instant>>,
}

impl SessionWatcher {
    pub fn new(host: Arc<AgentHost>) -> Arc<Self> {
        Arc::new(Self {
            host,
            cwd: Mutex::new(None),
            debouncer: Mutex::new(None),
            modified: Mutex::new(HashMap::new()),
            tried: Mutex::new(HashMap::new()),
        })
    }

    /// Watch this project's Claude directory, replacing any previous one. Same
    /// cwd again is a no-op.
    pub fn arm(self: &Arc<Self>, cwd: &str) {
        {
            let mut armed = self.cwd.lock();
            if armed.as_deref() == Some(cwd) {
                return;
            }
            *armed = Some(cwd.to_owned());
        }
        self.modified.lock().clear();
        let this = self.clone();
        let cwd = cwd.to_owned();
        // Creating a watcher does an initial scan on macOS, and the seeding
        // scan is file I/O: neither belongs on the async runtime's workers.
        tauri::async_runtime::spawn_blocking(move || this.install(&cwd, true));
    }

    /// Last-seen modified time per session id for the armed project. ATL-424
    /// reads this for liveness; until it lands there is no caller.
    #[allow(dead_code)]
    pub fn last_modified(&self) -> HashMap<String, DateTime<Utc>> {
        self.modified.lock().clone()
    }

    /// Start watching for `cwd`, dropping whatever was watched before.
    /// `seed` records the sessions already on disk as seen; the swap from
    /// parent to directory passes `false` so a session that appeared in the
    /// meantime still counts as new.
    fn install(self: &Arc<Self>, cwd: &str, seed: bool) {
        let Some(dir) = claude_sessions_dir(Path::new(cwd)) else {
            return;
        };
        // The directory Claude has not created yet (the project has never had
        // a session) cannot be watched, so watch its parent,
        // `~/.claude/projects`, non-recursively: creating the project's folder
        // is an event there, and the callback swaps to the real directory.
        // The alternative, rescanning on every arm, would only notice a first
        // session the next time the sidebar is focused, missing the "appears
        // within ~5s" goal for exactly the case a new project is.
        let (target, in_parent) = if dir.is_dir() {
            (dir.clone(), false)
        } else if let Some(parent) = dir.parent().filter(|p| p.is_dir()) {
            (parent.to_path_buf(), true)
        } else {
            // No `~/.claude/projects` at all: nothing to watch. Forget the
            // cwd so the next arm tries again, e.g. after Claude Code's first
            // run creates it.
            self.disarm_if_current(cwd);
            return;
        };

        if seed && !in_parent {
            let seen: HashMap<_, _> = scan_sessions(&dir)
                .into_iter()
                .map(|s| (s.session_id, s.modified))
                .collect();
            if self.is_current(cwd) {
                *self.modified.lock() = seen;
            }
        }

        let weak = Arc::downgrade(self);
        let cwd_for_cb = cwd.to_owned();
        let dir_for_cb = dir;
        let mut debouncer = match new_debouncer(
            DEBOUNCE,
            None,
            move |result: notify_debouncer_full::DebounceEventResult| match result {
                Ok(_events) => on_batch(&weak, &cwd_for_cb, &dir_for_cb, in_parent),
                Err(errors) => {
                    for e in errors {
                        tracing::warn!("session watch error: {e}");
                    }
                }
            },
        ) {
            Ok(debouncer) => debouncer,
            Err(e) => {
                tracing::warn!("session watch: could not create watcher: {e}");
                self.disarm_if_current(cwd);
                return;
            }
        };
        if let Err(e) = debouncer.watch(&target, RecursiveMode::NonRecursive) {
            tracing::warn!("session watch: could not watch {}: {e}", target.display());
            self.disarm_if_current(cwd);
            return;
        }
        if self.is_current(cwd) {
            *self.debouncer.lock() = Some(debouncer);
        }
    }

    fn is_current(&self, cwd: &str) -> bool {
        self.cwd.lock().as_deref() == Some(cwd)
    }

    fn disarm_if_current(&self, cwd: &str) {
        let mut armed = self.cwd.lock();
        if armed.as_deref() == Some(cwd) {
            *armed = None;
        }
    }

    /// Rescan, refresh the last-seen map, and act on what moved.
    fn handle_batch(&self, cwd: &str, dir: &Path) {
        let sessions = scan_sessions(dir);
        let previous = {
            if !self.is_current(cwd) {
                return;
            }
            let fresh = sessions
                .iter()
                .map(|s| (s.session_id.clone(), s.modified))
                .collect();
            std::mem::replace(&mut *self.modified.lock(), fresh)
        };
        let Some(history) = self.host.history() else {
            return;
        };
        let store = history.store();
        let known = store.known_session_ids();

        let mut touches = Vec::new();
        let mut unknown = Vec::new();
        for session in sessions {
            let moved = previous
                .get(&session.session_id)
                .is_none_or(|seen| session.modified > *seen);
            if !moved {
                continue;
            }
            let id = acp::SessionId::new(session.session_id);
            if known.contains(&id) {
                touches.push((id, session.modified));
            } else {
                unknown.push(id);
            }
        }

        if !touches.is_empty() {
            store.touch_sessions(&touches);
        }
        if self.note_unknown(&unknown) {
            let host = self.host.clone();
            let cwd = cwd.to_owned();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = host.sync_project(&cwd, true).await {
                    tracing::warn!(error = %e.message, "session watch: project sync failed");
                }
            });
        }
    }

    /// Remember `unknown` as tried; `true` when any of it had not been tried
    /// within [`RETRY_AFTER`], i.e. a sync is worth asking for.
    fn note_unknown(&self, unknown: &[acp::SessionId]) -> bool {
        if unknown.is_empty() {
            return false;
        }
        let now = Instant::now();
        let mut tried = self.tried.lock();
        tried.retain(|_, at| now.duration_since(*at) < RETRY_AFTER);
        let mut fresh = false;
        for id in unknown {
            fresh |= tried.insert(id.to_string(), now).is_none();
        }
        fresh
    }
}

/// One debounced batch of filesystem events. Runs on the debouncer's own
/// thread, so the blocking directory scan is fine here.
fn on_batch(weak: &Weak<SessionWatcher>, cwd: &str, dir: &Path, in_parent: bool) {
    let Some(this) = weak.upgrade() else {
        return;
    };
    if !this.is_current(cwd) {
        return;
    }
    if in_parent {
        // Events in `~/.claude/projects` are every project's; only the
        // project's own folder appearing matters. Swapping drops this very
        // debouncer, which must not happen on its own thread, so it goes to a
        // blocking task.
        if !dir.is_dir() {
            return;
        }
        let cwd = cwd.to_owned();
        let dir = dir.to_path_buf();
        tauri::async_runtime::spawn_blocking(move || {
            this.install(&cwd, false);
            this.handle_batch(&cwd, &dir);
        });
        return;
    }
    this.handle_batch(cwd, dir);
}

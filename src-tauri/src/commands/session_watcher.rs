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
//!   the row to the top, and an archived row with new activity inside the
//!   sync window comes back to the sidebar (`touch_sessions`). A write Atlas's
//!   own turn explains is skipped: Atlas's Claude adapter writes the very
//!   same transcript, and touching on it would be a SQLite write and a full
//!   sidebar refetch per [`DEBOUNCE`] for every turn Atlas runs — the live
//!   feed already keeps that row current;
//! - **unknown** and new to us: one forced project sync, so the agent can list
//!   the new session into the store. Each id backs off ([`RETRY_FIRST`],
//!   doubling to [`RETRY_MAX`]), so a session no installed agent will ever
//!   list costs a handful of sweeps, not one a minute forever;
//! - a **provisional transcript alias** (an id first seen beside a session
//!   Atlas is mid-turn in, `AgentHost::claim_for_atlas_turn`) is settled by
//!   its writes before anything else (`AgentHost::review_aliases`): written
//!   outside its owner's turn, it is revoked and becomes an unknown session
//!   due a sync at once; written alone in a later owner turn, it is confirmed
//!   and persisted.
//!
//! Liveness (ATL-424): the sidebar's "running in a terminal" dot is a pure
//! function of the file times kept here, what Atlas's own turns have been
//! doing (`AgentHost::atlas_activity`), and the clock — so it also has to be
//! re-announced when the clock alone moves it. While any session is live one
//! ticker re-checks every [`TICK`] and emits `atlas:threads-changed` whenever
//! the live set changes; with nothing live there is no ticker. An Atlas turn
//! starting or ending flips liveness too, and is announced by the batch its
//! own transcript write produces.
//!
//! There is no `#[tauri::command]` here: `threads_sync_project` arms it, with
//! the project directory already canonical — Claude Code names the folder
//! after its physical `getcwd`.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use agent_client_protocol::schema::v1 as acp;
use atlas_agent_transcript::discovery::{claude_sessions_dir, scan_sessions};
use chrono::{DateTime, Utc};
use notify::RecursiveMode;
use notify_debouncer_full::new_debouncer;
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use super::agent_host::{explained_by_atlas, live_elsewhere, sync_unarchive_cutoff, AgentHost};
use super::agents::THREADS_CHANGED_EVENT;

/// A terminal session writes its transcript in bursts; this folds a burst into
/// one rescan while still landing a new session well inside the ~5s target.
const DEBOUNCE: Duration = Duration::from_millis(1500);

/// How often liveness is re-checked while any session is live. Against the
/// 90s window this clears a dot within about two minutes of the terminal going
/// quiet.
const TICK: Duration = Duration::from_secs(30);

/// How long an unknown session id counts as already tried, the first time.
/// Each retry that still finds no agent listing it doubles the wait.
const RETRY_FIRST: Duration = Duration::from_secs(60);

/// The longest an unknown id waits between sweeps. A forced sync asks every
/// agent the user has used, so an id none of them will list (another tool's
/// file that happens to look like a session) must decay to rare — but never
/// to never, since a just-installed agent may list it after all.
const RETRY_MAX: Duration = Duration::from_secs(30 * 60);

type Debouncer = notify_debouncer_full::Debouncer<
    notify::RecommendedWatcher,
    notify_debouncer_full::RecommendedCache,
>;

/// The armed project and its OS-level watch.
///
/// One lock for all three fields, and a generation rather than the cwd as the
/// identity of an arming. `install` runs on a blocking thread, and used to
/// check "still current?" and then store its debouncer under a second lock: an
/// `arm(B)` landing in that gap had B's watch stored first and then
/// overwritten by A's, leaving A watched while B was armed — and a repeated
/// `arm(B)` was a no-op, so it stayed that way. Every install, seed, batch and
/// disarm now carries the generation it was started for and acts only if that
/// is still the current one, checked under the lock it writes under.
#[derive(Default)]
struct Armed {
    /// The project armed for. Set before the (blocking) watch is installed so
    /// a second `arm` for the same cwd is a no-op.
    cwd: Option<String>,
    /// Bumped by every `arm` that changes the project.
    generation: u64,
    /// Keeping the debouncer alive keeps the OS-level watch active.
    debouncer: Option<Debouncer>,
}

impl Armed {
    /// Arm for `cwd`; the new generation, or `None` when already armed for it.
    fn arm(&mut self, cwd: &str) -> Option<u64> {
        if self.cwd.as_deref() == Some(cwd) {
            return None;
        }
        self.cwd = Some(cwd.to_owned());
        self.generation += 1;
        Some(self.generation)
    }

    fn is_current(&self, generation: u64) -> bool {
        self.cwd.is_some() && self.generation == generation
    }

    /// Keep `debouncer` if `generation` is still current; otherwise hand it
    /// back. Either way the caller drops what it gets outside the lock.
    fn install(&mut self, generation: u64, debouncer: Debouncer) -> Option<Debouncer> {
        if self.is_current(generation) {
            self.debouncer.replace(debouncer)
        } else {
            Some(debouncer)
        }
    }

    /// Forget the arming, so the next `arm` for the same cwd tries again —
    /// but only if no newer arming has replaced it.
    fn disarm(&mut self, generation: u64) {
        if self.generation == generation {
            self.cwd = None;
        }
    }
}

pub struct SessionWatcher {
    host: Arc<AgentHost>,
    app: AppHandle,
    /// The live set as last announced to the webview.
    announced_live: Mutex<HashSet<String>>,
    /// A liveness ticker is running. At most one.
    ticking: AtomicBool,
    /// What the watcher is armed for, and the watch itself, under one lock.
    armed: Mutex<Armed>,
    modified: Mutex<HashMap<String, DateTime<Utc>>>,
    tried: Mutex<UnknownBackoff>,
}

impl SessionWatcher {
    pub fn new(host: Arc<AgentHost>, app: AppHandle) -> Arc<Self> {
        Arc::new(Self {
            host,
            app,
            announced_live: Mutex::new(HashSet::new()),
            ticking: AtomicBool::new(false),
            armed: Mutex::new(Armed::default()),
            modified: Mutex::new(HashMap::new()),
            tried: Mutex::new(UnknownBackoff::default()),
        })
    }

    /// Watch this project's Claude directory, replacing any previous one. Same
    /// cwd again is a no-op.
    pub fn arm(self: &Arc<Self>, cwd: &str) {
        let Some(generation) = ({
            let mut armed = self.armed.lock();
            let generation = armed.arm(cwd);
            if generation.is_some() {
                self.modified.lock().clear();
            }
            generation
        }) else {
            return;
        };
        self.reconcile_liveness();
        let this = self.clone();
        let cwd = cwd.to_owned();
        // Creating a watcher does an initial scan on macOS, and the seeding
        // scan is file I/O: neither belongs on the async runtime's workers.
        tauri::async_runtime::spawn_blocking(move || this.install(generation, &cwd, true));
    }

    /// Last-seen modified time per session id for the armed project; the
    /// history commands read it to decide which rows are live elsewhere.
    pub fn last_modified(&self) -> HashMap<String, DateTime<Utc>> {
        self.modified.lock().clone()
    }

    /// Start watching for `cwd`, dropping whatever was watched before.
    /// `seed` records the sessions already on disk as seen; the swap from
    /// parent to directory passes `false` so a session that appeared in the
    /// meantime still counts as new.
    fn install(self: &Arc<Self>, generation: u64, cwd: &str, seed: bool) {
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
            self.armed.lock().disarm(generation);
            return;
        };

        if seed && !in_parent {
            let seen: HashMap<_, _> = scan_sessions(&dir)
                .into_iter()
                .map(|s| (s.session_id, s.modified))
                .collect();
            let current = {
                let armed = self.armed.lock();
                let current = armed.is_current(generation);
                if current {
                    *self.modified.lock() = seen;
                }
                current
            };
            if current {
                self.reconcile_liveness();
            }
        }

        let weak = Arc::downgrade(self);
        let cwd_for_cb = cwd.to_owned();
        let dir_for_cb = dir;
        let generation_for_cb = generation;
        let mut debouncer = match new_debouncer(
            DEBOUNCE,
            None,
            move |result: notify_debouncer_full::DebounceEventResult| match result {
                Ok(_events) => on_batch(
                    &weak,
                    generation_for_cb,
                    &cwd_for_cb,
                    &dir_for_cb,
                    in_parent,
                ),
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
                self.armed.lock().disarm(generation);
                return;
            }
        };
        if let Err(e) = debouncer.watch(&target, RecursiveMode::NonRecursive) {
            tracing::warn!("session watch: could not watch {}: {e}", target.display());
            self.armed.lock().disarm(generation);
            return;
        }
        // Whatever comes back — the replaced watch, or this one if a newer
        // arming won — is dropped here, outside the lock: dropping a debouncer
        // stops its thread, and that thread's callback takes this lock.
        let stale = self.armed.lock().install(generation, debouncer);
        drop(stale);
    }

    fn is_current(&self, generation: u64) -> bool {
        self.armed.lock().is_current(generation)
    }

    /// The sessions live elsewhere right now — the same rule `thread_row`
    /// applies, so what is announced is what the sidebar will read back.
    fn live_ids(&self) -> HashSet<String> {
        let now = Utc::now();
        let activity = self.host.atlas_activity();
        self.modified
            .lock()
            .iter()
            .filter(|(id, at)| live_elsewhere(Some(**at), activity.get(*id), now))
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Announce a change in the live set, and keep exactly one ticker running
    /// while anything is live. Called after every change to `modified` and by
    /// the ticker itself.
    fn reconcile_liveness(self: &Arc<Self>) {
        if !self.announce_live().is_empty() {
            self.ensure_ticker();
        }
    }

    fn ensure_ticker(self: &Arc<Self>) {
        if self
            .ticking
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let weak = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(TICK).await;
                let Some(this) = weak.upgrade() else {
                    return;
                };
                if this.announce_live().is_empty() {
                    this.ticking.store(false, Ordering::Release);
                    // A batch may have made something live between the check
                    // and the store; it saw `ticking` set and started nothing.
                    if this.live_ids().is_empty()
                        || this
                            .ticking
                            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                            .is_err()
                    {
                        return;
                    }
                }
            }
        });
    }

    /// Emit if the live set differs from the last announcement; answers the
    /// current live set.
    fn announce_live(&self) -> HashSet<String> {
        let live = self.live_ids();
        let changed = {
            let mut announced = self.announced_live.lock();
            if *announced == live {
                false
            } else {
                *announced = live.clone();
                true
            }
        };
        if changed {
            let _ = self.app.emit(THREADS_CHANGED_EVENT, ());
        }
        live
    }

    /// Rescan, refresh the last-seen map, and act on what moved.
    fn handle_batch(self: &Arc<Self>, generation: u64, cwd: &str, dir: &Path) {
        let sessions = scan_sessions(dir);
        let previous = {
            let armed = self.armed.lock();
            if !armed.is_current(generation) {
                return;
            }
            let fresh = sessions
                .iter()
                .map(|s| (s.session_id.clone(), s.modified))
                .collect();
            std::mem::replace(&mut *self.modified.lock(), fresh)
        };
        let written: HashMap<String, DateTime<Utc>> = sessions
            .iter()
            .filter(|s| {
                previous
                    .get(&s.session_id)
                    .is_none_or(|seen| s.modified > *seen)
            })
            .map(|s| (s.session_id.clone(), s.modified))
            .collect();
        // Settle provisional transcript aliases first: one revoked here is a
        // terminal session after all, and must be live (and unknown) in this
        // very batch, not the next.
        let revoked = self.host.review_aliases(&written);
        // Before the history lookups below, which can bail out: a session
        // turning live must be announced whether or not the store knows it.
        self.reconcile_liveness();
        let Some(history) = self.host.history() else {
            return;
        };
        let store = history.store();
        let known = store.known_session_ids();

        // A transcript appearing for the first time beside one Atlas is
        // mid-turn in is Atlas's own continuation (an adapter restarting its
        // private conversation under a fresh id), not a terminal session.
        // Claimed before the activity snapshot so it is already explained.
        let on_disk: HashSet<String> = sessions.iter().map(|s| s.session_id.clone()).collect();
        for session in &sessions {
            let first_seen = !previous.contains_key(&session.session_id);
            if first_seen && !known.contains(&acp::SessionId::new(session.session_id.as_str())) {
                self.host
                    .claim_for_atlas_turn(&session.session_id, &on_disk);
            }
        }
        let activity = self.host.atlas_activity();

        let mut touches = Vec::new();
        let mut unknown = Vec::new();
        for session in sessions {
            let moved = previous
                .get(&session.session_id)
                .is_none_or(|seen| session.modified > *seen);
            if !moved {
                continue;
            }
            // Atlas's own turn wrote this; the live feed has the row.
            if explained_by_atlas(session.modified, activity.get(&session.session_id)) {
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
            self.tried.lock().forget(touches.iter().map(|(id, _)| id));
            store.touch_sessions(&touches, Some(sync_unarchive_cutoff(Utc::now())));
        }
        if self.tried.lock().due(&unknown, &revoked, Instant::now()) {
            let host = self.host.clone();
            let cwd = cwd.to_owned();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = host.sync_project(&cwd, true).await {
                    tracing::warn!(error = %e.message, "session watch: project sync failed");
                }
            });
        }
    }
}

/// Per-id exponential backoff for sessions on disk that no agent has listed.
///
/// An id is due the first time it is seen; after that it is due again
/// [`RETRY_FIRST`] later, then twice that, up to [`RETRY_MAX`]. Agent-agnostic
/// by construction: it never asks *which* agent should list an id, only how
/// long ago the last sweep failed to find one that would (ADR-0002).
#[derive(Default)]
struct UnknownBackoff {
    /// id → (when it is next due, the wait that will follow that attempt).
    ids: HashMap<String, (Instant, Duration)>,
}

impl UnknownBackoff {
    /// Note `unknown` as seen at `now`; `true` when any of them is due, in
    /// which case every due id has its wait doubled.
    fn note(&mut self, unknown: &[acp::SessionId], now: Instant) -> bool {
        let mut due = false;
        for id in unknown {
            match self.ids.get_mut(id.0.as_ref()) {
                None => {
                    self.ids
                        .insert(id.to_string(), (now + RETRY_FIRST, RETRY_FIRST));
                    due = true;
                }
                Some((next, wait)) if now >= *next => {
                    *wait = (*wait * 2).min(RETRY_MAX);
                    *next = now + *wait;
                    due = true;
                }
                Some(_) => {}
            }
        }
        due
    }

    /// Whether this batch is worth a forced sync: any of `unknown` is due,
    /// or an alias was just `revoked`. A revoked alias is a session nobody
    /// has asked an agent about — it was Atlas's until a moment ago — so it
    /// is due at once, whatever its backoff says.
    fn due(&mut self, unknown: &[acp::SessionId], revoked: &[String], now: Instant) -> bool {
        for id in revoked {
            self.ids.remove(id);
        }
        let noted = self.note(unknown, now);
        noted || !revoked.is_empty()
    }

    /// The store knows these now; a later appearance starts from scratch.
    fn forget<'a>(&mut self, ids: impl IntoIterator<Item = &'a acp::SessionId>) {
        for id in ids {
            self.ids.remove(id.0.as_ref());
        }
    }
}

/// One debounced batch of filesystem events. Runs on the debouncer's own
/// thread, so the blocking directory scan is fine here.
fn on_batch(weak: &Weak<SessionWatcher>, generation: u64, cwd: &str, dir: &Path, in_parent: bool) {
    let Some(this) = weak.upgrade() else {
        return;
    };
    if !this.is_current(generation) {
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
            this.install(generation, &cwd, false);
            this.handle_batch(generation, &cwd, &dir);
        });
        return;
    }
    this.handle_batch(generation, cwd, dir);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The review finding: an install for project A that finished after
    /// `arm(B)` stored A's watch over B's. Every arming has its own
    /// generation, and only the current one may install or disarm.
    #[test]
    fn a_stale_arming_cannot_act_after_a_newer_one() {
        let mut armed = Armed::default();
        let a = armed.arm("/a").expect("first arm");
        let b = armed.arm("/b").expect("a different project re-arms");
        assert!(!armed.is_current(a), "A's install must not store its watch");
        assert!(armed.is_current(b));

        // A's failure path disarming must not disarm B.
        armed.disarm(a);
        assert!(armed.is_current(b));
        assert_eq!(armed.arm("/b"), None, "B is still armed: a no-op");

        // B's own failure does disarm, so the next arm of B retries.
        armed.disarm(b);
        assert!(!armed.is_current(b));
        let retry = armed.arm("/b").expect("re-arming after a failure retries");
        assert!(retry > b);
    }

    #[test]
    fn going_back_to_a_project_is_a_new_generation() {
        let mut armed = Armed::default();
        let a1 = armed.arm("/a").unwrap();
        armed.arm("/b").unwrap();
        let a2 = armed.arm("/a").unwrap();
        assert_ne!(a1, a2, "the first A arming's callbacks stay dead");
        assert!(!armed.is_current(a1));
        assert!(armed.is_current(a2));
    }

    fn ids(names: &[&str]) -> Vec<acp::SessionId> {
        names.iter().map(|n| acp::SessionId::new(*n)).collect()
    }

    /// The review finding: an id no agent ever lists re-triggered a sweep of
    /// every used agent each [`RETRY_FIRST`], forever.
    #[test]
    fn an_unlisted_id_backs_off_exponentially_to_the_cap() {
        let mut backoff = UnknownBackoff::default();
        let stray = ids(&["stray"]);
        let start = Instant::now();

        assert!(backoff.note(&stray, start), "first sight is due");
        assert!(!backoff.note(&stray, start + Duration::from_secs(59)));

        // Due at 60s; the next wait is 120s, then 240s.
        let mut at = start + RETRY_FIRST;
        assert!(backoff.note(&stray, at));
        assert!(!backoff.note(&stray, at + Duration::from_secs(119)));
        at += Duration::from_secs(120);
        assert!(backoff.note(&stray, at));
        assert!(!backoff.note(&stray, at + Duration::from_secs(239)));

        // Keep failing: the wait never exceeds the cap.
        for _ in 0..20 {
            at += RETRY_MAX;
            assert!(backoff.note(&stray, at));
        }
        assert!(!backoff.note(&stray, at + RETRY_MAX - Duration::from_secs(1)));
        assert!(backoff.note(&stray, at + RETRY_MAX));
    }

    #[test]
    fn one_new_id_is_due_even_while_another_backs_off() {
        let mut backoff = UnknownBackoff::default();
        let now = Instant::now();
        assert!(backoff.note(&ids(&["a"]), now));
        assert!(!backoff.note(&ids(&["a"]), now));
        assert!(backoff.note(&ids(&["a", "b"]), now));
    }

    /// A revoked alias is due a sync immediately, even if the id had been
    /// backing off as unknown.
    #[test]
    fn a_revoked_alias_is_due_a_sync_at_once() {
        let mut backoff = UnknownBackoff::default();
        let now = Instant::now();
        let terminal = ids(&["terminal"]);
        assert!(backoff.note(&terminal, now));
        assert!(!backoff.note(&terminal, now), "backing off");
        assert!(backoff.due(&terminal, &["terminal".to_owned()], now));
        assert!(!backoff.due(&[], &[], now), "nothing revoked, nothing due");
    }

    #[test]
    fn a_forgotten_id_starts_over() {
        let mut backoff = UnknownBackoff::default();
        let now = Instant::now();
        let a = ids(&["a"]);
        assert!(backoff.note(&a, now));
        backoff.forget(&a);
        assert!(backoff.note(&a, now), "known, then gone: due again at once");
    }
}

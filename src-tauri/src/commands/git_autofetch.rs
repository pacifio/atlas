//! Background `git fetch` for the project each window has open, so the Pull
//! badge, branch ahead/behind and the graph reflect the remote without the
//! user pressing Fetch.
//!
//! Three triggers, one throttle:
//!   - **activated** — a window opens a project (`git_autofetch_set_active`)
//!   - **focused**   — a window regains focus (`on_window_focused`, lib.rs)
//!   - **tick**      — every [`INTERVAL`], checked on a [`TICK`] timer
//!
//! Activation and focus refetch at most once per [`MIN_GAP`]; the tick waits
//! the full [`INTERVAL`]. A failure (offline, auth, timeout) switches the
//! project to exponential backoff for every trigger until a fetch — automatic
//! or manual — succeeds. Only the projects windows currently show are
//! fetched; a backgrounded project waits until it is shown again.
//!
//! The fetch is deliberately quiet:
//!   - no `--progress` and no op id, so no `atlas:git:op` events — the
//!     progress bar and Fetch spinner stay for fetches the user asked for;
//!   - no synthetic `atlas:git-changed`. The git watcher already reports a
//!     fetch that moved a ref, and one that moved nothing writes no watched
//!     file (`--no-write-fetch-head`), so an idle repository costs no UI
//!     refresh at all;
//!   - every credential path is made non-interactive (see [`fetch`]) and the
//!     run is bounded by [`FETCH_TIMEOUT`], so an unreachable remote or a
//!     missing credential is a silent backoff, never a prompt or a hung
//!     thread.
//!
//! Manual remote ops (`git_ops::run_remote_op`) hold [`GitAutoFetchState::hold`]
//! for their duration, so an automatic fetch never races a user's pull or
//! push for the same ref locks; a manual fetch or pull that succeeds also
//! counts as a fetch here, resetting the timer and any backoff.
//!
//! Each attempt's outcome goes out as [`AUTOFETCH_EVENT`] for the Fetch
//! button's "Fetched 3m ago" hint.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use atlas_git::{GitCommand, GitErrorPayload};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, Window};

/// Outcome of each fetch attempt (automatic, or a manual one that succeeded).
pub const AUTOFETCH_EVENT: &str = "atlas:git-autofetch";

/// How often a shown project is fetched while nothing else prompts it.
const INTERVAL: Duration = Duration::from_secs(5 * 60);
/// Floor between fetches prompted by activation or focus — alt-tabbing
/// through windows shouldn't fetch on every switch.
const MIN_GAP: Duration = Duration::from_secs(60);
/// Ceiling on the failure backoff (5 → 10 → 20 → 30 min).
const MAX_BACKOFF: Duration = Duration::from_secs(30 * 60);
/// Timer granularity. A due fetch runs at most this late.
const TICK: Duration = Duration::from_secs(30);
/// Hard limit on one background fetch; see `GitCommand::timeout`.
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Trigger {
    Activated,
    Focused,
    Tick,
}

#[derive(Debug, Default, Clone)]
struct Record {
    last_attempt: Option<SystemTime>,
    /// Consecutive failed attempts; 0 after any success.
    failures: u32,
    last_success: Option<SystemTime>,
    last_error: Option<String>,
}

/// Wait after `failures` consecutive failures: [`INTERVAL`] doubled per extra
/// failure, capped at [`MAX_BACKOFF`].
fn backoff(failures: u32) -> Duration {
    let doublings = failures.saturating_sub(1).min(16);
    INTERVAL.saturating_mul(1 << doublings).min(MAX_BACKOFF)
}

/// Whether `trigger` may start a fetch now. Wall-clock time rather than
/// `Instant`, which stops while a Mac sleeps — an overnight sleep would
/// otherwise count as no time at all. A clock that moved backwards counts as
/// due rather than stalling fetches until it catches up.
fn is_due(rec: &Record, trigger: Trigger, now: SystemTime) -> bool {
    let Some(last) = rec.last_attempt else {
        return true;
    };
    let Ok(since) = now.duration_since(last) else {
        return true;
    };
    let wait = if rec.failures > 0 {
        backoff(rec.failures)
    } else if trigger == Trigger::Tick {
        INTERVAL
    } else {
        MIN_GAP
    };
    since >= wait
}

fn epoch_ms(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// Wire shape of [`AUTOFETCH_EVENT`] and of `git_autofetch_set_active`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoFetchStatus {
    pub project: String,
    /// Epoch ms of the last successful fetch this session, if any.
    pub last_fetched_at: Option<i64>,
    /// Why the most recent automatic attempt failed; `None` once one succeeds.
    pub last_error: Option<String>,
    /// How many commits the current branch is behind its upstream, measured
    /// right after a successful automatic fetch. `None` everywhere else (a
    /// failure, a manual fetch, the `set_active` snapshot, or no upstream).
    pub behind: Option<u32>,
    /// How many commits the current branch is ahead of its upstream, measured
    /// with `behind`. Both non-zero means the branch has diverged.
    pub ahead: Option<u32>,
    /// The upstream branch's head commit at that same moment — lets the
    /// frontend tell "still behind the same commit" from a new remote head.
    pub remote_head: Option<String>,
}

#[derive(Default)]
struct Inner {
    /// Window label → the project that window shows. Only these are fetched.
    active: HashMap<String, PathBuf>,
    records: HashMap<PathBuf, Record>,
    /// Remote ops in flight per repository, automatic and manual. A count,
    /// not a flag: a manual op can start while an automatic one runs.
    busy: HashMap<PathBuf, u32>,
}

impl Inner {
    fn status(&self, path: &Path) -> AutoFetchStatus {
        let rec = self.records.get(path).cloned().unwrap_or_default();
        AutoFetchStatus {
            project: path.to_string_lossy().into_owned(),
            last_fetched_at: rec.last_success.map(epoch_ms),
            last_error: rec.last_error,
            behind: None,
            ahead: None,
            remote_head: None,
        }
    }
}

#[derive(Default)]
pub struct GitAutoFetchState {
    inner: Arc<Mutex<Inner>>,
}

/// Marks a repository busy with a remote op until dropped.
pub struct BusyGuard {
    inner: Arc<Mutex<Inner>>,
    path: PathBuf,
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        let mut inner = self.inner.lock();
        if let Some(n) = inner.busy.get_mut(&self.path) {
            *n -= 1;
            if *n == 0 {
                inner.busy.remove(&self.path);
            }
        }
    }
}

impl GitAutoFetchState {
    pub fn new() -> Self {
        Self::default()
    }

    fn guard(&self, inner: &mut Inner, path: &Path) -> BusyGuard {
        *inner.busy.entry(path.to_path_buf()).or_insert(0) += 1;
        BusyGuard {
            inner: self.inner.clone(),
            path: path.to_path_buf(),
        }
    }

    /// Mark `path` busy for a manual remote op — unconditionally, since the
    /// user asked for it; automatic fetches skip the repository meanwhile.
    pub fn hold(&self, path: &Path) -> BusyGuard {
        let mut inner = self.inner.lock();
        self.guard(&mut inner, path)
    }

    /// Claim an automatic fetch of `path`: `None` when one isn't due or any
    /// remote op is already running there. Stamps the attempt under the same
    /// lock, so two triggers landing together start one fetch.
    fn try_claim(&self, path: &Path, trigger: Trigger, now: SystemTime) -> Option<BusyGuard> {
        let mut inner = self.inner.lock();
        if inner.busy.contains_key(path) {
            return None;
        }
        let rec = inner.records.entry(path.to_path_buf()).or_default();
        if !is_due(rec, trigger, now) {
            return None;
        }
        rec.last_attempt = Some(now);
        Some(self.guard(&mut inner, path))
    }

    /// A fetch of `path` (automatic or manual) succeeded at `now`.
    pub fn record_success(&self, path: &Path, now: SystemTime) -> AutoFetchStatus {
        let mut inner = self.inner.lock();
        let rec = inner.records.entry(path.to_path_buf()).or_default();
        rec.last_attempt = Some(now);
        rec.last_success = Some(now);
        rec.failures = 0;
        rec.last_error = None;
        inner.status(path)
    }

    fn record_failure(&self, path: &Path, error: String) -> AutoFetchStatus {
        let mut inner = self.inner.lock();
        let rec = inner.records.entry(path.to_path_buf()).or_default();
        rec.failures = rec.failures.saturating_add(1);
        rec.last_error = Some(error);
        inner.status(path)
    }

    fn active_projects(&self) -> Vec<PathBuf> {
        let inner = self.inner.lock();
        let mut out: Vec<PathBuf> = inner.active.values().cloned().collect();
        out.sort();
        out.dedup();
        out
    }

    fn active_for(&self, label: &str) -> Option<PathBuf> {
        self.inner.lock().active.get(label).cloned()
    }

    /// Forget a closed window's project.
    pub fn drop_window(&self, label: &str) {
        self.inner.lock().active.remove(label);
    }
}

fn enabled(app: &AppHandle) -> bool {
    app.try_state::<crate::state::AtlasConfigHandle>()
        .is_some_and(|config| config.lock().effective().git_auto_fetch)
}

/// Every credential path made non-interactive. `GIT_TERMINAL_PROMPT=0` (set
/// by the executor for all git) only covers git's own tty prompt; a
/// background fetch must also never open Git Credential Manager's sign-in
/// window or an SSH askpass dialog every few minutes. With these, a missing
/// credential is an ordinary `AuthFailed` and the project backs off.
fn fetch(path: &Path) -> Result<(), GitErrorPayload> {
    GitCommand::new(
        path,
        &[
            "-c",
            "credential.interactive=never",
            "fetch",
            "--all",
            "--no-write-fetch-head",
            "--quiet",
        ],
    )
    .env("GCM_INTERACTIVE", "never")
    .env("SSH_ASKPASS_REQUIRE", "never")
    .timeout(FETCH_TIMEOUT)
    .run()
    .map(|_| ())
}

/// Where the current branch stands against its upstream after a fetch.
struct UpstreamPosition {
    ahead: u32,
    behind: u32,
    head: String,
}

/// Parse `rev-list --left-right --count HEAD...@{upstream}`: "<ahead>\t<behind>".
fn parse_ahead_behind(out: &str) -> Option<(u32, u32)> {
    let mut parts = out.split_whitespace();
    let ahead = parts.next()?.parse().ok()?;
    let behind = parts.next()?.parse().ok()?;
    Some((ahead, behind))
}

/// Ahead/behind counts and head of the current branch's upstream, or `None`
/// when the branch has no upstream (git exits 128) or the repo is unreadable.
fn upstream_position(path: &Path) -> Option<UpstreamPosition> {
    let read = |args: &[&str]| {
        GitCommand::new(path, args)
            .read_only()
            .success_codes(&[0, 128])
            .run()
            .ok()
            .filter(|o| o.exit_code == 0)
            .map(|o| o.stdout.trim().to_string())
    };
    let (ahead, behind) = parse_ahead_behind(&read(&[
        "rev-list",
        "--left-right",
        "--count",
        "HEAD...@{upstream}",
    ])?)?;
    let head = read(&["rev-parse", "@{upstream}"])?;
    Some(UpstreamPosition {
        ahead,
        behind,
        head,
    })
}

/// Fetch `path` in the background if `trigger` makes it due. Returns at once.
fn maybe_fetch(app: &AppHandle, path: PathBuf, trigger: Trigger) {
    if !enabled(app) || !path.join(".git").exists() {
        return;
    }
    let state = app.state::<GitAutoFetchState>();
    let Some(guard) = state.try_claim(&path, trigger, SystemTime::now()) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let fetch_path = path.clone();
        let result = tokio::task::spawn_blocking(move || {
            fetch(&fetch_path).map(|()| upstream_position(&fetch_path))
        })
        .await;
        drop(guard);
        let state = app.state::<GitAutoFetchState>();
        let status = match result {
            Ok(Ok(position)) => {
                let mut status = state.record_success(&path, SystemTime::now());
                if let Some(position) = position {
                    status.behind = Some(position.behind);
                    status.ahead = Some(position.ahead);
                    status.remote_head = Some(position.head);
                }
                status
            }
            Ok(Err(e)) => {
                tracing::debug!(
                    "git auto-fetch failed for {}: {}",
                    path.display(),
                    e.message
                );
                state.record_failure(&path, e.message)
            }
            Err(e) => state.record_failure(&path, e.to_string()),
        };
        let _ = app.emit(AUTOFETCH_EVENT, status);
    });
}

/// Start the interval timer. Once, from `setup`.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(TICK);
        loop {
            ticker.tick().await;
            for path in app.state::<GitAutoFetchState>().active_projects() {
                maybe_fetch(&app, path, Trigger::Tick);
            }
        }
    });
}

/// A window regained focus: fetch its project if the throttle allows.
pub fn on_window_focused(app: &AppHandle, label: &str) {
    if let Some(path) = app.state::<GitAutoFetchState>().active_for(label) {
        maybe_fetch(app, path, Trigger::Focused);
    }
}

/// The calling window now shows `project_path` (`None`: no project). Fetches
/// it if due, and returns what is known so the Fetch hint can render at once.
#[tauri::command]
pub fn git_autofetch_set_active(
    project_path: Option<String>,
    window: Window,
    state: State<'_, GitAutoFetchState>,
) -> Option<AutoFetchStatus> {
    let label = window.label().to_string();
    let Some(project_path) = project_path else {
        state.drop_window(&label);
        return None;
    };
    let path = PathBuf::from(project_path);
    let status = {
        let mut inner = state.inner.lock();
        inner.active.insert(label, path.clone());
        inner.status(&path)
    };
    maybe_fetch(window.app_handle(), path, Trigger::Activated);
    Some(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_000_000 + secs)
    }

    fn rec(last: u64, failures: u32) -> Record {
        Record {
            last_attempt: Some(at(last)),
            failures,
            ..Record::default()
        }
    }

    #[test]
    fn a_never_fetched_project_is_due_for_every_trigger() {
        for t in [Trigger::Activated, Trigger::Focused, Trigger::Tick] {
            assert!(is_due(&Record::default(), t, at(0)));
        }
    }

    #[test]
    fn focus_and_activation_wait_the_min_gap_the_tick_waits_the_interval() {
        let r = rec(0, 0);
        assert!(!is_due(&r, Trigger::Focused, at(59)));
        assert!(is_due(&r, Trigger::Focused, at(60)));
        assert!(is_due(&r, Trigger::Activated, at(60)));
        assert!(!is_due(&r, Trigger::Tick, at(299)));
        assert!(is_due(&r, Trigger::Tick, at(300)));
    }

    #[test]
    fn failures_back_off_for_every_trigger_up_to_the_cap() {
        assert_eq!(backoff(1), Duration::from_secs(5 * 60));
        assert_eq!(backoff(2), Duration::from_secs(10 * 60));
        assert_eq!(backoff(3), Duration::from_secs(20 * 60));
        assert_eq!(backoff(4), MAX_BACKOFF);
        assert_eq!(backoff(u32::MAX), MAX_BACKOFF);
        let r = rec(0, 2);
        assert!(!is_due(&r, Trigger::Focused, at(599)));
        assert!(is_due(&r, Trigger::Focused, at(600)));
    }

    #[test]
    fn a_clock_moved_backwards_counts_as_due() {
        assert!(is_due(&rec(100, 0), Trigger::Tick, at(50)));
    }

    #[test]
    fn a_busy_repository_is_never_claimed_and_claims_stamp_the_attempt() {
        let state = GitAutoFetchState::new();
        let path = Path::new("/repo");
        let manual = state.hold(path);
        assert!(state.try_claim(path, Trigger::Activated, at(0)).is_none());
        drop(manual);

        let claimed = state.try_claim(path, Trigger::Activated, at(0));
        assert!(claimed.is_some());
        // Still running, and just attempted: a second trigger starts nothing.
        assert!(state.try_claim(path, Trigger::Focused, at(0)).is_none());
        drop(claimed);
        assert!(state.try_claim(path, Trigger::Focused, at(30)).is_none());
        assert!(state.try_claim(path, Trigger::Focused, at(60)).is_some());
    }

    #[test]
    fn success_clears_the_backoff_and_the_error() {
        let state = GitAutoFetchState::new();
        let path = Path::new("/repo");
        state.record_failure(path, "offline".into());
        state.record_failure(path, "offline".into());
        let failed = state.inner.lock().status(path);
        assert_eq!(failed.last_error.as_deref(), Some("offline"));
        assert_eq!(failed.last_fetched_at, None);

        let ok = state.record_success(path, at(10));
        assert_eq!(ok.last_error, None);
        assert_eq!(ok.last_fetched_at, Some(epoch_ms(at(10))));
        assert_eq!(state.inner.lock().records[path].failures, 0);
    }

    #[test]
    fn parses_left_right_counts() {
        assert_eq!(parse_ahead_behind("3\t1\n"), Some((3, 1)));
        assert_eq!(parse_ahead_behind("0\t0"), Some((0, 0)));
        assert_eq!(parse_ahead_behind("3"), None);
        assert_eq!(parse_ahead_behind(""), None);
        assert_eq!(parse_ahead_behind("x\t1"), None);
    }
}

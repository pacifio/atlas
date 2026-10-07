//! OS power assertion management to prevent idle system sleep while agents run.
//!
//! # Architecture
//!
//! Managed automatically in the Rust backend via a session set state machine:
//!
//! - Maintains the set of sessions whose status is `Running`, fed by
//!   `SessionDelta::Status` alone (see [`KeepAwakeManager::observe`]) and
//!   emptied of a session when it ends (`SessionLifecycle::session_ended`,
//!   which every ending path runs through: drop, kill, sign-out, exit, quit).
//! - Holds an OS power assertion while the set is non-empty AND the setting
//!   (`keep_awake_while_running`) is enabled.
//! - Releases the assertion when the set empties, when an agent enters `Waiting`
//!   (paused for user approval), or when the setting is toggled off.
//! - Wraps the assertion in a guard that releases on `Drop`; at process exit
//!   the OS frees it with the process either way.
//! - Narrow idle system sleep only (`PreventUserIdleSystemSleep` on macOS,
//!   `what="idle"` on Linux). The display is still permitted to sleep.
//! - Windows has no implementation: the manager never tries to acquire there.

use atlas_agent_wire::{SessionDelta, SessionStatus};
use parking_lot::Mutex;
use std::any::Any;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

/// Whether this platform has a power assertion to take at all.
const SUPPORTED: bool = cfg!(any(target_os = "macos", target_os = "linux"));

#[cfg(target_os = "macos")]
mod imp {
    use objc2_foundation::NSString;
    use std::ffi::c_void;

    type IOPMAssertionID = u32;
    type IOReturn = i32;
    /// `NSString` is toll-free bridged to `CFString`, so the pointer is a valid
    /// `CFStringRef` — no CoreFoundation crate needed.
    type CFStringRef = *const c_void;

    const K_IOPM_ASSERTION_LEVEL_ON: u32 = 255;
    const K_IOR_RETURN_SUCCESS: i32 = 0;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            assertion_level: u32,
            assertion_name: CFStringRef,
            assertion_id: *mut IOPMAssertionID,
        ) -> IOReturn;

        fn IOPMAssertionRelease(assertion_id: IOPMAssertionID) -> IOReturn;
    }

    #[derive(Debug)]
    pub struct PlatformGuard {
        id: IOPMAssertionID,
    }

    impl PlatformGuard {
        pub fn acquire() -> Option<Self> {
            let assertion_type = NSString::from_str("PreventUserIdleSystemSleep");
            let assertion_name = NSString::from_str("Atlas agent is working");
            let mut id: IOPMAssertionID = 0;
            // SAFETY: both strings outlive the call, and IOKit copies what it keeps.
            let ret = unsafe {
                IOPMAssertionCreateWithName(
                    (&*assertion_type as *const NSString).cast(),
                    K_IOPM_ASSERTION_LEVEL_ON,
                    (&*assertion_name as *const NSString).cast(),
                    &mut id,
                )
            };
            if ret == K_IOR_RETURN_SUCCESS {
                tracing::info!(target: "atlas::keep_awake", "Acquired macOS idle sleep assertion (id={id})");
                Some(Self { id })
            } else {
                tracing::warn!(target: "atlas::keep_awake", "Failed to create macOS power assertion: {ret}");
                None
            }
        }
    }

    impl Drop for PlatformGuard {
        fn drop(&mut self) {
            let ret = unsafe { IOPMAssertionRelease(self.id) };
            if ret == K_IOR_RETURN_SUCCESS {
                tracing::info!(target: "atlas::keep_awake", "Released macOS idle sleep assertion (id={})", self.id);
            } else {
                tracing::warn!(target: "atlas::keep_awake", "Failed to release macOS power assertion {}: {ret}", self.id);
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use zbus::zvariant::OwnedFd;
    use zbus::{Connection, Proxy};

    pub struct PlatformGuard {
        _fd: OwnedFd,
        _conn: Connection,
    }

    impl PlatformGuard {
        pub fn acquire() -> Option<Self> {
            let result = zbus::block_on(async {
                let conn = Connection::system().await?;
                let proxy = Proxy::new(
                    &conn,
                    "org.freedesktop.login1",
                    "/org/freedesktop/login1",
                    "org.freedesktop.login1.Manager",
                )
                .await?;
                let fd: OwnedFd = proxy
                    .call("Inhibit", &("idle", "Atlas", "Agent is working", "block"))
                    .await?;
                Ok::<_, zbus::Error>((conn, fd))
            });

            match result {
                Ok((conn, fd)) => {
                    tracing::info!(target: "atlas::keep_awake", "Acquired Linux logind idle inhibitor");
                    Some(Self {
                        _fd: fd,
                        _conn: conn,
                    })
                }
                Err(e) => {
                    tracing::warn!(target: "atlas::keep_awake", "Failed to acquire logind inhibitor: {e}");
                    None
                }
            }
        }
    }

    impl Drop for PlatformGuard {
        fn drop(&mut self) {
            tracing::info!(target: "atlas::keep_awake", "Released Linux logind idle inhibitor");
        }
    }
}

/// A held power assertion, released when dropped. Opaque so tests can hand the
/// manager a stand-in without touching the OS.
type Guard = Box<dyn Any + Send>;
type Acquire = Arc<dyn Fn() -> Option<Guard> + Send + Sync>;

/// Delay before the first retry of a failed acquisition; doubles per attempt.
const RETRY_INITIAL: Duration = Duration::from_millis(500);
/// Retries continue at this interval for as long as a session is running.
const RETRY_MAX: Duration = Duration::from_secs(30);

struct KeepAwakeState {
    enabled: bool,
    /// Running sessions, each with the `turn_seq` of the turn that set it
    /// running, so a stale terminal status from a superseded turn is ignored.
    running_sessions: HashMap<String, u64>,
    guard: Option<Guard>,
    acquiring: bool,
}

impl KeepAwakeState {
    fn wanted(&self) -> bool {
        self.enabled && !self.running_sessions.is_empty()
    }

    /// The guard to drop once the lock is released, if it's no longer wanted.
    fn take_unwanted(&mut self) -> Option<Guard> {
        if self.wanted() {
            None
        } else {
            self.guard.take()
        }
    }
}

/// Central state machine managing the OS power assertion across active sessions.
pub struct KeepAwakeManager {
    inner: Arc<Mutex<KeepAwakeState>>,
    acquire: Acquire,
    retry_initial: Duration,
}

impl KeepAwakeManager {
    pub fn new(enabled: bool) -> Self {
        Self::with_acquire(enabled, platform_acquire(), RETRY_INITIAL)
    }

    fn with_acquire(enabled: bool, acquire: Acquire, retry_initial: Duration) -> Self {
        Self {
            inner: Arc::new(Mutex::new(KeepAwakeState {
                enabled,
                running_sessions: HashMap::new(),
                guard: None,
                acquiring: false,
            })),
            acquire,
            retry_initial,
        }
    }

    /// Start acquiring on a background thread if a guard is wanted and none is
    /// held or being acquired. The OS call can block (D-Bus on Linux), and this
    /// runs on the delta-sink path.
    fn maybe_acquire(&self, state: &mut KeepAwakeState) {
        if !SUPPORTED && !cfg!(test) {
            return;
        }
        if !state.wanted() || state.guard.is_some() || state.acquiring {
            return;
        }
        state.acquiring = true;
        let inner = Arc::clone(&self.inner);
        let acquire = Arc::clone(&self.acquire);
        let mut delay = self.retry_initial;
        let spawned = std::thread::Builder::new()
            .name("atlas-keep-awake-acquire".into())
            .spawn(move || loop {
                let guard = acquire();
                let mut state = inner.lock();
                if !state.wanted() {
                    state.acquiring = false;
                    drop(state);
                    drop(guard);
                    return;
                }
                if guard.is_some() {
                    state.guard = guard;
                    state.acquiring = false;
                    return;
                }
                // Still wanted and still failing: keep trying for as long as
                // a session runs, backing off to `RETRY_MAX`.
                drop(state);
                std::thread::sleep(delay);
                delay = (delay * 2).min(RETRY_MAX);
            });
        if let Err(e) = spawned {
            tracing::warn!(target: "atlas::keep_awake", "Failed to spawn keep-awake acquisition thread: {e}");
            state.acquiring = false;
        }
    }

    /// Update the enabled state (e.g. from user settings change).
    pub fn set_enabled(&self, enabled: bool) {
        let mut state = self.inner.lock();
        state.enabled = enabled;
        self.maybe_acquire(&mut state);
        let released = state.take_unwanted();
        drop(state);
        drop(released);
    }

    /// Follow a session's status. Only `Status` matters: `Running` holds the
    /// session, any other status releases it — unless that status belongs to
    /// a turn older than the one now running.
    pub fn observe(&self, session_id: &str, delta: &SessionDelta) {
        let SessionDelta::Status { status, turn_seq } = delta else {
            return;
        };
        let mut state = self.inner.lock();
        if *status == SessionStatus::Running {
            let seq = state
                .running_sessions
                .entry(session_id.to_string())
                .or_default();
            *seq = (*seq).max(*turn_seq);
            self.maybe_acquire(&mut state);
            return;
        }
        let stale = *turn_seq != 0
            && state
                .running_sessions
                .get(session_id)
                .is_some_and(|running| *turn_seq < *running);
        if stale {
            return;
        }
        state.running_sessions.remove(session_id);
        let released = state.take_unwanted();
        drop(state);
        drop(released);
    }

    /// The session ended (dropped, its agent killed or exited, the app
    /// quitting): it can no longer be running.
    pub fn session_ended(&self, session_id: &str) {
        let mut state = self.inner.lock();
        state.running_sessions.remove(session_id);
        let released = state.take_unwanted();
        drop(state);
        drop(released);
    }

    #[cfg(test)]
    fn running_count(&self) -> usize {
        self.inner.lock().running_sessions.len()
    }

    #[cfg(test)]
    fn has_guard(&self) -> bool {
        self.inner.lock().guard.is_some()
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn platform_acquire() -> Acquire {
    Arc::new(|| imp::PlatformGuard::acquire().map(|g| Box::new(g) as Guard))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn platform_acquire() -> Acquire {
    Arc::new(|| None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    /// A manager whose acquisition fails `failures` times, then succeeds.
    /// Returns the live-guard counter: a guard increments it, dropping one
    /// decrements it, so it shows whether a guard leaked.
    fn manager(enabled: bool, failures: usize) -> (KeepAwakeManager, Arc<AtomicUsize>) {
        struct Counted(Arc<AtomicUsize>);
        impl Drop for Counted {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::SeqCst);
            }
        }
        let live = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let live_for_acquire = live.clone();
        let acquire: Acquire = Arc::new(move || {
            if calls.fetch_add(1, Ordering::SeqCst) < failures {
                return None;
            }
            live_for_acquire.fetch_add(1, Ordering::SeqCst);
            Some(Box::new(Counted(live_for_acquire.clone())) as Guard)
        });
        let m = KeepAwakeManager::with_acquire(enabled, acquire, Duration::from_millis(1));
        (m, live)
    }

    fn eventually(what: &str, check: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !check() {
            assert!(Instant::now() < deadline, "timed out waiting for: {what}");
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    /// Settle: no acquisition in flight.
    fn idle(m: &KeepAwakeManager) {
        eventually("acquisition to settle", || !m.inner.lock().acquiring);
    }

    fn status(status: SessionStatus, turn_seq: u64) -> SessionDelta {
        SessionDelta::Status { status, turn_seq }
    }

    #[test]
    fn disabled_never_acquires() {
        let (m, live) = manager(false, 0);
        m.observe("s1", &status(SessionStatus::Running, 1));
        assert_eq!(m.running_count(), 1);
        idle(&m);
        assert!(!m.has_guard());
        assert_eq!(live.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn toggling_the_setting_acquires_and_releases() {
        let (m, live) = manager(false, 0);
        m.observe("s1", &status(SessionStatus::Running, 1));
        m.set_enabled(true);
        eventually("guard after enabling", || m.has_guard());
        m.set_enabled(false);
        assert!(!m.has_guard());
        idle(&m);
        assert_eq!(live.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn held_until_the_last_session_stops() {
        let (m, live) = manager(true, 0);
        m.observe("s1", &status(SessionStatus::Running, 1));
        m.observe("s2", &status(SessionStatus::Running, 1));
        eventually("guard", || m.has_guard());
        m.observe("s1", &status(SessionStatus::Idle, 1));
        assert!(m.has_guard());
        m.observe("s2", &status(SessionStatus::Error, 1));
        assert!(!m.has_guard());
        assert_eq!(live.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn waiting_for_approval_releases_and_resuming_reacquires() {
        let (m, _) = manager(true, 0);
        m.observe("s1", &status(SessionStatus::Running, 1));
        eventually("guard", || m.has_guard());
        m.observe("s1", &status(SessionStatus::Waiting, 1));
        assert!(!m.has_guard());
        m.observe("s1", &status(SessionStatus::Running, 1));
        eventually("guard after resuming", || m.has_guard());
    }

    #[test]
    fn a_stale_terminal_status_does_not_release_a_newer_turn() {
        let (m, _) = manager(true, 0);
        m.observe("s1", &status(SessionStatus::Running, 2));
        eventually("guard", || m.has_guard());
        m.observe("s1", &status(SessionStatus::Idle, 1));
        assert!(m.has_guard(), "turn 1's idle must not end turn 2");
        m.observe("s1", &status(SessionStatus::Idle, 2));
        assert!(!m.has_guard());
    }

    #[test]
    fn turn_events_other_than_status_are_ignored() {
        let (m, _) = manager(true, 0);
        m.observe("s1", &status(SessionStatus::Running, 1));
        eventually("guard", || m.has_guard());
        m.observe(
            "s1",
            &SessionDelta::TurnFinished {
                stop_reason: "end_turn".into(),
                turn_seq: 0,
            },
        );
        assert!(m.has_guard());
    }

    #[test]
    fn a_session_ending_without_a_status_releases() {
        let (m, live) = manager(true, 0);
        m.observe("s1", &status(SessionStatus::Running, 1));
        eventually("guard", || m.has_guard());
        m.session_ended("s1");
        assert!(!m.has_guard());
        assert_eq!(live.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn keeps_retrying_while_a_session_runs() {
        let (m, _) = manager(true, 10);
        m.observe("s1", &status(SessionStatus::Running, 1));
        eventually("guard after 10 failures", || m.has_guard());
    }

    #[test]
    fn stops_retrying_and_drops_a_late_guard_once_nothing_runs() {
        let (m, live) = manager(true, usize::MAX);
        m.observe("s1", &status(SessionStatus::Running, 1));
        m.session_ended("s1");
        idle(&m);
        assert!(!m.has_guard());
        assert_eq!(live.load(Ordering::SeqCst), 0);
    }
}

//! OS power assertion management to prevent idle system sleep while agents run.
//!
//! # Architecture
//!
//! Managed automatically in the Rust backend via a session set state machine:
//!
//! - Maintains a set of active `Running` session IDs.
//! - Holds an OS power assertion while the set is non-empty AND the setting
//!   (`keep_awake_while_running`) is enabled.
//! - Releases the assertion when the set empties, when an agent enters `Waiting`
//!   (paused for user approval), or when the setting is toggled off.
//! - Wraps the assertion in a guard that releases on `Drop` so unexpected
//!   unwinds or application shutdown clean up reliably.
//! - Narrow idle system sleep only (`PreventUserIdleSystemSleep` on macOS,
//!   `what="idle"` on Linux). The display is still permitted to sleep.

use parking_lot::Mutex;
use std::collections::HashSet;
use std::sync::Arc;

#[cfg(target_os = "macos")]
mod imp {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;

    type IOPMAssertionID = u32;
    type IOReturn = i32;

    const K_IOPM_ASSERTION_LEVEL_ON: u32 = 255;
    const K_IOR_RETURN_SUCCESS: i32 = 0;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: core_foundation::string::CFStringRef,
            assertion_level: u32,
            assertion_name: core_foundation::string::CFStringRef,
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
            let assertion_type = CFString::new("PreventUserIdleSystemSleep");
            let assertion_name = CFString::new("Atlas agent is working");
            let mut id: IOPMAssertionID = 0;
            let ret = unsafe {
                IOPMAssertionCreateWithName(
                    assertion_type.as_concrete_TypeRef(),
                    K_IOPM_ASSERTION_LEVEL_ON,
                    assertion_name.as_concrete_TypeRef(),
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
    use std::time::Duration;
    use zbus::zvariant::OwnedFd;
    use zbus::{Connection, Proxy};

    pub struct PlatformGuard {
        _fd: OwnedFd,
        _conn: Connection,
    }

    impl PlatformGuard {
        pub fn acquire() -> Option<Self> {
            let (tx, rx) = std::sync::mpsc::channel();
            let spawned = std::thread::Builder::new()
                .name("atlas-keep-awake-acquire".into())
                .spawn(move || {
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
                    let _ = tx.send(result);
                });

            if let Err(e) = spawned {
                tracing::warn!(target: "atlas::keep_awake", "Failed to spawn thread for logind inhibitor: {e}");
                return None;
            }

            match rx.recv_timeout(Duration::from_secs(1)) {
                Ok(Ok((conn, fd))) => {
                    tracing::info!(target: "atlas::keep_awake", "Acquired Linux logind idle inhibitor");
                    Some(Self {
                        _fd: fd,
                        _conn: conn,
                    })
                }
                Ok(Err(e)) => {
                    tracing::warn!(target: "atlas::keep_awake", "Failed to acquire logind inhibitor: {e}");
                    None
                }
                Err(e) => {
                    tracing::warn!(target: "atlas::keep_awake", "Timed out waiting for logind inhibitor: {e}");
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

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod imp {
    pub struct PlatformGuard;

    impl PlatformGuard {
        pub fn acquire() -> Option<Self> {
            None
        }
    }
}

/// RAII power assertion guard that releases the assertion on drop.
pub struct KeepAwakeGuard {
    #[cfg(not(test))]
    _platform: imp::PlatformGuard,
    #[cfg(test)]
    _dummy: bool,
}

impl KeepAwakeGuard {
    #[cfg(not(test))]
    pub fn acquire() -> Option<Self> {
        imp::PlatformGuard::acquire().map(|platform| Self {
            _platform: platform,
        })
    }

    #[cfg(test)]
    pub fn acquire() -> Option<Self> {
        Some(Self { _dummy: true })
    }
}

struct KeepAwakeState {
    enabled: bool,
    running_sessions: HashSet<String>,
    guard: Option<KeepAwakeGuard>,
    acquiring: bool,
}

/// Central state machine managing the OS power assertion across active sessions.
pub struct KeepAwakeManager {
    inner: Arc<Mutex<KeepAwakeState>>,
}

impl KeepAwakeManager {
    pub fn new(enabled: bool) -> Self {
        Self {
            inner: Arc::new(Mutex::new(KeepAwakeState {
                enabled,
                running_sessions: HashSet::new(),
                guard: None,
                acquiring: false,
            })),
        }
    }

    fn maybe_acquire(&self, state: &mut KeepAwakeState) {
        if state.enabled
            && !state.running_sessions.is_empty()
            && state.guard.is_none()
            && !state.acquiring
        {
            state.acquiring = true;

            #[cfg(not(test))]
            {
                let inner = Arc::clone(&self.inner);
                let spawned = std::thread::Builder::new()
                    .name("atlas-keep-awake-acquire".into())
                    .spawn(move || {
                        let guard = KeepAwakeGuard::acquire();
                        let mut state = inner.lock();
                        state.acquiring = false;
                        if state.enabled
                            && !state.running_sessions.is_empty()
                            && state.guard.is_none()
                        {
                            state.guard = guard;
                        }
                    });

                if let Err(e) = spawned {
                    tracing::warn!(target: "atlas::keep_awake", "Failed to spawn keep-awake acquisition thread: {e}");
                    state.acquiring = false;
                }
            }

            #[cfg(test)]
            {
                let guard = KeepAwakeGuard::acquire();
                state.acquiring = false;
                if state.enabled && !state.running_sessions.is_empty() && state.guard.is_none() {
                    state.guard = guard;
                }
            }
        }
    }

    /// Update the enabled state (e.g. from user settings change).
    pub fn set_enabled(&self, enabled: bool) {
        let mut state = self.inner.lock();
        if state.enabled == enabled {
            return;
        }
        state.enabled = enabled;
        if !enabled {
            state.guard = None;
            return;
        }
        self.maybe_acquire(&mut state);
    }

    /// Mark a session as actively running.
    pub fn mark_running(&self, session_id: &str) {
        let mut state = self.inner.lock();
        state.running_sessions.insert(session_id.to_string());
        self.maybe_acquire(&mut state);
    }

    /// Mark a session as not running (e.g. idle, waiting for user input, or failed).
    pub fn mark_not_running(&self, session_id: &str) {
        let mut state = self.inner.lock();
        state.running_sessions.remove(session_id);
        if state.running_sessions.is_empty() {
            state.guard = None;
        }
    }

    /// Remove a session completely (e.g. when closed or dropped).
    pub fn forget_session(&self, session_id: &str) {
        let mut state = self.inner.lock();
        state.running_sessions.remove(session_id);
        if state.running_sessions.is_empty() {
            state.guard = None;
        }
    }

    /// Whether keep-awake is currently enabled by settings.
    pub fn is_enabled(&self) -> bool {
        self.inner.lock().enabled
    }

    /// Number of sessions currently recorded as running.
    pub fn running_count(&self) -> usize {
        self.inner.lock().running_sessions.len()
    }

    /// Whether a power assertion guard is currently held.
    pub fn has_guard(&self) -> bool {
        self.inner.lock().guard.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_keep_awake_disabled_by_default() {
        let manager = KeepAwakeManager::new(false);
        assert!(!manager.is_enabled());
        assert_eq!(manager.running_count(), 0);
        assert!(!manager.has_guard());

        manager.mark_running("session-1");
        assert_eq!(manager.running_count(), 1);
        assert!(!manager.has_guard());

        manager.mark_not_running("session-1");
        assert_eq!(manager.running_count(), 0);
    }

    #[test]
    fn test_keep_awake_enable_toggle() {
        let manager = KeepAwakeManager::new(false);
        manager.mark_running("session-1");
        assert_eq!(manager.running_count(), 1);
        assert!(!manager.has_guard());

        manager.set_enabled(true);
        assert!(manager.is_enabled());
        assert!(manager.has_guard());

        manager.set_enabled(false);
        assert!(!manager.is_enabled());
        assert!(!manager.has_guard());
    }

    #[test]
    fn test_keep_awake_multiple_sessions_and_forget() {
        let manager = KeepAwakeManager::new(true);
        manager.mark_running("session-1");
        manager.mark_running("session-2");
        assert_eq!(manager.running_count(), 2);
        assert!(manager.has_guard());

        manager.mark_not_running("session-1");
        assert_eq!(manager.running_count(), 1);
        assert!(manager.has_guard());

        manager.forget_session("session-2");
        assert_eq!(manager.running_count(), 0);
        assert!(!manager.has_guard());
    }

    #[test]
    fn test_keep_awake_waiting_status() {
        let manager = KeepAwakeManager::new(true);
        manager.mark_running("session-1");
        assert_eq!(manager.running_count(), 1);
        assert!(manager.has_guard());

        // Entering waiting (approval needed) releases the session from running set
        manager.mark_not_running("session-1");
        assert_eq!(manager.running_count(), 0);
        assert!(!manager.has_guard());

        // Resuming after approval marks it running again
        manager.mark_running("session-1");
        assert_eq!(manager.running_count(), 1);
        assert!(manager.has_guard());
    }
}

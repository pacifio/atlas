//! Per-session state on a live connection — ported from
//! `zed-ref/crates/agent_servers/src/acp.rs:492-640`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::AcpThread;

/// A session that exists on the agent and has a thread on our side.
pub struct AcpSession {
    /// Weak so a thread the UI has dropped does not keep living because the
    /// connection still lists its session.
    pub thread: Weak<Mutex<AcpThread>>,
    /// Fired by `cancel`, awaited by the in-flight `prompt`. See [`CancelSignal`].
    ///
    /// This replaced a `suppress_abort_err: bool` that `cancel` set and the
    /// next `prompt` result consumed. Some agents answer a cancelled turn with
    /// an internal error reading "This operation was aborted" rather than a
    /// clean `Cancelled` stop reason, and that must not surface as an error
    /// toast for something the user deliberately did — but one bool for a
    /// whole session is answered by whichever turn resolves first, which is
    /// not necessarily the turn it was set for.
    pub cancel_signal: CancelSignal,
    pub session_modes: Option<Arc<Mutex<acp::SessionModeState>>>,
    pub config_options: Option<ConfigOptions>,
    /// How many handles are open on this session. `close_session` only reaches
    /// the wire when this hits zero.
    pub ref_count: usize,
}

/// The local half of cancelling a turn.
///
/// `cancel` is a *notification* on the wire — there is no response and no
/// obligation on the agent to act. An agent that is wedged (deadlocked, blocked
/// on a network call, stopped) ignores it, and nothing else in the stack has a
/// clock, so the prompt future stayed pending forever and the chat could only
/// be recovered by quitting Atlas.
///
/// This is the clock. `prompt` waits on it and gives the agent a bounded grace
/// period to answer its own cancellation before resolving the turn locally.
///
/// A generation counter rather than a `Notify` on purpose: a receiver takes its
/// snapshot before the request is sent, so a cancel that lands in the gap
/// between sending and awaiting is still seen rather than missed.
#[derive(Clone)]
pub struct CancelSignal {
    tx: Arc<tokio::sync::watch::Sender<u64>>,
}

impl Default for CancelSignal {
    fn default() -> Self {
        Self::new()
    }
}

impl CancelSignal {
    pub fn new() -> Self {
        Self {
            tx: Arc::new(tokio::sync::watch::channel(0).0),
        }
    }

    /// Idempotent by construction: the composer leaves its stop button live
    /// while a stop is pending, so a user watching nothing happen presses it
    /// again. Each press is another generation, and every waiter already
    /// waiting is woken by the first.
    pub fn fire(&self) {
        self.tx.send_modify(|generation| *generation += 1);
    }

    /// Resolves on the next [`fire`](Self::fire) *after* this call. Call it
    /// before sending the request the cancel would apply to.
    pub fn waiter(&self) -> CancelWaiter {
        CancelWaiter {
            rx: self.tx.subscribe(),
        }
    }
}

pub struct CancelWaiter {
    rx: tokio::sync::watch::Receiver<u64>,
}

impl CancelWaiter {
    /// A handle that answers "has a cancel fired since this waiter was taken",
    /// without consuming the waiter. Holds a receiver, never the sender, so it
    /// cannot keep a closed session's signal alive.
    pub fn probe(&self) -> CancelProbe {
        CancelProbe {
            rx: self.rx.clone(),
        }
    }

    /// Waits for a cancel. Never resolves if none comes — a legitimate turn
    /// runs for as long as it runs, which is why this is not a request timeout.
    pub async fn cancelled(mut self) {
        // A dropped sender means the session was removed from the registry,
        // which happens on close or teardown. Nobody is going to answer that
        // turn, so it counts: parking here instead would leak the request
        // future, and its `Arc<dyn AgentConnection>` with it, for the life of
        // the process.
        let _ = self.rx.changed().await;
    }
}

/// Whether this turn's own cancel has fired.
///
/// The rule it encodes: a turn suppresses an "operation was aborted" error
/// only if a cancel was fired for its session *while it was running*. A
/// session-wide bool could not express that — it was set by one turn and
/// consumed by whichever resolved first, so a cancel could be spent on a turn
/// it was never meant for, and a turn started after a cancel could inherit a
/// suppression it never asked for.
pub struct CancelProbe {
    rx: tokio::sync::watch::Receiver<u64>,
}

impl CancelProbe {
    pub fn fired(&self) -> bool {
        // `Err` is a dropped sender: the session is gone, which is not a
        // cancel anyone asked for, so an error on this turn is real.
        self.rx.has_changed().unwrap_or(false)
    }
}

/// A session whose `session/load` or `session/new` RPC is still in flight.
///
/// Its own ref count is the source of truth while the load runs, because the
/// `sessions` entry is pre-registered before the RPC resolves and would
/// otherwise be double-counted.
pub struct PendingAcpSession {
    pub ref_count: usize,
}

#[derive(Clone)]
pub struct ConfigOptions {
    pub config_options: Arc<Mutex<Vec<acp::SessionConfigOption>>>,
    tx: Arc<tokio::sync::watch::Sender<()>>,
    rx: tokio::sync::watch::Receiver<()>,
}

impl ConfigOptions {
    pub fn new(config_options: Arc<Mutex<Vec<acp::SessionConfigOption>>>) -> Self {
        let (tx, rx) = tokio::sync::watch::channel(());
        Self {
            config_options,
            tx: Arc::new(tx),
            rx,
        }
    }

    pub fn notify(&self) {
        let _ = self.tx.send(());
    }

    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<()> {
        self.rx.clone()
    }
}

/// What the agent gets told about where the session lives.
///
/// Ported from `SessionDirectories` (`acp.rs:1440-1492`). The split matters:
/// `cwd` is the one directory the agent runs in, and everything else is an
/// explicitly granted extra root. An agent that does not advertise support for
/// additional directories gets only the first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionDirectories {
    pub cwd: PathBuf,
    pub additional_directories: Vec<PathBuf>,
}

impl SessionDirectories {
    pub fn from_work_dirs(
        work_dirs: &[PathBuf],
        supports_additional_directories: bool,
    ) -> anyhow::Result<Self> {
        let mut dirs = work_dirs.iter();
        let cwd = dirs
            .next()
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("a session needs at least one working directory"))?;

        let additional_directories = if supports_additional_directories {
            dirs.cloned().collect()
        } else {
            Vec::new()
        };

        Ok(Self {
            cwd,
            additional_directories,
        })
    }

    pub fn into_new_session_request(
        self,
        mcp_servers: Vec<acp::McpServer>,
    ) -> acp::NewSessionRequest {
        let mut request = acp::NewSessionRequest::new(self.cwd);
        request.meta = crate::session_mcp::preapproval_meta(&mcp_servers);
        request.mcp_servers = mcp_servers;
        if !self.additional_directories.is_empty() {
            request.additional_directories = self.additional_directories;
        }
        request
    }
}

/// The session table shared between the connection and the inbound handlers.
///
/// Zed reaches this through a foreground dispatch queue because its threads are
/// GPUI entities and therefore `!Send`; see the note in [`crate`]. Here the
/// handlers run directly on tokio workers, so the table is a plain mutex.
#[derive(Default)]
pub struct SessionRegistry {
    sessions: Mutex<HashMap<acp::SessionId, AcpSession>>,
    pending: Mutex<HashMap<acp::SessionId, PendingAcpSession>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn thread(&self, session_id: &acp::SessionId) -> Result<Arc<Mutex<AcpThread>>, acp::Error> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session_id)
            .and_then(|session| session.thread.upgrade())
            .ok_or_else(|| {
                acp::Error::internal_error().data(format!("unknown session: {session_id}"))
            })
    }

    pub fn all_threads(&self) -> Vec<Arc<Mutex<AcpThread>>> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .filter_map(|session| session.thread.upgrade())
            .collect()
    }

    pub fn with_session<R>(
        &self,
        session_id: &acp::SessionId,
        f: impl FnOnce(&mut AcpSession) -> R,
    ) -> Option<R> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get_mut(session_id)
            .map(f)
    }

    pub fn insert(&self, session_id: acp::SessionId, session: AcpSession) {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(session_id, session);
    }

    pub fn remove(&self, session_id: &acp::SessionId) -> Option<AcpSession> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id)
    }

    pub fn contains(&self, session_id: &acp::SessionId) -> bool {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(session_id)
    }

    /// `Some(new_count)` when the session is known, after decrementing.
    pub fn release(&self, session_id: &acp::SessionId) -> Option<usize> {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let session = sessions.get_mut(session_id)?;
        session.ref_count = session.ref_count.saturating_sub(1);
        let remaining = session.ref_count;
        if remaining == 0 {
            sessions.remove(session_id);
        }
        Some(remaining)
    }

    /// Adds a handle to an already-open session, if there is one.
    pub fn acquire(&self, session_id: &acp::SessionId) -> Option<Arc<Mutex<AcpThread>>> {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let session = sessions.get_mut(session_id)?;
        let thread = session.thread.upgrade()?;
        session.ref_count += 1;
        Some(thread)
    }

    pub fn pending_acquire(&self, session_id: &acp::SessionId) -> bool {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match pending.get_mut(session_id) {
            Some(entry) => {
                entry.ref_count += 1;
                true
            }
            None => false,
        }
    }

    pub fn pending_begin(&self, session_id: acp::SessionId) {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(session_id, PendingAcpSession { ref_count: 1 });
    }

    pub fn pending_take(&self, session_id: &acp::SessionId) -> Option<usize> {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id)
            .map(|pending| pending.ref_count)
    }

    /// `Some(new_count)` when a load is in flight, after decrementing.
    pub fn pending_release(&self, session_id: &acp::SessionId) -> Option<usize> {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let entry = pending.get_mut(session_id)?;
        entry.ref_count = entry.ref_count.saturating_sub(1);
        let remaining = entry.ref_count;
        if remaining == 0 {
            pending.remove(session_id);
        }
        Some(remaining)
    }
}

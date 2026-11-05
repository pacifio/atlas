//! The manager: who is connected, and which sessions are open on them.
//!
//! It owns both the connection table and session ownership, because Atlas has
//! no per-agent view to hold the latter.
//!
//! It links the three lower crates: sessions come from
//! `atlas-acp-thread`, connections from `atlas-agent-servers`, and installed
//! agents from `atlas-agent-store`.
//!
//! # The three behaviours worth knowing
//!
//! - **One connect attempt per agent.** A second `request_connection` while the
//!   first is still connecting joins it instead of starting a second process;
//!   that is what the shared connect future is for. The check and the insert
//!   happen under one `entries` guard, because they are one decision — split,
//!   two concurrent callers each started a process (ATL-226).
//! - **A failed connection does not stick.** The entry is set to `Error` (so a
//!   waiter sees why) *and* removed from the table, so the next request
//!   reconnects rather than replaying the old failure forever.
//! - **A version bump drops the connection.** When the store reports the agent
//!   moved forward, the entry goes; the running process is on the old binary and
//!   the next request starts the new one.
//!
//! Every path that evicts an entry also forgets that agent's sessions and stops
//! any connect still in flight. A session pins the connection, so one left
//! behind keeps a child process alive that nothing can reach (ATL-227); and an
//! attempt nobody stops finishes its download, spawns its process and completes
//! its handshake for an agent the user already killed (ATL-228).
//!
//! # Concurrency model
//!
//! Entries are `Arc<Mutex<_>>` compared with `Arc::ptr_eq`, the connect is a
//! `Shared` future, and notifications go over a broadcast channel.
//!
//! This runs on multi-threaded tokio, so nothing is serialised for free: a
//! single-threaded design makes check-then-insert one uninterruptible step, but
//! here that guarantee has to be built explicitly (hence the single `entries`
//! guard above). Any new logic should be asked the same question: what was it
//! leaning on the runtime for?

pub mod catalog;
pub mod manager;

pub use catalog::AgentCatalog;
pub use manager::{
    Agent, AgentConnectedState, AgentConnectionEntry, AgentConnectionStatus, AgentManager,
    AgentManagerEvent, ConnectHandle, Deadlines, ResumeMode, ResumedSession, SessionHandle,
    CONNECT_DEADLINE, RESTART_STALE_AFTER,
};

//! The manager: who is connected, and which sessions are open on them.
//!
//! Ported from Zed's `AgentConnectionStore`
//! (`zed-ref/crates/agent_ui/src/agent_connection_store.rs`) with the session
//! ownership Zed spreads across `ConversationView` folded in, because Atlas has
//! no per-agent view to hold it.
//!
//! This is the first thing to link all three ported crates: sessions come from
//! `atlas-acp-thread`, connections from `atlas-agent-servers`, and installed
//! agents from `atlas-agent-store`.
//!
//! # The three behaviours worth knowing
//!
//! - **One connect attempt per agent.** A second `request_connection` while the
//!   first is still connecting joins it instead of starting a second process;
//!   that is what the shared connect future is for.
//! - **A failed connection does not stick.** The entry is set to `Error` (so a
//!   waiter sees why) *and* removed from the table, so the next request
//!   reconnects rather than replaying the old failure forever.
//! - **A version bump drops the connection.** When the store reports the agent
//!   moved forward, the entry goes; the running process is on the old binary and
//!   the next request starts the new one.
//!
//! # Not ported
//!
//! GPUI. Zed's entries are `Entity<AgentConnectionEntry>` compared by identity,
//! its connect is a `Task`, and its notifications are `cx.emit`. Here those are
//! `Arc<Mutex<_>>` compared with `Arc::ptr_eq`, a `Shared` future, and a
//! broadcast channel. The mechanism is unchanged; only the runtime is.

pub mod catalog;
pub mod manager;

pub use catalog::AgentCatalog;
pub use manager::{
    Agent, AgentConnectedState, AgentConnectionEntry, AgentConnectionStatus, AgentManager,
    AgentManagerEvent, ResumeMode, ResumedSession, SessionHandle,
};

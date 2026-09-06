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
//! # Not ported
//!
//! GPUI. Zed's entries are `Entity<AgentConnectionEntry>` compared by identity,
//! its connect is a `Task`, and its notifications are `cx.emit`. Here those are
//! `Arc<Mutex<_>>` compared with `Arc::ptr_eq`, a `Shared` future, and a
//! broadcast channel.
//!
//! That substitution is not free, and this file used to claim it was: "the
//! mechanism is unchanged; only the runtime is". It is the other way round.
//! Zed's store is `Rc`-based and cannot leave the GPUI main thread, so its
//! check-then-insert is one uninterruptible borrow and its correctness came
//! from the runtime it ran on. Ported onto multi-threaded tokio with the same
//! shape, the guarantee stopped holding. Anything else moved across from
//! Zed's GPUI-side code deserves the same question: what was the original
//! leaning on that did not come with it?

pub mod catalog;
pub mod manager;

pub use catalog::AgentCatalog;
pub use manager::{
    Agent, AgentConnectedState, AgentConnectionEntry, AgentConnectionStatus, AgentManager,
    AgentManagerEvent, ConnectHandle, ResumeMode, ResumedSession, SessionHandle,
};

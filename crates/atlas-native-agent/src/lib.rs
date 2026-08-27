//! Cersei — Atlas's in-process agent — on the ported `AgentConnection` seam.
//!
//! This is Atlas's answer to Zed's `NativeAgentServer` / `NativeAgentConnection`
//! (`zed-ref/crates/agent/src/native_agent_server.rs`): the native agent
//! occupies the same slot an external ACP agent does, so the manager, the
//! thread model, and eventually the UI treat it identically. Everything
//! specific to it — reasoning effort, tool-output compression, its own model
//! list — hangs off native-only sub-traits, which is Zed's pattern too
//! (research §D12-5).
//!
//! # Why this is a separate crate from `atlas-cersei`
//!
//! It should not be, and eventually will not be. The split existed because
//! `atlas-cersei` had to stay linkable from the old ACP stack while that stack
//! was still shipping: the old one was on `agent-client-protocol` 1.3 and this
//! seam is on 2.0, and those could not share a Cargo graph — the protocol crate
//! pins its schema crate exactly (`=1.4.0` / `=1.5.0`), so a single resolution
//! containing both was impossible. Keeping the runtime protocol-free and
//! putting *this* protocol's adapter in its own crate is what let one runtime
//! serve both stacks during the port.
//!
//! **That constraint is history.** The old stack is deleted, every consumer
//! pins `=2.0.0`, and the repo is a single cargo workspace (issue #38). This
//! crate could fold into `atlas-cersei` — but it will not: it is the
//! `AgentConnection` seam the app plugs into, and the Codex port keeps it
//! while replacing the engine behind it (ADR-0003).
//!
//! # What the native agent does not implement, and why
//!
//! - **`AgentSessionTruncate`.** Rewinding to a user message needs the runtime
//!   to map a client message id onto a history index; it stores neither. Adding
//!   that is a change to the runtime's persistence, not an adapter concern.
//! - **`auth_methods` / `authenticate`.** The native agent authenticates with
//!   BYOK keys from Atlas's settings, not with an ACP auth method. It advertises
//!   none, which is what makes the sign-in flow skip it.
//! - **Elicitations.** The runtime never asks the user anything mid-turn except
//!   for tool permission, which has its own path.

pub mod connection;
pub mod server;
pub mod sink;

pub use connection::{
    AgentSessionCompression, AgentSessionEffort, CerseiConnection, NativeSessionEvent,
};
pub use server::{CerseiAgentServer, CERSEI_AGENT_ID};

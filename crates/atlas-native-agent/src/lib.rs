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
//! It should not be, and eventually will not be. `atlas-cersei` holds the
//! runtime and must stay linkable from the old stack until that stack is
//! deleted (port plan, stage 5). The old stack is on `agent-client-protocol`
//! 1.3 and this seam is on 2.0, and those cannot share a Cargo graph: the
//! protocol crate pins its schema crate exactly (`=1.4.0` / `=1.5.0`), so a
//! single resolution containing both is impossible. Keeping the runtime
//! protocol-free and putting *this* protocol's adapter in its own crate is what
//! lets one Cersei serve both stacks during the port. When `atlas-acp` and
//! the old stack went, this crate could fold into `atlas-cersei`.
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

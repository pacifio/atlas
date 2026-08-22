//! The frozen session-delta wire, shared by both ACP stacks.
//!
//! `docs/agents/delta-wire-contract.md` is the authority on these shapes; this
//! crate is that document in code. Nothing here names a protocol version, which
//! is the whole point — see [`types`] for the reason.

pub mod delta;
pub mod types;

pub use delta::{DeltaSink, Emitter, SessionDelta, SessionDeltaEnvelope};
pub use types::{
    extract_content_blocks, Message, MessageMode, MessageRole, PlanEntry, SessionStatus, ToolCall,
    ToolCallStatus, ToolContentBlock, Usage,
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Identifies one spawned agent.
///
/// Defined here rather than in either stack's crate because it is a routing key
/// on [`SessionDeltaEnvelope`], so both stacks have to name it. `atlas-acp`
/// re-exports it, which keeps it a single type across the whole app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AgentId(pub Uuid);

impl AgentId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for AgentId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for AgentId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

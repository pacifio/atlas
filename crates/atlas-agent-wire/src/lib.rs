//! The session-delta wire: additive-only. See [`types`] for the rules.
//!
//! `tests/contract.rs` (Rust) and `tests/wire-shape-contract.test.ts` (TS) are
//! the authority on these shapes. Nothing here names a protocol version, which
//! is the whole point — see [`types`] for the reason.

pub mod delta;
pub mod error;
pub mod types;

pub use delta::{DeltaSink, Emitter, SessionDelta, SessionDeltaEnvelope};
pub use error::{classify_message, ErrorClass};
pub use types::{
    extract_content_blocks, Message, MessageImage, MessageMode, MessageRole, Origin, PlanEntry,
    QueuedPrompt, RateLimitWindow, SessionStatus, Subagent, SubagentStatus, ToolCall,
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

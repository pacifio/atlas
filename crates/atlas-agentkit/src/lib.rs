//! atlas-agentkit — the protocol-agnostic core of the Atlas agent subsystem.
//!
//! This crate owns the seam behind which the native (in-process Cersei) agent
//! and every ACP subprocess agent look identical:
//!
//! - [`AgentConnection`] — one live agent connection. A turn is driven through
//!   `prompt`; optional features (model selection, session modes, effort,
//!   compression, auth) are exposed as `Option<Arc<dyn …>>` capability
//!   sub-traits rather than scattered booleans, so a caller queries a
//!   capability once and either has it or doesn't.
//! - [`TurnId`] / [`RunningTurn`] — the monotonic turn identity the single-owner
//!   session actor uses to drop work from a superseded turn (`is_same_turn`).
//!
//! The crate depends only on `atlas-acp` (identifiers + error type); it does NOT
//! depend on `atlas-agents`, so both the ACP and native agent crates can
//! implement `AgentConnection` without a dependency cycle.

mod connection;
mod turn;

pub use connection::{
    AgentConnection, AuthFlow, CompressionCtl, EffortControl, ModelSelector, SessionConfigOptions,
    SessionModes,
};
pub use turn::{RunningTurn, TurnId};

//! The native agent's protocol-free event contract.
//!
//! The native runtime used to speak `atlas_acp`'s `AcpEvent` directly, which
//! put `agent-client-protocol` 1.3 in this crate's dependency graph. That is
//! now a hard blocker: `agent-client-protocol` pins its schema crate exactly
//! (1.3 → `=1.4.0`, 2.0 → `=1.5.0`), so **no single Cargo graph can contain
//! both protocol versions**. A crate that speaks 1.3 can never be linked by the
//! ported stack, which is on 2.0.
//!
//! So the runtime speaks neither. It emits [`NativeEvent`], and each consumer
//! renders it in its own protocol version:
//!
//! - `atlas-agents` (the old stack) turns it back into `atlas_acp::AcpEvent`.
//! - `atlas-native-agent` (the ported stack) applies it to an
//!   `atlas_acp_thread::AcpThread`.
//!
//! Session updates travel as `serde_json::Value` because that is what the
//! runtime already built — the previous code assembled the JSON by hand and
//! deserialized it into a typed `SessionUpdate` as its last step. That last
//! step simply moved to the consumers, which is why the wire shapes are
//! unchanged.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Identifies one spawned native agent.
///
/// Same shape as the id the old stack keys agents by (`atlas_acp::AgentId`), so
/// the adapter converts by moving the `Uuid` across.
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

/// Identifies one session on a native agent.
///
/// Serializes as a bare string, which is what both protocol versions' own
/// `SessionId` does, so a round-trip through either is lossless.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(pub Arc<str>);

impl SessionId {
    pub fn new(id: impl Into<Arc<str>>) -> Self {
        Self(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl From<String> for SessionId {
    fn from(id: String) -> Self {
        Self(id.into())
    }
}

impl From<&str> for SessionId {
    fn from(id: &str) -> Self {
        Self(id.into())
    }
}

/// What [`crate::CerseiRuntime::spawn`] hands back.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub agent_id: AgentId,
    pub spec_id: String,
    pub display_name: String,
}

/// What [`crate::CerseiRuntime::new_session`] hands back.
///
/// `modes` / `models` stay JSON: they are rendered by whichever protocol
/// version the caller speaks, and the runtime has no opinion about either.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewSessionInfo {
    pub session_id: SessionId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<serde_json::Value>,
}

/// How a user answered a permission prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionDecision {
    Selected { option_id: String },
    Cancelled,
}

/// The three options the native agent offers on every permission prompt.
///
/// A neutral triple rather than the protocol's `PermissionOptionKind`, for the
/// same reason as everything else here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionOptionKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionOptionSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: PermissionOptionKind,
}

/// The tool call a permission prompt is about.
#[derive(Debug, Clone, PartialEq)]
pub struct PermissionToolCall {
    pub id: String,
    pub title: String,
    /// One of the protocol's `ToolKind` tokens (`read` / `edit` / `execute` /
    /// `fetch` / `other`), as a string so this crate names no protocol type.
    pub kind: &'static str,
    pub raw_input: serde_json::Value,
}

/// One event the native turn loop emits.
///
/// The variants are the ones the runtime actually produces; a consumer that
/// needs the full ACP event surface (disconnects, elicitations) gets those from
/// its own layer, not from here — the native agent is in-process and never
/// disconnects or elicits.
#[derive(Debug, Clone)]
pub enum NativeEvent {
    /// A `session/update`-shaped payload, in the JSON both protocol versions
    /// deserialize.
    SessionUpdate {
        session_id: SessionId,
        update: serde_json::Value,
    },
    /// The agent wants the user to authorize a tool call. The turn blocks until
    /// the host answers with [`crate::CerseiRuntime::respond_permission`].
    PermissionRequest {
        request_id: Uuid,
        session_id: SessionId,
        tool_call: PermissionToolCall,
        options: Vec<PermissionOptionSpec>,
    },
    /// Cumulative token usage + estimated cost for the session.
    Usage {
        session_id: SessionId,
        input_tokens: u64,
        output_tokens: u64,
        /// Cumulative estimated cost in USD.
        cost: Option<f64>,
    },
    /// Context compaction started (`active = true`) or finished (`false`).
    Compaction { session_id: SessionId, active: bool },
    /// Approx tokens saved by RTK tool-output compression this turn.
    CompressionSaved { session_id: SessionId, saved_tokens: u64 },
    /// A transient model-call failure is being retried after a backoff.
    Retry {
        session_id: SessionId,
        attempt: u32,
        max_attempts: u32,
        delay_ms: u64,
        last_error: String,
    },
}

/// Where the runtime sends its events.
///
/// `turn` is the producing turn's identity — the epoch returned by
/// [`crate::CerseiRuntime::mark_turn_started`]. `None` means turn-agnostic
/// traffic. A host that serializes turns drops stamped events whose stamp does
/// not match the live turn, so a cancelled turn's stragglers cannot contaminate
/// the next one.
pub trait NativeEventSink: Send + Sync + 'static {
    fn emit(&self, agent_id: AgentId, event: NativeEvent, turn: Option<u64>);
}

pub type Result<T> = std::result::Result<T, Error>;

/// What the runtime's fallible calls fail with.
///
/// A subset of the old `atlas_acp::AcpError`: the variants that were about a
/// spawned process (`DriverDown`, `Timeout`, `InvalidCommand`, `Protocol`)
/// cannot happen in-process and are not carried over.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("unknown agent id")]
    UnknownAgent,
    #[error("unknown session id")]
    UnknownSession,
    #[error("permission request {0} not pending")]
    UnknownPermissionRequest(Uuid),
    #[error("{0}")]
    Other(String),
}

impl Error {
    pub fn other(message: impl Into<String>) -> Self {
        Self::Other(message.into())
    }
}

//! atlas-acp — ACP client plumbing for the Atlas Tauri host.
//!
//! Implements the `Client` role of the Agent Client Protocol against one or
//! more spawned agent processes (canonical `@agentclientprotocol/claude-agent-acp`,
//! `claude-code-acp-rs`, or any other ACP-compatible agent).
//!
//! The crate is Tauri-independent: it exposes an [`EventSink`] trait that the
//! Tauri host implements to fan events out as window events.

pub mod driver;
pub mod error;
pub mod events;
pub mod model_sniff;
pub mod registry;
pub mod schema;
pub mod spawn;

pub use driver::AuthMethodWire;
pub use error::{AcpError, ErrorClass, Result, classify_message};
pub use events::{AcpEvent, EventSink};
pub use registry::{
    AUTO_MANAGED_BUILTIN_IDS, AgentId, AgentInfo, AgentRegistry, AgentSpec, ImageAttachment,
    PermissionDecision, SpecSource, builtin_login_args,
};
pub use schema::NewSessionInfo;
pub use spawn::{managed_node_bin, register_managed_node_bin, sanitize_host_env};

/// Login-shell program resolution, re-exported for the dynamic registry
/// (`atlas-registry`) which pre-resolves programs when it must emit a JSON
/// stdio spec (env-carrying commands bypass `resolve_command`).
pub use spawn::resolve_program_abs as resolve_program;

// Re-export schema types the host needs (so it doesn't have to take a direct
// dep on `agent-client-protocol-schema`).
pub use agent_client_protocol::schema::v1::{SessionId, StopReason};

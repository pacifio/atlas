//! atlas-acp — ACP client plumbing for the Atlas Tauri host.
//!
//! Implements the `Client` role of the Agent Client Protocol against one or
//! more spawned agent processes (canonical `@agentclientprotocol/claude-agent-acp`,
//! `claude-code-acp-rs`, or any other ACP-compatible agent).
//!
//! The crate is Tauri-independent: it exposes an [`EventSink`] trait that the
//! Tauri host implements to fan events out as window events.

pub mod driver;
pub mod capabilities;
pub mod error;
pub mod events;
pub mod fs;
pub mod mcp;
pub mod model_sniff;
pub mod prompt;
pub mod registry;
pub mod schema;
pub mod spawn;
pub mod terminal_pump;

pub use capabilities::{AgentCaps, client_capabilities};
pub use driver::{AuthEnvVar, AuthMethodKind, AuthMethodWire};
pub use error::{AcpError, ErrorClass, Result, classify_message};
pub use events::{AcpEvent, EventSink};
pub use registry::{
    AgentId, AgentInfo, AgentRegistry, AgentSessionInfo, AgentSpec, BUILTIN_AGENTS, BuiltinAgent,
    ImageAttachment,
    PermissionDecision, SpecSource, builtin_agent, builtin_login_args, builtin_registry_ids,
    is_auto_managed,
};
pub use prompt::ResourceLinkSpec;
pub use schema::NewSessionInfo;
pub use spawn::{
    invalidate_probe_cache, managed_node_bin, register_managed_node_bin, resolve_programs_abs,
    sanitize_host_env,
};

/// Login-shell program resolution, re-exported for the dynamic registry
/// (`atlas-registry`) which pre-resolves programs when it must emit a JSON
/// stdio spec (env-carrying commands bypass `resolve_command`).
pub use spawn::resolve_program_abs as resolve_program;

// Re-export schema types the host needs (so it doesn't have to take a direct
// dep on `agent-client-protocol-schema`).
//
// `ContentBlock` joined this list with P0.2: it is now the currency of the
// prompt seam, so `atlas-agentkit` (which has no ACP dep of its own) and the
// Tauri host both name it through here.
pub use agent_client_protocol::schema::v1::{ContentBlock, SessionId, StopReason};

/// Compile-time proof of which `unstable_*` schema features this build actually
/// has turned on (P0.1, `plans/atlas-acp-parity-loop.md`).
///
/// The feature surface is split across two crates and that split is easy to get
/// wrong: `agent-client-protocol`'s `unstable` umbrella covers only
/// `unstable_auth_methods`, `unstable_elicitation`,
/// `unstable_end_turn_token_usage`, `unstable_mcp_over_acp` and
/// `unstable_session_fork`. `unstable_llm_providers` / `unstable_plan_operations`
/// have no top-level flag at all and are reached solely through the direct
/// `agent-client-protocol-schema` dependency in `Cargo.toml`. Nothing else in the
/// tree references those two types yet (they land with P2.2 / P3.6), so without
/// this module a well-meaning "prune the unused dependency" edit would silently
/// switch them back off and the loss would only surface much later as an agent
/// notification failing to deserialize. Each `use` here is a load-bearing
/// assertion, not dead code.
#[cfg(test)]
mod unstable_feature_proof {
    // Umbrella (`agent-client-protocol/unstable`).
    #[allow(unused_imports)]
    use agent_client_protocol::schema::v1::{
        AuthMethodId, ElicitationCapabilities, ForkSessionRequest, McpCapabilities, Usage,
    };
    // Schema-only, via the direct `agent-client-protocol-schema` dep.
    #[allow(unused_imports)]
    use agent_client_protocol::schema::v1::{
        PlanCapabilities, PlanUpdate, ProviderInfo, ProvidersCapabilities,
    };

    /// `SessionUpdate` gains `PlanUpdate` / `PlanRemoved` variants once
    /// `unstable_plan_operations` is on. Before the P0.1 bump these arrived as
    /// unknown variants and the whole notification was rejected with
    /// `-32602 Invalid params`.
    #[test]
    fn plan_operations_session_updates_deserialize() {
        let raw = serde_json::json!({
            "sessionUpdate": "plan_update",
            "plan": { "type": "markdown", "planId": "plan-1", "content": "# hi" },
        });
        let update: agent_client_protocol::schema::v1::SessionUpdate =
            serde_json::from_value(raw).expect("plan_update must be a known SessionUpdate variant");
        assert!(matches!(
            update,
            agent_client_protocol::schema::v1::SessionUpdate::PlanUpdate(_)
        ));
    }

    /// `AgentCapabilities.providers` only exists under `unstable_llm_providers`;
    /// P3.6 reads it to decide whether to render a provider picker.
    #[test]
    fn agent_capabilities_carry_the_providers_field() {
        let caps: agent_client_protocol::schema::v1::AgentCapabilities =
            serde_json::from_value(serde_json::json!({ "providers": {} }))
                .expect("providers capability must parse");
        assert!(caps.providers.is_some());
    }
}

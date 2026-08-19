use agent_client_protocol::schema::v1 as acp_schema;
use serde::Serialize;
use uuid::Uuid;

use crate::registry::AgentId;

/// Single payload type that the driver pushes through [`EventSink`].
///
/// One event per ACP protocol-level message that the UI cares about. Wire format is
/// deliberately flat (`kind` + variant fields) so the TS side can pattern-match
/// without unwrapping a tagged union envelope.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AcpEvent {
    /// Driver finished `connect_with` (process exited or protocol shut down).
    AgentDisconnected {
        reason: String,
    },
    /// Agent emitted a `session/update` notification — forwarded raw so the UI
    /// can pattern-match on the full `SessionUpdate` enum (text, tool_call,
    /// plan, available_commands, mode change, etc).
    SessionUpdate {
        session_id: acp_schema::SessionId,
        update: acp_schema::SessionUpdate,
    },
    /// Agent asked the client for permission for a tool call.
    /// Frontend must respond via `acp_respond_permission(request_id, option_id)`.
    PermissionRequest {
        request_id: Uuid,
        session_id: acp_schema::SessionId,
        tool_call: acp_schema::ToolCallUpdate,
        options: Vec<acp_schema::PermissionOption>,
    },
    /// Cumulative token usage + estimated cost for the session. Emitted by the
    /// in-process native agent (ACP agents surface usage via their own updates).
    Usage {
        session_id: acp_schema::SessionId,
        input_tokens: u64,
        output_tokens: u64,
        /// Cumulative estimated cost in USD. `None` when the producer has no
        /// pricing to report — ACP carries none, and sending `0.0` would RESET
        /// a session's running cost every turn rather than leaving it alone.
        cost: Option<f64>,
        /// Cache tokens from an end-of-turn `PromptResponse.usage` (P2.5).
        /// `None` for the native agent's cost-bearing usage events, which have
        /// no cache split — additive so that path is unchanged.
        #[serde(default)]
        cache_read_tokens: Option<u64>,
        #[serde(default)]
        cache_write_tokens: Option<u64>,
    },
    /// The agent is asking the USER something mid-turn (P3.3,
    /// `elicitation/create`).
    ///
    /// Carried as raw JSON for the same reason permissions are: the schema
    /// types are `#[non_exhaustive]` and unstable-gated, and the UI renders a
    /// form generated from `requestedSchema` rather than matching variants. The
    /// host answers via `respond_elicitation`.
    Elicitation {
        session_id: Option<acp_schema::SessionId>,
        request_id: uuid::Uuid,
        /// `"form"` | `"url"`.
        mode: String,
        message: String,
        /// Form mode: the JSON schema of what the agent wants.
        requested_schema: Option<serde_json::Value>,
        /// URL mode: where to send the user.
        url: Option<String>,
    },
    /// Context compaction started (`active = true`) or finished (`false`).
    /// Native-agent only.
    Compaction {
        session_id: acp_schema::SessionId,
        active: bool,
    },
    /// Approx tokens saved by RTK tool-output compression this turn. Native-only.
    CompressionSaved {
        session_id: acp_schema::SessionId,
        saved_tokens: u64,
    },
    /// A transient model-call failure is being retried after a backoff.
    /// Native-only today (ACP agents own their retries in-process).
    Retry {
        session_id: acp_schema::SessionId,
        attempt: u32,
        max_attempts: u32,
        delay_ms: u64,
        last_error: String,
    },
}

/// Implemented by the Tauri host so the driver can fan events out without
/// depending on `tauri` directly.
///
/// `turn` is the producing turn's identity — the epoch returned by
/// `mark_turn_started` (ACP: `SessionGuard::turn_epoch`; native: the session's
/// turn counter). `None` means turn-agnostic traffic: session replay during
/// `session/load`, pre-first-turn notifications, and agent-level events like
/// `AgentDisconnected`. The session actor drops turn-stamped events whose
/// stamp doesn't match the live turn, so a superseded or cancelled turn's
/// stragglers can't contaminate the next turn's transcript.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, agent_id: AgentId, event: AcpEvent, turn: Option<u64>);
}

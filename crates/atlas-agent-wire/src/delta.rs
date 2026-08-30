//! Wire shape for session-scoped delta events — FROZEN.
//!
//! One change to one session, routed through a [`DeltaSink`] the host provides
//! (typically a window-event emitter) and fanned out on an [`EventBus`] for
//! in-process subscribers.
//!
//! Both ACP stacks produce these: the old one from its ACP notifications, the
//! ported one by projecting thread events (`atlas-agent-delta`). See
//! [`crate::types`] for why they live in a crate of their own.

use std::sync::Arc;

use serde::Serialize;

use atlas_bus::EventBus;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::types::{Message, PlanEntry, SessionStatus, ToolCall, Usage};
use crate::AgentId;

/// One change to one session. Tagged on the wire by `kind`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum SessionDelta {
    Status {
        status: SessionStatus,
        /// Turn identity this status belongs to (see `SessionState::turn_seq`).
        /// Lets the frontend drop a stale terminal `idle`/`error` that belongs
        /// to a turn already superseded by a newer send. 0 = untracked/current.
        #[serde(default)]
        turn_seq: u64,
    },
    /// A fresh message was appended to the tail of `messages`. UI should push
    /// it onto its local mirror.
    MessageAppended {
        message: Message,
    },
    /// Append text to an existing assistant message's `content`.
    TextChunk {
        message_id: String,
        delta: String,
    },
    /// Append text to an existing assistant message's `thinking` field.
    ThinkingChunk {
        message_id: String,
        delta: String,
    },
    /// Tool call inside a message was created or updated in place. The full
    /// snapshot is sent so the UI doesn't have to merge fields.
    ToolCallUpserted {
        message_id: String,
        tool_call: ToolCall,
    },
    /// Append live streaming output (`_meta.terminal_output`) to an existing
    /// tool call's `result` — the incremental sibling of `ToolCallUpserted`,
    /// mirroring `TextChunk`. Without it every output chunk re-shipped the
    /// FULL accumulated result, making a long-running command's IPC cost
    /// quadratic in its output size. Field changes (status, args, final
    /// result) still travel as full `ToolCallUpserted` snapshots. Additive:
    /// old frontends ignore unknown kinds.
    ToolCallOutputChunk {
        message_id: String,
        tool_call_id: String,
        delta: String,
    },
    PlanUpdated {
        plan: Vec<PlanEntry>,
    },
    /// The last `turns` exchanges were removed from the conversation's history
    /// (a rewind — the native agent's `/undo`). The UI drops its trailing
    /// messages through the `turns`-th user message from the end, so the
    /// transcript matches what the agent now remembers. Additive: old
    /// frontends ignore unknown kinds.
    HistoryRewound {
        turns: u32,
    },
    ModeChanged {
        mode_id: String,
    },
    /// A transient model-call failure is being retried after a backoff
    /// (native agent). Additive: old frontends ignore unknown kinds.
    RetryStatus {
        attempt: u32,
        max_attempts: u32,
        delay_ms: u64,
        last_error: String,
    },
    ModelChanged {
        model_id: String,
    },
    AvailableCommands {
        commands: Vec<serde_json::Value>,
    },
    UsageUpdated {
        usage: Usage,
    },
    /// The agent is asking the user something mid-turn (P3.3). Answered with
    /// `agents_respond_elicitation`.
    ElicitationRequested {
        request_id: uuid::Uuid,
        mode: String,
        message: String,
        requested_schema: Option<serde_json::Value>,
        url: Option<String>,
    },
    /// The agent named its own session (P3.1, `session_info_update`).
    /// Atlas titles a thread from the first 40 chars of the prompt; an agent
    /// that summarises it properly should win.
    TitleUpdated {
        title: String,
    },
    /// The agent's own config options changed (P2.2) — e.g. a thinking toggle
    /// flipped inside the agent, or `/model` run in its own TUI. Raw JSON,
    /// same shape the snapshot carries.
    ///
    /// Before this, `config_option_update` was stored on `SessionState` and
    /// never emitted, so the UI only learned about a change if something
    /// happened to refetch a snapshot — a knob toggled agent-side stayed
    /// visually wrong indefinitely.
    ConfigOptionsUpdated {
        config_options: Vec<serde_json::Value>,
    },
    /// Cumulative context-window usage from an ACP `usage_update` notification:
    /// `used`/`size` tokens (of the model's window) + optional cost. ACP agents
    /// (Claude Code / Codex) can't give a per-turn input/output split like the
    /// native agent, so this drives a context gauge in the turn card instead.
    ContextUsage {
        used: u64,
        size: u64,
        cost: f64,
    },
    /// Context compaction is running (`active = true`) or just finished.
    Compaction {
        active: bool,
    },
    /// Approx tokens RTK compression saved on this turn (native agent).
    CompressionSaved {
        saved_tokens: u64,
    },
    /// Agent requested permission for a tool call. The UI's permission inbox
    /// owns this — `respond_permission` resolves it back through atlas-acp.
    PermissionRequest {
        request_id: Uuid,
        tool_call: serde_json::Value,
        options: serde_json::Value,
    },
    /// Permission was resolved (by the user or by cancellation).
    PermissionResolved {
        request_id: Uuid,
    },
    TurnFinished {
        stop_reason: String,
        /// Turn identity (see `SessionState::turn_seq`); frontend rejects a
        /// terminal for a superseded turn. 0 = untracked/current.
        #[serde(default)]
        turn_seq: u64,
    },
    TurnFailed {
        error: String,
        #[serde(default)]
        turn_seq: u64,
        /// Failure class ("auth" routes the frontend to the sign-in flow;
        /// "transient"/"fatal"/"process_dead"/"unknown" are informational).
        /// Additive: absent on old payloads.
        #[serde(skip_serializing_if = "Option::is_none")]
        error_kind: Option<String>,
    },
    /// Underlying ACP agent process died.
    AgentDisconnected {
        reason: String,
    },
}

/// Envelope shipped through the Tauri event channel — keys for routing.
#[derive(Debug, Clone, Serialize)]
pub struct SessionDeltaEnvelope {
    pub agent_id: AgentId,
    pub session_id: String,
    #[serde(flatten)]
    pub delta: SessionDelta,
}

/// Implemented by the Tauri host to fan deltas out to the renderer.
pub trait DeltaSink: Send + Sync + 'static {
    fn emit(&self, envelope: SessionDeltaEnvelope);
}

/// The single outbound fan-out point for every session delta.
///
/// The manager and the per-session worker both funnel their emits through one
/// `Emitter` so there is exactly one place that sees every event. It publishes
/// to the global [`EventBus`] (the cloud-ready seam — a UI fan-out task and, in
/// future, a cloud streamer subscribe to it) and then delivers to the host
/// [`DeltaSink`] (window emit + telemetry + memory-ingest). Publishing to the
/// bus is non-blocking and drops for lagging subscribers, so the streaming hot
/// path is never held up by a slow consumer.
pub struct Emitter {
    sink: Arc<dyn DeltaSink>,
    bus: EventBus<SessionDeltaEnvelope>,
}

impl Emitter {
    pub fn new(sink: Arc<dyn DeltaSink>) -> Self {
        Self {
            sink,
            bus: EventBus::new(),
        }
    }

    /// The global event bus. Subscribe here for an in-process (or cloud) tap on
    /// every delta without going through the host sink.
    pub fn bus(&self) -> &EventBus<SessionDeltaEnvelope> {
        &self.bus
    }

    /// Convenience: a fresh subscription to the bus.
    pub fn subscribe(&self) -> broadcast::Receiver<SessionDeltaEnvelope> {
        self.bus.subscribe()
    }

    /// Fan one delta out to the bus and the host sink.
    pub fn emit(&self, envelope: SessionDeltaEnvelope) {
        // Bus first (cheap, non-blocking) so an in-process/cloud subscriber sees
        // the event even if the host sink does heavier work. Guarded: with no
        // subscribers (the production default — only opt-in taps attach), the
        // deep clone (full message bodies, full accumulated tool results) was
        // pure waste on the hottest path in the crate.
        if self.bus.receiver_count() > 0 {
            self.bus.publish(envelope.clone());
        }
        self.sink.emit(envelope);
    }
}

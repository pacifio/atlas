//! Wire shape for session-scoped delta events (additive-only; see [`crate::types`]).
//!
//! One change to one session, routed through a [`DeltaSink`] the host provides
//! (typically a window-event emitter) and fanned out on an [`EventBus`] for
//! in-process subscribers.
//!
//! They are produced by projecting thread events (`atlas-agent-delta`). See
//! [`crate::types`] for why they live in a crate of their own.

use std::sync::Arc;

use serde::Serialize;

use atlas_bus::EventBus;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::types::{
    Message, Origin, PlanEntry, QueuedPrompt, RateLimitWindow, SessionStatus, Subagent, ToolCall,
    Usage,
};
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
    /// A subagent was launched, made progress, or ended. The full snapshot
    /// travels, like [`SessionDelta::ToolCallUpserted`], so the client never
    /// merges fields. Additive: a client that does not know the kind ignores
    /// it and still sees the launching tool call, as before.
    SubagentUpserted {
        subagent: Subagent,
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
    /// The session's mode changed. `origin` says who changed it — the
    /// window, or a remote driver through Universal RC — when the change went
    /// through the host's steering entry; absent when the agent changed it on
    /// its own (an ACP `current_mode_update` echo). Additive: old frontends
    /// ignore the field.
    ModeChanged {
        mode_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        origin: Option<Origin>,
    },
    /// A transient model-call failure is being retried after a backoff
    /// (native agent). Additive: old frontends ignore unknown kinds.
    RetryStatus {
        attempt: u32,
        max_attempts: u32,
        delay_ms: u64,
        last_error: String,
    },
    /// The session's model changed through the host's steering entry.
    /// `origin` says who picked it (see [`SessionDelta::ModeChanged`]).
    ModelChanged {
        model_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        origin: Option<Origin>,
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
    ///
    /// `origin` says who set the option when the list is the confirmed echo
    /// of a `set_config_option` through the host; absent when the agent
    /// changed it on its own (see [`SessionDelta::ModeChanged`]).
    ConfigOptionsUpdated {
        config_options: Vec<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        origin: Option<Origin>,
    },
    /// Cumulative context-window usage from an ACP `usage_update` notification:
    /// `used`/`size` tokens (of the model's window) + optional cost. ACP agents
    /// (Claude Code / Codex) can't give a per-turn input/output split like the
    /// native agent, so this drives a context gauge in the turn card instead.
    ContextUsage {
        used: u64,
        size: u64,
        cost: f64,
        /// ISO 4217 code `cost` is in; `None` means USD, as on `Usage`.
        #[serde(default)]
        currency: Option<String>,
    },
    /// Context compaction is running (`active = true`) or just finished.
    Compaction {
        active: bool,
    },
    /// Approx tokens RTK compression saved on this turn (native agent).
    CompressionSaved {
        saved_tokens: u64,
    },
    /// The account's rolling quota windows, as the native engine reports them
    /// (`account/rateLimits/updated`). Account-level rather than per session:
    /// the same snapshot lands on every live native session. Absent windows
    /// are `None`, never zero.
    RateLimits {
        primary: Option<RateLimitWindow>,
        secondary: Option<RateLimitWindow>,
        plan_type: Option<String>,
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
        /// When the turn opened, as epoch milliseconds. Absent when the thread
        /// never saw it open (a stop announced with no turn running).
        /// Additive: old frontends ignore it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_at_ms: Option<i64>,
        /// When the turn stopped, as epoch milliseconds.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ended_at_ms: Option<i64>,
        /// How long the turn ran, in ms, on the monotonic clock — not
        /// `ended_at_ms - started_at_ms`, which a stepped wall clock or a
        /// sleep stretches. The figure a snapshot carries as
        /// `Message::worked_ms`. Absent with `started_at_ms`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        worked_ms: Option<u64>,
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
    /// The computer slept (lid closed, system sleep) while this session's turn
    /// was running, so whatever the agent was streaming may have been cut
    /// off. Emitted by the host on waking, for any agent — it is about the
    /// machine, not the agent. `turn_seq` is the turn that was in flight
    /// (0 = untracked/current); `slept_secs` is roughly how long the machine
    /// was asleep. Additive: old frontends ignore unknown kinds.
    SleptMidTurn {
        turn_seq: u64,
        slept_secs: u64,
    },
    /// Underlying ACP agent process died.
    AgentDisconnected {
        reason: String,
    },
    /// A prompt reached the agent: the user half of an exchange, projected
    /// from the thread entry the send pushed, so the stream and the snapshot
    /// agree on user rows.
    ///
    /// Only prompts sent through the host's steering entry are announced —
    /// history an agent replays on `session/load` is not, exactly as before
    /// (the snapshot carries it). `message.content` is what the agent was
    /// sent, which can carry Atlas's hidden directives; renderers strip them
    /// as they do on a reloaded transcript. `client_message_id` echoes the id
    /// the sender minted, so a window that already shows its own optimistic
    /// row adopts this one instead of drawing a second. Additive: old
    /// frontends ignore unknown kinds.
    UserMessage {
        message: Message,
        origin: Origin,
        #[serde(skip_serializing_if = "Option::is_none")]
        client_message_id: Option<String>,
    },
    /// The session's turn queue changed (a prompt parked, removed, started or
    /// discarded). The whole queue travels, like a plan, so a client never
    /// merges. Additive.
    QueueChanged {
        queue: Vec<QueuedPrompt>,
    },
    /// The session gained or lost a hold that keeps it running without a tab
    /// (Universal RC). A held session survives its tab closing and a project
    /// switch. Additive.
    HoldChanged {
        held: bool,
    },
}

/// Envelope shipped through the Tauri event channel — keys for routing.
#[derive(Debug, Clone, Serialize)]
pub struct SessionDeltaEnvelope {
    pub agent_id: AgentId,
    pub session_id: String,
    /// This delta's position in its session's stream: dense and monotonic per
    /// session, starting at 1, stamped by the projector in emit order. A
    /// snapshot carries the `as_of_seq` it reflects, so a late joiner that
    /// buffered the stream drops every envelope at or below it and applies the
    /// rest — nothing twice, nothing missed. 0 only on an envelope built
    /// outside the projector (tests). Additive.
    #[serde(default)]
    pub seq: u64,
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

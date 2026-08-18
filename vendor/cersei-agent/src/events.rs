//! Agent events: the full event enum, AgentStream, and control messages.

use cersei_tools::permissions::{PermissionDecision, PermissionRequest};
use cersei_tools::PermissionLevel;
use cersei_types::*;
use std::time::Duration;
use tokio::sync::mpsc;

use crate::AgentOutput;

// ─── Agent events ────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum AgentEvent {
    // Streaming content
    TextDelta(String),
    ThinkingDelta(String),

    /// ATLAS PATCH (retry-classified-v1): a transient model-call failure is
    /// being retried after a backoff. `attempt` is the retry number (1-based),
    /// `delay_ms` the backoff before it fires.
    Retry {
        attempt: u32,
        max_attempts: u32,
        delay_ms: u64,
        last_error: String,
    },

    // Tool lifecycle
    ToolStart {
        name: String,
        id: String,
        input: serde_json::Value,
    },
    ToolEnd {
        name: String,
        id: String,
        result: String,
        is_error: bool,
        duration: Duration,
        /// RTK compression metrics for this tool output, when compression ran
        /// (None for error results, which are not compressed).
        compression: Option<cersei_compression::CompressionStats>,
        /// ATLAS PATCH (tool-result-metadata-v1): the structured half of the
        /// tool's result, carried alongside its text. Without it a tool that
        /// computes a real before/after — every file edit — has that work
        /// discarded at the event boundary, and the UI is left re-deriving a
        /// diff from raw tool input. `None` for tools that produce none.
        metadata: Option<serde_json::Value>,
    },
    ToolPermissionCheck {
        name: String,
        id: String,
        level: PermissionLevel,
    },

    // Permission interaction
    PermissionRequired(PermissionRequest),

    // Turn lifecycle
    TurnStart {
        turn: u32,
    },
    TurnComplete {
        turn: u32,
        stop_reason: StopReason,
        usage: Usage,
    },
    ModelRequestStart {
        turn: u32,
        message_count: usize,
        token_estimate: u64,
    },
    ModelResponseStart {
        turn: u32,
        model: String,
    },

    // Context management
    TokenWarning {
        pct_used: f64,
        state: WarningState,
    },
    CompactStart {
        reason: CompactReason,
        messages_before: usize,
    },
    CompactEnd {
        messages_after: usize,
        tokens_freed: u64,
    },

    // Session lifecycle
    SessionLoaded {
        session_id: String,
        message_count: usize,
    },
    SessionSaved {
        session_id: String,
    },

    // Cost tracking (realtime)
    CostUpdate {
        turn_cost: f64,
        cumulative_cost: f64,
        input_tokens: u64,
        output_tokens: u64,
    },

    // Agent coordination (multi-agent)
    SubAgentSpawned {
        agent_id: String,
        prompt: String,
    },
    SubAgentComplete {
        agent_id: String,
        result: AgentOutput,
    },

    // Hook activity
    HookFired {
        event: cersei_hooks::HookEvent,
        hook_name: String,
    },
    HookBlocked {
        event: cersei_hooks::HookEvent,
        hook_name: String,
        reason: String,
    },

    // Terminal
    Status(String),
    Error(String),
    Complete(AgentOutput),
}

#[derive(Debug, Clone, Copy)]
pub enum WarningState {
    Normal,
    Warning,
    Critical,
}

#[derive(Debug, Clone, Copy)]
pub enum CompactReason {
    ThresholdExceeded,
    ManualTrigger,
    ContextOverflow,
}

// ─── Agent stream ────────────────────────────────────────────────────────────

/// Returned by `agent.run_stream()`. Provides async iteration over events
/// and bidirectional control (permissions, cancellation, message injection).
pub struct AgentStream {
    rx: mpsc::Receiver<AgentEvent>,
    control_tx: mpsc::Sender<AgentControl>,
}

impl AgentStream {
    pub(crate) fn new(
        rx: mpsc::Receiver<AgentEvent>,
        control_tx: mpsc::Sender<AgentControl>,
    ) -> Self {
        Self { rx, control_tx }
    }

    /// Respond to a PermissionRequired event.
    pub fn respond_permission(&self, request_id: String, decision: PermissionDecision) {
        let _ = self.control_tx.try_send(AgentControl::PermissionResponse {
            request_id,
            decision,
        });
    }

    /// Send a cancellation signal.
    pub fn cancel(&self) {
        let _ = self.control_tx.try_send(AgentControl::Cancel);
    }

    /// Inject a user message mid-stream.
    pub fn inject_message(&self, message: String) {
        let _ = self
            .control_tx
            .try_send(AgentControl::InjectMessage(message));
    }

    /// Receive the next event.
    pub async fn next(&mut self) -> Option<AgentEvent> {
        self.rx.recv().await
    }

    /// Collect all events and return the final output.
    pub async fn collect(mut self) -> cersei_types::Result<AgentOutput> {
        while let Some(event) = self.rx.recv().await {
            match event {
                AgentEvent::Complete(output) => return Ok(output),
                AgentEvent::Error(e) => return Err(CerseiError::Other(anyhow::anyhow!(e))),
                _ => continue,
            }
        }
        Err(CerseiError::Cancelled)
    }

    /// Collect only text deltas into a single string.
    pub async fn collect_text(mut self) -> cersei_types::Result<String> {
        let mut text = String::new();
        while let Some(event) = self.rx.recv().await {
            match event {
                AgentEvent::TextDelta(t) => text.push_str(&t),
                AgentEvent::Complete(_) => return Ok(text),
                AgentEvent::Error(e) => return Err(CerseiError::Other(anyhow::anyhow!(e))),
                _ => continue,
            }
        }
        Ok(text)
    }
}

// ─── Control messages ────────────────────────────────────────────────────────

#[derive(Debug)]
pub(crate) enum AgentControl {
    #[allow(dead_code)]
    PermissionResponse {
        request_id: String,
        decision: PermissionDecision,
    },
    Cancel,
    #[allow(dead_code)]
    InjectMessage(String),
}

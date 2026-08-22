//! The session-delta wire types — FROZEN (`docs/agents/delta-wire-contract.md`).
//!
//! These shapes are what `CaptureMiddleware`, the analytics/transcript/memory
//! middleware and the whole chat UI pattern-match on. They may not drift during
//! the ACP port; if a stack cannot produce one verbatim, the port stops and
//! every consumer is updated in the same change (research §D12-1).
//!
//! They live in their own crate for one reason: **both ACP stacks have to
//! produce them.** The old stack is on `agent-client-protocol` 1.3, the ported
//! one on 2.0, and the two can never share a Cargo graph — the protocol crate
//! pins its schema crate exactly (`=1.4.0` / `=1.5.0`). A wire type defined in
//! either stack is therefore unreachable from the other. Defined here, it is
//! one type for both, so `CaptureMiddleware` keeps matching on the same enum no
//! matter which stack produced the event.
//!
//! `atlas-agents` re-exports everything here, so consumers that say
//! `atlas_agents::SessionDelta` are unaffected (research §C9 touchpoint #2).

use chrono::{DateTime, Utc};
use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Idle,
    Running,
    Waiting,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageMode {
    Text,
    Tool,
    Thinking,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    Pending,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolCall {
    pub id: String,
    pub tool_name: String,
    pub title: Option<String>,
    pub kind: Option<String>,
    pub status: ToolCallStatus,
    pub arguments: serde_json::Value,
    pub result: Option<String>,
    pub locations: Vec<serde_json::Value>,
    /// The tool's own structured result (`rawOutput`), verbatim (P3.1).
    ///
    /// `src/types/acp.ts` has declared this field since before it was captured,
    /// so the frontend was reading `undefined` from every tool call. `result`
    /// is the human-readable flattening; this is what a tool actually returned,
    /// which is what a caller inspecting a failed structured call needs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_output: Option<serde_json::Value>,
    /// Content blocks that need STRUCTURE, not a flattened string (P1.4).
    ///
    /// `result` keeps carrying everything text-shaped, exactly as before — this
    /// is additive. A `ToolCallContent::Diff` was previously reduced to its bare
    /// `path` by [`format_tool_content`], throwing away the before/after text
    /// the agent had already computed; that is the content the transcript needs
    /// to show a proposed edit that is not on disk yet (plan mode, preview),
    /// where a git-backed diff has nothing to compare against.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub content_blocks: Vec<ToolContentBlock>,
}

/// A tool-content block the UI renders structurally rather than as text.
///
/// Deliberately NOT a mirror of the whole ACP `ToolCallContent` enum: text and
/// anything text-shaped keeps flowing through `result`, so only the variants
/// with a genuine non-text rendering appear here.
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ToolContentBlock {
    /// An edit the agent is proposing or has made. `old_text` is absent for a
    /// newly created file.
    #[serde(rename_all = "camelCase")]
    Diff {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        old_text: Option<String>,
        new_text: String,
    },
    /// A terminal the agent created through `terminal/*` (P1.2). Carries only
    /// the id — the live output is streamed separately.
    #[serde(rename_all = "camelCase")]
    Terminal { terminal_id: String },
}

/// Pull the structural blocks out of a tool call's `content` array.
///
/// Unknown block types are ignored rather than erroring: `ToolCallContent` is
/// `#[non_exhaustive]` and an agent on a newer schema must not break the whole
/// tool call by sending a variant this build has never heard of.
pub fn extract_content_blocks(value: &serde_json::Value) -> Vec<ToolContentBlock> {
    let mut out = Vec::new();
    collect_content_blocks(value, &mut out);
    out
}

fn collect_content_blocks(value: &serde_json::Value, out: &mut Vec<ToolContentBlock>) {
    match value {
        serde_json::Value::Array(arr) => {
            for item in arr {
                collect_content_blocks(item, out);
            }
        }
        serde_json::Value::Object(o) => {
            match o.get("type").and_then(|t| t.as_str()) {
                Some("diff") => {
                    // `newText` is required by the schema; a diff without it is
                    // malformed and there is nothing meaningful to render.
                    if let (Some(path), Some(new_text)) = (
                        o.get("path").and_then(|p| p.as_str()),
                        o.get("newText").and_then(|t| t.as_str()),
                    ) {
                        out.push(ToolContentBlock::Diff {
                            path: path.to_string(),
                            old_text: o
                                .get("oldText")
                                .and_then(|t| t.as_str())
                                .map(str::to_owned),
                            new_text: new_text.to_string(),
                        });
                    }
                }
                Some("terminal") => {
                    if let Some(id) = o.get("terminalId").and_then(|t| t.as_str()) {
                        out.push(ToolContentBlock::Terminal {
                            terminal_id: id.to_string(),
                        });
                    }
                }
                // `{"type":"content","content":{...}}` wraps the real block.
                _ => {
                    if let Some(inner) = o.get("content") {
                        collect_content_blocks(inner, out);
                    }
                }
            }
        }
        _ => {}
    }
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct PlanEntry {
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub priority: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Message {
    pub id: String,
    pub role: MessageRole,
    pub mode: MessageMode,
    pub content: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub thinking: String,
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<Vec<PlanEntry>>,
    /// Model that produced this assistant message — the session's current
    /// model at creation time, or the transcript's recorded model on replay.
    /// Lets the UI's per-message badge survive session reloads instead of
    /// deriving it from live state (which mislabels after model switches).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    /// Estimated cumulative cost in USD (native agent; 0 when unknown).
    #[serde(default)]
    pub cost: f64,
}

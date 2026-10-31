//! The session-delta wire types — additive-only.
//!
//! These shapes are what `CaptureMiddleware`, the analytics/transcript/memory
//! middleware and the whole chat UI pattern-match on, by concrete variant and
//! field. That is why they are not edited casually:
//!
//! - Adding an optional field or a new variant is ordinary work. Do it in the
//!   same change as its consumers, plus `tests/contract.rs` and
//!   `tests/wire-shape-contract.test.ts`.
//! - Renaming or removing a variant or field, or changing what a field means,
//!   is a breaking change: every consumer (chat store / UI, capture recorder,
//!   analytics/transcript/memory) is updated in the same change.
//!
//! The contract tests are the authority; the TS mirror is `src/types/agents.ts`.
//!
//! They live in their own crate because the protocol crates pin their schema
//! crate exactly, so a wire type defined in one stack was unreachable from
//! another (the old 1.3 stack and the 2.0 stack coexisted for a day). It stays
//! separate so the wire names no protocol version; `atlas-agent-delta` is where
//! thread events are projected onto it.

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
    /// The subagent this call belongs to, named by the id of the call that
    /// launched it ([`Subagent::tool_call_id`]).
    ///
    /// Absent for the parent's own work, which is almost every call. A child's
    /// tool calls arrive on the same session as its parent's, interleaved; this
    /// is the only thing that tells them apart (`atlas_acp_thread::subagent`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_tool_call_id: Option<String>,
    /// When Atlas first saw this call, as epoch milliseconds — the same clock
    /// and shape as [`Subagent::started_at_ms`]. Stamped once by the thread and
    /// never moved by later updates, so a reloaded session shows the same
    /// duration the live one did.
    ///
    /// A call rebuilt by an agent's `session/load` replay is stamped at replay
    /// time (ACP carries no per-call time), so its start and end coincide and
    /// it reads as having no duration rather than a wrong one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at_ms: Option<i64>,
    /// When the call first reached a terminal status (completed, failed,
    /// rejected or cancelled), as epoch milliseconds. Absent while it runs.
    /// It is `started_at_ms` plus the call's run time on the monotonic
    /// clock, so the difference is a duration a stepped wall clock cannot
    /// bend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at_ms: Option<i64>,
}

/// How far along a subagent is.
///
/// Deliberately not [`ToolCallStatus`]: a subagent that the parent interrupted
/// is neither completed nor failed, and a client that shows "failed" for one
/// the user stopped is lying about it.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SubagentStatus {
    Running,
    Completed,
    Failed,
    Interrupted,
}

/// A child agent the running agent delegated work to.
///
/// Projected from the tool call that launched it, which is also its identity:
/// ACP has no subagent concept, so there is no id to use but that call's
/// (`atlas_acp_thread::subagent` documents what each adapter sends).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Subagent {
    /// The launching tool call's id — the key a child's calls point back to.
    pub tool_call_id: String,
    /// The message the launching call belongs to, so the client can place the
    /// subagent in the transcript as well as in a panel.
    pub message_id: String,
    pub name: String,
    pub status: SubagentStatus,
    /// The child's instructions, when the launch carried them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// The child's role: Claude's `subagent_type`, the engine's `agent_type`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// What it reported back, once it finished.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    /// How many tool calls it has made so far — what a collapsed row counts.
    pub tool_call_count: u32,
    /// When the launching call was first seen, as epoch milliseconds. The
    /// client derives the elapsed time from it rather than being sent a
    /// duration that is stale the moment it arrives.
    pub started_at_ms: i64,
    /// Set once it reached a terminal status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at_ms: Option<i64>,
    /// The child ran on an agent thread of its own (the engine's subagents),
    /// so its work is not in this session: `tool_call_count` stays 0 however
    /// much it did. Omitted when false.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub own_thread: bool,
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
                            old_text: o.get("oldText").and_then(|t| t.as_str()).map(str::to_owned),
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
    /// Images the user sent with this message (user messages only). Carried on
    /// snapshots so a reopened conversation shows what was attached; before
    /// this field existed they were flattened to the text `` `Image` ``.
    /// Omitted when empty, so every message without one serializes exactly as
    /// it did before — the delta stream never sends user messages.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub images: Vec<MessageImage>,
    pub timestamp: DateTime<Utc>,
    /// True when `timestamp` is only when Atlas replayed the message, not when
    /// it was said: an agent's `session/load` replay carries no per-message
    /// time. The renderer shows no clock for such a message. Omitted when
    /// false, so every timed message serializes exactly as before.
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub timestamp_approximate: bool,
    /// How long the turn this message ends ran, in ms, on the monotonic clock
    /// (see `turn_finished.worked_ms`). Set only on a snapshot's last assistant message of a turn
    /// the thread saw start and stop; the live stream carries the same figure
    /// on `turn_finished` instead. Absent for a replayed turn, which has no
    /// honest start to measure from.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub worked_ms: Option<u64>,
    /// How the turn this message ends stopped — the protocol's token, as
    /// `turn_finished.stop_reason` carries it (`end_turn`, `cancelled`, …).
    /// Set on the same message as [`Self::worked_ms`].
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub stop_reason: Option<String>,
}

/// One image on a [`Message`]: base64 bytes plus their MIME type, the same
/// pair an ACP image content block carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct MessageImage {
    pub mime_type: String,
    pub data: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    /// Reasoning / thinking output, for agents that report it apart from
    /// `output_tokens`. Informational; nothing prices it separately yet.
    #[serde(default)]
    pub reasoning_tokens: u64,
    /// Cumulative cost as the agent reported it; 0 when unknown.
    #[serde(default)]
    pub cost: f64,
    /// ISO 4217 code `cost` is in, as ACP's `Cost.currency` gives it. `None`
    /// when the agent named none, which means USD.
    #[serde(default)]
    pub currency: Option<String>,
}

/// One rolling quota window, as the native engine's account report gives it.
#[derive(Debug, Clone, Default, Serialize)]
pub struct RateLimitWindow {
    /// 0–100.
    pub used_percent: u8,
    pub window_minutes: Option<i64>,
    /// Epoch seconds.
    pub resets_at: Option<i64>,
}

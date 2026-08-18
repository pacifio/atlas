//! Per-session state owned by the Rust side.
//!
//! `SessionState` is mutable, lives behind a `parking_lot::Mutex`, and is
//! mutated by:
//! - the manager's `EventSink` impl when ACP notifications arrive
//! - the per-session worker when send / cancel / mode-change commands run
//!
//! `SessionSnapshot` is the serialisable wire shape — produced on demand for
//! tab-activate, never streamed.

use agent_client_protocol::schema::v1 as acp_schema;
use atlas_acp::AgentId;
use chrono::{DateTime, Utc};
use serde::Serialize;
use uuid::Uuid;

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
    /// The real before/after, when the tool reported one.
    ///
    /// This used to be thrown away: a `diff` content block was flattened to its
    /// `path` by [`format_tool_content`], so the UI had to re-derive line counts
    /// from raw tool arguments — which reads zero for any tool whose argument
    /// shape it does not recognise, with nothing erroring.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub diff: Option<ToolCallDiff>,
}

/// A structured file change reported by a tool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct ToolCallDiff {
    pub path: String,
    /// Absent when the tool created the file.
    #[serde(rename = "oldText", skip_serializing_if = "Option::is_none", default)]
    pub old_text: Option<String>,
    #[serde(rename = "newText")]
    pub new_text: String,
}

/// Pull a `diff` content block out of a tool call's `content` array.
pub fn extract_tool_diff(value: &serde_json::Value) -> Option<ToolCallDiff> {
    fn from_block(block: &serde_json::Value) -> Option<ToolCallDiff> {
        if block.get("type").and_then(|t| t.as_str()) != Some("diff") {
            return None;
        }
        Some(ToolCallDiff {
            path: block.get("path")?.as_str()?.to_string(),
            old_text: block
                .get("oldText")
                .and_then(|t| t.as_str())
                .map(|s| s.to_string()),
            new_text: block.get("newText")?.as_str()?.to_string(),
        })
    }
    match value {
        serde_json::Value::Array(arr) => arr.iter().find_map(from_block),
        other => from_block(other),
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

/// One ACP-advertised session mode (e.g. Codex's read-only / auto / full-access).
/// Sourced from the `modes` blob in `session/new` and `session/load` responses.
#[derive(Debug, Clone, Serialize)]
pub struct SessionModeInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionSnapshot {
    pub agent_id: AgentId,
    pub session_id: String,
    pub cwd: String,
    pub plugin_id: String,
    pub status: SessionStatus,
    pub current_mode: Option<String>,
    pub current_model: Option<String>,
    /// The full set of modes the agent advertised for this session. Empty for
    /// agents that don't expose modes; drives the composer's mode picker.
    pub available_modes: Vec<SessionModeInfo>,
    /// Models the agent advertised (ACP `session/new` `models` blob, reused
    /// shape: id/name/description). Empty when the agent exposes no model
    /// selection; drives the composer's model picker for Claude Code / Codex.
    pub available_models: Vec<SessionModeInfo>,
    pub available_commands: Vec<serde_json::Value>,
    /// Raw `config_option_update` state (see `SessionState::config_options`).
    pub config_options: Vec<serde_json::Value>,
    /// Whether the agent's transport supports image content blocks in
    /// prompts (`promptCapabilities.image`). Stamped by the manager from the
    /// live backend — `SessionState::snapshot()` leaves it false so session
    /// state stays transport-agnostic. Drives the composer's attach routing.
    #[serde(default)]
    pub prompt_image_supported: bool,
    pub plan: Vec<PlanEntry>,
    pub messages: Vec<Message>,
    pub usage: Usage,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Mutable session state. Held inside `Arc<Mutex<SessionState>>`.
pub struct SessionState {
    pub agent_id: AgentId,
    pub session_id: String,
    pub cwd: String,
    pub plugin_id: String,
    pub status: SessionStatus,
    pub current_mode: Option<String>,
    pub current_model: Option<String>,
    pub available_modes: Vec<SessionModeInfo>,
    pub available_models: Vec<SessionModeInfo>,
    pub available_commands: Vec<serde_json::Value>,
    /// Config options the agent advertised / updated (`config_option_update`).
    /// Raw wire JSON, replaced whole per update — the UI reads them from the
    /// snapshot; nothing here interprets them. Ignoring this update kind meant
    /// an in-agent change (e.g. `/model` flipping a config option) never
    /// reached the host.
    pub config_options: Vec<serde_json::Value>,
    pub plan: Vec<PlanEntry>,
    pub messages: Vec<Message>,
    pub usage: Usage,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Monotonic turn identity, bumped at the START of every turn (the actor's
    /// `start_turn`). Stamped onto every emitted delta so the frontend can
    /// reject a stale terminal (idle/error) delta belonging to a turn that has
    /// already been superseded by a newer send. Not serialised into the
    /// snapshot.
    pub turn_seq: u64,
}

impl SessionState {
    pub fn new(agent_id: AgentId, session_id: String, cwd: String, plugin_id: String) -> Self {
        let now = Utc::now();
        Self {
            agent_id,
            session_id,
            cwd,
            plugin_id,
            status: SessionStatus::Idle,
            current_mode: None,
            current_model: None,
            available_modes: Vec::new(),
            available_models: Vec::new(),
            available_commands: Vec::new(),
            config_options: Vec::new(),
            plan: Vec::new(),
            messages: Vec::new(),
            usage: Usage::default(),
            created_at: now,
            updated_at: now,
            turn_seq: 0,
        }
    }

    pub fn snapshot(&self) -> SessionSnapshot {
        self.snapshot_with_messages(self.messages.clone())
    }

    /// [`snapshot`](Self::snapshot) minus the transcript (`messages` left
    /// empty). The full snapshot deep-clones every message + tool result under
    /// the same lock the streaming actor needs — multi-MB and multi-ms on long
    /// resumed sessions — yet most callers only want modes/models/cwd-scale
    /// metadata. Use this everywhere the transcript isn't actually read.
    pub fn snapshot_meta(&self) -> SessionSnapshot {
        self.snapshot_with_messages(Vec::new())
    }

    fn snapshot_with_messages(&self, messages: Vec<Message>) -> SessionSnapshot {
        SessionSnapshot {
            agent_id: self.agent_id,
            session_id: self.session_id.clone(),
            cwd: self.cwd.clone(),
            plugin_id: self.plugin_id.clone(),
            status: self.status,
            current_mode: self.current_mode.clone(),
            current_model: self.current_model.clone(),
            available_modes: self.available_modes.clone(),
            available_models: self.available_models.clone(),
            available_commands: self.available_commands.clone(),
            config_options: self.config_options.clone(),
            prompt_image_supported: false,
            plan: self.plan.clone(),
            messages,
            usage: self.usage.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }

    pub fn touch(&mut self) {
        self.updated_at = Utc::now();
    }

    /// True if any tool call in the session is still non-terminal
    /// (`Pending`/`Running`). The actor uses this to hold turn finalization
    /// until tool calls quiesce — the ACP contract is that a turn only truly
    /// ends once no tool calls pend, but the `session/prompt` future can resolve
    /// while trailing `tool_call_update` frames are still in flight. Because the
    /// actor sweeps residual tools to terminal at every finalize, this only ever
    /// reflects the current turn's tools.
    pub fn has_inflight_tool_calls(&self) -> bool {
        self.messages.iter().any(|m| {
            m.tool_calls
                .iter()
                .any(|t| matches!(t.status, ToolCallStatus::Pending | ToolCallStatus::Running))
        })
    }
}

// ── Helpers reused by the manager + worker ───────────────────────────────────

pub fn new_message_id() -> String {
    format!("msg-{}", Uuid::new_v4().simple())
}

pub fn new_assistant_text(content: String) -> Message {
    Message {
        id: new_message_id(),
        role: MessageRole::Assistant,
        mode: MessageMode::Text,
        content,
        thinking: String::new(),
        tool_calls: Vec::new(),
        plan: None,
        model: None,
        timestamp: Utc::now(),
    }
}

pub fn new_assistant_thinking(thinking: String) -> Message {
    Message {
        id: new_message_id(),
        role: MessageRole::Assistant,
        mode: MessageMode::Thinking,
        content: String::new(),
        thinking,
        tool_calls: Vec::new(),
        plan: None,
        model: None,
        timestamp: Utc::now(),
    }
}

pub fn new_assistant_tool(tool_call: ToolCall) -> Message {
    Message {
        id: new_message_id(),
        role: MessageRole::Assistant,
        mode: MessageMode::Tool,
        content: String::new(),
        thinking: String::new(),
        tool_calls: vec![tool_call],
        plan: None,
        model: None,
        timestamp: Utc::now(),
    }
}

pub fn new_user_message(content: String) -> Message {
    Message {
        id: new_message_id(),
        role: MessageRole::User,
        mode: MessageMode::Text,
        content,
        thinking: String::new(),
        tool_calls: Vec::new(),
        plan: None,
        model: None,
        timestamp: Utc::now(),
    }
}

pub fn map_tool_status(raw: Option<&str>, fallback: ToolCallStatus) -> ToolCallStatus {
    match raw {
        Some("pending") => ToolCallStatus::Pending,
        Some("in_progress") => ToolCallStatus::Running,
        Some("completed") => ToolCallStatus::Completed,
        Some("failed") => ToolCallStatus::Failed,
        _ => fallback,
    }
}

/// `rawInput` from the canonical Claude Code agent is sometimes a JSON object,
/// sometimes a stringified object. Normalise to a `Value`.
pub fn normalise_tool_input(raw: Option<&serde_json::Value>) -> serde_json::Value {
    match raw {
        Some(serde_json::Value::String(s)) => {
            serde_json::from_str(s).unwrap_or_else(|_| serde_json::json!({ "raw": s }))
        }
        Some(v) => v.clone(),
        None => serde_json::Value::Object(serde_json::Map::new()),
    }
}

/// Tool-call `content` blocks → flat string suitable for the existing
/// ToolCallCard "result" display. Mirrors the frontend's `formatToolContent`.
pub fn format_tool_content(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Array(arr) => {
            let parts: Vec<String> = arr.iter().filter_map(format_tool_content).collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        serde_json::Value::Object(o) => {
            if let Some(inner) = o.get("content") {
                if let Some(s) = format_tool_content(inner) {
                    return Some(s);
                }
            }
            if let Some(serde_json::Value::String(s)) = o.get("text") {
                return Some(s.clone());
            }
            if let Some(serde_json::Value::String(s)) = o.get("output") {
                return Some(s.clone());
            }
            // A `diff` block is structured, not text. It is carried on
            // `ToolCall::diff` instead; flattening it to a path here is what
            // made file-change accounting read zero.
            None
        }
        _ => None,
    }
}

/// Pull the `text` field out of an `agent_message_chunk` / `agent_thought_chunk`
/// ContentBlock. Returns `None` for non-text blocks (images, etc.).
pub fn extract_text_block(content: &acp_schema::ContentBlock) -> Option<String> {
    // ContentBlock is #[non_exhaustive] in the schema; round-trip through JSON.
    let v = serde_json::to_value(content).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("text") {
        return None;
    }
    v.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
}

/// Pull `(mime_type, base64_data)` out of an image ContentBlock. Returns
/// `None` for anything else. Same JSON round-trip as [`extract_text_block`]
/// (`ContentBlock` is `#[non_exhaustive]`).
pub fn extract_image_block(content: &acp_schema::ContentBlock) -> Option<(String, String)> {
    let v = serde_json::to_value(content).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("image") {
        return None;
    }
    let mime = v.get("mimeType").and_then(|m| m.as_str())?.to_string();
    let data = v.get("data").and_then(|d| d.as_str())?.to_string();
    Some((mime, data))
}

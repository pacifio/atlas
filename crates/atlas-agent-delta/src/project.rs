//! Turning one thread entry into its wire shape.
//!
//! Pure functions, no state: everything here answers "what does this entry look
//! like on the wire right now". Deciding what *changed* — and therefore which
//! delta to send — is [`crate::projector`]'s job.

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{
    AssistantMessageChunk, ContentBlock, PermissionOptions, ToolCall as ThreadToolCall,
    ToolCallContent, ToolCallStatus as ThreadToolCallStatus,
};
use atlas_agent_wire::{
    Message, MessageMode, MessageRole, PlanEntry, ToolCall, ToolCallStatus, ToolContentBlock,
};

/// One run of same-kind chunks inside an assistant entry.
///
/// The thread interleaves text and thoughts in a single entry; the wire wants a
/// message per contiguous run, `mode: text` or `mode: thinking`. Splitting here
/// is what preserves the old stack's rendering: a thought after some text opens
/// a new bubble rather than being appended to the previous one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub is_thought: bool,
    pub text: String,
}

/// Group an assistant entry's chunks into runs.
pub fn runs(chunks: &[AssistantMessageChunk]) -> Vec<Run> {
    let mut runs: Vec<Run> = Vec::new();
    for chunk in chunks {
        let is_thought = chunk.is_thought();
        let text = block_text(chunk.block());
        match runs.last_mut() {
            Some(run) if run.is_thought == is_thought => run.text.push_str(&text),
            _ => runs.push(Run { is_thought, text }),
        }
    }
    runs
}

/// The text of a content block.
///
/// A resource link contributes its URI rather than nothing: the agent referred
/// to a file, and dropping the reference would make the transcript read as
/// though it never did. Images have no text and contribute none.
pub fn block_text(block: &ContentBlock) -> String {
    match block {
        ContentBlock::Empty => String::new(),
        ContentBlock::Text(text) => text.clone(),
        ContentBlock::EmbeddedResource { text, .. } => text.clone(),
        ContentBlock::ResourceLink { resource_link } => resource_link.uri.clone(),
        ContentBlock::Image { .. } => String::new(),
    }
}

/// A wire message carrying one assistant run.
pub fn run_message(id: String, run: &Run, model: Option<String>) -> Message {
    let (mode, content, thinking) = if run.is_thought {
        (MessageMode::Thinking, String::new(), run.text.clone())
    } else {
        (MessageMode::Text, run.text.clone(), String::new())
    };
    Message {
        id,
        role: MessageRole::Assistant,
        mode,
        content,
        thinking,
        tool_calls: Vec::new(),
        plan: None,
        model,
        timestamp: chrono::Utc::now(),
    }
}

/// The message a tool call lives in.
///
/// The wire nests tool calls inside a message, so each one gets a message of its
/// own — the same shape the old stack produced (`new_assistant_tool`).
pub fn tool_message(id: String, tool_call: ToolCall, model: Option<String>) -> Message {
    Message {
        id,
        role: MessageRole::Assistant,
        mode: MessageMode::Tool,
        content: String::new(),
        thinking: String::new(),
        tool_calls: vec![tool_call],
        plan: None,
        model,
        timestamp: chrono::Utc::now(),
    }
}

/// Project a thread tool call onto the wire.
///
/// `tool_name` is the field capture canonicalizes on, and all four of its
/// inputs travel (touchpoint #10). The thread carries the agent's real tool
/// name when it sent one; when it did not, this falls back to the display title
/// and then the kind, which is what the old stack always did.
pub fn tool_call(call: &ThreadToolCall, thread: &atlas_acp_thread::AcpThread) -> ToolCall {
    let title = call.label.clone();
    let kind = tool_kind_token(call.kind).to_string();
    ToolCall {
        id: call.id.to_string(),
        tool_name: call
            .tool_name
            .as_ref()
            .map(|name| name.to_string())
            .unwrap_or_else(|| {
                if title.is_empty() {
                    kind.clone()
                } else {
                    title.clone()
                }
            }),
        title: (!title.is_empty()).then(|| title.clone()),
        kind: Some(kind),
        status: tool_status(&call.status),
        arguments: call.raw_input.clone().unwrap_or(serde_json::Value::Null),
        result: tool_result(&call.content, thread),
        locations: call
            .locations
            .iter()
            .map(|location| serde_json::to_value(location).unwrap_or(serde_json::Value::Null))
            .collect(),
        raw_output: call.raw_output.clone(),
        content_blocks: content_blocks(&call.content),
    }
}

/// The human-readable flattening of a tool call's content.
///
/// `None` rather than an empty string when there is nothing text-shaped yet, so
/// a tool call that has only announced itself does not look like one that
/// returned nothing.
///
/// Takes the whole thread because a terminal block carries only an id — that is
/// all the protocol sends — and the output it names lives on the client side,
/// growing after the block was announced. Both the delta stream and the
/// snapshot resolve it the same way, because a snapshot that flattened
/// terminals differently from the deltas applied on top of it is exactly the
/// disagreement [`snapshot_messages`] exists to avoid.
pub fn tool_result(
    content: &[ToolCallContent],
    thread: &atlas_acp_thread::AcpThread,
) -> Option<String> {
    let mut out = String::new();
    for block in content {
        let piece = match block {
            ToolCallContent::ContentBlock(block) => block_text(block),
            // A diff's own text rides in `content_blocks`; the flattening names
            // the file, matching what the old stack put in `result`.
            ToolCallContent::Diff(diff) => diff.path.to_string_lossy().into_owned(),
            // A terminal's output IS this tool call's result — it is what the
            // agent ran the command for. Flattening it here is what puts it in
            // the output pane, and what makes its growth stream as
            // `tool_call_output_chunk` (`tool_call_delta`) rather than
            // re-shipping the whole buffer per tick.
            ToolCallContent::Terminal(id) => thread.terminal_output(id).unwrap_or_default(),
        };
        if piece.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&piece);
    }
    (!out.is_empty()).then_some(out)
}

/// The blocks the UI renders structurally rather than as text.
pub fn content_blocks(content: &[ToolCallContent]) -> Vec<ToolContentBlock> {
    content
        .iter()
        .filter_map(|block| match block {
            ToolCallContent::Diff(diff) => Some(ToolContentBlock::Diff {
                path: diff.path.to_string_lossy().into_owned(),
                old_text: diff.old_text.clone(),
                new_text: diff.new_text.clone(),
            }),
            ToolCallContent::Terminal(id) => Some(ToolContentBlock::Terminal {
                terminal_id: id.to_string(),
            }),
            ToolCallContent::ContentBlock(_) => None,
        })
        .collect()
}

/// The wire has four tool-call states; the thread has seven.
///
/// The three extra ones are all endings the wire calls `failed`: a tool the
/// user rejected, one cancelled with the turn, and one waiting on an answer
/// that never came. `WaitingForConfirmation` maps to `pending` because that is
/// what it is — announced, not started.
pub fn tool_status(status: &ThreadToolCallStatus) -> ToolCallStatus {
    match status {
        ThreadToolCallStatus::Pending | ThreadToolCallStatus::WaitingForConfirmation { .. } => {
            ToolCallStatus::Pending
        }
        ThreadToolCallStatus::InProgress => ToolCallStatus::Running,
        ThreadToolCallStatus::Completed => ToolCallStatus::Completed,
        ThreadToolCallStatus::Failed
        | ThreadToolCallStatus::Rejected
        | ThreadToolCallStatus::Canceled => ToolCallStatus::Failed,
    }
}

/// The protocol's own token for a tool kind, as the wire carries it.
pub fn tool_kind_token(kind: acp::ToolKind) -> &'static str {
    match kind {
        acp::ToolKind::Read => "read",
        acp::ToolKind::Edit => "edit",
        acp::ToolKind::Delete => "delete",
        acp::ToolKind::Move => "move",
        acp::ToolKind::Search => "search",
        acp::ToolKind::Execute => "execute",
        acp::ToolKind::Think => "think",
        acp::ToolKind::Fetch => "fetch",
        acp::ToolKind::SwitchMode => "switch_mode",
        _ => "other",
    }
}

/// Plan entries, as the wire carries them.
pub fn plan_entries(entries: &[atlas_acp_thread::PlanEntry]) -> Vec<PlanEntry> {
    entries
        .iter()
        .map(|entry| PlanEntry {
            content: entry.content.clone(),
            priority: Some(plan_priority(&entry.priority).to_string()),
            status: plan_status(&entry.status).to_string(),
        })
        .collect()
}

fn plan_priority(priority: &acp::PlanEntryPriority) -> &'static str {
    match priority {
        acp::PlanEntryPriority::High => "high",
        acp::PlanEntryPriority::Medium => "medium",
        acp::PlanEntryPriority::Low => "low",
        _ => "medium",
    }
}

fn plan_status(status: &acp::PlanEntryStatus) -> &'static str {
    match status {
        acp::PlanEntryStatus::Pending => "pending",
        acp::PlanEntryStatus::InProgress => "in_progress",
        acp::PlanEntryStatus::Completed => "completed",
        _ => "pending",
    }
}

/// The permission options, as the wire carries them.
///
/// Raw JSON for the same reason the old stack used raw JSON here: the schema
/// types are `#[non_exhaustive]`, and the UI renders the options it is given
/// rather than matching variants. A dropdown's choices flatten to the same
/// array of options, because that is what the permission modal shows.
pub fn permission_options(options: &PermissionOptions) -> serde_json::Value {
    let flattened: Vec<&acp::PermissionOption> = match options {
        PermissionOptions::Flat(options) => options.iter().collect(),
        PermissionOptions::Dropdown(choices)
        | PermissionOptions::DropdownWithPatterns { choices, .. } => choices
            .iter()
            .flat_map(|choice| [&choice.allow, &choice.deny])
            .collect(),
    };
    serde_json::Value::Array(
        flattened
            .into_iter()
            .map(|option| serde_json::to_value(option).unwrap_or(serde_json::Value::Null))
            .collect(),
    )
}

/// The tool call a permission prompt is about, as the wire carries it.
pub fn permission_tool_call(call: &ThreadToolCall) -> serde_json::Value {
    serde_json::json!({
        "toolCallId": call.id.to_string(),
        "title": call.label,
        "kind": tool_kind_token(call.kind),
        "status": "pending",
        "rawInput": call.raw_input.clone().unwrap_or(serde_json::Value::Null),
    })
}

/// The protocol's own stop-reason token.
///
/// Serialised rather than matched so the wire keeps whatever the schema calls
/// it — the frontend consumes these tokens verbatim, and the one time this was
/// hand-formatted it produced `"endturn"` instead of `"end_turn"` (ATL-6).
pub fn stop_reason_token(reason: acp::StopReason) -> String {
    serde_json::to_value(reason)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "end_turn".to_string())
}

/// Every entry in a thread, as the wire's message list.
///
/// This is what `agents_snapshot` answers with, and it is deliberately built
/// from the same functions the delta stream uses. A snapshot assembled any
/// other way could disagree with the deltas that follow it — the frontend
/// paints the snapshot and then applies deltas on top, so a disagreement shows
/// up as a duplicated or missing message rather than as an error.
///
/// User messages DO appear here, unlike on the delta stream: a snapshot is the
/// conversation, and one with the user's half missing is not one. The wire
/// convention that user messages never arrive as *deltas* is about the live
/// stream, where the frontend already added them optimistically.
pub fn snapshot_messages(
    thread: &atlas_acp_thread::AcpThread,
    model: Option<&str>,
) -> Vec<Message> {
    use atlas_acp_thread::AgentThreadEntry;

    let mut out = Vec::new();
    for (ix, entry) in thread.entries().iter().enumerate() {
        match entry {
            AgentThreadEntry::UserMessage(message) => out.push(Message {
                id: format!("msg-{ix}"),
                role: MessageRole::User,
                mode: MessageMode::Text,
                content: block_text(&message.content),
                thinking: String::new(),
                tool_calls: Vec::new(),
                plan: None,
                model: None,
                timestamp: chrono::Utc::now(),
            }),
            AgentThreadEntry::AssistantMessage(message) => {
                for (run_ix, run) in runs(&message.chunks).iter().enumerate() {
                    if run.text.is_empty() {
                        continue;
                    }
                    out.push(run_message(
                        format!("msg-{ix}-{run_ix}"),
                        run,
                        model.map(str::to_string),
                    ));
                }
            }
            AgentThreadEntry::ToolCall(call) => out.push(tool_message(
                format!("msg-{ix}"),
                tool_call(call, thread),
                model.map(str::to_string),
            )),
            // Elicitations are their own UI, driven by `elicitation_requested`;
            // a compaction is a status, not conversation; a completed plan is
            // carried by the snapshot's `plan` field, not as a message.
            AgentThreadEntry::Elicitation(_)
            | AgentThreadEntry::CompletedPlan(_)
            | AgentThreadEntry::ContextCompaction(_) => {}
        }
    }
    out
}

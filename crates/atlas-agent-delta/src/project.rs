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

/// Where one run sits in an entry's chunk list.
///
/// Deliberately carries no text. A streamed assistant message arrives as one
/// `EntryUpdated` per chunk, so anything that rebuilds the whole text to answer
/// "what is new" costs the entire message on every token of it — which is what
/// made assistant streaming quadratic in message length (ATL-223). A caller
/// that only needs the new part asks [`run_span_len`] and [`run_span_tail`],
/// which cost the tail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunSpan {
    pub is_thought: bool,
    pub start: usize,
    pub end: usize,
}

/// Group an assistant entry's chunks into runs, without touching their text.
pub fn run_spans(chunks: &[AssistantMessageChunk]) -> Vec<RunSpan> {
    let mut spans: Vec<RunSpan> = Vec::new();
    for (ix, chunk) in chunks.iter().enumerate() {
        let is_thought = chunk.is_thought();
        match spans.last_mut() {
            Some(span) if span.is_thought == is_thought => span.end = ix + 1,
            _ => spans.push(RunSpan {
                is_thought,
                start: ix,
                end: ix + 1,
            }),
        }
    }
    spans
}

/// The byte length of a span's text, without building it.
pub fn run_span_len(chunks: &[AssistantMessageChunk], span: &RunSpan) -> usize {
    chunks[span.start..span.end]
        .iter()
        .map(|chunk| block_str(chunk.block()).len())
        .sum()
}

/// A span's text from `from` bytes on.
///
/// `None` when `from` is past the end — the text shrank, which the wire has no
/// way to express — or when it does not land on a character boundary. Both are
/// "do not stream this", not "nothing changed".
///
/// Reading the tail against a byte offset instead of comparing strings is safe
/// because a run's text only ever grows at its end: chunks are appended, and
/// `ContentBlock::append` in `atlas-acp-thread` either pushes onto the existing
/// text or replaces a block whose own rendering was the empty string.
pub fn run_span_tail(
    chunks: &[AssistantMessageChunk],
    span: &RunSpan,
    from: usize,
) -> Option<String> {
    let mut seen = 0usize;
    let mut out = String::new();
    for chunk in &chunks[span.start..span.end] {
        let text = block_str(chunk.block());
        let end = seen + text.len();
        if end > from {
            out.push_str(text.get(from.saturating_sub(seen)..)?);
        }
        seen = end;
    }
    (seen >= from).then_some(out)
}

/// Group an assistant entry's chunks into runs, text and all.
///
/// For the paths that need the whole thing — a snapshot, or a run being
/// announced for the first time. Streaming updates go through [`run_spans`].
pub fn runs(chunks: &[AssistantMessageChunk]) -> Vec<Run> {
    run_spans(chunks)
        .into_iter()
        .map(|span| Run {
            text: run_span_tail(chunks, &span, 0).unwrap_or_default(),
            is_thought: span.is_thought,
        })
        .collect()
}

/// The text of a content block.
///
/// A resource link contributes its URI rather than nothing: the agent referred
/// to a file, and dropping the reference would make the transcript read as
/// though it never did. Images have no text and contribute none.
pub fn block_text(block: &ContentBlock) -> String {
    block_str(block).to_string()
}

/// [`block_text`] without the copy. Every variant already owns its text, so a
/// caller that only measures or slices it need not allocate.
pub fn block_str(block: &ContentBlock) -> &str {
    match block {
        ContentBlock::Empty => "",
        ContentBlock::Text(text) => text,
        ContentBlock::EmbeddedResource { text, .. } => text,
        ContentBlock::ResourceLink { resource_link } => &resource_link.uri,
        ContentBlock::Image { .. } => "",
    }
}

/// A wire message carrying one assistant run.
///
/// `timestamp` is passed in rather than minted here: the live stream is
/// building a message that is being said now, but a snapshot is describing one
/// that was said earlier, and a clock read at snapshot time reported every
/// message in a past conversation as sent just now (ATL-221).
pub fn run_message(
    id: String,
    run: &Run,
    model: Option<String>,
    timestamp: chrono::DateTime<chrono::Utc>,
) -> Message {
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
        timestamp,
    }
}

/// The message a tool call lives in.
///
/// The wire nests tool calls inside a message, so each one gets a message of its
/// own — the same shape the old stack produced (`new_assistant_tool`).
pub fn tool_message(
    id: String,
    tool_call: ToolCall,
    model: Option<String>,
    timestamp: chrono::DateTime<chrono::Utc>,
) -> Message {
    Message {
        id,
        role: MessageRole::Assistant,
        mode: MessageMode::Tool,
        content: String::new(),
        thinking: String::new(),
        tool_calls: vec![tool_call],
        plan: None,
        model,
        timestamp,
    }
}

/// Project a thread tool call onto the wire.
///
/// `tool_name` is the field capture canonicalizes on, and all four of its
/// inputs travel (touchpoint #10). The thread carries the agent's real tool
/// name when it sent one; when it did not, this falls back to the display title
/// and then the kind, which is what the old stack always did.
pub fn tool_call(call: &ThreadToolCall, thread: &atlas_acp_thread::AcpThread) -> ToolCall {
    let mut out = tool_call_meta(call);
    out.result = tool_result(&call.content, thread);
    out
}

/// Everything about a tool call except its flattened result.
///
/// Split out because the result is the only field whose cost grows with what a
/// command printed, and the projector needs to know whether anything *else*
/// changed before it can decide to ship only the result's tail (ATL-219).
/// Every field here is bounded by the tool call itself, so building it per
/// output chunk is cheap.
pub fn tool_call_meta(call: &ThreadToolCall) -> ToolCall {
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
        result: None,
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
/// snapshot resolve it the same way, so a resumed transcript shows the same
/// command output the live one did.
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

/// The one terminal a tool call's result is made entirely of, when it is.
///
/// The projector's incremental path is only sound when the whole flattened
/// result IS one terminal's output: with a second block in `content`, growth is
/// not confined to the end of the string, and a byte offset into the previous
/// result names the wrong place.
pub fn sole_terminal(content: &[ToolCallContent]) -> Option<&acp::TerminalId> {
    match content {
        [ToolCallContent::Terminal(id)] => Some(id),
        _ => None,
    }
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
/// from the same functions the delta stream uses — not because the two must
/// agree field for field, but because a second flattening of the same entry is
/// a second thing to keep correct. They already differ where it does not
/// matter: the ids here are positional (`msg-{ix}`, `msg-{ix}-{run_ix}`) while
/// the delta stream mints a uuid per message, and nothing consumes either. The
/// frontend drops snapshot ids on the way in (`snapshot-message.ts`) and
/// matches deltas by `tool_call.id`, never by `message_id`. Do NOT "fix" the id
/// schemes to match each other; `tool_call.id` is the key that actually has to
/// hold, and it is the one worth protecting.
///
/// What the two DO have to agree on is which entries produce a message at all —
/// a run the stream announces and the snapshot skips is a bubble that vanishes
/// on reload (ATL-224). Both skip empty runs.
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
        // The time the thread learned of the entry, not the time this snapshot
        // was taken. Reading the clock here made two snapshots of an unchanged
        // conversation disagree, and collapsed every historical pause to zero
        // (ATL-221). `Utc::now()` remains the fallback only for an entry with
        // no recorded time, which the accessor's contract makes unreachable.
        let at = thread.entry_created_at(ix).unwrap_or_else(chrono::Utc::now);
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
                timestamp: at,
            }),
            AgentThreadEntry::AssistantMessage(message) => {
                // `run_ix` counts over the UNFILTERED list, so skipping an
                // empty run does not shift the ids of the ones after it.
                for (run_ix, run) in runs(&message.chunks).iter().enumerate() {
                    if run.text.is_empty() {
                        continue;
                    }
                    out.push(run_message(
                        format!("msg-{ix}-{run_ix}"),
                        run,
                        model.map(str::to_string),
                        at,
                    ));
                }
            }
            AgentThreadEntry::ToolCall(call) => out.push(tool_message(
                format!("msg-{ix}"),
                tool_call(call, thread),
                model.map(str::to_string),
                at,
            )),
            // Elicitations are their own UI, driven by `elicitation_requested`;
            // a compaction is a status, not conversation; a completed plan is
            // carried by the snapshot's `plan` field, not as a message.
            //
            // `CompletedPlan` has no constructor anywhere in the ported stack
            // today, so this arm is unreachable rather than merely unused; it
            // stays because the match must be exhaustive, and because the
            // variant is the shape a compacted plan would arrive in.
            AgentThreadEntry::Elicitation(_)
            | AgentThreadEntry::CompletedPlan(_)
            | AgentThreadEntry::ContextCompaction(_) => {}
        }
    }
    out
}

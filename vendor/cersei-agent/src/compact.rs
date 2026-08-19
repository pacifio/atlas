//! Auto-compact: context window management for long conversations.
//!
//! When the conversation approaches the context window limit, older messages
//! are summarized to free space while preserving essential context.

use cersei_provider::Provider;
use cersei_types::*;

// ─── Constants ───────────────────────────────────────────────────────────────

/// Fraction of context window that triggers auto-compact.
pub const AUTOCOMPACT_TRIGGER_FRACTION: f64 = 0.90;
/// Number of recent messages to always preserve (never compacted).
pub const KEEP_RECENT_MESSAGES: usize = 10;
/// Max consecutive failures before disabling auto-compact.
pub const MAX_CONSECUTIVE_FAILURES: u32 = 3;
/// Warning threshold (80% of context window).
pub const WARNING_PCT: f64 = 0.80;
/// Critical threshold (95% of context window).
pub const CRITICAL_PCT: f64 = 0.95;

// ─── Types ───────────────────────────────────────────────────────────────────

/// Session-level compaction tracking.
#[derive(Debug, Clone, Default)]
pub struct AutoCompactState {
    pub compaction_count: u32,
    pub consecutive_failures: u32,
    pub disabled: bool,
}

impl AutoCompactState {
    pub fn on_success(&mut self) {
        self.compaction_count += 1;
        self.consecutive_failures = 0;
    }

    pub fn on_failure(&mut self) {
        self.consecutive_failures += 1;
        if self.consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
            self.disabled = true;
        }
    }
}

/// Context window fullness level.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenWarningState {
    /// Below 80% — no action needed.
    Ok,
    /// 80-95% — warn user, consider compacting.
    Warning,
    /// Above 95% — critical, must compact or will fail.
    Critical,
}

/// A semantically coherent group of messages for summarization.
#[derive(Debug, Clone)]
pub struct MessageGroup {
    pub messages: Vec<Message>,
    pub topic_hint: Option<String>,
    pub token_estimate: usize,
}

/// Result of a compaction operation.
#[derive(Debug, Clone)]
pub struct CompactResult {
    pub messages_before: usize,
    pub messages_after: usize,
    pub tokens_freed_estimate: u64,
    pub summary: String,
}

/// What triggered the compaction.
#[derive(Debug, Clone, Copy)]
pub enum CompactTrigger {
    AutoThreshold,
    Manual,
    ContextOverflow,
}

// ─── Token estimation ────────────────────────────────────────────────────────

/// Rough token estimate for a message (~4 chars per token).
pub fn estimate_tokens(text: &str) -> u64 {
    (text.len() as u64) / 4
}

/// ATLAS PATCH (compact-turn-boundary-v1): everything a message costs on
/// the wire — text, tool_use inputs, and tool_result payloads.
/// `get_all_text()` returns only Text blocks, so the previous accounting
/// ignored tool results entirely — and tool output is usually the bulk of
/// a coding session, so compaction triggered far too late (or never) on
/// exactly the sessions that needed it.
pub fn message_wire_text(msg: &Message) -> String {
    match &msg.content {
        MessageContent::Text(t) => t.clone(),
        MessageContent::Blocks(blocks) => {
            let mut out = String::new();
            for b in blocks {
                match b {
                    ContentBlock::Text { text } => out.push_str(text),
                    ContentBlock::ToolUse { input, name, .. } => {
                        out.push_str(name);
                        out.push_str(&input.to_string());
                    }
                    ContentBlock::ToolResult { content, .. } => {
                        if let ToolResultContent::Text(text) = content {
                            out.push_str(text);
                        }
                    }
                    _ => {}
                }
            }
            out
        }
    }
}

/// Estimate tokens for a list of messages.
pub fn estimate_messages_tokens(messages: &[Message]) -> u64 {
    messages
        .iter()
        .map(|m| estimate_tokens(&message_wire_text(m)))
        .sum()
}

/// Get context window size for a model.
pub fn context_window_for_model(model: &str) -> u64 {
    match model {
        m if m.contains("gpt-5") => 1_000_000,
        m if m.contains("gemini") => 1_000_000,
        m if m.starts_with("o1") || m.starts_with("o3") => 200_000,
        m if m.contains("opus") => 200_000,
        m if m.contains("sonnet") => 200_000,
        m if m.contains("haiku") => 200_000,
        m if m.contains("gpt-4o") => 128_000,
        m if m.contains("gpt-4-turbo") => 128_000,
        m if m.contains("gpt-4") => 8_192,
        m if m.contains("gpt-3.5") => 16_385,
        m if m.contains("llama") => 8_192,
        _ => 200_000, // default to large
    }
}

// ─── Warning state ───────────────────────────────────────────────────────────

/// Calculate the token warning state given current usage.
pub fn calculate_token_warning_state(tokens_used: u64, context_limit: u64) -> TokenWarningState {
    if context_limit == 0 {
        return TokenWarningState::Ok;
    }
    let pct = tokens_used as f64 / context_limit as f64;
    if pct >= CRITICAL_PCT {
        TokenWarningState::Critical
    } else if pct >= WARNING_PCT {
        TokenWarningState::Warning
    } else {
        TokenWarningState::Ok
    }
}

// ─── Should compact ──────────────────────────────────────────────────────────

/// Check if compaction should trigger.
pub fn should_compact(tokens_used: u64, context_limit: u64) -> bool {
    should_compact_at(tokens_used, context_limit, AUTOCOMPACT_TRIGGER_FRACTION)
}

/// ATLAS PATCH (model-profile-v1): `should_compact` with a caller-supplied
/// trigger fraction, so the builder's `compact_threshold` knob actually
/// steers the decision. A non-finite or non-positive threshold falls back
/// to the default fraction rather than disabling compaction silently.
pub fn should_compact_at(tokens_used: u64, context_limit: u64, threshold: f64) -> bool {
    if context_limit == 0 {
        return false;
    }
    let threshold = if threshold.is_finite() && threshold > 0.0 {
        threshold
    } else {
        AUTOCOMPACT_TRIGGER_FRACTION
    };
    (tokens_used as f64 / context_limit as f64) >= threshold
}

/// Check if auto-compact should run (considering state/circuit breaker).
pub fn should_auto_compact(tokens_used: u64, context_limit: u64, state: &AutoCompactState) -> bool {
    if state.disabled {
        return false;
    }
    should_compact(tokens_used, context_limit)
}

/// Check if context collapse is needed (emergency, >98%).
pub fn should_context_collapse(tokens_used: u64, context_limit: u64) -> bool {
    if context_limit == 0 {
        return false;
    }
    (tokens_used as f64 / context_limit as f64) >= 0.98
}

// ─── Message grouping ────────────────────────────────────────────────────────

/// Extract a topic hint from messages (first file path or tool name).
fn extract_topic_hint(messages: &[Message]) -> Option<String> {
    for msg in messages {
        for block in msg.content_blocks() {
            match &block {
                ContentBlock::ToolUse { name, input, .. } => {
                    if let Some(path) = input.get("file_path").and_then(|v| v.as_str()) {
                        return Some(path.to_string());
                    }
                    return Some(name.clone());
                }
                _ => {}
            }
        }
    }
    None
}

/// Group messages into semantically coherent chunks at API-round boundaries.
/// Each group = one assistant response + its tool results.
pub fn group_messages_for_compact(messages: &[Message]) -> Vec<MessageGroup> {
    let mut groups: Vec<MessageGroup> = Vec::new();
    let mut current: Vec<Message> = Vec::new();

    for msg in messages {
        current.push(msg.clone());
        // End group at assistant messages that don't have tool use (end of a "round")
        if msg.role == Role::Assistant && !msg.has_tool_use() {
            let token_est = current.iter().map(|m| message_wire_text(m).len() / 4).sum();
            let hint = extract_topic_hint(&current);
            groups.push(MessageGroup {
                messages: std::mem::take(&mut current),
                topic_hint: hint,
                token_estimate: token_est,
            });
        }
    }
    // Leftover messages
    if !current.is_empty() {
        let token_est = current.iter().map(|m| message_wire_text(m).len() / 4).sum();
        let hint = extract_topic_hint(&current);
        groups.push(MessageGroup {
            messages: current,
            topic_hint: hint,
            token_estimate: token_est,
        });
    }
    groups
}

// ─── Turn-boundary split (ATLAS PATCH compact-turn-boundary-v1) ──────────────

/// Pick the split index for compaction: the start of the smallest suffix of
/// whole rounds whose estimated tokens meet `tail_token_budget`. A round is
/// the unit `group_messages_for_compact` produces (assistant response + its
/// tool results), so the cut can never separate a `tool_use` from its
/// `tool_result` — the raw `len - N` split could, and an orphaned
/// tool_result head is an invalid-history API error on Anthropic.
///
/// Returns 0 when there is nothing safe to compact (one round, or the whole
/// history fits the budget) — callers skip compaction on 0.
pub fn split_at_turn_boundary(messages: &[Message], tail_token_budget: u64) -> usize {
    if messages.len() < 2 {
        return 0;
    }
    // A boundary `i` is safe when no tool_use before it pairs with a
    // tool_result at or after it. Round starts are always safe; so is any
    // cut between one completed (call, result) pair and the next inside a
    // long agentic round — which is what saves a single giant round from
    // "no safe boundary, skip compaction, die by overflow".
    let mut unsafe_after: Vec<bool> = vec![false; messages.len() + 1];
    let mut use_pos: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (i, msg) in messages.iter().enumerate() {
        for block in msg.content_blocks() {
            match &block {
                ContentBlock::ToolUse { id, .. } => {
                    use_pos.insert(id.clone(), i);
                }
                ContentBlock::ToolResult { tool_use_id, .. } => {
                    if let Some(&u) = use_pos.get(tool_use_id) {
                        // Splitting anywhere in (u, i] separates the pair.
                        for slot in unsafe_after.iter_mut().take(i + 1).skip(u + 1) {
                            *slot = true;
                        }
                    }
                }
                _ => {}
            }
        }
    }

    // Walk from the end accumulating tail tokens; the first index (scanning
    // toward the head) whose tail meets the budget is the wanted cut,
    // widened to the nearest safe boundary at or before it.
    let mut tail_tokens: u64 = 0;
    for i in (1..messages.len()).rev() {
        tail_tokens += estimate_tokens(&message_wire_text(&messages[i]));
        if tail_tokens >= tail_token_budget {
            let mut cut = i;
            while cut > 0 && unsafe_after[cut] {
                cut -= 1;
            }
            return cut;
        }
    }

    // ATLAS PATCH (compact-oversized-head-v1): the walk can exhaust for two
    // very different reasons, and returning 0 for both was wrong for one of
    // them.
    //
    // If the whole history fits the tail budget there is genuinely nothing to
    // do. But if the bulk sits in `messages[0]` — a large pasted first prompt
    // on a small-window model — the tail never reaches the budget even though
    // cutting at 1 would free exactly the oversized head. Answering "nothing
    // safe to compact" there made the caller re-run the entire compaction
    // block every model round for the rest of the session (pre-compact hook,
    // CompactStart/CompactEnd, "compact skipped") while freeing nothing, until
    // the session died by context overflow.
    let head_tokens = estimate_tokens(&message_wire_text(&messages[0]));
    if head_tokens + tail_tokens <= tail_token_budget {
        return 0; // It all fits. Leave it alone.
    }
    // Compact as much of the head as a pair-safe cut allows: the earliest safe
    // boundary at or after 1.
    (1..messages.len()).find(|&i| !unsafe_after[i]).unwrap_or(0)
}

/// The recent-tail token budget for a context window: a quarter of the
/// window, clamped to [2k, 15k] tokens. Token-based, not message-count —
/// ten huge tool results are not the same tail as ten one-liners.
pub fn tail_token_budget(context_window: u64) -> u64 {
    (context_window / 4).clamp(2_000, 15_000)
}

/// File paths touched by write-class tools in `messages`, deduplicated in
/// first-touch order and capped. Carried into the summary message
/// mechanically — the one list the summarizer must not be trusted to
/// reconstruct.
pub fn file_ops(messages: &[Message]) -> Vec<String> {
    const WRITE_TOOLS: [&str; 4] = ["Edit", "Write", "NotebookEdit", "ApplyPatch"];
    const CAP: usize = 30;
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for msg in messages {
        for block in msg.content_blocks() {
            if let ContentBlock::ToolUse { name, input, .. } = &block {
                if !WRITE_TOOLS.contains(&name.as_str()) {
                    continue;
                }
                if let Some(path) = input.get("file_path").and_then(|v| v.as_str()) {
                    if seen.insert(path.to_string()) {
                        out.push(path.to_string());
                        if out.len() >= CAP {
                            return out;
                        }
                    }
                }
            }
        }
    }
    out
}

// ─── Snip compact (simple truncation) ────────────────────────────────────────

/// Remove oldest messages, keeping only the newest `keep_n`.
/// Returns (remaining messages, estimated tokens freed).
pub fn snip_compact(messages: Vec<Message>, keep_n: usize) -> (Vec<Message>, u64) {
    if messages.len() <= keep_n {
        return (messages, 0);
    }
    let removed = &messages[..messages.len() - keep_n];
    let freed = estimate_messages_tokens(removed);
    let kept = messages[messages.len() - keep_n..].to_vec();
    (kept, freed)
}

/// ATLAS PATCH (compact-turn-boundary-v1): snip at an explicit index — the
/// fallback when summarization fails must respect the same turn boundary
/// the summarizer would have, or the "safe" fallback is the one that
/// orphans a tool_result.
pub fn snip_compact_at(messages: Vec<Message>, split_idx: usize) -> (Vec<Message>, u64) {
    if split_idx == 0 || split_idx >= messages.len() {
        return (messages, 0);
    }
    let freed = estimate_messages_tokens(&messages[..split_idx]);
    (messages[split_idx..].to_vec(), freed)
}

/// Calculate how many messages to keep given a token budget.
pub fn calculate_messages_to_keep_index(messages: &[Message], token_budget: u64) -> usize {
    let mut total: u64 = 0;
    for (i, msg) in messages.iter().rev().enumerate() {
        total += estimate_tokens(&msg.get_all_text());
        if total > token_budget {
            return messages.len() - i;
        }
    }
    0 // keep all
}

// ─── Collapse strategies ─────────────────────────────────────────────────────

/// Collapse repeated file read results: if the same file is read multiple
/// times, only keep the latest result.
pub fn collapse_read_tool_results(messages: Vec<Message>) -> Vec<Message> {
    let mut seen_files: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut result: Vec<Message> = Vec::new();

    // Process in reverse to keep latest reads
    for msg in messages.into_iter().rev() {
        let dominated = match &msg.content {
            MessageContent::Blocks(blocks) => {
                blocks.iter().all(|b| {
                    if let ContentBlock::ToolResult {
                        tool_use_id,
                        content,
                        ..
                    } = b
                    {
                        // Check if this is a file read result we've already seen
                        if let ToolResultContent::Text(text) = content {
                            if text.contains('\t') {
                                // Line-numbered output = file read
                                let key = tool_use_id.clone();
                                if seen_files.contains(&key) {
                                    return true; // dominated, skip
                                }
                                seen_files.insert(key);
                            }
                        }
                        false
                    } else {
                        false
                    }
                })
            }
            _ => false,
        };

        if !dominated {
            result.push(msg);
        }
    }

    result.reverse();
    result
}

// ─── Compact prompt ──────────────────────────────────────────────────────────

/// Build the compaction prompt for the LLM.
///
/// ATLAS PATCH (compact-turn-boundary-v1): a structured, iteratively-updated
/// working summary (Pi's template shape) instead of freeform bullets. The
/// fixed section skeleton is what makes iterative updating possible — the
/// next compaction hands the previous summary back and asks for an update
/// in place, so long sessions converge on one living document instead of a
/// summary of a summary of a summary.
pub fn get_compact_prompt(custom_instructions: Option<&str>) -> String {
    let mut prompt = String::from(
        "Produce a working summary of the conversation as markdown with exactly these sections:\n\
        ## Goal\n## Constraints\n## Key decisions\n## Progress\n## Errors and fixes\n## Next steps\n\n\
        Be concise but preserve every actionable fact. Include file paths, commands, \
        and identifiers verbatim. If a current summary is provided above, update it in \
        place: carry forward what is still true, fold in what changed, and drop only \
        what is fully resolved.",
    );
    if let Some(instructions) = custom_instructions {
        prompt.push_str("\n\nAdditional context: ");
        prompt.push_str(instructions);
    }
    prompt
}

/// ATLAS PATCH (compact-tool-evidence-v1): the most one message may
/// contribute to the summarizer's input.
///
/// Head and tail both, for the same reason the shell tool caps that way: a
/// build log's beginning says what ran and its end says what failed, and the
/// end is the half a head-only cut throws away.
const SUMMARY_PER_MESSAGE_BUDGET: usize = 4_000;

fn clamp_for_summary(text: &str) -> String {
    if text.len() <= SUMMARY_PER_MESSAGE_BUDGET {
        return text.to_string();
    }
    let half = SUMMARY_PER_MESSAGE_BUDGET / 2;
    let head_end = floor_char_boundary(text, half);
    let tail_start = ceil_char_boundary(text, text.len() - half);
    format!(
        "{}\n…[{} bytes omitted]…\n{}",
        &text[..head_end],
        tail_start - head_end,
        &text[tail_start..]
    )
}

/// Largest index `<= at` that lands on a UTF-8 char boundary.
fn floor_char_boundary(s: &str, at: usize) -> usize {
    let mut i = at.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Smallest index `>= at` that lands on a UTF-8 char boundary.
fn ceil_char_boundary(s: &str, at: usize) -> usize {
    let mut i = at.min(s.len());
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// ATLAS PATCH (compact-turn-boundary-v1): the request
/// `compact_conversation` sends, factored out so the shape —
/// previous-summary carryover included — is testable without a provider.
pub fn build_compact_request(
    old_messages: &[Message],
    model: &str,
    custom_instructions: Option<&str>,
) -> cersei_provider::CompletionRequest {
    // Iterative update: if the history already starts with a summary from a
    // previous compaction, hand it back separately so the model updates it
    // instead of re-summarizing its own summary.
    let (prev_summary, fresh) = match old_messages.first() {
        Some(first) if first.get_all_text().trim_start().starts_with("<context_summary>") => {
            (Some(first.get_all_text()), &old_messages[1..])
        }
        _ => (None, old_messages),
    };

    let old_text: String = fresh
        .iter()
        .map(|m| {
            let role = match m.role {
                Role::User => "User",
                Role::Assistant => "Assistant",
                Role::System => "System",
            };
            // ATLAS PATCH (compact-tool-evidence-v1): the wire text, not
            // `get_all_text()`. The latter returns Text blocks only, so the
            // summarizer was handed the assistant's prose with every tool_use
            // input and tool_result payload stripped out — in a coding session
            // that is nearly everything that happened. "Progress" and "Errors
            // and fixes" were being written from no evidence, and the model
            // then continued on that summary for the rest of the session.
            // Bounded per message so one huge result cannot consume the
            // summarizer's own window and fail the call into the snip fallback.
            format!("{}: {}", role, clamp_for_summary(&message_wire_text(m)))
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    let mut body = String::new();
    if let Some(prev) = prev_summary {
        body.push_str("Current summary to update:\n\n");
        body.push_str(&prev);
        body.push_str("\n\n");
    }
    body.push_str("Conversation since then:\n\n");
    body.push_str(&old_text);
    body.push_str("\n\n");
    body.push_str(&get_compact_prompt(custom_instructions));

    cersei_provider::CompletionRequest {
        model: model.to_string(),
        messages: vec![Message::user(body)],
        system: Some(
            "You are a conversation summarizer. Be concise and preserve all actionable information."
                .into(),
        ),
        tools: Vec::new(),
        max_tokens: 4096,
        temperature: Some(0.0),
        stop_sequences: Vec::new(),
        options: cersei_provider::ProviderOptions::default(),
    }
}

/// Format raw compact output into a summary message.
pub fn format_compact_summary(raw: &str) -> String {
    format!(
        "<context_summary>\n\
        The following is a summary of the conversation so far:\n\n\
        {}\n\
        </context_summary>",
        raw.trim()
    )
}

// ─── Full compaction (requires provider call) ────────────────────────────────

/// Compact the conversation by summarizing older messages.
///
/// 1. Split messages into "old" (to compact) and "recent" (to keep)
/// 2. Group old messages by topic
/// 3. Send to provider for summarization
/// 4. Replace old messages with summary
/// ATLAS PATCH (compact-turn-boundary-v1): takes an explicit `split_idx`
/// (from [`split_at_turn_boundary`]) instead of a trailing message count,
/// builds the iterative-update request, and appends the mechanical
/// file-op list to the summary.
pub async fn compact_conversation(
    provider: &dyn Provider,
    messages: &[Message],
    model: &str,
    split_idx: usize,
    custom_instructions: Option<&str>,
) -> Result<CompactResult> {
    let messages_before = messages.len();

    if split_idx == 0 || split_idx >= messages.len() {
        return Ok(CompactResult {
            messages_before,
            messages_after: messages_before,
            tokens_freed_estimate: 0,
            summary: String::new(),
        });
    }

    let old_messages = &messages[..split_idx];
    let recent_messages = &messages[split_idx..];

    let request = build_compact_request(old_messages, model, custom_instructions);

    // Collect streaming response into a complete message
    let stream = provider.complete(request).await?;
    let mut rx = stream.into_receiver();
    let mut accumulator = cersei_provider::StreamAccumulator::new();
    while let Some(event) = rx.recv().await {
        accumulator.process_event(event);
    }
    let response = accumulator.into_response()?;
    let summary_text = response.message.get_all_text();
    let mut formatted_summary = format_compact_summary(&summary_text);

    // File-op carryover: the paths the session wrote, listed mechanically —
    // a summarizer that forgets one silently orphans the model's memory of
    // its own change.
    let touched = file_ops(old_messages);
    if !touched.is_empty() {
        formatted_summary.push_str("\n<files_touched>\n");
        for path in &touched {
            formatted_summary.push_str("- ");
            formatted_summary.push_str(path);
            formatted_summary.push('\n');
        }
        formatted_summary.push_str("</files_touched>");
    }

    let tokens_freed = estimate_messages_tokens(old_messages);
    let messages_after = 1 + recent_messages.len();

    Ok(CompactResult {
        messages_before,
        messages_after,
        tokens_freed_estimate: tokens_freed,
        summary: formatted_summary,
    })
}

/// Check and run auto-compact if needed. Returns None if no compaction needed.
pub async fn auto_compact_if_needed(
    provider: &dyn Provider,
    messages: &[Message],
    model: &str,
    tokens_used: u64,
    state: &mut AutoCompactState,
) -> Option<CompactResult> {
    let context_limit = context_window_for_model(model);
    if !should_auto_compact(tokens_used, context_limit, state) {
        return None;
    }

    let split_idx = split_at_turn_boundary(messages, tail_token_budget(context_limit));
    match compact_conversation(provider, messages, model, split_idx, None).await {
        Ok(result) => {
            state.on_success();
            Some(result)
        }
        Err(_) => {
            state.on_failure();
            None
        }
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_compact_at_honors_the_threshold_and_falls_back_on_nonsense() {
        // ATLAS PATCH (model-profile-v1)
        assert!(should_compact_at(75, 100, 0.75));
        assert!(!should_compact_at(74, 100, 0.75));
        // Non-finite / non-positive thresholds fall back to the default
        // fraction instead of disabling compaction.
        assert!(should_compact_at(90, 100, 0.0));
        assert!(should_compact_at(90, 100, f64::NAN));
        assert!(!should_compact_at(89, 100, -1.0));
        // A zero window never compacts.
        assert!(!should_compact_at(90, 0, 0.5));
    }

    fn make_messages(n: usize) -> Vec<Message> {
        (0..n)
            .map(|i| {
                if i % 2 == 0 {
                    Message::user(format!("User message {}", i))
                } else {
                    Message::assistant(format!("Assistant response {} with some longer text to simulate real content that takes up tokens in the context window.", i))
                }
            })
            .collect()
    }

    #[test]
    fn test_token_warning_ok() {
        assert_eq!(
            calculate_token_warning_state(50_000, 200_000),
            TokenWarningState::Ok
        );
    }

    #[test]
    fn test_token_warning_warning() {
        assert_eq!(
            calculate_token_warning_state(170_000, 200_000),
            TokenWarningState::Warning
        );
    }

    #[test]
    fn test_token_warning_critical() {
        assert_eq!(
            calculate_token_warning_state(196_000, 200_000),
            TokenWarningState::Critical
        );
    }

    #[test]
    fn test_should_compact() {
        assert!(!should_compact(100_000, 200_000)); // 50%
        assert!(!should_compact(170_000, 200_000)); // 85%
        assert!(should_compact(185_000, 200_000)); // 92.5%
        assert!(should_compact(195_000, 200_000)); // 97.5%
    }

    #[test]
    fn test_should_auto_compact_disabled() {
        let state = AutoCompactState {
            disabled: true,
            ..Default::default()
        };
        assert!(!should_auto_compact(195_000, 200_000, &state));
    }

    #[test]
    fn test_circuit_breaker() {
        let mut state = AutoCompactState::default();
        state.on_failure();
        state.on_failure();
        assert!(!state.disabled);
        state.on_failure(); // 3rd failure
        assert!(state.disabled);
    }

    #[test]
    fn test_snip_compact() {
        let messages = make_messages(20);
        let (kept, freed) = snip_compact(messages, 10);
        assert_eq!(kept.len(), 10);
        assert!(freed > 0);
    }

    #[test]
    fn test_snip_compact_already_small() {
        let messages = make_messages(5);
        let (kept, freed) = snip_compact(messages, 10);
        assert_eq!(kept.len(), 5);
        assert_eq!(freed, 0);
    }

    #[test]
    fn test_group_messages() {
        let mut messages = Vec::new();
        messages.push(Message::user("Read file A"));
        messages.push(Message::assistant("Contents of A"));
        messages.push(Message::user("Now edit B"));
        messages.push(Message::assistant("Edited B"));

        let groups = group_messages_for_compact(&messages);
        assert_eq!(groups.len(), 2);
    }

    #[test]
    fn test_estimate_tokens() {
        assert_eq!(estimate_tokens("hello world"), 2); // 11 chars / 4
        assert_eq!(estimate_tokens(""), 0);
        assert!(estimate_tokens(&"x".repeat(1000)) > 200);
    }

    #[test]
    fn test_context_window_for_model() {
        assert_eq!(context_window_for_model("claude-sonnet-4-6"), 200_000);
        assert_eq!(context_window_for_model("gpt-4o"), 128_000);
        assert_eq!(context_window_for_model("gpt-4"), 8_192);
    }

    #[test]
    fn test_compact_prompt_with_instructions() {
        let prompt = get_compact_prompt(Some("Focus on API changes"));
        assert!(prompt.contains("Focus on API changes"));
        // The structured template's fixed skeleton (what makes iterative
        // updating possible).
        for section in ["## Goal", "## Key decisions", "## Next steps"] {
            assert!(prompt.contains(section), "missing {section}");
        }
    }

    #[test]
    fn test_format_compact_summary() {
        let summary = format_compact_summary("- Did X\n- Did Y");
        assert!(summary.contains("<context_summary>"));
        assert!(summary.contains("- Did X"));
    }

    #[test]
    fn test_calculate_messages_to_keep_index() {
        let messages = make_messages(20);
        let idx = calculate_messages_to_keep_index(&messages, 100);
        assert!(idx > 0);
        assert!(idx < 20);
    }

    #[test]
    fn test_messages_to_keep_all_fit() {
        let messages = make_messages(3);
        let idx = calculate_messages_to_keep_index(&messages, 100_000);
        assert_eq!(idx, 0); // keep all
    }

    // ─── ATLAS PATCH (compact-turn-boundary-v1) tests ────────────────────

    /// A realistic round shape: user prompt, assistant with tool_use, user
    /// tool_result, assistant text (round end).
    fn tool_round(filler: usize) -> Vec<Message> {
        tool_round_with_id(filler, "t1")
    }

    fn tool_round_with_id(filler: usize, id: &str) -> Vec<Message> {
        use serde_json::json;
        let big = "x".repeat(filler);
        vec![
            Message::user("do the thing"),
            Message::assistant_blocks(vec![ContentBlock::ToolUse {
                id: id.into(),
                name: "Edit".into(),
                input: json!({"file_path": "src/lib.rs"}),
            }]),
            Message::user_blocks(vec![ContentBlock::ToolResult {
                tool_use_id: id.into(),
                content: ToolResultContent::Text(big),
                is_error: Some(false),
            }]),
            Message::assistant("done"),
        ]
    }

    #[test]
    fn the_split_never_separates_a_tool_use_from_its_result() {
        // Three rounds; a budget that forces a cut somewhere in the middle.
        let mut messages = Vec::new();
        for i in 0..3 {
            messages.extend(tool_round_with_id(4_000, &format!("t{i}")));
        }
        let split = split_at_turn_boundary(&messages, 1_500);
        assert!(split > 0, "a cut must exist");
        // No tool_use before the cut may pair with a tool_result after it.
        let ids_before: Vec<String> = messages[..split]
            .iter()
            .flat_map(|m| m.content_blocks())
            .filter_map(|b| match b {
                ContentBlock::ToolUse { id, .. } => Some(id.clone()),
                _ => None,
            })
            .collect();
        for m in &messages[split..] {
            for b in m.content_blocks() {
                if let ContentBlock::ToolResult { tool_use_id, .. } = b {
                    assert!(
                        !ids_before.contains(&tool_use_id),
                        "orphaned tool_result {tool_use_id}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_giant_single_turn_still_finds_a_pair_safe_cut() {
        // One continuous agentic turn — no plain assistant message ever ends
        // a round. The old group-based split returned 0 here and compaction
        // skipped forever; pair-safe boundaries keep it splittable.
        use serde_json::json;
        let mut messages = vec![Message::user("go")];
        for i in 0..5 {
            messages.push(Message::assistant_blocks(vec![ContentBlock::ToolUse {
                id: format!("t{i}"),
                name: "Bash".into(),
                input: json!({"command": "x"}),
            }]));
            messages.push(Message::user_blocks(vec![ContentBlock::ToolResult {
                tool_use_id: format!("t{i}"),
                content: ToolResultContent::Text("y".repeat(8_000)),
                is_error: Some(false),
            }]));
        }
        let split = split_at_turn_boundary(&messages, 2_000);
        assert!(split > 0, "a giant turn must still split");
        // And the cut is pair-safe: no tool_use before it answers after it.
        let ids_before: Vec<String> = messages[..split]
            .iter()
            .flat_map(|m| m.content_blocks())
            .filter_map(|b| match b {
                ContentBlock::ToolUse { id, .. } => Some(id.clone()),
                _ => None,
            })
            .collect();
        for m in &messages[split..] {
            for b in m.content_blocks() {
                if let ContentBlock::ToolResult { tool_use_id, .. } = b {
                    assert!(!ids_before.contains(&tool_use_id), "orphan at cut {split}");
                }
            }
        }
    }

    #[test]
    fn a_single_round_or_a_fitting_history_never_splits() {
        let messages = tool_round(1_000);
        assert_eq!(split_at_turn_boundary(&messages, 2_000), 0, "one round");
        let mut messages = Vec::new();
        for _ in 0..3 {
            messages.extend(tool_round(100));
        }
        assert_eq!(
            split_at_turn_boundary(&messages, 1_000_000),
            0,
            "everything fits the tail budget"
        );
    }

    #[test]
    fn the_tail_budget_is_a_quarter_window_clamped() {
        assert_eq!(tail_token_budget(8_000), 2_000);
        assert_eq!(tail_token_budget(4_000), 2_000, "floor");
        assert_eq!(tail_token_budget(40_000), 10_000);
        assert_eq!(tail_token_budget(1_000_000), 15_000, "ceiling");
    }

    #[test]
    fn file_ops_collects_write_class_paths_deduped_in_order() {
        use serde_json::json;
        let mk = |name: &str, path: &str| {
            Message::assistant_blocks(vec![ContentBlock::ToolUse {
                id: "i".into(),
                name: name.into(),
                input: json!({"file_path": path}),
            }])
        };
        let messages = vec![
            mk("Edit", "a.rs"),
            mk("Read", "ignored.rs"),
            mk("Write", "b.rs"),
            mk("Edit", "a.rs"),
        ];
        assert_eq!(file_ops(&messages), vec!["a.rs".to_string(), "b.rs".to_string()]);
    }

    #[test]
    fn a_previous_summary_is_handed_back_for_iterative_update() {
        let prev = Message::user("<context_summary>\nold summary\n</context_summary>");
        let fresh = Message::assistant("new work happened");
        let req = build_compact_request(&[prev, fresh], "m", None);
        let body = req.messages[0].get_all_text();
        assert!(body.contains("Current summary to update:"), "{body}");
        assert!(body.contains("old summary"));
        assert!(body.contains("new work happened"));

        // Without one, no update preamble.
        let req = build_compact_request(&[Message::user("hi")], "m", None);
        assert!(!req.messages[0].get_all_text().contains("Current summary to update"));
    }

    #[test]
    fn an_oversized_head_still_finds_a_cut() {
        // The reverse walk only ever returns a cut once the *tail* reaches the
        // budget. When the bulk sits in `messages[0]` — a large pasted first
        // prompt on a small-window model — the tail never gets there and the
        // function returned 0, i.e. "nothing safe to compact", even though
        // cutting at 1 would free exactly the oversized head.
        //
        // The caller then re-ran the whole compaction block every model round
        // for the rest of the session: pre-compact hook (enqueuing a memory
        // extraction job each time), CompactStart/CompactEnd (so Atlas's
        // read-registry reset wiped repeat-read suppression every round), and
        // "compact skipped" — while freeing nothing, until the session died by
        // context overflow. Which is the failure compaction exists to prevent.
        let messages = vec![
            Message::user(&"x".repeat(200_000)),
            Message::assistant("ok"),
            Message::user("go on"),
        ];
        let split = split_at_turn_boundary(&messages, tail_token_budget(32_768));
        assert!(
            split > 0,
            "an oversized head must be compactable, got {split}"
        );
        assert!(split < messages.len(), "the cut must leave a tail");
    }

    #[test]
    fn a_history_that_fits_is_still_left_alone() {
        // The other half of the same branch: exhausting the walk because
        // everything fits must still mean "do not compact", or every small
        // session pays for a pointless summarizer call.
        let messages = vec![
            Message::user("hi"),
            Message::assistant("hello"),
            Message::user("bye"),
        ];
        assert_eq!(split_at_turn_boundary(&messages, tail_token_budget(200_000)), 0);
    }

    #[test]
    fn the_summarizer_sees_tool_evidence_not_just_prose() {
        use serde_json::json;
        // `get_all_text()` returns Text blocks only, so the summarizer was
        // handed the assistant's prose with every tool_use input and
        // tool_result payload removed — in a coding session that is nearly
        // everything that happened. The living summary's "Progress" and
        // "Errors and fixes" sections were being written from no evidence,
        // and the model then continued on that summary. This module already
        // has `message_wire_text` for exactly this reason; the request
        // builder just never used it.
        let history = vec![
            Message::user("fix the build"),
            Message::assistant_blocks(vec![ContentBlock::ToolUse {
                id: "t1".into(),
                name: "Bash".into(),
                input: json!({"command": "cargo build"}),
            }]),
            Message::user_blocks(vec![ContentBlock::ToolResult {
                tool_use_id: "t1".into(),
                content: ToolResultContent::Text(
                    "error[E0308]: mismatched types in widget.rs".into(),
                ),
                is_error: Some(true),
            }]),
        ];
        let body = build_compact_request(&history, "m", None).messages[0].get_all_text();
        assert!(
            body.contains("E0308") && body.contains("widget.rs"),
            "the failure the turn was about is missing from the summarizer input: {body}"
        );
        assert!(body.contains("cargo build"), "the command that ran is missing: {body}");
    }

    #[test]
    fn one_huge_tool_result_cannot_blow_the_summarizer_window() {
        // The summarizer request has its own budget; a single multi-megabyte
        // result must not consume it (or the provider rejects the call and
        // compaction silently degrades to snip).
        let huge = "x".repeat(400_000);
        let history = vec![Message::user_blocks(vec![ContentBlock::ToolResult {
            tool_use_id: "t1".into(),
            content: ToolResultContent::Text(huge),
            is_error: None,
        }])];
        let body = build_compact_request(&history, "m", None).messages[0].get_all_text();
        assert!(
            body.len() < 40_000,
            "per-message contribution is unbounded: {} bytes",
            body.len()
        );
        assert!(body.contains('x'), "the result should still be represented");
    }

    #[test]
    fn snip_at_index_frees_the_head_and_refuses_nonsense() {
        let messages = tool_round(100);
        let (kept, freed) = snip_compact_at(messages.clone(), 0);
        assert_eq!(kept.len(), 4);
        assert_eq!(freed, 0);
        let (kept, freed) = snip_compact_at(messages, 2);
        assert_eq!(kept.len(), 2);
        assert!(freed > 0);
    }

}

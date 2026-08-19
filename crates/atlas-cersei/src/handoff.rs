//! M5 — cross-provider history transform (Pi's `transform-messages`
//! move, sized to Atlas).
//!
//! A session's history is written in one provider's dialect. Replaying it
//! verbatim to a different provider breaks in known ways:
//!
//! - **Thinking blocks** carry provider-specific signatures that other
//!   providers reject; the reasoning itself is still useful context.
//! - **Tool-call ids** have per-provider grammars (Anthropic: ≤64 chars of
//!   `[A-Za-z0-9_-]`); a foreign id fails validation.
//! - **Orphans** — a `tool_use` with no result (crash, cancel mid-round) or
//!   a `tool_result` whose call was compacted away — are invalid-history
//!   API errors.
//!
//! [`transform_history`] repairs all three, and runs at the two moments a
//! history changes hands: `set_model` onto a different provider, and
//! `load_session` (a restored history may carry crash orphans whatever the
//! provider). It is idempotent — running it twice changes nothing.

use cersei::types::{ContentBlock, Message, MessageContent, ToolResultContent};

/// Repair `messages` for replay to `provider`. See the module doc.
pub fn transform_history(messages: Vec<Message>, provider: &str) -> Vec<Message> {
    let _ = provider; // one grammar today — the strictest (Anthropic's).
    let mut out: Vec<Message> = Vec::new();

    // Pass 1: thinking → text, id normalization, and collect the id sets.
    let mut rename: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut counter = 0usize;
    let mut normalized: Vec<Message> = Vec::new();
    for msg in messages {
        let content = match msg.content {
            MessageContent::Text(t) => MessageContent::Text(t),
            MessageContent::Blocks(blocks) => {
                let mut kept: Vec<ContentBlock> = Vec::new();
                for block in blocks {
                    match block {
                        // The reasoning stays as context; the signature —
                        // which only its original provider can verify —
                        // does not survive the conversion.
                        ContentBlock::Thinking { thinking, .. } => {
                            if !thinking.trim().is_empty() {
                                kept.push(ContentBlock::Text {
                                    text: format!("[prior reasoning]\n{thinking}"),
                                });
                            }
                        }
                        // Encrypted reasoning is unreadable off-provider.
                        ContentBlock::RedactedThinking { .. } => {}
                        ContentBlock::ToolUse { id, name, input } => {
                            let id = normalize_id(id, &mut rename, &mut counter);
                            kept.push(ContentBlock::ToolUse { id, name, input });
                        }
                        ContentBlock::ToolResult { tool_use_id, content, is_error } => {
                            let tool_use_id =
                                normalize_id(tool_use_id, &mut rename, &mut counter);
                            kept.push(ContentBlock::ToolResult { tool_use_id, content, is_error });
                        }
                        other => kept.push(other),
                    }
                }
                MessageContent::Blocks(kept)
            }
        };
        normalized.push(Message { content, ..msg });
    }

    // Pass 2: orphan repair. Results with no matching call are dropped;
    // calls with no result get a synthetic interrupted-error result
    // immediately after their message.
    let use_ids: std::collections::HashSet<String> = normalized
        .iter()
        .flat_map(|m| m.content_blocks())
        .filter_map(|b| match b {
            ContentBlock::ToolUse { id, .. } => Some(id.clone()),
            _ => None,
        })
        .collect();
    let answered: std::collections::HashSet<String> = normalized
        .iter()
        .flat_map(|m| m.content_blocks())
        .filter_map(|b| match b {
            ContentBlock::ToolResult { tool_use_id, .. } => Some(tool_use_id.clone()),
            _ => None,
        })
        .collect();

    for msg in normalized {
        let msg = match msg.content {
            MessageContent::Blocks(blocks) => {
                let kept: Vec<ContentBlock> = blocks
                    .into_iter()
                    .filter(|b| match b {
                        ContentBlock::ToolResult { tool_use_id, .. } => {
                            use_ids.contains(tool_use_id)
                        }
                        _ => true,
                    })
                    .collect();
                if kept.is_empty() {
                    continue; // a message reduced to nothing is dropped
                }
                Message { content: MessageContent::Blocks(kept), ..msg }
            }
            MessageContent::Text(t) if t.is_empty() => continue,
            content => Message { content, ..msg },
        };

        // Synthetic results for this message's unanswered calls, inserted
        // directly after so the pairing is adjacent.
        let unanswered: Vec<String> = msg
            .content_blocks()
            .iter()
            .filter_map(|b| match b {
                ContentBlock::ToolUse { id, .. } if !answered.contains(id) => Some(id.clone()),
                _ => None,
            })
            .collect();
        out.push(msg);
        if !unanswered.is_empty() {
            out.push(Message::user_blocks(
                unanswered
                    .into_iter()
                    .map(|id| ContentBlock::ToolResult {
                        tool_use_id: id,
                        content: ToolResultContent::Text(
                            "[Tool call was interrupted before it produced a result.]".into(),
                        ),
                        is_error: Some(true),
                    })
                    .collect(),
            ));
        }
    }
    out
}

/// The strictest provider grammar: ≤64 chars of `[A-Za-z0-9_-]`. A
/// conforming id passes through; anything else maps to a stable synthetic
/// id, consistently for the call and its result.
fn normalize_id(
    id: String,
    rename: &mut std::collections::HashMap<String, String>,
    counter: &mut usize,
) -> String {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if valid {
        return id;
    }
    rename
        .entry(id)
        .or_insert_with(|| {
            *counter += 1;
            format!("call_{counter:04}")
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool_use(id: &str) -> Message {
        Message::assistant_blocks(vec![ContentBlock::ToolUse {
            id: id.into(),
            name: "Read".into(),
            input: json!({"file_path": "a.rs"}),
        }])
    }

    fn tool_result(id: &str) -> Message {
        Message::user_blocks(vec![ContentBlock::ToolResult {
            tool_use_id: id.into(),
            content: ToolResultContent::Text("ok".into()),
            is_error: Some(false),
        }])
    }

    fn all_blocks(messages: &[Message]) -> Vec<ContentBlock> {
        messages.iter().flat_map(|m| m.content_blocks()).collect()
    }

    #[test]
    fn thinking_becomes_text_and_redacted_thinking_disappears() {
        let messages = vec![Message::assistant_blocks(vec![
            ContentBlock::Thinking { thinking: "step by step".into(), signature: "sig".into() },
            ContentBlock::RedactedThinking { data: "opaque".into() },
            ContentBlock::Text { text: "answer".into() },
        ])];
        let out = transform_history(messages, "openai");
        let blocks = all_blocks(&out);
        assert_eq!(blocks.len(), 2);
        assert!(matches!(&blocks[0], ContentBlock::Text { text } if text.contains("step by step")));
        assert!(matches!(&blocks[1], ContentBlock::Text { text } if text == "answer"));
    }

    #[test]
    fn foreign_tool_ids_are_renamed_consistently_across_use_and_result() {
        let bad = "fc/call:with weird·chars"; // fails the grammar
        let out = transform_history(vec![tool_use(bad), tool_result(bad)], "anthropic");
        let blocks = all_blocks(&out);
        let (use_id, result_id) = match (&blocks[0], &blocks[1]) {
            (
                ContentBlock::ToolUse { id, .. },
                ContentBlock::ToolResult { tool_use_id, .. },
            ) => (id.clone(), tool_use_id.clone()),
            other => panic!("unexpected blocks: {other:?}"),
        };
        assert_eq!(use_id, result_id, "pairing must survive the rename");
        assert!(use_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'));
        // Conforming ids pass through untouched.
        let out = transform_history(vec![tool_use("toolu_01AB"), tool_result("toolu_01AB")], "x");
        assert!(matches!(&all_blocks(&out)[0], ContentBlock::ToolUse { id, .. } if id == "toolu_01AB"));
    }

    #[test]
    fn an_unanswered_tool_use_gets_a_synthetic_error_result() {
        let out = transform_history(vec![tool_use("t1")], "anthropic");
        assert_eq!(out.len(), 2);
        let blocks = all_blocks(&out);
        match &blocks[1] {
            ContentBlock::ToolResult { tool_use_id, is_error, content } => {
                assert_eq!(tool_use_id, "t1");
                assert_eq!(*is_error, Some(true));
                assert!(matches!(content, ToolResultContent::Text(t) if t.contains("interrupted")));
            }
            other => panic!("expected synthetic result, got {other:?}"),
        }
    }

    #[test]
    fn a_result_whose_call_was_compacted_away_is_dropped() {
        let out = transform_history(vec![tool_result("gone")], "anthropic");
        assert!(out.is_empty(), "an all-orphan message is dropped entirely: {out:?}");

        // Mixed message: the orphan block goes, the rest stays.
        let mixed = Message::user_blocks(vec![
            ContentBlock::ToolResult {
                tool_use_id: "gone".into(),
                content: ToolResultContent::Text("x".into()),
                is_error: Some(false),
            },
            ContentBlock::Text { text: "still here".into() },
        ]);
        let out = transform_history(vec![mixed], "anthropic");
        let blocks = all_blocks(&out);
        assert_eq!(blocks.len(), 1);
        assert!(matches!(&blocks[0], ContentBlock::Text { text } if text == "still here"));
    }

    #[test]
    fn the_transform_is_idempotent() {
        let messages = vec![
            Message::user("hi"),
            Message::assistant_blocks(vec![
                ContentBlock::Thinking { thinking: "hm".into(), signature: String::new() },
                ContentBlock::ToolUse { id: "bad id!".into(), name: "Read".into(), input: json!({}) },
            ]),
        ];
        let once = transform_history(messages, "openai");
        let twice = transform_history(once.clone(), "openai");
        assert_eq!(
            serde_json::to_string(&once).unwrap(),
            serde_json::to_string(&twice).unwrap()
        );
    }
}

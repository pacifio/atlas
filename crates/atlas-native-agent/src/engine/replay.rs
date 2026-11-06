//! Rollout history → thread entries, when a stored session reopens.
//!
//! The fix for the reopened-session bugs lived here all along: the engine's
//! `thread/resume` response has always carried the thread's full turn history
//! out of its rollout files — complete assistant text included — and the seam
//! ignored it. Reopened sessions painted from Atlas's own transcript record
//! instead, which is a byproduct (and for a while a truncated one), while the
//! primary source sat unread in the response.
//!
//! # What is replayed
//!
//! The words, the work, and how the turn ended.
//!
//! Text replays as text, reasoning as thoughts, and every item that maps to a
//! tool call replays as one. Replaying tool calls was once avoided on the
//! grounds that the rollout is lossy for them; that is true only of the legacy
//! history format, which keeps file changes and MCP calls but drops shell
//! commands. A paginated rollout persists every completed item, and an item
//! that never completed is simply absent — so what comes back is a true record
//! either way, just a fuller one on paginated threads.
//!
//! # Why a turn's status matters
//!
//! A process killed mid-turn writes no terminal record, so that turn resumes
//! as `InProgress` carrying whatever text had streamed. Rendering it like any
//! other turn is what made a truncated answer indistinguishable from a
//! finished one: the transcript agreed with the filesystem right up to the
//! point it was cut off, so nothing contradicted a confident partial reply.
//! An unfinished turn therefore ends with a marker of its own, and a failed
//! one with its error.
//!
//! The thread is deliberately left `Idle` rather than marked errored: the
//! retry affordance the marker points at is only offered on an idle session.
//!
//! User text is stripped of Atlas's injected context blocks before it lands:
//! the rollout holds the wire prompt, and the memory machinery prepended to it
//! is not something the user said.

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::AcpThread;
use atlas_engine_app_server_protocol as v2;

/// What a reopened thread says about a turn the process never finished.
///
/// Its wording has to carry three things a user cannot otherwise tell: that
/// the reply above is incomplete, that Atlas rather than the agent ended it,
/// and that the prompt can be run again.
pub const INTERRUPTED_NOTICE: &str =
    "This turn was interrupted — Atlas closed before the agent finished, so the reply above stops mid-way. Use Retry on your message to run it again.";

/// Prefix for a turn the engine reported as failed.
pub const FAILED_NOTICE_PREFIX: &str = "Error: ";

/// What a failed turn says when it carried no message of its own.
pub const FAILED_NOTICE_FALLBACK: &str = "the turn failed";

/// Replay stored turns into a freshly created thread.
///
/// Runs before the thread handle is returned to the host, so the entries are
/// simply *there* when the first snapshot is taken — no streaming, no events
/// that could race a not-yet-bound tab.
pub fn replay_turns(thread: &mut AcpThread, turns: &[v2::Turn]) {
    for turn in turns {
        for item in &turn.items {
            match item {
                v2::ThreadItem::UserMessage { id, content, .. } => {
                    let text = user_text(content);
                    if text.trim().is_empty() {
                        continue;
                    }
                    let _ = thread.handle_session_update(acp::SessionUpdate::UserMessageChunk(
                        acp::ContentChunk::new(acp::ContentBlock::Text(acp::TextContent::new(
                            text,
                        )))
                        // Distinct per item: a shared (or absent) id would let
                        // consecutive messages merge into one entry.
                        .message_id(acp::MessageId::new(id.as_str())),
                    ));
                }
                v2::ThreadItem::AgentMessage { id, text, .. } => {
                    if text.trim().is_empty() {
                        continue;
                    }
                    let _ = thread.handle_session_update(acp::SessionUpdate::AgentMessageChunk(
                        acp::ContentChunk::new(acp::ContentBlock::Text(acp::TextContent::new(
                            text.clone(),
                        )))
                        .message_id(acp::MessageId::new(id.as_str())),
                    ));
                }
                v2::ThreadItem::Reasoning {
                    id,
                    summary,
                    content,
                    ..
                } => {
                    // Summary first: it is what the user reads. Mirrors the
                    // live path in `sink.rs` so a replayed thought and a
                    // streamed one look the same.
                    let text = if summary.is_empty() {
                        content.join("\n")
                    } else {
                        summary.join("\n")
                    };
                    if text.trim().is_empty() {
                        continue;
                    }
                    let _ = thread.handle_session_update(acp::SessionUpdate::AgentThoughtChunk(
                        acp::ContentChunk::new(acp::ContentBlock::Text(acp::TextContent::new(
                            text,
                        )))
                        .message_id(acp::MessageId::new(id.as_str())),
                    ));
                }
                // Commands, file changes and MCP calls, through the same
                // mapping the live sink uses — so a reopened tool call renders
                // identically to the one the user watched run.
                item => {
                    if let Some(mut call) = crate::engine::sink::tool_call_of(item) {
                        // A command's output lives in a terminal the call
                        // names (see `sink::command_terminal_id`). The live
                        // sink creates it as deltas arrive; a rollout has only
                        // the aggregate, so it is written here — BEFORE the
                        // upsert, or the reopened call renders an empty pane.
                        crate::engine::sink::settle_command_terminal_in(thread, item);
                        // A rollout only records completed items, so an
                        // in-progress status here belongs to a turn that was
                        // cut off. Leaving it spinning would be a second way
                        // of claiming work is still happening when it is not.
                        if turn.status != v2::TurnStatus::Completed
                            && call.status == acp::ToolCallStatus::InProgress
                        {
                            call.status = acp::ToolCallStatus::Failed;
                        }
                        let _ = thread.upsert_tool_call(call);
                    }
                }
            }
        }
        replay_outcome(thread, turn);
    }
}

/// Say how a turn ended, when how it ended is not self-evident.
///
/// A completed turn needs no marker, and neither does one the user stopped:
/// the live path is silent about a cancellation too, and a user who pressed
/// stop does not need telling. The two that do need saying are the turn that
/// was cut off by the process dying and the turn that failed.
fn replay_outcome(thread: &mut AcpThread, turn: &v2::Turn) {
    match turn.status {
        v2::TurnStatus::InProgress => thread.push_assistant_notice(INTERRUPTED_NOTICE),
        v2::TurnStatus::Failed => {
            let detail = turn
                .error
                .as_ref()
                .map(|e| e.message.trim())
                .filter(|m| !m.is_empty())
                .unwrap_or(FAILED_NOTICE_FALLBACK);
            thread.push_assistant_notice(format!("{FAILED_NOTICE_PREFIX}{detail}"));
        }
        v2::TurnStatus::Completed | v2::TurnStatus::Interrupted => {}
    }
}

/// The user-visible text of a stored user message.
///
/// Injected context blocks are machinery, not what the user said; the engine
/// recorded the wire prompt, so they have to come back off here — the same
/// stripping every other replay path applies.
fn user_text(content: &[v2::UserInput]) -> String {
    let mut out = String::new();
    for input in content {
        if let v2::UserInput::Text { text, .. } = input {
            let stripped = atlas_agent_transcript::strip_injected_context(text);
            if stripped.trim().is_empty() {
                continue;
            }
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&stripped);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_acp_thread::{AgentThreadEntry, AssistantMessageChunk, ContentBlock, ToolCallStatus};

    use serde_json::json;

    /// Items and turns are built from JSON rather than struct literals: the
    /// protocol types gain fields over time, and a test that spells every one
    /// of them out breaks on changes it has no opinion about.
    fn turn(status: &str, items: serde_json::Value) -> v2::Turn {
        serde_json::from_value(json!({
            "id": "turn-1",
            "items": items,
            "status": status,
            "error": null,
            "startedAt": null,
            "completedAt": null,
            "durationMs": null,
        }))
        .expect("a turn the protocol accepts")
    }

    fn agent_text(text: &str) -> serde_json::Value {
        json!({ "type": "agentMessage", "id": "m-1", "text": text })
    }

    fn command(id: &str, command: &str, exit_code: i64) -> serde_json::Value {
        json!({
            "type": "commandExecution",
            "id": id,
            "command": command,
            "cwd": "/tmp/project",
            "processId": null,
            "status": "completed",
            "commandActions": [],
            // Real output, so the tests below cannot pass on a replay that
            // drops it — which is what happened when a rebuilt tool call named
            // a terminal nobody had created.
            "aggregatedOutput": format!("{command}: ran\n"),
            "exitCode": exit_code,
            "durationMs": null,
        })
    }

    fn replay(turns: &[v2::Turn]) -> atlas_acp_thread::AcpThreadHandle {
        let thread = crate::engine::test_support::detached_thread(acp::SessionId::new("t-replay"));
        {
            let mut guard = thread.lock().expect("thread lock");
            replay_turns(&mut guard, turns);
        }
        thread
    }

    fn text_of(block: &ContentBlock) -> String {
        match block {
            ContentBlock::Text(t) => t.clone(),
            _ => String::new(),
        }
    }

    /// Every assistant entry's spoken text, in order. Thoughts are not speech.
    fn assistant_texts(thread: &AcpThread) -> Vec<String> {
        thread
            .entries()
            .iter()
            .filter_map(|e| match e {
                AgentThreadEntry::AssistantMessage(m) => {
                    let spoken: String = m
                        .chunks
                        .iter()
                        .filter_map(|c| match c {
                            AssistantMessageChunk::Message { block, .. } => Some(text_of(block)),
                            AssistantMessageChunk::Thought { .. } => None,
                        })
                        .collect();
                    (!spoken.is_empty()).then_some(spoken)
                }
                _ => None,
            })
            .collect()
    }

    /// `ToolCallStatus` is neither `Copy` nor `PartialEq` (one variant carries
    /// a oneshot sender), so compare the name rather than the value.
    fn status_name(status: &ToolCallStatus) -> &'static str {
        match status {
            ToolCallStatus::Pending => "pending",
            ToolCallStatus::WaitingForConfirmation { .. } => "waiting",
            ToolCallStatus::InProgress => "in_progress",
            ToolCallStatus::Completed => "completed",
            ToolCallStatus::Failed => "failed",
            ToolCallStatus::Rejected => "rejected",
            _ => "other",
        }
    }

    fn tool_calls(thread: &AcpThread) -> Vec<(String, &'static str)> {
        thread
            .entries()
            .iter()
            .filter_map(|e| match e {
                AgentThreadEntry::ToolCall(c) => Some((c.id.0.to_string(), status_name(&c.status))),
                _ => None,
            })
            .collect()
    }

    /// Reopening a session rebuilds each command's tool call from the rollout.
    /// Its output is the rollout's `aggregatedOutput`, and the call renders it
    /// through a terminal — so the replay has to create and fill that terminal,
    /// or the reopened pane is blank however much the command printed.
    #[test]
    fn a_replayed_command_keeps_its_output() {
        let thread = replay(&[turn("completed", json!([command("c1", "ls -la", 0)]))]);
        let guard = thread.lock().expect("thread lock");
        let outputs: Vec<String> = guard
            .entries()
            .iter()
            .filter_map(|e| match e {
                atlas_acp_thread::AgentThreadEntry::ToolCall(call) => Some(call),
                _ => None,
            })
            .flat_map(|call| call.content.iter())
            .filter_map(|block| match block {
                atlas_acp_thread::ToolCallContent::Terminal(id) => guard.terminal_output(id),
                _ => None,
            })
            .collect();
        assert_eq!(outputs, vec!["ls -la: ran\n".to_string()]);
    }

    /// The tool calls a turn really made are part of the record of it. They
    /// used to be dropped on reopen, so a thread came back showing a confident
    /// reply with no sign of the files it had written.
    #[test]
    fn command_items_replay_as_tool_calls_with_the_exit_code_s_verdict() {
        let thread = replay(&[turn(
            "completed",
            json!([command("cmd-1", "ls", 0), command("cmd-2", "false", 1)]),
        )]);
        let guard = thread.lock().expect("thread lock");
        assert_eq!(
            tool_calls(&guard),
            vec![
                ("cmd-1".to_string(), "completed"),
                // The engine says the process ran; the exit code says it failed.
                ("cmd-2".to_string(), "failed"),
            ],
        );
    }

    /// The dangerous shape from issue 289: a turn killed mid-stream comes back
    /// with its partial text and nothing saying it is partial, so it reads as
    /// a finished answer. The marker has to be its own entry, or it runs on
    /// from the truncated sentence it is about.
    #[test]
    fn an_unfinished_turn_ends_with_an_interrupted_marker_as_its_own_entry() {
        let thread = replay(&[turn(
            "inProgress",
            json!([agent_text(
                "Creating the five files, starting with CRASH_A.md"
            )]),
        )]);
        let guard = thread.lock().expect("thread lock");
        assert_eq!(
            assistant_texts(&guard),
            vec![
                "Creating the five files, starting with CRASH_A.md".to_string(),
                INTERRUPTED_NOTICE.to_string(),
            ],
        );
    }

    #[test]
    fn a_failed_turn_comes_back_with_its_error() {
        let mut t = turn("failed", json!([agent_text("working on it")]));
        t.error = Some(
            serde_json::from_value(json!({
                "message": "stream disconnected",
                "atlasEngineErrorInfo": null,
            }))
            .expect("a turn error the protocol accepts"),
        );
        let thread = replay(&[t]);
        let guard = thread.lock().expect("thread lock");
        assert_eq!(
            assistant_texts(&guard).last().map(String::as_str),
            Some("Error: stream disconnected"),
        );
    }

    /// A finished turn needs no marker, and neither does one the user stopped:
    /// the live path is silent about a cancellation too, and someone who
    /// pressed stop does not need telling what they did.
    #[test]
    fn a_completed_or_cancelled_turn_gets_no_marker() {
        for status in ["completed", "interrupted"] {
            let thread = replay(&[turn(status, json!([agent_text("all done")]))]);
            let guard = thread.lock().expect("thread lock");
            assert_eq!(
                assistant_texts(&guard),
                vec!["all done".to_string()],
                "status {status} should not be marked"
            );
        }
    }

    #[test]
    fn reasoning_replays_as_a_thought_rather_than_as_the_answer() {
        let thread = replay(&[turn(
            "completed",
            json!([
                { "type": "reasoning", "id": "r-1", "summary": ["weighing the options"], "content": [] },
                agent_text("here is the answer"),
            ]),
        )]);
        let guard = thread.lock().expect("thread lock");
        assert_eq!(
            assistant_texts(&guard),
            vec!["here is the answer".to_string()]
        );
    }
}

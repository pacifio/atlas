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
//! Text only: user messages and assistant messages. Reasoning, tool calls,
//! plans and command executions have item forms in the rollout, but the
//! rollout is documented as lossy for them ("we explicitly do not persist all
//! agent interactions" — `ThreadRollbackResponse`), so replaying them would
//! render an incomplete record as if it were the whole story. The
//! conversation's words are complete, and they are what a reopened session is
//! for.
//!
//! User text is stripped of Atlas's injected context blocks before it lands:
//! the rollout holds the wire prompt, and the memory machinery prepended to it
//! is not something the user said.

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::AcpThread;
use codex_app_server_protocol as v2;

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
                // Lossy in the rollout by upstream's own documentation —
                // rendering a partial record as history would misrepresent it.
                _ => {}
            }
        }
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

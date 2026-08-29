//! Engine notifications → thread updates.
//!
//! This is the translation layer ADR-0004 calls the seam's real work and its
//! main maintenance cost. The engine speaks its own event vocabulary; the app
//! speaks ACP session updates and `AcpThread`. Nothing else in Atlas knows both.
//!
//! **Scope, honestly.** The tracer bullet's job is one complete turn, so what is
//! mapped here is what a text turn emits: streamed assistant text, reasoning,
//! and the turn's completion. Tool calls, plans, diffs, token usage, and the
//! retry notices all have engine events and thread representations, and wiring
//! them is #46 and #47. They are matched explicitly below and dropped with a
//! trace rather than falling into a silent `_ => {}`, so an unmapped event is
//! visible in a log instead of being invisible in the UI.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::AcpThread;
use atlas_acp_thread::AcpThreadHandle;
use atlas_acp_thread::RetryStatus;
use codex_app_server_protocol::ServerNotification;
use codex_app_server_protocol::ThreadItem;

use crate::engine::connection::TurnWaiters;

/// The threads this connection is serving, keyed by session id.
///
/// Weak, for the reason the Cersei-path sink gives: a thread the host dropped
/// must not be kept alive by a session table still listing it.
pub struct EngineSession {
    thread: Weak<Mutex<AcpThread>>,
    /// Item ids whose text already arrived as deltas.
    ///
    /// The engine sends both: deltas while the model writes, and a completed
    /// item carrying the whole thing. Rendering both shows the answer twice.
    /// Rendering only the deltas loses any item that never streamed — which is
    /// every item from a provider that does not stream, and the case the first
    /// version of this sink silently dropped.
    streamed: std::collections::HashSet<String>,
    /// The session's working directory.
    ///
    /// Kept because `search_memory` retrieves per project and the engine's
    /// tool-call request does not carry a cwd — it has no reason to, since the
    /// tool is Atlas's.
    cwd: String,
    /// The skills the engine discovered for this session's cwd, in the shape
    /// the command parser consumes. Per session because skills are cwd-scoped.
    skills: Vec<crate::engine::commands::SkillRef>,
    /// The model the composer's picker chose for this session, if it did.
    ///
    /// Held HERE, per session, because the state used to live inside the
    /// `AgentModelSelector` — and the host constructs a fresh selector per
    /// call, so a selection was forgotten the moment it was made. Worse, every
    /// `turn/start` sent the configured default explicitly, overriding the
    /// engine-side thread setting the selection had written: the picker
    /// changed nothing about the next turn. The turn path reads this instead.
    selected_model: Option<String>,
}

#[derive(Default)]
pub struct EngineSessions {
    sessions: Mutex<HashMap<acp::SessionId, EngineSession>>,
}

impl EngineSessions {
    pub fn insert(&self, session_id: acp::SessionId, thread: &AcpThreadHandle, cwd: String) {
        self.lock().insert(
            session_id,
            EngineSession {
                thread: Arc::downgrade(thread),
                streamed: std::collections::HashSet::new(),
                cwd,
                skills: Vec::new(),
                selected_model: None,
            },
        );
    }

    pub fn thread(&self, session_id: &acp::SessionId) -> Option<AcpThreadHandle> {
        self.lock()
            .get(session_id)
            .and_then(|s| s.thread.upgrade())
    }

    pub fn cwd(&self, session_id: &acp::SessionId) -> Option<String> {
        self.lock().get(session_id).map(|s| s.cwd.clone())
    }

    pub fn skills(&self, session_id: &acp::SessionId) -> Vec<crate::engine::commands::SkillRef> {
        self.lock()
            .get(session_id)
            .map(|s| s.skills.clone())
            .unwrap_or_default()
    }

    pub fn set_skills(
        &self,
        session_id: &acp::SessionId,
        skills: Vec<crate::engine::commands::SkillRef>,
    ) {
        if let Some(session) = self.lock().get_mut(session_id) {
            session.skills = skills;
        }
    }

    /// The model the picker chose for this session — `None` until it chooses,
    /// meaning "the configured default".
    pub fn selected_model(&self, session_id: &acp::SessionId) -> Option<String> {
        self.lock()
            .get(session_id)
            .and_then(|s| s.selected_model.clone())
    }

    pub fn set_selected_model(&self, session_id: &acp::SessionId, model: String) {
        if let Some(session) = self.lock().get_mut(session_id) {
            session.selected_model = Some(model);
        }
    }

    /// Records that an item streamed, and answers whether this was the first
    /// delta for it.
    fn mark_streamed(&self, session_id: &acp::SessionId, item_id: &str) {
        if let Some(session) = self.lock().get_mut(session_id) {
            session.streamed.insert(item_id.to_string());
        }
    }

    /// Whether this item's text has already been rendered from deltas.
    fn already_streamed(&self, session_id: &acp::SessionId, item_id: &str) -> bool {
        self.lock()
            .get(session_id)
            .is_some_and(|s| s.streamed.contains(item_id))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<acp::SessionId, EngineSession>> {
        self.sessions.lock().unwrap_or_else(|p| p.into_inner())
    }
}

fn text_block(text: &str) -> acp::ContentBlock {
    acp::ContentBlock::Text(acp::TextContent::new(text.to_owned()))
}

/// Flattens a prompt into the single string the engine's text input takes.
///
/// Same rules as the Cersei path so a prompt reads identically on both sides of
/// the switch: text passes through, a resource link contributes its URI, an
/// embedded text resource contributes its text, and anything else is skipped
/// rather than stringified into noise.
pub fn flatten_prompt(blocks: &[acp::ContentBlock]) -> String {
    let mut out = String::new();
    for block in blocks {
        let piece = match block {
            acp::ContentBlock::Text(text) => text.text.clone(),
            acp::ContentBlock::ResourceLink(link) => link.uri.clone(),
            acp::ContentBlock::Resource(resource) => match &resource.resource {
                acp::EmbeddedResourceResource::TextResourceContents(contents) => {
                    contents.text.clone()
                }
                _ => continue,
            },
            _ => continue,
        };
        if !out.is_empty() && !piece.is_empty() {
            out.push('\n');
        }
        out.push_str(&piece);
    }
    out
}

fn session_id(thread_id: &str) -> acp::SessionId {
    acp::SessionId::new(thread_id)
}

fn lock(thread: &AcpThreadHandle) -> std::sync::MutexGuard<'_, AcpThread> {
    thread.lock().unwrap_or_else(|p| p.into_inner())
}

/// Applies one engine notification.
///
/// `max_retries` is the provider's configured stream-retry ceiling. It is
/// passed in rather than guessed because the seam is what set it, and the
/// retry pill renders "attempt N of M" — an unknown M would render as
/// `1/0`.
pub fn apply_notification(
    sessions: &EngineSessions,
    turns: &TurnWaiters,
    max_retries: usize,
    notification: ServerNotification,
) {
    match notification {
        // Streamed assistant text. The engine sends deltas; the thread appends
        // them, which is what makes text appear as it is produced rather than
        // in one block at the end.
        ServerNotification::AgentMessageDelta(params) => {
            let id = session_id(&params.thread_id);
            if let Some(thread) = sessions.thread(&id) {
                sessions.mark_streamed(&id, &params.item_id);
                lock(&thread).push_assistant_content_block(text_block(&params.delta), false);
            }
        }

        // The finished item. For a streaming provider this is a duplicate of
        // what the deltas already rendered, so it is skipped; for one that does
        // not stream it is the only place the answer ever appears.
        ServerNotification::ItemCompleted(params) => {
            let id = session_id(&params.thread_id);
            let Some(thread) = sessions.thread(&id) else {
                return;
            };
            match &params.item {
                ThreadItem::AgentMessage { id: item_id, text, .. } => {
                    if sessions.already_streamed(&id, item_id) || text.is_empty() {
                        return;
                    }
                    lock(&thread).push_assistant_content_block(text_block(text), false);
                }
                ThreadItem::Reasoning { id: item_id, summary, content, .. } => {
                    if sessions.already_streamed(&id, item_id) {
                        return;
                    }
                    // Summary first: it is what the user reads. Content is the
                    // raw trace, and only some models emit it.
                    let text = if summary.is_empty() {
                        content.join("\n")
                    } else {
                        summary.join("\n")
                    };
                    if text.trim().is_empty() {
                        return;
                    }
                    lock(&thread).push_assistant_content_block(text_block(&text), true);
                }
                // Compaction finishing. Without this arm /compact was
                // invisible: the protocol call returned, the engine
                // summarised in the background, and nothing on screen ever
                // said so — indistinguishable from the command being broken.
                ThreadItem::ContextCompaction { id } => {
                    lock(&thread).upsert_context_compaction(
                        atlas_acp_thread::ContextCompactionId(id.as_str().into()),
                        atlas_acp_thread::ContextCompactionStatus::Completed,
                    );
                }
                other => {
                    tracing::debug!(
                        target: "atlas_native_agent::engine",
                        "thread item not rendered yet: {}", item_kind(other),
                    );
                }
            }
        }

        // Compaction beginning — the pill's "in progress" state, and the
        // user's only sign that /compact took.
        ServerNotification::ItemStarted(params) => {
            if let ThreadItem::ContextCompaction { id } = &params.item {
                let session = session_id(&params.thread_id);
                if let Some(thread) = sessions.thread(&session) {
                    lock(&thread).upsert_context_compaction(
                        atlas_acp_thread::ContextCompactionId(id.as_str().into()),
                        atlas_acp_thread::ContextCompactionStatus::InProgress,
                    );
                }
            }
        }

        // The turn's outcome. This is what `prompt` is awaiting — without it a
        // prompt future never resolves and the composer stays spinning.
        ServerNotification::TurnCompleted(params) => {
            turns.complete(&params.thread_id, params.turn);
        }

        // A stream error. `will_retry` is the engine telling us whether it is
        // about to try again, and it is the difference between a retry pill
        // and a dead turn: a retrying turn has NOT ended, so the only correct
        // response is to show progress. Dropping this is what makes a retry
        // look like a hang.
        ServerNotification::Error(params) if params.will_retry => {
            let Some(thread) = sessions.thread(&session_id(&params.thread_id)) else {
                return;
            };
            let attempt = turns.note_retry(&params.turn_id);
            lock(&thread).report_retry(RetryStatus {
                last_error: params.error.message.clone().into(),
                attempt,
                max_attempts: max_retries,
                started_at: std::time::Instant::now(),
                // The wait the engine is actually about to take, so the pill
                // counts *down* to the attempt rather than up from the notice.
                //
                // D8 recorded this as an accepted loss because upstream
                // computed the delay and then dropped it on the floor; the
                // gateway made it worth fixing, since a `429` carries a
                // `Retry-After` the contract instructs clients to honour and a
                // minute-long wait with no visible end reads as a hang. Zero
                // when the engine did not say — still better than inventing a
                // duration, which would be a countdown to nothing.
                duration: params
                    .error
                    .retry_delay_ms
                    .map(std::time::Duration::from_millis)
                    .unwrap_or(std::time::Duration::ZERO),
                meta: None,
            });
        }

        // A terminal error. The turn is ending, and `TurnCompleted` carries
        // the outcome `prompt` reports, so this only needs to be visible.
        ServerNotification::Error(params) => {
            tracing::warn!(
                target: "atlas_native_agent::engine",
                "the engine reported a terminal error: {}", params.error.message,
            );
        }

        other => {
            // Named rather than silently dropped: every one of these has a
            // thread representation and a ticket, and a log line is the
            // difference between "not wired yet" and "mysteriously missing".
            tracing::debug!(
                target: "atlas_native_agent::engine",
                "engine notification not mapped yet: {}", notification_name(&other),
            );
        }
    }
}

/// A thread item's variant name, for the trace above.
fn item_kind(item: &ThreadItem) -> String {
    serde_json::to_value(item)
        .ok()
        .and_then(|v| v.get("type").and_then(|t| t.as_str().map(str::to_owned)))
        .unwrap_or_else(|| "<unknown>".to_string())
}

/// The notification's wire method name, for the trace above.
fn notification_name(notification: &ServerNotification) -> String {
    serde_json::to_value(notification)
        .ok()
        .and_then(|v| v.get("method").and_then(|m| m.as_str().map(str::to_owned)))
        .unwrap_or_else(|| "<unnamed>".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_text_prompt_passes_through_unchanged() {
        assert_eq!(flatten_prompt(&[text_block("hello")]), "hello");
    }

    #[test]
    fn multiple_blocks_are_joined_by_newlines() {
        assert_eq!(
            flatten_prompt(&[text_block("one"), text_block("two")]),
            "one\ntwo",
        );
    }

    #[test]
    fn an_empty_prompt_is_empty_rather_than_a_stray_newline() {
        assert_eq!(flatten_prompt(&[]), "");
        assert_eq!(flatten_prompt(&[text_block("")]), "");
    }

    #[test]
    fn a_resource_link_contributes_its_uri() {
        // The composer degrades an attachment to a path mention; dropping the
        // link entirely would send a prompt that refers to nothing.
        // `ResourceLink::new` is (name, uri) — the display name first.
        let link = acp::ContentBlock::ResourceLink(acp::ResourceLink::new("a.rs", "file:///tmp/a.rs"));
        assert_eq!(flatten_prompt(&[link]), "file:///tmp/a.rs");
    }

    #[test]
    fn a_dropped_thread_does_not_keep_its_session_alive() {
        // The reason the table holds weak references: a thread the host closed
        // must be collectable even though this map still names it.
        let sessions = EngineSessions::default();
        let id = acp::SessionId::new("thread-1");
        {
            let thread = crate::engine::test_support::detached_thread(id.clone());
            sessions.insert(id.clone(), &thread, "/tmp".to_string());
            assert!(sessions.thread(&id).is_some());
        }
        assert!(
            sessions.thread(&id).is_none(),
            "a dropped thread must not be resurrectable from the session table",
        );
    }
}

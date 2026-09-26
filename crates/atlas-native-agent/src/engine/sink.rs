//! Engine notifications → thread updates.
//!
//! This is the translation layer ADR-0004 calls the seam's real work and its
//! main maintenance cost. The engine speaks its own event vocabulary; the app
//! speaks ACP session updates and `AcpThread`. Nothing else in Atlas knows both.
//!
//! **Scope.** Mapped: streamed assistant text, reasoning, turn completion,
//! retry notices, compaction, plans, and tool calls — command executions
//! (with live output), file changes (with locations, which is what feeds
//! capture's write set and therefore Artifacts checkpoints), and MCP calls.
//! What remains unmapped (sub-agent activity, image views, review-mode
//! markers, web search items) is matched explicitly below and dropped with a
//! trace rather than falling into a silent `_ => {}`, so an unmapped event is
//! visible in a log instead of being invisible in the UI.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::AcpThread;
use atlas_acp_thread::AcpThreadHandle;
use atlas_acp_thread::RateLimitWindow;
use atlas_acp_thread::RateLimits;
use atlas_acp_thread::RetryStatus;
use atlas_engine_app_server_protocol::ServerNotification;
use atlas_engine_app_server_protocol::ThreadItem;

use crate::engine::connection::TurnWaiters;

/// The threads this connection is serving, keyed by session id.
///
/// Weak, for the reason the old native-path sink gives: a thread the host dropped
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
    /// Kept because the engine's requests do not carry one back — a fork of
    /// the thread, for one, is started in it.
    cwd: String,
    /// The skills the engine discovered for this session's cwd, in the shape
    /// the command parser consumes. Per session because skills are cwd-scoped.
    skills: Vec<crate::engine::commands::SkillRef>,
    /// Accumulated live output per running command item.
    ///
    /// `item/commandExecution/outputDelta` carries only the chunk; the tool
    /// call's content is replace-not-append on the thread, so the running
    /// total has to live somewhere. Cleared when the item completes (the
    /// completed item carries the authoritative `aggregated_output`).
    command_output: HashMap<String, String>,
    /// The model the composer's picker chose for this session, if it did.
    ///
    /// Held HERE, per session, because the state used to live inside the
    /// `AgentModelSelector` — and the host constructs a fresh selector per
    /// call, so a selection was forgotten the moment it was made. Worse, every
    /// `turn/start` sent the configured default explicitly, overriding the
    /// engine-side thread setting the selection had written: the picker
    /// changed nothing about the next turn. The turn path reads this instead.
    selected_model: Option<String>,
    /// The last card to join this session's line, as the signal it sends when
    /// it is answered. See [`PromptPlace`].
    prompt_tail: Option<tokio::sync::oneshot::Receiver<()>>,
    /// The host tools the user allowed for the rest of this session, as
    /// `(server, tool)` (`engine::tool_approvals`). The engine keeps no session
    /// approval for a tool that always asks, so the seam does.
    allowed_for_session: std::collections::HashSet<(String, String)>,
}

/// A card's place in its session's line: one card at a time (ADR-0013).
///
/// A tool permission and a clarifying question both pin a card above the
/// composer, and both block the turn on the user. The engine can ask for two
/// at once — parallel tool calls can each want approval while the model's own
/// question is open — and the chat would stack them, the second covering the
/// first. So the engine's requests queue per session in the order they reached
/// the pump, and each card is raised only once the one ahead of it is
/// answered.
///
/// A chain rather than a lock, deliberately: a place is taken *synchronously*,
/// on the pump, which is what fixes the order to arrival order. Awaiting a
/// fair lock from a spawned task would order the cards by whichever task the
/// runtime happened to poll first.
///
/// Dropping the place is what lets the next card up, so an answer, a failure
/// to raise and a panic all release the line alike.
pub struct PromptPlace {
    /// The signal from the card ahead; `None` when nothing is waiting ahead.
    ahead: Option<tokio::sync::oneshot::Receiver<()>>,
    /// Held until this card is answered; dropped, it releases the next one.
    _answered: tokio::sync::oneshot::Sender<()>,
}

impl PromptPlace {
    /// Whether another card was still open when this one joined the line.
    pub fn is_queued(&self) -> bool {
        self.ahead.is_some()
    }

    /// Waits until every card ahead has been answered.
    pub async fn wait(&mut self) {
        if let Some(ahead) = self.ahead.take() {
            // `Err` is the normal release: the place ahead was dropped.
            let _ = ahead.await;
        }
    }
}

#[derive(Default)]
pub struct EngineSessions {
    sessions: Mutex<HashMap<acp::SessionId, EngineSession>>,
    /// Host MCP servers per engine thread, and whether each has finished
    /// starting (ready, failed or cancelled). Keyed by the engine's thread id
    /// rather than held on the session: the engine can report a server before
    /// `thread/start` has answered and the session exists.
    mcp_startup: Mutex<HashMap<String, HashMap<String, bool>>>,
    mcp_settled: tokio::sync::Notify,
    /// The MCP servers the HOST offered each engine thread — Atlas's own,
    /// which never elicit — as opposed to every server the engine reports.
    /// What tells the engine's own approval for a call to one of them from a
    /// tool server's elicitation (`engine::tool_approvals`).
    host_servers: Mutex<HashMap<String, std::collections::HashSet<String>>>,
}

/// How long a turn waits for its thread's host MCP servers to finish starting.
///
/// The engine starts them alongside the thread and lists their tools into
/// whichever turn begins once they are ready, so a first prompt sent at once
/// went out without them — and the shared-memory tools are the only way
/// memory reaches the model (ADR-0010). A loopback server is ready in
/// milliseconds; past this, the turn goes ahead without the tools rather
/// than stall on a server that will not come up.
pub const MCP_STARTUP_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

impl EngineSessions {
    pub fn insert(&self, session_id: acp::SessionId, thread: &AcpThreadHandle, cwd: String) {
        let mut sessions = self.lock();
        // Reap entries whose thread the host has dropped (#66). The map has
        // no other removal path — the connection lives as long as the process
        // — and while `thread` is Weak, everything else in the entry
        // (`streamed`, `command_output`, `cwd`, `skills`) is owned here and
        // outlived the AcpThread it described. Swept at insert, so the state
        // is bounded by live sessions rather than by every session the
        // process ever opened.
        sessions.retain(|_, session| session.thread.strong_count() > 0);
        sessions.insert(
            session_id,
            EngineSession {
                thread: Arc::downgrade(thread),
                streamed: std::collections::HashSet::new(),
                cwd,
                skills: Vec::new(),
                command_output: HashMap::new(),
                selected_model: None,
                prompt_tail: None,
                allowed_for_session: std::collections::HashSet::new(),
            },
        );
    }

    /// Takes the next place in `session_id`'s line of cards. Called on the
    /// pump, in arrival order — see [`PromptPlace`].
    pub fn join_prompt_line(&self, session_id: &acp::SessionId) -> PromptPlace {
        let (answered, signal) = tokio::sync::oneshot::channel();
        let ahead = self
            .lock()
            .get_mut(session_id)
            .and_then(|session| session.prompt_tail.replace(signal))
            // A card ahead that has already been answered is not in the way.
            .and_then(|mut ahead| match ahead.try_recv() {
                Err(tokio::sync::oneshot::error::TryRecvError::Empty) => Some(ahead),
                _ => None,
            });
        PromptPlace {
            ahead,
            _answered: answered,
        }
    }

    pub fn thread(&self, session_id: &acp::SessionId) -> Option<AcpThreadHandle> {
        self.lock()
            .get(session_id)
            .and_then(|s| s.thread.upgrade())
    }

    /// Every live thread, for the account-level notifications that name no
    /// session. Dropped threads are skipped, not reaped — `insert` reaps.
    pub fn threads(&self) -> Vec<AcpThreadHandle> {
        self.lock().values().filter_map(|s| s.thread.upgrade()).collect()
    }

    /// Records that `thread_id` was configured with these host MCP servers.
    /// A server the engine already reported keeps its settled state.
    pub fn expect_mcp_servers(&self, thread_id: &str, servers: impl IntoIterator<Item = String>) {
        let servers: Vec<String> = servers.into_iter().collect();
        self.host_servers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(thread_id.to_string())
            .or_default()
            .extend(servers.iter().cloned());
        let mut startup = self.mcp_startup_lock();
        let entry = startup.entry(thread_id.to_string()).or_default();
        for server in servers {
            entry.entry(server).or_insert(false);
        }
    }

    /// Whether `server` is one the host offered `thread_id`.
    pub fn is_host_server(&self, thread_id: &str, server: &str) -> bool {
        self.host_servers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(thread_id)
            .is_some_and(|servers| servers.contains(server))
    }

    /// Remembers that the user allowed `server`'s `tool` for the rest of this
    /// session.
    pub fn allow_for_session(&self, session_id: &acp::SessionId, server: &str, tool: &str) {
        if let Some(session) = self.lock().get_mut(session_id) {
            session.allowed_for_session.insert((server.to_string(), tool.to_string()));
        }
    }

    /// Whether the user allowed `server`'s `tool` for the rest of this session.
    pub fn allowed_for_session(&self, session_id: &acp::SessionId, server: &str, tool: &str) -> bool {
        self.lock()
            .get(session_id)
            .is_some_and(|s| s.allowed_for_session.contains(&(server.to_string(), tool.to_string())))
    }

    /// The engine's report on one MCP server's startup for one thread.
    fn record_mcp_status(&self, thread_id: &str, server: &str, settled: bool) {
        self.mcp_startup_lock()
            .entry(thread_id.to_string())
            .or_default()
            .insert(server.to_string(), settled);
        self.mcp_settled.notify_waiters();
    }

    fn mcp_pending(&self, thread_id: &str) -> bool {
        self.mcp_startup_lock()
            .get(thread_id)
            .is_some_and(|servers| servers.values().any(|settled| !settled))
    }

    /// Waits, at most `within`, for every host MCP server `thread_id` was
    /// configured with to finish starting. Returns whether they all did.
    pub async fn wait_for_mcp_servers(&self, thread_id: &str, within: std::time::Duration) -> bool {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            // Registered before the check, so a report landing between the
            // check and the wait still wakes it.
            let notified = self.mcp_settled.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !self.mcp_pending(thread_id) {
                return true;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return !self.mcp_pending(thread_id);
            }
        }
    }

    fn mcp_startup_lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, HashMap<String, bool>>> {
        self.mcp_startup
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
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

    /// Append a chunk of live command output; returns the running total.
    fn append_command_output(
        &self,
        session_id: &acp::SessionId,
        item_id: &str,
        delta: &str,
    ) -> Option<String> {
        let mut sessions = self.lock();
        let session = sessions.get_mut(session_id)?;
        let output = session.command_output.entry(item_id.to_string()).or_default();
        output.push_str(delta);
        Some(output.clone())
    }

    fn clear_command_output(&self, session_id: &acp::SessionId, item_id: &str) {
        if let Some(session) = self.lock().get_mut(session_id) {
            session.command_output.remove(item_id);
        }
    }

    /// The turn is over: drop every live-output accumulator for the session.
    ///
    /// `ItemCompleted` clears each item's entry, but an item aborted by an
    /// interrupt never completes — the engine gives a task 100 ms to wind
    /// down and then aborts it — so its accumulated output stayed for the
    /// life of the process, one verbose build per press of Stop (#66). The
    /// turn's end is the honest boundary: whatever is still accumulating
    /// belongs to an item that will never report.
    fn end_of_turn_cleanup(&self, session_id: &acp::SessionId) {
        if let Some(session) = self.lock().get_mut(session_id) {
            session.command_output.clear();
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
        self.sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn text_block(text: &str) -> acp::ContentBlock {
    acp::ContentBlock::Text(acp::TextContent::new(text.to_owned()))
}

/// An engine item that IS a tool call, as the thread's ACP shape — or `None`
/// for items that are not tool calls.
///
/// This mapping is what makes tool activity exist for the native agent at all:
/// without it the chat shows no tool rows, the detail panel has nothing to
/// open, and the Artifacts capture sees no writes — so no write set, and no
/// checkpoint is ever taken. `locations` is the load-bearing field for that
/// last part: capture's write extraction reads it first.
pub(crate) fn tool_call_of(item: &ThreadItem) -> Option<acp::ToolCall> {
    match item {
        ThreadItem::CommandExecution {
            id,
            command,
            cwd,
            status,
            aggregated_output,
            exit_code,
            ..
        } => {
            use atlas_engine_app_server_protocol::CommandExecutionStatus as S;
            let status = match status {
                S::InProgress => acp::ToolCallStatus::InProgress,
                // "Completed" is the ENGINE's word for "the process ran";
                // whether the command succeeded is the exit code's to say.
                S::Completed => {
                    if exit_code.unwrap_or(0) == 0 {
                        acp::ToolCallStatus::Completed
                    } else {
                        acp::ToolCallStatus::Failed
                    }
                }
                S::Failed | S::Declined => acp::ToolCallStatus::Failed,
            };
            let mut call = acp::ToolCall::new(id.clone(), command.clone())
                .kind(acp::ToolKind::Execute)
                .status(status)
                .raw_input(serde_json::json!({ "command": command, "cwd": cwd }));
            if let Some(output) = aggregated_output {
                if !output.is_empty() {
                    call = call.content(vec![acp::ToolCallContent::Content(acp::Content::new(
                        text_block(output),
                    ))]);
                }
            }
            Some(call)
        }
        ThreadItem::FileChange { id, changes, status } => {
            use atlas_engine_app_server_protocol::PatchApplyStatus as S;
            let status = match status {
                S::InProgress => acp::ToolCallStatus::InProgress,
                S::Completed => acp::ToolCallStatus::Completed,
                S::Failed | S::Declined => acp::ToolCallStatus::Failed,
            };
            let title = match changes.as_slice() {
                [] => "Edit".to_string(),
                [only] => format!("Edit {}", only.path),
                [first, rest @ ..] => format!("Edit {} (+{} more)", first.path, rest.len()),
            };
            let diffs: String = changes
                .iter()
                .map(|change| change.diff.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let mut call = acp::ToolCall::new(id.clone(), title)
                .kind(acp::ToolKind::Edit)
                .status(status)
                .locations(
                    changes
                        .iter()
                        .map(|change| acp::ToolCallLocation::new(change.path.clone()))
                        .collect::<Vec<_>>(),
                )
                .raw_input(serde_json::json!({
                    "paths": changes.iter().map(|c| c.path.clone()).collect::<Vec<_>>(),
                    // The engine's own per-file unified diffs, joined. This is
                    // what capture's `edit_patch` stores for the Timeline's
                    // checkpoint diff/restore view — its first arm reads
                    // `arguments["patch"]`, and without this key every native
                    // edit produced a checkpoint with nothing to show (#75).
                    // The structured Diff content block is not an option: it
                    // wants full old/new text, which a unified diff cannot
                    // reconstruct.
                    "patch": diffs,
                }));
            if !diffs.trim().is_empty() {
                call = call.content(vec![acp::ToolCallContent::Content(acp::Content::new(
                    text_block(&diffs),
                ))]);
            }
            Some(call)
        }
        ThreadItem::McpToolCall {
            id,
            server,
            tool,
            status,
            arguments,
            result,
            error,
            ..
        } => {
            use atlas_engine_app_server_protocol::McpToolCallStatus as S;
            let status = match status {
                S::InProgress => acp::ToolCallStatus::InProgress,
                S::Completed => acp::ToolCallStatus::Completed,
                S::Failed => acp::ToolCallStatus::Failed,
            };
            // `Other`: an MCP tool is whatever its server says it is, and
            // Atlas's own (memory, UI actions) are not fetches. The row's icon
            // then comes from the tool's name.
            let mut call = acp::ToolCall::new(id.clone(), format!("{server}.{tool}"))
                .kind(acp::ToolKind::Other)
                .status(status)
                .raw_input(arguments.clone());
            let body = error
                .as_ref()
                .map(|e| serde_json::to_string(e).unwrap_or_default())
                .or_else(|| {
                    result
                        .as_ref()
                        .map(|r| serde_json::to_string_pretty(r).unwrap_or_default())
                });
            if let Some(body) = body {
                if !body.is_empty() {
                    call = call.content(vec![acp::ToolCallContent::Content(acp::Content::new(
                        text_block(&body),
                    ))]);
                }
            }
            Some(call)
        }
        _ => None,
    }
}

/// Flattens a prompt into the single string the engine's text input takes.
///
/// Same rules as the previous native path so a prompt reads identically on both sides of
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
    thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Map the engine's thread token usage onto the shape the UI reads.
///
/// The one subtlety, and the reason this is its own function rather than
/// inline: `used_tokens` feeds the CONTEXT GAUGE and must come from `last`,
/// while every other field is a cumulative total and must come from `total`.
/// Taking `total` for the gauge divides a number that only grows by a fixed
/// window, so the percentage passes 100% and keeps climbing — 159% after
/// seven ordinary turns, and the 999% reports are the same arithmetic on a
/// longer thread.
fn token_usage_of(
    u: &atlas_engine_app_server_protocol::ThreadTokenUsage,
) -> atlas_acp_thread::TokenUsage {
    let clamp = |n: i64| n.max(0) as u64;
    let total = &u.total;
    let last = &u.last;
    atlas_acp_thread::TokenUsage {
        max_tokens: u.model_context_window.map(clamp).unwrap_or(0),
        // Current occupancy, not lifetime spend.
        used_tokens: clamp(last.total_tokens),
        input_tokens: clamp(total.input_tokens),
        output_tokens: clamp(total.output_tokens),
        max_output_tokens: None,
        cache_read_tokens: clamp(total.cached_input_tokens),
        cache_write_tokens: clamp(total.cache_write_input_tokens),
        reasoning_tokens: clamp(total.reasoning_output_tokens),
    }
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
        // A host MCP server finished starting (or gave up). The next turn on
        // its thread may be waiting for exactly this; see `MCP_STARTUP_WAIT`.
        ServerNotification::McpServerStatusUpdated(params) => {
            let settled = !matches!(
                params.status,
                atlas_engine_app_server_protocol::McpServerStartupState::Starting
            );
            if let Some(thread_id) = params.thread_id.as_deref() {
                sessions.record_mcp_status(thread_id, &params.name, settled);
            }
            if let Some(error) = params.error.as_deref() {
                tracing::warn!(server = %params.name, %error, "an MCP server failed to start");
            }
        }

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
                // A tool call settling: final status, exit-code verdict, the
                // aggregated output. This upsert is also what capture's write
                // extraction reads, which is where checkpoints come from.
                item if tool_call_of(item).is_some() => {
                    if let Some(call) = tool_call_of(item) {
                        sessions.clear_command_output(&id, item.id());
                        let _ = lock(&thread).upsert_tool_call(call);
                    }
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
        // user's only sign that /compact took. And tool calls announcing
        // themselves: the row appears the moment work starts, not when it
        // ends.
        ServerNotification::ItemStarted(params) => {
            let session = session_id(&params.thread_id);
            let Some(thread) = sessions.thread(&session) else {
                return;
            };
            if let ThreadItem::ContextCompaction { id } = &params.item {
                lock(&thread).upsert_context_compaction(
                    atlas_acp_thread::ContextCompactionId(id.as_str().into()),
                    atlas_acp_thread::ContextCompactionStatus::InProgress,
                );
            } else if let Some(call) = tool_call_of(&params.item) {
                let _ = lock(&thread).upsert_tool_call(call);
            }
        }

        // Live command output. Accumulated here because the thread's tool-call
        // content is replace-not-append; the completed item later carries the
        // authoritative aggregate and clears the running copy.
        ServerNotification::CommandExecutionOutputDelta(params) => {
            let session = session_id(&params.thread_id);
            let Some(total) =
                sessions.append_command_output(&session, &params.item_id, &params.delta)
            else {
                return;
            };
            if let Some(thread) = sessions.thread(&session) {
                let update = acp::ToolCallUpdate::new(
                    acp::ToolCallId::new(params.item_id),
                    acp::ToolCallUpdateFields::new().content(vec![
                        acp::ToolCallContent::Content(acp::Content::new(text_block(&total))),
                    ]),
                );
                let _ = lock(&thread)
                    .update_tool_call(atlas_acp_thread::ToolCallUpdate::UpdateFields(update));
            }
        }

        // The turn's plan — the planning panel and the timeline's plan rows.
        ServerNotification::TurnPlanUpdated(params) => {
            let session = session_id(&params.thread_id);
            if let Some(thread) = sessions.thread(&session) {
                use atlas_engine_app_server_protocol::TurnPlanStepStatus as S;
                let entries = params
                    .plan
                    .iter()
                    .map(|step| {
                        acp::PlanEntry::new(
                            step.step.clone(),
                            acp::PlanEntryPriority::Medium,
                            match step.status {
                                S::Pending => acp::PlanEntryStatus::Pending,
                                S::InProgress => acp::PlanEntryStatus::InProgress,
                                S::Completed => acp::PlanEntryStatus::Completed,
                            },
                        )
                    })
                    .collect();
                lock(&thread).update_plan(acp::Plan::new(entries));
            }
        }

        // The turn's outcome. This is what `prompt` is awaiting — without it a
        // prompt future never resolves and the composer stays spinning.
        ServerNotification::TurnCompleted(params) => {
            sessions.end_of_turn_cleanup(&session_id(&params.thread_id));
            turns.complete(&params.thread_id, params.turn);
        }

        // One notification carries two meters. `total` is cumulative lifetime
        // usage and feeds the input/output split; `last` is the latest active
        // context snapshot and feeds the context gauge. Using
        // `total.total_tokens` for both lets the gauge climb past 100%.
        ServerNotification::ThreadTokenUsageUpdated(params) => {
            let Some(thread) = sessions.thread(&session_id(&params.thread_id)) else {
                return;
            };
            lock(&thread).update_token_usage(Some(token_usage_of(&params.token_usage)));
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

        // The account's quota windows. Account-level — the notification names
        // no thread — so the same snapshot lands on every live session; one
        // opened later learns it from the engine's next report (it repeats
        // the snapshot every turn). The projector dedupes.
        ServerNotification::AccountRateLimitsUpdated(params) => {
            let snapshot = &params.rate_limits;
            let window = |w: &atlas_engine_app_server_protocol::RateLimitWindow| RateLimitWindow {
                used_percent: w.used_percent.clamp(0, 100) as u8,
                window_minutes: w.window_duration_mins,
                resets_at: w.resets_at,
            };
            let limits = RateLimits {
                primary: snapshot.primary.as_ref().map(window),
                secondary: snapshot.secondary.as_ref().map(window),
                plan_type: snapshot
                    .plan_type
                    .as_ref()
                    .map(|p| format!("{p:?}").to_lowercase()),
            };
            for thread in sessions.threads() {
                lock(&thread).update_rate_limits(Some(limits.clone()));
            }
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

    /// The context gauge reads `last`; every cumulative figure reads `total`.
    /// Mixing them is what made the percentage climb past 100% and keep going.
    mod token_usage {
        use super::super::token_usage_of;
        use atlas_engine_app_server_protocol::{ThreadTokenUsage, TokenUsageBreakdown};

        fn breakdown(input: i64, output: i64) -> TokenUsageBreakdown {
            TokenUsageBreakdown {
                input_tokens: input,
                cached_input_tokens: 0,
                cache_write_input_tokens: 0,
                output_tokens: output,
                reasoning_output_tokens: 0,
                total_tokens: input + output,
            }
        }

        #[test]
        fn the_gauge_reads_the_last_request_not_the_thread_total() {
            // A thread seven turns in: 266.4K spent in total, but the request
            // actually on the wire carried 60K. The window is 190K.
            let usage = ThreadTokenUsage {
                total: breakdown(266_400, 35_400),
                last: breakdown(60_000, 1_200),
                model_context_window: Some(190_000),
            };

            let mapped = token_usage_of(&usage);

            assert_eq!(mapped.used_tokens, 61_200, "gauge must use `last`");
            assert!(
                mapped.used_tokens < mapped.max_tokens,
                "a healthy thread must not read as over its window: {} / {}",
                mapped.used_tokens,
                mapped.max_tokens
            );
            // The split stays cumulative — that is what the Timeline wants.
            assert_eq!(mapped.input_tokens, 266_400);
            assert_eq!(mapped.output_tokens, 35_400);
            assert_eq!(mapped.max_tokens, 190_000);
        }

        #[test]
        fn a_negative_count_is_clamped_rather_than_wrapping() {
            let usage = ThreadTokenUsage {
                total: breakdown(-5, -5),
                last: breakdown(-5, -5),
                model_context_window: Some(-1),
            };

            let mapped = token_usage_of(&usage);

            assert_eq!(mapped.used_tokens, 0);
            assert_eq!(mapped.input_tokens, 0);
            assert_eq!(mapped.max_tokens, 0);
        }
    }

    mod mcp_startup {
        use super::super::*;
        use std::time::Duration;

        #[tokio::test]
        async fn a_thread_without_host_servers_never_waits() {
            let sessions = EngineSessions::default();
            assert!(sessions.wait_for_mcp_servers("t1", Duration::ZERO).await);
        }

        #[tokio::test]
        async fn a_turn_waits_until_its_server_reports_ready() {
            let sessions = Arc::new(EngineSessions::default());
            sessions.expect_mcp_servers("t1", ["atlas_memory".to_string()]);
            let reporter = sessions.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                reporter.record_mcp_status("t1", "atlas_memory", true);
            });
            assert!(sessions.wait_for_mcp_servers("t1", Duration::from_secs(5)).await);
        }

        #[tokio::test]
        async fn a_server_that_never_settles_is_given_up_on() {
            let sessions = EngineSessions::default();
            sessions.expect_mcp_servers("t1", ["atlas_memory".to_string()]);
            sessions.record_mcp_status("t1", "atlas_memory", false);
            assert!(!sessions.wait_for_mcp_servers("t1", Duration::from_millis(20)).await);
        }

        #[tokio::test]
        async fn a_report_before_the_session_exists_is_kept() {
            // The engine can report a server before `thread/start` answers.
            let sessions = EngineSessions::default();
            sessions.record_mcp_status("t1", "atlas_memory", true);
            sessions.expect_mcp_servers("t1", ["atlas_memory".to_string()]);
            assert!(sessions.wait_for_mcp_servers("t1", Duration::ZERO).await);
        }

        #[tokio::test]
        async fn a_failed_server_does_not_hold_the_turn() {
            let sessions = EngineSessions::default();
            sessions.expect_mcp_servers("t1", ["atlas_memory".to_string()]);
            sessions.record_mcp_status("t1", "atlas_memory", true); // failed is settled
            assert!(sessions.wait_for_mcp_servers("t1", Duration::ZERO).await);
        }
    }

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
    fn a_dropped_threads_state_is_reaped_at_the_next_insert() {
        // #66: the Weak thread was collectable, but the ENTRY — with its
        // owned `streamed`, `command_output`, `cwd` and `skills` — had no
        // removal path and lived as long as the process. Inserting a new
        // session sweeps the dead ones.
        let sessions = EngineSessions::default();
        let dead = acp::SessionId::new("dead");
        {
            let thread = crate::engine::test_support::detached_thread(dead.clone());
            sessions.insert(dead.clone(), &thread, "/tmp".to_string());
        }
        assert!(
            sessions.cwd(&dead).is_some(),
            "the entry itself outlives the thread…",
        );

        let live = acp::SessionId::new("live");
        let thread = crate::engine::test_support::detached_thread(live.clone());
        sessions.insert(live.clone(), &thread, "/tmp".to_string());
        assert!(
            sessions.cwd(&dead).is_none(),
            "…until the next insert sweeps it",
        );
        assert!(sessions.cwd(&live).is_some());
    }

    #[test]
    fn an_aborted_commands_output_is_dropped_when_the_turn_ends() {
        // #66: `ItemCompleted` clears per item, but a task interrupted by
        // Stop is aborted after its 100 ms grace and never completes — its
        // accumulated output stayed for the life of the process. The turn's
        // end clears whatever is still accumulating.
        let sessions = EngineSessions::default();
        let id = acp::SessionId::new("t1");
        let thread = crate::engine::test_support::detached_thread(id.clone());
        sessions.insert(id.clone(), &thread, "/tmp".to_string());

        sessions.append_command_output(&id, "item-1", "a very verbose build log");
        sessions.end_of_turn_cleanup(&id);
        assert_eq!(
            sessions.append_command_output(&id, "item-1", "").as_deref(),
            Some(""),
            "the accumulator starts empty again after the turn",
        );
    }

    #[test]
    fn a_file_change_ships_its_patch_for_the_checkpoint_diff() {
        // #75: the engine reports an edit with a per-file unified diff. The
        // capture path stores a patch for the Timeline's diff/restore view,
        // and its extractor's first arm reads `arguments["patch"]` — a key
        // this sink never wrote, so every native edit produced a checkpoint
        // with nothing to show or restore. (The structured Diff content
        // block wants full old/new text, which a unified diff cannot
        // reconstruct — the patch argument is the honest carrier.)
        let sessions = EngineSessions::default();
        let turns = TurnWaiters::default();
        let id = acp::SessionId::new("t-patch");
        let thread = crate::engine::test_support::detached_thread(id.clone());
        sessions.insert(id, &thread, "/tmp".to_string());

        apply_notification(
            &sessions,
            &turns,
            3,
            ServerNotification::ItemCompleted(atlas_engine_app_server_protocol::ItemCompletedNotification {
                thread_id: "t-patch".to_string(),
                turn_id: "turn-1".to_string(),
                item: ThreadItem::FileChange {
                    id: "item-1".to_string(),
                    status: atlas_engine_app_server_protocol::PatchApplyStatus::Completed,
                    changes: vec![atlas_engine_app_server_protocol::FileUpdateChange {
                        path: "src/foo.rs".to_string(),
                        kind: atlas_engine_app_server_protocol::PatchChangeKind::Update { move_path: None },
                        diff: "@@ -1 +1 @@\n-old\n+new\n".to_string(),
                    }],
                },
                completed_at_ms: 0,
            }),
        );

        let locked = thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let call = locked
            .entries()
            .iter()
            .find_map(|e| match e {
                atlas_acp_thread::AgentThreadEntry::ToolCall(call) => Some(call),
                _ => None,
            })
            .expect("the file change reaches the thread as a tool call");
        let patch = call
            .raw_input
            .as_ref()
            .and_then(|args| args.get("patch"))
            .and_then(|p| p.as_str())
            .expect("the edit's arguments carry the patch the checkpoint stores");
        assert!(patch.contains("+new"), "the patch is the engine's own diff: {patch}");
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

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
//! Sub-agents are mapped too: a v2 child's start from its `SubAgentActivity`
//! on the parent, its end from the child's own `TurnCompleted`.
//! What remains unmapped (v1 collab tool calls, image views, review-mode
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
use atlas_acp_thread::TerminalProviderEvent;
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
    /// Per engine thread, the host's `(server, tool)`s that ask on every call
    /// ([`atlas_agent_servers::AskFirst::every_time`]): their card offers no
    /// "Allow for this session", and no allowance is ever kept for them.
    every_time: Mutex<HashMap<String, std::collections::HashSet<(String, String)>>>,
    /// The subagents the sessions spawned, keyed by the CHILD's engine thread
    /// id. The engine reports a v2 child's start on the parent
    /// (`SubAgentActivity`) but its end only on the child's own thread — its
    /// `TurnCompleted` — and `wait_agent` names no child at all. This is what
    /// carries that end back to the parent's transcript.
    children: Mutex<HashMap<String, SpawnedChild>>,
    /// Signalled whenever `children` learns a child — what a request from a
    /// child the sink has not placed yet waits on ([`Self::wait_for_owner`]).
    children_changed: tokio::sync::Notify,
}

/// Where a spawned child's end is reported, and under which identity.
struct SpawnedChild {
    parent: acp::SessionId,
    /// The detector's identity for the child (`native_id`): the end must name
    /// the same path the start did, or the two are two rows.
    agent_path: String,
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
        // (`streamed`, `cwd`, `skills`) is owned here and
        // outlived the AcpThread it described. Swept at insert, so the state
        // is bounded by live sessions rather than by every session the
        // process ever opened.
        sessions.retain(|_, session| session.thread.strong_count() > 0);
        // A child stays while its chain of parents leads back to a live
        // session: a subagent's own children are recorded under the
        // subagent's thread, which is no session of ours.
        let mut children = self
            .children
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut live: std::collections::HashSet<String> =
            sessions.keys().map(ToString::to_string).collect();
        loop {
            let reached: Vec<String> = children
                .iter()
                .filter(|(id, child)| {
                    !live.contains(*id) && live.contains(&child.parent.to_string())
                })
                .map(|(id, _)| id.clone())
                .collect();
            if reached.is_empty() {
                break;
            }
            live.extend(reached);
        }
        children.retain(|id, _| live.contains(id));
        drop(children);
        sessions.insert(
            session_id,
            EngineSession {
                thread: Arc::downgrade(thread),
                streamed: std::collections::HashSet::new(),
                cwd,
                skills: Vec::new(),
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
        self.lock().get(session_id).and_then(|s| s.thread.upgrade())
    }

    /// Every live thread, for the account-level notifications that name no
    /// session. Dropped threads are skipped, not reaped — `insert` reaps.
    pub fn threads(&self) -> Vec<AcpThreadHandle> {
        self.lock()
            .values()
            .filter_map(|s| s.thread.upgrade())
            .collect()
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

    /// Records the host's tools that ask `thread_id` on every call.
    pub fn expect_every_time<'a>(
        &self,
        thread_id: &str,
        tools: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) {
        self.every_time
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(thread_id.to_string())
            .or_default()
            .extend(
                tools
                    .into_iter()
                    .map(|(s, t)| (s.to_string(), t.to_string())),
            );
    }

    /// Whether `server`'s `tool` asks `thread_id` on every call.
    pub fn asks_every_time(&self, thread_id: &str, server: &str, tool: &str) -> bool {
        self.every_time
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(thread_id)
            .is_some_and(|tools| tools.contains(&(server.to_string(), tool.to_string())))
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
            session
                .allowed_for_session
                .insert((server.to_string(), tool.to_string()));
        }
    }

    /// Whether the user allowed `server`'s `tool` for the rest of this session.
    pub fn allowed_for_session(
        &self,
        session_id: &acp::SessionId,
        server: &str,
        tool: &str,
    ) -> bool {
        self.lock().get(session_id).is_some_and(|s| {
            s.allowed_for_session
                .contains(&(server.to_string(), tool.to_string()))
        })
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

    fn mcp_startup_lock(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<String, HashMap<String, bool>>> {
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

    /// Remembers the child a `Started` activity on `parent_thread_id` names,
    /// so its end can be reported there. Anything else is ignored.
    fn note_spawned_child(&self, parent_thread_id: &str, item: &ThreadItem) {
        use atlas_engine_app_server_protocol::SubAgentActivityKind as K;
        let ThreadItem::SubAgentActivity {
            kind: K::Started,
            agent_thread_id,
            agent_path,
            ..
        } = item
        else {
            return;
        };
        self.children
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(
                agent_thread_id.clone(),
                SpawnedChild {
                    parent: session_id(parent_thread_id),
                    agent_path: agent_path.clone(),
                },
            );
        self.children_changed.notify_waiters();
    }

    /// The open session `thread_id` belongs to: itself when it is one, else
    /// the session that spawned it — through any depth of children.
    ///
    /// A v2 child runs on an engine thread of its own that is never a session
    /// here, but asks for approval under that thread's id; the card belongs
    /// on the session the user is looking at.
    pub(crate) fn owning_session(&self, thread_id: &str) -> Option<acp::SessionId> {
        /// Far deeper than any real delegation; a bound so a cycle (which the
        /// engine never makes) cannot spin.
        const MAX_DEPTH: usize = 32;
        let mut current = session_id(thread_id);
        for _ in 0..MAX_DEPTH {
            if self.lock().contains_key(&current) {
                return Some(current);
            }
            current = self
                .children
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .get(current.to_string().as_str())?
                .parent
                .clone();
        }
        None
    }

    /// [`Self::owning_session`], waiting up to `limit` for the child to be
    /// placed.
    ///
    /// A spawned child starts working before its parent's `Started` activity
    /// — the only thing that names its parent — has been reported: the engine
    /// emits it after the spawn returns. A child that asks at once asks under
    /// a thread nobody here knows yet, for a few milliseconds.
    pub(crate) async fn wait_for_owner(
        &self,
        thread_id: &str,
        limit: std::time::Duration,
    ) -> Option<acp::SessionId> {
        let wait = async {
            loop {
                let notified = self.children_changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if let Some(owner) = self.owning_session(thread_id) {
                    return owner;
                }
                notified.await;
            }
        };
        tokio::time::timeout(limit, wait).await.ok()
    }

    /// The parent session and agent path of the child running on
    /// `child_thread_id`, if a session here spawned it.
    fn spawned_child(&self, child_thread_id: &str) -> Option<(acp::SessionId, String)> {
        self.children
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(child_thread_id)
            .map(|child| (child.parent.clone(), child.agent_path.clone()))
    }

    /// Every child `parent_thread_id` spawned, and theirs in turn — what a
    /// stop on the parent has to reach. The engine's own interrupt stops only
    /// the thread it is sent to; a v2 child runs on as its own thread.
    pub(crate) fn descendants_of(&self, parent_thread_id: &str) -> Vec<String> {
        let children = self
            .children
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut found: Vec<String> = Vec::new();
        let mut frontier = vec![parent_thread_id.to_string()];
        while let Some(parent) = frontier.pop() {
            for (child, spawned) in children.iter() {
                if spawned.parent.to_string() == parent && !found.contains(child) {
                    found.push(child.clone());
                    frontier.push(child.clone());
                }
            }
        }
        found
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<acp::SessionId, EngineSession>> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn text_block(text: &str) -> acp::ContentBlock {
    owned_text_block(text.to_owned())
}

/// [`text_block`] for a `String` the caller is done with — no second copy.
fn owned_text_block(text: String) -> acp::ContentBlock {
    acp::ContentBlock::Text(acp::TextContent::new(text))
}

/// The terminal that carries one command-execution item's output.
///
/// Derived from the item id rather than minted, so every site that needs it —
/// the item's start, each output delta, its completion — names the same
/// terminal without threading state between them.
///
/// **Why a terminal at all.** The engine streams command output as deltas, and
/// a tool call's `content` on the thread is replace-not-append: rendering the
/// output as a text block meant rebuilding the whole block from everything
/// printed so far on every chunk, with the session lock held, and the
/// projector then rebuilt it again to compare — the cost of one chunk grew
/// with the length of the output it belonged to, so a `cargo build` streaming
/// megabytes cost megabytes of copying per chunk. A terminal is the shape the
/// thread already has an append path for (`terminal_output_appended`) and the
/// projector already has a fast path for (`project::sole_terminal`, ATL-219),
/// which is what ACP agents' terminals have always used. It also bounds the
/// buffer: `OutputBuffer` drops its front at the output byte limit, where the
/// text block grew without one.
///
/// **Lifetime.** The terminal lives as long as the tool call that names it,
/// which is as long as the thread — the same as the content block it replaces,
/// and the reason nothing sweeps it. What changed is the bound: each command
/// now retains at most the byte limit, where the aggregate in a content block
/// was retained in full. An interrupted command is the one case that retains
/// more than before (its accumulator used to be dropped at the turn's end,
/// taking the output the user was watching with it); it is bounded too, and
/// showing what a stopped command printed is the better answer.
fn command_terminal_id(item_id: &str) -> acp::TerminalId {
    acp::TerminalId::new(item_id.to_string())
}

/// Register `item_id`'s terminal on the thread if it is not there yet.
///
/// Idempotent: `Created` resets a terminal's buffer, so announcing one twice
/// would discard output already streamed into it. Output that arrives before
/// this runs is parked by the registry and drained on creation, so the order
/// of the engine's notifications does not matter.
fn ensure_command_terminal(
    thread: &AcpThreadHandle,
    item_id: &str,
    command: &str,
    cwd: &str,
) -> acp::TerminalId {
    ensure_command_terminal_in(&mut lock(thread), item_id, command, cwd)
}

/// [`ensure_command_terminal`] on a thread the caller already holds.
fn ensure_command_terminal_in(
    thread: &mut AcpThread,
    item_id: &str,
    command: &str,
    cwd: &str,
) -> acp::TerminalId {
    let terminal_id = command_terminal_id(item_id);
    if !thread.terminals().contains(&terminal_id) {
        thread.on_terminal_provider_event(TerminalProviderEvent::Created {
            terminal_id: terminal_id.clone(),
            label: command.to_string(),
            cwd: (!cwd.is_empty()).then(|| std::path::PathBuf::from(cwd)),
            // The engine declares no limit, so this lands on the same default a
            // `terminal/create` without one gets.
            output_byte_limit: None,
            // Display-only: the engine runs the command, so there is no PTY on
            // our side — the deltas are the entire capture.
            terminal: None,
        });
    }
    terminal_id
}

/// A command-execution item has finished: make sure its terminal exists, holds
/// the output, and carries the exit status.
fn settle_command_terminal(thread: &AcpThreadHandle, item: &ThreadItem) {
    settle_command_terminal_in(&mut lock(thread), item);
}

/// [`settle_command_terminal`] on a thread the caller already holds. Also the
/// replay path's way in (`replay::replay_turns`): a rollout item carries its
/// `aggregated_output`, and a tool call that names a terminal nobody created
/// renders an empty pane, so reopening a session has to run this for every
/// command it rebuilds.
///
/// **The aggregate is authoritative.** The completed item carries everything
/// the command printed, so the terminal is made to hold it whenever it holds
/// less: a provider that never streamed deltas has it as its only capture, and
/// a streamed run whose event stream dropped notifications under load (the
/// engine's feed is a broadcast that can lag) has a hole the aggregate repairs
/// — which is what the old replace-the-content-block behaviour did for free.
/// A terminal that already holds as much is left alone, so a cleanly streamed
/// run is not written twice. A truncated buffer is also left alone: the
/// aggregate's own tail is what it already holds, and re-writing a megabyte to
/// learn that is the cost this path exists to avoid.
pub(crate) fn settle_command_terminal_in(thread: &mut AcpThread, item: &ThreadItem) {
    let ThreadItem::CommandExecution {
        id,
        command,
        cwd,
        aggregated_output,
        exit_code,
        ..
    } = item
    else {
        return;
    };
    let terminal_id = ensure_command_terminal_in(thread, id.as_str(), command, cwd.as_str());

    if let Some(aggregate) = aggregated_output.as_deref().filter(|o| !o.is_empty()) {
        let current = thread
            .terminals()
            .get(&terminal_id)
            .map(atlas_acp_thread::AcpTerminal::current_output)
            .expect("just ensured");
        if !current.truncated && aggregate.len() > current.output.len() {
            if !current.output.is_empty() {
                // `Created` on a known id replaces the terminal: the only way
                // to drop a gapped capture through the provider-event seam.
                thread.on_terminal_provider_event(TerminalProviderEvent::Created {
                    terminal_id: terminal_id.clone(),
                    label: command.to_string(),
                    cwd: (!cwd.as_str().is_empty()).then(|| std::path::PathBuf::from(cwd.as_str())),
                    output_byte_limit: None,
                    terminal: None,
                });
            }
            thread.on_terminal_provider_event(TerminalProviderEvent::Output {
                terminal_id: terminal_id.clone(),
                data: aggregate.as_bytes().to_vec(),
            });
        }
    }

    let mut status = acp::TerminalExitStatus::new();
    // The engine reports a signed exit code; ACP's field is unsigned. A
    // negative code is how a signal is reported there, and the terminal's
    // `signal` field has no name to put in it, so it is dropped — the tool
    // call's own status already says the command failed.
    status.exit_code = exit_code.and_then(|code| u32::try_from(code).ok());
    thread.on_terminal_provider_event(TerminalProviderEvent::Exit {
        terminal_id,
        status,
    });
}

/// The command and cwd of a command-execution item, for its terminal's label.
fn command_of(item: &ThreadItem) -> Option<(&str, &str)> {
    match item {
        ThreadItem::CommandExecution { command, cwd, .. } => Some((command.as_str(), cwd.as_str())),
        _ => None,
    }
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
        // A child the agent delegated to. The engine reports each thing that
        // happens to one as its own item; Atlas renders it as a tool call
        // whose `rawInput` names the child, which is what
        // `atlas_acp_thread::subagent` reads to build a subagent row.
        //
        // The shape is deliberately the one the ACP adapter for this same
        // engine puts on the wire (`{agentThreadId, agentPath,
        // activityKind}`), so a native child and an external one are one case
        // for every layer above this — detection, projection and the UI —
        // rather than two.
        //
        // Before this the item fell through to `None`, so the native agent's
        // children were invisible: no tool row, nothing to attribute a
        // child's work to, and no subagent at all.
        ThreadItem::SubAgentActivity {
            id,
            kind,
            agent_thread_id,
            agent_path,
            prompt,
        } => {
            use atlas_engine_app_server_protocol::SubAgentActivityKind as K;
            let (activity, verb) = match kind {
                K::Started => ("started", "Start"),
                K::Interacted => ("interacted", "Interact with"),
                K::Interrupted => ("interrupted", "Interrupt"),
            };
            let name = subagent_name(agent_path);
            let mut input = serde_json::json!({
                "agentThreadId": agent_thread_id,
                "agentPath": agent_path,
                "activityKind": activity,
            });
            // The task, on a start: the panel's prompt bubble. The spawn call
            // that carries it is never an item of its own, so the engine
            // puts it on the activity.
            if let Some(prompt) = prompt.as_deref().filter(|p| !p.trim().is_empty()) {
                input["prompt"] = serde_json::Value::String(prompt.to_owned());
            }
            Some(
                acp::ToolCall::new(id.clone(), format!("{verb} subagent {name}"))
                    .kind(acp::ToolKind::Other)
                    // The activity is a fact about the child, not work the
                    // user waits on: the engine has already done it by the
                    // time the item arrives.
                    .status(acp::ToolCallStatus::Completed)
                    .raw_input(input),
            )
        }
        ThreadItem::CommandExecution {
            id,
            command,
            cwd,
            status,
            exit_code,
            // `aggregated_output` is deliberately not read: the terminal below
            // holds the output, and a provider that never streamed deltas has
            // its aggregate written into that terminal when the item completes
            // (`settle_command_terminal`).
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
            // The output is a TERMINAL, not a text block — see
            // `command_terminal_id`. The projector flattens a terminal into the
            // same `result` string a text block produced, so the wire shape the
            // UI reads is unchanged; what changes is that growth now streams as
            // a suffix instead of re-shipping everything printed so far.
            let call = acp::ToolCall::new(id.clone(), command.clone())
                .kind(acp::ToolKind::Execute)
                .status(status)
                .raw_input(serde_json::json!({ "command": command, "cwd": cwd }))
                .content(vec![acp::ToolCallContent::Terminal(acp::Terminal::new(
                    command_terminal_id(id.as_str()),
                ))]);
            Some(call)
        }
        ThreadItem::FileChange {
            id,
            changes,
            status,
        } => {
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
                    // What each file of `patch` is, for the renderer's per-turn
                    // view: `patch` alone cannot say a whole-content entry was
                    // an add or a delete, nor where two of them meet. Ranges
                    // into `patch`, not copies of it — every edit is stored,
                    // streamed and held in the store. Additive: capture reads
                    // `patch` first and stores the arguments whole.
                    "changes": file_changes_json(changes),
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

/// The edit's `changes` argument: one `{ path, kind, lines, movePath? }` per
/// file, in `patch` order.
///
/// `lines` is the half-open range `[start, end)` of `patch`'s lines (split on
/// `\n`) that holds this file's text, so `lines[start..end].join("\n")` is
/// its diff exactly. Line indices, not byte offsets: they count the same in
/// Rust's UTF-8 and the renderer's UTF-16. `patch` joins the per-file texts
/// with `\n`, so a text of `n` newlines spans `n + 1` lines and the next one
/// starts right after.
///
/// `kind` is `add` or `delete`, whose text is the file's whole content, or
/// `update` / `rename`, whose text is the headerless unified diff. A rename's
/// range stops before the `Moved to:` note the engine appends for display;
/// `movePath` states it as data instead.
fn file_changes_json(
    changes: &[atlas_engine_app_server_protocol::FileUpdateChange],
) -> serde_json::Value {
    use atlas_engine_app_server_protocol::PatchChangeKind as K;
    let line_count = |text: &str| text.split('\n').count();
    let mut start = 0;
    let mut out = Vec::with_capacity(changes.len());
    for change in changes {
        let path = change.path.as_str();
        let entry = match &change.kind {
            K::Add => serde_json::json!({
                "path": path, "kind": "add", "lines": [start, start + line_count(&change.diff)],
            }),
            K::Delete => serde_json::json!({
                "path": path, "kind": "delete", "lines": [start, start + line_count(&change.diff)],
            }),
            K::Update { move_path: None } => serde_json::json!({
                "path": path, "kind": "update", "lines": [start, start + line_count(&change.diff)],
            }),
            K::Update {
                move_path: Some(to),
            } => {
                let to = to.to_string_lossy();
                let note = format!("\n\nMoved to: {to}");
                let hunks = change.diff.strip_suffix(&note).unwrap_or(&change.diff);
                serde_json::json!({
                    "path": path,
                    "kind": "rename",
                    "lines": [start, start + line_count(hunks)],
                    "movePath": to,
                })
            }
        };
        out.push(entry);
        start += line_count(&change.diff);
    }
    serde_json::Value::Array(out)
}

/// Flattens a prompt into the single string the engine's text input takes.
///
/// Same rules as the previous native path so a prompt reads identically on both sides of
/// the switch: text passes through, a resource link contributes its URI, an
/// embedded text resource contributes its text, and anything else is skipped
/// rather than stringified into noise.
/// The last segment of an agent path: `/root/counter` → `counter`.
fn subagent_name(agent_path: &str) -> &str {
    agent_path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(agent_path)
}

/// A spawned child's turn ending, as the lifecycle step that ends its row.
///
/// The same shape as [`tool_call_of`]'s `SubAgentActivity` arm, and as the
/// external adapter for this engine's `Complete subagent …` call: the agent
/// path is what makes it the same row as the start. A failed turn is a
/// failed call, which the projection reads as a failed child; an interrupted
/// one is the `interrupted` step. The child's last reply is the content, so
/// the row carries what the child reported back.
///
/// `None` for a turn still in progress. Each of a child's turns ends with its
/// own step (the id names the turn), since a parent can hand one child more
/// work; the projection keeps the first terminal status it sees.
pub(crate) fn subagent_end_of(
    child_thread_id: &str,
    agent_path: &str,
    turn: &atlas_engine_app_server_protocol::Turn,
) -> Option<acp::ToolCall> {
    use atlas_engine_app_server_protocol::TurnStatus as S;
    let (activity, verb, status) = match turn.status {
        S::Completed => ("completed", "Complete", acp::ToolCallStatus::Completed),
        S::Failed => ("completed", "Complete", acp::ToolCallStatus::Failed),
        S::Interrupted => ("interrupted", "Interrupt", acp::ToolCallStatus::Completed),
        S::InProgress => return None,
    };
    let name = subagent_name(agent_path);
    let mut call = acp::ToolCall::new(
        format!("subagent-end-{child_thread_id}-{}", turn.id),
        format!("{verb} subagent {name}"),
    )
    .kind(acp::ToolKind::Other)
    .status(status)
    .raw_input(serde_json::json!({
        "agentThreadId": child_thread_id,
        "agentPath": agent_path,
        "activityKind": activity,
    }));
    let reply = turn.items.iter().rev().find_map(|item| match item {
        ThreadItem::AgentMessage { text, .. } if !text.trim().is_empty() => Some(text.clone()),
        _ => None,
    });
    let report = reply.or_else(|| turn.error.as_ref().map(|e| e.message.clone()));
    if let Some(text) = report {
        call = call.content(vec![acp::ToolCallContent::Content(acp::Content::new(
            owned_text_block(text),
        ))]);
    }
    Some(call)
}

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
    thread
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
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
            // Before the session check: a child's own spawns arrive on the
            // child's thread, which is no session, and a stop must reach them.
            sessions.note_spawned_child(&params.thread_id, &params.item);
            let id = session_id(&params.thread_id);
            let Some(thread) = sessions.thread(&id) else {
                return;
            };
            match &params.item {
                ThreadItem::AgentMessage {
                    id: item_id, text, ..
                } => {
                    if sessions.already_streamed(&id, item_id) || text.is_empty() {
                        return;
                    }
                    lock(&thread).push_assistant_content_block(text_block(text), false);
                }
                ThreadItem::Reasoning {
                    id: item_id,
                    summary,
                    content,
                    ..
                } => {
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
                        settle_command_terminal(&thread, item);
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
            sessions.note_spawned_child(&params.thread_id, &params.item);
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
                // Before the upsert: the tool call's content names this
                // terminal, and a call referencing one the thread does not hold
                // flattens to an empty result.
                if let Some((command, cwd)) = command_of(&params.item) {
                    ensure_command_terminal(&thread, params.item.id(), command, cwd);
                }
                let _ = lock(&thread).upsert_tool_call(call);
            }
        }

        // Live command output — appended to the item's terminal.
        //
        // One append of the chunk, and the projector ships the same chunk on as
        // a `tool_call_output_chunk`. This used to accumulate the output here
        // and hand the tool call a fresh content block holding ALL of it on
        // every delta, which the projector then rebuilt again to diff: five
        // copies of everything printed so far, per chunk, under the session
        // lock. See `command_terminal_id`.
        ServerNotification::CommandExecutionOutputDelta(params) => {
            let session = session_id(&params.thread_id);
            let Some(thread) = sessions.thread(&session) else {
                return;
            };
            // Not `ensure_command_terminal`: this notification carries no
            // command label, and the registry parks output for a terminal it
            // has not seen and drains it on creation.
            lock(&thread).on_terminal_provider_event(TerminalProviderEvent::Output {
                terminal_id: command_terminal_id(&params.item_id),
                data: params.delta.into_bytes(),
            });
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
        //
        // A spawned child's turns arrive here too: the in-process server
        // listens on every thread it creates, children included. A child's
        // end is reported nowhere on the parent's thread — v2's `wait_agent`
        // names no child — so this is where its row is closed.
        ServerNotification::TurnCompleted(params) => {
            if let Some((parent, agent_path)) = sessions.spawned_child(&params.thread_id) {
                let end = subagent_end_of(&params.thread_id, &agent_path, &params.turn);
                if let (Some(thread), Some(call)) = (sessions.thread(&parent), end) {
                    let _ = lock(&thread).upsert_tool_call(call);
                }
            }
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
                // D8 recorded this as an accepted loss because the engine
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

    /// The native agent's children reach the ACP surface in the same shape
    /// the external adapter for this engine puts on the wire, so one
    /// detection rule serves both (`atlas_acp_thread::subagent`). The item
    /// used to fall through to `None`, which made native children invisible.
    #[test]
    fn a_subagent_activity_becomes_a_tool_call_the_detector_reads() {
        use atlas_engine_app_server_protocol::SubAgentActivityKind as K;

        let item = |kind| ThreadItem::SubAgentActivity {
            id: "sa-1".to_string(),
            kind,
            agent_thread_id: "thr-9".to_string(),
            agent_path: "/root/code_reviewer".to_string(),
            prompt: Some("Review the diff.".to_string()),
        };

        let call = tool_call_of(&item(K::Started)).expect("a tool call");
        assert_eq!(call.title, "Start subagent code_reviewer");
        let input = call.raw_input.clone().expect("the child is named");
        assert_eq!(input["agentPath"], "/root/code_reviewer");
        assert_eq!(input["agentThreadId"], "thr-9");
        assert_eq!(input["activityKind"], "started");

        // And the detector reads it, which is the whole point of the shape.
        let launch = atlas_acp_thread::subagent::launch_of(
            None,
            Some(call.title.as_str()),
            call.raw_input.as_ref(),
            None,
        )
        .expect("the detector recognises a native child");
        assert_eq!(launch.name, "Code reviewer");
        assert_eq!(launch.native_id.as_deref(), Some("/root/code_reviewer"));
        // The task rides along, so the panel has a prompt to show, and the
        // child is marked as running on a thread of its own.
        assert_eq!(launch.prompt.as_deref(), Some("Review the diff."));
        assert!(launch.own_thread);

        for (kind, expected) in [
            (K::Started, "started"),
            (K::Interacted, "interacted"),
            (K::Interrupted, "interrupted"),
        ] {
            let call = tool_call_of(&item(kind)).expect("a tool call");
            assert_eq!(call.raw_input.unwrap()["activityKind"], expected);
        }
    }

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
            assert!(
                sessions
                    .wait_for_mcp_servers("t1", Duration::from_secs(5))
                    .await
            );
        }

        #[tokio::test]
        async fn a_server_that_never_settles_is_given_up_on() {
            let sessions = EngineSessions::default();
            sessions.expect_mcp_servers("t1", ["atlas_memory".to_string()]);
            sessions.record_mcp_status("t1", "atlas_memory", false);
            assert!(
                !sessions
                    .wait_for_mcp_servers("t1", Duration::from_millis(20))
                    .await
            );
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
        let link =
            acp::ContentBlock::ResourceLink(acp::ResourceLink::new("a.rs", "file:///tmp/a.rs"));
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
    fn an_aborted_commands_output_is_bounded_and_kept() {
        // #66 was an UNBOUNDED accumulator: a task interrupted by Stop is
        // aborted after its 100 ms grace and never completes, so its output
        // was never cleared and stayed for the life of the process — one
        // verbose build per press of Stop. The fix then was to drop it at the
        // turn's end, which also threw away output the user had been watching.
        //
        // The output now lives in the item's terminal, whose `OutputBuffer`
        // drops its front at the byte limit. So the leak is bounded by
        // construction rather than by a sweep, and an aborted command still
        // shows what it printed.
        let thread = crate::engine::test_support::detached_thread(acp::SessionId::new("t1"));
        let terminal = ensure_command_terminal(&thread, "item-1", "cargo build", "/tmp");

        lock(&thread).on_terminal_provider_event(TerminalProviderEvent::Output {
            terminal_id: terminal.clone(),
            data: b"a very verbose build log".to_vec(),
        });
        // No TurnCompleted, no ItemCompleted — the interrupted case.
        assert_eq!(
            lock(&thread).terminal_output(&terminal).as_deref(),
            Some("a very verbose build log"),
            "an aborted command keeps the output the user was watching",
        );
        assert!(
            lock(&thread).terminals().contains(&terminal),
            "and it is held by the terminal, whose buffer is capped",
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
            ServerNotification::ItemCompleted(
                atlas_engine_app_server_protocol::ItemCompletedNotification {
                    thread_id: "t-patch".to_string(),
                    turn_id: "turn-1".to_string(),
                    item: ThreadItem::FileChange {
                        id: "item-1".to_string(),
                        status: atlas_engine_app_server_protocol::PatchApplyStatus::Completed,
                        changes: vec![atlas_engine_app_server_protocol::FileUpdateChange {
                            path: "src/foo.rs".to_string(),
                            kind: atlas_engine_app_server_protocol::PatchChangeKind::Update {
                                move_path: None,
                            },
                            diff: "@@ -1 +1 @@\n-old\n+new\n".to_string(),
                        }],
                    },
                    completed_at_ms: 0,
                },
            ),
        );

        let locked = thread
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
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
        assert!(
            patch.contains("+new"),
            "the patch is the engine's own diff: {patch}"
        );
    }

    #[test]
    fn a_file_change_names_each_file_with_its_kind() {
        // The joined `patch` cannot say whether a whole-content entry was an
        // add or a delete, nor where two of them meet; `changes` can. It is
        // additive: `paths` and `patch` stay exactly as capture reads them.
        use atlas_engine_app_server_protocol::FileUpdateChange;
        use atlas_engine_app_server_protocol::PatchChangeKind as K;
        let change = |path: &str, kind: K, diff: &str| FileUpdateChange {
            path: path.to_string(),
            kind,
            diff: diff.to_string(),
        };
        let item = ThreadItem::FileChange {
            id: "item-1".to_string(),
            status: atlas_engine_app_server_protocol::PatchApplyStatus::Completed,
            changes: vec![
                change("/r/a.rs", K::Add, "fn a() {}\n"),
                change("/r/b.rs", K::Delete, "fn b() {}\n"),
                change(
                    "/r/c.rs",
                    K::Update {
                        move_path: Some(std::path::PathBuf::from("/r/d.rs")),
                    },
                    "@@ -1 +1 @@\n-c\n+d\n\n\nMoved to: /r/d.rs",
                ),
                change(
                    "/r/e.rs",
                    K::Update { move_path: None },
                    "@@ -1 +1 @@\n-e\n+E\n",
                ),
            ],
        };
        let call = tool_call_of(&item).expect("a file change is a tool call");
        let args = call.raw_input.expect("the edit carries arguments");
        assert_eq!(
            args["changes"],
            serde_json::json!([
                { "path": "/r/a.rs", "kind": "add", "lines": [0, 2] },
                { "path": "/r/b.rs", "kind": "delete", "lines": [2, 4] },
                {
                    "path": "/r/c.rs",
                    "kind": "rename",
                    "lines": [4, 8],
                    "movePath": "/r/d.rs",
                },
                { "path": "/r/e.rs", "kind": "update", "lines": [10, 14] },
            ]),
        );
        // Each range, sliced out of `patch` by lines, is that file's text
        // exactly — the rename's without its `Moved to:` note.
        let patch = args["patch"].as_str().expect("the patch is text");
        let lines: Vec<&str> = patch.split('\n').collect();
        let texts: Vec<String> = args["changes"]
            .as_array()
            .expect("changes is a list")
            .iter()
            .map(|entry| {
                let range = &entry["lines"];
                let (start, end) = (
                    range[0].as_u64().expect("a start") as usize,
                    range[1].as_u64().expect("an end") as usize,
                );
                lines[start..end].join("\n")
            })
            .collect();
        assert_eq!(
            texts,
            [
                "fn a() {}\n",
                "fn b() {}\n",
                "@@ -1 +1 @@\n-c\n+d\n",
                "@@ -1 +1 @@\n-e\n+E\n",
            ],
        );
        assert_eq!(
            args["paths"],
            serde_json::json!(["/r/a.rs", "/r/b.rs", "/r/c.rs", "/r/e.rs"]),
        );
        assert_eq!(
            args["patch"],
            "fn a() {}\n\nfn b() {}\n\n@@ -1 +1 @@\n-c\n+d\n\n\nMoved to: /r/d.rs\n@@ -1 +1 @@\n-e\n+E\n",
            "the joined patch is unchanged",
        );
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

/// Command output reaches the wire as a terminal, which is what makes a chatty
/// command cheap to project (ATL-219, and `command_terminal_id`).
///
/// These assert the SHAPE the projector's fast path requires — a tool call
/// whose content is exactly one terminal, and a terminal that grows by the
/// chunk. `atlas-agent-delta`'s `a_growing_display_only_terminal_streams_only_
/// its_tail` asserts what that shape then costs on the wire.
#[cfg(test)]
mod command_output {
    use super::*;
    use atlas_engine_app_server_protocol::{ItemCompletedNotification, ItemStartedNotification};

    /// Built through the protocol's own serde shape rather than the struct
    /// literal: `cwd` is a `LegacyAppPathString` from an engine crate this one
    /// does not depend on directly, and deserializing is also closer to what
    /// the engine actually sends.
    fn command_item(id: &str, status: &str, output: Option<&str>, exit: Option<i32>) -> ThreadItem {
        serde_json::from_value(serde_json::json!({
            "type": "commandExecution",
            "id": id,
            "command": "cargo build",
            "cwd": "/tmp/project",
            "processId": null,
            "status": status,
            "commandActions": [],
            "aggregatedOutput": output,
            "exitCode": exit,
            "durationMs": null,
        }))
        .expect("a command-execution item")
    }

    struct Fixture {
        sessions: EngineSessions,
        turns: TurnWaiters,
        thread: AcpThreadHandle,
        session: acp::SessionId,
    }

    fn fixture() -> Fixture {
        let session = acp::SessionId::new("thread-1");
        let thread = crate::engine::test_support::detached_thread(session.clone());
        let sessions = EngineSessions::default();
        sessions.insert(session.clone(), &thread, "/tmp/project".to_string());
        Fixture {
            sessions,
            turns: TurnWaiters::default(),
            thread,
            session,
        }
    }

    impl Fixture {
        fn apply(&self, notification: ServerNotification) {
            apply_notification(&self.sessions, &self.turns, 3, notification);
        }

        fn started(&self, id: &str) {
            self.apply(ServerNotification::ItemStarted(ItemStartedNotification {
                item: command_item(id, "inProgress", None, None),
                thread_id: self.session.to_string(),
                turn_id: "turn-1".into(),
                started_at_ms: 0,
            }));
        }

        fn output(&self, id: &str, delta: &str) {
            self.apply(ServerNotification::CommandExecutionOutputDelta(
                atlas_engine_app_server_protocol::CommandExecutionOutputDeltaNotification {
                    thread_id: self.session.to_string(),
                    turn_id: "turn-1".into(),
                    item_id: id.to_string(),
                    delta: delta.to_string(),
                },
            ));
        }

        /// Run `check` against the tool call's content, as the projector sees
        /// it. By reference: `ToolCallContent` is deliberately not `Clone`.
        fn with_content<R>(
            &self,
            id: &str,
            check: impl FnOnce(&[atlas_acp_thread::ToolCallContent]) -> R,
        ) -> R {
            let guard = lock(&self.thread);
            let content = guard
                .entries()
                .iter()
                .find_map(|entry| match entry {
                    atlas_acp_thread::AgentThreadEntry::ToolCall(call)
                        if call.id.0.as_ref() == id =>
                    {
                        Some(call.content.as_slice())
                    }
                    _ => None,
                })
                .unwrap_or_else(|| panic!("no tool call {id}"));
            check(content)
        }

        /// Whether the content is exactly the one terminal `sole_terminal`
        /// needs to see for the projector to take its cheap path.
        fn is_sole_terminal(&self, id: &str) -> bool {
            self.with_content(id, |content| {
                matches!(content, [atlas_acp_thread::ToolCallContent::Terminal(t)]
                    if *t == command_terminal_id(id))
            })
        }

        fn terminal_output(&self, id: &str) -> Option<String> {
            lock(&self.thread).terminal_output(&command_terminal_id(id))
        }
    }

    /// v2 reports a child's start on the parent and its end only on the
    /// child's own thread, and `wait_agent` names no child — so a native
    /// child stayed "running" for the life of the session. Its own
    /// `TurnCompleted` now closes the row, under the same agent path.
    #[test]
    fn a_spawned_childs_own_turn_ending_closes_its_row_on_the_parent() {
        use atlas_acp_thread::subagent::{activity, Activity};
        use atlas_acp_thread::AgentThreadEntry;
        use atlas_engine_app_server_protocol::{
            SubAgentActivityKind, Turn, TurnCompletedNotification, TurnStatus,
        };

        let f = fixture();
        f.apply(ServerNotification::ItemStarted(ItemStartedNotification {
            item: ThreadItem::SubAgentActivity {
                id: "call-spawn".into(),
                kind: SubAgentActivityKind::Started,
                agent_thread_id: "child-1".into(),
                agent_path: "/root/counter".into(),
                prompt: None,
            },
            thread_id: f.session.to_string(),
            turn_id: "turn-1".into(),
            started_at_ms: 0,
        }));

        let turn = |id: &str, status, text: &str| Turn {
            id: id.into(),
            items: vec![ThreadItem::AgentMessage {
                id: format!("{id}-msg"),
                text: text.into(),
                phase: None,
                memory_citation: None,
            }],
            items_view: Default::default(),
            status,
            error: None,
            started_at: None,
            completed_at: None,
            duration_ms: None,
        };
        // A turn of a thread nobody spawned is not a child's.
        f.apply(ServerNotification::TurnCompleted(
            TurnCompletedNotification {
                thread_id: "stranger".into(),
                turn: turn("t-0", TurnStatus::Completed, "not mine"),
            },
        ));
        f.apply(ServerNotification::TurnCompleted(
            TurnCompletedNotification {
                thread_id: "child-1".into(),
                turn: turn("t-1", TurnStatus::Completed, "There are 42 files."),
            },
        ));

        let thread = lock(&f.thread);
        let calls: Vec<_> = thread
            .entries()
            .iter()
            .filter_map(|entry| match entry {
                AgentThreadEntry::ToolCall(call) => Some(call),
                _ => None,
            })
            .collect();
        assert_eq!(
            calls.len(),
            2,
            "the start and the end, nothing for the stranger"
        );
        let end = calls[1];
        assert_eq!(end.label, "Complete subagent counter");
        assert_eq!(activity(end.raw_input.as_ref()), Some(Activity::Completed));
        let identity = |call: &atlas_acp_thread::ToolCall| {
            call.launched_subagent
                .as_ref()
                .and_then(|launch| launch.native_id.clone())
        };
        assert_eq!(identity(end), Some("/root/counter".to_owned()));
        assert_eq!(identity(end), identity(calls[0]), "one child, one row");
        assert!(
            format!("{:?}", end.content).contains("There are 42 files."),
            "the child's reply is what the row reports"
        );
    }

    #[test]
    fn a_stop_reaches_every_subagent_the_session_spawned_and_theirs() {
        use atlas_engine_app_server_protocol::SubAgentActivityKind;

        let f = fixture();
        let spawn = |on: &str, child: &str| {
            f.apply(ServerNotification::ItemStarted(ItemStartedNotification {
                item: ThreadItem::SubAgentActivity {
                    id: format!("call-{child}"),
                    kind: SubAgentActivityKind::Started,
                    agent_thread_id: child.into(),
                    agent_path: format!("/root/{child}"),
                    prompt: None,
                },
                thread_id: on.into(),
                turn_id: "turn-1".into(),
                started_at_ms: 0,
            }));
        };
        let parent = f.session.to_string();
        spawn(&parent, "child-1");
        spawn(&parent, "child-2");
        spawn("child-1", "grandchild");
        // Another session's child is not this stop's to reach.
        spawn("thread-2", "elsewhere");

        let mut reached = f.sessions.descendants_of(&parent);
        reached.sort();
        assert_eq!(reached, ["child-1", "child-2", "grandchild"]);
        assert_eq!(f.sessions.descendants_of("child-1"), ["grandchild"]);
        assert!(f.sessions.descendants_of("grandchild").is_empty());

        // The sweep at the next insert keeps the whole chain under a live
        // session, and drops the child of a session that is gone.
        let other = acp::SessionId::new("thread-3");
        let other_thread = crate::engine::test_support::detached_thread(other.clone());
        f.sessions
            .insert(other, &other_thread, "/tmp/project".to_string());
        let mut reached = f.sessions.descendants_of(&parent);
        reached.sort();
        assert_eq!(reached, ["child-1", "child-2", "grandchild"]);
        assert!(f.sessions.spawned_child("elsewhere").is_none());
    }

    /// A subagent asks for approval under its own engine thread. The card
    /// belongs on the session that spawned it — and a child that asks before
    /// its parent's `Started` activity has placed it is waited for, not
    /// refused (live, its command failed "no open thread for this approval").
    #[tokio::test]
    async fn a_childs_approval_finds_the_session_that_spawned_it() {
        use atlas_engine_app_server_protocol::SubAgentActivityKind;

        let f = std::sync::Arc::new(fixture());
        let parent = f.session.to_string();
        let spawn = |on: &str, child: &str| {
            f.apply(ServerNotification::ItemStarted(ItemStartedNotification {
                item: ThreadItem::SubAgentActivity {
                    id: format!("call-{child}"),
                    kind: SubAgentActivityKind::Started,
                    agent_thread_id: child.into(),
                    agent_path: format!("/root/{child}"),
                    prompt: None,
                },
                thread_id: on.into(),
                turn_id: "turn-1".into(),
                started_at_ms: 0,
            }));
        };

        assert_eq!(f.sessions.owning_session(&parent), Some(f.session.clone()));
        assert_eq!(f.sessions.owning_session("child-1"), None, "not placed yet");

        // Asked first, placed a moment later.
        let waiting = {
            let f = f.clone();
            tokio::spawn(async move {
                f.sessions
                    .wait_for_owner("child-1", std::time::Duration::from_secs(5))
                    .await
            })
        };
        tokio::task::yield_now().await;
        spawn(&parent, "child-1");
        assert_eq!(waiting.await.unwrap(), Some(f.session.clone()));

        spawn("child-1", "grandchild");
        assert_eq!(
            f.sessions.owning_session("grandchild"),
            Some(f.session.clone())
        );

        // A thread no session spawned stays unowned, and the wait gives up.
        assert_eq!(
            f.sessions
                .wait_for_owner("stranger", std::time::Duration::from_millis(50))
                .await,
            None
        );
    }

    #[test]
    fn subagent_end_steps_follow_the_turns_outcome() {
        use atlas_acp_thread::subagent::{activity, Activity};
        use atlas_engine_app_server_protocol::{Turn, TurnError, TurnStatus};

        let turn = |status, error: Option<&str>| Turn {
            id: "t".into(),
            items: Vec::new(),
            items_view: Default::default(),
            status,
            error: error.map(|message| TurnError {
                message: message.into(),
                atlas_engine_error_info: None,
                additional_details: None,
                retry_delay_ms: None,
            }),
            started_at: None,
            completed_at: None,
            duration_ms: None,
        };
        let end = |t| super::subagent_end_of("c", "/root/x", &t);

        assert!(end(turn(TurnStatus::InProgress, None)).is_none());

        let failed = end(turn(TurnStatus::Failed, Some("model refused"))).unwrap();
        assert_eq!(failed.status, acp::ToolCallStatus::Failed);
        assert!(format!("{:?}", failed.content).contains("model refused"));

        let interrupted = end(turn(TurnStatus::Interrupted, None)).unwrap();
        assert_eq!(
            activity(interrupted.raw_input.as_ref()),
            Some(Activity::Interrupted)
        );
        assert_eq!(interrupted.title, "Interrupt subagent x");
    }

    #[test]
    fn a_running_command_renders_as_exactly_one_terminal() {
        let f = fixture();
        f.started("item-1");

        // `sole_terminal` — the projector's fast-path gate — matches only a
        // content array of exactly one terminal. A text block, or a terminal
        // beside anything else, falls back to rebuilding the whole result.
        assert!(
            f.is_sole_terminal("item-1"),
            "the tool call must be exactly one terminal naming the item",
        );
    }

    #[test]
    fn output_deltas_append_to_the_terminal() {
        let f = fixture();
        f.started("item-1");
        f.output("item-1", "Compiling atlas");
        f.output("item-1", " v0.4.1\n");

        assert_eq!(
            f.terminal_output("item-1").as_deref(),
            Some("Compiling atlas v0.4.1\n"),
        );
        // Still exactly one terminal: appending must not rewrite the content.
        assert!(f.is_sole_terminal("item-1"));
    }

    #[test]
    fn output_that_arrives_before_the_item_starts_is_not_lost() {
        // The registry parks output for a terminal it has not seen and drains
        // it on creation, so the engine's notification order does not matter.
        let f = fixture();
        f.output("item-1", "early bytes\n");
        f.started("item-1");

        assert_eq!(
            f.terminal_output("item-1").as_deref(),
            Some("early bytes\n")
        );
    }

    #[test]
    fn a_provider_that_never_streams_gets_its_aggregate_written_once() {
        // Some providers report no deltas at all and carry the whole capture
        // on the completed item. Without this the output pane stayed blank.
        let f = fixture();
        f.apply(ServerNotification::ItemCompleted(
            ItemCompletedNotification {
                item: command_item("item-1", "completed", Some("the whole log\n"), Some(0)),
                thread_id: f.session.to_string(),
                turn_id: "turn-1".into(),
                completed_at_ms: 1,
            },
        ));

        assert_eq!(
            f.terminal_output("item-1").as_deref(),
            Some("the whole log\n")
        );
    }

    #[test]
    fn a_streamed_commands_aggregate_is_not_appended_twice() {
        // The completed item repeats what the deltas already delivered. Writing
        // it on top would show the command's output twice.
        let f = fixture();
        f.started("item-1");
        f.output("item-1", "streamed\n");

        f.apply(ServerNotification::ItemCompleted(
            ItemCompletedNotification {
                item: command_item("item-1", "completed", Some("streamed\n"), Some(0)),
                thread_id: f.session.to_string(),
                turn_id: "turn-1".into(),
                completed_at_ms: 1,
            },
        ));

        assert_eq!(f.terminal_output("item-1").as_deref(), Some("streamed\n"));
    }

    #[test]
    fn a_gapped_stream_is_repaired_by_the_completed_items_aggregate() {
        // The engine's event feed is a broadcast that can lag and drop
        // notifications. The completed item carries the whole capture, and a
        // terminal holding less than it is made to hold all of it — the
        // self-healing the old replace-the-content-block path had for free.
        let f = fixture();
        f.started("item-1");
        f.output("item-1", "line 1\n");
        // line 2 was dropped on the way
        f.output("item-1", "line 3\n");

        f.apply(ServerNotification::ItemCompleted(
            ItemCompletedNotification {
                item: command_item(
                    "item-1",
                    "completed",
                    Some("line 1\nline 2\nline 3\n"),
                    Some(0),
                ),
                thread_id: f.session.to_string(),
                turn_id: "turn-1".into(),
                completed_at_ms: 1,
            },
        ));

        assert_eq!(
            f.terminal_output("item-1").as_deref(),
            Some("line 1\nline 2\nline 3\n"),
        );
        assert!(
            f.is_sole_terminal("item-1"),
            "repair keeps the terminal shape"
        );
    }

    #[test]
    fn announcing_a_terminal_twice_keeps_the_output_it_already_has() {
        // `Created` resets a terminal's buffer, so `ensure_command_terminal`
        // has to be idempotent — the engine announces an item more than once.
        let f = fixture();
        f.started("item-1");
        f.output("item-1", "kept\n");
        f.started("item-1");

        assert_eq!(f.terminal_output("item-1").as_deref(), Some("kept\n"));
    }
}

/// What a chatty command costs the sink, old shape vs new.
///
/// Ignored by default: this measures time, and a loaded machine is not a
/// regression. Kept because the claim is about how the cost SCALES, and a
/// benchmark that no longer exists cannot be re-run against a later change.
///
/// ```text
/// cargo test -p atlas-native-agent --release --lib command_output_cost -- --ignored --nocapture
/// ```
#[cfg(test)]
mod command_output_cost {
    use super::*;
    use std::time::{Duration, Instant};

    /// The old path, reproduced: accumulate every byte the command has printed,
    /// then hand the tool call a fresh content block holding all of it.
    fn old_shape(thread: &AcpThreadHandle, total: &mut String, item_id: &str, delta: &str) {
        total.push_str(delta);
        let update = acp::ToolCallUpdate::new(
            acp::ToolCallId::new(item_id.to_string()),
            acp::ToolCallUpdateFields::new().content(vec![acp::ToolCallContent::Content(
                acp::Content::new(owned_text_block(total.clone())),
            )]),
        );
        let _ =
            lock(thread).update_tool_call(atlas_acp_thread::ToolCallUpdate::UpdateFields(update));
    }

    fn drive(chunks: usize, chunk_len: usize, old: bool) -> Duration {
        let session = acp::SessionId::new("bench");
        let thread = crate::engine::test_support::detached_thread(session.clone());
        let sessions = EngineSessions::default();
        sessions.insert(session, &thread, "/tmp".to_string());

        let terminal = ensure_command_terminal(&thread, "item-1", "cargo build", "/tmp");
        let payload = "y".repeat(chunk_len);
        let mut total = String::new();

        let start = Instant::now();
        for _ in 0..chunks {
            if old {
                old_shape(&thread, &mut total, "item-1", &payload);
            } else {
                lock(&thread).on_terminal_provider_event(TerminalProviderEvent::Output {
                    terminal_id: terminal.clone(),
                    data: payload.clone().into_bytes(),
                });
            }
        }
        start.elapsed()
    }

    #[test]
    #[ignore = "timing, not correctness"]
    fn a_chatty_commands_output_costs_its_own_length() {
        println!();
        let mut rows = Vec::new();
        for chunks in [500usize, 2_000, 8_000] {
            let old = drive(chunks, 200, true);
            let new = drive(chunks, 200, false);
            println!(
                "  {chunks:>5} chunks x 200 B ({:>5} KB total)   content-block: {old:>12?}   terminal: {new:>10?}   {:.0}x",
                chunks * 200 / 1024,
                old.as_secs_f64() / new.as_secs_f64().max(f64::MIN_POSITIVE),
            );
            rows.push((old, new));
        }
        println!();

        // Four times the chunks should cost about four times the time, not
        // sixteen. Compared against the smallest run so one noisy sample
        // cannot flip the verdict.
        let (old_small, new_small) = rows[0];
        let (old_big, new_big) = rows[2];
        let old_ratio = old_big.as_secs_f64() / old_small.as_secs_f64();
        let new_ratio = new_big.as_secs_f64() / new_small.as_secs_f64();
        println!("  16x the chunks: content-block {old_ratio:.1}x, terminal {new_ratio:.1}x (linear is 16)");
        assert!(
            new_ratio < old_ratio / 2.0,
            "the terminal path should scale far better: {new_ratio:.1}x vs {old_ratio:.1}x"
        );
    }
}

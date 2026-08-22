//! The stateful half: what changed, and therefore which delta to send.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{
    AcpThread, AcpThreadEvent, AcpThreadHandle, AgentThreadEntry, ElicitationEntryId, EventStream,
    LoadError, ToolCallStatus as ThreadToolCallStatus,
};
use atlas_agent_servers::ThreadEventSink;
use atlas_agent_wire::{
    AgentId, DeltaSink, Emitter, SessionDelta, SessionDeltaEnvelope, SessionStatus, ToolCall, Usage,
};
use uuid::Uuid;

use crate::project;

/// Ties a wire permission request back to the tool call waiting on it.
///
/// The wire identifies a permission prompt by a `Uuid` and the thread by a
/// `ToolCallId`; the host answers with the former and has to reach the latter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionKey {
    pub session_id: acp::SessionId,
    pub tool_call_id: acp::ToolCallId,
}

/// Ties a wire elicitation request back to the thread entry waiting on it.
///
/// Same shape and same reason as [`PermissionKey`]: the wire names an
/// elicitation by a `Uuid` and the thread by an [`ElicitationEntryId`], and the
/// host answers with the former.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ElicitationKey {
    pub session_id: acp::SessionId,
    pub entry_id: ElicitationEntryId,
}

/// Projects every attached thread's events onto the frozen wire.
///
/// One projector serves every session: it hands out the per-session event sink
/// that `ConnectOptions` wants, and each attached thread gets a task that
/// applies its events in order.
pub struct DeltaProjector {
    emitter: Emitter,
    sessions: Mutex<HashMap<acp::SessionId, Arc<Mutex<SessionProjection>>>>,
    /// Event streams for sessions whose thread does not exist yet.
    ///
    /// `ConnectOptions` asks for a session's sink while `session/new` is still
    /// in flight, so the channel has to exist before the thread does. Buffering
    /// here is what stops the updates that replay history during `session/load`
    /// from being dropped — the same pre-registration the transport does.
    pending: Mutex<HashMap<acp::SessionId, EventStream<AcpThreadEvent>>>,
    permissions: Mutex<HashMap<Uuid, PermissionKey>>,
    elicitations: Mutex<HashMap<Uuid, ElicitationKey>>,
}

impl DeltaProjector {
    pub fn new(sink: Arc<dyn DeltaSink>) -> Arc<Self> {
        Arc::new(Self {
            emitter: Emitter::new(sink),
            sessions: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            permissions: Mutex::new(HashMap::new()),
            elicitations: Mutex::new(HashMap::new()),
        })
    }

    /// The sink factory to hand to `ConnectOptions`.
    pub fn thread_events(self: &Arc<Self>) -> ThreadEventSink {
        let this = self.clone();
        Arc::new(move |session_id: &acp::SessionId| {
            let (tx, rx) = atlas_acp_thread::event_channel();
            this.pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(session_id.clone(), rx);
            tx
        })
    }

    /// Start projecting `thread`'s events on a task of its own.
    ///
    /// Called once the session exists. Anything the thread emitted before this
    /// is still in the channel and is applied first, in order.
    ///
    /// Note what the task does *not* guarantee: it applies each event against
    /// the thread as it is when the event is drained, not as it was when the
    /// event was emitted. A burst of chunks that lands before the task wakes is
    /// therefore projected as one `message_appended` carrying all of it rather
    /// than a message and a chunk. Both describe the same conversation — every
    /// delta carries the full state it announces, and none is skipped — so a
    /// consumer cannot tell the difference. A host that needs the finer grain
    /// pumps the stream itself with [`Self::register`].
    pub fn attach(self: &Arc<Self>, agent_id: AgentId, thread: AcpThreadHandle) {
        let session_id = lock_thread(&thread).session_id().clone();
        let Some(mut events) = self.register(agent_id, thread) else {
            return;
        };
        let this = self.clone();
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                this.apply(&session_id, event);
            }
            this.sessions
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&session_id);
        });
    }

    /// Set up a session's projection and hand back its event stream.
    ///
    /// The half of [`Self::attach`] that does not spawn: a caller that wants to
    /// decide when events are applied — a test, or a host with its own runtime —
    /// drains the stream and calls [`Self::apply`] itself.
    pub fn register(
        self: &Arc<Self>,
        agent_id: AgentId,
        thread: AcpThreadHandle,
    ) -> Option<EventStream<AcpThreadEvent>> {
        let session_id = lock_thread(&thread).session_id().clone();
        let Some(events) = self
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&session_id)
        else {
            // No stream was handed out for this session, so nothing will ever
            // arrive. Attaching anyway would silently project nothing.
            tracing::warn!(
                target: "atlas_agent_delta",
                session = %session_id,
                "no event stream for this session; was `thread_events` used for this connection?"
            );
            return None;
        };

        let projection = Arc::new(Mutex::new(SessionProjection::new(
            agent_id,
            session_id.clone(),
            thread,
        )));
        self.sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(session_id, projection);

        Some(events)
    }

    /// Subscribe to every delta in-process, without going through the host sink.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<SessionDeltaEnvelope> {
        self.emitter.subscribe()
    }

    /// Stamp this session's deltas with the turn identity the host assigned.
    ///
    /// Turn identity belongs to the send path, not to the thread: capture reads
    /// it from the binding it wrote at `note_prompt` time, and the frontend uses
    /// it to drop a terminal that belongs to a superseded turn.
    pub fn set_turn_seq(&self, session_id: &acp::SessionId, turn_seq: u64) {
        self.with_session(session_id, |projection| projection.turn_seq = turn_seq);
    }

    /// The model this session's assistant messages should be attributed to.
    pub fn set_model(&self, session_id: &acp::SessionId, model: Option<String>) {
        self.with_session(session_id, |projection| projection.model = model);
    }

    /// Which tool call a wire permission request is about.
    pub fn permission_key(&self, request_id: &Uuid) -> Option<PermissionKey> {
        self.permissions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(request_id)
            .cloned()
    }

    /// Which thread entry a wire elicitation request is about.
    ///
    /// The host answers an elicitation by the `request_id` it saw on the wire,
    /// so without this the id it was given resolves to nothing and the dialog
    /// can never be answered.
    pub fn elicitation_key(&self, request_id: &Uuid) -> Option<ElicitationKey> {
        self.elicitations
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(request_id)
            .cloned()
    }

    // ---- host-announced deltas ------------------------------------------
    //
    // Four deltas have no thread event behind them; see the crate docs.

    /// The turn failed. The error text lives with whoever awaited `prompt`.
    pub fn note_turn_failed(
        &self,
        session_id: &acp::SessionId,
        error: impl Into<String>,
        error_kind: Option<String>,
    ) {
        let error = error.into();
        self.emit_for(session_id, |projection| {
            vec![SessionDelta::TurnFailed {
                error,
                turn_seq: projection.turn_seq,
                error_kind,
            }]
        });
    }

    pub fn note_model_changed(&self, session_id: &acp::SessionId, model_id: impl Into<String>) {
        let model_id = model_id.into();
        self.with_session(session_id, |projection| {
            projection.model = Some(model_id.clone())
        });
        self.emit_for(session_id, |_| {
            vec![SessionDelta::ModelChanged { model_id }]
        });
    }

    pub fn note_compression_saved(&self, session_id: &acp::SessionId, saved_tokens: u64) {
        self.emit_for(session_id, |_| {
            vec![SessionDelta::CompressionSaved { saved_tokens }]
        });
    }

    pub fn note_agent_disconnected(&self, session_id: &acp::SessionId, reason: impl Into<String>) {
        let reason = reason.into();
        self.emit_for(session_id, |_| {
            vec![SessionDelta::AgentDisconnected { reason }]
        });
    }

    // ---- the projection --------------------------------------------------

    /// Apply one thread event, emitting whatever it changed.
    pub fn apply(&self, session_id: &acp::SessionId, event: AcpThreadEvent) {
        let Some(projection) = self.session(session_id) else {
            return;
        };
        let (envelopes, permissions, elicitations) = {
            let mut projection = projection.lock().unwrap_or_else(|p| p.into_inner());
            let deltas = projection.apply(event);
            let envelopes = projection.wrap(deltas);
            (
                envelopes,
                std::mem::take(&mut projection.new_permissions),
                std::mem::take(&mut projection.new_elicitations),
            )
        };
        if !permissions.is_empty() {
            let mut table = self.permissions.lock().unwrap_or_else(|p| p.into_inner());
            for (request_id, key) in permissions {
                table.insert(request_id, key);
            }
        }
        if !elicitations.is_empty() {
            let mut table = self.elicitations.lock().unwrap_or_else(|p| p.into_inner());
            for (request_id, key) in elicitations {
                table.insert(request_id, key);
            }
        }
        for envelope in envelopes {
            self.emitter.emit(envelope);
        }
    }

    fn session(&self, session_id: &acp::SessionId) -> Option<Arc<Mutex<SessionProjection>>> {
        self.sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(session_id)
            .cloned()
    }

    fn with_session<R>(
        &self,
        session_id: &acp::SessionId,
        f: impl FnOnce(&mut SessionProjection) -> R,
    ) -> Option<R> {
        let projection = self.session(session_id)?;
        let mut projection = projection.lock().unwrap_or_else(|p| p.into_inner());
        Some(f(&mut projection))
    }

    fn emit_for(
        &self,
        session_id: &acp::SessionId,
        f: impl FnOnce(&SessionProjection) -> Vec<SessionDelta>,
    ) {
        let Some(projection) = self.session(session_id) else {
            return;
        };
        let envelopes = {
            let projection = projection.lock().unwrap_or_else(|p| p.into_inner());
            projection.wrap(f(&projection))
        };
        for envelope in envelopes {
            self.emitter.emit(envelope);
        }
    }
}

/// What one entry of the thread has already been emitted as.
#[derive(Debug)]
enum Projected {
    /// A user message. Mirrored so indices line up, and never emitted — the
    /// prompt reaches capture through the send path, not the delta stream.
    User,
    Assistant { runs: Vec<ProjectedRun> },
    /// Boxed because a tool-call snapshot is by far the largest thing an entry
    /// can be, and most entries are not tool calls.
    ToolCall {
        message_id: String,
        snapshot: Box<ToolCall>,
    },
    /// Plans, compactions and elicitations: emitted, but nothing about them is
    /// diffed against a previous value.
    Other,
}

#[derive(Debug)]
struct ProjectedRun {
    message_id: String,
    is_thought: bool,
    text: String,
}

struct SessionProjection {
    agent_id: AgentId,
    session_id: acp::SessionId,
    thread: AcpThreadHandle,
    turn_seq: u64,
    model: Option<String>,
    entries: Vec<Projected>,
    status: Option<SessionStatus>,
    /// The plan as last announced, so an unchanged one is not re-sent.
    plan: Option<serde_json::Value>,
    /// Permission prompts announced on the wire, so an answer can be routed
    /// back and a resolution can name the same request.
    open_permissions: HashMap<acp::ToolCallId, Uuid>,
    new_permissions: Vec<(Uuid, PermissionKey)>,
    announced_elicitations: Vec<ElicitationEntryId>,
    new_elicitations: Vec<(Uuid, ElicitationKey)>,
}

impl SessionProjection {
    fn new(agent_id: AgentId, session_id: acp::SessionId, thread: AcpThreadHandle) -> Self {
        Self {
            agent_id,
            session_id,
            thread,
            turn_seq: 0,
            model: None,
            entries: Vec::new(),
            status: None,
            plan: None,
            open_permissions: HashMap::new(),
            new_permissions: Vec::new(),
            announced_elicitations: Vec::new(),
            new_elicitations: Vec::new(),
        }
    }

    fn wrap(&self, deltas: Vec<SessionDelta>) -> Vec<SessionDeltaEnvelope> {
        deltas
            .into_iter()
            .map(|delta| SessionDeltaEnvelope {
                agent_id: self.agent_id,
                session_id: self.session_id.to_string(),
                delta,
            })
            .collect()
    }

    fn apply(&mut self, event: AcpThreadEvent) -> Vec<SessionDelta> {
        match event {
            // New entries can also appear without an event of their own when a
            // later event refers to one, so both paths go through `sync`.
            AcpThreadEvent::NewEntry => self.sync_entries(),
            AcpThreadEvent::EntryUpdated(ix) => {
                let mut deltas = self.sync_entries();
                deltas.extend(self.update_entry(ix));
                deltas
            }
            AcpThreadEvent::EntriesRemoved(range) => {
                // No wire kind removes anything; the mirror is trimmed so later
                // indices still line up.
                let start = range.start.min(self.entries.len());
                let end = range.end.min(self.entries.len());
                self.entries.drain(start..end);
                Vec::new()
            }
            AcpThreadEvent::StatusChanged => self.status_deltas(),
            AcpThreadEvent::Stopped(stop_reason) => {
                let mut deltas = vec![SessionDelta::TurnFinished {
                    stop_reason: project::stop_reason_token(stop_reason),
                    turn_seq: self.turn_seq,
                }];
                deltas.extend(self.status_deltas());
                deltas
            }
            // Carries no message: the failure text lives with whoever awaited
            // `prompt`, and reaches the wire through `note_turn_failed`.
            // Emitting a placeholder here would put a second, emptier
            // `turn_failed` on the record for the same failure.
            AcpThreadEvent::Error => self.status_deltas(),
            AcpThreadEvent::LoadError(error) => {
                vec![SessionDelta::AgentDisconnected {
                    reason: load_error_reason(&error),
                }]
            }
            AcpThreadEvent::TitleUpdated => {
                let title = lock_thread(&self.thread)
                    .title()
                    .map(|title| title.to_string());
                title
                    .map(|title| vec![SessionDelta::TitleUpdated { title }])
                    .unwrap_or_default()
            }
            AcpThreadEvent::TokenUsageUpdated => self.usage_deltas(),
            AcpThreadEvent::Retry(status) => vec![SessionDelta::RetryStatus {
                attempt: status.attempt as u32,
                max_attempts: status.max_attempts as u32,
                delay_ms: status.duration.as_millis() as u64,
                last_error: status.last_error.to_string(),
            }],
            AcpThreadEvent::AvailableCommandsUpdated(commands) => {
                vec![SessionDelta::AvailableCommands {
                    commands: commands
                        .iter()
                        .map(|command| {
                            serde_json::to_value(command).unwrap_or(serde_json::Value::Null)
                        })
                        .collect(),
                }]
            }
            AcpThreadEvent::ModeUpdated(mode) => vec![SessionDelta::ModeChanged {
                mode_id: mode.to_string(),
            }],
            AcpThreadEvent::ConfigOptionsUpdated(options) => {
                vec![SessionDelta::ConfigOptionsUpdated {
                    config_options: options
                        .iter()
                        .map(|option| {
                            serde_json::to_value(option).unwrap_or(serde_json::Value::Null)
                        })
                        .collect(),
                }]
            }
            AcpThreadEvent::ToolAuthorizationRequested(tool_call_id) => {
                self.permission_requested(tool_call_id)
            }
            AcpThreadEvent::ToolAuthorizationReceived(tool_call_id) => {
                let mut deltas = match self.open_permissions.remove(&tool_call_id) {
                    Some(request_id) => vec![SessionDelta::PermissionResolved { request_id }],
                    None => Vec::new(),
                };
                deltas.extend(self.status_deltas());
                deltas
            }
            AcpThreadEvent::ElicitationRequested(id) => self.elicitation_requested(id),
            // No wire kind: the frontend closes an elicitation when it answers
            // it, and capture does not record them at all.
            AcpThreadEvent::ElicitationResponded(_) => Vec::new(),
            // The thread's plan is not an entry — it is replaced wholesale and
            // announced as a prompt update, which is the only thing that event
            // means today.
            AcpThreadEvent::PromptUpdated => self.plan_deltas(),
            // Nothing on the wire corresponds to these.
            AcpThreadEvent::PromptCapabilitiesUpdated
            | AcpThreadEvent::WorkingDirectoriesUpdated
            | AcpThreadEvent::Refusal => Vec::new(),
        }
    }

    /// Emit whatever entries the thread has that the mirror does not.
    fn sync_entries(&mut self) -> Vec<SessionDelta> {
        let mut deltas = Vec::new();
        loop {
            let ix = self.entries.len();
            let thread = lock_thread(&self.thread);
            if ix >= thread.entries().len() {
                break;
            }
            let (projected, mut new) = self.project_new(&thread, ix);
            drop(thread);
            self.entries.push(projected);
            deltas.append(&mut new);
        }
        deltas
    }

    fn project_new(&self, thread: &AcpThread, ix: usize) -> (Projected, Vec<SessionDelta>) {
        match &thread.entries()[ix] {
            AgentThreadEntry::UserMessage(_) => (Projected::User, Vec::new()),
            AgentThreadEntry::AssistantMessage(message) => {
                let mut runs = Vec::new();
                let mut deltas = Vec::new();
                for run in project::runs(&message.chunks) {
                    let message_id = new_message_id();
                    deltas.push(SessionDelta::MessageAppended {
                        message: project::run_message(
                            message_id.clone(),
                            &run,
                            self.model.clone(),
                        ),
                    });
                    runs.push(ProjectedRun {
                        message_id,
                        is_thought: run.is_thought,
                        text: run.text,
                    });
                }
                (Projected::Assistant { runs }, deltas)
            }
            AgentThreadEntry::ToolCall(call) => {
                let message_id = new_message_id();
                let snapshot = project::tool_call(call);
                let delta = SessionDelta::ToolCallUpserted {
                    message_id: message_id.clone(),
                    tool_call: snapshot.clone(),
                };
                (
                    Projected::ToolCall {
                        message_id,
                        snapshot: Box::new(snapshot),
                    },
                    vec![delta],
                )
            }
            AgentThreadEntry::CompletedPlan(entries) => (
                Projected::Other,
                vec![SessionDelta::PlanUpdated {
                    plan: project::plan_entries(entries),
                }],
            ),
            AgentThreadEntry::ContextCompaction(compaction) => (
                Projected::Other,
                vec![SessionDelta::Compaction {
                    active: matches!(
                        compaction.status,
                        atlas_acp_thread::ContextCompactionStatus::InProgress
                    ),
                }],
            ),
            // Announced through `ElicitationRequested`, which carries the
            // payload; the entry is only its position in the timeline.
            AgentThreadEntry::Elicitation(_) => (Projected::Other, Vec::new()),
        }
    }

    fn update_entry(&mut self, ix: usize) -> Vec<SessionDelta> {
        let Some(projected) = self.entries.get_mut(ix) else {
            return Vec::new();
        };
        let thread = lock_thread(&self.thread);
        let Some(entry) = thread.entries().get(ix) else {
            return Vec::new();
        };

        match (projected, entry) {
            (Projected::Assistant { runs }, AgentThreadEntry::AssistantMessage(message)) => {
                let current = project::runs(&message.chunks);
                let mut deltas = Vec::new();
                for (run_ix, run) in current.iter().enumerate() {
                    match runs.get_mut(run_ix) {
                        Some(projected) if projected.is_thought == run.is_thought => {
                            // Text only ever grows; a rewrite would mean the
                            // agent replaced what it already said, which the
                            // wire has no way to express.
                            let Some(suffix) = run.text.strip_prefix(projected.text.as_str())
                            else {
                                continue;
                            };
                            if suffix.is_empty() {
                                continue;
                            }
                            let delta = suffix.to_string();
                            let message_id = projected.message_id.clone();
                            projected.text = run.text.clone();
                            deltas.push(if run.is_thought {
                                SessionDelta::ThinkingChunk { message_id, delta }
                            } else {
                                SessionDelta::TextChunk { message_id, delta }
                            });
                        }
                        _ => {
                            let message_id = new_message_id();
                            deltas.push(SessionDelta::MessageAppended {
                                message: project::run_message(
                                    message_id.clone(),
                                    run,
                                    self.model.clone(),
                                ),
                            });
                            let projected_run = ProjectedRun {
                                message_id,
                                is_thought: run.is_thought,
                                text: run.text.clone(),
                            };
                            match runs.get_mut(run_ix) {
                                Some(slot) => *slot = projected_run,
                                None => runs.push(projected_run),
                            }
                        }
                    }
                }
                deltas
            }
            (
                Projected::ToolCall {
                    message_id,
                    snapshot,
                },
                AgentThreadEntry::ToolCall(call),
            ) => {
                let current = project::tool_call(call);
                let delta = tool_call_delta(message_id, snapshot, &current);
                **snapshot = current;
                delta.into_iter().collect()
            }
            (_, AgentThreadEntry::ContextCompaction(compaction)) => {
                vec![SessionDelta::Compaction {
                    active: matches!(
                        compaction.status,
                        atlas_acp_thread::ContextCompactionStatus::InProgress
                    ),
                }]
            }
            (_, AgentThreadEntry::CompletedPlan(entries)) => vec![SessionDelta::PlanUpdated {
                plan: project::plan_entries(entries),
            }],
            _ => Vec::new(),
        }
    }

    fn permission_requested(&mut self, tool_call_id: acp::ToolCallId) -> Vec<SessionDelta> {
        let thread = lock_thread(&self.thread);
        let Some((_, call)) = thread.tool_call(&tool_call_id) else {
            return Vec::new();
        };
        let ThreadToolCallStatus::WaitingForConfirmation { options, .. } = &call.status else {
            return Vec::new();
        };
        let request_id = Uuid::new_v4();
        let delta = SessionDelta::PermissionRequest {
            request_id,
            tool_call: project::permission_tool_call(call),
            options: project::permission_options(options),
        };
        drop(thread);

        self.open_permissions
            .insert(tool_call_id.clone(), request_id);
        self.new_permissions.push((
            request_id,
            PermissionKey {
                session_id: self.session_id.clone(),
                tool_call_id,
            },
        ));

        let mut deltas = vec![delta];
        deltas.extend(self.status_deltas());
        deltas
    }

    fn elicitation_requested(&mut self, id: ElicitationEntryId) -> Vec<SessionDelta> {
        if self.announced_elicitations.contains(&id) {
            return Vec::new();
        }
        let thread = lock_thread(&self.thread);
        let Some((_, elicitation)) = thread.elicitations().elicitation(&id) else {
            return Vec::new();
        };
        // Read as JSON, not by field: the request type is `#[non_exhaustive]`
        // and unstable-gated, and the frontend renders a form generated from
        // the schema rather than matching variants. Same reason the old stack
        // carried it raw.
        let request = serde_json::to_value(&elicitation.request).unwrap_or(serde_json::Value::Null);
        drop(thread);

        let url = request
            .get("url")
            .and_then(|url| url.as_str())
            .map(str::to_owned);
        let requested_schema = request.get("requestedSchema").cloned();
        let message = request
            .get("message")
            .and_then(|message| message.as_str())
            .unwrap_or_default()
            .to_string();
        let mode = if url.is_some() { "url" } else { "form" };

        let request_id = Uuid::new_v4();
        self.new_elicitations.push((
            request_id,
            ElicitationKey {
                session_id: self.session_id.clone(),
                entry_id: id.clone(),
            },
        ));
        self.announced_elicitations.push(id);
        vec![SessionDelta::ElicitationRequested {
            request_id,
            mode: mode.to_string(),
            message,
            requested_schema,
            url,
        }]
    }

    /// The plan, when it has actually changed.
    ///
    /// `PromptUpdated` fires for more than the plan, and a `plan_updated`
    /// carrying the same entries again would make the UI redraw a card that did
    /// not move.
    fn plan_deltas(&mut self) -> Vec<SessionDelta> {
        let plan = project::plan_entries(&lock_thread(&self.thread).plan().entries);
        let fingerprint = serde_json::to_value(&plan).unwrap_or(serde_json::Value::Null);
        if plan.is_empty() || self.plan == Some(fingerprint.clone()) {
            return Vec::new();
        }
        self.plan = Some(fingerprint);
        vec![SessionDelta::PlanUpdated { plan }]
    }

    fn usage_deltas(&self) -> Vec<SessionDelta> {
        let thread = lock_thread(&self.thread);
        let usage = thread.token_usage().cloned();
        let cost = thread.cost().map(|cost| cost.amount).unwrap_or(0.0);
        drop(thread);

        let Some(usage) = usage else {
            return Vec::new();
        };
        let mut deltas = Vec::new();
        // The per-turn input/output split — only an agent that reports one has
        // non-zero values here, which is the distinction the Timeline draws
        // between a real token split and a context gauge.
        if usage.input_tokens > 0 || usage.output_tokens > 0 {
            deltas.push(SessionDelta::UsageUpdated {
                usage: Usage {
                    input_tokens: usage.input_tokens,
                    output_tokens: usage.output_tokens,
                    cache_creation_tokens: 0,
                    cache_read_tokens: 0,
                    cost,
                },
            });
        }
        // The context gauge, from an agent that reports a window size.
        if usage.max_tokens > 0 {
            deltas.push(SessionDelta::ContextUsage {
                used: usage.used_tokens,
                size: usage.max_tokens,
                cost,
            });
        }
        deltas
    }

    /// A status flip, if the session is in a different state than last said.
    ///
    /// Deduplicated because a repeated identical status carries no information,
    /// and every entry update flips the thread's status event.
    fn status_deltas(&mut self) -> Vec<SessionDelta> {
        let status = self.current_status();
        if self.status == Some(status) {
            return Vec::new();
        }
        self.status = Some(status);
        vec![SessionDelta::Status {
            status,
            turn_seq: self.turn_seq,
        }]
    }

    fn current_status(&self) -> SessionStatus {
        let thread = lock_thread(&self.thread);
        let waiting = thread.entries().iter().any(|entry| {
            matches!(
                entry,
                AgentThreadEntry::ToolCall(call)
                    if matches!(call.status, ThreadToolCallStatus::WaitingForConfirmation { .. })
            )
        });
        if waiting {
            SessionStatus::Waiting
        } else if thread.is_generating() {
            SessionStatus::Running
        } else if thread.had_error() {
            SessionStatus::Error
        } else {
            SessionStatus::Idle
        }
    }
}

/// A tool call changed: a full snapshot, or just the output that grew.
///
/// Live command output arrives as a stream of updates, and re-shipping the
/// whole accumulated result on each one makes a chatty command's IPC cost
/// quadratic in its output. When nothing but the result's tail changed, the
/// tail alone goes on the wire; everything else is a full snapshot, because the
/// UI never merges fields.
fn tool_call_delta(
    message_id: &str,
    previous: &ToolCall,
    current: &ToolCall,
) -> Option<SessionDelta> {
    let same_except_result = previous.status == current.status
        && previous.title == current.title
        && previous.kind == current.kind
        && previous.tool_name == current.tool_name
        && previous.arguments == current.arguments
        && previous.locations == current.locations
        && previous.raw_output == current.raw_output
        && previous.content_blocks == current.content_blocks;

    if same_except_result {
        let previous_result = previous.result.as_deref().unwrap_or_default();
        let current_result = current.result.as_deref().unwrap_or_default();
        if previous_result == current_result {
            return None;
        }
        // A first result is a full snapshot, as it was before this existed:
        // consumers that ignore chunks (capture appends them, the record does
        // not depend on them) must still see the tool call's own content
        // announced at least once. Only growth after that streams.
        if let Some(suffix) = current_result
            .strip_prefix(previous_result)
            .filter(|_| !previous_result.is_empty())
        {
            if !suffix.is_empty() {
                return Some(SessionDelta::ToolCallOutputChunk {
                    message_id: message_id.to_string(),
                    tool_call_id: current.id.clone(),
                    delta: suffix.to_string(),
                });
            }
        }
    }

    Some(SessionDelta::ToolCallUpserted {
        message_id: message_id.to_string(),
        tool_call: current.clone(),
    })
}

/// `LoadError`'s own `Display` is the reason text, so the wire carries exactly
/// what the rest of the app would show.
fn load_error_reason(error: &LoadError) -> String {
    error.to_string()
}

fn new_message_id() -> String {
    format!("msg-{}", Uuid::new_v4().simple())
}

fn lock_thread(thread: &AcpThreadHandle) -> std::sync::MutexGuard<'_, AcpThread> {
    thread.lock().unwrap_or_else(|p| p.into_inner())
}

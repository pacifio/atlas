//! The stateful half: what changed, and therefore which delta to send.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{
    AcpThread, AcpThreadEvent, AcpThreadHandle, AgentThreadEntry, ElicitationEntryId, EventStream,
    LoadError, TerminalAppend, ToolCallStatus as ThreadToolCallStatus,
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

/// One elicitation, in the four fields the frontend's dialog renders from.
#[derive(Debug, Clone)]
pub struct ElicitationWire {
    /// `"url"` or `"form"`.
    pub mode: String,
    pub message: String,
    pub requested_schema: Option<serde_json::Value>,
    pub url: Option<String>,
}

/// Flatten an elicitation for the wire.
///
/// Read as JSON, not by field: the request type is `#[non_exhaustive]` and
/// unstable-gated, and the frontend renders a form generated from the schema
/// rather than matching variants. Same reason the old stack carried it raw.
///
/// Shared by the two places elicitations come from — a session's thread and a
/// connection's request-scoped store — so the sign-in dialog and the chat
/// dialog cannot disagree about how the same payload reads.
pub fn elicitation_wire(elicitation: &atlas_acp_thread::Elicitation) -> ElicitationWire {
    let request = serde_json::to_value(&elicitation.request).unwrap_or(serde_json::Value::Null);
    let url = request
        .get("url")
        .and_then(|url| url.as_str())
        .map(str::to_owned);
    ElicitationWire {
        mode: if url.is_some() { "url" } else { "form" }.to_string(),
        message: request
            .get("message")
            .and_then(|message| message.as_str())
            .unwrap_or_default()
            .to_string(),
        requested_schema: request.get("requestedSchema").cloned(),
        url,
    }
}

/// Projects every attached thread's events onto the frozen wire.
///
/// One projector serves every session: it hands out the per-session event sink
/// that `ConnectOptions` wants, and each attached thread gets a task that
/// applies its events in order.
/// Something that wants to see thread events besides the wire projection.
///
/// One observer, set once at startup: Atlas's history store, which keeps a
/// metadata row per conversation current from the same events (Zed's
/// `ThreadMetadataStore` subscribes to its `ConversationView`s the same way,
/// `thread_metadata_store.rs:1188-1212`).
///
/// It is handed the thread as well as the event because the row records what
/// the thread *is* — its title, its working directories, whether anything has
/// been sent — not what the event said.
pub trait ThreadObserver: Send + Sync {
    fn on_thread_event(
        &self,
        agent_id: AgentId,
        session_id: &acp::SessionId,
        event: &AcpThreadEvent,
        thread: &AcpThreadHandle,
    );
}

pub struct DeltaProjector {
    emitter: Emitter,
    /// Set once, before any session exists. Not a list: there is one history
    /// store, and a second observer would be a second thing to keep correct.
    observer: Mutex<Option<Arc<dyn ThreadObserver>>>,
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
            observer: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            permissions: Mutex::new(HashMap::new()),
            elicitations: Mutex::new(HashMap::new()),
        })
    }

    /// Install the thread observer. Call before any session is created;
    /// events emitted before this are not replayed to it.
    pub fn observe_threads(&self, observer: Arc<dyn ThreadObserver>) {
        *self.observer.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(observer);
    }

    /// The sink factory to hand to `ConnectOptions`.
    pub fn thread_events(self: &Arc<Self>) -> ThreadEventSink {
        let this = self.clone();
        Arc::new(move |session_id: &acp::SessionId| {
            let (tx, rx) = atlas_acp_thread::event_channel();
            let mut pending = this
                .pending
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            // A session whose `session/load` or `session/resume` RPC failed
            // never reaches `register`, so nothing takes its pre-registered
            // stream back out and the key stays here for the life of the
            // process (ATL-225). The thread that held the only sender was
            // dropped along with the failure, so a stream with no senders left
            // can never carry another event and is safe to forget. Swept here
            // rather than on a timer because this is the one place that learns
            // a new session is being opened.
            pending.retain(|_, stream| stream.sender_strong_count() > 0);
            pending.insert(session_id.clone(), rx);
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
    ///
    /// The cleanup when the stream ends is a backstop, not the primary path:
    /// the projection owns the thread that owns the sender, so in Atlas the
    /// stream only ends after [`Self::close_session`] has already dropped the
    /// projection. It stays for a host that owns its threads the other way
    /// round, and because ending a task on a dead channel is right regardless.
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
            this.forget_session(&session_id);
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
            .unwrap_or_else(std::sync::PoisonError::into_inner)
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
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(session_id, projection);

        Some(events)
    }

    /// Forget a session the host has closed.
    ///
    /// The projector is a session's OWNER, not just an observer: after `bind`
    /// the projection holds the only strong handle on the thread — the
    /// connection's session table keeps a `Weak`, and the host drops its clone.
    /// Which means the cleanup at the end of [`Self::attach`]'s task cannot run
    /// on its own: the thread it is waiting on holds the sender that would end
    /// the stream, so the stream never ends. Closing has to be told, not
    /// noticed.
    ///
    /// Dropping the projection is what releases the thread, and with it the
    /// thread's terminals — whose `Drop` kills any PTY still running.
    pub fn close_session(&self, session_id: &acp::SessionId) {
        self.forget_session(session_id);
    }

    /// Drop everything keyed to a session whose event stream has ended.
    ///
    /// `sessions` used to be the only table cleaned up here. The permission and
    /// elicitation tables are keyed by wire request id and had no removal at
    /// all, so on a process-lifetime singleton they retained one entry per
    /// prompt the app had ever shown, for as long as the app ran (ATL-225).
    fn forget_session(&self, session_id: &acp::SessionId) {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(session_id);
        self.permissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|_, key| &key.session_id != session_id);
        self.elicitations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|_, key| &key.session_id != session_id);
    }

    /// How many permission and elicitation routes are retained. Test-facing:
    /// the leak these count was invisible from the outside.
    pub fn routing_table_sizes(&self) -> (usize, usize) {
        (
            self.permissions.lock().unwrap_or_else(std::sync::PoisonError::into_inner).len(),
            self.elicitations.lock().unwrap_or_else(std::sync::PoisonError::into_inner).len(),
        )
    }

    /// How many event streams are pre-registered for sessions that do not exist
    /// yet. Test-facing, for the same reason.
    pub fn pending_len(&self) -> usize {
        self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner).len()
    }

    /// Subscribe to every delta in-process, without going through the host sink.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<SessionDeltaEnvelope> {
        self.emitter.subscribe()
    }

    fn notify_observer(
        &self,
        session_id: &acp::SessionId,
        event: &AcpThreadEvent,
        projection: &Arc<Mutex<SessionProjection>>,
    ) {
        let observer = self
            .observer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let Some(observer) = observer else {
            return;
        };
        // Read the identity and the handle out first: the observer reads the
        // thread itself, and holding the projection's lock across that call
        // would put the history store behind the wire projection's lock.
        let (agent_id, thread) = {
            let projection = projection.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            (projection.agent_id, projection.thread.clone())
        };
        observer.on_thread_event(agent_id, session_id, event, &thread);
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
            .unwrap_or_else(std::sync::PoisonError::into_inner)
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
            .unwrap_or_else(std::sync::PoisonError::into_inner)
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

    /// The confirmed config options a `session/set_config_option` RESPONSE
    /// carried. The response is the protocol's authoritative echo — a
    /// follow-up `config_option_update` notification is optional — so the host
    /// announces it the way it announces a model change: the thread has no
    /// event for something the thread never saw (#32).
    pub fn note_config_options(
        &self,
        session_id: &acp::SessionId,
        options: &[acp::SessionConfigOption],
    ) {
        let config_options: Vec<serde_json::Value> = options
            .iter()
            .map(|option| serde_json::to_value(option).unwrap_or(serde_json::Value::Null))
            .collect();
        self.emit_for(session_id, |_| {
            vec![SessionDelta::ConfigOptionsUpdated { config_options }]
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
        self.notify_observer(session_id, &event, &projection);
        let (envelopes, permissions, elicitations) = {
            let mut projection = projection.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let deltas = projection.apply(event);
            let envelopes = projection.wrap(deltas);
            (
                envelopes,
                std::mem::take(&mut projection.new_permissions),
                std::mem::take(&mut projection.new_elicitations),
            )
        };
        if !permissions.is_empty() {
            let mut table = self.permissions.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            for (request_id, key) in permissions {
                table.insert(request_id, key);
            }
        }
        if !elicitations.is_empty() {
            let mut table = self.elicitations.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
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
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(session_id)
            .cloned()
    }

    fn with_session<R>(
        &self,
        session_id: &acp::SessionId,
        f: impl FnOnce(&mut SessionProjection) -> R,
    ) -> Option<R> {
        let projection = self.session(session_id)?;
        let mut projection = projection.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
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
            let projection = projection.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
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
    /// `None` for a run that has nothing to render yet — an image- or
    /// audio-only chunk flattens to the empty string, and announcing it put a
    /// blank bubble on screen that the snapshot then omitted on reload
    /// (ATL-224). The slot is still mirrored so run indices stay aligned with
    /// the thread's, and the id is minted the moment the run has text.
    message_id: Option<String>,
    is_thought: bool,
    /// How much of the run has been emitted, in bytes — not the text itself.
    /// Keeping the text meant rebuilding and re-comparing the whole message on
    /// every token of it (ATL-223); a run only ever grows at its end, so a
    /// length is all that is needed to find what is new.
    text_len: usize,
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
                let start = range.start.min(self.entries.len());
                let end = range.end.min(self.entries.len());
                // Count whole exchanges by their user messages: that is the
                // unit the frontend can identify in its own mirror (its user
                // rows are optimistic and carry no wire ids to address). A
                // removal that clips none (an assistant-only trim) leaves it
                // nothing to drop, which is why this can be zero.
                let turns = self.entries[start..end]
                    .iter()
                    .filter(|projected| matches!(projected, Projected::User))
                    .count() as u32;
                let removed: Vec<String> = self.entries[start..end]
                    .iter()
                    .filter_map(|projected| match projected {
                        Projected::ToolCall { snapshot, .. } => Some(snapshot.id.clone()),
                        _ => None,
                    })
                    .collect();
                self.entries.drain(start..end);

                // A tool call that goes away takes its permission prompt with
                // it. Left in `open_permissions` the route outlives the call,
                // and the frontend keeps a modal open on a tool call that no
                // longer exists, answerable by nobody — the stranding shape of
                // ATL-213, one layer up.
                let mut deltas = Vec::new();
                self.open_permissions.retain(|tool_call_id, request_id| {
                    if removed.iter().any(|id| id == &tool_call_id.to_string()) {
                        deltas.push(SessionDelta::PermissionResolved {
                            request_id: *request_id,
                        });
                        return false;
                    }
                    true
                });
                if turns > 0 {
                    deltas.push(SessionDelta::HistoryRewound { turns });
                }
                deltas
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
                    .map(std::string::ToString::to_string);
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
            AcpThreadEvent::ToolAuthorizationRequested { id, options } => {
                self.permission_requested(id, options)
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
            // Nothing on the wire corresponds to these. `Refusal` has no
            // emitter anywhere in `atlas-acp-thread` today, so its arm is
            // unreachable rather than merely silent; it stays because the match
            // must be exhaustive, and because a refusal is a thing the wire
            // would eventually want to say.
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
                let at = chrono::Utc::now();
                for run in project::runs(&message.chunks) {
                    let text_len = run.text.len();
                    // An image- or audio-only chunk flattens to nothing. The
                    // snapshot skips such a run; announcing it here put a blank
                    // bubble in the live view that vanished on reload
                    // (ATL-224). Mirrored anyway so the run indices keep
                    // matching the thread's.
                    if run.text.is_empty() {
                        runs.push(ProjectedRun {
                            message_id: None,
                            is_thought: run.is_thought,
                            text_len,
                        });
                        continue;
                    }
                    let message_id = new_message_id();
                    deltas.push(SessionDelta::MessageAppended {
                        message: project::run_message(
                            message_id.clone(),
                            &run,
                            self.model.clone(),
                            at,
                        ),
                    });
                    runs.push(ProjectedRun {
                        message_id: Some(message_id),
                        is_thought: run.is_thought,
                        text_len,
                    });
                }
                (Projected::Assistant { runs }, deltas)
            }
            AgentThreadEntry::ToolCall(call) => {
                let message_id = new_message_id();
                let snapshot = project::tool_call(call, thread);
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
            // Nothing in the ported stack constructs `CompletedPlan`, so this
            // arm and its counterpart in `update_entry` are unreachable rather
            // than merely rare. Kept for exhaustiveness, and because the
            // variant is the shape a finished plan would arrive in.
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
                // Spans, not text: one `EntryUpdated` arrives per streamed
                // chunk, and rebuilding the message's whole text to find out
                // what is new costs the entire message on every token of it
                // (ATL-223). A run only grows at its end, so a byte length is
                // enough to locate the new part.
                let spans = project::run_spans(&message.chunks);
                let mut deltas = Vec::new();
                for (run_ix, span) in spans.iter().enumerate() {
                    let len = project::run_span_len(&message.chunks, span);
                    match runs.get_mut(run_ix) {
                        Some(projected) if projected.is_thought == span.is_thought => {
                            match projected.message_id.clone() {
                                Some(message_id) => {
                                    // A shrink would mean the agent replaced
                                    // what it already said, which the wire has
                                    // no way to express.
                                    if len <= projected.text_len {
                                        continue;
                                    }
                                    let Some(delta) = project::run_span_tail(
                                        &message.chunks,
                                        span,
                                        projected.text_len,
                                    ) else {
                                        continue;
                                    };
                                    if delta.is_empty() {
                                        continue;
                                    }
                                    projected.text_len = len;
                                    deltas.push(if span.is_thought {
                                        SessionDelta::ThinkingChunk { message_id, delta }
                                    } else {
                                        SessionDelta::TextChunk { message_id, delta }
                                    });
                                }
                                // Held back as empty (ATL-224), and now it has
                                // something to render. This is its first
                                // announcement, so it is a whole message rather
                                // than a chunk appended to one nobody has.
                                None => {
                                    if len == 0 {
                                        continue;
                                    }
                                    let Some(text) =
                                        project::run_span_tail(&message.chunks, span, 0)
                                    else {
                                        continue;
                                    };
                                    let message_id = new_message_id();
                                    deltas.push(SessionDelta::MessageAppended {
                                        message: project::run_message(
                                            message_id.clone(),
                                            &project::Run {
                                                is_thought: span.is_thought,
                                                text,
                                            },
                                            self.model.clone(),
                                            chrono::Utc::now(),
                                        ),
                                    });
                                    projected.message_id = Some(message_id);
                                    projected.text_len = len;
                                }
                            }
                        }
                        _ => {
                            let Some(text) = project::run_span_tail(&message.chunks, span, 0)
                            else {
                                continue;
                            };
                            let announced = if text.is_empty() {
                                None
                            } else {
                                let message_id = new_message_id();
                                deltas.push(SessionDelta::MessageAppended {
                                    message: project::run_message(
                                        message_id.clone(),
                                        &project::Run {
                                            is_thought: span.is_thought,
                                            text,
                                        },
                                        self.model.clone(),
                                        chrono::Utc::now(),
                                    ),
                                });
                                Some(message_id)
                            };
                            let projected_run = ProjectedRun {
                                message_id: announced,
                                is_thought: span.is_thought,
                                text_len: len,
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
                // Fast path: nothing but the result changed, and the result is
                // one terminal's output that only grew. Building `current` to
                // discover that costs a copy of everything the command has
                // printed so far — on every chunk it prints, with the session's
                // lock held — which is what let a chatty command stall the
                // whole session (ATL-219).
                let meta = project::tool_call_meta(call);
                if tool_call_meta_eq(snapshot, &meta) {
                    if let Some(terminal_id) = project::sole_terminal(&call.content) {
                        let emitted = snapshot.result.as_deref().unwrap_or_default().len();
                        match thread.terminal_output_appended(terminal_id, emitted) {
                            Some(TerminalAppend::Unchanged) => return Vec::new(),
                            // A first result stays a full snapshot, as on the
                            // slow path below: a consumer that ignores chunks
                            // must still see the tool call's content announced
                            // at least once.
                            Some(TerminalAppend::Grew(suffix)) if emitted > 0 => {
                                let delta = SessionDelta::ToolCallOutputChunk {
                                    message_id: message_id.clone(),
                                    tool_call_id: snapshot.id.clone(),
                                    delta: suffix.clone(),
                                };
                                snapshot
                                    .result
                                    .get_or_insert_with(String::new)
                                    .push_str(&suffix);
                                return vec![delta];
                            }
                            _ => {}
                        }
                    }
                }
                let mut current = meta;
                current.result = project::tool_result(&call.content, &thread);
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

    fn permission_requested(
        &mut self,
        tool_call_id: acp::ToolCallId,
        options: atlas_acp_thread::PermissionOptions,
    ) -> Vec<SessionDelta> {
        let thread = lock_thread(&self.thread);
        let Some((_, call)) = thread.tool_call(&tool_call_id) else {
            return Vec::new();
        };
        // The options come from the EVENT, not from re-reading the call's live
        // status: the drain lags the thread, and a call the agent finished in
        // the meantime is no longer `WaitingForConfirmation` — which used to
        // swallow the request entirely. Announcing from the event keeps the
        // wire's account true to what happened: the prompt existed, then the
        // `ToolAuthorizationReceived` that follows resolves it (#30).
        let request_id = Uuid::new_v4();
        let delta = SessionDelta::PermissionRequest {
            request_id,
            tool_call: project::permission_tool_call(call),
            options: project::permission_options(&options),
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
        let wire = elicitation_wire(elicitation);
        drop(thread);

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
            mode: wire.mode,
            message: wire.message,
            requested_schema: wire.requested_schema,
            url: wire.url,
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
        // An empty plan is only silence when nothing has been announced yet.
        // Skipping every empty plan meant an agent that CLEARED its plan never
        // said so, and the UI kept rendering a card full of steps the agent had
        // abandoned (ATL-222).
        if self.plan.is_none() && plan.is_empty() {
            return Vec::new();
        }
        if self.plan == Some(fingerprint.clone()) {
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
///
/// That is a claim about the WIRE only, and for a long time it was the whole
/// claim: reaching this function at all meant the caller had already rebuilt
/// the entire result and was about to compare it string-for-string, so the
/// projection stayed quadratic while the bytes on the wire did not (ATL-219).
/// The caller in `update_entry` now answers the common case — one terminal,
/// output that only grew — without building anything, and only falls through to
/// here when it cannot.
fn tool_call_delta(
    message_id: &str,
    previous: &ToolCall,
    current: &ToolCall,
) -> Option<SessionDelta> {
    if tool_call_meta_eq(previous, current) {
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

/// Whether two projections of a tool call agree on everything but the result.
///
/// The result is the only field whose size grows with what a command printed,
/// so it is the only one worth streaming — and the only one worth measuring
/// before deciding to. Shared with the incremental path in `update_entry`, so
/// the two cannot disagree about what "only the output changed" means.
fn tool_call_meta_eq(previous: &ToolCall, current: &ToolCall) -> bool {
    previous.status == current.status
        && previous.title == current.title
        && previous.kind == current.kind
        && previous.tool_name == current.tool_name
        && previous.arguments == current.arguments
        && previous.locations == current.locations
        && previous.raw_output == current.raw_output
        && previous.content_blocks == current.content_blocks
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
    thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

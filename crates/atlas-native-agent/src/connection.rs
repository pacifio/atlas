//! The native agent as an `AgentConnection`.
//!
//! Ported from Zed's `NativeAgentConnection`
//! (`zed-ref/crates/agent/src/native_agent_server.rs` and the connection it
//! wraps): the shared trait carries everything the UI does to any agent, and
//! the capabilities only this agent has hang off separate sub-traits.

use std::any::Any;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1 as acp;
use anyhow::{anyhow, Result};
use atlas_acp_thread::{
    AcpThread, AcpThreadHandle, AgentConnection, AgentId, AgentModelId, AgentModelInfo,
    AgentModelList, AgentModelSelector, AgentSessionInfo, AgentSessionList, AgentSessionListRequest,
    AgentSessionListResponse, AgentSessionModes, ToolCallStatus,
};
use atlas_agent_servers::ThreadEventSink;
use atlas_cersei::{AgentId as NativeAgentId, CerseiRuntime, ReplayItem};
use futures::future::BoxFuture;
use futures::FutureExt;

use crate::sink::{
    lock, to_acp_session_id, to_native_session_id, NativeSessionState, NativeSessions, ThreadSink,
};

pub use crate::sink::NativeSessionEvent;

/// How many native-only events are buffered for a slow subscriber before the
/// oldest are dropped. These are per-turn statistics, so a subscriber that fell
/// this far behind has already lost the context they belonged to.
const NATIVE_EVENT_BUFFER: usize = 64;

/// A live native agent.
///
/// One `CerseiConnection` owns one runtime agent handle and every thread opened
/// on it, exactly as `AcpConnection` owns one child process and its sessions.
pub struct CerseiConnection {
    id: AgentId,
    runtime: CerseiRuntime,
    agent_id: NativeAgentId,
    sessions: Arc<NativeSessions>,
    thread_events: ThreadEventSink,
    native_events: tokio::sync::broadcast::Sender<NativeSessionEvent>,
    default_mode: Option<acp::SessionModeId>,
    /// The working directory of the most recent session listing.
    ///
    /// The runtime stores sessions per project directory, so deleting one needs
    /// the directory it was listed from. The protocol's delete request carries
    /// only a session id, so the listing that produced it is what supplies the
    /// rest. A delete with no listing before it is refused rather than guessed.
    ///
    /// Shared with every session list this connection hands out, so a delete
    /// sees the directory the listing it came from was made against.
    last_listed_cwd: Arc<Mutex<Option<String>>>,
}

impl CerseiConnection {
    /// Registers a fresh agent on `runtime` and returns the connection to it.
    pub fn connect(
        id: AgentId,
        runtime: CerseiRuntime,
        thread_events: ThreadEventSink,
        default_mode: Option<acp::SessionModeId>,
    ) -> Arc<Self> {
        let sessions = Arc::new(NativeSessions::default());
        let (native_events, _) = tokio::sync::broadcast::channel(NATIVE_EVENT_BUFFER);

        // The sink has to exist before the agent does, because `spawn` is what
        // hands the runtime the sink it will emit through for the rest of its
        // life. It needs no agent id of its own: every event arrives stamped
        // with the id that produced it.
        let info = runtime.spawn(Arc::new(ThreadSink {
            sessions: sessions.clone(),
            runtime: runtime.clone(),
            native_events: native_events.clone(),
        }));

        Arc::new(Self {
            id,
            runtime,
            agent_id: info.agent_id,
            sessions,
            thread_events,
            native_events,
            default_mode,
            last_listed_cwd: Arc::new(Mutex::new(None)),
        })
    }

    /// Native-only events that have no place in the thread model.
    pub fn subscribe_native_events(
        &self,
    ) -> tokio::sync::broadcast::Receiver<NativeSessionEvent> {
        self.native_events.subscribe()
    }

    /// Reasoning effort for one session — native-only (§D12-5).
    pub fn session_effort(
        &self,
        session_id: &acp::SessionId,
    ) -> Option<Arc<dyn AgentSessionEffort>> {
        self.sessions.thread(session_id)?;
        Some(Arc::new(CerseiSessionControls {
            runtime: self.runtime.clone(),
            agent_id: self.agent_id,
            session_id: session_id.clone(),
        }))
    }

    /// Tool-output compression for one session — native-only (§D12-5).
    pub fn session_compression(
        &self,
        session_id: &acp::SessionId,
    ) -> Option<Arc<dyn AgentSessionCompression>> {
        self.sessions.thread(session_id)?;
        Some(Arc::new(CerseiSessionControls {
            runtime: self.runtime.clone(),
            agent_id: self.agent_id,
            session_id: session_id.clone(),
        }))
    }

    fn new_thread(
        self: &Arc<Self>,
        session_id: acp::SessionId,
        work_dirs: Vec<PathBuf>,
        title: Option<Arc<str>>,
    ) -> AcpThreadHandle {
        let events = (self.thread_events)(&session_id);
        let mut thread = AcpThread::new(
            session_id,
            self.clone() as Arc<dyn AgentConnection>,
            work_dirs,
            title,
            events,
        );
        // The native agent takes plain text: no embedded resources, no images,
        // no audio. Saying so is what makes the composer degrade an attachment
        // to a path mention instead of sending something that gets dropped.
        thread.set_prompt_capabilities(acp::PromptCapabilities::default());
        Arc::new(Mutex::new(thread))
    }

    fn register(
        &self,
        session_id: &acp::SessionId,
        thread: &AcpThreadHandle,
        cwd: String,
        modes: Option<serde_json::Value>,
    ) {
        self.sessions.insert(
            session_id.clone(),
            NativeSessionState {
                thread: Arc::downgrade(thread),
                cwd,
                modes: parse_modes(modes).map(|modes| Arc::new(Mutex::new(modes))),
                ref_count: 1,
            },
        );
        if let Some(mode) = self.default_mode.clone() {
            self.apply_mode(session_id, mode);
        }
    }

    /// Applies a mode locally and on the runtime, leaving the local view alone
    /// if the runtime does not know the session.
    fn apply_mode(&self, session_id: &acp::SessionId, mode: acp::SessionModeId) {
        let known = self
            .sessions
            .with_session(session_id, |state| {
                let Some(modes) = &state.modes else {
                    return false;
                };
                let mut modes = modes.lock().unwrap_or_else(|p| p.into_inner());
                if !modes.available_modes.iter().any(|m| m.id == mode) {
                    return false;
                }
                modes.current_mode_id = mode.clone();
                true
            })
            .unwrap_or(false);
        if !known {
            return;
        }
        let _ = self.runtime.set_session_mode(
            self.agent_id,
            &session_id.to_string(),
            mode.to_string(),
        );
    }

    fn cwd(&self, work_dirs: &[PathBuf]) -> Result<PathBuf> {
        work_dirs
            .first()
            .cloned()
            // The native agent has a single root by construction, so extra work
            // dirs are simply not passed on rather than being an error.
            .ok_or_else(|| anyhow!("a session needs at least one working directory"))
    }
}

impl AgentConnection for CerseiConnection {
    fn agent_id(&self) -> AgentId {
        self.id.clone()
    }

    fn telemetry_id(&self) -> Arc<str> {
        self.id.0.clone()
    }

    fn agent_version(&self) -> Option<Arc<str>> {
        Some(env!("CARGO_PKG_VERSION").into())
    }

    fn new_session(
        self: Arc<Self>,
        work_dirs: Vec<PathBuf>,
    ) -> BoxFuture<'static, Result<AcpThreadHandle>> {
        async move {
            let cwd = self.cwd(&work_dirs)?;
            let info = self.runtime.new_session(self.agent_id, cwd.clone())?;
            let session_id = to_acp_session_id(&info.session_id);
            let thread = self.new_thread(session_id.clone(), work_dirs, None);
            self.register(
                &session_id,
                &thread,
                cwd.to_string_lossy().into_owned(),
                info.modes,
            );
            Ok(thread)
        }
        .boxed()
    }

    fn supports_load_session(&self) -> bool {
        true
    }

    /// Reopen a stored session with its history.
    ///
    /// Two things happen, and both are needed: the runtime restores the
    /// conversation so the next turn continues it, and the transcript is
    /// replayed into the thread so the user sees what was said. Registering the
    /// session *before* the replay is the same ordering the external connection
    /// uses, for the same reason — anything the replay emits has to find a
    /// thread.
    fn load_session(
        self: Arc<Self>,
        session_id: acp::SessionId,
        work_dirs: Vec<PathBuf>,
        title: Option<Arc<str>>,
    ) -> BoxFuture<'static, Result<AcpThreadHandle>> {
        async move {
            if let Some(thread) = self.sessions.acquire(&session_id) {
                return Ok(thread);
            }

            let cwd = self.cwd(&work_dirs)?;
            let cwd_str = cwd.to_string_lossy().into_owned();
            let modes = self.runtime.load_session(
                self.agent_id,
                to_native_session_id(&session_id),
                cwd.clone(),
            )?;

            let thread = self.new_thread(session_id.clone(), work_dirs, title);
            self.register(&session_id, &thread, cwd_str.clone(), modes);

            let items = self
                .runtime
                .replay_session(&cwd_str, &session_id.to_string());
            replay_into(&thread, items);

            Ok(thread)
        }
        .boxed()
    }

    fn supports_close_session(&self) -> bool {
        true
    }

    fn close_session(self: Arc<Self>, session_id: acp::SessionId) -> BoxFuture<'static, Result<()>> {
        async move {
            // Ref-counted like the external connection: the last handle closing
            // is what drops the thread, and the runtime keeps the transcript on
            // disk either way.
            self.sessions.release(&session_id);
            Ok(())
        }
        .boxed()
    }

    fn supports_session_history(&self) -> bool {
        true
    }

    /// The native agent signs in with Atlas's own BYOK keys, so it advertises no
    /// ACP auth method — which is what keeps the sign-in flow from offering one.
    fn auth_methods(&self) -> &[acp::AuthMethod] {
        &[]
    }

    fn authenticate(&self, _method: acp::AuthMethodId) -> BoxFuture<'static, Result<()>> {
        async { Err(anyhow!("the native agent authenticates with API keys, not an auth method")) }
            .boxed()
    }

    fn prompt(&self, params: acp::PromptRequest) -> BoxFuture<'static, Result<acp::PromptResponse>> {
        let runtime = self.runtime.clone();
        let agent_id = self.agent_id;
        let session_id = params.session_id.clone();
        let text = flatten_text(&params.prompt);

        async move {
            // Stamps this turn's events, so a straggler from a cancelled turn is
            // identifiable downstream. The runtime refuses a second concurrent
            // turn on the same session, so a failure here is a real error.
            runtime.mark_turn_started(agent_id, &session_id.to_string())?;
            let stop = runtime
                .send_prompt(agent_id, to_native_session_id(&session_id), text)
                .await?;
            Ok(acp::PromptResponse::new(parse_stop_reason(&stop)))
        }
        .boxed()
    }

    fn cancel(&self, session_id: &acp::SessionId) {
        let _ = self
            .runtime
            .cancel_turn(self.agent_id, &session_id.to_string());
    }

    fn session_modes(&self, session_id: &acp::SessionId) -> Option<Arc<dyn AgentSessionModes>> {
        let modes = self
            .sessions
            .with_session(session_id, |state| state.modes.clone())??;
        Some(Arc::new(CerseiSessionModes {
            runtime: self.runtime.clone(),
            agent_id: self.agent_id,
            session_id: session_id.clone(),
            modes,
        }))
    }

    fn model_selector(&self, session_id: &acp::SessionId) -> Option<Arc<dyn AgentModelSelector>> {
        self.sessions.thread(session_id)?;
        Some(Arc::new(CerseiModelSelector {
            runtime: self.runtime.clone(),
            agent_id: self.agent_id,
            session_id: session_id.clone(),
        }))
    }

    fn session_list(&self) -> Option<Arc<dyn AgentSessionList>> {
        Some(Arc::new(CerseiSessionList {
            runtime: self.runtime.clone(),
            last_listed_cwd: self.last_listed_cwd.clone(),
        }))
    }

    fn into_any(self: Arc<Self>) -> Arc<dyn Any + Send + Sync> {
        self
    }
}

impl Drop for CerseiConnection {
    fn drop(&mut self) {
        // The runtime holds the agent's sessions and its event sink; dropping
        // the connection without this leaks both for the life of the process.
        let _ = self.runtime.kill(self.agent_id);
    }
}

// ---------------------------------------------------------------- sub-traits

/// Reasoning effort, native-only.
///
/// Zed's native agent gets extra capability traits the shared `AgentConnection`
/// does not carry; this is one of Atlas's (research §D12-5). It is a separate
/// trait rather than an inherent method so a host can hold it without holding
/// the concrete connection type.
pub trait AgentSessionEffort: Send + Sync {
    /// `None` clears the override and uses the model's own default.
    fn set_effort(&self, level: Option<String>) -> Result<()>;
}

/// Tool-output compression (RTK), native-only.
pub trait AgentSessionCompression: Send + Sync {
    fn set_compress(&self, enabled: bool) -> Result<()>;
}

struct CerseiSessionControls {
    runtime: CerseiRuntime,
    agent_id: NativeAgentId,
    session_id: acp::SessionId,
}

impl AgentSessionEffort for CerseiSessionControls {
    fn set_effort(&self, level: Option<String>) -> Result<()> {
        self.runtime
            .set_effort(
                self.agent_id,
                &self.session_id.to_string(),
                level.unwrap_or_default(),
            )
            .map_err(Into::into)
    }
}

impl AgentSessionCompression for CerseiSessionControls {
    fn set_compress(&self, enabled: bool) -> Result<()> {
        self.runtime
            .set_compress(self.agent_id, &self.session_id.to_string(), enabled)
            .map_err(Into::into)
    }
}

struct CerseiSessionModes {
    runtime: CerseiRuntime,
    agent_id: NativeAgentId,
    session_id: acp::SessionId,
    modes: Arc<Mutex<acp::SessionModeState>>,
}

impl AgentSessionModes for CerseiSessionModes {
    fn current_mode(&self) -> acp::SessionModeId {
        self.modes
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .current_mode_id
            .clone()
    }

    fn all_modes(&self) -> Vec<acp::SessionMode> {
        self.modes
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .available_modes
            .clone()
    }

    fn set_mode(&self, mode: acp::SessionModeId) -> BoxFuture<'static, Result<()>> {
        let runtime = self.runtime.clone();
        let agent_id = self.agent_id;
        let session_id = self.session_id.clone();
        let modes = self.modes.clone();
        async move {
            runtime.set_session_mode(agent_id, &session_id.to_string(), mode.to_string())?;
            // In-process: the call above cannot half-succeed, so unlike the
            // external connection there is nothing to roll back.
            modes
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .current_mode_id = mode;
            Ok(())
        }
        .boxed()
    }
}

struct CerseiModelSelector {
    runtime: CerseiRuntime,
    agent_id: NativeAgentId,
    session_id: acp::SessionId,
}

impl AgentModelSelector for CerseiModelSelector {
    fn list_models(&self) -> BoxFuture<'static, Result<AgentModelList>> {
        let models = self
            .runtime
            .configured_models()
            .into_iter()
            .map(|choice| AgentModelInfo {
                id: AgentModelId::from(choice.id),
                name: choice.model.into(),
                description: None,
                icon: None,
                is_latest: false,
                cost: None,
                disabled: None,
            })
            .collect();
        async move { Ok(AgentModelList::Flat(models)) }.boxed()
    }

    fn select_model(&self, model_id: AgentModelId) -> BoxFuture<'static, Result<()>> {
        let runtime = self.runtime.clone();
        let agent_id = self.agent_id;
        let session_id = self.session_id.clone();
        async move {
            runtime.set_model(
                agent_id,
                &session_id.to_string(),
                model_id.as_str().to_owned(),
            )?;
            Ok(())
        }
        .boxed()
    }

    fn selected_model(&self) -> BoxFuture<'static, Result<AgentModelInfo>> {
        let runtime = self.runtime.clone();
        let agent_id = self.agent_id;
        let session_id = self.session_id.clone();
        async move {
            let choice = runtime.session_model(agent_id, &session_id.to_string())?;
            Ok(AgentModelInfo {
                id: AgentModelId::from(choice.id),
                name: choice.model.into(),
                description: None,
                icon: None,
                is_latest: false,
                cost: None,
                disabled: None,
            })
        }
        .boxed()
    }

    fn favorite_model_ids(&self) -> HashSet<AgentModelId> {
        HashSet::default()
    }
}

struct CerseiSessionList {
    runtime: CerseiRuntime,
    last_listed_cwd: Arc<Mutex<Option<String>>>,
}

impl AgentSessionList for CerseiSessionList {
    fn list_sessions(
        &self,
        request: AgentSessionListRequest,
    ) -> BoxFuture<'static, Result<AgentSessionListResponse>> {
        let runtime = self.runtime.clone();
        let cwd = request
            .cwd
            .map(|cwd| cwd.to_string_lossy().into_owned())
            .or_else(|| self.last_listed_cwd.lock().unwrap_or_else(|p| p.into_inner()).clone());
        if let Some(cwd) = &cwd {
            *self.last_listed_cwd.lock().unwrap_or_else(|p| p.into_inner()) = Some(cwd.clone());
        }
        async move {
            // Sessions are stored per project directory, so with no directory
            // there is nothing to list — not an error, just an empty answer.
            let Some(cwd) = cwd else {
                return Ok(AgentSessionListResponse::new(Vec::new()));
            };
            let sessions = runtime
                .list_sessions(&cwd)
                .into_iter()
                .map(|meta| {
                    let mut info = AgentSessionInfo::new(acp::SessionId::new(meta.id.as_str()));
                    info.work_dirs = Some(vec![PathBuf::from(&cwd)]);
                    info.title = Some(meta.preview.as_str().into());
                    info
                })
                .collect();
            Ok(AgentSessionListResponse::new(sessions))
        }
        .boxed()
    }

    fn supports_delete(&self) -> bool {
        true
    }

    fn delete_session(&self, session_id: &acp::SessionId) -> BoxFuture<'static, Result<()>> {
        let runtime = self.runtime.clone();
        let session_id = session_id.to_string();
        let cwd = self
            .last_listed_cwd
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        async move {
            let cwd = cwd.ok_or_else(|| {
                anyhow!("cannot delete a native session before its project has been listed")
            })?;
            runtime
                .delete_session(&cwd, &session_id)
                .map_err(|e| anyhow!(e))
        }
        .boxed()
    }

    fn into_any(self: Arc<Self>) -> Arc<dyn Any + Send + Sync> {
        self
    }
}

// ------------------------------------------------------------------- helpers

/// The runtime's mode blob is the protocol's `SessionModeState` shape.
fn parse_modes(modes: Option<serde_json::Value>) -> Option<acp::SessionModeState> {
    let modes = modes?;
    match serde_json::from_value(modes) {
        Ok(modes) => Some(modes),
        Err(e) => {
            tracing::warn!(target: "atlas_native_agent", "mode blob decode failed: {e}");
            None
        }
    }
}

/// The native agent's prompt API is text-only, so a turn's blocks collapse here.
///
/// A resource link contributes its URI rather than being dropped: the agent can
/// read the path, and silently losing a mention would make the prompt read as
/// though the user never referred to the file.
fn flatten_text(blocks: &[acp::ContentBlock]) -> String {
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
        if piece.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&piece);
    }
    out
}

/// The runtime reports the protocol's own snake_case stop tokens.
///
/// An unrecognized token is `EndTurn` rather than an error: the turn did end,
/// and failing the whole prompt over a label would lose the transcript.
fn parse_stop_reason(token: &str) -> acp::StopReason {
    serde_json::from_value(serde_json::Value::String(token.to_owned()))
        .unwrap_or(acp::StopReason::EndTurn)
}

/// Push a stored transcript into a freshly opened thread.
fn replay_into(thread: &AcpThreadHandle, items: Vec<ReplayItem>) {
    let mut thread = lock(thread);
    for item in items {
        match item {
            ReplayItem::User { text } => {
                thread.push_user_content_block(None, text_block(&text));
            }
            ReplayItem::Assistant { text } => {
                thread.push_assistant_content_block(text_block(&text), false);
            }
            ReplayItem::Thinking { text } => {
                thread.push_assistant_content_block(text_block(&text), true);
            }
            ReplayItem::Tool {
                id,
                name,
                input,
                result,
                is_error,
            } => {
                let status = if is_error {
                    ToolCallStatus::Failed
                } else {
                    ToolCallStatus::Completed
                };
                let mut update = acp::ToolCallUpdateFields::default();
                update.title = Some(name);
                update.raw_input = Some(input);
                if let Some(result) = result {
                    update.content = Some(vec![acp::ToolCallContent::Content(
                        acp::Content::new(text_block(&result)),
                    )]);
                }
                let update = acp::ToolCallUpdate::new(acp::ToolCallId::new(id.as_str()), update);
                if let Err(e) = thread.upsert_tool_call_inner(update, status) {
                    tracing::warn!(target: "atlas_native_agent", "replayed tool call rejected: {e}");
                }
            }
        }
    }
}

fn text_block(text: &str) -> acp::ContentBlock {
    acp::ContentBlock::Text(acp::TextContent::new(text.to_owned()))
}

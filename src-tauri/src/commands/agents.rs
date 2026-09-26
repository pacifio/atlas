//! Tauri command surface for the ported ACP stack.
//!
//! The Tauri host owns three things: the singleton [`AgentHost`], the
//! [`DeltaSink`] that fans `SessionDeltaEnvelope`s out as `atlas:agents`
//! window events, and the ordered [`OutboundPipeline`] every delta travels
//! through on its way there.
//!
//! Rewritten on the new manager at Stage 3 of the Zed port. The command names
//! and argument shapes are exactly what they were — the frontend is re-pointed
//! in Stage 4, not here — and so is everything the checkpoint record depends
//! on:
//!
//! - the pipeline order, with `CaptureMiddleware` a STAGE rather than a bus
//!   subscriber (touchpoint #1);
//! - `note_prompt(session_id, cwd, plugin_id, model, RAW text)` on the send
//!   path, before memory prefixing and before any early return (#3), reading
//!   cheap metadata from `snapshot_meta` (#3);
//! - `turn_seq` stamped at send time (#6);
//! - plugin-id semantics, native-vs-ACP by `ATLAS_AGENT_ID` (#4);
//! - the `atlas:capture-changed` / `atlas:git-changed` event names, untouched
//!   because nothing here emits them (#5, #9);
//! - agents' own transcript locations, read through `atlas-agent-transcript`
//!   rather than relocated (#11).
//!
//! # What went away
//!
//! `agents_spawn` used to run a five-rung acquisition ladder before it could
//! start an agent: a disabled-builtin guard, a self-heal re-download, a
//! system-PATH probe, a managed-binary download with its own progress events,
//! and a stale-CLI fallback that retried the whole thing. All of it is gone
//! (ADR-0002). Spawning is now: look the id up in the installed map,
//! connect. An agent nobody installed is not there.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use atlas_acp_thread::prompt::{self, ImageAttachment, ResourceLinkSpec};
use atlas_agent_store::{
    AgentRegistryStore, AgentServerStore, InheritedProjectEnvironment, NodeRuntime, ReqwestClient,
};
use atlas_agent_wire::{
    AgentId, DeltaSink, ErrorClass, Message, MessageMode, MessageRole, SessionDelta,
    SessionDeltaEnvelope, SessionStatus, ToolCallStatus,
};
use atlas_bus::{OutboundMiddleware, OutboundPipeline};

use super::agent_host::{
    AgentHost, AgentInfo, AuthMethodWire, HostError, PermissionDecision, SessionInit,
    SessionKey, SessionSnapshot,
};
use super::agent_analytics::AnalyticsState;
use super::catalog::emit_catalog_changed;
use super::memory_indexer::MemoryRegistry;
use super::memory_pack;
use super::memory_sharing::MemorySharingState;
use super::memory_summarize;
use super::shared_memory::SharedMemoryStore;
use agent_client_protocol::schema::v1 as acp;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use uuid::Uuid;

/// Bridge the ported stack's deltas to the Tauri host's outbound concerns.
///
/// The sink body is an ordered [`OutboundPipeline`] of small, independently
/// testable middleware (window broadcast → analytics → capture → transcript →
/// memory ingest) rather than one monolithic `emit`. The projector also
/// publishes every delta to an in-process broadcast (`projector.subscribe()`)
/// before reaching this sink, so a cloud streamer can tap the same stream
/// without touching any of this.
pub struct TauriDeltaSink {
    pipeline: OutboundPipeline<SessionDeltaEnvelope>,
}

impl TauriDeltaSink {
    pub fn new(app: AppHandle) -> Self {
        let pipeline = OutboundPipeline::new()
            // Broadcast first so the UI updates before any heavier work.
            .with(Arc::new(BroadcastMiddleware { app: app.clone() }))
            .with(Arc::new(AnalyticsMiddleware { app: app.clone() }))
            // Session capture lives here rather than on the event bus because
            // the bus drops events for a lagging subscriber, and a dropped event
            // is a turn missing from the permanent record. This stage only
            // enqueues; all disk work happens on the capture worker thread.
            .with(Arc::new(super::capture::CaptureMiddleware { app: app.clone() }))
            // Atlas-owned transcripts for agents that keep none — what makes
            // an opencode / gemini session still exist in the sidebar after
            // the live session goes away. Always on and agent-agnostic,
            // unlike `capture` (opt-in, git-backed).
            .with(Arc::new(TranscriptMiddleware { app: app.clone() }))
            .with(Arc::new(MemoryIngestMiddleware { app }));
        Self { pipeline }
    }
}

impl DeltaSink for TauriDeltaSink {
    fn emit(&self, envelope: SessionDeltaEnvelope) {
        self.pipeline.run(&envelope);
    }
}

/// Fan every delta to the single `atlas:agents` window event channel.
struct BroadcastMiddleware {
    app: AppHandle,
}

impl OutboundMiddleware<SessionDeltaEnvelope> for BroadcastMiddleware {
    fn on_event(&self, envelope: &SessionDeltaEnvelope) {
        if let Err(e) = self.app.emit("atlas:agents", envelope) {
            tracing::error!(target: "atlas_agents::emit", "failed to emit atlas:agents event: {e}");
        }
    }
}

/// Opt-in per-turn product analytics, for **both** agent families.
///
/// The sink is the one place that sees every delta from every agent, so a turn's
/// whole shape — tools run, files touched, tokens spent, how it ended — is
/// accumulated here and flushed as a single `agent_turn_completed`. See
/// [`crate::commands::agent_analytics`] for the accumulator and for what this
/// deliberately refuses to measure.
///
/// Unlike [`MemoryIngestMiddleware`] this needs no blocking pool: it is
/// in-memory arithmetic over already-cloned data, and the one flush is
/// `capture`, a non-blocking `try_send` that no-ops entirely when the user has
/// not opted in.
struct AnalyticsMiddleware {
    app: AppHandle,
}

impl AnalyticsMiddleware {
    /// The plugin this agent was spawned from (`claude-code-ts` / `codex` /
    /// `atlas-agent`). A single `DashMap` lookup, safe on the delta hot path.
    ///
    /// This replaces the old `agent_kind`, which was `agent_id.0` — a random
    /// UUID minted per registration that identified nothing outside the process
    /// and did not survive a restart. It made every agent-segmented query in
    /// PostHog meaningless.
    fn plugin_id(&self, envelope: &SessionDeltaEnvelope) -> String {
        self.app
            .state::<Arc<AgentHost>>()
            .plugin_id_for_agent(envelope.agent_id)
            .unwrap_or_else(|| "unknown".to_string())
    }

    /// Coarse bucket for funnels that don't care which ACP agent it was.
    fn family(plugin_id: &str) -> &'static str {
        if plugin_id == atlas_native_agent::ATLAS_AGENT_ID {
            "native"
        } else {
            "acp"
        }
    }

    /// Flush the finished turn as one event. `outcome` discriminates rather than
    /// splitting into separate events, so a completion-rate funnel is one query.
    fn flush(&self, envelope: &SessionDeltaEnvelope, turn_seq: u64, extra: serde_json::Value) {
        let st = self.app.state::<Arc<AnalyticsState>>();
        let Some(mut props) = st.finish_turn(&envelope.session_id, turn_seq) else {
            return;
        };
        let plugin_id = self.plugin_id(envelope);
        if let (Some(map), Some(more)) = (props.as_object_mut(), extra.as_object()) {
            map.insert("agent_family".into(), serde_json::json!(Self::family(&plugin_id)));
            map.insert("plugin_id".into(), serde_json::json!(plugin_id));
            map.insert(
                "session_ref".into(),
                serde_json::json!(st.session_ref(&envelope.session_id)),
            );
            for (k, v) in more {
                map.insert(k.clone(), v.clone());
            }
        }
        self.app
            .state::<Arc<crate::telemetry::TelemetryClient>>()
            .capture("agent_turn_completed", props);
    }
}

impl OutboundMiddleware<SessionDeltaEnvelope> for AnalyticsMiddleware {
    fn on_event(&self, envelope: &SessionDeltaEnvelope) {
        let st = self.app.state::<Arc<AnalyticsState>>();
        let sid = envelope.session_id.as_str();

        match &envelope.delta {
            SessionDelta::Status { status, turn_seq } if *status == SessionStatus::Running => {
                let is_new = !st.has_turn(sid, *turn_seq);
                st.begin_turn(sid, *turn_seq);
                if is_new {
                    let plugin_id = self.plugin_id(envelope);
                    self.app
                        .state::<Arc<crate::telemetry::TelemetryClient>>()
                        .capture(
                            "agent_turn_started",
                            serde_json::json!({
                                "agent_family": Self::family(&plugin_id),
                                "plugin_id": plugin_id,
                                "session_ref": st.session_ref(sid),
                                "turn_seq": turn_seq,
                            }),
                        );
                }
            }
            SessionDelta::ToolCallUpserted { tool_call, .. } => {
                let salt = st.salt();
                st.with_turn(sid, |a| a.note_tool_call(salt, tool_call));
            }
            SessionDelta::UsageUpdated { usage } => st.with_turn(sid, |a| a.note_usage(usage)),
            SessionDelta::ContextUsage { used, size, cost } => {
                st.with_turn(sid, |a| a.note_context(*used, *size, *cost))
            }
            SessionDelta::PermissionRequest { .. } => {
                st.with_turn(sid, super::agent_analytics::TurnAcc::note_permission_request)
            }
            SessionDelta::PermissionResolved { .. } => {
                st.with_turn(sid, super::agent_analytics::TurnAcc::note_permission_resolved)
            }
            SessionDelta::RetryStatus { .. } => st.with_turn(sid, super::agent_analytics::TurnAcc::note_retry),
            SessionDelta::Compaction { active } if *active => {
                st.with_turn(sid, super::agent_analytics::TurnAcc::note_compaction)
            }
            SessionDelta::CompressionSaved { saved_tokens } => {
                st.with_turn(sid, |a| a.note_compression_saved(*saved_tokens))
            }
            SessionDelta::ModelChanged { model_id } => {
                st.with_turn(sid, |a| a.note_model(model_id))
            }
            SessionDelta::ModeChanged { .. } => st.with_turn(sid, super::agent_analytics::TurnAcc::note_mode_change),
            SessionDelta::MessageAppended { message } => {
                if message.role == MessageRole::Assistant {
                    st.with_turn(sid, super::agent_analytics::TurnAcc::note_assistant_message);
                }
            }
            SessionDelta::PlanUpdated { .. } => st.with_turn(sid, super::agent_analytics::TurnAcc::note_plan_update),

            SessionDelta::TurnFinished {
                stop_reason,
                turn_seq,
            } => self.flush(
                envelope,
                *turn_seq,
                serde_json::json!({ "outcome": "finished", "stop_reason": stop_reason }),
            ),
            SessionDelta::TurnFailed {
                error,
                turn_seq,
                error_kind,
            } => self.flush(
                envelope,
                *turn_seq,
                serde_json::json!({
                    "outcome": "failed",
                    "error_kind": error_kind,
                    "error_summary": crate::telemetry::redact_message(error, 160),
                }),
            ),
            SessionDelta::AgentDisconnected { reason } => {
                // The process died mid-turn. Flush what we have rather than
                // leaking the accumulator — a disconnect rate is exactly the
                // kind of thing this event exists to surface.
                self.flush(
                    envelope,
                    0,
                    serde_json::json!({
                        "outcome": "disconnected",
                        "error_summary": crate::telemetry::redact_message(reason, 160),
                    }),
                );
                st.forget_session(sid);
            }
            _ => {}
        }
    }
}

/// Records assistant output into Atlas's own transcript store, and persists at
/// each turn boundary.
///
/// For **every** agent. It used to skip the agents that keep a readable store
/// of their own — Claude, the native agent — because Atlas read those stores
/// for the sidebar and a second copy meant two rows for one conversation. Atlas
/// no longer reads anyone's store (ADR-0001), so that reason is gone and the
/// exception was the last agent-identity branch feeding Atlas's own record:
/// past-session `@`-mentions read these transcripts, and gating them by agent
/// id is exactly what "no ACP agent gets special treatment" forbids (#17).
///
/// Writes are debounced to `TurnFinished`/`TurnFailed` rather than per delta:
/// streaming emits hundreds of `MessageAppended`s per turn and a file write on
/// each would put disk I/O in the hot path for no benefit.
struct TranscriptMiddleware {
    app: AppHandle,
}

impl TranscriptMiddleware {
    /// Whether this session is one Atlas records is decided ONCE, by
    /// `agents_send` creating a buffer for it. Everything here just checks the
    /// buffer exists — no per-delta plugin lookup, and no way for the two sites
    /// to disagree about which agents are recorded.
    fn flush(&self, session_id: &str) {
        let state = self.app.state::<Arc<super::agent_transcript::TranscriptState>>();
        let Some(snapshot) = state.snapshot(session_id) else {
            return;
        };
        // Disk write off the emit thread — same discipline as memory ingest.
        let app = self.app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let dir = app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir());
            if let Err(e) = super::agent_transcript::save(&dir, &snapshot) {
                tracing::warn!(target: "atlas::agent_transcript", "save failed: {e}");
            }
        });
    }
}

impl OutboundMiddleware<SessionDeltaEnvelope> for TranscriptMiddleware {
    fn on_event(&self, envelope: &SessionDeltaEnvelope) {
        let state = self.app.state::<Arc<super::agent_transcript::TranscriptState>>();
        match &envelope.delta {
            SessionDelta::MessageAppended { message } => {
                // Cheap guard first: no buffer means no prompt was recorded for
                // this session, so it isn't one we're recording.
                if state.snapshot(&envelope.session_id).is_none() {
                    return;
                }
                // `agents_send` records the user's own prompts, so a user
                // message here is normally its echo — but not always. A queued
                // send fires without passing through `agents_send`, and used to
                // be dropped outright, leaving the transcript with the agent's
                // half of an exchange and no question. `note_user_delta` keeps
                // those and dedups the echo.
                if message.role == MessageRole::User {
                    state.note_user_delta(
                        &envelope.session_id,
                        &message.content,
                        chrono::Utc::now().to_rfc3339(),
                    );
                    return;
                }
                let role = match message.role {
                    MessageRole::Assistant => "assistant",
                    _ => "system",
                };
                state.note_message(
                    &envelope.session_id,
                    role,
                    &message.content,
                    message.model.as_deref(),
                    Some(&message.id),
                    chrono::Utc::now().to_rfc3339(),
                );
            }
            // The rest of a streaming reply. `MessageAppended` carries only a
            // run's FIRST fragment; ignoring the chunks — as this arm's absence
            // did — recorded every assistant reply cut off after a few words.
            // Invisible for agents whose own `session/load` replays history;
            // the whole visible transcript for the native agent, which resumes
            // without history and repaints from this record.
            SessionDelta::TextChunk { message_id, delta } => {
                state.note_text_chunk(
                    &envelope.session_id,
                    message_id,
                    delta,
                    chrono::Utc::now().to_rfc3339(),
                );
            }
            // Persist on either terminal — a failed turn's prose is still the
            // conversation, and losing it would make history lie about what
            // happened.
            SessionDelta::TurnFinished { .. } | SessionDelta::TurnFailed { .. } => {
                self.flush(&envelope.session_id)
            }
            SessionDelta::AgentDisconnected { .. } => self.flush(&envelope.session_id),
            _ => {}
        }
    }
}

/// Shared cross-agent memory ingest + finished-turn extraction/reindex. All
/// disk work is offloaded off the emit thread so the streaming hot path never
/// blocks.
struct MemoryIngestMiddleware {
    app: AppHandle,
}

impl OutboundMiddleware<SessionDeltaEnvelope> for MemoryIngestMiddleware {
    fn on_event(&self, envelope: &SessionDeltaEnvelope) {
        // Resolve this session's project cwd once via the in-memory session map
        // (cheap; no disk I/O). A delta before the session's first `agents_send`
        // has no meta yet → every memory action below is a silent no-op.
        let store = self.app.state::<SharedMemoryStore>();
        let meta = store.session_meta(&envelope.session_id);
        let cwd = meta.as_ref().map(|m| m.cwd.clone());

        let is_turn_finished = matches!(envelope.delta, SessionDelta::TurnFinished { .. });
        let agent_id = envelope.agent_id;
        let session_id = envelope.session_id.clone();

        // Site A — Shared Cross-Agent Memory (v2) capture (write-side parity for
        // all three agents). `classify` is pure/in-memory, but `append_event`
        // does a small disk write (one SQLite transaction in the record store), so we
        // run the whole `ingest` OFF the `emit` thread on the blocking pool — the
        // streaming-delta hot path must never block on disk. This feeds ONLY the
        // shared event log; the semantic vector index is now (re)built by the
        // background `MemoryIndexer` (Step 4), never synchronously on a delta.
        //
        // Gate BEFORE the clone+spawn: `classify` only ever acts on PlanUpdated,
        // completed ToolCallUpserted and assistant MessageAppended — every
        // streaming TextChunk/ThinkingChunk used to pay a full envelope clone
        // plus a blocking-pool dispatch to produce zero events, as did every
        // delta of a session never registered for sharing (cwd unknown →
        // `ingest` is a guaranteed no-op).
        let ingest_relevant = match &envelope.delta {
            SessionDelta::PlanUpdated { .. } => true,
            SessionDelta::ToolCallUpserted { tool_call, .. } => {
                tool_call.status == ToolCallStatus::Completed
            }
            SessionDelta::MessageAppended { message } => {
                message.role == MessageRole::Assistant
            }
            _ => false,
        };
        if ingest_relevant && cwd.is_some() {
            let app = self.app.clone();
            let envelope = envelope.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let store = app.state::<SharedMemoryStore>();
                super::memory_delta::ingest(&envelope, store.inner());
            });
        }

        if is_turn_finished {
            // Site B — the extractor's turn-finished pass, for every agent
            // (`super::memory_extract`). The conversation is read now, off the
            // emit thread — by the time the queue reaches the job the session
            // may be gone, and its end pass needs these turns — then queued:
            // the extractor applies the gates (about twenty turns and three
            // tool calls since the last pass) and asks the gateway or the
            // user's BYOK provider.
            if let Some(meta) = meta {
                let app = self.app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let key = SessionKey {
                        agent_id,
                        session_id: session_id.clone(),
                    };
                    let Ok(snapshot) = app.state::<Arc<AgentHost>>().snapshot(&key) else {
                        return;
                    };
                    let job = super::memory_indexer::Job::ExtractSession {
                        cwd: meta.cwd,
                        writer: super::shared_memory::Writer {
                            agent: meta.agent,
                            session_id,
                        },
                        turns: super::memory_extract::transcript_turns(&snapshot.messages),
                    };
                    if let Err(e) = app.state::<Arc<MemoryRegistry>>().enqueue(job) {
                        tracing::debug!(target: "atlas::shared_memory", "turn extraction not queued: {e}");
                    }
                });
            }

            // Background reindex nudge: the FS watcher only watches `*.md`/docs.json,
            // not session transcripts, so a finished turn needs an explicit nudge to
            // make chat-derived corpus searchable. Fire-and-forget — `enqueue_index`
            // `try_send`s and drops on a full queue, so `emit` never blocks here.
            // (The extractor additionally enqueues its own reindex after it
            // records entries.)
            if let Some(cwd) = cwd {
                let registry = self.app.state::<Arc<MemoryRegistry>>();
                registry.enqueue_index(&cwd);
            }
        }
    }
}

/// Emitted whenever Atlas's session history changes. Carries no payload: a
/// listener re-reads the store, which is the correct response to any change.
pub const THREADS_CHANGED_EVENT: &str = "atlas:threads-changed";

/// A connection asked the user something outside any session.
///
/// The session-scoped counterpart rides `atlas:agents` as an
/// `elicitation_requested` delta, keyed by session. These cannot: they are
/// raised during sign-in, before the agent has a session at all, which is
/// exactly when a device-code prompt or a login URL arrives. Same payload
/// fields, same dialog, answered by the same `agents_respond_elicitation`.
pub const AGENT_ELICITATION_EVENT: &str = "atlas:agent-elicitation";

/// A request-scoped question the user no longer has to answer.
///
/// The agent ends one out of band when the user completes a device-code login
/// in their browser (`session/complete_elicitation`). Without this the dialog
/// stays up, asking for something that already happened.
pub const AGENT_ELICITATION_RESOLVED_EVENT: &str = "atlas:agent-elicitation-resolved";

/// One request-scoped elicitation, as the webview reads it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestElicitation {
    agent_id: String,
    request_id: Uuid,
    /// `"url"` or `"form"`.
    mode: String,
    message: String,
    requested_schema: Option<serde_json::Value>,
    url: Option<String>,
}

/// Session lifecycle into shared memory, for projects with sharing on — the
/// sharing toggle switches all of shared memory, bookkeeping included. An end
/// is recorded for any session whose start was (the store keeps that set), so
/// a toggle flipped mid-session does not leave a row open.
///
/// The writes run on one thread of their own, in order: they touch disk (the
/// sharing file, the scope's git lookup, SQLite, a first-open migration) and
/// their callers are async tasks and the thread-event drain, which must not
/// block. One ordered queue, not a task per write, because an end overtaking
/// its start would be dropped. The quit path's grace covers the last writes.
struct SharingGatedLifecycle {
    writes: std::sync::mpsc::Sender<LifecycleWrite>,
    /// The memory tool server: its tokens are minted and revoked right here,
    /// in memory, so a session's token exists as soon as its start is
    /// reported; its per-session clock is dropped when the session ends.
    server: Arc<super::memory_server::MemoryServerHost>,
}

enum LifecycleWrite {
    Started { session_id: String, agent: String, cwd: String },
    Ended { session_id: String },
}

impl SharingGatedLifecycle {
    fn new(app: AppHandle, server: Arc<super::memory_server::MemoryServerHost>) -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<LifecycleWrite>();
        std::thread::Builder::new()
            .name("atlas-session-lifecycle".into())
            .spawn(move || {
                for write in rx {
                    let memory = app.state::<SharedMemoryStore>();
                    match write {
                        LifecycleWrite::Started { session_id, agent, cwd } => {
                            if app.state::<MemorySharingState>().is_enabled(&cwd) {
                                memory.session_started(&session_id, &agent, &cwd);
                            }
                        }
                        LifecycleWrite::Ended { session_id } => {
                            // The end-of-session extraction, queued behind the
                            // session's last turn-finished pass.
                            if let Some(ended) = memory.session_ended(&session_id) {
                                if let Some(registry) = app.try_state::<Arc<MemoryRegistry>>() {
                                    let job = super::memory_indexer::Job::SessionEnded {
                                        cwd: ended.cwd,
                                        writer: super::shared_memory::Writer {
                                            agent: ended.agent,
                                            session_id,
                                        },
                                    };
                                    if let Err(e) = registry.enqueue(job) {
                                        tracing::warn!(target: "atlas::shared_memory", "end-of-session extraction not queued: {e}");
                                    }
                                }
                            }
                        }
                    }
                }
            })
            .expect("the session lifecycle thread starts");
        Self { writes: tx, server }
    }

    fn queue(&self, write: LifecycleWrite) {
        let _ = self.writes.send(write);
    }
}

impl super::agent_host::SessionLifecycle for SharingGatedLifecycle {
    fn session_started(&self, session_id: &str, agent: &str, cwd: &str) {
        super::agent_host::SessionLifecycle::session_started(&**self.server.tokens(), session_id, agent, cwd);
        self.queue(LifecycleWrite::Started {
            session_id: session_id.to_string(),
            agent: agent.to_string(),
            cwd: cwd.to_string(),
        });
    }

    fn session_ended(&self, session_id: &str) {
        super::agent_host::SessionLifecycle::session_ended(&**self.server.tokens(), session_id);
        self.server.clocks().forget(session_id);
        self.queue(LifecycleWrite::Ended {
            session_id: session_id.to_string(),
        });
    }
}

/// Initialise the agent stack once the Tauri app is up so the sink has a real
/// `AppHandle` to emit through. Called from `setup`.
///
/// Order is load-bearing. Analytics and transcript state must exist before the
/// sink, because their middleware resolves them on the first delta; the sink
/// must exist before the host, because the host builds the projector around it.
pub fn install_manager(app: &AppHandle) {
    // App config dir holds the native agent's own state (the engine home
    // lives under it). Best-effort: fall
    // back to a temp dir if the platform path is unavailable. Resolved up here
    // because `TranscriptState` needs it to re-seed a session's buffer from the
    // transcript already on disk.
    let config_dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    app.manage(Arc::new(AnalyticsState::new()));
    app.manage(Arc::new(super::agent_transcript::TranscriptState::new(
        config_dir.clone(),
    )));
    let sink: Arc<dyn DeltaSink> = Arc::new(TauriDeltaSink::new(app.clone()));
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());

    let http = Arc::new(
        ReqwestClient::new(&format!("atlas/{}", env!("CARGO_PKG_VERSION")))
            .expect("the HTTP client builds"),
    );
    let registry = Arc::new(AgentRegistryStore::new(data_dir.clone(), http.clone()));
    let store = Arc::new(AgentServerStore::new(
        data_dir.clone(),
        http.clone(),
        NodeRuntime::managed(&data_dir, http),
        Arc::new(InheritedProjectEnvironment),
        Some(registry.clone()),
    ));

    // Inside the Tauri runtime's context: building the manager starts the task
    // that watches the installed map, and `tokio::spawn` panics with no reactor
    // entered. `setup` runs on the main thread, outside it.
    let host = {
        let handle = tauri::async_runtime::handle();
        let _guard = handle.inner().enter();
        AgentHost::new(sink, config_dir, store.clone(), registry.clone())
    };
    app.manage(host.clone());

    // Shared memory: every write is announced to the webview (the Shared tab
    // re-pulls on it), session start/end are recorded in the scope's sessions
    // table and mint/revoke the session's memory-server token, and the memory
    // tool server starts on the runtime (never blocking setup).
    {
        let memory = app.state::<SharedMemoryStore>();
        let emitter = app.clone();
        memory.on_change(Arc::new(move |change: &super::shared_memory::MemoryChanged| {
            let _ = emitter.emit(super::shared_memory::MEMORY_CHANGED_EVENT, change);
        }));
        super::shared_memory::install_embedder(Arc::new(super::memory_indexer::ModelEmbedder::new(app.clone())));
        // The extractor: durable entries distilled from sessions, through the
        // gateway or the user's BYOK provider.
        app.manage(Arc::new(super::memory_extract::Extractor::new(
            memory.inner().clone(),
            Arc::new(super::memory_extract::AppExtractionModel::new(app.clone())),
        )));
        let server = Arc::new(super::memory_server::MemoryServerHost::new());
        app.manage(server.clone());
        host.set_session_lifecycle(Arc::new(SharingGatedLifecycle::new(app.clone(), server.clone())));
        let gate_app = app.clone();
        let gate: super::memory_server::SharingGate =
            Arc::new(move |cwd: &str| gate_app.state::<MemorySharingState>().is_enabled(cwd));
        // The UI tool server (ADR-0012): each call is one UI action, emitted
        // to the window and answered through `ui_action_respond`. The
        // organisation tool server's window tools cross on the same bridge,
        // under their own event name.
        let emit_app = app.clone();
        let ui_bridge = Arc::new(super::ui_server::UiBridge::new(Arc::new(
            move |request: &super::ui_server::UiRequest| {
                emit_app.emit(super::ui_server::action_event(request), request).map_err(|e| e.to_string())
            },
        )));
        app.manage(ui_bridge.clone());
        // The user's "Let Atlas Agent navigate the app" setting, read on every
        // offer and every call so switching it off stops the agent at once.
        let nav_app = app.clone();
        let navigation: super::ui_server::NavigationGate = Arc::new(move || {
            nav_app
                .try_state::<crate::state::AtlasConfigHandle>()
                .is_some_and(|config| config.lock().effective().agent_ui_navigation)
        });
        let ui_router =
            super::ui_server::router(super::ui_server::UiTools::new(ui_bridge.clone(), navigation.clone()));
        // The organisation tool server (ADR-0014): calls act in the
        // organisation the session's Project is bound to, through the clients
        // the app already holds. Its setting, "Let Atlas Agent act in your
        // organisation", is read on every offer and every call, like the
        // navigation one.
        let org_app = app.clone();
        let org_access: super::org_server::OrgAccessGate = Arc::new(move || {
            org_app
                .try_state::<crate::state::AtlasConfigHandle>()
                .is_some_and(|config| config.lock().effective().agent_org_access)
        });
        // Every call is audited: its record goes to the window, which writes
        // the call's Logs row.
        let audit_app = app.clone();
        // The account and the Project's binding, read by the offer and again
        // by every call, so signing out or unbinding stops a running session.
        let session_orgs: Arc<dyn super::org_server::SessionOrgs> =
            Arc::new(super::org_server::AppSessionOrgs::new(app.clone()));
        let org_tools = super::org_server::OrgTools::new(
            Arc::new(super::org_server::AppOrganisationCloud::new(app.clone())),
            org_access.clone(),
            session_orgs.clone(),
        )
        .with_audit(Arc::new(move |record: &super::org_server::OrgActionRecord| {
            let _ = audit_app.emit(super::org_server::ORG_ACTION_EVENT, record);
        }))
        // Drawing on a Space page crosses to the window: the page's codec
        // lives in the frontend.
        .with_window(ui_bridge);
        let org_router = super::org_server::router(org_tools.clone());
        // Every agent that can take the server is handed it on each session
        // request, with a token of its own. It is the only way memory reaches
        // an agent (ADR-0010): nothing is prepended to a prompt. A connection
        // that carries UI control is also handed the UI tool server, and one
        // that carries organisation access the organisation tool server, all
        // on the same token.
        host.set_session_mcp(Arc::new(
            super::memory_server::MemorySessionOffers::new(server.clone(), gate.clone())
                .with_ui(super::ui_server::UiOffer::new(navigation))
                // The same tools describe an outward call on the approval
                // card — whom it reaches, and the full body — and keep the
                // user's approval of it, which the call checks (ADR-0014).
                .with_org(
                    super::org_server::OrgOffer::new(org_access, session_orgs)
                        .describing_with(org_tools),
                ),
        ));
        // `memory_search` also answers from the project's indexed documents.
        let index_app = app.clone();
        let index: super::memory_server::IndexSearch = Arc::new(move |cwd, query, limit| {
            let app = index_app.clone();
            Box::pin(async move {
                crate::commands::memory_retrieve::retrieve(&app, &cwd, &query, limit)
                    .await
                    .into_iter()
                    .map(|d| super::memory_server::IndexDoc {
                        id: Some(d.id),
                        title: d.title,
                        source: d.source,
                        text: d.text,
                    })
                    .collect()
            })
        });
        // `memory_forget` drops the entry's document from the index in the
        // same breath, so "forgotten" is true of both halves before it says
        // so. Bounded: the indexer holds the write lock for a whole re-embed
        // pass, and a tool call must not queue behind one — a miss here is
        // caught by the search-side liveness filter and by the next pass.
        let evict_app = app.clone();
        let evict: super::memory_server::IndexEvict = Arc::new(move |cwd, doc_id| {
            let app = evict_app.clone();
            Box::pin(async move {
                crate::commands::memory_retrieve::evict_doc(&app, &cwd, &doc_id).await
            })
        });
        // `memory_briefing` also carries the curated pack and the
        // recent-session handoff, built here because both need the app.
        let bootstrap_app = app.clone();
        let bootstrap: super::memory_server::BootstrapSource = Arc::new(move |cwd, session_id| {
            let app = bootstrap_app.clone();
            Box::pin(async move { build_bootstrap(&app, &cwd, &session_id).await })
        });
        server.start(
            memory.inner().clone(),
            gate,
            super::memory_server::Sources {
                index: Some(index),
                bootstrap: Some(bootstrap),
                evict: Some(evict),
            },
            vec![ui_router, org_router],
        );
    }

    // Connect-phase events the webview needs but no delta carries: the install
    // status text ("Downloading Node.js…") for the `Starting …` row, and a
    // connect that gave up at its deadline, counted so the next stall report
    // comes with the phase and not a screenshot of a timer.
    // One queue for both the bump announcements below and the background
    // pass after them, so an agent found behind by either waits only once.
    let pending_updates = PendingUpdates::default();
    {
        let app = app.clone();
        let host = host.clone();
        let mut events = host.manager().subscribe();
        let updates = pending_updates.clone();
        tauri::async_runtime::spawn(async move {
            use atlas_agent_manager::{Agent, AgentManagerEvent};
            loop {
                match events.recv().await {
                    Ok(AgentManagerEvent::NewVersionAvailable {
                        agent: Agent::Custom { id },
                        version,
                    }) => {
                        updates.schedule(&app, &host, id.to_string(), version);
                    }
                    Ok(AgentManagerEvent::LoadingStatusChanged {
                        agent: Agent::Custom { id },
                        status,
                    }) => {
                        let _ = app.emit(
                            "atlas:agents",
                            serde_json::json!({
                                "kind": "loading_status",
                                "plugin_id": id.to_string(),
                                "status": status,
                            }),
                        );
                    }
                    Ok(AgentManagerEvent::ConnectionFailed {
                        agent: Agent::Custom { id },
                        error: atlas_acp_thread::LoadError::TimedOut { phase, after, .. },
                    }) => {
                        tracing::warn!(plugin_id = %id, %phase, after_s = after.as_secs(), "agent start timed out");
                        if let Some(telemetry) =
                            app.try_state::<Arc<crate::telemetry::TelemetryClient>>()
                        {
                            telemetry.capture(
                                "agent_start_timed_out",
                                serde_json::json!({
                                    "agent_id": id.to_string(),
                                    "phase": phase.to_string(),
                                    "after_s": after.as_secs(),
                                }),
                            );
                        }
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                }
            }
        });
    }

    // Background updates, on every rebuild of the installed table (app start
    // and each registry refresh above all). Agents that are not running have
    // their copy on disk brought up to the registry's version now, so their
    // next start is instant. Running ones that are behind join the idle-restart
    // queue — that covers a copy left behind with no registry move to announce
    // it, which the bump path alone never saw. The `watch` coalesces: a burst
    // of rebuilds while one pass runs is one more pass, not one per rebuild.
    {
        let app = app.clone();
        let host = host.clone();
        let updates = pending_updates;
        let mut rebuilds = host.store().updates();
        tauri::async_runtime::spawn(async move {
            let running = |host: &AgentHost, id: &atlas_acp_thread::AgentId| {
                host.manager()
                    .entry(&atlas_agent_manager::Agent::Custom { id: id.clone() })
                    .is_some()
            };
            loop {
                for (id, version) in host.store().pending_updates(|id| running(&host, id)).await {
                    updates.schedule(&app, &host, id.to_string(), version);
                }
                let updated = host.store().prefetch_updates(|id| running(&host, id)).await;
                for id in &updated {
                    let version = host
                        .store()
                        .entry(id)
                        .and_then(|entry| entry.version)
                        .map(|version| version.to_string())
                        .unwrap_or_default();
                    emit_agent_update(&app, id.as_str(), &version, AgentUpdatePhase::Ready);
                }
                if !updated.is_empty() {
                    super::catalog::emit_catalog_changed(&app, "update");
                }
                if rebuilds.changed().await.is_err() {
                    return;
                }
            }
        });
    }

    // The sidebar refreshes from store changes, not from watching anyone's
    // files (ADR-0001). One task forwards them to the webview.
    if let Some(history) = host.history() {
        let app = app.clone();
        let mut changes = history.store().subscribe();
        tauri::async_runtime::spawn(async move {
            loop {
                match changes.recv().await {
                    Ok(_) => {
                        let _ = app.emit(THREADS_CHANGED_EVENT, ());
                    }
                    // Lagged means several changes collapsed into one, which is
                    // exactly what a listener that re-reads the store wants.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let _ = app.emit(THREADS_CHANGED_EVENT, ());
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                }
            }
        });
    }

    // Elicitations a connection raises outside any session — the sign-in ones.
    // Without this the agent asks, nobody is shown the question, and the
    // sign-in hangs on an answer that can never come.
    if let Some(mut elicitations) = host.take_request_elicitations() {
        let app = app.clone();
        let host = host.clone();
        tauri::async_runtime::spawn(async move {
            while let Some((agent_id, event)) = elicitations.recv().await {
                // A new question opens a dialog; an update may CLOSE one — the
                // agent ends a device-code elicitation itself once the user
                // finishes in their browser.
                let entry_id = match event {
                    atlas_acp_thread::ElicitationStoreEvent::ElicitationRequested(entry_id) => {
                        entry_id
                    }
                    atlas_acp_thread::ElicitationStoreEvent::ElicitationUpdated(entry_id)
                    | atlas_acp_thread::ElicitationStoreEvent::ElicitationResponded(entry_id) => {
                        if let Some(request_id) =
                            host.resolve_request_elicitation(&agent_id, &entry_id)
                        {
                            let _ = app.emit(
                                AGENT_ELICITATION_RESOLVED_EVENT,
                                serde_json::json!({ "requestId": request_id }),
                            );
                        }
                        continue;
                    }
                };
                let Some((request_id, wire)) =
                    host.announce_request_elicitation(&agent_id, &entry_id)
                else {
                    continue;
                };
                let _ = app.emit(
                    AGENT_ELICITATION_EVENT,
                    RequestElicitation {
                        agent_id: agent_id.as_str().to_string(),
                        request_id,
                        mode: wire.mode,
                        message: wire.message,
                        requested_schema: wire.requested_schema,
                        url: wire.url,
                    },
                );
            }
        });
    }

    // Seed the installed agents' spawn env from the BYOK keys on disk plus any
    // keys the user already exports in their shell — several agents read
    // provider API keys from env, which is Atlas's non-interactive substitute
    // for their `auth login` TUI. The sync uses the instant process-env
    // snapshot; the login-shell probe runs on its own thread and re-syncs.
    super::byok::sync_agent_key_env(app);
    super::byok::ensure_shell_probe(app);

    {
        // Cache-first, then network: the installed map is what makes agents
        // spawnable, so it is read and applied before anything is fetched.
        let app = app.clone();
        let host = host;
        tauri::async_runtime::spawn(async move {
            let installed = super::agent_host::load_installed(&data_dir);
            // Not fatal — an unreadable cache means "empty until the first
            // refresh", which the refresh below fixes. Logged rather than
            // discarded because the symptom it produces is "Registry
            // unavailable" with no cause anywhere in a user's log bundle.
            if let Err(error) = registry.load_cached().await {
                tracing::warn!(
                    error = %format!("{error:#}"),
                    "could not load the cached agent registry",
                );
            }
            store.set_settings(installed).await;
            emit_catalog_changed(&app, "settings");

            // Once the installed map is live, pull each installed agent's own
            // sessions in — once ever, per agent. A fresh install has none, so
            // this does nothing; an existing user's history does not arrive
            // empty (#20).
            //
            // On a task of its own: it starts every installed agent and waits
            // for each handshake, and an agent that hangs must not take the
            // catalog refresh and PATH detection down with it.
            {
                let host = host.clone();
                tauri::async_runtime::spawn(async move { host.backfill_history().await });
            }

            let _ = registry.refresh().await;
            store.registry_updated();
            // Announce the catalogue the moment it lands. Detection below can
            // take seconds — it shells out once per registry agent — and the
            // marketplace has everything it needs before that starts, so making
            // it wait is what left "Registry unavailable" on screen.
            emit_catalog_changed(&app, "registry");
            // Detection runs after the refresh: it probes for the programs the
            // registry names, so a first-run machine with no cached index would
            // otherwise have nothing to look for.
            let probe = host.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || probe.probe_detected()).await;
            emit_catalog_changed(&app, "discovery");
        });
    }

    // The D10 token provider (#51): the native agent authenticates with the
    // user's Atlas account, minting a short-TTL access JWT per request.
    //
    // Registered rather than passed in — these types are behind a cargo
    // feature, and a constructor parameter would `cfg`-gate `AgentHost::new`'s
    // signature and every caller of it — and read at *connect*
    // time rather than construction — `AgentHost` is built before the auth
    // state exists, so a source resolved in its constructor would always be
    // absent and every turn would go out with no credential.
    //
    // No cfg gate. This block used to sit behind `ported-engine`, and when #54
    // deleted that feature the gate did not fail the build — a cfg on a feature
    // that no longer exists silently compiles to NOTHING, so the registration
    // vanished and the first live turn went out with no Authorization header at
    // all ("Missing bearer token", straight from the gateway). Cargo does warn
    // (`unexpected_cfgs`), but only as a warning.
    //
    // The handle is captured and the auth state resolved **per mint**, not
    // here: `install_manager` runs at line ~176 of setup and `AuthState` is
    // managed at ~193, so an eager `app.state::<AuthState>()` panics the app
    // at launch — `state() called before manage()`. The old feature gate hid
    // exactly this ordering bug by never letting the line run.
    atlas_native_agent::engine::auth::register_token_source(Arc::new(AccountTokenSource {
        app: app.clone(),
    }));

    // The paying org, on every gateway request. Resolved from the live auth
    // snapshot per request rather than captured once: the user can switch org
    // mid-session, and the next message must bill — and be admitted by — the
    // org they switched to. Without this header the gateway attributes every
    // request to the caller *personally*, and an account whose AI grant lives
    // on its organisation is refused `403 no_entitlement` while that org sits
    // fully entitled.
    {
        let app_for_org = app.clone();
        atlas_native_agent::engine::set_org_source(Arc::new(move || {
            // `try_state`, lazily: this closure can in principle run before
            // `AuthState` is managed (same launch-ordering hazard as the token
            // source above), and "no org yet" is the honest answer then —
            // personal attribution, never a panic.
            let state = app_for_org.try_state::<crate::commands::auth::AuthState>()?;
            match state.core().snapshot() {
                crate::auth::AuthSnapshot::SignedIn { active_org_id, .. } => active_org_id,
                _ => None,
            }
        }));
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn agents_list_running(host: State<'_, Arc<AgentHost>>) -> Vec<AgentInfo> {
    host.list_agents()
}

/// A command failure that carries its CLASSIFICATION, not just a message.
///
/// The session-lifecycle commands used to reject with `e.to_string()`, throwing
/// away a classification the Rust side had already computed. That left the
/// frontend substring-matching English prose to decide whether a failure meant
/// "sign in" — and it missed the case that matters most: an agent that accepts
/// `initialize` and rejects `session/new` when unauthenticated fails at BIND
/// time, where no turn exists and no `atlas:auth-required` event ever fires.
///
/// `kind` is an [`ErrorClass`] wire token ("auth" | "transient" | "fatal" |
/// "process_dead" | "unknown"). Frontend callers must read `.message` rather
/// than stringifying the object — see `errInfo` in `agent-signin.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CmdError {
    pub message: String,
    pub kind: String,
}

impl CmdError {
    #[cfg_attr(not(test), allow(dead_code))]
    fn new(message: impl Into<String>, kind: ErrorClass) -> Self {
        Self {
            message: message.into(),
            kind: kind.wire_token().to_string(),
        }
    }
}

impl From<HostError> for CmdError {
    fn from(e: HostError) -> Self {
        Self {
            kind: e.class.wire_token().to_string(),
            message: e.message,
        }
    }
}

/// Connect to an agent.
///
/// No acquisition, no ladder, no retry: the id is either in the installed map
/// or it is not (ADR-0002). The catalog is re-emitted on success because an
/// agent's capability fields — `authKinds`, `supportsLogout`,
/// `supportsLoadSession`, `supportsSessionList` — only exist after
/// `initialize`, and nothing else tells the frontend they just appeared.
#[tauri::command]
pub async fn agents_spawn(
    plugin_id: String,
    app: AppHandle,
    host: State<'_, Arc<AgentHost>>,
) -> Result<AgentInfo, CmdError> {
    let info = host.spawn(&plugin_id).await.map_err(CmdError::from)?;
    emit_catalog_changed(&app, "spawn");
    Ok(info)
}

#[tauri::command]
pub fn agents_kill(agent_id: AgentId, host: State<'_, Arc<AgentHost>>) -> Result<(), String> {
    host.kill(agent_id).map_err(|e| e.to_string())
}

/// [`agents_kill`] by plugin id, for a tab whose connect never handed back a
/// handle to kill by. Cancels an in-flight connect, drops a live one, and is
/// a no-op for an agent that is not running. Renderer arg: `pluginId`.
#[tauri::command]
pub fn agents_kill_plugin(plugin_id: String, host: State<'_, Arc<AgentHost>>) -> Result<(), String> {
    host.kill_plugin(&plugin_id).map_err(|e| e.to_string())
}

/// Open a session on a connected agent.
///
/// This is THE command that surfaces "you are not signed in" for most agents:
/// they accept `initialize` happily and only reject `session/new`. No turn
/// exists at that point, so nothing emits `atlas:auth-required` — the
/// `kind: "auth"` on this rejection is the ONLY signal the frontend gets to
/// route the user into sign-in instead of showing a raw protocol error.
#[tauri::command]
pub async fn agents_new_session(
    agent_id: AgentId,
    cwd: PathBuf,
    // Extra project roots. Only reaches agents that advertised
    // `sessionCapabilities.additionalDirectories`; dropped with a log otherwise.
    additional_directories: Option<Vec<PathBuf>>,
    host: State<'_, Arc<AgentHost>>,
) -> Result<SessionInit, CmdError> {
    host.new_session(agent_id, cwd, additional_directories.unwrap_or_default())
        .await
        .map_err(CmdError::from)
}

/// Run an agent's ACP `authenticate` flow. Awaits until the agent reports
/// success — for Codex this resolves once the OpenAI sign-in completes.
#[tauri::command]
pub async fn agents_authenticate(
    agent_id: AgentId,
    method_id: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<(), String> {
    host.authenticate(agent_id, method_id)
        .await
        .map_err(|e| e.to_string())
}

/// Answer an elicitation the agent raised.
///
/// `action` is `"accept"` / `"decline"` / `"cancel"`; `content` is the form's
/// field map on accept. Unknown ids are a no-op — the user can answer a dialog
/// whose agent already died.
#[tauri::command]
pub fn agents_respond_elicitation(
    agent_id: AgentId,
    request_id: Uuid,
    action: String,
    content: Option<serde_json::Value>,
    host: State<'_, Arc<AgentHost>>,
) -> Result<(), String> {
    let _ = agent_id;
    host.respond_elicitation(request_id, &action, content)
        .map_err(|e| e.to_string())
}

/// Branch a session from its current state.
///
/// Real for the native agent — the engine's `thread/fork` copies the stored
/// conversation into a new thread, and the frontend opens the returned id
/// through the normal reopen path (which replays the forked history). Still
/// `null` for every ACP agent: Zed does not implement `session/fork`, the
/// trait has no method for it, and `supportsFork` hides the affordance there.
#[tauri::command]
pub async fn agents_fork_session(
    key: SessionKey,
    host: State<'_, Arc<AgentHost>>,
) -> Result<Option<String>, String> {
    host.fork_session(&key).await.map_err(|e| e.to_string())
}

/// Rewind the last exchange, returning the prompt that started it.
///
/// Half of "retry the last message": the caller re-sends the returned text
/// with `agents_send`. Split in two on purpose — the rewind is destructive and
/// the send can fail on its own, and a UI that cannot tell those apart either
/// loses the user's prompt or replays it into a thread that never shrank.
///
/// `null` when the connection advertises no rewind — which is every ACP agent
/// today, because rewinding is not in ACP's session capabilities. The
/// affordance is hidden there rather than faked with an append-and-resend that
/// quietly diverges. Asked through `AgentConnection::rewind`, so an agent that
/// gains the verb needs no change here.
#[tauri::command]
pub async fn agents_rewind_last_turn(
    key: SessionKey,
    host: State<'_, Arc<AgentHost>>,
) -> Result<Option<String>, String> {
    host.rewind_last_turn(&key).await.map_err(|e| e.to_string())
}

/// Set any agent-advertised config option.
///
/// Generic by design: ACP lets an agent advertise arbitrary options, and Atlas
/// previously only ever set `config_id = "model"`, so every other knob it
/// offered was unreachable. `value` is JSON — a bool maps to the wire's
/// `Boolean` form, anything else to the `ValueId` (select) form.
#[tauri::command]
pub async fn agents_set_config_option(
    key: SessionKey,
    config_id: String,
    value: serde_json::Value,
    host: State<'_, Arc<AgentHost>>,
) -> Result<(), String> {
    host.set_config_option(&key, config_id, value)
        .await
        .map_err(|e| e.to_string())
}

/// Sign the agent out (ACP `logout`).
///
/// Only offered for agents that advertised `auth.logout` — the frontend gates
/// on `AgentCatalogEntry.supportsLogout`, and the backend errors rather than
/// pretending for the rest. Atlas stores no agent credentials itself, so this
/// is purely a delegation: the agent drops its own.
#[tauri::command]
pub async fn agents_logout(
    agent_id: AgentId,
    host: State<'_, Arc<AgentHost>>,
) -> Result<(), String> {
    host.logout(agent_id).await.map_err(|e| e.to_string())
}
/// Read a saved session's transcript off disk for an INSTANT first paint.
///
/// Deliberately agent-free: no spawn, no `session/load`, no `SessionState`. The
/// frontend paints the returned messages immediately and runs the real
/// `agents_load_session` concurrently to make the session sendable. Empty vec
/// means "this plugin has no on-disk transcript" (Codex) — not an error.
#[tauri::command]
pub async fn agents_replay_transcript(
    session_id: String,
    cwd: String,
    app: AppHandle,
) -> Result<Vec<Message>, String> {
    // Atlas's own record, for every agent.
    //
    // There used to be a step before this one: for Claude, parse the JSONL the
    // Claude Agent SDK writes under `~/.claude/projects`. That was Atlas
    // reading another program's private storage to paint its own UI, which
    // ADR-0001 ends — and it was reachable only through an agent-identity
    // branch. Atlas has recorded every agent's transcript since the usage
    // re-source, and `session/load` replays anything older from the agent.
    let dir = app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir());
    let cwd_owned = cwd.clone();
    let sid = session_id.clone();
    let stored = tauri::async_runtime::spawn_blocking(move || {
        super::agent_transcript::read(&dir, &cwd_owned, &sid)
    })
    .await
    .ok()
    .flatten();
    Ok(stored.map(transcript_to_messages).unwrap_or_default())
}

/// Atlas's stored transcript → the `Message` shape the renderer paints.
fn transcript_to_messages(t: super::agent_transcript::StoredTranscript) -> Vec<Message> {
    t.messages
        .into_iter()
        .enumerate()
        .map(|(i, m)| Message {
            id: format!("{}-{i}", t.id),
            role: match m.role.as_str() {
                "user" => MessageRole::User,
                "assistant" => MessageRole::Assistant,
                _ => MessageRole::System,
            },
            mode: MessageMode::Text,
            content: m.content,
            thinking: String::new(),
            tool_calls: Vec::new(),
            plan: None,
            model: m.model,
            images: Vec::new(),
            timestamp: m
                .timestamp
                .parse::<chrono::DateTime<chrono::Utc>>()
                .unwrap_or_else(|_| chrono::Utc::now()),
        })
        .collect()
}

/// Session-history rows for agents Atlas records itself. Merged into the
/// sidebar alongside the Claude / Codex / native / Kilo listings; returns an
/// empty vec for a project with no such sessions.
#[tauri::command]
pub async fn agent_transcripts_list(
    cwd: String,
    app: AppHandle,
) -> Vec<super::agent_transcript::AgentSessionMeta> {
    let dir = app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir());
    tauri::async_runtime::spawn_blocking(move || super::agent_transcript::list(&dir, &cwd))
        .await
        .unwrap_or_default()
}

/// One Atlas-recorded transcript's messages, oldest first.
///
/// The read side of the store `agent_transcripts_list` enumerates. Past-session
/// `@`-mentions inline this at send time, for any agent that ran through Atlas
/// — which is why it is keyed by `(cwd, session_id)` rather than by a path into
/// some CLI's private directory.
#[tauri::command]
pub async fn agent_transcripts_read(
    cwd: String,
    session_id: String,
    app: AppHandle,
) -> Vec<super::agent_transcript::StoredMessage> {
    let dir = app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir());
    tauri::async_runtime::spawn_blocking(move || {
        super::agent_transcript::read(&dir, &cwd, &session_id)
            .map(|t| t.messages)
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn agents_load_session(
    agent_id: AgentId,
    session_id: String,
    cwd: PathBuf,
    host: State<'_, Arc<AgentHost>>,
) -> Result<SessionKey, CmdError> {
    host.load_session(agent_id, session_id, cwd)
        .await
        .map_err(CmdError::from)
}

/// Turn a history row into a live session.
///
/// The only way a history row is reopened: through the protocol, by whichever
/// of `session/load` / `session/resume` the agent advertised, starting the
/// agent if it is not running (#19).
#[tauri::command]
pub async fn threads_resume(
    thread_id: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<super::agent_host::ResumedThread, CmdError> {
    host.resume_thread(parse_thread_id(&thread_id)?)
        .await
        .map_err(CmdError::from)
}

/// Remove a history row. Always local; agent-side only when advertised.
#[tauri::command]
pub async fn threads_delete(
    thread_id: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<(), CmdError> {
    host.delete_thread(parse_thread_id(&thread_id)?)
        .await
        .map_err(CmdError::from)
}

/// Every project the user has threads in — the sidebar's only source (#21).
#[tauri::command]
pub fn threads_projects(
    cwd: Option<String>,
    host: State<'_, Arc<AgentHost>>,
) -> Result<Vec<super::agent_host::ThreadProjectWire>, CmdError> {
    host.thread_projects(cwd.as_deref())
        .map_err(CmdError::from)
}

/// Every thread, archived or not, newest-started first — the history view.
#[tauri::command]
pub fn threads_history(
    archived_only: bool,
    host: State<'_, Arc<AgentHost>>,
) -> Result<Vec<super::agent_host::ThreadRow>, CmdError> {
    host.thread_history(archived_only).map_err(CmdError::from)
}

/// Take a thread out of the active list, keeping it in history.
#[tauri::command]
pub fn threads_archive(
    thread_id: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<(), CmdError> {
    host.archive_thread(parse_thread_id(&thread_id)?)
        .map_err(CmdError::from)
}

/// Which installed agents can be imported from, and how much they have.
///
/// Spawns each installed agent to ask — the capability only exists after
/// `initialize`, so there is no cheaper honest answer (#20).
#[tauri::command]
pub async fn threads_import_candidates(
    host: State<'_, Arc<AgentHost>>,
) -> Result<Vec<super::agent_host::ImportCandidate>, CmdError> {
    host.import_candidates().await.map_err(CmdError::from)
}

/// Pull the chosen agents' sessions into history. Answers how many rows landed.
#[tauri::command]
pub async fn threads_import(
    plugin_ids: Vec<String>,
    host: State<'_, Arc<AgentHost>>,
) -> Result<usize, CmdError> {
    host.import_threads(plugin_ids)
        .await
        .map_err(CmdError::from)
}

fn parse_thread_id(raw: &str) -> Result<atlas_thread_metadata::ThreadId, CmdError> {
    raw.parse()
        .map_err(|_| CmdError::new(format!("not a thread id: {raw}"), ErrorClass::Fatal))
}

#[tauri::command(async)]
pub fn agents_snapshot(
    key: SessionKey,
    host: State<'_, Arc<AgentHost>>,
) -> Result<SessionSnapshot, String> {
    host.snapshot(&key).map_err(|e| e.to_string())
}

/// `agents_snapshot` minus the transcript. The full snapshot serializes every
/// message across IPC — multi-MB on long sessions — yet five frontend call
/// sites (mode seed, model backfill, composer self-heals, model warm) only
/// read the ~1KB metadata. Same wire shape; `messages` arrives empty.
#[tauri::command(async)]
pub fn agents_snapshot_meta(
    key: SessionKey,
    host: State<'_, Arc<AgentHost>>,
) -> Result<SessionSnapshot, String> {
    host.snapshot_meta(&key).map_err(|e| e.to_string())
}

/// Send a user message to an agent session, exactly as typed.
///
/// Shared memory is never prepended here (ADR-0010): the agent pulls it
/// through the `atlas_memory` tools its session was offered. What this path
/// owns on the memory side is the write half — registering the session so
/// its deltas are captured into the scope's record.
#[tauri::command]
pub async fn agents_send(
    key: SessionKey,
    text: String,
    attachments: Option<Vec<ImageAttachment>>,
    // `@`-mentions that point at files (P2.1). Sent as `ResourceLink` blocks
    // rather than flattened into the prose — the ACP-native way to hand an
    // agent a file, and every agent is required to accept it.
    resource_links: Option<Vec<ResourceLinkSpec>>,
    host: State<'_, Arc<AgentHost>>,
    sharing: State<'_, MemorySharingState>,
    app: AppHandle,
) -> Result<(), String> {
    // `agent_turn_started` is NOT emitted here. It used to be, but this runs
    // before `start_turn`, so it could not know the `turn_seq` that joins a
    // start to its completion — and a send that supersedes a running turn
    // counted twice. `AnalyticsMiddleware` emits it off `Status{Running}`
    // instead, which is the actual turn boundary.

    // Image attachments ride WITH the turn (P0.2) rather than through a staging
    // side-channel drained by the next send. Held here and folded into the
    // content at the one send below, so nothing can strand images for some
    // later turn to pick up.
    let images = attachments.unwrap_or_default();
    let links = resource_links.unwrap_or_default();

    // Resolve the project cwd. Unknown session → fail with the SAME error
    // shape `manager.send` produces, without attempting a send that would
    // skip session registration (one condition, one behavior — L5).
    // Meta only — the full snapshot deep-clones the whole transcript under the
    // SessionState mutex the streaming actor locks per chunk, and this path
    // reads three small fields.
    let Ok(snapshot) = host.snapshot_meta(&key) else {
        return Err(HostError::unknown_session().to_string());
    };
    let current_model = snapshot.current_model.clone();
    let plugin_id = snapshot.plugin_id.clone();
    let cwd = snapshot.cwd;

    // Session capture: record the prompt and bind the session.
    //
    // This has to happen here rather than in the delta middleware, because the
    // user's prompt is never emitted as a delta — the session actor skips it
    // deliberately (the frontend adds user messages optimistically) and turn
    // start is a bare status flip. A delta subscriber alone would produce
    // Sessions with no prompts and no titles.
    //
    // Placed before the sharing check so capture does not depend on whether
    // memory sharing happens to be enabled for the project.
    // `plugin_id` rather than `agent_id`: the latter is a per-process UUID, and
    // the former ("claude-code", "codex", the native agent's id) is both what a
    // reader wants to see on a timeline row and what tells capture whether this
    // is an ACP-hosted agent or the native one.
    app.state::<super::capture::CaptureState>().note_prompt(
        &key.session_id,
        &cwd,
        &plugin_id,
        current_model.as_deref(),
        &text,
    );

    // The user just sent something. `interacted_at` is the only field the
    // thread's own events cannot supply — a queued message never reaches the
    // agent (Zed's `update_interacted_at`, `thread_metadata_store.rs:843-856`).
    if let Some(history) = host.history() {
        history.note_interaction(
            &acp::SessionId::new(key.session_id.as_str()),
            chrono::Utc::now(),
        );
    }

    // Atlas's own transcript, for every agent. Recorded here for the same
    // reason capture is: the user's prompt is never emitted as a delta, so a
    // delta-only recorder produces transcripts that start mid-answer and have
    // no title.
    if !cwd.is_empty() {
        app.state::<Arc<super::agent_transcript::TranscriptState>>()
            .note_prompt(
                &key.session_id,
                &cwd,
                &plugin_id,
                &text,
                chrono::Utc::now().to_rfc3339(),
            );
    }

    // Register this session so the capture path (`TauriDeltaSink::emit`) can
    // route its deltas into the scope's record. The text itself goes to the
    // agent untouched: a slash command stays at byte 0 (Claude Code resolves
    // one only there), and nothing Atlas wrote can be echoed back as the
    // user's words.
    if !cwd.is_empty() && sharing.is_enabled(&cwd) {
        app.state::<SharedMemoryStore>().register_session(&key.session_id, &cwd, &plugin_id);
    }
    host.send(
        &key,
        prompt::with_resource_links(prompt::compose(text, images), links),
    )
    .map_err(|e| e.to_string())
}

/// Hard cap on building the briefing's first-look extras (pack + handoff +
/// summarise) so a slow disk or provider can never stall an agent's briefing.
const BOOTSTRAP_BUDGET_SECS: u64 = 8;

/// The first-look extras `memory_briefing` serves beyond the record: the
/// curated pack from the project's foreign memory files, then the
/// recent-session handoff. Everything runs inside a single
/// [`BOOTSTRAP_BUDGET_SECS`] timeout; on elapse the briefing goes out without
/// them rather than late.
async fn build_bootstrap(app: &AppHandle, cwd: &str, session_id: &str) -> super::memory_server::Bootstrap {
    let pref = app.state::<MemorySharingState>().summarizer_pref(cwd);
    let cwd = cwd.to_string();
    let session_id = session_id.to_string();

    let built = tokio::time::timeout(Duration::from_secs(BOOTSTRAP_BUDGET_SECS), async {
        // Curated pack (collect_corpus is async + does its own spawn_blocking).
        let project_memory = memory_pack::build_memory_pack(&cwd, memory_pack::PACK_MAX_CHARS).await;

        // Recent-session handoff, from what Atlas recorded for any agent:
        // pure disk I/O on a blocking thread.
        let handoff_raw = {
            let cwd = cwd.clone();
            let sid = session_id.clone();
            let transcripts = app
                .state::<Arc<super::agent_transcript::TranscriptState>>()
                .config_dir()
                .to_path_buf();
            tokio::task::spawn_blocking(move || {
                memory_pack::build_session_handoff(&cwd, &sid, &transcripts)
            })
            .await
            .ok()
            .flatten()
        };

        let recent_session = memory_pack::handoff_block(handoff_raw, &pref, |raw, provider, model| async move {
            memory_summarize::summarize(app, &raw, &provider, &model).await
        })
        .await;

        super::memory_server::Bootstrap { project_memory, recent_session }
    })
    .await;

    match built {
        Ok(bootstrap) => bootstrap,
        Err(_) => {
            tracing::warn!(
                target: "atlas::memory_sharing",
                "briefing extras exceeded {BOOTSTRAP_BUDGET_SECS}s budget; serving the briefing without the pack and handoff"
            );
            super::memory_server::Bootstrap::default()
        }
    }
}

#[tauri::command]
pub fn agents_cancel(key: SessionKey, host: State<'_, Arc<AgentHost>>) -> Result<(), String> {
    host.cancel(&key).map_err(|e| e.to_string())
}

/// Tear down a session's backend state when its tab closes or the project
/// switches. Idempotent; UI state is the frontend's.
#[tauri::command]
pub async fn agents_drop_session(
    app: AppHandle,
    agent_id: AgentId,
    session_id: String,
) -> Result<(), String> {
    let _ = agent_id;
    // Release the per-turn accumulator with the session, so a tab closed
    // mid-turn doesn't hold one for the life of the process.
    app.state::<Arc<AnalyticsState>>().forget_session(&session_id);
    let host = app.state::<Arc<AgentHost>>().inner().clone();
    host.drop_session(&session_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agents_set_mode(
    key: SessionKey,
    mode_id: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<(), String> {
    host.set_mode(&key, mode_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agents_set_model(
    key: SessionKey,
    model_id: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<(), String> {
    host.set_model(&key, model_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agents_set_effort(
    key: SessionKey,
    effort: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<(), String> {
    host.set_effort(&key, effort).map_err(|e| e.to_string())
}

// `agents_set_compress` is gone (#54). Tool-output compression was a knob on
// the old native runtime's RTK compressor and the engine has no counterpart — a
// named casualty (D8). Removed rather than stubbed, so the toggle disappears
// instead of sitting there doing nothing.

#[tauri::command]
pub fn agents_respond_permission(
    agent_id: AgentId,
    session_id: String,
    request_id: Uuid,
    decision: PermissionDecision,
    host: State<'_, Arc<AgentHost>>,
) -> Result<(), String> {
    let _ = agent_id;
    host.respond_permission(&session_id, request_id, decision)
        .map_err(|e| e.to_string())
}

// ── Auth methods ────────────────────────────────────────────────────────────
//
// An agent advertises its supported auth methods in the `initialize` response,
// and the frontend renders a chooser populated from whatever it actually
// supports. When the user picks one, `agents_run_auth_method` spawns the
// command the AGENT named for it (`_meta["terminal-auth"]`) — that CLI runs
// the loopback OAuth flow, opens the browser, catches the callback, and writes
// credentials. The host's only job is to run the spec and stream its output.
//
// Two shapes of "run this to sign in", both from the agent itself: a typed
// `Terminal` method naming the ARGUMENTS to re-run the agent's own binary
// with, and `_meta["terminal-auth"]` naming a whole command. Zed's
// `terminal_auth_task` reads both; so does `terminal_auth_command_for`.
//
// The old `enrich_auth_methods` is gone with `BUILTIN_AGENTS`: it filled in a
// login command for agents that advertised none, from a hardcoded per-agent
// table of login argv. An agent that names no login command now says so,
// which is the honest answer and the only one that generalises past a list
// someone wrote down. Codex's `~/.codex/auth.json` probe and its bespoke
// "Sign in with ChatGPT" pill went the same way — sign-in is capability-gated
// for every agent, and no agent's private storage is read to decide it.

/// One environment variable an agent's auth method wants, and whether the
/// system already provides it.
///
/// Deliberately value-free: the UI renders a green/red checklist, and a command
/// that returned the secret would put it in every IPC log and devtools trace
/// for no gain.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthEnvStatus {
    /// The auth method this variable belongs to.
    pub method_id: String,
    pub name: String,
    pub label: Option<String>,
    pub optional: bool,
    pub satisfied: bool,
    /// `"process-env"` / `"shell-env"`, or absent when unset.
    pub source: Option<super::byok::EnvVarSource>,
}

/// Which env vars an agent's auth methods need, and which the system already
/// satisfies.
///
/// Covers two shapes: typed `env_var` methods (spec) and the proprietary
/// `_meta["api-key"].provider` hint, which is the only api-key signal any
/// adapter actually ships today — mapping it through the BYOK provider table
/// gives those methods the same checklist a typed method would get.
#[tauri::command]
pub async fn agents_auth_env_status(
    agent_id: AgentId,
    host: State<'_, Arc<AgentHost>>,
) -> Result<Vec<AuthEnvStatus>, String> {
    let methods = host.auth_methods(agent_id).await.map_err(|e| e.to_string())?;

    let mut wanted: Vec<(String, String, Option<String>, bool)> = Vec::new();
    for method in &methods {
        for var in &method.env_vars {
            wanted.push((
                method.id.clone(),
                var.name.clone(),
                var.label.clone(),
                var.optional,
            ));
        }
        if let Some(provider) = &method.api_key_provider {
            for var in super::byok::env_vars_for_provider(provider) {
                wanted.push((method.id.clone(), (*var).to_string(), None, false));
            }
        }
    }

    // One shell probe for anything the standard sweep never looks at, so an
    // agent asking for an unusual variable still reports honestly.
    let names: Vec<String> = wanted.iter().map(|(_, n, _, _)| n.clone()).collect();
    super::byok::ensure_vars_probed(&names);

    Ok(wanted
        .into_iter()
        .map(|(method_id, name, label, optional)| {
            let source = super::byok::env_var_source(&name);
            AuthEnvStatus {
                method_id,
                name,
                label,
                optional,
                satisfied: source.is_some(),
                source,
            }
        })
        .collect())
}

/// The agent's advertised auth methods, verbatim.
///
/// Raw JSON rather than a typed projection: the `Terminal` / `EnvVar` variants
/// are unstable-gated, so a typed read silently degrades a `terminal` method to
/// `agent` and drops its extra fields. The frontend already reads these by
/// field name.
#[tauri::command]
pub async fn agents_list_auth_methods(
    agent_id: AgentId,
    host: State<'_, Arc<AgentHost>>,
) -> Result<Vec<AuthMethodWire>, String> {
    host.auth_methods(agent_id).await.map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
struct AuthRunDone {
    success: bool,
    exit_code: Option<i32>,
    message: Option<String>,
    /// Which agent this run belonged to, and which run it was. Without these,
    /// two agents signing in at once cross-talk: the frontend resolved on ANY
    /// `:done` event, so the first CLI to finish completed both flows.
    agent_id: AgentId,
    run_id: String,
}

/// First `https://` URL on a line, if any.
///
/// A login CLI prints the OAuth URL and usually opens it itself; surfacing it
/// gives the user a fallback when the browser hand-off silently fails, which is
/// otherwise indistinguishable from the flow just hanging. Trailing punctuation
/// is trimmed because CLIs habitually wrap the URL in prose.
fn first_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let rest = &line[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '<' || c == '>')
        .unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches(['.', ',', ')', ']', ';', ':']);
    (url.len() > "https://".len()).then(|| url.to_string())
}

/// Run the login command the agent named for this method.
///
/// The command comes from the agent's own `_meta["terminal-auth"]`, resolved
/// through the ported `AgentConnection::terminal_auth_command` — Zed's
/// mechanism. An agent that named none is rejected rather than guessed at.
#[tauri::command]
pub async fn agents_run_auth_method(
    agent_id: AgentId,
    method_id: String,
    app: AppHandle,
) -> Result<String, String> {
    let host = app.state::<Arc<AgentHost>>().inner().clone();
    let spec = host
        .terminal_auth_command(agent_id, &method_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("auth method {method_id} has no terminal-auth spec"))?;

    let command = spec.command;
    let args = spec.args;

    // Scopes every event this run emits. Returned to the caller so it can
    // filter, rather than resolving on whichever run finishes first.
    let run_id = uuid::Uuid::new_v4().to_string();

    tracing::info!(
        target: "atlas::agents",
        "running auth method `{method_id}` via `{command}` (args: {args:?}, run {run_id})"
    );

    // Windowless on Windows: a headless auth run must not flash a console.
    let mut cmd = atlas_process::async_command(&command);
    cmd.args(&args);
    cmd.envs(spec.env.iter().cloned());
    // Closed deliberately, and this run is NOT the answer for a login that asks
    // a question (#24). A pipe is not a tty: a provider picker or a password
    // prompt would neither render nor respond even if stdin were connected, so
    // giving it one would replace a visible hang with a subtler one. An
    // interactive login is handed to a real terminal instead — see
    // `openCommandTerminal`, offered by the sign-in dialog for any method with
    // a runnable command. What stays here is the headless run: a login that
    // asks nothing and reports itself through stdout/stderr.
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn `{command}`: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let app_for_stdout = app.clone();
    let run_for_stdout = run_id.clone();
    if let Some(out) = stdout {
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "atlas::agents::auth_stdout", "{line}");
                let _ = app_for_stdout.emit(
                    "atlas:auth-run:progress",
                    serde_json::json!({
                        "agentId": agent_id,
                        "runId": run_for_stdout,
                        "stream": "stdout",
                        "line": line,
                        "url": first_url(&line),
                    }),
                );
            }
        });
    }
    let app_for_stderr = app.clone();
    let run_for_stderr = run_id.clone();
    if let Some(err) = stderr {
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "atlas::agents::auth_stderr", "{line}");
                let _ = app_for_stderr.emit(
                    "atlas:auth-run:progress",
                    serde_json::json!({
                        "agentId": agent_id,
                        "runId": run_for_stderr,
                        // Login CLIs print the OAuth URL and prompts on stderr
                        // as often as stdout, so both streams are scanned.
                        "stream": "stderr",
                        "line": line,
                        "url": first_url(&line),
                    }),
                );
            }
        });
    }

    let app_for_wait = app.clone();
    let run_for_wait = run_id.clone();
    let run_for_wait_err = run_id.clone();
    tokio::spawn(async move {
        let result = child.wait().await;
        let payload = match result {
            Ok(status) => AuthRunDone {
                agent_id,
                run_id: run_for_wait,
                success: status.success(),
                exit_code: status.code(),
                message: if status.success() {
                    None
                } else {
                    Some(format!(
                        "auth subprocess exited with code {}",
                        status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into())
                    ))
                },
            },
            Err(e) => AuthRunDone {
                agent_id,
                run_id: run_for_wait_err,
                success: false,
                exit_code: None,
                message: Some(format!("wait failed: {e}")),
            },
        };
        let _ = app_for_wait.emit("atlas:auth-run:done", payload);
    });

    Ok(run_id)
}

#[cfg(test)]
mod cmd_error_tests {
    use super::*;

    fn wire(e: CmdError) -> serde_json::Value {
        serde_json::to_value(e).unwrap()
    }

    /// The case this type exists for: an agent rejecting `session/new` before
    /// any turn starts, so no `atlas:auth-required` ever fires.
    #[test]
    fn an_auth_failure_carries_the_auth_kind() {
        let e: CmdError = HostError::classified(
            "Authentication required. Please run `cursor-agent login`.",
        )
        .into();
        let v = wire(e);
        assert_eq!(v["kind"], "auth");
        assert!(v["message"].as_str().unwrap().contains("Authentication required"));
    }

    /// The frontend reads `.message`; stringifying the object would render
    /// "[object Object]".
    #[test]
    fn the_shape_is_camel_case_message_plus_kind() {
        let v = wire(CmdError::new("boom", ErrorClass::Fatal));
        assert_eq!(v["message"], "boom");
        assert_eq!(v["kind"], "fatal");
        assert_eq!(v.as_object().unwrap().len(), 2);
    }

    #[test]
    fn non_auth_failures_still_classify() {
        assert_eq!(wire(HostError::unknown_session().into())["kind"], "process_dead");
        assert_eq!(
            wire(HostError::classified("rate limit exceeded").into())["kind"],
            "transient"
        );
        assert_eq!(wire(HostError::classified("weird").into())["kind"], "unknown");
    }

    /// An agent that is not installed is FATAL, not auth: no amount of signing
    /// in or retrying changes it — only installing it does.
    #[test]
    fn a_missing_agent_is_fatal_rather_than_auth() {
        let v = wire(
            HostError::new(
                "some-agent is not installed. Install it from the Agent Marketplace.",
                ErrorClass::Fatal,
            )
            .into(),
        );
        assert_eq!(v["kind"], "fatal");
    }
}

#[cfg(test)]
mod auth_url_tests {
    use super::first_url;

    /// The whole point: a login CLI prints the OAuth URL in prose, and the user
    /// needs it when the automatic browser hand-off fails.
    #[test]
    fn a_url_is_lifted_out_of_surrounding_prose() {
        assert_eq!(
            first_url("Visit https://auth.example.com/device?code=ABC to continue").as_deref(),
            Some("https://auth.example.com/device?code=ABC")
        );
    }

    /// CLIs habitually end the sentence right after the URL; a trailing period
    /// silently 404s if it rides along.
    #[test]
    fn trailing_sentence_punctuation_is_trimmed() {
        assert_eq!(
            first_url("Open https://example.com/auth.").as_deref(),
            Some("https://example.com/auth")
        );
        assert_eq!(
            first_url("see (https://example.com/x), then return").as_deref(),
            Some("https://example.com/x")
        );
    }

    #[test]
    fn quoted_and_bracketed_urls_stop_at_the_delimiter() {
        assert_eq!(
            first_url("go to \"https://example.com/a\" now").as_deref(),
            Some("https://example.com/a")
        );
        assert_eq!(
            first_url("<https://example.com/b>").as_deref(),
            Some("https://example.com/b")
        );
    }

    #[test]
    fn lines_without_a_url_yield_nothing() {
        assert!(first_url("Waiting for authentication…").is_none());
        // Deliberately https-only: an http:// login URL would be a downgrade we
        // should not be steering the user toward.
        assert!(first_url("http://insecure.example.com").is_none());
    }

    #[test]
    fn a_bare_scheme_is_not_a_url() {
        assert!(first_url("prefix https:// suffix").is_none());
    }

    #[test]
    fn the_first_url_wins_when_a_line_has_several() {
        assert_eq!(
            first_url("https://first.example.com and https://second.example.com").as_deref(),
            Some("https://first.example.com")
        );
    }
}

/// The native agent's credential: an Atlas access JWT from the signed-in
/// account (#51, spec D10/D14).
///
/// A thin adapter and deliberately so — the caching, the proactive re-mint at
/// `exp − 60s` and the refresh-once-on-401 all live in the seam's
/// `AtlasExternalAuth`, which is where the engine can drive them. This only has
/// to answer "mint me one now".
///
/// `mint_access_token` is a bare `GET /token` with no cache of its own, which
/// is *correct* for its other callers: they mint at the point of use, so their
/// token is never near expiry. It is the engine's long-lived session, holding a
/// credential across a multi-minute turn, that needs the caching layer above.
struct AccountTokenSource {
    /// The app handle, not the auth core: this source is registered during
    /// setup, *before* `AuthState` is managed, so the core cannot be captured
    /// at construction. It is resolved per mint — by which time a turn is in
    /// flight and the state has long existed.
    app: AppHandle,
}

impl atlas_native_agent::engine::auth::AtlasTokenSource for AccountTokenSource {
    fn mint(&self) -> atlas_native_agent::engine::auth::ExternalAuthFuture<'_, String> {
        Box::pin(async move {
            let Some(state) = self.app.try_state::<crate::commands::auth::AuthState>() else {
                return Err(std::io::Error::other(
                    "Atlas auth state is not ready yet — try again in a moment",
                ));
            };
            state.core().mint_access_token().await.map_err(|err| {
                // The engine's trait speaks `io::Error`, so the reason has to
                // survive as text or the user is told only that auth failed.
                // Each verdict gets its own words: "not signed in" and "the
                // network is down" call for different actions, and the
                // Indeterminate one used to surface as a Debug dump
                // (`Indeterminate { retry_after: None, reason: "error sending
                // request" }`) — which is what a user with no DNS at launch
                // read on 2026-09-14, behind a toast about the engine runtime.
                use crate::auth::AuthFailure;
                let text = match err {
                    AuthFailure::NoCredential => "not signed in to Atlas".to_string(),
                    AuthFailure::Rejected => {
                        "the Atlas sign-in was rejected — sign in again".to_string()
                    }
                    AuthFailure::Denied => "the Atlas account may not use Atlas Agent".to_string(),
                    AuthFailure::Indeterminate { reason, .. } => {
                        format!("Atlas can't be reached ({reason})")
                    }
                };
                std::io::Error::other(text)
            })
        })
    }
}

/// Where an agent update is, as the webview hears it on `atlas:agents`
/// (`{kind: "agent_update", plugin_id, version, phase, error?}`). Not a
/// session delta — that wire is frozen, and an update belongs to a plugin,
/// not to one session.
#[derive(Clone, Copy)]
pub(crate) enum AgentUpdatePhase<'a> {
    /// Queued behind a reply that is still running. Nothing is interrupted.
    Waiting,
    /// The old process was dropped; open chats reconnect on their next send.
    Restarting,
    /// The new version is downloading.
    Installing,
    /// The new version is installed.
    Ready,
    /// The install failed. The next connect retries it in the foreground.
    Failed(&'a str),
}

pub(crate) fn emit_agent_update(
    app: &AppHandle,
    plugin_id: &str,
    version: &str,
    phase: AgentUpdatePhase<'_>,
) {
    let (phase, error) = match phase {
        AgentUpdatePhase::Waiting => ("waiting", None),
        AgentUpdatePhase::Restarting => ("restarting", None),
        AgentUpdatePhase::Installing => ("installing", None),
        AgentUpdatePhase::Ready => ("ready", None),
        AgentUpdatePhase::Failed(error) => ("failed", Some(error)),
    };
    let _ = app.emit(
        "atlas:agents",
        serde_json::json!({
            "kind": "agent_update",
            "plugin_id": plugin_id,
            "version": version,
            "phase": phase,
            "error": error,
        }),
    );
}

/// Registry bumps for running agents, applied once each agent is idle.
///
/// The manager only announces a bump; this is the half that acts on it. Per
/// plugin, one waiter: it polls until no turn is running on the agent, then
/// restarts it (`AgentHost::restart_for_update`) and installs the new version
/// before anything asks for it. A second bump while one waits just raises the
/// version the waiter will report — it reads the latest when it fires.
///
/// Polled, not evented: nothing emits "turn ended" per agent, and a turn
/// lasts seconds to minutes, so a two-second look costs nothing and keeps
/// this independent of the projector's internals.
#[derive(Clone, Default)]
struct PendingUpdates(Arc<std::sync::Mutex<std::collections::HashMap<String, String>>>);

impl PendingUpdates {
    const IDLE_POLL: std::time::Duration = std::time::Duration::from_secs(2);

    fn version_of(&self, plugin_id: &str) -> String {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(plugin_id)
            .cloned()
            .unwrap_or_default()
    }

    fn schedule(&self, app: &AppHandle, host: &Arc<AgentHost>, plugin_id: String, version: String) {
        let first = {
            let mut pending = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            pending.insert(plugin_id.clone(), version).is_none()
        };
        if !first {
            return;
        }
        let this = self.clone();
        let app = app.clone();
        let host = host.clone();
        tauri::async_runtime::spawn(async move {
            if host.agent_turn_running(&plugin_id) {
                let version = this.version_of(&plugin_id);
                emit_agent_update(&app, &plugin_id, &version, AgentUpdatePhase::Waiting);
            }
            while host.agent_turn_running(&plugin_id) {
                tokio::time::sleep(Self::IDLE_POLL).await;
            }
            let Some(version) = this
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&plugin_id)
            else {
                return;
            };
            // Uninstalled while we waited: nothing to update.
            if host.restart_for_update(&plugin_id, &version).is_err() {
                return;
            }
            tracing::info!(target: "atlas::agents", %plugin_id, %version, "restarted agent for update");
            emit_agent_update(&app, &plugin_id, &version, AgentUpdatePhase::Restarting);
            emit_agent_update(&app, &plugin_id, &version, AgentUpdatePhase::Installing);
            let id = atlas_acp_thread::AgentId::new(plugin_id.as_str());
            match host.store().prefetch_update(&id).await {
                Ok(_) => emit_agent_update(&app, &plugin_id, &version, AgentUpdatePhase::Ready),
                Err(error) => {
                    let error = format!("{error:#}");
                    tracing::warn!(target: "atlas::agents", %plugin_id, %error, "agent update install failed");
                    emit_agent_update(&app, &plugin_id, &version, AgentUpdatePhase::Failed(&error));
                }
            }
            super::catalog::emit_catalog_changed(&app, "update");
        });
    }
}

//! Tauri command surface for the ACP stack.
//!
//! The Tauri host owns three things: the singleton [`AgentHost`], the
//! [`DeltaSink`] that fans `SessionDeltaEnvelope`s out as `atlas:agents`
//! window events, and the ordered [`OutboundPipeline`] every delta travels
//! through on its way there.
//!
//! Rewritten on the new manager. The command names
//! and argument shapes are exactly what they were, and so is everything the checkpoint record depends
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

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::prompt::{ImageAttachment, PastedText, ResourceLinkSpec};
use atlas_agent_store::{
    AgentRegistryStore, AgentServerStore, InheritedProjectEnvironment, NodeRuntime, ReqwestClient,
};
use atlas_agent_wire::{
    AgentId, DeltaSink, ErrorClass, Message, MessageMode, MessageRole, SessionDelta,
    SessionDeltaEnvelope, SessionStatus, ToolCallStatus,
};
use atlas_bus::{OutboundMiddleware, OutboundPipeline};

use super::agent_analytics::AnalyticsState;
use super::agent_host::{
    AgentHost, AgentInfo, AuthMethodWire, HostError, Origin, PermissionDecision, Prompt,
    PromptHooks, PromptSent, SessionInit, SessionKey, SessionSnapshot, SubmitPolicy,
};
use super::catalog::emit_catalog_changed;
use super::memory_indexer::MemoryRegistry;
use super::memory_pack;
use super::memory_sharing::MemorySharingState;
use super::memory_summarize;
use super::shared_memory::SharedMemoryStore;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use uuid::Uuid;

/// Bridge the stack's deltas to the Tauri host's outbound concerns.
///
/// The sink body is an ordered [`OutboundPipeline`] of small, independently
/// testable middleware (window broadcast → analytics → capture → transcript →
/// memory ingest) rather than one monolithic `emit`. The projector also
/// publishes every delta to an in-process broadcast (`projector.subscribe()`)
/// before reaching this sink, so a cloud streamer can tap the same stream
/// without touching any of this.
pub struct TauriDeltaSink {
    inner: Arc<SinkInner>,
}

struct SinkInner {
    pipeline: OutboundPipeline<SessionDeltaEnvelope>,
    /// Names the turns a sleep of the computer interrupted. Read on every
    /// delta, BEFORE it travels, so the notice reaches every stage ahead of
    /// the failure it explains; and on a tick, for a turn that wakes silent.
    sleep: Arc<crate::sleep_watch::SleepWatch>,
    /// Held across "observe, then deliver" on both the emit path and the
    /// tick. Without it a tick could compute a turn's sleep notice, lose the
    /// race to an emit that ends the turn, and deliver the notice after the
    /// turn's terminal delta. Every stage of the pipeline is in-memory work
    /// or an enqueue, and none emits back into the sink, so this is cheap
    /// and cannot deadlock.
    delivery: parking_lot::Mutex<()>,
}

impl SinkInner {
    fn run(&self, envelope: &SessionDeltaEnvelope) {
        let _order = self.delivery.lock();
        for notice in self.sleep.observe(envelope) {
            self.pipeline.run(&notice);
        }
        self.pipeline.run(envelope);
    }
}

impl TauriDeltaSink {
    pub fn new(app: AppHandle, sleep: Arc<crate::sleep_watch::SleepWatch>) -> Self {
        let pipeline = OutboundPipeline::new()
            // Broadcast first so the UI updates before any heavier work.
            .with(Arc::new(BroadcastMiddleware { app: app.clone() }))
            .with(Arc::new(AnalyticsMiddleware { app: app.clone() }))
            .with(Arc::new(KeepAwakeMiddleware { app: app.clone() }))
            // Session capture lives here rather than on the event bus because
            // the bus drops events for a lagging subscriber, and a dropped event
            // is a turn missing from the permanent record. This stage only
            // enqueues; all disk work happens on the capture worker thread.
            .with(Arc::new(super::capture::CaptureMiddleware {
                app: app.clone(),
            }))
            // Atlas-owned transcripts for agents that keep none — what makes
            // an opencode / gemini session still exist in the sidebar after
            // the live session goes away. Always on and agent-agnostic,
            // unlike `capture` (opt-in, git-backed).
            .with(Arc::new(TranscriptMiddleware { app: app.clone() }))
            .with(Arc::new(MemoryIngestMiddleware {
                app: app.clone(),
                queue: super::memory_delta::IngestQueue::new("atlas-memory-ingest"),
            }))
            // Last: in-process subscribers that must not lose a delta (the
            // Universal RC relay). See [`DeltaTaps`].
            .with(Arc::new(TapMiddleware {
                taps: app.state::<Arc<DeltaTaps>>().inner().clone(),
            }));
        let inner = Arc::new(SinkInner {
            pipeline,
            sleep,
            delivery: parking_lot::Mutex::new(()),
        });
        // The tick holds only a weak reference, so it ends with the sink.
        let weak = Arc::downgrade(&inner);
        if let Err(e) = std::thread::Builder::new()
            .name("atlas-sleep-watch".into())
            .spawn(move || loop {
                std::thread::sleep(crate::sleep_watch::TICK_INTERVAL);
                let Some(inner) = weak.upgrade() else { return };
                let _order = inner.delivery.lock();
                for notice in inner.sleep.tick() {
                    inner.pipeline.run(&notice);
                }
            })
        {
            tracing::warn!(target: "atlas::sleep_watch", "the sleep-watch tick did not start: {e}");
        }
        Self { inner }
    }
}

/// A lossless, in-process subscription to every session delta, after the
/// window has had it.
pub type DeltaTap = Arc<dyn Fn(&SessionDeltaEnvelope) + Send + Sync>;

/// The pipeline's last stage: whoever registered a tap gets every envelope, in
/// emit order, with its `seq`.
///
/// The projector's broadcast bus is the other in-process tap, and it is lossy
/// by design — a lagging subscriber drops events. That is wrong for a remote
/// view, where a dropped `permission_request` is a turn stuck for the remote
/// driver. A tap here runs synchronously on the emit thread with the session's
/// emit order held, exactly like `CaptureMiddleware`, so it must only enqueue:
/// never block, never call back into the host for the same session.
///
/// The Universal RC layer registers one per live RC session: register, then
/// take `AgentHost::snapshot` and drop buffered envelopes with
/// `seq <= as_of_seq` — nothing twice, nothing missed.
#[derive(Default)]
pub struct DeltaTaps {
    taps: std::sync::RwLock<Vec<(u64, DeltaTap)>>,
    next: std::sync::atomic::AtomicU64,
}

// `add` / `remove` are the Universal RC layer's subscription API
// (`commands::rc`): one tap per hosted room.
impl DeltaTaps {
    /// Register a tap. The returned id removes it.
    pub fn add(&self, tap: DeltaTap) -> u64 {
        let id = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.taps
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((id, tap));
        id
    }

    pub fn remove(&self, id: u64) {
        self.taps
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|(tap, _)| *tap != id);
    }

    fn run(&self, envelope: &SessionDeltaEnvelope) {
        let taps = self
            .taps
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for (_, tap) in taps.iter() {
            tap(envelope);
        }
    }
}

struct TapMiddleware {
    taps: Arc<DeltaTaps>,
}

impl OutboundMiddleware<SessionDeltaEnvelope> for TapMiddleware {
    fn on_event(&self, envelope: &SessionDeltaEnvelope) {
        self.taps.run(envelope);
    }
}

impl DeltaSink for TauriDeltaSink {
    fn emit(&self, envelope: SessionDeltaEnvelope) {
        self.inner.run(&envelope);
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

/// Manages OS power assertions to prevent idle system sleep while agents are
/// running. Sessions that end without a status delta are released through
/// `SharingGatedLifecycle::session_ended`.
struct KeepAwakeMiddleware {
    app: AppHandle,
}

impl OutboundMiddleware<SessionDeltaEnvelope> for KeepAwakeMiddleware {
    fn on_event(&self, envelope: &SessionDeltaEnvelope) {
        let Some(manager) = self
            .app
            .try_state::<Arc<crate::keep_awake::KeepAwakeManager>>()
        else {
            return;
        };
        manager.observe(&envelope.session_id, &envelope.delta);
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
            map.insert(
                "agent_family".into(),
                serde_json::json!(Self::family(&plugin_id)),
            );
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
            SessionDelta::ContextUsage {
                used,
                size,
                cost,
                currency,
            } => st.with_turn(sid, |a| {
                a.note_context(*used, *size, *cost, currency.as_deref())
            }),
            SessionDelta::PermissionRequest { .. } => st.with_turn(
                sid,
                super::agent_analytics::TurnAcc::note_permission_request,
            ),
            SessionDelta::PermissionResolved { .. } => st.with_turn(
                sid,
                super::agent_analytics::TurnAcc::note_permission_resolved,
            ),
            SessionDelta::RetryStatus { .. } => {
                st.with_turn(sid, super::agent_analytics::TurnAcc::note_retry)
            }
            SessionDelta::Compaction { active } if *active => {
                st.with_turn(sid, super::agent_analytics::TurnAcc::note_compaction)
            }
            SessionDelta::CompressionSaved { saved_tokens } => {
                st.with_turn(sid, |a| a.note_compression_saved(*saved_tokens))
            }
            SessionDelta::ModelChanged { model_id, .. } => {
                st.with_turn(sid, |a| a.note_model(model_id))
            }
            SessionDelta::ModeChanged { .. } => {
                st.with_turn(sid, super::agent_analytics::TurnAcc::note_mode_change)
            }
            SessionDelta::MessageAppended { message } => {
                if message.role == MessageRole::Assistant {
                    st.with_turn(sid, super::agent_analytics::TurnAcc::note_assistant_message);
                }
            }
            SessionDelta::PlanUpdated { .. } => {
                st.with_turn(sid, super::agent_analytics::TurnAcc::note_plan_update)
            }

            SessionDelta::TurnFinished {
                stop_reason,
                turn_seq,
                ..
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
        let state = self
            .app
            .state::<Arc<super::agent_transcript::TranscriptState>>();
        let Some(snapshot) = state.snapshot(session_id) else {
            return;
        };
        // Disk write off the emit thread — same discipline as memory ingest.
        let app = self.app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            if let Err(e) = super::agent_transcript::save(&dir, &snapshot) {
                tracing::warn!(target: "atlas::agent_transcript", "save failed: {e}");
            }
        });
    }
}

impl OutboundMiddleware<SessionDeltaEnvelope> for TranscriptMiddleware {
    fn on_event(&self, envelope: &SessionDeltaEnvelope) {
        let state = self
            .app
            .state::<Arc<super::agent_transcript::TranscriptState>>();
        match &envelope.delta {
            SessionDelta::MessageAppended { message } => {
                // Cheap guard first: no buffer means no prompt was recorded for
                // this session, so it isn't one we're recording.
                if !state.is_recording(&envelope.session_id) {
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
            // Recorded from the send path (`note_prompt`, through the host's
            // prompt hooks) for every prompt the host dispatches, queued and
            // remote ones included; the echo would be a second copy.
            SessionDelta::UserMessage { .. } => {}
            _ => {}
        }
    }
}

/// Shared cross-agent memory ingest + finished-turn extraction/reindex. All
/// disk work is offloaded off the emit thread so the streaming hot path never
/// blocks.
struct MemoryIngestMiddleware {
    app: AppHandle,
    /// Capture jobs, in emit order (see [`super::memory_delta::IngestQueue`]).
    queue: super::memory_delta::IngestQueue,
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
        // run the whole `ingest` OFF the `emit` thread on the ingest queue's one
        // thread, in emit order — the streaming-delta hot path must never block
        // on disk, and a later plan must never land before an earlier one. This feeds ONLY the
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
            SessionDelta::MessageAppended { message } => message.role == MessageRole::Assistant,
            _ => false,
        };
        if ingest_relevant {
            if let Some(cwd) = cwd.clone() {
                let app = self.app.clone();
                let envelope = envelope.clone();
                self.queue.push(move || {
                    // The switch is read when the job runs: a session registered
                    // while sharing was on stops capturing as soon as it is
                    // switched off.
                    if !app.state::<MemorySharingState>().is_enabled(&cwd) {
                        return;
                    }
                    let store = app.state::<SharedMemoryStore>();
                    super::memory_delta::ingest(&envelope, store.inner());
                });
            }
        }

        // A retry or `/undo` took turns back: what the session remembered in
        // them drops to candidate once the recorder has marked them (M4).
        if matches!(envelope.delta, SessionDelta::HistoryRewound { .. }) {
            if let Some(cwd) = cwd.clone() {
                let _ = self.app.state::<Arc<MemoryRegistry>>().enqueue(
                    super::memory_indexer::Job::RewoundCheck {
                        cwd,
                        session: session_id.clone(),
                        retried: false,
                    },
                );
            }
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

            // Background reindex nudge: the FS watcher only watches `*.md` files,
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

/// How often the idle sweep looks for sessions to settle. The threshold is in
/// days, so a minute is far finer than it needs to be; it is what keeps a
/// change to the setting visible without a restart.
const AUTO_SETTLE_EVERY: std::time::Duration = std::time::Duration::from_secs(60);

/// A sweep that settles more than this many sessions at once tells the user,
/// the first time only ([`SESSIONS_AUTO_SETTLED_EVENT`]).
const AUTO_SETTLE_NOTICE_OVER: usize = 5;

/// Fired once, ever: the first idle sweep that settled more than
/// [`AUTO_SETTLE_NOTICE_OVER`] sessions. Payload `{ count }`.
pub const SESSIONS_AUTO_SETTLED_EVENT: &str = "atlas:sessions-auto-settled";

/// The flag that the notice has been shown, a marker file in the app data
/// directory. Its presence is the whole of it.
const AUTO_SETTLE_NOTICE_MARKER: &str = "auto-settle-notice-shown";

#[derive(Clone, serde::Serialize)]
struct AutoSettledNotice {
    count: usize,
}

/// The longest the snooze timer sleeps before re-reading the wall clock.
///
/// Tokio's timer runs on the monotonic clock, which stops while the machine
/// sleeps: a timer set for 9:00 before the lid closed at 8:00 would fire an
/// hour after it opens, not at 9:00. Capping each sleep bounds that lag. It
/// is still one timer, not a poll per session — each wake-up reads one
/// minimum and goes back to sleep.
const SNOOZE_TIMER_MAX_SLEEP: std::time::Duration = std::time::Duration::from_secs(60);

/// Wake snoozed sessions when their time comes: one timer, for the soonest
/// `snoozed_until`, recomputed whenever the store changes (a new snooze, a
/// wake, a send that cleared one). Every snooze already due — at launch,
/// after the machine slept — wakes on the first pass. Ends when the store
/// does.
pub(crate) async fn run_snooze_waker(store: atlas_thread_metadata::ThreadMetadataStore) {
    let mut changes = store.subscribe();
    loop {
        let now = chrono::Utc::now();
        store.wake_due(now);
        let sleep = store
            .next_snooze_wake()
            .map(|at| (at - now).to_std().unwrap_or_default())
            .unwrap_or(SNOOZE_TIMER_MAX_SLEEP)
            .min(SNOOZE_TIMER_MAX_SLEEP);
        tokio::select! {
            () = tokio::time::sleep(sleep) => {}
            changed = changes.recv() => {
                if matches!(changed, Err(tokio::sync::broadcast::error::RecvError::Closed)) {
                    return;
                }
            }
        }
    }
}

/// One pass of the idle sweep. Blocking: run it under `spawn_blocking`.
fn auto_settle_tick(app: &AppHandle, host: &Arc<AgentHost>) {
    let Some(days) = app
        .try_state::<crate::state::AtlasConfigHandle>()
        .map(|config| config.lock().effective().auto_settle_after_days)
    else {
        return;
    };
    if days == 0 {
        return;
    }
    // Each candidate is judged by its own project's transcripts, read now:
    // the session watcher only covers the project the sidebar has open.
    let keep_pull_requests = crate::state::atlas_config::read(app).auto_settle_keep_pull_requests;
    match host.auto_settle_idle_keeping(
        chrono::Duration::days(i64::from(days)),
        &super::session_watcher::activity_in,
        keep_pull_requests,
    ) {
        Ok(0) => {}
        Ok(settled) => {
            tracing::debug!(settled, days, "auto-settled idle sessions");
            if settled > AUTO_SETTLE_NOTICE_OVER {
                notice_auto_settled_once(app, settled);
            }
        }
        Err(e) => tracing::warn!(error = %e, "auto-settle sweep failed"),
    }
}

/// Tell the user about a big sweep, unless they have been told before. The
/// marker is written first: a notice that fails to send is not retried, and
/// one that is shown twice would be worse than one that is never shown.
fn notice_auto_settled_once(app: &AppHandle, count: usize) {
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let marker = dir.join(AUTO_SETTLE_NOTICE_MARKER);
    if marker.exists() {
        return;
    }
    let _ = std::fs::create_dir_all(&dir);
    if let Err(e) = std::fs::write(&marker, b"") {
        tracing::warn!(error = %e, "could not record the auto-settle notice");
        return;
    }
    let _ = app.emit(SESSIONS_AUTO_SETTLED_EVENT, AutoSettledNotice { count });
}

/// Emitted whenever Atlas's session history changes. Carries no payload: a
/// listener re-reads the store, which is the correct response to any change.
pub const THREADS_CHANGED_EVENT: &str = "atlas:threads-changed";

/// The longest a store change waits to be announced, and so the most often
/// `atlas:threads-changed` goes out for store changes.
const THREADS_CHANGED_COALESCE: std::time::Duration = std::time::Duration::from_millis(250);

/// Call `emit` once per burst of `changes`: the first change opens a
/// `window`, every change arriving before it closes is folded in, and `emit`
/// runs once at its end (trailing edge). So a burst is announced at most
/// `window` late, and never more than once per `window`. A lagged receiver
/// is several changes collapsed into one — what a listener that re-reads
/// the store wants anyway. Returns when the sender is gone.
pub(crate) async fn coalesce_changes<T: Clone>(
    mut changes: tokio::sync::broadcast::Receiver<T>,
    window: std::time::Duration,
    mut emit: impl FnMut(),
) {
    use tokio::sync::broadcast::error::RecvError;
    loop {
        match changes.recv().await {
            Ok(_) | Err(RecvError::Lagged(_)) => {}
            Err(RecvError::Closed) => return,
        }
        tokio::time::sleep(window).await;
        let closed = loop {
            match changes.try_recv() {
                Ok(_) | Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => break false,
                Err(tokio::sync::broadcast::error::TryRecvError::Closed) => break true,
            }
        };
        emit();
        if closed {
            return;
        }
    }
}

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
    /// Released here rather than from deltas: a session can end without a
    /// terminal status (sign-out, killing an agent, quitting).
    keep_awake: Option<Arc<crate::keep_awake::KeepAwakeManager>>,
    /// Same reason: a session that ends mid-turn is no longer in flight.
    sleep_watch: Option<Arc<crate::sleep_watch::SleepWatch>>,
}

enum LifecycleWrite {
    Started {
        session_id: String,
        agent: String,
        cwd: String,
    },
    Ended {
        session_id: String,
    },
}

impl SharingGatedLifecycle {
    fn new(
        app: AppHandle,
        server: Arc<super::memory_server::MemoryServerHost>,
        token_files: Arc<super::memory_bridge::TokenFiles>,
    ) -> Self {
        let keep_awake = app
            .try_state::<Arc<crate::keep_awake::KeepAwakeManager>>()
            .map(|state| state.inner().clone());
        let sleep_watch = app
            .try_state::<Arc<crate::sleep_watch::SleepWatch>>()
            .map(|state| state.inner().clone());
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
                            // Its bridge's token file, dead with its token.
                            token_files.session_ended(&session_id);
                            // The end-of-session extraction, queued behind the
                            // session's last turn-finished pass.
                            if let Some(ended) = memory.session_ended(&session_id) {
                                // What it wrote in turns it took back drops to
                                // candidate. The session ran in `cwd`, so the
                                // default reader finds its recorder store.
                                if let Some(windows) = super::memory_capture::rewound_windows_for(
                                    &super::memory_capture::CaptureReader::default(),
                                    &ended.cwd,
                                    &session_id,
                                    memory.now(),
                                ) {
                                    if let Err(e) = memory.demote_rewound(&ended.cwd, &session_id, &windows) {
                                        tracing::warn!(target: "atlas::shared_memory", "rewound check failed: {e}");
                                    }
                                }
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
        Self {
            writes: tx,
            server,
            keep_awake,
            sleep_watch,
        }
    }

    fn queue(&self, write: LifecycleWrite) {
        let _ = self.writes.send(write);
    }
}

impl super::agent_host::SessionLifecycle for SharingGatedLifecycle {
    fn session_started(&self, session_id: &str, agent: &str, cwd: &str) {
        super::agent_host::SessionLifecycle::session_started(
            &**self.server.tokens(),
            session_id,
            agent,
            cwd,
        );
        self.queue(LifecycleWrite::Started {
            session_id: session_id.to_string(),
            agent: agent.to_string(),
            cwd: cwd.to_string(),
        });
    }

    fn session_ended(&self, session_id: &str) {
        super::agent_host::SessionLifecycle::session_ended(&**self.server.tokens(), session_id);
        if let Some(keep_awake) = &self.keep_awake {
            keep_awake.session_ended(session_id);
        }
        if let Some(sleep_watch) = &self.sleep_watch {
            sleep_watch.session_ended(session_id);
        }
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
    // Managed so the session lifecycle can forget a session that ends
    // without a terminal status.
    let sleep_watch = Arc::new(crate::sleep_watch::SleepWatch::new());
    app.manage(sleep_watch.clone());
    // Before the sink: its constructor reads the taps off the app.
    app.manage(Arc::new(DeltaTaps::default()));
    let sink: Arc<dyn DeltaSink> = Arc::new(TauriDeltaSink::new(app.clone(), sleep_watch));
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
    store.set_secret_source(Arc::new(super::agent_secrets::Keychain));

    // Inside the Tauri runtime's context: building the manager starts the task
    // that watches the installed map, and `tokio::spawn` panics with no reactor
    // entered. `setup` runs on the main thread, outside it.
    let host = {
        let handle = tauri::async_runtime::handle();
        let _guard = handle.inner().enter();
        AgentHost::new(sink, config_dir, store.clone(), registry.clone())
    };
    app.manage(host.clone());
    host.set_prompt_hooks(Arc::new(AppPromptHooks { app: app.clone() }));
    app.manage(super::session_watcher::SessionWatcher::new(
        host.clone(),
        app.clone(),
    ));
    super::session_pull_requests::sweep_leftover_checkouts_later(host.clone(), data_dir.clone());
    // Pull request watches wake their sessions' agents, window hidden or not.
    super::pull_request_watch::start(app.clone(), host.clone());
    // Turns the last run left running carry on, through the wakes just wired.
    super::restart_continuation::start(app, host.clone());

    // Shared memory: every write is announced to the webview (the Shared tab
    // re-pulls on it), session start/end are recorded in the scope's sessions
    // table and mint/revoke the session's memory-server token, and the memory
    // tool server starts on the runtime (never blocking setup).
    {
        let memory = app.state::<SharedMemoryStore>();
        let emitter = app.clone();
        memory.on_change(Arc::new(
            move |change: &super::shared_memory::MemoryChanged| {
                let _ = emitter.emit(super::shared_memory::MEMORY_CHANGED_EVENT, change);
            },
        ));
        super::shared_memory::install_embedder(Arc::new(
            super::memory_indexer::ModelEmbedder::new(app.clone()),
        ));
        // The extractor: durable entries distilled from sessions, through the
        // gateway or the user's BYOK provider.
        app.manage(Arc::new(super::memory_extract::Extractor::new(
            memory.inner().clone(),
            Arc::new(super::memory_extract::AppExtractionModel::new(app.clone())),
        )));
        let server = Arc::new(super::memory_server::MemoryServerHost::new());
        app.manage(server.clone());
        // An ACP agent's bridge reads its token from a private file here:
        // never from its entry, which may land on a command line (ADR-0020).
        // A bound session's file goes when the session ends; ended launches'
        // directories are swept once, off the runtime.
        let token_files = Arc::new(super::memory_bridge::TokenFiles::new(
            data_dir.join("mcp-bridge"),
        ));
        {
            let token_files = token_files.clone();
            tauri::async_runtime::spawn_blocking(move || token_files.sweep_stale_launches());
        }
        host.set_session_lifecycle(Arc::new(SharingGatedLifecycle::new(
            app.clone(),
            server.clone(),
            token_files.clone(),
        )));
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
                emit_app
                    .emit(super::ui_server::action_event(request), request)
                    .map_err(|e| e.to_string())
            },
        )));
        app.manage(ui_bridge.clone());
        // The user's "Let Atlas Agent navigate the app" setting, read on every
        // offer and every call so switching it off stops the agent at once —
        // as the session's project sets it, since a project can override it.
        let nav_app = app.clone();
        let navigation: super::ui_server::NavigationGate = Arc::new(move |cwd: &str| {
            super::project_settings::effective_settings_for(&nav_app, std::path::Path::new(cwd))
                .is_some_and(|settings| settings.agent_ui_navigation)
        });
        let ui_router = super::ui_server::router(super::ui_server::UiTools::new(
            ui_bridge.clone(),
            navigation.clone(),
        ));
        // The organisation tool server (ADR-0014): calls act in the
        // organisation the session's Project is bound to, through the clients
        // the app already holds. Its setting, "Let Atlas Agent act in your
        // organisation", is read on every offer and every call, like the
        // navigation one.
        let org_app = app.clone();
        let org_access: super::org_server::OrgAccessGate = Arc::new(move |cwd: &str| {
            super::project_settings::effective_settings_for(&org_app, std::path::Path::new(cwd))
                .is_some_and(|settings| settings.agent_org_access)
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
        .with_audit(Arc::new(
            move |record: &super::org_server::OrgActionRecord| {
                let _ = audit_app.emit(super::org_server::ORG_ACTION_EVENT, record);
            },
        ))
        // Drawing on a Space page crosses to the window: the page's codec
        // lives in the frontend.
        .with_window(ui_bridge);
        let org_router = super::org_server::router(org_tools.clone());
        // The code tool server (ADR-0015): grep and find_files over the
        // session's directory, for every agent that speaks HTTP MCP. Its
        // setting is read on every offer and every call, like the two
        // above; the shared-memory toggle does not gate it.
        let code_app = app.clone();
        let code_tools: super::code_server::CodeToolsGate = Arc::new(move |cwd: &str| {
            super::project_settings::effective_settings_for(&code_app, std::path::Path::new(cwd))
                .is_some_and(|settings| settings.agent_code_tools)
        });
        // The code index (Phase 2) serves the symbol tools and names grep
        // hits by their enclosing symbol; it is managed in `setup` before
        // this runs.
        // `request_project_access` rides the same server: every agent that
        // gets the code tools can ask for a folder, and the host puts the
        // request on the session's approval card.
        let code_router = super::code_server::router(
            super::code_server::CodeTools::new(code_tools.clone())
                .with_access(Arc::new(super::session_projects::HostAccessBroker(
                    Arc::downgrade(&host),
                )))
                // The pull request tools too: the agent ties the pull requests
                // it opens to its session, and watches them.
                .with_pull_requests(Arc::new(
                    super::session_pull_requests::HostPullRequestBroker {
                        host: Arc::downgrade(&host),
                        wakes_on: {
                            let app = app.clone();
                            Arc::new(move || {
                                crate::state::atlas_config::read(&app).pull_request_watch_wakes
                            })
                        },
                    },
                )),
        );
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
                )
                .with_code(super::code_server::CodeOffer::new(code_tools))
                .with_token_files(token_files),
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
        // Cited code is checked against the file on disk.
        let check: super::memory_server::CitationCheck = Arc::new(
            move |root: &std::path::Path, cites: &[atlas_memory::citation::Citation]| {
                static CACHE: std::sync::OnceLock<atlas_memory::citation::ValidationCache> =
                    std::sync::OnceLock::new();
                let cache = CACHE.get_or_init(Default::default);
                let resolver = atlas_memory::citation::FileResolver::new(root);
                cites.iter().map(|c| cache.check(c, &resolver)).collect()
            },
        );
        server.start(
            memory.inner().clone(),
            gate,
            super::memory_server::Sources {
                index: Some(index),
                bootstrap: Some(bootstrap),
                evict: Some(evict),
                // Read-only: memory never writes the recorder (memory_capture.rs).
                capture: super::memory_capture::CaptureReader {
                    transcripts_dir: app
                        .try_state::<Arc<super::agent_transcript::TranscriptState>>()
                        .map(|t| t.config_dir().to_path_buf()),
                },
                check: Some(check),
            },
            vec![ui_router, org_router, code_router],
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
                    Ok(AgentManagerEvent::ConnectionExited { agent }) => {
                        host.agent_exited(&agent);
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

    // The sidebar refreshes from store changes; one task forwards them to the
    // webview. Since the ADR-0001 amendment ("discovery is not replay") one of
    // the store's writers watches files: the session watcher
    // (`session_watcher.rs`) lists the open project's Claude transcript
    // directory and reads file times — never contents — bumping or adding rows
    // through the store, so its changes arrive here like any other. Liveness
    // ("running in a terminal") is not stored; the watcher emits the same event
    // itself when the live set changes.
    //
    // The store notifies many times a turn, and every listener re-reads the
    // whole sidebar, so the forwarder coalesces: the first change opens a
    // window of `THREADS_CHANGED_COALESCE`, everything arriving inside it is
    // folded in, and one event goes out at its end (`coalesce_changes`).
    if let Some(history) = host.history() {
        let app = app.clone();
        let changes = history.store().subscribe();
        tauri::async_runtime::spawn(coalesce_changes(
            changes,
            THREADS_CHANGED_COALESCE,
            move || {
                let _ = app.emit(THREADS_CHANGED_EVENT, ());
            },
        ));
    }

    // Snoozes wake on one timer, set for the soonest of them and re-read on
    // every store change (`run_snooze_waker`). A wake is a store change, so
    // the forwarder above announces it like any other.
    if let Some(history) = host.history() {
        tauri::async_runtime::spawn(run_snooze_waker(history.store().clone()));
    }

    // Auto-settle: once a minute, sessions idle for `autoSettleAfterDays`
    // move to the sidebar's Settled shelf (0 turns it off). The host skips the
    // busy and the live-elsewhere ones, the store the pinned, the snoozed and
    // the ones the user un-settled since their last activity; a settle announces
    // itself through the forwarder above. The setting is read every pass, so
    // a change takes effect within the minute. Each tick's work reads the
    // store, the watcher and possibly a file, so it runs off the async
    // runtime the IPC channel shares.
    if host.history().is_some() {
        let app = app.clone();
        let host = host.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(AUTO_SETTLE_EVERY).await;
                let (app, host) = (app.clone(), host.clone());
                let tick = tokio::task::spawn_blocking(move || auto_settle_tick(&app, &host));
                if let Err(e) = tick.await {
                    tracing::warn!(error = %e, "auto-settle tick panicked");
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
    pub(crate) fn new(message: impl Into<String>, kind: ErrorClass) -> Self {
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
pub fn agents_kill_plugin(
    plugin_id: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<(), String> {
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
    host.answer_elicitation(request_id, &action, content, Origin::Local)
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
    host.set_config_option(&key, config_id, value, Origin::Local)
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
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
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
            timestamp_approximate: false,
            worked_ms: None,
            stop_reason: None,
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
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
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
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
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
    watcher: State<'_, Arc<super::session_watcher::SessionWatcher>>,
) -> Result<(), CmdError> {
    // The watcher's file times decide "live elsewhere", which refuses the
    // delete — the same input the sidebar's dot reads.
    let modified = watcher.last_modified();
    host.delete_thread(parse_thread_id(&thread_id)?, &modified)
        .await
        .map_err(CmdError::from)
}

/// Every project the user has threads in — the sidebar's only source (#21).
///
/// Async, with the build under `spawn_blocking`: the sidebar asks for every
/// row (unscoped) on each `atlas:threads-changed`, and building and
/// serialising a thousand-odd rows must not run on the main thread or hold
/// an async worker the IPC channel shares.
#[tauri::command(async)]
pub async fn threads_projects(
    cwd: Option<String>,
    host: State<'_, Arc<AgentHost>>,
    watcher: State<'_, Arc<super::session_watcher::SessionWatcher>>,
) -> Result<Vec<super::agent_host::ThreadProjectWire>, CmdError> {
    let host = host.inner().clone();
    let modified = watcher.last_modified();
    tauri::async_runtime::spawn_blocking(move || host.thread_projects(cwd.as_deref(), &modified))
        .await
        .map_err(|e| CmdError::new(e.to_string(), ErrorClass::Fatal))?
        .map_err(CmdError::from)
}

/// Every thread, newest-started first — the history view. Off the main
/// thread for the same reason as [`threads_projects`].
#[tauri::command(async)]
pub async fn threads_history(
    host: State<'_, Arc<AgentHost>>,
    watcher: State<'_, Arc<super::session_watcher::SessionWatcher>>,
) -> Result<Vec<super::agent_host::ThreadRow>, CmdError> {
    let host = host.inner().clone();
    let modified = watcher.last_modified();
    tauri::async_runtime::spawn_blocking(move || host.thread_history(&modified))
        .await
        .map_err(|e| CmdError::new(e.to_string(), ErrorClass::Fatal))?
        .map_err(CmdError::from)
}

/// Move a session to the sidebar's Settled shelf. Refused while a turn is
/// running there, in Atlas or in another process, or just after a send.
/// Answers whether it moved: `false` for one already settled or gone.
///
/// Liveness elsewhere is read from the row's own project's transcripts, which
/// is file I/O, so the check runs off the async workers.
#[tauri::command]
pub async fn threads_settle(
    thread_id: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<bool, CmdError> {
    let thread_id = parse_thread_id(&thread_id)?;
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.settle_thread(thread_id, &super::session_watcher::activity_in)
    })
    .await
    .map_err(|e| CmdError::new(e.to_string(), ErrorClass::Fatal))?
    .map_err(CmdError::from)
}

/// Take a session back off the Settled shelf. Answers whether it was on it.
#[tauri::command]
pub fn threads_unsettle(
    thread_id: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<bool, CmdError> {
    host.unsettle_thread(parse_thread_id(&thread_id)?)
        .map_err(CmdError::from)
}

// The lifecycle commands below touch only the store's in-memory index and its
// write queue (the disk write happens on the store's own writer thread), so
// none blocks. `async` keeps them off the main thread all the same: a pin or
// a debounced "viewed" must never wait behind a frame.

/// Pin a session. `orderKey` places it among the pinned (a fractional key the
/// frontend mints); omitted, it sorts after every keyed pin. Brings a settled
/// or snoozed session back. Answers whether anything changed.
#[tauri::command(async)]
pub fn threads_pin(
    thread_id: String,
    order_key: Option<String>,
    host: State<'_, Arc<AgentHost>>,
) -> Result<bool, CmdError> {
    host.pin_thread(parse_thread_id(&thread_id)?, order_key)
        .map_err(CmdError::from)
}

/// Unpin a session. Answers whether it was pinned.
#[tauri::command(async)]
pub fn threads_unpin(thread_id: String, host: State<'_, Arc<AgentHost>>) -> Result<bool, CmdError> {
    host.unpin_thread(parse_thread_id(&thread_id)?)
        .map_err(CmdError::from)
}

/// Move a pinned session to `orderKey`. `false` for one that is not pinned.
#[tauri::command(async)]
pub fn threads_reorder_pin(
    thread_id: String,
    order_key: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<bool, CmdError> {
    host.reorder_pinned_thread(parse_thread_id(&thread_id)?, order_key)
        .map_err(CmdError::from)
}

/// Snooze a session until `until` (RFC 3339). Rejected for a time not in the
/// future and for a session with a pending permission or question.
#[tauri::command(async)]
pub fn threads_snooze(
    thread_id: String,
    until: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<bool, CmdError> {
    let until = chrono::DateTime::parse_from_rfc3339(&until)
        .map_err(|_| CmdError::new(format!("not a time: {until}"), ErrorClass::Fatal))?
        .with_timezone(&chrono::Utc);
    host.snooze_thread(parse_thread_id(&thread_id)?, until)
        .map_err(CmdError::from)
}

/// Rename a session. An empty title clears the rename.
#[tauri::command(async)]
pub fn threads_rename(
    thread_id: String,
    title: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<(), CmdError> {
    host.rename_thread(parse_thread_id(&thread_id)?, &title)
        .map_err(CmdError::from)
}

/// Wake a snoozed session now. Answers whether it was snoozed.
#[tauri::command(async)]
pub fn threads_wake(thread_id: String, host: State<'_, Arc<AgentHost>>) -> Result<bool, CmdError> {
    host.wake_thread(parse_thread_id(&thread_id)?)
        .map_err(CmdError::from)
}

/// Undo a snooze the user just set: like a wake, but it leaves no "woke"
/// mark. Answers whether it was snoozed.
#[tauri::command(async)]
pub fn threads_unsnooze(
    thread_id: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<bool, CmdError> {
    host.unsnooze_thread(parse_thread_id(&thread_id)?)
        .map_err(CmdError::from)
}

/// The user opened or focused the chat tab running `sessionId`. Keyed by the
/// live session, not the row, because that is what a tab knows. The frontend
/// debounces it. Answers whether a row was marked.
#[tauri::command(async)]
pub fn threads_mark_viewed(
    session_id: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<bool, CmdError> {
    host.mark_session_viewed(&session_id)
        .map_err(CmdError::from)
}

/// Make a session read as unread again. Rejected for one with no finished
/// turn. Answers whether anything changed.
#[tauri::command(async)]
pub fn threads_mark_unread(
    thread_id: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<bool, CmdError> {
    host.mark_thread_unread(parse_thread_id(&thread_id)?)
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

/// Sync one project's recent agent sessions into the sidebar (ADR-0001
/// amendment, ATL-422). Debounced in the host; answers how many rows landed.
#[tauri::command]
pub async fn threads_sync_project(
    cwd: String,
    host: State<'_, Arc<AgentHost>>,
    watcher: State<'_, Arc<super::session_watcher::SessionWatcher>>,
) -> Result<usize, CmdError> {
    // One spelling of the project for everything below: the watcher's slug
    // directory (Claude Code names it after its physical `getcwd`), the
    // `session/list` cwd filter, and the sync debounce key. The UI's path is
    // not canonical — a symlink, macOS's `/private` prefix, a trailing slash —
    // and each of those uses would silently miss on a different spelling.
    // `canonicalize` touches the disk, so it runs off the async workers.
    let cwd = tauri::async_runtime::spawn_blocking(move || canonical_project_dir(&cwd))
        .await
        .map_err(|e| CmdError::new(e.to_string(), ErrorClass::Fatal))?;
    // Arm first: the watcher keeps the sidebar current between these calls.
    if !cwd.is_empty() {
        watcher.arm(&cwd);
    }
    host.sync_project(&cwd, false).await.map_err(CmdError::from)
}

/// The physical path of a project directory as the UI named it: resolved
/// through symlinks when it exists, else the raw path with surrounding
/// whitespace and any trailing slash removed (the root stays `/`). Empty in,
/// empty out.
fn canonical_project_dir(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // `dunce`, not `std::fs`: on Windows std returns the verbatim `\\?\C:\…`
    // form, which slugs to `----C--…` — a `~/.claude/projects` folder Claude
    // Code never writes (it slugs its plain `getcwd`, `C--…`). The watcher then
    // waited forever for that folder, so live-elsewhere detection and the
    // `session/list` filter both silently never matched on Windows.
    if let Ok(canonical) = dunce::canonicalize(trimmed) {
        return canonical.to_string_lossy().into_owned();
    }
    let without_slash = trimmed.trim_end_matches(['/', '\\']);
    if without_slash.is_empty() {
        "/".to_owned()
    } else {
        without_slash.to_owned()
    }
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
/// A one-liner onto the steering entry (`AgentHost::submit`), which carries
/// everything a prompt does on its way to the agent — capture, transcript,
/// history, the shared-memory registration (see [`AppPromptHooks`]) — so a
/// remote driver's prompt does exactly the same. `Now`: the window's composer
/// already queues while a turn runs, so a direct send is one it chose to make.
///
/// Shared memory is never prepended here (ADR-0010): the agent pulls it
/// through the `atlas_memory` tools its session was offered.
///
/// `client_message_id` is the id of the window's optimistic user row; the
/// prompt's `user_message` delta echoes it so the row is adopted, not drawn
/// twice.
#[tauri::command]
pub async fn agents_send(
    key: SessionKey,
    text: String,
    attachments: Option<Vec<ImageAttachment>>,
    // `@`-mentions that point at files (P2.1). Sent as `ResourceLink` blocks
    // rather than flattened into the prose — the ACP-native way to hand an
    // agent a file, and every agent is required to accept it.
    resource_links: Option<Vec<ResourceLinkSpec>>,
    // Large pastes the composer kept as chips. Each goes in full: an embedded
    // resource when the agent takes embedded context, a text block otherwise.
    pasted_texts: Option<Vec<PastedText>>,
    client_message_id: Option<String>,
    host: State<'_, Arc<AgentHost>>,
) -> Result<(), String> {
    // `agent_turn_started` is NOT emitted here: `AnalyticsMiddleware` emits it
    // off `Status{Running}`, the actual turn boundary, which carries the
    // `turn_seq` that joins a start to its completion.
    //
    // Image attachments ride WITH the turn (P0.2) rather than through a staging
    // side-channel drained by the next send, so nothing can strand images for
    // some later turn to pick up.
    let prompt = Prompt {
        text,
        display: None,
        images: attachments.unwrap_or_default(),
        resource_links: resource_links.unwrap_or_default(),
        pastes: pasted_texts.unwrap_or_default(),
        client_message_id,
        from_atlas: false,
    };
    host.inner()
        .submit(&key, prompt, Origin::Local, SubmitPolicy::Now)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Who a prompt is from. The user's own words count as the user's
/// interaction with the session; a prompt Atlas sends on its own (a pull
/// request watch waking the agent, a turn continued after a restart) is
/// recorded everywhere else the same way, but is not the user, so it neither
/// marks the session interacted with nor un-settles it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PromptOrigin {
    User,
    Atlas,
}

/// A prompt on its way to the agent: the text, and what rides with it.
#[derive(Debug, Default)]
pub(crate) struct OutgoingPrompt {
    pub text: String,
    pub images: Vec<ImageAttachment>,
    pub links: Vec<ResourceLinkSpec>,
    pub pastes: Vec<PastedText>,
}

impl OutgoingPrompt {
    /// Just text, as a wake sends.
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            ..Self::default()
        }
    }
}

/// Where a prompt is written down before it goes to the agent. A trait so
/// the order and the conditions ([`record_prompt`]) are testable without a
/// Tauri app; [`AppBooks`] is the real one.
pub(crate) trait PromptBooks {
    /// Session capture: the prompt, and the session bound to its scope.
    fn capture(
        &self,
        session_id: &str,
        cwd: &str,
        plugin_id: &str,
        model: Option<&str>,
        text: &str,
    );
    /// The user interacted with the session (`interacted_at`).
    fn interaction(&self, session_id: &str);
    /// Atlas's own transcript of the session.
    fn transcript(&self, session_id: &str, cwd: &str, plugin_id: &str, text: &str);
    /// Whether memory sharing is on for `cwd`.
    fn sharing_enabled(&self, cwd: &str) -> bool;
    /// Register the session so its deltas are captured into the scope's record.
    fn register_memory(&self, session_id: &str, cwd: &str, plugin_id: &str);
}

/// What a prompt is recorded against: the session's cheap metadata.
pub(crate) struct PromptMeta<'a> {
    pub cwd: &'a str,
    pub plugin_id: &'a str,
    pub model: Option<&'a str>,
}

/// Write `text` down in every book, in the order the send path always has.
pub(crate) fn record_prompt(
    books: &dyn PromptBooks,
    session_id: &str,
    meta: &PromptMeta<'_>,
    text: &str,
    origin: PromptOrigin,
) {
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
    books.capture(session_id, meta.cwd, meta.plugin_id, meta.model, text);

    // The user just sent something. `interacted_at` is the only field the
    // thread's own events cannot supply — a queued message never reaches the
    // agent. A wake is not the user.
    if origin == PromptOrigin::User {
        books.interaction(session_id);
    }

    // Atlas's own transcript, for every agent. Recorded here for the same
    // reason capture is: the user's prompt is never emitted as a delta, so a
    // delta-only recorder produces transcripts that start mid-answer and have
    // no title.
    if !meta.cwd.is_empty() {
        books.transcript(session_id, meta.cwd, meta.plugin_id, text);
    }

    // Register this session so the capture path (`TauriDeltaSink::emit`) can
    // route its deltas into the scope's record. The text itself goes to the
    // agent untouched: a slash command stays at byte 0 (Claude Code resolves
    // one only there), and nothing Atlas wrote can be echoed back as the
    // user's words.
    if !meta.cwd.is_empty() && books.sharing_enabled(meta.cwd) {
        books.register_memory(session_id, meta.cwd, meta.plugin_id);
    }
}

/// The app's books.
struct AppBooks<'a> {
    app: &'a AppHandle,
    host: &'a AgentHost,
}

impl PromptBooks for AppBooks<'_> {
    fn capture(
        &self,
        session_id: &str,
        cwd: &str,
        plugin_id: &str,
        model: Option<&str>,
        text: &str,
    ) {
        self.app
            .state::<super::capture::CaptureState>()
            .note_prompt(session_id, cwd, plugin_id, model, text);
    }

    fn interaction(&self, session_id: &str) {
        if let Some(history) = self.host.history() {
            history.note_interaction(&acp::SessionId::new(session_id), chrono::Utc::now());
        }
    }

    fn transcript(&self, session_id: &str, cwd: &str, plugin_id: &str, text: &str) {
        self.app
            .state::<Arc<super::agent_transcript::TranscriptState>>()
            .note_prompt(
                session_id,
                cwd,
                plugin_id,
                text,
                chrono::Utc::now().to_rfc3339(),
            );
    }

    fn sharing_enabled(&self, cwd: &str) -> bool {
        self.app.state::<MemorySharingState>().is_enabled(cwd)
    }

    fn register_memory(&self, session_id: &str, cwd: &str, plugin_id: &str) {
        self.app
            .state::<SharedMemoryStore>()
            .register_session(session_id, cwd, plugin_id);
    }
}

/// Send `outgoing` to the session `key` as a turn, the way Atlas does on its
/// own (a pull request watch's wake, `AgentHost::wake`; a turn continued
/// after a restart). One door with [`agents_send`]: the steering entry
/// (`agent_host/steering.rs`) records it in every book through
/// [`AppPromptHooks`] and starts the turn.
pub(crate) fn send_prompt(
    _app: &AppHandle,
    host: &Arc<AgentHost>,
    key: &SessionKey,
    outgoing: OutgoingPrompt,
    origin: PromptOrigin,
) -> Result<(), String> {
    let OutgoingPrompt {
        text,
        images,
        links,
        pastes,
    } = outgoing;
    let prompt = Prompt {
        text,
        images,
        resource_links: links,
        pastes,
        from_atlas: origin == PromptOrigin::Atlas,
        ..Prompt::default()
    };
    host.submit(key, prompt, Origin::Local, SubmitPolicy::Now)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// The send path's side effects, for every prompt the host dispatches.
///
/// Installed on the host at startup so the steering entry owns them: a prompt
/// that reaches the host by any door — a typed one, a drained queue item, a
/// remote driver's, a wake — is written down the same way ([`record_prompt`]).
pub(crate) struct AppPromptHooks {
    pub(crate) app: AppHandle,
}

impl PromptHooks for AppPromptHooks {
    fn prompt_sent(&self, sent: &PromptSent<'_>) {
        // Who sent it is not recorded yet: the transcript audit line for a
        // remote driver (design review slice 7) lands with the RC layer.
        tracing::debug!(target: "atlas::steering", session = sent.session_id, origin = ?sent.origin, "prompt sent");
        let host = self.app.state::<Arc<AgentHost>>();
        record_prompt(
            &AppBooks {
                app: &self.app,
                host: &host,
            },
            sent.session_id,
            &PromptMeta {
                cwd: sent.cwd,
                plugin_id: sent.plugin_id,
                model: sent.model,
            },
            sent.text,
            if sent.from_atlas {
                PromptOrigin::Atlas
            } else {
                PromptOrigin::User
            },
        );
    }
}

/// Hard cap on building the briefing's first-look extras (pack + handoff +
/// summarise) so a slow disk or provider can never stall an agent's briefing.
const BOOTSTRAP_BUDGET_SECS: u64 = 8;

/// The first-look extras `memory_briefing` serves beyond the record: the
/// curated pack from the project's foreign memory files, then the
/// recent-session handoff. Everything runs inside a single
/// [`BOOTSTRAP_BUDGET_SECS`] timeout; on elapse the briefing goes out without
/// them rather than late.
async fn build_bootstrap(
    app: &AppHandle,
    cwd: &str,
    session_id: &str,
) -> super::memory_server::Bootstrap {
    let pref = app.state::<MemorySharingState>().summarizer_pref(cwd);
    let cwd = cwd.to_string();
    let session_id = session_id.to_string();

    let built = tokio::time::timeout(Duration::from_secs(BOOTSTRAP_BUDGET_SECS), async {
        // Curated pack (collect_corpus is async + does its own spawn_blocking).
        let project_memory =
            memory_pack::build_memory_pack(&cwd, memory_pack::PACK_MAX_CHARS).await;

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

        let recent_session =
            memory_pack::handoff_block(handoff_raw, &pref, |raw, provider, model| async move {
                memory_summarize::summarize(app, &raw, &provider, &model).await
            })
            .await;

        super::memory_server::Bootstrap {
            project_memory,
            recent_session,
        }
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

/// Cancel the session's turn. `stop` is the user's Stop button: it also ends
/// the session's pull request watches, since a Stop means "stop" and a wake
/// landing right after it would start the agent straight back up. Every
/// other cancel (a tab closing, a project closing, a guide run cancelled)
/// leaves the watches on; both drop a wake held for the turn.
#[tauri::command]
pub fn agents_cancel(
    key: SessionKey,
    stop: Option<bool>,
    host: State<'_, Arc<AgentHost>>,
) -> Result<(), String> {
    if stop.unwrap_or(false) {
        host.stop(&key, Origin::Local)
    } else {
        host.interrupt(&key)
    }
    .map_err(|e| e.to_string())
}

// ── The turn queue (the turn controller in `agent_host/steering.rs`) ────────
//
// The window's queued-message strip mirrors the session's queue through
// `queue_changed` deltas; these verbs change it. Each is a one-liner onto the
// host, which a remote driver reaches the same way.

/// Park a prompt behind the running turn. `text` is what the strip shows;
/// `prompt` is what the agent will be sent (the window may append hidden
/// directives), defaulting to `text`. Returns the queued item's id.
#[tauri::command]
pub fn agents_queue_add(
    key: SessionKey,
    text: String,
    prompt: Option<String>,
    host: State<'_, Arc<AgentHost>>,
) -> Result<String, String> {
    let item = Prompt {
        display: Some(text.clone()),
        ..Prompt::text(prompt.unwrap_or(text))
    };
    host.enqueue(&key, item, Origin::Local)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agents_queue_remove(
    key: SessionKey,
    item_id: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<bool, String> {
    host.remove_queued(&key, &item_id, Origin::Local)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agents_queue_clear(key: SessionKey, host: State<'_, Arc<AgentHost>>) -> Result<(), String> {
    host.clear_queue(&key, Origin::Local)
        .map_err(|e| e.to_string())
}

/// Close or open the queue's drain gate — the window's send gates (a resume
/// loading, a session live elsewhere, no AI grant, a pending agent switch).
#[tauri::command]
pub fn agents_queue_pause(
    key: SessionKey,
    paused: bool,
    host: State<'_, Arc<AgentHost>>,
) -> Result<(), String> {
    host.inner()
        .set_queue_paused(&key, paused)
        .map_err(|e| e.to_string())
}

/// Start the head of the queue if the session is idle and the gate is open.
#[tauri::command]
pub fn agents_queue_drain(
    key: SessionKey,
    host: State<'_, Arc<AgentHost>>,
) -> Result<Option<u64>, String> {
    host.inner().drain_queue(&key).map_err(|e| e.to_string())
}

/// Run one queued prompt next, interrupting the running turn.
#[tauri::command]
pub fn agents_queue_send_now(
    key: SessionKey,
    item_id: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<(), String> {
    host.inner()
        .send_now(&key, &item_id, Origin::Local)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Take or release the developer's hold on a session (Universal RC
/// groundwork): a held session keeps running when its tab closes. Debug
/// builds only — the real holder is the RC layer, which calls
/// `AgentHost::hold_session` directly.
#[tauri::command]
pub async fn agents_set_hold(
    session_id: String,
    held: bool,
    host: State<'_, Arc<AgentHost>>,
) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("session holds are a developer tool in this build".into());
    }
    const DEV_HOLDER: &str = "dev";
    if held {
        host.hold_session(&session_id, DEV_HOLDER)
            .map_err(|e| e.to_string())
    } else {
        host.release_session(&session_id, DEV_HOLDER)
            .await
            .map_err(|e| e.to_string())
    }
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
    app.state::<Arc<AnalyticsState>>()
        .forget_session(&session_id);
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
    host.set_mode(&key, mode_id, Origin::Local)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agents_set_model(
    key: SessionKey,
    model_id: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<(), String> {
    host.set_model(&key, model_id, Origin::Local)
        .await
        .map_err(|e| e.to_string())
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
    host.answer_permission(&session_id, request_id, decision, Origin::Local)
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
// with, and `_meta["terminal-auth"]` naming a whole command.
// `terminal_auth_command_for` reads both.
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
    let methods = host
        .auth_methods(agent_id)
        .await
        .map_err(|e| e.to_string())?;

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
/// through `AgentConnection::terminal_auth_command`. An agent that named none is rejected rather than guessed at.
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
                        status
                            .code()
                            .map(|c| c.to_string())
                            .unwrap_or_else(|| "?".into())
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
        let e: CmdError =
            HostError::classified("Authentication required. Please run `cursor-agent login`.")
                .into();
        let v = wire(e);
        assert_eq!(v["kind"], "auth");
        assert!(v["message"]
            .as_str()
            .unwrap()
            .contains("Authentication required"));
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
        assert_eq!(
            wire(HostError::unknown_session().into())["kind"],
            "process_dead"
        );
        assert_eq!(
            wire(HostError::classified("rate limit exceeded").into())["kind"],
            "transient"
        );
        assert_eq!(
            wire(HostError::classified("weird").into())["kind"],
            "unknown"
        );
    }

    /// An agent that is not installed is FATAL, not auth: no amount of signing
    /// in or retrying changes it — only installing it does.
    #[test]
    fn a_missing_agent_is_fatal_rather_than_auth() {
        let v = wire(
            HostError::new(
                "some-agent is not installed. Add it in Settings → Agents.",
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
/// session delta — that wire is per-session, and an update belongs to a plugin,
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
            let mut pending = self
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
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

#[cfg(test)]
mod snooze_waker_tests {
    use std::path::PathBuf;
    use std::time::Duration as StdDuration;

    use agent_client_protocol::schema::v1 as acp;
    use atlas_thread_metadata::{PathList, ThreadId, ThreadMetadata, ThreadMetadataStore};
    use chrono::{Duration, Utc};

    use super::run_snooze_waker;

    fn saved(store: &ThreadMetadataStore) -> ThreadId {
        let mut thread = ThreadMetadata::new(
            ThreadId::new(),
            "some-agent".into(),
            PathList::new(&[PathBuf::from("/tmp/atlas")]),
        );
        thread.session_id = Some(acp::SessionId::new(thread.thread_id.to_key_string()));
        let id = thread.thread_id;
        store.save_all(vec![thread]);
        id
    }

    async fn until_awake(store: &ThreadMetadataStore, id: ThreadId) -> bool {
        for _ in 0..60 {
            if !store.thread(id).unwrap().is_snoozed() {
                return true;
            }
            tokio::time::sleep(StdDuration::from_millis(50)).await;
        }
        false
    }

    /// One timer serves every snooze: one already due when it starts wakes at
    /// once, one set afterwards is picked up from the change it makes, and
    /// each wakes at its own time — not before.
    #[tokio::test]
    async fn the_timer_wakes_each_snooze_at_its_time() {
        let dir = tempfile::tempdir().unwrap();
        let store = ThreadMetadataStore::open(dir.path().join("threads.db")).unwrap();

        let overdue = saved(&store);
        let mut row = store.thread(overdue).unwrap();
        row.snoozed_until = Some(Utc::now() - Duration::minutes(5));
        row.snoozed_at = Some(Utc::now() - Duration::hours(1));
        store.save_all(vec![row]);

        let waker = tokio::spawn(run_snooze_waker(store.clone()));
        assert!(
            until_awake(&store, overdue).await,
            "a missed wake fires at start"
        );
        assert!(store.thread(overdue).unwrap().is_woke());

        let later = saved(&store);
        let distant = saved(&store);
        store.snooze(later, Utc::now() + Duration::milliseconds(400));
        store.snooze(distant, Utc::now() + Duration::hours(2));
        assert!(
            store.thread(later).unwrap().is_snoozed(),
            "not before its time"
        );
        assert!(
            until_awake(&store, later).await,
            "a new snooze is scheduled"
        );
        assert!(
            store.thread(distant).unwrap().is_snoozed(),
            "and the distant one sleeps on"
        );
        waker.abort();
    }
}

#[cfg(test)]
mod project_dir_tests {
    use super::canonical_project_dir;

    /// The review finding: the UI's raw cwd keyed the watcher's slug directory,
    /// the `session/list` filter and the debounce, so a symlinked checkout (or
    /// macOS's `/tmp` → `/private/tmp`) watched a folder Claude Code never
    /// writes. Claude names the folder after its physical `getcwd`.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_project_resolves_to_its_physical_path() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let physical = std::fs::canonicalize(&real).unwrap();
        let physical = physical.to_string_lossy();

        assert_eq!(canonical_project_dir(&link.to_string_lossy()), physical);
        assert_eq!(
            canonical_project_dir(&format!("{}/", link.to_string_lossy())),
            physical,
            "a trailing slash is the same project"
        );
    }

    /// Claude Code names a project's transcript folder after its plain
    /// `getcwd`. On Windows `std::fs::canonicalize` adds the verbatim `\\?\`
    /// prefix, whose slug (`----C--…`) is a folder that never exists.
    #[test]
    fn an_existing_directory_canonicalises_to_a_plain_path() {
        let tmp = tempfile::tempdir().unwrap();
        let canonical = canonical_project_dir(&tmp.path().to_string_lossy());
        assert!(
            !canonical.starts_with(r"\\?\"),
            "verbatim prefix leaked: {canonical}"
        );
        assert!(
            !atlas_agent_transcript::encode_cwd(&canonical).starts_with("--"),
            "slug must match Claude Code's folder name"
        );
    }

    #[test]
    fn a_missing_directory_falls_back_to_the_trimmed_raw_path() {
        assert_eq!(
            canonical_project_dir(" /no/such/atlas-project/ "),
            "/no/such/atlas-project"
        );
        assert_eq!(canonical_project_dir(""), "");
        assert_eq!(canonical_project_dir("   "), "");
    }
}

#[cfg(test)]
mod coalesce_tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use super::coalesce_changes;

    /// A burst of store changes — many a turn — is one sidebar refresh, sent
    /// once the burst's window closes; a later change is its own refresh; and
    /// the forwarder ends with the store.
    #[tokio::test]
    async fn a_burst_of_changes_is_one_event_on_the_trailing_edge() {
        let (tx, rx) = tokio::sync::broadcast::channel::<()>(16);
        let emitted = Arc::new(AtomicUsize::new(0));
        let count = emitted.clone();
        let window = Duration::from_millis(100);
        let task = tokio::spawn(coalesce_changes(rx, window, move || {
            count.fetch_add(1, Ordering::SeqCst);
        }));

        // More changes than the channel holds: the lag folds in too.
        for _ in 0..50 {
            tx.send(()).unwrap();
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(
            emitted.load(Ordering::SeqCst),
            0,
            "not before the window closes"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert_eq!(emitted.load(Ordering::SeqCst), 1, "one event for the burst");

        tx.send(()).unwrap();
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert_eq!(emitted.load(Ordering::SeqCst), 2);

        drop(tx);
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("the forwarder ends with its store")
            .unwrap();
        assert_eq!(emitted.load(Ordering::SeqCst), 2, "no event for the close");
    }
}

#[cfg(test)]
mod prompt_books_tests {
    use std::cell::RefCell;

    use super::{record_prompt, PromptBooks, PromptMeta, PromptOrigin};

    /// Every book write, in order, with what it was given.
    #[derive(Default)]
    struct Recording {
        sharing: bool,
        writes: RefCell<Vec<String>>,
    }

    impl PromptBooks for Recording {
        fn capture(
            &self,
            session_id: &str,
            cwd: &str,
            plugin_id: &str,
            model: Option<&str>,
            text: &str,
        ) {
            self.writes.borrow_mut().push(format!(
                "capture {session_id} {cwd} {plugin_id} {} {text}",
                model.unwrap_or("-")
            ));
        }
        fn interaction(&self, session_id: &str) {
            self.writes
                .borrow_mut()
                .push(format!("interaction {session_id}"));
        }
        fn transcript(&self, session_id: &str, cwd: &str, plugin_id: &str, text: &str) {
            self.writes
                .borrow_mut()
                .push(format!("transcript {session_id} {cwd} {plugin_id} {text}"));
        }
        fn sharing_enabled(&self, _cwd: &str) -> bool {
            self.sharing
        }
        fn register_memory(&self, session_id: &str, cwd: &str, plugin_id: &str) {
            self.writes
                .borrow_mut()
                .push(format!("memory {session_id} {cwd} {plugin_id}"));
        }
    }

    fn meta(cwd: &str) -> PromptMeta<'_> {
        PromptMeta {
            cwd,
            plugin_id: "claude-code",
            model: Some("opus"),
        }
    }

    /// The user's prompt is written exactly as `agents_send` always wrote it:
    /// capture first, then the interaction, the transcript, and the memory
    /// registration where sharing is on.
    #[test]
    fn a_user_prompt_writes_every_book_in_order() {
        let books = Recording {
            sharing: true,
            ..Recording::default()
        };
        record_prompt(&books, "s1", &meta("/work"), "fix it", PromptOrigin::User);
        assert_eq!(
            books.writes.into_inner(),
            vec![
                "capture s1 /work claude-code opus fix it",
                "interaction s1",
                "transcript s1 /work claude-code fix it",
                "memory s1 /work claude-code",
            ]
        );
    }

    #[test]
    fn without_sharing_no_memory_registration() {
        let books = Recording::default();
        record_prompt(&books, "s1", &meta("/work"), "hi", PromptOrigin::User);
        assert_eq!(
            books.writes.into_inner(),
            vec![
                "capture s1 /work claude-code opus hi",
                "interaction s1",
                "transcript s1 /work claude-code hi",
            ]
        );
    }

    /// A session with no folder is captured and counts as interacted with,
    /// but has no transcript and no memory scope to register in.
    #[test]
    fn without_a_folder_only_capture_and_the_interaction() {
        let books = Recording {
            sharing: true,
            ..Recording::default()
        };
        record_prompt(&books, "s1", &meta(""), "hi", PromptOrigin::User);
        assert_eq!(
            books.writes.into_inner(),
            vec!["capture s1  claude-code opus hi", "interaction s1"]
        );
    }

    /// A watch's wake is written like any prompt, except that it is not the
    /// user interacting with the session.
    #[test]
    fn a_wake_is_recorded_but_is_not_the_user() {
        let books = Recording {
            sharing: true,
            ..Recording::default()
        };
        record_prompt(
            &books,
            "s1",
            &meta("/work"),
            "Update on pull request #7",
            PromptOrigin::Atlas,
        );
        assert_eq!(
            books.writes.into_inner(),
            vec![
                "capture s1 /work claude-code opus Update on pull request #7",
                "transcript s1 /work claude-code Update on pull request #7",
                "memory s1 /work claude-code",
            ]
        );
    }
}

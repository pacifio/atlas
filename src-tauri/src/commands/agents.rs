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
//! - plugin-id semantics, native-vs-ACP by `CERSEI_AGENT_ID` (#4);
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
//! (§D12-3, locked). Spawning is now: look the id up in the installed map,
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
    AgentHost, AgentInfo, AuthMethodWire, HostError, PermissionDecision, PluginSpec, SessionInit,
    SessionKey, SessionSnapshot,
};
use super::agent_analytics::AnalyticsState;
use super::catalog::emit_catalog_changed;
use super::memory_chat::MemoryChatState;
use super::memory_indexer::MemoryRegistry;
use super::memory_inject;
use super::memory_pack;
use super::memory_retrieve;
use super::memory_sharing::{MemorySharingState, SummarizerPref};
use super::memory_summarize;
use super::shared_memory::SharedMemoryStore;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as AsyncCommand;
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
    /// `cersei`). A single `DashMap` lookup, safe on the delta hot path.
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
        if plugin_id == atlas_native_agent::CERSEI_AGENT_ID {
            "cersei"
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
                st.with_turn(sid, |a| a.note_permission_request())
            }
            SessionDelta::PermissionResolved { .. } => {
                st.with_turn(sid, |a| a.note_permission_resolved())
            }
            SessionDelta::RetryStatus { .. } => st.with_turn(sid, |a| a.note_retry()),
            SessionDelta::Compaction { active } if *active => {
                st.with_turn(sid, |a| a.note_compaction())
            }
            SessionDelta::CompressionSaved { saved_tokens } => {
                st.with_turn(sid, |a| a.note_compression_saved(*saved_tokens))
            }
            SessionDelta::ModelChanged { model_id } => {
                st.with_turn(sid, |a| a.note_model(model_id))
            }
            SessionDelta::ModeChanged { .. } => st.with_turn(sid, |a| a.note_mode_change()),
            SessionDelta::MessageAppended { message } => {
                if message.role == MessageRole::Assistant {
                    st.with_turn(sid, |a| a.note_assistant_message());
                }
            }
            SessionDelta::PlanUpdated { .. } => st.with_turn(sid, |a| a.note_plan_update()),

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
                // The user's own messages are recorded by `agents_send` (they
                // never arrive as deltas), so this is assistant/system only.
                if message.role == MessageRole::User {
                    return;
                }
                // Cheap guard first: no buffer means no prompt was recorded for
                // this session, so it isn't one we're recording.
                if state.snapshot(&envelope.session_id).is_none() {
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
        let cwd = store.session_meta(&envelope.session_id).map(|m| m.cwd);

        let is_turn_finished = matches!(envelope.delta, SessionDelta::TurnFinished { .. });
        let agent_id = envelope.agent_id;
        let session_id = envelope.session_id.clone();

        // Site A — Shared Cross-Agent Memory (v2) capture (write-side parity for
        // all three agents). `classify` is pure/in-memory, but `append_event`
        // does a small disk append (events.jsonl + an atomic state write), so we
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
            // Site B — A/B gate (Step 7). `ATLAS_NATIVE_EXTRACTION` (default OFF)
            // selects between:
            //  - ON  → native gated extraction in the background indexer for ALL
            //          three agents (`Job::ExtractSession`), SKIPPING the legacy
            //          per-turn BYOK distill. `memory_compile` is only deleted in
            //          Step 8 once this path is validated.
            //  - OFF → the current behaviour: spawn `compile_finished_turn` (the
            //          legacy prose→events distill, itself a no-op unless the
            //          project's summarizer is a BYOK provider).
            if native_extraction_enabled() {
                if let Some(cwd) = cwd.clone() {
                    let registry = self.app.state::<Arc<MemoryRegistry>>();
                    let _ = registry.enqueue(super::memory_indexer::Job::ExtractSession {
                        cwd,
                        agent: agent_id.0.to_string(),
                        session: session_id.clone(),
                    });
                }
            } else {
                let app = self.app.clone();
                // TODO(step8): remove after ATLAS_NATIVE_EXTRACTION validated
                tauri::async_runtime::spawn(async move {
                    super::memory_compile::compile_finished_turn(&app, agent_id, session_id).await;
                });
            }

            // Background reindex nudge: the FS watcher only watches `*.md`/docs.json,
            // not session transcripts, so a finished turn needs an explicit nudge to
            // make chat-derived corpus searchable. Fire-and-forget — `enqueue_index`
            // `try_send`s and drops on a full queue, so `emit` never blocks here.
            // (Fires in BOTH modes; the native path additionally enqueues its own
            // reindex after writing `extracted/*.md`.)
            if let Some(cwd) = cwd {
                let registry = self.app.state::<Arc<MemoryRegistry>>();
                registry.enqueue_index(&cwd);
            }
        }
    }
}

/// A/B flag for Step 7's native session extraction. **Default OFF** so the
/// legacy `memory_compile` distill keeps running until the new path is validated
/// on real sessions (Step 8 then removes `memory_compile`).
///
/// Set `ATLAS_NATIVE_EXTRACTION` to `1`/`true`/`on`/`yes` (case-insensitive) to
/// route `TurnFinished` through the background `Job::ExtractSession` path for all
/// three agents instead.
fn native_extraction_enabled() -> bool {
    matches!(
        std::env::var("ATLAS_NATIVE_EXTRACTION")
            .ok()
            .as_deref()
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref(),
        Some("1" | "true" | "on" | "yes")
    )
}

/// Initialise the agent stack once the Tauri app is up so the sink has a real
/// `AppHandle` to emit through. Called from `setup`.
///
/// Order is load-bearing. Analytics and transcript state must exist before the
/// sink, because their middleware resolves them on the first delta; the sink
/// must exist before the host, because the host builds the projector around it.
pub fn install_manager(app: &AppHandle) {
    app.manage(Arc::new(AnalyticsState::new()));
    app.manage(Arc::new(super::agent_transcript::TranscriptState::new()));
    let sink: Arc<dyn DeltaSink> = Arc::new(TauriDeltaSink::new(app.clone()));

    // App config dir holds `byok-keys.json` (BYOK keys the native agent reads)
    // and `cersei-sessions/` (its persisted transcripts). Best-effort: fall
    // back to a temp dir if the platform path is unavailable.
    let config_dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    // Let the memory corpus reader find native-agent transcripts (Chat/Graph).
    super::agent_memory::set_cersei_config_dir(config_dir.clone());
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
        NodeRuntime::managed(&data_dir, http.clone()),
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

    // Seed the installed agents' spawn env from the BYOK keys on disk plus any
    // keys the user already exports in their shell — several agents read
    // provider API keys from env, which is Atlas's non-interactive substitute
    // for their `auth login` TUI. The sync uses the instant process-env
    // snapshot; the login-shell probe runs on its own thread and re-syncs.
    super::byok::sync_builtin_agent_env(app);
    super::byok::ensure_shell_probe(app);

    {
        // Cache-first, then network: the installed map is what makes agents
        // spawnable, so it is read and applied before anything is fetched.
        let app = app.clone();
        let host = host.clone();
        tauri::async_runtime::spawn(async move {
            let installed = super::agent_host::load_installed(&data_dir);
            let _ = registry.load_cached().await;
            store.set_settings(installed).await;
            emit_catalog_changed(&app, "settings");

            let _ = registry.refresh().await;
            store.registry_updated();
            // Detection runs after the refresh: it probes for the programs the
            // registry names, so a first-run machine with no cached index would
            // otherwise have nothing to look for.
            let probe = host.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || probe.probe_detected()).await;
            emit_catalog_changed(&app, "discovery");
        });
    }

    // Wire the native agent's `search_memory` tool to Atlas's on-device memory
    // retrieval. The closure resolves `MemoryChatState` lazily (it's managed
    // after this call) and maps the retrieved docs into the agent's shape.
    let app_for_search = app.clone();
    atlas_cersei::register_memory_search(Arc::new(move |cwd, query, k| {
        let app = app_for_search.clone();
        Box::pin(async move {
            let state = app.state::<crate::commands::memory_chat::MemoryChatState>();
            crate::commands::memory_retrieve::retrieve(&app, state.inner(), &cwd, &query, k)
                .await
                .into_iter()
                .map(|d| atlas_cersei::MemDoc {
                    title: d.title,
                    source: d.source,
                    text: d.text,
                })
                .collect()
        })
    }));
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn agents_list_plugins(host: State<'_, Arc<AgentHost>>) -> Vec<PluginSpec> {
    host.list_plugins()
}

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
/// or it is not (§D12-3). The catalog is re-emitted on success because an
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
    // Extra workspace roots. Only reaches agents that advertised
    // `sessionCapabilities.additionalDirectories`; dropped with a log otherwise.
    additional_directories: Option<Vec<PathBuf>>,
    host: State<'_, Arc<AgentHost>>,
) -> Result<SessionInit, CmdError> {
    host.new_session(agent_id, cwd, additional_directories.unwrap_or_default())
        .await
        .map_err(CmdError::from)
}

/// Whether Codex has stored credentials (`~/.codex/auth.json` exists). Drives
/// the "Sign in with ChatGPT" prompt on a Codex chat. Cheap file check.
#[tauri::command]
pub fn codex_status() -> bool {
    dirs::home_dir()
        .map(|h| h.join(".codex").join("auth.json").is_file())
        .unwrap_or(false)
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

/// The agent's OWN stored sessions for `cwd` (ACP `session/list`).
///
/// `null` when the agent is not connected or never advertised
/// `sessionCapabilities.list` — the sidebar then keeps using whatever bespoke
/// reader Atlas has for it. This is the path that gives a brand-new ACP agent
/// sidebar history without anyone writing a transcript parser for it.
#[tauri::command]
pub async fn agents_agent_sessions(
    plugin_id: String,
    cwd: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<Option<Vec<serde_json::Value>>, String> {
    host.agent_sessions(&plugin_id, &cwd)
        .await
        .map_err(|e| e.to_string())
}

/// Ask the agent to forget a stored session (ACP `session/delete`).
/// Returns whether the agent actually handled it.
#[tauri::command]
pub async fn agents_delete_agent_session(
    plugin_id: String,
    session_id: String,
    host: State<'_, Arc<AgentHost>>,
) -> Result<bool, String> {
    host.delete_agent_session(&plugin_id, &session_id)
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

/// Branch a session from its current state (ACP `session/fork`).
///
/// Always `null` on the ported seam: Zed does not implement `session/fork`, so
/// the trait has no method for it and there is nothing to delegate to. The
/// command stays registered and keeps its "this agent cannot fork" answer so
/// the frontend's capability check (`supportsFork`, likewise false) is what
/// hides the affordance, rather than an error the user has to read.
#[tauri::command]
pub async fn agents_fork_session(
    key: SessionKey,
    host: State<'_, Arc<AgentHost>>,
) -> Result<Option<String>, String> {
    let _ = (key, host);
    Ok(None)
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
    plugin_id: String,
    session_id: String,
    cwd: String,
    app: AppHandle,
    host: State<'_, Arc<AgentHost>>,
) -> Result<Vec<Message>, String> {
    let native = host.replay_transcript(&plugin_id, &cwd, &session_id).await;
    if !native.is_empty() {
        return Ok(native);
    }
    // Empty means this agent keeps no transcript of its own (opencode, cursor,
    // every registry agent). Fall back to the one Atlas recorded, which is what
    // makes their history rows actually reopen instead of painting blank.
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
            timestamp: m
                .timestamp
                .parse::<chrono::DateTime<chrono::Utc>>()
                .unwrap_or_else(|_| chrono::Utc::now()),
        })
        .collect()
}

/// Session-history rows for agents Atlas records itself. Merged into the
/// sidebar alongside the Claude / Codex / Cersei / Kilo listings; returns an
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

/// Delete one Atlas-recorded transcript (sidebar delete). Idempotent.
#[tauri::command]
pub async fn agent_transcripts_delete(
    cwd: String,
    session_id: String,
    app: AppHandle,
) -> Result<(), String> {
    app.state::<Arc<super::agent_transcript::TranscriptState>>()
        .forget(&session_id);
    let dir = app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir());
    tauri::async_runtime::spawn_blocking(move || {
        super::agent_transcript::remove(&dir, &cwd, &session_id)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
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

#[tauri::command]
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
#[tauri::command]
pub fn agents_snapshot_meta(
    key: SessionKey,
    host: State<'_, Arc<AgentHost>>,
) -> Result<SessionSnapshot, String> {
    host.snapshot_meta(&key).map_err(|e| e.to_string())
}

/// Hard cap on the whole memory-injection path (pack + handoff + summarize) so
/// a slow disk or provider can never stall the user's first message.
const INJECT_BUDGET_SECS: u64 = 8;

/// Send a user message to an agent session.
///
/// On the **first send** of a session — when Shared Cross-Agent Memory is
/// enabled for the project — Atlas prepends a curated memory pack + recent
/// Claude-session handoff so a freshly-switched agent inherits prior context.
/// The injection is best-effort and time-bounded ([`INJECT_BUDGET_SECS`]); on
/// any timeout/error the original `text` is sent unchanged. Turns 2..N skip the
/// build entirely (see [`MemorySharingState::already_sent`]).
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
    // content at each of the three send exits below (bare / slash-command /
    // memory-prefixed), so a send that returns early can't strand images for
    // some later turn to pick up.
    let images = attachments.unwrap_or_default();
    let links = resource_links.unwrap_or_default();

    // Resolve the project cwd. Unknown session → fail with the SAME error
    // shape `manager.send` produces, without attempting a send that would
    // skip memory injection (one condition, one behavior — L5).
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
    // Note it uses `text`, not the memory-prefixed string composed below:
    // Atlas's injected context blocks are machinery, not something the user
    // said, and a Session titled after an injected block would be nonsense.
    // Placed before the bare-send branch so capture does not depend on whether
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

    // Atlas's own transcript, for every agent. Recorded here for the same
    // reason capture is: the user's prompt is never emitted as a delta, so a
    // delta-only recorder produces transcripts that start mid-answer and have
    // no title. Uses `text`, not the memory-prefixed string composed below —
    // injected context is machinery, not what the user said, and a history row
    // titled after it would be nonsense.
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

    // No cwd or sharing disabled → bare send (no injection).
    if cwd.is_empty() || !sharing.is_enabled(&cwd) {
        return host
            .send(
                &key,
                prompt::with_resource_links(prompt::compose(text, images), links),
            )
            .map_err(|e| e.to_string());
    }

    // Register this session so the capture path (`TauriDeltaSink::emit`) can
    // route its deltas into the shared event log for the project.
    let store = app.state::<SharedMemoryStore>();
    store.register_session(&key.session_id, &cwd, &snapshot.plugin_id);

    // Slash-command turns ship verbatim: Claude Code only resolves a command
    // (skills included) when it sits at byte 0, so prepending any block below
    // would demote `/skill-name` to prose and the command would never fire. See
    // `memory_pack::is_slash_command`. Returning here — rather than composing
    // and stripping later — deliberately leaves the sync clock un-advanced and
    // `mark_sent` uncalled, so whatever memory was pending still rides the next
    // conversational turn instead of being consumed by a turn that dropped it.
    if memory_pack::is_slash_command(&text) {
        return host
            .send(
                &key,
                prompt::with_resource_links(prompt::compose(text, images), links),
            )
            .map_err(|e| e.to_string());
    }

    // v2 push: per-turn shared-memory block, gated by this session's sync clock
    // (0 ⇒ first sync = full current state; >0 ⇒ delta since last turn). Cheap
    // in-memory read, so no timeout needed here.
    let clock = sharing.clock_for(&key);
    let shared_block = memory_inject::build_shared_block(store.inner(), &cwd, clock);
    sharing.advance_clock(&key, store.last_seq(&cwd));

    // Site C (Step 5: kept, NOT removed) — retrieval-augmented push: RAG the
    // project's memory index by the user's message, keep only docs not already
    // injected this session, and compose a budgeted `--- RELEVANT PROJECT MEMORY
    // ---` block. This is a read-only PUSH that grounds Claude Code / Codex,
    // which have no `search_memory` pull tool — removing it would regress their
    // RAG. It performs NO indexing (read-only). Step 6 rewires the underlying
    // `memory_retrieve::retrieve` onto the fresh `MemoryEngine`; the call here is
    // unchanged. `retrieve` is best-effort + time-bounded; a missing embedding
    // model / unbuilt index yields nothing, so this is a no-op until the index
    // exists.
    const INDEX_TOP_K: usize = 3;
    let chat_state = app.state::<MemoryChatState>();
    let mut index_docs =
        memory_retrieve::retrieve(&app, chat_state.inner(), &cwd, &text, INDEX_TOP_K).await;
    index_docs.retain(|d| sharing.note_index_doc(&key, &d.id));
    let index_block = memory_retrieve::compose_index_block(&index_docs);

    // v1 bootstrap: on the very first send only, also prepend the curated pack +
    // recent-session handoff (retained as the clock-0 onboarding layer, bounded
    // by INJECT_BUDGET_SECS inside `build_injection`).
    let base = if !sharing.already_sent(&key) {
        let pref = sharing.summarizer_pref(&cwd);
        let built = build_injection(&app, &cwd, &key.session_id, &pref, &text).await;
        sharing.mark_sent(&key);
        built
    } else {
        text
    };

    // Compose: [working memory] + [relevant index] + (bootstrap +) user text.
    let mut parts: Vec<String> = Vec::new();
    if let Some(b) = shared_block {
        parts.push(b);
    }
    if let Some(b) = index_block {
        parts.push(b);
    }
    let prefixed = if parts.is_empty() {
        base
    } else {
        format!("{}\n\n{}", parts.join("\n\n"), base)
    };
    host.send(
        &key,
        prompt::with_resource_links(prompt::compose(prefixed, images), links),
    )
    .map_err(|e| e.to_string())
}

/// Assemble the memory-prefixed message. Everything runs inside a single
/// [`INJECT_BUDGET_SECS`] timeout; on elapse it falls back to the bare text.
async fn build_injection(
    app: &AppHandle,
    cwd: &str,
    session_id: &str,
    pref: &SummarizerPref,
    user_text: &str,
) -> String {
    let cwd = cwd.to_string();
    let session_id = session_id.to_string();

    let built = tokio::time::timeout(Duration::from_secs(INJECT_BUDGET_SECS), async {
        // Curated pack (collect_corpus is async + does its own spawn_blocking).
        let pack = memory_pack::build_memory_pack(&cwd).await;

        // Recent-session handoff: pure disk I/O on a blocking thread.
        let handoff_raw = {
            let cwd = cwd.clone();
            let sid = session_id.clone();
            tokio::task::spawn_blocking(move || memory_pack::build_session_handoff(&cwd, &sid))
                .await
                .ok()
                .flatten()
        };

        let handoff_block = if let Some((raw_body, turns)) = handoff_raw {
            let (body, attribution) = if pref.mode == "provider"
                && !pref.provider.is_empty()
                && !pref.model.is_empty()
            {
                let summary =
                    memory_summarize::summarize(app, &raw_body, &pref.provider, &pref.model).await;
                if summary == raw_body {
                    (raw_body, "raw".to_string())
                } else {
                    (summary, format!("summarized by {}/{}", pref.provider, pref.model))
                }
            } else {
                (raw_body, "raw".to_string())
            };
            Some(memory_pack::wrap_handoff(&body, turns, &attribution))
        } else {
            None
        };

        memory_pack::compose_injection(pack.as_deref(), handoff_block.as_deref(), user_text)
    })
    .await;

    match built {
        Ok(s) => s,
        Err(_) => {
            tracing::warn!(
                target: "atlas::memory_sharing",
                "memory injection exceeded {INJECT_BUDGET_SECS}s budget; sending bare text"
            );
            user_text.to_string()
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

#[tauri::command]
pub fn agents_set_compress(
    key: SessionKey,
    on: bool,
    host: State<'_, Arc<AgentHost>>,
) -> Result<(), String> {
    host.set_compress(&key, on).map_err(|e| e.to_string())
}

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
// The old `enrich_auth_methods` is gone with `BUILTIN_AGENTS`: it filled in a
// login command for agents that advertised none, from a hardcoded per-agent
// table of login argv. An agent that names no login command now says so,
// which is the honest answer and the only one that generalises past a list
// someone wrote down. Re-deriving the full flow from Zed's `terminal_auth_task`
// is the Stage 4 auth ticket.

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
pub fn agents_auth_env_status(
    agent_id: AgentId,
    host: State<'_, Arc<AgentHost>>,
) -> Result<Vec<AuthEnvStatus>, String> {
    let methods = host.auth_methods(agent_id).map_err(|e| e.to_string())?;

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
pub fn agents_list_auth_methods(
    agent_id: AgentId,
    host: State<'_, Arc<AgentHost>>,
) -> Result<Vec<AuthMethodWire>, String> {
    host.auth_methods(agent_id).map_err(|e| e.to_string())
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

    let mut cmd = AsyncCommand::new(&command);
    cmd.args(&args);
    cmd.envs(spec.env.iter().cloned());
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

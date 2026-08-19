//! Tauri command surface for `atlas-agents`.
//!
//! Mirrors the high-level multi-agent manager API. The Tauri host owns:
//! - the singleton `AgentManager`
//! - the `DeltaSink` impl that fans `SessionDeltaEnvelope`s out as
//!   `"atlas:agents"` window events
//!
//! The lower-level `acp_*` commands remain registered for now so the legacy
//! direct-ACP frontend keeps working during migration; they will be dropped
//! once the renderer is fully on the new surface.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use atlas_agents::{
    AgentId, AgentInfo, AgentManager, AuthMethodWire, DeltaSink, Message, OutboundMiddleware,
    OutboundPipeline, PermissionDecision, PluginSpec, SessionDelta, SessionDeltaEnvelope, SessionId,
    SessionKey, SessionSnapshot, SessionStatus,
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

/// Bridge atlas-agents deltas to the Tauri host's outbound concerns.
///
/// The sink body is decomposed into an ordered [`OutboundPipeline`] of small,
/// independently-testable middleware (window broadcast → telemetry → memory
/// ingest) instead of one monolithic `emit`. The atlas-agents `Emitter` also
/// publishes every delta to the global event bus (`manager.subscribe()`) before
/// reaching this sink, so a cloud streamer can tap the same stream without
/// touching any of this.
pub struct TauriDeltaSink {
    pipeline: OutboundPipeline<SessionDeltaEnvelope>,
}

impl TauriDeltaSink {
    pub fn new(app: AppHandle) -> Self {
        let pipeline = OutboundPipeline::new()
            // Broadcast first so the UI updates before any heavier work.
            .with(Arc::new(BroadcastMiddleware { app: app.clone() }))
            // `AnalyticsMiddleware` supersedes the old `TelemetryMiddleware`
            // this branch was written against (v0.2.4 account-linked analytics
            // rework) — same slot in the pipeline, so capture stacks after it.
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
            .state::<AgentManager>()
            .plugin_id_for_agent(envelope.agent_id)
            .unwrap_or_else(|| "unknown".to_string())
    }

    /// Coarse bucket for funnels that don't care which ACP agent it was.
    fn family(plugin_id: &str) -> &'static str {
        if plugin_id == "cersei" {
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
                if message.role == atlas_agents::session::MessageRole::Assistant {
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
/// Only for agents with `TranscriptKind::None` — Claude, the native agent and
/// Kilo already have readable stores, and a second copy would put two rows in
/// the sidebar for one conversation with two competing titles.
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
                if message.role == atlas_agents::session::MessageRole::User {
                    return;
                }
                // Cheap guard first: no buffer means no prompt was recorded for
                // this session, so it isn't one we're recording.
                if state.snapshot(&envelope.session_id).is_none() {
                    return;
                }
                let role = match message.role {
                    atlas_agents::session::MessageRole::Assistant => "assistant",
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
        let agent_id = envelope.agent_id.clone();
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
                tool_call.status == atlas_agents::ToolCallStatus::Completed
            }
            SessionDelta::MessageAppended { message } => {
                message.role == atlas_agents::MessageRole::Assistant
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

/// Initialise the `AgentManager` once the Tauri app is up so the sink has a
/// real `AppHandle` to emit through. Called from `setup`.
pub fn install_manager(app: &AppHandle) {
    // Must exist BEFORE the sink is built — the sink's analytics middleware
    // resolves this state on its first delta.
    app.manage(Arc::new(AnalyticsState::new()));
    // Must exist BEFORE the sink — `TranscriptMiddleware` resolves it on its
    // first delta, and `agents_send` on the first prompt.
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
    // Dynamic ACP registry: installed external agents become spawnable specs
    // alongside the first-party set. Cache-first construction (sync, cheap) so
    // the marketplace lists instantly; a non-blocking refresh follows.
    let app_data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let registry_store = atlas_registry::RegistryStore::new(app_data_dir);
    app.manage(registry_store.clone());
    // Seed the managed built-ins' spawn env from the BYOK keys on disk plus
    // any keys the user already exports in their shell — opencode/kilo read
    // provider API keys from env, which is Atlas's non-interactive substitute
    // for their `auth login` TUI. The immediate sync uses the instant
    // process-env snapshot; the login-shell probe runs on its own thread and
    // re-syncs (+ notifies the settings UI) when it lands.
    super::byok::sync_builtin_agent_env(app);
    super::byok::ensure_shell_probe(app);
    let manager = AgentManager::with_spec_source(
        sink,
        config_dir,
        Some(Arc::new(registry_store.clone())),
    );
    app.manage(manager);
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = registry_store.refresh(false).await;
            // Discovery runs AFTER the manifest refresh on purpose: the
            // candidate list includes manifest agents that publish a plain
            // executable, so a first-run machine with no cached manifest would
            // otherwise only ever probe for the built-ins.
            registry_store.discover(false).await;
            // Unconditional: even an empty result is news to a frontend that
            // has been rendering pre-discovery `auto-acquire` sources.
            emit_catalog_changed(&app, "discovery");
        });
    }

    // Wire the native agent's `search_memory` tool to Atlas's on-device memory
    // retrieval. The closure resolves `MemoryChatState` lazily (it's managed
    // after this call) and maps the retrieved docs into the agent's shape.
    let app_for_search = app.clone();
    atlas_agents::register_memory_search(std::sync::Arc::new(move |cwd, query, k| {
        let app = app_for_search.clone();
        Box::pin(async move {
            let state = app.state::<crate::commands::memory_chat::MemoryChatState>();
            crate::commands::memory_retrieve::retrieve(&app, state.inner(), &cwd, &query, k)
                .await
                .into_iter()
                .map(|d| atlas_agents::MemDoc {
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
pub fn agents_list_plugins(manager: State<'_, AgentManager>) -> Vec<PluginSpec> {
    manager.list_plugins()
}

#[tauri::command]
pub fn agents_list_running(manager: State<'_, AgentManager>) -> Vec<AgentInfo> {
    manager.list_agents()
}

/// A command failure that carries its CLASSIFICATION, not just a message.
///
/// The three session-lifecycle commands used to reject with `e.to_string()`,
/// throwing away a classification the Rust side had already computed. That
/// left the frontend substring-matching English prose to decide whether a
/// failure meant "sign in" — and it missed the case that matters most: Cursor
/// rejects `session/new` when unauthenticated, so the failure happens at BIND
/// time and no turn-failure `atlas:auth-required` event ever fires.
///
/// `kind` is an [`atlas_acp::ErrorClass`] wire token ("auth" | "transient" |
/// "fatal" | "process_dead" | "unknown"). Frontend callers must read
/// `.message` rather than stringifying the object — see `errInfo` in
/// `agent-signin.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CmdError {
    pub message: String,
    pub kind: String,
}

impl CmdError {
    /// Classify a bare message that never was an `Error` (host-side rejections
    /// like the disabled-agent guard), with an explicit kind.
    fn new(message: impl Into<String>, kind: atlas_acp::ErrorClass) -> Self {
        Self {
            message: message.into(),
            kind: kind.wire_token().to_string(),
        }
    }
}

impl From<atlas_agents::Error> for CmdError {
    fn from(e: atlas_agents::Error) -> Self {
        Self {
            kind: e.class().wire_token().to_string(),
            message: e.to_string(),
        }
    }
}

/// Byte progress for a built-in agent's managed-binary download, emitted while
/// a spawn waits on it. Deliberately its OWN event rather than reusing
/// `atlas:registry-install:*`: this is a spawn-time acquisition, not an
/// install, and the marketplace only clears its progress map from the install
/// flow — feeding it entries from here would leak them.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcquireProgress {
    agent_id: String,
    received: u64,
    total: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcquireDone {
    agent_id: String,
    /// Whether a managed binary is now in place. `false` means the spawn falls
    /// back to the agent's bare CLI command (which may still succeed).
    ready: bool,
}

/// Whole-percent to emit for a download chunk, or `None` to skip this one.
///
/// `ensure_binary` invokes its progress callback once PER HTTP CHUNK — ~56k
/// times for Cursor's 77 MB archive. Emitting a Tauri event each time would
/// flood the IPC bridge and jank the UI, so a percent is emitted only when it
/// actually changes (~101 events for a whole download). Chunks with no
/// content-length are skipped entirely — there is no percent to show.
fn acquire_pct_to_emit(
    received: u64,
    total: Option<u64>,
    last: &std::sync::atomic::AtomicU64,
) -> Option<u64> {
    let total = total.filter(|t| *t > 0)?;
    let pct = received.saturating_mul(100) / total;
    (last.swap(pct, std::sync::atomic::Ordering::Relaxed) != pct).then_some(pct)
}

#[tauri::command]
pub async fn agents_spawn(
    plugin_id: String,
    app: AppHandle,
    manager: State<'_, AgentManager>,
    registry: State<'_, atlas_registry::RegistryStore>,
    app_state: State<'_, crate::state::AppStateHandle>,
) -> Result<AgentInfo, CmdError> {
    // The user turned this built-in off in Settings → Agents. The UI already
    // hides it from the picker; this is the authority behind that — it also
    // covers paths the picker doesn't gate, notably resuming an old session
    // that was recorded against the agent before it was switched off.
    // Deliberately BEFORE any acquisition work: a disabled agent must never
    // trigger a download.
    if app_state.lock().settings.builtin_disabled(&plugin_id) {
        let name = atlas_acp::AgentSpec::all_known()
            .into_iter()
            .find(|s| s.spec_id == plugin_id)
            .map(|s| s.display_name)
            .unwrap_or_else(|| plugin_id.clone());
        // Fatal, not auth: no amount of retrying or signing in changes it —
        // only the user flipping the setting back does.
        return Err(CmdError::new(
            format!("{name} is turned off. Turn it back on in Settings → Agents."),
            atlas_acp::ErrorClass::Fatal,
        ));
    }
    // Self-heal for registry-installed externals: re-download a binary payload
    // that went missing (killed mid-install, cache purge). No-op otherwise.
    registry.ensure_ready(&plugin_id).await.map_err(|e| {
        let message = e.to_string();
        let kind = atlas_acp::classify_message(&message);
        CmdError::new(message, kind)
    })?;
    // Built-ins with no npx distribution (cursor / opencode / kilo).
    //
    // System-first: if the user already has the CLI on their PATH, that is
    // what spawns and Atlas downloads nothing. Only when discovery comes up
    // empty do we acquire the official binary from the registry, so these
    // agents still spawn with zero manual setup the way `npx -y` handles
    // Claude/Codex. Acquisition is deliberately not fatal — on failure the
    // bare-CLI command still runs, which is the behaviour that existed before.
    // Cold cache means a real download, so the composer gets progress to show
    // instead of a silent 20 s stall.
    let mut from_discovered = false;
    if atlas_acp::is_auto_managed(&plugin_id) {
        if registry.ensure_discovered(&plugin_id).await {
            from_discovered = true;
            // Clears any "Setting up…" pill the composer raced up before
            // discovery answered — nothing is being downloaded.
            let _ = app.emit(
                "atlas:agent-acquire:done",
                AcquireDone {
                    agent_id: plugin_id.clone(),
                    ready: true,
                },
            );
        } else {
            let progress_app = app.clone();
            let progress_id = plugin_id.clone();
            let last_pct = std::sync::atomic::AtomicU64::new(u64::MAX);
            let progress = move |received: u64, total: Option<u64>| {
                // Throttled — see `acquire_pct_to_emit`.
                if acquire_pct_to_emit(received, total, &last_pct).is_none() {
                    return;
                }
                let _ = progress_app.emit(
                    "atlas:agent-acquire:progress",
                    AcquireProgress {
                        agent_id: progress_id.clone(),
                        received,
                        total,
                    },
                );
            };
            let ready = registry.ensure_builtin(&plugin_id, Some(&progress)).await;
            // Always emitted (cache hit, download, or failure) so the composer
            // can clear its "Setting up…" pill on every path.
            let _ = app.emit(
                "atlas:agent-acquire:done",
                AcquireDone {
                    agent_id: plugin_id.clone(),
                    ready,
                },
            );
            if ready {
                // A binary that wasn't there a moment ago changes how this
                // agent launches — the catalog's `source` is now stale.
                emit_catalog_changed(&app, "acquire");
            }
        }
    }
    match manager.spawn(&plugin_id).await {
        Ok(info) => {
            // The catalog's capability fields (`authKinds`, `supportsLogout`,
            // `supportsFork`, `supportsLoadSession`, `supportsSessionList`) are
            // read from LIVE agents, because ACP capabilities only exist after
            // `initialize`. Nothing else emits after a spawn, so without this
            // the frontend keeps its pre-spawn snapshot — every one of those
            // fields stays false forever and the UI they gate (the sign-out
            // row, "Branch from here", catalog-first `canSignIn`) never
            // appears, even for an agent that plainly advertises them.
            emit_catalog_changed(&app, "spawn");
            Ok(info)
        }
        // Stale-CLI resilience — the one real risk of preferring the system
        // install. An `opencode` predating its `acp` subcommand exits
        // immediately, and without this the agent would be permanently
        // unusable on that machine. Drop the discovered binary, fall back to
        // the managed download, and retry ONCE: transparent to the user.
        Err(e) if from_discovered => {
            tracing::warn!(
                target: "atlas::agents",
                "discovered `{plugin_id}` failed to start ({e}) — falling back to the managed binary"
            );
            registry.forget_discovered(&plugin_id);
            registry.ensure_builtin(&plugin_id, None).await;
            // Announces the CHANGED LAUNCH PATH, and fires BEFORE the retry —
            // so the catalog it triggers is still built with no live agent.
            emit_catalog_changed(&app, "discovery");
            let info = manager.spawn(&plugin_id).await.map_err(CmdError::from)?;
            // …hence a second emit once the agent is actually up, for the
            // capability fields. Same reason as the `Ok` arm above.
            emit_catalog_changed(&app, "spawn");
            Ok(info)
        }
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
pub fn agents_kill(agent_id: AgentId, manager: State<'_, AgentManager>) -> Result<(), String> {
    manager.kill(agent_id).map_err(|e| e.to_string())
}

/// Open a session on a spawned agent.
///
/// This is THE command that surfaces "you are not signed in" for most agents:
/// they accept `initialize` happily and only reject `session/new`. Verified
/// live against Cursor and against auth-gated registry agents (`autohand`
/// answers `-32000 Authentication required — "Please log in to use Autohand"`).
/// No turn exists at that point, so nothing emits `atlas:auth-required` — the
/// `kind: "auth"` on this rejection is the ONLY signal the frontend gets to
/// route the user into sign-in instead of showing a raw protocol error.
#[tauri::command]
pub async fn agents_new_session(
    agent_id: AgentId,
    cwd: PathBuf,
    // Extra workspace roots (P3.2). Only reaches agents that advertised
    // `sessionCapabilities.additionalDirectories`; dropped with a log otherwise.
    additional_directories: Option<Vec<PathBuf>>,
    manager: State<'_, AgentManager>,
) -> Result<atlas_agents::SessionInit, CmdError> {
    manager
        .new_session(agent_id, cwd, additional_directories.unwrap_or_default())
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

/// Run an agent's ACP `authenticate` flow (e.g. Codex's "chatgpt" browser
/// OAuth). Awaits until the agent reports success — for Codex this resolves
/// once the OpenAI sign-in completes and `~/.codex/auth.json` is written.
#[tauri::command]
pub async fn agents_authenticate(
    agent_id: AgentId,
    method_id: String,
    manager: State<'_, AgentManager>,
) -> Result<(), String> {
    manager
        .authenticate(agent_id, method_id)
        .await
        .map_err(|e| e.to_string())
}

/// The agent's OWN stored sessions for `cwd` (P2.3, ACP `session/list`).
///
/// `null` when the agent is not running or never advertised
/// `sessionCapabilities.list` — the sidebar then keeps using whatever bespoke
/// reader Atlas has for it. This is the path that gives a brand-new ACP agent
/// sidebar history without anyone writing a transcript parser for it.
#[tauri::command]
pub async fn agents_agent_sessions(
    plugin_id: String,
    cwd: String,
    manager: State<'_, AgentManager>,
) -> Result<Option<Vec<atlas_acp::AgentSessionInfo>>, String> {
    manager
        .agent_sessions(&plugin_id, &cwd)
        .await
        .map_err(|e| e.to_string())
}

/// Ask the agent to forget a stored session (P2.3, ACP `session/delete`).
/// Returns whether the agent actually handled it.
#[tauri::command]
pub async fn agents_delete_agent_session(
    plugin_id: String,
    session_id: String,
    manager: State<'_, AgentManager>,
) -> Result<bool, String> {
    manager
        .delete_agent_session(&plugin_id, &session_id)
        .await
        .map_err(|e| e.to_string())
}

/// Answer an elicitation the agent raised (P3.3).
///
/// `action` is `"accept"` / `"decline"` / `"cancel"`; `content` is the form's
/// field map on accept. Unknown ids are a no-op — the user can answer a dialog
/// whose agent already died.
#[tauri::command]
pub fn agents_respond_elicitation(
    agent_id: AgentId,
    request_id: uuid::Uuid,
    action: String,
    content: Option<serde_json::Value>,
    manager: State<'_, AgentManager>,
) -> Result<(), String> {
    manager
        .respond_elicitation(agent_id, request_id, &action, content)
        .map_err(|e| e.to_string())
}

/// Branch a session from its current state (P3.4, ACP `session/fork`).
/// `null` when the agent has no fork capability.
#[tauri::command]
pub async fn agents_fork_session(
    key: SessionKey,
    manager: State<'_, AgentManager>,
) -> Result<Option<String>, String> {
    manager.fork_session(&key).await.map_err(|e| e.to_string())
}

/// Set any agent-advertised config option (P2.2).
///
/// Generic by design: ACP lets an agent advertise arbitrary options and Atlas
/// previously only ever set `config_id = "model"`, so every other knob it
/// offered was unreachable. `value` is JSON — a bool maps to the wire's
/// `Boolean` form, anything else to the `ValueId` (select) form.
#[tauri::command]
pub async fn agents_set_config_option(
    key: SessionKey,
    config_id: String,
    value: serde_json::Value,
    manager: State<'_, AgentManager>,
) -> Result<(), String> {
    manager
        .set_config_option(&key, config_id, value)
        .await
        .map_err(|e| e.to_string())
}

/// Sign the agent out (A2, ACP `logout`).
///
/// Only offered for agents that advertised `auth.logout` — the frontend gates on
/// `AgentCatalogEntry.supportsLogout`, and the backend errors rather than
/// pretending for the rest. Atlas stores no agent credentials itself, so this is
/// purely a delegation: the agent drops its own.
#[tauri::command]
pub async fn agents_logout(
    agent_id: AgentId,
    manager: State<'_, AgentManager>,
) -> Result<(), String> {
    manager.logout(agent_id).await.map_err(|e| e.to_string())
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
    manager: State<'_, AgentManager>,
) -> Result<Vec<Message>, String> {
    let native = manager
        .replay_transcript(&plugin_id, &cwd, &session_id)
        .await
        .map_err(|e| e.to_string())?;
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
    use atlas_agents::session::{MessageMode, MessageRole};
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
    session_id: SessionId,
    cwd: PathBuf,
    manager: State<'_, AgentManager>,
) -> Result<SessionKey, CmdError> {
    manager
        .load_session(agent_id, session_id, cwd)
        .await
        .map_err(CmdError::from)
}

#[tauri::command]
pub fn agents_snapshot(
    key: SessionKey,
    manager: State<'_, AgentManager>,
) -> Result<SessionSnapshot, String> {
    manager.snapshot(&key).map_err(|e| e.to_string())
}

/// `agents_snapshot` minus the transcript. The full snapshot serializes every
/// message across IPC — multi-MB on long sessions — yet five frontend call
/// sites (mode seed, model backfill, composer self-heals, model warm) only
/// read the ~1KB metadata. Same wire shape; `messages` arrives empty.
#[tauri::command]
pub fn agents_snapshot_meta(
    key: SessionKey,
    manager: State<'_, AgentManager>,
) -> Result<SessionSnapshot, String> {
    manager.snapshot_meta(&key).map_err(|e| e.to_string())
}

/// Hard cap on the whole memory-injection path (pack + handoff + summarize) so a
/// slow disk or provider can never stall the user's first message.
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
    attachments: Option<Vec<atlas_acp::ImageAttachment>>,
    // `@`-mentions that point at files (P2.1). Sent as `ResourceLink` blocks
    // rather than flattened into the prose — the ACP-native way to hand an
    // agent a file, and every agent is required to accept it.
    resource_links: Option<Vec<atlas_acp::ResourceLinkSpec>>,
    manager: State<'_, AgentManager>,
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
    let Ok(snapshot) = manager.snapshot_meta(&key) else {
        return Err(atlas_agents::Error::UnknownSession.to_string());
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

    // Atlas's own transcript, for agents that keep none of their own. Recorded
    // here for the same reason capture is: the user's prompt is never emitted
    // as a delta, so a delta-only recorder produces transcripts that start
    // mid-answer and have no title. Uses `text`, not the memory-prefixed
    // string composed below — injected context is machinery, not what the user
    // said, and a history row titled after it would be nonsense.
    if !cwd.is_empty() {
        let transcripts = app.state::<Arc<super::agent_transcript::TranscriptState>>();
        let records = app
            .state::<AgentManager>()
            .list_plugins()
            .into_iter()
            .find(|p| p.plugin_id == plugin_id)
            .is_some_and(|p| p.transcript == atlas_agents::TranscriptKind::None);
        if records {
            transcripts.note_prompt(
                &key.session_id,
                &cwd,
                &plugin_id,
                &text,
                chrono::Utc::now().to_rfc3339(),
            );
        }
    }

    // No cwd or sharing disabled → bare send (no injection).
    if cwd.is_empty() || !sharing.is_enabled(&cwd) {
        return manager
            .send(
                &key,
                atlas_acp::prompt::with_resource_links(
                    atlas_acp::prompt::compose(text, images),
                    links,
                ),
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
        return manager
            .send(
                &key,
                atlas_acp::prompt::with_resource_links(
                    atlas_acp::prompt::compose(text, images),
                    links,
                ),
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
    manager
        .send(
            &key,
            atlas_acp::prompt::with_resource_links(
                atlas_acp::prompt::compose(prefixed, images),
                links,
            ),
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
pub fn agents_cancel(key: SessionKey, manager: State<'_, AgentManager>) -> Result<(), String> {
    manager.cancel(&key).map_err(|e| e.to_string())
}

/// Tear down a session's backend state (actor + driver-side guard) when its
/// tab closes or the project switches. Idempotent; UI state is the frontend's.
#[tauri::command]
pub fn agents_drop_session(
    manager: tauri::State<'_, AgentManager>,
    analytics: tauri::State<'_, Arc<AnalyticsState>>,
    agent_id: AgentId,
    session_id: String,
) -> Result<(), String> {
    // Release the per-turn accumulator with the session, so a tab closed
    // mid-turn doesn't hold one for the life of the process.
    analytics.forget_session(&session_id);
    let key = SessionKey { agent_id, session_id };
    manager.drop_session(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agents_set_mode(
    key: SessionKey,
    mode_id: String,
    manager: State<'_, AgentManager>,
) -> Result<(), String> {
    manager.set_mode(&key, mode_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agents_set_model(
    key: SessionKey,
    model_id: String,
    manager: State<'_, AgentManager>,
) -> Result<(), String> {
    manager.set_model(&key, model_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agents_set_effort(
    key: SessionKey,
    effort: String,
    manager: State<'_, AgentManager>,
) -> Result<(), String> {
    manager.set_effort(&key, effort).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agents_set_compress(
    key: SessionKey,
    on: bool,
    manager: State<'_, AgentManager>,
) -> Result<(), String> {
    manager.set_compress(&key, on).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agents_respond_permission(
    agent_id: AgentId,
    session_id: String,
    request_id: Uuid,
    decision: PermissionDecision,
    manager: State<'_, AgentManager>,
) -> Result<(), String> {
    manager
        .respond_permission(agent_id, &session_id, request_id, decision)
        .map_err(|e| e.to_string())
}

// ── Auth methods ────────────────────────────────────────────────────────────
//
// The ACP adapter (claude-agent-acp) advertises its supported auth methods
// in the `initialize` response. We pull those out of the driver and let the
// frontend render a chooser populated from whatever the adapter actually
// supports. When the user picks one, `agents_run_auth_method` spawns the
// adapter-supplied subprocess (`process.execPath ... --cli auth login
// --claudeai` for the Subscription path) — that vendored CLI runs the
// localhost-loopback OAuth flow, opens the browser, catches the callback,
// writes credentials. The host's only job is to spawn the spec.

/// Fill in a runnable terminal-auth spec for the auto-managed built-ins.
///
/// Cursor / OpenCode / Kilo advertise an auth method but no
/// `_meta.terminal-auth`, so `terminal_command` arrives `None` and the whole
/// sign-in path dead-ends: `agents_run_auth_method` rejects the method, the UI
/// has no command to offer, and the user can't fall back to a shell either
/// because Atlas downloaded the CLI into its own app-data dir instead of onto
/// `PATH`. Pairing the resolved binary with the agent's documented login argv
/// (`atlas_acp::builtin_login_args`) makes the existing runner work unchanged.
///
/// The binary is resolved through `login_binary_path`, which mirrors spawn
/// precedence — the user's own `PATH` install first, Atlas's download second.
/// That ordering is what fixes the PATH-installed-Cursor dead-end: on such a
/// machine nothing is ever downloaded, so the old managed-only lookup found
/// nothing and sign-in was impossible.
///
/// A spec the adapter DID supply always wins — this only fills a hole.
///
/// Stays sync (cached discovery state, never a cold probe) because
/// `agents_list_auth_methods` is a sync command; both it and
/// `agents_run_auth_method` funnel through here, so what the UI offers is
/// always exactly what runs.
/// Fill in a runnable login command only where the agent could not supply one
/// (R3, `plans/atlas-acp-auth-login-loop.md`).
///
/// The rule is narrower than "fill every empty slot", because after R2 the
/// methods carry a `kind` and filling blindly would misrepresent them:
///
/// - **Any terminal-capable method present → change nothing.** The adapter knows
///   its own binary; claude-agent-acp ships a fully-resolved
///   `_meta["terminal-auth"]` command that our `builtin_login_args` guess would
///   only degrade.
/// - **Otherwise, fill any method that has no command** — deliberately NOT
///   restricted to `terminal`-kind methods. Cursor advertises `cursor_login`
///   with no `type` at all, which reads as `agent` ("just call authenticate"),
///   yet that path empirically dead-ends and only the CLI login works. Gating
///   on kind here would regress a flow that is known to work, so the evidence
///   wins over the taxonomy. Codex is unaffected either way: it has no
///   `login_args` in the builtin table, so it returns above untouched.
/// - **No methods at all** → synthesize one from the builtin table, so `/login`
///   has something to offer instead of the frontend special-casing agents by
///   name.
fn enrich_auth_methods(
    plugin_id: Option<&str>,
    methods: Vec<AuthMethodWire>,
    registry: &atlas_registry::RegistryStore,
) -> Vec<AuthMethodWire> {
    let Some(plugin_id) = plugin_id else {
        return methods;
    };
    // Adapter data wins outright.
    if methods.iter().any(AuthMethodWire::is_terminal_capable) {
        return methods;
    }
    let Some(login_args) = atlas_acp::builtin_login_args(plugin_id) else {
        return methods;
    };
    // Absent when the CLI is neither installed nor downloaded (acquisition
    // failed, or discovery hasn't run yet) — leave the methods untouched
    // rather than inventing a command that isn't there.
    let Some(binary) = registry.login_binary_path(plugin_id) else {
        return methods;
    };
    let args: Vec<String> = login_args.iter().map(|s| (*s).to_string()).collect();

    if methods.is_empty() {
        return vec![AuthMethodWire {
            id: format!("{plugin_id}-login"),
            name: "Sign in".to_string(),
            description: None,
            kind: atlas_acp::AuthMethodKind::Terminal,
            env_vars: Vec::new(),
            link: None,
            args: args.clone(),
            terminal_command: Some(binary),
            terminal_args: Some(args),
            terminal_label: Some("Sign in".to_string()),
            api_key_provider: None,
        }];
    }

    methods
        .into_iter()
        .map(|mut m| {
            if m.terminal_command.is_none() {
                m.terminal_command = Some(binary.clone());
                m.terminal_args = Some(args.clone());
                if m.terminal_label.is_none() {
                    m.terminal_label = Some(m.name.clone());
                }
            }
            m
        })
        .collect()
}

/// One environment variable an agent's auth method wants, and whether the
/// system already provides it (R5).
///
/// Deliberately value-free: the UI renders a green/red checklist, and a command
/// that returned the secret would put it in every IPC log and devtools trace for
/// no gain.
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
/// satisfies (R5).
///
/// Covers two shapes: typed `env_var` methods (spec) and codex's proprietary
/// `_meta["api-key"].provider` hint, which is the only api-key signal any
/// adapter actually ships today (R1) — mapping it through the BYOK provider
/// table gives those methods the same checklist a typed method would get.
#[tauri::command]
pub fn agents_auth_env_status(
    agent_id: AgentId,
    manager: State<'_, AgentManager>,
    registry: State<'_, atlas_registry::RegistryStore>,
) -> Result<Vec<AuthEnvStatus>, String> {
    let methods = manager.auth_methods(agent_id).map_err(|e| e.to_string())?;
    let methods = enrich_auth_methods(
        manager.plugin_id_for_agent(agent_id).as_deref(),
        methods,
        &registry,
    );

    let mut wanted: Vec<(String, String, Option<String>, bool)> = Vec::new();
    for m in &methods {
        for v in &m.env_vars {
            wanted.push((m.id.clone(), v.name.clone(), v.label.clone(), v.optional));
        }
        if let Some(provider) = &m.api_key_provider {
            for var in super::byok::env_vars_for_provider(provider) {
                wanted.push((m.id.clone(), (*var).to_string(), None, false));
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

#[tauri::command]
pub fn agents_list_auth_methods(
    agent_id: AgentId,
    manager: State<'_, AgentManager>,
    registry: State<'_, atlas_registry::RegistryStore>,
) -> Result<Vec<AuthMethodWire>, String> {
    let methods = manager.auth_methods(agent_id).map_err(|e| e.to_string())?;
    Ok(enrich_auth_methods(
        manager.plugin_id_for_agent(agent_id).as_deref(),
        methods,
        &registry,
    ))
}

#[derive(Debug, Clone, Serialize)]
struct AuthRunDone {
    success: bool,
    exit_code: Option<i32>,
    message: Option<String>,
    /// Which agent this run belonged to, and which run it was (R4). Without
    /// these, two agents signing in at once cross-talk: the frontend resolved
    /// on ANY `:done` event, so the first CLI to finish completed both flows.
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
    let url = rest[..end].trim_end_matches(|c| matches!(c, '.' | ',' | ')' | ']' | ';' | ':'));
    (url.len() > "https://".len()).then(|| url.to_string())
}

#[tauri::command]
pub async fn agents_run_auth_method(
    agent_id: AgentId,
    method_id: String,
    app: AppHandle,
) -> Result<String, String> {
    let manager: State<'_, AgentManager> = app.state();
    let registry: State<'_, atlas_registry::RegistryStore> = app.state();
    let methods = manager.auth_methods(agent_id).map_err(|e| e.to_string())?;
    // Same enrichment the list command applies, so what the UI offers is
    // exactly what runs here.
    let methods = enrich_auth_methods(
        manager.plugin_id_for_agent(agent_id).as_deref(),
        methods,
        &registry,
    );
    let method = methods
        .into_iter()
        .find(|m| m.id == method_id)
        .ok_or_else(|| format!("auth method not found: {method_id}"))?;

    let command = method
        .terminal_command
        .ok_or_else(|| format!("auth method {method_id} has no terminal-auth spec"))?;
    let args = method.terminal_args.unwrap_or_default();

    // Scopes every event this run emits. Returned to the caller so it can
    // filter, rather than resolving on whichever run finishes first.
    let run_id = uuid::Uuid::new_v4().to_string();

    tracing::info!(
        target: "atlas::agents",
        "running auth method `{method_id}` via `{command}` (args: {args:?}, run {run_id})"
    );

    let mut cmd = AsyncCommand::new(&command);
    cmd.args(&args);
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
mod acquire_progress_tests {
    use super::acquire_pct_to_emit;
    use std::sync::atomic::AtomicU64;

    /// Replays a download the way `ensure_binary` drives the callback (one call
    /// per HTTP chunk) and counts how many events would reach the UI.
    fn emits_for(total: u64, chunk: u64) -> Vec<u64> {
        let last = AtomicU64::new(u64::MAX);
        let mut out = Vec::new();
        let mut received = 0;
        while received < total {
            received = (received + chunk).min(total);
            if let Some(pct) = acquire_pct_to_emit(received, Some(total), &last) {
                out.push(pct);
            }
        }
        out
    }

    #[test]
    fn collapses_a_per_chunk_flood_into_one_event_per_percent() {
        // Cursor's real archive: 77_650_670 bytes in ~1.4 KB chunks = ~56k
        // callbacks. Unthrottled that many IPC emits would jank the UI.
        let emits = emits_for(77_650_670, 1_369);
        assert_eq!(emits.len(), 101, "0..=100 inclusive, once each");
        assert_eq!(emits.first(), Some(&0));
        assert_eq!(emits.last(), Some(&100), "always finishes at 100%");
        assert!(emits.windows(2).all(|w| w[1] > w[0]), "monotonic, no repeats");
    }

    #[test]
    fn a_tiny_download_still_reports_completion() {
        // Fewer chunks than percents: every chunk is a new percent, and the
        // pill must still reach 100 so the UI can settle.
        let emits = emits_for(300, 100);
        assert_eq!(emits, vec![33, 66, 100]);
    }

    #[test]
    fn without_a_content_length_nothing_is_emitted() {
        // No total → no percent to render; the pill falls back to its
        // indeterminate "Setting up X…" text instead of showing a bogus 0%.
        let last = AtomicU64::new(u64::MAX);
        assert_eq!(acquire_pct_to_emit(1_024, None, &last), None);
        assert_eq!(acquire_pct_to_emit(2_048, Some(0), &last), None);
    }
}

#[cfg(test)]
mod cmd_error_tests {
    use super::CmdError;

    fn wire(e: CmdError) -> serde_json::Value {
        serde_json::to_value(e).unwrap()
    }

    #[test]
    fn an_auth_failure_carries_the_auth_kind() {
        // The case this whole type exists for: Cursor rejecting `session/new`
        // before any turn starts, so no `atlas:auth-required` ever fires.
        let e: CmdError = atlas_agents::Error::Acp(atlas_acp::AcpError::other(
            "Authentication required. Please run `cursor-agent login`.",
        ))
        .into();
        let v = wire(e);
        assert_eq!(v["kind"], "auth");
        assert!(v["message"].as_str().unwrap().contains("Authentication required"));
    }

    #[test]
    fn the_shape_is_camel_case_message_plus_kind() {
        // The frontend reads `.message`; stringifying the object would render
        // "[object Object]".
        let v = wire(CmdError::new("boom", atlas_acp::ErrorClass::Fatal));
        assert_eq!(v["message"], "boom");
        assert_eq!(v["kind"], "fatal");
        assert_eq!(v.as_object().unwrap().len(), 2);
    }

    #[test]
    fn non_acp_failures_still_classify() {
        assert_eq!(
            wire(atlas_agents::Error::WorkerGone.into())["kind"],
            "process_dead"
        );
        assert_eq!(
            wire(atlas_agents::Error::UnknownPlugin("nope".into()).into())["kind"],
            "fatal"
        );
        assert_eq!(
            wire(atlas_agents::Error::other("rate limit exceeded").into())["kind"],
            "transient"
        );
        assert_eq!(wire(atlas_agents::Error::other("weird").into())["kind"], "unknown");
    }
}

#[cfg(test)]
mod auth_enrichment_tests {
    use super::enrich_auth_methods;
    use atlas_agents::AuthMethodWire;

    /// Exactly what `cursor-agent acp` returns from `initialize` — captured
    /// live: an auth method with NO `_meta.terminal-auth`, which is why the
    /// sign-in path dead-ended before this enrichment existed.
    fn cursor_method() -> AuthMethodWire {
        AuthMethodWire {
            id: "cursor_login".into(),
            name: "Cursor Login".into(),
            description: Some("Authenticate using existing Cursor login credentials.".into()),
            // No `type` on the wire → `Agent` (R2). Cursor still needs the CLI
            // login run, which is why enrichment does not gate on kind.
            kind: atlas_acp::AuthMethodKind::Agent,
            env_vars: Vec::new(),
            link: None,
            args: Vec::new(),
            terminal_command: None,
            terminal_args: None,
            terminal_label: None,
            api_key_provider: None,
        }
    }

    fn store() -> atlas_registry::RegistryStore {
        atlas_registry::RegistryStore::new(std::env::temp_dir().join("atlas-auth-test"))
    }

    #[test]
    fn without_an_acquired_binary_nothing_is_invented() {
        // Nothing installed and nothing downloaded → leave the method exactly
        // as the adapter sent it, rather than pointing the runner at a path
        // that doesn't exist.
        let out = enrich_auth_methods(Some("cursor"), vec![cursor_method()], &store());
        assert!(out[0].terminal_command.is_none());
    }

    /// The PATH-installed-Cursor dead-end. On a machine that installed the CLI
    /// by hand, Atlas downloads nothing — so the old managed-binary-only
    /// lookup found nothing and sign-in was impossible. `login_binary_path`
    /// resolves the discovered install instead.
    #[test]
    fn a_discovered_path_binary_enriches_when_nothing_was_downloaded() {
        let store = store();
        store.set_discovered_for_tests(vec![atlas_registry::DiscoveredAgent {
            spec_id: "cursor".into(),
            program: "/usr/local/bin/cursor-agent".into(),
            args: vec!["acp".into()],
            env: Default::default(),
            display_name: "Cursor".into(),
            help_url: None,
        }]);
        let out = enrich_auth_methods(Some("cursor"), vec![cursor_method()], &store);
        assert_eq!(
            out[0].terminal_command.as_deref(),
            Some("/usr/local/bin/cursor-agent")
        );
        assert_eq!(out[0].terminal_args.as_ref().unwrap(), &["login"]);
        // The label falls back to the method's own name so the UI has
        // something to render on the button.
        assert_eq!(out[0].terminal_label.as_deref(), Some("Cursor Login"));
    }

    #[test]
    fn agents_that_are_not_auto_managed_are_untouched() {
        for id in ["claude-code-ts", "codex", "cersei", "amp-acp"] {
            let out = enrich_auth_methods(Some(id), vec![cursor_method()], &store());
            assert!(out[0].terminal_command.is_none(), "{id} must not be enriched");
        }
        // …and an unknown agent (no plugin id resolved) too.
        let out = enrich_auth_methods(None, vec![cursor_method()], &store());
        assert!(out[0].terminal_command.is_none());
    }

    /// R3: when the adapter supplied a usable command for ANY method, none of
    /// the others get a guessed one either — a mixed list must not end up half
    /// adapter-resolved and half `builtin_login_args` guesswork.
    #[test]
    fn one_adapter_supplied_method_suppresses_enrichment_of_its_siblings() {
        let store = store();
        store.set_discovered_for_tests(vec![atlas_registry::DiscoveredAgent {
            spec_id: "cursor".into(),
            program: "/usr/local/bin/cursor-agent".into(),
            args: vec!["acp".into()],
            env: Default::default(),
            display_name: "Cursor".into(),
            help_url: None,
        }]);
        let mut adapter_supplied = cursor_method();
        adapter_supplied.id = "real".into();
        adapter_supplied.terminal_command = Some("/adapter/node".into());
        let out = enrich_auth_methods(
            Some("cursor"),
            vec![adapter_supplied, cursor_method()],
            &store,
        );
        assert_eq!(out[0].terminal_command.as_deref(), Some("/adapter/node"));
        assert!(
            out[1].terminal_command.is_none(),
            "sibling must stay untouched once the adapter proved it knows its own binary"
        );
    }

    /// R3: agents that advertise no methods at all still need `/login` to offer
    /// something — that is what removes the per-agent special cases in TS.
    #[test]
    fn an_agent_advertising_no_methods_gets_one_synthesized() {
        let store = store();
        store.set_discovered_for_tests(vec![atlas_registry::DiscoveredAgent {
            spec_id: "cursor".into(),
            program: "/usr/local/bin/cursor-agent".into(),
            args: vec!["acp".into()],
            env: Default::default(),
            display_name: "Cursor".into(),
            help_url: None,
        }]);
        let out = enrich_auth_methods(Some("cursor"), Vec::new(), &store);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, atlas_acp::AuthMethodKind::Terminal);
        assert_eq!(
            out[0].terminal_command.as_deref(),
            Some("/usr/local/bin/cursor-agent")
        );
        assert_eq!(out[0].terminal_args.as_ref().unwrap(), &["login"]);
    }

    /// Nothing to synthesize FROM: no builtin login args means no invention.
    #[test]
    fn an_agent_with_no_methods_and_no_login_args_stays_empty() {
        assert!(enrich_auth_methods(Some("codex"), Vec::new(), &store()).is_empty());
    }

    #[test]
    fn an_adapter_supplied_spec_always_wins() {
        let mut m = cursor_method();
        m.terminal_command = Some("/adapter/own/node".into());
        m.terminal_args = Some(vec!["--cli".into(), "auth".into()]);
        let out = enrich_auth_methods(Some("cursor"), vec![m], &store());
        assert_eq!(out[0].terminal_command.as_deref(), Some("/adapter/own/node"));
        assert_eq!(out[0].terminal_args.as_ref().unwrap(), &["--cli", "auth"]);
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

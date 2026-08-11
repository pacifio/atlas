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
        {
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
    let manager = AgentManager::new(sink, config_dir);
    app.manage(manager);

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

#[tauri::command]
pub async fn agents_spawn(
    plugin_id: String,
    manager: State<'_, AgentManager>,
) -> Result<AgentInfo, String> {
    manager.spawn(&plugin_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agents_kill(agent_id: AgentId, manager: State<'_, AgentManager>) -> Result<(), String> {
    manager.kill(agent_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agents_new_session(
    agent_id: AgentId,
    cwd: PathBuf,
    manager: State<'_, AgentManager>,
) -> Result<SessionKey, String> {
    manager
        .new_session(agent_id, cwd)
        .await
        .map_err(|e| e.to_string())
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
    manager: State<'_, AgentManager>,
) -> Result<Vec<Message>, String> {
    manager
        .replay_transcript(&plugin_id, &cwd, &session_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agents_load_session(
    agent_id: AgentId,
    session_id: SessionId,
    cwd: PathBuf,
    manager: State<'_, AgentManager>,
) -> Result<SessionKey, String> {
    manager
        .load_session(agent_id, session_id, cwd)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agents_snapshot(
    key: SessionKey,
    manager: State<'_, AgentManager>,
) -> Result<SessionSnapshot, String> {
    manager.snapshot(&key).map_err(|e| e.to_string())
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
    manager: State<'_, AgentManager>,
    sharing: State<'_, MemorySharingState>,
    app: AppHandle,
) -> Result<(), String> {
    // `agent_turn_started` is NOT emitted here. It used to be, but this runs
    // before `start_turn`, so it could not know the `turn_seq` that joins a
    // start to its completion — and a send that supersedes a running turn
    // counted twice. `AnalyticsMiddleware` emits it off `Status{Running}`
    // instead, which is the actual turn boundary.

    // Stage image attachments up front so every send exit below (bare or
    // memory-prefixed) drains them into this turn's prompt. Best-effort: a
    // staging failure must not block the text send.
    if let Some(atts) = attachments {
        if !atts.is_empty() {
            let _ = manager.stage_attachments(&key, atts);
        }
    }

    // Resolve the project cwd. Unknown session → fail with the SAME error
    // shape `manager.send` produces, without attempting a send that would
    // skip memory injection (one condition, one behavior — L5).
    let Ok(snapshot) = manager.snapshot(&key) else {
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

    // No cwd or sharing disabled → bare send (no injection).
    if cwd.is_empty() || !sharing.is_enabled(&cwd) {
        return manager.send(&key, text).map_err(|e| e.to_string());
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
        return manager.send(&key, text).map_err(|e| e.to_string());
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
    manager.send(&key, prefixed).map_err(|e| e.to_string())
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

#[tauri::command]
pub fn agents_list_auth_methods(
    agent_id: AgentId,
    manager: State<'_, AgentManager>,
) -> Result<Vec<AuthMethodWire>, String> {
    manager.auth_methods(agent_id).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
struct AuthRunDone {
    success: bool,
    exit_code: Option<i32>,
    message: Option<String>,
}

#[tauri::command]
pub async fn agents_run_auth_method(
    agent_id: AgentId,
    method_id: String,
    app: AppHandle,
) -> Result<(), String> {
    let manager: State<'_, AgentManager> = app.state();
    let methods = manager.auth_methods(agent_id).map_err(|e| e.to_string())?;
    let method = methods
        .into_iter()
        .find(|m| m.id == method_id)
        .ok_or_else(|| format!("auth method not found: {method_id}"))?;

    let command = method
        .terminal_command
        .ok_or_else(|| format!("auth method {method_id} has no terminal-auth spec"))?;
    let args = method.terminal_args.unwrap_or_default();

    tracing::info!(
        target: "atlas::agents",
        "running auth method `{method_id}` via `{command}` (args: {args:?})"
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
    if let Some(out) = stdout {
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "atlas::agents::auth_stdout", "{line}");
                let _ = app_for_stdout.emit(
                    "atlas:auth-run:progress",
                    serde_json::json!({ "stream": "stdout", "line": line }),
                );
            }
        });
    }
    let app_for_stderr = app.clone();
    if let Some(err) = stderr {
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "atlas::agents::auth_stderr", "{line}");
                let _ = app_for_stderr.emit(
                    "atlas:auth-run:progress",
                    serde_json::json!({ "stream": "stderr", "line": line }),
                );
            }
        });
    }

    let app_for_wait = app.clone();
    tokio::spawn(async move {
        let result = child.wait().await;
        let payload = match result {
            Ok(status) => AuthRunDone {
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
                success: false,
                exit_code: None,
                message: Some(format!("wait failed: {e}")),
            },
        };
        let _ = app_for_wait.emit("atlas:auth-run:done", payload);
    });

    Ok(())
}

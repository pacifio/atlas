//! atlas-cersei — Atlas's native, in-process coding agent on the Cersei SDK.
//!
//! Unlike the Claude Code / Codex agents (external subprocesses speaking ACP),
//! this agent runs *inside* the Atlas process: it drives a `cersei::Agent`
//! directly and **adapts Cersei's `AgentEvent` stream into the same `AcpEvent`
//! contract** the ACP driver emits ([`atlas_acp::EventSink`]). That lets
//! `atlas-agents`' dispatch/state/UI path consume it with zero changes —
//! streaming text, thinking, tool cards, permission prompts, and turn lifecycle
//! all flow through the existing pipeline.
//!
//! `CerseiRuntime` mirrors the slice of `atlas_acp::AgentRegistry`'s API that
//! `atlas-agents`' manager + worker call, so a thin `AgentBackend` adapter in
//! atlas-agents can route to either backend.

mod context;
mod mcp;
pub mod tools;
mod memory;
mod provider;
mod store;

pub use memory::{MemDoc, MemorySearchFn, register_memory_search};

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use agent_client_protocol::schema::v1 as acp_schema;
use async_trait::async_trait;
use atlas_acp::{AcpError, AcpEvent, AgentId, AgentInfo, EventSink, NewSessionInfo, Result, SessionId};
use cersei::prelude::{PermissionDecision as CerseiDecision, PermissionPolicy, PermissionRequest};
use cersei::tools::PermissionLevel;
use cersei::types::Message;
use cersei_agent::delegate::{ProviderFactory, ToolsetFactory};
use cersei_agent::delegate_tool::DelegateTool;
use cersei_agent::system_prompt::{SystemPromptOptions, build_system_prompt};
use dashmap::DashMap;
use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

// Compile-time guard: cersei-agent MUST resolve to the vendored, patched
// crate ([patch.crates-io] → vendor/cersei-agent). The crates.io release
// never races tool execution against the cancel token — without the patch a
// running Bash/Edit completes (and its writes land) after Stop, and a
// cancelled tool round leaves orphaned tool_use blocks in provider history.
const _CERSEI_CANCEL_PATCH_GUARD: &str = cersei_agent::ATLAS_CANCEL_PATCH;
use uuid::Uuid;

pub use store::SessionMeta;
pub use store::{corpus_sessions, project_sessions_dir, CorpusSession};

/// The plugin id the native agent registers under (matches the frontend
/// `AGENT_PLUGIN_ID.cersei`).
pub const CERSEI_PLUGIN_ID: &str = "cersei";
/// Display name shown in the agent picker / marks.
pub const CERSEI_DISPLAY_NAME: &str = "Atlas";

/// Atlas-specific behavioral guidance, injected as `custom_system_prompt` into
/// `build_system_prompt` (which also emits Cersei's base capabilities + the
/// dynamic git/cwd/docs context sections).
const ATLAS_GUIDANCE: &str = r#"You are Atlas, a coding agent embedded natively in the Atlas IDE. You run in-process — your tool calls are local and near-instant, so reach for them freely. You help the user read, write, and reason about their codebase.

# Exploration — understand before you act
- Read the codebase first; resist easy assumptions. Let the shape of the existing system teach you how to move. Never guess a file's location, an API's signature, or a pattern — verify it with a tool.
- Search to discover, read to confirm. Use Glob/List/code_search to find candidates, Grep to inspect them, then Read the files that matter.
- Use the dedicated file tools, not the shell: Read (not cat/head/tail), Grep (not cat|grep), Glob (not find), List (not ls), Edit (not sed/awk) or Write for a full rewrite. Edit tolerates minor indentation/whitespace drift, so prefer it over shelling out to patch files. Bash starts each call in the project root — pass a relative path, don't rely on a prior `cd`.
- Filter early: combine a grep pattern with a path/type filter rather than searching everything and sifting noise.
- Issue independent tool calls in parallel in a single step (e.g. several reads, or a grep plus a glob). Only serialize when a later call genuinely depends on an earlier result. Parallel calls are cheap here — use them.
- For a substantial change, trace the full call path and the existing conventions before editing.

# Planning & todos
- For any multi-step or non-trivial task (roughly 3+ steps, or work that spans several files), use the TodoWrite tool to lay out a short, concrete plan and keep the user oriented. Skip it for simple one- or two-step tasks — a todo list there is just noise.
- Write atomic todos: one clear action each. Mark exactly one item in_progress at a time, and flip it to completed the moment it's done — never batch-complete at the end. Don't leave the turn with todos unfinished.
- In plan mode you may only read and search — no edits, no commands, nothing that mutates files. Explore non-destructively, then present a concrete plan and exit plan mode when the user approves. A request to "do it" while in plan mode means plan the doing, not perform it.

# Parallel sub-agents (delegate)
- You can spawn parallel sub-agents with the `delegate` tool. Each child runs in its own fresh context with the coding tools and reports a summary back; children cannot delegate further. Use the `tasks` array to fan several out at once — they run concurrently.
- Delegate when the work splits into independent, well-bounded pieces that can run in parallel without stepping on each other: e.g. researching several subsystems at once, or implementing disjoint slices of a change with non-overlapping file scopes. Each task prompt must be fully self-contained — the child can't see this conversation.
- Keep the critical-path step yourself; delegate the sidecar work. Don't delegate a tightly-coupled next step you're blocked on, and don't delegate trivial one-shot tasks you can just do. After children return, integrate their results — don't redo their work.

# Project memory
- When available, the `search_memory` tool recalls Atlas's indexed project memory — prior decisions, conventions, feature notes, and codebase summaries. Reach for it BEFORE asking the user about project history or established patterns, and to ground a change in how this codebase already does things.

# Doing, not explaining
- Assume the user wants you to make the change and run the work needed to solve the problem — unless they explicitly ask for a plan, ask a question, or are brainstorming. Don't stop at a proposal; carry the task to a finished, verified state within the turn when feasible.
- Match the surrounding code: its naming, idiom, and comment density. Do NOT add comments that merely narrate what the code does — comments explain non-obvious intent, trade-offs, or constraints, nothing more.
- Prefer editing files with the file tools over printing large code blocks. The user is on the same machine — never tell them to copy or save a file you can write yourself.

# Communicating
- Be concise. For simple work, a sentence or two — don't pad with bullets unless structure genuinely helps.
- While exploring, drop brief one- or two-sentence notes on what you're learning, not just what you're doing. Before a non-trivial edit, say what you're about to change and why.
- Don't write "Let me read the file." before a tool call — just make the call; the UI shows it. No colons trailing into a tool call.
- Report outcomes faithfully: if something failed, say so with the evidence; if you skipped a step, note it; when it's done and verified, state it plainly without hedging."#;

/// One historical conversation item, in a UI-neutral shape so `atlas-agents`
/// can rebuild its own `Message` type on resume without depending on Cersei.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReplayItem {
    User { text: String },
    Assistant { text: String },
    Thinking { text: String },
    Tool {
        id: String,
        name: String,
        input: serde_json::Value,
        result: Option<String>,
        is_error: bool,
    },
}

// ─── Runtime ──────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct CerseiRuntime {
    inner: Arc<Inner>,
}

struct Inner {
    /// App config dir (holds `byok-keys.json` + `cersei-sessions/`).
    config_dir: PathBuf,
    agents: DashMap<AgentId, AgentEntry>,
    /// MCP servers, connected once on first use. `None` = none configured /
    /// none connected. Connecting spawns subprocess servers, so it's cached for
    /// the app session (edits to `mcp-servers.json` apply on restart).
    mcp: tokio::sync::OnceCell<Option<Arc<mcp::McpHandle>>>,
}

struct AgentEntry {
    sink: Arc<dyn EventSink>,
    sessions: DashMap<String, Arc<SessionEntry>>,
}

struct SessionEntry {
    #[allow(dead_code)]
    session_id: String,
    cwd: String,
    history: Mutex<Vec<Message>>,
    provider: Mutex<String>,
    model: Mutex<String>,
    /// Permission mode id (default / acceptEdits / plan / bypass).
    mode: Mutex<String>,
    /// Reasoning-effort level (low/medium/high/max), or None for the model
    /// default. Only applied for providers that support a thinking budget
    /// (Anthropic) — ignored elsewhere.
    effort: Mutex<Option<String>>,
    /// Whether RTK tool-output compression is enabled (token savings). Default on.
    compress: Mutex<bool>,
    /// Cumulative token/cost usage across the session's turns — persisted so the
    /// "tokens processed" figure survives a reload.
    usage: Mutex<store::StoredUsage>,
    /// Cancellation token for the in-flight turn, if any.
    cancel: Mutex<Option<CancellationToken>>,
    /// Pending permission requests awaiting a UI decision.
    pending: DashMap<Uuid, oneshot::Sender<CerseiDecision>>,
    cancelled: AtomicBool,
    /// Monotonic turn counter, bumped by `mark_turn_started`. Stamped onto
    /// every event the turn emits so the session actor can drop stragglers
    /// from a superseded turn. 0 = no turn has started yet (events unstamped).
    turn_seq: AtomicU64,
    /// True while a `send_prompt` turn is executing. A second concurrent
    /// send is rejected instead of racing the first turn's history
    /// clone/write (last-writer-wins silently lost the other turn's
    /// messages from context and disk).
    busy: AtomicBool,
}

/// Clears `SessionEntry::busy` AND the turn's cancel token on every exit
/// path of `send_prompt` (success, error, panic-unwind through the actor's
/// supervisor). The token must not outlive the turn: a later `cancel_turn`
/// finding a dead turn's token would cancel nothing real, and the next
/// turn installs a fresh one atomically.
struct BusyGuard(Arc<SessionEntry>);
impl Drop for BusyGuard {
    fn drop(&mut self) {
        *self.0.cancel.lock() = None;
        self.0.busy.store(false, Ordering::SeqCst);
    }
}

/// Wraps the host sink and stamps every event emitted through it with the
/// producing turn's identity, so the adapter helpers below don't have to
/// thread the stamp through every call.
struct TurnStampedSink {
    inner: Arc<dyn EventSink>,
    turn: Option<u64>,
}
impl EventSink for TurnStampedSink {
    fn emit(&self, agent_id: AgentId, event: AcpEvent, turn: Option<u64>) {
        self.inner.emit(agent_id, event, turn.or(self.turn));
    }
}

impl CerseiRuntime {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            inner: Arc::new(Inner {
                config_dir,
                agents: DashMap::new(),
                mcp: tokio::sync::OnceCell::new(),
            }),
        }
    }

    /// Register a native agent. No process is spawned — this just allocates an
    /// id and stashes the event sink the turn loop will emit through.
    pub fn spawn(&self, sink: Arc<dyn EventSink>) -> AgentInfo {
        let agent_id = AgentId::new();
        self.inner.agents.insert(
            agent_id,
            AgentEntry {
                sink,
                sessions: DashMap::new(),
            },
        );
        AgentInfo {
            agent_id,
            spec_id: CERSEI_PLUGIN_ID.to_string(),
            display_name: CERSEI_DISPLAY_NAME.to_string(),
        }
    }

    pub fn kill(&self, agent_id: AgentId) -> Result<()> {
        self.inner.agents.remove(&agent_id);
        Ok(())
    }

    /// Open a new session. Picks a default provider+model from the configured
    /// BYOK keys and returns the synthesized mode list (ACP `SessionModeState`
    /// shape) so the existing mode picker renders.
    pub fn new_session(&self, agent_id: AgentId, cwd: PathBuf) -> Result<NewSessionInfo> {
        let agent = self.agent(agent_id)?;
        let session_id = Uuid::new_v4().to_string();
        let (provider, model) = self.default_provider_model();
        let entry = Arc::new(SessionEntry {
            session_id: session_id.clone(),
            cwd: cwd.to_string_lossy().into_owned(),
            history: Mutex::new(Vec::new()),
            provider: Mutex::new(provider),
            model: Mutex::new(model),
            mode: Mutex::new("default".into()),
            effort: Mutex::new(None),
            compress: Mutex::new(true),
            usage: Mutex::new(store::StoredUsage::default()),
            cancel: Mutex::new(None),
            pending: DashMap::new(),
            cancelled: AtomicBool::new(false),
            turn_seq: AtomicU64::new(0),
            busy: AtomicBool::new(false),
        });
        agent.sessions.insert(session_id.clone(), entry);
        Ok(NewSessionInfo {
            session_id: SessionId::new(session_id),
            modes: Some(modes_blob("default")),
            models: None,
            // The native agent exposes its knobs (provider/model/effort/
            // compress) through its own composer pills, not ACP config
            // options.
            config_options: None,
        })
    }

    /// Resume a stored session: restore its history into the runtime (for
    /// context continuation) and return its mode blob.
    pub fn load_session(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        cwd: PathBuf,
    ) -> Result<atlas_acp::LoadedSessionInfo> {
        let agent = self.agent(agent_id)?;
        let sid = session_id_str(&session_id);
        let cwd_str = cwd.to_string_lossy().into_owned();
        let stored = store::load(&self.inner.config_dir, &cwd_str, &sid);
        let (provider, model, history, usage) = match stored {
            Some(doc) => (doc.provider, doc.model, doc.messages, doc.usage),
            None => {
                let (p, m) = self.default_provider_model();
                (p, m, Vec::new(), store::StoredUsage::default())
            }
        };
        let entry = Arc::new(SessionEntry {
            session_id: sid.clone(),
            cwd: cwd_str,
            history: Mutex::new(history),
            provider: Mutex::new(provider),
            model: Mutex::new(model),
            mode: Mutex::new("default".into()),
            effort: Mutex::new(None),
            compress: Mutex::new(true),
            usage: Mutex::new(usage),
            cancel: Mutex::new(None),
            pending: DashMap::new(),
            cancelled: AtomicBool::new(false),
            turn_seq: AtomicU64::new(0),
            busy: AtomicBool::new(false),
        });
        agent.sessions.insert(sid, entry);
        Ok(atlas_acp::LoadedSessionInfo {
            modes: Some(modes_blob("default")),
            config_options: None,
        })
    }

    /// UI-facing transcript for a stored session (for replay on resume).
    pub fn replay_session(&self, cwd: &str, session_id: &str) -> Vec<ReplayItem> {
        match store::load_checked(&self.inner.config_dir, cwd, session_id) {
            store::LoadOutcome::Loaded(doc) => {
                let mut items = messages_to_replay(&doc.messages);
                // The stored session's last turn failed: resume shows the
                // failed turn's history AND why it ended (M1), matching the
                // live `turn_failed` rendering ("Error: …").
                if let Some(err) = &doc.turn_error {
                    items.push(ReplayItem::Assistant {
                        text: format!("Error: {err}"),
                    });
                }
                items
            }
            store::LoadOutcome::Missing => Vec::new(),
            // Damaged file: backed up, surfaced, never silently empty (M2).
            store::LoadOutcome::Corrupt { backup_path } => vec![ReplayItem::Assistant {
                text: format!(
                    "⚠ This session's saved transcript was damaged and could not be \
                     read. The original file was backed up to `{backup_path}`; the \
                     session continues fresh from here."
                ),
            }],
        }
    }

    /// List stored sessions for a project (sidebar).
    pub fn list_sessions(&self, cwd: &str) -> Vec<SessionMeta> {
        store::list(&self.inner.config_dir, cwd)
    }

    /// Delete one stored session's transcript (sidebar delete). Guards the
    /// path stays inside the cersei-sessions root; missing file is a no-op.
    pub fn delete_session(
        &self,
        cwd: &str,
        session_id: &str,
    ) -> std::result::Result<(), String> {
        store::delete(&self.inner.config_dir, cwd, session_id)
    }

    pub fn set_session_mode(&self, agent_id: AgentId, session_id: &str, mode_id: String) -> Result<()> {
        let entry = self.session(agent_id, session_id)?;
        *entry.mode.lock() = mode_id;
        Ok(())
    }

    /// Set the session's model. Accepts `"provider/model"` or a bare model id
    /// (keeps the current provider).
    pub fn set_model(&self, agent_id: AgentId, session_id: &str, model: String) -> Result<()> {
        let entry = self.session(agent_id, session_id)?;
        if let Some((prov, m)) = model.split_once('/') {
            // Only treat the prefix as a provider if we recognise it; some model
            // ids legitimately contain a slash (e.g. "Qwen/Qwen3-Coder").
            if provider::default_model_for(prov).is_some() || provider::openai_base_url(prov).is_some() || prov == "anthropic" {
                *entry.provider.lock() = prov.to_string();
                *entry.model.lock() = m.to_string();
                return Ok(());
            }
        }
        *entry.model.lock() = model;
        Ok(())
    }

    /// Set the session's reasoning-effort level (low/medium/high/max), or clear
    /// it with an empty string. Applied as a thinking budget on the next turn
    /// for providers that support it (Anthropic).
    pub fn set_effort(&self, agent_id: AgentId, session_id: &str, effort: String) -> Result<()> {
        let entry = self.session(agent_id, session_id)?;
        *entry.effort.lock() = if effort.trim().is_empty() {
            None
        } else {
            Some(effort)
        };
        Ok(())
    }

    /// Toggle RTK tool-output compression for the session (token savings).
    pub fn set_compress(&self, agent_id: AgentId, session_id: &str, on: bool) -> Result<()> {
        let entry = self.session(agent_id, session_id)?;
        *entry.compress.lock() = on;
        Ok(())
    }

    /// The connected MCP servers, connecting (once) on first call. `None` when
    /// no servers are configured or none connected.
    async fn mcp_handle(&self) -> Option<Arc<mcp::McpHandle>> {
        self.inner
            .mcp
            .get_or_init(|| async {
                mcp::McpHandle::connect(&self.inner.config_dir).await.map(Arc::new)
            })
            .await
            .clone()
    }

    /// Cancel every in-flight turn across every session (app quit): flips the
    /// flags, fires the tokens (tool process groups die), and drains pending
    /// permissions. In-process, so nothing can orphan — this just stops work
    /// fast so quit isn't held up by a running Bash command.
    pub fn cancel_all(&self) {
        for agent in self.inner.agents.iter() {
            for session in agent.sessions.iter() {
                let entry = session.value();
                {
                    let guard = entry.cancel.lock();
                    entry.cancelled.store(true, Ordering::SeqCst);
                    if let Some(token) = guard.as_ref() {
                        token.cancel();
                    }
                }
                let keys: Vec<Uuid> = entry.pending.iter().map(|e| *e.key()).collect();
                for k in keys {
                    if let Some((_, tx)) = entry.pending.remove(&k) {
                        let _ = tx.send(CerseiDecision::Deny("cancelled".into()));
                    }
                }
            }
        }
    }

    /// Bump the session's turn counter and return the new turn identity.
    /// Called by the session actor right before `send_prompt`; the turn's
    /// events are stamped with this value (see `TurnStampedSink`).
    pub fn mark_turn_started(&self, agent_id: AgentId, session_id: &str) -> Result<u64> {
        let entry = self.session(agent_id, session_id)?;
        Ok(entry.turn_seq.fetch_add(1, Ordering::SeqCst) + 1)
    }

    /// Cancel the in-flight turn: flip the flag, drop pending permissions
    /// (so any blocked `check()` resolves), and cancel the agent token.
    pub fn cancel_turn(&self, agent_id: AgentId, session_id: &str) -> Result<()> {
        let entry = self.session(agent_id, session_id)?;
        // Flag + token under ONE lock scope, mirroring the atomic
        // reset+install at the top of `send_prompt`: either this cancel runs
        // first (the flag it sets belongs to the previous turn and is
        // correctly reset by the new install) or it runs after (it finds the
        // live token and interrupts the turn). No interleaving loses a cancel.
        {
            let guard = entry.cancel.lock();
            entry.cancelled.store(true, Ordering::SeqCst);
            if let Some(token) = guard.as_ref() {
                token.cancel();
            }
        }
        let keys: Vec<Uuid> = entry.pending.iter().map(|e| *e.key()).collect();
        for k in keys {
            if let Some((_, tx)) = entry.pending.remove(&k) {
                let _ = tx.send(CerseiDecision::Deny("cancelled".into()));
            }
        }
        Ok(())
    }

    /// Resolve every permission request still pending for a session as
    /// cancelled, returning their ids so the caller can emit
    /// `PermissionResolved` for each. Called by the session actor when a turn
    /// finalizes: a permission outstanding at turn end must not leave a live
    /// modal whose click strands the session (H6/M3).
    pub fn sweep_permissions(&self, agent_id: AgentId, session_id: &str) -> Vec<Uuid> {
        let Ok(entry) = self.session(agent_id, session_id) else {
            return Vec::new();
        };
        let keys: Vec<Uuid> = entry.pending.iter().map(|e| *e.key()).collect();
        let mut swept = Vec::new();
        for k in keys {
            if let Some((_, tx)) = entry.pending.remove(&k) {
                let _ = tx.send(CerseiDecision::Deny("cancelled".into()));
                swept.push(k);
            }
        }
        swept
    }

    /// Resolve a pending permission request raised during a turn.
    pub fn respond_permission(
        &self,
        agent_id: AgentId,
        request_id: Uuid,
        decision: atlas_acp::PermissionDecision,
    ) -> Result<()> {
        let agent = self.agent(agent_id)?;
        // The request id is unique across sessions; find whichever session holds it.
        for s in agent.sessions.iter() {
            if let Some((_, tx)) = s.value().pending.remove(&request_id) {
                let _ = tx.send(map_decision(decision));
                return Ok(());
            }
        }
        Err(AcpError::UnknownPermissionRequest(request_id))
    }

    /// Drive one prompt turn to completion, emitting `AcpEvent`s as it streams.
    /// Returns the lowercased stop-reason token the worker forwards as
    /// `TurnFinished`.
    pub async fn send_prompt(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        text: String,
    ) -> Result<String> {
        let agent = self.agent(agent_id)?;
        let sid = session_id_str(&session_id);
        let entry = self.session(agent_id, &sid)?;
        // Reject a second concurrent turn on this session: both would clone
        // the same history and the last finisher's `history = msgs` + save
        // would silently drop the other turn's messages. The actor serializes
        // sends per session; this is the backstop for any other caller.
        if entry.busy.swap(true, Ordering::SeqCst) {
            return Err(AcpError::other(
                "a turn is already running for this session; cancel it or wait for it to finish",
            ));
        }
        let _busy = BusyGuard(entry.clone());
        // Stamp every event this turn emits with its identity (0 = no
        // mark_turn_started yet → unstamped, e.g. direct runtime callers).
        let turn = {
            let t = entry.turn_seq.load(Ordering::SeqCst);
            (t > 0).then_some(t)
        };
        let sink: Arc<dyn EventSink> = Arc::new(TurnStampedSink {
            inner: agent.sink.clone(),
            turn,
        });

        // Install this turn's cancel token BEFORE any await, atomically with
        // the flag reset (one lock scope, paired with `cancel_turn`). The old
        // order reset the flag at the top but installed the token only after
        // provider/BYOK setup — a Stop landing in that window was erased by
        // the reset or found no token to fire, and the turn ran to completion
        // merely relabeled "cancelled" at the end.
        let token = CancellationToken::new();
        {
            let mut guard = entry.cancel.lock();
            *guard = Some(token.clone());
            entry.cancelled.store(false, Ordering::SeqCst);
        }

        // Resolve provider + key.
        let provider_id = entry.provider.lock().clone();
        let model = entry.model.lock().clone();
        if provider_id.is_empty() || model.is_empty() {
            return Err(AcpError::other(
                "No model selected for the Atlas agent. Add an API key in Settings → API Keys and pick a model.",
            ));
        }
        let api_key = store::byok_get(&self.inner.config_dir, &provider_id).ok_or_else(|| {
            AcpError::other(format!(
                "No API key configured for '{provider_id}'. Add one in Settings → API Keys."
            ))
        })?;
        let provider = provider::build_provider(&provider_id, &api_key, &model).map_err(AcpError::other)?;

        let history = entry.history.lock().clone();
        let mode = entry.mode.lock().clone();
        let effort = entry.effort.lock().clone();
        let compress = *entry.compress.lock();

        let policy = UiPolicy {
            sink: sink.clone(),
            agent_id,
            session_id: session_id.clone(),
            pending: entry.clone(),
            mode,
        };

        // Coding tools + planning (EnterPlanMode / ExitPlanMode / TodoWrite) so
        // the agent can lay out and track a plan; TodoWrite calls are surfaced
        // as a live plan card (see the adapter below), not a raw tool card.
        //
        // Plus the `delegate` tool — parallel in-process sub-agents (like Claude
        // Code's Task / Codex's spawn_agent). Each child gets a fresh
        // conversation + the coding toolset, runs on the SAME provider/model via
        // the factory below, and cannot delegate further (depth-capped). The
        // batch runs children concurrently (default 3 in flight).
        let provider_factory: ProviderFactory = {
            let pid = provider_id.clone();
            let key = api_key.clone();
            let m = model.clone();
            // Fallible: a rebuild error becomes a per-task delegate error
            // (rendered in the tool card) instead of a panic that aborted the
            // whole parent turn through the actor's supervisor (L3).
            Arc::new(move || provider::build_provider(&pid, &key, &m).map_err(|e| e.to_string()))
        };
        // Sub-agents (delegate) get the same Atlas-owned coding toolset.
        let toolset_factory: ToolsetFactory = Arc::new(crate::tools::atlas_coding);

        let mut tools = {
            // Main turn: Bash gets the turn's cancel token so Stop kills the
            // running command's process group (delegate children keep the
            // plain set via `atlas_coding` in the factory below).
            let mut t = crate::tools::atlas_coding_with(Some(token.clone()));
            t.extend(cersei::tools::planning());
            t.push(Box::new(
                DelegateTool::new(provider_factory, toolset_factory).with_model(model.clone()),
            ));
            // Skills: the `Skill` tool surfaces only the skills the user toggled ON
            // for the Atlas agent (read from `.atlas/agent-skills`). Its presence
            // makes `build_system_prompt` add the skills guidance automatically.
            // Main turn only (not the delegate toolset) so sub-agents stay focused.
            t.push(Box::new(crate::tools::skill::AtlasSkillTool));
            // Grounding: expose Atlas's indexed memory as a tool when the Tauri
            // layer has registered a retrieval backend.
            if memory::memory_search_available() {
                t.push(Box::new(memory::SearchMemoryTool));
            }
            t
        };

        // Connect + add MCP server tools (once-cached). Each discovered MCP tool
        // is proxied to the model alongside the built-ins.
        let mcp_handle = self.mcp_handle().await;
        let mcp_instructions: Vec<(String, String)> = match &mcp_handle {
            Some(h) => {
                tools.extend(h.proxy_tools());
                h.server_names
                    .iter()
                    .map(|n| (n.clone(), format!("MCP server `{n}` is connected; its tools are available to you.")))
                    .collect()
            }
            None => Vec::new(),
        };

        // Ground the agent in the repo: git snapshot + cwd + project docs
        // (AGENTS.md / CLAUDE.md) + the tool list, on top of our Atlas-specific
        // guidance. `build_system_prompt` also emits Cersei's base sections.
        let docs = context::project_docs(&entry.cwd);
        let system_prompt = build_system_prompt(&SystemPromptOptions {
            custom_system_prompt: Some(ATLAS_GUIDANCE.to_string()),
            working_directory: Some(entry.cwd.clone()),
            git_status: context::git_snapshot(&entry.cwd),
            memory_content: docs,
            tools_available: tools.iter().map(|t| t.name().to_string()).collect(),
            mcp_instructions,
            has_auto_compact: true,
            ..Default::default()
        });

        let mut builder = cersei::Agent::builder()
            .provider_boxed(provider)
            .tools(tools)
            .working_dir(PathBuf::from(&entry.cwd))
            .with_messages(history)
            .permission_policy(policy)
            .cancel_token(token)
            .system_prompt(system_prompt)
            .model(model.clone())
            .max_turns(50)
            .auto_compact(true)
            // RTK tool-output compression — Minimal when on (safe token savings),
            // Off when the user disabled it.
            .compression_level(if compress {
                cersei_compression::CompressionLevel::Minimal
            } else {
                cersei_compression::CompressionLevel::Off
            });
        // Reasoning effort → thinking budget. Only Anthropic exposes a usable
        // per-request thinking budget today; other providers ignore it, so we
        // only apply it there to avoid surprising behavior.
        if provider_id == "anthropic" {
            if let Some(level) = &effort {
                let budget = cersei_agent::effort::EffortLevel::from_str(level).thinking_budget_tokens();
                builder = builder.thinking_budget(budget);
            }
        }
        let built = builder
            .build()
            .map_err(|e| AcpError::other(format!("build agent: {e}")))?;
        let built = Arc::new(built);

        let mut stream = built.run_stream(&text);
        let mut stop = "end_turn".to_string();
        // TodoWrite tool-call ids — surfaced as plan cards, so their tool
        // start/end are suppressed from the raw tool-card stream.
        let mut todo_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
        // RTK savings accounting: mirror cersei's per-tool-output compression to
        // measure how many tokens it saved this turn (cersei doesn't report it).
        let mut acct = CompressAccount::new(if compress {
            cersei_compression::CompressionLevel::Minimal
        } else {
            cersei_compression::CompressionLevel::Off
        });
        let mut turn_error: Option<String> = None;
        while let Some(ev) = stream.next().await {
            match translate_event(ev, &sink, agent_id, &session_id, &mut todo_ids, &mut acct) {
                TurnStep::Continue => {}
                TurnStep::SetStop(s) => {
                    stop = s;
                    // Incremental persistence at a message boundary: each
                    // completed model round (assistant flush + settled tool
                    // results) hits disk, so an app crash mid-turn loses at
                    // most the round in flight — matching the incremental
                    // JSONL behavior of the Claude path. Cheap: small JSON,
                    // once per model round, atomic rename (store::save).
                    let now = chrono::Utc::now().to_rfc3339();
                    let usage_now = entry.usage.lock().clone();
                    store::save(
                        &self.inner.config_dir,
                        &entry.cwd,
                        &sid,
                        &provider_id,
                        &model,
                        &built.messages(),
                        &now,
                        &usage_now,
                        None,
                    );
                }
                TurnStep::Done(s) => {
                    stop = s;
                    break;
                }
                TurnStep::Failed(e) => {
                    if entry.cancelled.load(Ordering::SeqCst) {
                        stop = "cancelled".to_string();
                        break;
                    }
                    // Do NOT return yet: fall through to the persistence
                    // section so the failed turn's history (user message +
                    // partial assistant + settled tool results) is written
                    // with an error marker (M1 — it used to vanish from both
                    // context and disk).
                    turn_error = Some(e);
                    break;
                }
            }
        }

        if entry.cancelled.load(Ordering::SeqCst) {
            stop = "cancelled".to_string();
        }

        // Report RTK compression savings for the turn (≈ chars/4 tokens).
        let saved_tokens = acct.saved_chars / 4;
        if saved_tokens > 0 {
            sink.emit(
                agent_id,
                AcpEvent::CompressionSaved {
                    session_id: session_id.clone(),
                    saved_tokens,
                },
                None,
            );
        }

        // Fold this turn's usage into the session's cumulative total (cersei's
        // per-turn cumulative counters reset because the agent is rebuilt each
        // turn) so "tokens processed" persists across reloads.
        let usage_snapshot = {
            let mut u = entry.usage.lock();
            u.input_tokens += acct.input_tokens;
            u.output_tokens += acct.output_tokens;
            u.cost += acct.cost;
            u.clone()
        };

        // Persist the updated conversation for resume + context continuation —
        // for FAILED turns too: the user message and any partial progress stay
        // in runtime history (next turn keeps context) and on disk (resume
        // shows the failed turn with its error marker).
        let msgs = built.messages();
        *entry.history.lock() = msgs.clone();
        let now = chrono::Utc::now().to_rfc3339();
        store::save(
            &self.inner.config_dir,
            &entry.cwd,
            &sid,
            &provider_id,
            &model,
            &msgs,
            &now,
            &usage_snapshot,
            turn_error.as_deref(),
        );
        if let Some(e) = turn_error {
            return Err(AcpError::other(e));
        }
        Ok(stop)
    }

    // ── internals ─────────────────────────────────────────────────────────────

    fn agent(&self, agent_id: AgentId) -> Result<dashmap::mapref::one::Ref<'_, AgentId, AgentEntry>> {
        self.inner.agents.get(&agent_id).ok_or(AcpError::UnknownAgent)
    }

    fn session(&self, agent_id: AgentId, session_id: &str) -> Result<Arc<SessionEntry>> {
        let agent = self.agent(agent_id)?;
        agent
            .sessions
            .get(session_id)
            .map(|e| e.value().clone())
            .ok_or(AcpError::UnknownSession)
    }

    /// First configured BYOK provider (by priority) + its default model. Empty
    /// strings when nothing is configured (send_prompt then errors helpfully).
    fn default_provider_model(&self) -> (String, String) {
        let configured = store::byok_providers(&self.inner.config_dir);
        for p in provider::PROVIDER_PRIORITY {
            if configured.iter().any(|c| c == p) {
                if let Some(m) = provider::default_model_for(p) {
                    return (p.to_string(), m.to_string());
                }
            }
        }
        // Fall back to the first configured provider with any known default.
        for c in &configured {
            if let Some(m) = provider::default_model_for(c) {
                return (c.clone(), m.to_string());
            }
        }
        (String::new(), String::new())
    }
}

// ─── Permission policy ────────────────────────────────────────────────────────

/// The four permission behaviors the native agent supports. We map onto these
/// from whatever mode-id string arrives so a bypass/plan/accept id from another
/// agent's vocabulary still does the right thing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ModeKind {
    Ask,
    AcceptEdits,
    Plan,
    Bypass,
}

/// Normalize a mode id to a [`ModeKind`], tolerant of aliases from Claude Code /
/// Codex (e.g. `bypassPermissions`, `danger-full-access`, `read-only`).
fn mode_kind(mode: &str) -> ModeKind {
    let m = mode.to_ascii_lowercase().replace(['-', '_', ' '], "");
    match m.as_str() {
        "bypass" | "bypasspermissions" | "dangerfullaccess" | "fullaccess" | "yolo" => {
            ModeKind::Bypass
        }
        "plan" | "readonly" | "planmode" => ModeKind::Plan,
        "acceptedits" | "accept" | "autoedit" | "autoedits" | "auto" | "edit" => {
            ModeKind::AcceptEdits
        }
        // "default" / "ask" / unknown → prompt.
        _ => ModeKind::Ask,
    }
}

struct UiPolicy {
    sink: Arc<dyn EventSink>,
    agent_id: AgentId,
    session_id: SessionId,
    pending: Arc<SessionEntry>,
    mode: String,
}

#[async_trait]
impl PermissionPolicy for UiPolicy {
    async fn check(&self, request: &PermissionRequest) -> CerseiDecision {
        // Mode shortcuts that don't need a prompt. Normalize first — the mode id
        // can arrive from another agent's vocabulary (Claude's
        // "bypassPermissions", Codex's "danger-full-access", etc.) if a mode
        // picker seeded cross-agent ids, so we match on the normalized KIND
        // rather than the exact cersei id. Without this, "Bypass" silently fell
        // through to prompting on every action.
        match mode_kind(&self.mode) {
            ModeKind::Bypass => return CerseiDecision::Allow,
            ModeKind::Plan => {
                return match request.permission_level {
                    PermissionLevel::None | PermissionLevel::ReadOnly => CerseiDecision::Allow,
                    _ => CerseiDecision::Deny(
                        "Plan mode is read-only — switch modes to make changes.".into(),
                    ),
                };
            }
            ModeKind::AcceptEdits => {
                // Auto-allow file edits/reads; still prompt for shell/dangerous.
                if matches!(
                    request.permission_level,
                    PermissionLevel::None | PermissionLevel::ReadOnly | PermissionLevel::Write
                ) {
                    return CerseiDecision::Allow;
                }
            }
            ModeKind::Ask => {}
        }
        if matches!(request.permission_level, PermissionLevel::Forbidden) {
            return CerseiDecision::Deny("This operation is not permitted.".into());
        }

        // Prompt the UI and block this tool until the user responds.
        let request_id = Uuid::new_v4();
        let (tx, rx) = oneshot::channel();
        self.pending.pending.insert(request_id, tx);
        self.sink.emit(
            self.agent_id,
            AcpEvent::PermissionRequest {
                request_id,
                session_id: self.session_id.clone(),
                tool_call: permission_tool_call(request),
                options: permission_options(),
            },
            None,
        );
        match rx.await {
            Ok(decision) => decision,
            Err(_) => CerseiDecision::Deny("cancelled".into()),
        }
    }
}

fn permission_options() -> Vec<acp_schema::PermissionOption> {
    use acp_schema::{PermissionOption, PermissionOptionKind};
    vec![
        PermissionOption::new("allow_once", "Allow once", PermissionOptionKind::AllowOnce),
        PermissionOption::new(
            "allow_always",
            "Allow for this session",
            PermissionOptionKind::AllowAlways,
        ),
        PermissionOption::new("reject", "Reject", PermissionOptionKind::RejectOnce),
    ]
}

fn permission_tool_call(req: &PermissionRequest) -> acp_schema::ToolCallUpdate {
    let kind = tool_kind(&req.tool_name);
    let v = serde_json::json!({
        "toolCallId": req.id,
        "title": req.tool_name,
        "kind": kind,
        "status": "pending",
        "rawInput": req.tool_input,
    });
    serde_json::from_value(v).unwrap_or_else(|_| {
        acp_schema::ToolCallUpdate::new(req.id.clone(), acp_schema::ToolCallUpdateFields::default())
    })
}

fn map_decision(d: atlas_acp::PermissionDecision) -> CerseiDecision {
    match d {
        atlas_acp::PermissionDecision::Selected { option_id } => match option_id.as_str() {
            "allow_once" => CerseiDecision::AllowOnce,
            "allow_always" => CerseiDecision::AllowForSession,
            _ => CerseiDecision::Deny("Rejected by user".into()),
        },
        atlas_acp::PermissionDecision::Cancelled => CerseiDecision::Deny("cancelled".into()),
    }
}

// ─── Turn-stream event translation ──────────────────────────────────────────

/// Mirrors cersei's per-tool-output RTK compression to measure the tokens it
/// saves this turn (the SDK applies compression but never reports the savings).
struct CompressAccount {
    level: cersei_compression::CompressionLevel,
    saved_chars: u64,
    /// tool-call id → (name, input), captured at ToolStart for the ToolEnd calc.
    inputs: std::collections::HashMap<String, (String, serde_json::Value)>,
    /// Latest cumulative usage seen in a `CostUpdate` this turn — persisted so
    /// "tokens processed" survives reload (cersei rebuilds the agent per turn,
    /// so its cumulative counters reset; we accumulate across turns ourselves).
    input_tokens: u64,
    output_tokens: u64,
    cost: f64,
}

impl CompressAccount {
    fn new(level: cersei_compression::CompressionLevel) -> Self {
        Self {
            level,
            saved_chars: 0,
            inputs: std::collections::HashMap::new(),
            input_tokens: 0,
            output_tokens: 0,
            cost: 0.0,
        }
    }
}

/// Outcome of translating one Cersei `AgentEvent` in the turn loop.
enum TurnStep {
    /// Keep streaming.
    Continue,
    /// Update the running stop reason but keep streaming (multi-turn runs).
    SetStop(String),
    /// Final event — set the stop reason and end the turn.
    Done(String),
    /// The run errored; the caller decides cancel-vs-propagate.
    Failed(String),
}

/// Translate one Cersei `AgentEvent` into the emitted `AcpEvent`(s) and the loop
/// control signal. Pulled out of `send_prompt` so the whole adapter — text,
/// thinking, tool cards, the TodoWrite→plan mapping, and stop-reason handling —
/// is unit-testable with scripted events + a capturing sink, without a provider.
fn translate_event(
    ev: cersei::events::AgentEvent,
    sink: &Arc<dyn EventSink>,
    agent_id: AgentId,
    session_id: &SessionId,
    todo_ids: &mut std::collections::HashSet<String>,
    acct: &mut CompressAccount,
) -> TurnStep {
    use cersei::events::AgentEvent as E;
    match ev {
        E::TextDelta(s) => {
            emit_chunk(sink, agent_id, session_id, "agent_message_chunk", &s);
            TurnStep::Continue
        }
        E::ThinkingDelta(s) => {
            emit_chunk(sink, agent_id, session_id, "agent_thought_chunk", &s);
            TurnStep::Continue
        }
        E::ToolStart { name, id, input } => {
            if name == "TodoWrite" {
                // Surface the todo list as a live plan card, not a tool card.
                todo_ids.insert(id.clone());
                emit_plan(sink, agent_id, session_id, &input);
            } else {
                // Cache (name, input) so ToolEnd can compute compression savings.
                if !acct.level.is_off() {
                    acct.inputs.insert(id.clone(), (name.clone(), input.clone()));
                }
                emit_tool_call(sink, agent_id, session_id, &id, &name, input);
            }
            TurnStep::Continue
        }
        E::ToolEnd {
            id, result, is_error, ..
        } => {
            // TodoWrite already rendered as a plan card on ToolStart; drop its
            // completion so no phantom tool card appears.
            if !todo_ids.contains(&id) {
                emit_tool_update(sink, agent_id, session_id, &id, &result, is_error);
                // Measure what RTK compression would shave off this result —
                // exactly what cersei feeds the model (errors are sent raw).
                if !is_error {
                    if let Some((name, input)) = acct.inputs.remove(&id) {
                        let compressed = cersei_compression::compress_tool_output(
                            &name, &input, &result, acct.level,
                        );
                        acct.saved_chars +=
                            (result.len() as u64).saturating_sub(compressed.len() as u64);
                    }
                }
            }
            TurnStep::Continue
        }
        E::CostUpdate {
            cumulative_cost,
            input_tokens,
            output_tokens,
            ..
        } => {
            // Remember the latest cumulative figures so the caller can fold them
            // into the session's persisted total after the turn.
            acct.input_tokens = input_tokens;
            acct.output_tokens = output_tokens;
            acct.cost = cumulative_cost;
            sink.emit(
                agent_id,
                AcpEvent::Usage {
                    session_id: session_id.clone(),
                    input_tokens,
                    output_tokens,
                    cost: cumulative_cost,
                },
                None,
            );
            TurnStep::Continue
        }
        E::CompactStart { .. } => {
            sink.emit(
                agent_id,
                AcpEvent::Compaction {
                    session_id: session_id.clone(),
                    active: true,
                },
                None,
            );
            TurnStep::Continue
        }
        E::CompactEnd { .. } => {
            sink.emit(
                agent_id,
                AcpEvent::Compaction {
                    session_id: session_id.clone(),
                    active: false,
                },
                None,
            );
            TurnStep::Continue
        }
        E::Retry {
            attempt,
            max_attempts,
            delay_ms,
            last_error,
        } => {
            sink.emit(
                agent_id,
                AcpEvent::Retry {
                    session_id: session_id.clone(),
                    attempt,
                    max_attempts,
                    delay_ms,
                    last_error,
                },
                None,
            );
            TurnStep::Continue
        }
        E::TurnComplete { stop_reason, .. } => TurnStep::SetStop(map_stop(stop_reason).to_string()),
        E::Complete(out) => TurnStep::Done(map_stop(out.stop_reason).to_string()),
        E::Error(e) => TurnStep::Failed(e),
        _ => TurnStep::Continue,
    }
}

// ─── AgentEvent → AcpEvent adapters ─────────────────────────────────────────

fn emit_chunk(sink: &Arc<dyn EventSink>, agent_id: AgentId, session_id: &SessionId, kind: &str, text: &str) {
    let v = serde_json::json!({
        "sessionUpdate": kind,
        "content": { "type": "text", "text": text },
    });
    emit_session_update(sink, agent_id, session_id, v);
}

/// Map a `TodoWrite` tool input (`{ todos: [{ content, status, activeForm }] }`)
/// into an ACP `plan` session update so it renders as a live plan/todo card
/// (the same surface Claude Code's TodoWrite drives) instead of a tool card.
fn emit_plan(sink: &Arc<dyn EventSink>, agent_id: AgentId, session_id: &SessionId, input: &serde_json::Value) {
    let entries: Vec<serde_json::Value> = input
        .get("todos")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .map(|t| {
                    serde_json::json!({
                        "content": t.get("content").and_then(|c| c.as_str()).unwrap_or(""),
                        "priority": "medium",
                        "status": t.get("status").and_then(|s| s.as_str()).unwrap_or("pending"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let v = serde_json::json!({ "sessionUpdate": "plan", "entries": entries });
    emit_session_update(sink, agent_id, session_id, v);
}

fn emit_tool_call(
    sink: &Arc<dyn EventSink>,
    agent_id: AgentId,
    session_id: &SessionId,
    id: &str,
    name: &str,
    input: serde_json::Value,
) {
    let v = serde_json::json!({
        "sessionUpdate": "tool_call",
        "toolCallId": id,
        "title": name,
        "kind": tool_kind(name),
        "status": "in_progress",
        "rawInput": input,
    });
    emit_session_update(sink, agent_id, session_id, v);
}

fn emit_tool_update(
    sink: &Arc<dyn EventSink>,
    agent_id: AgentId,
    session_id: &SessionId,
    id: &str,
    result: &str,
    is_error: bool,
) {
    let v = serde_json::json!({
        "sessionUpdate": "tool_call_update",
        "toolCallId": id,
        "status": if is_error { "failed" } else { "completed" },
        "content": [ { "type": "content", "content": { "type": "text", "text": result } } ],
    });
    emit_session_update(sink, agent_id, session_id, v);
}

fn emit_session_update(
    sink: &Arc<dyn EventSink>,
    agent_id: AgentId,
    session_id: &SessionId,
    v: serde_json::Value,
) {
    match serde_json::from_value::<acp_schema::SessionUpdate>(v) {
        Ok(update) => sink.emit(
            agent_id,
            AcpEvent::SessionUpdate {
                session_id: session_id.clone(),
                update,
            },
            None,
        ),
        Err(e) => tracing::warn!(target: "atlas_cersei::adapter", "session update decode failed: {e}"),
    }
}

/// Map a Cersei tool name to an ACP `ToolKind` token (drives the UI icon).
fn tool_kind(name: &str) -> &'static str {
    let n = name.to_ascii_lowercase();
    if n.contains("read")
        || n.contains("glob")
        || n.contains("grep")
        || n.contains("search")
        || n.contains("list")
    {
        "read"
    } else if n.contains("edit") || n.contains("write") || n.contains("patch") || n.contains("notebook") {
        "edit"
    } else if n.contains("bash") || n.contains("shell") || n.contains("exec") || n.contains("powershell") {
        "execute"
    } else if n.contains("fetch") || n.contains("web") {
        "fetch"
    } else {
        "other"
    }
}

fn map_stop(s: cersei::types::StopReason) -> &'static str {
    use cersei::types::StopReason as S;
    match s {
        S::EndTurn => "end_turn",
        S::MaxTokens => "max_tokens",
        S::ToolUse => "end_turn",
        S::StopSequence => "end_turn",
        S::ContentFilter => "refusal",
    }
}

fn modes_blob(current: &str) -> serde_json::Value {
    serde_json::json!({
        "currentModeId": current,
        "availableModes": [
            { "id": "default", "name": "Ask", "description": "Prompt before edits and commands" },
            { "id": "acceptEdits", "name": "Accept edits", "description": "Auto-approve file edits; prompt for shell" },
            { "id": "plan", "name": "Plan", "description": "Read-only — no edits or commands" },
            { "id": "bypass", "name": "Bypass", "description": "Run everything without prompting" },
        ],
    })
}

fn session_id_str(id: &SessionId) -> String {
    serde_json::to_value(id)
        .ok()
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default()
}

// ─── Transcript → replay items ──────────────────────────────────────────────

fn messages_to_replay(messages: &[Message]) -> Vec<ReplayItem> {
    use cersei::types::{ContentBlock, MessageContent, Role};
    let mut items: Vec<ReplayItem> = Vec::new();
    for m in messages {
        let is_user = m.role == Role::User;
        match &m.content {
            MessageContent::Text(t) => {
                if t.trim().is_empty() {
                    continue;
                }
                items.push(if is_user {
                    ReplayItem::User { text: t.clone() }
                } else {
                    ReplayItem::Assistant { text: t.clone() }
                });
            }
            MessageContent::Blocks(blocks) => {
                for b in blocks {
                    match b {
                        ContentBlock::Text { text } => {
                            if text.trim().is_empty() {
                                continue;
                            }
                            items.push(if is_user {
                                ReplayItem::User { text: text.clone() }
                            } else {
                                ReplayItem::Assistant { text: text.clone() }
                            });
                        }
                        ContentBlock::Thinking { thinking, .. } => {
                            items.push(ReplayItem::Thinking {
                                text: thinking.clone(),
                            });
                        }
                        ContentBlock::ToolUse { id, name, input } => {
                            items.push(ReplayItem::Tool {
                                id: id.clone(),
                                name: name.clone(),
                                input: input.clone(),
                                result: None,
                                is_error: false,
                            });
                        }
                        ContentBlock::ToolResult {
                            tool_use_id,
                            content,
                            is_error,
                        } => {
                            let text = tool_result_text(content);
                            if let Some(ReplayItem::Tool {
                                result, is_error: ie, ..
                            }) = items.iter_mut().rev().find(|it| {
                                matches!(it, ReplayItem::Tool { id, .. } if id == tool_use_id)
                            }) {
                                *result = Some(text);
                                *ie = is_error.unwrap_or(false);
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    items
}

fn tool_result_text(content: &cersei::types::ToolResultContent) -> String {
    use cersei::types::{ContentBlock, ToolResultContent};
    match content {
        ToolResultContent::Text(t) => t.clone(),
        ToolResultContent::Blocks(blocks) => blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────
//
// These pin the AgentEvent→AcpEvent adapter (where bugs live) without needing a
// provider or network: scripted Cersei events are fed through `translate_event`
// into a capturing sink and the emitted ACP session updates are asserted.

#[cfg(test)]
mod tests {
    use super::*;
    use cersei::events::AgentEvent as E;
    use std::sync::Arc;
    use std::time::Duration;

    /// EventSink that records every emitted AcpEvent for assertions.
    #[derive(Default)]
    struct CollectingSink {
        events: Mutex<Vec<AcpEvent>>,
    }
    impl EventSink for CollectingSink {
        fn emit(&self, _agent_id: AgentId, event: AcpEvent, _turn: Option<u64>) {
            self.events.lock().push(event);
        }
    }

    fn sink() -> (Arc<dyn EventSink>, Arc<CollectingSink>) {
        let c = Arc::new(CollectingSink::default());
        (c.clone() as Arc<dyn EventSink>, c)
    }

    /// The session-update JSON of the i-th recorded event (re-serialized).
    fn update_json(c: &CollectingSink, i: usize) -> serde_json::Value {
        match &c.events.lock()[i] {
            AcpEvent::SessionUpdate { update, .. } => serde_json::to_value(update).unwrap(),
            other => panic!("event {i} is not a SessionUpdate: {other:?}"),
        }
    }

    fn run(ev: E) -> (Arc<CollectingSink>, TurnStep) {
        let (s, c) = sink();
        let sid = SessionId::new("sess-1".to_string());
        let mut todo = std::collections::HashSet::new();
        let mut acct = CompressAccount::new(cersei_compression::CompressionLevel::Off);
        let step = translate_event(ev, &s, AgentId::new(), &sid, &mut todo, &mut acct);
        (c, step)
    }

    #[test]
    fn text_delta_emits_message_chunk() {
        let (c, step) = run(E::TextDelta("hello world".into()));
        assert!(matches!(step, TurnStep::Continue));
        assert_eq!(c.events.lock().len(), 1);
        let v = update_json(&c, 0);
        assert_eq!(v["sessionUpdate"], "agent_message_chunk");
        assert_eq!(v["content"]["text"], "hello world");
    }

    #[test]
    fn thinking_delta_emits_thought_chunk() {
        let (c, _) = run(E::ThinkingDelta("pondering".into()));
        assert_eq!(update_json(&c, 0)["sessionUpdate"], "agent_thought_chunk");
    }

    #[test]
    fn tool_start_emits_tool_call_with_kind() {
        let (c, _) = run(E::ToolStart {
            name: "Read".into(),
            id: "t1".into(),
            input: serde_json::json!({ "path": "x.rs" }),
        });
        let v = update_json(&c, 0);
        assert_eq!(v["sessionUpdate"], "tool_call");
        assert_eq!(v["toolCallId"], "t1");
        assert_eq!(v["kind"], "read");
    }

    #[test]
    fn todowrite_emits_plan_not_tool_card() {
        let (s, c) = sink();
        let sid = SessionId::new("sess-1".to_string());
        let mut todo = std::collections::HashSet::new();
        let mut acct = CompressAccount::new(cersei_compression::CompressionLevel::Off);
        translate_event(
            E::ToolStart {
                name: "TodoWrite".into(),
                id: "td1".into(),
                input: serde_json::json!({
                    "todos": [
                        { "content": "Build feature", "status": "in_progress", "activeForm": "Building" },
                        { "content": "Write tests", "status": "pending", "activeForm": "Writing" }
                    ]
                }),
            },
            &s,
            AgentId::new(),
            &sid,
            &mut todo,
            &mut acct,
        );
        // Rendered as a plan card, and the id is tracked for ToolEnd suppression.
        assert!(todo.contains("td1"));
        let v = update_json(&c, 0);
        assert_eq!(v["sessionUpdate"], "plan");
        let entries = v["entries"].as_array().expect("entries array");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["content"], "Build feature");
        assert_eq!(entries[0]["status"], "in_progress");
        assert_eq!(entries[1]["status"], "pending");
    }

    #[test]
    fn tool_end_suppressed_for_todo_id() {
        let (s, c) = sink();
        let sid = SessionId::new("sess-1".to_string());
        let mut todo = std::collections::HashSet::new();
        todo.insert("td1".to_string());
        let mut acct = CompressAccount::new(cersei_compression::CompressionLevel::Off);
        let step = translate_event(
            E::ToolEnd {
                name: "TodoWrite".into(),
                id: "td1".into(),
                result: "2 items".into(),
                is_error: false,
                duration: Duration::from_secs(0),
                compression: None,
            },
            &s,
            AgentId::new(),
            &sid,
            &mut todo,
            &mut acct,
        );
        assert!(matches!(step, TurnStep::Continue));
        assert_eq!(c.events.lock().len(), 0, "TodoWrite ToolEnd must not emit a tool card");
    }

    #[test]
    fn tool_end_emits_update_for_normal_tool() {
        let (c, _) = run(E::ToolEnd {
            name: "Read".into(),
            id: "t1".into(),
            result: "file contents".into(),
            is_error: false,
            duration: Duration::from_secs(0),
            compression: None,
        });
        let v = update_json(&c, 0);
        assert_eq!(v["sessionUpdate"], "tool_call_update");
        assert_eq!(v["toolCallId"], "t1");
        assert_eq!(v["status"], "completed");
    }

    #[test]
    fn tool_end_error_maps_to_failed() {
        let (c, _) = run(E::ToolEnd {
            name: "Bash".into(),
            id: "t9".into(),
            result: "boom".into(),
            is_error: true,
            duration: Duration::from_secs(0),
            compression: None,
        });
        assert_eq!(update_json(&c, 0)["status"], "failed");
    }

    #[test]
    fn turn_complete_sets_stop_without_emitting() {
        let (c, step) = run(E::TurnComplete {
            turn: 1,
            stop_reason: cersei::types::StopReason::EndTurn,
            usage: cersei::types::Usage::default(),
        });
        assert!(matches!(step, TurnStep::SetStop(ref s) if s == "end_turn"));
        assert_eq!(c.events.lock().len(), 0);
    }

    #[test]
    fn error_event_signals_failure() {
        let (_c, step) = run(E::Error("provider exploded".into()));
        assert!(matches!(step, TurnStep::Failed(ref e) if e == "provider exploded"));
    }

    #[test]
    fn cost_update_emits_usage() {
        let (c, step) = run(E::CostUpdate {
            turn_cost: 0.01,
            cumulative_cost: 0.05,
            input_tokens: 1200,
            output_tokens: 340,
        });
        assert!(matches!(step, TurnStep::Continue));
        let evs = c.events.lock();
        match &evs[0] {
            AcpEvent::Usage {
                input_tokens,
                output_tokens,
                cost,
                ..
            } => {
                assert_eq!(*input_tokens, 1200);
                assert_eq!(*output_tokens, 340);
                assert!((*cost - 0.05).abs() < f64::EPSILON);
            }
            other => panic!("expected Usage, got {other:?}"),
        }
    }

    #[test]
    fn compact_events_toggle_compaction() {
        let (c1, _) = run(E::CompactStart {
            reason: cersei::events::CompactReason::ThresholdExceeded,
            messages_before: 50,
        });
        assert!(matches!(c1.events.lock().first(), Some(AcpEvent::Compaction { active: true, .. })));
        let (c2, _) = run(E::CompactEnd {
            messages_after: 12,
            tokens_freed: 8000,
        });
        assert!(matches!(c2.events.lock().first(), Some(AcpEvent::Compaction { active: false, .. })));
    }

    #[test]
    fn tool_kind_classification() {
        assert_eq!(tool_kind("Read"), "read");
        assert_eq!(tool_kind("Grep"), "read");
        assert_eq!(tool_kind("Glob"), "read");
        assert_eq!(tool_kind("List"), "read");
        assert_eq!(tool_kind("Edit"), "edit");
        assert_eq!(tool_kind("Write"), "edit");
        assert_eq!(tool_kind("Bash"), "execute");
        assert_eq!(tool_kind("WebFetch"), "fetch");
        assert_eq!(tool_kind("delegate"), "other");
    }

    #[test]
    fn stop_reason_mapping() {
        use cersei::types::StopReason as S;
        assert_eq!(map_stop(S::EndTurn), "end_turn");
        assert_eq!(map_stop(S::MaxTokens), "max_tokens");
        assert_eq!(map_stop(S::ToolUse), "end_turn");
        assert_eq!(map_stop(S::ContentFilter), "refusal");
    }

    #[test]
    fn modes_blob_advertises_four_modes() {
        let v = modes_blob("plan");
        assert_eq!(v["currentModeId"], "plan");
        let ids: Vec<&str> = v["availableModes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["default", "acceptEdits", "plan", "bypass"]);
    }

    #[test]
    fn full_turn_emits_events_in_wire_order() {
        // A realistic turn: narrate → call a tool → tool finishes → narrate →
        // end. The emitted ACP updates must stay in that exact order (this is
        // the ordering the streaming pipeline depends on).
        let (s, c) = sink();
        let sid = SessionId::new("sess-1".to_string());
        let aid = AgentId::new();
        let mut todo = std::collections::HashSet::new();
        let seq = vec![
            E::TextDelta("Reading it.".into()),
            E::ToolStart {
                name: "Read".into(),
                id: "r1".into(),
                input: serde_json::json!({}),
            },
            E::ToolEnd {
                name: "Read".into(),
                id: "r1".into(),
                result: "body".into(),
                is_error: false,
                duration: Duration::from_secs(0),
                compression: None,
            },
            E::TextDelta("Done.".into()),
            E::TurnComplete {
                turn: 1,
                stop_reason: cersei::types::StopReason::EndTurn,
                usage: cersei::types::Usage::default(),
            },
        ];
        let mut last = TurnStep::Continue;
        let mut acct = CompressAccount::new(cersei_compression::CompressionLevel::Off);
        for ev in seq {
            last = translate_event(ev, &s, aid, &sid, &mut todo, &mut acct);
        }
        // Bind the count first: holding the lock across `.map()` (which re-locks
        // inside `update_json`) would deadlock parking_lot's non-reentrant Mutex.
        let n = c.events.lock().len();
        let kinds: Vec<String> = (0..n)
            .map(|i| update_json(&c, i)["sessionUpdate"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            kinds,
            ["agent_message_chunk", "tool_call", "tool_call_update", "agent_message_chunk"],
            "TurnComplete emits nothing; the rest stay in wire order"
        );
        assert!(matches!(last, TurnStep::SetStop(ref s) if s == "end_turn"));
    }

    // ── Permission policy (the synthesized modes that mirror Claude Code) ──────

    fn policy(mode: &str) -> UiPolicy {
        let (s, _c) = sink();
        let entry = Arc::new(SessionEntry {
            session_id: "s".into(),
            cwd: "/tmp".into(),
            history: Mutex::new(Vec::new()),
            provider: Mutex::new("anthropic".into()),
            model: Mutex::new("claude-opus-4-8".into()),
            mode: Mutex::new(mode.into()),
            effort: Mutex::new(None),
            compress: Mutex::new(true),
            usage: Mutex::new(store::StoredUsage::default()),
            cancel: Mutex::new(None),
            pending: DashMap::new(),
            cancelled: std::sync::atomic::AtomicBool::new(false),
            turn_seq: AtomicU64::new(0),
            busy: AtomicBool::new(false),
        });
        UiPolicy {
            sink: s,
            agent_id: AgentId::new(),
            session_id: SessionId::new("s".to_string()),
            pending: entry,
            mode: mode.into(),
        }
    }

    fn req(level: PermissionLevel) -> PermissionRequest {
        PermissionRequest {
            tool_name: "SomeTool".into(),
            tool_input: serde_json::json!({}),
            permission_level: level,
            description: String::new(),
            id: "1".into(),
        }
    }

    #[tokio::test]
    async fn bypass_mode_allows_everything() {
        let p = policy("bypass");
        assert!(matches!(
            p.check(&req(PermissionLevel::Dangerous)).await,
            CerseiDecision::Allow
        ));
    }

    #[test]
    fn mode_kind_normalizes_cross_agent_aliases() {
        // The fix for "bypass still prompts": ids from other agents' vocabularies
        // must still resolve to the right behavior.
        assert_eq!(mode_kind("bypass"), ModeKind::Bypass);
        assert_eq!(mode_kind("bypassPermissions"), ModeKind::Bypass);
        assert_eq!(mode_kind("danger-full-access"), ModeKind::Bypass);
        assert_eq!(mode_kind("full-access"), ModeKind::Bypass);
        assert_eq!(mode_kind("plan"), ModeKind::Plan);
        assert_eq!(mode_kind("read-only"), ModeKind::Plan);
        assert_eq!(mode_kind("acceptEdits"), ModeKind::AcceptEdits);
        assert_eq!(mode_kind("auto"), ModeKind::AcceptEdits);
        assert_eq!(mode_kind("default"), ModeKind::Ask);
        assert_eq!(mode_kind("whatever"), ModeKind::Ask);
    }

    #[tokio::test]
    async fn bypass_alias_allows_everything() {
        // A Claude-style "bypassPermissions" id reaching the cersei runtime must
        // still auto-allow (the reported bug).
        let p = policy("bypassPermissions");
        assert!(matches!(
            p.check(&req(PermissionLevel::Dangerous)).await,
            CerseiDecision::Allow
        ));
    }

    #[tokio::test]
    async fn plan_mode_is_read_only() {
        let p = policy("plan");
        assert!(matches!(
            p.check(&req(PermissionLevel::ReadOnly)).await,
            CerseiDecision::Allow
        ));
        assert!(matches!(
            p.check(&req(PermissionLevel::Write)).await,
            CerseiDecision::Deny(_)
        ));
    }

    #[tokio::test]
    async fn accept_edits_auto_allows_writes() {
        let p = policy("acceptEdits");
        assert!(matches!(
            p.check(&req(PermissionLevel::Write)).await,
            CerseiDecision::Allow
        ));
    }

    #[tokio::test]
    async fn forbidden_is_always_denied() {
        // Denied before any UI prompt, so awaiting check() doesn't block.
        let p = policy("default");
        assert!(matches!(
            p.check(&req(PermissionLevel::Forbidden)).await,
            CerseiDecision::Deny(_)
        ));
    }

    #[test]
    fn replay_pairs_tool_results_with_calls() {
        use cersei::types::{ContentBlock, Message, ToolResultContent};
        let msgs = vec![
            Message::user("hello"),
            Message::assistant_blocks(vec![
                ContentBlock::Text { text: "on it".into() },
                ContentBlock::ToolUse {
                    id: "x".into(),
                    name: "Read".into(),
                    input: serde_json::json!({}),
                },
            ]),
            Message::user_blocks(vec![ContentBlock::ToolResult {
                tool_use_id: "x".into(),
                content: ToolResultContent::Text("file body".into()),
                is_error: None,
            }]),
        ];
        let items = messages_to_replay(&msgs);
        assert!(matches!(&items[0], ReplayItem::User { text } if text == "hello"));
        assert!(matches!(&items[1], ReplayItem::Assistant { text } if text == "on it"));
        match &items[2] {
            ReplayItem::Tool { id, name, result, is_error, .. } => {
                assert_eq!(id, "x");
                assert_eq!(name, "Read");
                assert_eq!(result.as_deref(), Some("file body"));
                assert!(!is_error);
            }
            other => panic!("expected Tool replay item, got {other:?}"),
        }
    }

    // ── Phase 6: history integrity (M1/M2) ─────────────────────────────────

    fn temp_cfg() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "atlas-cersei-libtest-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn failed_turn_survives_reload_with_error_marker() {
        let cfg = temp_cfg();
        let rt = CerseiRuntime::new(cfg.clone());
        let msgs = vec![
            cersei::types::Message::user("refactor the parser"),
            cersei::types::Message::assistant("Started, then the provider died…"),
        ];
        store::save(
            &cfg, "/proj/x", "s1", "anthropic", "m", &msgs, "t1",
            &store::StoredUsage::default(),
            Some("HTTP 529: overloaded (gave up after 4 attempts)"),
        );
        let items = rt.replay_session("/proj/x", "s1");
        // The failed turn's history is present…
        assert!(matches!(&items[0], ReplayItem::User { text } if text.contains("refactor")));
        assert!(items.len() >= 3, "user + partial assistant + error marker");
        // …and the resume surfaces WHY it ended, like the live turn_failed does.
        let ReplayItem::Assistant { text } = items.last().unwrap() else {
            panic!("last replay item must be the error marker");
        };
        assert!(text.starts_with("Error:"), "{text}");
        assert!(text.contains("HTTP 529"));
    }

    #[test]
    fn corrupt_session_resumes_with_notice_not_silently_empty() {
        let cfg = temp_cfg();
        let rt = CerseiRuntime::new(cfg.clone());
        store::save(
            &cfg, "/proj/y", "s1", "anthropic", "m",
            &[cersei::types::Message::user("q")], "t1",
            &store::StoredUsage::default(), None,
        );
        // Truncate the file (pre-M2 crash artifact).
        let path = store::project_sessions_dir(&cfg, "/proj/y").join("s1.json");
        std::fs::write(&path, "{\"session_id\": \"s1").unwrap();

        let items = rt.replay_session("/proj/y", "s1");
        assert_eq!(items.len(), 1);
        let ReplayItem::Assistant { text } = &items[0] else {
            panic!("corrupt session must surface a notice item");
        };
        assert!(text.contains("damaged"), "{text}");
        assert!(text.contains(".corrupt-"), "notice names the backup: {text}");
        // Subsequent replay: file was moved aside → clean fresh session.
        assert!(rt.replay_session("/proj/y", "s1").is_empty());
    }
}

use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::v1::{
    AuthenticateRequest, CancelNotification, ContentBlock, ImageContent, LoadSessionRequest,
    NewSessionRequest, PermissionOptionId, PromptRequest, RequestPermissionOutcome,
    SelectedPermissionOutcome, SessionConfigOptionValue, SessionId, SessionModeId,
    SetSessionConfigOptionRequest, SetSessionModeRequest, StopReason, TextContent,
};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::driver::{self, AgentRuntime, AuthMethodWire, SessionGuard};
use crate::error::{AcpError, Result};
use crate::events::EventSink;
use crate::schema::NewSessionInfo;
use crate::spawn::{explain_spawn_failure, resolve_command};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AgentId(pub Uuid);

impl AgentId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for AgentId {
    fn default() -> Self {
        Self::new()
    }
}

/// One image attached to an outbound prompt (multimodal input): base64
/// `data` + its MIME type, mapped to an ACP `ContentBlock::Image` at send
/// time when the agent advertised `promptCapabilities.image`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    pub mime_type: String,
    /// Raw base64 payload — no `data:` URI prefix.
    pub data_base64: String,
}

/// Description of an agent process that Atlas knows how to spawn.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSpec {
    pub spec_id: String,
    pub display_name: String,
    /// Shell-words–parseable command string (or a `{...}` JSON stdio spec).
    pub command: String,
    /// Where the user can get/install this agent — used by
    /// `explain_spawn_failure` for agents without a hardcoded hint (i.e.
    /// registry-installed externals; sourced from their manifest
    /// repository/website).
    #[serde(default)]
    pub help_url: Option<String>,
}

/// Provider of additional spawnable specs beyond [`AgentSpec::all_known`] —
/// implemented by the dynamic ACP registry (`atlas-registry`) so installed
/// external agents flow through the exact same spawn path as first-party ones.
pub trait SpecSource: Send + Sync {
    fn extra_specs(&self) -> Vec<AgentSpec>;
}

/// Built-in agents whose adapter is a plain CLI binary rather than an npm
/// package. Claude and Codex spawn through `npx -y …`, so npm fetches their
/// adapter on first run and they work on a machine that never installed
/// anything by hand; these three do not, and their bare commands
/// (`cursor-agent acp`, `opencode acp`, `kilo acp`) simply ENOENT there.
///
/// `atlas-registry` closes that gap by downloading each one's official binary
/// from the ACP registry manifest and offering it as a dynamic spec. For these
/// ids ONLY, that dynamic spec's command REPLACES the bare command below (see
/// [`AgentRegistry::known_specs`]) — every other id keeps first-party
/// precedence, so a registry install can never shadow a built-in agent.
pub const AUTO_MANAGED_BUILTIN_IDS: &[&str] = &["cursor", "opencode", "kilo"];

/// The CLI argv that signs a user in to an auto-managed built-in, appended to
/// its managed binary.
///
/// These three adapters advertise an `authMethod` but ship NO
/// `_meta.terminal-auth` block, so there is nothing for the host's terminal-auth
/// runner to execute — and because Atlas downloads their binary into its own
/// app-data dir, the user has no CLI on `PATH` to run by hand either. Without
/// this table "sign in" is simply impossible from inside Atlas: the agent
/// answers every prompt with `Authentication required` forever.
///
/// Verified against the downloaded binaries (`--help`): cursor exposes a
/// top-level `login`; opencode (and its Kilo fork) nest it under `auth login`.
/// Each opens the browser and prints the URL on stdout, which the auth runner
/// already streams to the UI.
pub fn builtin_login_args(spec_id: &str) -> Option<&'static [&'static str]> {
    match spec_id {
        "cursor" => Some(&["login"]),
        "opencode" | "kilo" => Some(&["auth", "login"]),
        _ => None,
    }
}

impl AgentSpec {
    pub fn claude_code_ts() -> Self {
        Self {
            spec_id: "claude-code-ts".into(),
            display_name: "Claude Code (canonical)".into(),
            // Upstream rename: `@zed-industries/claude-code-acp` was renamed
            // to `@agentclientprotocol/claude-agent-acp`. The old name still
            // resolves but no longer receives updates.
            command: "npx -y @agentclientprotocol/claude-agent-acp".into(),
            help_url: None,
        }
    }

    pub fn claude_code_rs() -> Self {
        Self {
            spec_id: "claude-code-rs".into(),
            display_name: "Claude Code (Rust)".into(),
            command: "claude-code-acp-rs".into(),
            help_url: None,
        }
    }

    /// Codex ACP bridge — speaks ACP over stdio around the Codex engine.
    /// Launched via `npx` (mirrors `claude_code_ts`); ships a `codex-acp` bin.
    /// Auth is inherited from the host env / `~/.codex` (ChatGPT login or
    /// `OPENAI_API_KEY`) — see `sanitize_host_env`.
    ///
    /// Uses `@agentclientprotocol/codex-acp` (the maintained replacement for the
    /// deprecated `@zed-industries/codex-acp`). CRITICAL: the old package shipped
    /// the Codex engine as a platform-specific **optional dependency**
    /// (`@zed-industries/codex-acp-darwin-arm64`); after an npm/npx cache clear
    /// npx would silently fail to reinstall that optional binary, and the agent
    /// crashed on launch with `ERR_MODULE_NOT_FOUND`. The new package has no
    /// optional platform binary — it depends on `@openai/codex` as a regular
    /// dependency + a pure-JS `dist/index.js`, so a clean/cold cache installs it
    /// reliably. Do NOT revert to `@zed-industries/codex-acp`.
    pub fn codex() -> Self {
        Self {
            spec_id: "codex".into(),
            display_name: "Codex (ACP)".into(),
            command: "npx -y @agentclientprotocol/codex-acp".into(),
            help_url: None,
        }
    }

    /// OpenCode — the `opencode` CLI speaks ACP natively over stdio via its
    /// `acp` subcommand (verified live against 1.3.15: protocol v1,
    /// `loadSession`, session `list`/`resume`/`fork`, image prompts, and a
    /// `models` blob + `build`/`plan` modes on `session/new`). Auth is the
    /// user's own `opencode auth login`; unauthenticated installs still work
    /// with the free OpenCode Zen models. Model selection uses
    /// `session/set_model` (it does NOT implement `session/set_config_option`)
    /// — see `AcpBackend::set_session_model`'s fallback.
    pub fn opencode() -> Self {
        Self {
            spec_id: "opencode".into(),
            display_name: "OpenCode".into(),
            command: "opencode acp".into(),
            help_url: None,
        }
    }

    /// Cursor — `cursor-agent acp` speaks stock ACP v1 over stdio (verified
    /// live against 2026.07.23 + the official doc, which names the binary
    /// `agent`; the installed CLI ships it as `cursor-agent`). Models arrive
    /// in the `session/new` `models` blob and switch via `session/set_model`
    /// (its `set_config_option` takes plain-string values our typed request
    /// can't produce — the backend's set_model fallback covers it). Modes are
    /// agent/plan/ask. Auth is the user's own `cursor-agent login`
    /// (method id `cursor_login`); quota exhaustion on free plans arrives as a
    /// NORMAL assistant message, not an error. Slash commands were never
    /// observed (`available_commands_update` may simply not fire).
    pub fn cursor() -> Self {
        Self {
            spec_id: "cursor".into(),
            display_name: "Cursor".into(),
            command: "cursor-agent acp".into(),
            help_url: None,
        }
    }

    /// Kilo Code — `kilo acp` (npm `@kilocode/cli`, an OpenCode fork) speaks
    /// ACP v1 as NDJSON over stdio (probed live against 7.4.20). It is on the
    /// newer config-options dialect: `session/new`/`load` return NO
    /// `modes`/`models` blobs — modes, models (~300, `provider/model`) and a
    /// reasoning-effort level all arrive as `configOptions` selects (see
    /// `schema.rs`'s normalisers). `session/set_mode` and
    /// `session/set_config_option` both work (the backend's set-model ladder
    /// succeeds on its first rung). `loadSession: true` with FULL transcript
    /// replay; ACP session ids are Kilo's real `ses_…` ids
    /// (`~/.local/share/kilo/kilo.db`). No terminal methods — shell output
    /// streams as `tool_call_update` content. Auth is the user's own
    /// `kilo auth login` (method id `kilo-login`); NOTE its `terminal-auth`
    /// meta still says `command: "opencode"` (fork residue) — never exec it
    /// verbatim. The embedded HTTP server makes `session/new` take ~1s extra.
    pub fn kilo() -> Self {
        Self {
            spec_id: "kilo".into(),
            display_name: "Kilo Code".into(),
            command: "kilo acp".into(),
            help_url: None,
        }
    }

    pub fn all_known() -> Vec<AgentSpec> {
        vec![
            Self::claude_code_ts(),
            Self::claude_code_rs(),
            Self::codex(),
            Self::opencode(),
            Self::cursor(),
            Self::kilo(),
        ]
    }
}

/// Public view of a spawned agent — what the Tauri layer hands back to the UI.
#[derive(Debug, Clone, Serialize)]
pub struct AgentInfo {
    pub agent_id: AgentId,
    pub spec_id: String,
    pub display_name: String,
}

struct AgentEntry {
    spec: AgentSpec,
    runtime: AgentRuntime,
}

/// Registry of live ACP agents. Cloneable handle — backed by an `Arc`.
#[derive(Clone, Default)]
pub struct AgentRegistry {
    inner: Arc<DashMap<AgentId, AgentEntry>>,
    /// Dynamic (registry-installed) specs, unioned into `known_specs`.
    /// `None` = first-party only (tests, minimal hosts).
    dynamic: Option<Arc<dyn SpecSource>>,
}

/// Bound an ACP request so a wedged adapter can't hang its caller forever
/// (H3): the actor's control ops and the host's session ops all resolve with
/// a typed [`AcpError::Timeout`] instead. `session/prompt` is deliberately
/// NOT bounded — turns are governed by the cancel machinery (CANCEL_GRACE).
async fn rpc_timeout<T>(
    rpc: &'static str,
    secs: u64,
    fut: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    match tokio::time::timeout(std::time::Duration::from_secs(secs), fut).await {
        Ok(res) => res,
        Err(_) => Err(AcpError::Timeout { rpc, secs }),
    }
}

/// Session-lifecycle RPCs (new/load/authenticate) — slow is plausible
/// (adapter cold start, browser OAuth handoff), so generous.
const LIFECYCLE_RPC_SECS: u64 = 30;
/// Session-tuning RPCs (set_mode / set_config_option) — cheap state flips;
/// anything past this is a wedged adapter.
const TUNING_RPC_SECS: u64 = 10;

impl AgentRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Production constructor: first-party specs plus whatever the dynamic
    /// registry store has installed.
    pub fn with_spec_source(source: Arc<dyn SpecSource>) -> Self {
        Self {
            inner: Arc::new(DashMap::new()),
            dynamic: Some(source),
        }
    }

    /// First-party specs ∪ dynamic (registry-installed) specs. First-party
    /// wins on a spec-id collision — a registry install must never shadow a
    /// built-in agent.
    ///
    /// The one exception is [`AUTO_MANAGED_BUILTIN_IDS`]: those built-ins have
    /// no npx distribution, so the registry's downloaded binary is strictly
    /// better than their bare-CLI command and takes over the `command` field
    /// IN PLACE — same id, same slot, same display name, never a second entry
    /// for one agent (the plugin catalog keys off `spec_id`). When no binary
    /// has been acquired the dynamic spec is simply absent and the bare
    /// command stands, which is the pre-existing behaviour.
    pub fn known_specs(&self) -> Vec<AgentSpec> {
        let mut specs = AgentSpec::all_known();
        if let Some(source) = &self.dynamic {
            for spec in source.extra_specs() {
                match specs.iter().position(|s| s.spec_id == spec.spec_id) {
                    Some(i) if AUTO_MANAGED_BUILTIN_IDS.contains(&spec.spec_id.as_str()) => {
                        specs[i].command = spec.command;
                    }
                    Some(_) => {}
                    None => specs.push(spec),
                }
            }
        }
        specs
    }

    pub fn list(&self) -> Vec<AgentInfo> {
        self.inner
            .iter()
            .map(|e| AgentInfo {
                agent_id: *e.key(),
                spec_id: e.spec.spec_id.clone(),
                display_name: e.spec.display_name.clone(),
            })
            .collect()
    }

    /// Spawn an agent matching `spec_id`. Resolves once the protocol
    /// handshake completes (or fails).
    pub async fn spawn(
        &self,
        spec_id: &str,
        sink: Arc<dyn EventSink>,
    ) -> Result<AgentInfo> {
        let spec = self
            .known_specs()
            .into_iter()
            .find(|s| s.spec_id == spec_id)
            .ok_or_else(|| AcpError::UnknownSpec(spec_id.to_string()))?;

        let agent_id = AgentId::new();
        // Resolve the agent's program (e.g. `npx`) to an ABSOLUTE path via the
        // user's login shell, so the spawn never depends on the GUI process
        // PATH being correctly enriched. This is the belt to `enrich_path`'s
        // suspenders: the bundled/Finder-launched app inherits a minimal PATH,
        // and if the boot-time PATH merge times out or can't run, a bare `npx`
        // ENOENTs ("driver panicked"). Resolving here mirrors what the user's
        // terminal would find. Falls back to the bare command on failure.
        let command = {
            let c = spec.command.clone();
            tokio::task::spawn_blocking(move || resolve_command(&c))
                .await
                .unwrap_or_else(|_| spec.command.clone())
        };
        let runtime = driver::spawn_agent(agent_id, command, sink)
            .await
            .map_err(|e| explain_spawn_failure(&spec, e))?;

        let info = AgentInfo {
            agent_id,
            spec_id: spec.spec_id.clone(),
            display_name: spec.display_name.clone(),
        };
        self.inner.insert(agent_id, AgentEntry { spec, runtime });
        Ok(info)
    }

    /// Tear down every spawned agent (app quit): dropping each runtime's
    /// `shutdown_tx` lets the SDK close the subprocess's stdin and reap it —
    /// no orphaned `node`/`npx` processes after the app exits (M7).
    pub fn kill_all(&self) {
        let ids: Vec<AgentId> = self.inner.iter().map(|e| *e.key()).collect();
        for id in ids {
            let _ = self.kill(id);
        }
    }

    pub fn kill(&self, agent_id: AgentId) -> Result<()> {
        let mut entry = self
            .inner
            .get_mut(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        if let Some(tx) = entry.runtime.shutdown_tx.take() {
            let _ = tx.send(());
        }
        drop(entry);
        self.inner.remove(&agent_id);
        Ok(())
    }

    /// Open a new session in `cwd` against the given agent. Registers
    /// a `SessionGuard` for the returned session id so the driver can
    /// gate inbound traffic on the session's lifecycle.
    pub async fn new_session(&self, agent_id: AgentId, cwd: PathBuf) -> Result<NewSessionInfo> {
        let connection = self.connection(agent_id)?;
        let resp = rpc_timeout("session/new", LIFECYCLE_RPC_SECS, async {
            Ok(connection
                .send_request(NewSessionRequest::new(cwd))
                .block_task()
                .await?)
        })
        .await?;
        self.register_session(agent_id, resp.session_id.clone())?;
        let session_id = resp.session_id.clone();
        let mut info: NewSessionInfo = resp.into();
        // Agents still on the pre-config-options dialect (OpenCode, Cursor)
        // answer with a top-level `models` blob that the typed
        // `NewSessionResponse` drops on the floor — without this their model
        // picker never renders. Recover it from the raw wire.
        if info.models.is_none() {
            info.models = self.take_sniffed_models(agent_id, session_id.0.as_ref());
        }
        // Diagnostic: surface what the agent advertised for model selection, so a
        // missing model picker can be diagnosed (agent didn't send `models` vs.
        // a parse gap). Logs once per new session.
        tracing::info!(
            target: "atlas_acp::registry",
            "new_session: modes_present={} models={}",
            info.modes.is_some(),
            info.models
                .as_ref()
                .map(|m| m.to_string())
                .unwrap_or_else(|| "none".into()),
        );
        Ok(info)
    }

    /// Resume a previously-saved session by id. Same guard registration
    /// as `new_session` — the resumed session can be cancelled / killed
    /// through the normal flow.
    pub async fn load_session(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        cwd: PathBuf,
    ) -> Result<Option<serde_json::Value>> {
        let connection = self.connection(agent_id)?;
        let resp = rpc_timeout("session/load", LIFECYCLE_RPC_SECS, async {
            Ok(connection
                .send_request(LoadSessionRequest::new(session_id.clone(), cwd))
                .block_task()
                .await?)
        })
        .await?;
        self.register_session(agent_id, session_id)?;
        // Project the (non_exhaustive, unstable-gated) `modes` blob to JSON the
        // same way `new_session` does, so the manager can seed the available
        // session-mode list for the resumed session. Config-options-dialect
        // agents (Kilo) advertise modes only as a `configOptions` select —
        // fall back to normalising that (mirrors `NewSessionInfo::from`).
        let modes = resp
            .modes
            .as_ref()
            .and_then(|m| serde_json::to_value(m).ok())
            .or_else(|| {
                serde_json::to_value(&resp.config_options)
                    .ok()
                    .and_then(|co| crate::schema::modes_blob_from_config_options(&co))
            });
        Ok(modes)
    }

    /// Run the agent's ACP `authenticate` flow for `method_id`. For Codex's
    /// "chatgpt" method this blocks while codex-acp runs a local login server
    /// and opens the browser to OpenAI (OAuth/PKCE); it resolves once the user
    /// completes sign-in (credentials land in `~/.codex/auth.json`).
    pub async fn authenticate(&self, agent_id: AgentId, method_id: String) -> Result<()> {
        let connection = self.connection(agent_id)?;
        // Bounded, but generously: this RPC legitimately waits on a HUMAN
        // completing browser sign-in (see doc above), so the tight
        // LIFECYCLE_RPC_SECS would break Codex ChatGPT login. 5 minutes turns
        // "forever" into "eventually fails visibly" without racing the user.
        rpc_timeout("authenticate", 300, async {
            connection
                .send_request(AuthenticateRequest::new(method_id))
                .block_task()
                .await?;
            Ok(())
        })
        .await
    }

    /// Install a lifecycle guard for a session. Idempotent — if a
    /// guard for this session already exists, the call is a no-op.
    /// Collect the legacy `models` blob the driver's wire tap captured for this
    /// session, if the agent sent one. `None` for agents on the config-options
    /// dialect (whose models come through the typed response) and for agents
    /// with no model selection at all.
    fn take_sniffed_models(&self, agent_id: AgentId, session_id: &str) -> Option<serde_json::Value> {
        self.inner
            .get(&agent_id)?
            .runtime
            .model_sniffer
            .take(session_id)
    }

    /// Called from `new_session` / `load_session`.
    pub fn register_session(&self, agent_id: AgentId, session_id: SessionId) -> Result<()> {
        let entry = self
            .inner
            .get(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        entry
            .runtime
            .session_guards
            .entry(session_id)
            .or_insert_with(|| Arc::new(SessionGuard::new()));
        Ok(())
    }

    /// Remove a session's guard. Called when the host-side session
    /// representation is being torn down (tab close, project switch,
    /// agent kill) so the driver's gates drop any further inbound
    /// traffic for this id.
    pub fn drop_session(&self, agent_id: AgentId, session_id: &SessionId) -> Result<()> {
        let entry = self
            .inner
            .get(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        entry.runtime.session_guards.remove(session_id);
        Ok(())
    }

    /// Re-arm the session's guard before starting a new turn. Bumps
    /// the turn epoch and clears the `cancelled` flag so inbound
    /// notifications / permission requests for this turn flow
    /// through. Called by the actor right before `send_prompt`.
    /// Returns the new turn epoch — the driver stamps it onto every
    /// event it emits for this session, and the actor matches the
    /// stamps against this value to drop stale-turn stragglers.
    pub fn mark_turn_started(
        &self,
        agent_id: AgentId,
        session_id: &SessionId,
    ) -> Result<u64> {
        let entry = self
            .inner
            .get(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        if let Some(guard) = entry.runtime.session_guards.get(session_id) {
            return Ok(guard.mark_turn_started());
        }
        // Race: send arrived before register_session finished, or
        // the session was just dropped. Install a fresh guard so
        // the turn isn't auto-blocked.
        let guard = Arc::new(SessionGuard::new());
        let epoch = guard.mark_turn_started();
        entry
            .runtime
            .session_guards
            .insert(session_id.clone(), guard);
        Ok(epoch)
    }

    /// Send a single text prompt, plus any image attachments staged for this
    /// session via [`Self::stage_attachments`]. Resolves with the turn's
    /// `StopReason` when the agent finishes streaming. Notifications fire
    /// over the event sink throughout the turn.
    pub async fn send_prompt(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        text: String,
    ) -> Result<StopReason> {
        // Drain staged images one-shot before the request. Text always goes;
        // images ride only when the agent advertised promptCapabilities.image
        // (sending them anyway would violate the ACP spec) — dropped with a
        // debug log otherwise, never an error.
        let (image_supported, staged) = {
            let entry = self.inner.get(&agent_id).ok_or(AcpError::UnknownAgent)?;
            let staged = entry
                .runtime
                .pending_attachments
                .remove(&session_id)
                .map(|(_, v)| v)
                .unwrap_or_default();
            (entry.runtime.prompt_image_supported, staged)
        };
        let mut content = vec![ContentBlock::Text(TextContent::new(text))];
        if !staged.is_empty() {
            if image_supported {
                for att in staged {
                    content.push(ContentBlock::Image(ImageContent::new(
                        att.data_base64,
                        att.mime_type,
                    )));
                }
            } else {
                tracing::debug!(
                    count = staged.len(),
                    "dropping image attachments — agent did not advertise promptCapabilities.image"
                );
            }
        }
        let connection = self.connection(agent_id)?;
        let resp = connection
            .send_request(PromptRequest::new(session_id, content))
            .block_task()
            .await?;
        Ok(resp.stop_reason)
    }

    /// Stage image attachments to ride on this session's *next* prompt. A
    /// non-empty vec overwrites any previously staged set; an empty vec
    /// clears. Drained one-shot by [`Self::send_prompt`].
    pub fn stage_attachments(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        attachments: Vec<ImageAttachment>,
    ) -> Result<()> {
        let entry = self.inner.get(&agent_id).ok_or(AcpError::UnknownAgent)?;
        if attachments.is_empty() {
            entry.runtime.pending_attachments.remove(&session_id);
        } else {
            entry
                .runtime
                .pending_attachments
                .insert(session_id, attachments);
        }
        Ok(())
    }

    /// Whether the agent advertised `promptCapabilities.image` at
    /// initialize. `false` for unknown agents.
    pub fn prompt_image_supported(&self, agent_id: AgentId) -> bool {
        self.inner
            .get(&agent_id)
            .map(|e| e.runtime.prompt_image_supported)
            .unwrap_or(false)
    }

    /// Switch the session's permission mode (default / acceptEdits / plan /
    /// dontAsk / bypassPermissions). Calling this with `bypassPermissions`
    /// stops the agent from ever emitting `RequestPermissionRequest` — the
    /// fix for "bypass mode still prompts".
    pub async fn set_session_mode(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        mode_id: String,
    ) -> Result<()> {
        let connection = self.connection(agent_id)?;
        rpc_timeout("session/set_mode", TUNING_RPC_SECS, async {
            connection
                .send_request(SetSessionModeRequest::new(
                    session_id,
                    SessionModeId::new(mode_id),
                ))
                .block_task()
                .await?;
            Ok(())
        })
        .await
    }

    /// `session/set_model` — the model-selection RPC agents with a `models`
    /// blob accept (OpenCode, Cursor; the TS SDK calls it
    /// `unstable_setSessionModel`). The Rust crate has no typed request for it,
    /// so it goes out as an `UntypedMessage`. Verified live against
    /// `opencode acp` 1.3.15 and `cursor-agent` 2026.07.23.
    pub async fn set_session_model(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        model_id: String,
    ) -> Result<()> {
        let connection = self.connection(agent_id)?;
        rpc_timeout("session/set_model", TUNING_RPC_SECS, async {
            let msg = agent_client_protocol::UntypedMessage::new(
                "session/set_model",
                serde_json::json!({ "sessionId": session_id, "modelId": model_id }),
            )?;
            connection.send_request(msg).block_task().await?;
            Ok(())
        })
        .await
    }

    /// Set a session config option (`session/set_config_option`) — the current
    /// mechanism Claude Code / Codex use for model (config_id "model"), effort,
    /// etc. `value` is the option's selected value id.
    pub async fn set_session_config_option(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        config_id: &str,
        value: String,
    ) -> Result<()> {
        let connection = self.connection(agent_id)?;
        rpc_timeout("session/set_config_option", TUNING_RPC_SECS, async {
            connection
                .send_request(SetSessionConfigOptionRequest::new(
                    session_id,
                    config_id.to_string(),
                    SessionConfigOptionValue::value_id(value),
                ))
                .block_task()
                .await?;
            Ok(())
        })
        .await
    }

    /// Cancel an in-flight prompt turn. Three things happen:
    ///
    /// 1. The session's lifecycle guard is marked `cancelled`. From
    ///    this point until the next `mark_turn_started`, the driver
    ///    drops every inbound notification / permission request for
    ///    this session at the protocol boundary — no late popups, no
    ///    transcript contamination.
    /// 2. Already-pending permission senders are dropped so the
    ///    driver's `rx.await` resolves as `Cancelled` and the agent
    ///    gets a clean answer for in-flight requests.
    /// 3. `CancelNotification` is sent so the agent winds down the
    ///    turn and replies to `send_prompt` with
    ///    `StopReason::Cancelled` per ACP spec.
    pub fn cancel_turn(&self, agent_id: AgentId, session_id: SessionId) -> Result<()> {
        let entry = self
            .inner
            .get(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        if let Some(guard) = entry.runtime.session_guards.get(&session_id) {
            guard.mark_cancelled();
        }
        entry
            .runtime
            .pending_permissions
            .retain(|_, p| p.session_id != session_id);
        let connection = entry.runtime.connection.clone();
        drop(entry);
        connection
            .send_notification(CancelNotification::new(session_id))?;
        Ok(())
    }

    /// Drop every pending permission for a session, returning their ids.
    /// Dropping the oneshot sender resolves the driver's `rx.await` as
    /// `Cancelled`, so the agent gets a clean outcome for each in-flight
    /// request (ACP spec). Called by the session actor when a turn
    /// finalizes, so no modal survives its turn (H6/M3).
    pub fn take_pending_permissions(
        &self,
        agent_id: AgentId,
        session_id: &SessionId,
    ) -> Vec<Uuid> {
        let Some(entry) = self.inner.get(&agent_id) else {
            return Vec::new();
        };
        let ids: Vec<Uuid> = entry
            .runtime
            .pending_permissions
            .iter()
            .filter(|e| e.value().session_id == *session_id)
            .map(|e| *e.key())
            .collect();
        for id in &ids {
            entry.runtime.pending_permissions.remove(id);
        }
        ids
    }

    /// Resolve a permission request that the agent emitted earlier.
    pub fn respond_permission(
        &self,
        agent_id: AgentId,
        request_id: Uuid,
        outcome: PermissionDecision,
    ) -> Result<()> {
        let entry = self
            .inner
            .get(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        let (_, pending) = entry
            .runtime
            .pending_permissions
            .remove(&request_id)
            .ok_or(AcpError::UnknownPermissionRequest(request_id))?;
        let resolved = match outcome {
            PermissionDecision::Selected { option_id } => RequestPermissionOutcome::Selected(
                SelectedPermissionOutcome::new(PermissionOptionId::new(option_id)),
            ),
            PermissionDecision::Cancelled => RequestPermissionOutcome::Cancelled,
        };
        pending
            .sender
            .send(resolved)
            .map_err(|_| AcpError::other("permission handler already dropped"))?;
        Ok(())
    }

    fn connection(&self, agent_id: AgentId) -> Result<agent_client_protocol::ConnectionTo<agent_client_protocol::Agent>> {
        let entry = self
            .inner
            .get(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        Ok(entry.runtime.connection.clone())
    }

    /// Auth methods the agent advertised in its `initialize` response.
    /// Empty if the agent doesn't support any (or didn't run `initialize`
    /// successfully — though spawn would have errored in that case).
    pub fn auth_methods(&self, agent_id: AgentId) -> Result<Vec<AuthMethodWire>> {
        let entry = self
            .inner
            .get(&agent_id)
            .ok_or(AcpError::UnknownAgent)?;
        Ok(entry.runtime.auth_methods.clone())
    }
}

/// Frontend-friendly permission outcome — the schema's enum is non_exhaustive
/// and has Selected wrapping a struct, awkward to serialize across the wire.
///
/// Struct variant (not tuple) because serde's internal tagging (`tag = "..."`)
/// only supports struct or unit variants; a tuple variant would silently lose
/// the inner value when deserialised across the Tauri boundary.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum PermissionDecision {
    Selected { option_id: String },
    Cancelled,
}

#[cfg(test)]
mod spec_source_tests {
    use super::*;

    struct FakeSource(Vec<AgentSpec>);
    impl SpecSource for FakeSource {
        fn extra_specs(&self) -> Vec<AgentSpec> {
            self.0.clone()
        }
    }

    fn external(spec_id: &str) -> AgentSpec {
        AgentSpec {
            spec_id: spec_id.into(),
            display_name: spec_id.into(),
            command: format!("npx -y {spec_id}"),
            help_url: Some("https://example.com".into()),
        }
    }

    #[test]
    fn known_specs_is_first_party_only_without_a_source() {
        let registry = AgentRegistry::new();
        let ids: Vec<String> = registry.known_specs().into_iter().map(|s| s.spec_id).collect();
        assert_eq!(
            ids,
            AgentSpec::all_known().into_iter().map(|s| s.spec_id).collect::<Vec<_>>()
        );
    }

    #[test]
    fn known_specs_unions_dynamic_specs() {
        let registry = AgentRegistry::with_spec_source(Arc::new(FakeSource(vec![
            external("amp-acp"),
        ])));
        let ids: Vec<String> = registry.known_specs().into_iter().map(|s| s.spec_id).collect();
        assert!(ids.contains(&"amp-acp".to_string()));
        assert_eq!(ids.len(), AgentSpec::all_known().len() + 1);
    }

    #[test]
    fn first_party_wins_on_spec_id_collision() {
        // A registry install must never shadow a built-in agent's command.
        let registry = AgentRegistry::with_spec_source(Arc::new(FakeSource(vec![
            external("codex"),
        ])));
        let specs = registry.known_specs();
        let codex: Vec<&AgentSpec> = specs.iter().filter(|s| s.spec_id == "codex").collect();
        assert_eq!(codex.len(), 1);
        assert_eq!(codex[0].command, AgentSpec::codex().command);
    }

    #[test]
    fn auto_managed_builtin_takes_the_dynamic_command_in_place() {
        // cursor/opencode/kilo have no npx distribution, so the registry's
        // downloaded binary replaces the bare CLI — but stays ONE entry with
        // the built-in's own display name.
        let registry = AgentRegistry::with_spec_source(Arc::new(FakeSource(vec![
            external("cursor"),
        ])));
        let specs = registry.known_specs();
        let cursor: Vec<&AgentSpec> = specs.iter().filter(|s| s.spec_id == "cursor").collect();
        assert_eq!(cursor.len(), 1);
        assert_eq!(cursor[0].command, "npx -y cursor");
        assert_eq!(cursor[0].display_name, AgentSpec::cursor().display_name);
        assert_eq!(specs.len(), AgentSpec::all_known().len());
    }

    #[test]
    fn auto_managed_builtin_keeps_bare_command_without_a_dynamic_spec() {
        // Nothing acquired (offline / no manifest) → pre-existing behaviour.
        let registry = AgentRegistry::with_spec_source(Arc::new(FakeSource(vec![])));
        let specs = registry.known_specs();
        let cursor = specs.iter().find(|s| s.spec_id == "cursor").unwrap();
        assert_eq!(cursor.command, "cursor-agent acp");
    }
}

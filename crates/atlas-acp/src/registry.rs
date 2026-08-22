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
use crate::schema::{LoadedSessionInfo, NewSessionInfo};
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

/// The sole provider of spawnable ACP agents — implemented by the dynamic ACP
/// registry (`atlas-registry`).
///
/// There is no second source. Atlas ships **zero** built-in ACP agents: an
/// external agent is spawnable if and only if the user installed it, exactly
/// the way Zed derives `external_agents` solely from its `agent_servers`
/// settings map. The native in-process agent (Cersei) is not an ACP agent and
/// never travels through here.
pub trait SpecSource: Send + Sync {
    fn extra_specs(&self) -> Vec<AgentSpec>;
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

    /// Production constructor: every spec comes from the registry store.
    pub fn with_spec_source(source: Arc<dyn SpecSource>) -> Self {
        Self {
            inner: Arc::new(DashMap::new()),
            dynamic: Some(source),
        }
    }

    /// The installed agents, and nothing else.
    ///
    /// Without a [`SpecSource`] this is empty — which is the correct answer for
    /// a host that has installed no agents, and the reason a fresh Atlas shows
    /// only its native agent. Ids are unique by construction (the install store
    /// is keyed by id), so there is no precedence rule to apply here any more.
    pub fn known_specs(&self) -> Vec<AgentSpec> {
        self.dynamic
            .as_ref()
            .map(|source| source.extra_specs())
            .unwrap_or_default()
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
    pub async fn spawn(&self, spec_id: &str, sink: Arc<dyn EventSink>) -> Result<AgentInfo> {
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
        let info: NewSessionInfo = resp.into();
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
    ) -> Result<LoadedSessionInfo> {
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
        let config_options = serde_json::to_value(&resp.config_options).ok();
        let modes = resp
            .modes
            .as_ref()
            .and_then(|m| serde_json::to_value(m).ok())
            .or_else(|| {
                config_options
                    .as_ref()
                    .and_then(crate::schema::modes_blob_from_config_options)
            });
        Ok(LoadedSessionInfo {
            modes,
            config_options: config_options
                .filter(|v| v.as_array().is_some_and(|a| !a.is_empty())),
        })
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
    /// Called from `new_session` / `load_session`.
    pub fn register_session(&self, agent_id: AgentId, session_id: SessionId) -> Result<()> {
        let entry = self.inner.get(&agent_id).ok_or(AcpError::UnknownAgent)?;
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
        let entry = self.inner.get(&agent_id).ok_or(AcpError::UnknownAgent)?;
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
    pub fn mark_turn_started(&self, agent_id: AgentId, session_id: &SessionId) -> Result<u64> {
        let entry = self.inner.get(&agent_id).ok_or(AcpError::UnknownAgent)?;
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
    /// Set one of the agent's advertised config options.
    ///
    /// `value` is the raw JSON the UI produced, mapped onto the wire shape ACP
    /// defines: a JSON bool becomes a `boolean` value, anything else becomes a
    /// `value_id` (the form every id-based option kind — `select`, `radio`, … —
    /// uses). The option ids and their legal values come from the agent's own
    /// `config_options` advertisement; Atlas never enumerates them.
    pub async fn set_session_config_option(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        config_id: &str,
        value: serde_json::Value,
    ) -> Result<()> {
        let connection = self.connection(agent_id)?;
        let wire = match &value {
            serde_json::Value::Bool(b) => SessionConfigOptionValue::boolean(*b),
            serde_json::Value::String(s) => SessionConfigOptionValue::value_id(s.clone()),
            other => SessionConfigOptionValue::value_id(other.to_string()),
        };
        rpc_timeout("session/set_config_option", TUNING_RPC_SECS, async {
            connection
                .send_request(SetSessionConfigOptionRequest::new(
                    session_id,
                    config_id.to_string(),
                    wire,
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
        let entry = self.inner.get(&agent_id).ok_or(AcpError::UnknownAgent)?;
        if let Some(guard) = entry.runtime.session_guards.get(&session_id) {
            guard.mark_cancelled();
        }
        entry
            .runtime
            .pending_permissions
            .retain(|_, p| p.session_id != session_id);
        let connection = entry.runtime.connection.clone();
        drop(entry);
        connection.send_notification(CancelNotification::new(session_id))?;
        Ok(())
    }

    /// Drop every pending permission for a session, returning their ids.
    /// Dropping the oneshot sender resolves the driver's `rx.await` as
    /// `Cancelled`, so the agent gets a clean outcome for each in-flight
    /// request (ACP spec). Called by the session actor when a turn
    /// finalizes, so no modal survives its turn (H6/M3).
    pub fn take_pending_permissions(&self, agent_id: AgentId, session_id: &SessionId) -> Vec<Uuid> {
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
        let entry = self.inner.get(&agent_id).ok_or(AcpError::UnknownAgent)?;
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

    fn connection(
        &self,
        agent_id: AgentId,
    ) -> Result<agent_client_protocol::ConnectionTo<agent_client_protocol::Agent>> {
        let entry = self.inner.get(&agent_id).ok_or(AcpError::UnknownAgent)?;
        Ok(entry.runtime.connection.clone())
    }

    /// Auth methods the agent advertised in its `initialize` response.
    /// Empty if the agent doesn't support any (or didn't run `initialize`
    /// successfully — though spawn would have errored in that case).
    pub fn auth_methods(&self, agent_id: AgentId) -> Result<Vec<AuthMethodWire>> {
        let entry = self.inner.get(&agent_id).ok_or(AcpError::UnknownAgent)?;
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
    fn a_host_with_no_registry_source_can_spawn_nothing() {
        // The fresh-install invariant: Atlas ships zero built-in ACP agents, so
        // with no install store wired up there is nothing to spawn. Anything
        // that reintroduces a hardcoded agent table fails here.
        assert!(AgentRegistry::new().known_specs().is_empty());
    }

    #[test]
    fn known_specs_is_exactly_what_the_registry_installed() {
        let registry = AgentRegistry::with_spec_source(Arc::new(FakeSource(vec![
            external("amp-acp"),
            external("claude-acp"),
        ])));
        let mut ids: Vec<String> = registry
            .known_specs()
            .into_iter()
            .map(|s| s.spec_id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["amp-acp".to_string(), "claude-acp".to_string()]);
    }

    #[test]
    fn no_agent_id_gets_special_precedence() {
        // The ids Atlas used to hardcode as built-ins are now ordinary registry
        // entries: their command comes from the install record like any other
        // agent's, with no first-party table shadowing it.
        for id in [
            "claude-acp",
            "codex-acp",
            "cursor",
            "opencode",
            "kilo",
            "gemini",
        ] {
            let registry =
                AgentRegistry::with_spec_source(Arc::new(FakeSource(vec![external(id)])));
            let specs = registry.known_specs();
            assert_eq!(specs.len(), 1, "{id} must resolve to exactly one spec");
            assert_eq!(specs[0].command, format!("npx -y {id}"));
        }
    }

    #[test]
    fn an_uninstalled_agent_is_not_spawnable() {
        let registry = AgentRegistry::with_spec_source(Arc::new(FakeSource(vec![])));
        assert!(registry.known_specs().iter().all(|s| s.spec_id != "cursor"));
    }
}

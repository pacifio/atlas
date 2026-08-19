//! Backend abstraction over the two agent transports.
//!
//! `atlas-agents`' manager + worker are agent-agnostic above the `EventSink` /
//! `AcpEvent` boundary. This trait captures exactly the operations they invoke
//! on a backend, so a session can be driven by either:
//!
//! - [`AcpBackend`] — the out-of-process ACP agents (Claude Code, Codex),
//!   delegating to `atlas_acp::AgentRegistry`, or
//! - [`CerseiBackend`] — the in-process native agent, delegating to
//!   `atlas_cersei::CerseiRuntime`.
//!
//! Both emit the same `AcpEvent`s through the same sink, so everything
//! downstream (dispatch, `SessionState`, the UI) is identical.

use std::path::PathBuf;

use async_trait::async_trait;
use atlas_acp::{
    AgentRegistry, AuthMethodWire, ImageAttachment, NewSessionInfo, PermissionDecision,
    Result as AcpResult,
};
use atlas_acp::{AgentId, SessionId};
use atlas_cersei::CerseiRuntime;
use uuid::Uuid;

/// The slice of agent-transport behaviour the manager + worker depend on.
#[async_trait]
pub trait AgentBackend: Send + Sync {
    async fn new_session(&self, agent_id: AgentId, cwd: PathBuf) -> AcpResult<NewSessionInfo>;
    async fn load_session(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        cwd: PathBuf,
    ) -> AcpResult<Option<serde_json::Value>>;
    /// Drive one prompt turn; returns the canonical snake_case stop-reason
    /// token ("end_turn", "max_tokens", …) per the frontend contract in
    /// `src/types/acp.ts`.
    async fn send_prompt(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        text: String,
    ) -> AcpResult<String>;
    async fn set_session_mode(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        mode_id: String,
    ) -> AcpResult<()>;
    /// Select the session's model. ACP → `session/set_model`; native agent
    /// applies it to the next turn. Default: no-op.
    async fn set_session_model(
        &self,
        _agent_id: AgentId,
        _session_id: SessionId,
        _model_id: String,
    ) -> AcpResult<()> {
        Ok(())
    }
    /// Update the session's reasoning-effort level. Default: no-op (only the
    /// native agent applies a thinking budget).
    fn set_effort(&self, _agent_id: AgentId, _session_id: &SessionId, _effort: String) -> AcpResult<()> {
        Ok(())
    }
    /// Toggle RTK tool-output compression. Default: no-op (native agent only).
    fn set_compress(&self, _agent_id: AgentId, _session_id: &SessionId, _on: bool) -> AcpResult<()> {
        Ok(())
    }
    /// Stage image attachments to ride on the session's next prompt.
    /// Default: no-op (the native agent has no multimodal input path yet;
    /// its frontend gate — `prompt_image_supported() == false` — means
    /// images degrade to path mentions before ever reaching here).
    fn stage_attachments(
        &self,
        _agent_id: AgentId,
        _session_id: SessionId,
        _attachments: Vec<ImageAttachment>,
    ) -> AcpResult<()> {
        Ok(())
    }
    /// Whether the agent advertised `promptCapabilities.image` at
    /// initialize. Default: false (native agent, unknown agents).
    fn prompt_image_supported(&self, _agent_id: AgentId) -> bool {
        false
    }
    /// Re-arm the session lifecycle guard for a new turn and return the new
    /// turn epoch (the identity stamped onto this turn's events).
    fn mark_turn_started(&self, agent_id: AgentId, session_id: &SessionId) -> AcpResult<u64>;
    fn cancel_turn(&self, agent_id: AgentId, session_id: SessionId) -> AcpResult<()>;
    /// Route a user message into the running turn (mid-turn steering).
    /// Default: unsupported — callers fall back to supersede. Only the native
    /// agent steers; ACP subprocess agents own their loops.
    fn steer_turn(
        &self,
        _agent_id: AgentId,
        _session_id: &SessionId,
        _text: String,
    ) -> AcpResult<()> {
        Err(atlas_acp::AcpError::other("steering not supported"))
    }
    fn respond_permission(
        &self,
        agent_id: AgentId,
        request_id: Uuid,
        decision: PermissionDecision,
    ) -> AcpResult<()>;
    /// Resolve every pending permission for the session as cancelled,
    /// returning their ids (turn finalized — no modal survives its turn).
    fn sweep_permissions(&self, _agent_id: AgentId, _session_id: &SessionId) -> Vec<Uuid> {
        Vec::new()
    }
    fn register_session(&self, agent_id: AgentId, session_id: SessionId) -> AcpResult<()>;
    fn drop_session(&self, agent_id: AgentId, session_id: &SessionId) -> AcpResult<()>;
    fn auth_methods(&self, agent_id: AgentId) -> AcpResult<Vec<AuthMethodWire>>;
    async fn authenticate(&self, agent_id: AgentId, method_id: String) -> AcpResult<()>;
    fn kill(&self, agent_id: AgentId) -> AcpResult<()>;
}

fn session_id_str(id: &SessionId) -> String {
    serde_json::to_value(id)
        .ok()
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default()
}

// ─── ACP (subprocess) backend ─────────────────────────────────────────────────

/// Wraps the shared `AgentRegistry`. Cloneable (registry is `Arc`-backed).
#[derive(Clone)]
pub struct AcpBackend(pub AgentRegistry);

#[async_trait]
impl AgentBackend for AcpBackend {
    async fn new_session(&self, agent_id: AgentId, cwd: PathBuf) -> AcpResult<NewSessionInfo> {
        self.0.new_session(agent_id, cwd).await
    }
    async fn load_session(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        cwd: PathBuf,
    ) -> AcpResult<Option<serde_json::Value>> {
        self.0.load_session(agent_id, session_id, cwd).await
    }
    fn stage_attachments(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        attachments: Vec<ImageAttachment>,
    ) -> AcpResult<()> {
        self.0.stage_attachments(agent_id, session_id, attachments)
    }
    fn prompt_image_supported(&self, agent_id: AgentId) -> bool {
        self.0.prompt_image_supported(agent_id)
    }
    async fn send_prompt(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        text: String,
    ) -> AcpResult<String> {
        let reason = self.0.send_prompt(agent_id, session_id, text).await?;
        // Serialize via serde to get the canonical snake_case wire tokens
        // ("end_turn", "max_tokens", …) the frontend contract expects;
        // Debug-lowercasing produced "endturn" which the UI never matched.
        Ok(serde_json::to_value(reason)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_else(|| {
                // Unreachable for a fieldless serde enum; if an upstream change
                // ever makes it fire, don't mask it as a silent normal finish.
                tracing::warn!(
                    target: "atlas_agents::backend",
                    ?reason,
                    "stop reason failed to serialize; defaulting to end_turn"
                );
                "end_turn".to_string()
            }))
    }
    async fn set_session_mode(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        mode_id: String,
    ) -> AcpResult<()> {
        self.0.set_session_mode(agent_id, session_id, mode_id).await
    }
    async fn set_session_model(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        model_id: String,
    ) -> AcpResult<()> {
        // Two model-selection dialects exist in the wild. claude-agent-acp /
        // codex-acp expose the model as a `config_options` entry (id "model")
        // and take `session/set_config_option`; OpenCode (and Cursor) return a
        // `models` blob instead and implement only `session/set_model` —
        // set_config_option is a hard -32601 there (verified live). Config
        // option goes first (the established adapters answer it instantly);
        // on failure the set_model fallback runs, and if BOTH fail the
        // config-option error is reported since that's the primary dialect.
        match self
            .0
            .set_session_config_option(agent_id, session_id.clone(), "model", model_id.clone())
            .await
        {
            Ok(()) => Ok(()),
            Err(config_err) => match self
                .0
                .set_session_model(agent_id, session_id, model_id)
                .await
            {
                Ok(()) => Ok(()),
                Err(_) => Err(config_err),
            },
        }
    }
    fn mark_turn_started(&self, agent_id: AgentId, session_id: &SessionId) -> AcpResult<u64> {
        self.0.mark_turn_started(agent_id, session_id)
    }
    fn cancel_turn(&self, agent_id: AgentId, session_id: SessionId) -> AcpResult<()> {
        self.0.cancel_turn(agent_id, session_id)
    }
    fn respond_permission(
        &self,
        agent_id: AgentId,
        request_id: Uuid,
        decision: PermissionDecision,
    ) -> AcpResult<()> {
        self.0.respond_permission(agent_id, request_id, decision)
    }
    fn sweep_permissions(&self, agent_id: AgentId, session_id: &SessionId) -> Vec<Uuid> {
        self.0.take_pending_permissions(agent_id, session_id)
    }
    fn register_session(&self, agent_id: AgentId, session_id: SessionId) -> AcpResult<()> {
        self.0.register_session(agent_id, session_id)
    }
    fn drop_session(&self, agent_id: AgentId, session_id: &SessionId) -> AcpResult<()> {
        self.0.drop_session(agent_id, session_id)
    }
    fn auth_methods(&self, agent_id: AgentId) -> AcpResult<Vec<AuthMethodWire>> {
        self.0.auth_methods(agent_id)
    }
    async fn authenticate(&self, agent_id: AgentId, method_id: String) -> AcpResult<()> {
        self.0.authenticate(agent_id, method_id).await
    }
    fn kill(&self, agent_id: AgentId) -> AcpResult<()> {
        self.0.kill(agent_id)
    }
}

// ─── Cersei (in-process) backend ──────────────────────────────────────────────

/// Wraps the native `CerseiRuntime`. Cloneable (`Arc`-backed).
#[derive(Clone)]
pub struct CerseiBackend(pub CerseiRuntime);

#[async_trait]
impl AgentBackend for CerseiBackend {
    async fn new_session(&self, agent_id: AgentId, cwd: PathBuf) -> AcpResult<NewSessionInfo> {
        self.0.new_session(agent_id, cwd)
    }
    async fn load_session(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        cwd: PathBuf,
    ) -> AcpResult<Option<serde_json::Value>> {
        self.0.load_session(agent_id, session_id, cwd)
    }
    async fn send_prompt(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        text: String,
    ) -> AcpResult<String> {
        self.0.send_prompt(agent_id, session_id, text).await
    }
    async fn set_session_mode(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        mode_id: String,
    ) -> AcpResult<()> {
        self.0.set_session_mode(agent_id, &session_id_str(&session_id), mode_id)
    }
    async fn set_session_model(
        &self,
        agent_id: AgentId,
        session_id: SessionId,
        model_id: String,
    ) -> AcpResult<()> {
        self.0.set_model(agent_id, &session_id_str(&session_id), model_id)
    }
    fn set_effort(&self, agent_id: AgentId, session_id: &SessionId, effort: String) -> AcpResult<()> {
        self.0.set_effort(agent_id, &session_id_str(session_id), effort)
    }
    fn set_compress(&self, agent_id: AgentId, session_id: &SessionId, on: bool) -> AcpResult<()> {
        self.0.set_compress(agent_id, &session_id_str(session_id), on)
    }
    fn mark_turn_started(&self, agent_id: AgentId, session_id: &SessionId) -> AcpResult<u64> {
        self.0.mark_turn_started(agent_id, &session_id_str(session_id))
    }
    fn cancel_turn(&self, agent_id: AgentId, session_id: SessionId) -> AcpResult<()> {
        self.0.cancel_turn(agent_id, &session_id_str(&session_id))
    }
    fn steer_turn(&self, agent_id: AgentId, session_id: &SessionId, text: String) -> AcpResult<()> {
        self.0.steer_turn(agent_id, &session_id_str(session_id), text)
    }
    fn respond_permission(
        &self,
        agent_id: AgentId,
        request_id: Uuid,
        decision: PermissionDecision,
    ) -> AcpResult<()> {
        self.0.respond_permission(agent_id, request_id, decision)
    }
    fn sweep_permissions(&self, agent_id: AgentId, session_id: &SessionId) -> Vec<Uuid> {
        self.0.sweep_permissions(agent_id, &session_id_str(session_id))
    }
    fn register_session(&self, _agent_id: AgentId, _session_id: SessionId) -> AcpResult<()> {
        // The runtime registers sessions itself in new_session / load_session.
        Ok(())
    }
    fn drop_session(&self, _agent_id: AgentId, _session_id: &SessionId) -> AcpResult<()> {
        Ok(())
    }
    fn auth_methods(&self, _agent_id: AgentId) -> AcpResult<Vec<AuthMethodWire>> {
        Ok(Vec::new())
    }
    async fn authenticate(&self, _agent_id: AgentId, _method_id: String) -> AcpResult<()> {
        Ok(())
    }
    fn kill(&self, agent_id: AgentId) -> AcpResult<()> {
        self.0.kill(agent_id)
    }
}

#[cfg(test)]
mod tests {
    use atlas_acp::StopReason;

    /// The frontend contract (`src/types/acp.ts`) consumes these exact tokens.
    /// The original ATL-6 bug was an ad-hoc `format!("{r:?}").to_ascii_lowercase()`
    /// producing "endturn" — this pins the serde round-trip `send_prompt` relies on.
    #[test]
    fn stop_reason_serializes_to_snake_case_wire_tokens() {
        for (reason, want) in [
            (StopReason::EndTurn, "end_turn"),
            (StopReason::MaxTokens, "max_tokens"),
            (StopReason::MaxTurnRequests, "max_turn_requests"),
            (StopReason::Refusal, "refusal"),
            (StopReason::Cancelled, "cancelled"),
        ] {
            assert_eq!(serde_json::to_value(reason).unwrap(), want);
        }
    }
}

//! `AgentConnection` adapter over the existing `AgentBackend`.
//!
//! During the staged migration the session actor drives turns through
//! [`atlas_agentkit::AgentConnection`], but the underlying transports still
//! speak the older [`AgentBackend`] trait. `BackendConnection` bridges the two:
//! it wraps one agent's `Arc<dyn AgentBackend>` + its `AgentId` and exposes it
//! as a per-session-agnostic connection, mapping the flat `set_*` methods onto
//! the `Option<Arc<dyn …>>` capability sub-traits.
//!
//! Every capability is advertised here (the backend has a no-op default for the
//! ones a given transport doesn't support); Stage 3 replaces this adapter with
//! native `AgentConnection` impls in `atlas-acp` / `atlas-cersei` that return
//! `None` for capabilities they genuinely lack.

use std::sync::Arc;

use async_trait::async_trait;
use atlas_acp::{AgentId, AuthMethodWire, ContentBlock, PermissionDecision, Result, SessionId};
use atlas_agentkit::{
    AgentConnection, AuthFlow, CompressionCtl, EffortControl, ModelSelector, SessionModes,
};
use uuid::Uuid;

use crate::backend::AgentBackend;

/// Adapts one agent's `AgentBackend` to the `AgentConnection` trait.
#[derive(Clone)]
pub struct BackendConnection {
    backend: Arc<dyn AgentBackend>,
    agent_id: AgentId,
}

impl BackendConnection {
    pub fn new(backend: Arc<dyn AgentBackend>, agent_id: AgentId) -> Self {
        Self { backend, agent_id }
    }

    fn caps(&self) -> Arc<BackendCaps> {
        Arc::new(BackendCaps {
            backend: self.backend.clone(),
            agent_id: self.agent_id,
        })
    }
}

#[async_trait]
impl AgentConnection for BackendConnection {
    async fn prompt(&self, session: SessionId, content: Vec<ContentBlock>) -> Result<String> {
        self.backend
            .send_prompt(self.agent_id, session, content)
            .await
    }

    fn mark_turn_started(&self, session: &SessionId) -> Result<u64> {
        self.backend.mark_turn_started(self.agent_id, session)
    }

    fn cancel(&self, session: SessionId) -> Result<()> {
        self.backend.cancel_turn(self.agent_id, session)
    }

    fn respond_permission(&self, request_id: Uuid, decision: PermissionDecision) -> Result<()> {
        self.backend
            .respond_permission(self.agent_id, request_id, decision)
    }

    fn sweep_permissions(&self, session: &SessionId) -> Vec<Uuid> {
        self.backend.sweep_permissions(self.agent_id, session)
    }

    fn model_selector(&self) -> Option<Arc<dyn ModelSelector>> {
        Some(self.caps())
    }
    fn session_modes(&self) -> Option<Arc<dyn SessionModes>> {
        Some(self.caps())
    }
    fn effort_control(&self) -> Option<Arc<dyn EffortControl>> {
        Some(self.caps())
    }
    fn compression(&self) -> Option<Arc<dyn CompressionCtl>> {
        Some(self.caps())
    }
    fn auth(&self) -> Option<Arc<dyn AuthFlow>> {
        Some(self.caps())
    }
}

/// Shared capability holder — one struct implements every sub-trait by
/// delegating to the backend with the bound `agent_id`.
struct BackendCaps {
    backend: Arc<dyn AgentBackend>,
    agent_id: AgentId,
}

#[async_trait]
impl ModelSelector for BackendCaps {
    async fn select(&self, session: &SessionId, model_id: String) -> Result<()> {
        self.backend
            .set_session_model(self.agent_id, session.clone(), model_id)
            .await
    }
}

#[async_trait]
impl SessionModes for BackendCaps {
    async fn set(&self, session: &SessionId, mode_id: String) -> Result<()> {
        self.backend
            .set_session_mode(self.agent_id, session.clone(), mode_id)
            .await
    }
}

impl EffortControl for BackendCaps {
    fn set(&self, session: &SessionId, effort: String) -> Result<()> {
        self.backend.set_effort(self.agent_id, session, effort)
    }
}

impl CompressionCtl for BackendCaps {
    fn set(&self, session: &SessionId, on: bool) -> Result<()> {
        self.backend.set_compress(self.agent_id, session, on)
    }
}

#[async_trait]
impl AuthFlow for BackendCaps {
    fn methods(&self) -> Vec<AuthMethodWire> {
        self.backend.auth_methods(self.agent_id).unwrap_or_default()
    }
    async fn authenticate(&self, method_id: String) -> Result<()> {
        self.backend.authenticate(self.agent_id, method_id).await
    }
}

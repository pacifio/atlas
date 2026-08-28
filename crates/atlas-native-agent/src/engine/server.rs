//! The launcher for the native agent, on the ported engine.
//!
//! The counterpart of `crate::server::CerseiAgentServer`, implementing the same
//! `AgentServer` trait against the same agent id. That sameness is the switch:
//! `src-tauri` registers one of these two and cannot tell the difference
//! afterwards, because everything downstream of `connect` is the trait.
//!
//! Like the Cersei one, `connect` starts no process — the engine runs in this
//! one (ADR-0004) — and ignores the delegate, because there is no command to
//! resolve and no binary to download.

use std::any::Any;
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use anyhow::Result;
use atlas_acp_thread::{AgentConnection, AgentId};
use atlas_agent_servers::{AgentServer, AgentServerDelegate, ConnectOptions};
use codex_login::auth::ExternalAuth;
use futures::future::BoxFuture;
use futures::FutureExt;

use crate::engine::config::EngineSettings;
use crate::engine::connection::EngineConnection;
use crate::server::CERSEI_AGENT_ID;

/// The native agent, on the ported engine.
#[derive(Clone)]
pub struct EngineAgentServer {
    settings: EngineSettings,
    /// The D10 token provider.
    ///
    /// `None` runs the engine against a developer-configured provider that
    /// authenticates some other way — which is exactly the Phase 2 tracer
    /// bullet, before the gateway dialect exists to need an account.
    external_auth: Option<Arc<dyn ExternalAuth>>,
    default_mode: Option<acp::SessionModeId>,
}

impl EngineAgentServer {
    pub fn new(settings: EngineSettings) -> Self {
        Self {
            settings,
            external_auth: None,
            default_mode: None,
        }
    }

    pub fn with_external_auth(mut self, external_auth: Arc<dyn ExternalAuth>) -> Self {
        self.external_auth = Some(external_auth);
        self
    }

    pub fn with_default_mode(mut self, mode: Option<acp::SessionModeId>) -> Self {
        self.default_mode = mode;
        self
    }

    pub fn settings(&self) -> &EngineSettings {
        &self.settings
    }
}

impl AgentServer for EngineAgentServer {
    /// The same id the Cersei path occupies.
    ///
    /// Deliberate, and load-bearing: the stored agent id is a storage key
    /// (D7 / CONTEXT.md), so a thread recorded before the switch still resolves
    /// after it. Minting a new id here would orphan every existing native row.
    fn agent_id(&self) -> AgentId {
        AgentId::new(CERSEI_AGENT_ID)
    }

    fn connect(
        &self,
        _delegate: AgentServerDelegate,
        options: ConnectOptions,
    ) -> BoxFuture<'static, Result<Arc<dyn AgentConnection>>> {
        let id = self.agent_id();
        let external_auth = self.external_auth.clone();
        let thread_events = options.thread_events.clone();
        let mut settings = self.settings.clone();
        if let Some(root) = options.root_dir.clone() {
            settings.cwd = root;
        }

        async move {
            let connection = EngineConnection::connect(id, settings, thread_events, external_auth)
                .await?;
            Ok(connection as Arc<dyn AgentConnection>)
        }
        .boxed()
    }

    fn into_any(self: Arc<Self>) -> Arc<dyn Any + Send + Sync> {
        self
    }

    fn default_mode(&self) -> Option<acp::SessionModeId> {
        self.default_mode.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::config::{EngineHome, EngineProvider};
    use std::path::PathBuf;

    fn server() -> EngineAgentServer {
        EngineAgentServer::new(EngineSettings::new(
            EngineHome::at("/tmp/atlas-engine-test"),
            EngineProvider::dev("dev", "https://example.invalid/v1", None),
            "gpt-5-codex",
            PathBuf::from("/tmp"),
        ))
    }

    #[test]
    fn both_engines_occupy_the_same_agent_id() {
        // The switch only works if the app cannot tell them apart, and the
        // stored id is a storage key: a new id here would orphan every native
        // history row written before the switch (D7).
        assert_eq!(server().agent_id().as_str(), CERSEI_AGENT_ID);
        assert_eq!(
            server().agent_id(),
            crate::server::CerseiAgentServer::new(PathBuf::from("/tmp")).agent_id(),
        );
    }

    #[test]
    fn the_token_provider_is_optional_so_a_dev_provider_can_carry_the_turn() {
        assert!(server().external_auth.is_none());
    }
}

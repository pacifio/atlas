//! The launcher for the native agent, on the ported engine.
//!
//! The only implementation of `AgentServer` for the native agent. It was one of
//! two while the port was being proved; the Cersei one is gone (#54), and what
//! made the swap invisible was that both answered to the same agent id.
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
use crate::CERSEI_AGENT_ID;

/// The native agent, on the ported engine.
#[derive(Clone)]
pub struct EngineAgentServer {
    settings: EngineSettings,
    /// The D10 token provider.
    ///
    /// `None` falls back to whatever token source the host registered, and
    /// failing that runs against a provider that authenticates some other way
    /// — the Phase 2 dev provider, which resolves a key from the environment.
    external_auth: Option<Arc<dyn ExternalAuth>>,
    default_mode: Option<acp::SessionModeId>,
    /// Retrieval for `search_memory`, when the caller supplies one directly.
    ///
    /// `None` falls back to whatever the host registered, so a test can pass
    /// its own without global state and the app does not have to thread one
    /// through a `cfg`-gated constructor.
    memory_search: Option<crate::engine::memory::MemorySearch>,
}

impl EngineAgentServer {
    pub fn new(settings: EngineSettings) -> Self {
        Self {
            settings,
            external_auth: None,
            default_mode: None,
            memory_search: None,
        }
    }

    pub fn with_memory_search(
        mut self,
        memory_search: crate::engine::memory::MemorySearch,
    ) -> Self {
        self.memory_search = Some(memory_search);
        self
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
        // Resolved here rather than in the constructor: `AgentHost` is built
        // during startup, before the auth state exists, so a source read at
        // construction would always be absent and every turn would go out with
        // no credential.
        let external_auth = self.external_auth.clone().or_else(|| {
            crate::engine::auth::registered_token_source().map(|source| {
                Arc::new(crate::engine::auth::AtlasExternalAuth::new(source)) as Arc<dyn ExternalAuth>
            })
        });
        let default_mode = self.default_mode.clone().or_else(|| options.defaults.mode.clone());
        let memory_search = self
            .memory_search
            .clone()
            .or_else(crate::engine::memory::registered_search);
        let thread_events = options.thread_events.clone();
        let mut settings = self.settings.clone();
        if let Some(root) = options.root_dir.clone() {
            settings.cwd = root;
        }

        async move {
            let connection = EngineConnection::connect_full(
                id,
                settings,
                thread_events,
                external_auth,
                default_mode,
                memory_search,
            )
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
    fn the_agent_id_is_the_storage_key_the_history_was_written_under() {
        // Not a name. Every recorded thread resolves through this string, so
        // changing it is a data migration rather than a rename — which is why
        // it survived the deletion of the path it was named after (D7).
        assert_eq!(server().agent_id().as_str(), CERSEI_AGENT_ID);
        assert_eq!(
            CERSEI_AGENT_ID, "cersei",
            "the stored id is a storage key, not a name — every recorded thread \
             resolves through it, so it outlives the retirement of the name (D7)",
        );
    }

    #[test]
    fn the_token_provider_is_optional_so_a_dev_provider_can_carry_the_turn() {
        assert!(server().external_auth.is_none());
    }

    #[test]
    fn a_registered_token_source_reaches_a_server_that_was_built_without_one() {
        // The ordering this pins: `AgentHost` builds the server during startup,
        // before the auth state exists. If the credential were resolved in the
        // constructor it would always be absent here, and every turn would go
        // out unauthenticated against a gateway that answers 401 — a failure
        // that looks like a broken account rather than a broken wiring order.
        struct Fake;
        impl crate::engine::auth::AtlasTokenSource for Fake {
            fn mint(&self) -> crate::engine::auth::ExternalAuthFuture<'_, String> {
                Box::pin(async { Ok("registered-jwt".to_string()) })
            }
        }
        crate::engine::auth::register_token_source(Arc::new(Fake));

        // Built with no credential of its own, exactly as `select_native_agent`
        // builds it.
        assert!(
            server().external_auth.is_none(),
            "the server is constructed without a credential",
        );
        assert!(
            crate::engine::auth::registered_token_source().is_some(),
            "and finds one at connect time",
        );
    }

}

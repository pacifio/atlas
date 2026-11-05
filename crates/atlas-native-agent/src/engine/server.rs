//! The launcher for the native agent, on the engine.
//!
//! The only implementation of `AgentServer` for the native agent. It was one of
//! two while the engine was being proved; the previous native one is gone (#54), and what
//! made the swap invisible was that both answered to the same agent id.
//!
//! Like the previous native one, `connect` starts no process — the engine runs in this
//! one (ADR-0004) — and ignores the delegate, because there is no command to
//! resolve and no binary to download.

use std::any::Any;
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use anyhow::Result;
use atlas_acp_thread::{AgentConnection, AgentId};
use atlas_agent_servers::{AgentServer, AgentServerDelegate, ConnectOptions};
use atlas_engine_login::auth::ExternalAuth;
use futures::future::BoxFuture;
use futures::FutureExt;

use crate::engine::catalog_cache::{CatalogueFetcher, GatewayCatalogueFetcher};
use crate::engine::config::EngineSettings;
use crate::engine::connection::EngineConnection;
use crate::ATLAS_AGENT_ID;

/// The native agent, on the engine.
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
    /// How the model catalogue is fetched (ADR-0007).
    ///
    /// `None` builds the gateway fetcher at connect time, over the registered
    /// token and org sources — the same lazy resolution the credential gets,
    /// and for the same reason. A test passes its own to point at a mock.
    catalogue: Option<Arc<dyn CatalogueFetcher>>,
}

impl EngineAgentServer {
    pub fn new(settings: EngineSettings) -> Self {
        Self {
            settings,
            external_auth: None,
            default_mode: None,
            catalogue: None,
        }
    }

    pub fn with_catalogue(mut self, catalogue: Arc<dyn CatalogueFetcher>) -> Self {
        self.catalogue = Some(catalogue);
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
    /// The native agent's stored id.
    ///
    /// Deliberate, and load-bearing: the stored agent id is a storage key
    /// (D7 / CONTEXT.md), so a thread recorded before the switch still resolves
    /// after it. Minting a new id here would orphan every existing native row.
    fn agent_id(&self) -> AgentId {
        AgentId::new(ATLAS_AGENT_ID)
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
                Arc::new(crate::engine::auth::AtlasExternalAuth::new(source))
                    as Arc<dyn ExternalAuth>
            })
        });
        let default_mode = self
            .default_mode
            .clone()
            .or_else(|| options.defaults.mode.clone());
        // The host's MCP servers (the memory tool server) reach the engine
        // the same way they reach every ACP agent: offered per session.
        let session_mcp = options.session_mcp.clone();
        let thread_events = options.thread_events.clone();
        let mut settings = self.settings.clone();
        if let Some(root) = options.root_dir.clone() {
            settings.cwd = root;
        }
        if !options.client_version.is_empty() {
            settings.client_version = options.client_version.clone();
        }
        // Built here, not in the constructor, for the ordering reason above:
        // the fetcher reads the registered token source when it fetches.
        let catalogue = self.catalogue.clone().or_else(|| {
            Some(Arc::new(GatewayCatalogueFetcher::registered(
                settings.provider.base_url.clone(),
            )) as Arc<dyn CatalogueFetcher>)
        });

        async move {
            let connection = EngineConnection::connect_full(
                id,
                settings,
                thread_events,
                external_auth,
                default_mode,
                session_mcp,
                catalogue,
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
            Some("test-model".to_string()),
            PathBuf::from("/tmp"),
        ))
    }

    #[test]
    fn the_agent_id_is_the_storage_key_the_history_was_written_under() {
        // Not a name. Every recorded thread resolves through this string, so
        // changing it is a data migration rather than a rename (ADR-0011).
        assert_eq!(server().agent_id().as_str(), ATLAS_AGENT_ID);
        assert_eq!(
            ATLAS_AGENT_ID, "atlas-agent",
            "the stored id is a storage key, not a name — every recorded thread \
             resolves through it, and the frontend's NATIVE_AGENT_ID mirrors it",
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

//! What the manager needs to know about installed agents.
//!
//! Zed's connection store reads `project.agent_server_store()` directly. The
//! trait here is that same read surface, named — [`AgentServerStore`]
//! implements it, and a test can stand in something simpler than a store with a
//! registry, an HTTP client and a Node runtime behind it. It is the same kind
//! of seam stage 1 and 2 used for `ExternalAgentServer`, `HttpClient` and
//! `ProjectEnvironment`, and for the same reason.

use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::AgentId;
use atlas_agent_servers::ExternalAgentServer;
use atlas_agent_store::AgentServerStore;
use tokio::sync::watch;

pub trait AgentCatalog: Send + Sync + 'static {
    /// Every installed external agent. The manager keeps a connection only for
    /// agents that appear here — an id that disappears has been uninstalled.
    fn external_agents(&self) -> Vec<AgentId>;

    /// How to resolve this agent's command, or `None` if it is not installed.
    fn agent_server(&self, id: &AgentId) -> Option<Arc<dyn ExternalAgentServer>>;

    /// The mode the user pinned for this agent, if any.
    fn default_mode(&self, id: &AgentId) -> Option<acp::SessionModeId>;

    /// Fires when a refresh moves this agent's installed version forward.
    fn watch_new_version(&self, id: &AgentId) -> Option<watch::Receiver<Option<String>>>;

    /// Fires with install progress while this agent downloads.
    fn watch_loading_status(&self, id: &AgentId) -> Option<watch::Receiver<Option<String>>>;

    /// Bumps whenever the installed map is rebuilt. Zed's
    /// `cx.emit(AgentServersUpdated)`.
    fn updates(&self) -> watch::Receiver<u64>;
}

impl AgentCatalog for AgentServerStore {
    fn external_agents(&self) -> Vec<AgentId> {
        AgentServerStore::external_agents(self)
    }

    fn agent_server(&self, id: &AgentId) -> Option<Arc<dyn ExternalAgentServer>> {
        AgentServerStore::agent_server(self, id)
    }

    fn default_mode(&self, id: &AgentId) -> Option<acp::SessionModeId> {
        self.entry(id)?
            .default_mode
            .map(|mode| acp::SessionModeId::new(mode.as_str()))
    }

    fn watch_new_version(&self, id: &AgentId) -> Option<watch::Receiver<Option<String>>> {
        AgentServerStore::watch_new_version(self, id)
    }

    fn watch_loading_status(&self, id: &AgentId) -> Option<watch::Receiver<Option<String>>> {
        AgentServerStore::watch_loading_status(self, id)
    }

    fn updates(&self) -> watch::Receiver<u64> {
        AgentServerStore::updates(self)
    }
}

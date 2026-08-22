//! The launcher layer — ported from
//! `zed-ref/crates/agent_servers/src/{agent_servers.rs, custom.rs}`.
//!
//! There is exactly **one** launcher, [`CustomAgentServer`], and it is generic.
//! Zed has no per-agent server types any more and neither does Atlas: an agent
//! exists because the user installed it, and this layer only knows how to start
//! whatever command the store resolves for it.
//!
//! The only per-agent knowledge here is [`env_quirks`], and it is deliberately
//! not a registry — see the note there.

use std::any::Any;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use anyhow::Result;
use atlas_acp_thread::{AgentConnection, AgentId};
use futures::future::BoxFuture;

use crate::connection::{AcpConnection, AcpConnectionDefaults, AgentServerCommand, ThreadEventSink};

/// Resolves the command for one installed agent.
///
/// Ported from Zed's `ExternalAgentServer` (`project/src/agent_server_store.rs:117-143`).
/// Implemented in stage 2 by `atlas-agent-store`; this crate only consumes it,
/// which is what keeps the transport independent of how a binary got onto disk.
pub trait ExternalAgentServer: Send + Sync {
    fn get_command(
        &self,
        extra_args: Vec<String>,
        extra_env: HashMap<String, String>,
    ) -> BoxFuture<'static, Result<AgentServerCommand>>;

    fn version(&self) -> Option<Arc<str>> {
        None
    }
}

/// What a connect attempt is given: the resolver for this agent, plus the
/// channels the UI watches while it starts.
///
/// Zed's carries an `Entity<AgentServerStore>` and two `watch::Sender`s; the
/// shape is the same with the store reduced to the one trait this layer needs.
///
/// `server` is optional because an in-process agent has no command to resolve —
/// Zed's `NativeAgentServer::connect` ignores the delegate for the same reason.
pub struct AgentServerDelegate {
    pub server: Option<Arc<dyn ExternalAgentServer>>,
    pub new_version_available: Option<tokio::sync::watch::Sender<Option<String>>>,
    pub loading_status: Option<tokio::sync::watch::Sender<Option<String>>>,
}

impl AgentServerDelegate {
    pub fn new(server: Arc<dyn ExternalAgentServer>) -> Self {
        Self {
            server: Some(server),
            new_version_available: None,
            loading_status: None,
        }
    }

    /// A delegate for an agent that runs in-process: no command to resolve, no
    /// binary to download, so nothing to report on either channel.
    pub fn native() -> Self {
        Self {
            server: None,
            new_version_available: None,
            loading_status: None,
        }
    }

    pub fn with_version_channel(
        mut self,
        tx: tokio::sync::watch::Sender<Option<String>>,
    ) -> Self {
        self.new_version_available = Some(tx);
        self
    }

    pub fn with_loading_status(mut self, tx: tokio::sync::watch::Sender<Option<String>>) -> Self {
        self.loading_status = Some(tx);
        self
    }
}

/// Everything about *this host* that a connect attempt needs.
///
/// Zed reads these off globals (`ReleaseChannel`, `AppVersion`, `SettingsStore`,
/// the project's MCP config). They are parameters here so this crate stays leaf-
/// level and testable.
#[derive(Clone)]
pub struct ConnectOptions {
    pub root_dir: Option<PathBuf>,
    pub defaults: AcpConnectionDefaults,
    pub thread_events: ThreadEventSink,
    pub client_name: &'static str,
    pub client_version: String,
}

pub trait AgentServer: Send + Sync {
    fn agent_id(&self) -> AgentId;

    fn connect(
        &self,
        delegate: AgentServerDelegate,
        options: ConnectOptions,
    ) -> BoxFuture<'static, Result<Arc<dyn AgentConnection>>>;

    fn into_any(self: Arc<Self>) -> Arc<dyn Any + Send + Sync>;

    fn default_mode(&self) -> Option<acp::SessionModeId> {
        None
    }
}

impl dyn AgentServer {
    pub fn downcast<T: 'static + AgentServer + Sized>(self: Arc<Self>) -> Option<Arc<T>> {
        self.into_any().downcast().ok()
    }
}

/// The one launcher. Ported from `CustomAgentServer` (`custom.rs:193-281`).
pub struct CustomAgentServer {
    id: AgentId,
    default_mode: Option<acp::SessionModeId>,
}

impl CustomAgentServer {
    pub fn new(id: AgentId) -> Self {
        Self {
            id,
            default_mode: None,
        }
    }

    pub fn with_default_mode(mut self, mode: Option<acp::SessionModeId>) -> Self {
        self.default_mode = mode;
        self
    }
}

impl AgentServer for CustomAgentServer {
    fn agent_id(&self) -> AgentId {
        self.id.clone()
    }

    fn connect(
        &self,
        delegate: AgentServerDelegate,
        options: ConnectOptions,
    ) -> BoxFuture<'static, Result<Arc<dyn AgentConnection>>> {
        let agent_id = self.id.clone();
        Box::pin(async move {
            let mut extra_env = load_proxy_env();
            extra_env.extend(env_quirks(&agent_id));

            let server = delegate.server.clone().ok_or_else(|| {
                anyhow::anyhow!("no command resolver for agent `{agent_id}`")
            })?;
            let command = server.get_command(Vec::new(), extra_env).await?;

            let connection = AcpConnection::stdio(
                agent_id,
                command,
                options.root_dir,
                options.defaults,
                options.thread_events,
                options.client_name,
                options.client_version,
            )
            .await?;

            Ok(Arc::new(connection) as Arc<dyn AgentConnection>)
        })
    }

    fn into_any(self: Arc<Self>) -> Arc<dyn Any + Send + Sync> {
        self
    }

    fn default_mode(&self) -> Option<acp::SessionModeId> {
        self.default_mode.clone()
    }
}

/// Proxy variables to pass through to the agent.
///
/// Zed sources these from its `ProxySettings`; Atlas's settings live above this
/// crate, so the process environment is the source here.
pub fn load_proxy_env() -> HashMap<String, String> {
    let mut env = HashMap::new();

    let proxy = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
        .into_iter()
        .find_map(|key| std::env::var(key).ok().map(|value| (key, value)));

    if let Some((key, value)) = proxy {
        let canonical = if key.to_ascii_lowercase().starts_with("https") {
            "HTTPS_PROXY"
        } else {
            "HTTP_PROXY"
        };
        env.insert(canonical.to_owned(), value);
    }

    if let Ok(no_proxy) = std::env::var("NO_PROXY").or_else(|_| std::env::var("no_proxy")) {
        env.insert("NO_PROXY".to_owned(), no_proxy);
    } else if !env.is_empty() {
        // Local MCP servers must not go through the proxy.
        env.insert("NO_PROXY".to_owned(), "localhost,127.0.0.1".to_owned());
    }

    env
}

// Agent ids that need an environment workaround. These are NOT a list of agents
// Atlas ships, offers, or knows how to install — an agent reaches this function
// only because the user already installed it and asked to run it. Nothing here
// creates an agent, and adding an id here must never become the way one appears.
const CLAUDE_AGENT_ID: &str = "claude-code";
const CODEX_AGENT_ID: &str = "codex";
const GEMINI_AGENT_ID: &str = "gemini";

/// Per-agent environment workarounds, ported from `custom.rs:229-254`.
///
/// Each is a fix for how that CLI behaves, not a capability decision — capability
/// questions are answered by what the agent advertises at `initialize`.
pub fn env_quirks(agent_id: &AgentId) -> HashMap<String, String> {
    let mut env = HashMap::new();

    match agent_id.as_str() {
        // Blanked, not unset: with a key present the CLI bills the key instead
        // of the subscription the user signed in with.
        CLAUDE_AGENT_ID => {
            env.insert("ANTHROPIC_API_KEY".to_owned(), String::new());
        }
        // Passed through explicitly because the CLI reads them from its own
        // environment, which a spawned child does not inherit selectively.
        CODEX_AGENT_ID => {
            for key in ["CODEX_API_KEY", "OPEN_AI_API_KEY"] {
                if let Ok(value) = std::env::var(key) {
                    env.insert(key.to_owned(), value);
                }
            }
        }
        // Identifies the host to Gemini's telemetry.
        GEMINI_AGENT_ID => {
            env.insert("SURFACE".to_owned(), "atlas".to_owned());
        }
        _ => {}
    }

    env
}

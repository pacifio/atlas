//! The launcher layer.
//!
//! There is exactly **one** launcher, [`CustomAgentServer`], and it is generic.
//! There are no per-agent server types: an agent
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

use crate::connection::{
    AcpConnection, AcpConnectionDefaults, AgentServerCommand, RequestElicitationSink,
    ThreadEventSink,
};

/// Resolves the command for one installed agent.
///
/// Implemented by `atlas-agent-store`; this crate only consumes it,
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

    /// Bring a copy this agent already has on disk up to [`Self::version`],
    /// without starting anything. `Ok(true)` when it installed something.
    ///
    /// For updates only: an agent never fetched stays lazy, so installing one
    /// from the marketplace still costs nothing until its first chat. This is
    /// what lets a registry bump download in the background, so the restart
    /// that follows is instant instead of the next message waiting on npm.
    /// The default has nothing on disk to update.
    fn prefetch_update(&self) -> BoxFuture<'static, Result<bool>> {
        Box::pin(async { Ok(false) })
    }

    /// Whether [`Self::prefetch_update`] would install something: a copy on
    /// disk that is behind [`Self::version`]. Installs nothing itself — this is
    /// how a running agent's staleness is found, since its update has to wait
    /// for the restart. The default has nothing on disk to be behind.
    fn update_pending(&self) -> BoxFuture<'static, bool> {
        Box::pin(async { false })
    }
}

/// What a connect attempt is given: the resolver for this agent, plus the
/// channels the UI watches while it starts.
///
/// The store is reduced to the one trait this layer needs, plus two
/// `watch::Sender`s for the UI.
///
/// `server` is optional because an in-process agent has no command to resolve,
/// so its connect path ignores the delegate.
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

    pub fn with_version_channel(mut self, tx: tokio::sync::watch::Sender<Option<String>>) -> Self {
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
/// The release channel, app version, settings and MCP config are parameters
/// rather than globals, so this crate stays leaf-level and testable.
#[derive(Clone)]
pub struct ConnectOptions {
    pub root_dir: Option<PathBuf>,
    pub defaults: AcpConnectionDefaults,
    pub thread_events: ThreadEventSink,
    /// Where a connection's REQUEST-scoped elicitations are announced.
    ///
    /// The counterpart to `thread_events` for the elicitations that belong to
    /// no session. They are the ones that arrive during sign-in — a device
    /// code to enter, a URL to visit — so they can predate every session the
    /// connection will ever have, and without a sink they are raised into
    /// silence and the agent waits for an answer nobody was shown.
    pub request_elicitation_events: RequestElicitationSink,
    /// Decides the MCP servers each session is handed (the memory tool
    /// server, today). `None` hands every session an empty list.
    pub session_mcp: Option<Arc<dyn crate::session_mcp::SessionMcpServers>>,
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

/// The one launcher.
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
            let (memory_env, memory_args) = memory_quirks(&agent_id, atlas_only_memory());
            extra_env.extend(memory_env);

            let server = delegate
                .server
                .clone()
                .ok_or_else(|| anyhow::anyhow!("no command resolver for agent `{agent_id}`"))?;
            let command = server.get_command(memory_args, extra_env).await?;

            let connection = AcpConnection::stdio(
                agent_id,
                command,
                options.root_dir,
                options.defaults,
                options.thread_events,
                options.request_elicitation_events,
                options.client_name,
                options.client_version,
            )
            .await?
            .with_session_mcp(options.session_mcp);

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
/// Atlas's settings live above this crate, so the process environment is the
/// source here.
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

/// Whether Atlas's shared memory is the only memory in Atlas sessions (the
/// `atlasOnlyMemory` setting, default on). Read when an agent starts, so a
/// change applies to the next session.
static ATLAS_ONLY_MEMORY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// Set from the app's settings at startup and whenever they change.
pub fn set_atlas_only_memory(on: bool) {
    ATLAS_ONLY_MEMORY.store(on, std::sync::atomic::Ordering::Relaxed);
}

/// The current `atlasOnlyMemory` setting.
pub fn atlas_only_memory() -> bool {
    ATLAS_ONLY_MEMORY.load(std::sync::atomic::Ordering::Relaxed)
}

/// What turns an agent's own memory off when Atlas's is the only one:
/// Claude Code's auto memory by `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`
/// (code.claude.com/docs/en/memory), Codex's memories by the
/// `memories.use_memories` / `memories.generate_memories` config keys passed
/// as `-c` overrides. Nothing when `atlas_only` is off, or for another agent.
pub fn memory_quirks(
    agent_id: &AgentId,
    atlas_only: bool,
) -> (HashMap<String, String>, Vec<String>) {
    let mut env = HashMap::new();
    let mut args = Vec::new();
    if atlas_only {
        match agent_id.as_str() {
            CLAUDE_AGENT_ID => {
                env.insert("CLAUDE_CODE_DISABLE_AUTO_MEMORY".to_owned(), "1".to_owned());
            }
            CODEX_AGENT_ID => {
                for key in [
                    "memories.use_memories=false",
                    "memories.generate_memories=false",
                ] {
                    args.push("-c".to_owned());
                    args.push(key.to_owned());
                }
            }
            _ => {}
        }
    }
    (env, args)
}

// Agent ids that need an environment workaround. These are NOT a list of agents
// Atlas ships, offers, or knows how to install — an agent reaches this function
// only because the user already installed it and asked to run it. Nothing here
// creates an agent, and adding an id here must never become the way one appears.
const CLAUDE_AGENT_ID: &str = "claude-code";
const CODEX_AGENT_ID: &str = "codex";
const GEMINI_AGENT_ID: &str = "gemini";

/// Per-agent environment workarounds.
///
/// Each is a fix for how that CLI behaves, not a capability decision — capability
/// questions are answered by what the agent advertises at `initialize`.
pub fn env_quirks(agent_id: &AgentId) -> HashMap<String, String> {
    env_quirks_from(agent_id, |key| std::env::var(key).ok())
}

/// [`env_quirks`] against an explicit environment, so the pass-through can be
/// tested without mutating the process's own.
pub fn env_quirks_from(
    agent_id: &AgentId,
    host_env: impl Fn(&str) -> Option<String>,
) -> HashMap<String, String> {
    let mut env = HashMap::new();

    match agent_id.as_str() {
        // Blanked, not unset: with a key present the CLI bills the key instead
        // of the subscription the user signed in with.
        CLAUDE_AGENT_ID => {
            env.insert("ANTHROPIC_API_KEY".to_owned(), String::new());
        }
        // Passed through explicitly because the CLI reads them from its own
        // environment. The spawn inherits the host's today, so this is what
        // keeps them there if it ever stops doing so. These are the two names
        // codex's auth reads (`CODEX_API_KEY_ENV_VAR`, `OPENAI_API_KEY_ENV_VAR`
        // in `vendor/atlas-engine/login/src/auth/manager.rs`). Note the spelling
        // `OPENAI_API_KEY`; `OPEN_AI_API_KEY` is read by nothing.
        CODEX_AGENT_ID => {
            for key in ["CODEX_API_KEY", "OPENAI_API_KEY"] {
                if let Some(value) = host_env(key) {
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

#[cfg(test)]
mod memory_quirk_tests {
    use super::*;

    #[test]
    fn atlas_only_memory_turns_each_agents_own_memory_off() {
        let (env, args) = memory_quirks(&AgentId::new(CLAUDE_AGENT_ID), true);
        assert_eq!(
            env.get("CLAUDE_CODE_DISABLE_AUTO_MEMORY")
                .map(String::as_str),
            Some("1")
        );
        assert!(args.is_empty());
        let (env, args) = memory_quirks(&AgentId::new(CODEX_AGENT_ID), true);
        assert!(env.is_empty());
        assert_eq!(
            args,
            [
                "-c",
                "memories.use_memories=false",
                "-c",
                "memories.generate_memories=false"
            ]
        );
        for agent in [CLAUDE_AGENT_ID, CODEX_AGENT_ID, GEMINI_AGENT_ID] {
            let (env, args) = memory_quirks(&AgentId::new(agent), false);
            assert!(
                env.is_empty() && args.is_empty(),
                "{agent}: off is today's launch"
            );
        }
    }
}

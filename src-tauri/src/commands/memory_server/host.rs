//! The running server, and the app-level host that owns it.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::middleware;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
use tokio::sync::oneshot;

use super::briefing::{SessionClocks, SessionReads};
use super::tokens::{require_token, MemoryTokens};
use super::tools::{BootstrapSource, CitationCheck, IndexEvict, IndexSearch, MemoryTools};
use super::MCP_PATH;
use crate::commands::shared_memory::SharedMemoryStore;

/// Whether shared memory is switched on for a launch directory (the Memory
/// panel's sharing toggle). Checked on every tool call, so flipping it off
/// mid-session takes effect at once.
pub type SharingGate = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// What the tools answer from beyond the record: the project's indexed
/// documents (`memory_search`) and the first-look extras (`memory_briefing`:
/// the curated pack read from foreign stores, and the recent-session
/// handoff). Both are seams into the app; a server without them answers from
/// the record alone.
#[derive(Clone, Default)]
pub struct Sources {
    pub index: Option<IndexSearch>,
    pub bootstrap: Option<BootstrapSource>,
    /// Drop one document from the index now (`memory_forget`). Without it a
    /// forgotten entry's text stays retrievable until the next corpus pass.
    pub evict: Option<IndexEvict>,
    /// The session recorder, read-only: where a memory's writing session is
    /// resolved to its title and commits. The default reads the launch
    /// directory and the repository's worktrees.
    pub capture: crate::commands::memory_capture::CaptureReader,
    /// Checks a memory's code citations (M3). Without it the cited files are
    /// read directly, with no symbol lookup for moved code.
    pub check: Option<CitationCheck>,
}

/// The running server. Dropping it (or [`shutdown`](Self::shutdown)) stops it.
pub struct MemoryServer {
    addr: SocketAddr,
    stop: Option<oneshot::Sender<()>>,
}

impl MemoryServer {
    /// Bind `127.0.0.1:0` and serve the memory tools over `memory`, admitting
    /// only requests bearing a live token from `tokens`. Returns once bound;
    /// serving continues on the runtime.
    #[cfg(test)]
    pub async fn start(
        memory: SharedMemoryStore,
        tokens: Arc<MemoryTokens>,
        clocks: Arc<SessionClocks>,
        reads: Arc<SessionReads>,
        gate: SharingGate,
        sources: Sources,
    ) -> std::io::Result<Self> {
        Self::start_with(memory, tokens, clocks, reads, gate, sources, Vec::new()).await
    }

    /// `start`, also serving each of `mounts` — another MCP
    /// service already routed at its own path, such as the UI tool server at
    /// `/ui` — on the same listener and behind the same token check. One
    /// listener means one token per session covers every service: the token
    /// table holds one token per session, so a second would revoke the first.
    pub async fn start_with(
        memory: SharedMemoryStore,
        tokens: Arc<MemoryTokens>,
        clocks: Arc<SessionClocks>,
        reads: Arc<SessionReads>,
        gate: SharingGate,
        sources: Sources,
        mounts: Vec<axum::Router>,
    ) -> std::io::Result<Self> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let addr = listener.local_addr()?;
        let tools = MemoryTools::new(memory, gate, clocks, reads, sources);
        // No idle timeout: an agent can go many minutes between memory
        // calls, and rmcp's default 5 minutes would drop its session under it.
        let mut sessions = LocalSessionManager::default();
        sessions.session_config.keep_alive = None;
        let service = StreamableHttpService::new(
            move || Ok(tools.clone()),
            Arc::new(sessions),
            StreamableHttpServerConfig::default(),
        );
        let router = mounts
            .into_iter()
            .fold(
                axum::Router::new().nest_service(MCP_PATH, service),
                axum::Router::merge,
            )
            // Last, so it wraps every mounted service too.
            .layer(middleware::from_fn_with_state(tokens, require_token));
        let (stop, stopped) = oneshot::channel::<()>();
        tokio::spawn(async move {
            let served = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = stopped.await;
                })
                .await;
            if let Err(e) = served {
                tracing::warn!(target: "atlas::memory_server", "memory tool server stopped: {e}");
            }
        });
        tracing::info!(target: "atlas::memory_server", "memory tool server on http://{addr}{MCP_PATH}");
        Ok(Self {
            addr,
            stop: Some(stop),
        })
    }

    /// The MCP endpoint, e.g. `http://127.0.0.1:53124/mcp`.
    pub fn url(&self) -> String {
        format!("http://{}{MCP_PATH}", self.addr)
    }

    /// The endpoint of a service mounted at `path`, e.g. `url_at("/ui")`.
    pub fn url_at(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr)
    }

    /// Stop serving.
    pub fn shutdown(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

impl Drop for MemoryServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// The app's one memory tool server, its tokens and its per-session clocks,
/// as managed state. Tokens and clocks exist from the start; the server's
/// URL once it has bound.
#[derive(Default)]
pub struct MemoryServerHost {
    tokens: Arc<MemoryTokens>,
    clocks: Arc<SessionClocks>,
    reads: Arc<SessionReads>,
    server: std::sync::OnceLock<MemoryServer>,
}

impl MemoryServerHost {
    pub fn new() -> Self {
        Self::default()
    }

    /// The live session tokens (minted and revoked by the session lifecycle).
    pub fn tokens(&self) -> &Arc<MemoryTokens> {
        &self.tokens
    }

    /// Each session's "last looked" clock (dropped by the session lifecycle
    /// when the session ends).
    pub fn clocks(&self) -> &Arc<SessionClocks> {
        &self.clocks
    }

    /// Which sessions have read memory. Only the tests ask any more; the
    /// dispatcher still records reads so that distinction stays pinned.
    #[cfg(test)]
    pub fn reads(&self) -> &Arc<SessionReads> {
        &self.reads
    }

    /// The MCP endpoint, once the server has bound; `None` before that or if
    /// binding failed (sessions then run without memory tools).
    pub fn url(&self) -> Option<String> {
        self.server.get().map(MemoryServer::url)
    }

    /// The endpoint of a service mounted at `path`, once the server has bound.
    pub fn url_at(&self, path: &str) -> Option<String> {
        self.server.get().map(|s| s.url_at(path))
    }

    /// Start the server on the async runtime, with `mounts` served beside the
    /// memory tools; returns at once. A failure to bind is logged and leaves
    /// [`url`](Self::url) `None`.
    pub fn start(
        self: &Arc<Self>,
        memory: SharedMemoryStore,
        gate: SharingGate,
        sources: Sources,
        mounts: Vec<axum::Router>,
    ) {
        let host = self.clone();
        tauri::async_runtime::spawn(async move {
            let started = MemoryServer::start_with(
                memory,
                host.tokens.clone(),
                host.clocks.clone(),
                host.reads.clone(),
                gate,
                sources,
                mounts,
            )
            .await;
            match started {
                Ok(server) => {
                    let _ = host.server.set(server);
                }
                Err(e) => {
                    tracing::warn!(target: "atlas::memory_server", "memory tool server did not start: {e}")
                }
            }
        });
    }

    /// A server that is already running, for tests.
    #[cfg(test)]
    pub(crate) fn adopt(&self, server: MemoryServer) {
        let _ = self.server.set(server);
    }
}

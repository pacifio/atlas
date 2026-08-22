//! The launcher for the native agent.
//!
//! Ported from Zed's `NativeAgentServer` (`agent/src/native_agent_server.rs`):
//! it implements the same `AgentServer` trait an external agent does, so the
//! manager holds one kind of thing. `connect` starts no process — it registers
//! an agent on the in-process runtime — and it ignores the delegate, because
//! there is no command to resolve and no binary to download. Zed's does the
//! same.

use std::any::Any;
use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use anyhow::Result;
use atlas_acp_thread::{AgentConnection, AgentId};
use atlas_agent_servers::{AgentServer, AgentServerDelegate, ConnectOptions};
use atlas_cersei::CerseiRuntime;
use futures::future::BoxFuture;
use futures::FutureExt;

use crate::connection::CerseiConnection;

/// The agent id the native agent occupies.
///
/// The same string the old stack used as its plugin id, so a stored session
/// that names `"cersei"` still resolves after the port.
pub const CERSEI_AGENT_ID: &str = atlas_cersei::CERSEI_PLUGIN_ID;

#[derive(Clone)]
pub struct CerseiAgentServer {
    runtime: CerseiRuntime,
    default_mode: Option<acp::SessionModeId>,
}

impl CerseiAgentServer {
    /// `config_dir` is where the runtime keeps BYOK keys and session
    /// transcripts — Atlas's app config directory in production, a tempdir in a
    /// test.
    pub fn new(config_dir: PathBuf) -> Self {
        Self::with_runtime(CerseiRuntime::new(config_dir))
    }

    pub fn with_runtime(runtime: CerseiRuntime) -> Self {
        Self {
            runtime,
            default_mode: None,
        }
    }

    pub fn with_default_mode(mut self, mode: Option<acp::SessionModeId>) -> Self {
        self.default_mode = mode;
        self
    }

    pub fn runtime(&self) -> &CerseiRuntime {
        &self.runtime
    }
}

impl AgentServer for CerseiAgentServer {
    fn agent_id(&self) -> AgentId {
        AgentId::new(CERSEI_AGENT_ID)
    }

    fn connect(
        &self,
        _delegate: AgentServerDelegate,
        options: ConnectOptions,
    ) -> BoxFuture<'static, Result<Arc<dyn AgentConnection>>> {
        let id = self.agent_id();
        let runtime = self.runtime.clone();
        let default_mode = self
            .default_mode
            .clone()
            .or_else(|| options.defaults.mode.clone());
        async move {
            Ok(
                CerseiConnection::connect(id, runtime, options.thread_events, default_mode)
                    as Arc<dyn AgentConnection>,
            )
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

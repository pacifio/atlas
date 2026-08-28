//! Shared fixtures for the engine seam's tests.

use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use anyhow::{anyhow, Result};
use atlas_acp_thread::{AcpThread, AcpThreadHandle, AgentConnection, AgentId};
use futures::future::BoxFuture;
use futures::FutureExt;

/// An `AgentConnection` that does nothing.
///
/// `AcpThread` needs one to exist, and tests about the *thread* should not have
/// to stand up an engine to get it.
pub struct NullConnection;

impl AgentConnection for NullConnection {
    fn agent_id(&self) -> AgentId {
        AgentId::new("null")
    }

    fn telemetry_id(&self) -> Arc<str> {
        "null".into()
    }

    fn new_session(
        self: Arc<Self>,
        _work_dirs: Vec<PathBuf>,
    ) -> BoxFuture<'static, Result<AcpThreadHandle>> {
        async { Err(anyhow!("the null connection opens no sessions")) }.boxed()
    }

    fn auth_methods(&self) -> &[acp::AuthMethod] {
        &[]
    }

    fn authenticate(&self, _method: acp::AuthMethodId) -> BoxFuture<'static, Result<()>> {
        async { Err(anyhow!("the null connection does not authenticate")) }.boxed()
    }

    fn prompt(
        &self,
        _params: acp::PromptRequest,
    ) -> BoxFuture<'static, Result<acp::PromptResponse>> {
        async { Err(anyhow!("the null connection takes no prompts")) }.boxed()
    }

    fn cancel(&self, _session_id: &acp::SessionId) {}

    fn into_any(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
        self
    }
}

/// A thread with a discarded event stream.
pub fn detached_thread(session_id: acp::SessionId) -> AcpThreadHandle {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    // Keep the receiver alive for the thread's lifetime, else every send fails.
    std::mem::forget(rx);
    Arc::new(std::sync::Mutex::new(AcpThread::new(
        session_id,
        Arc::new(NullConnection),
        Vec::new(),
        None,
        tx,
    )))
}

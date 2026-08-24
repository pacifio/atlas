//! A no-op `AgentConnection` for tests that need a thread but never talk to an
//! agent.

use std::any::Any;
use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use anyhow::Result;
use atlas_acp_thread::{AcpThreadHandle, AgentConnection, AgentId};
use futures::future::BoxFuture;

pub struct StubConnection {
    auth_methods: Vec<acp::AuthMethod>,
}

pub fn stub_connection() -> Arc<dyn AgentConnection> {
    Arc::new(StubConnection {
        auth_methods: Vec::new(),
    })
}

impl AgentConnection for StubConnection {
    fn agent_id(&self) -> AgentId {
        AgentId::new("stub")
    }

    fn telemetry_id(&self) -> Arc<str> {
        "stub".into()
    }

    fn new_session(
        self: Arc<Self>,
        _work_dirs: Vec<PathBuf>,
    ) -> BoxFuture<'static, Result<AcpThreadHandle>> {
        Box::pin(async { Err(anyhow::anyhow!("stub")) })
    }

    fn auth_methods(&self) -> &[acp::AuthMethod] {
        &self.auth_methods
    }

    fn authenticate(&self, _method: acp::AuthMethodId) -> BoxFuture<'static, Result<()>> {
        Box::pin(async { Ok(()) })
    }

    fn prompt(
        &self,
        _params: acp::PromptRequest,
    ) -> BoxFuture<'static, Result<acp::PromptResponse>> {
        Box::pin(async { Err(anyhow::anyhow!("stub")) })
    }

    fn cancel(&self, _session_id: &acp::SessionId) {}

    fn into_any(self: Arc<Self>) -> Arc<dyn Any + Send + Sync> {
        self
    }
}

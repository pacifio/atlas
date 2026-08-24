//! `session/list` and `session/delete` — the agent's own record of its sessions.
//!
//! Ported from Zed's `AcpSessionList` (`agent_servers/src/acp.rs:528-640`) and
//! the place it is built (`:1051-1065`).
//!
//! The construction rule is the whole capability gate, and it is worth stating
//! because everything downstream depends on it: **this object exists only if
//! the agent advertised `sessionCapabilities.list` at `initialize`**. A
//! connection that returns `None` from `session_list()` is an agent that cannot
//! be imported from, and the import flow says exactly that rather than guessing
//! from the agent's name. `supports_delete` rides along on the same object from
//! `sessionCapabilities.delete`, so agent-side deletion is gated the same way.
//!
//! Neither capability is ever inferred from an agent's identity. There is no
//! table of agent ids in this file, and there must not be one.

use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use agent_client_protocol::{Agent, ConnectionTo};
use chrono::{DateTime, Utc};
use anyhow::Result;
use atlas_acp_thread::{
    AgentSessionInfo, AgentSessionList, AgentSessionListRequest, AgentSessionListResponse,
};
use futures::future::BoxFuture;
use futures::FutureExt;

use crate::connection::map_acp_error;

pub struct AcpSessionList {
    connection: ConnectionTo<Agent>,
    supports_delete: bool,
}

// Zed's version also carries an update channel, so its always-open archive view
// can re-render when a session is deleted. Atlas's import is one-shot — it
// fetches, writes rows and closes — so the trait's do-nothing `watch` /
// `notify_refresh` defaults are left in place rather than wiring a channel with
// no listener.

impl AcpSessionList {
    /// Build the list surface for a connection whose `initialize` response
    /// advertised `sessionCapabilities.list`.
    ///
    /// Returns `None` otherwise — which is the signal every caller reads, and
    /// the only thing that decides whether an agent can be imported from.
    pub(crate) fn for_capabilities(
        connection: ConnectionTo<Agent>,
        capabilities: &acp::AgentCapabilities,
    ) -> Option<Arc<Self>> {
        capabilities.session_capabilities.list.as_ref()?;
        Some(Arc::new(Self {
            connection,
            supports_delete: capabilities.session_capabilities.delete.is_some(),
        }))
    }
}

impl AgentSessionList for AcpSessionList {
    fn list_sessions(
        &self,
        request: AgentSessionListRequest,
    ) -> BoxFuture<'static, Result<AgentSessionListResponse>> {
        let connection = self.connection.clone();
        async move {
            let mut acp_request = acp::ListSessionsRequest::new();
            acp_request.cwd = request.cwd;
            acp_request.cursor = request.cursor;
            let response = connection
                .send_request(acp_request)
                .block_task()
                .await
                .map_err(map_acp_error)?;
            Ok(AgentSessionListResponse {
                sessions: response.sessions.into_iter().map(session_info).collect(),
                next_cursor: response.next_cursor,
                meta: response.meta,
            })
        }
        .boxed()
    }

    fn supports_delete(&self) -> bool {
        self.supports_delete
    }

    fn delete_session(&self, session_id: &acp::SessionId) -> BoxFuture<'static, Result<()>> {
        if !self.supports_delete {
            // Never sent speculatively: an agent that did not advertise
            // `session/delete` may answer anything to one, and Atlas's own row
            // is already gone by the time this is called.
            return async { Err(anyhow::anyhow!("this agent cannot delete sessions")) }.boxed();
        }
        let connection = self.connection.clone();
        let session_id = session_id.clone();
        async move {
            connection
                .send_request(acp::DeleteSessionRequest::new(session_id))
                .block_task()
                .await
                .map_err(map_acp_error)?;
            Ok(())
        }
        .boxed()
    }

    fn into_any(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
        self
    }
}

/// One `SessionInfo` off the wire.
///
/// `cwd` and the optional `additionalDirectories` become the thread's work
/// dirs, deduped and cwd-first (Zed's `work_dirs_from_session_info`,
/// `acp.rs:1494-1508`). `createdAt` has no wire field in schema v1, so it is
/// always absent here — the store falls back to `updatedAt`.
fn session_info(info: acp::SessionInfo) -> AgentSessionInfo {
    let mut work_dirs: Vec<PathBuf> = Vec::with_capacity(1 + info.additional_directories.len());
    work_dirs.push(info.cwd);
    for path in info.additional_directories {
        if !work_dirs.contains(&path) {
            work_dirs.push(path);
        }
    }
    AgentSessionInfo {
        session_id: info.session_id,
        work_dirs: Some(work_dirs),
        title: info.title.map(Into::into),
        updated_at: info.updated_at.as_deref().and_then(|stamp| {
            DateTime::parse_from_rfc3339(stamp)
                .ok()
                .map(|dt| dt.with_timezone(&Utc))
        }),
        created_at: None,
        meta: info.meta,
    }
}

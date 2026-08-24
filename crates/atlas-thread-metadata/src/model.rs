//! What a row is.
//!
//! Ported from Zed's `ThreadMetadata` (`thread_metadata_store.rs:306-342`,
//! `:438-453`). The one thing to keep in mind reading this file: a row is
//! **metadata only**. There is no message, no chunk, no tool call and no token
//! anywhere in it. Replaying a conversation is the agent's job, through
//! `session/load`; this store only knows enough to list the thread and route
//! the click.

use std::path::Path;
use std::str::FromStr;
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::connection::{AgentId, AgentSessionInfo};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::paths::{PathList, WorktreePaths};

/// The default shown for a thread nobody has titled yet.
///
/// Zed's `DEFAULT_THREAD_TITLE` (`agent_ui/src/agent_ui.rs`).
pub const DEFAULT_THREAD_TITLE: &str = "New Thread";

/// Atlas's own id for a conversation.
///
/// Minted by Atlas, never by an agent, and never reused: it is what lets a
/// thread exist *before* any agent session does (a draft) and survive an agent
/// forgetting its session afterwards.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
pub struct ThreadId(uuid::Uuid);

impl ThreadId {
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4())
    }

    pub fn from_uuid(uuid: uuid::Uuid) -> Self {
        Self(uuid)
    }

    pub fn as_uuid(&self) -> &uuid::Uuid {
        &self.0
    }

    /// Stable, hyphenated string form, suitable as a key on the wire.
    pub fn to_key_string(&self) -> String {
        self.0.hyphenated().to_string()
    }
}

impl std::fmt::Display for ThreadId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.hyphenated().fmt(f)
    }
}

impl FromStr for ThreadId {
    type Err = uuid::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self(uuid::Uuid::parse_str(s)?))
    }
}

/// Which slice of the store a query wants.
///
/// Zed's archive view filter (`threads_archive_view.rs:271-299`). There is no
/// `ActiveOnly` because the sidebar's active list is a *path-grouped* query,
/// not a flat one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ThreadFilter {
    /// Everything, archived or not — what the history view shows.
    #[default]
    All,
    /// Only archived threads.
    ArchivedOnly,
}

/// One thread, as the sidebar and the history view need to know it.
#[derive(Debug, Clone, PartialEq)]
pub struct ThreadMetadata {
    pub thread_id: ThreadId,
    /// `None` while the thread is a draft — no agent session exists yet.
    pub session_id: Option<acp::SessionId>,
    pub agent_id: AgentId,
    /// The agent's own title for the thread, if it has produced one.
    pub title: Option<Arc<str>>,
    /// The user's rename. Beats [`ThreadMetadata::title`] so that a later
    /// agent-generated title never clobbers a name the user chose.
    pub title_override: Option<Arc<str>>,
    pub updated_at: DateTime<Utc>,
    pub created_at: Option<DateTime<Utc>>,
    /// When the user last sent (or queued) a message. Distinct from
    /// `updated_at`, which also moves for agent-side activity.
    pub interacted_at: Option<DateTime<Utc>>,
    pub worktree_paths: WorktreePaths,
    /// The remote-connection slot the spec calls for (issue #15: "…archived
    /// flag, remote-connection slot"; ADR-0001). Zed stores its
    /// `RemoteConnectionOptions` here and filters its sidebar queries by it.
    /// Atlas has no remote connections yet, so the column round-trips and
    /// nothing reads it — the row shape is the one the spec fixed, rather than
    /// one needing a migration the day Atlas grows them.
    pub remote_connection: Option<serde_json::Value>,
    pub archived: bool,
}

impl ThreadMetadata {
    /// A new thread for `agent_id` rooted at `folder_paths`, as a draft.
    ///
    /// `created_at`, `updated_at` and `interacted_at` all start at now; the
    /// thread gets its session id when its first message is sent.
    pub fn new(thread_id: ThreadId, agent_id: AgentId, folder_paths: PathList) -> Self {
        let now = Utc::now();
        Self {
            thread_id,
            session_id: None,
            agent_id,
            title: None,
            title_override: None,
            updated_at: now,
            created_at: Some(now),
            interacted_at: Some(now),
            worktree_paths: WorktreePaths::from_folder_paths(&folder_paths),
            remote_connection: None,
            archived: false,
        }
    }

    /// A thread is a draft until its first message is sent, at which point it
    /// gets an ACP session id (`thread_metadata_store.rs:328-333`).
    pub fn is_draft(&self) -> bool {
        self.session_id.is_none()
    }

    /// The title to show: the user's rename, else the agent's, else the
    /// default (`:335-342`).
    pub fn display_title(&self) -> Arc<str> {
        self.title()
            .unwrap_or_else(|| Arc::from(DEFAULT_THREAD_TITLE))
    }

    pub fn title(&self) -> Option<Arc<str>> {
        self.title_override.clone().or_else(|| self.title.clone())
    }

    pub fn folder_paths(&self) -> &PathList {
        self.worktree_paths.folder_path_list()
    }

    pub fn main_worktree_paths(&self) -> &PathList {
        self.worktree_paths.main_worktree_path_list()
    }

    pub fn references_folder_path(&self, path: &Path) -> bool {
        self.folder_paths().contains(path)
    }
}

/// A row, presented the way `session/list` results are.
///
/// Zed's `From<&ThreadMetadata> for AgentSessionInfo`
/// (`thread_metadata_store.rs:438-453`). A draft has no session id, so its
/// thread id stands in — the value is never sent to an agent, it only has to
/// be unique among the rows being rendered.
impl From<&ThreadMetadata> for AgentSessionInfo {
    fn from(meta: &ThreadMetadata) -> Self {
        let session_id = meta
            .session_id
            .clone()
            .unwrap_or_else(|| acp::SessionId::new(meta.thread_id.to_key_string()));
        Self {
            session_id,
            work_dirs: Some(meta.folder_paths().paths().to_vec()),
            title: meta.title(),
            updated_at: Some(meta.updated_at),
            created_at: meta.created_at,
            meta: None,
        }
    }
}

//! What a row is.
//!
//! The one thing to keep in mind reading this file: a row is
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
use crate::projects::AttachedProject;
use crate::pull_requests::PullRequestLink;

/// The default shown for a thread nobody has titled yet.
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
    /// flag, remote-connection slot"; ADR-0001). It would hold the
    /// connection options and filter sidebar queries by them. Atlas has no remote connections yet, so the column round-trips and
    /// nothing reads it — the row shape is the one the spec fixed, rather than
    /// one needing a migration the day Atlas grows them.
    pub remote_connection: Option<serde_json::Value>,
    /// The git branch the thread's working directory was on the last time
    /// Atlas looked — when the thread was bound and at each turn start.
    /// `None` is "not known": a detached HEAD, a folder outside any
    /// repository, or a row older than the column. Never guessed.
    pub branch: Option<Arc<str>>,
    /// The model the session's latest turn ran on, as its agent names it
    /// (the display name, else the id) — recorded at each turn start and on
    /// a model change. `None` when Atlas never saw one: an import, a row
    /// older than the column, or an agent with no model selection.
    pub model: Option<Arc<str>>,
    /// When the session was settled: done for now, moved to the sidebar's
    /// Settled shelf, still listed and still resumable. `None` is active.
    /// Settled replaced archiving: there is no state that takes a session off
    /// the sidebar short of deleting it.
    pub settled_at: Option<DateTime<Utc>>,
    /// When the user last un-settled the session. Auto-settle leaves a row
    /// alone while this is after its last activity: the user said "not done",
    /// and nothing has happened since that could change their mind.
    pub unsettled_at: Option<DateTime<Utc>>,
    /// When the session was pinned; `None` when it is not. A pinned session
    /// sits in the sidebar's Pinned section and is never auto-settled.
    pub pinned_at: Option<DateTime<Utc>>,
    /// Where the session sits among the pinned ones: a fractional key that
    /// sorts as a plain string, so moving one session rewrites only its own
    /// key. Minted by the frontend; the store only keeps it. `None` sorts
    /// after every keyed pin.
    pub pin_order: Option<Arc<str>>,
    /// When the session was last unpinned; `None` when it never was. A pin
    /// holds a session out of the idle sweep, so the release starts its idle
    /// clock over ([`ThreadMetadata::idle_since`]) — otherwise a session
    /// pinned for a week would settle the minute it is unpinned.
    pub unpinned_at: Option<DateTime<Utc>>,
    /// When the snoozed session wakes on its own. `None` when it is not
    /// snoozed. Cleared — the session woken — when the time comes, when it
    /// raises its hand ([`ThreadMetadata::raises_hand`]), or when the user
    /// sends, settles, pins or wakes it.
    pub snoozed_until: Option<DateTime<Utc>>,
    /// When the user snoozed it; `None` with `snoozed_until`.
    pub snoozed_at: Option<DateTime<Utc>>,
    /// When the session last woke from a snooze. It reads as "woke" until
    /// the user views it after this.
    pub last_snooze_wake_at: Option<DateTime<Utc>>,
    /// When the user last opened or focused the session.
    pub last_viewed_at: Option<DateTime<Utc>>,
    /// When the session's latest turn completed, as Atlas saw it end. What
    /// "unread" is measured against. `None` for a session Atlas never ran a
    /// turn in (an import), which is never unread.
    pub last_turn_completed_at: Option<DateTime<Utc>>,
    /// The projects attached to the session besides its own folder, in the
    /// order they were attached ([`crate::AttachedProject`]). Empty for most
    /// sessions, and for every row older than the column.
    pub attached_projects: Vec<AttachedProject>,
    /// The pull requests linked to the session, in the order they were
    /// linked, tombstones included ([`crate::PullRequestLink`]). Empty for
    /// most sessions, and for every row older than the column.
    pub pull_requests: Vec<PullRequestLink>,
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
            branch: None,
            model: None,
            settled_at: None,
            unsettled_at: None,
            pinned_at: None,
            pin_order: None,
            unpinned_at: None,
            snoozed_until: None,
            snoozed_at: None,
            last_snooze_wake_at: None,
            last_viewed_at: None,
            last_turn_completed_at: None,
            attached_projects: Vec::new(),
            pull_requests: Vec::new(),
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

    /// Whether the session sits on the Settled shelf.
    pub fn is_settled(&self) -> bool {
        self.settled_at.is_some()
    }

    pub fn is_pinned(&self) -> bool {
        self.pinned_at.is_some()
    }

    /// Whether the session is snoozed. A snooze whose time has passed is
    /// cleared by the store's wake timer, so a set `snoozed_until` is a
    /// snooze still running.
    pub fn is_snoozed(&self) -> bool {
        self.snoozed_until.is_some()
    }

    /// The latest turn completed after the user last looked. A session with
    /// no recorded completion is never unread.
    pub fn is_unread(&self) -> bool {
        self.last_turn_completed_at
            .is_some_and(|done| self.last_viewed_at.is_none_or(|seen| seen < done))
    }

    /// The session woke from a snooze and the user has not viewed it since.
    /// A settled or re-snoozed session is not "woke".
    pub fn is_woke(&self) -> bool {
        !self.is_settled()
            && !self.is_snoozed()
            && self
                .last_snooze_wake_at
                .is_some_and(|woke| self.last_viewed_at.is_none_or(|seen| seen < woke))
    }

    /// The last thing that happened in the session: agent or outside activity
    /// (`updated_at`) or the user sending (`interacted_at`), whichever is
    /// later. What "idle" is measured from.
    pub fn last_activity(&self) -> DateTime<Utc> {
        self.interacted_at
            .map_or(self.updated_at, |at| at.max(self.updated_at))
    }

    /// What the idle sweep measures from: the last activity, or the moment
    /// the session was last released back into the sweep — woken from a
    /// snooze or unpinned — whichever is later. A snooze or a pin holds a
    /// session out of the sweep; when it ends the session must get a full
    /// idle window again, not be settled on the next tick for time it spent
    /// held.
    pub fn idle_since(&self) -> DateTime<Utc> {
        let last = self.last_activity();
        [self.last_snooze_wake_at, self.unpinned_at]
            .into_iter()
            .flatten()
            .fold(last, DateTime::max)
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
/// A draft has no session id, so its
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

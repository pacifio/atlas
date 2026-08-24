//! Importing an agent's own sessions — the only way external history reaches
//! Atlas.
//!
//! Ported from Zed's `thread_import.rs` (`collect_all_sessions` `:794-820`,
//! `collect_importable_threads` `:855-889`). Two properties carry it:
//!
//! * **Metadata only.** A `SessionInfo` is an id, a directory, a title and a
//!   timestamp. No transcript is fetched, here or ever — the conversation
//!   arrives when the user opens the row, replayed by the agent through
//!   `session/load`.
//! * **Imports land archived.** They go to the history view, not the active
//!   sidebar, so pulling in a year of sessions never buries the work in front
//!   of you (`thread_import.rs:884`).
//!
//! Nothing in this file knows an agent's name. Whether an agent can be imported
//! from at all is decided by whether its connection hands back a session list,
//! which happens only when it advertised `sessionCapabilities.list`.

use std::collections::HashSet;
use std::path::PathBuf;

use agent_client_protocol::schema::v1 as acp;
use anyhow::Result;
use atlas_acp_thread::connection::AgentId;
use atlas_acp_thread::{AgentSessionInfo, AgentSessionList, AgentSessionListRequest};
use chrono::Utc;

use crate::model::{ThreadId, ThreadMetadata};
use crate::paths::{PathList, WorktreePaths};

/// How many pages an import will follow before giving up.
///
/// Not a limit on how much history can be imported — it is a guard against an
/// agent whose cursor never terminates in a way [`collect_all_sessions`]'s
/// repeat check can see. At a hundred pages of any sane page size, an agent
/// that has not finished is misbehaving.
const MAX_PAGES: usize = 100;

/// Every session an agent will list, following its cursor to exhaustion.
///
/// Stops when the agent stops sending a cursor, repeats the one it just sent,
/// or hits [`MAX_PAGES`]. The repeat check is not defensive programming: the
/// claude-agent-acp adapter ignores the cursor entirely and returns its whole
/// set on every call, so without it an import of one agent never finishes.
///
/// The result can therefore contain the same session more than once — the same
/// adapter returns its whole set on page one *and* page two. Deduplicating is
/// [`importable_threads`]'s job, and it is not optional.
pub async fn collect_all_sessions(
    list: &dyn AgentSessionList,
    cwd: Option<PathBuf>,
) -> Result<Vec<AgentSessionInfo>> {
    let mut sessions = Vec::new();
    let mut cursor: Option<String> = None;

    for _ in 0..MAX_PAGES {
        let response = list
            .list_sessions(AgentSessionListRequest {
                cwd: cwd.clone(),
                cursor: cursor.clone(),
                meta: None,
            })
            .await?;
        sessions.extend(response.sessions);
        match response.next_cursor {
            Some(next) if Some(&next) != cursor.as_ref() => cursor = Some(next),
            _ => break,
        }
        if sessions.len() >= MAX_PAGES {
            // Unreachable in practice — the cursor checks above end every
            // well-behaved and most ill-behaved agents first.
            tracing::warn!(pages = MAX_PAGES, "stopped following an agent's session cursor");
        }
    }
    Ok(sessions)
}

/// The rows worth writing, out of what an agent listed.
///
/// Skips two kinds of session, both for the same reason — a row nobody could
/// ever see is worse than no row:
///
/// * one Atlas already knows, by session id (`thread_import.rs:867-869`), which
///   is what makes importing twice a no-op;
/// * one with no working directory (`:870-872`), which would belong to no
///   project and so appear under none.
///
/// The known-ids set grows as it goes, exactly as Zed's does (`:867-869`
/// inserts into it). That is not a detail: an agent that ignores the pagination
/// cursor lists the same session on every page, so a fixed set would let one
/// conversation through as several rows.
pub fn importable_threads(
    sessions: Vec<AgentSessionInfo>,
    agent_id: &AgentId,
    known: &HashSet<acp::SessionId>,
) -> Vec<ThreadMetadata> {
    let now = Utc::now();
    let mut seen = known.clone();
    sessions
        .into_iter()
        .filter(|session| seen.insert(session.session_id.clone()))
        .filter_map(|session| {
            let work_dirs = session.work_dirs.filter(|dirs| !dirs.is_empty())?;
            let folder_paths = PathList::new(&work_dirs);
            // The agent's own last-activity time, so an import sorts into
            // history where it belongs rather than all at "now".
            let updated_at = session.updated_at.unwrap_or(now);
            Some(ThreadMetadata {
                thread_id: ThreadId::new(),
                session_id: Some(session.session_id),
                agent_id: agent_id.clone(),
                title: session.title,
                title_override: None,
                updated_at,
                // Verbatim, and so always `None` today: schema v1's
                // `SessionInfo` has no `createdAt`. Filling it in with
                // `updated_at` would be Atlas claiming to know when a
                // conversation started; the history view already falls back to
                // `updated_at` when it needs an ordering.
                created_at: session.created_at,
                // Atlas was not there. Claiming the user interacted at some
                // moment it did not observe would be an invention.
                interacted_at: None,
                worktree_paths: WorktreePaths::from_folder_paths(&folder_paths),
                remote_connection: None,
                archived: true,
            })
        })
        .collect()
}

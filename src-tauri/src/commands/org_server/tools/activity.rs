//! A member's recorded activity, for admins: `org_member_activity`.
//!
//! **Member activity** (CONTEXT.md) is what was recorded through Atlas and
//! nothing else — the recorded sessions, checkpoints, insertions, deletions
//! and Atlas-recorded tokens attributed to one member over a window. It is
//! named and described as recorded activity, never as performance: work done
//! outside Atlas, or in a session nobody recorded, is not in it.
//!
//! The server has no per-member metric, so this is folded here from the
//! Workspace's board by the same walk as `org_sessions`
//! ([`OrgTools::walk_board`]): the same window, the same default, the same
//! scan cap, and the same truncation notes.
//!
//! Admins only. The tool is left out of the tool list offered to any other
//! role ([`ADMIN_TOOLS`](super::ADMIN_TOOLS)), refused here at call time for
//! one that calls it anyway, and a 403 from the server is still answered in
//! words — the role in the access token is a mirror; the server decides.

use atlas_artifacts::RemoteSession;
use rmcp::model::CallToolResult;
use serde_json::{json, Value};

use super::super::cloud::CloudError;
use super::super::OrgScope;
use super::sessions::{workspace_of, BoardWalk, Window};
use super::{tool_error, tool_json, OrgTools};
use crate::auth::Role;

/// How many of the member's recorded sessions the answer lists, most recently
/// active first; the totals cover every one in the window regardless, and
/// the answer counts the rest.
pub(in crate::commands::org_server) const ACTIVITY_ROWS: usize = 20;

/// What the answer, and the tool's description, say the numbers are.
pub(in crate::commands::org_server) const RECORDED_NOTE: &str = "Activity recorded through Atlas, not a measure of \
     performance: only sessions recorded in this Workspace are counted, and files_touched is summed per session.";

/// What a caller who is not an organisation admin is told.
const NOT_ADMIN_NOTE: &str = "Only an organisation admin can read a member's recorded activity; this account is not \
     an admin in this organisation. Nothing was read.";

/// What `org_member_activity` was asked.
pub(super) struct ActivityArgs<'a> {
    /// A member's id, name or email, or `"me"`.
    pub(super) member: Option<&'a str>,
    pub(super) since: Option<&'a str>,
    pub(super) until: Option<&'a str>,
    /// A Workspace id in the grant's organisation; the grant's when absent.
    pub(super) workspace: Option<&'a str>,
}

/// The counts a recorded session carries, and their sum over many.
#[derive(Default)]
struct Counts {
    checkpoints: i64,
    insertions: i64,
    deletions: i64,
    files_touched: i64,
    total_tokens: i64,
}

impl Counts {
    fn of(session: &RemoteSession) -> Self {
        Self {
            checkpoints: session.checkpoint_count,
            insertions: session.insertions,
            deletions: session.deletions,
            files_touched: session.files_touched,
            total_tokens: session.total_tokens,
        }
    }

    fn add(&mut self, other: &Self) {
        self.checkpoints += other.checkpoints;
        self.insertions += other.insertions;
        self.deletions += other.deletions;
        self.files_touched += other.files_touched;
        self.total_tokens += other.total_tokens;
    }

    fn put(&self, out: &mut Value) {
        out["checkpoints"] = json!(self.checkpoints);
        out["insertions"] = json!(self.insertions);
        out["deletions"] = json!(self.deletions);
        out["files_touched"] = json!(self.files_touched);
        out["total_tokens"] = json!(self.total_tokens);
    }
}

impl OrgTools {
    /// `org_member_activity`: one member's recorded sessions in the window,
    /// totalled, with the newest [`ACTIVITY_ROWS`] listed.
    ///
    /// The caller's role is read first, and anyone but an admin is refused
    /// before the roster or the board is read. The member is resolved as
    /// `org_sessions` resolves an author (several matches come back as
    /// candidates); the board is then walked with no match limit, so the
    /// totals cover the whole window up to the scan cap.
    pub(super) async fn member_activity(&self, scope: &OrgScope, args: ActivityArgs<'_>) -> CallToolResult {
        match self.cloud.caller(&scope.org_id).await {
            Ok(caller) if caller.role == Some(Role::Admin) => {}
            Ok(_) => return tool_error(NOT_ADMIN_NOTE),
            Err(e) => return tool_error(e.to_string()),
        }
        let Some(member) = args.member else {
            return tool_error("name the member: `member` is their id, name or email (see org_members)");
        };
        let workspace_id = match workspace_of(args.workspace, scope) {
            Ok(id) => id,
            Err(answer) => return answer,
        };
        let window = match Window::of(args.since, args.until) {
            Ok(window) => window,
            Err(answer) => return answer,
        };
        let (user_id, name) = match self.author_of(scope, member).await {
            Ok(member) => member,
            Err(answer) => return answer,
        };

        let walk = BoardWalk {
            workspace_id,
            q: None,
            window: &window,
            limit: None,
            narrow_with: "a shorter since/until window",
        };
        let keep = |session: &RemoteSession| session.author_id.as_deref() == Some(user_id.as_str());
        let mut walked = match self.walk_board(&scope.org_id, walk, keep).await {
            Ok(walked) => walked,
            Err(CloudError::Forbidden(reason)) => {
                return tool_error(format!(
                    "the organisation refused this account a member's recorded activity ({reason}); only an \
                     organisation admin can read it — ask an admin, or check this account's role"
                ))
            }
            Err(e) => return tool_error(e.to_string()),
        };

        let mut totals = Counts::default();
        let mut sessions = Vec::new();
        for session in &walked.kept {
            let counts = Counts::of(session);
            totals.add(&counts);
            if sessions.len() < ACTIVITY_ROWS {
                let mut row = json!({
                    "id": session.id,
                    "title": session.title,
                    "last_activity_at": session.last_activity_at,
                });
                counts.put(&mut row);
                sessions.push(row);
            }
        }
        let more_sessions = walked.kept.len() - sessions.len();
        if more_sessions > 0 {
            walked.notes.push(format!(
                "Only the {ACTIVITY_ROWS} most recently active recorded sessions are listed; the totals cover all {}.",
                walked.kept.len()
            ));
        }
        walked.notes.insert(0, RECORDED_NOTE.to_string());

        let mut recorded = json!({ "recorded_sessions": walked.kept.len() });
        totals.put(&mut recorded);
        // Totals over every recorded session kept, listed or not.
        tool_json(json!({
            "member": { "user_id": user_id, "name": name },
            "workspace": { "id": workspace_id },
            "window": window.json(),
            "totals": recorded,
            "sessions": sessions,
            "more_sessions": more_sessions,
            "scanned": walked.scanned,
            "truncated": walked.truncated,
            "notes": walked.notes,
        }))
    }
}

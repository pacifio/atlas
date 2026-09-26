//! Who the agent acts as, and whom and where it can reach: `org_whoami`,
//! `org_members` and `org_conversations`.

use rmcp::model::CallToolResult;
use serde_json::{json, Value};

use super::super::cloud::CurrentSessionQuery;
use super::super::OrgScope;
use super::{
    conversation_json, member_json, resolve_conversation, resolve_member, tool_error, tool_json, OrgTools,
    NOT_RECORDED_YET,
};
use crate::commands::memory_server::Grant;
impl OrgTools {
    /// `org_whoami`: the caller, the organisation, the Workspace and the
    /// current recorded session. The caller is required — without it there
    /// is no answer — but a comment read that fails leaves the count unknown
    /// rather than failing the identity the agent asked for.
    pub(super) async fn whoami(&self, grant: &Grant, scope: &OrgScope) -> CallToolResult {
        let caller = match self.cloud.caller(&scope.org_id).await {
            Ok(caller) => caller,
            Err(e) => return tool_error(e.to_string()),
        };
        let query = CurrentSessionQuery { scope, native_session_id: &grant.session_id, cwd: &grant.cwd };
        let current = match self.cloud.current_session(query).await {
            Ok(current) => current,
            Err(e) => return tool_error(e.to_string()),
        };

        let current_session = match current {
            None => Value::Null,
            Some(session) => {
                let mut out = json!({
                    "id": session.id,
                    "title": session.title,
                    "live": session.live,
                });
                match self.cloud.comments(&scope.org_id, &session.workspace_id, &session.id).await {
                    Ok(comments) => {
                        let unresolved = comments
                            .iter()
                            .filter(|c| c.is_root() && !c.is_deleted() && c.resolved_at.is_none())
                            .count();
                        out["unresolved_comments"] = json!(unresolved);
                    }
                    Err(e) => {
                        out["unresolved_comments"] = Value::Null;
                        out["comments_error"] = json!(e.to_string());
                    }
                }
                out
            }
        };

        let mut answer = json!({
            "caller": {
                "user_id": caller.user_id,
                "name": caller.name,
                "role": caller.role,
            },
            "organisation": { "id": scope.org_id, "name": caller.organisation_name },
            "workspace": scope.workspace_id.as_ref().map(|id| json!({ "id": id })),
            "current_session": current_session,
        });
        if answer["current_session"].is_null() {
            answer["current_session_reason"] = json!(NOT_RECORDED_YET);
        }
        tool_json(answer)
    }

    /// `org_members`: the roster, or the one member a name resolves to.
    pub(super) async fn members(&self, scope: &OrgScope, name: Option<&str>) -> CallToolResult {
        let roster = match self.cloud.members(&scope.org_id).await {
            Ok(roster) => roster,
            Err(e) => return tool_error(e.to_string()),
        };
        match name {
            None => tool_json(json!({ "members": roster.iter().map(member_json).collect::<Vec<_>>() })),
            Some(name) => match resolve_member(&roster, name) {
                Ok(member) => tool_json(json!({ "member": member_json(&member) })),
                Err(answer) => answer,
            },
        }
    }

    /// `org_conversations`: the conversations the caller is in, then the
    /// channels they could join, or the one a name resolves to. The roster is
    /// read only to name the people in a DM; when it cannot be, the DMs keep
    /// their member ids and the list still answers.
    pub(super) async fn conversations(&self, scope: &OrgScope, name: Option<&str>) -> CallToolResult {
        let conversations = match self.cloud.conversations(&scope.org_id).await {
            Ok(conversations) => conversations,
            Err(e) => return tool_error(e.to_string()),
        };
        let chosen = match name {
            None => conversations,
            Some(name) => match resolve_conversation(&conversations, name) {
                Ok(one) => vec![one],
                Err(answer) => return answer,
            },
        };
        let roster = if chosen.iter().any(|c| c.member_ids.is_some()) {
            self.cloud.members(&scope.org_id).await.ok()
        } else {
            None
        };
        let listed: Vec<Value> = chosen.iter().map(|c| conversation_json(c, roster.as_deref())).collect();
        match name {
            None => tool_json(json!({ "conversations": listed })),
            Some(_) => tool_json(json!({ "conversation": listed[0] })),
        }
    }
}

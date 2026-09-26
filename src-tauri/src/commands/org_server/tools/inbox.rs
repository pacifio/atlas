//! The caller's inbox, read and never marked read: `org_inbox`.

use atlas_artifacts::{InboxEntry, InboxKind};
use rmcp::model::CallToolResult;
use serde_json::{json, Value};

use super::super::cloud::{InboxQuery, Member};
use super::super::OrgScope;
use super::{author_json, tool_error, tool_json, OrgTools};
/// Why an inbox entry concerns the user, in the words the model relays.
fn inbox_kind(kind: InboxKind) -> &'static str {
    match kind {
        InboxKind::Mention => "mention",
        InboxKind::Reply => "reply",
        InboxKind::SessionComment => "comment_on_your_session",
    }
}

/// An inbox entry as the model reads it: why it is there, whether the user
/// has read it, who wrote it ([`author_json`]), and the recorded session and
/// comment it points at, so a follow-up call can name them.
fn inbox_entry_json(entry: &InboxEntry, roster: Option<&[Member]>) -> Value {
    json!({
        "id": entry.id,
        "kind": inbox_kind(entry.kind),
        "unread": entry.is_unread(),
        "created_at": entry.created_at,
        "author": author_json(&entry.actor_id, entry.actor_name.as_deref(), roster),
        "session": { "id": entry.session_id, "title": entry.session_title, "workspace_id": entry.workspace_id },
        "comment": {
            "id": entry.comment_id,
            "anchor_kind": entry.anchor_kind,
            // The session anchor addresses the session itself and has no row.
            "anchor_id": Some(&entry.anchor_id).filter(|id| !id.is_empty()),
            "excerpt": entry.excerpt,
        },
        "link": entry.path,
    })
}

impl OrgTools {
    /// `org_inbox`: one page of the caller's inbox in the grant's
    /// organisation, newest first, with the unread total. Read-only: there is
    /// no call path from here to the server's mark-read route, because the
    /// organisation cloud has none. The roster is read only to name member
    /// authors; when it cannot be, they keep their ids and the inbox still
    /// answers.
    pub(super) async fn inbox(&self, scope: &OrgScope, query: InboxQuery<'_>) -> CallToolResult {
        let page = match self.cloud.inbox(&scope.org_id, query).await {
            Ok(page) => page,
            Err(e) => return tool_error(e.to_string()),
        };
        let mut entries = page.entries;
        // The server already answers newest first; sorting again keeps that
        // promise whatever order a page arrives in. ISO stamps sort as text.
        entries.sort_by(|a, b| (&b.created_at, &b.id).cmp(&(&a.created_at, &a.id)));
        let roster = if entries.iter().any(|e| e.actor_name.is_none()) {
            self.cloud.members(&scope.org_id).await.ok()
        } else {
            None
        };
        tool_json(json!({
            "unread": page.unread,
            "entries": entries.iter().map(|e| inbox_entry_json(e, roster.as_deref())).collect::<Vec<_>>(),
            "next_cursor": page.next_cursor,
        }))
    }
}

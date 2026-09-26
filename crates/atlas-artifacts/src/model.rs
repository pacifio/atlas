//! The shapes the artifacts API answers with.
//!
//! These mirror the server's `packages/contracts`, which in turn transcribed
//! the desktop's own `atlas_checkpoint::artifacts`. The round trip is why a
//! remote Session can sit in the same list as a local one: `rowId` is the
//! desktop's id all the way through, so a Session, a message and a Checkpoint
//! keep the same identity on both sides.
//!
//! # What the wire does not carry
//!
//! Four fields the local read model has do not exist on the wire, because the
//! push shapes never carried them: the Session's starting branch,
//! `needs_attention` / `attention_reason`, turn spans, and a Checkpoint's
//! commit subject. [`RemoteSession::into_summary`] fills them with the
//! honest empty value rather than inventing one.
//!
//! `active_seconds` is also **not** the desktop's figure for the same Session:
//! the server derives it from gap-capped message intervals, the desktop from
//! turn spans. They legitimately disagree, and the server says so on every row.

use serde::{Deserialize, Serialize};

/// A Project as the Organisation knows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProject {
    pub id: String,
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

/// One Session as the Organisation holds it.
///
/// Every numeric field defaults, because the board read is the surface most
/// likely to grow a column server-side and a missing one must not drop the row.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSession {
    pub id: String,
    /// Which Project this row belongs to. Every board row carries it, which is
    /// what lets one org-wide read cover every Project at once.
    #[serde(default)]
    pub workspace_id: String,
    #[serde(default)]
    pub workspace_slug: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub started_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub last_activity_at: String,
    #[serde(default)]
    pub active_seconds: i64,
    #[serde(default)]
    pub wall_seconds: i64,
    #[serde(default)]
    pub message_count: i64,
    #[serde(default)]
    pub tool_call_count: i64,
    #[serde(default)]
    pub checkpoint_count: i64,
    #[serde(default)]
    pub insertions: i64,
    #[serde(default)]
    pub deletions: i64,
    #[serde(default)]
    pub files_touched: i64,
    #[serde(default)]
    pub total_tokens: i64,
    /// The server does **not** split input from output — it carries only the
    /// sum and the two cache figures. Both stay zero on a remote row rather
    /// than being invented, and the viewer already handles a zero split (every
    /// ACP agent reports one).
    #[serde(default)]
    pub input_tokens: i64,
    #[serde(default)]
    pub output_tokens: i64,
    #[serde(default)]
    pub cache_creation_tokens: i64,
    #[serde(default)]
    pub cache_read_tokens: i64,
    #[serde(default)]
    pub context_used: Option<i64>,
    #[serde(default)]
    pub context_size: Option<i64>,
    /// Every branch a Checkpoint landed on. The Session's *starting* branch is
    /// not on the wire, so this is shorter than the local list.
    #[serde(default)]
    pub branches: Vec<String>,
    /// Derived server-side from arrival plus recorded activity, never stored.
    #[serde(default)]
    pub live: bool,
    /// Stamped by the ingest worker from the verified token subject — never
    /// read from a payload, so it is the one field a modified client cannot
    /// forge. Absent on a Session pushed before the server recorded it.
    #[serde(default)]
    pub author_id: Option<String>,
    #[serde(default)]
    pub author_name: Option<String>,
    /// A placeholder the server stood up for a message that arrived before its
    /// Session did. Real, but incomplete.
    #[serde(default)]
    pub incomplete: bool,
}

/// One page of the Organisation's board.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBoardPage {
    #[serde(default)]
    pub sessions: Vec<RemoteSession>,
    #[serde(default)]
    pub workspaces: Vec<RemoteProject>,
    /// `None` on the last page.
    #[serde(default)]
    pub next_cursor: Option<String>,
    /// Server-side caveats — a workspace that could not be reached, or the
    /// fan-out cap being hit. Surfaced rather than swallowed, because a board
    /// that is quietly missing a Project looks like a Project with no work.
    #[serde(default)]
    pub notes: Vec<String>,
}

/// One thing that happened inside a remote Session.
///
/// **Every field beyond the first four is optional, and the server omits the
/// ones that do not apply** rather than sending `null` or `0` — a Checkpoint
/// has no `toolStatus`, a prompt has no `insertions`, and a zero there would be
/// the server claiming it looked and found nothing. So everything defaults.
///
/// Two local fields have no wire equivalent and are filled in by the host:
/// `commitSubject` (resolved from git, which only the machine holding the
/// repository can do) and the `*Ref` blob keys — the server exposes an oversized
/// body through its own payload route keyed by `rowId`, not by a blob key.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub id: String,
    pub kind: String,
    pub at: String,
    #[serde(default)]
    pub turn_seq: i64,

    #[serde(default)]
    pub text: Option<String>,
    /// The body is longer than `text`; the rest is behind the payload route.
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub body_bytes: i64,

    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub tool_title: Option<String>,
    #[serde(default)]
    pub tool_status: Option<String>,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub arguments: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub result_binary: bool,

    #[serde(default)]
    pub commit_sha: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub link_state: Option<String>,
    #[serde(default)]
    pub insertions: i64,
    #[serde(default)]
    pub deletions: i64,
    #[serde(default)]
    pub files: Vec<String>,
}

/// How many of each kind a Session holds.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntryCounts {
    #[serde(default)]
    pub prompts: i64,
    #[serde(default)]
    pub responses: i64,
    #[serde(default)]
    pub thinking: i64,
    #[serde(default)]
    pub tool_calls: i64,
    #[serde(default)]
    pub checkpoints: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteToolTally {
    #[serde(default)]
    pub tool_name: String,
    #[serde(default)]
    pub count: i64,
}

/// One page of a remote Session's timeline.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetailPage {
    #[serde(default)]
    pub summary: RemoteSession,
    #[serde(default)]
    pub entries: Vec<RemoteEntry>,
    #[serde(default)]
    pub counts: RemoteEntryCounts,
    #[serde(default)]
    pub tools: Vec<RemoteToolTally>,
    #[serde(default)]
    pub next_cursor: Option<String>,
    #[serde(default)]
    pub notes: Vec<String>,
}

/// The full text behind a truncated entry.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryPayload {
    /// `None` when the stored bytes are not valid UTF-8.
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub binary: bool,
    #[serde(default)]
    pub bytes: i64,
}

/// Where a comment is attached.
///
/// `Session` addresses the Session itself; the other three address one row by
/// its `rowId`, which is the same id the local store minted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnchorKind {
    Session,
    Message,
    ToolCall,
    Checkpoint,
}

impl AnchorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Message => "message",
            Self::ToolCall => "tool_call",
            Self::Checkpoint => "checkpoint",
        }
    }

    /// The anchor for a timeline entry of this kind.
    ///
    /// Prompts, responses and thinking are all `agent_message` rows on the
    /// wire, so all three anchor as `Message` — the distinction the viewer
    /// draws between them is a `mode` on the row, not a different table.
    pub fn for_entry_kind(kind: &str) -> Option<Self> {
        match kind {
            "prompt" | "response" | "thinking" => Some(Self::Message),
            "tool_call" => Some(Self::ToolCall),
            "checkpoint" => Some(Self::Checkpoint),
            _ => None,
        }
    }
}

/// One comment. Roots and replies are the same shape; a reply has a `parent_id`
/// and replies are exactly one level deep.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub session_id: String,
    pub anchor_kind: AnchorKind,
    pub anchor_id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub author_id: String,
    /// Non-null means a guest, who must never be rendered as a member.
    #[serde(default)]
    pub guest_name: Option<String>,
    /// `None` once deleted. The row stays so replies keep their places.
    #[serde(default)]
    pub body: Option<String>,
    /// Parsed server-side from `<@user-id>` in the body and filtered to people
    /// who may read the Project. A client cannot send this.
    #[serde(default)]
    pub mentions: Vec<String>,
    pub created_at: String,
    #[serde(default)]
    pub edited_at: Option<String>,
    #[serde(default)]
    pub deleted_at: Option<String>,
    #[serde(default)]
    pub resolved_at: Option<String>,
    #[serde(default)]
    pub resolved_by: Option<String>,
}

impl Comment {
    pub fn is_deleted(&self) -> bool {
        self.deleted_at.is_some()
    }

    pub fn is_root(&self) -> bool {
        self.parent_id.is_none()
    }
}

/// Why an inbox entry concerns its reader. Only a comment write produces one,
/// and the kind is the strongest reason the reader was owed it: named in the
/// body, the author of the root being replied to, or the author of the Session
/// commented on.
///
/// A kind this build does not know reads as [`InboxKind::SessionComment`],
/// the weakest of the three — the same fallback the server applies to a
/// stored kind it cannot parse, so an unknown row is never rendered as the
/// strongest signal the inbox has.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "String", into = "&'static str")]
pub enum InboxKind {
    /// `artifact_mention`: the reader was named in the comment.
    Mention,
    /// `artifact_reply`: a reply on a thread the reader started.
    Reply,
    /// `artifact_session_comment`: a comment on a Session the reader recorded.
    SessionComment,
}

impl InboxKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mention => "artifact_mention",
            Self::Reply => "artifact_reply",
            Self::SessionComment => "artifact_session_comment",
        }
    }
}

impl From<String> for InboxKind {
    fn from(stored: String) -> Self {
        match stored.as_str() {
            "artifact_mention" => Self::Mention,
            "artifact_reply" => Self::Reply,
            _ => Self::SessionComment,
        }
    }
}

impl From<InboxKind> for &'static str {
    fn from(kind: InboxKind) -> Self {
        kind.as_str()
    }
}

/// One thing that concerns the reader, from `GET /inbox`.
///
/// The row stores who acted by id; a client resolves the name. `actor_name`
/// is set only for a **guest** holding a share link, who is in nobody's
/// directory and so has no id to resolve.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxEntry {
    pub id: String,
    pub kind: InboxKind,
    #[serde(default)]
    pub org_id: String,
    #[serde(default)]
    pub workspace_id: String,
    #[serde(default)]
    pub workspace_slug: String,
    pub session_id: String,
    #[serde(default)]
    pub session_title: Option<String>,
    pub comment_id: String,
    pub anchor_kind: AnchorKind,
    #[serde(default)]
    pub anchor_id: String,
    pub actor_id: String,
    #[serde(default)]
    pub actor_name: Option<String>,
    /// The comment, shortened — empty once its text has been deleted.
    #[serde(default)]
    pub excerpt: String,
    pub created_at: String,
    /// `None` while unread. Only the reader marks an entry read, and never
    /// through this crate.
    #[serde(default)]
    pub read_at: Option<String>,
    /// A deep link to the anchored comment, relative to the web app's origin.
    #[serde(default)]
    pub path: String,
}

impl InboxEntry {
    pub fn is_unread(&self) -> bool {
        self.read_at.is_none()
    }
}

/// One page of the inbox, newest first.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxPage {
    #[serde(default)]
    pub entries: Vec<InboxEntry>,
    /// Unread across every Workspace the query covers, **not** this page's
    /// share — the server counts the total, because a badge is a total.
    #[serde(default)]
    pub unread: u64,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_commentable_entry_kind_maps_to_an_anchor() {
        // The viewer's three text kinds are one table on the wire. Losing that
        // mapping would put a comment button on a row that cannot carry one.
        assert_eq!(AnchorKind::for_entry_kind("prompt"), Some(AnchorKind::Message));
        assert_eq!(AnchorKind::for_entry_kind("response"), Some(AnchorKind::Message));
        assert_eq!(AnchorKind::for_entry_kind("thinking"), Some(AnchorKind::Message));
        assert_eq!(AnchorKind::for_entry_kind("tool_call"), Some(AnchorKind::ToolCall));
        assert_eq!(AnchorKind::for_entry_kind("checkpoint"), Some(AnchorKind::Checkpoint));
        assert_eq!(AnchorKind::for_entry_kind("nonsense"), None);
    }

    #[test]
    fn anchor_kinds_use_the_servers_spelling() {
        // snake_case on the wire; `toolCall` would 422 at the door.
        assert_eq!(AnchorKind::ToolCall.as_str(), "tool_call");
        assert_eq!(
            serde_json::to_value(AnchorKind::ToolCall).unwrap(),
            serde_json::json!("tool_call")
        );
    }

    #[test]
    fn a_session_row_survives_a_response_that_omits_every_optional_field() {
        // The board is the surface most likely to grow a column server-side.
        // A row that drops on an unknown-but-absent field would empty the list.
        let row: RemoteSession = serde_json::from_value(serde_json::json!({ "id": "ses_1" }))
            .expect("an id is the only thing required");
        assert_eq!(row.id, "ses_1");
        assert_eq!(row.message_count, 0);
        assert_eq!(row.author_id, None);
        assert!(!row.incomplete);
    }

    #[test]
    fn an_inbox_page_decodes_in_the_servers_shape() {
        let page: InboxPage = serde_json::from_value(serde_json::json!({
            "entries": [{
                "id": "n1",
                "kind": "artifact_reply",
                "orgId": "org_1",
                "workspaceId": "ws_1",
                "workspaceSlug": "atlas",
                "sessionId": "ses_1",
                "sessionTitle": null,
                "commentId": "c1",
                "anchorKind": "tool_call",
                "anchorId": "tc_1",
                "actorId": "user_ada",
                "actorName": null,
                "excerpt": "looks good",
                "createdAt": "2026-09-20T10:04:11.000Z",
                "readAt": null,
                "path": "/timeline?org=org_1&workspace=ws_1&session=ses_1&comment=c1",
            }],
            "unread": 60,
            "nextCursor": "1758362651000:n1",
        }))
        .expect("decodes");
        assert_eq!(page.unread, 60, "the total, not the page's share");
        assert_eq!(page.next_cursor.as_deref(), Some("1758362651000:n1"));
        let entry = &page.entries[0];
        assert_eq!(entry.kind, InboxKind::Reply);
        assert_eq!(entry.anchor_kind, AnchorKind::ToolCall);
        assert!(entry.is_unread());
    }

    #[test]
    fn an_inbox_kind_this_build_does_not_know_reads_as_the_weakest() {
        let kind: InboxKind = serde_json::from_value(serde_json::json!("artifact_nudge")).unwrap();
        assert_eq!(kind, InboxKind::SessionComment);
        assert_eq!(serde_json::to_value(InboxKind::Mention).unwrap(), serde_json::json!("artifact_mention"));
    }

    #[test]
    fn a_deleted_comment_keeps_its_place_and_loses_its_body() {
        let c: Comment = serde_json::from_value(serde_json::json!({
            "id": "c1",
            "sessionId": "ses_1",
            "anchorKind": "message",
            "anchorId": "msg_1",
            "authorId": "user_ada",
            "body": serde_json::Value::Null,
            "createdAt": "2026-09-20T10:04:11.000Z",
            "deletedAt": "2026-09-20T10:05:00.000Z",
        }))
        .expect("decodes");
        assert!(c.is_deleted());
        assert!(c.is_root());
        assert_eq!(c.body, None);
    }
}

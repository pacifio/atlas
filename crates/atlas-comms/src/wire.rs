//! The `atlas-chat` wire protocol.
//!
//! Mirrors `packages/contracts/src/chat.ts` in the server repo, which wins on
//! any disagreement. Only the Phase-1 text-chat surface is modelled; calls,
//! drafts and spaces arrive as [`ServerFrame::Unknown`] and are dropped, which
//! is exactly what the contract requires of a client that does not know a `t`.
//!
//! Two shapes here are load-bearing:
//!
//! * **Timestamps are epoch-millisecond integers**, never strings.
//! * **Durable frames carry `seq`; ephemeral ones carry none.** The split is
//!   [`is_journaled`], and it is the only thing allowed to advance a watermark.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Domain objects
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationKind {
    Channel,
    Dm,
    GroupDm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    PublicOrg,
    Private,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub kind: ConversationKind,
    /// Channels are named; DMs are not.
    pub name: Option<String>,
    pub visibility: Visibility,
    #[serde(default)]
    pub workspace_ref_ids: Vec<String>,
    pub created_by: String,
    pub created_at: i64,
    pub archived_at: Option<i64>,
    pub seq: i64,
    /// Populated for a `dm`/`group_dm`; `null` for a channel, whose roster is
    /// never broadcast org-wide.
    pub member_ids: Option<Vec<String>>,
    pub last_activity_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attachment {
    pub id: String,
    pub filename: String,
    pub content_type: String,
    /// As **measured** on completion, not as declared at the intent.
    pub bytes: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeRef {
    pub workspace_ref_id: String,
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    /// `null` when the lines came from a dirty tree.
    #[serde(default)]
    pub commit_sha: Option<String>,
    pub snippet: String,
}

/// A **Session Reference**: a recorded session, or one checkpoint inside it,
/// carried by a message (the contract's `ChatArtifactRef`, ATL-329; the wire
/// keeps its field name, `artifact_refs`): its own list beside
/// `code_refs`, at most [`CHAT_MESSAGE_ARTIFACT_REF_MAX`] on a message.
///
/// A snapshot, like a code reference's snippet: the figures are what the
/// sender saw when the reference was drawn, and the server does not re-derive
/// them. What the server does check is the one thing a client must not
/// decide — that `workspace_ref_id` is a Workspace this organisation owns,
/// visible to all of it (`visibility = 'org'`) and not archived. A restricted
/// Workspace is refused even to its own members, and one bad reference
/// refuses the whole message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionReference {
    /// The whole recorded session: what it was, when it began, how much of it
    /// there is.
    Session(ReferencedSession),
    /// One checkpoint (commit) inside a recorded session.
    Checkpoint(ReferencedCheckpoint),
}

impl SessionReference {
    /// The Workspace the referenced recorded session lives in — the id the
    /// server checks.
    pub fn workspace_ref_id(&self) -> &str {
        match self {
            Self::Session(r) => &r.workspace_ref_id,
            Self::Checkpoint(r) => &r.workspace_ref_id,
        }
    }
}

/// `{kind: "session", …}`: a recorded session as a reference card draws it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReferencedSession {
    /// The Workspace (its `workspace_refs` id — the Workspace registry id).
    pub workspace_ref_id: String,
    /// The recorded session; what the card links to.
    pub session_id: String,
    /// Its title when the reference was drawn; `null` for an untitled run.
    #[serde(default)]
    pub session_title: Option<String>,
    /// The agent that ran it, as the record names it.
    #[serde(default)]
    pub agent: Option<String>,
    /// When it began, epoch milliseconds; `null` when the sender had no figure.
    #[serde(default)]
    pub started_at: Option<i64>,
    #[serde(default)]
    pub messages: u64,
    #[serde(default)]
    pub tool_calls: u64,
    #[serde(default)]
    pub checkpoints: u64,
}

/// `{kind: "checkpoint", …}`: one commit inside a recorded session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReferencedCheckpoint {
    pub workspace_ref_id: String,
    pub session_id: String,
    #[serde(default)]
    pub session_title: Option<String>,
    /// The checkpoint's own row id, which a deep link anchors on.
    pub row_id: String,
    pub commit_sha: String,
    /// The branch it landed on, when the record has one.
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub insertions: u64,
    #[serde(default)]
    pub deletions: u64,
    /// How many distinct paths the commit touched.
    #[serde(default)]
    pub files: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub conv_id: String,
    pub seq: i64,
    pub author_id: String,
    pub body: String,
    #[serde(default)]
    pub reply_to_id: Option<String>,
    #[serde(default)]
    pub edited_at: Option<i64>,
    pub created_at: i64,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    #[serde(default)]
    pub code_refs: Vec<CodeRef>,
    /// Recorded sessions and checkpoints this message points at.
    #[serde(default)]
    pub artifact_refs: Vec<SessionReference>,
    #[serde(default)]
    pub draft_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReactionRow {
    pub message_id: String,
    pub user_id: String,
    pub emoji: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadState {
    pub conv_id: String,
    pub last_read_seq: i64,
    pub unread: i64,
    pub mentions: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pin {
    pub conv_id: String,
    pub message_id: String,
    pub pinned_by: String,
    pub at: i64,
    /// The pinned message rides with the pin, so a rail renders in one request.
    #[serde(default)]
    pub message: Option<Message>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CallMode {
    Audio,
    Video,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CallRecordingState {
    #[default]
    Off,
    Starting,
    Recording,
    Processing,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CallTranscriptState {
    #[default]
    None,
    Pending,
    Ready,
    Failed,
}

/// A call, as the timeline knows it.
///
/// Two sources, one map: `GET /calls?conv_id=…&include=recent` (ATL-208) is
/// the cold-sync — every live call plus the last 10 ended — and the journaled
/// `call.*` frames are the live overlay on top. The frames alone are NOT
/// enough: a watermark already at the live edge replays nothing, so a client
/// that never fetched would show no history at all (which is exactly the bug
/// this note used to encode as a design).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Call {
    pub id: String,
    #[serde(default)]
    pub conv_id: Option<String>,
    pub mode: CallMode,
    pub started_by: String,
    pub started_at: i64,
    #[serde(default)]
    pub ended_at: Option<i64>,
    pub seq: i64,
    #[serde(default)]
    pub transcript_state: CallTranscriptState,
    #[serde(default)]
    pub join_slug: Option<String>,
    #[serde(default)]
    pub recording_state: CallRecordingState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireError {
    pub code: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub detail: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

/// A frame from the server.
///
/// [`ServerFrame::Unknown`] is not an error path: the server ships ahead of any
/// given client and every not-yet-built slice (calls, drafts, spaces) will land
/// on an existing socket. A client that errored on one would break itself on a
/// server deploy.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "t")]
pub enum ServerFrame {
    #[serde(rename = "hello")]
    Hello(Box<Hello>),

    #[serde(rename = "resumed")]
    Resumed { through: i64, count: i64 },

    #[serde(rename = "too_old")]
    TooOld { snapshot_from: i64 },

    #[serde(rename = "ack")]
    Ack {
        client_msg_id: String,
        id: String,
        seq: i64,
    },

    #[serde(rename = "message.new")]
    MessageNew(Box<MessageNew>),

    #[serde(rename = "message.edited")]
    MessageEdited {
        seq: i64,
        conv_id: String,
        id: String,
        body: String,
        edited_at: i64,
    },

    #[serde(rename = "message.deleted")]
    MessageDeleted {
        seq: i64,
        conv_id: String,
        id: String,
        deleted_at: i64,
    },

    #[serde(rename = "reaction.added")]
    ReactionAdded {
        seq: i64,
        conv_id: String,
        message_id: String,
        user_id: String,
        emoji: String,
    },

    #[serde(rename = "reaction.removed")]
    ReactionRemoved {
        seq: i64,
        conv_id: String,
        message_id: String,
        user_id: String,
        emoji: String,
    },

    #[serde(rename = "pin.added")]
    PinAdded {
        seq: i64,
        conv_id: String,
        message_id: String,
        pinned_by: String,
        at: i64,
    },

    /// Fires for an unpin **and** for a deleted message — one handler, so a
    /// rail can never point at something that is gone.
    #[serde(rename = "pin.removed")]
    PinRemoved {
        seq: i64,
        conv_id: String,
        message_id: String,
    },

    #[serde(rename = "conversation.created")]
    ConversationCreated { seq: i64, conversation: Conversation },

    #[serde(rename = "conversation.updated")]
    ConversationUpdated { seq: i64, conversation: Conversation },

    #[serde(rename = "member.joined")]
    MemberJoined {
        seq: i64,
        conv_id: String,
        user_id: String,
    },

    #[serde(rename = "member.left")]
    MemberLeft {
        seq: i64,
        conv_id: String,
        user_id: String,
    },

    /// Removed from the *Organisation*. Delivered, then the socket closes 1008.
    /// A distinct frame from `member.left` on purpose: "they left this channel"
    /// and "they are no longer with us" read differently in a timeline.
    #[serde(rename = "member.evicted")]
    MemberEvicted {
        seq: i64,
        conv_id: String,
        user_id: String,
    },

    /// To the reader's own sockets only — publishing it wider would be a read
    /// receipt. Carries no `seq`.
    #[serde(rename = "read.updated")]
    ReadUpdated {
        conv_id: String,
        last_read_seq: i64,
        unread: i64,
        mentions: i64,
    },

    /// The **whole** online set, not a delta. Apply as an assignment.
    #[serde(rename = "presence")]
    Presence { online: Vec<String> },

    #[serde(rename = "typing")]
    Typing { conv_id: String, user_id: String },

    /// The ringing signal AND the timeline card, one journaled frame.
    #[serde(rename = "call.started")]
    CallStarted { seq: i64, call: Call },

    #[serde(rename = "call.ended")]
    CallEnded {
        seq: i64,
        call_id: String,
        ended_at: i64,
        #[serde(default)]
        duration_s: Option<i64>,
    },

    /// Journaled on purpose — that is what makes the indicator honest for
    /// somebody who was away while it ran.
    #[serde(rename = "call.recording")]
    CallRecording {
        seq: i64,
        call_id: String,
        state: CallRecordingState,
    },

    /// Lands minutes after the call ended, hence its own frame rather than a
    /// field on `call.ended`.
    #[serde(rename = "call.transcript")]
    CallTranscript {
        seq: i64,
        call_id: String,
        state: CallTranscriptState,
    },

    #[serde(rename = "error")]
    Error { error: WireError },

    /// The answer to `draft.open` (and to a repeated `draft.send`): the
    /// draft's metadata plus its content as a snapshot (null until the first
    /// compaction) and the update log after it — all opaque base64 Yjs bytes
    /// this crate never decodes. To the asking socket only.
    /// NOTE the shape: `DraftContent + t` — there is NO top-level `draft_id`
    /// (the id lives inside `draft`). The API doc's frame table claims one;
    /// the zod contract (`ChatDraftOpened = DraftContent.extend({t})`) does
    /// not, and the contract file wins by its own preamble. Requiring the
    /// phantom field made serde drop every real `draft.opened`, which
    /// presented as an editor that loaded forever.
    #[serde(rename = "draft.opened")]
    DraftOpened {
        // Boxed: nine owned fields would make this the largest ServerFrame
        // variant and fatten every frame the channel moves.
        draft: Box<crate::rest::PromptDraft>,
        #[serde(default)]
        snapshot: Option<String>,
        #[serde(default)]
        updates: Vec<String>,
    },

    /// Somebody else's Yjs bytes, relayed verbatim to this draft's OTHER
    /// subscribers. Durable server-side but never journaled — no seq, never
    /// replayed on resume.
    #[serde(rename = "draft.update")]
    DraftUpdate { draft_id: String, update: String },

    /// Somebody else's cursor. `user_id` is stamped by the server from the
    /// socket identity — there is no field a client could forge it in.
    #[serde(rename = "draft.awareness")]
    DraftAwareness {
        draft_id: String,
        user_id: String,
        state: String,
    },

    /// Any `t` this build does not model — dropped, never an error.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Hello {
    pub seq: i64,
    pub user_id: String,
    pub org_id: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub conversations: Vec<Conversation>,
    #[serde(default)]
    pub discoverable: Vec<Conversation>,
    /// Restated on **every** connection — read state is never journaled, so a
    /// replay cannot teach it.
    #[serde(default)]
    pub reads: Vec<ReadState>,
    #[serde(default)]
    pub online: Vec<String>,
}

/// `message.new` is the message's fields inline alongside `t`, not nested.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct MessageNew {
    pub seq: i64,
    pub conv_id: String,
    pub id: String,
    pub author_id: String,
    pub body: String,
    #[serde(default)]
    pub reply_to_id: Option<String>,
    #[serde(default)]
    pub edited_at: Option<i64>,
    pub created_at: i64,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    #[serde(default)]
    pub code_refs: Vec<CodeRef>,
    #[serde(default)]
    pub artifact_refs: Vec<SessionReference>,
    #[serde(default)]
    pub draft_id: Option<String>,
    /// Echoed back so a client can recognise its own send arriving on another
    /// device. Absent on frames from other authors.
    #[serde(default)]
    pub client_msg_id: Option<String>,
}

impl MessageNew {
    pub fn into_message(self) -> Message {
        Message {
            id: self.id,
            conv_id: self.conv_id,
            seq: self.seq,
            author_id: self.author_id,
            body: self.body,
            reply_to_id: self.reply_to_id,
            edited_at: self.edited_at,
            created_at: self.created_at,
            attachments: self.attachments,
            code_refs: self.code_refs,
            artifact_refs: self.artifact_refs,
            draft_id: self.draft_id,
        }
    }
}

/// Does this frame carry an org-wide `seq` that may advance the watermark?
///
/// The whole point of the distinction: advancing from an ephemeral frame would
/// skip real history on the next `resume`, silently and permanently.
pub fn is_journaled(frame: &ServerFrame) -> bool {
    match frame {
        ServerFrame::MessageNew(_)
        | ServerFrame::MessageEdited { .. }
        | ServerFrame::MessageDeleted { .. }
        | ServerFrame::ReactionAdded { .. }
        | ServerFrame::ReactionRemoved { .. }
        | ServerFrame::PinAdded { .. }
        | ServerFrame::PinRemoved { .. }
        | ServerFrame::ConversationCreated { .. }
        | ServerFrame::ConversationUpdated { .. }
        | ServerFrame::MemberJoined { .. }
        | ServerFrame::MemberLeft { .. }
        | ServerFrame::MemberEvicted { .. }
        | ServerFrame::CallStarted { .. }
        | ServerFrame::CallEnded { .. }
        | ServerFrame::CallRecording { .. }
        | ServerFrame::CallTranscript { .. } => true,

        // `ack` carries a seq but is addressed to one socket, so it is not a
        // journal position this client may adopt: the same seq arrives at
        // everyone else as `message.new`.
        ServerFrame::Ack { .. }
        | ServerFrame::Hello(_)
        | ServerFrame::Resumed { .. }
        | ServerFrame::TooOld { .. }
        | ServerFrame::ReadUpdated { .. }
        | ServerFrame::Presence { .. }
        | ServerFrame::Typing { .. }
        | ServerFrame::Error { .. }
        // Draft traffic is durable server-side but NEVER journaled: no seq,
        // never replayed on resume, must never advance a watermark.
        | ServerFrame::DraftOpened { .. }
        | ServerFrame::DraftUpdate { .. }
        | ServerFrame::DraftAwareness { .. }
        | ServerFrame::Unknown => false,
    }
}

/// The `seq` a journaled frame carries, for advancing the watermark.
pub fn frame_seq(frame: &ServerFrame) -> Option<i64> {
    match frame {
        ServerFrame::MessageNew(m) => Some(m.seq),
        ServerFrame::MessageEdited { seq, .. }
        | ServerFrame::MessageDeleted { seq, .. }
        | ServerFrame::ReactionAdded { seq, .. }
        | ServerFrame::ReactionRemoved { seq, .. }
        | ServerFrame::PinAdded { seq, .. }
        | ServerFrame::PinRemoved { seq, .. }
        | ServerFrame::ConversationCreated { seq, .. }
        | ServerFrame::ConversationUpdated { seq, .. }
        | ServerFrame::MemberJoined { seq, .. }
        | ServerFrame::MemberLeft { seq, .. }
        | ServerFrame::MemberEvicted { seq, .. }
        | ServerFrame::CallStarted { seq, .. }
        | ServerFrame::CallEnded { seq, .. }
        | ServerFrame::CallRecording { seq, .. }
        | ServerFrame::CallTranscript { seq, .. } => Some(*seq),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "t")]
pub enum ClientFrame {
    #[serde(rename = "resume")]
    Resume { since: i64 },

    #[serde(rename = "send")]
    Send {
        conv_id: String,
        client_msg_id: String,
        body: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reply_to_id: Option<String>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<String>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        code_refs: Vec<CodeRef>,
        /// At most [`CHAT_MESSAGE_ARTIFACT_REF_MAX`], sent whole.
        #[serde(skip_serializing_if = "Vec::is_empty")]
        artifact_refs: Vec<SessionReference>,
    },

    #[serde(rename = "edit")]
    Edit { message_id: String, body: String },

    #[serde(rename = "delete")]
    Delete { message_id: String },

    /// `on` is explicit state, not a toggle: a retried frame must not become an
    /// accidental removal.
    #[serde(rename = "react")]
    React {
        message_id: String,
        emoji: String,
        on: bool,
    },

    #[serde(rename = "pin")]
    Pin { message_id: String, on: bool },

    #[serde(rename = "read")]
    Read { conv_id: String, seq: i64 },

    #[serde(rename = "typing")]
    Typing { conv_id: String },

    /// Subscribe THIS SOCKET to a draft (ATL-194). Answered with
    /// `draft.opened`; the subscription dies with the socket (cap 16,
    /// LRU-evicted, no close frame), so a reconnect must re-open.
    #[serde(rename = "draft.open")]
    DraftOpen { draft_id: String },

    /// Opaque base64 Yjs bytes, ≤128KB decoded, ~100ms debounced by the
    /// caller. The server stores and relays them and parses NOTHING —
    /// that is the whole of the confidentiality claim (ADR-0011).
    #[serde(rename = "draft.update")]
    DraftUpdate { draft_id: String, update: String },

    /// Cursor state, ≤16KB decoded. Ephemeral: no table, no journal, no seq.
    #[serde(rename = "draft.awareness")]
    DraftAwareness { draft_id: String, state: String },

    /// Send a draft (ATL-201): marks it sent and posts one ordinary message
    /// linking it. The references the draft was written with ride on the
    /// frame — the server never reads a draft's bytes — and are checked
    /// exactly as a `send`'s are (ATL-329).
    #[serde(rename = "draft.send")]
    DraftSend {
        draft_id: String,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        artifact_refs: Vec<SessionReference>,
    },
}

/// The reaction allowlist, vendored verbatim from the contract. A `react`
/// carrying anything else is a `400`, so a picker is built from this list.
pub const CHAT_REACTION_EMOJI: &[&str] = &[
    "\u{1F44D}",
    "\u{1F44E}",
    "\u{1F602}",
    "\u{1F389}",
    "\u{1F440}",
    "\u{1F680}",
    "\u{1F525}",
    "\u{1F914}",
    "\u{1F621}",
    "\u{1F62E}",
    "\u{1F64F}",
    "\u{1F4AF}",
    "\u{1F41B}",
    "\u{1F44F}",
    "\u{2764}\u{FE0F}",
    "\u{2705}",
    "\u{274C}",
    "\u{26A0}\u{FE0F}",
    "\u{1F44C}",
    "\u{1F937}",
];

pub fn is_allowed_reaction(emoji: &str) -> bool {
    CHAT_REACTION_EMOJI.contains(&emoji)
}

/// Body limit, in UTF-8 **bytes** — emoji and CJK cost 3–4× a character.
pub const CHAT_BODY_MAX_BYTES: usize = 16 * 1024;
pub const CHANNEL_NAME_MAX: usize = 80;
pub const CHAT_MESSAGE_ATTACHMENT_MAX: usize = 10;
/// The most recorded-session and checkpoint references one message carries.
pub const CHAT_MESSAGE_ARTIFACT_REF_MAX: usize = 3;
/// A reference's `session_title` bound, in UTF-16 code units (zod's `max`).
pub const CHAT_ARTIFACT_REF_TITLE_MAX: usize = 200;
pub const CHAT_PIN_LIMIT: usize = 100;
pub const CHAT_TYPING_INTERVAL_MS: u64 = 3_000;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn session_ref() -> SessionReference {
        SessionReference::Session(ReferencedSession {
            workspace_ref_id: "ws_1".into(),
            session_id: "s_1".into(),
            session_title: Some("Fix the flaky login test".into()),
            agent: Some("atlas-agent".into()),
            started_at: Some(1_790_000_000_000),
            messages: 12,
            tool_calls: 30,
            checkpoints: 2,
        })
    }

    fn checkpoint_ref() -> SessionReference {
        SessionReference::Checkpoint(ReferencedCheckpoint {
            workspace_ref_id: "ws_1".into(),
            session_id: "s_1".into(),
            session_title: None,
            row_id: "row_9".into(),
            commit_sha: "abc1234def".into(),
            branch: None,
            insertions: 4,
            deletions: 1,
            files: 2,
        })
    }

    #[test]
    fn a_send_carries_its_session_reference_in_the_servers_shape() {
        let frame = ClientFrame::Send {
            conv_id: "c1".into(),
            client_msg_id: "cm1".into(),
            body: "the report".into(),
            reply_to_id: None,
            attachments: vec![],
            code_refs: vec![],
            artifact_refs: vec![session_ref()],
        };
        assert_eq!(
            serde_json::to_value(&frame).unwrap(),
            json!({
                "t": "send",
                "conv_id": "c1",
                "client_msg_id": "cm1",
                "body": "the report",
                "artifact_refs": [{
                    "kind": "session",
                    "workspace_ref_id": "ws_1",
                    "session_id": "s_1",
                    "session_title": "Fix the flaky login test",
                    "agent": "atlas-agent",
                    "started_at": 1_790_000_000_000i64,
                    "messages": 12,
                    "tool_calls": 30,
                    "checkpoints": 2,
                }],
            })
        );
    }

    #[test]
    fn a_send_without_references_leaves_the_list_off() {
        let frame = ClientFrame::Send {
            conv_id: "c1".into(),
            client_msg_id: "cm1".into(),
            body: "hi".into(),
            reply_to_id: None,
            attachments: vec![],
            code_refs: vec![],
            artifact_refs: vec![],
        };
        assert!(serde_json::to_value(&frame).unwrap().get("artifact_refs").is_none());
    }

    #[test]
    fn a_checkpoint_reference_names_its_nulls_rather_than_inventing_values() {
        assert_eq!(
            serde_json::to_value(checkpoint_ref()).unwrap(),
            json!({
                "kind": "checkpoint",
                "workspace_ref_id": "ws_1",
                "session_id": "s_1",
                "session_title": null,
                "row_id": "row_9",
                "commit_sha": "abc1234def",
                "branch": null,
                "insertions": 4,
                "deletions": 1,
                "files": 2,
            })
        );
    }

    #[test]
    fn a_draft_send_carries_the_drafts_references() {
        let frame = ClientFrame::DraftSend {
            draft_id: "d1".into(),
            artifact_refs: vec![session_ref(), checkpoint_ref()],
        };
        let value = serde_json::to_value(&frame).unwrap();
        assert_eq!(value["t"], "draft.send");
        assert_eq!(value["draft_id"], "d1");
        assert_eq!(value["artifact_refs"][0]["kind"], "session");
        assert_eq!(value["artifact_refs"][1]["kind"], "checkpoint");
        assert_eq!(value["artifact_refs"][1]["row_id"], "row_9");
    }

    #[test]
    fn a_received_message_reads_its_references_and_the_servers_defaults() {
        // As the server journals it: a session reference with its defaulted
        // fields left out, and a checkpoint one in full.
        let frame: ServerFrame = serde_json::from_value(json!({
            "t": "message.new",
            "seq": 7,
            "conv_id": "c1",
            "id": "m1",
            "author_id": "u1",
            "body": "see the run",
            "created_at": 1,
            "artifact_refs": [
                { "kind": "session", "workspace_ref_id": "ws_1", "session_id": "s_1" },
                serde_json::to_value(checkpoint_ref()).unwrap(),
            ],
        }))
        .unwrap();
        let ServerFrame::MessageNew(new) = frame else { panic!("not a message.new") };
        let message = new.into_message();
        assert_eq!(
            message.artifact_refs,
            vec![
                SessionReference::Session(ReferencedSession {
                    workspace_ref_id: "ws_1".into(),
                    session_id: "s_1".into(),
                    session_title: None,
                    agent: None,
                    started_at: None,
                    messages: 0,
                    tool_calls: 0,
                    checkpoints: 0,
                }),
                checkpoint_ref(),
            ]
        );
        assert_eq!(message.artifact_refs[0].workspace_ref_id(), "ws_1");
    }

    #[test]
    fn a_message_written_before_references_existed_still_reads() {
        let message: Message = serde_json::from_value(json!({
            "id": "m1", "conv_id": "c1", "seq": 1, "author_id": "u1", "body": "old", "created_at": 1,
        }))
        .unwrap();
        assert!(message.artifact_refs.is_empty());
    }
}

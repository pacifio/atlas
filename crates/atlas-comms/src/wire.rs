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
pub const CHAT_PIN_LIMIT: usize = 100;
pub const CHAT_TYPING_INTERVAL_MS: u64 = 3_000;

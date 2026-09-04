//! What crosses the bridge to the renderer.
//!
//! Mirrored by hand in TypeScript, as `AuthSnapshot` already is. Everything
//! here is a *projection* of [`crate::state::ChatState`] — the renderer applies
//! these mechanically and decides nothing.
//!
//! **Casing:** event *names* are camelCase (`messageAppended`), because they are
//! read as a discriminant in a TS switch. Every *field* stays snake_case,
//! because most of them are wire objects — a `Conversation` carries
//! `member_ids` and a message carries `conv_id`, and translating half of a
//! payload would leave the renderer holding two dialects of the same object.
//!
//! The governing rule: **steady state emits granular events; bulk transitions
//! emit one [`CommsEvent::Resync`]**. A resume replay of five thousand frames
//! is one repaint, not five thousand events, and the renderer re-reads the
//! snapshot commands when the epoch moves.

use serde::Serialize;

use crate::wire::{Attachment, Call, CodeRef, Conversation, ReactionRow, ReadState};

#[derive(Debug, Clone, Serialize)]
pub struct CommsEnvelope {
    /// Server org id. The renderer drops envelopes for a stale org mid-switch.
    pub org: String,
    /// Bumped on every socket open and every cold-sync.
    pub epoch: u64,
    pub ev: CommsEvent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Open,
    Backoff,
    /// Stopped trying, because retrying cannot help.
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnReason {
    Auth,
    NotAMember,
    Evicted,
    Offline,
}

/// A message as the renderer receives it: the wire row plus local-only fields.
#[derive(Debug, Clone, Serialize)]
pub struct WireMessage {
    pub id: String,
    pub conv_id: String,
    pub seq: i64,
    pub author_id: String,
    pub body: String,
    pub reply_to_id: Option<String>,
    pub edited_at: Option<i64>,
    pub created_at: i64,
    pub attachments: Vec<Attachment>,
    pub code_refs: Vec<CodeRef>,
    pub draft_id: Option<String>,
    pub client_msg_id: Option<String>,
    /// `"sending" | "sent" | "failed"`. Two rungs plus a failure — nothing on
    /// this wire reports that a message reached a device, so there is no
    /// "delivered".
    pub status: &'static str,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CommsEvent {
    Connection {
        state: ConnectionState,
        reason: Option<ConnReason>,
        retry_at_ms: Option<i64>,
    },

    /// Re-invoke the snapshot commands; the epoch has moved.
    Resync,

    MessageAppended {
        conv_id: String,
        message: WireMessage,
    },

    MessageUpdated {
        conv_id: String,
        /// The optimistic id this replaces, when an `ack` reconciled a send.
        replaced_id: Option<String>,
        message: WireMessage,
    },

    ConversationsChanged {
        conversations: Vec<Conversation>,
        discoverable: Vec<Conversation>,
    },

    ReadsChanged { reads: Vec<ReadState> },

    /// One conversation's read state moved. The common case — every
    /// `read.updated` frame names a single conversation — used to ride the
    /// bulk event above, re-serializing the WHOLE read table per read
    /// receipt. Bulk stays for snapshot restatements (clean reconnect).
    ReadChanged { read: ReadState },

    /// The **whole** online set — an assignment, not a delta.
    Presence { online: Vec<String> },

    Typing {
        conv_id: String,
        user_id: String,
        at_ms: i64,
    },

    /// Rows, never counts.
    ReactionsChanged {
        message_id: String,
        rows: Vec<ReactionRow>,
    },

    PinsChanged {
        conv_id: String,
        pinned_message_ids: Vec<String>,
    },

    MemberChanged {
        conv_id: String,
        user_id: String,
        /// `"joined" | "left" | "evicted"`.
        change: &'static str,
    },

    UploadProgress {
        upload_id: String,
        sent_bytes: u64,
        total_bytes: u64,
        /// `"uploading" | "complete" | "failed"`.
        state: &'static str,
        error: Option<String>,
    },

    /// Mirror of `UploadProgress` for the other direction. `total_bytes` is
    /// `0` when the server did not declare a content-length — render an
    /// indeterminate ring, not a 0% one.
    DownloadProgress {
        download_id: String,
        got_bytes: u64,
        total_bytes: u64,
        /// `"downloading" | "complete" | "failed"`.
        state: &'static str,
        error: Option<String>,
    },

    /// A call started, ended, or changed recording/transcript state. Carries
    /// the whole call — like `conversation.updated`, a replayed pair then
    /// converges whichever order it arrives in.
    CallChanged {
        call: Call,
    },

    /// Frames carry no correlation id, so these are stamped on arrival: two
    /// identical refusals are two events, not one.
    Error {
        code: String,
        message: String,
        detail: Option<serde_json::Value>,
    },
}

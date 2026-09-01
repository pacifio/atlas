//! The authoritative chat state, and the pure reducer over it.
//!
//! A port of the reference web client's `applyFrame`
//! (`apps/web/src/lib/chat.ts`), including the reasoning in its comments —
//! those record *why* a branch is shaped as it is, which is the part that gets
//! lost and then reinvented wrongly.
//!
//! [`apply_frame`] is pure: state in, state mutated, a list of [`StateDelta`]
//! out. It performs no I/O and knows nothing about sockets, which is what makes
//! the whole protocol testable against recorded frames.

use std::collections::HashMap;

use crate::wire::{
    Conversation, Message, ReactionRow, ReadState, ServerFrame, Visibility, WireError,
};

/// A send this client has written but not yet seen acknowledged.
///
/// The `ack` carries only `{client_msg_id, id, seq}`, so everything else about
/// the message has to be remembered here or the reconciled row would be blank.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingSend {
    pub client_msg_id: String,
    pub conv_id: String,
    pub body: String,
    pub reply_to_id: Option<String>,
    pub attachments: Vec<String>,
    /// When it was written, for the no-ack timeout.
    pub sent_at: i64,
}

pub type PendingMap = HashMap<String, PendingSend>;

/// A message as this client holds it: the wire row plus local-only fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalMessage {
    pub message: Message,
    /// Set while optimistic; cleared when the `ack` reconciles it.
    pub client_msg_id: Option<String>,
    pub status: SendStatus,
    /// The row survives a delete so a reply can still point at it.
    pub deleted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendStatus {
    /// Not ours, or ours and already acknowledged.
    Settled,
    Sending,
    Failed,
}

impl LocalMessage {
    pub fn settled(message: Message) -> Self {
        Self {
            message,
            client_msg_id: None,
            status: SendStatus::Settled,
            deleted: false,
        }
    }
}

/// What changed, for the manager to turn into events for the UI.
#[derive(Debug, Clone, PartialEq)]
pub enum StateDelta {
    Hello,
    ConversationsChanged,
    MessageAppended {
        conv_id: String,
        id: String,
    },
    MessageUpdated {
        conv_id: String,
        id: String,
        /// The optimistic id this replaces, when an `ack` reconciled a send.
        replaced_id: Option<String>,
    },
    ReactionsChanged {
        message_id: String,
    },
    PinsChanged {
        conv_id: String,
    },
    ReadsChanged {
        conv_id: String,
    },
    Presence,
    Typing {
        conv_id: String,
        user_id: String,
        at_ms: i64,
    },
    MemberChanged {
        conv_id: String,
        user_id: String,
        change: MemberChange,
    },
    Error {
        code: String,
        message: String,
    },
    /// The replay finished; `through` is the new watermark.
    Resumed {
        through: i64,
    },
    /// The resume point fell outside the journal; cold-sync from here.
    TooOld {
        snapshot_from: i64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemberChange {
    Joined,
    Left,
    Evicted,
}

#[derive(Debug, Default, Clone)]
pub struct ChatState {
    /// Identity as the *server* resolved it from the ticket.
    pub me: Option<String>,
    pub org_id: Option<String>,
    pub conversations: Vec<Conversation>,
    /// `public_org` channels we may join but have not. A separate list on
    /// purpose: keeping them apart is what stops a rendering mistake from
    /// showing the contents of a conversation we are not in.
    pub discoverable: Vec<Conversation>,
    pub messages: HashMap<String, Vec<LocalMessage>>,
    /// Reaction **rows**, per message. Counts are derived at render; storing a
    /// count would be a second source of truth that drifts on a missed frame.
    pub reactions: HashMap<String, Vec<ReactionRow>>,
    pub pins: HashMap<String, Vec<String>>,
    pub reads: HashMap<String, ReadState>,
    pub online: Vec<String>,
    /// Who is typing where, and when they last said so. The timestamp is the
    /// whole mechanism — there is no "stopped typing" frame, so a reader ages
    /// the entry out, which is right for a pause and for a crash alike.
    pub typing: HashMap<String, HashMap<String, i64>>,
    pub last_error: Option<WireError>,
}

impl ChatState {
    pub fn conversation(&self, id: &str) -> Option<&Conversation> {
        self.conversations.iter().find(|c| c.id == id)
    }

    pub fn is_member(&self, id: &str) -> bool {
        self.conversation(id).is_some()
    }

    /// Every message id we hold for a conversation, oldest first.
    pub fn messages(&self, conv_id: &str) -> &[LocalMessage] {
        self.messages.get(conv_id).map(Vec::as_slice).unwrap_or(&[])
    }

    fn insert_message(&mut self, conv_id: &str, message: LocalMessage) -> bool {
        let list = self.messages.entry(conv_id.to_string()).or_default();
        if list.iter().any(|m| m.message.id == message.message.id) {
            return false;
        }
        list.push(message);
        // Ordered by seq. An optimistic row has a provisional seq past the tail,
        // so it sorts last until its ack gives it the real one.
        list.sort_by_key(|m| m.message.seq);
        true
    }

    fn find_mut(&mut self, conv_id: &str, id: &str) -> Option<&mut LocalMessage> {
        self.messages
            .get_mut(conv_id)?
            .iter_mut()
            .find(|m| m.message.id == id)
    }
}

/// Apply one server frame. Pure — no I/O, no clock beyond `now_ms`.
///
/// `now_ms` is passed in rather than read so a test can drive time.
pub fn apply_frame(
    state: &mut ChatState,
    frame: ServerFrame,
    pending: &mut PendingMap,
    now_ms: i64,
) -> Vec<StateDelta> {
    match frame {
        ServerFrame::Hello(hello) => {
            state.me = Some(hello.user_id.clone());
            state.org_id = Some(hello.org_id.clone());
            state.conversations = hello.conversations.clone();
            state.discoverable = hello.discoverable.clone();
            // Restated on every connection, which is what makes a badge survive
            // a reconnect: read state is per-person and never journaled, so
            // there is no replay to learn the position from after a gap.
            state.reads = hello
                .reads
                .iter()
                .map(|r| (r.conv_id.clone(), r.clone()))
                .collect();
            // Presence is ephemeral and never journaled either; this snapshot
            // is what stands in for a replay.
            state.online = hello.online.clone();
            vec![StateDelta::Hello]
        }

        ServerFrame::Resumed { through, .. } => vec![StateDelta::Resumed { through }],
        ServerFrame::TooOld { snapshot_from } => vec![StateDelta::TooOld { snapshot_from }],

        ServerFrame::Ack {
            client_msg_id,
            id,
            seq,
        } => {
            let Some(sent) = pending.remove(&client_msg_id) else {
                // An ack for something we are not holding: a duplicate, or a
                // resend after a restart. Nothing to reconcile.
                return Vec::new();
            };
            let optimistic_id = optimistic_id(&client_msg_id);
            let conv_id = sent.conv_id.clone();

            // The optimistic row may already have been replaced by a
            // `message.new` from our own other device; if so there is nothing
            // left to promote and the real row is already in place.
            let existing = state
                .messages
                .get_mut(&conv_id)
                .and_then(|l| l.iter_mut().find(|m| m.message.id == optimistic_id));

            match existing {
                Some(row) => {
                    row.message.id = id.clone();
                    row.message.seq = seq;
                    row.client_msg_id = None;
                    row.status = SendStatus::Settled;
                    if let Some(list) = state.messages.get_mut(&conv_id) {
                        list.sort_by_key(|m| m.message.seq);
                    }
                    vec![StateDelta::MessageUpdated {
                        conv_id,
                        id,
                        replaced_id: Some(optimistic_id),
                    }]
                }
                None => Vec::new(),
            }
        }

        ServerFrame::MessageNew(new) => {
            let conv_id = new.conv_id.clone();
            let author = new.author_id.clone();
            let client_msg_id = new.client_msg_id.clone();
            let message = new.into_message();
            let id = message.id.clone();

            // Our own send, arriving on this device from another one. Dedupe by
            // `client_msg_id` or the message doubles: the sender's socket gets
            // `ack`, every *other* socket of the same author gets this.
            if let Some(cmid) = client_msg_id.as_ref() {
                if pending.remove(cmid).is_some() {
                    let optimistic = optimistic_id(cmid);
                    if let Some(row) = state.find_mut(&conv_id, &optimistic) {
                        row.message = message;
                        row.client_msg_id = None;
                        row.status = SendStatus::Settled;
                        if let Some(list) = state.messages.get_mut(&conv_id) {
                            list.sort_by_key(|m| m.message.seq);
                        }
                        return vec![StateDelta::MessageUpdated {
                            conv_id,
                            id,
                            replaced_id: Some(optimistic),
                        }];
                    }
                }
            }

            let appended = state.insert_message(&conv_id, LocalMessage::settled(message));

            // They finished the sentence. There is no "stopped typing" frame,
            // and this is a better signal than a timeout because it is exactly
            // when the hint stopped being true.
            let mut deltas = Vec::new();
            if let Some(room) = state.typing.get_mut(&conv_id) {
                if room.remove(&author).is_some() {
                    deltas.push(StateDelta::Typing {
                        conv_id: conv_id.clone(),
                        user_id: author,
                        at_ms: 0, // 0 = cleared
                    });
                }
            }
            if appended {
                deltas.push(StateDelta::MessageAppended { conv_id, id });
            }
            deltas
        }

        ServerFrame::MessageEdited {
            conv_id,
            id,
            body,
            edited_at,
            ..
        } => match state.find_mut(&conv_id, &id) {
            Some(row) => {
                row.message.body = body;
                row.message.edited_at = Some(edited_at);
                vec![StateDelta::MessageUpdated {
                    conv_id,
                    id,
                    replaced_id: None,
                }]
            }
            None => Vec::new(),
        },

        // Destructive: the body is gone from the table *and* scrubbed from the
        // journal. The row stays so a reply to it still renders a stub.
        // Idempotent and order-independent.
        ServerFrame::MessageDeleted { conv_id, id, .. } => match state.find_mut(&conv_id, &id) {
            Some(row) => {
                row.deleted = true;
                row.message.body.clear();
                row.message.attachments.clear();
                row.message.code_refs.clear();
                let mut deltas = vec![StateDelta::MessageUpdated {
                    conv_id: conv_id.clone(),
                    id: id.clone(),
                    replaced_id: None,
                }];
                // A deleted message takes its pin with it; the server also
                // sends `pin.removed`, and both paths must converge.
                if let Some(rail) = state.pins.get_mut(&conv_id) {
                    if let Some(at) = rail.iter().position(|m| *m == id) {
                        rail.remove(at);
                        deltas.push(StateDelta::PinsChanged { conv_id });
                    }
                }
                deltas
            }
            None => Vec::new(),
        },

        ServerFrame::ReactionAdded {
            message_id,
            user_id,
            emoji,
            ..
        } => {
            let rows = state.reactions.entry(message_id.clone()).or_default();
            if rows
                .iter()
                .any(|r| r.user_id == user_id && r.emoji == emoji)
            {
                return Vec::new();
            }
            rows.push(ReactionRow {
                message_id: message_id.clone(),
                user_id,
                emoji,
            });
            vec![StateDelta::ReactionsChanged { message_id }]
        }

        ServerFrame::ReactionRemoved {
            message_id,
            user_id,
            emoji,
            ..
        } => {
            let Some(rows) = state.reactions.get_mut(&message_id) else {
                return Vec::new();
            };
            let before = rows.len();
            rows.retain(|r| !(r.user_id == user_id && r.emoji == emoji));
            if rows.len() == before {
                return Vec::new();
            }
            vec![StateDelta::ReactionsChanged { message_id }]
        }

        ServerFrame::PinAdded {
            conv_id,
            message_id,
            ..
        } => {
            let rail = state.pins.entry(conv_id.clone()).or_default();
            if rail.contains(&message_id) {
                return Vec::new();
            }
            rail.insert(0, message_id);
            vec![StateDelta::PinsChanged { conv_id }]
        }

        ServerFrame::PinRemoved {
            conv_id,
            message_id,
            ..
        } => {
            let Some(rail) = state.pins.get_mut(&conv_id) else {
                return Vec::new();
            };
            let before = rail.len();
            rail.retain(|m| *m != message_id);
            if rail.len() == before {
                return Vec::new();
            }
            vec![StateDelta::PinsChanged { conv_id }]
        }

        ServerFrame::ConversationCreated { conversation, .. } => {
            if state.conversations.iter().any(|c| c.id == conversation.id)
                || state.discoverable.iter().any(|c| c.id == conversation.id)
            {
                return Vec::new();
            }
            // Ours goes straight into membership; anyone else's `public_org`
            // channel is merely discoverable until we join it.
            let mine = state.me.as_deref() == Some(conversation.created_by.as_str());
            if mine || conversation.visibility == Visibility::Private {
                state.conversations.push(conversation);
            } else {
                state.discoverable.push(conversation);
            }
            vec![StateDelta::ConversationsChanged]
        }

        // Carries the whole conversation rather than a diff, so a replayed pair
        // converges whichever order it arrives in.
        ServerFrame::ConversationUpdated { conversation, .. } => {
            let mut touched = false;
            for list in [&mut state.conversations, &mut state.discoverable] {
                if let Some(slot) = list.iter_mut().find(|c| c.id == conversation.id) {
                    *slot = conversation.clone();
                    touched = true;
                }
            }
            if touched {
                vec![StateDelta::ConversationsChanged]
            } else {
                Vec::new()
            }
        }

        ServerFrame::MemberJoined {
            conv_id, user_id, ..
        } => {
            let mut deltas = vec![StateDelta::MemberChanged {
                conv_id: conv_id.clone(),
                user_id: user_id.clone(),
                change: MemberChange::Joined,
            }];
            // Somebody else joining changes no list of ours. Our own join moves
            // the channel across.
            if state.me.as_deref() == Some(user_id.as_str()) {
                if let Some(at) = state.discoverable.iter().position(|c| c.id == conv_id) {
                    let conv = state.discoverable.remove(at);
                    state.conversations.push(conv);
                    deltas.push(StateDelta::ConversationsChanged);
                }
            }
            deltas
        }

        ServerFrame::MemberLeft {
            conv_id, user_id, ..
        } => {
            let mut deltas = vec![StateDelta::MemberChanged {
                conv_id: conv_id.clone(),
                user_id: user_id.clone(),
                change: MemberChange::Left,
            }];
            // Delivered *before* the membership row goes, so our own departure
            // reaches us on a socket that is still in the audience.
            if state.me.as_deref() == Some(user_id.as_str()) {
                let before = state.conversations.len();
                state.conversations.retain(|c| c.id != conv_id);
                state.messages.remove(&conv_id);
                state.reads.remove(&conv_id);
                if state.conversations.len() != before {
                    deltas.push(StateDelta::ConversationsChanged);
                }
            }
            deltas
        }

        ServerFrame::MemberEvicted {
            conv_id, user_id, ..
        } => vec![StateDelta::MemberChanged {
            conv_id,
            user_id,
            change: MemberChange::Evicted,
        }],

        ServerFrame::ReadUpdated {
            conv_id,
            last_read_seq,
            unread,
            mentions,
        } => {
            state.reads.insert(
                conv_id.clone(),
                ReadState {
                    conv_id: conv_id.clone(),
                    last_read_seq,
                    unread,
                    mentions,
                },
            );
            vec![StateDelta::ReadsChanged { conv_id }]
        }

        // The whole set, so this is an assignment. A frame missed during a
        // reconnect is repaired by the next one rather than leaving a dot lit.
        ServerFrame::Presence { online } => {
            state.online = online;
            vec![StateDelta::Presence]
        }

        ServerFrame::Typing { conv_id, user_id } => {
            state
                .typing
                .entry(conv_id.clone())
                .or_default()
                .insert(user_id.clone(), now_ms);
            vec![StateDelta::Typing {
                conv_id,
                user_id,
                at_ms: now_ms,
            }]
        }

        ServerFrame::Error { error } => {
            let delta = StateDelta::Error {
                code: error.code.clone(),
                message: error.message.clone(),
            };
            state.last_error = Some(error);
            vec![delta]
        }

        // The server ships ahead of us; a frame we do not model is not an error.
        ServerFrame::Unknown => Vec::new(),
    }
}

/// The local id an optimistic row carries until its `ack` lands.
pub fn optimistic_id(client_msg_id: &str) -> String {
    format!("local_{client_msg_id}")
}

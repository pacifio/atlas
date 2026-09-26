//! Chat messages: the outward `org_send`, and the **Session Reference** a
//! message can carry.

use atlas_comms::wire::{SessionReference, ConversationKind, ReferencedSession, CHAT_ARTIFACT_REF_TITLE_MAX, CHAT_BODY_MAX_BYTES};
use chrono::DateTime;
use rmcp::model::{CallToolResult, JsonObject};
use serde_json::{json, Value};

use super::super::cloud::{Member, NewMessage, OrgConversation, TimelineQuery};
use super::super::resolve::{self, Resolution};
use super::super::OrgScope;
use super::mentions::named_mentions;
use super::{
    ambiguous, conversation_json, member_json, roster_name, string_in, strings_in, tool_error, tool_json, NamedSession,
    OrgTools,
};
use crate::commands::memory_server::Grant;

/// `org_send`'s arguments, read once for the call and for its approval card
/// alike, so the card's body is the body that is sent: strings trimmed,
/// blanks absent, blank mentions dropped.
pub(super) struct SendArgs<'a> {
    pub(super) to: Option<&'a str>,
    pub(super) body: Option<&'a str>,
    pub(super) mentions: Vec<String>,
    /// The recorded session the message references: an id, `"current"`, or
    /// a recorded-session link. Absent for a plain message — unlike the
    /// session tools, `org_send` never references the current session unasked.
    pub(super) session: Option<&'a str>,
    /// The Workspace a bare `session` id is in.
    pub(super) workspace: Option<&'a str>,
}

impl<'a> SendArgs<'a> {
    pub(super) fn of(arguments: Option<&'a JsonObject>) -> Self {
        Self {
            to: string_in(arguments, "to"),
            body: string_in(arguments, "body"),
            mentions: strings_in(arguments, "mention"),
            session: string_in(arguments, "session"),
            workspace: string_in(arguments, "workspace"),
        }
    }
}

/// What `org_send`'s `session` comes to: a **Session Reference** the message
/// carries — the card the reader clicks to open the recorded session on the
/// Timeline — or, when chat will not take one, the recorded session's
/// timeline link written into the body instead.
///
/// Chat takes a reference only to a Workspace visible to the whole
/// organisation: a channel is readable organisation-wide, so a card drawn from
/// a restricted Workspace would launder the restriction, and the server
/// refuses it — even to the Workspace's own members, and one such reference
/// refuses the whole message. So the sender asks first
/// ([`OrganisationCloud::referenceable_workspaces`]) rather than learning it
/// from a refusal chat's socket cannot tie back to this send.
///
/// Built once per call by [`OrgTools::session_reference`], for the call and
/// for its approval card alike, so the card shows the reference and the body
/// the call sends.
///
/// [`OrganisationCloud::referenceable_workspaces`]: super::super::cloud::OrganisationCloud::referenceable_workspaces
pub(super) enum MessageReference {
    /// Carried on the message as its reference card.
    Attached(ReferencedSession),
    /// The Workspace is not one a message may reference: no card, and the
    /// recorded session's timeline link is appended to the body.
    Linked { session_id: String, title: Option<String>, link: String },
}

impl MessageReference {
    /// The recorded session as a person names it: its title, else its id.
    fn name(&self) -> String {
        let (id, title) = match self {
            Self::Attached(r) => (&r.session_id, &r.session_title),
            Self::Linked { session_id, title, .. } => (session_id, title),
        };
        title.clone().unwrap_or_else(|| format!("recorded session {id}"))
    }

    /// The body as it goes out: as written for a reference card; with the
    /// timeline link after it, on its own line, where there is no card.
    pub(super) fn body(&self, written: &str) -> String {
        match self {
            Self::Attached(_) => written.to_string(),
            Self::Linked { link, .. } => format!("{written}\n\n{link}"),
        }
    }

    /// The references the message carries.
    fn refs(&self) -> Vec<SessionReference> {
        match self {
            Self::Attached(r) => vec![SessionReference::Session(r.clone())],
            Self::Linked { .. } => Vec::new(),
        }
    }

    /// The approval card's line about it.
    pub(super) fn card_line(&self) -> String {
        match self {
            Self::Attached(_) => format!("Session Reference: {}", self.name()),
            Self::Linked { .. } => format!(
                "No Session Reference: {} is in a restricted Workspace, so its timeline link is added to the message",
                self.name()
            ),
        }
    }

    /// What the tool's answer says about it.
    fn json(&self) -> Value {
        match self {
            Self::Attached(r) => json!({
                "attached": true,
                "session_id": r.session_id,
                "title": r.session_title,
            }),
            Self::Linked { session_id, title, link } => json!({
                "attached": false,
                "session_id": session_id,
                "title": title,
                "link": link,
                "note": "The recorded session's Workspace is not visible to the whole organisation, so chat would \
                         refuse a Session Reference to it; the message was sent without one, with the recorded \
                         session's timeline link appended to the body instead. Tell the user.",
            }),
        }
    }
}

/// A title as a reference carries it: within the contract's bound, which
/// counts UTF-16 units, cut with an ellipsis when it is longer. A card's
/// label, not the message — the body is never cut.
fn reference_title(title: Option<&str>) -> Option<String> {
    let title = title.map(str::trim).filter(|t| !t.is_empty())?;
    if title.encode_utf16().count() <= CHAT_ARTIFACT_REF_TITLE_MAX {
        return Some(title.to_string());
    }
    let mut cut = String::new();
    let mut units = 0;
    for c in title.chars() {
        units += c.len_utf16();
        if units > CHAT_ARTIFACT_REF_TITLE_MAX - 1 {
            break;
        }
        cut.push(c);
    }
    Some(format!("{}…", cut.trim_end()))
}

/// Where a message goes, found without writing anything: a conversation the
/// caller is in, or a member with whom the caller has no DM yet — which the
/// send creates first.
pub(super) enum Recipient {
    Conversation(OrgConversation),
    NewDm(Member),
}

/// Who a DM or group DM is with, by name where the roster has one, leaving
/// out the caller when they are known; by id where the roster cannot name
/// someone.
fn others(conversation: &OrgConversation, caller: Option<&str>, roster: Option<&[Member]>) -> Vec<String> {
    conversation
        .member_ids
        .iter()
        .flatten()
        .filter(|id| Some(id.as_str()) != caller)
        .map(|id| roster_name(roster, id).unwrap_or_else(|| id.clone()))
        .collect()
}

/// `a`, `a and b`, `a, b and c`.
fn listed(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [init @ .., last] => format!("{} and {last}", init.join(", ")),
    }
}

impl OrgTools {
    /// The conversation `to` names, or the member — whose DM it then is.
    /// A conversation is tried first (an id, or a channel's name); a name no
    /// conversation answers to is then looked for on the roster (an id, a
    /// name or an email), and that member's DM is the one the caller already
    /// has, or a new one. A channel the caller is not in is refused — they
    /// could join it, but posting is not joining — and more than one match
    /// comes back as candidates. Reads only; the roster it read, when it read
    /// one, comes back with it for naming mentions and people.
    pub(super) async fn recipient(
        &self,
        scope: &OrgScope,
        to: &str,
    ) -> Result<(Recipient, Option<Vec<Member>>), CallToolResult> {
        let conversations = self.cloud.conversations(&scope.org_id).await.map_err(|e| tool_error(e.to_string()))?;
        match resolve::conversation(&conversations, to) {
            Resolution::One(conversation) => {
                if !conversation.caller_is_member {
                    let named = conversation.name.as_deref().map_or_else(|| conversation.id.clone(), |n| format!("#{n}"));
                    return Err(tool_error(format!(
                        "you are not a member of {named}, so you cannot post in it; ask the user to join it first. \
                         Nothing was sent."
                    )));
                }
                Ok((Recipient::Conversation(conversation.clone()), None))
            }
            Resolution::Many(found) => Err(ambiguous(
                to,
                "conversations",
                found.into_iter().map(|c| conversation_json(c, None)).collect(),
            )),
            Resolution::None => {
                let roster = self.cloud.members(&scope.org_id).await.map_err(|e| tool_error(e.to_string()))?;
                let member = match resolve::member(&roster, to) {
                    Resolution::One(member) => member.clone(),
                    Resolution::Many(found) => {
                        return Err(ambiguous(to, "members", found.into_iter().map(member_json).collect()))
                    }
                    Resolution::None => {
                        return Err(tool_error(format!(
                            "nothing matches \"{to}\": no conversation by id or channel name, and no member by id, \
                             name or email; call org_conversations or org_members"
                        )))
                    }
                };
                // Their DM is the one DM they are in. Every DM holds the
                // caller, so a member in several is the caller themself —
                // left to the server, which answers the one it keeps.
                let dms: Vec<&OrgConversation> = conversations
                    .iter()
                    .filter(|c| c.kind == ConversationKind::Dm)
                    .filter(|c| c.member_ids.as_ref().is_some_and(|ids| ids.contains(&member.user_id)))
                    .collect();
                let recipient = match dms.as_slice() {
                    [dm] => Recipient::Conversation((*dm).clone()),
                    _ => Recipient::NewDm(member),
                };
                Ok((recipient, Some(roster)))
            }
        }
    }

    /// `org_send`: posts `body` as the caller into the conversation `to`
    /// names, or into the DM with the member it names — created first when
    /// there is none. An **outward action** (ADR-0014): projected to ask
    /// first, with the recipient and this exact body on the approval card, and
    /// checked in [`answer`](Self::answer) for the user's approval of this
    /// exact call, so a call the engine ran unasked (bypass) never gets here.
    ///
    /// With `session`, the message carries that recorded session's **Session
    /// Reference** ([`MessageReference`]) — or, where chat will not take one,
    /// its timeline link on the body's last line, and the answer says so.
    ///
    /// Everything that can refuse does so before anything is written — the
    /// recipient, a mention nobody or several members answer to, a recorded
    /// session that cannot be read, a body over chat's cap (counted with any
    /// appended link) — so a refused send creates no DM either. The body goes
    /// out exactly as the card showed it: never truncated, never split, nothing
    /// added but the link the card showed.
    pub(super) async fn send(&self, grant: &Grant, scope: &OrgScope, args: &SendArgs<'_>) -> CallToolResult {
        let Some(to) = args.to else {
            return tool_error(
                "say where to send it: `to` is a conversation's id or channel name, or a member's id, name or email",
            );
        };
        let Some(body) = args.body else {
            return tool_error("say what to send: `body` is the message's text");
        };
        let (recipient, roster) = match self.recipient(scope, to).await {
            Ok(found) => found,
            Err(answer) => return answer,
        };
        let mut roster = roster;
        let body = match self.post_body(&scope.org_id, body, &args.mentions, &mut roster).await {
            Ok(body) => body,
            Err(answer) => return answer,
        };
        let reference = match args.session {
            Some(session) => match self.session_reference(grant, scope, (Some(session), args.workspace)).await {
                Ok(reference) => Some(reference),
                Err(answer) => return answer,
            },
            None => None,
        };
        let body = reference.as_ref().map_or(body.clone(), |r| r.body(&body));
        let artifact_refs = reference.as_ref().map(MessageReference::refs).unwrap_or_default();
        // Chat's cap is UTF-8 bytes (the contract's `CHAT_BODY_MAX_BYTES`),
        // counted on the body as it will be posted.
        if body.len() > CHAT_BODY_MAX_BYTES {
            return tool_error(format!(
                "the message is {} bytes, over chat's cap of {CHAT_BODY_MAX_BYTES} bytes (UTF-8); shorten it or send \
                 it as several messages yourself. Nothing was sent.",
                body.len()
            ));
        }
        let (conversation, created_dm) = match recipient {
            Recipient::Conversation(conversation) => (conversation, false),
            Recipient::NewDm(member) => match self.cloud.dm_with(&scope.org_id, &member.user_id).await {
                Ok(opened) => opened,
                Err(e) => return tool_error(e.to_string()),
            },
        };
        let message = NewMessage {
            org_id: &scope.org_id,
            conversation_id: &conversation.id,
            body: &body,
            artifact_refs: &artifact_refs,
        };
        let sent = match self.cloud.send(message).await {
            Ok(sent) => sent,
            Err(e) => return tool_error(e.to_string()),
        };
        let roster = match roster {
            Some(roster) => Some(roster),
            None if conversation.member_ids.is_some() || body.contains("<@") => {
                self.cloud.members(&scope.org_id).await.ok()
            }
            None => None,
        };
        let mut answer = json!({
            "conversation": conversation_json(&conversation, roster.as_deref()),
            "message_id": sent.message_id,
            "client_msg_id": sent.client_msg_id,
            "created_dm": created_dm,
            "body": named_mentions(&body, roster.as_deref()),
        });
        if let Some(reference) = &reference {
            answer["session_reference"] = reference.json();
        }
        if sent.message_id.is_none() {
            answer["note"] = json!(
                "chat has not confirmed it yet; it is queued on chat's connection and resent until the server takes it"
            );
        }
        tool_json(answer)
    }

    /// The Session Reference `session` names ([`MessageReference`]): the
    /// recorded session [`session_target`](Self::session_target) finds — the
    /// current one, an id (in `workspace`, else the grant's Workspace) or a
    /// recorded-session link, in any Workspace of the grant's organisation — with its summary read for the card's figures, attached
    /// when chat lets a message reference its Workspace and linked otherwise.
    /// Reads only.
    pub(super) async fn session_reference(
        &self,
        grant: &Grant,
        scope: &OrgScope,
        session: NamedSession<'_>,
    ) -> Result<MessageReference, CallToolResult> {
        let target = self.session_target(grant, scope, session).await?;
        // One entry is the least page there is; the summary is what is read.
        let query = TimelineQuery {
            org_id: &scope.org_id,
            workspace_id: &target.workspace_id,
            session_id: &target.id,
            cursor: None,
            limit: Some(1),
        };
        let summary = self.cloud.timeline(query).await.map_err(|e| tool_error(e.to_string()))?.summary;
        let title = reference_title(summary.title.as_deref().or(target.title.as_deref()));
        let referenceable =
            self.cloud.referenceable_workspaces(&scope.org_id).await.map_err(|e| tool_error(e.to_string()))?;
        if !referenceable.contains(&target.workspace_id) {
            let link = atlas_artifacts::session_web_url(&scope.org_id, &target.workspace_id, &target.id);
            return Ok(MessageReference::Linked { session_id: target.id, title, link });
        }
        let count = |n: i64| u64::try_from(n).unwrap_or(0);
        Ok(MessageReference::Attached(ReferencedSession {
            workspace_ref_id: target.workspace_id,
            session_id: target.id,
            session_title: title,
            agent: summary.agent.filter(|a| !a.is_empty()).map(|a| a.chars().take(64).collect()),
            started_at: DateTime::parse_from_rfc3339(&summary.started_at).ok().map(|at| at.timestamp_millis()),
            messages: count(summary.message_count),
            tool_calls: count(summary.tool_call_count),
            checkpoints: count(summary.checkpoint_count),
        }))
    }

    /// The approval card's title and recipient line for a send to
    /// `recipient`, as a person reads them: "Send to #general" / "Message
    /// Grace Hopper".
    pub(super) fn send_card(
        recipient: &Recipient,
        caller: Option<&str>,
        roster: Option<&[Member]>,
    ) -> (String, String) {
        match recipient {
            Recipient::NewDm(member) => (
                format!("Message {}", member.name),
                format!("{} ({}), in a new DM with them", member.name, member.email),
            ),
            Recipient::Conversation(c) => match c.kind {
                ConversationKind::Channel => {
                    let name = c.name.as_deref().map_or_else(|| c.id.clone(), |n| format!("#{n}"));
                    (format!("Send to {name}"), format!("Everyone in {name}"))
                }
                ConversationKind::Dm => {
                    let who = listed(&others(c, caller, roster));
                    (format!("Message {who}"), format!("{who}, in your DM"))
                }
                ConversationKind::GroupDm => {
                    let who = listed(&others(c, caller, roster));
                    (format!("Message the group with {who}"), format!("Everyone in your group DM with {who}"))
                }
            },
        }
    }
}

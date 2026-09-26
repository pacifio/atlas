//! The **organisation cloud**: the one seam between the organisation tools and
//! everything remote.
//!
//! Every tool handler reaches the organisation through this trait and through
//! nothing else — no handler holds a client, mints a token or opens a store.
//! Production implements it over the clients Atlas already has
//! ([`AppOrganisationCloud`]); the tests implement it in memory, holding a
//! roster, a board of recorded sessions and their comments, so every fold,
//! cap, sentinel and refusal is tested through the tool surface the model
//! sees.
//!
//! Every method names the organisation it acts in explicitly, always the one
//! on the session's grant ([`OrgScope`]). An implementation never falls back
//! to whichever organisation the window is showing.
//!
//! Shaped to grow: each later tool adds the method it needs here (the roster,
//! conversations, the board, a recorded session's entries and an entry's
//! payload, replying on and resolving comments, the inbox, sending, creating a
//! DM, creating a Space page), its production half in the adapter and its
//! in-memory half in the tests' fake.
//!
//! [`AppOrganisationCloud`]: super::AppOrganisationCloud
//! [`OrgScope`]: super::OrgScope

use std::future::Future;
use std::pin::Pin;

use atlas_artifacts::{AnchorKind, Comment, EntryPayload, InboxPage, SessionBoardPage, SessionDetailPage};
use atlas_comms::wire::{SessionReference, ConversationKind};
use atlas_comms::CommsError;

use super::OrgScope;
use crate::auth::{AuthFailure, Role};

/// What every organisation cloud call returns: boxed, because the trait is
/// used as `dyn` and the handlers are async.
pub type CloudFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, CloudError>> + Send + 'a>>;

/// Why a remote operation failed, in words the model can relay. Distinct
/// kinds, because the model's next move differs: a signed-out user must sign
/// in, a refusal will not become an acceptance by retrying, and a network
/// blip might.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudError {
    /// No account is signed in, or the server no longer accepts its credential.
    SignedOut(String),
    /// The server refused this user (a 403).
    Forbidden(String),
    /// No such thing, or one this user may not see (the server answers 404
    /// for both).
    NotFound(String),
    /// The organisation could not be reached, or answered something unreadable.
    /// Worth trying again later.
    Unavailable(String),
    /// Chat is connected to another organisation than the one this session
    /// acts in (or to none). Chat has one socket, on the organisation the
    /// window chose for it; a chat tool never reaches past it into the grant's
    /// organisation, and never acts in chat's instead. Named both ways, so the
    /// model can tell the user which one to switch chat to.
    ChatElsewhere {
        /// The organisation on the session's grant.
        grant_org: String,
        /// The organisation chat is connected to, if any.
        chat_org: Option<String>,
    },
}

impl std::fmt::Display for CloudError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SignedOut(reason) => write!(f, "not signed in to Atlas ({reason}); ask the user to sign in"),
            Self::Forbidden(reason) => write!(f, "the organisation refused this ({reason})"),
            Self::NotFound(reason) => write!(f, "not found ({reason})"),
            Self::Unavailable(reason) => write!(f, "the organisation could not be reached ({reason}); try again later"),
            Self::ChatElsewhere { grant_org, chat_org: Some(chat_org) } => write!(
                f,
                "chat is connected to organisation {chat_org}, but this session acts in organisation {grant_org} \
                 (the one its project is bound to); ask the user to switch chat to {grant_org}"
            ),
            Self::ChatElsewhere { grant_org, chat_org: None } => write!(
                f,
                "chat is not connected to an organisation, and this session acts in organisation {grant_org}; \
                 ask the user to open chat in {grant_org}"
            ),
        }
    }
}

impl std::error::Error for CloudError {}

impl From<atlas_artifacts::Error> for CloudError {
    fn from(error: atlas_artifacts::Error) -> Self {
        use atlas_artifacts::Error as E;
        match error {
            E::Unauthorized(reason) => Self::SignedOut(reason),
            E::Forbidden(reason) => Self::Forbidden(reason),
            E::NotFound(reason) => Self::NotFound(reason),
            other => Self::Unavailable(other.to_string()),
        }
    }
}

impl From<AuthFailure> for CloudError {
    fn from(failure: AuthFailure) -> Self {
        match failure {
            AuthFailure::NoCredential => Self::SignedOut("no account is signed in".into()),
            AuthFailure::Rejected => Self::SignedOut("the server no longer accepts the sign-in".into()),
            AuthFailure::Denied => Self::Forbidden("this account may not read that".into()),
            AuthFailure::Indeterminate { reason, .. } => Self::Unavailable(reason),
        }
    }
}

impl From<CommsError> for CloudError {
    fn from(error: CommsError) -> Self {
        match error {
            CommsError::Token(reason) => Self::SignedOut(reason),
            CommsError::Unauthorized => Self::SignedOut("chat refused the sign-in".into()),
            CommsError::Forbidden => Self::Forbidden("not a member".into()),
            CommsError::NotFound => Self::NotFound("chat has no such thing".into()),
            CommsError::Refused { code, message, .. } => Self::Forbidden(format!("{code}: {message}")),
            other => Self::Unavailable(other.to_string()),
        }
    }
}

/// Who the agent is acting as: the signed-in user, as a member of the
/// organisation on the grant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    pub user_id: String,
    pub name: String,
    /// The member's role in this organisation, from the access token's
    /// organisation claim. `None` when the claim does not place the user in
    /// it, or names a role this build does not know. Mirrored only to explain
    /// and to omit; the server is the authority.
    pub role: Option<Role>,
    /// The organisation's display name, when the account knows it.
    pub organisation_name: Option<String>,
}

/// A running chat, as the recorded-session join needs it: the organisation it
/// acts in, the session id the agent was opened with, and the launch
/// directory whose Project records it.
#[derive(Debug, Clone, Copy)]
pub struct CurrentSessionQuery<'a> {
    pub scope: &'a OrgScope,
    pub native_session_id: &'a str,
    pub cwd: &'a str,
}

/// A recorded session in the Workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedSession {
    /// Its id on the server, which is also its captured row id here.
    pub id: String,
    /// The Workspace holding it.
    pub workspace_id: String,
    pub title: Option<String>,
    /// Whether its agent is still writing, as the server derives it.
    pub live: bool,
}

/// A member of the organisation, as the roster lists them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub user_id: String,
    pub name: String,
    pub email: String,
    /// `None` when the server named a role this build does not know.
    pub role: Option<Role>,
}

/// A chat conversation in the organisation, as the caller sees the list: the
/// ones they are in, and the channels they could join.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrgConversation {
    pub id: String,
    pub kind: ConversationKind,
    /// A channel's name; `None` for a DM or group DM.
    pub name: Option<String>,
    /// Who is in a DM or group DM; `None` for a channel, whose roster the
    /// server does not broadcast.
    pub member_ids: Option<Vec<String>>,
    /// Whether the caller is in it. A channel they are not in is one they can
    /// see and join, not one they can post to.
    pub caller_is_member: bool,
}

/// Which page of the caller's inbox to read.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct InboxQuery<'a> {
    /// Only the entries the user has not read.
    pub unread_only: bool,
    /// Where the previous page's `next_cursor` left off.
    pub cursor: Option<&'a str>,
    /// At most this many entries; the server's default when `None`.
    pub limit: Option<u32>,
}

/// Which page of the Workspace's board to read. The server narrows only by
/// Workspace and keyword; the author, date and liveness folds are the tool's,
/// over the pages this reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BoardQuery<'a> {
    /// The grant's Workspace — the board is never read organisation-wide here.
    pub workspace_id: &'a str,
    /// The server's keyword search, passed through as it was asked.
    pub q: Option<&'a str>,
    /// Where the previous page's `next_cursor` left off.
    pub cursor: Option<&'a str>,
}

/// Which page of a recorded session's timeline to read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimelineQuery<'a> {
    pub org_id: &'a str,
    pub workspace_id: &'a str,
    pub session_id: &'a str,
    /// Where the previous page's `next_cursor` left off.
    pub cursor: Option<&'a str>,
    /// At most this many entries; the server's maximum when `None`.
    pub limit: Option<u32>,
}

/// One entry's full text: which recorded session, which entry (its row id),
/// and which part of it (`body`, or a tool call's `arguments` / `result`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PayloadRef<'a> {
    pub org_id: &'a str,
    pub workspace_id: &'a str,
    pub session_id: &'a str,
    pub row_id: &'a str,
    pub part: &'a str,
}

/// One comment on a recorded session, addressed the way the server's routes
/// address it: the organisation, the Workspace, the recorded session, the
/// comment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommentRef<'a> {
    pub org_id: &'a str,
    pub workspace_id: &'a str,
    pub session_id: &'a str,
    pub comment_id: &'a str,
}

/// A reply about to be posted on a comment thread: under the thread's first
/// comment (the server keeps replies one level deep), on that comment's
/// anchor, as the caller. The body is exactly what will be stored, mentions
/// already written as `<@user-id>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NewReply<'a> {
    /// The thread's first comment, which the reply hangs off.
    pub root: CommentRef<'a>,
    /// The root's anchor, copied: a reply sits where its thread does.
    pub anchor_kind: AnchorKind,
    pub anchor_id: &'a str,
    pub body: &'a str,
}

/// A page about to be created at the root of a conversation's Space, as the
/// caller. The name is exactly what the page will be called: trimmed, never
/// empty, and within the contract's 200-unit bound.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NewPage<'a> {
    pub org_id: &'a str,
    /// The conversation whose Space holds the page — one the caller is in.
    pub conversation_id: &'a str,
    pub name: &'a str,
}

/// A chat message about to be sent into a conversation, as the caller. The
/// body is exactly what will be posted — mentions already written as
/// `<@user-id>`, a recorded session's link already appended where its
/// reference could not ride, within the contract's byte cap — and nothing is
/// added to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NewMessage<'a> {
    pub org_id: &'a str,
    /// The conversation it goes into — one the caller is in.
    pub conversation_id: &'a str,
    pub body: &'a str,
    /// The **Session References** it carries: recorded sessions in
    /// Workspaces chat said a message may reference
    /// ([`OrganisationCloud::referenceable_workspaces`]). Empty for a plain
    /// message.
    pub artifact_refs: &'a [SessionReference],
}

/// A chat message handed to chat's socket: the id this client gave it, and
/// the server's id for it once the server acknowledged it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentMessage {
    /// The id the send was written under; the server answers with it.
    pub client_msg_id: String,
    /// The server's id for the stored message, from its `ack`; `None` when no
    /// `ack` arrived in time — the message is then still queued on chat's
    /// socket, which resends it until the server takes it.
    pub message_id: Option<String>,
}

/// Everything the organisation tools do remotely.
///
/// **Nothing here marks the inbox read**, and nothing may be added that
/// does: the unread state is the user's (ADR-0014), so the tools have no
/// call path to the server's mark-read route at all.
pub trait OrganisationCloud: Send + Sync {
    /// The signed-in user as a member of `org_id`.
    fn caller<'a>(&'a self, org_id: &'a str) -> CloudFuture<'a, Caller>;

    /// The recorded session a running chat is written into — the **current**
    /// one — or `None` while it is not recorded in the Workspace yet (no
    /// prompt captured, or not synced to the server).
    fn current_session<'a>(&'a self, query: CurrentSessionQuery<'a>) -> CloudFuture<'a, Option<RecordedSession>>;

    /// The organisation's roster.
    fn members<'a>(&'a self, org_id: &'a str) -> CloudFuture<'a, Vec<Member>>;

    /// The chat conversations the caller is in, then the channels they could
    /// join. Refused with [`CloudError::ChatElsewhere`] while chat is not
    /// connected to `org_id`.
    fn conversations<'a>(&'a self, org_id: &'a str) -> CloudFuture<'a, Vec<OrgConversation>>;

    /// Every comment on a recorded session, roots and replies, oldest first.
    fn comments<'a>(&'a self, org_id: &'a str, workspace_id: &'a str, session_id: &'a str)
        -> CloudFuture<'a, Vec<Comment>>;

    /// Resolves (`resolved: true`) or unresolves a thread's root comment on a
    /// recorded session, as the caller, and answers the comment as the server
    /// now holds it (`resolved_at`/`resolved_by` set, or cleared). The server
    /// lets anyone who can read the Workspace do this, on roots only; the tool
    /// refuses a reply before it gets here.
    fn set_resolved<'a>(&'a self, comment: CommentRef<'a>, resolved: bool) -> CloudFuture<'a, Comment>;

    /// Posts a reply on a thread as the caller, and answers the comment as the
    /// server stored it. An **outward action** (ADR-0014): the server tells
    /// the thread's first author (unless that is the caller) and everyone the
    /// body mentions, so the tool that calls this is projected to ask first.
    fn reply<'a>(&'a self, reply: NewReply<'a>) -> CloudFuture<'a, Comment>;

    /// One page of the recorded sessions on `org_id`'s board, most recently
    /// active first, narrowed to one Workspace and, when asked, the server's
    /// keyword search.
    fn board_page<'a>(&'a self, org_id: &'a str, query: BoardQuery<'a>) -> CloudFuture<'a, SessionBoardPage>;

    /// One page of a recorded session's summary and entries, in the server's
    /// order, with the cursor to the next.
    fn timeline<'a>(&'a self, query: TimelineQuery<'a>) -> CloudFuture<'a, SessionDetailPage>;

    /// The full text behind one entry of a recorded session.
    fn entry_payload<'a>(&'a self, entry: PayloadRef<'a>) -> CloudFuture<'a, EntryPayload>;

    /// One page of the caller's inbox in `org_id` — mentions, replies and
    /// comments on their recorded sessions — with the unread total. Read-only.
    fn inbox<'a>(&'a self, org_id: &'a str, query: InboxQuery<'a>) -> CloudFuture<'a, InboxPage>;

    /// Creates a page at the root of a conversation's Space, as the caller,
    /// and answers its id. Not an outward action (ADR-0014): it reaches no
    /// one, everyone in the conversation can see and move or delete it, and
    /// the call is audited. Like every chat call, refused with
    /// [`CloudError::ChatElsewhere`] while chat is not connected to `org_id`.
    fn create_page<'a>(&'a self, page: NewPage<'a>) -> CloudFuture<'a, String>;

    /// The caller's DM with `user_id`, created when there is none, and
    /// whether it was just created (the server answers an existing DM rather
    /// than a second one). Refused with [`CloudError::ChatElsewhere`] while
    /// chat is not connected to `org_id`.
    fn dm_with<'a>(&'a self, org_id: &'a str, user_id: &'a str) -> CloudFuture<'a, (OrgConversation, bool)>;

    /// The Workspaces a chat message in `org_id` may reference, by id: the
    /// ones the organisation owns that are visible to all of it and not
    /// archived (chat's `GET /workspaces`). Chat refuses a message whose
    /// reference names any other — a restricted Workspace even to its own
    /// members, since a channel is readable organisation-wide — and one such
    /// reference refuses the whole message, so a sender asks this first.
    /// Refused with [`CloudError::ChatElsewhere`] while chat is not connected
    /// to `org_id`.
    fn referenceable_workspaces<'a>(&'a self, org_id: &'a str) -> CloudFuture<'a, Vec<String>>;

    /// Sends a chat message as the caller. An **outward action** (ADR-0014):
    /// everyone in the conversation sees it and everyone it mentions is told,
    /// so the tool that calls this is projected to ask first. Refused with
    /// [`CloudError::ChatElsewhere`] while chat is not connected to `org_id`.
    fn send<'a>(&'a self, message: NewMessage<'a>) -> CloudFuture<'a, SentMessage>;
}

//! The organisation tool server end to end over loopback with an rmcp client,
//! beside the memory and UI tool servers on their listener, against an
//! in-memory organisation; and the offer that hands it out.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use atlas_agent_servers::{SessionMcpOffer, SessionMcpRequest, SessionMcpServers};
use atlas_artifacts::{
    AnchorKind, Comment, EntryPayload, InboxEntry, InboxKind, InboxPage, RemoteEntry, RemoteEntryCounts, RemoteSession,
    SessionBoardPage, SessionDetailPage,
};
use atlas_comms::wire::{SessionReference, ConversationKind, ReferencedSession};
use parking_lot::Mutex;
use rmcp::model::CallToolRequestParams;
use rmcp::service::RunningService;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::{RoleClient, ServiceExt};
use serde_json::{json, Value};

use super::adapter::scope_of;
use super::tools::{
    tool_names, tools, tools_list, ACTIVITY_ROWS, INSTRUCTIONS, RECORDED_NOTE, NOT_RECORDED_YET, SESSIONS_DEFAULT_LIMIT, SESSIONS_DEFAULT_WINDOW_DAYS,
    SESSIONS_SCAN_CAP, TIMELINE_DEFAULT_LIMIT,
};
use super::*;
use crate::auth::Role;
use crate::commands::memory_server::{
    MemoryServer, MemoryServerHost, MemorySessionOffers, MemoryTokens, SessionClocks, SessionReads, SharingGate, Sources,
    TOOLS_LIST_TTL_MS,
};
use crate::commands::shared_memory::SharedMemoryStore;
use crate::commands::ui_server::{self, UiBridge, UiOffer, UI_SERVER_NAME};

// ── An organisation in memory ────────────────────────────────────────────────

/// The organisation cloud the tests run against: one caller, the roster, the
/// chat conversations and the organisation chat is connected to, the recorded
/// sessions the Workspace holds keyed by the chat's session id, and each
/// recorded session's comments. Records every organisation it was asked
/// about, so a test can show a call acted in the grant's.
#[derive(Default)]
struct FakeOrganisation {
    caller: Mutex<Option<Caller>>,
    roster: Mutex<Vec<Member>>,
    roster_fail: AtomicBool,
    conversations: Mutex<Vec<OrgConversation>>,
    /// The organisation chat's socket is on; `None` while chat is not
    /// connected.
    chat_org: Mutex<Option<String>>,
    /// Chat session id → the recorded session it is written into.
    recorded: Mutex<HashMap<String, RecordedSession>>,
    /// Recorded session id → its comments.
    comments: Mutex<HashMap<String, Vec<Comment>>>,
    comments_fail: AtomicBool,
    /// Resolving or unresolving a comment fails.
    resolve_fail: AtomicBool,
    /// Posting a reply fails.
    reply_fail: AtomicBool,
    /// Who the server told about each posted comment, as `(user, kind,
    /// comment)`, by its rule (`apps/ingest/src/workspace-do.ts`, `owedFor`):
    /// everyone the body mentions, then the thread's first author for a reply
    /// — one row per person, the first reason winning, and never the person
    /// who posted it.
    notified: Mutex<Vec<(String, &'static str, String)>>,
    /// The caller's inbox, in the order it was written (oldest first), each
    /// entry's read state as the user left it. There is no way to mark one
    /// read: the organisation cloud has no such method, so neither does this.
    inbox: Mutex<Vec<InboxEntry>>,
    /// The cursor the next inbox page continues from, when there is one.
    inbox_next: Mutex<Option<String>>,
    inbox_fail: AtomicBool,
    /// The Workspace's board: every recorded session, in any order (the fake
    /// orders it as the server does, most recently active first).
    board: Mutex<Vec<RemoteSession>>,
    board_fail: AtomicBool,
    /// The server refuses the board to this account (a 403).
    board_forbidden: AtomicBool,
    /// Recorded session id → its entries, in the server's order.
    timelines: Mutex<HashMap<String, Vec<RemoteEntry>>>,
    timeline_fail: AtomicBool,
    /// `(recorded session, entry, part)` → that part's full text.
    payloads: Mutex<HashMap<(String, String, String), EntryPayload>>,
    /// Every page created in a conversation's Space, as `(org, conversation,
    /// name, page id)`, in order.
    pages: Mutex<Vec<(String, String, String, String)>>,
    /// The Space refuses the page (a full Space, an archived conversation).
    page_fail: AtomicBool,
    /// Every chat message sent, as `(org, conversation, body)`, in order —
    /// the body exactly as it went out.
    sent: Mutex<Vec<(String, String, String)>>,
    /// The Session References each sent message carried, in the order sent.
    sent_refs: Mutex<Vec<Vec<SessionReference>>>,
    /// The Workspaces chat lets a message reference: visible to the whole
    /// organisation and not archived. A restricted Workspace is not here.
    referenceable: Mutex<Vec<String>>,
    /// Chat refuses the message.
    send_fail: AtomicBool,
    /// The server's `ack` never arrives in time.
    unacked: AtomicBool,
    /// Every `(org, what)` asked, in order.
    asked: Mutex<Vec<(String, String)>>,
}

impl FakeOrganisation {
    fn with_member(name: &str, role: Option<Role>) -> Arc<Self> {
        let org = Arc::new(Self::default());
        *org.caller.lock() = Some(Caller {
            user_id: "u-1".into(),
            name: name.into(),
            role,
            organisation_name: Some("Acme".into()),
        });
        *org.chat_org.lock() = Some("org-acme".into());
        org
    }

    fn with_roster(self: Arc<Self>, roster: Vec<Member>) -> Arc<Self> {
        *self.roster.lock() = roster;
        self
    }

    fn with_conversations(self: Arc<Self>, conversations: Vec<OrgConversation>) -> Arc<Self> {
        *self.conversations.lock() = conversations;
        self
    }

    fn record(&self, chat_session: &str, session: RecordedSession) {
        self.recorded.lock().insert(chat_session.into(), session);
    }

    fn comment_on(&self, session: &str, comment: Comment) {
        self.comments.lock().entry(session.into()).or_default().push(comment);
    }

    fn asked(&self) -> Vec<(String, String)> {
        self.asked.lock().clone()
    }

    fn with_inbox(self: Arc<Self>, inbox: Vec<InboxEntry>) -> Arc<Self> {
        *self.inbox.lock() = inbox;
        self
    }

    fn with_board(self: Arc<Self>, board: Vec<RemoteSession>) -> Arc<Self> {
        *self.board.lock() = board;
        self
    }

    /// How many board pages were read.
    fn board_reads(&self) -> usize {
        self.asked().iter().filter(|(_, what)| what.starts_with("board")).count()
    }
}

/// The fake board's page size — the server's largest, as the adapter asks.
const FAKE_BOARD_PAGE: usize = 100;

impl OrganisationCloud for FakeOrganisation {
    fn caller<'a>(&'a self, org_id: &'a str) -> CloudFuture<'a, Caller> {
        Box::pin(async move {
            self.asked.lock().push((org_id.into(), "caller".into()));
            self.caller.lock().clone().ok_or_else(|| CloudError::SignedOut("no account is signed in".into()))
        })
    }

    fn current_session<'a>(&'a self, query: CurrentSessionQuery<'a>) -> CloudFuture<'a, Option<RecordedSession>> {
        Box::pin(async move {
            self.asked.lock().push((
                query.scope.org_id.clone(),
                format!("current {} in {}", query.native_session_id, query.cwd),
            ));
            Ok(self
                .recorded
                .lock()
                .get(query.native_session_id)
                .filter(|s| query.scope.workspace_id.as_deref() == Some(s.workspace_id.as_str()))
                .cloned())
        })
    }

    fn members<'a>(&'a self, org_id: &'a str) -> CloudFuture<'a, Vec<Member>> {
        Box::pin(async move {
            self.asked.lock().push((org_id.into(), "members".into()));
            if self.roster_fail.load(Ordering::SeqCst) {
                return Err(CloudError::Unavailable("connection reset".into()));
            }
            Ok(self.roster.lock().clone())
        })
    }

    fn conversations<'a>(&'a self, org_id: &'a str) -> CloudFuture<'a, Vec<OrgConversation>> {
        Box::pin(async move {
            self.asked.lock().push((org_id.into(), "conversations".into()));
            let chat_org = self.chat_org.lock().clone();
            if chat_org.as_deref() != Some(org_id) {
                return Err(CloudError::ChatElsewhere { grant_org: org_id.into(), chat_org });
            }
            Ok(self.conversations.lock().clone())
        })
    }

    fn comments<'a>(&'a self, org_id: &'a str, workspace_id: &'a str, session_id: &'a str) -> CloudFuture<'a, Vec<Comment>> {
        Box::pin(async move {
            self.asked.lock().push((org_id.into(), format!("comments {workspace_id}/{session_id}")));
            if self.comments_fail.load(Ordering::SeqCst) {
                return Err(CloudError::Unavailable("connection reset".into()));
            }
            Ok(self.comments.lock().get(session_id).cloned().unwrap_or_default())
        })
    }

    /// As the server does: sets `resolved_at`/`resolved_by` (the caller) or
    /// clears both, and answers the comment as it now is. The server refuses
    /// a reply; so does this, so a test can show the tool never sent one.
    fn set_resolved<'a>(&'a self, at: CommentRef<'a>, resolved: bool) -> CloudFuture<'a, Comment> {
        Box::pin(async move {
            self.asked.lock().push((
                at.org_id.into(),
                format!("resolve {}/{}/{} resolved={resolved}", at.workspace_id, at.session_id, at.comment_id),
            ));
            if self.resolve_fail.load(Ordering::SeqCst) {
                return Err(CloudError::Unavailable("connection reset".into()));
            }
            let by = self.caller.lock().as_ref().map(|c| c.user_id.clone());
            let mut sessions = self.comments.lock();
            let comment = sessions
                .get_mut(at.session_id)
                .and_then(|list| list.iter_mut().find(|c| c.id == at.comment_id))
                .ok_or_else(|| CloudError::NotFound("comment".into()))?;
            if !comment.is_root() {
                return Err(CloudError::Forbidden("only a root can be resolved".into()));
            }
            comment.resolved_at = resolved.then(|| "2026-09-26T12:00:00Z".to_string());
            comment.resolved_by = if resolved { by } else { None };
            Ok(comment.clone())
        })
    }

    /// As the server does: a reply hangs off a root (a reply to a reply is
    /// refused), is written as the caller with the mentions its body names,
    /// and owes notifications by the server's rule (see `notified`).
    fn reply<'a>(&'a self, reply: NewReply<'a>) -> CloudFuture<'a, Comment> {
        Box::pin(async move {
            let at = reply.root;
            self.asked.lock().push((
                at.org_id.into(),
                format!("reply {}/{}/{}", at.workspace_id, at.session_id, at.comment_id),
            ));
            if self.reply_fail.load(Ordering::SeqCst) {
                return Err(CloudError::Unavailable("connection reset".into()));
            }
            let caller = self.caller.lock().as_ref().map(|c| c.user_id.clone()).unwrap_or_default();
            let mut sessions = self.comments.lock();
            let list = sessions.get_mut(at.session_id).ok_or_else(|| CloudError::NotFound("session".into()))?;
            let root = list
                .iter()
                .find(|c| c.id == at.comment_id)
                .ok_or_else(|| CloudError::NotFound("comment".into()))?;
            if !root.is_root() {
                return Err(CloudError::Forbidden("a reply hangs off a root comment; replies are one level deep".into()));
            }
            let root_author = root.author_id.clone();
            let mentions: Vec<String> = reply
                .body
                .split("<@")
                .skip(1)
                .filter_map(|rest| rest.split_once('>').map(|(id, _)| id.to_string()))
                .filter(|id| *id != caller)
                .collect();
            let posted = Comment {
                id: format!("r{}", list.len() + 1),
                session_id: at.session_id.into(),
                anchor_kind: reply.anchor_kind,
                anchor_id: reply.anchor_id.into(),
                parent_id: Some(at.comment_id.into()),
                author_id: caller.clone(),
                guest_name: None,
                body: Some(reply.body.into()),
                mentions: mentions.clone(),
                created_at: "2026-09-26T12:30:00Z".into(),
                edited_at: None,
                deleted_at: None,
                resolved_at: None,
                resolved_by: None,
            };
            list.push(posted.clone());
            let mut owed: Vec<(String, &'static str)> =
                mentions.into_iter().map(|user| (user, "artifact_mention")).collect();
            if root_author != caller {
                owed.push((root_author, "artifact_reply"));
            }
            let mut notified = self.notified.lock();
            for (user, kind) in owed {
                if !notified.iter().any(|(u, _, c)| *u == user && *c == posted.id) {
                    notified.push((user, kind, posted.id.clone()));
                }
            }
            Ok(posted)
        })
    }

    fn inbox<'a>(&'a self, org_id: &'a str, query: InboxQuery<'a>) -> CloudFuture<'a, InboxPage> {
        Box::pin(async move {
            self.asked.lock().push((
                org_id.into(),
                format!("inbox unread_only={} cursor={:?} limit={:?}", query.unread_only, query.cursor, query.limit),
            ));
            if self.inbox_fail.load(Ordering::SeqCst) {
                return Err(CloudError::Unavailable("connection reset".into()));
            }
            Ok(self.inbox_page(org_id, query.unread_only, query.limit))
        })
    }

    /// As the server does: one Workspace, most recently active first, the
    /// keyword matched against titles (the fake's stand-in for the server's
    /// search), a page at a time with an offset cursor. No author, date or
    /// liveness filter, because the server has none.
    fn board_page<'a>(&'a self, org_id: &'a str, query: BoardQuery<'a>) -> CloudFuture<'a, SessionBoardPage> {
        Box::pin(async move {
            self.asked.lock().push((
                org_id.into(),
                format!("board {} q={:?} cursor={:?}", query.workspace_id, query.q, query.cursor),
            ));
            if self.board_fail.load(Ordering::SeqCst) {
                return Err(CloudError::Unavailable("connection reset".into()));
            }
            if self.board_forbidden.load(Ordering::SeqCst) {
                return Err(CloudError::Forbidden("403 forbidden".into()));
            }
            let mut rows: Vec<RemoteSession> = self
                .board
                .lock()
                .iter()
                .filter(|s| s.workspace_id == query.workspace_id)
                .filter(|s| {
                    query.q.is_none_or(|q| {
                        s.title.as_deref().is_some_and(|t| t.to_lowercase().contains(&q.to_lowercase()))
                    })
                })
                .cloned()
                .collect();
            rows.sort_by(|a, b| (&b.last_activity_at, &b.id).cmp(&(&a.last_activity_at, &a.id)));
            let start: usize = query.cursor.map_or(0, |c| c.parse().unwrap());
            let end = (start + FAKE_BOARD_PAGE).min(rows.len());
            Ok(SessionBoardPage {
                sessions: rows[start.min(end)..end].to_vec(),
                next_cursor: (end < rows.len()).then(|| end.to_string()),
                ..SessionBoardPage::default()
            })
        })
    }

    fn timeline<'a>(&'a self, query: TimelineQuery<'a>) -> CloudFuture<'a, SessionDetailPage> {
        Box::pin(async move {
            self.asked.lock().push((
                query.org_id.into(),
                format!(
                    "timeline {}/{} cursor={:?} limit={:?}",
                    query.workspace_id, query.session_id, query.cursor, query.limit
                ),
            ));
            if self.timeline_fail.load(Ordering::SeqCst) {
                return Err(CloudError::Unavailable("connection reset".into()));
            }
            let summary = self
                .board
                .lock()
                .iter()
                .find(|s| s.id == query.session_id && s.workspace_id == query.workspace_id)
                .cloned()
                .ok_or_else(|| CloudError::NotFound("session".into()))?;
            let entries = self.timelines.lock().get(query.session_id).cloned().unwrap_or_default();
            let start: usize = query.cursor.map_or(0, |c| c.parse().unwrap());
            let end = (start + query.limit.unwrap_or(500) as usize).min(entries.len());
            Ok(SessionDetailPage {
                summary,
                counts: RemoteEntryCounts { prompts: 1, responses: 1, tool_calls: 1, checkpoints: 1, ..Default::default() },
                entries: entries[start.min(end)..end].to_vec(),
                next_cursor: (end < entries.len()).then(|| end.to_string()),
                ..SessionDetailPage::default()
            })
        })
    }

    /// As the Space does: a page at the root with the name given, answered by
    /// its new id — reached, as the adapter's is, only while chat is on the
    /// organisation asked about.
    fn create_page<'a>(&'a self, page: NewPage<'a>) -> CloudFuture<'a, String> {
        Box::pin(async move {
            self.asked.lock().push((page.org_id.into(), format!("page_create {} {}", page.conversation_id, page.name)));
            let chat_org = self.chat_org.lock().clone();
            if chat_org.as_deref() != Some(page.org_id) {
                return Err(CloudError::ChatElsewhere { grant_org: page.org_id.into(), chat_org });
            }
            if self.page_fail.load(Ordering::SeqCst) {
                return Err(CloudError::Forbidden("quota_exceeded: A Space holds at most 200 pages and folders.".into()));
            }
            let mut pages = self.pages.lock();
            let id = format!("page-{}", pages.len() + 1);
            pages.push((page.org_id.into(), page.conversation_id.into(), page.name.into(), id.clone()));
            Ok(id)
        })
    }

    /// As `POST /conversations {kind: "dm"}` does: the DM with `user_id` when
    /// there is one, else a new one holding the caller and them — reached,
    /// like every chat call, only while chat is on the organisation asked.
    fn dm_with<'a>(&'a self, org_id: &'a str, user_id: &'a str) -> CloudFuture<'a, (OrgConversation, bool)> {
        Box::pin(async move {
            self.asked.lock().push((org_id.into(), format!("dm {user_id}")));
            let chat_org = self.chat_org.lock().clone();
            if chat_org.as_deref() != Some(org_id) {
                return Err(CloudError::ChatElsewhere { grant_org: org_id.into(), chat_org });
            }
            let mut conversations = self.conversations.lock();
            let existing = conversations.iter().find(|c| {
                c.kind == ConversationKind::Dm && c.member_ids.as_ref().is_some_and(|ids| ids.iter().any(|id| id == user_id))
            });
            if let Some(dm) = existing {
                return Ok((dm.clone(), false));
            }
            let dm = conversation(&format!("c-dm-{user_id}"), ConversationKind::Dm, None, Some(&["u-1", user_id]), true);
            conversations.push(dm.clone());
            Ok((dm, true))
        })
    }

    /// As chat's socket does: the message stored as sent, acknowledged with
    /// the server's id — unless the test holds the ack back.
    fn send<'a>(&'a self, message: NewMessage<'a>) -> CloudFuture<'a, SentMessage> {
        Box::pin(async move {
            self.asked.lock().push((message.org_id.into(), format!("send {}", message.conversation_id)));
            let chat_org = self.chat_org.lock().clone();
            if chat_org.as_deref() != Some(message.org_id) {
                return Err(CloudError::ChatElsewhere { grant_org: message.org_id.into(), chat_org });
            }
            if self.send_fail.load(Ordering::SeqCst) {
                return Err(CloudError::Forbidden("not_member: You are not a member of this conversation.".into()));
            }
            // As chat does: one reference to a Workspace it will not let a
            // message reference refuses the whole message.
            let referenceable = self.referenceable.lock().clone();
            if let Some(bad) = message.artifact_refs.iter().find(|r| !referenceable.iter().any(|w| w == r.workspace_ref_id())) {
                return Err(CloudError::Forbidden(format!("forbidden: reference refused ({})", bad.workspace_ref_id())));
            }
            self.sent_refs.lock().push(message.artifact_refs.to_vec());
            let mut sent = self.sent.lock();
            sent.push((message.org_id.into(), message.conversation_id.into(), message.body.into()));
            let n = sent.len();
            let message_id = (!self.unacked.load(Ordering::SeqCst)).then(|| format!("m-{n}"));
            Ok(SentMessage { client_msg_id: format!("cm-{n}"), message_id })
        })
    }

    fn referenceable_workspaces<'a>(&'a self, org_id: &'a str) -> CloudFuture<'a, Vec<String>> {
        Box::pin(async move {
            self.asked.lock().push((org_id.into(), "workspaces".into()));
            let chat_org = self.chat_org.lock().clone();
            if chat_org.as_deref() != Some(org_id) {
                return Err(CloudError::ChatElsewhere { grant_org: org_id.into(), chat_org });
            }
            Ok(self.referenceable.lock().clone())
        })
    }

    fn entry_payload<'a>(&'a self, entry: PayloadRef<'a>) -> CloudFuture<'a, EntryPayload> {
        Box::pin(async move {
            self.asked.lock().push((
                entry.org_id.into(),
                format!("payload {}/{}/{} part={}", entry.workspace_id, entry.session_id, entry.row_id, entry.part),
            ));
            self.payloads
                .lock()
                .get(&(entry.session_id.to_string(), entry.row_id.to_string(), entry.part.to_string()))
                .cloned()
                .ok_or_else(|| CloudError::NotFound("entry".into()))
        })
    }
}

impl FakeOrganisation {
    /// The inbox as the server answers it: the organisation's entries, unread
    /// only when asked, the newest `limit` of them, with the unread **total**
    /// — but in the order they were written, because the tool, not the fake,
    /// is what puts the newest first.
    fn inbox_page(&self, org_id: &str, unread_only: bool, limit: Option<u32>) -> InboxPage {
        let all = self.inbox.lock().clone();
        let mine: Vec<InboxEntry> = all.into_iter().filter(|e| e.org_id == org_id).collect();
        let unread = mine.iter().filter(|e| e.is_unread()).count() as u64;
        let mut entries: Vec<InboxEntry> = mine.into_iter().filter(|e| !unread_only || e.is_unread()).collect();
        if let Some(limit) = limit {
            entries.drain(..entries.len().saturating_sub(limit as usize));
        }
        InboxPage { entries, unread, next_cursor: self.inbox_next.lock().clone() }
    }
}

fn comment(id: &str, parent: Option<&str>) -> Comment {
    Comment {
        id: id.into(),
        session_id: "rs-1".into(),
        anchor_kind: AnchorKind::Session,
        anchor_id: String::new(),
        parent_id: parent.map(Into::into),
        author_id: "u-2".into(),
        guest_name: None,
        body: Some("please rename this".into()),
        mentions: Vec::new(),
        created_at: "2026-09-26T10:00:00Z".into(),
        edited_at: None,
        deleted_at: None,
        resolved_at: None,
        resolved_by: None,
    }
}

fn member(user_id: &str, name: &str, email: &str, role: Option<Role>) -> Member {
    Member { user_id: user_id.into(), name: name.into(), email: email.into(), role }
}

/// Ada, two members both called Sam Lee, and Grace.
fn acme_roster() -> Vec<Member> {
    vec![
        member("u-1", "Ada Lovelace", "ada@acme.dev", Some(Role::Developer)),
        member("u-sam1", "Sam Lee", "sam.lee@acme.dev", Some(Role::Admin)),
        member("u-sam2", "Sam Lee", "slee@acme.dev", Some(Role::ProductOwner)),
        member("u-grace", "Grace Hopper", "grace@acme.dev", None),
    ]
}

fn conversation(id: &str, kind: ConversationKind, name: Option<&str>, members: Option<&[&str]>, joined: bool) -> OrgConversation {
    OrgConversation {
        id: id.into(),
        kind,
        name: name.map(Into::into),
        member_ids: members.map(|ids| ids.iter().map(|s| s.to_string()).collect()),
        caller_is_member: joined,
    }
}

/// #general (joined), a DM with Grace, a group DM, #Design and #design (the
/// second not joined).
fn acme_conversations() -> Vec<OrgConversation> {
    use ConversationKind::*;
    vec![
        conversation("c-general", Channel, Some("general"), None, true),
        conversation("c-dm-grace", Dm, None, Some(&["u-1", "u-grace"]), true),
        conversation("c-group", GroupDm, None, Some(&["u-1", "u-sam1", "u-ghost"]), true),
        conversation("c-design", Channel, Some("Design"), None, true),
        conversation("c-design-web", Channel, Some("design"), None, false),
    ]
}

fn acme() -> OrgScope {
    OrgScope { org_id: "org-acme".into(), workspace_id: Some("ws-atlas".into()) }
}

fn current(live: bool) -> RecordedSession {
    RecordedSession {
        id: "rs-1".into(),
        workspace_id: "ws-atlas".into(),
        title: Some("Fix the theme importer".into()),
        live,
    }
}

// ── Serving it ───────────────────────────────────────────────────────────────

fn memory() -> SharedMemoryStore {
    let t = Arc::new(AtomicI64::new(1_000));
    SharedMemoryStore::with_clock(Arc::new(move || t.fetch_add(1_000, Ordering::SeqCst)))
}

fn sharing(on: bool) -> SharingGate {
    Arc::new(move |_| on)
}

fn setting(on: bool) -> OrgAccessGate {
    Arc::new(move || on)
}

/// A setting the test can flip while a session runs.
fn switchable(on: bool) -> (OrgAccessGate, Arc<AtomicBool>) {
    let flag = Arc::new(AtomicBool::new(on));
    let read = flag.clone();
    (Arc::new(move || read.load(Ordering::SeqCst)), flag)
}

/// A window that is never asked anything in these tests.
fn quiet_ui() -> axum::Router {
    let bridge = Arc::new(UiBridge::new(Arc::new(|_| Err("no window".into()))));
    ui_server::router(ui_server::UiTools::new(bridge, Arc::new(|| true)))
}

async fn serve(tokens: Arc<MemoryTokens>, cloud: Arc<dyn OrganisationCloud>, gate: OrgAccessGate) -> MemoryServer {
    serve_tools(tokens, OrgTools::new(cloud, gate, bound_to_acme())).await
}

async fn serve_tools(tokens: Arc<MemoryTokens>, tools: OrgTools) -> MemoryServer {
    MemoryServer::start_with(
        memory(),
        tokens,
        Arc::new(SessionClocks::default()),
        Arc::new(SessionReads::default()),
        sharing(true),
        Sources::default(),
        vec![quiet_ui(), router(tools)],
    )
    .await
    .unwrap()
}

/// Signed in, with the Project bound to Acme's Workspace — what every grant
/// the tests mint was offered under, read again on each call.
fn bound_to_acme() -> Arc<FakeSessionOrgs> {
    FakeSessionOrgs::new(true, Some(acme()))
}

/// The user approved this call on its card (or it is covered by "Allow for
/// this session"): the record the native seam leaves through the host for
/// chat `s1`. Returns the arguments, for the call to send.
fn approved(consent: &atlas_agent_servers::OutwardConsent, arguments: Value) -> Value {
    approved_for(consent, "org_comment_reply", arguments)
}

/// [`approved`], for the outward `tool`.
fn approved_for(consent: &atlas_agent_servers::OutwardConsent, tool: &str, arguments: Value) -> Value {
    let session = acp::SessionId::new("s1");
    consent.record(atlas_agent_servers::CallToApprove {
        session_id: &session,
        server: ORG_SERVER_NAME,
        tool,
        arguments: &arguments,
    });
    arguments
}

/// A token as an offer mints one: carrying the organisation, bound to the
/// chat's session id once the agent answers.
fn offered_token(tokens: &MemoryTokens, session: &str, cwd: &str, scope: Option<OrgScope>) -> String {
    let token = tokens.mint_unbound("atlas-agent", cwd, scope);
    tokens.bind(&token, session);
    token
}

async fn connect(url: &str, token: &str) -> Result<RunningService<RoleClient, ()>, String> {
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url.to_string()).auth_header(token.to_string()),
    );
    ().serve(transport).await.map_err(|e| format!("{e:?}"))
}

async fn call(client: &RunningService<RoleClient, ()>, name: &'static str, args: Value) -> (bool, String) {
    let Value::Object(args) = args else { panic!("object args") };
    let result = client
        .call_tool(CallToolRequestParams::new(name).with_arguments(args))
        .await
        .expect("the tool call completes");
    let text = result
        .content
        .iter()
        .find_map(|c| c.as_text().map(|t| t.text.clone()))
        .unwrap_or_default();
    (result.is_error.unwrap_or(false), text)
}

/// A tool call's JSON answer, and whether it was an error.
async fn call_json(client: &RunningService<RoleClient, ()>, name: &'static str, args: Value) -> (bool, Value) {
    let (err, text) = call(client, name, args).await;
    let value = serde_json::from_str(&text).unwrap_or(Value::String(text));
    (err, value)
}

async fn whoami(client: &RunningService<RoleClient, ()>) -> Value {
    let (err, text) = call(client, "org_whoami", json!({})).await;
    assert!(!err, "{text}");
    serde_json::from_str(&text).expect("org_whoami answers JSON")
}

// ── org_whoami ───────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn org_whoami_reads_the_caller_the_organisation_the_workspace_and_the_current_session() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer));
    org.record("s1", current(true));
    org.comment_on("rs-1", comment("c1", None));
    org.comment_on("rs-1", comment("c2", None));
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(tokens.clone(), org.clone(), setting(true)).await;
    let token = offered_token(&tokens, "s1", "/p", Some(acme()));
    let client = connect(&server.url_at(ORG_PATH), &token).await.expect("a live token connects");

    assert_eq!(
        whoami(&client).await,
        json!({
            "caller": { "user_id": "u-1", "name": "Ada Lovelace", "role": "developer" },
            "organisation": { "id": "org-acme", "name": "Acme" },
            "workspace": { "id": "ws-atlas" },
            "current_session": {
                "id": "rs-1",
                "title": "Fix the theme importer",
                "live": true,
                "unresolved_comments": 2
            }
        }),
    );
    assert_eq!(
        org.asked(),
        [
            ("org-acme".to_string(), "caller".to_string()),
            ("org-acme".to_string(), "current s1 in /p".to_string()),
            ("org-acme".to_string(), "comments ws-atlas/rs-1".to_string()),
        ],
        "every call acts in the grant's organisation, for this chat's session and launch directory",
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_chat_the_workspace_has_not_recorded_yet_has_no_current_session_and_says_why() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Admin));
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(tokens.clone(), org.clone(), setting(true)).await;
    let client = connect(&server.url_at(ORG_PATH), &offered_token(&tokens, "s1", "/p", Some(acme())))
        .await
        .unwrap();

    let answer = whoami(&client).await;
    assert_eq!(answer["current_session"], Value::Null);
    assert_eq!(answer["current_session_reason"], json!(NOT_RECORDED_YET));
    assert_eq!(answer["caller"]["role"], json!("admin"));
    assert!(
        !org.asked().iter().any(|(_, what)| what.starts_with("comments")),
        "no comment read for a session that is not there",
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_unresolved_count_is_open_roots_only() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None);
    org.record("s1", current(false));
    org.comment_on("rs-1", comment("open", None));
    org.comment_on("rs-1", comment("reply", Some("open")));
    let mut resolved = comment("resolved", None);
    resolved.resolved_at = Some("2026-09-26T11:00:00Z".into());
    org.comment_on("rs-1", resolved);
    let mut deleted = comment("deleted", None);
    deleted.deleted_at = Some("2026-09-26T11:00:00Z".into());
    org.comment_on("rs-1", deleted);
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(tokens.clone(), org, setting(true)).await;
    let client = connect(&server.url_at(ORG_PATH), &offered_token(&tokens, "s1", "/p", Some(acme())))
        .await
        .unwrap();

    let answer = whoami(&client).await;
    assert_eq!(answer["current_session"]["unresolved_comments"], json!(1));
    assert_eq!(answer["current_session"]["live"], json!(false));
    assert_eq!(answer["caller"]["role"], Value::Null, "a role the token does not state is unknown, not guessed");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_comment_read_leaves_the_count_unknown_but_still_answers() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Member));
    org.record("s1", current(true));
    org.comments_fail.store(true, Ordering::SeqCst);
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(tokens.clone(), org, setting(true)).await;
    let client = connect(&server.url_at(ORG_PATH), &offered_token(&tokens, "s1", "/p", Some(acme())))
        .await
        .unwrap();

    let answer = whoami(&client).await;
    assert_eq!(answer["current_session"]["id"], json!("rs-1"));
    assert_eq!(answer["current_session"]["unresolved_comments"], Value::Null);
    assert!(answer["current_session"]["comments_error"].as_str().unwrap().contains("connection reset"));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_signed_out_user_is_a_tool_error_the_model_can_read() {
    let org = Arc::new(FakeOrganisation::default());
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(tokens.clone(), org, setting(true)).await;
    let client = connect(&server.url_at(ORG_PATH), &offered_token(&tokens, "s1", "/p", Some(acme())))
        .await
        .unwrap();
    let (err, text) = call(&client, "org_whoami", json!({})).await;
    assert!(err);
    assert!(text.contains("sign in"), "{text}");
    client.cancel().await.ok();
}

// ── org_members ──────────────────────────────────────────────────────────────

/// A connected client on an offered token, against `org`.
async fn org_client(org: Arc<FakeOrganisation>) -> (MemoryServer, RunningService<RoleClient, ()>) {
    let (server, client, _) = consenting_client(org).await;
    (server, client)
}

/// [`org_client`], with the store the tools check for the user's approval of
/// an outward call.
async fn consenting_client(
    org: Arc<FakeOrganisation>,
) -> (MemoryServer, RunningService<RoleClient, ()>, Arc<atlas_agent_servers::OutwardConsent>) {
    let tokens = Arc::new(MemoryTokens::default());
    let tools = OrgTools::new(org, setting(true), bound_to_acme());
    let consent = tools.consent().clone();
    let server = serve_tools(tokens.clone(), tools).await;
    let client = connect(&server.url_at(ORG_PATH), &offered_token(&tokens, "s1", "/p", Some(acme())))
        .await
        .unwrap();
    (server, client, consent)
}

#[tokio::test(flavor = "multi_thread")]
async fn org_members_lists_the_roster_with_ids_names_emails_and_roles() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer)).with_roster(acme_roster());
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_members", json!({})).await;
    assert!(!err, "{answer}");
    assert_eq!(
        answer,
        json!({ "members": [
            { "user_id": "u-1", "name": "Ada Lovelace", "email": "ada@acme.dev", "role": "developer" },
            { "user_id": "u-sam1", "name": "Sam Lee", "email": "sam.lee@acme.dev", "role": "admin" },
            { "user_id": "u-sam2", "name": "Sam Lee", "email": "slee@acme.dev", "role": "product_owner" },
            { "user_id": "u-grace", "name": "Grace Hopper", "email": "grace@acme.dev", "role": null },
        ]}),
    );
    assert_eq!(org.asked(), [("org-acme".to_string(), "members".to_string())], "the grant's organisation's roster");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_member_named_exactly_resolves_to_that_one_member() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_roster(acme_roster());
    let (_server, client) = org_client(org).await;
    let (err, answer) = call_json(&client, "org_members", json!({ "name": "Grace Hopper" })).await;
    assert!(!err, "{answer}");
    assert_eq!(
        answer,
        json!({ "member": { "user_id": "u-grace", "name": "Grace Hopper", "email": "grace@acme.dev", "role": null } }),
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_member_named_in_another_case_or_by_email_resolves_to_the_one_member() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_roster(acme_roster());
    let (_server, client) = org_client(org).await;
    for name in ["@grace hopper", "SLEE@acme.dev", "u-sam1"] {
        let (err, answer) = call_json(&client, "org_members", json!({ "name": name })).await;
        assert!(!err, "{name}: {answer}");
        let expected = match name {
            "@grace hopper" => "u-grace",
            "SLEE@acme.dev" => "u-sam2",
            _ => "u-sam1",
        };
        assert_eq!(answer["member"]["user_id"], json!(expected), "{name}");
    }
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_member_name_matching_nobody_is_an_error_naming_what_was_looked_for() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_roster(acme_roster());
    let (_server, client) = org_client(org).await;
    let (err, answer) = call_json(&client, "org_members", json!({ "name": "Ada" })).await;
    assert!(err, "a first name is not a match");
    let text = answer.as_str().unwrap();
    assert!(text.contains("no member matches \"Ada\""), "{text}");
    assert!(text.contains("org_members"), "{text}");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_member_name_matching_several_returns_every_candidate_with_its_id_to_ask_about() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_roster(acme_roster());
    let (_server, client) = org_client(org).await;
    let (err, answer) = call_json(&client, "org_members", json!({ "name": "sam lee" })).await;
    assert!(err, "several matches are not an answer");
    assert_eq!(
        answer,
        json!({
            "error": "\"sam lee\" matches 2 members; ask the user which one",
            "candidates": [
                { "user_id": "u-sam1", "name": "Sam Lee", "email": "sam.lee@acme.dev", "role": "admin" },
                { "user_id": "u-sam2", "name": "Sam Lee", "email": "slee@acme.dev", "role": "product_owner" },
            ],
        }),
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_roster_that_cannot_be_read_is_a_tool_error() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_roster(acme_roster());
    org.roster_fail.store(true, Ordering::SeqCst);
    let (_server, client) = org_client(org).await;
    let (err, text) = call(&client, "org_members", json!({})).await;
    assert!(err);
    assert!(text.contains("connection reset"), "{text}");
    client.cancel().await.ok();
}

// ── org_conversations ────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn org_conversations_lists_channels_dms_and_group_dms_with_kinds_and_membership() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None)
        .with_roster(acme_roster())
        .with_conversations(acme_conversations());
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_conversations", json!({})).await;
    assert!(!err, "{answer}");
    assert_eq!(
        answer,
        json!({ "conversations": [
            { "id": "c-general", "kind": "channel", "name": "general", "caller_is_member": true },
            { "id": "c-dm-grace", "kind": "dm", "name": null, "caller_is_member": true, "members": [
                { "user_id": "u-1", "name": "Ada Lovelace" },
                { "user_id": "u-grace", "name": "Grace Hopper" },
            ]},
            { "id": "c-group", "kind": "group_dm", "name": null, "caller_is_member": true, "members": [
                { "user_id": "u-1", "name": "Ada Lovelace" },
                { "user_id": "u-sam1", "name": "Sam Lee" },
                { "user_id": "u-ghost", "name": null },
            ]},
            { "id": "c-design", "kind": "channel", "name": "Design", "caller_is_member": true },
            { "id": "c-design-web", "kind": "channel", "name": "design", "caller_is_member": false },
        ]}),
    );
    assert_eq!(
        org.asked(),
        [
            ("org-acme".to_string(), "conversations".to_string()),
            ("org-acme".to_string(), "members".to_string()),
        ],
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dm_keeps_its_member_ids_when_the_roster_cannot_be_read() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    org.roster_fail.store(true, Ordering::SeqCst);
    let (_server, client) = org_client(org).await;
    let (err, answer) = call_json(&client, "org_conversations", json!({})).await;
    assert!(!err, "{answer}");
    assert_eq!(
        answer["conversations"][1]["members"],
        json!([{ "user_id": "u-1", "name": null }, { "user_id": "u-grace", "name": null }]),
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_channel_named_with_its_hash_or_in_another_case_resolves_to_the_one_conversation() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None)
        .with_roster(acme_roster())
        .with_conversations(acme_conversations());
    let (_server, client) = org_client(org.clone()).await;
    for (name, id) in [("#general", "c-general"), ("GENERAL", "c-general"), ("design", "c-design-web"), ("c-dm-grace", "c-dm-grace")] {
        let (err, answer) = call_json(&client, "org_conversations", json!({ "name": name })).await;
        assert!(!err, "{name}: {answer}");
        assert_eq!(answer["conversation"]["id"], json!(id), "{name}");
    }
    let (_, answer) = call_json(&client, "org_conversations", json!({ "name": "#general" })).await;
    assert_eq!(
        answer,
        json!({ "conversation": { "id": "c-general", "kind": "channel", "name": "general", "caller_is_member": true } }),
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_conversation_name_matching_nothing_is_an_error() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    let (_server, client) = org_client(org).await;
    let (err, answer) = call_json(&client, "org_conversations", json!({ "name": "#random" })).await;
    assert!(err);
    let text = answer.as_str().unwrap();
    assert!(text.contains("no conversation matches \"#random\""), "{text}");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_conversation_name_matching_several_returns_every_candidate_with_its_id_to_ask_about() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    let (_server, client) = org_client(org).await;
    let (err, answer) = call_json(&client, "org_conversations", json!({ "name": "#DESIGN" })).await;
    assert!(err);
    assert_eq!(
        answer,
        json!({
            "error": "\"#DESIGN\" matches 2 conversations; ask the user which one",
            "candidates": [
                { "id": "c-design", "kind": "channel", "name": "Design", "caller_is_member": true },
                { "id": "c-design-web", "kind": "channel", "name": "design", "caller_is_member": false },
            ],
        }),
    );
    client.cancel().await.ok();
}

/// Chat has one socket, on the organisation the window chose for it. A
/// session bound to another organisation does not read that one's chat as
/// if it were its own, and is told which two differ.
#[tokio::test(flavor = "multi_thread")]
async fn org_conversations_refuses_while_chat_is_on_another_organisation_and_names_both() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    *org.chat_org.lock() = Some("org-globex".into());
    let (_server, client) = org_client(org.clone()).await;
    let (err, text) = call(&client, "org_conversations", json!({})).await;
    assert!(err);
    assert!(text.contains("org-globex") && text.contains("org-acme"), "{text}");

    *org.chat_org.lock() = None;
    let (err, text) = call(&client, "org_conversations", json!({})).await;
    assert!(err);
    assert!(text.contains("not connected") && text.contains("org-acme"), "{text}");
    client.cancel().await.ok();
}

// ── org_page_create ──────────────────────────────────────────────────────────

/// Every page the fake's Spaces hold, as `(conversation, name)`.
fn pages_created(org: &FakeOrganisation) -> Vec<(String, String)> {
    org.pages.lock().iter().map(|(_, conv, name, _)| (conv.clone(), name.clone())).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn org_page_create_creates_a_root_page_in_the_named_conversations_space_and_answers_its_id() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) =
        call_json(&client, "org_page_create", json!({ "conversation": "#general", "name": "Architecture" })).await;
    assert!(!err, "{answer}");
    assert_eq!(
        answer,
        json!({
            "page_id": "page-1",
            "conversation": { "id": "c-general", "kind": "channel", "name": "general", "caller_is_member": true },
            "name": "Architecture",
        }),
    );
    assert_eq!(org.pages.lock()[0], ("org-acme".into(), "c-general".into(), "Architecture".into(), "page-1".into()));
    assert_eq!(
        org.asked(),
        [
            ("org-acme".to_string(), "conversations".to_string()),
            ("org-acme".to_string(), "page_create c-general Architecture".to_string()),
        ],
        "resolved against the grant's organisation's conversations, created there, and nothing else asked",
    );
    client.cancel().await.ok();
}

/// Auto-approved (ADR-0014): creating a page reaches no one, so the call
/// runs with no approval recorded — unlike a reply, which is refused without one.
#[tokio::test(flavor = "multi_thread")]
async fn org_page_create_is_auto_approved_and_needs_no_recorded_consent() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, text) = call(&client, "org_page_create", json!({ "conversation": "c-general", "name": "Notes" })).await;
    assert!(!err, "{text}");
    assert!(!consent.take("s1", ORG_SERVER_NAME, "org_page_create", &json!({ "conversation": "c-general", "name": "Notes" })));
    assert_eq!(pages_created(&org), [("c-general".to_string(), "Notes".to_string())]);
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dm_named_by_id_gets_the_page_and_the_answer_names_who_is_in_it() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None)
        .with_roster(acme_roster())
        .with_conversations(acme_conversations());
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) =
        call_json(&client, "org_page_create", json!({ "conversation": "c-dm-grace", "name": "  Plan  " })).await;
    assert!(!err, "{answer}");
    assert_eq!(answer["name"], json!("Plan"), "the name as created, trimmed");
    assert_eq!(
        answer["conversation"]["members"],
        json!([{ "user_id": "u-1", "name": "Ada Lovelace" }, { "user_id": "u-grace", "name": "Grace Hopper" }]),
    );
    assert_eq!(pages_created(&org), [("c-dm-grace".to_string(), "Plan".to_string())]);
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_conversation_the_caller_is_not_in_is_refused_and_no_page_is_created() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    let (_server, client) = org_client(org.clone()).await;
    let (err, text) =
        call(&client, "org_page_create", json!({ "conversation": "c-design-web", "name": "Architecture" })).await;
    assert!(err);
    assert!(text.contains("not a member of #design"), "{text}");
    assert!(pages_created(&org).is_empty());
    assert!(!org.asked().iter().any(|(_, what)| what.starts_with("page_create")), "the Space was never asked");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_conversation_name_matching_several_is_candidates_and_no_page_is_created() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_page_create", json!({ "conversation": "#DESIGN", "name": "X" })).await;
    assert!(err);
    assert_eq!(answer["candidates"].as_array().map(Vec::len), Some(2), "{answer}");
    let (err, text) = call(&client, "org_page_create", json!({ "conversation": "#random", "name": "X" })).await;
    assert!(err);
    assert!(text.contains("no conversation matches \"#random\""), "{text}");
    assert!(pages_created(&org).is_empty());
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn org_page_create_refuses_while_chat_is_on_another_organisation() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    *org.chat_org.lock() = Some("org-globex".into());
    let (_server, client) = org_client(org.clone()).await;
    let (err, text) = call(&client, "org_page_create", json!({ "conversation": "#general", "name": "X" })).await;
    assert!(err);
    assert!(text.contains("org-globex") && text.contains("org-acme"), "{text}");
    assert!(pages_created(&org).is_empty());
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_blank_or_overlong_name_or_conversation_is_refused_before_anything_is_asked() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    let (_server, client) = org_client(org.clone()).await;
    let too_long = "x".repeat(201);
    for (args, says) in [
        (json!({ "name": "X" }), "`conversation`"),
        (json!({ "conversation": "#general" }), "`name`"),
        (json!({ "conversation": "#general", "name": "   " }), "`name`"),
        (json!({ "conversation": "#general", "name": too_long }), "200 characters"),
    ] {
        let (err, text) = call(&client, "org_page_create", args.clone()).await;
        assert!(err, "{args}");
        assert!(text.contains(says), "{args}: {text}");
    }
    assert!(org.asked().is_empty(), "{:?}", org.asked());
    let exactly = "x".repeat(200);
    let (err, text) = call(&client, "org_page_create", json!({ "conversation": "#general", "name": exactly })).await;
    assert!(!err, "{text}");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_page_the_space_refuses_is_a_tool_error_with_its_reason() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    org.page_fail.store(true, Ordering::SeqCst);
    let (_server, client) = org_client(org.clone()).await;
    let (err, text) = call(&client, "org_page_create", json!({ "conversation": "#general", "name": "X" })).await;
    assert!(err);
    assert!(text.contains("200 pages"), "{text}");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_created_page_is_one_audit_record_naming_the_conversation_and_the_page() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    let tokens = Arc::new(MemoryTokens::default());
    let (server, records) = serve_audited(tokens.clone(), org, setting(true)).await;
    let client = connect(&server.url_at(ORG_PATH), &offered_token(&tokens, "s1", "/p", Some(acme())))
        .await
        .unwrap();
    let args = json!({ "conversation": "#general", "name": "Architecture" });
    let (_, answer) = call(&client, "org_page_create", args.clone()).await;
    let records = records.lock();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].tool, "org_page_create");
    assert_eq!(records[0].arguments, args);
    assert!(records[0].ok);
    assert_eq!(records[0].text, answer);
    let answered: Value = serde_json::from_str(&records[0].text).unwrap();
    assert_eq!(answered["conversation"]["name"], json!("general"));
    assert_eq!(answered["page_id"], json!("page-1"));
    drop(records);
    client.cancel().await.ok();
}

// ── org_page_write ───────────────────────────────────────────────────────────

/// The window the page-write tests draw through: every request it is sent is
/// recorded, and answered from another task by `answer` — as the webview
/// answers through `ui_action_respond`.
fn drawing_window(
    answer: impl Fn(&ui_server::UiRequest) -> ui_server::UiReply + Send + Sync + 'static,
) -> (Arc<UiBridge>, Arc<Mutex<Vec<ui_server::UiRequest>>>) {
    let asked = Arc::new(Mutex::new(Vec::new()));
    let slot: Arc<std::sync::OnceLock<Arc<UiBridge>>> = Arc::new(std::sync::OnceLock::new());
    let (log, window) = (asked.clone(), slot.clone());
    let answer = Arc::new(answer);
    let bridge = Arc::new(UiBridge::new(Arc::new(move |request: &ui_server::UiRequest| {
        log.lock().push(request.clone());
        let (window, answer, request) = (window.clone(), answer.clone(), request.clone());
        tokio::spawn(async move {
            let bridge = window.get().expect("bridge installed").clone();
            bridge.respond(request.request_id, answer(&request));
        });
        Ok(())
    })));
    let _ = slot.set(bridge.clone());
    (bridge, asked)
}

/// A window that draws whatever it is sent and says so, as the frontend does.
fn obliging_window() -> (Arc<UiBridge>, Arc<Mutex<Vec<ui_server::UiRequest>>>) {
    drawing_window(|request| {
        let document = &request.args["document"];
        ui_server::UiReply {
            ok: true,
            result: Some(json!({
                "page_id": request.args["page_id"],
                "name": "Architecture",
                "nodes_placed": document["nodes"].as_array().map_or(0, Vec::len),
                "edges_placed": document["edges"].as_array().map_or(0, Vec::len),
            })),
            error: None,
        }
    })
}

/// A connected client whose organisation tools draw through `window`.
async fn drawing_client(
    org: Arc<FakeOrganisation>,
    window: Option<Arc<UiBridge>>,
) -> (MemoryServer, RunningService<RoleClient, ()>) {
    let tokens = Arc::new(MemoryTokens::default());
    let mut tools = OrgTools::new(org, setting(true), bound_to_acme());
    if let Some(window) = window {
        tools = tools.with_window(window);
    }
    let server = serve_tools(tokens.clone(), tools).await;
    let client = connect(&server.url_at(ORG_PATH), &offered_token(&tokens, "s1", "/p", Some(acme())))
        .await
        .unwrap();
    (server, client)
}

/// Three boxes in a row, the middle one a diamond inside a group.
fn pipeline() -> Value {
    json!({
        "nodes": [
            { "id": "ingest", "kind": "shape", "text": "Ingest" },
            { "id": "core", "kind": "group", "text": "Core" },
            { "id": "check", "kind": "shape", "shape": "Diamond", "text": "Valid?", "parent": "core" },
            { "id": "store", "kind": "note", "text": "Store\nPostgres", "x": 800, "y": 40, "w": 240, "h": 160 }
        ],
        "edges": [
            { "from": "ingest", "to": "check", "label": "events" },
            { "from": "check", "to": "store", "from_anchor": "E", "to_anchor": "w" }
        ]
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn org_page_write_sends_the_checked_document_to_the_window_and_answers_what_it_placed() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    let (window, asked) = obliging_window();
    let (_server, client) = drawing_client(org.clone(), Some(window)).await;
    let (err, answer) = call_json(
        &client,
        "org_page_write",
        json!({ "page": "page-1", "conversation": "#general", "document": pipeline() }),
    )
    .await;
    assert!(!err, "{answer}");
    assert_eq!(
        answer,
        json!({ "page_id": "page-1", "name": "Architecture", "nodes_placed": 4, "edges_placed": 2 }),
        "the window's answer, verbatim",
    );
    let request = {
        let asked = asked.lock();
        assert_eq!(asked.len(), 1, "one crossing");
        asked[0].clone()
    };
    let request = &request;
    assert_eq!((request.tool.as_str(), request.session_id.as_str(), request.cwd.as_str()), ("org_page_write", "s1", "/p"));
    assert_eq!(
        request.args,
        json!({
            "org_id": "org-acme",
            "conversation_id": "c-general",
            "page_id": "page-1",
            "document": {
                "nodes": [
                    { "id": "ingest", "kind": "shape", "text": "Ingest", "shape": "rectangle" },
                    { "id": "core", "kind": "group", "text": "Core" },
                    { "id": "check", "kind": "shape", "text": "Valid?", "shape": "diamond", "parent": "core" },
                    { "id": "store", "kind": "note", "text": "Store\nPostgres", "x": 800.0, "y": 40.0, "w": 240.0, "h": 160.0 }
                ],
                "edges": [
                    { "from": "ingest", "to": "check", "label": "events" },
                    { "from": "check", "to": "store", "from_anchor": "e", "to_anchor": "w" }
                ]
            }
        }),
        "the conversation resolved to its id in the grant's organisation, a shape's default and the casing settled",
    );
    assert_eq!(ui_server::action_event(request), ORG_WINDOW_ACTION_EVENT, "on the organisation's window event");
    assert!(pages_created(&org).is_empty(), "a write creates nothing");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_document_the_page_cannot_hold_is_refused_in_words_before_the_window_or_the_organisation_is_asked() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    let (window, asked) = obliging_window();
    let (_server, client) = drawing_client(org.clone(), Some(window)).await;
    let node = |id: &str, kind: &str| json!({ "id": id, "kind": kind });
    let too_many: Vec<Value> = (0..201).map(|i| node(&format!("n{i}"), "note")).collect();
    let cases = [
        (json!(null), "give the `document`"),
        (json!({ "nodes": [] }), "no nodes"),
        (json!({ "nodes": [node("a", "box")] }), "`kind` \"box\" is not one of note, text, shape, group"),
        (json!({ "nodes": [node("a", "media")] }), "media nodes cannot be drawn"),
        (json!({ "nodes": [{ "kind": "note" }] }), "node 1 has no `id`"),
        (json!({ "nodes": [node("a", "note"), node("a", "text")] }), "two nodes have the id `a`"),
        (json!({ "nodes": [node("a", "note")], "edges": [{ "from": "a", "to": "ghost" }] }), "`to` names node `ghost`, which the document does not have"),
        (json!({ "nodes": [node("a", "note")], "edges": [{ "from": "a", "to": "a" }] }), "joins a node to itself"),
        (json!({ "nodes": [node("a", "note"), node("b", "note")], "edges": [{ "from": "a", "to": "b", "to_anchor": "up" }] }), "`to_anchor` \"up\" is not one of n, e, s, w"),
        (json!({ "nodes": [node("a", "note"), { "id": "b", "kind": "text", "parent": "a" }] }), "`parent` names `a`, a note; only a group can hold other nodes"),
        (json!({ "nodes": [{ "id": "b", "kind": "text", "parent": "g" }] }), "`parent` names `g`, which the document does not have"),
        (json!({ "nodes": [{ "id": "g1", "kind": "group", "parent": "g2" }, { "id": "g2", "kind": "group", "parent": "g1" }] }), "inside itself"),
        (json!({ "nodes": [{ "id": "a", "kind": "note", "shape": "ellipse" }] }), "`shape` is only for kind shape"),
        (json!({ "nodes": [{ "id": "a", "kind": "note", "x": 10 }] }), "give both `x` and `y`"),
        (json!({ "nodes": [{ "id": "a", "kind": "note", "w": 5 }] }), "`w` is between 40 and 10000"),
        (json!({ "nodes": [{ "id": "a", "kind": "note", "text": "x".repeat(2_001) }] }), "at most 2000 characters, and is 2001"),
        (json!({ "nodes": too_many }), "201 nodes; at most 200"),
    ];
    for (document, says) in cases {
        let (err, text) = call(
            &client,
            "org_page_write",
            json!({ "page": "page-1", "conversation": "#general", "document": document.clone() }),
        )
        .await;
        assert!(err, "{document} is refused");
        assert!(text.contains(says), "{document}: {text}");
        assert!(text.contains("Nothing was drawn"), "{text}");
    }
    let (err, text) = call(
        &client,
        "org_page_write",
        json!({ "page": "atlas-org://conversation/c-general", "conversation": "#general", "document": pipeline() }),
    )
    .await;
    assert!(err && text.contains("is not a page id"), "{text}");
    assert!(asked.lock().is_empty(), "the window was never asked");
    assert!(org.asked().is_empty(), "nor the organisation");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_conversation_the_caller_is_not_in_is_refused_and_the_window_is_not_asked() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    let (window, asked) = obliging_window();
    let (_server, client) = drawing_client(org, Some(window)).await;
    let (err, text) = call(
        &client,
        "org_page_write",
        json!({ "page": "page-1", "conversation": "c-design-web", "document": pipeline() }),
    )
    .await;
    assert!(err, "{text}");
    assert!(text.contains("not a member of #design") && text.contains("Nothing was drawn"), "{text}");
    assert!(asked.lock().is_empty());
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_write_the_window_refuses_is_a_tool_error_in_the_windows_words() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    let (window, _) = drawing_window(|_| ui_server::UiReply {
        ok: false,
        result: None,
        error: Some("the page is read-only: its conversation is archived. Nothing was drawn.".into()),
    });
    let (_server, client) = drawing_client(org, Some(window)).await;
    let (err, text) = call(
        &client,
        "org_page_write",
        json!({ "page": "page-1", "conversation": "#general", "document": pipeline() }),
    )
    .await;
    assert!(err);
    assert_eq!(text, "the page is read-only: its conversation is archived. Nothing was drawn.");
    client.cancel().await.ok();
}

/// A window that never answers ends the call with an error once the bridge's
/// timeout passes — never a hung turn.
#[tokio::test(flavor = "multi_thread")]
async fn a_window_that_never_answers_is_a_tool_error_not_a_hung_turn() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    let silent = Arc::new(UiBridge::with_timeout(Arc::new(|_| Ok(())), std::time::Duration::from_millis(100)));
    let (_server, client) = drawing_client(org, Some(silent)).await;
    let started = std::time::Instant::now();
    let (err, text) = call(
        &client,
        "org_page_write",
        json!({ "page": "page-1", "conversation": "#general", "document": pipeline() }),
    )
    .await;
    assert!(err, "{text}");
    assert!(text.contains("did not answer"), "{text}");
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "bounded by the bridge's timeout");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_window_the_write_is_refused_in_words() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    let (_server, client) = drawing_client(org, None).await;
    let (err, text) = call(
        &client,
        "org_page_write",
        json!({ "page": "page-1", "conversation": "#general", "document": pipeline() }),
    )
    .await;
    assert!(err && text.contains("window is not available"), "{text}");
    client.cancel().await.ok();
}

/// Auto-approved (ADR-0014): drawing on a page reaches no one, so it runs
/// with no approval recorded, and is audited as one record like any call.
#[tokio::test(flavor = "multi_thread")]
async fn org_page_write_is_auto_approved_and_is_one_audit_record() {
    assert!(!OUTWARD_TOOLS.contains(&"org_page_write"));
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    let (window, _) = obliging_window();
    let tokens = Arc::new(MemoryTokens::default());
    let records = Arc::new(Mutex::new(Vec::new()));
    let sink = records.clone();
    let tools = OrgTools::new(org, setting(true), bound_to_acme())
        .with_window(window)
        .with_audit(Arc::new(move |record: &OrgActionRecord| sink.lock().push(record.clone())));
    let server = serve_tools(tokens.clone(), tools).await;
    let client = connect(&server.url_at(ORG_PATH), &offered_token(&tokens, "s1", "/p", Some(acme())))
        .await
        .unwrap();
    let args = json!({ "page": "page-1", "conversation": "#general", "document": pipeline() });
    let (err, answer) = call(&client, "org_page_write", args.clone()).await;
    assert!(!err, "{answer}");
    {
        let records = records.lock();
        assert_eq!(records.len(), 1);
        assert_eq!((records[0].tool.as_str(), records[0].ok), ("org_page_write", true));
        assert_eq!(records[0].arguments, args);
        assert_eq!(records[0].text, answer);
    }
    client.cancel().await.ok();
}

#[test]
fn every_window_tool_is_offered_and_crosses_on_the_organisations_event_while_ui_actions_keep_theirs() {
    let request = |tool: &str| ui_server::UiRequest {
        request_id: uuid::Uuid::new_v4(),
        session_id: "s1".into(),
        agent: "atlas-agent".into(),
        cwd: "/p".into(),
        tool: tool.into(),
        args: json!({}),
    };
    let offered: Vec<String> = tools().into_iter().map(|t| t.name.to_string()).collect();
    for tool in WINDOW_TOOLS {
        assert!(offered.contains(&tool.to_string()), "{tool} is a tool");
        assert_eq!(ui_server::action_event(&request(tool)), ORG_WINDOW_ACTION_EVENT);
    }
    assert_eq!(ui_server::action_event(&request("ui_state")), ui_server::UI_ACTION_EVENT);
    assert_eq!(ui_server::action_event(&request("org_page_create")), ui_server::UI_ACTION_EVENT, "never emitted anyway");
}

// ── org_inbox ────────────────────────────────────────────────────────────────

/// An inbox entry in the grant's organisation, on recorded session `rs-1`.
fn inbox_entry(id: &str, kind: InboxKind, actor: &str, at: &str, read: bool) -> InboxEntry {
    InboxEntry {
        id: id.into(),
        kind,
        org_id: "org-acme".into(),
        workspace_id: "ws-atlas".into(),
        workspace_slug: "atlas".into(),
        session_id: "rs-1".into(),
        session_title: Some("Fix the theme importer".into()),
        comment_id: format!("c-{id}"),
        anchor_kind: AnchorKind::Session,
        anchor_id: String::new(),
        actor_id: actor.into(),
        actor_name: None,
        excerpt: format!("remark {id}"),
        created_at: at.into(),
        read_at: read.then(|| "2026-09-26T12:00:00.000Z".to_string()),
        path: format!("/timeline?org=org-acme&workspace=ws-atlas&session=rs-1&comment=c-{id}"),
    }
}

/// Written oldest first, the way the fake keeps them: a read reply from Sam,
/// an unread mention from Grace on a checkpoint, and an unread comment on the
/// user's session from a guest reviewer; plus one entry in another
/// organisation that must never be read here.
fn acme_inbox() -> Vec<InboxEntry> {
    let reply = inbox_entry("n1", InboxKind::Reply, "u-sam1", "2026-09-24T09:00:00.000Z", true);
    let mut mention = inbox_entry("n2", InboxKind::Mention, "u-grace", "2026-09-25T09:00:00.000Z", false);
    mention.anchor_kind = AnchorKind::Checkpoint;
    mention.anchor_id = "cp-7".into();
    let mut guest = inbox_entry("n3", InboxKind::SessionComment, "g-rev", "2026-09-26T09:00:00.000Z", false);
    guest.actor_name = Some("Outside Reviewer".into());
    let mut elsewhere = inbox_entry("n9", InboxKind::Mention, "u-x", "2026-09-26T10:00:00.000Z", false);
    elsewhere.org_id = "org-globex".into();
    vec![reply, mention, guest, elsewhere]
}

#[tokio::test(flavor = "multi_thread")]
async fn org_inbox_lists_entries_newest_first_with_kind_unread_author_session_and_comment() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_roster(acme_roster()).with_inbox(acme_inbox());
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_inbox", json!({})).await;
    assert!(!err, "{answer}");
    let session = json!({ "id": "rs-1", "title": "Fix the theme importer", "workspace_id": "ws-atlas" });
    assert_eq!(
        answer,
        json!({
            "unread": 2,
            "entries": [
                {
                    "id": "n3",
                    "kind": "comment_on_your_session",
                    "unread": true,
                    "created_at": "2026-09-26T09:00:00.000Z",
                    "author": { "user_id": "g-rev", "name": "Outside Reviewer", "guest": true },
                    "session": session,
                    "comment": { "id": "c-n3", "anchor_kind": "session", "anchor_id": null, "excerpt": "remark n3" },
                    "link": "/timeline?org=org-acme&workspace=ws-atlas&session=rs-1&comment=c-n3",
                },
                {
                    "id": "n2",
                    "kind": "mention",
                    "unread": true,
                    "created_at": "2026-09-25T09:00:00.000Z",
                    "author": { "user_id": "u-grace", "name": "Grace Hopper", "guest": false },
                    "session": session,
                    "comment": {
                        "id": "c-n2", "anchor_kind": "checkpoint", "anchor_id": "cp-7", "excerpt": "remark n2"
                    },
                    "link": "/timeline?org=org-acme&workspace=ws-atlas&session=rs-1&comment=c-n2",
                },
                {
                    "id": "n1",
                    "kind": "reply",
                    "unread": false,
                    "created_at": "2026-09-24T09:00:00.000Z",
                    "author": { "user_id": "u-sam1", "name": "Sam Lee", "guest": false },
                    "session": session,
                    "comment": { "id": "c-n1", "anchor_kind": "session", "anchor_id": null, "excerpt": "remark n1" },
                    "link": "/timeline?org=org-acme&workspace=ws-atlas&session=rs-1&comment=c-n1",
                },
            ],
            "next_cursor": null,
        }),
    );
    assert_eq!(
        org.asked(),
        [
            ("org-acme".to_string(), "inbox unread_only=false cursor=None limit=None".to_string()),
            ("org-acme".to_string(), "members".to_string()),
        ],
        "the grant's organisation's inbox, and its roster to name the authors"
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn unread_only_leaves_out_what_the_user_has_read_but_the_count_is_still_the_total() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_roster(acme_roster()).with_inbox(acme_inbox());
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_inbox", json!({ "unread_only": true, "limit": 1 })).await;
    assert!(!err, "{answer}");
    assert_eq!(answer["unread"], json!(2), "the total, not the page's share");
    let ids: Vec<&str> = answer["entries"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["n3"]);
    assert_eq!(org.asked()[0].1, "inbox unread_only=true cursor=None limit=Some(1)");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_next_page_continues_from_the_cursor_the_last_one_answered() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_roster(acme_roster()).with_inbox(acme_inbox());
    *org.inbox_next.lock() = Some("1758790800000:n1".into());
    let (_server, client) = org_client(org.clone()).await;
    let (_, first) = call_json(&client, "org_inbox", json!({})).await;
    assert_eq!(first["next_cursor"], json!("1758790800000:n1"));
    let (err, _) = call_json(&client, "org_inbox", json!({ "cursor": "1758790800000:n1" })).await;
    assert!(!err);
    let inbox_asks: Vec<String> =
        org.asked().into_iter().map(|(_, what)| what).filter(|w| w.starts_with("inbox")).collect();
    assert_eq!(inbox_asks[1], "inbox unread_only=false cursor=Some(\"1758790800000:n1\") limit=None");
    client.cancel().await.ok();
}

/// A member the roster cannot name — it failed, or they have left — keeps
/// their id; the inbox still answers.
#[tokio::test(flavor = "multi_thread")]
async fn an_author_the_roster_cannot_name_keeps_their_id_and_the_inbox_still_answers() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_roster(acme_roster()).with_inbox(acme_inbox());
    org.roster_fail.store(true, Ordering::SeqCst);
    let (_server, client) = org_client(org).await;
    let (err, answer) = call_json(&client, "org_inbox", json!({})).await;
    assert!(!err, "{answer}");
    assert_eq!(answer["entries"][1]["author"], json!({ "user_id": "u-grace", "name": null, "guest": false }));
    assert_eq!(answer["entries"][0]["author"]["name"], json!("Outside Reviewer"), "a guest's name is on the entry");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_inbox_that_cannot_be_read_is_a_tool_error() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_inbox(acme_inbox());
    org.inbox_fail.store(true, Ordering::SeqCst);
    let (_server, client) = org_client(org).await;
    let (err, text) = call(&client, "org_inbox", json!({})).await;
    assert!(err);
    assert!(text.contains("could not be reached"), "{text}");
    client.cancel().await.ok();
}

/// Reading the inbox leaves it exactly as the user left it. The organisation
/// cloud has no way to mark an entry read (and so neither has the fake), no
/// tool is offered that could, and the inbox answers the same the second
/// time as the first.
#[tokio::test(flavor = "multi_thread")]
async fn reading_the_inbox_never_marks_anything_read() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_roster(acme_roster()).with_inbox(acme_inbox());
    let (_server, client) = org_client(org.clone()).await;
    let (_, first) = call_json(&client, "org_inbox", json!({})).await;
    let (_, again) = call_json(&client, "org_inbox", json!({})).await;
    assert_eq!(first, again);
    assert_eq!(org.inbox.lock().clone(), acme_inbox(), "every entry's read state is as the user left it");
    assert!(
        org.asked().iter().all(|(_, what)| what.starts_with("inbox unread_only=") || what == "members"),
        "nothing but inbox reads and the roster: {:?}",
        org.asked()
    );
    let tools = client.list_all_tools().await.unwrap();
    assert!(
        tools.iter().all(|t| !t.name.contains("mark") && !t.name.ends_with("_read")),
        "no tool can mark the inbox read"
    );
    client.cancel().await.ok();
}

// ── org_comments ─────────────────────────────────────────────────────────────

/// A comment by `author` on recorded session `rs-1`, at minute `minute`.
fn authored(id: &str, parent: Option<&str>, author: &str, body: &str, minute: u32) -> Comment {
    Comment {
        author_id: author.into(),
        body: Some(body.into()),
        created_at: format!("2026-09-26T10:{minute:02}:00Z"),
        ..comment(id, parent)
    }
}

/// The current session's comments, oldest first: an open thread from Sam on
/// a checkpoint mentioning Grace, with a reply from Grace and a deleted
/// reply; a thread Grace resolved; and an open thread from a guest reviewer.
fn acme_comments() -> Vec<Comment> {
    let mut root = authored("k1", None, "u-sam1", "<@u-grace> can you check the <@u-ghost> path?", 1);
    root.anchor_kind = AnchorKind::Checkpoint;
    root.anchor_id = "cp-7".into();
    let reply = Comment { edited_at: Some("2026-09-26T10:05:00Z".into()), ..authored("k2", Some("k1"), "u-grace", "done", 2) };
    let mut gone = authored("k3", Some("k1"), "u-sam2", "never mind", 3);
    gone.body = None;
    gone.deleted_at = Some("2026-09-26T10:04:00Z".into());
    let mut done = authored("k4", None, "u-sam2", "typo in the title", 4);
    done.resolved_at = Some("2026-09-26T11:00:00Z".into());
    done.resolved_by = Some("u-grace".into());
    let mut guest = authored("k5", None, "guest:9f2c", "looks good to me", 5);
    guest.guest_name = Some("Outside Reviewer".into());
    vec![root, reply, gone, done, guest]
}

/// An organisation whose chat `s1` is recorded as `rs-1` with
/// [`acme_comments`], and whose Workspace also holds `rs-2` with one open
/// thread.
fn commented() -> Arc<FakeOrganisation> {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer)).with_roster(acme_roster());
    org.record("s1", current(true));
    for c in acme_comments() {
        org.comment_on("rs-1", c);
    }
    org.comment_on("rs-2", Comment { session_id: "rs-2".into(), ..authored("z1", None, "u-1", "older remark", 0) });
    org
}

fn thread_ids(answer: &Value) -> Vec<String> {
    answer["threads"].as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap().to_string()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn org_comments_with_no_arguments_reads_the_current_sessions_threads() {
    let org = commented();
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_comments", json!({})).await;
    assert!(!err, "{answer}");
    assert_eq!(
        answer,
        json!({
            "session": { "id": "rs-1", "title": "Fix the theme importer", "current": true },
            "unresolved": 2,
            "threads": [
                {
                    "id": "k1",
                    "author": { "user_id": "u-sam1", "name": "Sam Lee", "guest": false },
                    "anchor": { "kind": "checkpoint", "id": "cp-7" },
                    "body": "@Grace Hopper can you check the <@u-ghost> path?",
                    "created_at": "2026-09-26T10:01:00Z",
                    "edited_at": null,
                    "resolved": null,
                    "replies": [
                        {
                            "id": "k2",
                            "author": { "user_id": "u-grace", "name": "Grace Hopper", "guest": false },
                            "anchor": { "kind": "session", "id": null },
                            "body": "done",
                            "created_at": "2026-09-26T10:02:00Z",
                            "edited_at": "2026-09-26T10:05:00Z",
                        },
                        {
                            "id": "k3",
                            "author": { "user_id": "u-sam2", "name": "Sam Lee", "guest": false },
                            "anchor": { "kind": "session", "id": null },
                            "body": null,
                            "created_at": "2026-09-26T10:03:00Z",
                            "edited_at": null,
                            "deleted": true,
                        },
                    ],
                },
                {
                    "id": "k4",
                    "author": { "user_id": "u-sam2", "name": "Sam Lee", "guest": false },
                    "anchor": { "kind": "session", "id": null },
                    "body": "typo in the title",
                    "created_at": "2026-09-26T10:04:00Z",
                    "edited_at": null,
                    "resolved": {
                        "at": "2026-09-26T11:00:00Z",
                        "by": { "user_id": "u-grace", "name": "Grace Hopper" },
                    },
                    "replies": [],
                },
                {
                    "id": "k5",
                    "author": { "user_id": "guest:9f2c", "name": "Outside Reviewer", "guest": true },
                    "anchor": { "kind": "session", "id": null },
                    "body": "looks good to me",
                    "created_at": "2026-09-26T10:05:00Z",
                    "edited_at": null,
                    "resolved": null,
                    "replies": [],
                },
            ],
        }),
    );
    assert_eq!(
        org.asked(),
        [
            ("org-acme".to_string(), "current s1 in /p".to_string()),
            ("org-acme".to_string(), "comments ws-atlas/rs-1".to_string()),
            ("org-acme".to_string(), "members".to_string()),
        ],
        "the current session's comments, in the grant's organisation and Workspace",
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_current_sentinel_is_the_current_session() {
    let org = commented();
    let (_server, client) = org_client(org).await;
    let (_, default) = call_json(&client, "org_comments", json!({})).await;
    for sentinel in ["current", "Current"] {
        let (err, answer) = call_json(&client, "org_comments", json!({ "session": sentinel })).await;
        assert!(!err, "{answer}");
        assert_eq!(answer, default, "{sentinel}");
    }
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_explicit_session_id_reads_any_recorded_session_in_the_workspace() {
    let org = commented();
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_comments", json!({ "session": "rs-2" })).await;
    assert!(!err, "{answer}");
    assert_eq!(answer["session"], json!({ "id": "rs-2", "title": null, "current": false }));
    assert_eq!(thread_ids(&answer), ["z1"]);
    assert_eq!(answer["threads"][0]["author"]["name"], json!("Ada Lovelace"));
    assert!(
        !org.asked().iter().any(|(_, what)| what.starts_with("current")),
        "a named session needs no current-session join",
    );
    assert!(org.asked().contains(&("org-acme".to_string(), "comments ws-atlas/rs-2".to_string())));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn unresolved_only_leaves_out_resolved_threads() {
    let org = commented();
    let (_server, client) = org_client(org).await;
    let (err, answer) = call_json(&client, "org_comments", json!({ "unresolved_only": true })).await;
    assert!(!err, "{answer}");
    assert_eq!(thread_ids(&answer), ["k1", "k5"]);
    assert_eq!(answer["unresolved"], json!(2));
    assert_eq!(answer["threads"][0]["replies"].as_array().unwrap().len(), 2, "an open thread keeps its replies");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn mentions_are_written_as_names_and_keep_their_id_when_the_roster_cannot_name_them() {
    let org = commented();
    let (_server, client) = org_client(org.clone()).await;
    let (_, answer) = call_json(&client, "org_comments", json!({})).await;
    assert_eq!(answer["threads"][0]["body"], json!("@Grace Hopper can you check the <@u-ghost> path?"));

    org.roster_fail.store(true, Ordering::SeqCst);
    let (err, answer) = call_json(&client, "org_comments", json!({})).await;
    assert!(!err, "the threads still answer without the roster: {answer}");
    assert_eq!(answer["threads"][0]["body"], json!("<@u-grace> can you check the <@u-ghost> path?"));
    assert_eq!(answer["threads"][0]["author"], json!({ "user_id": "u-sam1", "name": null, "guest": false }));
    client.cancel().await.ok();
}

#[test]
fn mention_rewriting_leaves_everything_that_is_not_a_mention_alone() {
    let roster = acme_roster();
    let named = |body: &str| super::tools::named_mentions(body, Some(&roster));
    assert_eq!(named("hi <@u-1> and <@u-grace>!"), "hi @Ada Lovelace and @Grace Hopper!");
    assert_eq!(named("a < b <@ nope> <@> <@u-1"), "a < b <@ nope> <@> <@u-1");
    assert_eq!(named("<@<@u-1>"), "<@@Ada Lovelace");
    assert_eq!(named("naïve <@u-1>é"), "naïve @Ada Lovelaceé", "multi-byte text around a mention survives");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_guest_author_is_shown_as_a_guest_by_the_name_on_the_comment() {
    let org = commented();
    let (_server, client) = org_client(org).await;
    let (_, answer) = call_json(&client, "org_comments", json!({})).await;
    assert_eq!(
        answer["threads"][2]["author"],
        json!({ "user_id": "guest:9f2c", "name": "Outside Reviewer", "guest": true }),
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn org_comments_on_a_chat_not_recorded_yet_says_so() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_roster(acme_roster());
    let (_server, client) = org_client(org.clone()).await;
    let (err, text) = call(&client, "org_comments", json!({})).await;
    assert!(err);
    assert!(text.contains(NOT_RECORDED_YET) && text.contains("recorded session id"), "{text}");
    assert!(!org.asked().iter().any(|(_, what)| what.starts_with("comments")));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn comments_that_cannot_be_read_are_a_tool_error() {
    let org = commented();
    org.comments_fail.store(true, Ordering::SeqCst);
    let (_server, client) = org_client(org).await;
    let (err, text) = call(&client, "org_comments", json!({})).await;
    assert!(err);
    assert!(text.contains("could not be reached"), "{text}");
    client.cancel().await.ok();
}

// ── org_comment_resolve ──────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn org_comment_resolve_resolves_a_root_on_the_current_session_as_the_caller() {
    let org = commented();
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_comment_resolve", json!({ "comment": "k1" })).await;
    assert!(!err, "{answer}");
    assert_eq!(answer["session"]["id"], json!("rs-1"));
    assert_eq!(answer["comment"]["id"], json!("k1"));
    assert_eq!(
        answer["comment"]["resolved"],
        json!({ "at": "2026-09-26T12:00:00Z", "by": { "user_id": "u-1", "name": "Ada Lovelace" } }),
    );
    assert!(org.asked().contains(&("org-acme".to_string(), "resolve ws-atlas/rs-1/k1 resolved=true".to_string())));

    let (_, after) = call_json(&client, "org_comments", json!({ "unresolved_only": true })).await;
    assert_eq!(thread_ids(&after), ["k5"], "the thread is resolved for everyone who reads it");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn resolved_false_unresolves_a_root() {
    let org = commented();
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) =
        call_json(&client, "org_comment_resolve", json!({ "comment": "k4", "resolved": false, "session": "current" })).await;
    assert!(!err, "{answer}");
    assert_eq!(answer["comment"]["resolved"], Value::Null);
    assert!(org.asked().contains(&("org-acme".to_string(), "resolve ws-atlas/rs-1/k4 resolved=false".to_string())));
    let (_, after) = call_json(&client, "org_comments", json!({ "unresolved_only": true })).await;
    assert_eq!(thread_ids(&after), ["k1", "k4", "k5"]);
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_root_on_a_named_session_resolves_there() {
    let org = commented();
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_comment_resolve", json!({ "comment": "z1", "session": "rs-2" })).await;
    assert!(!err, "{answer}");
    assert_eq!(answer["session"], json!({ "id": "rs-2", "title": null, "current": false }));
    assert!(org.asked().contains(&("org-acme".to_string(), "resolve ws-atlas/rs-2/z1 resolved=true".to_string())));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reply_is_refused_naming_its_root_and_nothing_is_sent() {
    let org = commented();
    let (_server, client) = org_client(org.clone()).await;
    let (err, text) = call(&client, "org_comment_resolve", json!({ "comment": "k2" })).await;
    assert!(err);
    assert_eq!(text, "only a thread's first comment can be resolved; its root is k1");
    assert!(!org.asked().iter().any(|(_, what)| what.starts_with("resolve")), "the server was never asked");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_comment_id_is_an_error_and_nothing_is_sent() {
    let org = commented();
    let (_server, client) = org_client(org.clone()).await;
    let (err, text) = call(&client, "org_comment_resolve", json!({ "comment": "k99" })).await;
    assert!(err);
    assert!(text.contains("no comment k99 on recorded session rs-1") && text.contains("org_comments"), "{text}");
    let (err, text) = call(&client, "org_comment_resolve", json!({})).await;
    assert!(err);
    assert!(text.contains("`comment`"), "{text}");
    assert!(!org.asked().iter().any(|(_, what)| what.starts_with("resolve")));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resolve_the_organisation_cannot_take_is_a_tool_error() {
    let org = commented();
    org.resolve_fail.store(true, Ordering::SeqCst);
    let (_server, client) = org_client(org.clone()).await;
    let (err, text) = call(&client, "org_comment_resolve", json!({ "comment": "k1" })).await;
    assert!(err);
    assert!(text.contains("could not be reached"), "{text}");
    assert!(org.comments.lock()["rs-1"][0].resolved_at.is_none(), "nothing changed");
    client.cancel().await.ok();
}

// ── org_comment_reply ────────────────────────────────────────────────────────

/// Everything posted on recorded session `rs-1` after the fixtures.
fn replies(org: &FakeOrganisation) -> Vec<Comment> {
    org.comments.lock()["rs-1"].iter().filter(|c| c.id.starts_with('r')).cloned().collect()
}

fn notified(org: &FakeOrganisation) -> Vec<(String, &'static str)> {
    org.notified.lock().iter().map(|(user, kind, _)| (user.clone(), *kind)).collect()
}

fn nothing_posted(org: &FakeOrganisation) -> bool {
    !org.asked().iter().any(|(_, what)| what.starts_with("reply"))
}

#[tokio::test(flavor = "multi_thread")]
async fn org_comment_reply_posts_under_the_thread_on_its_anchor_as_the_caller_and_tells_the_threads_author() {
    let org = commented();
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) =
        call_json(&client, "org_comment_reply", approved(&consent, json!({ "comment": "k1", "body": "Checked the path; it was stale." }))).await;
    assert!(!err, "{answer}");
    assert_eq!(answer["session"]["id"], json!("rs-1"));
    assert_eq!(
        answer["thread"],
        json!({ "id": "k1", "author": { "user_id": "u-sam1", "name": "Sam Lee", "guest": false } }),
    );
    assert_eq!(answer["comment"]["author"], json!({ "user_id": "u-1", "name": "Ada Lovelace", "guest": false }));
    assert_eq!(answer["comment"]["body"], json!("Checked the path; it was stale."));
    assert_eq!(answer["comment"]["anchor"], json!({ "kind": "checkpoint", "id": "cp-7" }), "where its thread is");
    assert!(org.asked().contains(&("org-acme".to_string(), "reply ws-atlas/rs-1/k1".to_string())));

    let posted = replies(&org);
    assert_eq!(posted.len(), 1);
    assert_eq!(posted[0].parent_id.as_deref(), Some("k1"));
    assert_eq!(answer["comment"]["id"], json!(posted[0].id), "the answer is the posted comment");
    assert_eq!(notified(&org), [("u-sam1".to_string(), "artifact_reply")], "the thread's author is told");

    // It is on the thread for everyone who reads it.
    let (_, threads) = call_json(&client, "org_comments", json!({})).await;
    let replies_on_k1: Vec<&str> =
        threads["threads"][0]["replies"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert!(replies_on_k1.contains(&posted[0].id.as_str()));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reply_given_a_reply_id_goes_under_that_threads_first_comment() {
    let org = commented();
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_comment_reply", approved(&consent, json!({ "comment": "k2", "body": "Thanks Grace." }))).await;
    assert!(!err, "{answer}");
    assert_eq!(answer["thread"]["id"], json!("k1"));
    assert_eq!(replies(&org)[0].parent_id.as_deref(), Some("k1"), "replies are one level deep");
    assert_eq!(notified(&org), [("u-sam1".to_string(), "artifact_reply")], "the root's author, not the reply's");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn mentions_are_written_as_user_ids_where_the_body_names_them_or_lead_it() {
    let org = commented();
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) = call_json(
        &client,
        "org_comment_reply",
        approved(&consent, json!({
            "comment": "k1",
            "body": "@Grace Hopper can you confirm?",
            "mention": ["Grace Hopper", "sam.lee@acme.dev"],
        })),
    )
    .await;
    assert!(!err, "{answer}");
    assert_eq!(
        replies(&org)[0].body.as_deref(),
        Some("<@u-sam1> <@u-grace> can you confirm?"),
        "the named one in place, the other leading",
    );
    assert_eq!(answer["comment"]["body"], json!("@Sam Lee @Grace Hopper can you confirm?"), "read back by name");
    assert_eq!(
        notified(&org),
        [("u-sam1".to_string(), "artifact_mention"), ("u-grace".to_string(), "artifact_mention")],
        "one notification per person, the mention winning over the reply",
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_mention_matching_nobody_or_several_is_refused_before_anything_is_posted() {
    let org = commented();
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, text) =
        call(&client, "org_comment_reply", approved(&consent, json!({ "comment": "k1", "body": "hi", "mention": ["Nobody Here"] }))).await;
    assert!(err);
    assert!(text.contains("no member matches \"Nobody Here\""), "{text}");
    let (err, answer) =
        call_json(&client, "org_comment_reply", approved(&consent, json!({ "comment": "k1", "body": "hi", "mention": ["Sam Lee"] }))).await;
    assert!(err);
    assert_eq!(answer["candidates"].as_array().map(Vec::len), Some(2), "{answer}");
    assert!(nothing_posted(&org));
    assert!(org.notified.lock().is_empty());
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn replying_on_your_own_thread_tells_nobody() {
    let org = commented();
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) =
        call_json(&client, "org_comment_reply", approved(&consent, json!({ "comment": "z1", "body": "fixed", "session": "rs-2" }))).await;
    assert!(!err, "{answer}");
    assert_eq!(answer["session"], json!({ "id": "rs-2", "title": null, "current": false }));
    assert!(org.notified.lock().is_empty(), "the server never tells you about your own reply");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_comment_or_a_missing_body_is_an_error_and_nothing_is_posted() {
    let org = commented();
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, text) = call(&client, "org_comment_reply", approved(&consent, json!({ "comment": "k99", "body": "hi" }))).await;
    assert!(err);
    assert!(text.contains("no comment k99 on recorded session rs-1"), "{text}");
    let (err, text) = call(&client, "org_comment_reply", approved(&consent, json!({ "comment": "k1", "body": "  " }))).await;
    assert!(err);
    assert!(text.contains("`body`"), "{text}");
    assert!(nothing_posted(&org));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reply_the_organisation_cannot_take_is_a_tool_error() {
    let org = commented();
    org.reply_fail.store(true, Ordering::SeqCst);
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, text) = call(&client, "org_comment_reply", approved(&consent, json!({ "comment": "k1", "body": "hi" }))).await;
    assert!(err);
    assert!(text.contains("could not be reached"), "{text}");
    assert!(replies(&org).is_empty(), "nothing was posted");
    assert!(org.notified.lock().is_empty(), "and nobody was told");
    client.cancel().await.ok();
}

/// ADR-0014: an outward action is posted only once the user approved that
/// exact call. Bypass mode runs a prompted tool without asking, so it arrives
/// here with no approval behind it — and is refused with nothing sent.
#[tokio::test(flavor = "multi_thread")]
async fn a_reply_the_user_did_not_approve_is_refused_and_nothing_is_posted() {
    let org = commented();
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, text) = call(&client, "org_comment_reply", json!({ "comment": "k1", "body": "unasked" })).await;
    assert!(err);
    assert!(text.contains("only after you approve them") && text.contains("bypass"), "{text}");

    // An approval covers the call it was given for, and no other.
    approved(&consent, json!({ "comment": "k1", "body": "the approved words" }));
    let (err, _) = call(&client, "org_comment_reply", json!({ "comment": "k1", "body": "other words" })).await;
    assert!(err, "another body is another call");
    assert!(nothing_posted(&org));
    assert!(org.notified.lock().is_empty());
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn one_approval_posts_one_reply() {
    let org = commented();
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let args = approved(&consent, json!({ "comment": "k1", "body": "once" }));
    assert!(!call(&client, "org_comment_reply", args.clone()).await.0);
    let (err, text) = call(&client, "org_comment_reply", args).await;
    assert!(err, "the approval was spent: {text}");
    assert_eq!(replies(&org).len(), 1);
    client.cancel().await.ok();
}

/// The native seam reports each approval through the host
/// (`SessionMcpServers::approved_call`); the offer hands it to the tools that
/// answer the call, and to nothing else.
#[tokio::test(flavor = "multi_thread")]
async fn an_approval_the_native_seam_reports_reaches_the_tools_that_check_it() {
    let org = commented();
    let host = running_host(org.clone()).await;
    let tools = OrgTools::new(org, setting(true), bound_to_acme());
    let offers = MemorySessionOffers::new(host, sharing(true))
        .with_org(OrgOffer::new(setting(true), bound_to_acme()).describing_with(tools.clone()));
    let session = acp::SessionId::new("s1");
    let args = json!({ "comment": "k1", "body": "Done." });
    let on = |server| atlas_agent_servers::CallToApprove {
        session_id: &session,
        server,
        tool: "org_comment_reply",
        arguments: &args,
    };
    offers.approved_call(on(UI_SERVER_NAME));
    assert!(!tools.consent().take("s1", ORG_SERVER_NAME, "org_comment_reply", &args), "another server's call");
    offers.approved_call(on(ORG_SERVER_NAME));
    assert!(tools.consent().take("s1", ORG_SERVER_NAME, "org_comment_reply", &args));
}

#[test]
fn mention_rewriting_takes_the_longest_spelling_and_never_doubles_a_mention() {
    let roster = acme_roster();
    assert_eq!(
        tools::with_mentions("@Grace Hopper and @grace@acme.dev", &["grace@acme.dev".into()], &roster).ok(),
        Some("<@u-grace> and <@u-grace>".to_string()),
    );
    assert_eq!(
        tools::with_mentions("no names here", &[], &roster).ok(),
        Some("no names here".to_string()),
    );
}

// ── The approval card's words for an outward call ────────────────────────────

/// The offer the native seam asks to describe a waiting call, bound to chat
/// `s1` the way a real session's is.
async fn describing_offer(org: Arc<FakeOrganisation>) -> MemorySessionOffers {
    let host = running_host(org.clone()).await;
    let offers = MemorySessionOffers::new(host, sharing(true)).with_org(
        OrgOffer::new(setting(true), FakeSessionOrgs::new(true, Some(acme())))
            .describing_with(OrgTools::new(org, setting(true), bound_to_acme())),
    );
    offers.offer(&session_request(true)).bind(&acp::SessionId::new("s1"));
    offers
}

async fn describe(offers: &MemorySessionOffers, server: &str, tool: &str, arguments: Value) -> Option<atlas_agent_servers::CallDescription> {
    let session = acp::SessionId::new("s1");
    offers
        .describe_call(atlas_agent_servers::CallToApprove { session_id: &session, server, tool, arguments: &arguments })
        .await
}

#[tokio::test(flavor = "multi_thread")]
async fn the_card_names_the_threads_author_where_it_is_and_the_full_body_as_it_will_post() {
    let org = commented();
    let offers = describing_offer(org.clone()).await;
    let body = "Checked it.\n".repeat(300);
    let said = describe(
        &offers,
        ORG_SERVER_NAME,
        "org_comment_reply",
        json!({ "comment": "k2", "body": format!("@Grace Hopper {body}"), "mention": ["Grace Hopper"] }),
    )
    .await
    .expect("a reply is described");
    assert_eq!(said.title, "Reply on Sam Lee's comment", "the thread's first author, from a reply's id");
    assert_eq!(
        said.recipient,
        "Sam Lee, on their comment \"@Grace Hopper can you check the <@u-ghost> path?\" in Fix the theme importer"
    );
    assert_eq!(
        said.body,
        format!("@Grace Hopper {}", body.trim_end()),
        "the whole body as it will post (trimmed, as the call trims it), mentions by name",
    );
    assert!(nothing_posted(&org), "describing posts nothing");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_card_the_organisation_cannot_describe_still_shows_the_comment_and_the_body() {
    let org = commented();
    org.comments_fail.store(true, Ordering::SeqCst);
    let offers = describing_offer(org).await;
    let said = describe(&offers, ORG_SERVER_NAME, "org_comment_reply", json!({ "comment": "k1", "body": "hi" }))
        .await
        .expect("still described");
    assert_eq!(said.title, "Reply to comment k1");
    assert_eq!(said.body, "hi");
}

/// The card and the call read the arguments through one parser and rewrite
/// mentions one way, so the card's body is exactly the posted comment's —
/// trimmed, a blank mention dropped, mentions shown by name.
#[tokio::test(flavor = "multi_thread")]
async fn the_cards_body_is_the_posted_body() {
    let org = commented();
    let offers = describing_offer(org.clone()).await;
    let args = json!({
        "comment": "k1",
        "body": "  @Grace Hopper can you confirm?\n",
        "mention": ["Grace Hopper", " ", "sam.lee@acme.dev"],
    });
    let said = describe(&offers, ORG_SERVER_NAME, "org_comment_reply", args.clone()).await.expect("described");
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_comment_reply", approved(&consent, args)).await;
    assert!(!err, "{answer}");
    assert_eq!(json!(said.body), answer["comment"]["body"]);
    assert_eq!(said.body, "@Sam Lee @Grace Hopper can you confirm?");
    client.cancel().await.ok();
}

/// When the thread cannot be read for the card, it still shows the body as it
/// will be posted, mentions rewritten; when the roster cannot be read either,
/// a mention keeps its `<@id>` on both.
#[tokio::test(flavor = "multi_thread")]
async fn a_card_the_organisation_cannot_describe_still_shows_the_posted_body() {
    let org = commented();
    let offers = describing_offer(org.clone()).await;
    let (_server, client, consent) = consenting_client(org.clone()).await;

    let args = json!({ "comment": "k1", "body": " thanks ", "mention": ["Grace Hopper"] });
    org.comments_fail.store(true, Ordering::SeqCst);
    let said = describe(&offers, ORG_SERVER_NAME, "org_comment_reply", args.clone()).await.expect("described");
    assert_eq!(said.title, "Reply to comment k1");
    org.comments_fail.store(false, Ordering::SeqCst);
    let (err, answer) = call_json(&client, "org_comment_reply", approved(&consent, args)).await;
    assert!(!err, "{answer}");
    assert_eq!(json!(said.body), answer["comment"]["body"]);
    assert_eq!(said.body, "@Grace Hopper thanks");

    let args = json!({ "comment": "k1", "body": "<@u-grace> see above" });
    org.roster_fail.store(true, Ordering::SeqCst);
    let said = describe(&offers, ORG_SERVER_NAME, "org_comment_reply", args.clone()).await.expect("described");
    let (err, answer) = call_json(&client, "org_comment_reply", approved(&consent, args)).await;
    assert!(!err, "{answer}");
    assert_eq!(json!(said.body), answer["comment"]["body"]);
    assert_eq!(said.body, "<@u-grace> see above", "no names to show");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn only_an_outward_call_on_the_org_server_is_described() {
    let offers = describing_offer(commented()).await;
    assert!(describe(&offers, ORG_SERVER_NAME, "org_comment_resolve", json!({ "comment": "k1" })).await.is_none());
    assert!(describe(&offers, "atlas_ui", "org_comment_reply", json!({ "comment": "k1", "body": "x" })).await.is_none());
}

// ── org_send ─────────────────────────────────────────────────────────────────

/// Acme's roster and conversations, chat on Acme: #general, a DM with Grace,
/// a group DM, and a #design the caller is not in. Sam Lee (slee@acme.dev)
/// has no DM with the caller yet.
fn chatting() -> Arc<FakeOrganisation> {
    FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer))
        .with_roster(acme_roster())
        .with_conversations(acme_conversations())
}

/// Every message sent, as `(conversation, body)`.
fn sent(org: &FakeOrganisation) -> Vec<(String, String)> {
    org.sent.lock().iter().map(|(_, conversation, body)| (conversation.clone(), body.clone())).collect()
}

/// Nothing was sent and no DM was opened.
fn nothing_sent(org: &FakeOrganisation) -> bool {
    !org.asked().iter().any(|(_, what)| what.starts_with("send") || what.starts_with("dm"))
}

/// An approved `org_send`, and its JSON answer.
async fn send(
    client: &RunningService<RoleClient, ()>,
    consent: &atlas_agent_servers::OutwardConsent,
    args: Value,
) -> (bool, Value) {
    call_json(client, "org_send", approved_for(consent, "org_send", args)).await
}

#[tokio::test(flavor = "multi_thread")]
async fn org_send_posts_to_a_channel_the_caller_is_in_exactly_as_written_and_answers_the_acked_message() {
    let org = chatting();
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) = send(&client, &consent, json!({ "to": "#general", "body": "Deployed the importer fix." })).await;
    assert!(!err, "{answer}");
    assert_eq!(sent(&org), [("c-general".to_string(), "Deployed the importer fix.".to_string())], "no suffix, nothing added");
    assert_eq!(org.sent.lock()[0].0, "org-acme", "in the grant's organisation");
    assert_eq!(answer["conversation"]["id"], json!("c-general"));
    assert_eq!(answer["conversation"]["name"], json!("general"));
    assert_eq!(answer["message_id"], json!("m-1"), "the server's id, from its ack");
    assert_eq!(answer["client_msg_id"], json!("cm-1"));
    assert_eq!(answer["created_dm"], json!(false));
    assert_eq!(answer["body"], json!("Deployed the importer fix."));
    assert!(answer.get("note").is_none());
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_member_with_a_dm_is_messaged_in_that_dm_and_none_is_created() {
    let org = chatting();
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) = send(&client, &consent, json!({ "to": "Grace Hopper", "body": "Your review is in." })).await;
    assert!(!err, "{answer}");
    assert_eq!(sent(&org), [("c-dm-grace".to_string(), "Your review is in.".to_string())]);
    assert_eq!(answer["created_dm"], json!(false));
    assert!(!org.asked().iter().any(|(_, what)| what.starts_with("dm")), "the DM that exists is used");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_member_with_no_dm_gets_one_created_first_then_the_message() {
    let org = chatting();
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) = send(&client, &consent, json!({ "to": "slee@acme.dev", "body": "Welcome aboard." })).await;
    assert!(!err, "{answer}");
    let writes: Vec<String> = org
        .asked()
        .into_iter()
        .map(|(_, what)| what)
        .filter(|what| what.starts_with("dm") || what.starts_with("send"))
        .collect();
    assert_eq!(writes, ["dm u-sam2", "send c-dm-u-sam2"], "the DM is created first, then the message goes into it");
    assert_eq!(answer["created_dm"], json!(true));
    assert_eq!(answer["conversation"]["id"], json!("c-dm-u-sam2"));
    assert_eq!(
        answer["conversation"]["members"],
        json!([{ "user_id": "u-1", "name": "Ada Lovelace" }, { "user_id": "u-sam2", "name": "Sam Lee" }]),
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_group_dm_named_by_id_gets_the_message() {
    let org = chatting();
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) = send(&client, &consent, json!({ "to": "c-group", "body": "Standup moved to 10." })).await;
    assert!(!err, "{answer}");
    assert_eq!(sent(&org), [("c-group".to_string(), "Standup moved to 10.".to_string())]);
    assert_eq!(answer["conversation"]["kind"], json!("group_dm"));
    assert_eq!(answer["created_dm"], json!(false));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn mentions_in_a_message_are_written_as_user_ids_where_the_body_names_them_or_lead_it() {
    let org = chatting();
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) = send(
        &client,
        &consent,
        json!({ "to": "general", "body": "@Grace Hopper can you look?", "mention": ["Grace Hopper", "sam.lee@acme.dev"] }),
    )
    .await;
    assert!(!err, "{answer}");
    assert_eq!(sent(&org)[0].1, "<@u-sam1> <@u-grace> can you look?", "the named one in place, the other leading");
    assert_eq!(answer["body"], json!("@Sam Lee @Grace Hopper can you look?"), "read back by name");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_mention_matching_nobody_or_several_is_refused_before_anything_is_sent_or_opened() {
    let org = chatting();
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) =
        send(&client, &consent, json!({ "to": "slee@acme.dev", "body": "hi", "mention": ["Nobody Here"] })).await;
    assert!(err);
    assert!(answer.as_str().is_some_and(|t| t.contains("no member matches \"Nobody Here\"")), "{answer}");
    let (err, answer) = send(&client, &consent, json!({ "to": "general", "body": "hi", "mention": ["Sam Lee"] })).await;
    assert!(err);
    assert_eq!(answer["candidates"].as_array().map(Vec::len), Some(2), "{answer}");
    assert!(nothing_sent(&org), "no message, and no DM opened for one");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_body_over_chats_cap_is_refused_naming_the_cap_and_the_size_and_nothing_is_sent() {
    let org = chatting();
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let over = "é".repeat(8 * 1024) + "!";
    let (err, answer) = send(&client, &consent, json!({ "to": "slee@acme.dev", "body": over })).await;
    assert!(err);
    let text = answer.as_str().unwrap_or_default();
    assert!(text.contains("16385 bytes") && text.contains("16384 bytes"), "UTF-8 bytes, not characters: {text}");
    assert!(nothing_sent(&org), "not truncated, not split, and no DM opened");

    let at_cap = "x".repeat(16 * 1024);
    let (err, answer) = send(&client, &consent, json!({ "to": "general", "body": at_cap.clone() })).await;
    assert!(!err, "{answer}");
    assert_eq!(sent(&org), [("c-general".to_string(), at_cap)], "exactly the cap goes out whole");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_channel_the_caller_is_not_in_is_refused_and_nothing_is_sent() {
    let org = chatting();
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) = send(&client, &consent, json!({ "to": "c-design-web", "body": "hello" })).await;
    assert!(err);
    let text = answer.as_str().unwrap_or_default();
    assert!(text.contains("not a member of #design") && text.contains("Nothing was sent"), "{text}");
    assert!(nothing_sent(&org));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_recipient_matching_nothing_or_several_is_refused_and_nothing_is_sent() {
    let org = chatting();
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) = send(&client, &consent, json!({ "to": "Nobody Here", "body": "hi" })).await;
    assert!(err);
    assert!(answer.as_str().is_some_and(|t| t.contains("nothing matches \"Nobody Here\"")), "{answer}");
    let (err, answer) = send(&client, &consent, json!({ "to": "Sam Lee", "body": "hi" })).await;
    assert!(err);
    assert_eq!(answer["candidates"].as_array().map(Vec::len), Some(2), "two members are called Sam Lee: {answer}");
    let (err, answer) = send(&client, &consent, json!({ "to": "general", "body": "  " })).await;
    assert!(err);
    assert!(answer.as_str().is_some_and(|t| t.contains("`body`")), "{answer}");
    assert!(nothing_sent(&org));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn org_send_refuses_while_chat_is_on_another_organisation_and_nothing_is_sent() {
    let org = chatting();
    *org.chat_org.lock() = Some("org-other".into());
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) = send(&client, &consent, json!({ "to": "general", "body": "hi" })).await;
    assert!(err);
    let text = answer.as_str().unwrap_or_default();
    assert!(text.contains("chat is connected to organisation org-other") && text.contains("org-acme"), "{text}");
    assert!(nothing_sent(&org));
    client.cancel().await.ok();
}

/// ADR-0014: a message is posted only once the user approved that exact
/// call; bypass runs it unasked, and it is refused with nothing sent.
#[tokio::test(flavor = "multi_thread")]
async fn a_message_the_user_did_not_approve_is_refused_and_nothing_is_sent() {
    let org = chatting();
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, text) = call(&client, "org_send", json!({ "to": "general", "body": "unasked" })).await;
    assert!(err);
    assert!(text.contains("only after you approve them") && text.contains("bypass"), "{text}");
    // A reply's approval is not a message's.
    approved(&consent, json!({ "to": "general", "body": "unasked" }));
    assert!(call(&client, "org_send", json!({ "to": "general", "body": "unasked" })).await.0);
    assert!(nothing_sent(&org));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn one_approval_sends_one_message() {
    let org = chatting();
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let args = approved_for(&consent, "org_send", json!({ "to": "general", "body": "once" }));
    assert!(!call(&client, "org_send", args.clone()).await.0);
    assert!(call(&client, "org_send", args).await.0, "the approval was spent");
    assert_eq!(sent(&org).len(), 1);
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_message_chat_has_not_acked_yet_answers_its_client_id_and_says_it_is_queued() {
    let org = chatting();
    org.unacked.store(true, Ordering::SeqCst);
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) = send(&client, &consent, json!({ "to": "general", "body": "hi" })).await;
    assert!(!err, "{answer}");
    assert_eq!(answer["message_id"], Value::Null);
    assert_eq!(answer["client_msg_id"], json!("cm-1"));
    assert!(answer["note"].as_str().is_some_and(|n| n.contains("queued")), "{answer}");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_message_chat_refuses_is_a_tool_error_with_its_reason() {
    let org = chatting();
    org.send_fail.store(true, Ordering::SeqCst);
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) = send(&client, &consent, json!({ "to": "general", "body": "hi" })).await;
    assert!(err);
    assert!(answer.as_str().is_some_and(|t| t.contains("not_member")), "{answer}");
    assert!(org.sent.lock().is_empty());
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_card_for_a_message_names_the_channel_the_dm_the_group_or_the_new_dm() {
    let offers = describing_offer(chatting()).await;
    let card = |to: &str| describe(&offers, ORG_SERVER_NAME, "org_send", json!({ "to": to, "body": "hi" }));
    let said = card("#general").await.expect("described");
    assert_eq!((said.title.as_str(), said.recipient.as_str()), ("Send to #general", "Everyone in #general"));
    let said = card("Grace Hopper").await.expect("described");
    assert_eq!((said.title.as_str(), said.recipient.as_str()), ("Message Grace Hopper", "Grace Hopper, in your DM"));
    let said = card("slee@acme.dev").await.expect("described");
    assert_eq!(
        (said.title.as_str(), said.recipient.as_str()),
        ("Message Sam Lee", "Sam Lee (slee@acme.dev), in a new DM with them"),
    );
    let said = card("c-group").await.expect("described");
    assert_eq!(
        (said.title.as_str(), said.recipient.as_str()),
        ("Message the group with Sam Lee and u-ghost", "Everyone in your group DM with Sam Lee and u-ghost"),
    );
    let said = card("Nobody Here").await.expect("still described");
    assert_eq!((said.title.as_str(), said.recipient.as_str(), said.body.as_str()), ("Send to Nobody Here", "Nobody Here", "hi"));
}

/// The card and the call read the arguments through one parser and rewrite
/// mentions one way, so the card's body is exactly the message sent — whole,
/// trimmed, mentions shown by name — and describing it sends nothing, opens
/// no DM.
#[tokio::test(flavor = "multi_thread")]
async fn the_cards_body_is_the_sent_body() {
    let org = chatting();
    let offers = describing_offer(org.clone()).await;
    let args = json!({
        "to": "slee@acme.dev",
        "body": format!("  @Grace Hopper {}\n", "the importer is fixed.\n".repeat(400)),
        "mention": ["Grace Hopper", " "],
    });
    let said = describe(&offers, ORG_SERVER_NAME, "org_send", args.clone()).await.expect("described");
    assert!(nothing_sent(&org), "describing sends nothing and opens no DM");
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) = send(&client, &consent, args).await;
    assert!(!err, "{answer}");
    assert_eq!(json!(said.body), answer["body"]);
    let posted = &sent(&org)[0].1;
    assert_eq!(said.body, tools::named_mentions(posted, Some(&acme_roster())), "the card is the sent message, by name");
    assert_eq!(posted.replace("<@u-grace>", "@Grace Hopper"), said.body);
    client.cancel().await.ok();
}

// ── org_send with a Session Reference ────────────────────────────────────────

/// [`chatting`], with a board: the chat `s1` is written into `rs-1` ("Fix the
/// theme importer"), and `rs-2` is another recorded session in the grant's
/// Workspace. `restricted` makes the Workspace one chat will not let a
/// message reference.
fn reporting(restricted: bool) -> Arc<FakeOrganisation> {
    let org = chatting().with_board(vec![
        board_row("rs-1", "u-1", 120, 5, false, "Fix the theme importer"),
        board_row("rs-2", "u-grace", 3 * DAY, 2 * DAY, false, "Theme tokens"),
    ]);
    org.record("s1", current(false));
    if !restricted {
        *org.referenceable.lock() = vec!["ws-other".into(), "ws-atlas".into()];
    }
    org
}

/// The references each message sent carried.
fn sent_refs(org: &FakeOrganisation) -> Vec<Vec<SessionReference>> {
    org.sent_refs.lock().clone()
}

/// The one Session Reference the only message sent carried.
fn the_reference(org: &FakeOrganisation) -> ReferencedSession {
    match sent_refs(org).as_slice() {
        [refs] => match refs.as_slice() {
            [SessionReference::Session(r)] => r.clone(),
            other => panic!("expected one session reference, got {other:?}"),
        },
        other => panic!("expected one message, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn org_send_with_a_session_attaches_its_reference_from_the_recorded_summary() {
    let org = reporting(false);
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) = send(&client, &consent, json!({ "to": "Grace Hopper", "body": "Report: tokens done.", "session": "rs-2" })).await;
    assert!(!err, "{answer}");
    assert_eq!(sent(&org), [("c-dm-grace".to_string(), "Report: tokens done.".to_string())], "the body as written");
    let r = the_reference(&org);
    assert_eq!((r.workspace_ref_id.as_str(), r.session_id.as_str()), ("ws-atlas", "rs-2"), "the grant's Workspace");
    assert_eq!(r.session_title.as_deref(), Some("Theme tokens"));
    assert_eq!(r.agent.as_deref(), Some("atlas-agent"));
    assert_eq!((r.messages, r.tool_calls, r.checkpoints), (12, 7, 2), "the summary's figures");
    let started = chrono::DateTime::parse_from_rfc3339(&ago(3 * DAY)).unwrap().timestamp_millis();
    assert!(r.started_at.is_some_and(|at| (at - started).abs() < 120_000), "epoch milliseconds: {:?}", r.started_at);
    assert_eq!(answer["session_reference"]["attached"], json!(true), "{answer}");
    assert_eq!(answer["session_reference"]["title"], json!("Theme tokens"));
    assert_eq!(answer["body"], json!("Report: tokens done."));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_current_sentinel_references_the_session_this_chat_is_recorded_in() {
    let org = reporting(false);
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) = send(&client, &consent, json!({ "to": "#general", "body": "Where I got to.", "session": "current" })).await;
    assert!(!err, "{answer}");
    let r = the_reference(&org);
    assert_eq!((r.session_id.as_str(), r.session_title.as_deref()), ("rs-1", Some("Fix the theme importer")));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_recorded_session_link_is_referenced_as_the_session_it_carries() {
    let org = reporting(false);
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) = send(
        &client,
        &consent,
        json!({ "to": "general", "body": "See this.", "session": "atlas-org://recorded-session/ws-atlas/rs-2" }),
    )
    .await;
    assert!(!err, "{answer}");
    assert_eq!(the_reference(&org).session_id, "rs-2");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_recorded_session_in_another_workspace_of_the_organisation_is_referenced_there() {
    let org = reporting(false);
    org.board.lock().push(RemoteSession { workspace_id: "ws-other".into(), ..board_row("rs-9", "u-grace", 90, 30, false, "Elsewhere") });
    let (_server, client, consent) = consenting_client(org.clone()).await;
    for session in [
        json!({ "session": "atlas-org://recorded-session/ws-other/rs-9" }),
        json!({ "session": "rs-9", "workspace": "ws-other" }),
    ] {
        let mut args = json!({ "to": "general", "body": "See this." });
        args.as_object_mut().unwrap().extend(session.as_object().unwrap().clone());
        let (err, answer) = send(&client, &consent, args).await;
        assert!(!err, "{session}: {answer}");
        let r = sent_refs(&org).last().cloned().unwrap();
        assert!(
            matches!(r.as_slice(), [SessionReference::Session(r)] if r.workspace_ref_id == "ws-other" && r.session_id == "rs-9"),
            "{session}: {r:?}"
        );
    }
    assert!(org.asked().contains(&("org-acme".to_string(), "timeline ws-other/rs-9 cursor=None limit=Some(1)".to_string())));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn without_session_a_message_carries_no_reference_and_reads_no_session() {
    let org = reporting(false);
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) = send(&client, &consent, json!({ "to": "general", "body": "plain" })).await;
    assert!(!err, "{answer}");
    assert_eq!(sent_refs(&org), [Vec::<SessionReference>::new()]);
    assert!(answer.get("session_reference").is_none());
    assert!(!org.asked().iter().any(|(_, what)| what.starts_with("timeline") || what == "workspaces"));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restricted_workspace_drops_the_reference_appends_the_timeline_link_and_says_so() {
    let org = reporting(true);
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) = send(&client, &consent, json!({ "to": "general", "body": "Report.", "session": "current" })).await;
    assert!(!err, "{answer}");
    let link = atlas_artifacts::session_web_url("org-acme", "ws-atlas", "rs-1");
    assert_eq!(sent(&org), [("c-general".to_string(), format!("Report.\n\n{link}"))], "the link on its own last line");
    assert_eq!(sent_refs(&org), [Vec::<SessionReference>::new()], "no reference chat would refuse");
    let said = &answer["session_reference"];
    assert_eq!(said["attached"], json!(false), "{answer}");
    assert_eq!(said["link"], json!(link));
    assert!(said["note"].as_str().is_some_and(|n| n.contains("not visible to the whole organisation")), "{answer}");
    assert_eq!(answer["body"], json!(format!("Report.\n\n{link}")));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_report_over_the_cap_only_once_its_link_is_appended_is_refused_not_truncated() {
    let org = reporting(true);
    let (_server, client, consent) = consenting_client(org.clone()).await;
    // At the cap as written; over it with the link.
    let body = "x".repeat(16 * 1024);
    let (err, answer) = send(&client, &consent, json!({ "to": "general", "body": body.clone(), "session": "rs-2" })).await;
    assert!(err, "{answer}");
    let text = answer.as_str().unwrap_or_default();
    assert!(text.contains("over chat's cap of 16384 bytes") && text.contains("Nothing was sent"), "{text}");
    assert!(nothing_sent(&org));
    // The same body with the reference attached is exactly the cap, and goes.
    *org.referenceable.lock() = vec!["ws-atlas".into()];
    let (err, answer) = send(&client, &consent, json!({ "to": "general", "body": body.clone(), "session": "rs-2" })).await;
    assert!(!err, "{answer}");
    assert_eq!(sent(&org), [("c-general".to_string(), body)]);
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_that_cannot_be_read_refuses_the_send_and_nothing_is_sent() {
    let org = reporting(false);
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) = send(&client, &consent, json!({ "to": "slee@acme.dev", "body": "hi", "session": "rs-missing" })).await;
    assert!(err);
    assert!(answer.as_str().is_some_and(|t| t.contains("not found")), "{answer}");
    assert!(nothing_sent(&org), "no message, and no DM opened for one");
    client.cancel().await.ok();
}

/// The card shows the reference, and its body is the body sent — with the
/// link appended when the Workspace is restricted.
#[tokio::test(flavor = "multi_thread")]
async fn the_card_shows_the_session_reference_and_its_body_is_the_sent_body() {
    for restricted in [false, true] {
        let org = reporting(restricted);
        let offers = describing_offer(org.clone()).await;
        let args = json!({ "to": "#general", "body": "@Grace Hopper the report.", "mention": ["Grace Hopper"], "session": "current" });
        let said = describe(&offers, ORG_SERVER_NAME, "org_send", args.clone()).await.expect("described");
        assert!(nothing_sent(&org), "describing sends nothing");
        if restricted {
            assert_eq!(
                said.recipient,
                "Everyone in #general\nNo Session Reference: Fix the theme importer is in a restricted Workspace, so its \
                 timeline link is added to the message"
            );
            assert!(said.body.ends_with(&atlas_artifacts::session_web_url("org-acme", "ws-atlas", "rs-1")), "{}", said.body);
        } else {
            assert_eq!(said.recipient, "Everyone in #general\nSession Reference: Fix the theme importer");
        }
        let (_server, client, consent) = consenting_client(org.clone()).await;
        let (err, answer) = send(&client, &consent, args).await;
        assert!(!err, "{answer}");
        assert_eq!(json!(said.body), answer["body"]);
        let posted = &sent(&org)[0].1;
        assert_eq!(posted.replace("<@u-grace>", "@Grace Hopper"), said.body, "the card is the sent message");
        client.cancel().await.ok();
    }
}

// ── org_sessions ─────────────────────────────────────────────────────────────

/// `minutes` ago, as the server stamps it.
fn ago(minutes: i64) -> String {
    (chrono::Utc::now() - chrono::Duration::minutes(minutes)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

const DAY: i64 = 24 * 60;

/// A recorded session on the grant's Workspace's board, by `author`, started
/// and last active the given number of minutes ago.
fn board_row(id: &str, author: &str, started: i64, active: i64, live: bool, title: &str) -> RemoteSession {
    let name = acme_roster().into_iter().find(|m| m.user_id == author).map(|m| m.name);
    RemoteSession {
        id: id.into(),
        workspace_id: "ws-atlas".into(),
        title: Some(title.into()),
        agent: Some("atlas-agent".into()),
        model: Some("claude-opus-5-5".into()),
        started_at: ago(started),
        last_activity_at: ago(active),
        live,
        message_count: 12,
        tool_call_count: 7,
        checkpoint_count: 2,
        insertions: 40,
        deletions: 3,
        files_touched: 4,
        total_tokens: 91_000,
        author_id: Some(author.into()),
        author_name: name,
        ..RemoteSession::default()
    }
}

/// The Workspace's recent work: Ada's live session an hour ago, Grace's
/// theme-importer session two days ago, Ada's older one five days ago, Sam's
/// ten days ago, Grace's three weeks ago (outside the default window), and a
/// session in another Workspace that must never show.
fn acme_board() -> Vec<RemoteSession> {
    vec![
        board_row("rs-ada-old", "u-1", 5 * DAY + 60, 5 * DAY, false, "Tidy the settings pane"),
        board_row("rs-grace", "u-grace", 2 * DAY + 90, 2 * DAY, false, "Fix the theme importer"),
        board_row("rs-ada-live", "u-1", 120, 60, true, "Wire the org tools"),
        board_row("rs-sam", "u-sam1", 10 * DAY + 30, 10 * DAY, false, "Theme tokens"),
        board_row("rs-grace-old", "u-grace", 21 * DAY + 30, 21 * DAY, false, "Release notes"),
        RemoteSession { workspace_id: "ws-other".into(), ..board_row("rs-elsewhere", "u-1", 30, 10, true, "Elsewhere") },
    ]
}

fn boarded() -> Arc<FakeOrganisation> {
    FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer))
        .with_roster(acme_roster())
        .with_board(acme_board())
}

fn session_ids(answer: &Value) -> Vec<String> {
    answer["sessions"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap().to_string()).collect()
}

fn notes(answer: &Value) -> String {
    answer["notes"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect::<Vec<_>>().join(" ")
}

#[test]
fn the_window_and_the_scan_cap_are_fourteen_days_and_five_hundred_sessions() {
    assert_eq!(SESSIONS_DEFAULT_WINDOW_DAYS, 14);
    assert_eq!(SESSIONS_SCAN_CAP, 500);
    assert_eq!(SESSIONS_DEFAULT_LIMIT, 20);
    assert_eq!(TIMELINE_DEFAULT_LIMIT, 50);
}

#[tokio::test(flavor = "multi_thread")]
async fn org_sessions_lists_the_workspaces_sessions_of_the_last_fourteen_days_newest_activity_first() {
    let org = boarded();
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_sessions", json!({})).await;
    assert!(!err, "{answer}");

    assert_eq!(session_ids(&answer), ["rs-ada-live", "rs-grace", "rs-ada-old", "rs-sam"]);
    let first = &answer["sessions"][0];
    assert_eq!(
        first,
        &json!({
            "id": "rs-ada-live",
            "workspace_id": "ws-atlas",
            "title": "Wire the org tools",
            "author": { "user_id": "u-1", "name": "Ada Lovelace" },
            "agent": "atlas-agent",
            "model": "claude-opus-5-5",
            "started_at": first["started_at"],
            "last_activity_at": first["last_activity_at"],
            "live": true,
            "counts": { "messages": 12, "tool_calls": 7, "checkpoints": 2 },
            "insertions": 40,
            "deletions": 3,
            "files_touched": 4,
            "total_tokens": 91_000,
        }),
    );
    assert_eq!(answer["window"]["default"], json!(true));
    assert!(answer["window"]["since"].is_string() && answer["window"]["until"].is_null());
    assert_eq!(answer["workspace"], json!({ "id": "ws-atlas" }));
    assert_eq!(answer["truncated"], json!(false));
    assert_eq!(answer["scanned"], json!(4), "the three-week-old row ends the walk and is not counted");
    assert!(notes(&answer).contains("only the last 14 days were searched"), "{answer}");
    assert_eq!(
        org.asked(),
        [("org-acme".to_string(), "board ws-atlas q=None cursor=None".to_string())],
        "one page of the grant's Workspace, in the grant's organisation",
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_explicit_window_holds_the_sessions_that_overlap_it_and_says_nothing_of_a_default() {
    let org = boarded();
    let (_server, client) = org_client(org).await;
    // Six to three days ago: Ada's older session (5 days) overlaps; Grace's
    // (2 days) started after the window; Sam's (10 days) ended before it.
    let since = (chrono::Utc::now() - chrono::Duration::days(6)).format("%Y-%m-%d").to_string();
    let until = (chrono::Utc::now() - chrono::Duration::days(3)).to_rfc3339();
    let (err, answer) = call_json(&client, "org_sessions", json!({ "since": since, "until": until })).await;
    assert!(!err, "{answer}");
    assert_eq!(session_ids(&answer), ["rs-ada-old"]);
    assert_eq!(answer["window"]["default"], json!(false));
    assert!(answer["window"]["since"].as_str().unwrap().starts_with(&since));
    assert!(!notes(&answer).contains("14 days"), "{answer}");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn only_until_lifts_the_default_window() {
    let org = boarded();
    let (_server, client) = org_client(org).await;
    let until = (chrono::Utc::now() - chrono::Duration::days(15)).format("%Y-%m-%d").to_string();
    let (err, answer) = call_json(&client, "org_sessions", json!({ "until": until })).await;
    assert!(!err, "{answer}");
    assert_eq!(session_ids(&answer), ["rs-grace-old"]);
    assert!(answer["window"]["since"].is_null());
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_since_or_until_that_is_not_a_date_is_refused_before_the_board_is_read() {
    let org = boarded();
    let (_server, client) = org_client(org.clone()).await;
    for args in [json!({ "since": "last tuesday" }), json!({ "until": "2026-13-45" })] {
        let (err, text) = call(&client, "org_sessions", args).await;
        assert!(err);
        assert!(text.contains("is not an ISO date or datetime"), "{text}");
    }
    assert_eq!(org.board_reads(), 0);
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_author_filter_resolves_a_name_and_keeps_only_their_sessions() {
    let org = boarded();
    let (_server, client) = org_client(org).await;
    let (err, answer) = call_json(&client, "org_sessions", json!({ "author": "grace@acme.dev", "since": "2000-01-01" })).await;
    assert!(!err, "{answer}");
    assert_eq!(session_ids(&answer), ["rs-grace", "rs-grace-old"]);
    assert_eq!(answer["author"], json!({ "user_id": "u-grace", "name": "Grace Hopper" }));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_author_name_several_members_share_comes_back_as_candidates_and_the_board_is_not_read() {
    let org = boarded();
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_sessions", json!({ "author": "Sam Lee" })).await;
    assert!(err);
    assert_eq!(answer["candidates"].as_array().unwrap().len(), 2, "{answer}");
    assert_eq!(org.board_reads(), 0);
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn my_last_session_is_the_newest_by_last_activity_among_my_own() {
    let org = boarded();
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_sessions", json!({ "author": "me", "limit": 1 })).await;
    assert!(!err, "{answer}");
    assert_eq!(session_ids(&answer), ["rs-ada-live"], "not Ada's older one, nor Grace's in between");
    assert_eq!(answer["author"], json!({ "user_id": "u-1", "name": "Ada Lovelace" }));
    assert_eq!(answer["limit_reached"], json!(true));
    assert!(notes(&answer).contains("raise limit"), "{answer}");
    assert!(org.asked().contains(&("org-acme".to_string(), "caller".to_string())), "\"me\" is the caller");
    assert!(!org.asked().iter().any(|(_, what)| what == "members"), "\"me\" needs no roster");

    let (_, mine) = call_json(&client, "org_sessions", json!({ "author": "ME" })).await;
    assert_eq!(session_ids(&mine), ["rs-ada-live", "rs-ada-old"]);
    assert_eq!(mine["limit_reached"], json!(false));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_live_filter_keeps_sessions_still_being_written_or_only_finished_ones() {
    let org = boarded();
    let (_server, client) = org_client(org).await;
    let (_, live) = call_json(&client, "org_sessions", json!({ "live": true })).await;
    assert_eq!(session_ids(&live), ["rs-ada-live"]);
    let (_, done) = call_json(&client, "org_sessions", json!({ "live": false })).await;
    assert_eq!(session_ids(&done), ["rs-grace", "rs-ada-old", "rs-sam"]);
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_keyword_is_passed_through_to_the_servers_search() {
    let org = boarded();
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_sessions", json!({ "q": "theme" })).await;
    assert!(!err, "{answer}");
    assert_eq!(session_ids(&answer), ["rs-grace", "rs-sam"]);
    assert_eq!(org.asked(), [("org-acme".to_string(), "board ws-atlas q=Some(\"theme\") cursor=None".to_string())]);
    client.cancel().await.ok();
}

/// `n` sessions by Grace, one a minute apart, the newest a minute ago.
fn busy_board(n: i64) -> Vec<RemoteSession> {
    (1..=n).map(|i| board_row(&format!("rs-{i:04}"), "u-grace", i + 30, i, false, "Busy work")).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_scan_stops_at_five_hundred_sessions_and_says_how_to_narrow_or_go_further_back() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer))
        .with_roster(acme_roster())
        .with_board(busy_board(650));
    let (_server, client) = org_client(org.clone()).await;
    // Ada has none of them, so nothing ends the walk but the cap.
    let (err, answer) = call_json(&client, "org_sessions", json!({ "author": "me" })).await;
    assert!(!err, "{answer}");
    assert_eq!(session_ids(&answer), Vec::<String>::new());
    assert_eq!(answer["scanned"], json!(SESSIONS_SCAN_CAP));
    assert_eq!(answer["truncated"], json!(true));
    let said = notes(&answer);
    assert!(said.contains("scanning the 500 most recently active"), "{said}");
    assert!(said.contains("Narrow with author, q or a shorter since/until window"), "{said}");
    let oldest = org.board.lock().iter().find(|s| s.id == "rs-0500").unwrap().last_activity_at.clone();
    assert!(said.contains(&format!("until={oldest}")), "where to pick up: {said}");
    assert_eq!(org.board_reads(), 5, "five pages of a hundred, and not a sixth");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_window_that_ends_before_the_cap_is_not_truncated() {
    let mut board = busy_board(300);
    board.extend((0..350).map(|i| board_row(&format!("rs-old-{i:04}"), "u-grace", 20 * DAY + i + 30, 20 * DAY + i, false, "Old")));
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer)).with_roster(acme_roster()).with_board(board);
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_sessions", json!({ "author": "me" })).await;
    assert!(!err, "{answer}");
    assert_eq!(answer["scanned"], json!(300));
    assert_eq!(answer["truncated"], json!(false));
    assert!(!notes(&answer).contains("Stopped after scanning"), "{answer}");
    assert_eq!(org.board_reads(), 4, "the page holding the window's end is the last read");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn exactly_five_hundred_sessions_and_the_end_of_the_board_is_not_truncated() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer)).with_board(busy_board(500));
    let (_server, client) = org_client(org).await;
    let (_, answer) = call_json(&client, "org_sessions", json!({ "author": "me" })).await;
    assert_eq!(answer["scanned"], json!(500));
    assert_eq!(answer["truncated"], json!(false));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_workspace_argument_reads_another_workspace_in_the_organisation_and_defaults_to_the_grants() {
    let org = boarded();
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_sessions", json!({ "workspace": "ws-other" })).await;
    assert!(!err, "{answer}");
    assert_eq!(answer["workspace"], json!({ "id": "ws-other" }));
    assert_eq!(session_ids(&answer), ["rs-elsewhere"]);
    assert_eq!(answer["sessions"][0]["workspace_id"], json!("ws-other"), "each row says where to open it");
    assert!(
        org.asked().iter().any(|(o, what)| o == "org-acme" && what.starts_with("board ws-other")),
        "asked in the grant's organisation",
    );

    let (_, answer) = call_json(&client, "org_sessions", json!({})).await;
    assert_eq!(answer["workspace"], json!({ "id": "ws-atlas" }), "the grant's by default");
    assert!(!session_ids(&answer).contains(&"rs-elsewhere".to_string()));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_board_that_cannot_be_read_is_a_tool_error() {
    let org = boarded();
    org.board_fail.store(true, Ordering::SeqCst);
    let (_server, client) = org_client(org).await;
    let (err, text) = call(&client, "org_sessions", json!({})).await;
    assert!(err);
    assert!(text.contains("could not be reached"), "{text}");
    client.cancel().await.ok();
}

// ── org_session ──────────────────────────────────────────────────────────────

// ── org_member_activity ──────────────────────────────────────────────────────

/// [`boarded`], with the caller in `role`.
fn boarded_as(role: Option<Role>) -> Arc<FakeOrganisation> {
    FakeOrganisation::with_member("Ada Lovelace", role).with_roster(acme_roster()).with_board(acme_board())
}

async fn offered_names(org: Arc<FakeOrganisation>) -> Vec<String> {
    let (_server, client) = org_client(org).await;
    let names = client.list_all_tools().await.unwrap().into_iter().map(|t| t.name.to_string()).collect();
    client.cancel().await.ok();
    names
}

#[tokio::test(flavor = "multi_thread")]
async fn an_admin_is_offered_org_member_activity_and_no_other_role_is() {
    let names = offered_names(boarded_as(Some(Role::Admin))).await;
    assert!(names.contains(&"org_member_activity".to_string()), "{names:?}");
    assert_eq!(names, tool_names(true));

    for role in [Some(Role::ProductOwner), Some(Role::Developer), Some(Role::Member), None] {
        let names = offered_names(boarded_as(role)).await;
        assert!(!names.contains(&"org_member_activity".to_string()), "{role:?} is offered it: {names:?}");
        assert_eq!(names, tool_names(false), "{role:?} is offered everything else");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_caller_that_cannot_be_read_is_not_offered_org_member_activity() {
    let org = Arc::new(FakeOrganisation::default()).with_board(acme_board());
    let names = offered_names(org).await;
    assert!(!names.contains(&"org_member_activity".to_string()), "{names:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_non_admin_calling_org_member_activity_anyway_is_refused_and_nothing_is_read() {
    for role in [Some(Role::ProductOwner), Some(Role::Developer), Some(Role::Member), None] {
        let org = boarded_as(role);
        let (_server, client) = org_client(org.clone()).await;
        let (err, text) = call(&client, "org_member_activity", json!({ "member": "Grace Hopper" })).await;
        assert!(err, "{role:?}: {text}");
        assert!(text.contains("Only an organisation admin"), "{text}");
        assert_eq!(org.board_reads(), 0, "{role:?}");
        assert!(!org.asked().iter().any(|(_, what)| what == "members"), "{role:?}: the roster is not read");
        client.cancel().await.ok();
    }
}

#[test]
fn org_member_activity_is_described_as_recorded_activity_not_performance() {
    let tool = tools().into_iter().find(|t| t.name == "org_member_activity").unwrap();
    let description = tool.description.unwrap();
    assert!(description.contains("recorded through Atlas, not a measure of performance"), "{description}");
    assert!(RECORDED_NOTE.contains("recorded through Atlas, not a measure of performance"));
}

#[tokio::test(flavor = "multi_thread")]
async fn org_member_activity_totals_the_members_recorded_sessions_of_the_last_fourteen_days() {
    let org = boarded_as(Some(Role::Admin));
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_member_activity", json!({ "member": "grace@acme.dev" })).await;
    assert!(!err, "{answer}");

    assert_eq!(answer["member"], json!({ "user_id": "u-grace", "name": "Grace Hopper" }));
    assert_eq!(answer["workspace"], json!({ "id": "ws-atlas" }));
    assert_eq!(answer["window"]["default"], json!(true));
    // Grace's two-day-old session only: her three-week-old one is outside
    // the window, and Ada's and Sam's are not hers.
    assert_eq!(
        answer["totals"],
        json!({
            "recorded_sessions": 1,
            "checkpoints": 2,
            "insertions": 40,
            "deletions": 3,
            "files_touched": 4,
            "total_tokens": 91_000,
        }),
    );
    let row = &answer["sessions"][0];
    assert_eq!(
        row,
        &json!({
            "id": "rs-grace",
            "title": "Fix the theme importer",
            "last_activity_at": row["last_activity_at"],
            "checkpoints": 2,
            "insertions": 40,
            "deletions": 3,
            "files_touched": 4,
            "total_tokens": 91_000,
        }),
    );
    assert_eq!(answer["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(answer["more_sessions"], json!(0));
    assert_eq!(answer["scanned"], json!(4), "the same walk as org_sessions: the three-week-old row ends it");
    assert_eq!(answer["truncated"], json!(false));
    let said = notes(&answer);
    assert!(said.contains("recorded through Atlas, not a measure of performance"), "{said}");
    assert!(said.contains("only the last 14 days were searched"), "{said}");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_explicit_window_totals_every_recorded_session_of_the_member_in_it() {
    let org = boarded_as(Some(Role::Admin));
    let (_server, client) = org_client(org).await;
    let (err, answer) =
        call_json(&client, "org_member_activity", json!({ "member": "u-grace", "since": "2000-01-01" })).await;
    assert!(!err, "{answer}");
    assert_eq!(session_ids(&answer), ["rs-grace", "rs-grace-old"], "newest first");
    assert_eq!(answer["totals"]["recorded_sessions"], json!(2));
    assert_eq!(answer["totals"]["insertions"], json!(80));
    assert_eq!(answer["totals"]["total_tokens"], json!(182_000));
    assert_eq!(answer["window"]["default"], json!(false));
    assert!(!notes(&answer).contains("14 days"), "{answer}");

    let until = (chrono::Utc::now() - chrono::Duration::days(15)).format("%Y-%m-%d").to_string();
    let (_, older) = call_json(&client, "org_member_activity", json!({ "member": "u-grace", "until": until })).await;
    assert_eq!(session_ids(&older), ["rs-grace-old"]);
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_activity_scan_stops_at_five_hundred_sessions_lists_twenty_and_totals_every_one_read() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Admin))
        .with_roster(acme_roster())
        .with_board(busy_board(650));
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_member_activity", json!({ "member": "Grace Hopper" })).await;
    assert!(!err, "{answer}");
    assert_eq!(answer["scanned"], json!(SESSIONS_SCAN_CAP));
    assert_eq!(answer["truncated"], json!(true));
    assert_eq!(answer["totals"]["recorded_sessions"], json!(500));
    assert_eq!(answer["totals"]["checkpoints"], json!(1_000));
    assert_eq!(answer["sessions"].as_array().unwrap().len(), ACTIVITY_ROWS);
    assert_eq!(answer["sessions"][0]["id"], json!("rs-0001"), "most recently active first");
    assert_eq!(answer["more_sessions"], json!(500 - ACTIVITY_ROWS));
    let said = notes(&answer);
    assert!(said.contains("scanning the 500 most recently active"), "{said}");
    assert!(said.contains("Narrow with a shorter since/until window"), "{said}");
    assert!(said.contains("the totals cover all 500"), "{said}");
    assert_eq!(org.board_reads(), 5, "the same cap as org_sessions");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_member_name_several_share_comes_back_as_candidates_and_the_board_is_not_read() {
    let org = boarded_as(Some(Role::Admin));
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_member_activity", json!({ "member": "Sam Lee" })).await;
    assert!(err);
    assert_eq!(answer["candidates"].as_array().unwrap().len(), 2, "{answer}");
    assert_eq!(org.board_reads(), 0);

    let (err, text) = call(&client, "org_member_activity", json!({})).await;
    assert!(err);
    assert!(text.contains("name the member"), "{text}");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_403_from_the_organisation_is_a_readable_tool_error() {
    let org = boarded_as(Some(Role::Admin));
    org.board_forbidden.store(true, Ordering::SeqCst);
    let (_server, client) = org_client(org).await;
    let (err, text) = call(&client, "org_member_activity", json!({ "member": "Grace Hopper" })).await;
    assert!(err);
    assert!(text.contains("refused this account a member's recorded activity (403 forbidden)"), "{text}");
    assert!(text.contains("only an organisation admin can read it"), "{text}");
    client.cancel().await.ok();
}

fn timeline_entry(id: &str, kind: &str, turn: i64) -> RemoteEntry {
    RemoteEntry { id: id.into(), kind: kind.into(), at: format!("2026-09-26T10:0{turn}:00Z"), turn_seq: turn, ..Default::default() }
}

/// An organisation whose chat `s1` is recorded as `rs-1` (on the board, with
/// four entries in the server's order) beside Grace's `rs-grace`, with the
/// full text of `rs-1`'s tool call.
fn timelined() -> Arc<FakeOrganisation> {
    let mut board = acme_board();
    board.push(board_row("rs-1", "u-1", 30, 5, true, ""));
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer)).with_roster(acme_roster()).with_board(board);
    org.record("s1", current(true));
    let prompt = RemoteEntry { text: Some("fix the importer".into()), ..timeline_entry("e1", "prompt", 1) };
    let tool = RemoteEntry {
        tool_name: Some("edit".into()),
        tool_status: Some("completed".into()),
        paths: vec!["src/theme.rs".into()],
        result: Some("ok…".into()),
        truncated: true,
        body_bytes: 9_000,
        ..timeline_entry("e2", "tool_call", 1)
    };
    let checkpoint = RemoteEntry {
        commit_sha: Some("abc123".into()),
        insertions: 4,
        deletions: 1,
        files: vec!["src/theme.rs".into()],
        ..timeline_entry("e3", "checkpoint", 1)
    };
    let reply = RemoteEntry { text: Some("done".into()), ..timeline_entry("e4", "response", 2) };
    org.timelines.lock().insert("rs-1".into(), vec![prompt, tool, checkpoint, reply]);
    org.timelines.lock().insert("rs-grace".into(), vec![timeline_entry("g1", "prompt", 1)]);
    org.payloads.lock().insert(
        ("rs-1".into(), "e2".into(), "result".into()),
        EntryPayload { text: Some("ok, the whole result".into()), binary: false, bytes: 9_000 },
    );
    org.payloads.lock().insert(
        ("rs-1".into(), "e1".into(), "body".into()),
        EntryPayload { text: Some("fix the importer, all of it".into()), binary: false, bytes: 27 },
    );
    org
}

fn entry_ids(answer: &Value) -> Vec<String> {
    answer["entries"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap().to_string()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn org_session_with_no_arguments_reads_the_current_session_and_its_entries_in_the_servers_order() {
    let org = timelined();
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_session", json!({})).await;
    assert!(!err, "{answer}");

    let session = &answer["session"];
    assert_eq!(session["id"], json!("rs-1"));
    assert_eq!(session["current"], json!(true));
    assert_eq!(session["title"], json!("Fix the theme importer"), "an untitled row takes the chat's own title");
    assert_eq!(session["author"], json!({ "user_id": "u-1", "name": "Ada Lovelace" }));
    assert_eq!(session["counts"]["tool_calls"], json!(1));
    assert_eq!(entry_ids(&answer), ["e1", "e2", "e3", "e4"]);
    assert_eq!(
        answer["entries"][1],
        json!({
            "id": "e2", "kind": "tool_call", "at": "2026-09-26T10:01:00Z", "turn": 1,
            "truncated": true, "body_bytes": 9_000,
            "tool_name": "edit", "tool_status": "completed", "result": "ok…",
            "paths": ["src/theme.rs"],
        }),
        "only the fields a tool call has",
    );
    assert_eq!(
        answer["entries"][2],
        json!({
            "id": "e3", "kind": "checkpoint", "at": "2026-09-26T10:01:00Z", "turn": 1,
            "commit_sha": "abc123", "files": ["src/theme.rs"], "insertions": 4, "deletions": 1,
        }),
    );
    assert_eq!(answer["next_cursor"], Value::Null);
    assert_eq!(
        org.asked(),
        [
            ("org-acme".to_string(), "current s1 in /p".to_string()),
            ("org-acme".to_string(), format!("timeline ws-atlas/rs-1 cursor=None limit=Some({TIMELINE_DEFAULT_LIMIT})")),
        ],
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn org_session_reads_the_current_sentinel_as_the_current_session() {
    let org = timelined();
    let (_server, client) = org_client(org).await;
    let (_, default) = call_json(&client, "org_session", json!({})).await;
    let (err, answer) = call_json(&client, "org_session", json!({ "session": "current" })).await;
    assert!(!err, "{answer}");
    assert_eq!(answer, default);
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn org_session_reads_any_recorded_session_by_id() {
    let org = timelined();
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_session", json!({ "session": "rs-grace" })).await;
    assert!(!err, "{answer}");
    assert_eq!(answer["session"]["id"], json!("rs-grace"));
    assert_eq!(answer["session"]["title"], json!("Fix the theme importer"));
    assert_eq!(answer["session"]["current"], json!(false));
    assert_eq!(entry_ids(&answer), ["g1"]);
    assert!(!org.asked().iter().any(|(_, what)| what.starts_with("current")));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn org_session_pages_its_entries_with_the_servers_cursor() {
    let org = timelined();
    let (_server, client) = org_client(org).await;
    let (_, first) = call_json(&client, "org_session", json!({ "limit": 3 })).await;
    assert_eq!(entry_ids(&first), ["e1", "e2", "e3"]);
    let cursor = first["next_cursor"].as_str().expect("more to read").to_string();
    let (_, rest) = call_json(&client, "org_session", json!({ "limit": 3, "cursor": cursor })).await;
    assert_eq!(entry_ids(&rest), ["e4"]);
    assert_eq!(rest["next_cursor"], Value::Null);
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_entry_argument_answers_that_entrys_full_text() {
    let org = timelined();
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_session", json!({ "entry": "e2", "part": "result" })).await;
    assert!(!err, "{answer}");
    assert_eq!(
        answer,
        json!({
            "session": { "id": "rs-1", "title": "Fix the theme importer", "current": true },
            "entry": { "id": "e2", "part": "result", "text": "ok, the whole result", "binary": false, "bytes": 9_000 },
        }),
    );
    let (_, body) = call_json(&client, "org_session", json!({ "entry": "e1" })).await;
    assert_eq!(body["entry"]["text"], json!("fix the importer, all of it"), "the body by default");
    assert!(org.asked().contains(&("org-acme".to_string(), "payload ws-atlas/rs-1/e2 part=result".to_string())));
    assert!(!org.asked().iter().any(|(_, what)| what.starts_with("timeline")), "an entry read reads no page");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_part_that_is_not_body_arguments_or_result_is_refused_before_anything_is_asked() {
    let org = timelined();
    let (_server, client) = org_client(org.clone()).await;
    let (err, text) = call(&client, "org_session", json!({ "entry": "e2", "part": "diff" })).await;
    assert!(err);
    assert!(text.contains("not one of body, arguments or result"), "{text}");
    assert!(org.asked().is_empty());
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn org_session_on_a_chat_not_recorded_yet_says_so_and_points_at_org_sessions() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None);
    let (_server, client) = org_client(org.clone()).await;
    let (err, text) = call(&client, "org_session", json!({})).await;
    assert!(err);
    assert!(text.contains(NOT_RECORDED_YET) && text.contains("org_sessions"), "{text}");
    assert!(!org.asked().iter().any(|(_, what)| what.starts_with("timeline")));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_or_entry_the_organisation_cannot_give_is_a_tool_error() {
    let org = timelined();
    let (_server, client) = org_client(org.clone()).await;
    let (err, text) = call(&client, "org_session", json!({ "session": "rs-nope" })).await;
    assert!(err && text.contains("not found"), "{text}");
    let (err, text) = call(&client, "org_session", json!({ "entry": "e9" })).await;
    assert!(err && text.contains("not found"), "{text}");
    org.timeline_fail.store(true, Ordering::SeqCst);
    let (err, text) = call(&client, "org_session", json!({})).await;
    assert!(err && text.contains("could not be reached"), "{text}");
    client.cancel().await.ok();
}

// ── Refusals ─────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn switching_organisation_access_off_refuses_the_next_call_of_a_running_session() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer));
    let (gate, on) = switchable(true);
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(tokens.clone(), org.clone(), gate).await;
    let client = connect(&server.url_at(ORG_PATH), &offered_token(&tokens, "s1", "/p", Some(acme())))
        .await
        .unwrap();
    assert!(!call(&client, "org_whoami", json!({})).await.0);
    let asked = org.asked().len();

    on.store(false, Ordering::SeqCst);
    let (err, text) = call(&client, "org_whoami", json!({})).await;
    assert!(err);
    assert!(text.contains("switched off"), "{text}");
    assert_eq!(org.asked().len(), asked, "nothing reached the organisation");
    client.cancel().await.ok();
}

/// A client on a grant offered for Acme, with the account and the binding the
/// test changes while the session runs.
async fn rechecked_client(
    org: Arc<FakeOrganisation>,
) -> (MemoryServer, RunningService<RoleClient, ()>, Arc<FakeSessionOrgs>) {
    let orgs = bound_to_acme();
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve_tools(tokens.clone(), OrgTools::new(org, setting(true), orgs.clone())).await;
    let client = connect(&server.url_at(ORG_PATH), &offered_token(&tokens, "s1", "/p", Some(acme())))
        .await
        .unwrap();
    (server, client, orgs)
}

#[tokio::test(flavor = "multi_thread")]
async fn signing_out_refuses_the_next_call_of_a_running_session() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer));
    let (_server, client, orgs) = rechecked_client(org.clone()).await;
    assert!(!call(&client, "org_whoami", json!({})).await.0);
    let asked = org.asked().len();

    orgs.sign_out();
    let (err, text) = call(&client, "org_whoami", json!({})).await;
    assert!(err);
    assert!(text.contains("sign in"), "{text}");
    assert_eq!(org.asked().len(), asked, "nothing reached the organisation");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn unbinding_the_project_refuses_the_next_call_of_a_running_session() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer));
    let (_server, client, orgs) = rechecked_client(org.clone()).await;
    assert!(!call(&client, "org_whoami", json!({})).await.0);
    let asked = org.asked().len();

    orgs.rebind(None);
    let (err, text) = call(&client, "org_whoami", json!({})).await;
    assert!(err);
    assert!(text.contains("no longer bound"), "{text}");
    assert!(text.contains("this chat was given access to."), "one sentence, no stray run of spaces: {text}");
    assert_eq!(org.asked().len(), asked, "nothing reached the organisation");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_project_bound_elsewhere_now_refuses_the_next_call_of_a_running_session() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer));
    let (_server, client, orgs) = rechecked_client(org.clone()).await;
    for elsewhere in [
        OrgScope { org_id: "org-acme".into(), workspace_id: Some("ws-other".into()) },
        OrgScope { org_id: "org-globex".into(), workspace_id: Some("ws-atlas".into()) },
    ] {
        orgs.rebind(Some(elsewhere.clone()));
        let (err, text) = call(&client, "org_whoami", json!({})).await;
        assert!(err, "{elsewhere:?}");
        assert!(text.contains("no longer bound"), "{text}");
    }
    assert!(org.asked().is_empty(), "nothing reached either organisation");
    client.cancel().await.ok();
}

/// A token minted without the organisation — a session the offer left it out
/// of, or one the session lifecycle re-minted — names no organisation, and
/// the tools do not pick one for it.
#[tokio::test(flavor = "multi_thread")]
async fn a_token_that_names_no_organisation_is_refused_and_nothing_is_asked() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer));
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(tokens.clone(), org.clone(), setting(true)).await;
    let client = connect(&server.url_at(ORG_PATH), &tokens.mint("s1", "atlas-agent", "/p")).await.unwrap();
    let (err, text) = call(&client, "org_whoami", json!({})).await;
    assert!(err);
    assert!(text.contains("not given access to an organisation"), "{text}");
    assert!(org.asked().is_empty());
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_or_revoked_token_is_refused_on_the_org_path() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer));
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(tokens.clone(), org, setting(true)).await;
    assert!(connect(&server.url_at(ORG_PATH), "not-a-token").await.is_err());
    let token = offered_token(&tokens, "s1", "/p", Some(acme()));
    tokens.revoke("s1");
    assert!(connect(&server.url_at(ORG_PATH), &token).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_tool_list_is_what_the_model_is_offered() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer));
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(tokens.clone(), org, setting(true)).await;
    let client = connect(&server.url_at(ORG_PATH), &offered_token(&tokens, "s1", "/p", Some(acme())))
        .await
        .unwrap();
    let names: Vec<String> = client.list_all_tools().await.unwrap().into_iter().map(|t| t.name.to_string()).collect();
    assert_eq!(names, tool_names(false));
    assert_eq!(
        names,
        [
            "org_whoami",
            "org_members",
            "org_conversations",
            "org_inbox",
            "org_comments",
            "org_comment_resolve",
            "org_comment_reply",
            "org_send",
            "org_sessions",
            "org_session",
            "org_page_create",
            "org_page_write"
        ]
    );
    client.cancel().await.ok();
}

#[test]
fn the_tool_list_carries_the_cache_fields_the_2026_07_28_spec_requires() {
    let list = serde_json::to_value(tools_list(false)).unwrap();
    assert_eq!(list["ttlMs"], json!(TOOLS_LIST_TTL_MS));
    assert_eq!(list["cacheScope"], json!("private"));
}

#[test]
fn the_instructions_state_the_protocol_in_three_sentences_or_fewer() {
    assert!(INSTRUCTIONS.contains("Call org_whoami first"));
    assert!(INSTRUCTIONS.contains("ask the user which one"));
    assert!(INSTRUCTIONS.matches(". ").count() + 1 <= 3, "{INSTRUCTIONS}");
}

/// The Chat Completions wire drops a server's instructions (`reshape_tools`
/// sends only its tools), so every rule that must reach the model is in a
/// tool's or a property's description too.
#[test]
fn the_rules_the_model_must_see_ride_in_the_tool_descriptions() {
    let all = tools();
    let tool = |name: &str| all.iter().find(|t| t.name == name).unwrap();
    let described = |name: &str| tool(name).description.as_deref().unwrap_or_default().to_string();
    let property = |name: &str, key: &str| tool(name).input_schema["properties"][key]["description"].clone();
    assert!(described("org_whoami").contains("call first"));
    for outward in OUTWARD_TOOLS {
        assert!(described(outward).contains("the user approves first"), "{outward}");
    }
    assert!(described("org_inbox").contains("read-only"));
    assert!(property("org_send", "to").as_str().is_some_and(|d| d.contains("atlas-org:// link")));
    for session_tool in ["org_comments", "org_session", "org_send"] {
        assert!(property(session_tool, "session").as_str().is_some_and(|d| d.contains("current")), "{session_tool}");
    }
}

/// The **fixed-prefix cost** the server adds to every native turn, measured
/// the way `docs/research/native-agent-input-tokens-measured.md` measured the
/// engine's own tools: the exact JSON bytes of the `tools/list` answer (for a
/// member and for an admin, who is offered one tool more), the same tools as
/// the Chat Completions dialect puts them on the wire (`atlas_chat::request`,
/// `reshape_one`: one flat `function` per tool, named `atlas_org__<tool>`),
/// and the instructions. Recorded in `docs/research/org-tool-server-prefix.md`;
/// reproduce with
/// `cargo test -p atlas --lib org_server_prefix -- --nocapture`.
#[test]
fn org_server_prefix_bytes_are_measured() {
    fn wire(tool: &rmcp::model::Tool) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": format!("{ORG_SERVER_NAME}__{}", tool.name),
                "description": tool.description.as_deref().unwrap_or_default(),
                "parameters": Value::Object((*tool.input_schema).clone()),
            }
        })
    }
    let bytes = |v: &Value| serde_json::to_vec(v).unwrap().len();

    let member_list = bytes(&serde_json::to_value(tools_list(false)).unwrap());
    let admin_list = bytes(&serde_json::to_value(tools_list(true)).unwrap());
    let mut per_tool: Vec<(usize, String)> = tools().iter().map(|t| (bytes(&wire(t)), t.name.to_string())).collect();
    let wire_total = |admin: bool| -> usize {
        per_tool.iter().filter(|(_, n)| admin || !ADMIN_TOOLS.contains(&n.as_str())).map(|(b, _)| b).sum()
    };
    let (member_wire, admin_wire) = (wire_total(false), wire_total(true));
    per_tool.sort_by(|a, b| b.0.cmp(&a.0));

    println!("tools/list JSON: member {member_list} B, admin {admin_list} B");
    println!("Chat wire tools: member {member_wire} B, admin {admin_wire} B");
    println!("INSTRUCTIONS: {} B", INSTRUCTIONS.len());
    for (b, name) in &per_tool {
        println!("  {b:>5} B  {name}");
    }
    if std::env::var_os("ORG_PREFIX_DUMP").is_some() {
        for t in tools() {
            println!("{}", wire(&t));
        }
    }

    assert_eq!(per_tool.len(), tool_names(true).len(), "every tool measured");
    assert!(admin_list > member_list && admin_wire > member_wire, "an admin is offered one tool more");
    // The budget the research note records (the spec's ~3 KB): a member's tools
    // on the Chat wire stay within 3.5 KB, so a description that grows past it
    // is a prefix cost to decide on, not to drift into.
    assert!(member_wire <= 3_500, "a member's org tools on the Chat wire stay within 3.5 KB ({member_wire} B)");
    assert!(admin_wire + INSTRUCTIONS.len() < 4_500, "an admin's, with the instructions, within 4.5 KB");
}

// ── The audit trail ──────────────────────────────────────────────────────────

/// The server with an audit sink that keeps every record it is handed, as the
/// app's sink emits each one to the window for its Logs panel.
async fn serve_audited(
    tokens: Arc<MemoryTokens>,
    cloud: Arc<dyn OrganisationCloud>,
    gate: OrgAccessGate,
) -> (MemoryServer, Arc<Mutex<Vec<OrgActionRecord>>>) {
    let records = Arc::new(Mutex::new(Vec::new()));
    let sink = records.clone();
    let audit: OrgAudit = Arc::new(move |record: &OrgActionRecord| sink.lock().push(record.clone()));
    let server = MemoryServer::start_with(
        memory(),
        tokens,
        Arc::new(SessionClocks::default()),
        Arc::new(SessionReads::default()),
        sharing(true),
        Sources::default(),
        vec![quiet_ui(), router(OrgTools::new(cloud, gate, bound_to_acme()).with_audit(audit))],
    )
    .await
    .unwrap();
    (server, records)
}

#[tokio::test(flavor = "multi_thread")]
async fn every_org_call_writes_one_audit_record_naming_the_session_the_tool_its_arguments_and_the_answer() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer)).with_roster(acme_roster());
    let tokens = Arc::new(MemoryTokens::default());
    let (server, records) = serve_audited(tokens.clone(), org, setting(true)).await;
    let client = connect(&server.url_at(ORG_PATH), &offered_token(&tokens, "s1", "/p", Some(acme())))
        .await
        .unwrap();

    let (_, answer) = call(&client, "org_whoami", json!({})).await;
    {
        let records = records.lock();
        assert_eq!(records.len(), 1, "one call, one record");
        let record = &records[0];
        assert_eq!(record.session_id, "s1");
        assert_eq!(record.agent, "atlas-agent");
        assert_eq!(record.tool, "org_whoami");
        assert_eq!(record.arguments, json!({}));
        assert!(record.ok);
        assert_eq!(record.text, answer, "the record carries what the model was answered");
    }

    let (_, answer) = call(&client, "org_members", json!({ "name": "Grace Hopper" })).await;
    let records = records.lock();
    assert_eq!(records.len(), 2, "each call adds exactly one record");
    assert_eq!(records[1].tool, "org_members");
    assert_eq!(records[1].arguments, json!({ "name": "Grace Hopper" }));
    assert!(records[1].ok);
    assert_eq!(records[1].text, answer);
    drop(records);
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_call_that_fails_is_one_audit_record_that_says_why() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer)).with_roster(acme_roster());
    let tokens = Arc::new(MemoryTokens::default());
    let (server, records) = serve_audited(tokens.clone(), org, setting(true)).await;
    let client = connect(&server.url_at(ORG_PATH), &offered_token(&tokens, "s1", "/p", Some(acme())))
        .await
        .unwrap();

    let (err, answer) = call(&client, "org_members", json!({ "name": "Sam Lee" })).await;
    assert!(err);
    let records = records.lock();
    assert_eq!(records.len(), 1);
    assert!(!records[0].ok);
    assert_eq!(records[0].text, answer);
    assert!(records[0].text.contains("ask the user which one"), "{}", records[0].text);
    drop(records);
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_call_is_one_audit_record_that_says_why() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer));
    let (gate, on) = switchable(false);
    let tokens = Arc::new(MemoryTokens::default());
    let (server, records) = serve_audited(tokens.clone(), org, gate).await;
    let client = connect(&server.url_at(ORG_PATH), &offered_token(&tokens, "s1", "/p", Some(acme())))
        .await
        .unwrap();
    assert!(call(&client, "org_whoami", json!({})).await.0);
    on.store(true, Ordering::SeqCst);
    let no_org = connect(&server.url_at(ORG_PATH), &tokens.mint("s2", "atlas-agent", "/q")).await.unwrap();
    assert!(call(&no_org, "org_conversations", json!({})).await.0);

    let records = records.lock();
    assert_eq!(records.len(), 2, "one record per refused call");
    assert_eq!(records[0].tool, "org_whoami");
    assert!(!records[0].ok);
    assert!(records[0].text.contains("switched off"), "{}", records[0].text);
    assert_eq!(records[1].session_id, "s2");
    assert_eq!(records[1].tool, "org_conversations");
    assert!(!records[1].ok);
    assert!(records[1].text.contains("not given access to an organisation"), "{}", records[1].text);
    drop(records);
    client.cancel().await.ok();
    no_org.cancel().await.ok();
}

#[test]
fn an_audit_record_reaches_the_window_in_its_wire_shape() {
    let record = OrgActionRecord {
        session_id: "s1".into(),
        agent: "atlas-agent".into(),
        tool: "org_members".into(),
        arguments: json!({ "name": "Grace" }),
        ok: false,
        text: "no member matches".into(),
    };
    assert_eq!(
        serde_json::to_value(&record).unwrap(),
        json!({
            "sessionId": "s1",
            "agent": "atlas-agent",
            "tool": "org_members",
            "arguments": { "name": "Grace" },
            "ok": false,
            "text": "no member matches",
        }),
    );
    assert_eq!(ORG_ACTION_EVENT, "atlas:org-action");
}

// ── Handing the server to sessions ───────────────────────────────────────────

/// The account and the Project's binding as the offer sees them, counting
/// how often each is read.
struct FakeSessionOrgs {
    signed_in: AtomicBool,
    bound: Mutex<Option<OrgScope>>,
    reads: AtomicUsize,
}

impl FakeSessionOrgs {
    fn new(signed_in: bool, bound: Option<OrgScope>) -> Arc<Self> {
        Arc::new(Self { signed_in: AtomicBool::new(signed_in), bound: Mutex::new(bound), reads: AtomicUsize::new(0) })
    }

    /// The user signs out while a session runs.
    fn sign_out(&self) {
        self.signed_in.store(false, Ordering::SeqCst);
    }

    /// The Project's binding changes while a session runs.
    fn rebind(&self, bound: Option<OrgScope>) {
        *self.bound.lock() = bound;
    }
}

impl SessionOrgs for FakeSessionOrgs {
    fn signed_in(&self) -> bool {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.signed_in.load(Ordering::SeqCst)
    }

    fn bound_to(&self, _cwd: &str) -> Option<OrgScope> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.bound.lock().clone()
    }
}

async fn running_host(org: Arc<dyn OrganisationCloud>) -> Arc<MemoryServerHost> {
    let host = Arc::new(MemoryServerHost::new());
    let server = MemoryServer::start_with(
        memory(),
        host.tokens().clone(),
        host.clocks().clone(),
        host.reads().clone(),
        sharing(true),
        Sources::default(),
        vec![quiet_ui(), router(OrgTools::new(org, setting(true), bound_to_acme()))],
    )
    .await
    .unwrap();
    host.adopt(server);
    host
}

fn offers(host: Arc<MemoryServerHost>, setting_on: bool, orgs: Arc<FakeSessionOrgs>) -> MemorySessionOffers {
    MemorySessionOffers::new(host, sharing(true))
        .with_ui(UiOffer::new(Arc::new(|| true)))
        .with_org(OrgOffer::new(setting(setting_on), orgs))
}

/// The native connection carries both properties; an ACP one neither. The
/// same agent id either way: only the connection's flags decide.
fn session_request(in_process: bool) -> SessionMcpRequest {
    SessionMcpRequest {
        agent_id: atlas_acp_thread::AgentId::new("atlas-agent"),
        http_mcp: true,
        ui_control: in_process,
        org_access: in_process,
        cwd: std::path::PathBuf::from("/p"),
        session_id: None,
    }
}

/// Every entry an offer carries, as `(name, url, bearer token)`.
fn entries(offer: &SessionMcpOffer) -> Vec<(String, String, String)> {
    offer
        .servers()
        .iter()
        .map(|server| {
            let acp::McpServer::Http(http) = server else { panic!("HTTP entries only") };
            let token = http
                .headers
                .iter()
                .find(|h| h.name == "Authorization")
                .and_then(|h| h.value.strip_prefix("Bearer "))
                .expect("a bearer token")
                .to_string();
            (http.name.clone(), http.url.clone(), token)
        })
        .collect()
}

fn names(offer: &SessionMcpOffer) -> Vec<String> {
    entries(offer).into_iter().map(|(name, _, _)| name).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_native_session_on_a_cloud_bound_project_is_offered_all_three_on_one_token_carrying_the_organisation() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer));
    org.record("s1", current(true));
    let host = running_host(org.clone()).await;
    let offer = offers(host.clone(), true, FakeSessionOrgs::new(true, Some(acme()))).offer(&session_request(true));
    let got = entries(&offer);
    assert_eq!(names(&offer), ["atlas_memory", UI_SERVER_NAME, ORG_SERVER_NAME]);
    assert!(got.iter().all(|(_, _, token)| *token == got[0].2), "all three ride one token");
    assert_eq!(Some(got[2].1.clone()), host.url_at(ORG_PATH));
    let token = got[2].2.clone();
    assert_eq!(host.tokens().grant(&token).unwrap().org, Some(acme()), "the grant carries the organisation");

    offer.bind(&acp::SessionId::new("s1"));
    assert_eq!(host.tokens().token_for("s1"), Some(token.clone()), "binding keeps the one token live");
    assert_eq!(host.tokens().grant(&token).unwrap().org, Some(acme()), "and the organisation with it");

    // The token the offer handed out is the one the agent calls with.
    let client = connect(&host.url_at(ORG_PATH).unwrap(), &token).await.unwrap();
    let answer = whoami(&client).await;
    assert_eq!(answer["organisation"]["id"], json!("org-acme"));
    assert_eq!(answer["current_session"]["id"], json!("rs-1"));
    client.cancel().await.ok();
}

/// ADR-0014: the host declares which of its tools ask first, and the offer
/// carries the declaration for the connection to project — the organisation
/// server's outward actions, and only while that server is offered.
#[tokio::test(flavor = "multi_thread")]
async fn the_offer_declares_the_org_servers_outward_actions_as_asking_first() {
    let host = running_host(chatting()).await;
    let offer = offers(host.clone(), true, FakeSessionOrgs::new(true, Some(acme()))).offer(&session_request(true));
    assert_eq!(offer.ask_first().tools_on(ORG_SERVER_NAME).collect::<Vec<_>>(), ["org_comment_reply", "org_send"]);
    assert_eq!(offer.ask_first().tools_on("atlas_memory").count(), 0);
    assert_eq!(offer.ask_first().tools_on(UI_SERVER_NAME).count(), 0);

    let offer = offers(host, false, FakeSessionOrgs::new(true, Some(acme()))).offer(&session_request(true));
    assert_eq!(offer.ask_first(), &atlas_agent_servers::AskFirst::none(), "no org server, nothing asks");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_acp_session_is_not_offered_the_org_server() {
    let host = running_host(Arc::new(FakeOrganisation::default())).await;
    let orgs = FakeSessionOrgs::new(true, Some(acme()));
    let offer = offers(host.clone(), true, orgs.clone()).offer(&session_request(false));
    assert_eq!(names(&offer), ["atlas_memory"]);
    assert_eq!(orgs.reads.load(Ordering::SeqCst), 0, "neither the account nor the binding was read");
    let token = entries(&offer)[0].2.clone();
    assert_eq!(host.tokens().grant(&token).unwrap().org, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn with_the_setting_off_the_org_server_is_not_offered() {
    let host = running_host(Arc::new(FakeOrganisation::default())).await;
    let offer = offers(host, false, FakeSessionOrgs::new(true, Some(acme()))).offer(&session_request(true));
    assert_eq!(names(&offer), ["atlas_memory", UI_SERVER_NAME]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_on_an_unbound_project_is_not_offered_the_org_server() {
    let host = running_host(Arc::new(FakeOrganisation::default())).await;
    let offer = offers(host.clone(), true, FakeSessionOrgs::new(true, None)).offer(&session_request(true));
    assert_eq!(names(&offer), ["atlas_memory", UI_SERVER_NAME]);
    let token = entries(&offer)[0].2.clone();
    assert_eq!(host.tokens().grant(&token).unwrap().org, None, "the token names no organisation");
}

/// A binding made before the server's Workspace id was recorded names its
/// organisation but no Workspace: not bound, for the offer.
#[tokio::test(flavor = "multi_thread")]
async fn a_project_bound_without_a_workspace_is_not_offered_the_org_server() {
    let host = running_host(Arc::new(FakeOrganisation::default())).await;
    let no_workspace = OrgScope { org_id: "org-acme".into(), workspace_id: None };
    let offer = offers(host.clone(), true, FakeSessionOrgs::new(true, Some(no_workspace))).offer(&session_request(true));
    assert_eq!(names(&offer), ["atlas_memory", UI_SERVER_NAME]);
    let token = entries(&offer)[0].2.clone();
    assert_eq!(host.tokens().grant(&token).unwrap().org, None, "the token names no organisation");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_signed_out_user_is_not_offered_the_org_server() {
    let host = running_host(Arc::new(FakeOrganisation::default())).await;
    let orgs = FakeSessionOrgs::new(false, Some(acme()));
    let offer = offers(host, true, orgs.clone()).offer(&session_request(true));
    assert_eq!(names(&offer), ["atlas_memory", UI_SERVER_NAME]);
    assert_eq!(orgs.reads.load(Ordering::SeqCst), 1, "the binding is not opened for a signed-out user");
}

#[tokio::test(flavor = "multi_thread")]
async fn without_the_org_third_the_offer_is_as_before() {
    let host = running_host(Arc::new(FakeOrganisation::default())).await;
    let offers = MemorySessionOffers::new(host, sharing(true)).with_ui(UiOffer::new(Arc::new(|| true)));
    assert_eq!(names(&offers.offer(&session_request(true))), ["atlas_memory", UI_SERVER_NAME]);
}

#[test]
fn the_decision_says_whether_the_org_server_is_included_and_why_not() {
    use OrgOfferDecision::*;
    assert_eq!(OrgOfferDecision::decide(true, true, true, true, true, true), Included);
    assert_eq!(
        OrgOfferDecision::decide(false, true, true, true, true, true),
        Omitted("agent did not advertise mcpCapabilities.http")
    );
    assert_eq!(
        OrgOfferDecision::decide(true, false, true, true, true, true),
        Omitted("connection does not carry organisation access")
    );
    assert_eq!(
        OrgOfferDecision::decide(true, true, false, true, true, true),
        Omitted("organisation access is off in Settings")
    );
    assert_eq!(OrgOfferDecision::decide(true, true, true, false, true, true), Omitted("not signed in"));
    assert_eq!(
        OrgOfferDecision::decide(true, true, true, true, false, true),
        Omitted("project is not bound to a cloud Workspace")
    );
    assert_eq!(OrgOfferDecision::decide(true, true, true, true, true, false), Omitted("org tool server is not running"));
}

#[test]
fn each_decision_is_one_log_line_naming_the_agent_its_capabilities_and_the_outcome() {
    assert_eq!(
        OrgOfferDecision::Included.log_line("atlas-agent", true, true),
        "org tool server offer: agent=atlas-agent http_mcp=true org_access=true org_server=included",
    );
    assert_eq!(
        OrgOfferDecision::decide(true, false, true, true, true, true).log_line("claude-code", true, false),
        "org tool server offer: agent=claude-code http_mcp=true org_access=false org_server=omitted \
         reason=\"connection does not carry organisation access\"",
    );
}

#[test]
fn the_setting_is_not_read_for_a_connection_that_cannot_use_the_server() {
    let reads = Arc::new(AtomicUsize::new(0));
    let counted = reads.clone();
    let orgs = FakeSessionOrgs::new(true, Some(acme()));
    let offer = OrgOffer::new(
        Arc::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            true
        }),
        orgs.clone(),
    );
    assert_eq!(offer.decide(true, false, "/p", true).1, None);
    assert_eq!(offer.decide(false, true, "/p", true).1, None);
    assert_eq!(reads.load(Ordering::SeqCst), 0);
    assert_eq!(orgs.reads.load(Ordering::SeqCst), 0);
}

// ── Which organisation a binding places a Project in ─────────────────────────

fn binding(mode: atlas_checkpoint::ProjectMode, enabled: bool, org: Option<&str>, workspace: Option<&str>) -> atlas_checkpoint::Binding {
    atlas_checkpoint::Binding {
        workspace_id: "/p".into(),
        root: "/p".into(),
        mode,
        slug: Some("atlas".into()),
        org_id: org.map(Into::into),
        root_commit_sha: None,
        fingerprint_is_shallow: false,
        git_url: None,
        enabled,
        import_approved: true,
        drain_state: atlas_checkpoint::model::DrainGate::Ok,
        remote_workspace_id: workspace.map(Into::into),
        created_at: chrono::Utc::now(),
    }
}

#[test]
fn a_cloud_binding_places_the_project_in_its_own_organisation_and_workspace() {
    use atlas_checkpoint::ProjectMode::{Cloud, Local};
    assert_eq!(scope_of(&binding(Cloud, true, Some("org-acme"), Some("ws-atlas"))), Some(acme()));
    assert_eq!(
        scope_of(&binding(Cloud, true, Some("org-acme"), None)),
        Some(OrgScope { org_id: "org-acme".into(), workspace_id: None }),
        "a binding from before the Workspace id was recorded still names its organisation",
    );
    assert_eq!(scope_of(&binding(Local, true, None, None)), None, "a local Project has no organisation");
    assert_eq!(scope_of(&binding(Cloud, false, Some("org-acme"), Some("ws-atlas"))), None, "capture switched off");
    assert_eq!(scope_of(&binding(Cloud, true, None, Some("ws-atlas"))), None);
}

// ── Composer mentions arrive as organisation links (#122) ─────────────────────

const GRACE: &str = "atlas-org://member/u-grace";
/// The second of the two members called Sam Lee — ambiguous by name, not by link.
const SAM_TWO: &str = "atlas-org://member/u-sam2";

#[tokio::test(flavor = "multi_thread")]
async fn org_sessions_takes_a_member_link_as_its_author() {
    let org = boarded();
    let (_server, client) = org_client(org).await;
    let (err, answer) = call_json(&client, "org_sessions", json!({ "author": GRACE, "since": "2000-01-01" })).await;
    assert!(!err, "{answer}");
    assert_eq!(session_ids(&answer), ["rs-grace", "rs-grace-old"]);
    assert_eq!(answer["author"], json!({ "user_id": "u-grace", "name": "Grace Hopper" }));

    let (err, answer) = call_json(&client, "org_sessions", json!({ "author": "atlas-org://member/u-sam1", "since": "2000-01-01" })).await;
    assert!(!err, "a link names one Sam Lee, never both: {answer}");
    assert_eq!(session_ids(&answer), ["rs-sam"]);
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_link_of_another_kind_as_an_author_matches_nobody_and_the_board_is_not_read() {
    let org = boarded();
    let (_server, client) = org_client(org.clone()).await;
    let (err, text) = call(&client, "org_sessions", json!({ "author": "atlas-org://conversation/u-grace" })).await;
    assert!(err);
    assert!(text.contains("no member matches"), "{text}");
    assert_eq!(org.board_reads(), 0);
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn org_member_activity_takes_a_member_link() {
    let org = boarded_as(Some(Role::Admin));
    let (_server, client) = org_client(org).await;
    let (err, answer) = call_json(&client, "org_member_activity", json!({ "member": GRACE })).await;
    assert!(!err, "{answer}");
    assert_eq!(answer["member"], json!({ "user_id": "u-grace", "name": "Grace Hopper" }));
    assert_eq!(answer["totals"]["recorded_sessions"], json!(1));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn org_send_takes_a_member_link_or_a_conversation_link_as_to() {
    let org = chatting();
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) = send(&client, &consent, json!({ "to": GRACE, "body": "Your review is in." })).await;
    assert!(!err, "{answer}");
    let (err, answer2) =
        send(&client, &consent, json!({ "to": "atlas-org://conversation/c-group", "body": "Standup moved to 10." })).await;
    assert!(!err, "{answer2}");
    let (err, answer3) = send(&client, &consent, json!({ "to": SAM_TWO, "body": "Welcome aboard." })).await;
    assert!(!err, "{answer3}");
    assert_eq!(
        sent(&org),
        [
            ("c-dm-grace".to_string(), "Your review is in.".to_string()),
            ("c-group".to_string(), "Standup moved to 10.".to_string()),
            ("c-dm-u-sam2".to_string(), "Welcome aboard.".to_string()),
        ],
        "the member's DM, the conversation itself, and a new DM with the one Sam Lee the link names",
    );
    assert_eq!(answer["created_dm"], json!(false));
    assert_eq!(answer3["created_dm"], json!(true));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn org_send_takes_member_links_as_mentions() {
    let org = chatting();
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) = send(
        &client,
        &consent,
        json!({ "to": "#general", "body": "@Grace Hopper shipped it", "mention": [GRACE, SAM_TWO] }),
    )
    .await;
    assert!(!err, "{answer}");
    assert_eq!(sent(&org), [("c-general".to_string(), "<@u-sam2> <@u-grace> shipped it".to_string())]);
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_card_for_a_message_to_a_link_names_who_it_reaches() {
    let offers = describing_offer(chatting()).await;
    let said = describe(&offers, ORG_SERVER_NAME, "org_send", json!({ "to": GRACE, "body": "hi" }))
        .await
        .expect("described");
    assert_eq!((said.title.as_str(), said.recipient.as_str()), ("Message Grace Hopper", "Grace Hopper, in your DM"));
}

#[tokio::test(flavor = "multi_thread")]
async fn org_page_create_takes_a_conversation_link() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(
        &client,
        "org_page_create",
        json!({ "conversation": "atlas-org://conversation/c-dm-grace", "name": "Notes" }),
    )
    .await;
    assert!(!err, "{answer}");
    assert_eq!(pages_created(&org), [("c-dm-grace".to_string(), "Notes".to_string())]);
    client.cancel().await.ok();
}

const RS_TWO: &str = "atlas-org://recorded-session/ws-atlas/rs-2";

#[tokio::test(flavor = "multi_thread")]
async fn org_comments_and_org_comment_resolve_take_a_recorded_session_link() {
    let org = commented();
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_comments", json!({ "session": RS_TWO })).await;
    assert!(!err, "{answer}");
    assert_eq!(answer["session"], json!({ "id": "rs-2", "title": null, "current": false }));
    assert_eq!(thread_ids(&answer), ["z1"]);

    let (err, answer) = call_json(&client, "org_comment_resolve", json!({ "comment": "z1", "session": RS_TWO })).await;
    assert!(!err, "{answer}");
    assert!(org.asked().contains(&("org-acme".to_string(), "resolve ws-atlas/rs-2/z1 resolved=true".to_string())));
    assert!(!org.asked().iter().any(|(_, what)| what.starts_with("current")), "a linked session needs no join");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn org_comment_reply_takes_a_recorded_session_link_and_member_links_as_mentions() {
    let org = commented();
    let (_server, client, consent) = consenting_client(org.clone()).await;
    let (err, answer) = call_json(
        &client,
        "org_comment_reply",
        approved(&consent, json!({ "comment": "z1", "session": RS_TWO, "body": "Still true?", "mention": [GRACE] })),
    )
    .await;
    assert!(!err, "{answer}");
    assert_eq!(answer["session"]["id"], json!("rs-2"));
    assert!(org.asked().contains(&("org-acme".to_string(), "reply ws-atlas/rs-2/z1".to_string())));
    let posted: Vec<Comment> = org.comments.lock()["rs-2"].iter().filter(|c| c.id != "z1").cloned().collect();
    assert_eq!(posted[0].body.as_deref(), Some("<@u-grace> Still true?"));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn org_session_takes_a_recorded_session_link() {
    let org = timelined();
    let (_server, client) = org_client(org).await;
    let (err, answer) =
        call_json(&client, "org_session", json!({ "session": "atlas-org://recorded-session/ws-atlas/rs-grace" })).await;
    assert!(!err, "{answer}");
    assert_eq!(answer["session"]["id"], json!("rs-grace"));
    assert_eq!(answer["session"]["current"], json!(false));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_link_to_another_workspace_of_the_organisation_is_read_there() {
    let org = commented();
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) =
        call_json(&client, "org_comments", json!({ "session": "atlas-org://recorded-session/ws-other/rs-2" })).await;
    assert!(!err, "{answer}");
    assert_eq!(thread_ids(&answer), ["z1"]);
    assert_eq!(
        org.asked(),
        [("org-acme".to_string(), "comments ws-other/rs-2".to_string()), ("org-acme".to_string(), "members".to_string())],
        "asked in the grant's organisation, whose server decides whether this account may read it",
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bare_session_id_with_a_workspace_is_read_in_that_workspace() {
    let org = commented();
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_comments", json!({ "session": "rs-2", "workspace": "ws-other" })).await;
    assert!(!err, "{answer}");
    let (err, answer) =
        call_json(&client, "org_comment_resolve", json!({ "comment": "z1", "session": "rs-2", "workspace": "ws-other" })).await;
    assert!(!err, "{answer}");
    assert!(org.asked().contains(&("org-acme".to_string(), "comments ws-other/rs-2".to_string())));
    assert!(org.asked().contains(&("org-acme".to_string(), "resolve ws-other/rs-2/z1 resolved=true".to_string())));

    let org = timelined();
    org.board.lock().push(RemoteSession { workspace_id: "ws-other".into(), ..board_row("rs-9", "u-grace", 90, 30, false, "Elsewhere") });
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_session", json!({ "session": "rs-9", "workspace": "ws-other" })).await;
    assert!(!err, "{answer}");
    assert_eq!(answer["session"]["workspace_id"], json!("ws-other"));
    assert!(org.asked().iter().any(|(_, what)| what.starts_with("timeline ws-other/rs-9")));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_workspace_without_a_session_id_or_that_its_link_contradicts_is_refused_before_anything_is_read() {
    let org = commented();
    let (_server, client) = org_client(org.clone()).await;
    for args in [
        json!({ "workspace": "ws-other" }),
        json!({ "session": "current", "workspace": "ws-other" }),
        json!({ "session": RS_TWO, "workspace": "ws-other" }),
    ] {
        let (err, text) = call(&client, "org_comments", args.clone()).await;
        assert!(err && text.contains("workspace"), "{args}: {text}");
    }
    assert!(org.asked().is_empty(), "nothing asked of the organisation: {:?}", org.asked());
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_link_of_another_kind_as_a_session_is_refused_before_anything_is_read() {
    let org = commented();
    let (_server, client) = org_client(org.clone()).await;
    let (err, text) = call(&client, "org_session", json!({ "session": GRACE })).await;
    assert!(err);
    assert!(text.contains("is not a recorded session"), "{text}");
    assert!(org.asked().is_empty(), "nothing asked of the organisation: {:?}", org.asked());
    client.cancel().await.ok();
}

// ── An id is an id, never a path ─────────────────────────────────────────────

/// What a model could pass, or a crafted link could decode to, to climb out of
/// the grant's Workspace in a route: a traversal, an encoded slash, a stray
/// percent sign, whitespace, a dot segment.
const NOT_IDS: &[&str] = &["../ws-other/rs-9", "rs-1/../../ws-other/rs-9", "rs%2F1", "rs 1", "..", ".", "rs-1\\x"];

#[tokio::test(flavor = "multi_thread")]
async fn a_session_id_that_is_not_an_id_is_refused_before_anything_is_read() {
    let org = timelined();
    let (_server, client) = org_client(org.clone()).await;
    for bad in NOT_IDS {
        for tool in ["org_session", "org_comments"] {
            let (err, text) = call(&client, tool, json!({ "session": bad })).await;
            assert!(err && text.contains("is not a recorded session id"), "{tool} {bad}: {text}");
        }
    }
    assert!(org.asked().is_empty(), "nothing asked of the organisation: {:?}", org.asked());
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_recorded_session_link_whose_ids_decode_to_a_path_is_refused_before_anything_is_read() {
    let org = timelined();
    let (_server, client) = org_client(org.clone()).await;
    for link in [
        "atlas-org://recorded-session/ws-atlas/..%2Fws-other%2Frs-9",
        "atlas-org://recorded-session/ws-atlas/%2E%2E",
        "atlas-org://recorded-session/..%2Fws-other/rs-9",
        "atlas-org://recorded-session/ws-atlas/rs%252F1",
    ] {
        let (err, text) = call(&client, "org_session", json!({ "session": link })).await;
        assert!(err && text.contains("is not a"), "{link}: {text}");
    }
    assert!(org.asked().is_empty(), "nothing asked of the organisation: {:?}", org.asked());
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_entry_comment_or_workspace_id_that_is_not_an_id_is_refused_before_anything_is_read() {
    let org = commented();
    let (_server, client, consent) = consenting_client(org.clone()).await;
    for bad in NOT_IDS {
        let (err, text) = call(&client, "org_session", json!({ "entry": bad })).await;
        assert!(err && text.contains("is not an entry id"), "entry {bad}: {text}");
        let (err, text) = call(&client, "org_comment_resolve", json!({ "comment": bad })).await;
        assert!(err && text.contains("is not a comment id"), "resolve {bad}: {text}");
        let reply = json!({ "comment": bad, "body": "hi" });
        let (err, text) = call(&client, "org_comment_reply", approved(&consent, reply)).await;
        assert!(err && text.contains("is not a comment id"), "reply {bad}: {text}");
        let (err, text) = call(&client, "org_sessions", json!({ "workspace": bad })).await;
        assert!(err && text.contains("is not a Workspace id"), "workspace {bad}: {text}");
    }
    assert!(org.asked().is_empty(), "nothing asked of the organisation: {:?}", org.asked());
    assert!(nothing_posted(&org));
    client.cancel().await.ok();
}

#[test]
fn an_id_is_a_short_run_of_letters_digits_and_a_few_marks() {
    for id in ["rs-1", "am-6f1c2a0e-9b1d-4c1e-8a7b-0d2f4e6a8c10", "01J8Z3K4M5N6P7Q8R9S0T1V2W3", "ws_atlas", "a.b", "tc:1"] {
        assert!(tools::is_id(id), "{id}");
    }
    for id in NOT_IDS.iter().copied().chain(["", "a/b", "a?b", "a#b", "a%b", "a\tb", "...", &"x".repeat(129)]) {
        assert!(!tools::is_id(id), "{id:?}");
    }
}

// ── No tool server talks to the user (ADR-0013) ──────────────────────────────

/// The one MCP elicitation Atlas serves is the engine's own ask before an
/// outward action, and the native seam tells it from a tool server's only
/// because Atlas's own servers never elicit (`engine::tool_approvals`). So
/// none of the three may: no handler in the memory, UI or organisation tool
/// server sends `elicitation/create`, through the peer or otherwise.
#[test]
fn none_of_atlas_tool_servers_ever_sends_an_elicitation() {
    let commands = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands");
    let mut read = 0;
    for server in ["memory_server", "ui_server", "org_server"] {
        for entry in std::fs::read_dir(commands.join(server)).expect("the server's module") {
            let path = entry.expect("an entry").path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            if !name.ends_with(".rs") || name == "tests.rs" {
                continue;
            }
            read += 1;
            let source = std::fs::read_to_string(&path).expect("readable");
            for (i, line) in source.lines().enumerate() {
                let code = line.split("//").next().unwrap_or_default().to_lowercase();
                assert!(
                    !code.contains("elicit"),
                    "{}:{} reaches for an elicitation: {line}",
                    path.display(),
                    i + 1,
                );
            }
        }
    }
    assert!(read >= 9, "the three servers' sources were read ({read})");
}

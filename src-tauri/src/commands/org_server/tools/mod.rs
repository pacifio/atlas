//! The MCP surface of the organisation tool server: the tools, their
//! instructions, and the handler that answers each call through the
//! organisation cloud.
//!
//! Every call is checked before anything remote happens, as the offer was:
//! the user's organisation-access setting (off stops a running session at its
//! next call), the grant's organisation (a token that was not offered the
//! server names none, and is refused), that someone is still signed in, and
//! that the grant's Project is still bound to the grant's organisation and
//! Workspace. What a tool then asks the cloud, it asks in the grant's
//! organisation — in the grant's Workspace unless the tool names another of
//! the organisation's — never in the window's. An outward action is
//! also checked for the user's approval of that exact call
//! ([`OutwardConsent`]).
//! Schemas are kept flat, with one-clause descriptions, because every native
//! turn carries them in its fixed prefix.
//!
//! This module holds the server itself: the tool list, the instructions, the
//! per-call checks and dispatch, the argument readers, and the shapes and
//! resolvers more than one area shares. Each area's tools live beside it:
//! [`roster`] (who you are, members, conversations), [`inbox`],
//! [`comments`] (threads, resolving, replying), [`messages`] (sending),
//! [`mentions`] (members named in what is posted, and read back),
//! [`sessions`] (the recorded work), [`activity`] (a member's recorded
//! activity, for admins), [`spaces`] (pages in a conversation's
//! Space, and drawing on one), [`diagram`] (the document a drawing is checked
//! as) and [`describe`] (the approval card for an outward call).

mod activity;
mod comments;
mod describe;
mod diagram;
mod inbox;
mod mentions;
mod messages;
mod roster;
mod sessions;
mod spaces;

use std::borrow::Cow;
use std::sync::Arc;

use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CacheScope, CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock as Content, JsonObject,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::ErrorData as McpError;
use serde_json::{json, Value};

use super::audit::{unaudited, OrgActionRecord, OrgAudit};
use super::cloud::{CurrentSessionQuery, InboxQuery, Member, OrgConversation, OrganisationCloud};
use super::offers::SessionOrgs;
use super::resolve::{self, OrgLink, Resolution};
use super::{OrgAccessGate, OrgScope, ORG_PATH, ORG_SERVER_NAME};
use crate::auth::Role;
use crate::commands::memory_server::{Grant, TOOLS_LIST_TTL_MS};
use crate::commands::ui_server::UiBridge;
use atlas_agent_servers::OutwardConsent;
use activity::ActivityArgs;
use comments::ReplyArgs;
use messages::SendArgs;
#[cfg(test)]
pub(super) use mentions::{named_mentions, with_mentions};
#[cfg(test)]
pub(super) use activity::{ACTIVITY_ROWS, RECORDED_NOTE};
pub(super) use sessions::SESSIONS_DEFAULT_LIMIT;
use sessions::{SessionFilters, SESSIONS_MAX_LIMIT};
#[cfg(test)]
pub(super) use sessions::{SESSIONS_DEFAULT_WINDOW_DAYS, SESSIONS_SCAN_CAP, TIMELINE_DEFAULT_LIMIT};

/// What the server tells the agent about itself. The engine keeps it as the
/// description of the `atlas_org` tool namespace — but the Chat Completions
/// dialect sends only a namespace's tools (`reshape_tools`), so nothing here
/// may be the only place a rule reaches the model: each rule that must is
/// also in a tool's or a property's description, and every rule the model
/// could break is enforced in code (a name that matches several is answered
/// with candidates to ask about; the inbox cannot be marked read; an outward
/// action is posted only once the user approved that exact call).
pub const INSTRUCTIONS: &str = "\
Atlas organisation: read and act in the organisation this chat's project is bound to, as the signed-in \
user. Call org_whoami first when the organisation matters. When a name matches several, ask the user which \
one.";

/// The server's **outward actions** (ADR-0014): the tools that reach another
/// person in the user's name. The one declaration both halves read — the
/// offer names them as asking first ([`atlas_agent_servers::AskFirst`]), so
/// the native seam projects each with a per-tool `prompt`, and
/// [`OrgTools::answer`] refuses any of them without the user's recorded
/// approval of that exact call. A new outward tool is one more name here.
pub const OUTWARD_TOOLS: &[&str] = &["org_comment_reply", "org_send"];

/// The tools only an organisation **admin** is offered: left out of the
/// `tools/list` answer for a session whose caller holds any other role (read
/// from the access token's organisation claim, through the organisation
/// cloud's `caller`), and refused at call time for one that calls it anyway.
/// The role is a mirror — the server is the authority, and its 403 is still
/// answered in words.
pub const ADMIN_TOOLS: &[&str] = &["org_member_activity"];

/// The tools the **window** performs: their work needs something only the
/// frontend holds — a Space page's codec — so the call is checked here and
/// then crosses to the window on the UI tool server's bridge (ADR-0012),
/// emitted as [`ORG_WINDOW_ACTION_EVENT`](super::ORG_WINDOW_ACTION_EVENT).
/// The one declaration the event choice and the frontend's dispatcher are
/// held to (`tests/org-window-actions-contract.test.ts`).
pub const WINDOW_TOOLS: &[&str] = &["org_page_write"];

/// What a tool answers while the user has switched organisation access off.
const OFF_NOTE: &str =
    "Atlas Agent's organisation access is switched off in Settings → General; ask the user to turn it on.";

/// What a tool answers for a session that was not offered the server — its
/// token names no organisation.
const NO_ORG_NOTE: &str = "This session was not given access to an organisation: its project is not bound to a \
     cloud Workspace, or it was opened before it was. Ask the user to bind the project and start a new chat.";

/// What a tool answers once nobody is signed in on this machine any more.
const SIGNED_OUT_NOTE: &str = "Nobody is signed in to Atlas on this machine any more; ask the user to sign in.";

/// What a tool answers once the session's Project is no longer bound to the
/// organisation and Workspace it was offered in — unbound, local-only, moved
/// to another Workspace, or capture switched off.
const UNBOUND_NOTE: &str = "This session's project is no longer bound to the cloud Workspace this chat was given access to. Ask the user to bind the project again and start a new chat.";

/// What an outward action answers when the user did not approve that call on
/// its card — above all in bypass mode, where the engine runs it unasked.
const UNAPPROVED_NOTE: &str = "Replies and messages are sent in your name only after you approve them; bypass mode \
     cannot approve outward actions — switch the chat out of bypass to send. Nothing was posted.";

/// What `org_whoami` says in place of a current session the Workspace does
/// not hold yet.
pub(super) const NOT_RECORDED_YET: &str = "not recorded yet";

fn schema(value: Value) -> Arc<JsonObject> {
    match value {
        Value::Object(map) => Arc::new(map),
        _ => Arc::new(JsonObject::new()),
    }
}

fn tool(name: &'static str, description: &'static str, input: Value) -> Tool {
    Tool::new(Cow::Borrowed(name), Cow::Borrowed(description), schema(input))
}

/// How a member or a conversation is named, said once where it matters most:
/// every such argument also takes the `atlas-org://` link a composer mention
/// carries (and an email for a member, `#name` for a channel — resolution
/// tries them all, [`resolve`]).
const NAMED: &str = "Name, id or atlas-org:// link";
/// How a recorded session is named: an id, its link, or the `"current"`
/// sentinel (also the default).
const SESSION: &str = "Id, link or current";

fn described(kind: &str, description: &str) -> Value {
    json!({ "type": kind, "description": description })
}

/// Every tool, reads first — [`ADMIN_TOOLS`] included; [`tools_for`] is
/// what a session is offered. Descriptions are one clause and a property is
/// described only where its name does not say it; defaults, caps and limits
/// are left to the answers, which report them.
pub(super) fn tools() -> Vec<Tool> {
    let s = json!({ "type": "string" });
    let int = json!({ "type": "integer" });
    let flag = json!({ "type": "boolean" });
    let named = described("string", NAMED);
    let session = described("string", SESSION);
    let mention = json!({ "type": "array", "items": s });
    vec![
        tool(
            "org_whoami",
            "You, your role, Workspace and current session; call first.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "org_members",
            "Members, or one by name.",
            json!({ "type": "object", "properties": { "name": s } }),
        ),
        tool(
            "org_conversations",
            "Channels and DMs, or one by name.",
            json!({ "type": "object", "properties": { "name": s } }),
        ),
        tool(
            "org_inbox",
            "Your inbox; read-only.",
            json!({ "type": "object", "properties": { "unread_only": flag, "cursor": s } }),
        ),
        tool(
            "org_comments",
            "A recorded session's comments.",
            json!({
                "type": "object",
                "properties": { "session": session, "workspace": s, "unresolved_only": flag }
            }),
        ),
        tool(
            "org_comment_resolve",
            "Resolve or reopen a comment thread.",
            json!({
                "type": "object",
                "properties": { "comment": s, "resolved": flag, "session": s, "workspace": s }
            }),
        ),
        tool(
            "org_comment_reply",
            "Reply to a comment; the user approves first.",
            json!({
                "type": "object",
                "properties": { "comment": s, "body": s, "mention": mention, "session": s, "workspace": s }
            }),
        ),
        tool(
            "org_send",
            "Send a chat message; the user approves first.",
            json!({
                "type": "object",
                "properties": {
                    "to": named,
                    "body": s,
                    "mention": mention,
                    "session": session,
                    "workspace": s
                }
            }),
        ),
        tool(
            "org_sessions",
            "Recorded sessions, latest first.",
            json!({
                "type": "object",
                "properties": {
                    "workspace": s,
                    "author": described("string", "me, name, id or link"),
                    "since": s,
                    "until": s,
                    "q": s,
                    "limit": int
                }
            }),
        ),
        tool(
            "org_session",
            "A recorded session's entries, or one in full.",
            json!({
                "type": "object",
                "properties": {
                    "session": session,
                    "workspace": s,
                    "cursor": s,
                    "entry": s,
                    "part": { "type": "string", "enum": ["body", "arguments", "result"] }
                }
            }),
        ),
        tool(
            "org_member_activity",
            "A member's activity recorded through Atlas, not a measure of performance; admins only.",
            json!({
                "type": "object",
                "properties": {
                    "member": named,
                    "since": s,
                    "until": s,
                    "workspace": s
                }
            }),
        ),
        tool(
            "org_page_create",
            "Create a page in a conversation's Space.",
            json!({
                "type": "object",
                "properties": { "conversation": s, "name": s }
            }),
        ),
        tool(
            "org_page_write",
            "Draw a diagram on a Space page, replacing it.",
            json!({
                "type": "object",
                "properties": {
                    "page": s,
                    "conversation": s,
                    "document": described("object", diagram::DOCUMENT_SHAPE.as_str())
                }
            }),
        ),
    ]
}

/// The tools a session is offered: every one for an organisation admin,
/// every one but [`ADMIN_TOOLS`] for anyone else.
pub(super) fn tools_for(admin: bool) -> Vec<Tool> {
    tools().into_iter().filter(|t| admin || !ADMIN_TOOLS.contains(&t.name.as_ref())).collect()
}

#[cfg(test)]
pub(super) fn tool_names(admin: bool) -> Vec<String> {
    tools_for(admin).into_iter().map(|t| t.name.to_string()).collect()
}

/// The `tools/list` answer, with the cache fields MCP 2026-07-28 requires
/// (see the memory tool server's `tools_list`). Private-scoped: it differs by
/// the caller's role.
pub(super) fn tools_list(admin: bool) -> ListToolsResult {
    ListToolsResult::with_all_items(tools_for(admin))
        .with_ttl_ms(TOOLS_LIST_TTL_MS)
        .with_cache_scope(CacheScope::Private)
}

fn tool_error(message: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![Content::text(message.into())])
}

fn tool_json(value: Value) -> CallToolResult {
    CallToolResult::success(vec![Content::text(value.to_string())])
}

/// An optional string argument, blank read as absent.
fn string_arg<'a>(request: &'a CallToolRequestParams, name: &str) -> Option<&'a str> {
    string_in(request.arguments.as_ref(), name)
}

/// [`string_arg`] over a call's arguments however they arrived — on a call,
/// or on the approval card's description of one.
fn string_in<'a>(arguments: Option<&'a JsonObject>, name: &str) -> Option<&'a str> {
    arguments.and_then(|args| args.get(name)).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

/// The longest id a tool takes. The organisation's ids are UUID-, ULID- or
/// prefixed tokens far shorter than this.
const ID_MAX: usize = 128;

/// Whether `text` has the shape of an organisation id — a recorded session,
/// a Workspace, a comment, an entry or a page: ASCII letters, digits, `-`,
/// `_`, `.` and `:`, not dots alone, at most [`ID_MAX`] long. Ids reach the
/// artifacts routes as path segments, so nothing that could end, climb out
/// of or re-scope one — a `/`, a `%`, whitespace, `.` or `..` — is ever
/// taken as one, however it arrived: as an argument, or decoded out of an
/// organisation link. (The artifacts client encodes each id as one segment
/// too; this refuses in words, before anything is read.)
pub(crate) fn is_id(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= ID_MAX
        && !text.bytes().all(|b| b == b'.')
        && text.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
}

/// `id` when it is one ([`is_id`]); else the tool's answer refusing it —
/// `what` names the kind ("a comment", "an entry").
fn checked_id<'a>(what: &str, id: &'a str) -> Result<&'a str, CallToolResult> {
    if is_id(id) {
        Ok(id)
    } else {
        Err(not_an_id(what, id))
    }
}

fn not_an_id(what: &str, text: &str) -> CallToolResult {
    tool_error(format!("\"{text}\" is not {what} id. Nothing was read."))
}

/// An optional boolean argument, absent read as `false`.
fn bool_arg(request: &CallToolRequestParams, name: &str) -> bool {
    request.arguments.as_ref().and_then(|args| args.get(name)).and_then(Value::as_bool).unwrap_or(false)
}

/// An optional boolean argument, `default` when absent.
fn bool_arg_or(request: &CallToolRequestParams, name: &str, default: bool) -> bool {
    request.arguments.as_ref().and_then(|args| args.get(name)).and_then(Value::as_bool).unwrap_or(default)
}

/// An optional positive integer argument.
fn u32_arg(request: &CallToolRequestParams, name: &str) -> Option<u32> {
    let value = request.arguments.as_ref()?.get(name)?.as_u64()?;
    u32::try_from(value).ok().filter(|n| *n > 0)
}

/// An optional list of strings, blanks dropped; a lone string reads as a
/// list of one. Over a call's arguments however they arrived, as
/// [`string_in`].
fn strings_in(arguments: Option<&JsonObject>, name: &str) -> Vec<String> {
    let strings = |value: &Value| value.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    match arguments.and_then(|args| args.get(name)) {
        Some(Value::Array(items)) => items.iter().filter_map(strings).collect(),
        Some(value) => strings(value).into_iter().collect(),
        None => Vec::new(),
    }
}

/// Who wrote something, as the model reads it: a guest by the name they
/// signed it with, never as a member; a member by the roster when it could be
/// read, else by id alone.
fn author_json(user_id: &str, guest_name: Option<&str>, roster: Option<&[Member]>) -> Value {
    let name = guest_name.map(str::to_string).or_else(|| roster_name(roster, user_id));
    json!({ "user_id": user_id, "name": name, "guest": guest_name.is_some() })
}

/// A member's name from the roster, when it could be read and holds them.
fn roster_name(roster: Option<&[Member]>, user_id: &str) -> Option<String> {
    roster.and_then(|r| r.iter().find(|m| m.user_id == user_id)).map(|m| m.name.clone())
}

fn member_json(member: &Member) -> Value {
    json!({
        "user_id": member.user_id,
        "name": member.name,
        "email": member.email,
        "role": member.role,
    })
}

/// A conversation as the model reads it. A DM or group DM has no name, so it
/// is described by who is in it, named from the roster when there is one.
fn conversation_json(conversation: &OrgConversation, roster: Option<&[Member]>) -> Value {
    let mut out = json!({
        "id": conversation.id,
        "kind": conversation.kind,
        "name": conversation.name,
        "caller_is_member": conversation.caller_is_member,
    });
    if let Some(ids) = &conversation.member_ids {
        out["members"] = ids
            .iter()
            .map(|id| json!({ "user_id": id, "name": roster_name(roster, id) }))
            .collect();
    }
    out
}

/// The error for a name that matched more than one: every candidate with its
/// id, and the instruction to ask. JSON, because the model reads the ids out
/// of it once the user has chosen.
fn ambiguous(query: &str, what: &str, candidates: Vec<Value>) -> CallToolResult {
    tool_error(
        json!({
            "error": format!("\"{query}\" matches {} {what}; ask the user which one", candidates.len()),
            "candidates": candidates,
        })
        .to_string(),
    )
}

/// A member named by the model, resolved against the roster
/// ([`resolve::member`]): the one member, or the tool result to answer
/// instead — nobody matched, or several did.
pub(super) fn resolve_member(roster: &[Member], query: &str) -> Result<Member, CallToolResult> {
    match resolve::member(roster, query) {
        Resolution::One(member) => Ok(member.clone()),
        Resolution::None => Err(tool_error(format!(
            "no member matches \"{query}\" by id, name or email; call org_members for the roster"
        ))),
        Resolution::Many(found) => Err(ambiguous(query, "members", found.into_iter().map(member_json).collect())),
    }
}

/// A conversation named by the model, resolved against the conversation list
/// ([`resolve::conversation`]), as [`resolve_member`] does for a member.
pub(super) fn resolve_conversation(
    conversations: &[OrgConversation],
    query: &str,
) -> Result<OrgConversation, CallToolResult> {
    match resolve::conversation(conversations, query) {
        Resolution::One(conversation) => Ok(conversation.clone()),
        Resolution::None => Err(tool_error(format!(
            "no conversation matches \"{query}\" by id or channel name; call org_conversations for the list \
             (a DM is reached through its member)"
        ))),
        Resolution::Many(found) => Err(ambiguous(
            query,
            "conversations",
            found.into_iter().map(|c| conversation_json(c, None)).collect(),
        )),
    }
}

#[derive(Clone)]
pub struct OrgTools {
    cloud: Arc<dyn OrganisationCloud>,
    gate: OrgAccessGate,
    /// The account and the Project's binding, as the offer reads them: read
    /// again on every call, so signing out or unbinding the Project stops a
    /// running session at its next call.
    orgs: Arc<dyn SessionOrgs>,
    /// The user's approvals of outward calls, recorded by the native seam
    /// through the host and spent here (ADR-0014).
    consent: Arc<OutwardConsent>,
    audit: OrgAudit,
    /// The way to the window, for [`WINDOW_TOOLS`]: the UI tool server's
    /// bridge. `None` until the app hands it over; a window tool then answers
    /// that the window is unavailable.
    window: Option<Arc<UiBridge>>,
}

impl OrgTools {
    pub fn new(cloud: Arc<dyn OrganisationCloud>, gate: OrgAccessGate, orgs: Arc<dyn SessionOrgs>) -> Self {
        Self { cloud, gate, orgs, consent: Arc::new(OutwardConsent::new()), audit: unaudited(), window: None }
    }

    /// Hands [`WINDOW_TOOLS`] their way to the window: the bridge the UI tool
    /// server's actions cross on, so a window call is parked, timed out and
    /// answered exactly as a UI action is.
    pub fn with_window(mut self, bridge: Arc<UiBridge>) -> Self {
        self.window = Some(bridge);
        self
    }

    /// Where the user's approvals of outward calls are recorded for these
    /// tools to check: the host hands it every approval the native seam
    /// reports ([`SessionMcpServers::approved_call`]).
    ///
    /// [`SessionMcpServers::approved_call`]: atlas_agent_servers::SessionMcpServers::approved_call
    pub fn consent(&self) -> &Arc<OutwardConsent> {
        &self.consent
    }

    /// Hands every call's [`OrgActionRecord`] to `audit`.
    pub fn with_audit(mut self, audit: OrgAudit) -> Self {
        self.audit = audit;
        self
    }

    /// One call, answered and then audited: exactly one record whatever the
    /// answer, so a refusal and a failure are rows as much as a success is.
    /// The one place a call is recorded — a new tool is audited by being
    /// answered here.
    async fn dispatch(&self, grant: Grant, request: CallToolRequestParams) -> CallToolResult {
        let answer = self.answer(&grant, &request).await;
        (self.audit)(&OrgActionRecord::of(&grant, &request, &answer));
        answer
    }

    async fn answer(&self, grant: &Grant, request: &CallToolRequestParams) -> CallToolResult {
        if !(self.gate)() {
            return tool_error(OFF_NOTE);
        }
        let Some(scope) = grant.org.clone() else {
            return tool_error(NO_ORG_NOTE);
        };
        // What the offer checked, checked again: the grant outlives both.
        if !self.orgs.signed_in() {
            return tool_error(SIGNED_OUT_NOTE);
        }
        if self.orgs.bound_to(&grant.cwd).as_ref() != Some(&scope) {
            return tool_error(UNBOUND_NOTE);
        }
        // An outward action posts only the call the user approved — on its
        // card, or under "Allow for this session" — never one the engine ran
        // unasked (bypass).
        if OUTWARD_TOOLS.contains(&request.name.as_ref()) {
            let arguments = request.arguments.clone().map_or(Value::Null, Value::Object);
            if !self.consent.take(&grant.session_id, ORG_SERVER_NAME, &request.name, &arguments) {
                return tool_error(UNAPPROVED_NOTE);
            }
        }
        match request.name.as_ref() {
            "org_whoami" => self.whoami(grant, &scope).await,
            "org_members" => self.members(&scope, string_arg(request, "name")).await,
            "org_conversations" => self.conversations(&scope, string_arg(request, "name")).await,
            "org_inbox" => {
                let query = InboxQuery {
                    unread_only: bool_arg(request, "unread_only"),
                    cursor: string_arg(request, "cursor"),
                    limit: u32_arg(request, "limit"),
                };
                self.inbox(&scope, query).await
            }
            "org_comments" => {
                let session = (string_arg(request, "session"), string_arg(request, "workspace"));
                self.comments(grant, &scope, session, bool_arg(request, "unresolved_only")).await
            }
            "org_comment_resolve" => {
                let Some(comment) = string_arg(request, "comment") else {
                    return tool_error("name the comment to resolve: `comment` is its id (see org_comments)");
                };
                if let Err(answer) = checked_id("a comment", comment) {
                    return answer;
                }
                let resolved = bool_arg_or(request, "resolved", true);
                let session = (string_arg(request, "session"), string_arg(request, "workspace"));
                self.resolve_comment(grant, &scope, session, comment, resolved).await
            }
            "org_comment_reply" => {
                let args = ReplyArgs::of(request.arguments.as_ref());
                let Some(comment) = args.comment else {
                    return tool_error("name the comment to reply to: `comment` is its id (see org_comments)");
                };
                if let Err(answer) = checked_id("a comment", comment) {
                    return answer;
                }
                let Some(body) = args.body else {
                    return tool_error("say what to reply: `body` is the reply's text");
                };
                self.reply_comment(grant, &scope, (args.session, args.workspace), comment, body, &args.mentions).await
            }
            "org_send" => self.send(grant, &scope, &SendArgs::of(request.arguments.as_ref())).await,
            "org_sessions" => {
                let filters = SessionFilters {
                    workspace: string_arg(request, "workspace"),
                    author: string_arg(request, "author"),
                    since: string_arg(request, "since"),
                    until: string_arg(request, "until"),
                    live: request.arguments.as_ref().and_then(|a| a.get("live")).and_then(Value::as_bool),
                    q: string_arg(request, "q"),
                    limit: u32_arg(request, "limit")
                        .map_or(SESSIONS_DEFAULT_LIMIT, |n| (n as usize).min(SESSIONS_MAX_LIMIT)),
                };
                self.sessions(&scope, filters).await
            }
            "org_session" => {
                let session = (string_arg(request, "session"), string_arg(request, "workspace"));
                match string_arg(request, "entry") {
                    Some(entry) => {
                        if let Err(answer) = checked_id("an entry", entry) {
                            return answer;
                        }
                        let part = string_arg(request, "part").unwrap_or("body");
                        self.session_entry(grant, &scope, session, entry, part).await
                    }
                    None => {
                        let page = (string_arg(request, "cursor"), u32_arg(request, "limit"));
                        self.session(grant, &scope, session, page).await
                    }
                }
            }
            "org_member_activity" => {
                let args = ActivityArgs {
                    member: string_arg(request, "member"),
                    since: string_arg(request, "since"),
                    until: string_arg(request, "until"),
                    workspace: string_arg(request, "workspace"),
                };
                self.member_activity(&scope, args).await
            }
            "org_page_create" => {
                let Some(conversation) = string_arg(request, "conversation") else {
                    return tool_error(
                        "name the conversation: `conversation` is its id or channel name (see org_conversations)",
                    );
                };
                let Some(name) = string_arg(request, "name") else {
                    return tool_error("name the page: `name` is what it will be called");
                };
                self.create_page(&scope, conversation, name).await
            }
            "org_page_write" => {
                let Some(page) = string_arg(request, "page") else {
                    return tool_error("name the page: `page` is its id, as org_page_create answered it");
                };
                let Some(conversation) = string_arg(request, "conversation") else {
                    return tool_error(
                        "name the conversation whose Space holds the page: `conversation` is its id or channel name",
                    );
                };
                let document = request.arguments.as_ref().and_then(|args| args.get("document"));
                self.write_page(grant, &scope, conversation, page, document).await
            }
            other => tool_error(format!("unknown tool `{other}`")),
        }
    }
}

/// The sentinel the session and comment tools read as the current recorded
/// session.
const CURRENT: &str = "current";

/// How a tool names a recorded session: its `session` argument (an id, a
/// recorded-session link, `"current"`, or absent for the current one) and
/// its `workspace` argument (the Workspace a bare id is in).
type NamedSession<'a> = (Option<&'a str>, Option<&'a str>);

/// A recorded session a session or comment tool acts on: the current one, in
/// the grant's Workspace, or any the tool names in a Workspace of the grant's
/// organisation.
struct SessionTarget {
    id: String,
    workspace_id: String,
    /// Its title, when it is the current one (the join reads it); an explicit
    /// id is not looked up, so it has none.
    title: Option<String>,
    current: bool,
}

impl OrgTools {
    /// The recorded session a tool names: the current one when it names none
    /// or says `"current"`; else the id it gives — in `workspace` when it
    /// names one, the grant's Workspace otherwise — or the Workspace and id
    /// its recorded-session link ([`OrgLink`]) carries.
    ///
    /// **One Workspace policy**: a recorded session in any Workspace of the
    /// grant's organisation may be read, as `org_sessions` lists them — every
    /// read is asked in the grant's organisation, and the server, which knows
    /// which Workspaces this account can see, answers or refuses (403/404). A
    /// link carries no organisation, so one to another organisation's
    /// Workspace is refused there, not here. The current session is always the
    /// grant's Workspace's, so a `workspace` beside it — or beside a link that
    /// names another — is refused as a contradiction. Every id is checked
    /// ([`is_id`]) before anything is read.
    async fn session_target(
        &self,
        grant: &Grant,
        scope: &OrgScope,
        (session, workspace): NamedSession<'_>,
    ) -> Result<SessionTarget, CallToolResult> {
        let Some(grant_workspace) = scope.workspace_id.clone() else {
            return Err(tool_error(
                "this session's project is bound to the organisation but its Workspace id is not recorded yet; \
                 ask the user to reopen the project's cloud settings and start a new chat",
            ));
        };
        let named = match session {
            // A recorded-session link (a composer mention) is read first, as
            // the Workspace and id it carries.
            Some(text) if OrgLink::looks_like(text) => match OrgLink::parse(text) {
                Some(OrgLink::RecordedSession { workspace_id: linked, session_id }) => {
                    if let Some(asked) = workspace.filter(|asked| *asked != linked) {
                        return Err(tool_error(format!(
                            "the link names Workspace {linked} but `workspace` says {asked}; pass the link alone"
                        )));
                    }
                    Some((linked, session_id))
                }
                _ => {
                    return Err(tool_error(format!(
                        "\"{text}\" is not a recorded session; name one by its id or its atlas-org://recorded-session \
                         link (org_sessions lists them)"
                    )))
                }
            },
            Some(id) if !id.eq_ignore_ascii_case(CURRENT) => {
                Some((workspace.unwrap_or(&grant_workspace).to_string(), id.to_string()))
            }
            _ => None,
        };
        if let Some((workspace_id, id)) = named {
            checked_id("a Workspace", &workspace_id)?;
            checked_id("a recorded session", &id)?;
            return Ok(SessionTarget { id, workspace_id, title: None, current: false });
        }
        if workspace.is_some() {
            return Err(tool_error(
                "`workspace` goes with a recorded session id; the current session is this chat's own Workspace's",
            ));
        }
        let query = CurrentSessionQuery { scope, native_session_id: &grant.session_id, cwd: &grant.cwd };
        match self.cloud.current_session(query).await {
            Ok(Some(session)) => Ok(SessionTarget {
                id: session.id,
                workspace_id: session.workspace_id,
                title: session.title,
                current: true,
            }),
            Ok(None) => Err(tool_error(format!(
                "the current chat is {NOT_RECORDED_YET} in the Workspace; name a recorded session id \
                 instead (org_sessions lists them)"
            ))),
            Err(e) => Err(tool_error(e.to_string())),
        }
    }
}

impl OrgTools {
    /// Whether the session's caller is an admin in the grant's organisation,
    /// asked afresh on every `tools/list`. Anything short of a known admin —
    /// no organisation on the grant, the setting off, nobody signed in, a
    /// role the token does not state, a caller that cannot be read — is not,
    /// so an admin tool is only ever offered to someone the token names as one.
    async fn offers_admin_tools(&self, grant: Option<&Grant>) -> bool {
        let Some(scope) = grant.and_then(|g| g.org.as_ref()) else { return false };
        if !(self.gate)() || !self.orgs.signed_in() {
            return false;
        }
        matches!(self.cloud.caller(&scope.org_id).await, Ok(caller) if caller.role == Some(Role::Admin))
    }
}

/// The session's grant, as the listener's token check left it on the request.
fn grant_of(context: &RequestContext<RoleServer>) -> Option<Grant> {
    context
        .extensions
        .get::<axum::http::request::Parts>()
        .and_then(|parts| parts.extensions.get::<Grant>())
        .cloned()
}

impl ServerHandler for OrgTools {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(INSTRUCTIONS)
    }

    /// The tools this session is offered: [`ADMIN_TOOLS`] only when its
    /// caller is an admin in the grant's organisation.
    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let admin = self.offers_admin_tools(grant_of(&context).as_ref()).await;
        Ok(tools_list(admin))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let grant = grant_of(&context).ok_or_else(|| McpError::invalid_request("no session token", None))?;
        Ok(self.dispatch(grant, request).await.into())
    }
}

/// The service, routed at [`ORG_PATH`], for the tool-server listener to merge
/// in front of its token check.
pub fn router(tools: OrgTools) -> axum::Router {
    let service = StreamableHttpService::new(
        move || Ok(tools.clone()),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default(),
    );
    axum::Router::new().nest_service(ORG_PATH, service)
}

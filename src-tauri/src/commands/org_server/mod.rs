//! The **organisation tool server**: Atlas Agent's way to read the
//! organisation a session's Project belongs to, and to act in it as the
//! signed-in user (ADR-0014). The third MCP service on the memory tool
//! server's loopback listener, beside the UI tool server, behind the same
//! token check and on the same per-session token — the token store binds one
//! token per session, so a second minted token would revoke the first.
//!
//! - **Offered only to a connection that carries organisation access**
//!   ([`offers`]): today the in-process native connection, never an ACP one,
//!   and never decided by agent identity. Also only while the user lets the
//!   agent act in the organisation, is signed in, and the session's Project is
//!   bound to a Workspace.
//! - **Acts in the organisation the Project is bound to** ([`OrgScope`]),
//!   resolved from the Project's binding when the offer is decided and carried
//!   on the session's grant. The app's active and chat organisations are not
//!   consulted, so a switch in the window cannot redirect a call mid-turn.
//! - **Every remote operation goes through one seam** ([`OrganisationCloud`]):
//!   the production adapter ([`AppOrganisationCloud`]) over the artifacts
//!   client, the chat client and the auth core, which already hold the bearer
//!   in Rust; an in-memory organisation in the tests. The tool handlers
//!   ([`tools`]) never touch a client.
//! - **Gated by the user's organisation-access setting**
//!   ([`OrgAccessGate`]), at offer time and on every call, so switching it off
//!   stops a running session at its next call — and likewise by the account
//!   and the Project's binding ([`SessionOrgs`]): signing out, or the Project
//!   leaving the grant's organisation or Workspace, refuses the next call.
//!
//! - **Names become ids in one place** ([`resolve`]): a member or a
//!   conversation the model names is resolved against the roster or the
//!   conversation list, and more than one match comes back as candidates for
//!   the model to ask about, never a guess. A composer mention arrives as an
//!   organisation link ([`OrgLink`]) carrying the id, which every tool that
//!   takes a member, a conversation or a recorded session reads first.
//!
//! - **Every call is audited** ([`audit`]): one [`OrgActionRecord`] per call,
//!   made in the tool dispatch and emitted to the window as
//!   [`ORG_ACTION_EVENT`] for its Logs panel — refusals and failures too.
//!
//! - **Outward actions ask first** (ADR-0014): a tool that reaches another
//!   person — `org_comment_reply` and `org_send` ([`OUTWARD_TOOLS`]) — is
//!   declared on the offer as asking first, projected by the native seam
//!   with a per-tool `prompt`, and the offer describes the waiting call for
//!   the approval card ([`OrgTools::describe`]): whom it reaches, and the
//!   full body. The seam reports each call the user approves through the host
//!   into the tools' [`OutwardConsent`](atlas_agent_servers::OutwardConsent),
//!   and the tool posts only a call found there — so a call the engine runs
//!   without asking (bypass mode) is refused and nothing is sent.
//!
//! - **Some tools cross to the window** ([`WINDOW_TOOLS`]): drawing on a
//!   Space page is done by the frontend, where the page's codec lives, through
//!   the UI tool server's bridge (ADR-0012) — emitted as
//!   [`ORG_WINDOW_ACTION_EVENT`], answered through `ui_action_respond`. The
//!   arguments are checked here first, so the window is only asked to draw a
//!   document that can be drawn; a window that does not answer in time is a
//!   tool error, never a hung turn.
//!
//! `org_whoami`, `org_members`, `org_conversations`, `org_inbox`, `org_comments`,
//! `org_comment_resolve`, `org_comment_reply`, `org_sessions`, `org_session`,
//! `org_page_create`, `org_page_write`, `org_send` and (admins only, [`ADMIN_TOOLS`])
//! `org_member_activity` exist so far; the rest of the thirteen tools the spec names are
//! added on this skeleton.

mod adapter;
mod audit;
mod cloud;
mod offers;
mod resolve;
#[cfg(test)]
mod tests;
mod tools;

use std::sync::Arc;

#[allow(unused_imports)]
pub use adapter::{AppOrganisationCloud, AppSessionOrgs};
#[allow(unused_imports)]
pub use audit::{OrgActionRecord, OrgAudit, ORG_ACTION_EVENT};
#[allow(unused_imports)]
pub use cloud::{
    BoardQuery, Caller, CloudError, CloudFuture, CommentRef, CurrentSessionQuery, InboxQuery, Member, NewMessage, NewPage,
    NewReply, OrgConversation, OrganisationCloud, PayloadRef, RecordedSession, SentMessage, TimelineQuery,
};
#[allow(unused_imports)]
pub use offers::{OrgOffer, OrgOfferDecision, SessionOrgs};
pub use resolve::OrgLink;
#[allow(unused_imports)]
pub use tools::{router, OrgTools, ADMIN_TOOLS, INSTRUCTIONS, OUTWARD_TOOLS, WINDOW_TOOLS};
/// The shape every organisation id is checked for before it is used — also
/// by the UI tool server, for the ids that open a Space page.
pub(crate) use tools::is_id as is_org_id;

/// The name the server goes by in the agent's MCP configuration; its tools
/// reach the model as `mcp__atlas_org__<tool>`.
pub const ORG_SERVER_NAME: &str = "atlas_org";

/// Where the service is mounted on the tool-server listener.
pub const ORG_PATH: &str = "/org";

/// Rust → window: one organisation call for the frontend to perform
/// ([`WINDOW_TOOLS`]). The UI action's wire, under its own name so the UI
/// action dispatcher never sees it; answered by `ui_action_respond`.
pub const ORG_WINDOW_ACTION_EVENT: &str = "atlas:org-window-action";

/// Whether the user lets Atlas Agent act in the organisation (Settings →
/// General → "Let Atlas Agent act in your organisation"). Checked when a
/// session is offered the server and on every call, so switching it off stops
/// the agent at once.
pub type OrgAccessGate = Arc<dyn Fn() -> bool + Send + Sync>;

/// Where a session's organisation tools act: the organisation its Project is
/// bound to, and the Workspace the binding registered. Resolved once, from the
/// Project's binding, when the session is offered the server, and carried on
/// its grant; the tools read it from there and from nowhere else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrgScope {
    /// The organisation's server id.
    pub org_id: String,
    /// The server's Workspace id for the Project — `None` for a binding made
    /// before the server id was recorded, which still names its organisation
    /// but has no Workspace to read.
    pub workspace_id: Option<String>,
}

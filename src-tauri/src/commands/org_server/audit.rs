//! The audit trail of the organisation tool server: one record for every
//! call, whatever it answered (ADR-0014, after ADR-0012's contract for UI
//! actions). A UI action is performed by the window, so the window writes its
//! own Logs row; an organisation call never crosses to the window, so the
//! record is made here, once, in the tool dispatch — every tool, the refusals
//! before any tool runs, and the failures after — and handed to an
//! [`OrgAudit`] sink. The app's sink emits it as [`ORG_ACTION_EVENT`], and the
//! window turns it into the call's Logs row; the tests keep it.
//!
//! The record names the call and carries what the model was answered, and no
//! more. What a row says about it (the member, the conversation, the
//! organisation) is decided on the window's side, from the same table that
//! names the call's tool row in the chat, so the two never read differently.

use std::sync::Arc;

use rmcp::model::{CallToolRequestParams, CallToolResult};
use serde::Serialize;
use serde_json::Value;

use crate::commands::memory_server::Grant;

/// Rust → window: one organisation call was answered. Written to the Logs
/// panel by the window that shows the calling session.
pub const ORG_ACTION_EVENT: &str = "atlas:org-action";

/// One organisation call and its answer.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgActionRecord {
    /// The calling session's id, as its grant names it.
    pub session_id: String,
    /// The durable agent id owning the session.
    pub agent: String,
    /// The tool the model called, e.g. `org_members`.
    pub tool: String,
    /// The tool's arguments exactly as the model sent them; `{}` for none.
    pub arguments: Value,
    /// Whether the call answered, rather than being refused or failing.
    pub ok: bool,
    /// What the model was answered: the JSON result, or why it was refused.
    pub text: String,
}

impl OrgActionRecord {
    pub(super) fn of(grant: &Grant, request: &CallToolRequestParams, answer: &CallToolResult) -> Self {
        Self {
            session_id: grant.session_id.clone(),
            agent: grant.agent.clone(),
            tool: request.name.to_string(),
            arguments: Value::Object(request.arguments.clone().unwrap_or_default()),
            ok: !answer.is_error.unwrap_or(false),
            text: answer
                .content
                .iter()
                .find_map(|c| c.as_text().map(|t| t.text.clone()))
                .unwrap_or_default(),
        }
    }
}

/// Where each record goes. Called once per call, after it is answered; it
/// must not block.
pub type OrgAudit = Arc<dyn Fn(&OrgActionRecord) + Send + Sync>;

/// The sink for a server nobody audits.
pub(super) fn unaudited() -> OrgAudit {
    Arc::new(|_| {})
}

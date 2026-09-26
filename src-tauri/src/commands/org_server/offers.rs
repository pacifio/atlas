//! Whether a session request is handed the organisation tool server, and in
//! which organisation it will act.
//!
//! The memory tool server's offer ([`MemorySessionOffers`]) makes the
//! decision for all three services, because all three ride one token (see the
//! UI server's module doc); this is the organisation third of it. Unlike the
//! other two it yields something besides yes or no: the [`OrgScope`] the
//! Project is bound to, which the offer stamps on the session's grant.
//!
//! [`MemorySessionOffers`]: crate::commands::memory_server::MemorySessionOffers

use std::sync::Arc;

use super::{OrgAccessGate, OrgScope, OrgTools};

/// Whether one session request is handed the organisation tool server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrgOfferDecision {
    Included,
    /// Left out, and why.
    Omitted(&'static str),
}

impl OrgOfferDecision {
    /// Included only for a connection that carries organisation access,
    /// speaks HTTP MCP, while the user lets the agent act in the organisation,
    /// is signed in, and the session's Project is bound to a Workspace, once
    /// the server is running. Never decided by which agent it is.
    pub fn decide(
        http_mcp: bool,
        org_access: bool,
        setting_on: bool,
        signed_in: bool,
        project_bound: bool,
        server_running: bool,
    ) -> Self {
        if !http_mcp {
            Self::Omitted("agent did not advertise mcpCapabilities.http")
        } else if !org_access {
            Self::Omitted("connection does not carry organisation access")
        } else if !setting_on {
            Self::Omitted("organisation access is off in Settings")
        } else if !signed_in {
            Self::Omitted("not signed in")
        } else if !project_bound {
            Self::Omitted("project is not bound to a cloud Workspace")
        } else if !server_running {
            Self::Omitted("org tool server is not running")
        } else {
            Self::Included
        }
    }

    /// The one log line per session request.
    pub fn log_line(self, agent: &str, http_mcp: bool, org_access: bool) -> String {
        let head = format!("org tool server offer: agent={agent} http_mcp={http_mcp} org_access={org_access}");
        match self {
            Self::Included => format!("{head} org_server=included"),
            Self::Omitted(reason) => format!("{head} org_server=omitted reason=\"{reason}\""),
        }
    }
}

/// What the offer needs to know about the account and the Project, read from
/// the app's existing state: whether anyone is signed in, and which
/// organisation and Workspace a launch directory's Project is bound to. A
/// seam so the offer can be decided in a test without an account or a
/// capture store.
pub trait SessionOrgs: Send + Sync {
    /// Whether an account is signed in on this machine.
    fn signed_in(&self) -> bool;
    /// The organisation (and Workspace) the Project in `cwd` is bound to, or
    /// `None` when it is not bound to the cloud — local-only, never bound,
    /// capture switched off, or its store unreadable. A binding with no
    /// Workspace still names its organisation here; the offer, not this,
    /// decides that it is not enough.
    fn bound_to(&self, cwd: &str) -> Option<OrgScope>;
}

/// The organisation third of a session offer: the setting it consults and
/// where it learns the account and the Project's binding.
#[derive(Clone)]
pub struct OrgOffer {
    gate: OrgAccessGate,
    orgs: Arc<dyn SessionOrgs>,
    /// The tools the offered server answers with, for describing an outward
    /// call on the approval card; `None` leaves the card to the call's own
    /// arguments.
    tools: Option<OrgTools>,
}

impl OrgOffer {
    pub fn new(gate: OrgAccessGate, orgs: Arc<dyn SessionOrgs>) -> Self {
        Self { gate, orgs, tools: None }
    }

    /// Describe outward calls with `tools` — the same tools the server
    /// answers with, so the card names what the call will act on.
    pub fn describing_with(mut self, tools: OrgTools) -> Self {
        self.tools = Some(tools);
        self
    }

    /// The tools that describe an outward call, when there are any.
    pub fn tools(&self) -> Option<&OrgTools> {
        self.tools.as_ref()
    }

    /// Decide for one request, and name the organisation it would act in.
    /// The setting, the account and the binding are read only when they can
    /// matter, in that order: a connection that cannot use the server never
    /// opens a store.
    pub fn decide(
        &self,
        http_mcp: bool,
        org_access: bool,
        cwd: &str,
        server_running: bool,
    ) -> (OrgOfferDecision, Option<OrgScope>) {
        let setting_on = http_mcp && org_access && (self.gate)();
        let signed_in = setting_on && self.orgs.signed_in();
        // Bound means bound to a Workspace: a binding made before the server's
        // Workspace id was recorded names an organisation but nothing to read.
        let scope = if signed_in { self.orgs.bound_to(cwd) } else { None }
            .filter(|scope| scope.workspace_id.is_some());
        let decision =
            OrgOfferDecision::decide(http_mcp, org_access, setting_on, signed_in, scope.is_some(), server_running);
        match decision {
            OrgOfferDecision::Included => (decision, scope),
            OrgOfferDecision::Omitted(_) => (decision, None),
        }
    }
}

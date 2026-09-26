//! Handing the server to sessions.
//!
//! Every agent that can take the server is handed it on each session request
//! ([`MemorySessionOffers`]): an ACP session request carries the server in
//! `mcpServers` when the agent advertised `mcpCapabilities.http`; the native
//! agent gets it as a StreamableHttp entry in its thread's engine config. The
//! token is minted for the *request*, before a new session's id exists, and
//! bound to the id once the agent answers; an offer that never binds is
//! revoked. Each decision is logged, one line per session request.

use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use atlas_agent_servers::{AskFirst, SessionMcpOffer, SessionMcpRequest, SessionMcpServers};

use super::host::{MemoryServerHost, SharingGate};
use super::MEMORY_SERVER_NAME;
use crate::commands::org_server::{OrgOffer, OrgOfferDecision, ORG_PATH, ORG_SERVER_NAME, OUTWARD_TOOLS};
use crate::commands::ui_server::{UiOffer, UiOfferDecision, UI_PATH, UI_SERVER_NAME};

/// Whether one session request is handed the memory tool server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfferDecision {
    Included,
    /// Left out, and why.
    Omitted(&'static str),
}

impl OfferDecision {
    /// The one log line per session request: the agent, whether it advertised
    /// HTTP MCP, and whether the server was included (and if not, why).
    pub fn log_line(self, agent: &str, http_mcp: bool) -> String {
        match self {
            Self::Included => format!("memory tool server offer: agent={agent} http_mcp={http_mcp} memory_server=included"),
            Self::Omitted(reason) => format!(
                "memory tool server offer: agent={agent} http_mcp={http_mcp} memory_server=omitted reason=\"{reason}\""
            ),
        }
    }

    /// Included only for an agent that advertised HTTP MCP, in a project with
    /// shared memory on (the tools would hold nothing otherwise), once the
    /// server is running. Never decided by which agent it is.
    pub fn decide(http_mcp: bool, sharing_on: bool, server_running: bool) -> Self {
        if !http_mcp {
            Self::Omitted("agent did not advertise mcpCapabilities.http")
        } else if !sharing_on {
            Self::Omitted("shared memory is off for this project")
        } else if !server_running {
            Self::Omitted("memory tool server is not running")
        } else {
            Self::Included
        }
    }
}

/// Offers each session the memory tool server with a token of its own
/// ([`SessionMcpServers`], installed on every agent connection), and — with
/// [`with_ui`](Self::with_ui) — the UI tool server beside it on the same
/// token (ADR-0012), and — with [`with_org`](Self::with_org) — the
/// organisation tool server as the third (ADR-0014). One offer decides all
/// three because all three ride one token: the token table holds one token
/// per session, so two offers minting two tokens would revoke each other.
pub struct MemorySessionOffers {
    host: Arc<MemoryServerHost>,
    gate: SharingGate,
    ui: Option<UiOffer>,
    org: Option<OrgOffer>,
}

impl MemorySessionOffers {
    pub fn new(host: Arc<MemoryServerHost>, gate: SharingGate) -> Self {
        Self { host, gate, ui: None, org: None }
    }

    /// Also offer the UI tool server, mounted on this host at `/ui`.
    pub fn with_ui(mut self, ui: UiOffer) -> Self {
        self.ui = Some(ui);
        self
    }

    /// Also offer the organisation tool server, mounted on this host at
    /// `/org`. When it is included, the token carries the organisation and
    /// Workspace the session's Project is bound to.
    pub fn with_org(mut self, org: OrgOffer) -> Self {
        self.org = Some(org);
        self
    }
}

impl SessionMcpServers for MemorySessionOffers {
    /// An outward call on the organisation server, described by the tools
    /// that will answer it, under the grant the session's token carries — so
    /// the card reads the same organisation and Workspace the call acts in.
    fn describe_call(
        &self,
        call: atlas_agent_servers::CallToApprove<'_>,
    ) -> futures::future::BoxFuture<'static, Option<atlas_agent_servers::CallDescription>> {
        let tools = self.org.as_ref().and_then(OrgOffer::tools).filter(|_| call.server == ORG_SERVER_NAME).cloned();
        let grant = self.host.tokens().grant_for_session(&call.session_id.to_string());
        let tool = call.tool.to_string();
        let arguments = call.arguments.clone();
        Box::pin(async move {
            let (tools, grant) = (tools?, grant?);
            tools.describe(&grant, &tool, &arguments).await
        })
    }

    /// An approved outward call on the organisation server, recorded where
    /// the tools that answer it check for the user's approval (ADR-0014).
    fn approved_call(&self, call: atlas_agent_servers::CallToApprove<'_>) {
        if call.server != ORG_SERVER_NAME {
            return;
        }
        if let Some(tools) = self.org.as_ref().and_then(OrgOffer::tools) {
            tools.consent().record(call);
        }
    }

    fn offer(&self, request: &SessionMcpRequest) -> SessionMcpOffer {
        let cwd = request.cwd.to_string_lossy().into_owned();
        let agent = request.agent_id.as_str().to_string();
        // The gate reads the sharing file; only asked when it can matter.
        let sharing_on = request.http_mcp && (self.gate)(&cwd);
        let url = self.host.url();
        let decision = OfferDecision::decide(request.http_mcp, sharing_on, url.is_some());
        tracing::info!(
            target: "atlas::memory_server",
            session = request.session_id.as_ref().map(ToString::to_string).unwrap_or_default(),
            "{}",
            decision.log_line(&agent, request.http_mcp),
        );
        let ui_url = self.host.url_at(UI_PATH);
        let ui = self.ui.as_ref().map(|ui| {
            let decision = ui.decide(request.http_mcp, request.ui_control, ui_url.is_some());
            tracing::info!(
                target: "atlas::ui_server",
                session = request.session_id.as_ref().map(ToString::to_string).unwrap_or_default(),
                "{}",
                decision.log_line(&agent, request.http_mcp, request.ui_control),
            );
            decision
        });

        let org_url = self.host.url_at(ORG_PATH);
        let (org, scope) = match self.org.as_ref() {
            Some(org) => {
                let (decision, scope) = org.decide(request.http_mcp, request.org_access, &cwd, org_url.is_some());
                tracing::info!(
                    target: "atlas::org_server",
                    session = request.session_id.as_ref().map(ToString::to_string).unwrap_or_default(),
                    "{}",
                    decision.log_line(&agent, request.http_mcp, request.org_access),
                );
                (Some(decision), scope)
            }
            None => (None, None),
        };

        let mut entries: Vec<(&str, String)> = Vec::new();
        if let (OfferDecision::Included, Some(url)) = (decision, url) {
            entries.push((MEMORY_SERVER_NAME, url));
        }
        if let (Some(UiOfferDecision::Included), Some(url)) = (ui, ui_url) {
            entries.push((UI_SERVER_NAME, url));
        }
        let mut org_included = false;
        if let (Some(OrgOfferDecision::Included), Some(url)) = (org, org_url) {
            entries.push((ORG_SERVER_NAME, url));
            org_included = true;
        }
        if entries.is_empty() {
            return SessionMcpOffer::none();
        }
        // Minted once, after every decision, for every entry — carrying the
        // organisation only when the organisation server is among them (the
        // org decision names none otherwise).
        let tokens = self.host.tokens().clone();
        let token = tokens.mint_unbound(&agent, &cwd, scope);
        let servers = entries
            .into_iter()
            .map(|(name, url)| {
                acp::McpServer::Http(
                    acp::McpServerHttp::new(name, url)
                        .headers(vec![acp::HttpHeader::new("Authorization", format!("Bearer {token}"))]),
                )
            })
            .collect();
        // The organisation server's outward actions ask first (ADR-0014);
        // the host declares them, the connection projects them.
        let ask_first = if org_included {
            AskFirst::none().on(ORG_SERVER_NAME, OUTWARD_TOOLS)
        } else {
            AskFirst::none()
        };
        SessionMcpOffer::new(servers, move |session| match session {
            Some(id) => tokens.bind(&token, &id.to_string()),
            None => tokens.revoke_token(&token),
        })
        .asking_first(ask_first)
    }
}

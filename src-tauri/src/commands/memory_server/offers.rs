//! Handing the server to sessions.
//!
//! Every agent that can take the server is handed it on each session request
//! ([`MemorySessionOffers`]). An agent in another process — every ACP agent,
//! whatever it advertised — gets it as a stdio server, the Atlas binary's own
//! `mcp-bridge` forwarding to the loopback server (ADR-0019), with the token
//! in a private file the entry names, never in the entry itself: an adapter
//! may put the entry on a command line (ADR-0020). The native agent, in this
//! process, gets it as a StreamableHttp entry with the token in its header.
//! The token is minted for the *request*, before a new session's id exists,
//! and bound to the id once the agent answers; an offer that never binds is
//! revoked. Each decision is logged, one line per session request.

use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use atlas_agent_servers::{AskFirst, SessionMcpOffer, SessionMcpRequest, SessionMcpServers};

use super::host::{MemoryServerHost, SharingGate};
use super::MEMORY_SERVER_NAME;
use crate::commands::code_server::{CodeOffer, CodeOfferDecision, CODE_PATH, CODE_SERVER_NAME};
use crate::commands::memory_bridge::TokenFiles;
use crate::commands::org_server::{
    OrgOffer, OrgOfferDecision, EVERY_TIME_TOOLS, ORG_PATH, ORG_SERVER_NAME, OUTWARD_TOOLS,
};
use crate::commands::ui_server::{UiOffer, UiOfferDecision, UI_PATH, UI_SERVER_NAME};

/// Whether one session request is handed the memory tool server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfferDecision {
    /// Included over HTTP: the agent runs in this process.
    Included,
    /// Included as a stdio server through `atlas mcp-bridge`: the agent runs
    /// in another process (ADR-0019, ADR-0020).
    IncludedViaBridge,
    /// Left out, and why.
    Omitted(&'static str),
}

impl OfferDecision {
    /// The one log line per session request: the agent, whether it advertised
    /// HTTP MCP, and whether the server was included (and if not, why).
    pub fn log_line(self, agent: &str, http_mcp: bool) -> String {
        match self {
            Self::Included => format!("memory tool server offer: agent={agent} http_mcp={http_mcp} memory_server=included"),
            Self::IncludedViaBridge => format!(
                "memory tool server offer: agent={agent} http_mcp={http_mcp} memory_server=included_via_bridge"
            ),
            Self::Omitted(reason) => format!(
                "memory tool server offer: agent={agent} http_mcp={http_mcp} memory_server=omitted reason=\"{reason}\""
            ),
        }
    }

    /// Included in a project with shared memory on (the tools would hold
    /// nothing otherwise), once the server is running: over HTTP when the
    /// entry may carry the token (`over_http`: an in-process agent that takes
    /// HTTP), else through the stdio bridge. Never decided by which agent it
    /// is.
    pub fn decide(over_http: bool, sharing_on: bool, server_running: bool) -> Self {
        if !sharing_on {
            Self::Omitted("shared memory is off for this project")
        } else if !server_running {
            Self::Omitted("memory tool server is not running")
        } else if over_http {
            Self::Included
        } else {
            Self::IncludedViaBridge
        }
    }
}

/// The argument that makes the Atlas binary the stdio bridge.
pub const BRIDGE_ARG: &str = "mcp-bridge";

/// `name` at `url` as a stdio server: `<this binary> mcp-bridge <url> <token
/// file>`. Nothing in the entry is secret: an adapter may put all of it,
/// `env` included, on a command line (ADR-0020).
fn bridge_entry(
    exe: &std::path::Path,
    name: &str,
    url: String,
    token_file: &std::path::Path,
) -> acp::McpServer {
    acp::McpServer::Stdio(acp::McpServerStdio::new(name, exe.to_path_buf()).args(vec![
        BRIDGE_ARG.to_string(),
        url,
        token_file.to_string_lossy().into_owned(),
    ]))
}

impl OfferDecision {
    fn includes(self) -> bool {
        matches!(self, Self::Included | Self::IncludedViaBridge)
    }
}

/// Offers each session the memory tool server with a token of its own
/// ([`SessionMcpServers`], installed on every agent connection), and — with
/// [`with_ui`](Self::with_ui) — the UI tool server beside it on the same
/// token (ADR-0012), and — with [`with_org`](Self::with_org) — the
/// organisation tool server as the third (ADR-0014), and — with
/// [`with_code`](Self::with_code) — the code tool server as the fourth
/// (ADR-0015). One offer decides them all because they all ride one token:
/// the token table holds one token per session, so two offers minting two
/// tokens would revoke each other.
pub struct MemorySessionOffers {
    host: Arc<MemoryServerHost>,
    gate: SharingGate,
    ui: Option<UiOffer>,
    org: Option<OrgOffer>,
    code: Option<CodeOffer>,
    token_files: Arc<TokenFiles>,
}

impl MemorySessionOffers {
    /// Bridged sessions' token files go to a fresh temporary directory until
    /// [`with_token_files`](Self::with_token_files) names the app's own.
    pub fn new(host: Arc<MemoryServerHost>, gate: SharingGate) -> Self {
        Self {
            host,
            gate,
            ui: None,
            org: None,
            code: None,
            token_files: Arc::new(TokenFiles::in_temp()),
        }
    }

    /// Write bridged sessions' token files with `files` (ADR-0020), shared
    /// with whatever removes a session's file when the session ends.
    pub fn with_token_files(mut self, files: Arc<TokenFiles>) -> Self {
        self.token_files = files;
        self
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

    /// Also offer the code tool server, mounted on this host at `/code`
    /// (ADR-0015). Its own setting decides, never the sharing gate.
    pub fn with_code(mut self, code: CodeOffer) -> Self {
        self.code = Some(code);
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
        let tools = self
            .org
            .as_ref()
            .and_then(OrgOffer::tools)
            .filter(|_| call.server == ORG_SERVER_NAME)
            .cloned();
        let grant = self
            .host
            .tokens()
            .grant_for_session(&call.session_id.to_string());
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
        // Only an agent in this process may hold the token in its entry: any
        // other may put the entry on a command line (ADR-0020), so it reaches
        // the servers through this binary as a stdio bridge (ADR-0019) that
        // reads the token from a private file. Without a path to the binary,
        // it gets none.
        let over_http = request.in_process && request.http_mcp;
        let bridge = if over_http {
            None
        } else {
            std::env::current_exe().ok()
        };
        let reachable = over_http || bridge.is_some();
        // The gate reads the sharing file; only asked when it can matter.
        let sharing_on = reachable && (self.gate)(&cwd);
        let url = self.host.url();
        let decision = if reachable {
            OfferDecision::decide(over_http, sharing_on, url.is_some())
        } else {
            OfferDecision::Omitted("no transport reaches the agent")
        };
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
                let (decision, scope) = org.decide(
                    request.http_mcp,
                    request.org_access,
                    &cwd,
                    org_url.is_some(),
                );
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

        let code_url = self.host.url_at(CODE_PATH);
        let code = self.code.as_ref().map(|code| {
            // The bridge carries the code server too.
            let decision = code.decide(reachable, code_url.is_some());
            tracing::info!(
                target: "atlas::code_server",
                session = request.session_id.as_ref().map(ToString::to_string).unwrap_or_default(),
                "{}",
                decision.log_line(&agent, request.http_mcp),
            );
            decision
        });

        let mut entries: Vec<(&str, String)> = Vec::new();
        if let (true, Some(url)) = (decision.includes(), url) {
            entries.push((MEMORY_SERVER_NAME, url));
        }
        let mut ui_included = false;
        if let (Some(UiOfferDecision::Included), Some(url)) = (ui, ui_url) {
            entries.push((UI_SERVER_NAME, url));
            ui_included = true;
        }
        let mut org_included = false;
        if let (Some(OrgOfferDecision::Included), Some(url)) = (org, org_url) {
            entries.push((ORG_SERVER_NAME, url));
            org_included = true;
        }
        if let (Some(CodeOfferDecision::Included), Some(url)) = (code, code_url) {
            entries.push((CODE_SERVER_NAME, url));
        }
        if entries.is_empty() {
            return SessionMcpOffer::none();
        }
        // Minted once, after every decision, for every entry — carrying the
        // organisation only when the organisation server is among them (the
        // org decision names none otherwise).
        let tokens = self.host.tokens().clone();
        let token = tokens.mint_unbound(&agent, &cwd, scope, ui_included);
        // A bridged session's entries name one file holding the token.
        let token_file = match &bridge {
            Some(_) => match self
                .token_files
                .write(&token, |t| tokens.grant(t).is_some())
            {
                Ok(path) => Some(path),
                Err(e) => {
                    tracing::warn!(
                        target: "atlas::memory_server",
                        "no Atlas tool servers for this session: cannot write its token file: {e:#}"
                    );
                    tokens.revoke_token(&token);
                    return SessionMcpOffer::none();
                }
            },
            None => None,
        };
        let servers = entries
            .into_iter()
            .map(|(name, url)| match (&bridge, &token_file) {
                (Some(exe), Some(file)) => bridge_entry(exe, name, url, file),
                _ => acp::McpServer::Http(acp::McpServerHttp::new(name, url).headers(vec![
                    acp::HttpHeader::new("Authorization", format!("Bearer {token}")),
                ])),
            })
            .collect();
        // The organisation server's outward actions ask first (ADR-0014);
        // the host declares them, the connection projects them. A message asks
        // on every call: no "Allow for this session" on its card.
        let ask_first = if org_included {
            AskFirst::none()
                .on(ORG_SERVER_NAME, OUTWARD_TOOLS)
                .every_time(ORG_SERVER_NAME, EVERY_TIME_TOOLS)
        } else {
            AskFirst::none()
        };
        let token_files = self.token_files.clone();
        SessionMcpOffer::new(servers, move |session| match session {
            Some(id) => {
                let id = id.to_string();
                tokens.bind(&token, &id);
                // Its file goes when the session ends.
                if let Some(file) = &token_file {
                    token_files.bind(file, &id);
                }
            }
            None => {
                tokens.revoke_token(&token);
                if let Some(file) = &token_file {
                    token_files.remove(file);
                }
            }
        })
        .asking_first(ask_first)
    }
}

/// Every entry `offer` carries, as `(name, url, bearer token)`: the token
/// from an HTTP entry's header, or from the file a bridged entry names.
#[cfg(test)]
pub fn offered_entries(offer: &SessionMcpOffer) -> Vec<(String, String, String)> {
    offer
        .servers()
        .iter()
        .map(|server| match server {
            acp::McpServer::Http(http) => {
                let token = http
                    .headers
                    .iter()
                    .find(|h| h.name == "Authorization")
                    .and_then(|h| h.value.strip_prefix("Bearer "))
                    .expect("a bearer token")
                    .to_string();
                (http.name.clone(), http.url.clone(), token)
            }
            acp::McpServer::Stdio(stdio) => {
                let [arg, url, file] = stdio.args.as_slice() else {
                    panic!("mcp-bridge <url> <token file>: {:?}", stdio.args)
                };
                assert_eq!(arg, BRIDGE_ARG);
                let token = crate::commands::memory_bridge::read_token_file(file.as_ref())
                    .expect("a readable token file");
                (stdio.name.clone(), url.clone(), token)
            }
            other => panic!("{other:?}"),
        })
        .collect()
}

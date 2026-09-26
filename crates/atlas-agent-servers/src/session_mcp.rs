//! MCP servers the host hands a session.
//!
//! ACP carries MCP servers on the session request itself (`session/new`,
//! `session/load` and `session/resume` each take `mcpServers`), so what a
//! session is offered has to be settled before the request goes out. For a
//! new session that is before its id exists: the host mints whatever the
//! entry needs (a bearer token, say) against the *request*, and learns the id
//! only when the connection [binds](SessionMcpOffer::bind) the offer to the
//! session that came back. An offer that is never bound — the request failed,
//! or the connection never sent it — is released when it drops, so nothing the
//! host minted outlives an attempt that went nowhere.
//!
//! The host decides what to offer; the connection only carries it, and never
//! sends a transport the agent did not advertise ([`admissible`]). ACP makes
//! stdio mandatory for every agent and HTTP/SSE opt-in through
//! `mcpCapabilities`, and that is the only gate: never the agent's identity.

use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::AgentId;

/// What a session is being opened for, as the host sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMcpRequest {
    pub agent_id: AgentId,
    /// Whether the agent advertised `mcpCapabilities.http` at `initialize`.
    pub http_mcp: bool,
    /// Whether this connection carries **UI control**: its agent runs inside
    /// the Atlas process, so Atlas vouches for what its tool calls may do and
    /// may hand it the UI tool server (ADR-0012). A property of the
    /// connection, like `http_mcp`, never of which agent it is. ACP has no
    /// capability for it, so an ACP connection never sets it.
    pub ui_control: bool,
    /// Whether this connection carries **organisation access**: Atlas may hand
    /// it the organisation tool server, through which it reads the
    /// organisation the session's Project is bound to and acts in it as the
    /// signed-in user (ADR-0014). The same kind of property as `ui_control`,
    /// and for the same reason: only a connection whose agent runs inside the
    /// Atlas process sets it. An ACP connection never does, so a third-party
    /// binary is never handed the user's organisation — decided by the
    /// connection, never by which agent it is.
    pub org_access: bool,
    /// The directory the session runs in.
    pub cwd: PathBuf,
    /// The session being loaded or resumed; `None` for a new session, whose
    /// id arrives with the response.
    pub session_id: Option<acp::SessionId>,
}

/// A call to one of the tools a host's server offered, stopped before it runs
/// until the user approves it — an **outward action** (ADR-0014).
#[derive(Debug, Clone, Copy)]
pub struct CallToApprove<'a> {
    /// The session the call was made in.
    pub session_id: &'a acp::SessionId,
    /// The server's name in the agent's MCP configuration (`atlas_org`).
    pub server: &'a str,
    /// The tool's bare name (`org_comment_reply`).
    pub tool: &'a str,
    /// The arguments exactly as the tool will receive them.
    pub arguments: &'a serde_json::Value,
}

/// What the approval card says about a call: a title naming the act and whom
/// it reaches, the recipient in full, and the exact words that will leave the
/// device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallDescription {
    /// One line: "Reply on Ada Lovelace's comment".
    pub title: String,
    /// Who and where it reaches: the thread and its author, a channel, a DM.
    pub recipient: String,
    /// The full text that will be posted, never shortened.
    pub body: String,
}

/// Decides the MCP servers each session is handed. Supplied by the host
/// through `ConnectOptions`.
pub trait SessionMcpServers: Send + Sync {
    fn offer(&self, request: &SessionMcpRequest) -> SessionMcpOffer;

    /// Describes a call to one of the offered servers' tools that is waiting
    /// on the user's approval, for the approval card. The host owns the
    /// servers, so only the host can say who a call reaches (a comment id is
    /// not a person). `None` — the default — leaves the card to the tool's own
    /// name and arguments. Boxed, because the trait is used as `dyn` and a
    /// description may have to ask the host's cloud.
    fn describe_call(&self, call: CallToApprove<'_>) -> futures::future::BoxFuture<'static, Option<CallDescription>> {
        let _ = call;
        Box::pin(async { None })
    }

    /// The user approved this exact call — on its card, or through an "Allow
    /// for this session" that covers it — and the connection is about to let
    /// it run. The host records it ([`OutwardConsent`]) so the server that
    /// answers the call can check the user really was asked: an engine that
    /// runs a call without asking (bypass mode approves every prompted tool
    /// unasked) leaves no record, and the server refuses. The default records
    /// nothing, for a host whose servers take no outward action.
    fn approved_call(&self, call: CallToApprove<'_>) {
        let _ = call;
    }
}

/// The user's approvals of outward calls, one per approved call, held by the
/// host between the connection that asked and the tool server that answers
/// (ADR-0014).
///
/// The connection records a call when the user approves it
/// ([`SessionMcpServers::approved_call`]); the tool server
/// [takes](Self::take) the record when the call arrives, and posts only if
/// there was one. Keyed by session, server, tool and the arguments exactly as
/// the tool receives them, so an approval of one reply cannot send another,
/// and consumed on use, so one approval sends once. A record nobody takes —
/// the call never reached the server — lapses after [`CONSENT_LIFETIME`].
#[derive(Default)]
pub struct OutwardConsent {
    approved: std::sync::Mutex<Vec<ApprovedCall>>,
}

/// How long an approved call's record waits for the call to reach its server.
/// The engine calls the tool as soon as it hears the answer, so this only
/// bounds records for calls that never arrived.
pub const CONSENT_LIFETIME: std::time::Duration = std::time::Duration::from_secs(300);

struct ApprovedCall {
    session_id: String,
    server: String,
    tool: String,
    arguments: serde_json::Value,
    at: std::time::Instant,
}

/// Arguments as compared: no arguments and an empty object are the same call.
/// Object equality ignores key order, so the order a client wrote them in
/// does not matter.
fn canonical(arguments: &serde_json::Value) -> serde_json::Value {
    match arguments {
        serde_json::Value::Null => serde_json::Value::Object(serde_json::Map::new()),
        other => other.clone(),
    }
}

impl OutwardConsent {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records that the user approved `call`.
    pub fn record(&self, call: CallToApprove<'_>) {
        let mut approved = self.approved.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        approved.retain(|a| a.at.elapsed() < CONSENT_LIFETIME);
        approved.push(ApprovedCall {
            session_id: call.session_id.to_string(),
            server: call.server.to_string(),
            tool: call.tool.to_string(),
            arguments: canonical(call.arguments),
            at: std::time::Instant::now(),
        });
    }

    /// Whether the user approved this call, spending the approval: `true`
    /// once per recorded approval, `false` for a call nobody asked about.
    pub fn take(&self, session_id: &str, server: &str, tool: &str, arguments: &serde_json::Value) -> bool {
        let arguments = canonical(arguments);
        let mut approved = self.approved.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        approved.retain(|a| a.at.elapsed() < CONSENT_LIFETIME);
        let found = approved.iter().position(|a| {
            a.session_id == session_id && a.server == server && a.tool == tool && a.arguments == arguments
        });
        found.map(|i| approved.remove(i)).is_some()
    }
}

impl std::fmt::Debug for OutwardConsent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let pending = self.approved.lock().map_or(0, |a| a.len());
        f.debug_struct("OutwardConsent").field("pending", &pending).finish()
    }
}

/// Told how an offer ended: `Some(id)` when the session it was made for
/// opened with that id, `None` when it never did.
type Settle = Box<dyn FnOnce(Option<&acp::SessionId>) + Send>;

/// Per offered server, the tools that must ask the user before they run —
/// its **outward actions** (ADR-0014). The host owns its servers, so the host
/// declares which of their tools reach another person; a connection that runs
/// its agent's tool approvals itself (the native one) projects exactly these
/// as asking, and every other tool on the server keeps running unasked. A
/// connection that cannot ask per tool (ACP) is never offered a server with
/// any.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AskFirst {
    /// `(server, tool)`, in the order they were declared.
    tools: Vec<(String, String)>,
}

impl AskFirst {
    /// Nothing asks.
    pub fn none() -> Self {
        Self::default()
    }

    /// `tools` on the offered server named `server` ask first.
    #[must_use]
    pub fn on(mut self, server: &str, tools: &[&str]) -> Self {
        self.tools.extend(tools.iter().map(|tool| (server.to_string(), (*tool).to_string())));
        self
    }

    /// The tools on `server` that ask first.
    pub fn tools_on<'a>(&'a self, server: &'a str) -> impl Iterator<Item = &'a str> + 'a {
        self.tools.iter().filter(move |(s, _)| s == server).map(|(_, tool)| tool.as_str())
    }
}

/// The servers for one session request, which of their tools ask first, and
/// what to do once it is known whether that session opened.
pub struct SessionMcpOffer {
    servers: Vec<acp::McpServer>,
    ask_first: AskFirst,
    settle: Option<Settle>,
}

impl SessionMcpOffer {
    /// No servers, nothing to settle.
    pub fn none() -> Self {
        Self {
            servers: Vec::new(),
            ask_first: AskFirst::none(),
            settle: None,
        }
    }

    /// `servers`, with `settle` told whether the session opened (see
    /// [`Settle`]). Called exactly once: by [`bind`](Self::bind), or on drop.
    pub fn new(
        servers: Vec<acp::McpServer>,
        settle: impl FnOnce(Option<&acp::SessionId>) + Send + 'static,
    ) -> Self {
        Self {
            servers,
            ask_first: AskFirst::none(),
            settle: Some(Box::new(settle)),
        }
    }

    /// Declares the offered servers' tools that must ask first ([`AskFirst`]).
    #[must_use]
    pub fn asking_first(mut self, ask_first: AskFirst) -> Self {
        self.ask_first = ask_first;
        self
    }

    pub fn servers(&self) -> &[acp::McpServer] {
        &self.servers
    }

    /// The offered servers' tools that must ask first.
    pub fn ask_first(&self) -> &AskFirst {
        &self.ask_first
    }

    /// The session this offer was made for opened as `session_id`.
    pub fn bind(mut self, session_id: &acp::SessionId) {
        if let Some(settle) = self.settle.take() {
            settle(Some(session_id));
        }
    }
}

impl Drop for SessionMcpOffer {
    fn drop(&mut self) {
        if let Some(settle) = self.settle.take() {
            settle(None);
        }
    }
}

impl std::fmt::Debug for SessionMcpOffer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionMcpOffer")
            .field("servers", &self.servers.len())
            .finish_non_exhaustive()
    }
}

/// Asks `provider` for `request`'s servers; no provider offers nothing.
pub fn offer_for(
    provider: Option<&Arc<dyn SessionMcpServers>>,
    request: &SessionMcpRequest,
) -> SessionMcpOffer {
    provider.map_or_else(SessionMcpOffer::none, |p| p.offer(request))
}

/// The servers an agent with `capabilities` may be sent: stdio always (ACP
/// requires every agent to take it), HTTP and SSE only when advertised.
pub fn admissible(
    servers: &[acp::McpServer],
    capabilities: &acp::McpCapabilities,
) -> Vec<acp::McpServer> {
    servers
        .iter()
        .filter(|server| match server {
            acp::McpServer::Http(_) => capabilities.http,
            acp::McpServer::Sse(_) => capabilities.sse,
            acp::McpServer::Stdio(_) => true,
            #[allow(unreachable_patterns)]
            _ => false,
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn http(name: &str) -> acp::McpServer {
        acp::McpServer::Http(acp::McpServerHttp::new(name, "http://127.0.0.1:1/mcp"))
    }

    /// Every settle call the offer made: one entry each, `None` when the
    /// offer was released unbound.
    type SettleLog = Arc<Mutex<Vec<Option<String>>>>;

    fn recorded() -> (SettleLog, impl FnOnce(Option<&acp::SessionId>) + Send) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let sink = log.clone();
        (log, move |id: Option<&acp::SessionId>| {
            sink.lock().unwrap().push(id.map(std::string::ToString::to_string));
        })
    }

    #[test]
    fn a_bound_offer_is_settled_once_with_its_session() {
        let (log, settle) = recorded();
        SessionMcpOffer::new(vec![http("m")], settle).bind(&acp::SessionId::new("s-1"));
        assert_eq!(*log.lock().unwrap(), vec![Some("s-1".to_string())]);
    }

    #[test]
    fn an_offer_dropped_unbound_is_released() {
        let (log, settle) = recorded();
        drop(SessionMcpOffer::new(vec![http("m")], settle));
        assert_eq!(*log.lock().unwrap(), vec![None]);
    }

    fn approval<'a>(session: &'a acp::SessionId, arguments: &'a serde_json::Value) -> CallToApprove<'a> {
        CallToApprove { session_id: session, server: "atlas_org", tool: "org_comment_reply", arguments }
    }

    #[test]
    fn an_approved_call_is_consented_once_and_only_for_its_exact_arguments() {
        let consent = OutwardConsent::new();
        let session = acp::SessionId::new("s-1");
        let args = serde_json::json!({ "comment": "k1", "body": "Done." });
        consent.record(approval(&session, &args));

        let other = serde_json::json!({ "comment": "k1", "body": "Something else." });
        assert!(!consent.take("s-1", "atlas_org", "org_comment_reply", &other), "another body");
        assert!(!consent.take("s-2", "atlas_org", "org_comment_reply", &args), "another session");
        assert!(!consent.take("s-1", "atlas_org", "org_send", &args), "another tool");
        let reordered = serde_json::json!({ "body": "Done.", "comment": "k1" });
        assert!(consent.take("s-1", "atlas_org", "org_comment_reply", &reordered), "key order is not the call");
        assert!(!consent.take("s-1", "atlas_org", "org_comment_reply", &args), "spent on use");
    }

    #[test]
    fn a_call_nobody_approved_has_no_consent() {
        let consent = OutwardConsent::new();
        assert!(!consent.take("s-1", "atlas_org", "org_comment_reply", &serde_json::json!({})));
        let session = acp::SessionId::new("s-1");
        consent.record(approval(&session, &serde_json::Value::Null));
        assert!(consent.take("s-1", "atlas_org", "org_comment_reply", &serde_json::json!({})), "none is empty");
    }

    #[test]
    fn an_offer_carries_the_tools_its_host_declared_ask_first_per_server() {
        let offer = SessionMcpOffer::new(vec![http("a"), http("b")], |_| {})
            .asking_first(AskFirst::none().on("b", &["send", "reply"]));
        assert_eq!(offer.ask_first().tools_on("b").collect::<Vec<_>>(), ["send", "reply"]);
        assert_eq!(offer.ask_first().tools_on("a").count(), 0);
        assert_eq!(SessionMcpOffer::none().ask_first(), &AskFirst::none());
    }

    #[test]
    fn http_servers_reach_only_agents_that_advertised_http() {
        let servers = vec![http("m")];
        let mut caps = acp::McpCapabilities::default();
        assert!(admissible(&servers, &caps).is_empty());
        caps.http = true;
        assert_eq!(admissible(&servers, &caps), servers);
    }
}

//! Shared by the engine-turn tests over both wires: a stand-in memory tool
//! server (one `memory_search` tool over streamable HTTP on loopback,
//! recording each call's arguments and bearer header), and the offer that
//! hands it to a session.

use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1 as acp;

use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::ErrorData as McpError;
use serde_json::json;

/// `(authorization header, arguments)` per call.
pub type Calls = Arc<Mutex<Vec<(String, serde_json::Value)>>>;

/// Whether the stand-in answers a call with these arguments; a refused call
/// is an error result and is not logged, as a server that posts nothing.
pub type Gate = Arc<dyn Fn(&serde_json::Value) -> bool + Send + Sync>;

#[derive(Clone)]
struct Tools {
    calls: Calls,
    /// The one tool it lists.
    name: &'static str,
    gate: Option<Gate>,
}

impl ServerHandler for Tools {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let schema = json!({
            "type": "object",
            "properties": { "query": { "type": "string" } },
            "required": ["query"]
        });
        let serde_json::Value::Object(schema) = schema else { unreachable!() };
        Ok(ListToolsResult::with_all_items(vec![Tool::new(
            self.name,
            "Search shared memory.",
            Arc::new(schema),
        )]))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let auth = context
            .extensions
            .get::<axum::http::request::Parts>()
            .and_then(|parts| parts.headers.get("authorization"))
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let args = serde_json::Value::Object(request.arguments.unwrap_or_default());
        if self.gate.as_ref().is_some_and(|gate| !gate(&args)) {
            return Ok(CallToolResult::error(vec![ContentBlock::text("not approved by the user")]).into());
        }
        self.calls.lock().unwrap().push((auth, args));
        Ok(CallToolResult::success(vec![ContentBlock::text(
            json!({ "entries": [{ "kind": "decision", "content": "Sign JWTs with RS256" }] }).to_string(),
        )])
        .into())
    }
}

/// Serves until the test ends; returns the endpoint and the call log.
pub async fn start() -> (String, Calls) {
    start_listing("memory_search").await
}

/// The same stand-in listing one tool called `name` instead, for a test that
/// needs a server shaped like another of Atlas's.
#[allow(dead_code)]
pub async fn start_listing(name: &'static str) -> (String, Calls) {
    serve(name, None).await
}

/// The same stand-in, answering only the calls `gate` lets through — as the
/// organisation tool server posts only a call the user approved.
#[allow(dead_code)]
pub async fn start_gated(name: &'static str, gate: Gate) -> (String, Calls) {
    serve(name, Some(gate)).await
}

async fn serve(name: &'static str, gate: Option<Gate>) -> (String, Calls) {
    let calls: Calls = Arc::default();
    let tools = Tools { calls: calls.clone(), name, gate };
    let service = StreamableHttpService::new(
        move || Ok(tools.clone()),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default(),
    );
    let router = axum::Router::new().nest_service("/mcp", service);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    (format!("http://{addr}/mcp"), calls)
}

/// Offers the memory server with a fixed token, recording each request and
/// how its offer settled.
pub struct OfferingMemory {
    pub url: String,
    pub asked: Mutex<Vec<atlas_agent_servers::SessionMcpRequest>>,
    pub settled: Arc<Mutex<Vec<Option<String>>>>,
}

impl atlas_agent_servers::SessionMcpServers for OfferingMemory {
    fn offer(
        &self,
        request: &atlas_agent_servers::SessionMcpRequest,
    ) -> atlas_agent_servers::SessionMcpOffer {
        self.asked
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(request.clone());
        let server = acp::McpServer::Http(
            acp::McpServerHttp::new("atlas_memory", self.url.clone())
                .headers(vec![acp::HttpHeader::new("Authorization", "Bearer session-token")]),
        );
        let settled = self.settled.clone();
        atlas_agent_servers::SessionMcpOffer::new(vec![server], move |session| {
            settled
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(session.map(ToString::to_string));
        })
    }
}

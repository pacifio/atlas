//! The MCP servers a session request carries, observed at a real agent.
//!
//! The host offers servers per session (the memory tool server, in the app);
//! the connection carries them on `session/new`, `session/load` and
//! `session/resume`, only in transports the agent advertised, and tells the
//! host which session each offer ended up bound to.

mod support;

use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1 as acp;
use atlas_agent_servers::{SessionMcpOffer, SessionMcpRequest, SessionMcpServers};
use serde_json::json;

use support::custom;
use support::spawning::{manager_offering_mcp, session_requests};

/// Offers one HTTP server with a fresh bearer token per request, and records
/// what it was asked and how each offer settled.
/// `(token, bound session)` per settled offer — `None` for one that was
/// released.
type SettledOffers = Arc<Mutex<Vec<(String, Option<String>)>>>;

#[derive(Default)]
struct TokenOffering {
    asked: Mutex<Vec<SessionMcpRequest>>,
    settled: SettledOffers,
}

impl SessionMcpServers for TokenOffering {
    fn offer(&self, request: &SessionMcpRequest) -> SessionMcpOffer {
        let mut asked = self.asked.lock().unwrap();
        asked.push(request.clone());
        let token = format!("token-{}", asked.len());
        let server = acp::McpServer::Http(
            acp::McpServerHttp::new("atlas_memory", "http://127.0.0.1:4321/mcp")
                .headers(vec![acp::HttpHeader::new("Authorization", format!("Bearer {token}"))]),
        );
        let settled = self.settled.clone();
        SessionMcpOffer::new(vec![server], move |session| {
            settled
                .lock()
                .unwrap()
                .push((token, session.map(std::string::ToString::to_string)));
        })
    }
}

fn http_capable(extra: serde_json::Value) -> serde_json::Value {
    let mut caps = json!({ "mcpCapabilities": { "http": true } });
    if let (Some(caps), Some(extra)) = (caps.as_object_mut(), extra.as_object()) {
        caps.extend(extra.clone());
    }
    caps
}

fn the_memory_entry(token: &str) -> serde_json::Value {
    json!([{
        "type": "http",
        "name": "atlas_memory",
        "url": "http://127.0.0.1:4321/mcp",
        "headers": [{ "name": "Authorization", "value": format!("Bearer {token}") }],
    }])
}

#[tokio::test]
async fn an_agent_advertising_http_mcp_gets_the_server_with_its_token_on_session_new() {
    let offering = Arc::new(TokenOffering::default());
    let Some((manager, pid_file)) = manager_offering_mcp("mcp-new-http", http_capable(json!({})), offering.clone())
    else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };
    let thread = manager
        .new_session(custom("fake-agent"), vec![std::env::temp_dir()])
        .await
        .expect("a session opens on the real agent");

    let requests = session_requests(&pid_file);
    assert_eq!(requests.len(), 1, "{requests:?}");
    assert_eq!(requests[0].0, "session/new");
    assert_eq!(requests[0].1["mcpServers"], the_memory_entry("token-1"));

    let asked = offering.asked.lock().unwrap().clone();
    assert_eq!(asked.len(), 1);
    assert!(asked[0].http_mcp, "the host is told the agent advertised HTTP MCP");
    assert!(
        !asked[0].ui_control,
        "an ACP connection never carries UI control (ADR-0012), whatever the agent is",
    );
    assert!(
        !asked[0].org_access,
        "an ACP connection never carries organisation access (ADR-0014), whatever the agent is",
    );
    assert_eq!(asked[0].agent_id.as_str(), "fake-agent");
    assert_eq!(asked[0].session_id, None, "a new session has no id until the agent answers");
    assert_eq!(
        *offering.settled.lock().unwrap(),
        vec![("token-1".to_string(), Some("session-1".to_string()))],
        "the token is bound to the id the agent answered with",
    );

    manager.shutdown();
    drop(thread);
}

#[tokio::test]
async fn an_agent_without_http_mcp_gets_no_server_entry() {
    let offering = Arc::new(TokenOffering::default());
    let Some((manager, pid_file)) = manager_offering_mcp("mcp-new-none", json!({}), offering.clone()) else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };
    let thread = manager
        .new_session(custom("fake-agent"), vec![std::env::temp_dir()])
        .await
        .expect("a session opens on the real agent");

    let requests = session_requests(&pid_file);
    assert_eq!(requests.len(), 1, "{requests:?}");
    assert_eq!(
        requests[0].1["mcpServers"],
        json!([]),
        "an HTTP server never reaches an agent that did not advertise HTTP MCP",
    );
    let asked = offering.asked.lock().unwrap().clone();
    assert!(!asked[0].http_mcp, "the host is told the agent did not advertise HTTP MCP");

    manager.shutdown();
    drop(thread);
}

#[tokio::test]
async fn a_loaded_session_gets_the_server_and_its_token_is_bound_to_that_session() {
    let offering = Arc::new(TokenOffering::default());
    let Some((manager, pid_file)) =
        manager_offering_mcp("mcp-load", http_capable(json!({ "loadSession": true })), offering.clone())
    else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };
    let thread = manager
        .load_session(
            custom("fake-agent"),
            acp::SessionId::new("stored-7"),
            vec![std::env::temp_dir()],
            None,
        )
        .await
        .expect("the stored session loads");

    let requests = session_requests(&pid_file);
    assert_eq!(requests[0].0, "session/load");
    assert_eq!(requests[0].1["mcpServers"], the_memory_entry("token-1"));
    assert_eq!(
        offering.asked.lock().unwrap()[0].session_id,
        Some(acp::SessionId::new("stored-7")),
    );
    assert_eq!(
        *offering.settled.lock().unwrap(),
        vec![("token-1".to_string(), Some("stored-7".to_string()))],
    );

    manager.shutdown();
    drop(thread);
}

#[tokio::test]
async fn a_resumed_session_gets_the_server() {
    let offering = Arc::new(TokenOffering::default());
    let Some((manager, pid_file)) = manager_offering_mcp(
        "mcp-resume",
        http_capable(json!({ "sessionCapabilities": { "resume": {} } })),
        offering.clone(),
    ) else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };
    let thread = manager
        .resume_session(
            custom("fake-agent"),
            acp::SessionId::new("stored-8"),
            vec![std::env::temp_dir()],
            None,
        )
        .await
        .expect("the stored session resumes");

    let requests = session_requests(&pid_file);
    assert_eq!(requests[0].0, "session/resume");
    assert_eq!(requests[0].1["mcpServers"], the_memory_entry("token-1"));
    assert_eq!(
        *offering.settled.lock().unwrap(),
        vec![("token-1".to_string(), Some("stored-8".to_string()))],
    );

    manager.shutdown();
    drop(thread);
}

#[tokio::test]
async fn a_session_that_fails_to_open_releases_its_token() {
    let offering = Arc::new(TokenOffering::default());
    let Some((manager, _pid_file)) =
        manager_offering_mcp("mcp-load-fail", http_capable(json!({ "loadSession": true })), offering.clone())
    else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };
    let failed = manager
        .load_session(
            custom("fake-agent"),
            acp::SessionId::new("missing"),
            vec![std::env::temp_dir()],
            None,
        )
        .await;
    assert!(failed.is_err(), "the agent refused the load");
    assert_eq!(
        *offering.settled.lock().unwrap(),
        vec![("token-1".to_string(), None)],
        "a token for a session that never opened does not stay live",
    );
    manager.shutdown();
}

//! The UI tool server end to end over loopback with an rmcp client, beside
//! the memory tool server on its listener, and the offer that hands it out.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1 as acp;
use atlas_agent_servers::{SessionMcpOffer, SessionMcpRequest, SessionMcpServers};
use parking_lot::Mutex;
use rmcp::model::CallToolRequestParams;
use rmcp::service::RunningService;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::{RoleClient, ServiceExt};
use serde_json::{json, Value};

use super::tools::{tool_names, tools_list, INSTRUCTIONS};
use super::*;
use crate::commands::memory_server::{
    MemoryServer, MemoryServerHost, MemorySessionOffers, MemoryTokens, SessionClocks, SessionReads,
    SharingGate, Sources, TOOLS_LIST_TTL_MS,
};
use crate::commands::shared_memory::SharedMemoryStore;

fn memory() -> SharedMemoryStore {
    let t = Arc::new(AtomicI64::new(1_000));
    SharedMemoryStore::with_clock(Arc::new(move || t.fetch_add(1_000, Ordering::SeqCst)))
}

fn sharing(on: bool) -> SharingGate {
    Arc::new(move |_| on)
}

fn navigation(on: bool) -> NavigationGate {
    Arc::new(move || on)
}

/// A bridge whose "window" answers every request with `answer`, recording
/// what it was asked.
fn answering_bridge(
    answer: impl Fn(&UiRequest) -> UiReply + Send + Sync + 'static,
) -> (Arc<UiBridge>, Arc<Mutex<Vec<UiRequest>>>) {
    let asked = Arc::new(Mutex::new(Vec::new()));
    let slot: Arc<std::sync::OnceLock<Arc<UiBridge>>> = Arc::new(std::sync::OnceLock::new());
    let (log, window) = (asked.clone(), slot.clone());
    let answer = Arc::new(answer);
    let bridge = Arc::new(UiBridge::new(Arc::new(move |request: &UiRequest| {
        log.lock().push(request.clone());
        let (window, answer, request) = (window.clone(), answer.clone(), request.clone());
        // Answer from another task, as the webview does through the command.
        tokio::spawn(async move {
            let bridge = window.get().expect("bridge installed").clone();
            bridge.respond(request.request_id, answer(&request));
        });
        Ok(())
    })));
    let _ = slot.set(bridge.clone());
    (bridge, asked)
}

async fn serve(
    tokens: Arc<MemoryTokens>,
    bridge: Arc<UiBridge>,
    nav: NavigationGate,
) -> MemoryServer {
    MemoryServer::start_with(
        memory(),
        tokens,
        Arc::new(SessionClocks::default()),
        Arc::new(SessionReads::default()),
        sharing(true),
        Sources::default(),
        vec![router(UiTools::new(bridge, nav))],
    )
    .await
    .unwrap()
}

async fn connect(url: &str, token: &str) -> Result<RunningService<RoleClient, ()>, String> {
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url.to_string())
            .auth_header(token.to_string()),
    );
    ().serve(transport).await.map_err(|e| format!("{e:?}"))
}

async fn call(
    client: &RunningService<RoleClient, ()>,
    name: &'static str,
    args: Value,
) -> (bool, String) {
    let Value::Object(args) = args else {
        panic!("object args")
    };
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

// ── The tools ────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn a_call_crosses_to_the_window_and_its_result_reaches_the_model_verbatim() {
    let tokens = Arc::new(MemoryTokens::default());
    let (bridge, asked) = answering_bridge(|_| UiReply {
        ok: true,
        result: Some(json!({ "activeTabId": "editor:/p/a.ts", "tabs": [] })),
        error: None,
    });
    let server = serve(tokens.clone(), bridge.clone(), navigation(true)).await;
    let token = tokens.mint_with_ui("s1", "atlas-agent", "/p");
    let client = connect(&server.url_at(UI_PATH), &token)
        .await
        .expect("a live token connects");

    let names: Vec<String> = client
        .list_all_tools()
        .await
        .unwrap()
        .into_iter()
        .map(|t| t.name.to_string())
        .collect();
    assert_eq!(names, tool_names());

    let (err, text) = call(&client, "ui_state", json!({})).await;
    assert!(!err, "{text}");
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap(),
        json!({ "activeTabId": "editor:/p/a.ts", "tabs": [] })
    );

    let asked = asked.lock().clone();
    assert_eq!(asked.len(), 1);
    assert_eq!(
        (
            asked[0].session_id.as_str(),
            asked[0].agent.as_str(),
            asked[0].cwd.as_str(),
            asked[0].tool.as_str()
        ),
        ("s1", "atlas-agent", "/p", "ui_state"),
        "the window is told who asked, from where, and for what",
    );
    assert_eq!(asked[0].args, json!({}));
    assert_eq!(bridge.pending_len(), 0);
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refusal_from_the_window_is_a_tool_error_the_model_can_read() {
    let tokens = Arc::new(MemoryTokens::default());
    let (bridge, _) = answering_bridge(|_| UiReply {
        ok: false,
        result: None,
        error: Some("no tab abc".into()),
    });
    let server = serve(tokens.clone(), bridge, navigation(true)).await;
    let client = connect(
        &server.url_at(UI_PATH),
        &tokens.mint_with_ui("s1", "atlas-agent", "/p"),
    )
    .await
    .unwrap();
    assert_eq!(
        call(&client, "ui_state", json!({})).await,
        (true, "no tab abc".to_string())
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_space_page_opens_by_its_conversation_and_page_ids_and_a_malformed_id_never_reaches_the_window(
) {
    let tokens = Arc::new(MemoryTokens::default());
    let (bridge, asked) = answering_bridge(|_| UiReply {
        ok: true,
        result: Some(json!({ "tabId": "spaces-c-1" })),
        error: None,
    });
    let server = serve(tokens.clone(), bridge, navigation(true)).await;
    let client = connect(
        &server.url_at(UI_PATH),
        &tokens.mint_with_ui("s1", "atlas-agent", "/p"),
    )
    .await
    .unwrap();

    let open = json!({ "target": "space_page", "conversationId": "c-1", "pageId": "01J8Z3K4M5N6P7Q8R9S0T1V2W3" });
    let (err, text) = call(&client, "ui_open", open.clone()).await;
    assert!(!err, "{text}");
    assert_eq!(asked.lock().last().map(|r| r.args.clone()), Some(open));

    for (args, words) in [
        (
            json!({ "target": "space_page", "pageId": "p-1" }),
            "conversationId",
        ),
        (
            json!({ "target": "space_page", "conversationId": "c-1" }),
            "pageId",
        ),
        (
            json!({ "target": "space_page", "conversationId": "c-1", "pageId": "../p-2" }),
            "pageId",
        ),
        (
            json!({ "target": "space_page", "conversationId": "c 1", "pageId": "p-1" }),
            "conversationId",
        ),
    ] {
        let (err, text) = call(&client, "ui_open", args.clone()).await;
        assert!(err && text.contains(words), "{args}: {text}");
    }
    assert_eq!(
        asked.lock().len(),
        1,
        "only the well-formed call crossed to the window"
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn with_navigation_off_nothing_crosses_to_the_window() {
    let tokens = Arc::new(MemoryTokens::default());
    let (bridge, asked) = answering_bridge(|_| UiReply {
        ok: true,
        result: None,
        error: None,
    });
    let server = serve(tokens.clone(), bridge, navigation(false)).await;
    let client = connect(
        &server.url_at(UI_PATH),
        &tokens.mint_with_ui("s1", "atlas-agent", "/p"),
    )
    .await
    .unwrap();
    let (err, text) = call(&client, "ui_state", json!({})).await;
    assert!(err);
    assert!(text.contains("switched off"), "{text}");
    assert!(asked.lock().is_empty(), "the window was never asked");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_or_revoked_token_is_refused_on_the_ui_path() {
    let tokens = Arc::new(MemoryTokens::default());
    let (bridge, _) = answering_bridge(|_| UiReply {
        ok: true,
        result: None,
        error: None,
    });
    let server = serve(tokens.clone(), bridge, navigation(true)).await;
    assert!(connect(&server.url_at(UI_PATH), "not-a-token")
        .await
        .is_err());
    let token = tokens.mint_with_ui("s1", "atlas-agent", "/p");
    tokens.revoke("s1");
    assert!(connect(&server.url_at(UI_PATH), &token).await.is_err());
}

/// One token opens both services: the memory tools keep working with the UI
/// service mounted beside them.
#[tokio::test(flavor = "multi_thread")]
async fn one_session_token_opens_both_services() {
    let tokens = Arc::new(MemoryTokens::default());
    let (bridge, _) = answering_bridge(|_| UiReply {
        ok: true,
        result: Some(json!({})),
        error: None,
    });
    let server = serve(tokens.clone(), bridge, navigation(true)).await;
    let project = std::env::temp_dir().join(format!("atlas-ui-server-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&project).unwrap();
    let token = tokens.mint_with_ui("s1", "atlas-agent", &project.to_string_lossy());

    let memory = connect(&server.url(), &token)
        .await
        .expect("the memory service admits the token");
    let (err, text) = call(&memory, "memory_list", json!({})).await;
    assert!(!err, "{text}");
    let ui = connect(&server.url_at(UI_PATH), &token)
        .await
        .expect("the UI service admits the same token");
    assert!(!call(&ui, "ui_state", json!({})).await.0);
    memory.cancel().await.ok();
    ui.cancel().await.ok();
    let _ = std::fs::remove_dir_all(&project);
}

#[test]
fn the_tool_list_carries_the_cache_fields_the_2026_07_28_spec_requires() {
    let list = serde_json::to_value(tools_list()).unwrap();
    assert_eq!(list["ttlMs"], json!(TOOLS_LIST_TTL_MS));
    assert_eq!(list["cacheScope"], json!("private"));
}

#[test]
fn the_instructions_tell_the_agent_what_it_may_not_do() {
    assert!(INSTRUCTIONS.contains("never switch projects"));
    assert!(INSTRUCTIONS.contains("user presses Enter"));
    assert!(INSTRUCTIONS.contains("did not ask"));
}

// ── The bridge ───────────────────────────────────────────────────────────────

fn request(tool: &str) -> UiRequest {
    UiRequest {
        request_id: uuid::Uuid::new_v4(),
        session_id: "s1".into(),
        agent: "atlas-agent".into(),
        cwd: "/p".into(),
        tool: tool.into(),
        args: json!({}),
    }
}

#[tokio::test]
async fn a_window_that_never_answers_fails_the_call_instead_of_hanging_it() {
    let bridge = UiBridge::with_timeout(Arc::new(|_| Ok(())), Duration::from_millis(50));
    let err = bridge.request(request("ui_state")).await.unwrap_err();
    assert!(err.contains("did not answer"), "{err}");
    assert_eq!(bridge.pending_len(), 0, "nothing is left waiting");
}

#[tokio::test]
async fn a_request_that_cannot_be_sent_fails_at_once() {
    let bridge = UiBridge::with_timeout(
        Arc::new(|_| Err("no window".into())),
        Duration::from_secs(60),
    );
    let err = bridge.request(request("ui_state")).await.unwrap_err();
    assert!(err.contains("no window"), "{err}");
    assert_eq!(bridge.pending_len(), 0);
}

#[tokio::test]
async fn an_answer_for_nobody_is_ignored() {
    let (bridge, _) = answering_bridge(|_| UiReply {
        ok: true,
        result: None,
        error: None,
    });
    let reply = UiReply {
        ok: true,
        result: None,
        error: None,
    };
    assert!(
        !bridge.respond(uuid::Uuid::new_v4(), reply.clone()),
        "an id never issued"
    );
    bridge.request(request("ui_state")).await.unwrap();
    assert_eq!(bridge.pending_len(), 0);
}

#[test]
fn a_reply_reads_the_shape_the_window_sends() {
    let reply: UiReply = serde_json::from_value(json!({ "ok": false, "error": "nope" })).unwrap();
    assert_eq!(
        reply,
        UiReply {
            ok: false,
            result: None,
            error: Some("nope".into())
        }
    );
    let request = serde_json::to_value(request("ui_state")).unwrap();
    for key in ["requestId", "sessionId", "agent", "cwd", "tool", "args"] {
        assert!(
            request.get(key).is_some(),
            "the event carries {key}: {request}"
        );
    }
}

// ── Handing the server to sessions ───────────────────────────────────────────

async fn running_host() -> Arc<MemoryServerHost> {
    let host = Arc::new(MemoryServerHost::new());
    let (bridge, _) = answering_bridge(|_| UiReply {
        ok: true,
        result: None,
        error: None,
    });
    let server = MemoryServer::start_with(
        memory(),
        host.tokens().clone(),
        host.clocks().clone(),
        host.reads().clone(),
        sharing(true),
        Sources::default(),
        vec![router(UiTools::new(bridge, navigation(true)))],
    )
    .await
    .unwrap();
    host.adopt(server);
    host
}

fn session_request(ui_control: bool) -> SessionMcpRequest {
    SessionMcpRequest {
        // The same agent id in every case: only the connection's flag decides.
        agent_id: atlas_acp_thread::AgentId::new("atlas-agent"),
        http_mcp: true,
        ui_control,
        org_access: false,
        // UI control is only ever carried by the in-process connection.
        in_process: ui_control,
        cwd: std::path::PathBuf::from("/p"),
        session_id: None,
    }
}

/// Every entry an offer carries, as `(name, url, bearer token)`.
fn entries(offer: &SessionMcpOffer) -> Vec<(String, String, String)> {
    crate::commands::memory_server::offers::offered_entries(offer)
}

fn names(offer: &SessionMcpOffer) -> Vec<String> {
    entries(offer)
        .into_iter()
        .map(|(name, _, _)| name)
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connection_with_ui_control_is_offered_both_servers_on_one_token() {
    let host = running_host().await;
    let offers = MemorySessionOffers::new(host.clone(), sharing(true))
        .with_ui(UiOffer::new(navigation(true)));
    let offer = offers.offer(&session_request(true));
    let got = entries(&offer);
    assert_eq!(names(&offer), ["atlas_memory", UI_SERVER_NAME]);
    assert_eq!(got[0].2, got[1].2, "both services ride one token");
    assert_eq!(Some(got[1].1.clone()), host.url_at(UI_PATH));

    offer.bind(&acp::SessionId::new("s1"));
    assert_eq!(
        host.tokens().token_for("s1"),
        Some(got[0].2.clone()),
        "binding keeps the one token live"
    );
}

/// The ACP case: same agent id, only the connection's flag differs.
#[tokio::test(flavor = "multi_thread")]
async fn a_connection_without_ui_control_is_offered_memory_only() {
    let host = running_host().await;
    let offers =
        MemorySessionOffers::new(host, sharing(true)).with_ui(UiOffer::new(navigation(true)));
    assert_eq!(
        names(&offers.offer(&session_request(false))),
        ["atlas_memory"]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn with_navigation_off_only_memory_is_offered() {
    let host = running_host().await;
    let offers =
        MemorySessionOffers::new(host, sharing(true)).with_ui(UiOffer::new(navigation(false)));
    assert_eq!(
        names(&offers.offer(&session_request(true))),
        ["atlas_memory"]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn with_sharing_off_and_navigation_on_only_ui_is_offered() {
    let host = running_host().await;
    let offers =
        MemorySessionOffers::new(host, sharing(false)).with_ui(UiOffer::new(navigation(true)));
    assert_eq!(
        names(&offers.offer(&session_request(true))),
        [UI_SERVER_NAME]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn without_the_ui_half_the_offer_is_memory_only_as_before() {
    let host = running_host().await;
    let offers = MemorySessionOffers::new(host, sharing(true));
    assert_eq!(
        names(&offers.offer(&session_request(true))),
        ["atlas_memory"]
    );
}

#[test]
fn the_decision_says_whether_the_ui_server_is_included_and_why_not() {
    use UiOfferDecision::*;
    assert_eq!(UiOfferDecision::decide(true, true, true, true), Included);
    assert_eq!(
        UiOfferDecision::decide(false, true, true, true),
        Omitted("agent did not advertise mcpCapabilities.http")
    );
    assert_eq!(
        UiOfferDecision::decide(true, false, true, true),
        Omitted("connection does not carry UI control")
    );
    assert_eq!(
        UiOfferDecision::decide(true, true, false, true),
        Omitted("agent navigation is off in Settings")
    );
    assert_eq!(
        UiOfferDecision::decide(true, true, true, false),
        Omitted("ui tool server is not running")
    );
}

#[test]
fn each_decision_is_one_log_line_naming_the_agent_its_capabilities_and_the_outcome() {
    assert_eq!(
        UiOfferDecision::Included.log_line("atlas-agent", true, true),
        "ui tool server offer: agent=atlas-agent http_mcp=true ui_control=true ui_server=included",
    );
    assert_eq!(
        UiOfferDecision::decide(true, false, true, true).log_line("claude-code", true, false),
        "ui tool server offer: agent=claude-code http_mcp=true ui_control=false ui_server=omitted reason=\"connection does not carry UI control\"",
    );
}

#[test]
fn the_setting_is_not_read_for_a_connection_that_cannot_use_the_server() {
    let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = reads.clone();
    let ui = UiOffer::new(Arc::new(move || {
        counted.fetch_add(1, Ordering::SeqCst);
        true
    }));
    ui.decide(true, false, true);
    ui.decide(false, true, true);
    assert_eq!(reads.load(Ordering::SeqCst), 0);
}

// ── Who the UI service admits (0.3.4 hardening) ──────────────────────────────

/// A host serving the UI tools on a bridge that records what the window is
/// asked, and the offers handing it out.
async fn recording_host(
    nav: NavigationGate,
) -> (
    Arc<MemoryServerHost>,
    MemorySessionOffers,
    Arc<Mutex<Vec<UiRequest>>>,
) {
    let host = Arc::new(MemoryServerHost::new());
    let (bridge, asked) = answering_bridge(|_| UiReply {
        ok: true,
        result: Some(json!({})),
        error: None,
    });
    let server = MemoryServer::start_with(
        memory(),
        host.tokens().clone(),
        host.clocks().clone(),
        host.reads().clone(),
        sharing(true),
        Sources::default(),
        vec![router(UiTools::new(bridge, nav.clone()))],
    )
    .await
    .unwrap();
    host.adopt(server);
    let offers = MemorySessionOffers::new(host.clone(), sharing(true)).with_ui(UiOffer::new(nav));
    (host, offers, asked)
}

/// ADR-0012: an ACP connection never gets `atlas_ui`. The listener's one token
/// opens every service on it, so the memory token an ACP session is offered
/// must not reach the window through `/ui` either.
#[tokio::test(flavor = "multi_thread")]
async fn a_memory_token_offered_without_ui_control_cannot_drive_the_window() {
    let (host, offers, asked) = recording_host(navigation(true)).await;
    let offer = offers.offer(&session_request(false));
    assert_eq!(names(&offer), ["atlas_memory"]);
    let token = entries(&offer)[0].2.clone();
    offer.bind(&acp::SessionId::new("acp-1"));

    let ui_url = host.url_at(UI_PATH).expect("the UI service is mounted");
    if let Ok(client) = connect(&ui_url, &token).await {
        for (tool, args) in [
            ("ui_state", json!({})),
            (
                "ui_chat",
                json!({ "op": "send", "tabId": "chat-1", "text": "hi" }),
            ),
            ("ui_terminal", json!({ "op": "type", "text": "ls" })),
        ] {
            let (err, text) = call(&client, tool, args).await;
            assert!(err, "{tool} answered an ACP session's token: {text}");
            assert!(text.contains("not offered"), "{tool}: {text}");
        }
        client.cancel().await.ok();
    }
    assert!(asked.lock().is_empty(), "the window was never asked");
}

/// The contrast: the same offer on a connection with UI control drives it.
#[tokio::test(flavor = "multi_thread")]
async fn a_token_offered_with_ui_control_drives_the_window() {
    let (host, offers, asked) = recording_host(navigation(true)).await;
    let offer = offers.offer(&session_request(true));
    let token = entries(&offer)[0].2.clone();
    offer.bind(&acp::SessionId::new("s1"));
    let client = connect(&host.url_at(UI_PATH).unwrap(), &token)
        .await
        .unwrap();
    let (err, text) = call(&client, "ui_state", json!({})).await;
    assert!(!err, "{text}");
    assert_eq!(asked.lock().len(), 1);
    client.cancel().await.ok();
}

/// The setting is read on every call, not only at offer: switching it off
/// refuses the very next call on an already connected client.
#[tokio::test(flavor = "multi_thread")]
async fn switching_navigation_off_refuses_the_next_call_of_a_connected_client() {
    let flag = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let read = flag.clone();
    let nav: NavigationGate = Arc::new(move || read.load(Ordering::SeqCst));
    let tokens = Arc::new(MemoryTokens::default());
    let (bridge, asked) = answering_bridge(|_| UiReply {
        ok: true,
        result: Some(json!({})),
        error: None,
    });
    let server = serve(tokens.clone(), bridge, nav).await;
    let client = connect(
        &server.url_at(UI_PATH),
        &tokens.mint_with_ui("s1", "atlas-agent", "/p"),
    )
    .await
    .unwrap();
    assert!(!call(&client, "ui_state", json!({})).await.0);
    flag.store(false, Ordering::SeqCst);
    let (err, text) = call(&client, "ui_state", json!({})).await;
    assert!(err && text.contains("switched off"), "{text}");
    flag.store(true, Ordering::SeqCst);
    assert!(
        !call(&client, "ui_state", json!({})).await.0,
        "and it resumes when switched back on"
    );
    assert_eq!(asked.lock().len(), 2, "the refused call never crossed");
    client.cancel().await.ok();
}

/// No `Authorization`, or anything but `Bearer <live token>`, is a 401 before
/// any MCP handling.
#[tokio::test(flavor = "multi_thread")]
async fn a_missing_or_non_bearer_authorization_is_refused_on_the_ui_path() {
    let tokens = Arc::new(MemoryTokens::default());
    let (bridge, _) = answering_bridge(|_| UiReply {
        ok: true,
        result: None,
        error: None,
    });
    let server = serve(tokens.clone(), bridge, navigation(true)).await;
    let token = tokens.mint_with_ui("s1", "atlas-agent", "/p");
    let init = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "t", "version": "0" } } });
    let http = reqwest::Client::new();
    for auth in [
        None,
        Some(format!("Basic {token}")),
        Some(token.clone()),
        Some("Bearer ".to_string()),
    ] {
        let mut req = http
            .post(server.url_at(UI_PATH))
            .header("Accept", "application/json, text/event-stream")
            .json(&init);
        if let Some(auth) = &auth {
            req = req.header("Authorization", auth);
        }
        let status = req.send().await.unwrap().status();
        assert_eq!(status, reqwest::StatusCode::UNAUTHORIZED, "{auth:?}");
    }
}

/// Two calls in flight at once each get their own answer: the bridge pairs
/// replies by request id, not by order.
#[tokio::test(flavor = "multi_thread")]
async fn concurrent_calls_each_get_their_own_answer() {
    let tokens = Arc::new(MemoryTokens::default());
    // The window echoes the path it was asked to open, the first one slowly,
    // so the replies arrive in the reverse order of the requests.
    let slot: Arc<std::sync::OnceLock<Arc<UiBridge>>> = Arc::new(std::sync::OnceLock::new());
    let window = slot.clone();
    let bridge = Arc::new(UiBridge::new(Arc::new(move |request: &UiRequest| {
        let (window, request) = (window.clone(), request.clone());
        tokio::spawn(async move {
            let path = request.args["path"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            if path == "a.ts" {
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            let reply = UiReply {
                ok: true,
                result: Some(json!({ "path": path })),
                error: None,
            };
            window
                .get()
                .expect("bridge installed")
                .respond(request.request_id, reply);
        });
        Ok(())
    })));
    let _ = slot.set(bridge.clone());
    let server = serve(tokens.clone(), bridge.clone(), navigation(true)).await;
    let client = connect(
        &server.url_at(UI_PATH),
        &tokens.mint_with_ui("s1", "atlas-agent", "/p"),
    )
    .await
    .unwrap();
    let (a, b) = tokio::join!(
        call(
            &client,
            "ui_open",
            json!({ "target": "file", "path": "a.ts" })
        ),
        call(
            &client,
            "ui_open",
            json!({ "target": "file", "path": "b.ts" })
        ),
    );
    assert_eq!(
        serde_json::from_str::<Value>(&a.1).unwrap(),
        json!({ "path": "a.ts" })
    );
    assert_eq!(
        serde_json::from_str::<Value>(&b.1).unwrap(),
        json!({ "path": "b.ts" })
    );
    assert_eq!(bridge.pending_len(), 0);
    client.cancel().await.ok();
}

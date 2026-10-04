//! The code tool server end to end over loopback with an rmcp client, on the
//! memory tool server's listener, the offer that hands it out, and the
//! project search overlay's command.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1 as acp;
use atlas_agent_servers::{SessionMcpOffer, SessionMcpRequest, SessionMcpServers};
use rmcp::model::CallToolRequestParams;
use rmcp::service::RunningService;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::{RoleClient, ServiceExt};
use serde_json::{json, Value};

use super::tools::{run_bounded, tool_names};
use super::*;
use crate::commands::memory_server::{
    MemoryServer, MemoryServerHost, MemorySessionOffers, SharingGate, Sources,
};
use crate::commands::shared_memory::SharedMemoryStore;

fn memory() -> SharedMemoryStore {
    let t = Arc::new(AtomicI64::new(1_000));
    SharedMemoryStore::with_clock(Arc::new(move || t.fetch_add(1_000, Ordering::SeqCst)))
}

fn sharing(on: bool) -> SharingGate {
    Arc::new(move |_| on)
}

fn enabled(on: bool) -> CodeToolsGate {
    Arc::new(move || on)
}

/// A project directory holding `files` (relative path, text).
fn project(files: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temp dir");
    for (rel, body) in files {
        let path = dir.path().join(rel);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dirs");
        std::fs::write(path, body).expect("write");
    }
    dir
}

/// A host serving the code tools beside the memory tools, as the app does.
async fn running_host(gate: CodeToolsGate) -> Arc<MemoryServerHost> {
    running_host_with(CodeTools::new(gate)).await
}

/// [`running_host`] with the code tools built by the caller.
async fn running_host_with(tools: CodeTools) -> Arc<MemoryServerHost> {
    let host = Arc::new(MemoryServerHost::new());
    let server = MemoryServer::start_with(
        memory(),
        host.tokens().clone(),
        host.clocks().clone(),
        host.reads().clone(),
        sharing(true),
        Sources::default(),
        vec![router(tools)],
    )
    .await
    .unwrap();
    host.adopt(server);
    host
}

/// A native agent's client on `/code` for a session launched in `dir`.
async fn client_in(
    host: &MemoryServerHost,
    dir: &std::path::Path,
) -> RunningService<RoleClient, ()> {
    client_as(host, dir, atlas_native_agent::ATLAS_AGENT_ID).await
}

/// [`client_in`] for the session of `agent`.
async fn client_as(
    host: &MemoryServerHost,
    dir: &std::path::Path,
    agent: &str,
) -> RunningService<RoleClient, ()> {
    let token = host.tokens().mint("s1", agent, &dir.to_string_lossy());
    let url = host.url_at(CODE_PATH).expect("the server is running");
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url).auth_header(token),
    );
    ().serve(transport).await.expect("a live token connects")
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
async fn grep_and_find_files_answer_from_the_session_directory() {
    let dir = project(&[
        ("src/lib.rs", "pub fn needle() {}\n"),
        ("README.md", "nothing\n"),
    ]);
    let host = running_host(enabled(true)).await;
    let client = client_in(&host, dir.path()).await;

    let tools = client.list_all_tools().await.unwrap();
    let names: Vec<String> = tools.iter().map(|t| t.name.to_string()).collect();
    assert_eq!(names, tool_names());
    assert!(
        tools
            .iter()
            .all(|t| t.annotations.as_ref().and_then(|a| a.read_only_hint) == Some(true)),
        "both tools are read-only, so an agent may run them in parallel"
    );

    let (err, text) = call(
        &client,
        "grep",
        json!({ "pattern": "fn needle", "output_mode": "content" }),
    )
    .await;
    assert!(!err, "{text}");
    assert!(
        text.contains("src/lib.rs\n1:pub fn needle() {}\n"),
        "{text}"
    );

    let (err, text) = call(&client, "find_files", json!({ "query": "*.md" })).await;
    assert!(!err, "{text}");
    assert!(
        text.contains("paths: 1  (cols: path)\n  README.md\n"),
        "{text}"
    );
    client.cancel().await.ok();
}

/// Review focus 1: an agent greps for text it has just written.
#[tokio::test(flavor = "multi_thread")]
async fn an_agent_finds_text_it_just_wrote() {
    let dir = project(&[("src/lib.rs", "fn old() {}\n")]);
    let host = running_host(enabled(true)).await;
    let client = client_in(&host, dir.path()).await;
    let (_, before) = call(&client, "grep", json!({ "pattern": "just_written" })).await;
    assert!(before.starts_with("No matches"), "{before}");
    std::fs::write(dir.path().join("src/new.rs"), "fn just_written() {}\n").unwrap();
    let (err, after) = call(&client, "grep", json!({ "pattern": "just_written" })).await;
    assert!(!err && after.contains("  src/new.rs\n"), "{after}");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_path_outside_the_session_directory_is_a_tool_error() {
    let dir = project(&[("a.txt", "needle\n")]);
    let host = running_host(enabled(true)).await;
    let client = client_in(&host, dir.path()).await;
    let (err, text) = call(&client, "grep", json!({ "pattern": "x", "path": "../" })).await;
    assert!(err && text.contains("outside the session root"), "{text}");
    let (err, text) = call(&client, "find_files", json!({ "query": "*", "path": "/" })).await;
    assert!(err && text.contains("outside the session root"), "{text}");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pattern_the_engine_cannot_compile_says_what_to_do_instead() {
    let dir = project(&[("a.txt", "ab\n")]);
    let host = running_host(enabled(true)).await;
    let client = client_in(&host, dir.path()).await;
    let (err, text) = call(&client, "grep", json!({ "pattern": "(?<=a)b" })).await;
    assert!(err, "{text}");
    assert!(
        text.contains("look-around") && text.contains("literal=true"),
        "{text}"
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn bad_arguments_are_a_tool_error_that_names_the_field() {
    let dir = project(&[("a.txt", "x\n")]);
    let host = running_host(enabled(true)).await;
    let client = client_in(&host, dir.path()).await;
    let (err, text) = call(&client, "grep", json!({})).await;
    assert!(err && text.contains("pattern"), "{text}");
    let (err, text) = call(
        &client,
        "grep",
        json!({ "pattern": "x", "output_mode": "lines" }),
    )
    .await;
    assert!(err && text.contains("output_mode"), "{text}");
    let (err, text) = call(
        &client,
        "find_files",
        json!({ "query": "x", "mode": "regex" }),
    )
    .await;
    assert!(err && text.contains("mode"), "{text}");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn max_output_tokens_bounds_the_reply() {
    let line = format!("needle {}\n", "z".repeat(280));
    let files: Vec<(String, String)> = (0..50)
        .map(|i| (format!("f{i:02}.txt"), line.clone()))
        .collect();
    let refs: Vec<(&str, &str)> = files
        .iter()
        .map(|(n, b)| (n.as_str(), b.as_str()))
        .collect();
    let dir = project(&refs);
    let host = running_host(enabled(true)).await;
    let client = client_in(&host, dir.path()).await;
    let (err, text) = call(
        &client,
        "grep",
        json!({ "pattern": "needle", "output_mode": "content", "max_output_tokens": 1000 }),
    )
    .await;
    assert!(!err, "{text}");
    assert!(text.len() <= 4_000, "{} bytes", text.len());
    assert!(text.contains("truncation: output_budget"), "{text}");
    client.cancel().await.ok();
}

/// Switching the setting off stops a running session's calls at once.
#[tokio::test(flavor = "multi_thread")]
async fn with_code_tools_off_every_call_is_refused() {
    let dir = project(&[("a.txt", "needle\n")]);
    let host = running_host(enabled(false)).await;
    let client = client_in(&host, dir.path()).await;
    for (tool, args) in [
        ("grep", json!({ "pattern": "needle" })),
        ("find_files", json!({ "query": "a" })),
    ] {
        let (err, text) = call(&client, tool, args).await;
        assert!(err && text.contains("Settings"), "{tool}: {text}");
    }
    client.cancel().await.ok();
}

// ── Cancellation ─────────────────────────────────────────────────────────────

/// A worker that spins until its token is cancelled, then reports in.
fn spin_until_cancelled(
    done: std::sync::mpsc::Sender<()>,
) -> impl FnOnce(&atlas_search::CancelToken) + Send + 'static {
    move |cancel| {
        while !cancel.is_cancelled() {
            std::thread::sleep(Duration::from_millis(5));
        }
        let _ = done.send(());
    }
}

/// The turn was interrupted: the engine drops the call's future.
#[tokio::test(flavor = "multi_thread")]
async fn dropping_the_call_stops_the_search() {
    let (done, stopped) = std::sync::mpsc::channel();
    let call = run_bounded(
        spin_until_cancelled(done),
        std::future::pending::<()>(),
        Duration::from_secs(60),
    );
    assert!(tokio::time::timeout(Duration::from_millis(50), call)
        .await
        .is_err());
    stopped
        .recv_timeout(Duration::from_secs(5))
        .expect("the worker saw the cancel");
}

/// The client sent `notifications/cancelled`.
#[tokio::test(flavor = "multi_thread")]
async fn a_cancel_notification_stops_the_search() {
    let (done, stopped) = std::sync::mpsc::channel();
    let answer = run_bounded(
        spin_until_cancelled(done),
        tokio::time::sleep(Duration::from_millis(20)),
        Duration::from_secs(60),
    )
    .await;
    assert_eq!(answer, None);
    stopped
        .recv_timeout(Duration::from_secs(5))
        .expect("the worker saw the cancel");
}

/// A deadline is not a cancel: the search answers with what it found.
#[tokio::test(flavor = "multi_thread")]
async fn the_deadline_lets_the_search_answer_with_what_it_found() {
    let answer = run_bounded(
        |cancel: &atlas_search::CancelToken| {
            while !cancel.is_cancelled() {
                std::thread::sleep(Duration::from_millis(5));
            }
            "partial"
        },
        std::future::pending::<()>(),
        Duration::from_millis(30),
    )
    .await;
    assert_eq!(answer, Some("partial"));
}

// ── The offer ────────────────────────────────────────────────────────────────

fn session_request(http_mcp: bool) -> SessionMcpRequest {
    SessionMcpRequest {
        // An ACP agent: the code server is not decided by agent identity.
        agent_id: atlas_acp_thread::AgentId::new("claude-code"),
        http_mcp,
        ui_control: false,
        org_access: false,
        cwd: std::path::PathBuf::from("/p"),
        session_id: None,
    }
}

/// Every entry an offer carries, as `(name, url, bearer token)`.
fn entries(offer: &SessionMcpOffer) -> Vec<(String, String, String)> {
    offer
        .servers()
        .iter()
        .map(|server| {
            let acp::McpServer::Http(http) = server else {
                panic!("HTTP entries only")
            };
            let token = http
                .headers
                .iter()
                .find(|h| h.name == "Authorization")
                .and_then(|h| h.value.strip_prefix("Bearer "))
                .expect("a bearer token")
                .to_string();
            (http.name.clone(), http.url.clone(), token)
        })
        .collect()
}

fn names(offer: &SessionMcpOffer) -> Vec<String> {
    entries(offer)
        .into_iter()
        .map(|(name, _, _)| name)
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn an_http_agent_is_offered_the_code_server_on_the_memory_token() {
    let host = running_host(enabled(true)).await;
    let offers = MemorySessionOffers::new(host.clone(), sharing(true))
        .with_code(CodeOffer::new(enabled(true)));
    let offer = offers.offer(&session_request(true));
    let got = entries(&offer);
    assert_eq!(names(&offer), ["atlas_memory", CODE_SERVER_NAME]);
    assert_eq!(got[0].2, got[1].2, "both services ride one token");
    assert_eq!(Some(got[1].1.clone()), host.url_at(CODE_PATH));

    offer.bind(&acp::SessionId::new("s1"));
    assert_eq!(
        host.tokens().token_for("s1"),
        Some(got[1].2.clone()),
        "binding keeps the one token live"
    );
}

/// ADR-0015: code search stores nothing, so the sharing toggle does not gate it.
#[tokio::test(flavor = "multi_thread")]
async fn with_shared_memory_off_the_code_server_is_still_offered() {
    let host = running_host(enabled(true)).await;
    let offers =
        MemorySessionOffers::new(host, sharing(false)).with_code(CodeOffer::new(enabled(true)));
    assert_eq!(
        names(&offers.offer(&session_request(true))),
        [CODE_SERVER_NAME]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn with_code_tools_off_the_code_server_is_not_offered() {
    let host = running_host(enabled(true)).await;
    let offers =
        MemorySessionOffers::new(host, sharing(true)).with_code(CodeOffer::new(enabled(false)));
    assert_eq!(
        names(&offers.offer(&session_request(true))),
        ["atlas_memory"]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_without_http_mcp_is_offered_nothing() {
    let host = running_host(enabled(true)).await;
    let offers =
        MemorySessionOffers::new(host, sharing(true)).with_code(CodeOffer::new(enabled(true)));
    assert!(names(&offers.offer(&session_request(false))).is_empty());
}

#[test]
fn the_decision_says_whether_the_code_server_is_included_and_why_not() {
    use CodeOfferDecision::*;
    assert_eq!(CodeOfferDecision::decide(true, true, true), Included);
    assert_eq!(
        CodeOfferDecision::decide(false, true, true),
        Omitted("agent did not advertise mcpCapabilities.http")
    );
    assert_eq!(
        CodeOfferDecision::decide(true, false, true),
        Omitted("code tools are off in Settings")
    );
    assert_eq!(
        CodeOfferDecision::decide(true, true, false),
        Omitted("code tool server is not running")
    );
    assert_eq!(
        Included.log_line("claude-code", true),
        "code tool server offer: agent=claude-code http_mcp=true code_server=included"
    );
    assert_eq!(
        Omitted("x").log_line("atlas-agent", false),
        "code tool server offer: agent=atlas-agent http_mcp=false code_server=omitted reason=\"x\""
    );
}

// ── The project search overlay ───────────────────────────────────────────────

/// The overlay's defaults: literal, case-insensitive, any substring, 100 lines.
fn overlay_defaults() -> OverlaySearch {
    OverlaySearch {
        max_results: 100,
        ..OverlaySearch::default()
    }
}

async fn overlay(
    root: &str,
    query: &str,
    options: OverlaySearch,
) -> Result<CodeGrepResult, String> {
    grep_overlay(root.to_string(), query.to_string(), options, None).await
}

#[tokio::test(flavor = "multi_thread")]
async fn code_grep_is_literal_and_case_insensitive_unless_asked() {
    let dir = project(&[("a.ts", "const Foo = foo(1);\nfoo.bar\n")]);
    let root = dir.path().to_string_lossy().into_owned();
    let lines = |res: &CodeGrepResult| res.matches.iter().map(|m| m.line).collect::<Vec<_>>();

    let literal = overlay(&root, "foo(", overlay_defaults()).await.unwrap();
    assert_eq!(lines(&literal), [1], "a regex metacharacter is just text");
    let cased = overlay(
        &root,
        "Foo",
        OverlaySearch {
            case_sensitive: true,
            ..overlay_defaults()
        },
    )
    .await
    .unwrap();
    assert_eq!(cased.total_matches, 1);
    let regex = overlay(
        &root,
        r"foo\.\w+",
        OverlaySearch {
            regex: true,
            ..overlay_defaults()
        },
    )
    .await
    .unwrap();
    assert_eq!(lines(&regex), [2]);
    let word = overlay(
        &root,
        "fo",
        OverlaySearch {
            whole_word: true,
            ..overlay_defaults()
        },
    )
    .await
    .unwrap();
    assert_eq!(word.total_matches, 0, "whole word: `fo` is inside `foo`");
    let err = overlay(
        &root,
        "(",
        OverlaySearch {
            regex: true,
            ..overlay_defaults()
        },
    )
    .await
    .unwrap_err();
    assert!(err.contains("regex error"), "{err}");

    let capped = overlay(
        &root,
        "o",
        OverlaySearch {
            max_results: 1,
            ..overlay_defaults()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(&capped).unwrap(),
        json!({
            "matches": [{ "path": "a.ts", "line": 1, "text": "const Foo = foo(1);" }],
            "totalMatches": 2,
            "totalFiles": 1,
            "truncated": true,
            "partial": false
        }),
        "the shape `code-search-api.ts` reads"
    );
}

// ── The code index (Phase 2) ─────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn symbol_tools_answer_from_the_code_index_and_grep_names_the_symbol() {
    let dir = project(&[(
        "src/lib.rs",
        "pub struct Store;\nimpl Store {\n    pub fn open() -> Self {\n        // needle\n        Store\n    }\n}\n",
    )]);
    let registry = Arc::new(crate::commands::code_index::CodeIndexRegistry::new(None));
    registry
        .ensure_open(dir.path())
        .unwrap()
        .enqueue_and_wait(crate::commands::code_index::Job::Reconcile)
        .await
        .unwrap()
        .unwrap();
    let tools = CodeTools::new(enabled(true)).with_index(registry);
    let host = running_host_with(tools).await;
    let client = client_in(&host, dir.path()).await;
    let (_, found) = call(&client, "find_symbol", json!({ "query": "open" })).await;
    assert!(found.contains("Store::open"), "{found}");
    let (_, outline) = call(&client, "outline", json!({ "path": "src/lib.rs" })).await;
    assert!(
        outline.contains("struct") && outline.contains("Store"),
        "{outline}"
    );
    let (_, grep) = call(
        &client,
        "grep",
        json!({ "pattern": "needle", "output_mode": "content" }),
    )
    .await;
    assert!(
        grep.contains("Store::open"),
        "grep group names its symbol: {grep}"
    );
    client.cancel().await.ok();
}

/// An ACP agent ships its own grep and file finder: it is listed only the
/// code index's tools, and a call to `grep` is refused.
#[tokio::test(flavor = "multi_thread")]
async fn an_acp_agent_is_listed_the_index_tools_but_not_grep_or_find_files() {
    let dir = project(&[("src/lib.rs", "pub fn needle() {}\n")]);
    let registry = Arc::new(crate::commands::code_index::CodeIndexRegistry::new(None));
    let tools = CodeTools::new(enabled(true)).with_index(registry);
    let host = running_host_with(tools).await;

    let acp = client_as(&host, dir.path(), "claude-code").await;
    let listed: Vec<String> = acp
        .list_all_tools()
        .await
        .unwrap()
        .iter()
        .map(|t| t.name.to_string())
        .collect();
    let index: Vec<String> = crate::commands::code_index::index_tool_specs()
        .into_iter()
        .map(|(name, _, _)| name.to_string())
        .collect();
    assert_eq!(listed, index);
    for (name, args) in [
        ("grep", json!({ "pattern": "needle" })),
        ("find_files", json!({ "query": "*.rs" })),
    ] {
        let (err, text) = call(&acp, name, args).await;
        assert!(err && text.contains("not offered to this agent"), "{text}");
    }
    acp.cancel().await.ok();

    let native = client_in(&host, dir.path()).await;
    let listed: Vec<String> = native
        .list_all_tools()
        .await
        .unwrap()
        .iter()
        .map(|t| t.name.to_string())
        .collect();
    assert_eq!(listed, [tool_names(), index].concat());
    native.cancel().await.ok();
}

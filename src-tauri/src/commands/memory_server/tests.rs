//! The memory tool server, end to end over loopback with an rmcp client, and
//! the pure ranking behind the briefing.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use atlas_agent_servers::{SessionMcpOffer, SessionMcpRequest, SessionMcpServers};
use atlas_memory::record::{Embedder, Embedding, Entry, EntryKind, NewEntry};
use parking_lot::Mutex;
use rmcp::model::{CallToolRequestParams, JsonObject};
use rmcp::service::RunningService;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::{RoleClient, ServiceExt};
use serde_json::{json, Value};

use super::briefing::{rank_index, score, SessionClocks, SessionReads, INDEX_MAX_ENTRIES};
use super::tools::{
    tool_names, tools_list, Bootstrap, BootstrapSource, IndexDoc, IndexEvict, IndexSearch,
    TOOLS_LIST_TTL_MS,
};
use super::*;
use crate::commands::agent_host::SessionLifecycle;
use crate::commands::memory_pack::{Handoff, PackEntry};
use crate::commands::shared_memory::{
    store_for, EventKind, MemoryChanged, RawEvent, SharedMemoryStore,
};

pub(super) fn temp_project(label: &str) -> String {
    let dir = std::env::temp_dir().join(format!(
        "atlas-memory-server-{label}-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir.to_string_lossy().into_owned()
}

/// A store whose clock advances one second per read, so every write has its
/// own `updated_at`.
pub(super) fn ticking_memory() -> SharedMemoryStore {
    let t = Arc::new(AtomicI64::new(1_000));
    SharedMemoryStore::with_clock(Arc::new(move || t.fetch_add(1_000, Ordering::SeqCst)))
}

pub(super) fn always_on() -> SharingGate {
    Arc::new(|_| true)
}

pub(super) async fn serve(
    memory: SharedMemoryStore,
    tokens: Arc<MemoryTokens>,
    gate: SharingGate,
    sources: Sources,
) -> MemoryServer {
    MemoryServer::start(
        memory,
        tokens,
        Arc::new(SessionClocks::default()),
        Arc::new(SessionReads::default()),
        gate,
        sources,
    )
    .await
    .unwrap()
}

pub(super) async fn connect(
    url: &str,
    token: &str,
) -> Result<RunningService<RoleClient, ()>, String> {
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url.to_string())
            .auth_header(token.to_string()),
    );
    ().serve(transport).await.map_err(|e| format!("{e:?}"))
}

pub(super) async fn call(
    client: &RunningService<RoleClient, ()>,
    name: &'static str,
    args: Value,
) -> (bool, Value) {
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
    let value = serde_json::from_str(&text).unwrap_or(Value::String(text));
    (result.is_error.unwrap_or(false), value)
}

/// A captured event, as the delta path appends it for a session.
pub(super) fn capture(
    memory: &SharedMemoryStore,
    p: &str,
    agent: &str,
    session: &str,
    kind: EventKind,
    key: &str,
    payload: Value,
) {
    memory
        .append_event(
            p,
            RawEvent {
                agent: agent.into(),
                session_id: session.into(),
                kind,
                key: key.into(),
                payload,
            },
        )
        .unwrap();
}

// ── The tools ────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn a_session_token_exercises_every_tool_over_loopback() {
    let project = temp_project("tools");
    let memory = ticking_memory();
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(
        memory.clone(),
        tokens.clone(),
        always_on(),
        Sources::default(),
    )
    .await;
    assert!(
        server.url().starts_with("http://127.0.0.1:"),
        "{}",
        server.url()
    );
    let token = tokens.mint("s1", "claude", &project);
    let client = connect(&server.url(), &token)
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

    let (err, remembered) = call(
        &client,
        "memory_remember",
        json!({ "kind": "decision", "key": "jwt", "content": "Sign JWTs with RS256" }),
    )
    .await;
    assert!(!err, "{remembered}");
    assert_eq!(remembered["outcome"], "inserted");
    assert_eq!(remembered["entry"]["source"], "claude");
    assert_eq!(remembered["entry"]["by"], "claude");
    assert_eq!(remembered["entry"]["confidence"], 1.0);
    let id = remembered["entry"]["id"].as_i64().unwrap();

    let (_, found) = call(&client, "memory_search", json!({ "query": "jwt rs256" })).await;
    assert_eq!(found["entries"][0]["id"], id, "{found}");
    assert_eq!(found["entries"][0]["content"], "Sign JWTs with RS256");

    let (err, got) = call(&client, "memory_get", json!({ "id": id })).await;
    assert!(!err, "{got}");
    assert_eq!(got["entry"]["key"], "jwt");
    let (err, missing) = call(&client, "memory_get", json!({ "id": id + 1 })).await;
    assert!(err, "{missing}");

    let (_, listed) = call(&client, "memory_list", json!({ "kind": "decision" })).await;
    assert_eq!(listed["entries"].as_array().unwrap().len(), 1, "{listed}");

    let (err, forgotten) = call(&client, "memory_forget", json!({ "id": id })).await;
    assert!(!err);
    assert_eq!(forgotten["forgotten"], true);
    let (_, listed) = call(&client, "memory_list", json!({})).await;
    assert_eq!(listed["entries"], json!([]));

    client.cancel().await.ok();
    let _ = std::fs::remove_dir_all(&project);
}

/// The briefing is the whole first look: working memory, the ranked index
/// (capped lines, `memory_get` for the rest), the curated pack and the
/// previous session's tail — everything the prompt used to carry.
#[tokio::test(flavor = "multi_thread")]
async fn the_briefing_carries_working_memory_the_index_and_the_first_look_extras() {
    let p = temp_project("briefing");
    let memory = ticking_memory();
    capture(
        &memory,
        &p,
        "claude-code",
        "earlier",
        EventKind::PlanSet,
        "plan",
        json!({"text": "Migrate auth to JWT"}),
    );
    capture(
        &memory,
        &p,
        "codex",
        "earlier",
        EventKind::FileChanged,
        "src/auth.rs",
        json!({"path": "src/auth.rs", "summary": "sign with RS256"}),
    );
    capture(
        &memory,
        &p,
        "codex",
        "earlier",
        EventKind::FileChanged,
        "src/token.rs",
        json!({"path": "src/token.rs"}),
    );
    capture(
        &memory,
        &p,
        "codex",
        "earlier",
        EventKind::Decision,
        "auth.alg",
        json!({"text": "Use RS256 for JWT signing"}),
    );
    let long = "The staging database resets nightly, "
        .repeat(8)
        .trim()
        .to_string();
    store_for(&p)
        .unwrap()
        .upsert(NewEntry {
            kind: EntryKind::Fact,
            key: String::new(),
            content: long.clone(),
            source: "import:memdir".into(),
            agent: String::new(),
            session_id: String::new(),
            confidence: 0.7,
            at: 5_000,
        })
        .unwrap();

    let asked = Arc::new(Mutex::new(Vec::new()));
    let seen = asked.clone();
    let bootstrap: BootstrapSource = Arc::new(move |cwd: String, session: String| {
        seen.lock().push((cwd, session));
        Box::pin(async move {
            Bootstrap {
                project_memory: vec![PackEntry {
                    kind: "feedback".into(),
                    title: "tooling".into(),
                    text: "Prefer bun over npm".into(),
                }],
                recent_session: Some(Handoff {
                    text: "User: hi\nAssistant: yo".into(),
                    turns: 2,
                    attribution: "raw".into(),
                }),
            }
        })
    });
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(
        memory.clone(),
        tokens.clone(),
        always_on(),
        Sources {
            index: None,
            bootstrap: Some(bootstrap),
            evict: None,
            ..Sources::default()
        },
    )
    .await;
    let client = connect(&server.url(), &tokens.mint("s-new", "gemini", &p))
        .await
        .unwrap();

    let (err, briefing) = call(&client, "memory_briefing", json!({})).await;
    assert!(!err, "{briefing}");
    assert_eq!(briefing["plan"]["content"], "Migrate auth to JWT");
    assert_eq!(briefing["plan"]["by"], "claude-code");
    let files: Vec<&str> = briefing["filesChanged"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap())
        .collect();
    assert_eq!(files, ["src/token.rs", "src/auth.rs"], "newest first");
    assert_eq!(briefing["filesChanged"][1]["summary"], "sign with RS256");
    assert_eq!(
        briefing["index"]["decision"][0]["content"],
        "Use RS256 for JWT signing"
    );
    assert_eq!(briefing["index"]["decision"][0]["by"], "codex");
    let fact = &briefing["index"]["fact"][0];
    assert_eq!(fact["by"], "import:memdir");
    assert_eq!(fact["truncated"], true);
    assert!(
        fact["content"].as_str().unwrap().chars().count() <= 161,
        "{fact}"
    );
    assert_eq!(
        briefing["projectMemory"],
        json!([{ "kind": "feedback", "title": "tooling", "text": "Prefer bun over npm" }])
    );
    assert_eq!(
        briefing["recentSession"],
        json!({ "text": "User: hi\nAssistant: yo", "turns": 2, "attribution": "raw" })
    );
    assert_eq!(*asked.lock(), vec![(p.clone(), "s-new".to_string())]);

    // The index line was capped; the entry is a get away, in full.
    let id = fact["id"].as_i64().unwrap();
    let (_, got) = call(&client, "memory_get", json!({ "id": id })).await;
    assert_eq!(got["entry"]["content"], long);

    client.cancel().await.ok();
    let _ = std::fs::remove_dir_all(&p);
}

/// Changes are what *other* sessions recorded since this one last looked:
/// nothing right after a briefing, another session's write after it, never
/// the session's own writes, and each look advances the clock.
#[tokio::test(flavor = "multi_thread")]
async fn changes_are_what_other_sessions_recorded_since_the_last_look() {
    let p = temp_project("changes");
    let memory = ticking_memory();
    capture(
        &memory,
        &p,
        "codex",
        "earlier",
        EventKind::Decision,
        "auth.alg",
        json!({"text": "Use RS256"}),
    );
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(
        memory.clone(),
        tokens.clone(),
        always_on(),
        Sources::default(),
    )
    .await;
    let mine = connect(&server.url(), &tokens.mint("s-mine", "claude", &p))
        .await
        .unwrap();
    let theirs = connect(&server.url(), &tokens.mint("s-theirs", "codex", &p))
        .await
        .unwrap();

    // Before any look, everything is new.
    let (_, first) = call(&mine, "memory_changes", json!({})).await;
    assert_eq!(first["since"], 0);
    assert_eq!(first["entries"][0]["content"], "Use RS256", "{first}");

    let (_, none) = call(&mine, "memory_changes", json!({})).await;
    assert_eq!(none["entries"], json!([]), "{none}");
    assert_eq!(none["since"], first["syncedTo"]);

    // Another session records a failure; this session records a fact.
    let (_, _) = call(
        &theirs,
        "memory_remember",
        json!({ "kind": "failure", "content": "HS256 keys leaked" }),
    )
    .await;
    let (_, _) = call(
        &mine,
        "memory_remember",
        json!({ "kind": "fact", "content": "My own note" }),
    )
    .await;
    capture(
        &memory,
        &p,
        "codex",
        "s-theirs",
        EventKind::PlanSet,
        "plan",
        json!({"text": "Rotate the keys"}),
    );

    let (_, delta) = call(&mine, "memory_changes", json!({})).await;
    let contents: Vec<&str> = delta["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["content"].as_str().unwrap())
        .collect();
    assert_eq!(
        contents,
        ["Rotate the keys", "HS256 keys leaked"],
        "{delta}"
    );
    assert_eq!(delta["entries"][0]["kind"], "plan");
    assert_eq!(delta["entries"][1]["by"], "codex");

    // A briefing is a look too: nothing is new after it.
    let (_, _) = call(&mine, "memory_briefing", json!({})).await;
    let (_, after) = call(&mine, "memory_changes", json!({})).await;
    assert_eq!(after["entries"], json!([]), "{after}");

    mine.cancel().await.ok();
    theirs.cancel().await.ok();
    let _ = std::fs::remove_dir_all(&p);
}

/// A forget by one session is a change the others hear about: its id comes
/// back in `forgotten`, once, and never for the session that forgot.
#[tokio::test(flavor = "multi_thread")]
async fn a_forget_reaches_the_other_session_as_a_tombstone() {
    let p = temp_project("tombstone");
    let memory = ticking_memory();
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(
        memory.clone(),
        tokens.clone(),
        always_on(),
        Sources::default(),
    )
    .await;
    let mine = connect(&server.url(), &tokens.mint("s-mine", "claude", &p))
        .await
        .unwrap();
    let theirs = connect(&server.url(), &tokens.mint("s-theirs", "codex", &p))
        .await
        .unwrap();

    let (_, r) = call(
        &theirs,
        "memory_remember",
        json!({ "kind": "fact", "content": "Staging lives on fly.io" }),
    )
    .await;
    let id = r["entry"]["id"].clone();
    let (_, _) = call(&mine, "memory_changes", json!({})).await;
    let (_, _) = call(&theirs, "memory_changes", json!({})).await;
    let (_, _) = call(&theirs, "memory_forget", json!({ "id": id })).await;

    let (_, delta) = call(&mine, "memory_changes", json!({})).await;
    assert_eq!(delta["forgotten"], json!([id]), "{delta}");
    let (_, again) = call(&mine, "memory_changes", json!({})).await;
    assert_eq!(again["forgotten"], json!([]), "once: {again}");
    let (_, own) = call(&theirs, "memory_changes", json!({})).await;
    assert_eq!(
        own["forgotten"],
        json!([]),
        "not to the session that forgot: {own}"
    );

    mine.cancel().await.ok();
    theirs.cancel().await.ok();
    let _ = std::fs::remove_dir_all(&p);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_or_revoked_token_is_refused() {
    let project = temp_project("auth");
    let memory = ticking_memory();
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(
        memory.clone(),
        tokens.clone(),
        always_on(),
        Sources::default(),
    )
    .await;

    assert!(
        connect(&server.url(), "not-a-token").await.is_err(),
        "an unknown token connects"
    );

    // Revoked through the session lifecycle, while the MCP session is open.
    tokens.session_started("s1", "codex", &project);
    let token = tokens.token_for("s1").expect("minted at session start");
    let client = connect(&server.url(), &token)
        .await
        .expect("a live token connects");
    let (err, _) = call(&client, "memory_list", json!({})).await;
    assert!(!err);
    tokens.session_ended("s1");
    assert_eq!(tokens.token_for("s1"), None);
    let refused = client
        .call_tool(CallToolRequestParams::new("memory_list").with_arguments(JsonObject::new()))
        .await;
    assert!(
        refused.is_err(),
        "a revoked token still calls tools: {refused:?}"
    );
    assert!(
        connect(&server.url(), &token).await.is_err(),
        "a revoked token reconnects"
    );
    let _ = std::fs::remove_dir_all(&project);
}

/// Two near-identical phrasings embed to vectors with cosine 0.96.
struct TwoPhrasings;
impl Embedder for TwoPhrasings {
    fn embed(&self, text: &str) -> Option<Embedding> {
        let vector = match text {
            "Postgres is the only database" => vec![1.0, 0.0],
            "The only database is Postgres" => vec![0.96, 0.28],
            _ => return None,
        };
        Some(Embedding {
            model: "test-2".into(),
            vector,
        })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn remember_replaces_by_key_merges_near_duplicates_and_rejects_working_memory() {
    let project = temp_project("remember");
    let memory = ticking_memory();
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(
        memory.clone(),
        tokens.clone(),
        always_on(),
        Sources::default(),
    )
    .await;
    let client = connect(&server.url(), &tokens.mint("s1", "gemini", &project))
        .await
        .unwrap();
    store_for(&project)
        .unwrap()
        .set_embedder(Some(Arc::new(TwoPhrasings)));

    let (_, first) = call(
        &client,
        "memory_remember",
        json!({ "kind": "decision", "key": "alg", "content": "HS256" }),
    )
    .await;
    let (_, second) = call(
        &client,
        "memory_remember",
        json!({ "kind": "decision", "key": "alg", "content": "RS256" }),
    )
    .await;
    assert_eq!(second["outcome"], "replaced");
    assert_eq!(second["entry"]["id"], first["entry"]["id"]);
    assert_eq!(second["entry"]["content"], "RS256");

    let (_, fact) = call(
        &client,
        "memory_remember",
        json!({ "kind": "fact", "content": "Postgres is the only database" }),
    )
    .await;
    let (_, near) = call(
        &client,
        "memory_remember",
        json!({ "kind": "fact", "content": "The only database is Postgres" }),
    )
    .await;
    assert_eq!(near["outcome"], "merged", "{near}");
    assert_eq!(near["entry"]["id"], fact["entry"]["id"]);
    assert_eq!(near["entry"]["uses"], 1);

    for kind in ["plan", "file_changed"] {
        let (err, refused) = call(
            &client,
            "memory_remember",
            json!({ "kind": kind, "content": "do the thing" }),
        )
        .await;
        assert!(err, "{kind} was remembered: {refused}");
    }
    let (_, plans) = call(&client, "memory_list", json!({ "kind": "plan" })).await;
    assert_eq!(plans["entries"], json!([]));
    let _ = std::fs::remove_dir_all(&project);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_write_through_the_server_shows_in_the_shared_tab_and_is_announced() {
    let project = temp_project("visible");
    let memory = ticking_memory();
    let announced: Arc<Mutex<Vec<MemoryChanged>>> = Arc::default();
    memory.on_change({
        let announced = announced.clone();
        Arc::new(move |c: &MemoryChanged| announced.lock().push(c.clone()))
    });
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(
        memory.clone(),
        tokens.clone(),
        always_on(),
        Sources::default(),
    )
    .await;
    let client = connect(&server.url(), &tokens.mint("s9", "codex", &project))
        .await
        .unwrap();

    let secret = "sk-proj-AbCdEf0123456789GhIjKlMnOpQrStUv";
    let (err, _) = call(
        &client,
        "memory_remember",
        json!({ "kind": "failure", "content": format!("Retrying with {secret} did not help") }),
    )
    .await;
    assert!(!err);

    // The Shared tab's commands see it: the state view and the event list.
    let state = memory.get_state(&project);
    assert_eq!(state.failures.len(), 1, "{state:?}");
    assert_eq!(state.failures[0].agent, "codex");
    assert!(
        !state.failures[0].text.contains(secret),
        "{}",
        state.failures[0].text
    );
    let events = memory.list_events(&project);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].session_id, "s9");
    assert!(!memory.query(&project, "did not help", 10).is_empty());

    let announced = announced.lock().clone();
    assert_eq!(announced.len(), 1, "{announced:?}");
    assert_eq!(announced[0].kinds, ["failure"]);
    let _ = std::fs::remove_dir_all(&project);
}

#[tokio::test(flavor = "multi_thread")]
async fn with_sharing_off_the_tools_hold_no_memory() {
    let project = temp_project("gated");
    let memory = ticking_memory();
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(
        memory.clone(),
        tokens.clone(),
        Arc::new(|_| false),
        Sources::default(),
    )
    .await;
    let client = connect(&server.url(), &tokens.mint("s1", "claude", &project))
        .await
        .unwrap();
    let (err, _) = call(
        &client,
        "memory_remember",
        json!({ "kind": "fact", "content": "x" }),
    )
    .await;
    assert!(err);
    for read in ["memory_briefing", "memory_changes", "memory_list"] {
        let (err, found) = call(&client, read, json!({})).await;
        assert!(!err, "{read}: {found}");
        assert_eq!(found["entries"], json!([]), "{read}: {found}");
    }
    let (err, found) = call(&client, "memory_search", json!({ "query": "x" })).await;
    assert!(!err);
    assert_eq!(found["entries"], json!([]));
    assert!(memory.list_events(&project).is_empty());
    let _ = std::fs::remove_dir_all(&project);
}

#[tokio::test(flavor = "multi_thread")]
async fn memory_search_also_returns_indexed_project_documents() {
    let project = temp_project("index");
    let tokens = Arc::new(MemoryTokens::default());
    let asked = Arc::new(Mutex::new(Vec::new()));
    let seen = asked.clone();
    let index: IndexSearch = Arc::new(move |cwd: String, query: String, limit: usize| {
        seen.lock().push((cwd, query.clone(), limit));
        Box::pin(async move {
            vec![IndexDoc {
                id: Some("docs/adr/0003.md".to_string()),
                title: "ADR-0003".to_string(),
                source: "docs/adr/0003.md".to_string(),
                text: format!("about {query}"),
            }]
        })
    });
    let server = serve(
        ticking_memory(),
        tokens.clone(),
        always_on(),
        Sources {
            index: Some(index),
            bootstrap: None,
            evict: None,
            ..Sources::default()
        },
    )
    .await;
    let client = connect(&server.url(), &tokens.mint("s1", "atlas-agent", &project))
        .await
        .unwrap();

    let (err, found) = call(
        &client,
        "memory_search",
        json!({ "query": "the engine fork" }),
    )
    .await;
    assert!(!err, "{found}");
    assert_eq!(found["entries"], json!([]));
    assert_eq!(
        found["documents"],
        json!([{ "title": "ADR-0003", "source": "docs/adr/0003.md", "text": "about the engine fork" }]),
    );
    assert_eq!(
        *asked.lock(),
        vec![(project.clone(), "the engine fork".to_string(), 6)]
    );

    // A working-memory search is a search of the record alone.
    let (_, found) = call(
        &client,
        "memory_search",
        json!({ "query": "x", "kinds": ["plan"] }),
    )
    .await;
    assert_eq!(found.get("documents"), None, "{found}");
    client.cancel().await.ok();
    let _ = std::fs::remove_dir_all(&project);
}

/// #292: `memory_forget` used to answer `{"forgotten": true}` while the same
/// text was still retrievable in the documents half of `memory_search`, until
/// whenever the next whole-corpus pass ran. The eviction has to be part of the
/// same operation, and it has to happen before the tool answers.
#[tokio::test(flavor = "multi_thread")]
async fn forgetting_through_the_tool_evicts_the_document_before_returning() {
    let project = temp_project("forget-evicts");
    let tokens = Arc::new(MemoryTokens::default());
    let evicted = Arc::new(Mutex::new(Vec::new()));
    let seen = evicted.clone();
    let evict: IndexEvict = Arc::new(move |cwd: String, doc_id: String| {
        seen.lock().push((cwd, doc_id));
        Box::pin(async move { true })
    });
    let server = serve(
        ticking_memory(),
        tokens.clone(),
        always_on(),
        Sources {
            index: None,
            bootstrap: None,
            evict: Some(evict),
            ..Sources::default()
        },
    )
    .await;
    let client = connect(&server.url(), &tokens.mint("s1", "atlas-agent", &project))
        .await
        .unwrap();

    let (err, remembered) = call(
        &client,
        "memory_remember",
        json!({ "kind": "fact", "content": "the secondary canary token is QUOKKA-9042" }),
    )
    .await;
    assert!(!err, "{remembered}");
    let id = remembered["entry"]["id"].as_i64().expect("an entry id");

    let (err, forgotten) = call(&client, "memory_forget", json!({ "id": id })).await;
    assert!(!err, "{forgotten}");
    assert_eq!(forgotten["forgotten"], json!(true));

    // The document went with the record, addressed by its corpus id, and the
    // eviction had already happened by the time the tool answered.
    assert_eq!(
        *evicted.lock(),
        vec![(project.clone(), format!("shared:fact:{id}"))]
    );

    // Forgetting something that is not there evicts nothing and says so.
    let (_, missing) = call(&client, "memory_forget", json!({ "id": id })).await;
    assert_eq!(missing["forgotten"], json!(false));
    assert_eq!(
        evicted.lock().len(),
        1,
        "no eviction for an entry that was not there"
    );

    client.cancel().await.ok();
    let _ = std::fs::remove_dir_all(&project);
}

/// The record has the last word on what a search may return. An eviction can
/// be missed (the index was busy, or the document predates the seam), so a
/// document promoted from an entry that no longer exists is dropped at read
/// time too — and nothing else is, because dropping a live document would be
/// a worse failure than the one being fixed.
#[tokio::test(flavor = "multi_thread")]
async fn search_never_returns_a_shared_document_whose_entry_is_gone() {
    let project = temp_project("stale-docs");
    let tokens = Arc::new(MemoryTokens::default());
    let memory = ticking_memory();

    let writer = crate::commands::shared_memory::Writer {
        agent: "atlas-agent".to_string(),
        session_id: "s1".to_string(),
    };
    let live = memory
        .remember(
            &project,
            &writer,
            EntryKind::Fact,
            "a fact worth keeping",
            "",
            None,
            &[],
        )
        .expect("remembered")
        .entry
        .id;
    let gone = live + 4242; // never existed

    let index: IndexSearch = Arc::new(move |_cwd, _query, _limit| {
        Box::pin(async move {
            vec![
                IndexDoc {
                    id: Some(format!("shared:fact:{live}")),
                    title: "live".to_string(),
                    source: "shared".to_string(),
                    text: "[atlas-agent] a fact worth keeping".to_string(),
                },
                IndexDoc {
                    id: Some(format!("shared:fact:{gone}")),
                    title: "forgotten".to_string(),
                    source: "shared".to_string(),
                    text: "[atlas-agent] QUOKKA-9042".to_string(),
                },
                IndexDoc {
                    id: Some("docs/adr/0010.md".to_string()),
                    title: "ADR-0010".to_string(),
                    source: "docs/adr/0010.md".to_string(),
                    text: "an ordinary project document".to_string(),
                },
            ]
        })
    });
    let server = serve(
        memory,
        tokens.clone(),
        always_on(),
        Sources {
            index: Some(index),
            bootstrap: None,
            evict: None,
            ..Sources::default()
        },
    )
    .await;
    let client = connect(&server.url(), &tokens.mint("s1", "atlas-agent", &project))
        .await
        .unwrap();

    let (err, found) = call(
        &client,
        "memory_search",
        json!({ "query": "anything at all" }),
    )
    .await;
    assert!(!err, "{found}");
    let titles: Vec<&str> = found["documents"]
        .as_array()
        .expect("documents")
        .iter()
        .filter_map(|d| d["title"].as_str())
        .collect();
    assert_eq!(
        titles,
        vec!["live", "ADR-0010"],
        "the forgotten entry's document is dropped; the live one and the ordinary document are not"
    );

    client.cancel().await.ok();
    let _ = std::fs::remove_dir_all(&project);
}

/// Whether a session consulted memory is NOT the same question as its sync
/// clock. `memory_search` answers from the record without moving the clock, so
/// reading "never looked" off the clock would accuse a session that did
/// consult memory — and a false accusation here is worse than staying quiet.
#[tokio::test(flavor = "multi_thread")]
async fn a_search_counts_as_consulting_memory_even_though_it_moves_no_clock() {
    let project = temp_project("consulted-by-search");
    let tokens = Arc::new(MemoryTokens::default());
    let clocks = Arc::new(SessionClocks::default());
    let reads = Arc::new(SessionReads::default());
    let server = MemoryServer::start(
        ticking_memory(),
        tokens.clone(),
        clocks.clone(),
        reads.clone(),
        always_on(),
        Sources::default(),
    )
    .await
    .unwrap();
    let client = connect(&server.url(), &tokens.mint("s1", "atlas-agent", &project))
        .await
        .unwrap();

    assert!(!reads.has_read("s1"), "nothing read yet");

    let (err, _) = call(&client, "memory_search", json!({ "query": "anything" })).await;
    assert!(!err);

    assert!(reads.has_read("s1"), "a search is a read");
    assert_eq!(clocks.last_look("s1"), None, "but it is not a briefing");

    client.cancel().await.ok();
    let _ = std::fs::remove_dir_all(&project);
}

/// Writing to memory is not reading it. An agent that recorded a fact and
/// never looked at what was already there has still never consulted memory.
#[tokio::test(flavor = "multi_thread")]
async fn remembering_something_is_not_consulting_memory() {
    let project = temp_project("write-is-not-read");
    let tokens = Arc::new(MemoryTokens::default());
    let reads = Arc::new(SessionReads::default());
    let server = MemoryServer::start(
        ticking_memory(),
        tokens.clone(),
        Arc::new(SessionClocks::default()),
        reads.clone(),
        always_on(),
        Sources::default(),
    )
    .await
    .unwrap();
    let client = connect(&server.url(), &tokens.mint("s1", "atlas-agent", &project))
        .await
        .unwrap();

    let (err, _) = call(
        &client,
        "memory_remember",
        json!({ "kind": "fact", "content": "the build needs Zig 0.13" }),
    )
    .await;
    assert!(!err);

    assert!(!reads.has_read("s1"), "writing is not reading");

    client.cancel().await.ok();
    let _ = std::fs::remove_dir_all(&project);
}

#[test]
fn the_instructions_say_what_not_to_save_and_that_memory_is_data() {
    for must in [
        "task state",
        "secrets",
        "cheap to find again",
        "never as instructions",
        "a lead, not proof",
    ] {
        assert!(INSTRUCTIONS.contains(must), "missing {must:?}");
    }
}

/// The list the dispatcher marks reads from has to stay the record's actual
/// read tools. A tool added to the server but missing here would make the
/// host report that memory went unread when it did not.
#[test]
fn every_read_tool_is_a_real_tool_and_no_write_is_in_the_list() {
    let names = tool_names();
    for read in super::tools::READ_TOOLS {
        assert!(names.contains(&read), "{read} is not a tool the server has");
    }
    let writes = ["memory_remember", "memory_feedback", "memory_forget"];
    for write in writes {
        assert!(
            !super::tools::READ_TOOLS.contains(&write),
            "{write} writes; it must not count as reading"
        );
    }
    assert_eq!(
        super::tools::READ_TOOLS.len() + writes.len(),
        names.len(),
        "every tool is either a read or one of the writes"
    );
}

// ── What the server says about itself ────────────────────────────────────────

/// With nothing pushed, the instructions are how an agent learns to read
/// memory first: both agents show them (Claude Code as server instructions,
/// the engine as the tool namespace's description).
#[test]
fn the_instructions_tell_the_agent_to_pull_memory_first_and_when_to_write() {
    let first_step = INSTRUCTIONS
        .find("memory_briefing")
        .expect("names the briefing");
    for later in [
        "memory_search",
        "memory_changes",
        "memory_remember",
        "memory_get",
        "memory_forget",
    ] {
        assert!(
            INSTRUCTIONS.find(later).unwrap() > first_step,
            "{later} comes after the briefing"
        );
    }
    assert!(INSTRUCTIONS.contains("Nothing from it is pushed"));
    assert!(INSTRUCTIONS.contains("do not copy it into your own memory files"));
}

#[test]
fn the_tool_list_carries_the_cache_fields_the_2026_07_28_spec_requires() {
    let wire = serde_json::to_value(tools_list()).expect("serializes");
    assert_eq!(wire["ttlMs"], json!(TOOLS_LIST_TTL_MS));
    assert_eq!(wire["cacheScope"], json!("private"));
    let names: Vec<&str> = wire["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t["name"].as_str())
        .collect();
    assert_eq!(names, tool_names());
}

// ── Ranking and caps ─────────────────────────────────────────────────────────

const NOW: i64 = 1_800_000_000_000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

fn entry(
    id: i64,
    kind: EntryKind,
    content: &str,
    confidence: f64,
    uses: u32,
    updated_at: i64,
    last_used_at: Option<i64>,
) -> Entry {
    Entry {
        id,
        kind,
        key: String::new(),
        content: content.into(),
        status: String::new(),
        source: "codex".into(),
        agent: "codex".into(),
        session_id: String::new(),
        confidence,
        created_at: updated_at,
        updated_at,
        last_used_at,
        uses,
        content_hash: String::new(),
        seq: None,
        ..Default::default()
    }
}

/// A recently used high-confidence entry outranks an old unused one, even when
/// the old one was written later than the recent one was.
#[test]
fn ranking_prefers_recently_used_high_confidence() {
    let old_unused = entry(
        1,
        EntryKind::Decision,
        "Old unused",
        0.5,
        0,
        NOW - 90 * DAY_MS,
        None,
    );
    let used = entry(
        2,
        EntryKind::Decision,
        "Recently used",
        1.0,
        4,
        NOW - 200 * DAY_MS,
        Some(NOW - DAY_MS),
    );
    assert!(score(&used, NOW) > score(&old_unused, NOW));
    let index: Vec<String> = rank_index(&[old_unused, used], NOW)
        .into_iter()
        .map(|e| e.content)
        .collect();
    assert_eq!(index, ["Recently used", "Old unused"]);
}

/// Each kind carries at most its display cap — its best entries — grouped by
/// kind, and the whole index stays within its entry limit.
#[test]
fn caps_are_respected_per_kind() {
    let mut entries = Vec::new();
    for i in 0..60 {
        // Higher i = more recent = better.
        entries.push(entry(
            i,
            EntryKind::Decision,
            &format!("d{i}"),
            1.0,
            0,
            NOW - (60 - i) * DAY_MS,
            None,
        ));
    }
    for i in 0..40 {
        entries.push(entry(
            100 + i,
            EntryKind::Failure,
            &format!("f{i}"),
            1.0,
            0,
            NOW - (40 - i) * DAY_MS,
            None,
        ));
    }
    let index = rank_index(&entries, NOW);
    let decisions = index
        .iter()
        .filter(|e| e.kind == EntryKind::Decision)
        .count();
    let failures = index
        .iter()
        .filter(|e| e.kind == EntryKind::Failure)
        .count();
    assert_eq!((decisions, failures), (50, 30));
    let contents: Vec<&str> = index.iter().map(|e| e.content.as_str()).collect();
    assert!(contents.contains(&"d59") && !contents.contains(&"d9"));
    assert!(contents.contains(&"f39") && !contents.contains(&"f9"));
    assert_eq!(contents[0], "d59", "grouped by kind, best first within it");
    assert!(index.len() <= INDEX_MAX_ENTRIES);
}

#[test]
fn a_session_clock_is_monotonic_and_forgotten_at_session_end() {
    let clocks = SessionClocks::default();
    assert_eq!(clocks.last_look("s1"), None);
    clocks.looked("s1", 10);
    clocks.looked("s1", 5);
    assert_eq!(clocks.last_look("s1"), Some(10));
    clocks.forget("s1");
    assert_eq!(clocks.last_look("s1"), None);
}

// ── Handing the server to sessions ───────────────────────────────────────────

async fn running_host(gate: SharingGate) -> Arc<MemoryServerHost> {
    let host = Arc::new(MemoryServerHost::new());
    let server = MemoryServer::start(
        ticking_memory(),
        host.tokens().clone(),
        host.clocks().clone(),
        host.reads().clone(),
        gate,
        Sources::default(),
    )
    .await
    .unwrap();
    host.adopt(server);
    host
}

/// An ACP agent's request: another process, whatever it advertised.
fn request(http_mcp: bool, cwd: &str, session: Option<&str>) -> SessionMcpRequest {
    SessionMcpRequest {
        agent_id: atlas_acp_thread::AgentId::new("claude-code"),
        http_mcp,
        ui_control: false,
        org_access: false,
        in_process: false,
        cwd: std::path::PathBuf::from(cwd),
        session_id: session.map(acp::SessionId::new),
    }
}

/// The native agent's request: in this process, over HTTP.
fn in_process_request(cwd: &str) -> SessionMcpRequest {
    SessionMcpRequest {
        agent_id: atlas_acp_thread::AgentId::new("atlas-agent"),
        in_process: true,
        ..request(true, cwd, None)
    }
}

/// The one server an offer carries, as `(name, url, bearer token)`: from the
/// header of an HTTP entry, or from the file a bridged entry names.
fn offered(offer: &SessionMcpOffer) -> Option<(String, String, String)> {
    let mut entries = offers::offered_entries(offer);
    assert!(entries.len() <= 1, "one server at most: {entries:?}");
    entries.pop()
}

/// ADR-0020: an agent in another process may put its whole MCP entry on a
/// command line (the Claude Agent SDK's `--mcp-config <json>`), so no field
/// of any entry it is offered carries the token — not a header, not the
/// URL, not an argument, not `env` — whether or not it advertised HTTP MCP.
/// The token is in the private file the entry names. Only the in-process
/// agent's entry holds the token itself, in its header.
#[tokio::test(flavor = "multi_thread")]
async fn no_entry_offered_to_another_process_carries_the_token() {
    let host = running_host(always_on()).await;
    let offers = MemorySessionOffers::new(host.clone(), always_on()).with_code(
        crate::commands::code_server::CodeOffer::new(Arc::new(|| true)),
    );
    for http_mcp in [true, false] {
        let offer = offers.offer(&request(http_mcp, "/p", None));
        assert_eq!(
            offer.servers().len(),
            2,
            "memory and code: {:?}",
            offer.servers()
        );
        let mut tokens = Vec::new();
        for server in offer.servers() {
            let acp::McpServer::Stdio(stdio) = server else {
                panic!("http_mcp={http_mcp}: only the stdio bridge leaves the process: {server:?}")
            };
            assert!(stdio.env.is_empty(), "nothing in env: {:?}", stdio.env);
            let file = stdio.args.last().unwrap();
            let token = crate::commands::memory_bridge::read_token_file(file.as_ref()).unwrap();
            assert!(host.tokens().grant(&token).is_some(), "a live token");
            let printed = serde_json::to_string(server).unwrap();
            assert!(
                !printed.contains(&token),
                "http_mcp={http_mcp}: the token is in the entry: {printed}"
            );
            tokens.push(token);
        }
        assert_eq!(tokens[0], tokens[1], "one token for both servers");
    }

    let offer = offers.offer(&in_process_request("/p"));
    let token = host.tokens().grant(&offered_token(&offer));
    assert!(
        token.is_some(),
        "the in-process agent's header token is live"
    );
}

/// The token of an offer whose entries are all HTTP.
fn offered_token(offer: &SessionMcpOffer) -> String {
    let [acp::McpServer::Http(http), ..] = offer.servers() else {
        panic!("HTTP for the in-process agent: {:?}", offer.servers())
    };
    http.headers[0]
        .value
        .strip_prefix("Bearer ")
        .unwrap()
        .to_string()
}

/// An offer released unbound removes its token file with its token.
#[tokio::test(flavor = "multi_thread")]
async fn a_bridged_offer_that_never_binds_removes_its_token_file() {
    let host = running_host(always_on()).await;
    let offers = MemorySessionOffers::new(host, always_on());
    let offer = offers.offer(&request(true, "/p", None));
    let [acp::McpServer::Stdio(stdio)] = offer.servers() else {
        panic!("{:?}", offer.servers())
    };
    let file = std::path::PathBuf::from(stdio.args.last().unwrap());
    assert!(file.exists());
    drop(offer);
    assert!(!file.exists(), "the file goes with the token");
}

/// A bound offer's token file goes when its session ends, not at some later
/// offer's sweep.
#[tokio::test(flavor = "multi_thread")]
async fn a_bound_sessions_token_file_goes_when_the_session_ends() {
    let host = running_host(always_on()).await;
    let files = Arc::new(crate::commands::memory_bridge::TokenFiles::in_temp());
    let offers = MemorySessionOffers::new(host, always_on()).with_token_files(files.clone());
    let offer = offers.offer(&request(true, "/p", None));
    let [acp::McpServer::Stdio(stdio)] = offer.servers() else {
        panic!("{:?}", offer.servers())
    };
    let file = std::path::PathBuf::from(stdio.args.last().unwrap());
    offer.bind(&acp::SessionId::new("s-bound"));
    assert!(
        file.exists(),
        "a bound session keeps its file while it runs"
    );
    files.session_ended("s-other");
    assert!(file.exists());
    files.session_ended("s-bound");
    assert!(!file.exists(), "the file goes with the session");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_http_agent_is_offered_the_server_with_a_token_that_binds_to_its_session() {
    let project = temp_project("offer");
    let host = running_host(always_on()).await;
    let offers = MemorySessionOffers::new(host.clone(), always_on());

    let offer = offers.offer(&request(true, &project, None));
    let (name, url, token) =
        offered(&offer).expect("an HTTP agent with sharing on gets the server");
    assert_eq!(name, MEMORY_SERVER_NAME);
    assert_eq!(Some(url.clone()), host.url());
    let client = connect(&url, &token)
        .await
        .expect("the offered token is live before the id exists");
    client.cancel().await.ok();

    offer.bind(&acp::SessionId::new("s1"));
    assert_eq!(
        host.tokens().token_for("s1").as_deref(),
        Some(token.as_str())
    );
    let grant = host.tokens().grant(&token).unwrap();
    assert_eq!(
        (
            grant.session_id.as_str(),
            grant.agent.as_str(),
            grant.cwd.as_str()
        ),
        ("s1", "claude-code", project.as_str())
    );

    // The session start the host reports next keeps the token the agent
    // holds, however the directory is spelled.
    host.tokens()
        .session_started("s1", "claude-code", &format!("{project}/"));
    assert_eq!(
        host.tokens().token_for("s1").as_deref(),
        Some(token.as_str())
    );

    // And the session's end revokes it.
    host.tokens().session_ended("s1");
    assert!(
        connect(&url, &token).await.is_err(),
        "a revoked token is refused"
    );
    let _ = std::fs::remove_dir_all(&project);
}

/// ADR-0019, ADR-0020: an ACP agent is handed the server as a stdio entry,
/// this binary's `mcp-bridge`, naming a file that holds the token.
#[tokio::test(flavor = "multi_thread")]
async fn an_acp_agent_is_offered_the_stdio_bridge() {
    let host = running_host(always_on()).await;
    let offers = MemorySessionOffers::new(host.clone(), always_on());
    let offer = offers.offer(&request(false, "/p", None));
    let [acp::McpServer::Stdio(stdio)] = offer.servers() else {
        panic!("{:?}", offer.servers())
    };
    assert_eq!(stdio.command, std::env::current_exe().unwrap());
    let (name, url, token) = offered(&offer).unwrap();
    assert_eq!(name, MEMORY_SERVER_NAME);
    assert_eq!(Some(url), host.url());
    assert!(host.tokens().grant(&token).is_some(), "a live token");
}

/// The in-process agent keeps HTTP, its token in the header it reads from
/// memory.
#[tokio::test(flavor = "multi_thread")]
async fn the_in_process_agent_is_offered_the_server_over_http() {
    let host = running_host(always_on()).await;
    let offers = MemorySessionOffers::new(host, always_on());
    let offer = offers.offer(&in_process_request("/p"));
    assert!(matches!(offer.servers(), [acp::McpServer::Http(_)]));
}

/// A stdio-only agent's messages reach the loopback server through the
/// bridge, with the MCP session id carried from the first response on.
#[tokio::test(flavor = "multi_thread")]
async fn the_bridge_forwards_and_keeps_the_session() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let p = temp_project("bridge");
    let memory = ticking_memory();
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(memory, tokens.clone(), always_on(), Sources::default()).await;
    let token = tokens.mint("s-bridge", "gemini", &p);
    let (mut to_bridge, bridge_in) = tokio::io::duplex(64 * 1024);
    let (bridge_out, from_bridge) = tokio::io::duplex(64 * 1024);
    let url = server.url();
    let run = tokio::spawn(async move {
        crate::commands::memory_bridge::bridge(&url, &token, BufReader::new(bridge_in), bridge_out)
            .await
    });
    for line in [
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"bridge-test","version":"0"}}}"#,
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
    ] {
        to_bridge.write_all(line.as_bytes()).await.unwrap();
        to_bridge.write_all(b"\n").await.unwrap();
    }
    let mut lines = BufReader::new(from_bridge).lines();
    let first = lines.next_line().await.unwrap().unwrap();
    assert!(first.contains(r#""id":1"#), "{first}");
    let second = lines.next_line().await.unwrap().unwrap();
    assert!(
        second.contains("memory_briefing"),
        "the session id was carried: {second}"
    );
    drop(to_bridge);
    run.await.unwrap().unwrap();
    let _ = std::fs::remove_dir_all(&p);
}

#[tokio::test(flavor = "multi_thread")]
async fn with_sharing_off_nothing_is_offered() {
    let host = running_host(always_on()).await;
    let offers = MemorySessionOffers::new(host, Arc::new(|_| false));
    assert_eq!(offered(&offers.offer(&request(true, "/p", None))), None);
}

#[test]
fn before_the_server_binds_nothing_is_offered() {
    let offers = MemorySessionOffers::new(Arc::new(MemoryServerHost::new()), always_on());
    assert_eq!(offered(&offers.offer(&request(true, "/p", None))), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_offer_that_never_binds_leaves_no_live_token() {
    let host = running_host(always_on()).await;
    let offers = MemorySessionOffers::new(host.clone(), always_on());
    let offer = offers.offer(&request(true, "/p", Some("stored-1")));
    let (_, _, token) = offered(&offer).unwrap();
    drop(offer);
    assert_eq!(host.tokens().grant(&token), None);
    assert_eq!(host.tokens().token_for("stored-1"), None);
}

#[test]
fn the_decision_says_whether_the_server_is_included_and_why_not() {
    assert_eq!(
        OfferDecision::decide(true, true, true),
        OfferDecision::Included
    );
    assert_eq!(
        OfferDecision::decide(false, true, true),
        OfferDecision::IncludedViaBridge
    );
    assert_eq!(
        OfferDecision::decide(false, false, true),
        OfferDecision::Omitted("shared memory is off for this project")
    );
    assert_eq!(
        OfferDecision::decide(true, false, true),
        OfferDecision::Omitted("shared memory is off for this project")
    );
    assert_eq!(
        OfferDecision::decide(true, true, false),
        OfferDecision::Omitted("memory tool server is not running")
    );
}

#[test]
fn each_decision_is_one_log_line_naming_the_agent_its_capability_and_the_outcome() {
    assert_eq!(
        OfferDecision::Included.log_line("claude-code", true),
        "memory tool server offer: agent=claude-code http_mcp=true memory_server=included",
    );
    assert_eq!(
        OfferDecision::decide(false, true, true).log_line("gemini", false),
        "memory tool server offer: agent=gemini http_mcp=false memory_server=included_via_bridge",
    );
    // An ACP agent that advertised HTTP is bridged all the same (ADR-0020).
    assert_eq!(
        OfferDecision::decide(false, true, true).log_line("claude-code", true),
        "memory tool server offer: agent=claude-code http_mcp=true memory_server=included_via_bridge",
    );
    assert_eq!(
        OfferDecision::decide(true, false, true).log_line("atlas-agent", true),
        "memory tool server offer: agent=atlas-agent http_mcp=true memory_server=omitted \
         reason=\"shared memory is off for this project\"",
    );
}

#[test]
fn a_rebind_keeps_the_token_and_a_move_replaces_it() {
    let tokens = MemoryTokens::default();
    tokens.session_started("s1", "claude", "/a");
    let first = tokens.token_for("s1").unwrap();
    tokens.session_started("s1", "claude", "/a");
    assert_eq!(tokens.token_for("s1").as_deref(), Some(first.as_str()));
    tokens.session_started("s1", "claude", "/b");
    let moved = tokens.token_for("s1").unwrap();
    assert_ne!(moved, first);
    assert_eq!(tokens.grant(&first), None);
    assert_eq!(tokens.grant(&moved).unwrap().cwd, "/b");
}

// ── Evidence (M3) ────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn a_changed_citation_makes_the_memory_stale_in_search_and_briefing() {
    let p = temp_project("cite");
    let file = std::path::Path::new(&p).join("src/ttl.rs");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, "pub const TOKEN_TTL_MINUTES: u32 = 15;\n").unwrap();
    let memory = ticking_memory();
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(
        memory.clone(),
        tokens.clone(),
        always_on(),
        Sources::default(),
    )
    .await;
    let a = connect(&server.url(), &tokens.mint("s-a", "claude", &p))
        .await
        .unwrap();
    let (_, r) = call(
        &a,
        "memory_remember",
        json!({"kind": "fact", "content": "Access tokens live 15 minutes",
               "evidence": [{"path": "src/ttl.rs", "lines": "1"}]}),
    )
    .await;
    assert_eq!(r["entry"]["validity"], "valid", "{r}");
    assert_eq!(r["entry"]["citations"][0]["lines"], "1-1", "{r}");
    std::fs::write(&file, "pub const TOKEN_TTL_MINUTES: u32 = 300;\n").unwrap();
    let (_, s) = call(
        &a,
        "memory_search",
        json!({"query": "access tokens minutes"}),
    )
    .await;
    assert_eq!(s["entries"][0]["validity"], "stale", "{s}");
    let (_, b) = call(&a, "memory_briefing", json!({})).await;
    assert!(!b.to_string().contains("15 minutes"), "{b}");
    assert_eq!(b["staleHidden"], 1, "{b}");
    a.cancel().await.ok();
    let _ = std::fs::remove_dir_all(&p);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_citation_outside_the_repository_is_refused() {
    let p = temp_project("cite-out");
    let outside = temp_project("cite-out-other");
    std::fs::write(std::path::Path::new(&outside).join("x.rs"), "fn x() {}\n").unwrap();
    let memory = ticking_memory();
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(
        memory.clone(),
        tokens.clone(),
        always_on(),
        Sources::default(),
    )
    .await;
    let a = connect(&server.url(), &tokens.mint("s-a", "claude", &p))
        .await
        .unwrap();
    let escape = format!("{outside}/x.rs");
    for (path, lines) in [
        ("../../etc/passwd", "1"),
        (escape.as_str(), "1"),
        ("missing.rs", "1"),
    ] {
        let (refused, why) = call(
            &a,
            "memory_remember",
            json!({"kind": "fact", "content": "x", "evidence": [{"path": path, "lines": lines}]}),
        )
        .await;
        assert!(refused, "{path}: {why}");
    }
    let (refused, why) = call(
        &a,
        "memory_remember",
        json!({"kind": "fact", "content": "x", "evidence": [{"path": "src/a.rs", "symbol": "a"}]}),
    )
    .await;
    assert!(refused && why.to_string().contains("give lines"), "{why}");
    a.cancel().await.ok();
    let _ = std::fs::remove_dir_all(&p);
    let _ = std::fs::remove_dir_all(&outside);
}

/// The session decided EdDSA and committed `src/auth.rs`. While the file
/// holds that work the memory is valid; once a rewrite removes it, the
/// memory is stale and leaves the briefing. A wall-clock memory store,
/// because writes are matched to capture's turn times.
#[tokio::test(flavor = "multi_thread")]
async fn landed_work_that_was_removed_makes_an_uncited_memory_stale() {
    use crate::commands::memory_capture::test_support::Recording;
    let p = temp_project("work");
    let file = std::path::Path::new(&p).join("src/auth.rs");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let agent_text = "pub fn sign(token: &Token) -> Sig {\n    eddsa::sign(token)\n}\n\npub fn verify(sig: &Sig) -> bool {\n    eddsa::verify(sig)\n}\n";
    let memory = SharedMemoryStore::new();
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(
        memory.clone(),
        tokens.clone(),
        always_on(),
        Sources::default(),
    )
    .await;
    let a = connect(&server.url(), &tokens.mint("s-a", "claude-code", &p))
        .await
        .unwrap();

    let mut rec = Recording::open_turn(&p, "s-a", "claude-code", "Move auth to EdDSA");
    let (_, r) = call(
        &a,
        "memory_remember",
        json!({"kind": "decision", "content": "Sign JWTs with EdDSA"}),
    )
    .await;
    std::fs::write(&file, agent_text).unwrap();
    rec.write("src/auth.rs", agent_text.as_bytes());
    rec.close_turn();
    rec.commit("3f9c2ab1d4e0aa11bb22cc33dd44ee55ff660011", &["src/auth.rs"]);
    drop(rec);

    let (_, got) = call(&a, "memory_get", json!({"id": r["entry"]["id"]})).await;
    assert_eq!(got["entry"]["validity"], "valid", "{got}");
    assert_eq!(got["entry"]["validityFrom"], "commits");
    assert_eq!(got["entry"]["commits"][0]["sha"], "3f9c2ab1d4e0");

    std::fs::write(
        &file,
        "pub fn sign(token: &Token) -> Sig {\n    hs256::sign(token, SECRET)\n}\n",
    )
    .unwrap();
    let (_, b) = call(&a, "memory_briefing", json!({})).await;
    assert!(!b.to_string().contains("EdDSA"), "{b}");
    assert_eq!(b["staleHidden"], 1, "{b}");
    a.cancel().await.ok();
    let _ = std::fs::remove_dir_all(&p);
}

/// Code citations decide alone, a failure's undone work is expected, and
/// a write capture never saw has no commit evidence.
#[tokio::test(flavor = "multi_thread")]
async fn commit_evidence_leaves_cited_memories_failures_and_unrecorded_sessions_alone() {
    use crate::commands::memory_capture::test_support::Recording;
    let p = temp_project("work-scope");
    let file = std::path::Path::new(&p).join("src/ttl.rs");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, "pub const TOKEN_TTL_MINUTES: u32 = 15;\n").unwrap();
    let memory = SharedMemoryStore::new();
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(
        memory.clone(),
        tokens.clone(),
        always_on(),
        Sources::default(),
    )
    .await;
    let a = connect(&server.url(), &tokens.mint("s-a", "claude-code", &p))
        .await
        .unwrap();
    let other = connect(&server.url(), &tokens.mint("s-z", "codex", &p))
        .await
        .unwrap();

    let mut rec = Recording::open_turn(&p, "s-a", "claude-code", "tokens");
    let (_, cited) = call(
        &a,
        "memory_remember",
        json!({"kind": "fact", "content": "Access tokens live 15 minutes",
               "evidence": [{"path": "src/ttl.rs", "lines": "1"}]}),
    )
    .await;
    let (_, failure) = call(
        &a,
        "memory_remember",
        json!({"kind": "failure", "content": "ring 0.16 can't parse PKCS#8 v2"}),
    )
    .await;
    rec.write("src/ttl.rs", b"pub const TOKEN_TTL_MINUTES: u32 = 15;\n");
    rec.close_turn();
    rec.commit("aa11bb22cc33dd44ee55ff6600113f9c2ab1d4e0", &["src/ttl.rs"]);
    drop(rec);
    let (_, unrecorded) = call(
        &other,
        "memory_remember",
        json!({"kind": "decision", "content": "Use Postgres"}),
    )
    .await;

    for (r, field) in [
        (&cited, "evidence"),
        (&failure, "kind"),
        (&unrecorded, "session"),
    ] {
        let (_, got) = call(&a, "memory_get", json!({"id": r["entry"]["id"]})).await;
        assert!(got["entry"].get("validityFrom").is_none(), "{field}: {got}");
    }
    a.cancel().await.ok();
    other.cancel().await.ok();
    let _ = std::fs::remove_dir_all(&p);
}

// ── Feedback (M4) ────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn wrong_feedback_leaves_the_briefing_and_a_bad_verdict_is_refused() {
    let p = temp_project("feedback");
    let memory = ticking_memory();
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(
        memory.clone(),
        tokens.clone(),
        always_on(),
        Sources::default(),
    )
    .await;
    let a = connect(&server.url(), &tokens.mint("s-a", "claude", &p))
        .await
        .unwrap();
    let b = connect(&server.url(), &tokens.mint("s-b", "codex", &p))
        .await
        .unwrap();
    let (_, r) = call(
        &a,
        "memory_remember",
        json!({"kind": "fact", "content": "CI runs on Jenkins"}),
    )
    .await;
    let (refused, why) = call(
        &b,
        "memory_feedback",
        json!({"id": r["entry"]["id"], "verdict": "meh"}),
    )
    .await;
    assert!(refused && why.to_string().contains("useful"), "{why}");
    let (failed, out) = call(
        &b,
        "memory_feedback",
        json!({"id": r["entry"]["id"], "verdict": "wrong", "note": "GitHub Actions"}),
    )
    .await;
    assert!(!failed, "{out}");
    assert_eq!(out["entry"]["state"], "archived", "{out}");
    let (_, brief) = call(&b, "memory_briefing", json!({})).await;
    assert!(!brief.to_string().contains("Jenkins"), "{brief}");
    let (_, history) = call(&b, "memory_history", json!({"id": r["entry"]["id"]})).await;
    assert!(
        history.to_string().contains("Jenkins"),
        "kept in history: {history}"
    );
    a.cancel().await.ok();
    b.cancel().await.ok();
    let _ = std::fs::remove_dir_all(&p);
}

// ── The handoff note (M4) ────────────────────────────────────────────────────

/// The note the next agent gets says what the recorded session did, not
/// only what it remembered: its files, its failures, its commit, and that
/// its last turn never finished.
#[tokio::test(flavor = "multi_thread")]
async fn the_handoff_carries_what_the_recorded_session_did() {
    use crate::commands::memory_capture::test_support::Recording;
    let p = temp_project("handoff-facts");
    let memory = ticking_memory();
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(
        memory.clone(),
        tokens.clone(),
        always_on(),
        Sources::default(),
    )
    .await;
    let b = connect(&server.url(), &tokens.mint("s-b", "codex", &p))
        .await
        .unwrap();
    memory.session_started("s-a", "claude-code", &p);
    let mut rec = Recording::open_turn(&p, "s-a", "claude-code", "Move auth to EdDSA");
    rec.write("src/auth.rs", b"pub fn sign() {}\n");
    rec.fail("cargo test -p auth", "error: test failed");
    rec.fail("cargo test -p auth", "error: test failed");
    rec.close_turn();
    rec.commit("3f9c2ab1d4e0aa11bb22cc33dd44ee55ff660011", &["src/auth.rs"]);
    rec.next_turn("now rotate the keys");
    drop(rec);
    memory.session_ended("s-a");
    let (_, brief) = call(&b, "memory_briefing", json!({})).await;
    let h = &brief["handoff"];
    assert_eq!(h["title"], "Move auth to EdDSA", "{brief}");
    assert_eq!(h["files"][0], "src/auth.rs");
    assert_eq!(h["failedTools"][0]["detail"], "cargo test -p auth");
    assert_eq!(h["failedTools"][0]["count"], 2);
    assert_eq!(h["commits"][0]["sha"], "3f9c2ab1d4e0");
    assert_eq!(h["interrupted"], true);
    b.cancel().await.ok();
    let _ = std::fs::remove_dir_all(&p);
}

/// The description promises a `handoff` field, so it is there even when no
/// earlier session left a note: `null`, never missing.
#[tokio::test(flavor = "multi_thread")]
async fn a_briefing_with_no_earlier_session_carries_a_null_handoff() {
    let p = temp_project("handoff-none");
    let memory = ticking_memory();
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(
        memory.clone(),
        tokens.clone(),
        always_on(),
        Sources::default(),
    )
    .await;
    let b = connect(&server.url(), &tokens.mint("s-only", "codex", &p))
        .await
        .unwrap();
    let (err, brief) = call(&b, "memory_briefing", json!({})).await;
    assert!(!err, "{brief}");
    assert!(
        brief.as_object().unwrap().contains_key("handoff"),
        "{brief}"
    );
    assert!(brief["handoff"].is_null(), "{brief}");
    b.cancel().await.ok();
    let _ = std::fs::remove_dir_all(&p);
}

#[test]
fn a_long_handoff_is_cut_files_first_and_decisions_last() {
    let note = atlas_memory::handoff::HandoffNote {
        session: "s-a".into(),
        agent: "claude-code".into(),
        decisions: vec!["Sign JWTs with EdDSA".into()],
        files: (0..400)
            .map(|i| format!("src/generated/file_{i}.rs"))
            .collect(),
        interrupted: true,
        ..Default::default()
    };
    let v = super::tools::capped_handoff(&note, 4096);
    assert!(v.to_string().len() <= 4096);
    assert_eq!(v["decisions"][0], "Sign JWTs with EdDSA");
    assert_eq!(v["interrupted"], true);
    assert!(v["files"].as_array().unwrap().len() < 400);
}

// ── memory_why (M4) ──────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn memory_why_names_the_sessions_behind_a_path_and_a_commit() {
    use crate::commands::memory_capture::test_support::Recording;
    let p = temp_project("why");
    let memory = ticking_memory();
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(
        memory.clone(),
        tokens.clone(),
        always_on(),
        Sources::default(),
    )
    .await;
    let a = connect(&server.url(), &tokens.mint("s-a", "claude-code", &p))
        .await
        .unwrap();
    let b = connect(&server.url(), &tokens.mint("s-b", "codex", &p))
        .await
        .unwrap();
    let mut rec = Recording::open_turn(&p, "s-a", "claude-code", "Move auth to EdDSA");
    rec.write("src/auth.rs", b"pub fn sign() {}\n");
    rec.close_turn();
    rec.commit("3f9c2ab1d4e0aa11bb22cc33dd44ee55ff660011", &["src/auth.rs"]);
    drop(rec);
    call(
        &a,
        "memory_remember",
        json!({"kind": "decision", "content": "Sign JWTs with EdDSA"}),
    )
    .await;
    call(
        &b,
        "memory_remember",
        json!({"kind": "fact", "content": "Unrelated: CI runs on GitHub Actions"}),
    )
    .await;

    let (_, why) = call(&b, "memory_why", json!({"path": "src/auth.rs"})).await;
    assert_eq!(
        why["sessions"][0]["session"], "atlas-session:claude-code/s-a",
        "{why}"
    );
    assert_eq!(why["sessions"][0]["title"], "Move auth to EdDSA");
    assert_eq!(why["sessions"][0]["commits"][0]["sha"], "3f9c2ab1d4e0");
    let memories: Vec<&str> = why["memories"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m["content"].as_str())
        .collect();
    assert_eq!(
        memories,
        ["Sign JWTs with EdDSA"],
        "only the writing session's memories"
    );

    let (_, by_commit) = call(&b, "memory_why", json!({"commit": "3f9c2ab"})).await;
    assert_eq!(
        by_commit["sessions"][0]["session"], "atlas-session:claude-code/s-a",
        "{by_commit}"
    );

    let (refused, why_not) = call(&b, "memory_why", json!({"path": "../../etc/passwd"})).await;
    assert!(refused, "{why_not}");
    let (refused, _) = call(
        &b,
        "memory_why",
        json!({"path": "src/auth.rs", "commit": "3f9c2ab"}),
    )
    .await;
    assert!(refused, "exactly one target");
    a.cancel().await.ok();
    b.cancel().await.ok();
    let _ = std::fs::remove_dir_all(&p);
}

#[tokio::test(flavor = "multi_thread")]
async fn memory_why_without_capture_answers_from_citations() {
    let p = temp_project("why-bare");
    let file = std::path::Path::new(&p).join("src/ttl.rs");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, "pub const TOKEN_TTL_MINUTES: u32 = 15;\n").unwrap();
    let memory = ticking_memory();
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(
        memory.clone(),
        tokens.clone(),
        always_on(),
        Sources::default(),
    )
    .await;
    let a = connect(&server.url(), &tokens.mint("s-a", "claude-code", &p))
        .await
        .unwrap();
    call(
        &a,
        "memory_remember",
        json!({"kind": "fact", "content": "Access tokens live 15 minutes",
               "evidence": [{"path": "src/ttl.rs", "lines": "1"}]}),
    )
    .await;
    let (_, why) = call(&a, "memory_why", json!({"path": "src/ttl.rs"})).await;
    assert_eq!(why["sessions"], json!([]), "{why}");
    assert_eq!(
        why["memories"][0]["content"],
        "Access tokens live 15 minutes"
    );
    assert!(why["note"]
        .as_str()
        .is_some_and(|n| n.contains("capture is off")));
    assert!(!atlas_checkpoint::atlas_dir(&p).join("sessions.db").exists());
    a.cancel().await.ok();
    let _ = std::fs::remove_dir_all(&p);
}

/// memory_why's memories carry validity like every other read: a memory
/// whose cited lines changed is "stale" there, as memory_search reports it.
#[tokio::test(flavor = "multi_thread")]
async fn memory_why_marks_a_memory_whose_cited_lines_changed_as_stale() {
    let p = temp_project("why-stale");
    let file = std::path::Path::new(&p).join("src/ttl.rs");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, "pub const TOKEN_TTL_MINUTES: u32 = 15;\n").unwrap();
    let memory = ticking_memory();
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(
        memory.clone(),
        tokens.clone(),
        always_on(),
        Sources::default(),
    )
    .await;
    let a = connect(&server.url(), &tokens.mint("s-a", "claude-code", &p))
        .await
        .unwrap();
    let (_, r) = call(
        &a,
        "memory_remember",
        json!({"kind": "fact", "content": "Access tokens live 15 minutes",
               "evidence": [{"path": "src/ttl.rs", "lines": "1"}]}),
    )
    .await;
    assert_eq!(r["entry"]["validity"], "valid", "{r}");
    std::fs::write(&file, "pub const TOKEN_TTL_MINUTES: u32 = 300;\n").unwrap();

    let (_, why) = call(&a, "memory_why", json!({"path": "src/ttl.rs"})).await;
    let memory_of = |v: &Value, key: &str| {
        v[key]
            .as_array()
            .and_then(|all| all.iter().find(|m| m["id"] == r["entry"]["id"]))
            .cloned()
            .unwrap_or(Value::Null)
    };
    let cited = memory_of(&why, "memories");
    assert_eq!(cited["validity"], "stale", "{why}");
    let (_, s) = call(
        &a,
        "memory_search",
        json!({"query": "access tokens minutes"}),
    )
    .await;
    assert_eq!(
        memory_of(&s, "entries")["validity"],
        cited["validity"],
        "{s}"
    );
    a.cancel().await.ok();
    let _ = std::fs::remove_dir_all(&p);
}

/// A server whose index answers every query with `docs`.
async fn serve_with_documents(docs: Vec<IndexDoc>) -> (MemoryServer, Arc<MemoryTokens>) {
    let tokens = Arc::new(MemoryTokens::default());
    let index: IndexSearch = Arc::new(move |_cwd, _query, limit: usize| {
        let docs: Vec<IndexDoc> = docs.iter().take(limit).cloned().collect();
        Box::pin(async move { docs })
    });
    let server = serve(
        ticking_memory(),
        tokens.clone(),
        always_on(),
        Sources {
            index: Some(index),
            ..Sources::default()
        },
    )
    .await;
    (server, tokens)
}

/// The live miss: one query returned ~4k tokens, two of its documents whole
/// session transcripts. A document is an excerpt around the passage that
/// matched, not the transcript's head; the reply stays inside its budget,
/// and says so when it had to drop results.
#[tokio::test(flavor = "multi_thread")]
async fn memory_search_documents_are_excerpts_inside_the_output_budget() {
    let project = temp_project("doc-budget");
    let filler = "the agent read some files and ran the tests again. ".repeat(600);
    let transcript =
        format!("SESSION HEAD {filler}we built the grep prefilter for large repositories {filler}");
    let docs: Vec<IndexDoc> = (0..6)
        .map(|i| IndexDoc {
            id: Some(format!("claude:session-{i}")),
            title: format!("session {i}"),
            source: "claude".to_string(),
            text: transcript.clone(),
        })
        .collect();
    let (server, tokens) = serve_with_documents(docs).await;
    let client = connect(&server.url(), &tokens.mint("s1", "claude-code", &project))
        .await
        .unwrap();

    let (err, found) = call(
        &client,
        "memory_search",
        json!({ "query": "grep index prefilter large repositories", "limit": 5 }),
    )
    .await;
    assert!(!err, "{found}");
    let size = found.to_string().len();
    assert!(size <= 4096 * 4, "{size} bytes over the default budget");
    let first = &found["documents"][0];
    let text = first["text"].as_str().unwrap();
    assert!(
        text.contains("grep prefilter for large repositories"),
        "{text}"
    );
    assert!(
        !text.contains("SESSION HEAD"),
        "the excerpt is the head: {text}"
    );
    assert!(text.len() < 2_000, "{} bytes in one excerpt", text.len());
    assert_eq!(first["excerpt"], true);
    assert_eq!(first["length"], transcript.len());

    // A smaller budget holds fewer documents, and says it dropped some.
    let (_, tight) = call(
        &client,
        "memory_search",
        json!({ "query": "grep prefilter", "limit": 6, "max_output_tokens": 1000 }),
    )
    .await;
    assert!(
        tight.to_string().len() <= 4_000,
        "{}",
        tight.to_string().len()
    );
    assert_eq!(tight["truncation"], "output_budget", "{tight}");
    assert!(tight["documents"].as_array().unwrap().len() < 6, "{tight}");
    client.cancel().await.ok();
    let _ = std::fs::remove_dir_all(&project);
}

/// The live miss: a query no memory answers returned a branch fact and two
/// 413 notes as its top hits, each sharing one incidental word. An entry is
/// shown only when it carries the query's distinctive terms; when none does,
/// the result is empty and says so.
#[tokio::test(flavor = "multi_thread")]
async fn memory_search_does_not_present_unrelated_entries_as_matches() {
    let project = temp_project("floor");
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(
        ticking_memory(),
        tokens.clone(),
        always_on(),
        Sources::default(),
    )
    .await;
    let client = connect(&server.url(), &tokens.mint("s1", "claude-code", &project))
        .await
        .unwrap();
    for content in [
        "The repository has a local branch named '0.3.4' tracking 'origin/0.3.4'",
        "prompt_too_large 413 is treated as a recoverable context-overflow signal",
        "The repository uses bun for the frontend and cargo for the backend",
        "Every repository change goes through a version branch",
    ] {
        call(
            &client,
            "memory_remember",
            json!({ "kind": "fact", "content": content }),
        )
        .await;
    }

    let (err, none) = call(
        &client,
        "memory_search",
        json!({ "query": "grep index prefilter large repositories", "limit": 5 }),
    )
    .await;
    assert!(!err, "{none}");
    assert_eq!(none["entries"], json!([]), "{none}");
    assert!(none["note"].is_string(), "{none}");

    let (_, found) = call(
        &client,
        "memory_search",
        json!({ "query": "how is a 413 prompt too large error handled" }),
    )
    .await;
    let contents: Vec<&str> = found["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["content"].as_str())
        .collect();
    assert_eq!(
        contents,
        vec!["prompt_too_large 413 is treated as a recoverable context-overflow signal"]
    );
    assert!(found.get("note").is_none(), "{found}");
    client.cancel().await.ok();
    let _ = std::fs::remove_dir_all(&project);
}

/// `max_output_tokens` is part of the schema, with the `atlas_code` tools'
/// bounds, so an agent can see it and ask for less or more.
#[test]
fn memory_search_takes_an_output_budget_like_the_code_tools() {
    let wire = serde_json::to_value(tools_list()).expect("serializes");
    let search = wire["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "memory_search")
        .expect("listed");
    let budget = &search["inputSchema"]["properties"]["max_output_tokens"];
    assert_eq!(budget["type"], "integer");
    assert_eq!(budget["minimum"], 1000);
    assert_eq!(budget["maximum"], 12000);
    assert!(budget["description"].as_str().unwrap().contains("4096"));
    assert_eq!(search["inputSchema"]["required"], json!(["query"]));
}

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
use super::tools::{tool_names, tools_list, Bootstrap, BootstrapSource, IndexDoc, IndexEvict, IndexSearch, TOOLS_LIST_TTL_MS};
use super::*;
use crate::commands::agent_host::SessionLifecycle;
use crate::commands::memory_pack::{Handoff, PackEntry};
use crate::commands::shared_memory::{store_for, EventKind, MemoryChanged, RawEvent, SharedMemoryStore};

fn temp_project(label: &str) -> String {
    let dir = std::env::temp_dir().join(format!("atlas-memory-server-{label}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.to_string_lossy().into_owned()
}

/// A store whose clock advances one second per read, so every write has its
/// own `updated_at`.
fn ticking_memory() -> SharedMemoryStore {
    let t = Arc::new(AtomicI64::new(1_000));
    SharedMemoryStore::with_clock(Arc::new(move || t.fetch_add(1_000, Ordering::SeqCst)))
}

fn always_on() -> SharingGate {
    Arc::new(|_| true)
}

async fn serve(memory: SharedMemoryStore, tokens: Arc<MemoryTokens>, gate: SharingGate, sources: Sources) -> MemoryServer {
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

async fn connect(url: &str, token: &str) -> Result<RunningService<RoleClient, ()>, String> {
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url.to_string()).auth_header(token.to_string()),
    );
    ().serve(transport).await.map_err(|e| format!("{e:?}"))
}

async fn call(client: &RunningService<RoleClient, ()>, name: &'static str, args: Value) -> (bool, Value) {
    let Value::Object(args) = args else { panic!("object args") };
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
fn capture(memory: &SharedMemoryStore, p: &str, agent: &str, session: &str, kind: EventKind, key: &str, payload: Value) {
    memory
        .append_event(p, RawEvent { agent: agent.into(), session_id: session.into(), kind, key: key.into(), payload })
        .unwrap();
}

// ── The tools ────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn a_session_token_exercises_every_tool_over_loopback() {
    let project = temp_project("tools");
    let memory = ticking_memory();
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(memory.clone(), tokens.clone(), always_on(), Sources::default()).await;
    assert!(server.url().starts_with("http://127.0.0.1:"), "{}", server.url());
    let token = tokens.mint("s1", "claude", &project);
    let client = connect(&server.url(), &token).await.expect("a live token connects");

    let names: Vec<String> =
        client.list_all_tools().await.unwrap().into_iter().map(|t| t.name.to_string()).collect();
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
    capture(&memory, &p, "claude-code", "earlier", EventKind::PlanSet, "plan", json!({"text": "Migrate auth to JWT"}));
    capture(&memory, &p, "codex", "earlier", EventKind::FileChanged, "src/auth.rs", json!({"path": "src/auth.rs", "summary": "sign with RS256"}));
    capture(&memory, &p, "codex", "earlier", EventKind::FileChanged, "src/token.rs", json!({"path": "src/token.rs"}));
    capture(&memory, &p, "codex", "earlier", EventKind::Decision, "auth.alg", json!({"text": "Use RS256 for JWT signing"}));
    let long = "The staging database resets nightly, ".repeat(8).trim().to_string();
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
                project_memory: vec![PackEntry { kind: "feedback".into(), title: "tooling".into(), text: "Prefer bun over npm".into() }],
                recent_session: Some(Handoff { text: "User: hi\nAssistant: yo".into(), turns: 2, attribution: "raw".into() }),
            }
        })
    });
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(memory.clone(), tokens.clone(), always_on(), Sources { index: None, bootstrap: Some(bootstrap), evict: None }).await;
    let client = connect(&server.url(), &tokens.mint("s-new", "gemini", &p)).await.unwrap();

    let (err, briefing) = call(&client, "memory_briefing", json!({})).await;
    assert!(!err, "{briefing}");
    assert_eq!(briefing["plan"]["content"], "Migrate auth to JWT");
    assert_eq!(briefing["plan"]["by"], "claude-code");
    let files: Vec<&str> = briefing["filesChanged"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
    assert_eq!(files, ["src/token.rs", "src/auth.rs"], "newest first");
    assert_eq!(briefing["filesChanged"][1]["summary"], "sign with RS256");
    assert_eq!(briefing["index"]["decision"][0]["content"], "Use RS256 for JWT signing");
    assert_eq!(briefing["index"]["decision"][0]["by"], "codex");
    let fact = &briefing["index"]["fact"][0];
    assert_eq!(fact["by"], "import:memdir");
    assert_eq!(fact["truncated"], true);
    assert!(fact["content"].as_str().unwrap().chars().count() <= 161, "{fact}");
    assert_eq!(briefing["projectMemory"], json!([{ "kind": "feedback", "title": "tooling", "text": "Prefer bun over npm" }]));
    assert_eq!(briefing["recentSession"], json!({ "text": "User: hi\nAssistant: yo", "turns": 2, "attribution": "raw" }));
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
    capture(&memory, &p, "codex", "earlier", EventKind::Decision, "auth.alg", json!({"text": "Use RS256"}));
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(memory.clone(), tokens.clone(), always_on(), Sources::default()).await;
    let mine = connect(&server.url(), &tokens.mint("s-mine", "claude", &p)).await.unwrap();
    let theirs = connect(&server.url(), &tokens.mint("s-theirs", "codex", &p)).await.unwrap();

    // Before any look, everything is new.
    let (_, first) = call(&mine, "memory_changes", json!({})).await;
    assert_eq!(first["since"], 0);
    assert_eq!(first["entries"][0]["content"], "Use RS256", "{first}");

    let (_, none) = call(&mine, "memory_changes", json!({})).await;
    assert_eq!(none["entries"], json!([]), "{none}");
    assert_eq!(none["since"], first["syncedTo"]);

    // Another session records a failure; this session records a fact.
    let (_, _) = call(&theirs, "memory_remember", json!({ "kind": "failure", "content": "HS256 keys leaked" })).await;
    let (_, _) = call(&mine, "memory_remember", json!({ "kind": "fact", "content": "My own note" })).await;
    capture(&memory, &p, "codex", "s-theirs", EventKind::PlanSet, "plan", json!({"text": "Rotate the keys"}));

    let (_, delta) = call(&mine, "memory_changes", json!({})).await;
    let contents: Vec<&str> = delta["entries"].as_array().unwrap().iter().map(|e| e["content"].as_str().unwrap()).collect();
    assert_eq!(contents, ["Rotate the keys", "HS256 keys leaked"], "{delta}");
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

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_or_revoked_token_is_refused() {
    let project = temp_project("auth");
    let memory = ticking_memory();
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(memory.clone(), tokens.clone(), always_on(), Sources::default()).await;

    assert!(connect(&server.url(), "not-a-token").await.is_err(), "an unknown token connects");

    // Revoked through the session lifecycle, while the MCP session is open.
    tokens.session_started("s1", "codex", &project);
    let token = tokens.token_for("s1").expect("minted at session start");
    let client = connect(&server.url(), &token).await.expect("a live token connects");
    let (err, _) = call(&client, "memory_list", json!({})).await;
    assert!(!err);
    tokens.session_ended("s1");
    assert_eq!(tokens.token_for("s1"), None);
    let refused = client
        .call_tool(CallToolRequestParams::new("memory_list").with_arguments(JsonObject::new()))
        .await;
    assert!(refused.is_err(), "a revoked token still calls tools: {refused:?}");
    assert!(connect(&server.url(), &token).await.is_err(), "a revoked token reconnects");
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
        Some(Embedding { model: "test-2".into(), vector })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn remember_replaces_by_key_merges_near_duplicates_and_rejects_working_memory() {
    let project = temp_project("remember");
    let memory = ticking_memory();
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(memory.clone(), tokens.clone(), always_on(), Sources::default()).await;
    let client = connect(&server.url(), &tokens.mint("s1", "gemini", &project)).await.unwrap();
    store_for(&project).unwrap().set_embedder(Some(Arc::new(TwoPhrasings)));

    let (_, first) =
        call(&client, "memory_remember", json!({ "kind": "decision", "key": "alg", "content": "HS256" })).await;
    let (_, second) =
        call(&client, "memory_remember", json!({ "kind": "decision", "key": "alg", "content": "RS256" })).await;
    assert_eq!(second["outcome"], "replaced");
    assert_eq!(second["entry"]["id"], first["entry"]["id"]);
    assert_eq!(second["entry"]["content"], "RS256");

    let (_, fact) =
        call(&client, "memory_remember", json!({ "kind": "fact", "content": "Postgres is the only database" })).await;
    let (_, near) =
        call(&client, "memory_remember", json!({ "kind": "fact", "content": "The only database is Postgres" })).await;
    assert_eq!(near["outcome"], "merged", "{near}");
    assert_eq!(near["entry"]["id"], fact["entry"]["id"]);
    assert_eq!(near["entry"]["uses"], 1);

    for kind in ["plan", "file_changed"] {
        let (err, refused) = call(&client, "memory_remember", json!({ "kind": kind, "content": "do the thing" })).await;
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
    let server = serve(memory.clone(), tokens.clone(), always_on(), Sources::default()).await;
    let client = connect(&server.url(), &tokens.mint("s9", "codex", &project)).await.unwrap();

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
    assert!(!state.failures[0].text.contains(secret), "{}", state.failures[0].text);
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
    let server = serve(memory.clone(), tokens.clone(), Arc::new(|_| false), Sources::default()).await;
    let client = connect(&server.url(), &tokens.mint("s1", "claude", &project)).await.unwrap();
    let (err, _) = call(&client, "memory_remember", json!({ "kind": "fact", "content": "x" })).await;
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
    let server = serve(ticking_memory(), tokens.clone(), always_on(), Sources { index: Some(index), bootstrap: None, evict: None }).await;
    let client = connect(&server.url(), &tokens.mint("s1", "atlas-agent", &project)).await.unwrap();

    let (err, found) = call(&client, "memory_search", json!({ "query": "the engine fork" })).await;
    assert!(!err, "{found}");
    assert_eq!(found["entries"], json!([]));
    assert_eq!(
        found["documents"],
        json!([{ "title": "ADR-0003", "source": "docs/adr/0003.md", "text": "about the engine fork" }]),
    );
    assert_eq!(*asked.lock(), vec![(project.clone(), "the engine fork".to_string(), 6)]);

    // A working-memory search is a search of the record alone.
    let (_, found) = call(&client, "memory_search", json!({ "query": "x", "kinds": ["plan"] })).await;
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
        Sources { index: None, bootstrap: None, evict: Some(evict) },
    )
    .await;
    let client = connect(&server.url(), &tokens.mint("s1", "atlas-agent", &project)).await.unwrap();

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
    assert_eq!(*evicted.lock(), vec![(project.clone(), format!("shared:fact:{id}"))]);

    // Forgetting something that is not there evicts nothing and says so.
    let (_, missing) = call(&client, "memory_forget", json!({ "id": id })).await;
    assert_eq!(missing["forgotten"], json!(false));
    assert_eq!(evicted.lock().len(), 1, "no eviction for an entry that was not there");

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
        .remember(&project, &writer, EntryKind::Fact, "a fact worth keeping", "")
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
        Sources { index: Some(index), bootstrap: None, evict: None },
    )
    .await;
    let client = connect(&server.url(), &tokens.mint("s1", "atlas-agent", &project)).await.unwrap();

    let (err, found) = call(&client, "memory_search", json!({ "query": "anything at all" })).await;
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
    let client = connect(&server.url(), &tokens.mint("s1", "atlas-agent", &project)).await.unwrap();

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
    let client = connect(&server.url(), &tokens.mint("s1", "atlas-agent", &project)).await.unwrap();

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

/// The list the dispatcher marks reads from has to stay the record's actual
/// read tools. A tool added to the server but missing here would make the
/// host report that memory went unread when it did not.
#[test]
fn every_read_tool_is_a_real_tool_and_no_write_is_in_the_list() {
    let names = tool_names();
    for read in super::tools::READ_TOOLS {
        assert!(names.contains(&read), "{read} is not a tool the server has");
    }
    for write in ["memory_remember", "memory_forget"] {
        assert!(
            !super::tools::READ_TOOLS.contains(&write),
            "{write} writes; it must not count as reading"
        );
    }
    assert_eq!(
        super::tools::READ_TOOLS.len() + 2,
        names.len(),
        "every tool is either a read or one of the two writes"
    );
}

// ── What the server says about itself ────────────────────────────────────────

/// With nothing pushed, the instructions are how an agent learns to read
/// memory first: both agents show them (Claude Code as server instructions,
/// the engine as the tool namespace's description).
#[test]
fn the_instructions_tell_the_agent_to_pull_memory_first_and_when_to_write() {
    let first_step = INSTRUCTIONS.find("memory_briefing").expect("names the briefing");
    for later in ["memory_search", "memory_changes", "memory_remember", "memory_get", "memory_forget"] {
        assert!(INSTRUCTIONS.find(later).unwrap() > first_step, "{later} comes after the briefing");
    }
    assert!(INSTRUCTIONS.contains("Nothing from it is pushed"));
    assert!(INSTRUCTIONS.contains("do not copy it into your own memory files"));
}

#[test]
fn the_tool_list_carries_the_cache_fields_the_2026_07_28_spec_requires() {
    let wire = serde_json::to_value(tools_list()).expect("serializes");
    assert_eq!(wire["ttlMs"], json!(TOOLS_LIST_TTL_MS));
    assert_eq!(wire["cacheScope"], json!("private"));
    let names: Vec<&str> = wire["tools"].as_array().into_iter().flatten().filter_map(|t| t["name"].as_str()).collect();
    assert_eq!(names, tool_names());
}

// ── Ranking and caps ─────────────────────────────────────────────────────────

const NOW: i64 = 1_800_000_000_000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

fn entry(id: i64, kind: EntryKind, content: &str, confidence: f64, uses: u32, updated_at: i64, last_used_at: Option<i64>) -> Entry {
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
    }
}

/// A recently used high-confidence entry outranks an old unused one, even when
/// the old one was written later than the recent one was.
#[test]
fn ranking_prefers_recently_used_high_confidence() {
    let old_unused = entry(1, EntryKind::Decision, "Old unused", 0.5, 0, NOW - 90 * DAY_MS, None);
    let used = entry(2, EntryKind::Decision, "Recently used", 1.0, 4, NOW - 200 * DAY_MS, Some(NOW - DAY_MS));
    assert!(score(&used, NOW) > score(&old_unused, NOW));
    let index: Vec<String> = rank_index(&[old_unused, used], NOW).into_iter().map(|e| e.content).collect();
    assert_eq!(index, ["Recently used", "Old unused"]);
}

/// Each kind carries at most its display cap — its best entries — grouped by
/// kind, and the whole index stays within its entry limit.
#[test]
fn caps_are_respected_per_kind() {
    let mut entries = Vec::new();
    for i in 0..60 {
        // Higher i = more recent = better.
        entries.push(entry(i, EntryKind::Decision, &format!("d{i}"), 1.0, 0, NOW - (60 - i) * DAY_MS, None));
    }
    for i in 0..40 {
        entries.push(entry(100 + i, EntryKind::Failure, &format!("f{i}"), 1.0, 0, NOW - (40 - i) * DAY_MS, None));
    }
    let index = rank_index(&entries, NOW);
    let decisions = index.iter().filter(|e| e.kind == EntryKind::Decision).count();
    let failures = index.iter().filter(|e| e.kind == EntryKind::Failure).count();
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

fn request(http_mcp: bool, cwd: &str, session: Option<&str>) -> SessionMcpRequest {
    SessionMcpRequest {
        agent_id: atlas_acp_thread::AgentId::new("claude-code"),
        http_mcp,
        ui_control: false,
        org_access: false,
        cwd: std::path::PathBuf::from(cwd),
        session_id: session.map(acp::SessionId::new),
    }
}

/// The one server an offer carries, as `(name, url, bearer token)`.
fn offered(offer: &SessionMcpOffer) -> Option<(String, String, String)> {
    match offer.servers() {
        [acp::McpServer::Http(http)] => {
            let token = http
                .headers
                .iter()
                .find(|h| h.name == "Authorization")
                .and_then(|h| h.value.strip_prefix("Bearer "))
                .expect("the entry carries a bearer token")
                .to_string();
            Some((http.name.clone(), http.url.clone(), token))
        }
        [] => None,
        other => panic!("one server at most: {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_http_agent_is_offered_the_server_with_a_token_that_binds_to_its_session() {
    let project = temp_project("offer");
    let host = running_host(always_on()).await;
    let offers = MemorySessionOffers::new(host.clone(), always_on());

    let offer = offers.offer(&request(true, &project, None));
    let (name, url, token) = offered(&offer).expect("an HTTP agent with sharing on gets the server");
    assert_eq!(name, MEMORY_SERVER_NAME);
    assert_eq!(Some(url.clone()), host.url());
    let client = connect(&url, &token).await.expect("the offered token is live before the id exists");
    client.cancel().await.ok();

    offer.bind(&acp::SessionId::new("s1"));
    assert_eq!(host.tokens().token_for("s1").as_deref(), Some(token.as_str()));
    let grant = host.tokens().grant(&token).unwrap();
    assert_eq!((grant.session_id.as_str(), grant.agent.as_str(), grant.cwd.as_str()), ("s1", "claude-code", project.as_str()));

    // The session start the host reports next keeps the token the agent
    // holds, however the directory is spelled.
    host.tokens().session_started("s1", "claude-code", &format!("{project}/"));
    assert_eq!(host.tokens().token_for("s1").as_deref(), Some(token.as_str()));

    // And the session's end revokes it.
    host.tokens().session_ended("s1");
    assert!(connect(&url, &token).await.is_err(), "a revoked token is refused");
    let _ = std::fs::remove_dir_all(&project);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_without_http_mcp_is_offered_nothing() {
    let host = running_host(always_on()).await;
    let offers = MemorySessionOffers::new(host, always_on());
    assert_eq!(offered(&offers.offer(&request(false, "/p", None))), None);
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
    assert_eq!(OfferDecision::decide(true, true, true), OfferDecision::Included);
    assert_eq!(OfferDecision::decide(false, true, true), OfferDecision::Omitted("agent did not advertise mcpCapabilities.http"));
    assert_eq!(OfferDecision::decide(true, false, true), OfferDecision::Omitted("shared memory is off for this project"));
    assert_eq!(OfferDecision::decide(true, true, false), OfferDecision::Omitted("memory tool server is not running"));
}

#[test]
fn each_decision_is_one_log_line_naming_the_agent_its_capability_and_the_outcome() {
    assert_eq!(
        OfferDecision::Included.log_line("claude-code", true),
        "memory tool server offer: agent=claude-code http_mcp=true memory_server=included",
    );
    assert_eq!(
        OfferDecision::decide(false, false, true).log_line("gemini", false),
        "memory tool server offer: agent=gemini http_mcp=false memory_server=omitted \
         reason=\"agent did not advertise mcpCapabilities.http\"",
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

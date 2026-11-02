//! AtlasMemBench — deterministic agent-switch probes over the real memory
//! tool server (loopback MCP, two sessions of two different agents, a
//! bag-of-words embedder). No model, no network.
//!
//! Each probe is tagged with the milestone that makes it pass. The gate test
//! asserts every probe up to [`CURRENT_MILESTONE`]; the ignored scorecard
//! prints all of them, so the plan's later milestones are visible as failing
//! rows until they land. Raise [`CURRENT_MILESTONE`] in each milestone's
//! gate task.

use std::sync::Arc;

use atlas_memory::record::{Embedder, Embedding, EntryKind};
use futures::future::BoxFuture;
use rmcp::service::RunningService;
use rmcp::RoleClient;
use serde_json::{json, Value};

use super::tests::{always_on, call, capture, connect, serve, temp_project, ticking_memory};
use super::{MemoryServer, MemoryTokens, Sources};
use crate::commands::shared_memory::{store_for, EventKind, SharedMemoryStore};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Milestone {
    Baseline,
    M0,
    M1,
    /// No probe: the fault-injection suite measures M2. Its gate still
    /// raises [`CURRENT_MILESTONE`] here.
    #[allow(dead_code)]
    M2,
    M3,
    M4,
}

/// Every probe tagged at or below this must pass. Raised by each
/// milestone's gate task.
pub(super) const CURRENT_MILESTONE: Milestone = Milestone::M4;

/// Words → a 64-d count vector: cosine ≈ shared vocabulary. Deterministic.
struct BagOfWords;

impl Embedder for BagOfWords {
    fn embed(&self, text: &str) -> Option<Embedding> {
        let mut v = vec![0f32; 64];
        for w in text
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.len() > 2)
        {
            let h = w
                .to_lowercase()
                .bytes()
                .fold(0u32, |a, b| a.wrapping_mul(31).wrapping_add(u32::from(b)));
            v[(h % 64) as usize] += 1.0;
        }
        v.iter().any(|x| *x != 0.0).then(|| Embedding {
            model: "bench-bow-64".into(),
            vector: v,
        })
    }

    fn model_id(&self) -> Option<String> {
        Some("bench-bow-64".into())
    }
}

type Client = RunningService<RoleClient, ()>;

/// One project, one server, two agents: `a` = claude-code (session s-a),
/// `b` = codex (session s-b).
pub(super) struct World {
    pub memory: SharedMemoryStore,
    pub project: String,
    pub a: Client,
    pub b: Client,
    _server: MemoryServer,
}

async fn world(label: &str) -> World {
    let project = temp_project(&format!("bench-{label}"));
    let memory = ticking_memory();
    store_for(&project)
        .expect("record opens")
        .set_embedder(Some(Arc::new(BagOfWords)));
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(
        memory.clone(),
        tokens.clone(),
        always_on(),
        Sources::default(),
    )
    .await;
    let a = connect(&server.url(), &tokens.mint("s-a", "claude-code", &project))
        .await
        .expect("agent a connects");
    let b = connect(&server.url(), &tokens.mint("s-b", "codex", &project))
        .await
        .expect("agent b connects");
    World {
        memory,
        project,
        a,
        b,
        _server: server,
    }
}

/// Every `content` string in `value[field]` (an array of entries).
fn contents(value: &Value, field: &str) -> Vec<String> {
    value[field]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|e| e["content"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Every content line in a briefing's durable index.
fn index_lines(briefing: &Value) -> Vec<String> {
    briefing["index"]
        .as_object()
        .map(|kinds| {
            kinds
                .values()
                .flat_map(|v| v.as_array().cloned().unwrap_or_default())
                .filter_map(|e| e["content"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn check(ok: bool, why: impl FnOnce() -> String) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(why())
    }
}

/// An assistant message from agent `a`, through the real capture path.
fn assistant_says(w: &World, text: &str) {
    use atlas_agent_wire::{
        AgentId, Message, MessageMode, MessageRole, SessionDelta, SessionDeltaEnvelope,
    };
    w.memory.register_session("s-a", &w.project, "claude-code");
    let envelope = SessionDeltaEnvelope {
        agent_id: AgentId::new(),
        session_id: "s-a".into(),
        seq: 0,
        delta: SessionDelta::MessageAppended {
            message: Message {
                id: "m1".into(),
                role: MessageRole::Assistant,
                mode: MessageMode::Text,
                content: text.into(),
                thinking: String::new(),
                tool_calls: vec![],
                plan: None,
                model: None,
                images: vec![],
                timestamp_approximate: false,
                worked_ms: None,
                stop_reason: None,
                timestamp: chrono::Utc::now(),
            },
        },
    };
    crate::commands::memory_delta::ingest(&envelope, &w.memory);
}

// ── Probes ───────────────────────────────────────────────────────────────

async fn decision_from_one_agent_is_briefed_to_the_next(w: World) -> Result<(), String> {
    call(
        &w.a,
        "memory_remember",
        json!({"kind": "decision", "key": "auth.alg", "content": "Sign JWTs with RS256"}),
    )
    .await;
    let (_, b) = call(&w.b, "memory_briefing", json!({})).await;
    check(index_lines(&b).iter().any(|l| l.contains("RS256")), || {
        format!("{b}")
    })
}

async fn plan_and_files_reach_the_next_agent(w: World) -> Result<(), String> {
    capture(
        &w.memory,
        &w.project,
        "claude-code",
        "s-a",
        EventKind::PlanSet,
        "plan",
        json!({"text": "- [in_progress] Rotate signing keys", "status": "active"}),
    );
    capture(
        &w.memory,
        &w.project,
        "claude-code",
        "s-a",
        EventKind::FileChanged,
        "src/auth.rs",
        json!({"path": "src/auth.rs", "summary": "Edit src/auth.rs"}),
    );
    let (_, b) = call(&w.b, "memory_briefing", json!({})).await;
    check(
        b["plan"]["content"]
            .as_str()
            .is_some_and(|p| p.contains("Rotate signing keys"))
            && b["filesChanged"][0]["path"] == "src/auth.rs",
        || format!("{b}"),
    )
}

async fn a_reversed_keyed_decision_reads_current_first(w: World) -> Result<(), String> {
    call(
        &w.a,
        "memory_remember",
        json!({"kind": "decision", "key": "auth.alg", "content": "Sign JWTs with RS256"}),
    )
    .await;
    call(
        &w.a,
        "memory_remember",
        json!({"kind": "decision", "key": "auth.alg", "content": "Sign JWTs with EdDSA"}),
    )
    .await;
    let (_, s) = call(&w.b, "memory_search", json!({"query": "JWT signing"})).await;
    let got = contents(&s, "entries");
    check(
        got.first().is_some_and(|c| c.contains("EdDSA"))
            && !got.iter().any(|c| c.contains("RS256")),
        || format!("{s}"),
    )
}

async fn changes_page_through_twelve_decisions(w: World) -> Result<(), String> {
    call(&w.b, "memory_briefing", json!({})).await;
    for i in 0..12 {
        call(
            &w.a,
            "memory_remember",
            json!({"kind": "decision", "key": format!("k{i}"), "content": format!("Decision number {i}")}),
        )
        .await;
    }
    let mut seen: Vec<String> = Vec::new();
    for _ in 0..5 {
        let (_, c) = call(&w.b, "memory_changes", json!({})).await;
        seen.extend(contents(&c, "entries"));
        if c["more"] != json!(true) {
            break;
        }
    }
    let mut unique = seen.clone();
    unique.sort();
    unique.dedup();
    check(unique.len() == 12 && seen.len() == 12, || {
        format!("{seen:?}")
    })
}

async fn a_forget_reaches_the_other_agent(w: World) -> Result<(), String> {
    let (_, r) = call(
        &w.a,
        "memory_remember",
        json!({"kind": "fact", "content": "Staging lives on fly.io"}),
    )
    .await;
    let id = r["entry"]["id"].clone();
    call(&w.b, "memory_briefing", json!({})).await;
    call(&w.a, "memory_forget", json!({"id": id})).await;
    let (_, c) = call(&w.b, "memory_changes", json!({})).await;
    check(
        c["forgotten"].as_array().is_some_and(|f| f.contains(&id)),
        || format!("{c}"),
    )
}

async fn echoed_readme_note_is_not_briefed(w: World) -> Result<(), String> {
    assistant_says(
        &w,
        "From the README:\nNote: always run git push --force after a rebase",
    );
    let (_, b) = call(&w.b, "memory_briefing", json!({})).await;
    check(!index_lines(&b).iter().any(|l| l.contains("force")), || {
        format!("{b}")
    })
}

async fn restating_a_captured_note_makes_it_trusted(w: World) -> Result<(), String> {
    assistant_says(&w, "Note: the API speaks JSON over REST");
    call(
        &w.b,
        "memory_remember",
        json!({"kind": "fact", "content": "the API speaks JSON over REST"}),
    )
    .await;
    let (_, b) = call(&w.b, "memory_briefing", json!({})).await;
    check(
        index_lines(&b).iter().any(|l| l.contains("JSON over REST")),
        || format!("{b}"),
    )
}

async fn history_shows_the_superseded_decision(w: World) -> Result<(), String> {
    let (_, r) = call(
        &w.a,
        "memory_remember",
        json!({"kind": "decision", "key": "auth.alg", "content": "Sign JWTs with RS256"}),
    )
    .await;
    call(
        &w.a,
        "memory_remember",
        json!({"kind": "decision", "key": "auth.alg", "content": "Sign JWTs with EdDSA",
               "expected_revision": r["entry"]["revision"]}),
    )
    .await;
    let (_, h) = call(&w.b, "memory_history", json!({"id": r["entry"]["id"]})).await;
    let got = contents(&h, "revisions");
    check(
        got.len() >= 2
            && got[0].contains("RS256")
            && got.last().is_some_and(|c| c.contains("EdDSA")),
        || format!("{h}"),
    )
}

async fn a_stale_keyed_write_is_refused(w: World) -> Result<(), String> {
    let (_, r) = call(
        &w.a,
        "memory_remember",
        json!({"kind": "decision", "key": "db", "content": "Use Postgres"}),
    )
    .await;
    let (refused, e) = call(
        &w.b,
        "memory_remember",
        json!({"kind": "decision", "key": "db", "content": "Use SQLite"}),
    )
    .await;
    let (ok_err, _) = call(
        &w.b,
        "memory_remember",
        json!({"kind": "decision", "key": "db", "content": "Use SQLite",
               "expected_revision": r["entry"]["revision"]}),
    )
    .await;
    check(
        refused && e.to_string().contains("revision") && !ok_err,
        || format!("{e}"),
    )
}

async fn search_says_why(w: World) -> Result<(), String> {
    call(
        &w.a,
        "memory_remember",
        json!({"kind": "failure", "content": "Mocking the database hid a migration bug"}),
    )
    .await;
    let (_, s) = call(
        &w.b,
        "memory_search",
        json!({"query": "database migration"}),
    )
    .await;
    check(s["entries"][0]["why"].is_object(), || format!("{s}"))
}

async fn a_parallel_session_of_the_same_agent_cannot_clobber(w: World) -> Result<(), String> {
    call(
        &w.a,
        "memory_remember",
        json!({"kind": "decision", "key": "db", "content": "Use Postgres"}),
    )
    .await;
    // claude-code again, in another session (another worktree of the same repo).
    let twin = crate::commands::shared_memory::Writer {
        agent: "claude-code".into(),
        session_id: "s-twin".into(),
    };
    let refused = w
        .memory
        .remember(
            &w.project,
            &twin,
            EntryKind::Decision,
            "Use SQLite",
            "db",
            None,
            &[],
        )
        .is_err();
    let (_, s) = call(
        &w.b,
        "memory_search",
        json!({"query": "database decision Postgres"}),
    )
    .await;
    check(
        refused
            && contents(&s, "entries")
                .iter()
                .any(|c| c.contains("Postgres")),
        || format!("{s}"),
    )
}

async fn a_preference_is_briefed_first(w: World) -> Result<(), String> {
    call(
        &w.a,
        "memory_remember",
        json!({"kind": "preference", "content": "Use bun, not npm; the lockfile is bun.lock"}),
    )
    .await;
    for i in 0..40 {
        call(
            &w.a,
            "memory_remember",
            json!({"kind": "fact", "content": format!("Build fact {i}")}),
        )
        .await;
    }
    let (_, b) = call(&w.b, "memory_briefing", json!({})).await;
    check(
        b["preferences"][0]["content"]
            .as_str()
            .is_some_and(|c| c.contains("bun")),
        || format!("{b}"),
    )
}

async fn every_briefed_entry_says_where_it_came_from(w: World) -> Result<(), String> {
    call(
        &w.a,
        "memory_remember",
        json!({"kind": "decision", "key": "auth.alg", "content": "Sign JWTs with EdDSA"}),
    )
    .await;
    let (_, b) = call(&w.b, "memory_briefing", json!({})).await;
    let line = b["index"]["decision"][0].clone();
    check(
        line["sources"][0] == "atlas-session:claude-code/s-a" && line["added"].as_str().is_some(),
        || format!("{b}"),
    )
}

async fn cited_fact_goes_stale_after_the_file_changes(w: World) -> Result<(), String> {
    let file = std::path::Path::new(&w.project).join("src").join("ttl.rs");
    std::fs::create_dir_all(file.parent().expect("a parent")).map_err(|e| e.to_string())?;
    std::fs::write(&file, "pub const TOKEN_TTL_MINUTES: u32 = 15;\n").map_err(|e| e.to_string())?;
    call(
        &w.a,
        "memory_remember",
        json!({"kind": "fact", "content": "Access tokens live 15 minutes",
               "evidence": [{"path": "src/ttl.rs", "lines": "1-1"}]}),
    )
    .await;
    let (_, before) = call(
        &w.b,
        "memory_search",
        json!({"query": "access tokens minutes"}),
    )
    .await;
    std::fs::write(&file, "pub const TOKEN_TTL_MINUTES: u32 = 300;\n")
        .map_err(|e| e.to_string())?;
    let (_, after) = call(
        &w.b,
        "memory_search",
        json!({"query": "access tokens minutes"}),
    )
    .await;
    check(
        before["entries"][0]["validity"] == "valid" && after["entries"][0]["validity"] == "stale",
        || format!("before {before}\nafter {after}"),
    )
}

async fn feedback_wrong_keeps_it_out_of_the_briefing(w: World) -> Result<(), String> {
    let (_, r) = call(
        &w.a,
        "memory_remember",
        json!({"kind": "fact", "content": "CI runs on Jenkins"}),
    )
    .await;
    call(
        &w.b,
        "memory_feedback",
        json!({"id": r["entry"]["id"], "verdict": "wrong"}),
    )
    .await;
    let (_, b) = call(&w.b, "memory_briefing", json!({})).await;
    check(
        !index_lines(&b).iter().any(|l| l.contains("Jenkins")),
        || format!("{b}"),
    )
}

async fn the_handoff_note_carries_the_last_sessions_decisions(w: World) -> Result<(), String> {
    w.memory.session_started("s-a", "claude-code", &w.project);
    capture(
        &w.memory,
        &w.project,
        "claude-code",
        "s-a",
        EventKind::PlanSet,
        "plan",
        json!({"text": "- [in_progress] Move auth to EdDSA", "status": "active"}),
    );
    call(
        &w.a,
        "memory_remember",
        json!({"kind": "decision", "key": "auth.alg", "content": "Sign JWTs with EdDSA"}),
    )
    .await;
    w.memory.session_ended("s-a");
    let (_, b) = call(&w.b, "memory_briefing", json!({})).await;
    check(
        b["handoff"]["decisions"].as_array().is_some_and(|d| {
            d.iter()
                .any(|x| x.as_str().is_some_and(|s| s.contains("EdDSA")))
        }),
        || format!("{b}"),
    )
}

async fn memory_why_names_the_session_that_wrote_a_file(w: World) -> Result<(), String> {
    use crate::commands::memory_capture::test_support::Recording;
    let mut rec = Recording::open_turn(&w.project, "s-a", "claude-code", "Move auth to EdDSA");
    rec.write("src/auth.rs", b"pub fn sign() {}\n");
    rec.close_turn();
    drop(rec);
    call(
        &w.a,
        "memory_remember",
        json!({"kind": "decision", "key": "auth.alg", "content": "Sign JWTs with EdDSA"}),
    )
    .await;
    let (_, why) = call(&w.b, "memory_why", json!({"path": "src/auth.rs"})).await;
    check(
        why["sessions"][0]["session"] == "atlas-session:claude-code/s-a"
            && contents(&why, "memories")
                .iter()
                .any(|c| c.contains("EdDSA")),
        || format!("{why}"),
    )
}

type Probe = fn(World) -> BoxFuture<'static, Result<(), String>>;

fn probes() -> Vec<(&'static str, Milestone, Probe)> {
    use Milestone::*;
    vec![
        (
            "decision_from_one_agent_is_briefed_to_the_next",
            Baseline,
            |w| Box::pin(decision_from_one_agent_is_briefed_to_the_next(w)),
        ),
        ("plan_and_files_reach_the_next_agent", Baseline, |w| {
            Box::pin(plan_and_files_reach_the_next_agent(w))
        }),
        (
            "a_reversed_keyed_decision_reads_current_first",
            Baseline,
            |w| Box::pin(a_reversed_keyed_decision_reads_current_first(w)),
        ),
        ("changes_page_through_twelve_decisions", M0, |w| {
            Box::pin(changes_page_through_twelve_decisions(w))
        }),
        ("a_forget_reaches_the_other_agent", M0, |w| {
            Box::pin(a_forget_reaches_the_other_agent(w))
        }),
        ("echoed_readme_note_is_not_briefed", M0, |w| {
            Box::pin(echoed_readme_note_is_not_briefed(w))
        }),
        ("restating_a_captured_note_makes_it_trusted", M0, |w| {
            Box::pin(restating_a_captured_note_makes_it_trusted(w))
        }),
        ("history_shows_the_superseded_decision", M1, |w| {
            Box::pin(history_shows_the_superseded_decision(w))
        }),
        ("a_stale_keyed_write_is_refused", M1, |w| {
            Box::pin(a_stale_keyed_write_is_refused(w))
        }),
        ("search_says_why", M1, |w| Box::pin(search_says_why(w))),
        (
            "a_parallel_session_of_the_same_agent_cannot_clobber",
            M1,
            |w| Box::pin(a_parallel_session_of_the_same_agent_cannot_clobber(w)),
        ),
        ("a_preference_is_briefed_first", M1, |w| {
            Box::pin(a_preference_is_briefed_first(w))
        }),
        ("every_briefed_entry_says_where_it_came_from", M1, |w| {
            Box::pin(every_briefed_entry_says_where_it_came_from(w))
        }),
        ("cited_fact_goes_stale_after_the_file_changes", M3, |w| {
            Box::pin(cited_fact_goes_stale_after_the_file_changes(w))
        }),
        ("feedback_wrong_keeps_it_out_of_the_briefing", M4, |w| {
            Box::pin(feedback_wrong_keeps_it_out_of_the_briefing(w))
        }),
        (
            "the_handoff_note_carries_the_last_sessions_decisions",
            M4,
            |w| Box::pin(the_handoff_note_carries_the_last_sessions_decisions(w)),
        ),
        ("memory_why_names_the_session_that_wrote_a_file", M4, |w| {
            Box::pin(memory_why_names_the_session_that_wrote_a_file(w))
        }),
    ]
}

#[tokio::test(flavor = "multi_thread")]
async fn atlasmembench_passes_every_probe_up_to_the_current_milestone() {
    let mut failed = Vec::new();
    for (name, milestone, probe) in probes() {
        if milestone > CURRENT_MILESTONE {
            continue;
        }
        if let Err(why) = probe(world(name).await).await {
            failed.push(format!("{name}: {why}"));
        }
    }
    assert!(failed.is_empty(), "{failed:#?}");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "prints the AtlasMemBench scorecard; run with --ignored --nocapture"]
async fn atlasmembench_scorecard() {
    let mut passed = 0;
    let all = probes();
    for (name, milestone, probe) in &all {
        let ok = probe(world(name).await).await.is_ok();
        passed += usize::from(ok);
        let tag = format!("{milestone:?}");
        let verdict = if ok { "PASS" } else { "fail" };
        println!("{name:<56} {tag:<9} {verdict}");
    }
    println!(
        "AtlasMemBench: {passed}/{} probes pass (current milestone {CURRENT_MILESTONE:?})",
        all.len()
    );
}

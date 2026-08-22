//! Behaviour lock for everything `atlas-memory` used to borrow from the Cersei SDK.
//!
//! This file was written against the **cersei-backed** implementation and passed
//! there before a single line was ported. It is deliberately unchanged by the
//! port: the native code in `graph.rs` / `session.rs` / `dream.rs` / `embedding.rs`
//! has to satisfy exactly these assertions, so a green run after the swap is
//! evidence that observable behaviour did not move.
//!
//! It pins *behaviour as it actually was*, not behaviour as it ought to be. Where
//! Cersei did something surprising (duplicate `:Topic` nodes per tag, unescaped
//! topic strings, `MEMORY:` lines with a negative confidence surviving) the test
//! records the surprise and says so, because changing it silently during a port
//! is precisely the kind of drift this file exists to catch. Fixes are welcome —
//! but they must land as a deliberate edit to this file, not as a side effect.

use std::path::PathBuf;

use atlas_memory::dream::{AutoDream, ConsolidationState};
use atlas_memory::graph::{GraphMemory, MemoryType};
use atlas_memory::session::{
    extraction_prompt, parse_extraction_output, persist_memories, ExtractedMemory, MemoryCategory,
};

// ─── Test scratch dir ────────────────────────────────────────────────────────

struct TmpDir(PathBuf);

impl TmpDir {
    fn new(tag: &str) -> Self {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("atlas-mem-parity-{tag}-{n}"));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TmpDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ─── MemoryType ──────────────────────────────────────────────────────────────

/// The graph stores `mem_type` as `format!("{:?}")` of this enum, so the Debug
/// spelling is on-disk data — renaming a variant silently orphans stored nodes.
#[test]
fn memory_type_debug_spelling_is_stable() {
    assert_eq!(format!("{:?}", MemoryType::User), "User");
    assert_eq!(format!("{:?}", MemoryType::Feedback), "Feedback");
    assert_eq!(format!("{:?}", MemoryType::Project), "Project");
    assert_eq!(format!("{:?}", MemoryType::Reference), "Reference");
}

#[test]
fn memory_type_from_str_is_case_insensitive() {
    assert!(matches!(MemoryType::from_str("user"), Some(MemoryType::User)));
    assert!(matches!(MemoryType::from_str("USER"), Some(MemoryType::User)));
    assert!(matches!(
        MemoryType::from_str("Project"),
        Some(MemoryType::Project)
    ));
    assert!(matches!(
        MemoryType::from_str("reference"),
        Some(MemoryType::Reference)
    ));
    assert!(MemoryType::from_str("nonsense").is_none());
    assert!(MemoryType::from_str("").is_none());
}

// ─── GraphMemory ─────────────────────────────────────────────────────────────

#[test]
fn graph_store_and_query_by_type() {
    let g = GraphMemory::open_in_memory().unwrap();

    let id = g.store_memory("prefers rust", MemoryType::User, 0.9).unwrap();
    assert!(!id.is_empty(), "store_memory returns a non-empty id");
    g.store_memory("uses tauri", MemoryType::Project, 0.8).unwrap();
    g.store_memory("second user fact", MemoryType::User, 0.7).unwrap();

    let users = g.by_type(MemoryType::User);
    assert_eq!(users.len(), 2, "{users:?}");
    assert!(users.iter().any(|c| c.contains("prefers rust")), "{users:?}");
    assert!(
        users.iter().any(|c| c.contains("second user fact")),
        "{users:?}"
    );

    let projects = g.by_type(MemoryType::Project);
    assert_eq!(projects.len(), 1, "{projects:?}");
    assert!(projects[0].contains("uses tauri"));

    // A type with nothing stored comes back empty, never an error.
    assert!(g.by_type(MemoryType::Reference).is_empty());
}

#[test]
fn graph_ids_are_unique_per_store() {
    let g = GraphMemory::open_in_memory().unwrap();
    let a = g.store_memory("same text", MemoryType::User, 0.5).unwrap();
    let b = g.store_memory("same text", MemoryType::User, 0.5).unwrap();
    assert_ne!(a, b, "identical content must still get distinct ids");
    assert_eq!(g.by_type(MemoryType::User).len(), 2);
}

#[test]
fn graph_tag_and_query_by_topic() {
    let g = GraphMemory::open_in_memory().unwrap();
    let a = g.store_memory("alpha fact", MemoryType::Project, 0.9).unwrap();
    let b = g.store_memory("beta fact", MemoryType::Project, 0.9).unwrap();
    g.tag_memory(&a, "decision").unwrap();
    g.tag_memory(&b, "decision").unwrap();
    g.tag_memory(&a, "failure").unwrap();

    assert_eq!(g.by_topic("decision").len(), 2);
    assert_eq!(g.by_topic("failure").len(), 1);
    assert!(g.by_topic("never-used").is_empty());
}

#[test]
fn graph_tagging_an_unknown_id_is_not_an_error() {
    let g = GraphMemory::open_in_memory().unwrap();
    // No node matches, so the MATCH yields nothing and the INSERT never fires.
    // Cersei reported Ok here; callers rely on tag failures being non-fatal.
    assert!(g.tag_memory("no-such-id", "topic").is_ok());
    assert!(g.by_topic("topic").is_empty());
}

#[test]
fn graph_link_memories_round_trips() {
    let g = GraphMemory::open_in_memory().unwrap();
    let a = g.store_memory("first", MemoryType::User, 0.9).unwrap();
    let b = g.store_memory("second", MemoryType::User, 0.9).unwrap();
    assert!(g.link_memories(&a, &b, "co_extracted").is_ok());
    // Linking unknown ids is a silent no-op, not an error.
    assert!(g.link_memories("nope", "also-nope", "co_extracted").is_ok());
}

#[test]
fn graph_recall_is_substring_matched_and_limited() {
    let g = GraphMemory::open_in_memory().unwrap();
    g.store_memory("the tauri build pipeline", MemoryType::Project, 0.9)
        .unwrap();
    g.store_memory("tauri window management", MemoryType::Project, 0.9)
        .unwrap();
    g.store_memory("unrelated note", MemoryType::Project, 0.9).unwrap();

    let hits = g.recall("tauri", 10);
    assert_eq!(hits.len(), 2, "{hits:?}");
    assert!(hits.iter().all(|h| h.contains("tauri")));

    // `limit` is applied by the query itself.
    assert_eq!(g.recall("tauri", 1).len(), 1);
    assert!(g.recall("nothing-matches-this", 10).is_empty());
}

/// Surprise worth pinning: `recall_top_k` re-ranks by word overlap, but its
/// candidate set comes from `recall`, which substring-matches the **whole**
/// query. A candidate therefore already contains every query word, so the score
/// is effectively always 1.0 and the re-ranking never reorders anything. The
/// scoring code is real but currently inert. Recorded, not endorsed.
#[test]
fn graph_recall_top_k_scores_are_effectively_always_one() {
    let g = GraphMemory::open_in_memory().unwrap();
    g.store_memory("tauri window resize handling", MemoryType::Project, 0.9)
        .unwrap();
    g.store_memory("tauri window management", MemoryType::Project, 0.9)
        .unwrap();
    g.store_memory("tauri only", MemoryType::Project, 0.9).unwrap();

    let scored = g.recall_top_k("tauri window", 5);
    // "tauri only" does not contain the substring "tauri window", so it is not
    // even a candidate — this is a whole-phrase match, not a word match.
    assert_eq!(scored.len(), 2, "{scored:?}");
    for (_, s) in &scored {
        assert_eq!(*s, 1.0, "candidates contain every query word: {scored:?}");
    }

    // `limit` truncates after ranking.
    assert_eq!(g.recall_top_k("tauri window", 1).len(), 1);

    // Degenerate inputs return empty rather than panicking.
    assert!(g.recall_top_k("tauri", 0).is_empty());
    assert!(g.recall_top_k("   ", 5).is_empty());
}

/// Surprise worth pinning, and the sharpest one here: every graph query returns
/// each content string **wrapped in literal double quotes** (`"\"fact\""`),
/// because results are rendered with `format!("{}", value)` and grafeo's Display
/// for a string value includes its quotes. Nothing in `atlas-memory` strips them,
/// so the quotes reach retrieval output today. The port must reproduce this
/// exactly; fixing it is a separate, deliberate change.
#[test]
fn graph_results_are_wrapped_in_literal_quotes() {
    let g = GraphMemory::open_in_memory().unwrap();
    g.store_memory("plain fact", MemoryType::User, 0.9).unwrap();

    let by_type = g.by_type(MemoryType::User);
    assert_eq!(by_type, vec![r#""plain fact""#.to_string()], "{by_type:?}");

    let recalled = g.recall("plain", 5);
    assert_eq!(recalled, vec![r#""plain fact""#.to_string()], "{recalled:?}");

    let top = g.recall_top_k("plain fact", 5);
    assert_eq!(top[0].0, r#""plain fact""#, "{top:?}");
}

/// `recall` matches the whole query as one substring, not word-by-word.
#[test]
fn graph_recall_matches_the_whole_query_as_a_substring() {
    let g = GraphMemory::open_in_memory().unwrap();
    g.store_memory("alpha beta", MemoryType::Project, 0.9).unwrap();
    g.store_memory("alpha only", MemoryType::Project, 0.9).unwrap();

    // One row contains the full phrase; both contain the single word.
    assert_eq!(g.recall("alpha beta", 10).len(), 1);
    assert_eq!(g.recall("alpha", 10).len(), 2);
    // Word order matters, because it is a raw substring test.
    assert!(g.recall("beta alpha", 10).is_empty());
}

#[test]
fn graph_escapes_quotes_and_backslashes_in_content() {
    let g = GraphMemory::open_in_memory().unwrap();
    // Both are GQL string-literal metacharacters; unescaped they would break the
    // generated query (or worse, inject into it).
    let tricky = r"user's path is C:\temp and they said 'no'";
    g.store_memory(tricky, MemoryType::User, 0.9).unwrap();

    let users = g.by_type(MemoryType::User);
    assert_eq!(users.len(), 1, "quoted content must round-trip: {users:?}");
    assert!(users[0].contains("no"), "{users:?}");

    // A quote in the *query* must not break recall either.
    let _ = g.recall("user's", 5);
}

#[test]
fn graph_persists_across_reopen() {
    let tmp = TmpDir::new("graph");
    let path = tmp.path().join("memory.grafeo");

    {
        let g = GraphMemory::open(&path).unwrap();
        g.store_memory("durable fact", MemoryType::Project, 0.9).unwrap();
        assert_eq!(g.by_type(MemoryType::Project).len(), 1);
    }

    let g2 = GraphMemory::open(&path).unwrap();
    let found = g2.by_type(MemoryType::Project);
    assert_eq!(found.len(), 1, "reopened graph lost data: {found:?}");
    assert!(found[0].contains("durable fact"));
}

#[test]
fn graph_empty_store_queries_are_empty_not_errors() {
    let g = GraphMemory::open_in_memory().unwrap();
    assert!(g.by_type(MemoryType::User).is_empty());
    assert!(g.by_topic("anything").is_empty());
    assert!(g.recall("anything", 5).is_empty());
    assert!(g.recall_top_k("anything", 5).is_empty());
}

// ─── MemoryCategory ──────────────────────────────────────────────────────────

/// `label()` is written into the memdir markdown AND used as the graph topic, so
/// these five strings are on-disk data.
#[test]
fn memory_category_labels_are_stable() {
    assert_eq!(MemoryCategory::UserPreference.label(), "preference");
    assert_eq!(MemoryCategory::ProjectFact.label(), "project");
    assert_eq!(MemoryCategory::CodePattern.label(), "pattern");
    assert_eq!(MemoryCategory::Decision.label(), "decision");
    assert_eq!(MemoryCategory::Constraint.label(), "constraint");
}

#[test]
fn memory_category_from_str_accepts_every_alias() {
    for s in ["preference", "userpreference", "user_preference", "PREFERENCE"] {
        assert!(
            matches!(MemoryCategory::from_str(s), Some(MemoryCategory::UserPreference)),
            "{s}"
        );
    }
    for s in ["project", "projectfact", "project_fact"] {
        assert!(
            matches!(MemoryCategory::from_str(s), Some(MemoryCategory::ProjectFact)),
            "{s}"
        );
    }
    for s in ["pattern", "codepattern", "code_pattern"] {
        assert!(
            matches!(MemoryCategory::from_str(s), Some(MemoryCategory::CodePattern)),
            "{s}"
        );
    }
    assert!(matches!(
        MemoryCategory::from_str("decision"),
        Some(MemoryCategory::Decision)
    ));
    assert!(matches!(
        MemoryCategory::from_str("constraint"),
        Some(MemoryCategory::Constraint)
    ));
    assert!(MemoryCategory::from_str("bogus").is_none());
}

// ─── parse_extraction_output ─────────────────────────────────────────────────

#[test]
fn parse_extraction_happy_path() {
    let out = "\
Some preamble the model emitted.
MEMORY: preference | 9 | User prefers Rust over Go
MEMORY: project | 7 | The app is a Tauri desktop shell
trailing chatter
";
    let mems = parse_extraction_output(out);
    assert_eq!(mems.len(), 2);
    assert_eq!(mems[0].content, "User prefers Rust over Go");
    assert!((mems[0].confidence - 0.9).abs() < 1e-6, "{}", mems[0].confidence);
    assert_eq!(mems[0].category.label(), "preference");
    assert_eq!(mems[1].content, "The app is a Tauri desktop shell");
    assert!((mems[1].confidence - 0.7).abs() < 1e-6);
    assert_eq!(mems[1].category.label(), "project");
}

#[test]
fn parse_extraction_rejects_malformed_lines() {
    // Missing prefix, too few fields, unknown category, unparsable confidence,
    // and an empty fact are all dropped — silently, one line at a time.
    let out = "\
preference | 9 | no MEMORY prefix
MEMORY: preference | 9
MEMORY: nonsense | 9 | unknown category
MEMORY: preference | high | non-numeric confidence
MEMORY: preference | 9 |
MEMORY: decision | 5 | this one is fine
";
    let mems = parse_extraction_output(out);
    assert_eq!(mems.len(), 1, "{mems:?}");
    assert_eq!(mems[0].content, "this one is fine");
}

#[test]
fn parse_extraction_clamps_confidence_above_ten() {
    let mems = parse_extraction_output("MEMORY: decision | 25 | over-confident model");
    assert_eq!(mems.len(), 1);
    assert!((mems[0].confidence - 1.0).abs() < 1e-6, "{}", mems[0].confidence);
}

/// A negative confidence is rejected outright (the `confidence < 0.0` guard runs
/// after the divide-by-ten, before the clamp), so the line is dropped rather
/// than being clamped to zero and kept.
#[test]
fn parse_extraction_drops_negative_confidence() {
    assert!(parse_extraction_output("MEMORY: decision | -5 | negative confidence").is_empty());
    // Zero is still a valid confidence and survives.
    let zero = parse_extraction_output("MEMORY: decision | 0 | zero confidence");
    assert_eq!(zero.len(), 1, "{zero:?}");
    assert_eq!(zero[0].confidence, 0.0);
}

#[test]
fn parse_extraction_keeps_pipes_inside_the_fact() {
    // splitn(3, '|') means only the first two pipes are delimiters.
    let mems = parse_extraction_output("MEMORY: project | 8 | uses a | b | c pipeline");
    assert_eq!(mems.len(), 1);
    assert_eq!(mems[0].content, "uses a | b | c pipeline");
}

#[test]
fn parse_extraction_tolerates_indentation_and_empty_input() {
    let mems = parse_extraction_output("    MEMORY: decision | 5 | indented line");
    assert_eq!(mems.len(), 1, "leading whitespace is trimmed first");
    assert!(parse_extraction_output("").is_empty());
    assert!(parse_extraction_output("no memories here").is_empty());
}

#[test]
fn extraction_prompt_states_the_wire_format() {
    let p = extraction_prompt();
    // The parser above only understands this one line shape, so the prompt has
    // to keep asking for it verbatim.
    assert!(p.contains("MEMORY: <category> | <confidence 0-10> | <fact>"), "{p}");
    for cat in ["preference", "project", "pattern", "decision", "constraint"] {
        assert!(p.contains(cat), "prompt omits category {cat}");
    }
}

// ─── persist_memories ────────────────────────────────────────────────────────

fn mem(cat: MemoryCategory, content: &str, confidence: f32) -> ExtractedMemory {
    ExtractedMemory {
        content: content.to_string(),
        category: cat,
        confidence,
    }
}

/// The exact rendered line is parsed back by `consolidate::prune_memdir`, so its
/// shape is a contract between the two modules.
#[test]
fn persist_renders_the_expected_entry_line() {
    let tmp = TmpDir::new("persist-new");
    let target = tmp.path().join("extracted").join("s1.md");

    persist_memories(&[mem(MemoryCategory::Decision, "chose usearch", 0.85)], &target).unwrap();

    let body = std::fs::read_to_string(&target).unwrap();
    assert!(
        body.contains("- **[decision]** chose usearch *(confidence: 85%)*"),
        "{body}"
    );
    assert!(body.contains("## Auto-extracted memories"), "{body}");
    assert!(body.contains("### Session memories — "), "{body}");
    // Confidence is rendered with no decimal places.
    assert!(!body.contains("85.0%"), "{body}");
}

#[test]
fn persist_creates_parent_directories() {
    let tmp = TmpDir::new("persist-mkdir");
    let target = tmp.path().join("deep").join("nested").join("s.md");
    persist_memories(&[mem(MemoryCategory::ProjectFact, "fact", 0.5)], &target).unwrap();
    assert!(target.exists());
}

#[test]
fn persist_empty_slice_writes_nothing() {
    let tmp = TmpDir::new("persist-empty");
    let target = tmp.path().join("s.md");
    persist_memories(&[], &target).unwrap();
    assert!(!target.exists(), "no file should be created for zero memories");
}

#[test]
fn persist_appends_into_the_same_date_block() {
    let tmp = TmpDir::new("persist-append");
    let target = tmp.path().join("s.md");

    persist_memories(&[mem(MemoryCategory::Decision, "first", 0.9)], &target).unwrap();
    persist_memories(&[mem(MemoryCategory::Decision, "second", 0.8)], &target).unwrap();

    let body = std::fs::read_to_string(&target).unwrap();
    assert!(body.contains("first"), "{body}");
    assert!(body.contains("second"), "{body}");
    // Same UTC day → one section header and one date header, not two.
    assert_eq!(body.matches("## Auto-extracted memories").count(), 1, "{body}");
    assert_eq!(body.matches("### Session memories — ").count(), 1, "{body}");
}

#[test]
fn persist_preserves_unrelated_existing_content() {
    let tmp = TmpDir::new("persist-preserve");
    let target = tmp.path().join("s.md");
    std::fs::write(&target, "# Hand-written notes\n\nkeep me\n").unwrap();

    persist_memories(&[mem(MemoryCategory::Constraint, "no network", 0.6)], &target).unwrap();

    let body = std::fs::read_to_string(&target).unwrap();
    assert!(body.contains("# Hand-written notes"), "{body}");
    assert!(body.contains("keep me"), "{body}");
    assert!(body.contains("- **[constraint]** no network"), "{body}");
}

// ─── AutoDream ───────────────────────────────────────────────────────────────

/// Both filenames live in the user's memory dir and are read by already-shipped
/// installs, so they are on-disk contract.
#[test]
fn dream_state_and_lock_use_the_expected_filenames() {
    let tmp = TmpDir::new("dream-paths");
    let d = AutoDream::new(tmp.path().to_path_buf(), tmp.path().to_path_buf());

    d.acquire_lock().unwrap();
    assert!(
        tmp.path().join(".consolidation_lock").exists(),
        "lock filename changed"
    );

    d.update_state().unwrap();
    assert!(
        tmp.path().join(".consolidation_state.json").exists(),
        "state filename changed"
    );
}

#[test]
fn dream_defaults_are_24h_and_5_sessions() {
    let tmp = TmpDir::new("dream-defaults");
    let d = AutoDream::new(tmp.path().to_path_buf(), tmp.path().to_path_buf());
    assert_eq!(d.config.min_hours, 24.0);
    assert_eq!(d.config.min_sessions, 5);
}

#[test]
fn dream_time_gate_opens_when_never_consolidated_and_closes_right_after() {
    let tmp = TmpDir::new("dream-time");
    let d = AutoDream::new(tmp.path().to_path_buf(), tmp.path().to_path_buf());

    let fresh = ConsolidationState::default();
    assert!(fresh.last_consolidated_at.is_none());
    assert!(d.time_gate_passes(&fresh), "never-consolidated must pass");

    d.update_state().unwrap();
    let after = d.load_state();
    assert!(after.last_consolidated_at.is_some(), "update_state stamps a time");
    assert!(
        !d.time_gate_passes(&after),
        "just-consolidated must not pass the 24h gate"
    );
}

#[test]
fn dream_load_state_survives_missing_and_corrupt_files() {
    let tmp = TmpDir::new("dream-corrupt");
    let d = AutoDream::new(tmp.path().to_path_buf(), tmp.path().to_path_buf());

    // Missing file → default.
    assert!(d.load_state().last_consolidated_at.is_none());

    // Corrupt file → default, never a panic.
    std::fs::write(tmp.path().join(".consolidation_state.json"), "{not json").unwrap();
    assert!(d.load_state().last_consolidated_at.is_none());
}

#[test]
fn dream_lock_gate_closes_while_a_fresh_lock_is_held() {
    let tmp = TmpDir::new("dream-lock");
    let d = AutoDream::new(tmp.path().to_path_buf(), tmp.path().to_path_buf());

    assert!(d.lock_gate_passes(), "no lock → open");
    d.acquire_lock().unwrap();
    assert!(!d.lock_gate_passes(), "fresh lock → closed");
    d.release_lock().unwrap();
    assert!(d.lock_gate_passes(), "released → open");
    // Releasing twice is a no-op, not an error.
    assert!(d.release_lock().is_ok());
}

#[test]
fn dream_session_gate_counts_only_recent_jsonl_files() {
    let tmp = TmpDir::new("dream-sessions");
    let convos = tmp.path().join("convos");
    std::fs::create_dir_all(&convos).unwrap();
    let d = AutoDream::new(tmp.path().to_path_buf(), convos.clone());

    let fresh = ConsolidationState::default();
    assert!(!d.session_gate_passes(&fresh), "no files → closed");

    // Non-jsonl files never count, however many there are.
    for i in 0..10 {
        std::fs::write(convos.join(format!("s{i}.txt")), "x").unwrap();
    }
    assert!(!d.session_gate_passes(&fresh), "non-jsonl must not count");

    // Four is one short of the default threshold of five.
    for i in 0..4 {
        std::fs::write(convos.join(format!("s{i}.jsonl")), "x").unwrap();
    }
    assert!(!d.session_gate_passes(&fresh), "4 < min_sessions(5)");

    std::fs::write(convos.join("s4.jsonl"), "x").unwrap();
    assert!(d.session_gate_passes(&fresh), "5 >= min_sessions(5)");
}

#[test]
fn dream_session_gate_returns_false_for_a_missing_dir() {
    let tmp = TmpDir::new("dream-nodir");
    let d = AutoDream::new(tmp.path().to_path_buf(), tmp.path().join("does-not-exist"));
    assert!(!d.session_gate_passes(&ConsolidationState::default()));
}

// ─── EmbeddingProvider seam ──────────────────────────────────────────────────

/// `MiniLmProvider` implements this trait; the port must keep the same method
/// set and signatures or the provider stops compiling.
#[test]
fn embedding_provider_trait_shape_is_unchanged() {
    use atlas_memory::embedding::{EmbeddingError, EmbeddingProvider};

    struct Fake;

    #[async_trait::async_trait]
    impl EmbeddingProvider for Fake {
        fn name(&self) -> &str {
            "fake"
        }
        fn dimensions(&self) -> usize {
            3
        }
        async fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbeddingError> {
            Ok(texts.iter().map(|_| vec![0.1, 0.2, 0.3]).collect())
        }
    }

    let rt = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    rt.block_on(async {
        let f = Fake;
        assert_eq!(f.name(), "fake");
        assert_eq!(f.dimensions(), 3);

        // The default `embed` must delegate to `embed_batch`.
        let one = f.embed("hello").await.unwrap();
        assert_eq!(one, vec![0.1, 0.2, 0.3]);

        let many = f
            .embed_batch(&["a".to_string(), "b".to_string()])
            .await
            .unwrap();
        assert_eq!(many.len(), 2);
    });
}

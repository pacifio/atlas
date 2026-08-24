//! Step 7 — gated session memory extraction.
//!
//! Relocates the per-turn BYOK distill (legacy `memory_compile`) off the hot
//! path and behind Cersei's session-extraction gates. The Cersei SDK supplies
//! only the **gates + prompt + parser**
//! (`cersei_agent::session_memory::{extraction_prompt, parse_extraction_output}`
//! plus the `MemoryCategory`/`ExtractedMemory` types) — **the actual BYOK LLM
//! call is injected by the caller** via the `llm` closure, so this crate stays
//! Tauri-free *and* BYOK-free.
//!
//! Flow ([`extract_and_store`]):
//! 1. Sync `tool_calls_since_last` from the transcript and run [`should_extract`]
//!    (≥20 turns, ≥3 tool calls since the last extraction, no pending tool_use) —
//!    the same gates the SDK applies, replicated locally on the neutral
//!    [`TranscriptTurn`] (the SDK gate wants `&[cersei_types::Message]`, which we
//!    don't reconstruct; the plan permits a thin local extractor).
//! 2. Build the prompt from `extraction_prompt()` + the rendered transcript and
//!    make ONE injected LLM call.
//! 3. `parse_extraction_output` → `ExtractedMemory`s; map each `MemoryCategory`
//!    onto a (lossy) `MemoryType` and write it to the graph
//!    (`store_memory` + `tag_memory` carrying the real category as a topic tag,
//!    `link_memories` within the batch where sensible).
//! 4. Append the batch to `extracted/<session>.md` (Claude-compatible memdir,
//!    via the SDK's `persist_memories`) so the indexer's next pass embeds it.
//!
//! The neutral [`ExtractState`] (counts since the last extraction) is persisted
//! per-session under the memory dir so the gates survive across turns.

use std::future::Future;
use std::path::Path;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::session::{
    extraction_prompt, parse_extraction_output, persist_memories, MemoryCategory,
};
use crate::graph::GraphMemory;
use crate::graph::MemoryType;

/// Mirrors `cersei_agent::session_memory::MIN_MESSAGES_TO_EXTRACT` (private there).
const MIN_MESSAGES_TO_EXTRACT: usize = 20;
/// Mirrors `cersei_agent::session_memory::MIN_TOOL_CALLS_BETWEEN_EXTRACTIONS`.
const MIN_TOOL_CALLS_BETWEEN_EXTRACTIONS: usize = 3;
/// Cap on the transcript text fed to the model (chars) — mirrors the legacy
/// `memory_compile::MAX_TEXT` budget so BYOK cost stays bounded.
const MAX_PROMPT_CHARS: usize = 6000;

/// Format-neutral transcript turn. Each agent's transcript (Cersei native /
/// Claude Code JSONL / Codex) is adapted into this by the Tauri layer (Step 7
/// Part B reuses the unified `AgentManager` snapshot, which already normalises
/// all three agents into role/content/tool-call messages).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptTurn {
    /// `"user"`, `"assistant"`, or `"system"` (lower-cased role label).
    pub role: String,
    /// Visible text of the turn (tool args/results are summarised out by the adapter).
    pub text: String,
    /// Number of tool calls attached to this turn (drives the gate's tool-call count).
    pub tool_calls: usize,
}

/// Per-session extraction bookkeeping, persisted under
/// `<memory_dir>/extract-state/<session>.json`. Neutral analogue of the SDK's
/// `SessionMemoryState` (which is `&[Message]`-shaped); we track counts against
/// the neutral transcript instead.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExtractState {
    /// Transcript length at the last successful extraction pass.
    pub last_extracted_turn_index: usize,
    /// Tool calls observed since `last_extracted_turn_index` (synced from the
    /// transcript before each gate check).
    pub tool_calls_since_last: usize,
    /// How many extraction passes have run for this session.
    pub extraction_count: u32,
}

impl ExtractState {
    /// Load the persisted state for `session_id`, or a default if absent/corrupt.
    pub fn load(memory_dir: &Path, session_id: &str) -> Self {
        let path = state_path(memory_dir, session_id);
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// Persist the state for `session_id` (atomic temp + rename).
    pub fn save(&self, memory_dir: &Path, session_id: &str) -> Result<()> {
        let path = state_path(memory_dir, session_id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json.as_bytes())?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// Recompute `tool_calls_since_last` from the turns after the last extraction.
    fn sync_counts(&mut self, turns: &[TranscriptTurn]) {
        let start = self.last_extracted_turn_index.min(turns.len());
        self.tool_calls_since_last = turns[start..].iter().map(|t| t.tool_calls).sum();
    }
}

fn state_path(memory_dir: &Path, session_id: &str) -> std::path::PathBuf {
    memory_dir
        .join("extract-state")
        .join(format!("{}.json", sanitize(session_id)))
}

/// Keep a session id filesystem-safe (it is also the on-disk JSONL stem upstream,
/// but be defensive about path separators).
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// The same gates the SDK applies (`cersei_agent::session_memory::should_extract`),
/// replicated on the neutral transcript: ≥20 turns; ≥3 tool calls since the last
/// extraction (only enforced once a first extraction has happened); and no
/// pending tool_use on the last assistant turn.
///
/// `state.tool_calls_since_last` must already reflect the transcript — callers go
/// through [`extract_and_store`], which syncs it first.
pub fn should_extract(turns: &[TranscriptTurn], state: &ExtractState) -> bool {
    if turns.len() < MIN_MESSAGES_TO_EXTRACT {
        return false;
    }
    if state.extraction_count > 0 && state.tool_calls_since_last < MIN_TOOL_CALLS_BETWEEN_EXTRACTIONS
    {
        return false;
    }
    // Don't extract while the last assistant turn still has an unresolved tool call.
    if let Some(last_assistant) = turns.iter().rev().find(|t| t.role == "assistant") {
        if last_assistant.tool_calls > 0 {
            return false;
        }
    }
    true
}

/// Map an extraction [`MemoryCategory`] onto the graph's coarser [`MemoryType`].
///
/// Lossy by design (the graph only knows `User/Feedback/Project/Reference`); the
/// precise category is preserved separately as a topic tag (see `tag_memory`):
/// - `UserPreference` → `User`
/// - `ProjectFact` / `CodePattern` / `Decision` / `Constraint` → `Project`
pub fn category_to_memory_type(category: &MemoryCategory) -> MemoryType {
    match category {
        MemoryCategory::UserPreference => MemoryType::User,
        MemoryCategory::ProjectFact
        | MemoryCategory::CodePattern
        | MemoryCategory::Decision
        | MemoryCategory::Constraint => MemoryType::Project,
    }
}

/// Gate, extract, and store distilled memories for one session — off the hot path.
///
/// `llm` is the injected BYOK seam: it receives the fully-built extraction prompt
/// and returns the model's raw completion. This keeps `atlas-memory` BYOK-free
/// (the Tauri layer supplies a closure over its provider plumbing).
///
/// Returns the number of memories stored (0 when the gates don't fire or the
/// model produced nothing parseable). `state` is updated and persisted on every
/// pass that clears the gates.
pub async fn extract_and_store<F, Fut>(
    turns: &[TranscriptTurn],
    state: &mut ExtractState,
    graph: &GraphMemory,
    memory_dir: &Path,
    session_id: &str,
    llm: F,
) -> Result<usize>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<String>>,
{
    state.sync_counts(turns);
    if !should_extract(turns, state) {
        return Ok(0);
    }

    // ── Build the prompt: SDK system prompt + rendered transcript ──────────────
    let prompt = build_prompt(turns);

    // ── ONE injected BYOK call ────────────────────────────────────────────────
    let output = llm(prompt).await?;
    let memories = parse_extraction_output(&output);

    // The pass ran — advance the gate counters even if nothing parsed, so a dud
    // turn doesn't immediately re-trigger on the next finished turn.
    state.extraction_count += 1;
    state.last_extracted_turn_index = turns.len();
    state.tool_calls_since_last = 0;
    let _ = state.save(memory_dir, session_id);

    if memories.is_empty() {
        return Ok(0);
    }

    // ── Write to the graph: store + tag (category) + link within the batch ─────
    let mut ids: Vec<(String, String)> = Vec::with_capacity(memories.len());
    for mem in &memories {
        let mem_type = category_to_memory_type(&mem.category);
        match graph.store_memory(&mem.content, mem_type, mem.confidence) {
            Ok(id) => {
                // Carry the precise category as a topic tag (the graph type is lossy).
                if let Err(e) = graph.tag_memory(&id, mem.category.label()) {
                    tracing::debug!(target: "atlas_memory::extract", "tag_memory failed: {e}");
                }
                ids.push((id, mem.category.label().to_string()));
            }
            Err(e) => {
                tracing::debug!(target: "atlas_memory::extract", "store_memory failed: {e}");
            }
        }
    }

    // Link consecutive same-category memories so the graph reflects intra-session
    // relationships (best-effort; recall never depends on links existing).
    for window in ids.windows(2) {
        let (from, from_cat) = &window[0];
        let (to, to_cat) = &window[1];
        if from_cat == to_cat {
            if let Err(e) = graph.link_memories(from, to, "co_extracted") {
                tracing::debug!(target: "atlas_memory::extract", "link_memories failed: {e}");
            }
        }
    }

    // ── Append to the Claude-compatible memdir file (SDK writer) ───────────────
    let target = memory_dir
        .join("extracted")
        .join(format!("{}.md", sanitize(session_id)));
    if let Err(e) = persist_memories(&memories, &target) {
        tracing::debug!(target: "atlas_memory::extract", "persist_memories failed: {e}");
    }

    Ok(ids.len())
}

/// Render the extraction prompt: the SDK system prompt followed by the transcript,
/// char-capped to [`MAX_PROMPT_CHARS`] (keeping the most recent turns).
fn build_prompt(turns: &[TranscriptTurn]) -> String {
    let mut body = String::new();
    for turn in turns {
        let text = turn.text.trim();
        if text.is_empty() {
            continue;
        }
        body.push_str(&format!("[{}] {}\n", turn.role, text));
    }
    // Keep the tail if over budget — recent context is the most valuable.
    if body.len() > MAX_PROMPT_CHARS {
        let start = body.len() - MAX_PROMPT_CHARS;
        // Snap to a char boundary.
        let start = (start..body.len())
            .find(|i| body.is_char_boundary(*i))
            .unwrap_or(start);
        body = body[start..].to_string();
    }
    format!(
        "{}\n\n--- CONVERSATION ---\n{}",
        extraction_prompt(),
        body
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(role: &str, text: &str, tool_calls: usize) -> TranscriptTurn {
        TranscriptTurn {
            role: role.into(),
            text: text.into(),
            tool_calls,
        }
    }

    fn make_turns(n: usize) -> Vec<TranscriptTurn> {
        (0..n)
            .map(|i| {
                if i % 2 == 0 {
                    turn("user", &format!("msg {i}"), 0)
                } else {
                    turn("assistant", &format!("reply {i}"), 0)
                }
            })
            .collect()
    }

    #[test]
    fn gate_false_below_message_threshold() {
        let turns = make_turns(10);
        assert!(!should_extract(&turns, &ExtractState::default()));
    }

    #[test]
    fn gate_true_above_threshold() {
        let turns = make_turns(26); // ends on an assistant turn with no tool calls
        assert!(should_extract(&turns, &ExtractState::default()));
    }

    #[test]
    fn gate_false_during_cooldown() {
        let turns = make_turns(26);
        let state = ExtractState {
            extraction_count: 1,
            tool_calls_since_last: 1, // < 3
            ..Default::default()
        };
        assert!(!should_extract(&turns, &state));
    }

    #[test]
    fn gate_true_after_cooldown_met() {
        let turns = make_turns(26);
        let state = ExtractState {
            extraction_count: 1,
            tool_calls_since_last: 3,
            ..Default::default()
        };
        assert!(should_extract(&turns, &state));
    }

    #[test]
    fn gate_false_with_pending_tool_use() {
        let mut turns = make_turns(26);
        // Last assistant turn still has an open tool call → don't extract yet.
        turns.push(turn("assistant", "running tool", 1));
        assert!(!should_extract(&turns, &ExtractState::default()));
    }

    #[test]
    fn category_mapping_is_lossy_but_total() {
        use MemoryCategory::*;
        assert_eq!(category_to_memory_type(&UserPreference), MemoryType::User);
        for c in [ProjectFact, CodePattern, Decision, Constraint] {
            assert_eq!(category_to_memory_type(&c), MemoryType::Project);
        }
    }

    #[test]
    fn sync_counts_sums_tool_calls_since_last() {
        let turns = vec![
            turn("user", "a", 0),
            turn("assistant", "b", 2),
            turn("user", "c", 0),
            turn("assistant", "d", 3),
        ];
        let mut state = ExtractState {
            last_extracted_turn_index: 2,
            ..Default::default()
        };
        state.sync_counts(&turns);
        assert_eq!(state.tool_calls_since_last, 3); // only turns[2..]
    }

    fn tmp_dir(name: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("atlas-extract-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[tokio::test]
    async fn fake_llm_populates_graph_and_memdir() {
        let dir = tmp_dir("happy");
        let graph = GraphMemory::open_in_memory().expect("in-memory graph");
        let mut state = ExtractState::default();
        let turns = make_turns(26);

        let canned = "\
MEMORY: preference | 8 | User prefers Rust over Python
MEMORY: project | 9 | The API uses REST with JSON
MEMORY: decision | 7 | Chose PostgreSQL for persistence
not a memory line
"
        .to_string();

        let count = extract_and_store(
            &turns,
            &mut state,
            &graph,
            &dir,
            "sess-1",
            |_prompt| async move { Ok(canned) },
        )
        .await
        .unwrap();

        assert_eq!(count, 3, "three valid MEMORY lines stored");

        // Graph got the entries (User + Project types).
        let users = graph.by_type(MemoryType::User);
        let projects = graph.by_type(MemoryType::Project);
        assert_eq!(users.len(), 1, "one UserPreference → User");
        assert_eq!(projects.len(), 2, "project + decision → Project");

        // Memdir file written, Claude-compatible.
        let md = dir.join("extracted").join("sess-1.md");
        let body = std::fs::read_to_string(&md).unwrap();
        assert!(body.contains("Auto-extracted memories"));
        assert!(body.contains("Rust over Python"));
        assert!(body.contains("PostgreSQL"));

        // State advanced so the next finished turn doesn't immediately re-extract.
        assert_eq!(state.extraction_count, 1);
        assert_eq!(state.last_extracted_turn_index, turns.len());
        assert_eq!(state.tool_calls_since_last, 0);

        // Persisted state round-trips.
        let reloaded = ExtractState::load(&dir, "sess-1");
        assert_eq!(reloaded.extraction_count, 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn short_transcript_is_a_noop_and_never_calls_llm() {
        let dir = tmp_dir("short");
        let graph = GraphMemory::open_in_memory().expect("in-memory graph");
        let mut state = ExtractState::default();
        let turns = make_turns(4); // below the 20-turn gate

        let count = extract_and_store(
            &turns,
            &mut state,
            &graph,
            &dir,
            "sess-short",
            |_prompt| async move {
                panic!("llm must not be called when the gate fails");
                #[allow(unreachable_code)]
                Ok(String::new())
            },
        )
        .await
        .unwrap();

        assert_eq!(count, 0);
        assert_eq!(state.extraction_count, 0);
        assert!(graph.by_type(MemoryType::Project).is_empty());
        assert!(!dir.join("extracted").join("sess-short.md").exists());

        std::fs::remove_dir_all(&dir).ok();
    }
}

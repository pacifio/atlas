//! Memory-RAG grounding for the native agent.
//!
//! Atlas indexes the project's memory (Claude/Codex memory, codebase index,
//! shared memory) into an on-device embedding store. This module exposes that
//! retrieval to the agent as a `search_memory` tool so it can ground answers in
//! prior decisions / conventions instead of guessing or asking.
//!
//! The retrieval itself lives in the Tauri layer (it needs the embedding model
//! + app state), so it's injected via a registered async callback — mirroring
//! the delegate `ProviderFactory` seam — keeping `atlas-cersei` a low crate.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::OnceLock;

use async_trait::async_trait;
use cersei::tools::{PermissionLevel, Tool, ToolContext, ToolResult};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// One retrieved memory snippet handed back to the agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemDoc {
    pub title: String,
    pub source: String,
    pub text: String,
}

/// `(cwd, query, limit) -> ranked docs`. Async because retrieval embeds the
/// query + does a kNN search.
pub type MemorySearchFn =
    Arc<dyn Fn(String, String, usize) -> Pin<Box<dyn Future<Output = Vec<MemDoc>> + Send>> + Send + Sync>;

static MEMORY_SEARCH: OnceLock<MemorySearchFn> = OnceLock::new();

/// Register the retrieval backend. Called once by the Tauri layer at startup;
/// until then the `search_memory` tool reports itself unavailable.
pub fn register_memory_search(f: MemorySearchFn) {
    let _ = MEMORY_SEARCH.set(f);
}

/// Whether a retrieval backend has been registered (gates adding the tool).
pub fn memory_search_available() -> bool {
    MEMORY_SEARCH.get().is_some()
}

/// `(cwd, agent_uuid, session)` — schedule a memory flush for a session whose
/// conversation is about to be compacted (contract C1). The payload is
/// identity only — `agent_uuid` is the manager's agent UUID, not a plugin
/// id — because the Tauri layer keeps its own uncompacted transcript
/// snapshot: the flush re-reads from there rather than carrying the SDK's
/// message vector across the crate boundary.
pub type MemoryFlushFn = Arc<
    dyn Fn(String, String, String) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync,
>;

static MEMORY_FLUSH: OnceLock<MemoryFlushFn> = OnceLock::new();

/// Register the pre-compaction flush backend. Called once by the Tauri layer
/// at startup, beside [`register_memory_search`]; until then compaction runs
/// without a flush (the degradation ladder's floor is today's behavior).
pub fn register_memory_flush(f: MemoryFlushFn) {
    let _ = MEMORY_FLUSH.set(f);
}

/// Run the registered flush, if any. Awaited by the agent's pre-compact hook,
/// which guarantees the flush is *scheduled* before summarization runs; the
/// registered backend may complete asynchronously, because it reads the Tauri
/// layer's transcript snapshot — which compaction never touches — not the
/// SDK's message vector.
pub async fn memory_flush(cwd: String, agent: String, session: String) {
    if let Some(flush) = MEMORY_FLUSH.get() {
        flush(cwd, agent, session).await;
    }
}

/// One ranked hit from the fused code index — a **manifest row**, not content.
/// The agent reads the evidence file (or the cited range) for the bodies it
/// actually needs; retrieval never floods the context with full chunks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeDoc {
    /// Project-relative path.
    pub rel: String,
    /// 1-based inclusive line range of the chunk.
    pub start_line: u32,
    pub end_line: u32,
    /// "fn" | "struct" | "class" | … ("" when unknown).
    pub kind: String,
    /// Primary symbol ("" for merged chunks).
    pub symbol: String,
    /// Fused score (higher is better).
    pub score: f32,
    /// One-line context header (path · language · enclosing · imports).
    pub summary: String,
}

/// What one code search returned: manifest rows plus the path of the evidence
/// bundle holding the full chunk bodies.
#[derive(Debug, Clone, Default)]
pub struct CodeSearchOutcome {
    pub hits: Vec<CodeDoc>,
    pub evidence_path: Option<String>,
}

/// `(cwd, query, limit) -> ranked manifest`. Async because retrieval may embed
/// the query and refresh the dirty-file overlay.
pub type CodeSearchFn = Arc<
    dyn Fn(String, String, usize) -> Pin<Box<dyn Future<Output = CodeSearchOutcome> + Send>>
        + Send
        + Sync,
>;

static CODE_SEARCH: OnceLock<CodeSearchFn> = OnceLock::new();

/// Register the code-search backend. Called once by the Tauri layer at
/// startup; until then the `search_code` tool is not offered and the SDK's
/// working-tree BM25 `code_search` remains the only ranked search — the
/// zero-index rung of the degradation ladder.
pub fn register_code_search(f: CodeSearchFn) {
    let _ = CODE_SEARCH.set(f);
}

/// Whether a code-search backend has been registered (gates adding the tool).
pub fn code_search_available() -> bool {
    CODE_SEARCH.get().is_some()
}

/// Tool the model calls to search the project's persistent code index:
/// chunk-level, dense + lexical fused, freshness-guarded, with exact line
/// citations.
pub struct SearchCodeTool;

#[async_trait]
impl Tool for SearchCodeTool {
    fn name(&self) -> &str {
        "search_code"
    }
    fn description(&self) -> &str {
        "Search the project's code index (semantic + keyword, fused) and return \
         a ranked manifest of code locations with exact file:line citations. \
         Works for conceptual questions (\"where do we handle payment retries\") \
         as well as identifiers. Each hit cites path, lines, and symbol; read \
         the evidence file or the cited range for the bodies you need. For an \
         exact string match, Grep is more precise."
    }
    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "What to find (natural language or identifiers)." },
                "limit": { "type": "integer", "description": "Max hits to return (default 8)." }
            },
            "required": ["query"]
        })
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let query = input.get("query").and_then(|q| q.as_str()).unwrap_or("").trim().to_string();
        if query.is_empty() {
            return ToolResult::error("`query` is required.");
        }
        let limit = input.get("limit").and_then(|l| l.as_u64()).unwrap_or(8).clamp(1, 20) as usize;
        let Some(search) = CODE_SEARCH.get() else {
            return ToolResult::error(
                "The code index is unavailable — use Grep or code_search instead.",
            );
        };
        let cwd = ctx.working_dir.to_string_lossy().into_owned();
        let outcome = search(cwd, query, limit).await;
        if outcome.hits.is_empty() {
            return ToolResult::success(
                "No matches in the code index. Try Grep for exact strings, or \
                 code_search for keyword search over the working tree.",
            );
        }
        let mut out = String::new();
        for d in &outcome.hits {
            let label = match (d.kind.as_str(), d.symbol.as_str()) {
                ("", "") | ("misc", "") => String::new(),
                (kind, "") => format!(" · {kind}"),
                (kind, symbol) => format!(" · {kind} {symbol}"),
            };
            out.push_str(&format!(
                "{}:{}-{}{} · score {:.4}\n  {}\n",
                d.rel, d.start_line, d.end_line, label, d.score, d.summary
            ));
        }
        if let Some(path) = &outcome.evidence_path {
            out.push_str(&format!(
                "\nFull chunk bodies: {path} — Read it (or the cited ranges) for what you need."
            ));
        }
        ToolResult::success(out.trim().to_string())
    }
}

/// Tool the model calls to recall indexed project memory.
pub struct SearchMemoryTool;

#[async_trait]
impl Tool for SearchMemoryTool {
    fn name(&self) -> &str {
        "search_memory"
    }
    fn description(&self) -> &str {
        "Search Atlas's indexed project memory — prior decisions, conventions, \
         feature notes, and codebase summaries — and return the most relevant \
         snippets. Use this BEFORE asking the user about project history or \
         established patterns; it grounds your answer in what's already known."
    }
    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "What to recall (natural language)." },
                "limit": { "type": "integer", "description": "Max snippets to return (default 6)." }
            },
            "required": ["query"]
        })
    }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let query = input.get("query").and_then(|q| q.as_str()).unwrap_or("").trim().to_string();
        if query.is_empty() {
            return ToolResult::error("`query` is required.");
        }
        let limit = input.get("limit").and_then(|l| l.as_u64()).unwrap_or(6).clamp(1, 20) as usize;
        let Some(search) = MEMORY_SEARCH.get() else {
            return ToolResult::error("Memory search is unavailable (index not ready).");
        };
        let cwd = ctx.working_dir.to_string_lossy().into_owned();
        let docs = search(cwd, query, limit).await;
        if docs.is_empty() {
            return ToolResult::success("No relevant project memory found.");
        }
        let mut out = String::new();
        for d in &docs {
            out.push_str(&format!("## {} ({})\n{}\n\n", d.title, d.source, d.text.trim()));
        }
        ToolResult::success(out.trim().to_string())
    }
}

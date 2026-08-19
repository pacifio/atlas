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

/// `(cwd, agent, session)` — flush anything worth keeping to memory NOW,
/// before compaction summarizes it away (contract C1). The payload is
/// identity only: the Tauri layer keeps its own uncompacted transcript
/// snapshot, so the flush re-reads from there rather than carrying the
/// SDK's message vector across the crate boundary.
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

/// Run the registered flush, if any. Awaited by the agent's pre-compact hook
/// — the whole point is that it completes before summarization discards the
/// middle of the session.
pub async fn memory_flush(cwd: String, agent: String, session: String) {
    if let Some(flush) = MEMORY_FLUSH.get() {
        flush(cwd, agent, session).await;
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

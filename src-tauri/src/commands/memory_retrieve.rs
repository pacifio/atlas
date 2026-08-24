//! Shared Cross-Agent Memory (v3) — retrieval-augmented push (Tier 2).
//!
//! The "Read half" of the index↔shared bridge. On a turn, Atlas uses the user's
//! message as an implicit query, RAG-searches the project's **memory index**
//! (the same MiniLM vector store the Memory ▸ Graph / Chat features build), and
//! returns the top few relevant docs so `agents_send` can inject a small
//! `--- RELEVANT PROJECT MEMORY ---` block. This makes the long-term index help
//! **every** agent via push — no agent-side tool support required (unlike the
//! Tier 3 pull tool).
//!
//! Retrieval runs through the fused `MemoryEngine` (HNSW + graph) using the single
//! app-wide MiniLM provider held by [`MemoryRegistry`] — the same instance the
//! indexer, graph, query and chat share, so the model is never re-loaded here.
//! **Strictly best-effort**: a missing model, an unbuilt index, or any error is a
//! silent empty result, and the whole call is time-bounded so it can never stall
//! a turn.

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use super::memory_delta::redact;
use super::memory_indexer::MemoryRegistry;

/// Hard cap on the whole retrieve (embed + search + corpus read).
const RETRIEVE_TIMEOUT_SECS: u64 = 6;
/// Per-doc snippet cap in the injected block.
const PER_DOC_CHARS: usize = 320;
/// Total char budget for the composed block body.
const BLOCK_MAX_CHARS: usize = 1400;

#[derive(Debug, Clone)]
pub struct RetrievedDoc {
    pub id: String,
    pub title: String,
    pub source: String,
    pub text: String,
}


/// Retrieve up to `top_k` index docs relevant to `query`, via the fused
/// `MemoryEngine` (Step 6): HNSW (embedding, primary) + graph (down-weighted),
/// RRF-fused and Jaccard-deduped behind the engine. Both seam consumers reach this
/// — the Cersei `search_memory` pull tool (`agents.rs` closure) and the
/// Claude/Codex push (site C) — so it improves all three agents at once.
///
/// Empty on any failure (no model, no engine, timeout) — callers treat empty as
/// "skip". Still time-bounded so it can never stall a turn.
pub async fn retrieve(
    app: &AppHandle,
    project_path: &str,
    query: &str,
    top_k: usize,
) -> Vec<RetrievedDoc> {
    match tokio::time::timeout(
        Duration::from_secs(RETRIEVE_TIMEOUT_SECS),
        retrieve_engine(app, project_path, query, top_k),
    )
    .await
    {
        Ok(docs) => docs,
        Err(_) => {
            tracing::warn!(target: "atlas::shared_memory", "index retrieval exceeded {RETRIEVE_TIMEOUT_SECS}s; skipping");
            Vec::new()
        }
    }
}

/// Engine-backed retrieval: resolve the project's `MemoryEngine` through the
/// registry, take the **read lock**, embed+fuse via [`MemoryEngine::retrieve`]
/// using the registry's **shared** provider, and map `atlas_memory::RetrievedDoc`
/// onto the local [`RetrievedDoc`] (which keeps `id` for site-C session dedup).
async fn retrieve_engine(
    app: &AppHandle,
    project_path: &str,
    query: &str,
    top_k: usize,
) -> Vec<RetrievedDoc> {
    if query.trim().len() < 4 || top_k == 0 {
        return Vec::new();
    }
    let registry = app.state::<Arc<MemoryRegistry>>();
    // Shared on-device provider (loaded once, reused by the indexer). Absent until
    // the MiniLM model is downloaded → nothing to retrieve, skip silently.
    let Some(provider) = registry.provider(app).await else {
        return Vec::new();
    };
    let engine = registry.engine_for(project_path);
    // try_read, never read().await: the indexer holds the WRITE lock for the
    // whole of a re-embed pass, and a big working-tree churn keeps it busy for
    // minutes. This retrieval is a best-effort nicety prepended to the user's
    // prompt — queueing their send behind indexing turned "agent is thinking"
    // into a flat 6s stall (the timeout) on every turn while the index was
    // warm. Busy index ⇒ skip the block this turn; the next quiet turn gets it.
    let Ok(guard) = engine.try_read() else {
        tracing::debug!(
            target: "atlas::shared_memory",
            "memory index busy (indexer holds the write lock) — skipping RAG block this turn"
        );
        return Vec::new();
    };
    let docs = guard.retrieve(query, top_k, &provider).await;
    drop(guard);

    docs.into_iter()
        .map(|d| RetrievedDoc {
            id: d.id,
            title: d.title,
            source: d.source,
            text: d.text,
        })
        .collect()
}


/// Compose the `--- RELEVANT PROJECT MEMORY ---` block from retrieved docs.
/// Snippets are truncated, secret-scanned, and budget-bounded. `None` when the
/// list is empty (caller injects nothing).
pub fn compose_index_block(docs: &[RetrievedDoc]) -> Option<String> {
    if docs.is_empty() {
        return None;
    }
    let mut body = String::new();
    let mut count = 0usize;
    for d in docs {
        let snippet = redact(&truncate_chars(d.text.trim(), PER_DOC_CHARS));
        if snippet.is_empty() {
            continue;
        }
        let entry = format!("- {} ({}): {}\n", d.title, d.source, snippet);
        if count > 0 && body.len() + entry.len() > BLOCK_MAX_CHARS {
            break;
        }
        body.push_str(&entry);
        count += 1;
    }
    if count == 0 {
        return None;
    }
    Some(format!(
        "--- RELEVANT PROJECT MEMORY ---\n{body}--- END RELEVANT PROJECT MEMORY ---"
    ))
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(id: &str, title: &str, text: &str) -> RetrievedDoc {
        RetrievedDoc {
            id: id.into(),
            title: title.into(),
            source: "claude".into(),
            text: text.into(),
        }
    }

    #[test]
    fn empty_docs_is_none() {
        assert!(compose_index_block(&[]).is_none());
    }

    #[test]
    fn composes_block_with_delimiters() {
        let docs = vec![doc("a", "Auth", "Uses Better Auth with DB sessions")];
        let block = compose_index_block(&docs).unwrap();
        assert!(block.starts_with("--- RELEVANT PROJECT MEMORY ---"));
        assert!(block.contains("Auth (claude): Uses Better Auth"));
        assert!(block.ends_with("--- END RELEVANT PROJECT MEMORY ---"));
    }

    #[test]
    fn redacts_secrets_in_snippets() {
        let docs = vec![doc("a", "Env", "key is sk-ABCDEF0123456789ABCDEF here")];
        let block = compose_index_block(&docs).unwrap();
        assert!(block.contains("[REDACTED]"));
        assert!(!block.contains("sk-ABCDEF0123456789"));
    }

    #[test]
    fn budget_bounds_body() {
        let big = "x".repeat(2000);
        let docs = vec![
            doc("a", "A", &big),
            doc("b", "B", &big),
            doc("c", "C", &big),
        ];
        let block = compose_index_block(&docs).unwrap();
        assert!(block.len() <= BLOCK_MAX_CHARS + 200);
    }
}

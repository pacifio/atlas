//! The one retrieval path (app side).
//!
//! Every consumer — the Claude/Codex push (site C), the Cersei `search_memory`
//! and `search_code` pull tools, and the Memory UIs (graph query, chat) —
//! reaches recall through this module: lexical FTS5 candidates from
//! `atlas-codeindex` (freshness-guarded by the dirty-file overlay) are handed
//! to `atlas_memory::MemoryEngine::retrieve_fused` beside the dense HNSW +
//! graph lists, RRF-fused with clamped IDF/recency bonuses. The UIs wrap these
//! primitives; nothing queries a second store.
//!
//! **Strictly best-effort**: a missing model degrades to lexical + graph (the
//! ladder's zero-download rung), an unbuilt engine store / lexical store is a
//! silent empty result, and every path is time-bounded (the 6s cap lives in
//! [`retrieve_scored`], so no consumer can stall).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use atlas_codeindex::lexical::{self, LexicalHit, LexicalStore};
use atlas_memory::{ExternalHit, RetrievalClass, ScoredDoc};
use tauri::{AppHandle, Manager};

use super::memory_chat::MemoryChatState;
use super::memory_delta::redact;
use super::memory_indexer::MemoryRegistry;

/// Hard cap on the whole retrieve (embed + search + corpus read).
const RETRIEVE_TIMEOUT_SECS: u64 = 6;
/// Per-doc snippet cap in the injected block.
const PER_DOC_CHARS: usize = 320;
/// Total char budget for the composed block body.
const BLOCK_MAX_CHARS: usize = 1400;
/// Lexical snippet handed to fusion/dedup (full bodies live in the store).
const LEX_SNIPPET_CHARS: usize = 700;
/// IDF bonus scale for rare query identifiers — matches the engine's
/// `MAX_IDF_BONUS` clamp, so a full-strength IDF match uses the whole
/// allowance and anything above it is clamped at the seam.
const IDF_SCALE: f32 = 0.0008;
/// Recency tie-break scale — matches the engine's `MAX_RECENCY_BONUS`.
const RECENCY_SCALE: f32 = 0.0002;
/// Evidence bundles kept before pruning oldest.
const EVIDENCE_KEEP: usize = 20;

#[derive(Debug, Clone)]
pub struct RetrievedDoc {
    pub id: String,
    pub title: String,
    pub source: String,
    pub text: String,
}

/// Lexical candidates plus the per-hit metadata fusion strips (line ranges,
/// kinds, bodies) and the store size for telemetry.
#[derive(Default)]
struct LexicalBundle {
    hits: Vec<ExternalHit>,
    meta: HashMap<String, LexicalHit>,
    corpus: u64,
}

/// What one [`retrieve_scored`] call produced, with telemetry inputs attached
/// (each caller records under its own path name).
#[derive(Default)]
pub struct ScoredRetrieval {
    pub docs: Vec<ScoredDoc>,
    /// Docs across the queried stores at query time (engine + lexical).
    pub corpus_size: u64,
    /// Which early-return guard fired, if any — a skip is a data point.
    pub skipped: Option<&'static str>,
    /// Lexical metadata fusion strips (line ranges, kinds, bodies), keyed by
    /// fusion id.
    pub lexical_meta: HashMap<String, LexicalHit>,
}

/// Retrieve up to `top_k` docs relevant to `query` through the fused engine.
/// Empty on any failure (no stores, timeout) — callers treat empty as "skip".
///
/// `_chat_state` is unused (the engine owns its provider via the registry) but
/// kept so the call sites compile unchanged. `invoked_by` is telemetry-only:
/// `"push"` (agents_send site C) or `"tool"` (the `search_memory` closure).
pub async fn retrieve(
    app: &AppHandle,
    _chat_state: &MemoryChatState,
    project_path: &str,
    query: &str,
    top_k: usize,
    invoked_by: &'static str,
) -> Vec<RetrievedDoc> {
    let started = std::time::Instant::now();
    let r = retrieve_scored(app, project_path, query, top_k, RetrievalClass::All).await;
    crate::telemetry::retrieval::record(
        app,
        "memory_retrieve",
        r.corpus_size,
        r.docs.len() as u64,
        r.docs.first().map(|d| d.score),
        started.elapsed().as_millis() as u64,
        invoked_by,
        r.skipped,
    );
    r.docs
        .into_iter()
        .map(|s| RetrievedDoc {
            id: s.doc.id,
            title: s.doc.title,
            source: s.doc.source,
            text: s.doc.text,
        })
        .collect()
}

/// The shared engine call every consumer builds on: lexical bundle (with the
/// dirty-overlay refresh) + dense + graph, fused by class. The whole call is
/// bounded by [`RETRIEVE_TIMEOUT_SECS`], so no consumer — push, tool, or UI —
/// can stall on retrieval. Telemetry is the caller's job.
pub async fn retrieve_scored(
    app: &AppHandle,
    project_path: &str,
    query: &str,
    top_k: usize,
    class: RetrievalClass,
) -> ScoredRetrieval {
    match tokio::time::timeout(
        Duration::from_secs(RETRIEVE_TIMEOUT_SECS),
        retrieve_scored_inner(app, project_path, query, top_k, class),
    )
    .await
    {
        Ok(r) => r,
        Err(_) => {
            tracing::warn!(
                target: "atlas::shared_memory",
                "fused retrieval exceeded {RETRIEVE_TIMEOUT_SECS}s; skipping"
            );
            ScoredRetrieval {
                skipped: Some("timeout"),
                ..Default::default()
            }
        }
    }
}

async fn retrieve_scored_inner(
    app: &AppHandle,
    project_path: &str,
    query: &str,
    top_k: usize,
    class: RetrievalClass,
) -> ScoredRetrieval {
    if query.trim().len() < 4 || top_k == 0 {
        return ScoredRetrieval {
            skipped: Some("query_too_short"),
            ..Default::default()
        };
    }
    let registry = app.state::<Arc<MemoryRegistry>>();
    // Shared on-device provider (loaded once, reused by the indexer). Absent
    // until the MiniLM model is downloaded → dense is skipped, lexical + graph
    // still answer (the degradation ladder's zero-download rung).
    let provider = registry.provider(app).await;

    let lex = if class == RetrievalClass::Memory {
        LexicalBundle::default()
    } else {
        let pool = top_k.saturating_mul(4).max(20);
        let pp = project_path.to_string();
        let q = query.to_string();
        tokio::task::spawn_blocking(move || lexical_bundle_blocking(&pp, &q, pool))
            .await
            .unwrap_or_default()
    };

    let engine = registry.engine_for(project_path);
    let guard = engine.read().await;
    let corpus_size = guard.store().len() as u64 + lex.corpus;
    if provider.is_none() && lex.hits.is_empty() && corpus_size == 0 {
        // Nothing to query anywhere: no embedding model, no lexical store, no
        // engine store.
        return ScoredRetrieval {
            skipped: Some("no_sources"),
            ..Default::default()
        };
    }
    let docs = guard
        .retrieve_fused(query, top_k, provider.as_deref(), &lex.hits, class)
        .await;
    drop(guard);
    ScoredRetrieval {
        docs,
        corpus_size,
        skipped: None,
        lexical_meta: lex.meta,
    }
}

/// `search_code` backend: fused code-class retrieval returning a manifest of
/// exact locations plus an evidence bundle with the full chunk bodies.
pub async fn retrieve_code(
    app: &AppHandle,
    project_path: &str,
    query: &str,
    top_k: usize,
) -> atlas_agents::CodeSearchOutcome {
    let started = std::time::Instant::now();
    let r = retrieve_scored(app, project_path, query, top_k, RetrievalClass::Code).await;
    let (scored, corpus_size, skipped, meta) =
        (r.docs, r.corpus_size, r.skipped, r.lexical_meta);

    // Dense-only chunk hits carry no line ranges through fusion; recover them
    // from the store first (one blocking pass), then build manifest + evidence.
    let need: Vec<(String, String, String)> = scored
        .iter()
        .filter(|s| !meta.contains_key(&s.doc.id))
        .filter_map(|s| {
            let (rel, hash) = lexical::parse_chunk_doc_id(&s.doc.id)?;
            Some((s.doc.id.clone(), rel.to_string(), hash.to_string()))
        })
        .collect();
    let resolved: HashMap<String, LexicalHit> = if need.is_empty() {
        HashMap::new()
    } else {
        let pp = project_path.to_string();
        tokio::task::spawn_blocking(move || {
            let mut out = HashMap::new();
            if let Ok(store) = LexicalStore::open(&pp) {
                for (id, rel, hash) in need {
                    if let Ok(Some(h)) = store.lookup(&rel, &hash) {
                        out.insert(id, h);
                    }
                }
            }
            out
        })
        .await
        .unwrap_or_default()
    };

    let mut hits: Vec<atlas_agents::CodeDoc> = Vec::new();
    let mut evidence = String::new();
    for s in &scored {
        if let Some(h) = meta.get(&s.doc.id).or_else(|| resolved.get(&s.doc.id)) {
            evidence.push_str(&format!(
                "## {}:{}-{}\n{}\n```\n{}\n```\n\n",
                h.rel, h.start_line, h.end_line, h.header, h.body
            ));
            hits.push(atlas_agents::CodeDoc {
                rel: h.rel.clone(),
                start_line: h.start_line,
                end_line: h.end_line,
                kind: h.kind.clone(),
                symbol: h.symbol.clone(),
                score: s.score,
                summary: h.header.clone(),
            });
        } else if let Some((rel, _)) = lexical::parse_chunk_doc_id(&s.doc.id) {
            // Chunk vanished from the store between fusion and lookup; cite
            // what fusion carried rather than dropping the hit silently.
            evidence.push_str(&format!("## {}\n{}\n\n", s.doc.title, s.doc.text));
            hits.push(atlas_agents::CodeDoc {
                rel: rel.to_string(),
                start_line: 0,
                end_line: 0,
                kind: String::new(),
                symbol: String::new(),
                score: s.score,
                summary: first_line(&s.doc.text),
            });
        } else if let Some(rel) = s.doc.id.strip_prefix("codebase:") {
            // File-level summary doc (distilled representation).
            evidence.push_str(&format!("## {rel}\n{}\n\n", s.doc.text));
            hits.push(atlas_agents::CodeDoc {
                rel: rel.to_string(),
                start_line: 0,
                end_line: 0,
                kind: "file".to_string(),
                symbol: String::new(),
                score: s.score,
                summary: first_line(&s.doc.text),
            });
        }
    }

    let pp = project_path.to_string();
    let evidence_path = tokio::task::spawn_blocking(move || write_evidence(&pp, &evidence))
        .await
        .ok()
        .flatten();

    crate::telemetry::retrieval::record(
        app,
        "search_code",
        corpus_size,
        hits.len() as u64,
        scored.first().map(|s| s.score),
        started.elapsed().as_millis() as u64,
        "tool",
        skipped,
    );

    atlas_agents::CodeSearchOutcome {
        hits,
        evidence_path,
    }
}

fn first_line(s: &str) -> String {
    let mut line = s.lines().next().unwrap_or("").trim().to_string();
    if line.len() > 160 {
        line.truncate(160);
        line.push('…');
    }
    line
}

/// Build the lexical candidate list: open the store, refresh the git-dirty
/// overlay (so just-written code is searchable), BM25-search, and attach
/// clamp-ready IDF + recency bonuses. Best-effort: any failure → empty.
fn lexical_bundle_blocking(project_path: &str, query: &str, pool: usize) -> LexicalBundle {
    let root = Path::new(project_path);
    let Ok(mut store) = LexicalStore::open(project_path) else {
        return LexicalBundle::default();
    };
    let dirty = lexical::dirty_files(root, lexical::MAX_REFRESH_FILES);
    if !dirty.is_empty() {
        if let Err(e) = store.refresh_files(root, &dirty) {
            tracing::debug!(target: "atlas::shared_memory", "lexical refresh failed: {e}");
        }
    }
    let corpus = store.chunk_count().unwrap_or(0);
    let Ok(found) = store.search(query, pool) else {
        return LexicalBundle {
            corpus,
            ..Default::default()
        };
    };

    // IDF weight per identifier-ish query token: rarer subtokens matter more.
    let token_idf: Vec<(String, f32)> = lexical::identifier_tokens(query)
        .into_iter()
        .filter_map(|tok| {
            let (df, total) = store.doc_frequency(&tok).ok()?;
            if df == 0 || total < 2 {
                return None;
            }
            let idf = ((total as f32) / (df as f32)).ln() / ((total as f32) + 1.0).ln();
            Some((tok.to_lowercase(), idf.clamp(0.0, 1.0)))
        })
        .collect();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let mut hits = Vec::with_capacity(found.len());
    let mut meta = HashMap::with_capacity(found.len());
    for h in found {
        let haystack = format!("{} {} {}", h.symbol, h.header, h.body).to_lowercase();
        let idf = token_idf
            .iter()
            .filter(|(tok, _)| haystack.contains(tok.as_str()))
            .map(|(_, w)| *w)
            .fold(0.0f32, f32::max)
            * IDF_SCALE;
        let age_days = ((now - h.recency_epoch).max(0) as f32) / 86_400.0;
        let recency = RECENCY_SCALE / (1.0 + age_days / 30.0);
        let id = h.doc_id();
        let mut text = format!("{}\n{}", h.header, h.body);
        truncate_at_char_boundary(&mut text, LEX_SNIPPET_CHARS);
        hits.push(ExternalHit {
            id: id.clone(),
            title: format!("{}:{}-{}", h.rel, h.start_line, h.end_line),
            source: "code".to_string(),
            text,
            idf,
            recency,
        });
        meta.insert(id, h);
    }
    LexicalBundle { hits, meta, corpus }
}

/// Truncate a `String` to at most `max` bytes without slicing mid-character.
pub(crate) fn truncate_at_char_boundary(s: &mut String, max: usize) {
    if s.len() <= max {
        return;
    }
    let mut cut = max;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    s.truncate(cut);
}

/// Write the evidence bundle and prune old ones. Returns the file path.
fn write_evidence(project_path: &str, evidence: &str) -> Option<String> {
    if evidence.is_empty() {
        return None;
    }
    let dir = atlas_codeindex::index_dir(project_path).join("evidence");
    std::fs::create_dir_all(&dir).ok()?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("search-{ts}.md"));
    // Atomic temp + rename: the agent Reads this file, so a torn write must
    // never be visible.
    let tmp = dir.join(format!("search-{ts}.md.tmp.{}", std::process::id()));
    std::fs::write(&tmp, evidence).ok()?;
    if std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return None;
    }
    // Prune: keep the newest EVIDENCE_KEEP bundles.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        let mut files: Vec<std::path::PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("search-")))
            .collect();
        files.sort();
        while files.len() > EVIDENCE_KEEP {
            let oldest = files.remove(0);
            let _ = std::fs::remove_file(oldest);
        }
    }
    Some(path.to_string_lossy().into_owned())
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

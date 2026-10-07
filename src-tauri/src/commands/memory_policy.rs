//! `memory_policy` — distill a table of user-preference "policies" out of the
//! agent memory, with NO LLM: a curated catalog of preference *probes* is
//! matched, by embedding cosine similarity (`atlas-embed`), against statement-
//! level passages pulled from the editable memory files (Claude `memory/*.md`,
//! `CLAUDE.md`, `AGENTS.md`). Each best match becomes an editable row whose
//! value is the exact memory text; editing rewrites that span in place.
//!
//! Codex's SQLite session threads are intentionally excluded — they're session
//! history, not persisted preferences, and aren't editable files.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use atlas_embed::{cosine, Embedder};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};

use super::agent_memory::collect_corpus;
use super::memory_graph::{model_dir, MODEL_FILES};
use super::memory_indexer::{indexed_vectors, MemoryRegistry};

/// Minimum cosine for a probe to claim a statement as its policy value.
const MATCH_THRESHOLD: f32 = 0.30;
/// Minimum cosine for a doc to be a candidate in the coarse (stage-1) match.
const DOC_THRESHOLD: f32 = 0.18;
/// How many top docs (per probe) to mine statements from in stage 2.
const TOP_DOCS: usize = 2;
/// Ignore lines shorter than this (headers, noise).
const MIN_STMT_LEN: usize = 14;

/// One preference "key" + the natural-language query used to find it.
struct Probe {
    key: &'static str,
    hint: &'static str,
    query: &'static str,
}

/// Curated catalog of common coding-agent preferences. The `query` is what we
/// embed and match against memory statements; `key`/`hint` label the row.
const CATALOG: &[Probe] = &[
    Probe { key: "Version control", hint: "Committing, pushing, staging", query: "git commit push and stage policy — may the agent commit or push changes, or does the user manage git manually" },
    Probe { key: "Theme", hint: "Light or dark appearance", query: "preferred UI theme or appearance — light mode or dark mode" },
    Probe { key: "Edit permissions", hint: "Auto-accept / bypass / ask", query: "permission mode preference — auto accept edits, bypass permissions, or ask before changes" },
    Probe { key: "Testing", hint: "Running and writing tests", query: "preference for running tests, writing tests, or test-driven development" },
    Probe { key: "Comments & style", hint: "Comment density, code style", query: "code comment density and coding style preferences" },
    Probe { key: "Package manager", hint: "npm / pnpm / yarn / bun", query: "preferred package manager such as npm, pnpm, yarn, or bun" },
    Probe { key: "Commit messages", hint: "Message format", query: "git commit message format and style preferences" },
    Probe { key: "Languages & frameworks", hint: "Preferred stack", query: "preferred programming languages, frameworks, or libraries to use" },
    Probe { key: "Architecture", hint: "Where logic lives", query: "architectural rules — where business logic should live, separation of concerns" },
    Probe { key: "Communication", hint: "Verbosity and tone", query: "how the agent should communicate — verbosity, tone, conciseness" },
    Probe { key: "Dependencies & files", hint: "Adding deps / new files", query: "rules about adding dependencies or creating new files" },
    Probe { key: "Formatting & linting", hint: "Formatter / linter rules", query: "code formatting and linting preferences" },
];

#[derive(Debug, Serialize)]
pub struct Policy {
    /// Stable row id (`key` + statement index).
    id: String,
    key: String,
    hint: String,
    /// The matched memory statement — editable; rewritten in place on save.
    value: String,
    /// "strong" (hard rule — MUST/NEVER/ALWAYS) | "soft" (preference/guidance).
    category: String,
    /// "preference" (curated probe) | "codebase" (a feedback/behavior memory).
    origin: String,
    /// "semantic" (cosine-matched probe) | "keyword" (direct memory listing).
    match_kind: String,
    source: String, // "claude" | "codex"
    file_path: String,
    doc_title: String,
    score: f32,
}

/// Classify a policy statement as a STRONG (hard) rule or a SOFT (preference).
/// Strong = imperative absolutes the agent must obey; soft = guidance.
fn classify(text: &str) -> &'static str {
    let l = text.to_lowercase();
    const STRONG: &[&str] = &[
        "must",
        "never",
        "always",
        "do not",
        "don't",
        "required",
        "mandatory",
        "forbidden",
        "shall",
        "only ever",
        "do NOT",
    ];
    if STRONG.iter().any(|m| l.contains(m)) {
        "strong"
    } else {
        "soft"
    }
}

// ── Statement-vector cache (per project) ────────────────────────────────────

fn cache_path(project_path: &str) -> PathBuf {
    atlas_profile::dir_in(Path::new(project_path))
        .join("memory-index")
        .join("policy.json")
}

fn load_cache(project_path: &str) -> HashMap<String, Vec<f32>> {
    std::fs::read_to_string(cache_path(project_path))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_cache(project_path: &str, cache: &HashMap<String, Vec<f32>>) {
    let path = cache_path(project_path);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(cache) {
        let _ = std::fs::write(path, json);
    }
}

fn hash_text(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    format!("{:x}", h.finalize())
}

/// Split a doc body into candidate preference statements. Strips leading list /
/// heading / quote markers (so the cleaned text is still a substring of the file
/// for exact replacement) and drops short/noise lines. Deduped.
fn split_statements(body: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for raw in body.lines() {
        let line = raw
            .trim_start_matches(|c: char| {
                c == '-' || c == '*' || c == '+' || c == '#' || c == '>' || c.is_whitespace()
            })
            .trim();
        if line.len() < MIN_STMT_LEN {
            continue;
        }
        if line.starts_with("```") || line.starts_with("| ") || line.starts_with("---") {
            continue;
        }
        if seen.insert(line.to_string()) {
            out.push(line.to_string());
        }
    }
    out
}

#[tauri::command]
pub async fn memory_policies(
    app: AppHandle,
    project_path: String,
    registry: State<'_, Arc<MemoryRegistry>>,
) -> Result<Vec<Policy>, String> {
    let dir = model_dir(&app)?;
    if !MODEL_FILES.iter().all(|f| dir.join(f).exists()) {
        return Err("model-not-downloaded".into());
    }

    // Preferences live in memory files (MEMORY.md / CLAUDE.md / AGENTS.md / shared
    // memory), NEVER in source files — so drop the codebase index (source
    // "codebase", added in 0.1.18). It otherwise made "Distilling preferences…"
    // embed hundreds of irrelevant file docs on the CPU embedder every cold run.
    let docs = collect_corpus(&project_path)
        .await
        .into_iter()
        .filter(|d| d.file_path.is_some() && d.source != "codebase")
        .collect::<Vec<_>>();
    if docs.is_empty() {
        return Ok(vec![]);
    }

    // Shared, load-once MiniLM — no per-distillation model reload.
    let provider = registry
        .provider(&app)
        .await
        .ok_or("model-not-downloaded")?;
    let embedder = provider.embedder();
    let doc_vecs = indexed_vectors(&registry, &provider, &project_path, &docs).await;

    let pp = project_path.clone();
    tokio::task::spawn_blocking(move || compute_policies(embedder, pp, docs, doc_vecs))
        .await
        .map_err(|e| format!("policy task: {e}"))?
}

fn compute_policies(
    embedder: Arc<Embedder>,
    project_path: String,
    docs: Vec<super::agent_memory::MemoryDoc>,
    mut doc_vecs: HashMap<String, Vec<f32>>,
) -> Result<Vec<Policy>, String> {
    // ── Stage 1: doc-level vectors, reusing the retrieval index where built ──
    // This is the expensive part the old version redid per statement; here the
    // whole-file vectors come free from the index (`doc_vecs`), and we only embed
    // the handful of docs it hasn't seen.
    for d in &docs {
        if !doc_vecs.contains_key(&d.id) {
            // Same text the index embeds, so these vectors are comparable.
            let text = super::memory_indexer::to_corpus_doc(d).text;
            let v = embedder
                .embed_one(&text)
                .map_err(|e| format!("embed doc: {e}"))?;
            doc_vecs.insert(d.id.clone(), v);
        }
    }

    // Statement-vector cache (persisted) — only the *winning* docs' lines are
    // ever embedded, so this stays small.
    let mut cache = load_cache(&project_path);
    let mut cache_dirty = false;

    let mut out: Vec<Policy> = Vec::new();
    for probe in CATALOG {
        let qv = embedder
            .embed_one(probe.query)
            .map_err(|e| format!("embed probe: {e}"))?;

        // Rank file-backed docs by the coarse doc-level vector.
        let mut ranked: Vec<(usize, f32)> = docs
            .iter()
            .enumerate()
            .filter_map(|(i, d)| doc_vecs.get(&d.id).map(|v| (i, cosine(&qv, v))))
            .collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1));

        // Stage 2: within the top docs, find the best statement.
        let mut best: Option<(usize, String, f32)> = None;
        for (di, dscore) in ranked.iter().take(TOP_DOCS) {
            if *dscore < DOC_THRESHOLD {
                break;
            }
            for line in split_statements(&docs[*di].text) {
                let h = hash_text(&line);
                let v = if let Some(v) = cache.get(&h) {
                    v.clone()
                } else {
                    let v = embedder
                        .embed_one(&line)
                        .map_err(|e| format!("embed stmt: {e}"))?;
                    cache.insert(h, v.clone());
                    cache_dirty = true;
                    v
                };
                let s = cosine(&qv, &v);
                if best.as_ref().map(|(_, _, bs)| s > *bs).unwrap_or(true) {
                    best = Some((*di, line, s));
                }
            }
        }

        if let Some((di, line, score)) = best {
            if score >= MATCH_THRESHOLD {
                let d = &docs[di];
                let category = classify(&line).to_string();
                out.push(Policy {
                    id: probe.key.to_string(),
                    key: probe.key.to_string(),
                    hint: probe.hint.to_string(),
                    category,
                    origin: "preference".to_string(),
                    match_kind: "semantic".to_string(),
                    value: line,
                    source: d.source.clone(),
                    file_path: d.file_path.clone().unwrap_or_default(),
                    doc_title: d.title.clone(),
                    score,
                });
            }
        }
    }

    if cache_dirty {
        save_cache(&project_path, &cache);
    }

    // ── Behavioral policies ──────────────────────────────────────────────────
    // Every `feedback` memory is a codebase behavior the agent should follow,
    // but most aren't one of the curated preference probes (e.g. "use
    // transform-gpu for hover jitter"). Surface each as a soft/strong policy row
    // so they show up in the tab. No embedding needed — it's a direct listing.
    // Skip docs already claimed by a probe match above to avoid duplicate rows.
    let used: std::collections::HashSet<String> = out.iter().map(|p| p.file_path.clone()).collect();
    for d in &docs {
        if d.kind != "feedback" {
            continue;
        }
        let fp = d.file_path.clone().unwrap_or_default();
        if used.contains(&fp) {
            continue;
        }
        // Lead statement = the one-line rule (the memory's description/summary).
        let Some(line) = split_statements(&d.text).into_iter().next() else {
            continue;
        };
        let category = classify(&line).to_string();
        out.push(Policy {
            id: format!("fb:{}", d.id),
            key: d.title.clone(),
            hint: "Codebase behavior".to_string(),
            category,
            origin: "codebase".to_string(),
            match_kind: "keyword".to_string(),
            value: line,
            source: d.source.clone(),
            file_path: fp,
            doc_title: d.title.clone(),
            score: 1.0,
        });
    }

    Ok(out)
}

/// Replace the first exact occurrence of `old_text` with `new_text` in a memory
/// file. Guarded to the agent memory locations so the command can't be coerced
/// into writing arbitrary files.
#[tauri::command]
pub async fn memory_policy_update(
    file_path: String,
    old_text: String,
    new_text: String,
) -> Result<(), String> {
    if !is_allowed_memory_path(&file_path) {
        return Err("path not allowed".into());
    }
    if old_text.is_empty() {
        return Err("empty original text".into());
    }
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let content = std::fs::read_to_string(&file_path).map_err(|e| format!("read: {e}"))?;
        let Some(pos) = content.find(&old_text) else {
            return Err("original text not found in file".into());
        };
        let mut updated = String::with_capacity(content.len() + new_text.len());
        updated.push_str(&content[..pos]);
        updated.push_str(&new_text);
        updated.push_str(&content[pos + old_text.len()..]);
        std::fs::write(&file_path, updated).map_err(|e| format!("write: {e}"))
    })
    .await
    .map_err(|e| format!("update task: {e}"))?
}

fn is_allowed_memory_path(p: &str) -> bool {
    let home = dirs::home_dir().unwrap_or_default();
    let path = Path::new(p);
    path.starts_with(home.join(".claude"))
        || path.starts_with(home.join(".codex"))
        || p.ends_with("CLAUDE.md")
        || p.ends_with("AGENTS.md")
}

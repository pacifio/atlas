//! Backlinks engine for the knowledge base.
//!
//! Walks every `.atlas/knowledge/**/*.md` file in a project and pulls
//! out references to other knowledge entries, in two flavors:
//!
//!   - `[[page-id]]` (bare wikilinks)
//!   - `@knowledge:<id>` / `@note:<id>` / `@page:<id>` — Atlas's
//!     existing mention wire formats (kept in sync with the kinds
//!     consumed by `compose_prompt.rs::MentionSpec`).
//!
//! The result is a per-project `LinkGraph` cached in
//! `Arc<RwLock<...>>`. Callers either rebuild on demand (first read,
//! after a `_invalidate` call) or rely on Rust to emit
//! `atlas:knowledge:links-changed` after a rebuild for the frontend
//! store to refresh.
//!
//! No filesystem watcher here — the frontend invalidates explicitly
//! after every `save_knowledge_note` / `delete_knowledge_note`, which
//! is when content actually changes. Adding a watcher later if other
//! tools rewrite the files is a small addition (mirror the
//! `git_watcher` pattern in `git_watcher.rs`).

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;

use parking_lot::RwLock;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    pub from_entry_id: String,
    pub from_title: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LinkCounts {
    pub backlinks: usize,
    pub forwardlinks: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub title: String,
    pub in_degree: u32,
    pub out_degree: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Default, Clone)]
struct LinkGraph {
    /// `target_id → [Backlink]` (where target = the page being referenced).
    backlinks: HashMap<String, Vec<Backlink>>,
    /// `from_id → [target_id]` (everything the page references).
    forwardlinks: HashMap<String, Vec<String>>,
    /// Every note walked off disk, in (id, title) order. Used by
    /// `knowledge_links_graph` so the graph view can surface isolated
    /// notes (no incoming or outgoing references) as standalone nodes.
    notes: Vec<NoteSummary>,
}

#[derive(Debug, Clone)]
struct NoteSummary {
    id: String,
    title: String,
}

#[derive(Default)]
pub struct KnowledgeLinksState {
    /// `project_path → LinkGraph`. `None` = "not yet computed".
    by_project: RwLock<HashMap<String, Option<LinkGraph>>>,
}

impl KnowledgeLinksState {
    pub fn new() -> Self {
        Self::default()
    }
}

const SNIPPET_RADIUS: usize = 90;

fn knowledge_dir(project_path: &str) -> std::path::PathBuf {
    Path::new(project_path).join(".atlas").join("knowledge")
}

/// One-shot rebuild — walks every .md file, parses refs, builds the
/// reverse index. Synchronous; callers route through spawn_blocking.
fn build_graph(project_path: &str) -> LinkGraph {
    let root = knowledge_dir(project_path);
    if !root.exists() {
        return LinkGraph::default();
    }
    let mut docs: Vec<(String, String, String)> = Vec::new(); // (id, title, body)
    walk(&root, &root, &mut docs);

    let mut graph = LinkGraph::default();
    for (from_id, from_title, body) in &docs {
        graph.notes.push(NoteSummary {
            id: from_id.clone(),
            title: from_title.clone(),
        });
        let mut targets: Vec<String> = Vec::new();
        for hit in find_refs(body) {
            // Skip self-references — a page can't backlink to itself.
            if hit.target == *from_id {
                continue;
            }
            let bl = Backlink {
                from_entry_id: from_id.clone(),
                from_title: from_title.clone(),
                snippet: extract_snippet(body, hit.start, hit.end),
            };
            graph
                .backlinks
                .entry(hit.target.clone())
                .or_default()
                .push(bl);
            if !targets.contains(&hit.target) {
                targets.push(hit.target);
            }
        }
        graph.forwardlinks.insert(from_id.clone(), targets);
    }
    graph
}

fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, String, String)>) {
    let Ok(read) = fs::read_dir(dir) else { return };
    for entry in read.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, root, out);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Ok(body) = fs::read_to_string(&path) else { continue };
        let rel = path.strip_prefix(root).unwrap_or(&path);
        let id = rel.with_extension("").to_string_lossy().to_string();
        let filename = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        // Filename-only fallback. The user-edited title in `_meta.json`
        // wins on the JS side; deriving from the first `#` would cause
        // the graph node label to drift to body content. Mirrors the
        // same change in `knowledge::list_knowledge`.
        out.push((id, filename, body));
    }
}

struct RefHit {
    target: String,
    start: usize,
    end: usize,
}

/// Two-pass extractor: `[[id]]` wikilinks first, then `@kind:id` for
/// the three kinds we treat as knowledge refs. Byte-offset-based so
/// the snippet extractor can highlight the exact match later.
fn find_refs(body: &str) -> Vec<RefHit> {
    let mut out: Vec<RefHit> = Vec::new();
    let bytes = body.as_bytes();
    let n = bytes.len();

    // [[wikilinks]]
    let mut i = 0;
    while i + 1 < n {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if let Some(close) = body[i + 2..].find("]]") {
                let inner_start = i + 2;
                let inner_end = i + 2 + close;
                let inner = &body[inner_start..inner_end];
                if !inner.is_empty() && !inner.contains('\n') && inner.len() < 200 {
                    out.push(RefHit {
                        target: inner.to_string(),
                        start: i,
                        end: inner_end + 2,
                    });
                }
                i = inner_end + 2;
                continue;
            }
        }
        i += 1;
    }

    // @kind:id mentions (only the kinds we treat as knowledge refs).
    for kind in &["knowledge", "note", "page"] {
        let needle = format!("@{}:", kind);
        let mut search_from = 0;
        while let Some(pos_in_slice) = body[search_from..].find(&needle) {
            let pos = search_from + pos_in_slice;
            let id_start = pos + needle.len();
            // Mention ids end at whitespace / punctuation. Be liberal —
            // accept anything that isn't whitespace or a few break chars.
            let mut id_end = id_start;
            for c in body[id_start..].chars() {
                if c.is_whitespace() || matches!(c, ',' | ';' | ')' | ']' | '}' | '"' | '\'' | '`') {
                    break;
                }
                id_end += c.len_utf8();
            }
            if id_end > id_start {
                let target = body[id_start..id_end].to_string();
                if !target.is_empty() {
                    out.push(RefHit { target, start: pos, end: id_end });
                }
            }
            search_from = id_end.max(pos + 1);
        }
    }

    // HTML-mode fallback: tiptap-markdown's html mode can serialize a
    // Mention chip as `<span data-id="..." data-mention-kind="knowledge">…</span>`.
    // The plain `@kind:id` text version above is preferred (and what our
    // current Mention serializer emits), but old files written before
    // the dedicated serializer landed will still have the HTML span —
    // pick those up too so the graph survives format migrations.
    let mut span_search = 0;
    while let Some(pos_in_slice) = body[span_search..].find("data-mention-kind=") {
        let pos = span_search + pos_in_slice;
        let kind_value = match read_quoted_attr(&body[pos..], "data-mention-kind=") {
            Some(v) => v,
            None => { span_search = pos + 1; continue; }
        };
        let only_knowledge = matches!(kind_value.as_str(), "knowledge" | "note" | "page");
        // The id is typically on the same span; scan a small window.
        let window_end = (pos + 400).min(body.len());
        let window = &body[pos..clamp_to_char_boundary(body, window_end)];
        let id_value = read_quoted_attr(window, "data-id=");
        if only_knowledge {
            if let Some(target) = id_value {
                if !target.is_empty() {
                    out.push(RefHit { target, start: pos, end: pos + 1 });
                }
            }
        }
        span_search = pos + 1;
    }

    out
}

/// Read the value of `name="…"` or `name='…'` starting at the head of
/// `src`. Returns None if the attribute isn't a `quote/value/quote`
/// shape at the very start of the slice.
fn read_quoted_attr(src: &str, name: &str) -> Option<String> {
    let head = src.find(name)?;
    let after = head + name.len();
    let bytes = src.as_bytes();
    if after >= bytes.len() { return None; }
    let quote = bytes[after];
    if quote != b'"' && quote != b'\'' { return None; }
    let value_start = after + 1;
    let rest = &src[value_start..];
    let end = rest.find(quote as char)?;
    Some(rest[..end].to_string())
}

/// ~120 chars surrounding the match, with the match wrapped in
/// brackets so the UI can highlight it. Clipped at word boundaries
/// where convenient. Safe over UTF-8 boundaries.
fn extract_snippet(body: &str, start: usize, end: usize) -> String {
    let lo = body
        .char_indices()
        .map(|(i, _)| i)
        .filter(|i| *i + SNIPPET_RADIUS >= start)
        .next()
        .unwrap_or(start.saturating_sub(SNIPPET_RADIUS));
    let hi = body
        .char_indices()
        .map(|(i, c)| i + c.len_utf8())
        .filter(|i| *i >= end + SNIPPET_RADIUS)
        .next()
        .unwrap_or((end + SNIPPET_RADIUS).min(body.len()));

    let lo = clamp_to_char_boundary(body, lo);
    let hi = clamp_to_char_boundary(body, hi.min(body.len()));
    let before = &body[lo..start.min(hi)];
    let matched = &body[start.min(hi)..end.min(hi)];
    let after = &body[end.min(hi)..hi];

    // Strip newlines so the snippet reads as a single line in the UI.
    let cleaned = format!(
        "{}{{{{ {} }}}}{}",
        before.replace('\n', " "),
        matched.replace('\n', " "),
        after.replace('\n', " "),
    );

    let prefix = if lo > 0 { "…" } else { "" };
    let suffix = if hi < body.len() { "…" } else { "" };
    format!("{}{}{}", prefix, cleaned.trim(), suffix)
}

fn clamp_to_char_boundary(s: &str, i: usize) -> usize {
    let mut j = i.min(s.len());
    while j > 0 && !s.is_char_boundary(j) {
        j -= 1;
    }
    j
}

fn ensure_graph(state: &KnowledgeLinksState, project_path: &str) {
    {
        let by_proj = state.by_project.read();
        if matches!(by_proj.get(project_path), Some(Some(_))) {
            return;
        }
    }
    let graph = build_graph(project_path);
    let mut by_proj = state.by_project.write();
    by_proj.insert(project_path.to_string(), Some(graph));
}

/* ── Commands ───────────────────────────────────────────────────── */

#[tauri::command]
pub async fn knowledge_backlinks(
    project_path: String,
    entry_id: String,
    state: State<'_, Arc<KnowledgeLinksState>>,
) -> Result<Vec<Backlink>, String> {
    let state = Arc::clone(state.inner());
    tokio::task::spawn_blocking(move || {
        ensure_graph(&state, &project_path);
        let by_proj = state.by_project.read();
        let graph = match by_proj.get(&project_path) {
            Some(Some(g)) => g,
            _ => return Ok(Vec::new()),
        };
        Ok(graph.backlinks.get(&entry_id).cloned().unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn knowledge_link_counts(
    project_path: String,
    entry_id: String,
    state: State<'_, Arc<KnowledgeLinksState>>,
) -> Result<LinkCounts, String> {
    let state = Arc::clone(state.inner());
    tokio::task::spawn_blocking(move || {
        ensure_graph(&state, &project_path);
        let by_proj = state.by_project.read();
        let graph = match by_proj.get(&project_path) {
            Some(Some(g)) => g,
            _ => return Ok(LinkCounts::default()),
        };
        Ok(LinkCounts {
            backlinks: graph.backlinks.get(&entry_id).map(|v| v.len()).unwrap_or(0),
            forwardlinks: graph.forwardlinks.get(&entry_id).map(|v| v.len()).unwrap_or(0),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Drop the cached graph + emit `atlas:knowledge:links-changed` so the
/// frontend re-pulls. Cheap — frontend calls after every save/delete.
#[tauri::command]
pub async fn knowledge_links_invalidate(
    project_path: String,
    state: State<'_, Arc<KnowledgeLinksState>>,
    app: AppHandle,
) -> Result<(), String> {
    {
        let mut by_proj = state.by_project.write();
        by_proj.remove(&project_path);
    }
    let _ = app.emit(
        "atlas:knowledge:links-changed",
        serde_json::json!({ "projectPath": project_path }),
    );
    Ok(())
}

/// Project-wide graph projection for the Obsidian-style graph view.
/// Surfaces every note as a node (including isolated ones) so the
/// canvas isn't sparse for fresh projects, and dedupes A→B / B→A into
/// a single undirected edge for layout purposes (the picker / inspector
/// keep the directed `LinkGraph` for their own needs).
#[tauri::command]
pub async fn knowledge_links_graph(
    project_path: String,
    state: State<'_, Arc<KnowledgeLinksState>>,
) -> Result<ProjectGraph, String> {
    let state = Arc::clone(state.inner());
    tokio::task::spawn_blocking(move || {
        ensure_graph(&state, &project_path);
        let by_proj = state.by_project.read();
        let graph = match by_proj.get(&project_path) {
            Some(Some(g)) => g,
            _ => return Ok(ProjectGraph::default()),
        };

        // Collect every known id from notes + both link sides.
        // Notes-walk gives us isolated ones; the maps catch any
        // referenced-but-not-on-disk ids (shouldn't happen, but safe).
        let mut titles: HashMap<String, String> = HashMap::new();
        for n in &graph.notes {
            titles.insert(n.id.clone(), n.title.clone());
        }
        for id in graph.backlinks.keys() {
            titles.entry(id.clone()).or_insert_with(|| id.clone());
        }
        for id in graph.forwardlinks.keys() {
            titles.entry(id.clone()).or_insert_with(|| id.clone());
        }

        // Dedupe edges as undirected pairs.
        let mut edges: Vec<GraphEdge> = Vec::new();
        let mut seen_pairs: std::collections::HashSet<(String, String)> = Default::default();
        for (from, targets) in &graph.forwardlinks {
            for to in targets {
                if from == to { continue; }
                let key = if from < to { (from.clone(), to.clone()) } else { (to.clone(), from.clone()) };
                if seen_pairs.insert(key) {
                    edges.push(GraphEdge { from: from.clone(), to: to.clone() });
                }
            }
        }

        // Degrees from the directed graph: out = forwardlinks count,
        // in = backlinks count. Used by the renderer to scale hub nodes
        // bigger.
        let mut nodes: Vec<GraphNode> = titles
            .into_iter()
            .map(|(id, title)| {
                let out_degree = graph
                    .forwardlinks
                    .get(&id)
                    .map(|v| v.len() as u32)
                    .unwrap_or(0);
                let in_degree = graph
                    .backlinks
                    .get(&id)
                    .map(|v| v.len() as u32)
                    .unwrap_or(0);
                GraphNode { id, title, in_degree, out_degree }
            })
            .collect();
        nodes.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(ProjectGraph { nodes, edges })
    })
    .await
    .map_err(|e| e.to_string())?
}

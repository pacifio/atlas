//! Unified `mention_search` command — replaces the JS-side per-provider
//! fan-out + ranking in `src/features/chat/lib/mentions.ts`.
//!
//! Previously: each keystroke in the picker triggered N parallel JS
//! providers (`Promise.allSettled([files, folders, symbols, knowledge,
//! repos, papers, branches])`), each invoking its own Tauri command
//! and returning results, then JS ran `rankMention` to blend + sort.
//! That's per-keystroke N+1 IPCs + JS-side fuzzy scoring across all
//! results.
//!
//! Now: one Tauri command. Rust reads the data sources it already
//! owns (file/folder via the live `FileIndexState`, repo/paper via
//! existing computes, branch via `git_refs_compute`). Knowledge +
//! symbols are passed in from the frontend caches that already
//! mirror Rust state — the input is small (a few hundred entries)
//! and the alternative (a second Rust cache layer for them) was a
//! larger refactor without payoff for this round. All seven kinds
//! fan out in parallel via `tokio::join!`; every fuzzy match runs
//! through `nucleo` (the same matcher Cmd+P uses) and returns a
//! unified ranked top-N. Past-message is intentionally out of
//! scope — it's a two-level pick-session-then-search flow that
//! doesn't fit the unified shape.

use std::collections::HashMap;
use std::path::PathBuf;

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Matcher, Utf32Str};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{State, WebviewWindow};

use super::fileindex::FileIndexState;
use super::git::{GitRef, GitRefs};
use super::git_watcher::GitWatcherState;
use super::github::{list_cloned_repos, ClonedRepo};
use super::papers::{list_saved_papers, SavedPaper, SavedPapersIndex};

const PER_KIND_LIMIT: usize = 30;
/// Unscoped blend: cap any one kind so files can't crowd every other
/// kind out of the list (the old concat-then-truncate did exactly that).
const BLEND_PER_KIND: usize = 10;
const TOTAL_LIMIT: usize = 40;

/// Per-process cache of the mention-search inputs that aren't already held in
/// a lock-protected Rust state. Knowledge entries are pushed in from JS
/// (`useKnowledgeStore`) via `mention_cache_set_knowledge`; symbols are loaded
/// Rust-side from the persisted `atlas-codeindex` by [`ensure_symbol_cache`]
/// (no JS push). Read by `mention_search`.
///
/// Why this exists: before the cache, every @-picker keystroke
/// serialized the full knowledge + symbols arrays from JS to JSON,
/// shipped them over IPC to Rust, then Rust deserialized them. On a
/// project with 1000 symbols this was ~150 KB of JSON encode +
/// decode work on the JS main thread per keystroke — the perceived
/// typing lag in the picker. With the cache the per-keystroke
/// payload is just `(query, scope, project_path)` (a few hundred
/// bytes) and the heavy data sits hot in Rust.
/// Per-WINDOW caches (keyed by webview label), for the same reason as
/// `FileIndexState`: `.manage()` state is process-global, so a single cache
/// would let window B's knowledge/symbols leak into window A's @-mentions.
#[derive(Default)]
struct WindowCache {
    knowledge: Vec<KnowledgeInput>,
    symbols: Vec<SymbolInput>,
    /// Which project `symbols` was loaded from. Symbols are now sourced
    /// Rust-side from the persisted `atlas-codeindex` (see
    /// `ensure_symbol_cache`) rather than pushed from JS, so we lazily load
    /// them on the first symbol-search per project and remember the project
    /// here to avoid re-reading `docs.json` on every keystroke.
    symbols_project: Option<String>,
    /// `docs.json` mtime (ms) the cached `symbols` were built from. Re-read
    /// when the index is (re)built so freshly-indexed symbols show up without
    /// a window reload; a cheap `stat` per keystroke gates the reload.
    symbols_mtime: i64,
}

#[derive(Default)]
pub struct MentionCacheState {
    per_window: RwLock<HashMap<String, WindowCache>>,
}

impl MentionCacheState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Drop a window's cache (called on window close).
    pub fn drop_window(&self, label: &str) {
        self.per_window.write().remove(label);
    }
}

#[tauri::command]
pub fn mention_cache_set_knowledge(
    items: Vec<KnowledgeInput>,
    workspace_id: Option<String>,
    webview: WebviewWindow,
    state: State<'_, MentionCacheState>,
) {
    let key = workspace_id.unwrap_or_else(|| webview.label().to_string());
    state
        .per_window
        .write()
        .entry(key)
        .or_default()
        .knowledge = items;
}

#[tauri::command]
pub fn mention_cache_clear(
    workspace_id: Option<String>,
    webview: WebviewWindow,
    state: State<'_, MentionCacheState>,
) {
    let key = workspace_id.unwrap_or_else(|| webview.label().to_string());
    state.per_window.write().remove(&key);
}

/// Ranked shape for a code symbol in the @-mention picker. Built Rust-side
/// from the persisted `atlas-codeindex` (`docs.json`) by [`ensure_symbol_cache`].
#[derive(Debug, Clone)]
pub struct SymbolInput {
    pub name: String,
    pub kind: String,
    pub file_path: String,
    pub line: u32,
    pub signature: String,
}

/// Lazily populate a window's symbol cache from the persisted codebase index
/// (`atlas-codeindex`) the first time symbols are searched for a given
/// project. The `docs.json` read + flatten runs once per project on a blocking
/// thread; every subsequent keystroke hits the hot in-memory cache. Mirrors
/// the branch-refs lazy-cache pattern. A project that has never been indexed
/// (no `docs.json`) yields an empty list — `@symbol` simply returns nothing
/// until chat-with-codebase indexing has run.
async fn ensure_symbol_cache(
    state: &MentionCacheState,
    label: &str,
    project_path: Option<&str>,
) {
    let Some(project) = project_path else {
        return;
    };
    // Cheap stat of `docs.json` — its mtime tells us whether the index was
    // (re)built since we cached. 0 when it doesn't exist yet (unindexed).
    let mtime = std::fs::metadata(atlas_codeindex::docs_path(project))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    // Already loaded for this exact project + index revision → nothing to do.
    {
        let map = state.per_window.read();
        if let Some(c) = map.get(label) {
            if c.symbols_project.as_deref() == Some(project) && c.symbols_mtime == mtime {
                return;
            }
        }
    }
    let project_owned = project.to_string();
    let symbols = tokio::task::spawn_blocking(move || {
        let index = atlas_codeindex::load_index(&project_owned);
        let mut out: Vec<SymbolInput> = Vec::new();
        for doc in &index.docs {
            for s in &doc.symbols {
                out.push(SymbolInput {
                    name: s.name.clone(),
                    kind: s.kind.clone(),
                    // Absolute path so the picker can open the file directly.
                    file_path: doc.abs_path.clone(),
                    line: s.line,
                    // atlas-codeindex stores no signature; synthesize a compact
                    // "kind name" so the picker's detail line still reads well.
                    signature: format!("{} {}", s.kind, s.name),
                });
            }
        }
        out
    })
    .await
    .unwrap_or_default();

    let mut map = state.per_window.write();
    let entry = map.entry(label.to_string()).or_default();
    entry.symbols = symbols;
    entry.symbols_project = Some(project.to_string());
    entry.symbols_mtime = mtime;
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeInput {
    pub id: String,
    pub title: String,
    /// Per-note emoji/glyph from `_meta.json`. `#[serde(default)]` so an
    /// older publisher that omits it still deserializes (→ None).
    #[serde(default)]
    pub icon: Option<String>,
    pub source: String,
    pub file_path: String,
}


/// Single result, discriminated by `kind`. Mirrors the TS
/// `MentionData` union field-for-field; `kind` is rendered in
/// snake_case so `kind: "past_message"` reads cleanly were it ever
/// added (today this enum doesn't include it).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum MentionResult {
    File {
        id: String,
        display_name: String,
        abs_path: String,
    },
    Folder {
        id: String,
        display_name: String,
        abs_path: String,
    },
    Symbol {
        id: String,
        display_name: String,
        signature: String,
        symbol_kind: String,
        file_path: String,
        line: u32,
    },
    Knowledge {
        id: String,
        display_name: String,
        icon: Option<String>,
        source: String,
        file_path: String,
        folder: Option<String>,
    },
    Repo {
        id: String,
        display_name: String,
        abs_path: String,
        has_readme: bool,
    },
    Paper {
        id: String,
        display_name: String,
        authors: Vec<String>,
        metadata_path: String,
    },
    Branch {
        id: String,
        display_name: String,
        sha: String,
        ref_kind: String,
        is_current: bool,
    },
}

fn matches_scope(scope: Option<&str>, kind: &str) -> bool {
    scope.is_none_or(|s| s == kind)
}

#[tauri::command]
pub async fn mention_search(
    query: String,
    scope: Option<String>,
    project_path: Option<String>,
    workspace_id: Option<String>,
    webview: WebviewWindow,
    fileindex: State<'_, FileIndexState>,
    papers: State<'_, SavedPapersIndex>,
    git_watcher: State<'_, GitWatcherState>,
    cache: State<'_, MentionCacheState>,
) -> Result<Vec<MentionResult>, String> {
    let label = workspace_id.unwrap_or_else(|| webview.label().to_string());
    let scope_ref = scope.as_deref();
    let trimmed = query.trim().to_string();

    let want_file = matches_scope(scope_ref, "file");
    let want_folder = matches_scope(scope_ref, "folder");
    let want_repo = matches_scope(scope_ref, "repo");
    let want_paper = matches_scope(scope_ref, "paper");
    let want_branch = matches_scope(scope_ref, "branch");
    let want_symbol = matches_scope(scope_ref, "symbol");
    let want_knowledge = matches_scope(scope_ref, "knowledge");

    // Pull file/folder snapshots ONCE (no redundant clone) directly
    // from the lock-protected state. snapshot_folders uses the
    // watcher-invalidated cache so the O(files × depth) derivation
    // only runs after a real file-set change — not per keystroke.
    let files_snapshot: Option<Vec<(String, PathBuf)>> = if want_file {
        fileindex.snapshot_files(&label).map(|(files, _)| files)
    } else {
        None
    };
    let folders_snapshot: Option<Vec<(String, PathBuf)>> = if want_folder {
        fileindex.snapshot_folders(&label)
    } else {
        None
    };

    let project_for_repo = project_path.clone();
    let project_for_paper = project_path.clone();
    let project_for_branch = project_path.clone();

    let trimmed_for_file = trimmed.clone();
    let trimmed_for_folder = trimmed.clone();
    let trimmed_for_repo = trimmed.clone();
    let trimmed_for_paper = trimmed.clone();
    let trimmed_for_branch = trimmed.clone();
    let trimmed_for_symbol = trimmed.clone();
    let trimmed_for_knowledge = trimmed.clone();

    let file_fut = async move {
        let Some(files) = files_snapshot else {
            return Vec::new();
        };
        rank_files(&trimmed_for_file, files)
    };

    let folder_fut = async move {
        let Some(folders) = folders_snapshot else {
            return Vec::new();
        };
        rank_folders(&trimmed_for_folder, folders)
    };

    let repo_fut = async move {
        if !want_repo {
            return Vec::new();
        }
        let Some(project_path) = project_for_repo else {
            return Vec::new();
        };
        match list_cloned_repos(project_path).await {
            Ok(rows) => rank_repos(&trimmed_for_repo, rows),
            Err(_) => Vec::new(),
        }
    };

    let papers_state = papers.clone();
    let paper_fut = async move {
        if !want_paper {
            return Vec::new();
        }
        let Some(project_path) = project_for_paper else {
            return Vec::new();
        };
        match list_saved_papers(project_path, papers_state).await {
            Ok(rows) => rank_papers(&trimmed_for_paper, rows),
            Err(_) => Vec::new(),
        }
    };

    // Branch refs come from a watcher-invalidated cache (see
    // `GitWatcherState::get_or_compute_refs`). First call per project
    // pays the ~80 ms of `git rev-parse` / `for-each-ref` shell-outs;
    // every subsequent keystroke is sub-microsecond until the
    // watcher flushes the cache on the next git mutation. Before
    // this cache the @-mention picker fired three `git` subprocesses
    // per keystroke and stuttered visibly on large repos.
    let cached_refs: Option<GitRefs> = match (&project_for_branch, want_branch) {
        (Some(p), true) => git_watcher.get_or_compute_refs(p),
        _ => None,
    };
    let branch_fut = async move {
        if !want_branch {
            return Vec::new();
        }
        let Some(refs) = cached_refs else {
            return Vec::new();
        };
        rank_branches(&trimmed_for_branch, refs)
    };

    // Pull from the cache instead of taking the data as an argument.
    // Cloning a few hundred entries here is sub-millisecond; the
    // savings come from NOT serializing+deserializing those
    // entries across the IPC boundary on every keystroke (the old
    // path could push 100-500 KB per keystroke on a project with
    // many symbols, which was the visible typing lag).
    // Symbols are sourced from the persisted codebase index, loaded lazily
    // into the per-window cache on the first symbol-search per project.
    if want_symbol {
        ensure_symbol_cache(cache.inner(), &label, project_path.as_deref()).await;
    }
    let symbols_data: Vec<SymbolInput> = if want_symbol {
        cache
            .per_window
            .read()
            .get(&label)
            .map(|c| c.symbols.clone())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let symbol_fut = async move {
        if !want_symbol {
            return Vec::new();
        }
        rank_symbols(&trimmed_for_symbol, symbols_data)
    };

    let knowledge_data: Vec<KnowledgeInput> = if want_knowledge {
        cache
            .per_window
            .read()
            .get(&label)
            .map(|c| c.knowledge.clone())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let knowledge_fut = async move {
        if !want_knowledge {
            return Vec::new();
        }
        rank_knowledge(&trimmed_for_knowledge, knowledge_data)
    };

    let (files, folders, repos, papers_res, branches, symbols_res, knowledge_res) = tokio::join!(
        file_fut, folder_fut, repo_fut, paper_fut, branch_fut, symbol_fut, knowledge_fut
    );

    if scope_ref.is_some() {
        // Scoped view: only one kind is populated — flatten and cap.
        let mut all: Vec<MentionResult> = Vec::new();
        for scored in [files, folders, symbols_res, knowledge_res, repos, papers_res, branches] {
            all.extend(scored.into_iter().map(|(_, m)| m));
        }
        return Ok(all.into_iter().take(PER_KIND_LIMIT).collect());
    }

    if trimmed.is_empty() {
        // Zero-query overview: a small slice of every kind so `@` alone
        // shows real results (Linear-style) instead of nothing. Symbols
        // are omitted — "the first N symbols in walk order" is noise.
        let mut all: Vec<MentionResult> = Vec::new();
        for (scored, cap) in [
            (files, 8),
            (folders, 4),
            (knowledge_res, 4),
            (repos, 3),
            (branches, 3),
            (papers_res, 3),
        ] {
            all.extend(scored.into_iter().take(cap).map(|(_, m)| m));
        }
        return Ok(all);
    }

    // Blended search: one ranked list across ALL kinds, sorted by nucleo
    // score (stable sort keeps per-kind order on ties), with a per-kind
    // cap so no single kind can push the rest below the fold.
    let mut all: Vec<(u32, MentionResult)> = Vec::new();
    for scored in [files, folders, symbols_res, knowledge_res, repos, papers_res, branches] {
        all.extend(scored);
    }
    all.sort_by(|a, b| b.0.cmp(&a.0));
    let mut per_kind: HashMap<&'static str, usize> = HashMap::new();
    let mut out: Vec<MentionResult> = Vec::new();
    for (_, m) in all {
        if out.len() >= TOTAL_LIMIT {
            break;
        }
        let count = per_kind.entry(kind_key(&m)).or_insert(0);
        if *count >= BLEND_PER_KIND {
            continue;
        }
        *count += 1;
        out.push(m);
    }
    Ok(out)
}

fn kind_key(m: &MentionResult) -> &'static str {
    match m {
        MentionResult::File { .. } => "file",
        MentionResult::Folder { .. } => "folder",
        MentionResult::Symbol { .. } => "symbol",
        MentionResult::Knowledge { .. } => "knowledge",
        MentionResult::Repo { .. } => "repo",
        MentionResult::Paper { .. } => "paper",
        MentionResult::Branch { .. } => "branch",
    }
}

// ── Per-kind ranking ────────────────────────────────────────────────────

/// Every rank fn returns `(score, result)` pairs so the unscoped caller can
/// blend across kinds; scoped callers just drop the score.
///
/// Empty-query fast path: no scoring, no full vec, no sort. The
/// caller is asking for "top N in some natural order" — for a
/// scoped picker view this is "the first N items as we have them."
/// Skipping nucleo for the empty case avoids the previous behavior
/// of allocating an N-entry scored vec + sort_by every keystroke
/// when no query has been typed yet.
fn rank_files(query: &str, files: Vec<(String, PathBuf)>) -> Vec<(u32, MentionResult)> {
    let to_result = |(rel, abs): (String, PathBuf)| {
        let abs_str = abs.to_string_lossy().into_owned();
        MentionResult::File {
            id: abs_str.clone(),
            display_name: rel,
            abs_path: abs_str,
        }
    };
    if query.is_empty() {
        return files
            .into_iter()
            .take(PER_KIND_LIMIT)
            .map(|f| (0, to_result(f)))
            .collect();
    }
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::default();
    let mut scored: Vec<(u32, (String, PathBuf))> = files
        .into_iter()
        .filter_map(|(rel, abs)| {
            let mut buf = Vec::new();
            let utf = Utf32Str::new(&rel, &mut buf);
            pattern.score(utf, &mut matcher).map(|s| (s, (rel, abs)))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(PER_KIND_LIMIT)
        .map(|(s, f)| (s, to_result(f)))
        .collect()
}

fn rank_folders(
    query: &str,
    folders: Vec<(String, PathBuf)>,
) -> Vec<(u32, MentionResult)> {
    let to_result = |(rel, abs): (String, PathBuf)| {
        let abs_str = abs.to_string_lossy().into_owned();
        MentionResult::Folder {
            id: abs_str.clone(),
            display_name: rel,
            abs_path: abs_str,
        }
    };
    if query.is_empty() {
        return folders
            .into_iter()
            .take(PER_KIND_LIMIT)
            .map(|f| (0, to_result(f)))
            .collect();
    }
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::default();
    let mut scored: Vec<(u32, (String, PathBuf))> = folders
        .into_iter()
        .filter_map(|(rel, abs)| {
            let mut buf = Vec::new();
            let utf = Utf32Str::new(&rel, &mut buf);
            pattern.score(utf, &mut matcher).map(|s| (s, (rel, abs)))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(PER_KIND_LIMIT)
        .map(|(s, f)| (s, to_result(f)))
        .collect()
}

fn rank_repos(query: &str, rows: Vec<ClonedRepo>) -> Vec<(u32, MentionResult)> {
    if query.is_empty() {
        return rows
            .into_iter()
            .take(PER_KIND_LIMIT)
            .map(|r| {
                (0, MentionResult::Repo {
                    id: r.path.clone(),
                    display_name: r.name,
                    abs_path: r.path,
                    has_readme: r.has_readme,
                })
            })
            .collect();
    }
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::default();
    let mut scored: Vec<(u32, ClonedRepo)> = rows
        .into_iter()
        .filter_map(|r| {
            let mut buf = Vec::new();
            let utf = Utf32Str::new(&r.name, &mut buf);
            pattern.score(utf, &mut matcher).map(|s| (s, r))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(PER_KIND_LIMIT)
        .map(|(s, r)| {
            (s, MentionResult::Repo {
                id: r.path.clone(),
                display_name: r.name,
                abs_path: r.path,
                has_readme: r.has_readme,
            })
        })
        .collect()
}

fn rank_papers(query: &str, rows: Vec<SavedPaper>) -> Vec<(u32, MentionResult)> {
    if query.is_empty() {
        return rows
            .into_iter()
            .take(PER_KIND_LIMIT)
            .map(|p| {
                (0, MentionResult::Paper {
                    id: p.id,
                    display_name: p.title,
                    authors: p.authors,
                    metadata_path: p.metadata_path,
                })
            })
            .collect();
    }
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::default();
    let mut scored: Vec<(u32, SavedPaper)> = rows
        .into_iter()
        .filter_map(|p| {
            let mut buf = Vec::new();
            let utf = Utf32Str::new(&p.title, &mut buf);
            pattern.score(utf, &mut matcher).map(|s| (s, p))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(PER_KIND_LIMIT)
        .map(|(s, p)| {
            (s, MentionResult::Paper {
                id: p.id,
                display_name: p.title,
                authors: p.authors,
                metadata_path: p.metadata_path,
            })
        })
        .collect()
}

fn rank_branches(query: &str, refs: GitRefs) -> Vec<(u32, MentionResult)> {
    let pool: Vec<GitRef> = refs
        .refs
        .into_iter()
        .filter(|r| r.kind == "branch" || r.kind == "remote")
        .collect();
    if query.is_empty() {
        return pool
            .into_iter()
            .take(PER_KIND_LIMIT)
            .map(|r| {
                (0, MentionResult::Branch {
                    id: r.name.clone(),
                    display_name: r.name,
                    sha: r.sha,
                    ref_kind: r.kind,
                    is_current: r.is_current,
                })
            })
            .collect();
    }
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::default();
    let mut scored: Vec<(u32, GitRef)> = pool
        .into_iter()
        .filter_map(|r| {
            let mut buf = Vec::new();
            let utf = Utf32Str::new(&r.name, &mut buf);
            pattern.score(utf, &mut matcher).map(|s| (s, r))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(PER_KIND_LIMIT)
        .map(|(s, r)| {
            (s, MentionResult::Branch {
                id: r.name.clone(),
                display_name: r.name,
                sha: r.sha,
                ref_kind: r.kind,
                is_current: r.is_current,
            })
        })
        .collect()
}

fn rank_symbols(query: &str, symbols: Vec<SymbolInput>) -> Vec<(u32, MentionResult)> {
    if query.is_empty() {
        return symbols
            .into_iter()
            .take(PER_KIND_LIMIT)
            .map(|s| {
                (0, MentionResult::Symbol {
                    id: format!("{}@{}:{}", s.name, s.file_path, s.line),
                    display_name: s.name,
                    signature: s.signature,
                    symbol_kind: s.kind,
                    file_path: s.file_path,
                    line: s.line,
                })
            })
            .collect();
    }
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::default();
    let mut scored: Vec<(u32, SymbolInput)> = symbols
        .into_iter()
        .filter_map(|s| {
            let mut buf = Vec::new();
            let utf = Utf32Str::new(&s.name, &mut buf);
            pattern.score(utf, &mut matcher).map(|sc| (sc, s))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(PER_KIND_LIMIT)
        .map(|(sc, s)| {
            (sc, MentionResult::Symbol {
                id: format!("{}@{}:{}", s.name, s.file_path, s.line),
                display_name: s.name,
                signature: s.signature,
                symbol_kind: s.kind,
                file_path: s.file_path,
                line: s.line,
            })
        })
        .collect()
}

fn rank_knowledge(query: &str, entries: Vec<KnowledgeInput>) -> Vec<(u32, MentionResult)> {
    if query.is_empty() {
        return entries
            .into_iter()
            .take(PER_KIND_LIMIT)
            .map(|e| {
                let folder = e.id.rfind('/').map(|i| e.id[..i].to_string());
                (0, MentionResult::Knowledge {
                    id: e.id,
                    display_name: e.title,
                    icon: e.icon,
                    source: e.source,
                    file_path: e.file_path,
                    folder,
                })
            })
            .collect();
    }
    // Match against `title + " " + folder` so typing a space name
    // surfaces its entries — parity with the prior JS behavior.
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::default();
    let mut scored: Vec<(u32, KnowledgeInput, Option<String>)> = entries
        .into_iter()
        .map(|e| {
            let folder = e.id.rfind('/').map(|i| e.id[..i].to_string());
            (e, folder)
        })
        .filter_map(|(e, folder)| {
            let haystack = match &folder {
                Some(f) => format!("{} {}", e.title, f),
                None => e.title.clone(),
            };
            let mut buf = Vec::new();
            let utf = Utf32Str::new(&haystack, &mut buf);
            pattern.score(utf, &mut matcher).map(|s| (s, e, folder))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(PER_KIND_LIMIT)
        .map(|(s, e, folder)| {
            (s, MentionResult::Knowledge {
                id: e.id,
                display_name: e.title,
                icon: e.icon,
                source: e.source,
                file_path: e.file_path,
                folder,
            })
        })
        .collect()
}

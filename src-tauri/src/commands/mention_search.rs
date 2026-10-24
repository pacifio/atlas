//! Unified `mention_search` command — replaces the JS-side per-provider
//! fan-out + ranking in `src/features/chat/lib/mentions.ts`.
//!
//! Previously: each keystroke in the picker triggered N parallel JS
//! providers (`Promise.allSettled([files, folders, knowledge,
//! repos, branches])`), each invoking its own Tauri command
//! and returning results, then JS ran `rankMention` to blend + sort.
//! That's per-keystroke N+1 IPCs + JS-side fuzzy scoring across all
//! results.
//!
//! Now: one Tauri command. Rust reads the data sources it already
//! owns (file/folder via the live `FileIndexState`, repo via
//! existing computes, branch via `git_refs_compute`). Knowledge is
//! passed in from the frontend cache that already mirrors Rust
//! state — the input is small (a few hundred entries) and the
//! alternative (a second Rust cache layer for it) was a larger
//! refactor without payoff for this round. All five kinds
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

use super::fileindex::{FileIndexState, IndexedFile};
use super::git::{GitRef, GitRefs};
use super::git_watcher::GitWatcherState;
use super::github::{list_cloned_repos, ClonedRepo};

const PER_KIND_LIMIT: usize = 30;
/// Unscoped blend: cap any one kind so files can't crowd every other
/// kind out of the list (the old concat-then-truncate did exactly that).
const BLEND_PER_KIND: usize = 10;
const TOTAL_LIMIT: usize = 40;

/// Per-process cache of the mention-search inputs that aren't already held in
/// a lock-protected Rust state. Knowledge entries are pushed in from JS
/// (`useKnowledgeStore`) via `mention_cache_set_knowledge`. Read by
/// `mention_search`.
///
/// Why this exists: before the cache, every @-picker keystroke
/// serialized the full knowledge array from JS to JSON, shipped it
/// over IPC to Rust, then Rust deserialized it — JSON encode +
/// decode work on the JS main thread per keystroke, the perceived
/// typing lag in the picker. With the cache the per-keystroke
/// payload is just `(query, scope, project_path)` (a few hundred
/// bytes) and the heavy data sits hot in Rust.
/// Per-WINDOW caches (keyed by webview label), for the same reason as
/// `FileIndexState`: `.manage()` state is process-global, so a single cache
/// would let window B's knowledge leak into window A's @-mentions.
#[derive(Default)]
struct WindowCache {
    knowledge: Vec<KnowledgeInput>,
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

#[tauri::command(async)]
pub fn mention_cache_set_knowledge(
    items: Vec<KnowledgeInput>,
    workspace_id: Option<String>,
    webview: WebviewWindow,
    state: State<'_, MentionCacheState>,
) {
    let key = workspace_id.unwrap_or_else(|| webview.label().to_string());
    state.per_window.write().entry(key).or_default().knowledge = items;
}

#[tauri::command(async)]
pub fn mention_cache_clear(
    workspace_id: Option<String>,
    webview: WebviewWindow,
    state: State<'_, MentionCacheState>,
) {
    let key = workspace_id.unwrap_or_else(|| webview.label().to_string());
    state.per_window.write().remove(&key);
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
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
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
#[allow(clippy::too_many_arguments)] // a Tauri command takes its state as arguments
pub async fn mention_search(
    query: String,
    scope: Option<String>,
    project_path: Option<String>,
    workspace_id: Option<String>,
    webview: WebviewWindow,
    fileindex: State<'_, FileIndexState>,
    git_watcher: State<'_, GitWatcherState>,
    cache: State<'_, MentionCacheState>,
) -> Result<Vec<MentionResult>, String> {
    let label = workspace_id.unwrap_or_else(|| webview.label().to_string());
    let scope_ref = scope.as_deref();
    let trimmed = query.trim().to_string();

    let want_file = matches_scope(scope_ref, "file");
    let want_folder = matches_scope(scope_ref, "folder");
    let want_repo = matches_scope(scope_ref, "repo");
    let want_branch = matches_scope(scope_ref, "branch");
    let want_knowledge = matches_scope(scope_ref, "knowledge");

    // Take POINTERS to the file and folder lists, not copies of them. Both
    // rankers keep `PER_KIND_LIMIT` (30) results, and deep-cloning a whole
    // project's index on each keystroke to choose thirty of it was the
    // picker's remaining per-keystroke cost. `snapshot_folders` uses the
    // watcher-invalidated cache, so the O(files × depth) derivation still only
    // runs after a real file-set change.
    let files_snapshot = if want_file {
        fileindex.files_arc(&label).map(|(files, _)| files)
    } else {
        None
    };
    let folders_snapshot = if want_folder {
        fileindex.snapshot_folders(&label)
    } else {
        None
    };

    let project_for_repo = project_path.clone();
    let project_for_branch = project_path.clone();

    let trimmed_for_file = trimmed.clone();
    let trimmed_for_folder = trimmed.clone();
    let trimmed_for_repo = trimmed.clone();
    let trimmed_for_branch = trimmed.clone();
    let trimmed_for_knowledge = trimmed.clone();

    let file_fut = async move {
        let Some(files) = files_snapshot else {
            return Vec::new();
        };
        // Matching is pure CPU with no `.await`, so holding the read lock
        // across it is fine — and is what keeps the list from being copied.
        let guard = files.read();
        rank_files(&trimmed_for_file, &guard)
    };

    let folder_fut = async move {
        let Some(folders) = folders_snapshot else {
            return Vec::new();
        };
        rank_folders(&trimmed_for_folder, &folders)
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
    // many entries, which was the visible typing lag).
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

    let (files, folders, repos, branches, knowledge_res) =
        tokio::join!(file_fut, folder_fut, repo_fut, branch_fut, knowledge_fut);

    if scope_ref.is_some() {
        // Scoped view: only one kind is populated — flatten and cap.
        let mut all: Vec<MentionResult> = Vec::new();
        for scored in [files, folders, knowledge_res, repos, branches] {
            all.extend(scored.into_iter().map(|(_, m)| m));
        }
        return Ok(all.into_iter().take(PER_KIND_LIMIT).collect());
    }

    if trimmed.is_empty() {
        // Zero-query overview: a small slice of every kind so `@` alone
        // shows real results (Linear-style) instead of nothing.
        let mut all: Vec<MentionResult> = Vec::new();
        for (scored, cap) in [
            (files, 8),
            (folders, 4),
            (knowledge_res, 4),
            (repos, 3),
            (branches, 3),
        ] {
            all.extend(scored.into_iter().take(cap).map(|(_, m)| m));
        }
        return Ok(all);
    }

    // Blended search: one ranked list across ALL kinds, sorted by nucleo
    // score (stable sort keeps per-kind order on ties), with a per-kind
    // cap so no single kind can push the rest below the fold.
    let mut all: Vec<(u32, MentionResult)> = Vec::new();
    for scored in [files, folders, knowledge_res, repos, branches] {
        all.extend(scored);
    }
    all.sort_by_key(|entry| std::cmp::Reverse(entry.0));
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
        MentionResult::Knowledge { .. } => "knowledge",
        MentionResult::Repo { .. } => "repo",
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
/// Borrows the index and allocates only for the results it keeps.
fn rank_files(query: &str, files: &[IndexedFile]) -> Vec<(u32, MentionResult)> {
    let to_result = |f: &IndexedFile| {
        let abs_str = f.path.to_string_lossy().into_owned();
        MentionResult::File {
            id: abs_str.clone(),
            display_name: f.rel.clone(),
            abs_path: abs_str,
        }
    };
    if query.is_empty() {
        return files
            .iter()
            .take(PER_KIND_LIMIT)
            .map(|f| (0, to_result(f)))
            .collect();
    }
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::default();
    let mut buf = Vec::new();
    let mut scored: Vec<(u32, &IndexedFile)> = files
        .iter()
        .filter_map(|f| {
            let utf = Utf32Str::new(&f.rel, &mut buf);
            pattern.score(utf, &mut matcher).map(|s| (s, f))
        })
        .collect();
    scored.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    scored
        .into_iter()
        .take(PER_KIND_LIMIT)
        .map(|(s, f)| (s, to_result(f)))
        .collect()
}

/// Borrows the cached folder list and allocates only for the results it keeps.
fn rank_folders(query: &str, folders: &[(String, PathBuf)]) -> Vec<(u32, MentionResult)> {
    let to_result = |(rel, abs): &(String, PathBuf)| {
        let abs_str = abs.to_string_lossy().into_owned();
        MentionResult::Folder {
            id: abs_str.clone(),
            display_name: rel.clone(),
            abs_path: abs_str,
        }
    };
    if query.is_empty() {
        return folders
            .iter()
            .take(PER_KIND_LIMIT)
            .map(|f| (0, to_result(f)))
            .collect();
    }
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::default();
    let mut buf = Vec::new();
    let mut scored: Vec<(u32, &(String, PathBuf))> = folders
        .iter()
        .filter_map(|f| {
            let utf = Utf32Str::new(&f.0, &mut buf);
            pattern.score(utf, &mut matcher).map(|s| (s, f))
        })
        .collect();
    scored.sort_by_key(|entry| std::cmp::Reverse(entry.0));
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
                (
                    0,
                    MentionResult::Repo {
                        id: r.path.clone(),
                        display_name: r.name,
                        abs_path: r.path,
                        has_readme: r.has_readme,
                    },
                )
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
    scored.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    scored
        .into_iter()
        .take(PER_KIND_LIMIT)
        .map(|(s, r)| {
            (
                s,
                MentionResult::Repo {
                    id: r.path.clone(),
                    display_name: r.name,
                    abs_path: r.path,
                    has_readme: r.has_readme,
                },
            )
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
                (
                    0,
                    MentionResult::Branch {
                        id: r.name.clone(),
                        display_name: r.name,
                        sha: r.sha,
                        ref_kind: r.kind,
                        is_current: r.is_current,
                    },
                )
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
    scored.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    scored
        .into_iter()
        .take(PER_KIND_LIMIT)
        .map(|(s, r)| {
            (
                s,
                MentionResult::Branch {
                    id: r.name.clone(),
                    display_name: r.name,
                    sha: r.sha,
                    ref_kind: r.kind,
                    is_current: r.is_current,
                },
            )
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
                (
                    0,
                    MentionResult::Knowledge {
                        id: e.id,
                        display_name: e.title,
                        icon: e.icon,
                        source: e.source,
                        file_path: e.file_path,
                        folder,
                    },
                )
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
    scored.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    scored
        .into_iter()
        .take(PER_KIND_LIMIT)
        .map(|(s, e, folder)| {
            (
                s,
                MentionResult::Knowledge {
                    id: e.id,
                    display_name: e.title,
                    icon: e.icon,
                    source: e.source,
                    file_path: e.file_path,
                    folder,
                },
            )
        })
        .collect()
}

/// Per-keystroke cost of ranking the file index, borrowed vs copied. Not a
/// correctness test — run it by hand after touching that path:
///
/// ```text
/// cargo test -p atlas --lib mention_search::perf -- --ignored --nocapture
/// ```
#[cfg(test)]
mod perf {
    use super::*;
    use std::time::Instant;

    /// The old path, reproduced exactly: `snapshot_files` deep-copied every
    /// entry, `rank_files` consumed that copy, and the match buffer was
    /// allocated per candidate rather than once.
    fn rank_files_old(query: &str, files: Vec<(String, PathBuf)>) -> Vec<(u32, MentionResult)> {
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
        scored.sort_by_key(|entry| std::cmp::Reverse(entry.0));
        scored
            .into_iter()
            .take(PER_KIND_LIMIT)
            .map(|(s, f)| (s, to_result(f)))
            .collect()
    }

    fn index(count: usize) -> Vec<IndexedFile> {
        (0..count)
            .map(|i| {
                // Every fifth path is non-ASCII: `Utf32Str::new` only touches
                // the shared match buffer for non-ASCII input, so an all-ASCII
                // fixture never exercises the buffer reuse this module hoists.
                let dir = if i % 5 == 0 { "café" } else { "area" };
                IndexedFile {
                    rel: format!("src/features/{dir}{}/components/widget-{i}.tsx", i % 40),
                    path: PathBuf::from(format!(
                        "/Users/dev/project/src/features/{dir}{}/components/widget-{i}.tsx",
                        i % 40
                    )),
                }
            })
            .collect()
    }

    /// The borrowed ranker must answer exactly what the owned one did —
    /// including the reused match buffer, which `fileindex_search` hoists the
    /// same way.
    #[test]
    fn borrowing_the_index_ranks_identically() {
        let files = index(400);
        for query in [
            "",
            "widget",
            "area3",
            "wdgt",
            "WIDGET",
            "components/widget-7",
            "zzz",
            "café",
            "caf",
        ] {
            let owned: Vec<(String, PathBuf)> = files
                .iter()
                .map(|f| (f.rel.clone(), f.path.clone()))
                .collect();
            // `MentionResult` is a wire type without `PartialEq`; compare the
            // fields the picker actually shows, in order, with their scores.
            let shown = |v: Vec<(u32, MentionResult)>| {
                v.into_iter()
                    .map(|(score, m)| match m {
                        MentionResult::File {
                            id,
                            display_name,
                            abs_path,
                        } => (score, id, display_name, abs_path),
                        other => panic!("rank_files yielded a non-file: {other:?}"),
                    })
                    .collect::<Vec<_>>()
            };
            assert_eq!(
                shown(rank_files(query, &files)),
                shown(rank_files_old(query, owned)),
                "query {query:?}"
            );
        }
    }

    #[test]
    #[ignore = "measurement, not a gate"]
    fn ranking_the_index_does_not_copy_it() {
        const KEYSTROKES: usize = 200;
        println!();
        for count in [5_000usize, 20_000, 50_000] {
            let files = index(count);

            // Before: snapshot_files' deep copy, then rank consumes it.
            let t = Instant::now();
            for _ in 0..KEYSTROKES {
                let copied: Vec<(String, PathBuf)> = files
                    .iter()
                    .map(|f| (f.rel.clone(), f.path.clone()))
                    .collect();
                std::hint::black_box(rank_files_old("widget", copied));
            }
            let before = t.elapsed().as_micros() as f64 / KEYSTROKES as f64;

            // After: rank borrows the index under its read lock.
            let t = Instant::now();
            for _ in 0..KEYSTROKES {
                std::hint::black_box(rank_files("widget", &files));
            }
            let after = t.elapsed().as_micros() as f64 / KEYSTROKES as f64;

            println!(
                "  {count:>6} files   before: {before:>8.0} µs/keystroke   after: {after:>7.0} µs   {:.1}x",
                before / after
            );
        }
        println!();
    }
}

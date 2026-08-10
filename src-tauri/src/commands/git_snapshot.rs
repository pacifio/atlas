//! One-shot repository snapshot for the Source-Control UI.
//!
//! Replaces the fan-out where a single `atlas:git-changed` event triggered
//! six separate IPC loaders (status, branches ×2, log, diff, in-progress) —
//! 10-25 git spawns per change. `git_snapshot` answers with everything the
//! panel headers need in ~4 concurrent spawns, and concurrent callers for
//! the same repo coalesce onto one in-flight computation.
//!
//! Status uses `--porcelain=2` (parsed in `atlas-git`): rename detection,
//! submodule codes, conflict codes, and branch/ahead/behind all arrive in
//! the same spawn — no more `--no-renames` / `--ignore-submodules=all`.

use atlas_git::{status as gstatus, GitCommand, GitErrorCode, GitErrorPayload};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use crate::commands::git_ops::{self, BranchInfo, InProgress, StashEntry};

/// One changed path. `status` is a word ("modified", "added", "deleted",
/// "renamed", "untracked", "conflicted", "copied") — the UI routes badges
/// and revert semantics on substrings of it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotFile {
    pub path: String,
    pub status: String,
    pub staged: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
    pub conflicted: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshot {
    pub is_repo: bool,
    pub branch: String,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<SnapshotFile>,
    pub branches: Vec<BranchInfo>,
    pub stashes: Vec<StashEntry>,
    pub in_progress: Option<InProgress>,
}

fn status_word(c: char) -> &'static str {
    match c {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'M' | 'T' => "modified",
        '?' => "untracked",
        _ => "modified",
    }
}

/// Map porcelain-v2 entries to UI rows. A file changed in BOTH the index and
/// the worktree yields two rows (one staged, one not) — matching how GitHub
/// Desktop and the Changes view split the lists.
fn to_files(entries: &[gstatus::StatusEntry]) -> Vec<SnapshotFile> {
    let mut files = Vec::with_capacity(entries.len());
    for e in entries {
        if e.unmerged.is_some() {
            files.push(SnapshotFile {
                path: e.path.clone(),
                status: "conflicted".into(),
                staged: false,
                orig_path: None,
                conflicted: true,
            });
            continue;
        }
        if e.untracked {
            files.push(SnapshotFile {
                path: e.path.clone(),
                status: "untracked".into(),
                staged: false,
                orig_path: None,
                conflicted: false,
            });
            continue;
        }
        if e.index != '.' {
            files.push(SnapshotFile {
                path: e.path.clone(),
                status: status_word(e.index).into(),
                staged: true,
                orig_path: e.orig_path.clone(),
                conflicted: false,
            });
        }
        if e.worktree != '.' {
            files.push(SnapshotFile {
                path: e.path.clone(),
                status: status_word(e.worktree).into(),
                staged: false,
                orig_path: None,
                conflicted: false,
            });
        }
    }
    files
}

async fn compute(path: String) -> Result<GitSnapshot, GitErrorPayload> {
    let status_path = path.clone();
    let status_fut = tokio::task::spawn_blocking(move || {
        GitCommand::new(&status_path, &["status", "--porcelain=2", "--branch", "-z"])
            .read_only()
            .run()
    });
    let branches_fut = git_ops::git_branches_full(path.clone());
    let stashes_fut = git_ops::git_stash_list(path.clone());
    let inprog_fut = git_ops::git_inprogress(path.clone());

    let (status_res, branches, stashes, inprog) =
        tokio::join!(status_fut, branches_fut, stashes_fut, inprog_fut);

    let status_out = match status_res.map_err(|e| GitErrorPayload::internal(e.to_string()))? {
        Ok(out) => out,
        // Not a work tree → the well-known empty shape, not an error.
        Err(e) if e.code == GitErrorCode::NotARepository => {
            return Ok(GitSnapshot::default());
        }
        Err(e) => return Err(e),
    };

    let parsed = gstatus::parse(status_out.stdout.as_bytes());
    let ip = inprog.unwrap_or(InProgress {
        merge: false,
        rebase: false,
        cherry_pick: false,
        revert: false,
    });
    let any_in_progress = ip.merge || ip.rebase || ip.cherry_pick || ip.revert;

    Ok(GitSnapshot {
        is_repo: true,
        branch: parsed.branch.clone().unwrap_or_default(),
        detached: parsed.detached,
        upstream: parsed.upstream.clone(),
        ahead: parsed.ahead,
        behind: parsed.behind,
        files: to_files(&parsed.entries),
        branches: branches.unwrap_or_default(),
        stashes: stashes.unwrap_or_default(),
        in_progress: if any_in_progress { Some(ip) } else { None },
    })
}

type SnapshotCell = Arc<tokio::sync::OnceCell<Result<GitSnapshot, GitErrorPayload>>>;

fn inflight() -> &'static Mutex<HashMap<String, SnapshotCell>> {
    static MAP: OnceLock<Mutex<HashMap<String, SnapshotCell>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Everything the Source-Control panel headers need in one IPC call.
/// Concurrent calls for the same repo share one computation (the debounced
/// watcher, the store's own refresh and the workspace sidebar all land here
/// after a commit — only the first pays).
#[tauri::command]
pub async fn git_snapshot(path: String) -> Result<GitSnapshot, GitErrorPayload> {
    let (cell, owner) = {
        let mut map = inflight().lock().expect("snapshot inflight lock");
        match map.get(&path) {
            Some(c) => (c.clone(), false),
            None => {
                let c: SnapshotCell = Arc::new(tokio::sync::OnceCell::new());
                map.insert(path.clone(), c.clone());
                (c, true)
            }
        }
    };

    let result = cell
        .get_or_init(|| compute(path.clone()))
        .await
        .clone();

    if owner {
        inflight().lock().expect("snapshot inflight lock").remove(&path);
    }
    result
}

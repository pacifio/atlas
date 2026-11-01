use atlas_git::{GitCommand, GitErrorPayload};
use serde::{Deserialize, Serialize};
use std::process::Command;

/// `git` for a READ-ONLY query — status, log, diff, blame, rev-parse, refs.
///
/// **Every read in this module must go through this, not a bare `git` spawn.**
///
/// `git status` (and friends) opportunistically REFRESH the index's stat cache,
/// which means taking `.git/index.lock`. That is invisible until something else
/// wants the index at the same moment — and in Atlas something always does: the
/// file watcher fires a status refresh on every write, so `git commit` run from
/// inside the app (or from a terminal, while the app is open on the same repo)
/// races our own polling. The failure surfaces far from here, as a `git add`
/// that exits non-zero — e.g. lint-staged's "Failed to stage changes from
/// tasks", which is a lost commit, not a lint error.
///
/// `--no-optional-locks` tells git to skip exactly those non-essential index
/// writes, so a background read can never block a user-initiated mutation. It
/// is what Desktop and VS Code pass on every status call, and what
/// `atlas_git::GitCommand::read_only()` already does for the source-control
/// crate — this module predates that crate and spawns git directly.
///
/// Only for reads: a command that is SUPPOSED to write the index (`add`,
/// `commit`, `checkout`) must take the lock, so it uses plain `Command`.
fn git_read() -> Command {
    let mut cmd = atlas_process::command("git");
    cmd.arg("--no-optional-locks");
    cmd
}

/// Async twin of [`git_read`], for the parallel status refresh.
fn git_read_async() -> tokio::process::Command {
    let mut cmd = atlas_process::async_command("git");
    cmd.arg("--no-optional-locks");
    cmd
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: String,
    pub files: Vec<GitFileStatus>,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitFileStatus {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

#[derive(Debug, Serialize)]
pub struct GitLogEntry {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    pub email: String,
    pub date: String,
    /// Committer time as unix milliseconds (0 if unparsable). Added for the
    /// memory timeline; `date` stays the relative string the git-graph uses.
    pub committed_at_ms: i64,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitRef {
    pub name: String, // short ref name, e.g. "main", "feature/x", "v1.2"
    pub sha: String,
    pub kind: String, // "branch" | "remote" | "tag"
    pub is_current: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitRefs {
    pub head: Option<String>,
    pub head_ref: Option<String>,
    pub refs: Vec<GitRef>,
}

/// Force-fresh status — skips the stale-while-revalidate cache read and
/// computes synchronously, returning the result directly (no event detour).
///
/// Used for changes Atlas *originates* and therefore already knows about:
/// git mutations (stage / unstage / commit / discard / checkout …) and
/// editor saves. Those don't need to wait for the `.git` / project fs
/// watcher to notice — calling this right after the action lands makes the
/// Changes panel and file-tree dots update in one lean `git status`
/// (~50–120 ms) instead of FSEvents-latency + debounce + a stale round-trip.
#[tauri::command]
pub async fn git_status_fresh(path: String) -> Result<GitStatus, String> {
    git_status_compute(&path).await
}

/// The actual git work — parallel subprocesses, filtered flags.
/// Called both inline (cache miss) and in the background (cache refresh).
async fn git_status_compute(path: &str) -> Result<GitStatus, String> {
    // branch / status / ahead-behind in parallel. We intentionally DON'T
    // gate on a preliminary `rev-parse --is-inside-work-tree` — that was a
    // serial subprocess on the hot path (every refresh paid one extra `git`
    // spawn before the real work). Instead we infer repo-ness from the
    // `git status` exit code below: it fails fast outside a work tree.
    //   --ignore-submodules=all   skips per-submodule recursion — biggest
    //                             win on monorepos.
    //   --no-renames              skips O(adds × dels) rename detection.
    let branch_fut = git_read_async()
        .args(["branch", "--show-current"])
        .current_dir(path)
        .output();
    let status_fut = git_read_async()
        .args([
            "status",
            "--porcelain=v1",
            "--ignore-submodules=all",
            "--no-renames",
        ])
        .current_dir(path)
        .output();
    let ab_fut = git_read_async()
        .args(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])
        .current_dir(path)
        .output();

    let (branch_res, status_res, ab_res) = tokio::join!(branch_fut, status_fut, ab_fut);

    // Not a work tree (or git missing) → `git status` errored. Return the
    // empty not-a-repo shape, same as the old `rev-parse` gate did.
    let status_out = match status_res {
        Ok(out) if out.status.success() => out,
        _ => {
            return Ok(GitStatus {
                is_repo: false,
                branch: String::new(),
                files: vec![],
                ahead: 0,
                behind: 0,
            });
        }
    };

    let branch = branch_res
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    let status_str = String::from_utf8_lossy(&status_out.stdout);
    let files: Vec<GitFileStatus> = status_str
        .lines()
        .filter(|l| l.len() >= 3)
        .map(|line| {
            let index = line.chars().next().unwrap_or(' ');
            let worktree = line.chars().nth(1).unwrap_or(' ');
            let file_path = line[3..].to_string();
            let (status, staged) = if index != ' ' && index != '?' {
                (index.to_string(), true)
            } else if worktree == '?' {
                ("?".to_string(), false)
            } else {
                (worktree.to_string(), false)
            };
            GitFileStatus {
                path: file_path,
                status,
                staged,
            }
        })
        .collect();

    let (ahead, behind) = match ab_res {
        Ok(out) => {
            let s = String::from_utf8_lossy(&out.stdout);
            let parts: Vec<&str> = s.trim().split('\t').collect();
            if parts.len() == 2 {
                (parts[0].parse().unwrap_or(0), parts[1].parse().unwrap_or(0))
            } else {
                (0, 0)
            }
        }
        Err(_) => (0, 0),
    };

    Ok(GitStatus {
        is_repo: true,
        branch,
        files,
        ahead,
        behind,
    })
}

/// Synchronous core of `git_log` — extracted as a `pub(crate)` helper
/// so `git_graph_build` can call it directly inside a `tokio::join!`
/// without going through the Tauri command boundary (which would be
/// awkward + needlessly serialize the result twice).
pub(crate) fn git_log_compute(
    path: &str,
    limit: u32,
    all: bool,
) -> Result<Vec<GitLogEntry>, String> {
    let n = limit.to_string();
    let mut args: Vec<String> = vec![
        "log".into(),
        format!("-{}", n),
        "--topo-order".into(),
        "--decorate=short".into(),
        "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%cr%x1f%P%x1f%D%x1f%ct%x1e".into(),
    ];
    if all {
        args.push("--all".into());
    }
    let output = git_read()
        .args(&args)
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;

    let log_str = String::from_utf8_lossy(&output.stdout);
    let entries = log_str
        .split('\x1e')
        .map(|s| s.trim_start_matches('\n'))
        .filter(|s| !s.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\x1f').collect();
            if parts.len() < 8 {
                return None;
            }
            let parents: Vec<String> = parts[6]
                .split_whitespace()
                .map(std::string::ToString::to_string)
                .collect();
            let refs: Vec<String> = parts[7]
                .split(',')
                .map(|r| r.trim().to_string())
                .filter(|r| !r.is_empty())
                .collect();
            let committed_at_ms = parts
                .get(8)
                .and_then(|s| s.trim().parse::<i64>().ok())
                .map(|secs| secs * 1000)
                .unwrap_or(0);
            Some(GitLogEntry {
                hash: parts[0].to_string(),
                short_hash: parts[1].to_string(),
                message: parts[2].to_string(),
                author: parts[3].to_string(),
                email: parts[4].to_string(),
                date: parts[5].to_string(),
                committed_at_ms,
                parents,
                refs,
            })
        })
        .collect();
    Ok(entries)
}

/// How many commits `git_log_compute` would walk with no limit — the same
/// scope (`HEAD`, or every ref with `all`). `None` on any failure (empty
/// repo, unborn HEAD); callers fall back to the rows they loaded.
pub(crate) fn git_commit_count(path: &str, all: bool) -> Option<usize> {
    let scope = if all { "--all" } else { "HEAD" };
    let output = git_read()
        .args(["rev-list", "--count", scope])
        .current_dir(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

#[tauri::command]
pub async fn git_log(
    path: String,
    limit: Option<u32>,
    all: Option<bool>,
) -> Result<Vec<GitLogEntry>, String> {
    let lim = limit.unwrap_or(50);
    // Defaults to the checked-out branch, like `git log` itself. Every consumer
    // of THIS command is branch-scoped: the Source-Control History list sits
    // under a toolbar naming the current branch and offers reset/revert against
    // what it shows, and the Review panel pre-selects its newest entry. Under
    // `--all` both silently reach commits that are not on HEAD. The commit graph
    // genuinely wants every ref, and asks for it explicitly via
    // `git_graph_build(all: true)`.
    let all_flag = all.unwrap_or(false);
    tokio::task::spawn_blocking(move || git_log_compute(&path, lim, all_flag))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn git_refs_compute(path: &str) -> Result<GitRefs, String> {
    let head_sha = git_read()
        .args(["rev-parse", "HEAD"])
        .current_dir(path)
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        });
    let head_ref = git_read()
        .args(["symbolic-ref", "--quiet", "--short", "HEAD"])
        .current_dir(path)
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        });

    let out = git_read()
        .args([
            "for-each-ref",
            "--format=%(refname:short)\x1f%(objectname)\x1f%(refname)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;
    let txt = String::from_utf8_lossy(&out.stdout);
    let mut refs: Vec<GitRef> = Vec::new();
    for line in txt.lines() {
        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() < 3 {
            continue;
        }
        let name = parts[0].to_string();
        let sha = parts[1].to_string();
        let full = parts[2];
        let kind = if full.starts_with("refs/tags/") {
            "tag"
        } else if full.starts_with("refs/remotes/") {
            "remote"
        } else {
            "branch"
        }
        .to_string();
        let is_current = head_ref.as_deref() == Some(&name);
        refs.push(GitRef {
            name,
            sha,
            kind,
            is_current,
        });
    }
    Ok(GitRefs {
        head: head_sha,
        head_ref,
        refs,
    })
}

#[tauri::command]
pub async fn git_graph_signature(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let head = git_read()
            .args(["rev-parse", "HEAD"])
            .current_dir(&path)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        let refs_out = git_read()
            .args(["for-each-ref", "--format=%(refname) %(objectname)"])
            .current_dir(&path)
            .output()
            .map_err(|e| e.to_string())?;
        let refs_text = String::from_utf8_lossy(&refs_out.stdout).to_string();
        let mut lines: Vec<String> = refs_text
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        lines.sort();
        let joined = lines.join("\n");
        // Cheap stable signature — full sha is overkill; we just hash a small djb2.
        let mut h: u64 = 5381;
        for b in head.bytes().chain(joined.bytes()) {
            h = h.wrapping_mul(33) ^ (b as u64);
        }
        Ok(format!("{head}-{h:016x}"))
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Compact per-project git summary for the project sidebar: branch, latest
/// commit subject, dirty flag (green/yellow dot), and working-tree +/- counts.
/// One command (a few cheap git calls) so the sidebar doesn't fan out several
/// IPC round-trips per project.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitProjectSummary {
    pub is_repo: bool,
    pub branch: String,
    pub head_subject: String,
    pub dirty: bool,
    pub additions: u32,
    pub deletions: u32,
}

#[tauri::command]
pub async fn git_workspace_summary(path: String) -> Result<GitProjectSummary, String> {
    tokio::task::spawn_blocking(move || {
        let git = |args: &[&str]| -> Option<String> {
            let out = git_read().args(args).current_dir(&path).output().ok()?;
            if !out.status.success() {
                return None;
            }
            Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
        };

        let is_repo = git(&["rev-parse", "--is-inside-work-tree"])
            .map(|s| s == "true")
            .unwrap_or(false);
        if !is_repo {
            return GitProjectSummary {
                is_repo: false,
                branch: String::new(),
                head_subject: String::new(),
                dirty: false,
                additions: 0,
                deletions: 0,
            };
        }

        let branch = git(&["branch", "--show-current"])
            .filter(|s| !s.is_empty())
            .or_else(|| git(&["rev-parse", "--short", "HEAD"]).map(|s| format!("@{s}")))
            .unwrap_or_default();
        let head_subject = git(&["log", "-1", "--pretty=%s"]).unwrap_or_default();
        let dirty = git(&["status", "--porcelain"])
            .map(|s| !s.is_empty())
            .unwrap_or(false);

        // additions/deletions from working tree vs HEAD (tracked changes).
        let (mut additions, mut deletions) = (0u32, 0u32);
        if let Some(numstat) = git(&["diff", "--numstat", "HEAD"]) {
            for line in numstat.lines() {
                let mut cols = line.split('\t');
                let a = cols.next().and_then(|c| c.parse::<u32>().ok());
                let d = cols.next().and_then(|c| c.parse::<u32>().ok());
                additions += a.unwrap_or(0);
                deletions += d.unwrap_or(0);
            }
        }

        GitProjectSummary {
            is_repo: true,
            branch,
            head_subject,
            dirty,
            additions,
            deletions,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Where a checkout's branch stands against the repository's default branch:
/// what the session Details card's Commit and Changes rows read, beside
/// `git_snapshot`'s upstream view.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchCompare {
    /// `main`, from `origin/HEAD`, else a local `main` / `master`.
    pub default_branch: Option<String>,
    /// HEAD is the default branch.
    pub is_default: bool,
    /// The repository has at least one remote.
    pub has_remote: bool,
    /// Commits on HEAD the default branch does not have; `None` without one.
    pub ahead_of_default: Option<u32>,
    /// Lines added and removed since the branch left the default branch,
    /// uncommitted changes and untracked files included. On the default branch (or with no
    /// default branch) the working tree against HEAD.
    pub additions: u32,
    pub deletions: u32,
}

/// Untracked files larger than this are left out of the branch's line count.
const UNTRACKED_COUNT_MAX_BYTES: u64 = 1024 * 1024;

/// Sum a `git diff --numstat` listing. Binary files (`-`) count nothing.
fn sum_numstat(numstat: &str) -> (u32, u32) {
    numstat.lines().fold((0, 0), |(a, d), line| {
        let mut cols = line.split('\t');
        let add = cols.next().and_then(|c| c.parse::<u32>().ok()).unwrap_or(0);
        let del = cols.next().and_then(|c| c.parse::<u32>().ok()).unwrap_or(0);
        (a.saturating_add(add), d.saturating_add(del))
    })
}

/// `origin/main` → `main`: the remote's name is everything before the first `/`.
fn strip_remote(remote_ref: &str) -> &str {
    remote_ref.split_once('/').map_or(remote_ref, |(_, b)| b)
}

#[tauri::command]
pub async fn git_branch_compare(path: String) -> Result<GitBranchCompare, String> {
    tokio::task::spawn_blocking(move || {
        let git = |args: &[&str]| -> Option<String> {
            let out = git_read().args(args).current_dir(&path).output().ok()?;
            if !out.status.success() {
                return None;
            }
            Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
        };
        let exists = |rev: &str| git(&["rev-parse", "--verify", "--quiet", rev]).is_some();

        let has_remote = git(&["remote"]).is_some_and(|s| !s.is_empty());
        let origin_head = git(&[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ]);
        let default_branch = origin_head
            .as_deref()
            .map(|r| strip_remote(r).to_string())
            .or_else(|| {
                ["main", "master"]
                    .into_iter()
                    .find(|b| exists(&format!("refs/heads/{b}")))
                    .map(String::from)
            });
        let current = git(&["symbolic-ref", "--quiet", "--short", "HEAD"]);
        let is_default = matches!((&current, &default_branch), (Some(c), Some(d)) if c == d);

        // The remote's copy when there is one: a local `main` left behind
        // would count every commit merged since as this branch's.
        let base = default_branch.as_ref().and_then(|d| {
            origin_head
                .as_ref()
                .map(|_| format!("origin/{d}"))
                .filter(|r| exists(r))
                .or_else(|| exists(d).then(|| d.clone()))
        });
        let ahead_of_default = base
            .as_ref()
            .and_then(|b| git(&["rev-list", "--count", &format!("{b}..HEAD")]))
            .and_then(|s| s.parse().ok());
        let from = match (&base, is_default) {
            (Some(b), false) => git(&["merge-base", b, "HEAD"]),
            _ => None,
        }
        .unwrap_or_else(|| "HEAD".to_string());
        let (mut additions, deletions) = git(&["diff", "--numstat", &from])
            .map(|s| sum_numstat(&s))
            .unwrap_or((0, 0));
        // `git diff` does not see untracked files, and a turn that only adds
        // files would read `+0 −0`: count their lines as added. Text only, as
        // numstat skips binaries, and nothing huge (a stray log or dump that
        // is not ignored would otherwise be read whole on every refresh).
        if let Some(list) = git(&["ls-files", "-z", "--others", "--exclude-standard"]) {
            let root = std::path::Path::new(&path);
            for rel in list.split('\0').filter(|l| !l.is_empty()) {
                let file = root.join(rel);
                let small = std::fs::metadata(&file)
                    .is_ok_and(|m| m.is_file() && m.len() <= UNTRACKED_COUNT_MAX_BYTES);
                if !small {
                    continue;
                }
                if let Ok(text) = std::fs::read_to_string(&file) {
                    let lines = u32::try_from(text.lines().count()).unwrap_or(u32::MAX);
                    additions = additions.saturating_add(lines);
                }
            }
        }

        GitBranchCompare {
            default_branch,
            is_default,
            has_remote,
            ahead_of_default,
            additions,
            deletions,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_diff_all(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let output = git_read()
            .args(["diff", "HEAD"])
            .current_dir(&path)
            .output()
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_diff_file(path: String, file: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let output = git_read()
            .args(["diff", "HEAD", "--", &file])
            .current_dir(&path)
            .output()
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// spawn_blocking join failure → internal payload (never a raw string).
fn join_err(e: tokio::task::JoinError) -> GitErrorPayload {
    GitErrorPayload::internal(e.to_string())
}

#[tauri::command]
pub async fn git_stage(path: String, files: Vec<String>) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        if files.is_empty() {
            return Ok(());
        }
        GitCommand::new(&path, &["add"]).pathspecs(&files).run()?;
        Ok(())
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn git_unstage(path: String, files: Vec<String>) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        if files.is_empty() {
            return Ok(());
        }
        GitCommand::new(&path, &["restore", "--staged"])
            .pathspecs(&files)
            .run()?;
        Ok(())
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn git_list_branches(path: String) -> Result<Vec<GitBranch>, String> {
    tokio::task::spawn_blocking(move || {
        let output = git_read()
            .args(["branch", "--format=%(refname:short)\x1f%(HEAD)"])
            .current_dir(&path)
            .output()
            .map_err(|e| e.to_string())?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let branches = stdout
            .lines()
            .filter(|l| !l.is_empty())
            .map(|line| {
                let parts: Vec<&str> = line.split('\x1f').collect();
                GitBranch {
                    name: parts.first().unwrap_or(&"").to_string(),
                    is_current: parts.get(1).is_some_and(|h| h.trim() == "*"),
                }
            })
            .collect();
        Ok(branches)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Refuse a branch name git would read as an option. `git check-ref-format`
/// refuses one too, but only after git has already parsed it as a flag.
fn branch_arg(branch: &str) -> Result<&str, GitErrorPayload> {
    if branch.is_empty() || branch.starts_with('-') {
        return Err(GitErrorPayload::internal(format!(
            "'{branch}' is not a branch name."
        )));
    }
    Ok(branch)
}

/// `git checkout <branch> --`: the trailing `--` pins `branch` as a revision,
/// so a name that is also a file is never read as a path to restore.
fn checkout(path: &str, branch: &str) -> Result<(), GitErrorPayload> {
    GitCommand::new(path, &["checkout", branch_arg(branch)?, "--"]).run()?;
    Ok(())
}

#[tauri::command]
pub async fn git_checkout(path: String, branch: String) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || checkout(&path, &branch))
        .await
        .map_err(join_err)?
}

/// Switch `path` to `branch` only if its working tree is clean (untracked
/// files count): the check and the switch run back to back in one blocking
/// task, so nothing the UI read earlier can have gone stale in between. A
/// dirty tree is refused with `uncommitted-changes` and left alone. For
/// starting a session on another session's branch, where the checkout may be
/// shared with an agent Atlas does not run.
#[tauri::command]
pub async fn git_switch_if_clean(path: String, branch: String) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || switch_if_clean(&path, &branch))
        .await
        .map_err(join_err)?
}

fn switch_if_clean(path: &str, branch: &str) -> Result<(), GitErrorPayload> {
    let branch = branch_arg(branch)?;
    let status = GitCommand::new(path, &["status", "--porcelain", "--untracked-files=normal"])
        .read_only()
        .run()?;
    if !status.stdout.trim().is_empty() {
        let code = atlas_git::GitErrorCode::UncommittedChanges;
        return Err(GitErrorPayload {
            code,
            message: atlas_git::error::friendly_message(code, &[], None),
            raw_stderr: String::new(),
            command: "git status --porcelain".into(),
            exit_code: None,
            files: Vec::new(),
            hint: None,
        });
    }
    checkout(path, branch)
}

#[tauri::command]
pub async fn git_create_branch(path: String, name: String) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        GitCommand::new(&path, &["checkout", "-b", branch_arg(&name)?]).run()?;
        Ok(())
    })
    .await
    .map_err(join_err)?
}

/// One line of blame output, in final-file order (`line` is 1-based).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub line: u32,
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    /// Author time as unix milliseconds (0 if unparsable).
    pub time_ms: i64,
    pub summary: String,
    /// False for git's synthetic all-zero sha ("Not Committed Yet").
    pub committed: bool,
}

/// Blame `file` against the working tree. `-w` keeps whitespace-only
/// reformatting from stealing authorship. Untracked files and non-repos are
/// not errors — they return an empty vec and the editor renders nothing.
#[tauri::command]
pub async fn git_blame_file(path: String, file: String) -> Result<Vec<BlameLine>, String> {
    tokio::task::spawn_blocking(move || {
        let output = git_read()
            .args(["blame", "-w", "--line-porcelain", "--", &file])
            .current_dir(&path)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Ok(Vec::new());
        }
        Ok(parse_line_porcelain(&String::from_utf8_lossy(
            &output.stdout,
        )))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Parse `git blame --line-porcelain`: every line group starts with a
/// "<40-hex sha> <orig> <final> [count]" header, carries a full metadata block
/// (author / author-time / summary / …), and ends with the tab-prefixed file
/// content — which is our emit signal.
fn parse_line_porcelain(out: &str) -> Vec<BlameLine> {
    const ZERO_SHA: &str = "0000000000000000000000000000000000000000";

    let mut result = Vec::new();
    let (mut sha, mut line_no): (String, u32) = (String::new(), 0);
    let (mut author, mut time_ms, mut summary): (String, i64, String) =
        (String::new(), 0, String::new());

    for raw in out.lines() {
        if raw.starts_with('\t') {
            let committed = !sha.is_empty() && sha != ZERO_SHA;
            result.push(BlameLine {
                short_sha: sha.chars().take(7).collect(),
                sha: std::mem::take(&mut sha),
                line: line_no,
                author: if committed {
                    std::mem::take(&mut author)
                } else {
                    "You".into()
                },
                time_ms,
                summary: if committed {
                    std::mem::take(&mut summary)
                } else {
                    "Uncommitted changes".into()
                },
                committed,
            });
            author.clear();
            summary.clear();
            time_ms = 0;
            continue;
        }

        // Header vs metadata: only headers start with a 40-char hex token.
        let first = raw.split(' ').next().unwrap_or("");
        if first.len() == 40 && first.bytes().all(|b| b.is_ascii_hexdigit()) {
            sha = first.to_string();
            line_no = raw
                .split(' ')
                .nth(2)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
        } else if let Some(rest) = raw.strip_prefix("author ") {
            author = rest.to_string();
        } else if let Some(rest) = raw.strip_prefix("author-time ") {
            time_ms = rest.trim().parse::<i64>().map(|s| s * 1000).unwrap_or(0);
        } else if let Some(rest) = raw.strip_prefix("summary ") {
            summary = rest.to_string();
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn git(repo: &Path, args: &[&str]) {
        let status = atlas_process::command("git")
            .args(args)
            .current_dir(repo)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .status()
            .expect("git is on PATH");
        assert!(status.success(), "git {args:?} failed");
    }

    fn head(repo: &Path) -> String {
        let out = atlas_process::command("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(repo)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    #[test]
    fn numstat_sums_lines_and_skips_binaries() {
        assert_eq!(
            sum_numstat("3\t1\ta.rs\n-\t-\tlogo.png\n10\t0\tb.rs\n"),
            (13, 1)
        );
        assert_eq!(sum_numstat(""), (0, 0));
        assert_eq!(strip_remote("origin/main"), "main");
        assert_eq!(strip_remote("origin/release/1.0"), "release/1.0");
    }

    /// A feature branch counts its commits past `main` and every line since
    /// it left `main`, uncommitted ones included; `main` itself counts only
    /// its working tree.
    #[tokio::test]
    async fn branch_compare_measures_a_branch_against_main() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q", "-b", "main"]);
        fs::write(root.join("f"), "a\n").unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-qm", "init"]);
        let path = root.to_string_lossy().into_owned();

        let on_main = git_branch_compare(path.clone()).await.unwrap();
        assert_eq!(on_main.default_branch.as_deref(), Some("main"));
        assert!(on_main.is_default);
        assert!(!on_main.has_remote);
        assert_eq!(on_main.ahead_of_default, Some(0));
        assert_eq!((on_main.additions, on_main.deletions), (0, 0));

        git(root, &["checkout", "-qb", "feature"]);
        fs::write(root.join("f"), "a\nb\nc\n").unwrap();
        git(root, &["commit", "-qam", "two lines"]);
        fs::write(root.join("f"), "b\nc\nd\n").unwrap();

        let feature = git_branch_compare(path).await.unwrap();
        assert!(!feature.is_default);
        assert_eq!(feature.ahead_of_default, Some(1));
        // a → b c d: one removed, three added, the last uncommitted.
        assert_eq!((feature.additions, feature.deletions), (3, 1));
    }

    /// Starting a session on another session's branch: the switch happens
    /// only on a clean tree, untracked files included, and a name that is
    /// also a file, or that looks like an option, is never misread.
    #[test]
    fn switch_if_clean_refuses_a_dirty_tree_and_reads_the_branch_safely() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q", "-b", "main"]);
        fs::write(root.join("f"), "a").unwrap();
        // A file named like the branch: plain `git checkout feature` with
        // a pathspec reading would restore it rather than switch.
        fs::write(root.join("feature"), "a file").unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-qm", "init"]);
        git(root, &["branch", "feature"]);
        let path = root.to_string_lossy().into_owned();

        fs::write(root.join("untracked"), "x").unwrap();
        let err = switch_if_clean(&path, "feature").unwrap_err();
        assert_eq!(err.code, atlas_git::GitErrorCode::UncommittedChanges);
        assert_eq!(head(root), "main", "left alone");
        fs::remove_file(root.join("untracked")).unwrap();

        fs::write(root.join("f"), "edited").unwrap();
        assert!(switch_if_clean(&path, "feature").is_err());
        assert_eq!(head(root), "main");
        git(root, &["checkout", "-q", "--", "f"]);

        for bad in ["-f", "--orphan=x", ""] {
            assert!(switch_if_clean(&path, bad).is_err(), "{bad:?} refused");
            assert_eq!(head(root), "main");
        }

        switch_if_clean(&path, "feature").unwrap();
        assert_eq!(head(root), "feature");
    }

    /// `git_log` is branch-scoped unless a caller opts in. The Source-Control
    /// History list and the Review panel both act on what this returns —
    /// reset/revert/cherry-pick and the pre-selected review target — so a
    /// commit that is not on HEAD must not appear by default.
    #[tokio::test]
    async fn git_log_defaults_to_the_checked_out_branch() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("atlas-gitlog-{nanos}"));
        fs::create_dir_all(&root).unwrap();

        git(&root, &["init", "-q", "-b", "main"]);
        fs::write(root.join("f"), "a").unwrap();
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-qm", "on main"]);
        git(&root, &["checkout", "-qb", "feature"]);
        fs::write(root.join("f"), "b").unwrap();
        git(&root, &["commit", "-qam", "only on feature"]);
        git(&root, &["checkout", "-q", "main"]);

        let path = root.to_string_lossy().into_owned();

        let default = git_log(path.clone(), Some(50), None).await.unwrap();
        assert!(
            !default.iter().any(|c| c.message == "only on feature"),
            "default log leaked a commit that is not on HEAD: {:?}",
            default.iter().map(|c| &c.message).collect::<Vec<_>>()
        );
        assert!(default.iter().any(|c| c.message == "on main"));

        let all = git_log(path, Some(50), Some(true)).await.unwrap();
        assert!(
            all.iter().any(|c| c.message == "only on feature"),
            "all: true must still reach every ref"
        );

        let _ = fs::remove_dir_all(&root);
    }
}

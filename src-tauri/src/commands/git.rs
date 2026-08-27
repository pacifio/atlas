use atlas_git::{GitCommand, GitErrorPayload};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

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
    let mut cmd = Command::new("git");
    cmd.arg("--no-optional-locks");
    cmd
}

/// Async twin of [`git_read`], for the parallel status refresh.
fn git_read_async() -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("git");
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

/// Stale-while-revalidate `git_status`:
///
/// On a project with thousands of changed files `git status` itself takes
/// several seconds — even with the parallelization + flag tuning below
/// (`--ignore-submodules=all`, `--no-renames`). That's git's actual speed,
/// not something we can squeeze further from app code.
///
/// To make the right-panel Changes section feel instant on warm launches we
/// cache the last result to `<project>/.atlas/git-status-cache.json`:
///
/// 1. If a cache exists, return it as the IPC reply (typically <5 ms).
/// 2. In a background task, compute fresh status, update the cache, and
///    emit `atlas:git-status-fresh` with the new value. The frontend's
///    git-store listens for that event and patches its state.
/// 3. First open of a project has no cache → falls back to the slow path,
///    and the result is cached for next launch.
///
/// Net effect: every launch after the first sees Changes data flow into
/// the UI immediately, then quietly refresh.
#[tauri::command]
pub async fn git_status(path: String, app: AppHandle) -> Result<GitStatus, String> {
    if let Some(cached) = read_status_cache(&path) {
        let path_for_task = path.clone();
        tokio::spawn(async move {
            if let Ok(fresh) = git_status_compute(&path_for_task).await {
                write_status_cache(&path_for_task, &fresh);
                let _ = app.emit(
                    "atlas:git-status-fresh",
                    GitStatusFreshPayload {
                        path: path_for_task,
                        status: fresh,
                    },
                );
            }
        });
        return Ok(cached);
    }

    let fresh = git_status_compute(&path).await?;
    write_status_cache(&path, &fresh);
    Ok(fresh)
}

/// Force-fresh status — skips the stale-while-revalidate cache read and
/// computes synchronously, returning the result directly (no event detour).
///
/// Used for changes Atlas *originates* and therefore already knows about:
/// git mutations (stage / unstage / commit / discard / checkout …) and
/// editor saves. Those don't need to wait for the `.git` / workspace fs
/// watcher to notice — calling this right after the action lands makes the
/// Changes panel and file-tree dots update in one lean `git status`
/// (~50–120 ms) instead of FSEvents-latency + debounce + a stale round-trip.
#[tauri::command]
pub async fn git_status_fresh(path: String) -> Result<GitStatus, String> {
    let fresh = git_status_compute(&path).await?;
    write_status_cache(&path, &fresh);
    Ok(fresh)
}

#[derive(Debug, Clone, Serialize)]
struct GitStatusFreshPayload {
    path: String,
    status: GitStatus,
}

const STATUS_CACHE_REL: &str = ".atlas/git-status-cache.json";

fn status_cache_path(project_path: &str) -> PathBuf {
    Path::new(project_path).join(STATUS_CACHE_REL)
}

fn read_status_cache(project_path: &str) -> Option<GitStatus> {
    let cache = status_cache_path(project_path);
    let raw = std::fs::read_to_string(&cache).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_status_cache(project_path: &str, status: &GitStatus) {
    let cache = status_cache_path(project_path);
    if let Some(parent) = cache.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let raw = match serde_json::to_string(status) {
        Ok(r) => r,
        Err(_) => return,
    };
    let tmp = cache.with_extension("json.tmp");
    if std::fs::write(&tmp, raw).is_ok() {
        let _ = std::fs::rename(&tmp, &cache);
    }
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
            let index = line.chars().nth(0).unwrap_or(' ');
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
                .map(|s| s.to_string())
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
        refs.push(GitRef { name, sha, kind, is_current });
    }
    Ok(GitRefs { head: head_sha, head_ref, refs })
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
            .args([
                "for-each-ref",
                "--format=%(refname) %(objectname)",
            ])
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
        Ok(format!("{}-{:016x}", head, h))
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Compact per-workspace git summary for the workspace sidebar: branch, latest
/// commit subject, dirty flag (green/yellow dot), and working-tree +/- counts.
/// One command (a few cheap git calls) so the sidebar doesn't fan out several
/// IPC round-trips per workspace.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkspaceSummary {
    pub is_repo: bool,
    pub branch: String,
    pub head_subject: String,
    pub dirty: bool,
    pub additions: u32,
    pub deletions: u32,
}

#[tauri::command]
pub async fn git_workspace_summary(path: String) -> Result<GitWorkspaceSummary, String> {
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
            return GitWorkspaceSummary {
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

        GitWorkspaceSummary {
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

#[tauri::command]
pub async fn git_diff_all(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let output = git_read()
            .args(["diff", "HEAD"])
            .current_dir(&path)
            .output()
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }).await.map_err(|e| e.to_string())?
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
    }).await.map_err(|e| e.to_string())?
}

/// spawn_blocking join failure → internal payload (never a raw string).
fn join_err(e: tokio::task::JoinError) -> GitErrorPayload {
    GitErrorPayload::internal(e.to_string())
}

#[tauri::command]
pub async fn git_stage(path: String, files: Vec<String>) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        let mut args: Vec<String> = vec!["add".into(), "--".into()];
        args.extend(files);
        GitCommand::new_owned(&path, args).run()?;
        Ok(())
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn git_unstage(path: String, files: Vec<String>) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        let mut args: Vec<String> = vec!["restore".into(), "--staged".into(), "--".into()];
        args.extend(files);
        GitCommand::new_owned(&path, args).run()?;
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
                    is_current: parts.get(1).map_or(false, |h| h.trim() == "*"),
                }
            })
            .collect();
        Ok(branches)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_checkout(path: String, branch: String) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        GitCommand::new(&path, &["checkout", &branch]).run()?;
        Ok(())
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn git_create_branch(path: String, name: String) -> Result<(), GitErrorPayload> {
    tokio::task::spawn_blocking(move || {
        GitCommand::new(&path, &["checkout", "-b", &name]).run()?;
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
        Ok(parse_line_porcelain(&String::from_utf8_lossy(&output.stdout)))
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
                author: if committed { std::mem::take(&mut author) } else { "You".into() },
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
            line_no = raw.split(' ').nth(2).and_then(|s| s.parse().ok()).unwrap_or(0);
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
        let status = Command::new("git")
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

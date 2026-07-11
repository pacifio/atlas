use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

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
    use tokio::process::Command as AsyncCommand;

    // branch / status / ahead-behind in parallel. We intentionally DON'T
    // gate on a preliminary `rev-parse --is-inside-work-tree` — that was a
    // serial subprocess on the hot path (every refresh paid one extra `git`
    // spawn before the real work). Instead we infer repo-ness from the
    // `git status` exit code below: it fails fast outside a work tree.
    //   --ignore-submodules=all   skips per-submodule recursion — biggest
    //                             win on monorepos.
    //   --no-renames              skips O(adds × dels) rename detection.
    let branch_fut = AsyncCommand::new("git")
        .args(["branch", "--show-current"])
        .current_dir(path)
        .output();
    let status_fut = AsyncCommand::new("git")
        .args([
            "status",
            "--porcelain=v1",
            "--ignore-submodules=all",
            "--no-renames",
        ])
        .current_dir(path)
        .output();
    let ab_fut = AsyncCommand::new("git")
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
    let output = Command::new("git")
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
    let all_flag = all.unwrap_or(true);
    tokio::task::spawn_blocking(move || git_log_compute(&path, lim, all_flag))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn git_refs_compute(path: &str) -> Result<GitRefs, String> {
    let head_sha = Command::new("git")
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
    let head_ref = Command::new("git")
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

    let out = Command::new("git")
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
pub async fn git_refs(path: String) -> Result<GitRefs, String> {
    tokio::task::spawn_blocking(move || git_refs_compute(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_graph_signature(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let head = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(&path)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        let refs_out = Command::new("git")
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
            let out = Command::new("git").args(args).current_dir(&path).output().ok()?;
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
        let output = Command::new("git")
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
        let output = Command::new("git")
            .args(["diff", "HEAD", "--", &file])
            .current_dir(&path)
            .output()
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }).await.map_err(|e| e.to_string())?
}

/// One line of `git blame` output, in final-file line order.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    /// 1-based line number in the current (final) file.
    pub line: u32,
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    /// Author time as unix milliseconds (0 if unparsable).
    pub time_ms: i64,
    pub summary: String,
    /// False for the synthetic all-zero sha git uses for local/uncommitted
    /// lines ("Not Committed Yet").
    pub committed: bool,
}

/// Blame a file against the working tree. `-w` ignores whitespace-only changes
/// so reformatting doesn't reassign authorship. Returns one entry per line in
/// final-file order; an empty vec when the file isn't tracked or the path isn't
/// a repo (the frontend then shows nothing).
#[tauri::command]
pub async fn git_blame_file(path: String, file: String) -> Result<Vec<BlameLine>, String> {
    tokio::task::spawn_blocking(move || {
        let output = Command::new("git")
            .args(["blame", "-w", "--porcelain", "--", &file])
            .current_dir(&path)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Ok(Vec::new());
        }
        Ok(parse_blame_porcelain(&String::from_utf8_lossy(&output.stdout)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Parse `git blame --porcelain`. Commit metadata (author/summary/time) is
/// emitted only the first time each sha appears; later lines with the same sha
/// carry just the header + content, so we cache per-sha metadata and look it up.
fn parse_blame_porcelain(out: &str) -> Vec<BlameLine> {
    use std::collections::HashMap;

    #[derive(Default, Clone)]
    struct Commit {
        author: String,
        time_ms: i64,
        summary: String,
    }

    let mut commits: HashMap<String, Commit> = HashMap::new();
    let mut result: Vec<BlameLine> = Vec::new();
    let mut cur_sha = String::new();
    let mut cur_line: u32 = 0;

    for raw in out.lines() {
        // The actual file content is the only tab-prefixed line in each group;
        // seeing it means the current group's metadata is complete → emit.
        if raw.starts_with('\t') {
            let c = commits.get(&cur_sha).cloned().unwrap_or_default();
            let committed = !cur_sha.is_empty() && !cur_sha.chars().all(|ch| ch == '0');
            let short_sha = cur_sha.chars().take(7).collect::<String>();
            result.push(BlameLine {
                line: cur_line,
                sha: cur_sha.clone(),
                short_sha,
                author: if c.author.is_empty() && !committed {
                    "You".to_string()
                } else {
                    c.author.clone()
                },
                time_ms: c.time_ms,
                summary: if c.summary.is_empty() && !committed {
                    "Uncommitted changes".to_string()
                } else {
                    c.summary.clone()
                },
                committed,
            });
            continue;
        }

        // A header line: "<40-hex-sha> <origLine> <finalLine> [numLines]".
        // Distinguish it from "key value" metadata by the 40-char hex first token.
        let mut parts = raw.splitn(4, ' ');
        let first = parts.next().unwrap_or("");
        if first.len() == 40 && first.bytes().all(|b| b.is_ascii_hexdigit()) {
            cur_sha = first.to_string();
            let _orig = parts.next();
            cur_line = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            commits.entry(cur_sha.clone()).or_default();
            continue;
        }

        // Metadata line for the current sha: "key value".
        let entry = commits.entry(cur_sha.clone()).or_default();
        if let Some(rest) = raw.strip_prefix("author ") {
            entry.author = rest.to_string();
        } else if let Some(rest) = raw.strip_prefix("author-time ") {
            entry.time_ms = rest.trim().parse::<i64>().map(|s| s * 1000).unwrap_or(0);
        } else if let Some(rest) = raw.strip_prefix("summary ") {
            entry.summary = rest.to_string();
        }
    }

    result
}

#[tauri::command]
pub async fn git_stage(path: String, files: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["add".to_string()];
        args.extend(files);
        Command::new("git").args(&args).current_dir(&path).output().map_err(|e| e.to_string())?;
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_unstage(path: String, files: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["restore".to_string(), "--staged".to_string()];
        args.extend(files);
        Command::new("git").args(&args).current_dir(&path).output().map_err(|e| e.to_string())?;
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_commit(path: String, message: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let output = Command::new("git")
            .args(["commit", "-m", &message])
            .current_dir(&path)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_list_branches(path: String) -> Result<Vec<GitBranch>, String> {
    tokio::task::spawn_blocking(move || {
        let output = Command::new("git")
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
pub async fn git_checkout(path: String, branch: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let output = Command::new("git").args(["checkout", &branch]).current_dir(&path).output().map_err(|e| e.to_string())?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).to_string()); }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_create_branch(path: String, name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let output = Command::new("git").args(["checkout", "-b", &name]).current_dir(&path).output().map_err(|e| e.to_string())?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).to_string()); }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_delete_branch(path: String, name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let output = Command::new("git").args(["branch", "-d", &name]).current_dir(&path).output().map_err(|e| e.to_string())?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).to_string()); }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

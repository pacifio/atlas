use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Serialize)]
pub struct GithubRepo {
    pub name: String,
    pub full_name: String,
    pub description: String,
    pub html_url: String,
    pub clone_url: String,
    pub language: String,
    pub stars: u32,
    pub forks: u32,
    pub updated_at: String,
}

/// What the search result knew about the repo at clone time — kept so the
/// cloned list can show it without another API call. Lives in
/// `<project>/.atlas/repo-meta.json`, a sibling of `repos/`, never inside
/// the clone (an untracked file there dirties the clone's own git tree).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RepoMeta {
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub stars: u32,
    #[serde(default)]
    pub forks: u32,
    #[serde(default)]
    pub html_url: String,
    #[serde(default)]
    pub updated_at: String,
}

fn meta_path(project_path: &str) -> std::path::PathBuf {
    atlas_profile::dir_in(Path::new(project_path)).join("repo-meta.json")
}

fn read_meta(project_path: &str) -> BTreeMap<String, RepoMeta> {
    fs::read_to_string(meta_path(project_path))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_meta(project_path: &str, repo_name: &str, meta: &RepoMeta) -> Result<(), String> {
    let mut all = read_meta(project_path);
    all.insert(repo_name.to_string(), meta.clone());
    let path = meta_path(project_path);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

fn forget_meta(project_path: &str, repo_name: &str) {
    let mut all = read_meta(project_path);
    if all.remove(repo_name).is_some() {
        if let Ok(json) = serde_json::to_string_pretty(&all) {
            let _ = fs::write(meta_path(project_path), json);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ClonedRepo {
    /// On-disk directory name (`owner-repo`). Used for every filesystem op
    /// (`read_repo_readme`, `delete_cloned_repo`) — never derived from.
    pub name: String,
    /// Human-facing `owner/repo`. Recovered from the clone's git remote so
    /// owners/repos that themselves contain `-` (e.g. `rudi-q/leed_pdf_viewer`)
    /// render correctly — the dashed dir name is ambiguous on its own.
    pub display_name: String,
    pub path: String,
    pub has_readme: bool,
    /// The checked-out branch, read from `.git/HEAD` (no process spawn).
    /// `None` for a detached HEAD or an unreadable clone.
    pub branch: Option<String>,
    /// Cached at clone time (or backfilled on demand); `None` until then.
    pub meta: Option<RepoMeta>,
}

/// The branch `.git/HEAD` points at, or `None` when detached.
fn branch_from_head(head: &str) -> Option<String> {
    head.trim()
        .strip_prefix("ref: refs/heads/")
        .filter(|b| !b.is_empty())
        .map(str::to_string)
}

fn read_head_branch(repo_dir: &Path) -> Option<String> {
    fs::read_to_string(repo_dir.join(".git").join("HEAD"))
        .ok()
        .and_then(|head| branch_from_head(&head))
}

/// A branch name safe to hand to git as an argument and a refspec: no
/// leading `-` (a flag), no `..`, no `@{`, no whitespace or control chars,
/// and only the characters a GitHub branch can actually carry. Stricter than
/// `git check-ref-format`, which is fine — the list this is picked from came
/// from `ls-remote` a moment earlier.
fn safe_branch(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.starts_with('-')
        && !name.starts_with('/')
        && !name.ends_with('/')
        && !name.ends_with(".lock")
        && !name.contains("..")
        && !name.contains("@{")
        && !name.contains("//")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))
}

/// `<project>/.atlas/repos/<repo_name>`, or an error when the name could
/// climb out of it. Every command that touches a clone starts here.
fn cloned_repo_dir(project_path: &str, repo_name: &str) -> Result<std::path::PathBuf, String> {
    if !safe_segment(repo_name) {
        return Err("invalid repository name".to_string());
    }
    let dir = atlas_profile::dir_in(Path::new(project_path))
        .join("repos")
        .join(repo_name);
    if !dir.join(".git").exists() {
        return Err(format!("'{repo_name}' is not a cloned repository"));
    }
    Ok(dir)
}

/// Run git inside a clone with prompts off, returning stdout or stderr.
///
/// These clones are reference material, never a working tree the developer
/// edits, so nothing here writes anywhere but `.git` — no state files, no
/// `.atlas` folder inside the clone (that used to leave every clone's tree
/// dirty with an untracked directory).
fn git_in(repo_dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = atlas_process::command("git")
        .current_dir(repo_dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_LFS_SKIP_SMUDGE", "1")
        .output()
        .map_err(|e| format!("git failed to start: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git {} failed", args.first().copied().unwrap_or(""))
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Best-effort `owner/repo` for a cloned repo. Reads the `origin` remote URL
/// from `<repo>/.git/config` (the source of truth) and extracts the last two
/// path segments. Falls back to the dashed directory name when no remote is
/// found, splitting on the first `-` as a rough guess.
fn derive_display_name(repo_dir: &Path, dir_name: &str) -> String {
    if let Ok(cfg) = fs::read_to_string(repo_dir.join(".git").join("config")) {
        // Find the first `url = ...` line under any remote. The first remote
        // in a fresh clone is always `origin`.
        if let Some(url) = cfg
            .lines()
            .map(str::trim)
            .find_map(|l| l.strip_prefix("url = ").or_else(|| l.strip_prefix("url=")))
        {
            // Normalise `git@host:owner/repo.git` and `https://host/owner/repo.git`
            // down to `owner/repo`.
            let tail = url.rsplit(['/', ':']).take(2).collect::<Vec<_>>();
            if tail.len() == 2 {
                let repo = tail[0].trim_end_matches(".git");
                let owner = tail[1];
                if !owner.is_empty() && !repo.is_empty() {
                    return format!("{owner}/{repo}");
                }
            }
        }
    }
    // Fallback: dashed dir name → split on first `-`.
    match dir_name.split_once('-') {
        Some((owner, repo)) if !owner.is_empty() && !repo.is_empty() => {
            format!("{owner}/{repo}")
        }
        _ => dir_name.to_string(),
    }
}

#[tauri::command]
pub async fn search_github(query: String) -> Result<Vec<GithubRepo>, String> {
    let url = format!(
        "https://api.github.com/search/repositories?q={}&sort=stars&order=desc&per_page=20",
        urlencoded(&query)
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("Atlas-IDE")
        .build()
        .unwrap_or_default();

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GitHub API request failed: {e}"))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    let items = json
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let repos = items
        .iter()
        .map(|item| GithubRepo {
            name: item
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            full_name: item
                .get("full_name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            description: item
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            html_url: item
                .get("html_url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            clone_url: item
                .get("clone_url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            language: item
                .get("language")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            stars: item
                .get("stargazers_count")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0) as u32,
            forks: item
                .get("forks_count")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0) as u32,
            updated_at: item
                .get("updated_at")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        })
        .collect();

    Ok(repos)
}

/// A single path/URL segment safe to hand to git and to `Path::join`:
/// non-empty, no leading `-` (git would parse it as a flag), and only
/// `[A-Za-z0-9._-]` (no separators, no `..` — the `.` rule below).
/// Mirrors `skills.rs::is_safe_gh_segment`; duplicated because the two
/// modules deliberately do not depend on each other.
fn safe_segment(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Parse and re-derive the ONLY clone URL shape this command accepts:
/// `https://github.com/<owner>/<repo>[.git]`. The URL that reaches git is
/// reconstructed from the validated parts, never the caller's string —
/// `clone_url` used to be passed through verbatim with no `--` terminator,
/// which made `--upload-pack=<cmd>` and the `ext::` transport remote code
/// execution from the renderer.
fn parse_github_https(clone_url: &str) -> Result<(String, String), String> {
    let rest = clone_url
        .trim()
        .strip_prefix("https://github.com/")
        .ok_or_else(|| "only https://github.com/<owner>/<repo> URLs can be cloned".to_string())?;
    let mut parts = rest.trim_end_matches('/').splitn(2, '/');
    let owner = parts.next().unwrap_or_default();
    let repo = parts.next().unwrap_or_default().trim_end_matches(".git");
    if !safe_segment(owner) || !safe_segment(repo) || repo.contains('/') {
        return Err("that does not look like a GitHub repository URL".to_string());
    }
    Ok((owner.to_string(), repo.to_string()))
}

#[tauri::command]
pub async fn clone_github_repo(
    project_path: String,
    clone_url: String,
    repo_name: String,
    meta: Option<RepoMeta>,
) -> Result<String, String> {
    let (owner, repo) = parse_github_https(&clone_url)?;
    // `repo_name` becomes a path segment under .atlas/repos — hold it to the
    // same rule so it cannot climb out (`../../…` was a renderer-directed
    // write location before this).
    if !safe_segment(&repo_name) {
        return Err("invalid repository name".to_string());
    }

    let repos_dir = atlas_profile::dir_in(Path::new(&project_path)).join("repos");
    fs::create_dir_all(&repos_dir).map_err(|e| e.to_string())?;

    let dest = repos_dir.join(&repo_name);
    if dest.exists() {
        return Err(format!("Repository '{repo_name}' already cloned"));
    }

    let dest_str = dest.to_string_lossy().to_string();
    tokio::task::spawn_blocking(move || {
        let url = format!("https://github.com/{owner}/{repo}.git");
        let output = atlas_process::command("git")
            // `--` so nothing after it can ever parse as a flag, and no
            // terminal prompt — an auth failure fails fast instead of
            // wedging a hidden child process.
            .args(["clone", "--depth", "1", "--no-tags", "--"])
            .arg(&url)
            .arg(&dest_str)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_LFS_SKIP_SMUDGE", "1")
            .output()
            .map_err(|e| format!("Git clone failed: {e}"))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
        // The search result already knew the description, stars and
        // language; keep them so the list never has to ask GitHub again.
        if let Some(meta) = meta {
            write_meta(&project_path, &repo_name, &meta)?;
        }
        Ok(dest_str)
    })
    .await
    .map_err(|e| e.to_string())?
}

// All async + spawn_blocking — see the comment in knowledge.rs for the
// reason (sync Tauri command handlers run on NSApp main thread).
#[tauri::command]
pub async fn list_cloned_repos(project_path: String) -> Result<Vec<ClonedRepo>, String> {
    tokio::task::spawn_blocking(move || {
        let repos_dir = atlas_profile::dir_in(Path::new(&project_path)).join("repos");
        if !repos_dir.exists() {
            return Ok(vec![]);
        }
        let metas = read_meta(&project_path);
        let mut repos = Vec::new();
        let read = fs::read_dir(&repos_dir).map_err(|e| e.to_string())?;
        for entry in read.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            // Only git clones are repos. A stray directory under `repos/` (a
            // cache folder something once wrote there) is not one, and
            // listing it as a repo offered Fetch and Delete on nothing.
            if !path.join(".git").exists() {
                continue;
            }
            let has_readme = path.join("README.md").exists() || path.join("readme.md").exists();
            let display_name = derive_display_name(&path, &name);
            let branch = read_head_branch(&path);
            let meta = metas.get(&name).cloned();
            repos.push(ClonedRepo {
                name,
                display_name,
                path: path.to_string_lossy().to_string(),
                has_readme,
                branch,
                meta,
            });
        }
        repos.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(repos)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_repo_readme(project_path: String, repo_name: String) -> Result<String, String> {
    if !safe_segment(&repo_name) {
        return Err("invalid repository name".to_string());
    }
    tokio::task::spawn_blocking(move || {
        let repo_dir = atlas_profile::dir_in(Path::new(&project_path))
            .join("repos")
            .join(&repo_name);
        for name in &[
            "README.md",
            "readme.md",
            "Readme.md",
            "README.rst",
            "README.txt",
            "README",
        ] {
            let path = repo_dir.join(name);
            if path.exists() {
                return fs::read_to_string(&path).map_err(|e| e.to_string());
            }
        }
        Err("No README found".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_cloned_repo(project_path: String, repo_name: String) -> Result<(), String> {
    // `remove_dir_all` steered by the renderer: the name MUST be a plain
    // segment or this deletes wherever `../..` points.
    if !safe_segment(&repo_name) {
        return Err("invalid repository name".to_string());
    }
    tokio::task::spawn_blocking(move || {
        let repo_dir = atlas_profile::dir_in(Path::new(&project_path))
            .join("repos")
            .join(&repo_name);
        if repo_dir.exists() {
            fs::remove_dir_all(&repo_dir).map_err(|e| e.to_string())?;
        }
        forget_meta(&project_path, &repo_name);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Every branch on `origin`, from `ls-remote` — the clone is `--depth 1` and
/// single-branch, so its own refs know nothing beyond the branch it was
/// cloned on. Network, hence `spawn_blocking`.
#[tauri::command]
pub async fn list_remote_branches(
    project_path: String,
    repo_name: String,
) -> Result<Vec<String>, String> {
    let repo_dir = cloned_repo_dir(&project_path, &repo_name)?;
    tokio::task::spawn_blocking(move || {
        let out = git_in(&repo_dir, &["ls-remote", "--heads", "--quiet", "origin"])?;
        let mut branches: Vec<String> = out
            .lines()
            .filter_map(|line| line.split_whitespace().nth(1))
            .filter_map(|r| r.strip_prefix("refs/heads/"))
            .map(str::to_string)
            .collect();
        branches.sort_unstable();
        branches.dedup();
        Ok(branches)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Check out another remote branch, shallowly: fetch just that branch's tip
/// and point a local branch of the same name at it. The clone stays
/// single-commit-deep and gains nothing but the one new ref.
#[tauri::command]
pub async fn switch_cloned_repo_branch(
    project_path: String,
    repo_name: String,
    branch: String,
) -> Result<String, String> {
    let repo_dir = cloned_repo_dir(&project_path, &repo_name)?;
    if !safe_branch(&branch) {
        return Err("invalid branch name".to_string());
    }
    tokio::task::spawn_blocking(move || {
        git_in(
            &repo_dir,
            &[
                "fetch",
                "--depth",
                "1",
                "--no-tags",
                "--",
                "origin",
                &branch,
            ],
        )?;
        // `-B` rather than `-b`: switching back to a branch visited before
        // must re-point it at what was just fetched, not fail on "exists".
        git_in(&repo_dir, &["checkout", "-B", &branch, "FETCH_HEAD"])?;
        Ok(branch)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Bring the checked-out branch up to the remote's tip.
///
/// A reference clone has no local work to preserve, so this is fetch +
/// `reset --hard` to what was fetched — a force-push upstream cannot wedge
/// it the way `pull --ff-only` would. Untracked files are left alone.
#[tauri::command]
pub async fn update_cloned_repo(project_path: String, repo_name: String) -> Result<String, String> {
    let repo_dir = cloned_repo_dir(&project_path, &repo_name)?;
    let Some(branch) = read_head_branch(&repo_dir) else {
        return Err("the clone is not on a branch — pick one first".to_string());
    };
    if !safe_branch(&branch) {
        return Err("invalid branch name".to_string());
    }
    tokio::task::spawn_blocking(move || {
        git_in(
            &repo_dir,
            &[
                "fetch",
                "--depth",
                "1",
                "--no-tags",
                "--",
                "origin",
                &branch,
            ],
        )?;
        git_in(&repo_dir, &["reset", "--hard", "FETCH_HEAD"])?;
        Ok(branch)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Fetch and cache the metadata for a clone made before Atlas kept any —
/// one `GET /repos/{owner}/{repo}`. The panel asks for the rows that have
/// none, once; from then on the cache answers.
#[tauri::command]
pub async fn fetch_cloned_repo_meta(
    project_path: String,
    repo_name: String,
) -> Result<RepoMeta, String> {
    let repo_dir = cloned_repo_dir(&project_path, &repo_name)?;
    let display = derive_display_name(&repo_dir, &repo_name);
    let (owner, repo) = display
        .split_once('/')
        .ok_or_else(|| "cannot tell which GitHub repository this is".to_string())?;
    if !safe_segment(owner) || !safe_segment(repo) {
        return Err("cannot tell which GitHub repository this is".to_string());
    }
    let url = format!("https://api.github.com/repos/{owner}/{repo}");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("Atlas-IDE")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GitHub API request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub answered {}", resp.status()));
    }
    let item: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let str_of = |k: &str| {
        item.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let meta = RepoMeta {
        description: str_of("description"),
        language: str_of("language"),
        stars: item
            .get("stargazers_count")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0) as u32,
        forks: item
            .get("forks_count")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0) as u32,
        html_url: str_of("html_url"),
        updated_at: str_of("updated_at"),
    };
    let (pp, rn, m) = (project_path, repo_name, meta.clone());
    tokio::task::spawn_blocking(move || write_meta(&pp, &rn, &m))
        .await
        .map_err(|e| e.to_string())??;
    Ok(meta)
}

fn urlencoded(s: &str) -> String {
    s.replace(' ', "+")
        .replace('&', "%26")
        .replace('=', "%3D")
        .replace('?', "%3F")
}

#[cfg(test)]
mod clone_guard_tests {
    use super::*;

    #[test]
    fn only_github_https_urls_parse() {
        assert!(parse_github_https("https://github.com/pacifio/atlas").is_ok());
        assert!(parse_github_https("https://github.com/pacifio/atlas.git").is_ok());
        // The RCE shapes: flag injection and shell transports.
        assert!(parse_github_https("--upload-pack=touch /tmp/pwn").is_err());
        assert!(parse_github_https("ext::sh -c 'touch /tmp/pwn'").is_err());
        assert!(parse_github_https("file:///etc").is_err());
        assert!(parse_github_https("https://github.com/-flag/repo").is_err());
        assert!(parse_github_https("https://github.com/a/b/c").is_err());
        assert!(parse_github_https("https://evil.com/a/b").is_err());
    }

    #[test]
    fn a_branch_name_is_a_ref_not_a_flag() {
        assert!(safe_branch("main"));
        assert!(safe_branch("feature/usage-pill"));
        assert!(safe_branch("release-1.2.x"));
        assert!(!safe_branch(""));
        assert!(!safe_branch("-D"));
        assert!(!safe_branch("--upload-pack=touch /tmp/pwn"));
        assert!(!safe_branch("a..b"));
        assert!(!safe_branch("a@{1}"));
        assert!(!safe_branch("has space"));
        assert!(!safe_branch("/leading"));
        assert!(!safe_branch("trailing/"));
        assert!(!safe_branch("x.lock"));
    }

    #[test]
    fn head_names_the_branch_or_nothing() {
        assert_eq!(
            branch_from_head("ref: refs/heads/main\n"),
            Some("main".into())
        );
        assert_eq!(
            branch_from_head("ref: refs/heads/feature/x"),
            Some("feature/x".into())
        );
        // Detached HEAD is a bare sha.
        assert_eq!(
            branch_from_head("0123456789abcdef0123456789abcdef01234567\n"),
            None
        );
        assert_eq!(branch_from_head("ref: refs/heads/"), None);
    }

    #[test]
    fn repo_name_cannot_climb() {
        assert!(safe_segment("atlas"));
        assert!(safe_segment("my.repo-2_x"));
        assert!(!safe_segment(".."));
        assert!(!safe_segment("../../../Users"));
        assert!(!safe_segment("a/b"));
        assert!(!safe_segment("-rf"));
        assert!(!safe_segment(""));
    }
}

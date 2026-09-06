use serde::Serialize;
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
            let tail = url
                .rsplit(['/', ':'])
                .take(2)
                .collect::<Vec<_>>();
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

    let resp = client.get(&url).send().await
        .map_err(|e| format!("GitHub API request failed: {e}"))?;

    let json: serde_json::Value = resp.json().await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    let items = json.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();

    let repos = items.iter().map(|item| {
        GithubRepo {
            name: item.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            full_name: item.get("full_name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            description: item.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            html_url: item.get("html_url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            clone_url: item.get("clone_url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            language: item.get("language").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            stars: item.get("stargazers_count").and_then(serde_json::Value::as_u64).unwrap_or(0) as u32,
            forks: item.get("forks_count").and_then(serde_json::Value::as_u64).unwrap_or(0) as u32,
            updated_at: item.get("updated_at").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        }
    }).collect();

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
    let repo = parts
        .next()
        .unwrap_or_default()
        .trim_end_matches(".git");
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
) -> Result<String, String> {
    let (owner, repo) = parse_github_https(&clone_url)?;
    // `repo_name` becomes a path segment under .atlas/repos — hold it to the
    // same rule so it cannot climb out (`../../…` was a renderer-directed
    // write location before this).
    if !safe_segment(&repo_name) {
        return Err("invalid repository name".to_string());
    }

    let repos_dir = Path::new(&project_path).join(".atlas").join("repos");
    fs::create_dir_all(&repos_dir).map_err(|e| e.to_string())?;

    let dest = repos_dir.join(&repo_name);
    if dest.exists() {
        return Err(format!("Repository '{repo_name}' already cloned"));
    }

    let dest_str = dest.to_string_lossy().to_string();
    tokio::task::spawn_blocking(move || {
        let url = format!("https://github.com/{owner}/{repo}.git");
        let output = std::process::Command::new("git")
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
        Ok(dest_str)
    }).await.map_err(|e| e.to_string())?
}

// All async + spawn_blocking — see the comment in knowledge.rs for the
// reason (sync Tauri command handlers run on NSApp main thread).
#[tauri::command]
pub async fn list_cloned_repos(project_path: String) -> Result<Vec<ClonedRepo>, String> {
    tokio::task::spawn_blocking(move || {
        let repos_dir = Path::new(&project_path).join(".atlas").join("repos");
        if !repos_dir.exists() {
            return Ok(vec![]);
        }
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
            let has_readme =
                path.join("README.md").exists() || path.join("readme.md").exists();
            let display_name = derive_display_name(&path, &name);
            repos.push(ClonedRepo {
                name,
                display_name,
                path: path.to_string_lossy().to_string(),
                has_readme,
            });
        }
        repos.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(repos)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_repo_readme(
    project_path: String,
    repo_name: String,
) -> Result<String, String> {
    if !safe_segment(&repo_name) {
        return Err("invalid repository name".to_string());
    }
    tokio::task::spawn_blocking(move || {
        let repo_dir = Path::new(&project_path)
            .join(".atlas")
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
pub async fn delete_cloned_repo(
    project_path: String,
    repo_name: String,
) -> Result<(), String> {
    // `remove_dir_all` steered by the renderer: the name MUST be a plain
    // segment or this deletes wherever `../..` points.
    if !safe_segment(&repo_name) {
        return Err("invalid repository name".to_string());
    }
    tokio::task::spawn_blocking(move || {
        let repo_dir = Path::new(&project_path)
            .join(".atlas")
            .join("repos")
            .join(&repo_name);
        if repo_dir.exists() {
            fs::remove_dir_all(&repo_dir).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn urlencoded(s: &str) -> String {
    s.replace(' ', "+").replace('&', "%26").replace('=', "%3D").replace('?', "%3F")
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

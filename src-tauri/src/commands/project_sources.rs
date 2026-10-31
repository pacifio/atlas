//! The palette's "Add project" sources: browse to a folder on disk, start a
//! new project from a name, or clone one from a Git URL or a GitHub
//! `owner/repo`.
//!
//! New and cloned projects go in one place, `~/.atlas/projects`
//! (`projects_root`), so a name is all the palette has to ask for. Adding the
//! result as a project is the frontend's (`useProjectStore.addProject`), the
//! same as a folder picked in the native dialog.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::git_pr::{run_gh, GhOutcome, GH_PERMITS, GH_TIMEOUT};

/// Where new and cloned projects go: `~/.atlas/projects`.
fn projects_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("no home directory")?;
    Ok(atlas_profile::dir_in(home).join("projects"))
}

/// `~` and `~/…` against the home directory; anything else as given.
fn expand_home(path: &str) -> Result<PathBuf, String> {
    let home = || dirs::home_dir().ok_or_else(|| "no home directory".to_string());
    if path == "~" {
        return home();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return Ok(home()?.join(rest));
    }
    Ok(PathBuf::from(path))
}

/// A folder name a user typed, held to one safe path segment.
fn safe_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    let ok = !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', '\0'])
        && !name.starts_with('-');
    if ok {
        Ok(name)
    } else {
        Err(format!("\"{name}\" is not a usable folder name"))
    }
}

/// Whether the GitHub CLI can publish and clone for the user.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GhStatus {
    /// `gh` is not on the PATH.
    Missing,
    /// `gh` runs, but no account is signed in.
    SignedOut,
    Ready,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsRootInfo {
    /// Where new and cloned projects go.
    pub path: String,
    pub gh: GhStatus,
    /// The GitHub account `gh` is signed in to, when it is.
    pub github_login: Option<String>,
    /// The package manager that can install `gh` here (`brew`, `winget`),
    /// when there is one.
    pub installer: Option<&'static str>,
}

/// Asked the way the pull request surface asks (`git_pr::run_gh`): with a
/// timeout, never a prompt, and "not installed" and "signed out" told apart
/// from a failed request.
fn gh_status() -> (GhStatus, Option<String>) {
    let home = dirs::home_dir()
        .map(|home| home.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/".to_string());
    match run_gh(
        OsStr::new("gh"),
        &home,
        &["api", "user", "--jq", ".login"],
        GH_TIMEOUT,
    ) {
        GhOutcome::Missing => (GhStatus::Missing, None),
        GhOutcome::AuthRequired => (GhStatus::SignedOut, None),
        GhOutcome::Output(login) => {
            let login = login.trim().to_string();
            if login.is_empty() {
                (GhStatus::SignedOut, None)
            } else {
                (GhStatus::Ready, Some(login))
            }
        }
        // Installed, and not refused for auth: a network blip should not send
        // the user to a setup step they have already done.
        GhOutcome::Failed(_) => (GhStatus::Ready, None),
    }
}

fn installer() -> Option<&'static str> {
    let runs = |program: &str, arg: &str| {
        atlas_process::command(program)
            .arg(arg)
            .output()
            .is_ok_and(|out| out.status.success())
    };
    if cfg!(target_os = "macos") || cfg!(target_os = "linux") {
        runs("brew", "--version").then_some("brew")
    } else if cfg!(windows) {
        runs("winget", "--version").then_some("winget")
    } else {
        None
    }
}

/// Where new projects go, and whether the GitHub CLI is there to publish or
/// clone one (and how to install it when it is not).
#[tauri::command]
pub async fn project_sources_info() -> Result<ProjectsRootInfo, String> {
    let path = projects_root()?.to_string_lossy().into_owned();
    let _permit = GH_PERMITS.acquire().await.map_err(|e| e.to_string())?;
    let ((gh, github_login), installer) =
        tokio::task::spawn_blocking(|| (gh_status(), installer()))
            .await
            .map_err(|e| e.to_string())?;
    Ok(ProjectsRootInfo {
        path,
        gh,
        github_login,
        installer: if gh == GhStatus::Missing {
            installer
        } else {
            None
        },
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseListing {
    /// The folder listed, absolute.
    pub path: String,
    /// Its parent, absent at the filesystem root.
    pub parent: Option<String>,
    /// The folders in it, by name, sorted, dot-folders last.
    pub directories: Vec<String>,
}

/// The folders in `path` (`~` expanded), for the palette's folder browser.
#[tauri::command]
pub async fn project_browse(path: String) -> Result<BrowseListing, String> {
    // `components()` drops a trailing separator (`~/` and a typed `/a/b/`
    // both keep one), so the path the palette adds matches the same folder
    // added without it.
    let dir: PathBuf = expand_home(&path)?.components().collect();
    tokio::task::spawn_blocking(move || {
        let entries = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let mut directories: Vec<String> = entries
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        directories.sort_by(|a, b| {
            (a.starts_with('.'), a.to_lowercase()).cmp(&(b.starts_with('.'), b.to_lowercase()))
        });
        Ok(BrowseListing {
            path: dir.to_string_lossy().into_owned(),
            parent: dir.parent().map(|p| p.to_string_lossy().into_owned()),
            directories,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn git(dir: &Path, args: &[&str]) -> Result<(), String> {
    let out = atlas_process::command("git")
        .current_dir(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// A project `project_create` made. `warning` is set when the folder and its
/// repository stand but publishing to GitHub failed: the project is still
/// added, and the warning shown.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedProject {
    pub path: String,
    pub warning: Option<String>,
}

/// Start a new project called `name` in `~/.atlas/projects`: the folder, an
/// empty Git repository in it, and — with `github_private` — a private
/// GitHub repository of the same name as its `origin`.
#[tauri::command]
pub async fn project_create(name: String, github_private: bool) -> Result<CreatedProject, String> {
    let name = safe_name(&name)?.to_string();
    let dir = projects_root()?.join(&name);
    tokio::task::spawn_blocking(move || {
        if let Some(parent) = dir.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // `create_dir`, not `create_dir_all`: it fails when the folder is
        // already there, with no window between a check and the create.
        std::fs::create_dir(&dir).map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => format!("{} already exists", dir.display()),
            _ => e.to_string(),
        })?;
        if let Err(e) = git(&dir, &["init", "--quiet"]) {
            // Nothing was made but the empty folder; leave no trace, so the
            // same name can be tried again.
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
        let path = dir.to_string_lossy().into_owned();
        if github_private {
            let out = atlas_process::command("gh")
                .current_dir(&dir)
                .stdin(std::process::Stdio::null())
                .args([
                    "repo",
                    "create",
                    &name,
                    "--private",
                    "--source",
                    ".",
                    "--remote",
                    "origin",
                ])
                .env("GH_PROMPT_DISABLED", "1")
                .output()
                .map_err(|e| format!("gh: {e}"));
            let failure = match out {
                Ok(out) if out.status.success() => None,
                Ok(out) => Some(String::from_utf8_lossy(&out.stderr).trim().to_string()),
                Err(e) => Some(e),
            };
            if let Some(reason) = failure {
                // The folder and its repository stand; only publishing failed.
                return Ok(CreatedProject {
                    path,
                    warning: Some(format!("The GitHub repository was not created: {reason}")),
                });
            }
        }
        Ok(CreatedProject {
            path,
            warning: None,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The folder name a clone URL implies: its last segment, less `.git`.
fn repo_name_from_url(url: &str) -> Option<&str> {
    let trimmed = url.trim().trim_end_matches('/');
    let last = trimmed.rsplit(['/', ':']).next()?;
    let name = last.strip_suffix(".git").unwrap_or(last);
    safe_name(name).ok()
}

/// A GitHub `owner/repo` (or a github.com URL) as an HTTPS clone URL.
fn github_clone_url(spec: &str) -> Option<String> {
    let spec = spec.trim().trim_end_matches('/').trim_end_matches(".git");
    let spec = spec
        .strip_prefix("https://github.com/")
        .or_else(|| spec.strip_prefix("github.com/"))
        .unwrap_or(spec);
    let (owner, repo) = spec.split_once('/')?;
    let segment = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    (segment(owner) && segment(repo) && !repo.contains('/'))
        .then(|| format!("https://github.com/{owner}/{repo}.git"))
}

/// Clone `url` (any Git URL, or a GitHub `owner/repo` with `github`) into
/// `~/.atlas/projects/<repo>`. Answers the folder. A GitHub clone goes
/// through `gh repo clone`, so a private repository clones with the
/// credentials `gh` already holds.
#[tauri::command]
pub async fn project_clone(url: String, github: bool) -> Result<String, String> {
    let url = if github {
        github_clone_url(&url).ok_or("Enter a GitHub repository as owner/repo")?
    } else {
        url.trim().to_string()
    };
    if url.starts_with('-') {
        return Err("That is not a Git URL".to_string());
    }
    let name = repo_name_from_url(&url)
        .ok_or("Could not tell the repository's name from that URL")?
        .to_string();
    let root = projects_root()?;
    let dest = root.join(&name);
    tokio::task::spawn_blocking(move || {
        if dest.exists() {
            return Err(format!("{} already exists", dest.display()));
        }
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let mut cmd = if github {
            let mut cmd = atlas_process::command("gh");
            cmd.args(["repo", "clone"])
                .arg(&url)
                .arg(&dest)
                .env("GH_PROMPT_DISABLED", "1");
            cmd
        } else {
            let mut cmd = atlas_process::command("git");
            cmd.args(["clone", "--"]).arg(&url).arg(&dest);
            cmd
        };
        let out = cmd
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| format!("clone: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(dest.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_from_clone_urls() {
        assert_eq!(repo_name_from_url("https://github.com/a/b.git"), Some("b"));
        assert_eq!(repo_name_from_url("git@github.com:a/b.git"), Some("b"));
        assert_eq!(repo_name_from_url("ssh://host/x/y/"), Some("y"));
        assert_eq!(repo_name_from_url(".."), None);
    }

    #[test]
    fn github_specs() {
        assert_eq!(
            github_clone_url("pacifio/atlas").as_deref(),
            Some("https://github.com/pacifio/atlas.git")
        );
        assert_eq!(
            github_clone_url("https://github.com/a/b/").as_deref(),
            Some("https://github.com/a/b.git")
        );
        assert_eq!(github_clone_url("a/b/c"), None);
        assert_eq!(github_clone_url("a b/c"), None);
    }

    #[test]
    fn unsafe_names_are_refused() {
        assert!(safe_name("../x").is_err());
        assert!(safe_name("-rf").is_err());
        assert!(safe_name("my-app").is_ok());
    }
}

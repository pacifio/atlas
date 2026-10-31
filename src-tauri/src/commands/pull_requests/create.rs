//! Opening a pull request for the checkout's current branch: `gh pr create`,
//! under the user's own `gh` login, and the title and body it starts from.
//!
//! The flow is the session context overlay's "Create PR": the frontend pushes
//! the branch first (through the git store, which owns push and publish), then
//! asks [`pr_create_draft`] for a title and body to show, then calls
//! [`pr_create`] with what the user kept. `gh` picks the host from the
//! remote; Atlas never holds a token.
//!
//! The prefill is what `gh pr create --fill` would write, computed here so the
//! user sees it before anything is opened: one commit ahead of the base gives
//! that commit's subject and body; several give the branch name as the title
//! and the commit subjects as a list.

use std::ffi::OsStr;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use super::checkout::run;
use super::gh::{classify_no_response, PR_PERMITS, WRITE_TIMEOUT};
use super::model::PrError;

/// One local `git` read for the prefill or the head: a ref, a log.
const GIT_READ_TIMEOUT: Duration = Duration::from_secs(10);

/// How many commits the prefill lists before it stops.
const MAX_LISTED_COMMITS: usize = 50;

/// What the user confirmed in the Create PR dialog.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCreateInput {
    pub title: String,
    pub body: String,
    /// The branch to merge into; `None` lets `gh` use the repository default.
    pub base: Option<String>,
    pub draft: bool,
}

/// The pull request `gh` opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCreated {
    pub number: u64,
    pub url: String,
}

/// A starting title and body for the current branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCreateDraft {
    /// The current branch; `None` on a detached HEAD, where nothing can be opened.
    pub head_branch: Option<String>,
    /// The remote's default branch, when the remote names one.
    pub base_branch: Option<String>,
    pub title: String,
    pub body: String,
    /// Commits on the branch that the base does not have.
    pub commit_count: u32,
}

/// The title and body a new pull request for the current branch starts from.
#[tauri::command]
pub async fn pr_create_draft(path: String) -> Result<PrCreateDraft, PrError> {
    let path = super::checkout(&path)?.to_string();
    Ok(draft_for(Path::new(&path)).await)
}

/// Open a pull request for the current branch. The branch must already be on
/// the remote; the overlay pushes it first. `sessionId`, the live session the
/// overlay belongs to, has the new pull request linked to it as `created`.
#[tauri::command]
pub async fn pr_create(
    path: String,
    input: PrCreateInput,
    session_id: Option<String>,
    host: tauri::State<'_, std::sync::Arc<crate::commands::agent_host::AgentHost>>,
) -> Result<PrCreated, PrError> {
    let cwd = super::checkout(&path)?.to_string();
    let title = input.title.trim();
    if title.is_empty() {
        return Err(PrError::invalid("A pull request needs a title."));
    }
    let head = current_branch(Path::new(&cwd))
        .await
        .ok_or_else(|| PrError::invalid("A pull request cannot be opened from a detached HEAD."))?;
    let head_ref = head_ref(&cwd, &head).await;
    let args = create_args(title, &head_ref, &input);
    let _permit = PR_PERMITS
        .acquire()
        .await
        .map_err(|e| PrError::failed(e.to_string()))?;
    let out = run_gh(OsStr::new("gh"), &cwd, &args, input.body.as_bytes()).await?;
    let created = parse_created(&out).ok_or_else(|| {
        PrError::failed("gh opened the pull request but did not say where it is.")
    })?;
    // Opened from a session: it is that session's pull request from now on.
    if let Some(session_id) = session_id.as_deref().filter(|s| !s.is_empty()) {
        crate::commands::session_pull_requests::record_created(
            host.inner(),
            session_id,
            &created.url,
            created.number,
            title,
            &head,
            input.base.as_deref(),
            input.draft,
        );
    }
    Ok(created)
}

/// What `--head` names: the branch, or `owner:branch` when the branch is
/// pushed to another owner's repository than the one the pull request opens
/// against (a fork's), since GitHub reads a bare name as a branch of the base
/// repository. The base is the repository `gh` resolves for the checkout,
/// which is also the one `gh pr create` opens against.
async fn head_ref(cwd: &str, branch: &str) -> String {
    let push_owner = push_remote_url(Path::new(cwd), branch)
        .await
        .and_then(|url| remote_owner(&url));
    let base_owner = match super::GitHub::open(cwd).await {
        Ok(github) => github
            .provider()
            .repository
            .split_once('/')
            .map(|(owner, _)| owner.to_string()),
        Err(_) => None,
    };
    head_argument(branch, push_owner.as_deref(), base_owner.as_deref())
}

/// The branch, qualified with the push owner only when it differs from the
/// base repository's.
pub(super) fn head_argument(
    branch: &str,
    push_owner: Option<&str>,
    base_owner: Option<&str>,
) -> String {
    match (push_owner, base_owner) {
        (Some(push), Some(base)) if !push.eq_ignore_ascii_case(base) => format!("{push}:{branch}"),
        _ => branch.to_string(),
    }
}

/// The URL of the remote `branch` is pushed to: `branch.<b>.pushRemote`,
/// else `remote.pushDefault`, else `branch.<b>.remote`, else `origin`.
async fn push_remote_url(cwd: &Path, branch: &str) -> Option<String> {
    let mut remote = None;
    for key in [
        format!("branch.{branch}.pushRemote"),
        "remote.pushDefault".to_string(),
        format!("branch.{branch}.remote"),
    ] {
        if let Some(name) = git(cwd, &["config", "--get", &key])
            .await
            .filter(|n| !n.is_empty())
        {
            remote = Some(name);
            break;
        }
    }
    let remote = remote.unwrap_or_else(|| "origin".into());
    git(cwd, &["remote", "get-url", "--push", &remote])
        .await
        .filter(|u| !u.is_empty())
}

/// The owner a remote URL names: `https://host/owner/name(.git)`,
/// `ssh://git@host/owner/name`, or scp-like `git@host:owner/name.git`.
pub(super) fn remote_owner(url: &str) -> Option<String> {
    let url = url.trim();
    let path = if let Some((_, rest)) = url.split_once("://") {
        rest.split_once('/')?.1
    } else {
        // scp-like: `user@host:path`.
        url.split_once(':')?.1
    };
    let mut parts = path.trim_start_matches('/').split('/');
    let owner = parts.next().filter(|o| !o.is_empty())?;
    parts.next().filter(|n| !n.is_empty())?;
    Some(owner.to_string())
}

/// `gh pr create`'s arguments. The body goes on stdin (`--body-file -`), so
/// a long one never meets an argument-length limit or a shell.
fn create_args(title: &str, head: &str, input: &PrCreateInput) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "pr".into(),
        "create".into(),
        "--title".into(),
        title.into(),
        "--body-file".into(),
        "-".into(),
        "--head".into(),
        head.into(),
    ];
    if let Some(base) = input
        .base
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
    {
        args.push("--base".into());
        args.push(base.into());
    }
    if input.draft {
        args.push("--draft".into());
    }
    args
}

async fn run_gh(
    program: &OsStr,
    cwd: &str,
    args: &[String],
    stdin: &[u8],
) -> Result<String, PrError> {
    if !Path::new(cwd).is_dir() {
        return Err(classify_no_response(None, "not a git repository"));
    }
    let mut cmd = atlas_process::async_command(program);
    cmd.args(args)
        .current_dir(cwd)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .env("GH_PAGER", "")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(PrError::NotInstalled),
        Err(e) => return Err(PrError::failed(e.to_string())),
    };
    let pipe = child.stdin.take();
    let body = stdin.to_vec();
    let work = async move {
        if let Some(mut pipe) = pipe {
            let _ = pipe.write_all(&body).await;
            drop(pipe);
        }
        child.wait_with_output().await
    };
    let output = match tokio::time::timeout(WRITE_TIMEOUT, work).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return Err(PrError::failed(e.to_string())),
        Err(_) => {
            return Err(PrError::failed(
                "gh took too long to open the pull request.",
            ))
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // `gh` says plainly when the branch already has one; that is the
        // user's answer, not a network failure.
        if let Some(line) = stderr.lines().find(|l| l.contains("already exists")) {
            return Err(PrError::invalid(
                line.trim().trim_start_matches("gh: ").to_string(),
            ));
        }
        return Err(classify_no_response(output.status.code(), &stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The URL `gh pr create` prints last, and the number at its end.
fn parse_created(stdout: &str) -> Option<PrCreated> {
    let url = stdout
        .lines()
        .map(str::trim)
        .rev()
        .find(|l| l.starts_with("https://") && l.contains("/pull/"))?;
    let number = url.rsplit('/').next()?.parse().ok()?;
    Some(PrCreated {
        number,
        url: url.to_string(),
    })
}

/// A bounded local `git` read; `None` for any failure.
async fn git(cwd: &Path, args: &[&str]) -> Option<String> {
    run(cwd, "git", args, GIT_READ_TIMEOUT)
        .await
        .ok()
        .map(|out| out.trim().to_string())
}

async fn current_branch(cwd: &Path) -> Option<String> {
    git(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .await
        .filter(|b| !b.is_empty())
}

async fn draft_for(cwd: &Path) -> PrCreateDraft {
    let head = current_branch(cwd).await;
    // `origin/HEAD` names the remote's default branch when the clone recorded it.
    let base_ref = git(
        cwd,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )
    .await
    .filter(|r| !r.is_empty());
    let base_branch = base_ref
        .as_deref()
        .map(|r| r.strip_prefix("origin/").unwrap_or(r).to_string());
    let log = match base_ref.as_deref() {
        Some(base) => {
            git(
                cwd,
                &[
                    "log",
                    "--reverse",
                    "--format=%s%x1f%b%x1e",
                    &format!("{base}..HEAD"),
                ],
            )
            .await
        }
        None => None,
    };
    let commits: Vec<(String, String)> = log.map(|log| parse_log(&log)).unwrap_or_default();
    let (title, body) = prefill(head.as_deref(), &commits);
    PrCreateDraft {
        head_branch: head,
        base_branch,
        title,
        body,
        commit_count: u32::try_from(commits.len()).unwrap_or(u32::MAX),
    }
}

/// `subject \x1f body \x1e` records, oldest first.
fn parse_log(log: &str) -> Vec<(String, String)> {
    log.split('\u{1e}')
        .filter_map(|record| {
            let record = record.trim_matches(['\n', '\r']);
            if record.trim().is_empty() {
                return None;
            }
            let (subject, body) = record.split_once('\u{1f}').unwrap_or((record, ""));
            Some((subject.trim().to_string(), body.trim().to_string()))
        })
        .collect()
}

/// `gh pr create --fill`'s rule: one commit gives its own subject and body;
/// otherwise the branch, humanised, is the title and the subjects are the body.
fn prefill(head: Option<&str>, commits: &[(String, String)]) -> (String, String) {
    if let [(subject, body)] = commits {
        return (subject.clone(), body.clone());
    }
    let title = head.map(humanize_branch).unwrap_or_default();
    let body = commits
        .iter()
        .take(MAX_LISTED_COMMITS)
        .map(|(subject, _)| format!("- {subject}"))
        .collect::<Vec<_>>()
        .join("\n");
    (title, body)
}

/// `uzayer/session-context_overlay` → `Session context overlay`.
fn humanize_branch(branch: &str) -> String {
    let leaf = branch.rsplit('/').next().unwrap_or(branch);
    let words = leaf.replace(['-', '_'], " ");
    let words = words.trim();
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_url_gh_prints_is_read_back_with_its_number() {
        let out = "Warning: 2 uncommitted changes\nhttps://github.com/acme/app/pull/415\n";
        assert_eq!(
            parse_created(out),
            Some(PrCreated {
                number: 415,
                url: "https://github.com/acme/app/pull/415".into()
            })
        );
        assert_eq!(parse_created("nothing useful"), None);
    }

    #[test]
    fn the_arguments_carry_base_and_draft_only_when_asked() {
        let input = PrCreateInput {
            title: "t".into(),
            body: "b".into(),
            base: Some("  ".into()),
            draft: false,
        };
        assert_eq!(
            create_args("t", "feat", &input),
            [
                "pr",
                "create",
                "--title",
                "t",
                "--body-file",
                "-",
                "--head",
                "feat"
            ]
        );
        let input = PrCreateInput {
            base: Some("main".into()),
            draft: true,
            ..input
        };
        assert!(create_args("t", "feat", &input).ends_with(&[
            "--base".to_string(),
            "main".to_string(),
            "--draft".to_string()
        ]));
    }

    #[test]
    fn a_fork_s_branch_is_named_with_its_owner() {
        assert_eq!(head_argument("feat", Some("me"), Some("acme")), "me:feat");
        assert_eq!(head_argument("feat", Some("Acme"), Some("acme")), "feat");
        assert_eq!(head_argument("feat", None, Some("acme")), "feat");
        assert_eq!(head_argument("feat", Some("me"), None), "feat");
    }

    #[test]
    fn a_remote_url_names_its_owner() {
        for url in [
            "https://github.com/me/shop.git",
            "https://github.com/me/shop",
            "ssh://git@github.com/me/shop.git",
            "git@github.com:me/shop.git",
            "https://token@ghe.example.com/me/shop",
        ] {
            assert_eq!(remote_owner(url).as_deref(), Some("me"), "{url}");
        }
        assert_eq!(remote_owner("https://github.com/me"), None);
        assert_eq!(remote_owner("/local/path/repo"), None);
    }

    #[tokio::test]
    async fn the_push_remote_follows_git_s_own_order() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        let g = |args: &[&str]| {
            assert!(std::process::Command::new("git")
                .args(args)
                .current_dir(repo)
                .status()
                .unwrap()
                .success());
        };
        g(&["init", "-q", "-b", "feat"]);
        g(&["remote", "add", "origin", "git@github.com:acme/shop.git"]);
        g(&["remote", "add", "mine", "https://github.com/me/shop.git"]);
        assert_eq!(
            push_remote_url(repo, "feat").await.as_deref(),
            Some("git@github.com:acme/shop.git")
        );
        g(&["config", "branch.feat.pushRemote", "mine"]);
        assert_eq!(
            push_remote_url(repo, "feat").await.as_deref(),
            Some("https://github.com/me/shop.git")
        );
    }

    #[test]
    fn one_commit_fills_from_itself_and_several_from_the_branch() {
        let one = parse_log("Add the overlay\u{1f}Body line\n\u{1e}\n");
        assert_eq!(
            prefill(Some("u/x"), &one),
            ("Add the overlay".to_string(), "Body line".to_string())
        );
        let many = parse_log("First\u{1f}\u{1e}\nSecond\u{1f}more\u{1e}\n");
        assert_eq!(
            prefill(Some("uzayer/session-context_overlay"), &many),
            (
                "Session context overlay".to_string(),
                "- First\n- Second".to_string()
            )
        );
        assert_eq!(prefill(None, &[]), (String::new(), String::new()));
    }
}

//! A checkout of a pull request's head for an agent session to work in: the
//! "Fix" actions' first step.
//!
//! The main checkout is never switched. A pull request whose branch is
//! already checked out — in the main checkout or in a worktree — is worked on
//! where it is. Otherwise it gets a worktree of its own under Atlas's data
//! directory, and `gh pr checkout` puts the branch in it: `gh` fetches the
//! head, names the push remote (a fork's included) and fast-forwards a local
//! branch that already exists, so the user can push the session's work from
//! the session context overlay as usual.
//!
//! A pull request from another repository is checked out as
//! `atlas/pr-<number>/<branch>`, so a fork's `main` never lands on the user's
//! own `main`.
//!
//! Every `git` and `gh` process here is bounded ([`run`], ADR-0008): a local
//! step by [`GIT_TIMEOUT`], one that talks to the remote by
//! [`NETWORK_TIMEOUT`], with prompts turned off so a credential or host-key
//! question fails instead of waiting for a terminal nobody can see.
//!
//! The worktrees made here outlive the call — the session works in them — so
//! [`sweep_leftovers`] removes, once per launch, the ones no unsettled session
//! is in, and only when they hold nothing that removing them would lose.
//!
//! Nothing here logs a repository, branch or path.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::gh::classify_no_response;
use super::model::PrError;

/// A local `git` step: a worktree added or removed, a ref read.
pub(super) const GIT_TIMEOUT: Duration = Duration::from_secs(60);
/// A step that talks to the remote: a fetch, `gh pr checkout`.
pub(super) const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);
/// A Fix worktree younger than this is never swept, whatever else holds: its
/// session may not have been recorded yet.
const LEFTOVER_MIN_AGE: Duration = Duration::from_secs(3 * 24 * 60 * 60);

/// Where the session should run, and how it got there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCheckout {
    /// The local branch holding the pull request's head.
    pub branch: String,
    /// The worktree it is in, or `None` for the main checkout.
    pub worktree_path: Option<String>,
    /// The directory the session runs in.
    pub cwd: String,
    /// Whether the checkout's HEAD is the pull request's head commit. False
    /// for a reused checkout that holds commits of its own or could not move.
    pub is_on_pull_request_head: bool,
    /// An existing checkout was used rather than a new worktree made.
    pub reused: bool,
}

/// Check out pull request `number`'s head for a session: where it already is,
/// or in a new worktree.
///
/// `in_place` is the header's "Check out → In this repository": the main
/// checkout itself is switched to the branch, as `gh pr checkout` would, but
/// only when its working tree is clean ([`prepare_in_place`]).
#[tauri::command]
pub async fn pr_prepare_checkout(
    app: AppHandle,
    path: String,
    number: u64,
    head_branch: String,
    head_sha: Option<String>,
    is_cross_repository: bool,
    in_place: Option<bool>,
) -> Result<PrCheckout, PrError> {
    let path = super::checkout(&path)?.to_string();
    let number = super::pull_number(number)?;
    if in_place == Some(true) {
        return prepare_in_place(
            Path::new(&path),
            number,
            head_branch.trim(),
            head_sha.as_deref(),
            is_cross_repository,
        )
        .await;
    }
    let root = worktrees_root(
        &app.path()
            .app_data_dir()
            .map_err(|e| PrError::failed(e.to_string()))?,
    );
    prepare(
        Path::new(&path),
        &root,
        number,
        head_branch.trim(),
        head_sha.as_deref(),
        is_cross_repository,
    )
    .await
}

/// Where Fix worktrees are made, under Atlas's data directory.
pub(crate) fn worktrees_root(app_data: &Path) -> PathBuf {
    app_data.join("worktrees")
}

/// Why a bounded process did not succeed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum RunError {
    /// The program is not on `PATH`.
    NotInstalled,
    /// It ran past its timeout and was killed.
    TimedOut,
    /// It exited unsuccessfully.
    Failed { exit: Option<i32>, stderr: String },
}

impl RunError {
    /// The last line the process wrote to stderr: what a message shows.
    pub fn line(&self) -> String {
        match self {
            RunError::NotInstalled => "not installed".into(),
            RunError::TimedOut => "timed out".into(),
            RunError::Failed { stderr, .. } => stderr
                .lines()
                .map(str::trim)
                .rfind(|l| !l.is_empty())
                .unwrap_or("failed")
                .to_string(),
        }
    }
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.line())
    }
}

/// What `GIT_SSH_COMMAND` is set to for a step that talks to the remote: the
/// user's own ssh command (`GIT_SSH_COMMAND`, else `core.sshCommand`), or
/// plain `ssh`, told never to prompt. A passphrase or host-key question then
/// fails the step instead of hanging it.
pub(super) fn batch_ssh_command(configured: Option<&str>) -> String {
    match configured.map(str::trim).filter(|c| !c.is_empty()) {
        Some(c) if c.contains("BatchMode") => c.to_string(),
        Some(c) => format!("{c} -o BatchMode=yes"),
        None => "ssh -o BatchMode=yes".into(),
    }
}

/// Run `program` in `cwd`, killed past `timeout`. Async process handling:
/// the child is killed on drop, so the timeout dropping the future is the
/// kill.
pub(super) async fn run(
    cwd: &Path,
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<String, RunError> {
    run_with_env(cwd, program, args, timeout, &[]).await
}

/// [`run`] for a step that talks to the remote: ssh is told not to prompt
/// ([`batch_ssh_command`]). A user who set `GIT_SSH` (a program, not a
/// command line) keeps it as it is.
pub(super) async fn run_networked(
    cwd: &Path,
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<String, RunError> {
    if std::env::var_os("GIT_SSH").is_some() {
        return run(cwd, program, args, timeout).await;
    }
    let configured = match std::env::var("GIT_SSH_COMMAND") {
        Ok(command) => Some(command),
        Err(_) => run(
            cwd,
            "git",
            &["config", "--get", "core.sshCommand"],
            GIT_TIMEOUT,
        )
        .await
        .ok()
        .map(|s| s.trim().to_string()),
    };
    let ssh = batch_ssh_command(configured.as_deref());
    run_with_env(cwd, program, args, timeout, &[("GIT_SSH_COMMAND", &ssh)]).await
}

async fn run_with_env(
    cwd: &Path,
    program: &str,
    args: &[&str],
    timeout: Duration,
    env: &[(&str, &str)],
) -> Result<String, RunError> {
    let mut cmd = atlas_process::async_command(program);
    cmd.args(args)
        .current_dir(cwd)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        // Git Credential Manager's own prompt, which ignores the above.
        .env("GCM_INTERACTIVE", "never")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in env {
        cmd.env(key, value);
    }
    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(RunError::NotInstalled),
        Err(e) => {
            return Err(RunError::Failed {
                exit: None,
                stderr: e.to_string(),
            })
        }
    };
    let out = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => {
            return Err(RunError::Failed {
                exit: None,
                stderr: e.to_string(),
            })
        }
        Err(_) => return Err(RunError::TimedOut),
    };
    if !out.status.success() {
        return Err(RunError::Failed {
            exit: out.status.code(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// A local `git` step, its output's trailing newline trimmed.
pub(super) async fn git(cwd: &Path, args: &[&str]) -> Result<String, RunError> {
    run(cwd, "git", args, GIT_TIMEOUT)
        .await
        .map(|s| s.trim_end().to_string())
}

/// A failed `gh pr checkout`, as the frontend tells them apart: a signed-out
/// `gh` asks the user to sign in, not to try again.
pub(super) fn checkout_error(error: &RunError) -> PrError {
    match error {
        RunError::NotInstalled => PrError::NotInstalled,
        RunError::TimedOut => PrError::Network {
            message: "gh took too long to check out the pull request.".into(),
        },
        RunError::Failed { exit, stderr } => match classify_no_response(*exit, stderr) {
            e @ (PrError::NotAuthenticated | PrError::RateLimited { .. }) => e,
            _ => PrError::failed(format!(
                "gh could not check out the pull request: {}",
                error.line()
            )),
        },
    }
}

/// What kind of failure a `gh` step was, for a log line: never its stderr,
/// which can carry a branch or repository name.
fn failure_kind(error: &RunError) -> &'static str {
    match checkout_error(error) {
        PrError::NotInstalled => "not-installed",
        PrError::NotAuthenticated => "not-authenticated",
        PrError::RateLimited { .. } => "rate-limited",
        PrError::Network { .. } => "timed-out",
        _ => "failed",
    }
}

/// The branch a cross-repository head is checked out as. Same rule as the
/// branch-name generator: lower case, `[a-z0-9/_-]`, at most 64 characters.
pub(super) fn sanitize_branch_fragment(raw: &str) -> String {
    let trim_set = |c: char| matches!(c, '.' | '/' | '_' | '-') || c.is_whitespace();
    let lowered: String = raw
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| !matches!(c, '\'' | '"' | '`'))
        .collect();
    let lowered = lowered.trim_matches(trim_set);
    let mut out = String::new();
    let mut last: Option<char> = None;
    for c in lowered.chars() {
        let mapped = if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '/' | '_' | '-')
        {
            c
        } else {
            '-'
        };
        // Runs of `/` and of `-` collapse to one.
        if (mapped == '/' || mapped == '-') && last == Some(mapped) {
            continue;
        }
        out.push(mapped);
        last = Some(mapped);
    }
    let trimmed: String = out
        .trim_matches(|c: char| matches!(c, '.' | '/' | '_' | '-'))
        .chars()
        .take(64)
        .collect();
    let trimmed = trimmed.trim_end_matches(['.', '/', '_', '-']).to_string();
    if trimmed.is_empty() {
        "update".into()
    } else {
        trimmed
    }
}

pub(super) fn local_branch_name(number: u64, head_branch: &str, cross_repository: bool) -> String {
    if !cross_repository {
        return head_branch.to_string();
    }
    let suffix = sanitize_branch_fragment(head_branch);
    let suffix = if suffix.is_empty() {
        "head".to_string()
    } else {
        suffix
    };
    format!("atlas/pr-{number}/{suffix}")
}

/// `git worktree list --porcelain`: each worktree's path and the branch it
/// has checked out (`None` when detached).
pub(super) fn parse_worktrees(porcelain: &str) -> Vec<(PathBuf, Option<String>)> {
    let mut out = Vec::new();
    let mut current: Option<(PathBuf, Option<String>)> = None;
    for line in porcelain.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(done) = current.take() {
                out.push(done);
            }
            current = Some((PathBuf::from(path), None));
        } else if let Some(branch) = line.strip_prefix("branch ") {
            if let Some((_, slot)) = current.as_mut() {
                *slot = Some(
                    branch
                        .strip_prefix("refs/heads/")
                        .unwrap_or(branch)
                        .to_string(),
                );
            }
        }
    }
    if let Some(done) = current {
        out.push(done);
    }
    out
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

async fn head_matches(cwd: &Path, head_sha: Option<&str>) -> bool {
    let Some(want) = head_sha.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    git(cwd, &["rev-parse", "HEAD"])
        .await
        .map(|have| have.trim().to_lowercase().starts_with(&want.to_lowercase()))
        .unwrap_or(false)
}

/// A short, stable folder name for a checkout: its folder name and a hash of
/// its path, so two clones of one repository never share a worktree folder.
pub(super) fn checkout_slug(root: &Path) -> String {
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".into());
    let name = sanitize_branch_fragment(&name).replace('/', "-");
    let mut hash: u32 = 0x811c_9dc5;
    for byte in root.to_string_lossy().as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{name}-{hash:08x}")
}

async fn gh_checkout(cwd: &Path, number: u64, branch: &str) -> Result<String, RunError> {
    let n = number.to_string();
    run_networked(
        cwd,
        "gh",
        &["pr", "checkout", &n, "--branch", branch],
        NETWORK_TIMEOUT,
    )
    .await
}

async fn prepare(
    path: &Path,
    worktrees_root: &Path,
    number: u64,
    head_branch: &str,
    head_sha: Option<&str>,
    cross_repository: bool,
) -> Result<PrCheckout, PrError> {
    if head_branch.is_empty() {
        return Err(PrError::invalid("The pull request names no head branch."));
    }
    let root = git(path, &["rev-parse", "--show-toplevel"])
        .await
        .map(|r| canonical(Path::new(r.trim())))
        .map_err(|_| PrError::invalid("This folder is not a git checkout."))?;
    let branch = local_branch_name(number, head_branch, cross_repository);
    if git(&root, &["check-ref-format", "--branch", &branch])
        .await
        .is_err()
    {
        return Err(PrError::invalid(
            "The pull request's branch name is not one git can check out.",
        ));
    }

    let worktrees = git(&root, &["worktree", "list", "--porcelain"])
        .await
        .map(|p| parse_worktrees(&p))
        .unwrap_or_default();
    if let Some((found, _)) = worktrees
        .iter()
        .find(|(_, b)| b.as_deref() == Some(branch.as_str()))
    {
        let found = canonical(found);
        let is_main = found == root;
        // Moved forward only when it can be without losing anything: `gh`
        // fast-forwards, and refuses a branch that has diverged.
        if !head_matches(&found, head_sha).await {
            if let Err(e) = gh_checkout(&found, number, &branch).await {
                tracing::debug!(
                    target: "atlas::pull_requests",
                    kind = failure_kind(&e),
                    "refreshing a reused checkout failed"
                );
            }
        }
        let cwd = found.to_string_lossy().into_owned();
        return Ok(PrCheckout {
            branch,
            worktree_path: (!is_main).then(|| cwd.clone()),
            is_on_pull_request_head: head_matches(&found, head_sha).await,
            cwd,
            reused: true,
        });
    }

    let parent = worktrees_root.join(checkout_slug(&root));
    std::fs::create_dir_all(&parent).map_err(|e| PrError::failed(e.to_string()))?;
    // A folder left by a worktree whose registration is gone is pruned first;
    // one still in use gets a numbered sibling.
    let _ = git(&root, &["worktree", "prune"]).await;
    let mut dir = parent.join(format!("pr-{number}"));
    let mut attempt = 1;
    while dir.exists() {
        attempt += 1;
        dir = parent.join(format!("pr-{number}-{attempt}"));
    }
    let dir_str = dir.to_string_lossy().into_owned();
    git(
        &root,
        &["worktree", "add", "--detach", "--quiet", &dir_str, "HEAD"],
    )
    .await
    .map_err(|e| PrError::failed(format!("Could not make a worktree: {e}")))?;
    if let Err(e) = gh_checkout(&dir, number, &branch).await {
        let _ = git(&root, &["worktree", "remove", "--force", &dir_str]).await;
        let _ = std::fs::remove_dir_all(&dir);
        return Err(checkout_error(&e));
    }
    let dir = canonical(&dir);
    let cwd = dir.to_string_lossy().into_owned();
    Ok(PrCheckout {
        branch,
        is_on_pull_request_head: head_sha.is_none() || head_matches(&dir, head_sha).await,
        worktree_path: Some(cwd.clone()),
        cwd,
        reused: false,
    })
}

/// What "In this repository" refuses with when the tree has changes: the
/// same words the new-session-on-branch flow uses.
pub(super) const DIRTY_TREE_MESSAGE: &str =
    "The project has uncommitted changes, so Atlas left it alone.";

/// Switch the main checkout to the pull request's head, like `gh pr checkout`
/// run there. Already on the branch, it is used as it is. Refused when the
/// working tree has changes (untracked files count), checked right before the
/// switch so nothing read earlier can have gone stale, and when the branch is
/// checked out in another worktree, which git would refuse anyway.
async fn prepare_in_place(
    path: &Path,
    number: u64,
    head_branch: &str,
    head_sha: Option<&str>,
    cross_repository: bool,
) -> Result<PrCheckout, PrError> {
    if head_branch.is_empty() {
        return Err(PrError::invalid("The pull request names no head branch."));
    }
    let root = git(path, &["rev-parse", "--show-toplevel"])
        .await
        .map(|r| canonical(Path::new(r.trim())))
        .map_err(|_| PrError::invalid("This folder is not a git checkout."))?;
    let branch = local_branch_name(number, head_branch, cross_repository);
    if git(&root, &["check-ref-format", "--branch", &branch])
        .await
        .is_err()
    {
        return Err(PrError::invalid(
            "The pull request's branch name is not one git can check out.",
        ));
    }
    let cwd = root.to_string_lossy().into_owned();
    let current = git(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .await
        .ok();
    if current.as_deref() == Some(branch.as_str()) {
        return Ok(PrCheckout {
            branch,
            worktree_path: None,
            is_on_pull_request_head: head_matches(&root, head_sha).await,
            cwd,
            reused: true,
        });
    }
    let worktrees = git(&root, &["worktree", "list", "--porcelain"])
        .await
        .map(|p| parse_worktrees(&p))
        .unwrap_or_default();
    if worktrees
        .iter()
        .any(|(dir, b)| b.as_deref() == Some(branch.as_str()) && canonical(dir) != root)
    {
        return Err(PrError::invalid(
            "The pull request's branch is checked out in another worktree; open it there.",
        ));
    }
    let status = git(
        &root,
        &["status", "--porcelain", "--untracked-files=normal"],
    )
    .await
    .map_err(|e| PrError::failed(format!("Could not read the working tree: {e}")))?;
    if !status.trim().is_empty() {
        return Err(PrError::invalid(DIRTY_TREE_MESSAGE));
    }
    gh_checkout(&root, number, &branch)
        .await
        .map_err(|e| checkout_error(&e))?;
    Ok(PrCheckout {
        branch,
        worktree_path: None,
        is_on_pull_request_head: head_sha.is_none() || head_matches(&root, head_sha).await,
        cwd,
        reused: false,
    })
}

// ── leftovers ───────────────────────────────────────────────────────────

/// Whether a Fix worktree may be removed, from what is known about it. All of
/// it must hold: old enough that its session is surely recorded, no
/// unsettled session works in it, nothing uncommitted (untracked files
/// included), and its HEAD on a branch or reachable from one — a commit made
/// on a detached HEAD would otherwise go with the worktree.
pub(super) fn is_removable_leftover(
    age: Duration,
    in_use: bool,
    status_porcelain: Option<&str>,
    head_is_kept: bool,
) -> bool {
    age >= LEFTOVER_MIN_AGE
        && !in_use
        && status_porcelain.is_some_and(|s| s.trim().is_empty())
        && head_is_kept
}

/// Whether some branch or remote-tracking ref holds the worktree's HEAD.
async fn head_is_kept(dir: &Path) -> bool {
    if git(dir, &["symbolic-ref", "--quiet", "HEAD"]).await.is_ok() {
        return true;
    }
    git(
        dir,
        &[
            "for-each-ref",
            "--count=1",
            "--contains",
            "HEAD",
            "--format=%(refname)",
            "refs/heads",
            "refs/remotes",
        ],
    )
    .await
    .is_ok_and(|out| !out.trim().is_empty())
}

/// Remove the Fix worktrees under `app_data` that nothing needs any more
/// ([`is_removable_leftover`]), and the folders they leave empty. `live` is
/// every folder an unsettled session runs in. Answers how many were removed.
/// Without `--force`: git itself refuses a worktree with changes in it.
pub(crate) async fn sweep_leftovers(app_data: &Path, live: &[PathBuf], now: SystemTime) -> usize {
    let root = worktrees_root(app_data);
    let live: Vec<PathBuf> = live.iter().map(|p| canonical(p)).collect();
    let mut removed = 0;
    let Ok(checkouts) = std::fs::read_dir(&root) else {
        return 0;
    };
    for slug in checkouts.flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
        let Ok(entries) = std::fs::read_dir(&slug) else {
            continue;
        };
        for dir in entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
            let dir = canonical(&dir);
            let age = std::fs::metadata(&dir)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|at| now.duration_since(at).ok())
                .unwrap_or_default();
            let in_use = live.iter().any(|p| p.starts_with(&dir));
            if age < LEFTOVER_MIN_AGE || in_use {
                continue;
            }
            let status = git(&dir, &["status", "--porcelain", "--untracked-files=normal"])
                .await
                .ok();
            let kept = head_is_kept(&dir).await;
            if !is_removable_leftover(age, in_use, status.as_deref(), kept) {
                continue;
            }
            let Ok(common) = git(
                &dir,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            )
            .await
            else {
                continue;
            };
            let target = dir.to_string_lossy().into_owned();
            if git(Path::new(common.trim()), &["worktree", "remove", &target])
                .await
                .is_ok()
            {
                removed += 1;
            }
        }
        // Gone only when empty.
        let _ = std::fs::remove_dir(&slug);
    }
    if removed > 0 {
        tracing::debug!(target: "atlas::pull_requests", removed, "removed leftover pull request checkouts");
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A synchronous `git` for test setup.
    fn g(cwd: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim_end().to_string()
    }

    fn commit(cwd: &Path) {
        g(
            cwd,
            &[
                "-c",
                "user.name=a",
                "-c",
                "user.email=a@b",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "x",
            ],
        );
    }

    #[test]
    fn a_same_repository_head_keeps_its_branch_name() {
        assert_eq!(local_branch_name(12, "feat/x", false), "feat/x");
    }

    #[test]
    fn a_fork_head_gets_a_namespaced_branch() {
        assert_eq!(local_branch_name(12, "main", true), "atlas/pr-12/main");
        assert_eq!(
            local_branch_name(7, "Feature/Some Thing!", true),
            "atlas/pr-7/feature/some-thing"
        );
        assert_eq!(local_branch_name(7, "---", true), "atlas/pr-7/update");
    }

    #[test]
    fn worktree_porcelain_reads_paths_and_branches() {
        let porcelain = "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /wt/a\nHEAD def\ndetached\n\nworktree /wt/b\nHEAD 123\nbranch refs/heads/feat/x\n";
        let parsed = parse_worktrees(porcelain);
        assert_eq!(
            parsed,
            vec![
                (PathBuf::from("/repo"), Some("main".into())),
                (PathBuf::from("/wt/a"), None),
                (PathBuf::from("/wt/b"), Some("feat/x".into())),
            ]
        );
    }

    #[test]
    fn the_checkout_slug_is_stable_and_distinguishes_clones() {
        let a = checkout_slug(Path::new("/Users/me/code/atlas"));
        let b = checkout_slug(Path::new("/Users/me/other/atlas"));
        assert!(a.starts_with("atlas-"));
        assert_ne!(a, b);
        assert_eq!(a, checkout_slug(Path::new("/Users/me/code/atlas")));
    }

    #[test]
    fn ssh_is_told_never_to_prompt_and_keeps_the_user_s_command() {
        assert_eq!(batch_ssh_command(None), "ssh -o BatchMode=yes");
        assert_eq!(batch_ssh_command(Some("  ")), "ssh -o BatchMode=yes");
        assert_eq!(
            batch_ssh_command(Some("ssh -i ~/.ssh/work")),
            "ssh -i ~/.ssh/work -o BatchMode=yes"
        );
        assert_eq!(
            batch_ssh_command(Some("ssh -o BatchMode=no")),
            "ssh -o BatchMode=no"
        );
    }

    #[test]
    fn a_signed_out_gh_reads_as_not_authenticated() {
        let signed_out = RunError::Failed {
            exit: Some(4),
            stderr: "To get started with GitHub CLI, please run:  gh auth login\n".into(),
        };
        assert_eq!(checkout_error(&signed_out), PrError::NotAuthenticated);
        assert_eq!(failure_kind(&signed_out), "not-authenticated");
        assert_eq!(
            checkout_error(&RunError::NotInstalled),
            PrError::NotInstalled
        );
        assert!(matches!(
            checkout_error(&RunError::TimedOut),
            PrError::Network { .. }
        ));
        let other = RunError::Failed {
            exit: Some(1),
            stderr: "fatal: couldn't find remote ref refs/heads/x\n".into(),
        };
        assert_eq!(
            checkout_error(&other),
            PrError::failed(
                "gh could not check out the pull request: fatal: couldn't find remote ref refs/heads/x"
            )
        );
        // The log line names the kind only, never the stderr.
        assert_eq!(failure_kind(&other), "failed");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_process_past_its_timeout_is_killed() {
        let dir = tempfile::tempdir().unwrap();
        let started = std::time::Instant::now();
        assert_eq!(
            run(
                dir.path(),
                "/bin/sh",
                &["-c", "exec sleep 30"],
                Duration::from_millis(200)
            )
            .await,
            Err(RunError::TimedOut)
        );
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_networked_step_cannot_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let out = run_networked(
            dir.path(),
            "/bin/sh",
            &[
                "-c",
                r#"printf '%s|%s' "$GIT_TERMINAL_PROMPT" "$GIT_SSH_COMMAND""#,
            ],
            GIT_TIMEOUT,
        )
        .await
        .unwrap();
        let (prompt, ssh) = out.split_once('|').unwrap();
        assert_eq!(prompt, "0");
        if std::env::var_os("GIT_SSH").is_none() {
            assert!(ssh.contains("BatchMode"), "{ssh}");
        }
    }

    #[tokio::test]
    async fn a_missing_program_is_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            run(dir.path(), "atlas-no-such-program", &[], GIT_TIMEOUT).await,
            Err(RunError::NotInstalled)
        );
    }

    #[tokio::test]
    async fn a_branch_checked_out_in_the_main_checkout_is_used_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        g(&repo, &["init", "-q", "-b", "feat"]);
        commit(&repo);
        let sha = g(&repo, &["rev-parse", "HEAD"]);
        let out = prepare(&repo, &dir.path().join("wt"), 3, "feat", Some(&sha), false)
            .await
            .unwrap();
        assert!(out.reused);
        assert_eq!(out.worktree_path, None);
        assert!(out.is_on_pull_request_head);
        assert_eq!(out.cwd, canonical(&repo).to_string_lossy());
    }

    #[tokio::test]
    async fn a_branch_in_another_worktree_is_reused() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        g(&repo, &["init", "-q", "-b", "main"]);
        commit(&repo);
        let linked = dir.path().join("linked");
        g(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feat",
                linked.to_str().unwrap(),
            ],
        );
        let sha = g(&repo, &["rev-parse", "HEAD"]);
        let out = prepare(&repo, &dir.path().join("wt"), 3, "feat", Some(&sha), false)
            .await
            .unwrap();
        assert!(out.reused);
        assert_eq!(
            out.worktree_path.as_deref(),
            Some(canonical(&linked).to_str().unwrap())
        );
        // The main checkout stayed on its branch.
        assert_eq!(g(&repo, &["symbolic-ref", "--short", "HEAD"]), "main");
    }

    #[tokio::test]
    async fn in_place_refuses_a_dirty_tree_and_leaves_it_alone() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        g(&repo, &["init", "-q", "-b", "main"]);
        commit(&repo);
        std::fs::write(repo.join("scratch.txt"), "x").unwrap();
        let err = prepare_in_place(&repo, 3, "feat", None, false)
            .await
            .unwrap_err();
        assert_eq!(err, PrError::invalid(DIRTY_TREE_MESSAGE));
        assert_eq!(g(&repo, &["symbolic-ref", "--short", "HEAD"]), "main");
        assert!(repo.join("scratch.txt").exists());
    }

    #[tokio::test]
    async fn in_place_on_the_branch_already_is_used_as_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        g(&repo, &["init", "-q", "-b", "feat"]);
        commit(&repo);
        // Changes do not matter when nothing is switched.
        std::fs::write(repo.join("scratch.txt"), "x").unwrap();
        let sha = g(&repo, &["rev-parse", "HEAD"]);
        let out = prepare_in_place(&repo, 3, "feat", Some(&sha), false)
            .await
            .unwrap();
        assert!(out.reused);
        assert_eq!(out.worktree_path, None);
        assert!(out.is_on_pull_request_head);
    }

    #[tokio::test]
    async fn in_place_refuses_a_branch_held_by_another_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        g(&repo, &["init", "-q", "-b", "main"]);
        commit(&repo);
        let linked = dir.path().join("linked");
        g(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feat",
                linked.to_str().unwrap(),
            ],
        );
        let err = prepare_in_place(&repo, 3, "feat", None, false)
            .await
            .unwrap_err();
        assert!(matches!(err, PrError::Invalid { .. }), "{err:?}");
        assert_eq!(g(&repo, &["symbolic-ref", "--short", "HEAD"]), "main");
    }

    #[test]
    fn a_leftover_goes_only_when_nothing_would_be_lost() {
        let old = LEFTOVER_MIN_AGE;
        assert!(is_removable_leftover(old, false, Some(""), true));
        // Too young, in use, dirty, unreadable, or holding a detached commit.
        assert!(!is_removable_leftover(
            Duration::from_secs(60),
            false,
            Some(""),
            true
        ));
        assert!(!is_removable_leftover(old, true, Some(""), true));
        assert!(!is_removable_leftover(old, false, Some(" M a.txt\n"), true));
        assert!(!is_removable_leftover(
            old,
            false,
            Some("?? new.txt\n"),
            true
        ));
        assert!(!is_removable_leftover(old, false, None, true));
        assert!(!is_removable_leftover(old, false, Some(""), false));
    }

    #[tokio::test]
    async fn the_sweep_removes_clean_unused_worktrees_and_keeps_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        g(&repo, &["init", "-q", "-b", "main"]);
        commit(&repo);
        let app_data = dir.path().join("data");
        let parent = worktrees_root(&app_data).join("repo-0000");
        std::fs::create_dir_all(&parent).unwrap();
        let add = |name: &str, branch: &str| {
            let wt = parent.join(name);
            g(
                &repo,
                &["worktree", "add", "-q", "-b", branch, wt.to_str().unwrap()],
            );
            wt
        };
        let clean = add("pr-1", "one");
        let dirty = add("pr-2", "two");
        std::fs::write(dirty.join("notes.txt"), "keep me").unwrap();
        let live = add("pr-3", "three");
        let detached = parent.join("pr-4");
        g(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "--detach",
                detached.to_str().unwrap(),
            ],
        );
        commit(&detached);

        // Today: nothing is old enough.
        let now = SystemTime::now();
        assert_eq!(sweep_leftovers(&app_data, &[], now).await, 0);

        let later = now + LEFTOVER_MIN_AGE + Duration::from_secs(60);
        let removed = sweep_leftovers(&app_data, std::slice::from_ref(&live), later).await;
        assert_eq!(removed, 1);
        assert!(!clean.exists());
        assert!(dirty.join("notes.txt").exists());
        assert!(live.exists());
        assert!(detached.exists());
        // The branch survives its worktree.
        g(&repo, &["rev-parse", "--verify", "refs/heads/one"]);
    }
}

//! A repository's pull requests, read through the user's GitHub CLI.
//!
//! Not through `github.rs`: that client is unauthenticated, so it cannot see a
//! private repository, and a history card that shows PRs only for public repos
//! would be wrong most of the time without saying so. `gh` already holds the
//! user's own credentials and knows which GitHub repository the checkout's
//! remote points at, so asking it costs Atlas no token handling at all.
//!
//! One `gh pr list` per repository, not per branch: the agent sidebar mounts
//! every thread card at once, and a card per branch each spawning its own `gh`
//! was a burst of network-bound processes on every sidebar open. The answer is
//! the newest [`GH_LIMIT`] PRs of the repository, reduced here to the one PR
//! worth showing per head branch; the frontend shares that one answer between
//! every card in the repository. A branch whose PR is older than the newest
//! hundred shows none, which is the right trade for a sidebar label.
//!
//! The result says *why* there is nothing, because the two reasons call for
//! different behaviour: [`RepoPullRequests::Unavailable`] (no `gh`, or `gh`
//! not signed in) is true of every repository, so the caller stops asking for
//! the rest of the session; [`RepoPullRequests::Failed`] (not a GitHub remote,
//! offline, too slow) is about this repository at this moment. Neither is an
//! `Err` — the caller is a label on a sidebar card, and none is worth a toast.

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::io::Read;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

/// How long `gh` gets before it is killed. It goes to the network, so a
/// captive portal or a dead VPN would otherwise hold a blocking thread for as
/// long as the TCP stack cares to wait.
const GH_TIMEOUT: Duration = Duration::from_secs(5);

/// How many of the repository's PRs to ask for, newest first. Enough to cover
/// every branch a sidebar realistically lists; one page of GitHub's API.
const GH_LIMIT: &str = "100";

/// The most `gh` processes this module runs at once, across all repositories.
/// A sidebar listing threads from many worktrees would otherwise spawn one per
/// repository in the same instant.
static GH_PERMITS: Semaphore = Semaphore::const_new(2);

/// `gh`'s documented exit code for "authentication required".
const GH_EXIT_AUTH_REQUIRED: i32 = 4;

/// What a PR is now, lowercased from `gh`'s `OPEN` / `CLOSED` / `MERGED`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PullRequestState {
    Open,
    Closed,
    Merged,
}

/// The pull request whose head is a given branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchPullRequest {
    pub number: u64,
    pub state: PullRequestState,
    pub title: String,
    pub url: String,
    pub is_draft: bool,
}

/// The answer for one repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RepoPullRequests {
    /// `gh` answered: the PR worth showing for each head branch. A branch
    /// that is absent has no PR among the newest [`GH_LIMIT`].
    #[serde(rename_all = "camelCase")]
    Ok {
        by_branch: BTreeMap<String, BranchPullRequest>,
    },
    /// `gh` is not installed or not signed in — true of every repository, so
    /// the caller stops asking.
    Unavailable,
    /// `gh` could not answer for this repository: not a GitHub remote, not a
    /// repository, offline, timed out, or output Atlas could not read.
    Failed,
}

/// One element of `gh pr list --json number,title,state,isDraft,url,createdAt,headRefName`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPullRequest {
    number: u64,
    state: String,
    title: String,
    url: String,
    #[serde(default)]
    is_draft: bool,
    /// RFC 3339 in UTC (`2026-10-07T12:00:00Z`), so the strings order the
    /// same way the instants do.
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    head_ref_name: String,
}

/// The pull requests of the repository at `path`, one per head branch.
#[tauri::command]
pub async fn git_repo_pull_requests(path: String) -> Result<RepoPullRequests, String> {
    if path.trim().is_empty() {
        return Ok(RepoPullRequests::Failed);
    }
    // Held across the blocking run, so at most two `gh` exist at once.
    let Ok(_permit) = GH_PERMITS.acquire().await else {
        return Ok(RepoPullRequests::Failed);
    };
    let run = tokio::task::spawn_blocking(move || {
        run_gh(OsStr::new("gh"), &path, &gh_pr_list_args(), GH_TIMEOUT)
    })
    .await;
    Ok(match run {
        Ok(GhOutcome::Output(stdout)) => match parse_by_branch(&stdout) {
            Some(by_branch) => RepoPullRequests::Ok { by_branch },
            None => RepoPullRequests::Failed,
        },
        Ok(GhOutcome::Missing | GhOutcome::AuthRequired) => RepoPullRequests::Unavailable,
        Ok(GhOutcome::Failed) => RepoPullRequests::Failed,
        Err(e) => {
            tracing::warn!(error = %e, "gh pr list task failed");
            RepoPullRequests::Failed
        }
    })
}

fn gh_pr_list_args() -> Vec<&'static str> {
    vec![
        "pr",
        "list",
        "--state",
        "all",
        "--limit",
        GH_LIMIT,
        "--json",
        "number,title,state,isDraft,url,createdAt,headRefName",
    ]
}

/// How one run of `gh` ended.
#[derive(Debug, PartialEq, Eq)]
enum GhOutcome {
    /// Exit 0; its stdout.
    Output(String),
    /// The binary could not be started (not installed, not on `PATH`).
    Missing,
    /// `gh` says it needs `gh auth login`.
    AuthRequired,
    /// Any other non-zero exit, a timeout, or an I/O failure.
    Failed,
}

/// Run `program` with `args` in `cwd`, killing it after `timeout`. The
/// program is a parameter so tests can point it at a fake `gh`.
fn run_gh(program: &OsStr, cwd: &str, args: &[&str], timeout: Duration) -> GhOutcome {
    // A directory that is gone (a removed worktree) fails the spawn with the
    // same NotFound as a missing binary; it must not read as "no `gh`".
    if !std::path::Path::new(cwd).is_dir() {
        return GhOutcome::Failed;
    }
    let spawned = atlas_process::command(program)
        .args(args)
        .current_dir(cwd)
        // Never wait on a prompt nobody can see, never print upgrade nags.
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::debug!(error = %e, "gh not installed");
            return GhOutcome::Missing;
        }
        Err(e) => {
            tracing::debug!(error = %e, "gh failed to start");
            return GhOutcome::Failed;
        }
    };

    // Drained on its own thread so a large answer cannot fill the pipe and
    // stall the child. Its EOF is the child's exit, so waiting on the channel
    // with a deadline is the timeout — no polling loop.
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return GhOutcome::Failed;
    };
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut out = String::new();
        let _ = tx.send(stdout.read_to_string(&mut out).map(|_| out));
    });

    let stdout = match rx.recv_timeout(timeout) {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => {
            tracing::debug!(error = %e, "gh stdout read failed");
            let _ = child.kill();
            let _ = child.wait();
            return GhOutcome::Failed;
        }
        Err(_) => {
            tracing::debug!(cwd, "gh pr list timed out; killed");
            let _ = child.kill();
            let _ = child.wait();
            return GhOutcome::Failed;
        }
    };
    // Stdout closed, so the child has exited (or is about to): this does not
    // block for long.
    match child.wait() {
        Ok(status) if status.success() => GhOutcome::Output(stdout),
        Ok(status) if status.code() == Some(GH_EXIT_AUTH_REQUIRED) => GhOutcome::AuthRequired,
        Ok(status) => {
            // Not a GitHub remote, not a repository: nothing for this repo.
            tracing::debug!(cwd, ?status, "gh pr list exited non-zero");
            GhOutcome::Failed
        }
        Err(e) => {
            tracing::debug!(error = %e, "gh pr list wait failed");
            GhOutcome::Failed
        }
    }
}

/// Group `gh pr list --json` output by head branch and pick the PR worth
/// showing for each: an open one if there is one, else the most recently
/// created. `None` for output that is not the expected JSON; PRs in a state
/// Atlas does not know, or with no head branch, are skipped.
fn parse_by_branch(json: &str) -> Option<BTreeMap<String, BranchPullRequest>> {
    let prs: Vec<GhPullRequest> = serde_json::from_str(json).ok()?;
    let mut best: BTreeMap<String, (String, BranchPullRequest)> = BTreeMap::new();
    for pr in prs {
        if pr.head_ref_name.is_empty() {
            continue;
        }
        let state = match pr.state.to_ascii_uppercase().as_str() {
            "OPEN" => PullRequestState::Open,
            "CLOSED" => PullRequestState::Closed,
            "MERGED" => PullRequestState::Merged,
            _ => continue,
        };
        let candidate = (
            pr.created_at,
            BranchPullRequest {
                number: pr.number,
                state,
                title: pr.title,
                url: pr.url,
                is_draft: pr.is_draft,
            },
        );
        match best.get(&pr.head_ref_name) {
            Some(current) if !beats(&candidate, current) => {}
            _ => {
                best.insert(pr.head_ref_name, candidate);
            }
        }
    }
    Some(
        best.into_iter()
            .map(|(branch, (_, pr))| (branch, pr))
            .collect(),
    )
}

/// Whether `a` is the better PR to show for a branch than `b`: open beats
/// anything else, then the more recently created, then the higher number
/// (opened later at the same instant).
fn beats(a: &(String, BranchPullRequest), b: &(String, BranchPullRequest)) -> bool {
    let (a_at, a) = a;
    let (b_at, b) = b;
    let a_open = a.state == PullRequestState::Open;
    let b_open = b.state == PullRequestState::Open;
    a_open
        .cmp(&b_open)
        .then_with(|| a_at.cmp(b_at))
        .then_with(|| a.number.cmp(&b.number))
        .is_gt()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr_on(branch: &str, number: u64, state: &str, created_at: &str) -> String {
        format!(
            r#"{{"number":{number},"state":"{state}","title":"PR {number}","url":"https://github.com/o/r/pull/{number}","isDraft":false,"createdAt":"{created_at}","headRefName":"{branch}"}}"#
        )
    }

    fn pr(number: u64, state: &str, created_at: &str) -> String {
        pr_on("feature", number, state, created_at)
    }

    fn list(items: &[String]) -> String {
        format!("[{}]", items.join(","))
    }

    /// The PR chosen for the `feature` branch of a one-branch list.
    fn select(json: &str) -> Option<BranchPullRequest> {
        parse_by_branch(json)?.remove("feature")
    }

    #[test]
    fn an_empty_list_is_no_pull_request() {
        assert_eq!(parse_by_branch("[]"), Some(BTreeMap::new()));
    }

    #[test]
    fn output_that_is_not_the_expected_json_is_unreadable() {
        assert_eq!(parse_by_branch(""), None);
        assert_eq!(parse_by_branch("no pull requests found"), None);
        assert_eq!(parse_by_branch(r#"{"number":1}"#), None);
    }

    #[test]
    fn one_pull_request_is_returned_with_its_state_lowercased() {
        let json = r#"[{"number":353,"state":"OPEN","title":"Validate discount codes","url":"https://github.com/o/r/pull/353","isDraft":true,"createdAt":"2026-10-06T16:00:00Z","headRefName":"feature"}]"#;
        assert_eq!(
            select(json),
            Some(BranchPullRequest {
                number: 353,
                state: PullRequestState::Open,
                title: "Validate discount codes".into(),
                url: "https://github.com/o/r/pull/353".into(),
                is_draft: true,
            })
        );
    }

    #[test]
    fn an_open_pull_request_beats_a_newer_closed_one() {
        let json = list(&[
            pr(20, "MERGED", "2026-10-06T00:00:00Z"),
            pr(12, "OPEN", "2026-09-01T00:00:00Z"),
            pr(30, "CLOSED", "2026-10-07T00:00:00Z"),
        ]);
        assert_eq!(select(&json).map(|p| p.number), Some(12));
    }

    #[test]
    fn with_nothing_open_the_most_recent_wins_whatever_order_gh_used() {
        let json = list(&[
            pr(5, "MERGED", "2026-08-01T00:00:00Z"),
            pr(9, "CLOSED", "2026-10-01T00:00:00Z"),
            pr(7, "MERGED", "2026-09-01T00:00:00Z"),
        ]);
        let chosen = select(&json).unwrap();
        assert_eq!(chosen.number, 9);
        assert_eq!(chosen.state, PullRequestState::Closed);
    }

    #[test]
    fn at_the_same_instant_the_higher_number_wins() {
        let json = list(&[
            pr(41, "MERGED", "2026-10-01T00:00:00Z"),
            pr(42, "MERGED", "2026-10-01T00:00:00Z"),
        ]);
        assert_eq!(select(&json).map(|p| p.number), Some(42));
    }

    #[test]
    fn a_state_atlas_does_not_know_is_skipped_rather_than_guessed() {
        let json = list(&[
            pr(4, "MERGED", "2026-08-01T00:00:00Z"),
            pr(8, "LOCKED", "2026-10-01T00:00:00Z"),
        ]);
        assert_eq!(select(&json).map(|p| p.number), Some(4));
    }

    #[test]
    fn each_branch_gets_its_own_pick_from_a_mixed_list() {
        let json = list(&[
            pr_on("main", 1, "MERGED", "2026-01-01T00:00:00Z"),
            pr_on("feature", 10, "CLOSED", "2026-10-05T00:00:00Z"),
            pr_on("feature", 11, "OPEN", "2026-09-01T00:00:00Z"),
            pr_on("fix/login", 20, "MERGED", "2026-08-01T00:00:00Z"),
            pr_on("fix/login", 21, "CLOSED", "2026-09-15T00:00:00Z"),
            pr_on("", 99, "OPEN", "2026-10-07T00:00:00Z"),
        ]);
        let by_branch = parse_by_branch(&json).unwrap();
        let picked: Vec<(&str, u64)> = by_branch
            .iter()
            .map(|(b, p)| (b.as_str(), p.number))
            .collect();
        assert_eq!(
            picked,
            vec![("feature", 11), ("fix/login", 21), ("main", 1)]
        );
    }

    #[test]
    fn the_wire_shape_is_camel_case_with_a_lowercase_state() {
        let value = serde_json::to_value(BranchPullRequest {
            number: 1,
            state: PullRequestState::Merged,
            title: "t".into(),
            url: "u".into(),
            is_draft: false,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "number": 1,
                "state": "merged",
                "title": "t",
                "url": "u",
                "isDraft": false,
            })
        );
    }

    #[test]
    fn the_repo_answer_is_tagged_by_kind() {
        let mut by_branch = BTreeMap::new();
        by_branch.insert(
            "b".to_string(),
            BranchPullRequest {
                number: 2,
                state: PullRequestState::Open,
                title: "t".into(),
                url: "u".into(),
                is_draft: true,
            },
        );
        assert_eq!(
            serde_json::to_value(RepoPullRequests::Ok { by_branch }).unwrap(),
            serde_json::json!({
                "kind": "ok",
                "byBranch": {
                    "b": { "number": 2, "state": "open", "title": "t", "url": "u", "isDraft": true }
                },
            })
        );
        assert_eq!(
            serde_json::to_value(RepoPullRequests::Unavailable).unwrap(),
            serde_json::json!({ "kind": "unavailable" })
        );
        assert_eq!(
            serde_json::to_value(RepoPullRequests::Failed).unwrap(),
            serde_json::json!({ "kind": "failed" })
        );
    }

    #[cfg(unix)]
    mod runner {
        use super::super::*;
        use std::path::{Path, PathBuf};

        /// A fake `gh`: a shell script with `body`, in its own temp dir. Run
        /// through `/bin/sh` rather than exec'd directly, so a freshly written
        /// script cannot hit ETXTBSY when another test thread forks mid-write.
        fn fake_gh(body: &str) -> (tempfile::TempDir, PathBuf) {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("gh");
            std::fs::write(&path, format!("{body}\n")).unwrap();
            (dir, path)
        }

        fn run_in(script: &Path, cwd: &Path, timeout: Duration) -> GhOutcome {
            let mut args = vec![script.to_str().unwrap()];
            args.extend(gh_pr_list_args());
            run_gh(OsStr::new("/bin/sh"), cwd.to_str().unwrap(), &args, timeout)
        }

        fn run(script: &Path, timeout: Duration) -> GhOutcome {
            run_in(script, &std::env::temp_dir(), timeout)
        }

        #[test]
        fn a_successful_run_returns_its_stdout() {
            let (_dir, gh) = fake_gh(r#"printf '[]'"#);
            assert_eq!(run(&gh, GH_TIMEOUT), GhOutcome::Output("[]".into()));
        }

        #[test]
        fn the_arguments_ask_for_every_state_with_the_head_branch() {
            let (_dir, gh) = fake_gh(r#"printf '%s ' "$@""#);
            let GhOutcome::Output(argv) = run(&gh, GH_TIMEOUT) else {
                panic!("expected output");
            };
            assert!(argv.contains("pr list --state all --limit 100"), "{argv}");
            assert!(argv.contains("headRefName"), "{argv}");
        }

        #[test]
        fn a_non_zero_exit_is_a_failure_for_this_repository() {
            let (_dir, gh) = fake_gh("echo 'not a github remote' >&2; exit 1");
            assert_eq!(run(&gh, GH_TIMEOUT), GhOutcome::Failed);
        }

        #[test]
        fn exit_four_means_not_signed_in() {
            let (_dir, gh) = fake_gh("exit 4");
            assert_eq!(run(&gh, GH_TIMEOUT), GhOutcome::AuthRequired);
        }

        #[test]
        fn a_missing_binary_is_reported_as_missing() {
            let dir = tempfile::tempdir().unwrap();
            let missing = dir.path().join("gh");
            let outcome = run_gh(
                missing.as_os_str(),
                std::env::temp_dir().to_str().unwrap(),
                &gh_pr_list_args(),
                GH_TIMEOUT,
            );
            assert_eq!(outcome, GhOutcome::Missing);
        }

        #[test]
        fn a_directory_that_is_gone_is_a_failure_not_a_missing_gh() {
            let (_dir, gh) = fake_gh(r#"printf '[]'"#);
            let gone = std::env::temp_dir().join("atlas-git-pr-no-such-dir");
            assert_eq!(run_in(&gh, &gone, GH_TIMEOUT), GhOutcome::Failed);
        }

        #[test]
        fn a_run_past_the_timeout_is_killed_and_fails() {
            // `exec` so the kill reaches the sleeper itself, which holds stdout.
            let (_dir, gh) = fake_gh("exec sleep 30");
            let started = std::time::Instant::now();
            assert_eq!(run(&gh, Duration::from_millis(200)), GhOutcome::Failed);
            assert!(started.elapsed() < Duration::from_secs(10));
        }
    }
}

//! GitHub avatars for a repository's commit authors, read through the user's
//! GitHub CLI — for the same reasons as [`super::git_pr`]: `gh` already holds
//! the user's credentials (so private repositories work) and knows which
//! GitHub repository the checkout's remote points at.
//!
//! A commit's email says nothing GitHub-shaped on its own; only GitHub knows
//! which account an email belongs to. One `gh api` call for the newest
//! hundred commits of the current branch (one page of GitHub's API) answers that for every author
//! in them, and the frontend shares the answer between every avatar in the
//! repository. A branch GitHub does not have (unpushed, detached HEAD) costs a
//! second call, for the default branch, whose authors mostly overlap.
//!
//! The result says why there is nothing, from `git_pr`'s outcome:
//! [`RepoAvatars::Unavailable`] stops the caller asking for the session,
//! [`RepoAvatars::Failed`] is about this repository now. Neither is an `Err`:
//! the caller falls back to Gravatar, and no avatar is worth a toast.

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::git_pr::{run_gh, GhOutcome, GH_PERMITS, GH_TIMEOUT};

/// Only an avatar served from here is passed on: it is the one image origin
/// the webview's CSP admits for GitHub.
const AVATAR_ORIGIN: &str = "https://avatars.githubusercontent.com/";

/// Commits whose author is a GitHub account, reduced to email → avatar inside
/// `gh` so only the pairs cross the pipe.
const JQ: &str = concat!(
    "[.[] | select(.author != null)",
    " | {email: .commit.author.email, avatar: .author.avatar_url}]"
);

/// The answer for one repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RepoAvatars {
    /// Avatar URL per author email, the email lowercased.
    #[serde(rename_all = "camelCase")]
    Ok { by_email: BTreeMap<String, String> },
    /// `gh` is not installed or not signed in.
    Unavailable,
    /// `gh` could not answer for this repository: not a GitHub remote,
    /// offline, timed out, or output Atlas could not read.
    Failed,
}

#[derive(Debug, Deserialize)]
struct AuthorAvatar {
    email: Option<String>,
    avatar: Option<String>,
}

/// GitHub avatars for the authors of the repository at `path`.
#[tauri::command]
pub async fn git_repo_avatars(path: String) -> Result<RepoAvatars, String> {
    if path.trim().is_empty() {
        return Ok(RepoAvatars::Failed);
    }
    let Ok(_permit) = GH_PERMITS.acquire().await else {
        return Ok(RepoAvatars::Failed);
    };
    let run = tokio::task::spawn_blocking(move || {
        let gh = OsStr::new("gh");
        let started = Instant::now();
        match run_gh(gh, &path, &gh_api_args(true), GH_TIMEOUT) {
            // The branch may not exist on GitHub; its default branch does.
            // A run that used its whole timeout was offline or stuck, not
            // missing a branch — a second one would hold the shared permit
            // (and stall the PR badges) for nothing.
            GhOutcome::Failed(_) if started.elapsed() < GH_TIMEOUT => {
                run_gh(gh, &path, &gh_api_args(false), GH_TIMEOUT)
            }
            other => other,
        }
    })
    .await;
    Ok(match run {
        Ok(GhOutcome::Output(stdout)) => match parse_by_email(&stdout) {
            Some(by_email) => RepoAvatars::Ok { by_email },
            None => RepoAvatars::Failed,
        },
        Ok(GhOutcome::Missing | GhOutcome::AuthRequired) => RepoAvatars::Unavailable,
        Ok(GhOutcome::Failed(_)) => RepoAvatars::Failed,
        Err(e) => {
            tracing::warn!(error = %e, "gh api commits task failed");
            RepoAvatars::Failed
        }
    })
}

/// `gh` fills `{owner}`, `{repo}` and `{branch}` from the checkout.
fn gh_api_args(on_branch: bool) -> Vec<&'static str> {
    let endpoint = if on_branch {
        "repos/{owner}/{repo}/commits?sha={branch}&per_page=100"
    } else {
        "repos/{owner}/{repo}/commits?per_page=100"
    };
    vec!["api", endpoint, "--jq", JQ]
}

/// Email → avatar from the `--jq` output. `None` for output that is not the
/// expected JSON; pairs missing either half, or an avatar from anywhere but
/// [`AVATAR_ORIGIN`], are skipped. The first pair for an email wins — the
/// list is newest first, so that is the account's current avatar.
fn parse_by_email(json: &str) -> Option<BTreeMap<String, String>> {
    let pairs: Vec<AuthorAvatar> = serde_json::from_str(json).ok()?;
    let mut by_email = BTreeMap::new();
    for pair in pairs {
        let (Some(email), Some(avatar)) = (pair.email, pair.avatar) else {
            continue;
        };
        let email = email.trim().to_ascii_lowercase();
        if email.is_empty() || !avatar.starts_with(AVATAR_ORIGIN) {
            continue;
        }
        by_email.entry(email).or_insert(avatar);
    }
    Some(by_email)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairs_are_keyed_by_lowercased_email() {
        let json = r#"[{"email":"Dev@Acme.dev","avatar":"https://avatars.githubusercontent.com/u/1?v=4"}]"#;
        let by_email = parse_by_email(json).unwrap();
        assert_eq!(
            by_email.get("dev@acme.dev").map(String::as_str),
            Some("https://avatars.githubusercontent.com/u/1?v=4")
        );
    }

    #[test]
    fn the_newest_avatar_for_an_email_wins() {
        let json = r#"[
            {"email":"a@x.dev","avatar":"https://avatars.githubusercontent.com/u/2?v=4"},
            {"email":"a@x.dev","avatar":"https://avatars.githubusercontent.com/u/1?v=4"}
        ]"#;
        assert_eq!(
            parse_by_email(json).unwrap()["a@x.dev"],
            "https://avatars.githubusercontent.com/u/2?v=4"
        );
    }

    #[test]
    fn incomplete_pairs_and_foreign_origins_are_skipped() {
        let json = r#"[
            {"email":null,"avatar":"https://avatars.githubusercontent.com/u/1?v=4"},
            {"email":"b@x.dev","avatar":null},
            {"email":"c@x.dev","avatar":"https://evil.example/c.png"},
            {"email":"  ","avatar":"https://avatars.githubusercontent.com/u/3?v=4"}
        ]"#;
        assert_eq!(parse_by_email(json), Some(BTreeMap::new()));
    }

    #[test]
    fn output_that_is_not_the_expected_json_is_unreadable() {
        assert_eq!(parse_by_email(""), None);
        assert_eq!(parse_by_email(r#"{"message":"Not Found"}"#), None);
    }

    #[test]
    fn the_branch_call_asks_for_the_checked_out_branch() {
        assert!(gh_api_args(true)[1].contains("sha={branch}"));
        assert!(!gh_api_args(false)[1].contains("sha="));
    }

    #[test]
    fn the_wire_shape_is_tagged_by_kind() {
        let mut by_email = BTreeMap::new();
        by_email.insert("a@x.dev".to_string(), "u".to_string());
        assert_eq!(
            serde_json::to_value(RepoAvatars::Ok { by_email }).unwrap(),
            serde_json::json!({ "kind": "ok", "byEmail": { "a@x.dev": "u" } })
        );
        assert_eq!(
            serde_json::to_value(RepoAvatars::Unavailable).unwrap(),
            serde_json::json!({ "kind": "unavailable" })
        );
    }
}

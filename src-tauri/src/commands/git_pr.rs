//! Running the user's GitHub CLI (`gh`) with a timeout, and reading how it
//! ended.
//!
//! Not through `github.rs`: that client is unauthenticated, so it cannot see a
//! private repository. `gh` already holds the user's own credentials and knows
//! which GitHub repository the checkout's remote points at, so asking it costs
//! Atlas no token handling at all. `git_avatars` reads through it; pull
//! requests have their own client (`pull_requests/gh.rs`).
//!
//! The outcome says *why* there is nothing, because the reasons call for
//! different behaviour: [`GhOutcome::Missing`] and [`GhOutcome::AuthRequired`]
//! are true of every repository until the user fixes them;
//! [`GhOutcome::Failed`] is about this repository at this moment, and its
//! [`FailedReason`] says whether asking again soon can help.

use std::ffi::OsStr;
use std::io::Read;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::Semaphore;

/// How long `gh` gets before it is killed. It goes to the network, so a
/// captive portal or a dead VPN would otherwise hold a blocking thread for as
/// long as the TCP stack cares to wait.
pub(crate) const GH_TIMEOUT: Duration = Duration::from_secs(5);

/// The most `gh` processes this module runs at once, across all repositories.
/// A sidebar listing sessions from many worktrees would otherwise spawn one
/// per repository in the same instant.
pub(crate) static GH_PERMITS: Semaphore = Semaphore::const_new(2);

/// `gh`'s documented exit code for "authentication required".
const GH_EXIT_AUTH_REQUIRED: i32 = 4;

/// Why `gh` could not answer for this repository just now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FailedReason {
    /// Offline, a dead VPN, or too slow: worth asking again soon.
    Network,
    /// GitHub refused for its rate limit: ask again only after a pause.
    RateLimited,
    /// Not a GitHub remote, or not a repository: asking again will not help.
    Unsupported,
    /// Anything else, including output Atlas could not read.
    Other,
}

/// How one run of `gh` ended.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum GhOutcome {
    /// Exit 0; its stdout.
    Output(String),
    /// The binary could not be started (not installed, not on `PATH`).
    Missing,
    /// `gh` says it needs `gh auth login`.
    AuthRequired,
    /// Any other non-zero exit, a timeout, or an I/O failure, classified
    /// from `gh`'s stderr.
    Failed(FailedReason),
}

/// What a failed `gh` run's stderr says went wrong. Only the classification
/// leaves this function; the text (which can name the repository) is never
/// logged.
pub(crate) fn classify_failure(stderr: &str) -> FailedReason {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("rate limit") || lower.contains("http 429") {
        return FailedReason::RateLimited;
    }
    if lower.contains("none of the git remotes")
        || lower.contains("not a git repository")
        || lower.contains("no git remotes")
        || lower.contains("could not resolve to a repository")
        || lower.contains("not a github")
    {
        return FailedReason::Unsupported;
    }
    if lower.contains("error connecting")
        || lower.contains("dial tcp")
        || lower.contains("could not resolve host")
        || lower.contains("no such host")
        || lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("connection")
        || lower.contains("tls")
        || lower.contains("http 502")
        || lower.contains("http 503")
        || lower.contains("http 504")
    {
        return FailedReason::Network;
    }
    FailedReason::Other
}

/// Run `program` with `args` in `cwd`, killing it after `timeout`. The
/// program is a parameter so tests can point it at a fake `gh`.
pub(crate) fn run_gh(program: &OsStr, cwd: &str, args: &[&str], timeout: Duration) -> GhOutcome {
    // A directory that is gone (a removed worktree) fails the spawn with the
    // same NotFound as a missing binary; it must not read as "no `gh`".
    if !std::path::Path::new(cwd).is_dir() {
        return GhOutcome::Failed(FailedReason::Unsupported);
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
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::debug!(error = %e, "gh not installed");
            return GhOutcome::Missing;
        }
        Err(e) => {
            tracing::debug!(error = %e, "gh failed to start");
            return GhOutcome::Failed(FailedReason::Other);
        }
    };

    // Drained on its own thread so a large answer cannot fill the pipe and
    // stall the child. Its EOF is the child's exit, so waiting on the channel
    // with a deadline is the timeout — no polling loop.
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return GhOutcome::Failed(FailedReason::Other);
    };
    // Stderr drains on its own thread too, for the same reason; it is read
    // only to classify a failure.
    let stderr = child.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut err = String::new();
            let _ = pipe.read_to_string(&mut err);
            err
        })
    });
    let stderr_text = move || {
        stderr
            .and_then(|handle| handle.join().ok())
            .unwrap_or_default()
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
            return GhOutcome::Failed(FailedReason::Other);
        }
        Err(_) => {
            tracing::debug!("gh timed out; killed");
            let _ = child.kill();
            let _ = child.wait();
            return GhOutcome::Failed(FailedReason::Network);
        }
    };
    // Stdout closed, so the child has exited (or is about to): this does not
    // block for long.
    match child.wait() {
        Ok(status) if status.success() => GhOutcome::Output(stdout),
        Ok(status) if status.code() == Some(GH_EXIT_AUTH_REQUIRED) => GhOutcome::AuthRequired,
        Ok(status) => {
            let reason = classify_failure(&stderr_text());
            tracing::debug!(?status, ?reason, "gh exited non-zero");
            GhOutcome::Failed(reason)
        }
        Err(e) => {
            tracing::debug!(error = %e, "gh wait failed");
            GhOutcome::Failed(FailedReason::Other)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_is_classified_from_stderr() {
        assert_eq!(
            classify_failure("GraphQL: API rate limit exceeded for user ID 1."),
            FailedReason::RateLimited
        );
        assert_eq!(
            classify_failure(
                "none of the git remotes configured for this repository point to a known GitHub host"
            ),
            FailedReason::Unsupported
        );
        assert_eq!(
            classify_failure("error connecting to api.github.com"),
            FailedReason::Network
        );
        assert_eq!(classify_failure("something else"), FailedReason::Other);
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
            let args = [script.to_str().unwrap(), "pr", "list", "--state", "all"];
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
        fn the_arguments_reach_gh_in_order() {
            let (_dir, gh) = fake_gh(r#"printf '%s ' "$@""#);
            let GhOutcome::Output(argv) = run(&gh, GH_TIMEOUT) else {
                panic!("expected output");
            };
            assert!(argv.contains("pr list --state all"), "{argv}");
        }

        #[test]
        fn a_non_zero_exit_is_a_failure_for_this_repository() {
            let (_dir, gh) = fake_gh("echo 'not a github remote' >&2; exit 1");
            assert_eq!(
                run(&gh, GH_TIMEOUT),
                GhOutcome::Failed(FailedReason::Unsupported)
            );
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
                &["pr", "list"],
                GH_TIMEOUT,
            );
            assert_eq!(outcome, GhOutcome::Missing);
        }

        #[test]
        fn a_directory_that_is_gone_is_a_failure_not_a_missing_gh() {
            let (_dir, gh) = fake_gh(r#"printf '[]'"#);
            let gone = std::env::temp_dir().join("atlas-git-pr-no-such-dir");
            assert_eq!(
                run_in(&gh, &gone, GH_TIMEOUT),
                GhOutcome::Failed(FailedReason::Unsupported)
            );
        }

        #[test]
        fn a_run_past_the_timeout_is_killed_and_fails() {
            // `exec` so the kill reaches the sleeper itself, which holds stdout.
            let (_dir, gh) = fake_gh("exec sleep 30");
            let started = std::time::Instant::now();
            assert_eq!(
                run(&gh, Duration::from_millis(200)),
                GhOutcome::Failed(FailedReason::Network)
            );
            assert!(started.elapsed() < Duration::from_secs(10));
        }
    }
}

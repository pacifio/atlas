//! Typed git errors: classify raw stderr/stdout into a stable code the UI
//! can route on, plus a human message written for a person, not a parser.
//!
//! The pattern table is ported from dugite's `GitError` regexes and GitHub
//! Desktop's `getDescriptionForError` (core.ts) — first match wins, so
//! specific patterns must precede generic ones.

use regex::Regex;
use serde::Serialize;
use std::sync::OnceLock;

/// Stable machine-readable error codes. Serialized kebab-case; the frontend
/// routes each code to a dialog, a toast, or silence (`git-errors.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitErrorCode {
    /// HTTPS/SSH authentication failed (bad/absent credential, no agent).
    AuthFailed,
    /// Remote repo doesn't exist or we can't see it.
    RemoteNotFound,
    /// DNS/connection/timeout class failures.
    NetworkError,
    /// Push rejected because the remote is ahead — pull first.
    NonFastForward,
    /// `--force-with-lease` rejected (stale info).
    ForcePushRejected,
    /// Remote-side policy: protected branch / required review / GH hooks.
    ProtectedBranch,
    /// Push rejected for another remote-side reason (size limit, policy).
    PushRejected,
    MergeConflicts,
    RebaseConflicts,
    /// `refusing to merge unrelated histories`.
    UnrelatedHistories,
    /// Checkout/merge/pull would clobber local edits; `files` lists them.
    LocalChangesOverwritten,
    /// Operation needs a clean tree ("commit or stash them").
    UncommittedChanges,
    NothingToCommit,
    NoUpstream,
    BranchAlreadyExists,
    TagAlreadyExists,
    /// Bad revision / unknown ref / ambiguous argument.
    UnknownRef,
    NotARepository,
    /// `index.lock` (or a config lock) already exists; `hint` = lock path.
    LockFileExists,
    /// A local git hook exited non-zero (classified by the caller, which
    /// knows whether hooks exist — git prints no stable marker for this).
    HookFailed,
    GpgFailedToSign,
    /// abort/continue with nothing in progress.
    NoOpInProgress,
    /// Anything we couldn't classify. `raw_stderr` is all we know.
    Generic,
}

/// What a failed git command sends over IPC. `message` is the friendly line
/// the UI leads with; `raw_stderr` backs the "details" expando.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitErrorPayload {
    pub code: GitErrorCode,
    pub message: String,
    pub raw_stderr: String,
    /// The command as run, e.g. `git push --force-with-lease`.
    pub command: String,
    pub exit_code: Option<i32>,
    /// Populated for `LocalChangesOverwritten`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
    /// Extra machine context, e.g. the lock-file path for `LockFileExists`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl std::fmt::Display for GitErrorPayload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl GitErrorPayload {
    /// An internal (non-git) failure — spawn error, join error, bad input.
    pub fn internal(message: impl Into<String>) -> Self {
        let message = message.into();
        GitErrorPayload {
            code: GitErrorCode::Generic,
            raw_stderr: message.clone(),
            message,
            command: String::new(),
            exit_code: None,
            files: Vec::new(),
            hint: None,
        }
    }
}

struct Pattern {
    re: Regex,
    code: GitErrorCode,
}

/// Ordered match table — specific before generic, first match wins.
fn patterns() -> &'static [Pattern] {
    static PATTERNS: OnceLock<Vec<Pattern>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let p = |re: &str, code: GitErrorCode| Pattern {
            re: Regex::new(re).expect("static regex"),
            code,
        };
        vec![
            // ── Remote-side policy (before generic push failures) ─────────
            p(r"protected branch hook declined|GH006", GitErrorCode::ProtectedBranch),
            p(
                r"At least \d+ approving review is required|required status check",
                GitErrorCode::ProtectedBranch,
            ),
            p(r"GH013|push declined due to repository rule violations", GitErrorCode::PushRejected),
            p(r"exceeds GitHub's file size limit", GitErrorCode::PushRejected),
            p(r"\(stale info\)", GitErrorCode::ForcePushRejected),
            p(
                r"Updates were rejected because the (tip of your current branch is behind|remote contains work)",
                GitErrorCode::NonFastForward,
            ),
            p(r"\(non-fast-forward\)", GitErrorCode::NonFastForward),
            // ── Auth / remote reachability ────────────────────────────────
            p(r"(?i)fatal: Authentication failed", GitErrorCode::AuthFailed),
            p(r"could not read (Username|Password) for", GitErrorCode::AuthFailed),
            p(r"Permission denied \(publickey", GitErrorCode::AuthFailed),
            p(r"(?m)^ERROR: Permission to .* denied", GitErrorCode::AuthFailed),
            p(r"ERROR: Repository not found", GitErrorCode::RemoteNotFound),
            p(r"(?m)^fatal: repository '.*' not found", GitErrorCode::RemoteNotFound),
            p(
                r"does not appear to be a git repository",
                GitErrorCode::RemoteNotFound,
            ),
            p(
                r"Could not resolve host|Connection timed out|Connection refused|Operation timed out|The remote end hung up unexpectedly|Network is unreachable|Failed to connect to",
                GitErrorCode::NetworkError,
            ),
            // `Could not read from remote repository` covers both a missing
            // repo and a dead agent over SSH; auth is the likelier cause and
            // the friendlier prompt. Must come after the network patterns.
            p(
                r"fatal: Could not read from remote repository",
                GitErrorCode::AuthFailed,
            ),
            // ── Conflicts / dirty tree ────────────────────────────────────
            p(
                r"Resolve all conflicts manually|after resolving the conflicts|You must edit all merge conflicts",
                GitErrorCode::RebaseConflicts,
            ),
            p(r"(?m)^error: could not apply", GitErrorCode::RebaseConflicts),
            p(
                r"Automatic merge failed; fix conflicts",
                GitErrorCode::MergeConflicts,
            ),
            p(r"(?m)^CONFLICT \(", GitErrorCode::MergeConflicts),
            p(
                r"refusing to merge unrelated histories",
                GitErrorCode::UnrelatedHistories,
            ),
            p(
                r"Your local changes to the following files would be overwritten",
                GitErrorCode::LocalChangesOverwritten,
            ),
            p(
                r"Please commit your changes or stash them|cannot pull with rebase: You have unstaged changes|cannot \w+: You have unstaged changes|cannot \w+: Your index contains uncommitted changes",
                GitErrorCode::UncommittedChanges,
            ),
            p(
                r"There is no merge to abort|no cherry-pick or revert in progress|No rebase in progress",
                GitErrorCode::NoOpInProgress,
            ),
            // ── Local bookkeeping ─────────────────────────────────────────
            p(
                r"nothing to commit|no changes added to commit|nothing added to commit",
                GitErrorCode::NothingToCommit,
            ),
            p(r"has no upstream branch", GitErrorCode::NoUpstream),
            p(
                r"(?i)fatal: a branch named '.*' already exists",
                GitErrorCode::BranchAlreadyExists,
            ),
            p(r"(?m)^fatal: tag '.*' already exists", GitErrorCode::TagAlreadyExists),
            p(
                r"Unable to create '.*\.lock': File exists|could not lock config file .*: File exists",
                GitErrorCode::LockFileExists,
            ),
            p(r"gpg failed to sign the data", GitErrorCode::GpgFailedToSign),
            p(
                r"fatal: (bad revision|ambiguous argument|invalid reference)|unknown revision or path not in the working tree",
                GitErrorCode::UnknownRef,
            ),
            p(r"not a git repository", GitErrorCode::NotARepository),
        ]
    })
}

/// First matching code, or `Generic`. Checks stderr first (where git talks),
/// then stdout (some failures — e.g. merge conflicts — land there).
pub fn classify(stderr: &str, stdout: &str) -> GitErrorCode {
    for text in [stderr, stdout] {
        if text.is_empty() {
            continue;
        }
        for pat in patterns() {
            if pat.re.is_match(text) {
                return pat.code;
            }
        }
    }
    GitErrorCode::Generic
}

/// The files a `LocalChangesOverwritten` error would clobber: the
/// tab-indented block after the marker line.
fn overwritten_files(text: &str) -> Vec<String> {
    let mut files = Vec::new();
    let mut in_block = false;
    for line in text.lines() {
        if line.contains("would be overwritten") {
            in_block = true;
            continue;
        }
        if in_block {
            if let Some(f) = line.strip_prefix('\t') {
                files.push(f.trim().to_string());
            } else if !files.is_empty() {
                break;
            }
        }
    }
    files
}

/// The lock-file path out of `Unable to create '<path>': File exists` /
/// `could not lock config file <path>: File exists`.
fn lock_path(text: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"Unable to create '(.+\.lock)': File exists|could not lock config file (.+?): File exists")
            .expect("static regex")
    });
    let caps = re.captures(text)?;
    caps.get(1)
        .or_else(|| caps.get(2))
        .map(|m| m.as_str().to_string())
}

/// Friendly one-or-two-liner per code — what the UI leads with.
pub fn friendly_message(code: GitErrorCode, files: &[String], hint: Option<&str>) -> String {
    match code {
        GitErrorCode::AuthFailed => {
            "Authentication failed. Check that you're signed in, your credential helper or \
             SSH agent is set up, and you have access to this repository."
                .into()
        }
        GitErrorCode::RemoteNotFound => {
            "The remote repository could not be found. It may have been deleted, renamed, \
             or you may not have access to it."
                .into()
        }
        GitErrorCode::NetworkError => {
            "Couldn't reach the remote. Check your internet connection and try again.".into()
        }
        GitErrorCode::NonFastForward => {
            "The remote has commits you don't have yet. Pull before pushing.".into()
        }
        GitErrorCode::ForcePushRejected => {
            "The force push was rejected — the remote branch moved since you last fetched. \
             Fetch and review before forcing again."
                .into()
        }
        GitErrorCode::ProtectedBranch => {
            "The remote rejected this push: the branch is protected (force-pushes blocked, \
             reviews or status checks required)."
                .into()
        }
        GitErrorCode::PushRejected => "The remote rejected this push.".into(),
        GitErrorCode::MergeConflicts => {
            "The merge hit conflicts. Resolve them, then continue — or abort to undo the merge."
                .into()
        }
        GitErrorCode::RebaseConflicts => {
            "There are conflicts to resolve. Fix the conflicted files, then continue — or abort."
                .into()
        }
        GitErrorCode::UnrelatedHistories => {
            "These branches have unrelated histories and can't be merged.".into()
        }
        GitErrorCode::LocalChangesOverwritten => {
            let n = files.len();
            if n == 0 {
                "This would overwrite local changes. Commit or stash them first.".into()
            } else {
                format!(
                    "This would overwrite local changes to {n} file{}. Commit or stash them first.",
                    if n == 1 { "" } else { "s" }
                )
            }
        }
        GitErrorCode::UncommittedChanges => {
            "You have uncommitted changes in the way. Commit or stash them first.".into()
        }
        GitErrorCode::NothingToCommit => "There are no changes to commit.".into(),
        GitErrorCode::NoUpstream => {
            "This branch has no upstream yet. Publish it to set one.".into()
        }
        GitErrorCode::BranchAlreadyExists => "A branch with that name already exists.".into(),
        GitErrorCode::TagAlreadyExists => "A tag with that name already exists.".into(),
        GitErrorCode::UnknownRef => "That commit or branch couldn't be found.".into(),
        GitErrorCode::NotARepository => "This folder is not a git repository.".into(),
        GitErrorCode::LockFileExists => match hint {
            Some(p) => format!(
                "Another git process seems to be running (lock file {p} exists). If nothing \
                 is running, the lock can be removed."
            ),
            None => "Another git process seems to be running in this repository.".into(),
        },
        GitErrorCode::HookFailed => {
            "A git hook rejected this operation. See the hook's output below.".into()
        }
        GitErrorCode::GpgFailedToSign => {
            "GPG failed to sign the commit. Check your signing key and pinentry setup, or \
             disable commit signing for this repository."
                .into()
        }
        GitErrorCode::NoOpInProgress => "There is no operation in progress to act on.".into(),
        GitErrorCode::Generic => "The git command failed.".into(),
    }
}

/// Build the full IPC payload from a failed command's output.
pub fn payload(command: String, exit_code: Option<i32>, stderr: &str, stdout: &str) -> GitErrorPayload {
    let code = classify(stderr, stdout);
    let files = if code == GitErrorCode::LocalChangesOverwritten {
        let mut f = overwritten_files(stderr);
        if f.is_empty() {
            f = overwritten_files(stdout);
        }
        f
    } else {
        Vec::new()
    };
    let hint = if code == GitErrorCode::LockFileExists {
        lock_path(stderr).or_else(|| lock_path(stdout))
    } else {
        None
    };
    let message = friendly_message(code, &files, hint.as_deref());
    let raw = if stderr.trim().is_empty() { stdout } else { stderr };
    GitErrorPayload {
        code,
        message,
        raw_stderr: raw.trim().to_string(),
        command,
        exit_code,
        files,
        hint,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_auth_failures() {
        assert_eq!(
            classify("fatal: Authentication failed for 'https://github.com/x/y.git/'\n", ""),
            GitErrorCode::AuthFailed
        );
        assert_eq!(
            classify(
                "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
                ""
            ),
            GitErrorCode::AuthFailed
        );
        assert_eq!(
            classify("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n", ""),
            GitErrorCode::AuthFailed
        );
    }

    #[test]
    fn classifies_push_rejections_specifically() {
        let non_ff = "To github.com:x/y.git\n ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to 'github.com:x/y.git'\nhint: Updates were rejected because the tip of your current branch is behind\n";
        assert_eq!(classify(non_ff, ""), GitErrorCode::NonFastForward);

        let stale = " ! [rejected]        main -> main (stale info)\nerror: failed to push some refs\n";
        assert_eq!(classify(stale, ""), GitErrorCode::ForcePushRejected);

        let protected = "remote: error: GH006: Protected branch update failed for refs/heads/main.\n";
        assert_eq!(classify(protected, ""), GitErrorCode::ProtectedBranch);
    }

    #[test]
    fn classifies_conflicts_by_operation() {
        assert_eq!(
            classify("", "CONFLICT (content): Merge conflict in src/a.rs\nAutomatic merge failed; fix conflicts and then commit the result.\n"),
            GitErrorCode::MergeConflicts
        );
        assert_eq!(
            classify("error: could not apply abc1234... my change\nhint: Resolve all conflicts manually, mark them as resolved with\n", ""),
            GitErrorCode::RebaseConflicts
        );
    }

    #[test]
    fn extracts_overwritten_files() {
        let stderr = "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/a.rs\n\tsrc/b.rs\nPlease commit your changes or stash them before you switch branches.\nAborting\n";
        // The marker for LocalChangesOverwritten wins over the generic
        // "Please commit" pattern because it appears earlier in the table.
        let p = payload("git checkout main".into(), Some(1), stderr, "");
        assert_eq!(p.code, GitErrorCode::LocalChangesOverwritten);
        assert_eq!(p.files, vec!["src/a.rs", "src/b.rs"]);
        assert!(p.message.contains("2 files"));
    }

    #[test]
    fn extracts_lock_path() {
        let stderr = "fatal: Unable to create '/repo/.git/index.lock': File exists.\n";
        let p = payload("git add .".into(), Some(128), stderr, "");
        assert_eq!(p.code, GitErrorCode::LockFileExists);
        assert_eq!(p.hint.as_deref(), Some("/repo/.git/index.lock"));
    }

    #[test]
    fn nothing_to_commit_and_upstream() {
        assert_eq!(
            classify("", "On branch main\nnothing to commit, working tree clean\n"),
            GitErrorCode::NothingToCommit
        );
        assert_eq!(
            classify("fatal: The current branch feature-x has no upstream branch.\n", ""),
            GitErrorCode::NoUpstream
        );
    }

    #[test]
    fn unmatched_is_generic_with_raw_preserved() {
        let p = payload("git frobnicate".into(), Some(1), "error: something odd\n", "");
        assert_eq!(p.code, GitErrorCode::Generic);
        assert_eq!(p.raw_stderr, "error: something odd");
    }

    #[test]
    fn network_before_ssh_auth_fallback() {
        assert_eq!(
            classify("ssh: connect to host github.com port 22: Connection timed out\nfatal: Could not read from remote repository.\n", ""),
            GitErrorCode::NetworkError
        );
    }
}

//! The bit of git this crate needs, and nothing else.
//!
//! Shelling out to `git` rather than linking a git library is deliberate: the
//! repository is the user's, and the operations here are all *reads* whose exact
//! semantics — first-parent traversal, rename detection, stable patch-id — are
//! defined by git's own behaviour rather than by a reimplementation of it. A
//! library that disagreed with the user's git about what a rename is would
//! produce a Checkpoint that quietly attaches to the wrong commit.
//!
//! Nothing in this module writes. No hooks are installed, no refs are created,
//! no config is touched. The repository is observed and never modified.

use std::path::Path;
use std::process::Command;

/// Where a path stood in a commit, relative to its first parent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    /// New in this commit — it did not exist in the parent.
    Added,
    Modified,
    Deleted,
    /// Renamed; [`ChangedPath::previous_path`] holds where it came from.
    Renamed,
    Copied,
    TypeChanged,
}

impl ChangeKind {
    fn parse(status: &str) -> Option<Self> {
        match status.chars().next()? {
            'A' => Some(Self::Added),
            'M' => Some(Self::Modified),
            'D' => Some(Self::Deleted),
            'R' => Some(Self::Renamed),
            'C' => Some(Self::Copied),
            'T' => Some(Self::TypeChanged),
            _ => None,
        }
    }

    /// Did this path exist in the parent commit?
    ///
    /// The single question the asymmetric link rule turns on. A copy is treated
    /// as new: the destination path did not exist, so it must earn its link by
    /// content like any other new file.
    pub fn existed_in_parent(self) -> bool {
        !matches!(self, Self::Added | Self::Copied)
    }
}

#[derive(Debug, Clone)]
pub struct ChangedPath {
    pub path: String,
    pub kind: ChangeKind,
    /// For a rename, the path it had in the parent — which is the path the
    /// agent will have touched.
    pub previous_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CommitInfo {
    pub sha: String,
    /// Verbatim from the commit. Display-only: this is the identity on the
    /// commit, which is a different fact from the Atlas account whose agent ran.
    /// Pairing, rebasing a colleague's branch and bot commits all make them
    /// diverge, and git emails are self-asserted and never verified.
    pub author_name: String,
    pub author_email: String,
    pub parents: Vec<String>,
    /// Committer time, seconds since the epoch. The link walk refuses to link a
    /// commit to a Session that started *after* the commit was created — which
    /// is what makes the bounded recovery re-scan safe: historical commits that
    /// predate every Session can neither link nor consume its touches.
    pub commit_time: i64,
    pub subject: String,
}

impl CommitInfo {
    /// A commit with no parent — the root. Every path in it is new.
    pub fn is_initial(&self) -> bool {
        self.parents.is_empty()
    }

    /// A commit with more than one parent.
    pub fn is_merge(&self) -> bool {
        self.parents.len() > 1
    }
}

/// A `git` invocation failed, or the repository is not one.
#[derive(Debug)]
pub struct GitError(pub String);

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "git: {}", self.0)
    }
}

impl std::error::Error for GitError {}

type Result<T> = std::result::Result<T, GitError>;

fn run(repo: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| GitError(format!("{args:?}: {e}")))?;

    if !output.status.success() {
        return Err(GitError(format!(
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// A git invocation whose *exit status* carries meaning.
///
/// [`run`] folds any non-zero exit into an error, which is right for commands
/// where failure is failure. Reachability probes are different: `merge-base
/// --is-ancestor` answers "no" with exit 1, and conflating that with "the probe
/// could not run" is how a transient failure gets read as "unreachable" and
/// orphans a perfectly good Checkpoint. Here only a spawn failure is an error.
struct RunStatus {
    success: bool,
    stdout: String,
}

fn run_status(repo: &Path, args: &[&str]) -> Result<RunStatus> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| GitError(format!("{args:?}: {e}")))?;
    Ok(RunStatus {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
    })
}

/// Every path the working tree differs from HEAD at, right now.
///
/// The input to shell-write attribution. An agent that writes through a shell
/// command — `sed -i`, a redirect, a Makefile, a script — names no file
/// anywhere in the protocol, so the only way to know what it touched is to look
/// at the tree before the command and again after, and take the difference.
///
/// `None` means there is no answer (not a repository, or git failed), which the
/// caller must distinguish from `Some(empty)` — "nothing changed". Attributing
/// on a failed probe would credit a Session with every file in the tree.
///
/// `-z` because porcelain v1 quotes paths containing spaces or non-ASCII;
/// `--untracked-files=all` because the default collapses a new directory to
/// `dir/`, and a directory is not something a Checkpoint can link.
pub fn worktree_changes(repo: &Path) -> Option<std::collections::BTreeSet<String>> {
    if !is_repository(repo) {
        return None;
    }
    let out = run(
        repo,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )
    .ok()?;

    let mut paths = std::collections::BTreeSet::new();
    let mut fields = out.split('\0');
    while let Some(entry) = fields.next() {
        if entry.len() < 4 {
            continue;
        }
        let (status, path) = entry.split_at(3);
        if path.is_empty() {
            continue;
        }
        paths.insert(path.to_string());
        // A rename entry is followed by its ORIGIN path as a separate field.
        // Both sides changed, and the origin is the one a later commit records
        // as deleted, so neither may be dropped.
        if status.starts_with('R') || status.starts_with('C') {
            if let Some(origin) = fields.next() {
                if !origin.is_empty() {
                    paths.insert(origin.to_string());
                }
            }
        }
    }
    Some(paths)
}

/// The paths a commit RANGE changed, with each path's change kind.
///
/// The shell-attribution input for a command that committed its own writes
/// (#31): the tree is clean again by the time the after-snapshot runs, so the
/// window's evidence is `before_head..after_head` — the commits the command
/// itself made. The kind is what makes `existed_before` honest for these
/// paths: an `Added` file did not exist when the command started, whatever
/// the post-commit index now says.
///
/// `None` when the diff cannot be produced (not a repository, unknown shas);
/// the caller must treat that as "no answer", not "nothing changed".
pub fn changed_between(repo: &Path, from: &str, to: &str) -> Option<Vec<ChangedPath>> {
    let out = run(
        repo,
        &["diff", "--name-status", "-z", "-M", &format!("{from}..{to}")],
    )
    .ok()?;
    Some(parse_name_status(&out))
}

/// Is this directory a git repository?
///
/// Git is optional: a Workspace that is not a repository captures Sessions
/// perfectly well and simply never produces Checkpoints.
pub fn is_repository(repo: &Path) -> bool {
    repo.join(".git").exists() && run(repo, &["rev-parse", "--git-dir"]).is_ok()
}

/// The commit HEAD points at, or `None` for an unborn branch (a fresh `git init`
/// with nothing committed).
pub fn head_commit(repo: &Path) -> Option<String> {
    run(repo, &["rev-parse", "HEAD"])
        .ok()
        .map(|out| out.trim().to_string())
        .filter(|sha| !sha.is_empty())
}

/// The branch HEAD is on, or `None` when detached.
///
/// Detached HEAD still produces Checkpoints — the branch field is simply empty,
/// and the timeline's branch filter does not claim them.
pub fn current_branch(repo: &Path) -> Option<String> {
    let out = run(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok()?;
    let branch = out.trim();
    (!branch.is_empty()).then(|| branch.to_string())
}

/// Is this commit reachable from HEAD or any ref — branches **and tags**?
///
/// The question that decides whether a Checkpoint's commit still exists after a
/// history rewrite. Tags count: a commit kept alive only by a release tag is
/// permanently reachable, and orphaning its Checkpoint would be false.
///
/// Returns `Err` when the probe itself could not be trusted — the caller must
/// treat that as "unknown" and skip, never as "unreachable". A commit only in
/// the reflog *is* unreachable, which is the correct answer: a rebased-away
/// commit is gone as far as the history is concerned.
pub fn is_reachable(repo: &Path, sha: &str) -> Result<bool> {
    // HEAD ancestry first: the overwhelmingly common case, and one cheap check.
    // Exit 0 = ancestor; exit 1 = not; anything else falls through to the
    // ref scan, which distinguishes "gone" from "probe failed".
    let head = run_status(repo, &["merge-base", "--is-ancestor", sha, "HEAD"])?;
    if head.success {
        return Ok(true);
    }

    // `for-each-ref --contains` covers every ref — branches, tags, remotes.
    let refs = run_status(repo, &["for-each-ref", "--format=%(refname)", "--contains", sha])?;
    if refs.success {
        return Ok(!refs.stdout.trim().is_empty());
    }

    // The ref scan refused. Either the commit object no longer exists at all
    // (definitively unreachable — nothing can contain a missing object) or the
    // probe itself failed (lock contention, a mid-gc window). Only the first
    // may orphan; the second must surface as an error and be retried later.
    let exists = run_status(repo, &["cat-file", "-e", &format!("{sha}^{{commit}}")])?;
    if exists.success {
        Err(GitError(format!("reachability probe failed for {sha}")))
    } else {
        Ok(false)
    }
}

/// Commits reachable from `to` but not from `from`, oldest first.
///
/// **First-parent traversal.** `existed_before` is defined against "the parent
/// commit", and a merge has several. Following only the first parent gives
/// `git log --first-parent` semantics — the branch you were on when you merged —
/// which is what stops work that arrived via the merged-in branch from being
/// counted twice: once when it was originally committed, and again at the merge.
/// Plain `git pull` creates merge commits, so this is not an edge case.
pub fn commits_between(repo: &Path, from: Option<&str>, to: &str) -> Result<Vec<String>> {
    let range = match from {
        Some(from) => format!("{from}..{to}"),
        None => to.to_string(),
    };
    let out = run(repo, &["rev-list", "--first-parent", "--reverse", &range])?;
    Ok(out.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect())
}

/// The most recent `limit` commits from HEAD, oldest first.
///
/// The recovery path for a cursor that can no longer be resolved — garbage
/// collected, or rewritten away. `rev-list from..HEAD` fails outright in that
/// case, after which detection would silently stop forever, so a bounded
/// re-scan is what keeps a Workspace from going quietly dark. Re-processing is
/// harmless because `(Session, commit)` is the idempotency key.
pub fn recent_commits(repo: &Path, limit: usize) -> Result<Vec<String>> {
    let out = run(
        repo,
        &["rev-list", "--first-parent", "--reverse", "--max-count", &limit.to_string(), "HEAD"],
    )?;
    Ok(out.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect())
}

/// The repository's root commit — the identity that survives forks, folder
/// renames and remote changes.
///
/// **Advisory, never authoritative.** A shallow clone's grafted boundary is not
/// the true root, a squashed history has a different one, and every repository
/// created from the same GitHub template shares one. So this pre-selects and
/// warns; it never gates. Hard-gating on it would break every one of those, all
/// of which are repositories someone actually has.
pub fn root_commit(repo: &Path) -> Option<String> {
    let out = run(repo, &["rev-list", "--max-parents=0", "HEAD"]).ok()?;
    // A repository with several root commits (a merged-in unrelated history)
    // has no single fingerprint. The last is the oldest.
    out.lines().last().map(str::trim).map(str::to_string).filter(|s| !s.is_empty())
}

/// Is this a shallow clone?
///
/// Worth knowing precisely because its root commit is a graft boundary rather
/// than the true root — the fingerprint it yields is stored but must not be
/// treated as authoritative.
pub fn is_shallow(repo: &Path) -> bool {
    run(repo, &["rev-parse", "--is-shallow-repository"])
        .map(|out| out.trim() == "true")
        .unwrap_or(false)
}

/// The `origin` remote's URL, normalised.
pub fn origin_url(repo: &Path) -> Option<String> {
    let out = run(repo, &["remote", "get-url", "origin"]).ok()?;
    let url = out.trim();
    (!url.is_empty()).then(|| normalize_git_url(url))
}

/// Reduce a git remote URL to a comparable identity.
///
/// `git@github.com:tryatlas/atlas.git`, `https://github.com/tryatlas/atlas.git`
/// and `ssh://git@github.com/tryatlas/atlas` all describe the same repository,
/// and Connect has to recognise that — otherwise switching a remote from SSH to
/// HTTPS looks like a different project.
pub fn normalize_git_url(raw: &str) -> String {
    let mut url = raw.trim().to_string();

    for prefix in ["ssh://", "https://", "http://", "git://"] {
        if let Some(rest) = url.strip_prefix(prefix) {
            url = rest.to_string();
            break;
        }
    }
    // `git@host:owner/repo` — the scp-like form, where the colon is a path
    // separator rather than a port.
    if let Some(rest) = url.strip_prefix("git@") {
        url = rest.replacen(':', "/", 1);
    } else if let Some((userinfo, rest)) = url.split_once('@') {
        // Any other embedded credential is identity noise, not identity.
        if !userinfo.contains('/') {
            url = rest.to_string();
        }
    }

    url = url.trim_end_matches('/').to_string();
    url = url.strip_suffix(".git").unwrap_or(&url).to_string();
    url.to_lowercase()
}

/// Is a history rewrite in progress right now?
///
/// Mid-rebase, commits are transiently unreachable — the old ones are already
/// detached and the new ones do not exist yet. Reconciling in that window would
/// orphan Checkpoints that are about to be perfectly fine, and orphaning is not
/// something to do speculatively.
///
/// The watcher deliberately does not *watch* these directories (ref movement is
/// a sufficient trigger, and a completed rebase always moves refs), but checking
/// for them costs two `stat`s and turns "tolerate firing mid-rebase" from a hope
/// into a guarantee.
pub fn rewrite_in_progress(repo: &Path) -> bool {
    const MARKERS: [&str; 4] = ["rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "MERGE_HEAD"];

    // Resolved through `rev-parse --git-path` rather than assuming `.git/<marker>`:
    // in a linked worktree the markers live under the worktree's private gitdir
    // (`.git/worktrees/<name>/rebase-merge`), and the naive join would silently
    // never fire there — deferral would be a hope, not a guarantee, exactly
    // where a mid-rebase orphaning is most likely.
    if let Ok(out) = run(
        repo,
        &[
            "rev-parse",
            "--git-path", MARKERS[0],
            "--git-path", MARKERS[1],
            "--git-path", MARKERS[2],
            "--git-path", MARKERS[3],
        ],
    ) {
        return out
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .any(|line| {
                let path = Path::new(line);
                if path.is_absolute() {
                    path.exists()
                } else {
                    // `git -C <repo>` prints paths relative to the repo root.
                    repo.join(path).exists()
                }
            });
    }

    // rev-parse unavailable: the static layout still answers for the main
    // worktree, which is better than answering "no rewrite" unconditionally.
    let git_dir = repo.join(".git");
    MARKERS.iter().any(|marker| git_dir.join(marker).exists())
}

/// The most recent `limit` commits across **every** ref, newest first.
///
/// Distinct from [`recent_commits`], which follows the current branch's first
/// parent. A rewritten commit does not necessarily land on the branch that is
/// checked out — and the ambiguity that matters most, a cherry-pick, is by
/// definition the same diff on *two different branches*. Scanning only HEAD
/// would make that collision invisible and the re-match would confidently pick
/// the one candidate it happened to see.
pub fn recent_commits_all_refs(repo: &Path, limit: usize) -> Result<Vec<String>> {
    let out = run(repo, &["rev-list", "--all", "--max-count", &limit.to_string()])?;
    Ok(out.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect())
}

/// Every reachable commit's patch-id, as `patch_id -> [commit, …]`.
///
/// One pass rather than a `patch-id` invocation per candidate: a reconciliation
/// after an interactive rebase has to consider every rewritten commit against
/// every affected Checkpoint, and doing that pairwise would be quadratic in
/// subprocess spawns.
///
/// Fallible on purpose. A failed scan must not be readable as an *empty* map —
/// "no candidates" is what reconciliation turns into "no match, orphan", and a
/// transient git failure must never orphan anything.
pub fn patch_id_map(repo: &Path, limit: usize) -> Result<std::collections::HashMap<String, Vec<String>>> {
    let mut map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for commit in recent_commits_all_refs(repo, limit)? {
        // `None` for an empty diff, which is exactly right: the patch-id of an
        // empty diff is a constant, so letting empty commits into this map would
        // make every one of them a candidate match for every other.
        if let Some(id) = patch_id(repo, &commit) {
            map.entry(id).or_default().push(commit);
        }
    }
    Ok(map)
}

/// The commits a merge brought in from one side parent, oldest first, bounded.
///
/// `first_parent..side_parent`, merges excluded — the commits the first-parent
/// walk deliberately skipped. Work committed on a side branch while Atlas was
/// closed and then merged is linked through these, exactly once each: the
/// `(Session, commit)` idempotency key and touch consumption make re-seeing
/// them (a later merge of an already-walked branch) harmless.
pub fn merge_side_commits(
    repo: &Path,
    first_parent: &str,
    side_parent: &str,
    limit: usize,
) -> Result<Vec<String>> {
    let range = format!("{first_parent}..{side_parent}");
    let out = run(
        repo,
        &["rev-list", "--no-merges", "--reverse", "--max-count", &limit.to_string(), &range],
    )?;
    Ok(out.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect())
}

/// The branches a commit is on.
///
/// Used to break a patch-id tie: the classic ambiguity is a cherry-pick, where
/// the same diff is reachable at two commits on two branches.
pub fn branches_containing(repo: &Path, sha: &str) -> Vec<String> {
    let Ok(out) = run(repo, &["branch", "--format=%(refname:short)", "--contains", sha]) else {
        return Vec::new();
    };
    out.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('('))
        .map(str::to_string)
        .collect()
}

pub fn commit_info(repo: &Path, sha: &str) -> Result<CommitInfo> {
    // Unit-separator delimited so an author name containing the delimiter is
    // not a parsing hazard.
    let out = run(repo, &["show", "--no-patch", "--format=%H%x1f%an%x1f%ae%x1f%P%x1f%ct%x1f%s", sha])?;
    let line = out.lines().next().unwrap_or_default();
    let mut fields = line.split('\x1f');

    Ok(CommitInfo {
        sha: fields.next().unwrap_or(sha).to_string(),
        author_name: fields.next().unwrap_or_default().to_string(),
        author_email: fields.next().unwrap_or_default().to_string(),
        parents: fields
            .next()
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_string)
            .collect(),
        // Zero (the epoch) on a parse failure, which fails **closed**: the time
        // bound then refuses to link this commit to any Session rather than
        // linking it to all of them — a missing link is recoverable, a wrong
        // one corrupts a shared timeline.
        commit_time: fields.next().and_then(|f| f.trim().parse().ok()).unwrap_or(0),
        subject: fields.next().unwrap_or_default().to_string(),
    })
}

/// The paths a commit changed, relative to its first parent.
///
/// Rename detection is on (`-M`): a renamed file whose content is unchanged
/// still represents agent work that landed, and the agent will have touched it
/// under its *old* path.
pub fn changed_paths(repo: &Path, sha: &str) -> Result<Vec<ChangedPath>> {
    let out = run(
        repo,
        &[
            "show",
            "--first-parent",
            "--name-status",
            "-M",
            "--format=",
            "-z",
            sha,
        ],
    )?;
    Ok(parse_name_status(&out))
}

/// Parse `--name-status -z` output — shared by [`changed_paths`] and
/// [`changed_between`].
///
/// `-z` output is NUL-separated, and a rename entry is three fields: status,
/// old path, new path. Without it a path containing a quote or a newline is
/// silently mangled.
fn parse_name_status(out: &str) -> Vec<ChangedPath> {
    let mut fields = out.split('\0').filter(|f| !f.is_empty());
    let mut changes = Vec::new();
    while let Some(status) = fields.next() {
        let Some(kind) = ChangeKind::parse(status) else {
            continue;
        };
        match kind {
            ChangeKind::Renamed | ChangeKind::Copied => {
                let Some(previous) = fields.next() else { break };
                let Some(path) = fields.next() else { break };
                changes.push(ChangedPath {
                    path: path.to_string(),
                    kind,
                    previous_path: Some(previous.to_string()),
                });
            }
            _ => {
                let Some(path) = fields.next() else { break };
                changes.push(ChangedPath {
                    path: path.to_string(),
                    kind,
                    previous_path: None,
                });
            }
        }
    }
    changes
}

/// The content of a path as the commit recorded it.
///
/// Used to answer the new-file arm of the link rule: did the committed blob
/// match what the agent wrote? Returns `None` when the path is absent from the
/// commit (a deletion).
pub fn blob_at(repo: &Path, sha: &str, path: &str) -> Option<Vec<u8>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["cat-file", "blob", &format!("{sha}:{path}")])
        .output()
        .ok()?;
    output.status.success().then_some(output.stdout)
}

/// Whether `HEAD` already tracks this workspace-relative path.
///
/// The fallback answer for `existed_before` when the write-sampling probe
/// cannot run before the agent's write. A filesystem `exists()` is only
/// truthful when asked *before* the write — afterwards a file the agent just
/// created answers `true`, which is why the sampler records the strict arm
/// rather than re-probing. Git's index does not have that problem: a file the
/// agent created this turn is untracked in `HEAD` whenever we ask, and a file
/// that predates the turn is tracked whenever we ask. Order-independent, so a
/// late-locations agent gets the same answer an early-locations one does.
///
/// Deliberately `HEAD` and not the worktree: an untracked file the agent did
/// not create still takes the strict arm, which is the conservative direction
/// and costs nothing — such a path is new in whatever commit first carries it,
/// so the strict arm is where the link rule would send it anyway.
pub fn tracked_in_head(repo: &Path, path: &str) -> bool {
    // Set-backed: the write sampler asks this once per touched path,
    // synchronously on the delta emit thread, and the old per-path
    // `git cat-file -e` was a ~5-20ms process spawn each — a multi-file edit
    // turn paid N spawns before any subsequent delta could emit. One
    // `ls-tree -r HEAD` per (HEAD, index) epoch answers every path with a
    // hash lookup instead.
    match head_tracked_set(repo) {
        Some(set) => set.contains(path),
        // Unstampable layout (gitfile worktree, missing .git) — old behavior.
        None => tracked_in_head_probe(repo, path),
    }
}

/// The original single-path probe, kept as the fallback for repos the set
/// cache cannot safely stamp.
fn tracked_in_head_probe(repo: &Path, path: &str) -> bool {
    run_status(repo, &["cat-file", "-e", &format!("HEAD:{path}")])
        .is_ok_and(|status| status.success)
}

struct HeadTracked {
    head_mtime: std::time::SystemTime,
    index_mtime: std::time::SystemTime,
    paths: std::sync::Arc<std::collections::HashSet<String>>,
}

/// Per-repo cache of every path tracked in `HEAD`, invalidated when
/// `.git/HEAD` or `.git/index` changes mtime — a commit rewrites the index, a
/// branch switch rewrites both, so both epochs that can change the answer
/// bump a stamp. Staleness inside one mtime granule errs toward "untracked",
/// which is the conservative arm of the link rule (see `tracked_in_head`'s
/// docs). `None` when the repo layout can't be stamped (`.git` is a gitfile,
/// no index yet) — callers fall back to the per-path probe.
fn head_tracked_set(repo: &Path) -> Option<std::sync::Arc<std::collections::HashSet<String>>> {
    use std::collections::{HashMap, HashSet};
    use std::sync::{Arc, LazyLock, Mutex};

    static CACHE: LazyLock<Mutex<HashMap<std::path::PathBuf, HeadTracked>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    let git_dir = repo.join(".git");
    if !git_dir.is_dir() {
        return None; // gitfile worktree or not a repo — probe per path
    }
    let mtime = |p: std::path::PathBuf| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    let head_mtime = mtime(git_dir.join("HEAD"))?;
    let index_mtime = mtime(git_dir.join("index"))?;

    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = cache.get(repo) {
        if entry.head_mtime == head_mtime && entry.index_mtime == index_mtime {
            return Some(entry.paths.clone());
        }
    }
    // `-z`: raw NUL-separated paths (default output quotes special chars,
    // which would break membership tests against the sampler's plain paths).
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["ls-tree", "-r", "-z", "--name-only", "HEAD"])
        .output();
    let paths: HashSet<String> = match output {
        Ok(o) if o.status.success() => o
            .stdout
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect(),
        // No commits yet / git failed: an empty set is the honest answer
        // (nothing is tracked in HEAD) and stays conservative.
        _ => HashSet::new(),
    };
    let paths = Arc::new(paths);
    cache.insert(
        repo.to_path_buf(),
        HeadTracked {
            head_mtime,
            index_mtime,
            paths: paths.clone(),
        },
    );
    Some(paths)
}

/// The content of a path as it would appear in the **worktree** — the committed
/// blob with git's content filters (CRLF conversion, `text=auto`) applied on
/// the way out.
///
/// The strict arm of the link rule compares the committed blob against a hash
/// of the bytes the agent wrote into the worktree. On a repository that
/// normalises line endings, those two are legitimately different byte strings
/// for the same content: the agent wrote CRLF, the blob stores LF. Comparing
/// against the checkout form closes that gap without weakening the rule.
pub fn blob_at_filtered(repo: &Path, sha: &str, path: &str) -> Option<Vec<u8>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["cat-file", "--filters", &format!("{sha}:{path}")])
        .output()
        .ok()?;
    output.status.success().then_some(output.stdout)
}

/// Line counts for a commit, against its first parent.
pub fn line_stats(repo: &Path, sha: &str) -> (i64, i64) {
    let Ok(out) = run(
        repo,
        &["show", "--first-parent", "--numstat", "--format=", sha],
    ) else {
        return (0, 0);
    };

    let mut insertions = 0i64;
    let mut deletions = 0i64;
    for line in out.lines() {
        let mut fields = line.split('\t');
        // A binary file reports `-`, which is not a count and must not be
        // silently read as zero-and-fine.
        let added: i64 = fields.next().and_then(|f| f.parse().ok()).unwrap_or(0);
        let removed: i64 = fields.next().and_then(|f| f.parse().ok()).unwrap_or(0);
        insertions += added;
        deletions += removed;
    }
    (insertions, deletions)
}

/// Git's stable patch-id: a hash of the *diff* rather than of the commit.
///
/// This is what lets a rebased or amended commit be recognised as the same work
/// under a new hash — it is the same mechanism git itself uses to detect
/// already-applied commits during a rebase.
///
/// Returns `None` for an empty diff. That is not a failure: the patch-id of an
/// empty diff is a constant, so every empty commit would "match" every other,
/// and letting them participate would attach Checkpoints arbitrarily.
pub fn patch_id(repo: &Path, sha: &str) -> Option<String> {
    let diff = run(repo, &["diff-tree", "-p", "--first-parent", "--root", sha]).ok()?;
    if diff.trim().is_empty() {
        return None;
    }

    let mut child = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["patch-id", "--stable"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    {
        use std::io::Write;
        child.stdin.as_mut()?.write_all(diff.as_bytes()).ok()?;
    }

    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let id = stdout.split_whitespace().next()?;
    (!id.is_empty()).then(|| id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real repository, driven with real git commands — the only way to be
    /// sure about first-parent semantics and rename detection.
    pub(crate) struct TestRepo {
        pub dir: tempfile::TempDir,
    }

    impl TestRepo {
        pub fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let repo = Self { dir };
            repo.git(&["init", "--initial-branch=main"]);
            repo.git(&["config", "user.name", "Test Developer"]);
            repo.git(&["config", "user.email", "dev@example.com"]);
            repo
        }

        pub fn path(&self) -> &Path {
            self.dir.path()
        }

        pub fn git(&self, args: &[&str]) -> String {
            let output = Command::new("git")
                .arg("-C")
                .arg(self.path())
                .args(args)
                .output()
                .expect("git runs");
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).into_owned()
        }

        pub fn write(&self, path: &str, content: &str) {
            let full = self.path().join(path);
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(full, content).unwrap();
        }

        pub fn commit_all(&self, message: &str) -> String {
            self.git(&["add", "-A"]);
            self.git(&["commit", "-m", message]);
            head_commit(self.path()).expect("a commit")
        }
    }

    // ── Working-tree snapshots ──────────────────────────────────────────────

    /// The signal behind shell-write attribution: what the tree looks like
    /// before a command runs, and what it looks like after.
    #[test]
    fn a_worktree_snapshot_names_every_kind_of_change() {
        let repo = TestRepo::new();
        repo.write("kept.txt", "one");
        repo.write("removed.txt", "one");
        repo.commit_all("initial");

        assert!(
            worktree_changes(repo.path()).unwrap().is_empty(),
            "a clean tree changes nothing"
        );

        repo.write("kept.txt", "two"); // modified
        repo.write("fresh.txt", "new"); // untracked
        std::fs::remove_file(repo.path().join("removed.txt")).unwrap();

        let changed = worktree_changes(repo.path()).unwrap();
        assert!(changed.contains("kept.txt"), "{changed:?}");
        assert!(changed.contains("fresh.txt"), "{changed:?}");
        assert!(changed.contains("removed.txt"), "{changed:?}");
        assert_eq!(changed.len(), 3);
    }

    /// A file inside an untracked DIRECTORY still has to be named. Git's
    /// default status collapses it to `dir/`, which is not a path anything can
    /// be attributed to.
    #[test]
    fn a_file_in_a_new_directory_is_named_individually() {
        let repo = TestRepo::new();
        repo.write("seed.txt", "one");
        repo.commit_all("initial");
        repo.write("out/generated.txt", "made by a script");

        let changed = worktree_changes(repo.path()).unwrap();
        assert!(changed.contains("out/generated.txt"), "{changed:?}");
    }

    /// Staged and unstaged are the same answer here: the question is "did this
    /// file change since the command started", not "is it ready to commit".
    #[test]
    fn staging_a_change_does_not_hide_it() {
        let repo = TestRepo::new();
        repo.write("a.txt", "one");
        repo.commit_all("initial");
        repo.write("a.txt", "two");
        repo.git(&["add", "a.txt"]);

        assert!(worktree_changes(repo.path()).unwrap().contains("a.txt"));
    }

    /// A path with a space survives. Git quotes those in porcelain v1 output,
    /// and a naive split on whitespace would record half a filename.
    #[test]
    fn a_path_with_a_space_survives_the_snapshot() {
        let repo = TestRepo::new();
        repo.write("seed.txt", "one");
        repo.commit_all("initial");
        repo.write("my notes.txt", "hello");

        assert!(worktree_changes(repo.path()).unwrap().contains("my notes.txt"));
    }

    /// Not a repository is not an error — it is "no answer", and the caller
    /// must be able to tell that from "nothing changed".
    #[test]
    fn a_directory_that_is_not_a_repository_has_no_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        assert!(worktree_changes(dir.path()).is_none());
    }

    /// The #31 input: what a commit RANGE changed, with kinds — the evidence
    /// for a shell command that committed its own writes.
    #[test]
    fn a_range_diff_names_adds_edits_and_deletes_with_their_kinds() {
        let repo = TestRepo::new();
        repo.write("kept.txt", "one");
        repo.write("gone.txt", "one");
        let before = repo.commit_all("seed");

        repo.write("kept.txt", "two");
        repo.write("fresh.txt", "new");
        std::fs::remove_file(repo.path().join("gone.txt")).unwrap();
        repo.commit_all("first");
        repo.write("fresh.txt", "newer");
        let after = repo.commit_all("second");

        let mut changes = changed_between(repo.path(), &before, &after).unwrap();
        changes.sort_by(|a, b| a.path.cmp(&b.path));
        let summary: Vec<(String, ChangeKind)> =
            changes.into_iter().map(|c| (c.path, c.kind)).collect();
        assert_eq!(
            summary,
            vec![
                ("fresh.txt".to_string(), ChangeKind::Added),
                ("gone.txt".to_string(), ChangeKind::Deleted),
                ("kept.txt".to_string(), ChangeKind::Modified),
            ],
            "the range collapses both commits into one honest delta"
        );
    }

    /// Unknown shas are "no answer", which the caller must distinguish from
    /// "nothing changed" — attributing on a failed diff would be a guess.
    #[test]
    fn a_range_diff_with_an_unknown_sha_has_no_answer() {
        let repo = TestRepo::new();
        repo.write("a.txt", "x");
        let head = repo.commit_all("seed");
        assert!(changed_between(repo.path(), "0000000000000000000000000000000000000000", &head)
            .is_none());
    }

    #[test]
    fn a_fresh_repository_is_recognised_and_has_no_head() {
        let repo = TestRepo::new();
        assert!(is_repository(repo.path()));
        assert_eq!(head_commit(repo.path()), None, "unborn branch");
    }

    #[test]
    fn a_non_repository_is_recognised_as_such() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_repository(dir.path()));
    }

    #[test]
    fn the_initial_commit_has_no_parent_and_every_path_is_new() {
        let repo = TestRepo::new();
        repo.write("src/lib.rs", "fn main() {}");
        let sha = repo.commit_all("initial");

        let info = commit_info(repo.path(), &sha).unwrap();
        assert!(info.is_initial());
        assert!(!info.is_merge());
        assert_eq!(info.author_name, "Test Developer");
        assert_eq!(info.author_email, "dev@example.com");

        let changed = changed_paths(repo.path(), &sha).unwrap();
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].path, "src/lib.rs");
        assert_eq!(changed[0].kind, ChangeKind::Added);
        assert!(!changed[0].kind.existed_in_parent());
    }

    #[test]
    fn a_modification_reports_the_path_as_pre_existing() {
        let repo = TestRepo::new();
        repo.write("src/lib.rs", "fn main() {}");
        repo.commit_all("initial");
        repo.write("src/lib.rs", "fn main() { run(); }");
        let sha = repo.commit_all("change");

        let changed = changed_paths(repo.path(), &sha).unwrap();
        assert_eq!(changed[0].kind, ChangeKind::Modified);
        assert!(changed[0].kind.existed_in_parent());
    }

    #[test]
    fn a_rename_reports_where_the_file_came_from() {
        let repo = TestRepo::new();
        repo.write("src/old.rs", "fn main() {}\n// enough content to detect\n");
        repo.commit_all("initial");
        repo.git(&["mv", "src/old.rs", "src/new.rs"]);
        let sha = repo.commit_all("rename");

        let changed = changed_paths(repo.path(), &sha).unwrap();
        let rename = changed.iter().find(|c| c.kind == ChangeKind::Renamed);
        let rename = rename.expect("rename detected");
        assert_eq!(rename.path, "src/new.rs");
        assert_eq!(rename.previous_path.as_deref(), Some("src/old.rs"));
    }

    #[test]
    fn a_deletion_is_reported_as_such() {
        let repo = TestRepo::new();
        repo.write("src/gone.rs", "fn main() {}");
        repo.commit_all("initial");
        std::fs::remove_file(repo.path().join("src/gone.rs")).unwrap();
        let sha = repo.commit_all("delete");

        let changed = changed_paths(repo.path(), &sha).unwrap();
        assert_eq!(changed[0].kind, ChangeKind::Deleted);
    }

    #[test]
    fn a_merge_commit_is_evaluated_against_its_first_parent() {
        // Work that arrived via the side branch was linked when it was
        // committed; showing it again at the merge would double-count it.
        let repo = TestRepo::new();
        repo.write("base.rs", "base");
        repo.commit_all("initial");

        repo.git(&["checkout", "-b", "side"]);
        repo.write("side.rs", "side");
        repo.commit_all("side work");

        repo.git(&["checkout", "main"]);
        repo.write("main.rs", "main");
        repo.commit_all("main work");

        repo.git(&["merge", "--no-ff", "side", "-m", "merge side"]);
        let merge = head_commit(repo.path()).unwrap();

        let info = commit_info(repo.path(), &merge).unwrap();
        assert!(info.is_merge());

        // Against the first parent, the merge brings in only the side branch's
        // file — and the *commits* walk skips the side branch entirely.
        let changed = changed_paths(repo.path(), &merge).unwrap();
        assert!(changed.iter().any(|c| c.path == "side.rs"));
        assert!(!changed.iter().any(|c| c.path == "main.rs"));
    }

    #[test]
    fn the_commit_walk_follows_only_the_first_parent() {
        let repo = TestRepo::new();
        repo.write("base.rs", "base");
        let base = repo.commit_all("initial");

        repo.git(&["checkout", "-b", "side"]);
        repo.write("side.rs", "side");
        let side = repo.commit_all("side work");

        repo.git(&["checkout", "main"]);
        repo.write("main.rs", "main");
        repo.commit_all("main work");
        repo.git(&["merge", "--no-ff", "side", "-m", "merge side"]);

        let walked = commits_between(repo.path(), Some(&base), "HEAD").unwrap();
        assert!(
            !walked.contains(&side),
            "the side branch commit must not be walked again at the merge"
        );
    }

    #[test]
    fn commits_between_returns_oldest_first() {
        let repo = TestRepo::new();
        repo.write("a", "1");
        let first = repo.commit_all("one");
        repo.write("b", "2");
        let second = repo.commit_all("two");
        repo.write("c", "3");
        let third = repo.commit_all("three");

        let walked = commits_between(repo.path(), Some(&first), "HEAD").unwrap();
        assert_eq!(walked, vec![second, third]);
    }

    #[test]
    fn a_detached_head_reports_no_branch_but_still_has_a_commit() {
        let repo = TestRepo::new();
        repo.write("a", "1");
        let first = repo.commit_all("one");
        repo.write("b", "2");
        repo.commit_all("two");

        assert_eq!(current_branch(repo.path()).as_deref(), Some("main"));
        repo.git(&["checkout", "--detach", &first]);
        assert_eq!(current_branch(repo.path()), None);
        assert_eq!(head_commit(repo.path()).as_deref(), Some(first.as_str()));
    }

    #[test]
    fn a_committed_blob_can_be_read_back_for_the_content_check() {
        let repo = TestRepo::new();
        repo.write("src/lib.rs", "fn main() {}");
        let sha = repo.commit_all("initial");

        assert_eq!(
            blob_at(repo.path(), &sha, "src/lib.rs").as_deref(),
            Some(b"fn main() {}".as_slice())
        );
        assert!(blob_at(repo.path(), &sha, "nope.rs").is_none());
    }

    #[test]
    fn line_stats_count_both_directions() {
        let repo = TestRepo::new();
        repo.write("a.rs", "one\ntwo\nthree\n");
        repo.commit_all("initial");
        repo.write("a.rs", "one\ntwo\n");
        let sha = repo.commit_all("trim");

        let (insertions, deletions) = line_stats(repo.path(), &sha);
        assert_eq!(insertions, 0);
        assert_eq!(deletions, 1);
    }

    #[test]
    fn a_patch_id_is_stable_across_a_rewrite_of_the_same_change() {
        let repo = TestRepo::new();
        repo.write("a.rs", "one\n");
        repo.commit_all("initial");
        repo.write("a.rs", "one\ntwo\n");
        let before = repo.commit_all("add two");
        let id_before = patch_id(repo.path(), &before).expect("a patch id");

        // Amend the message only: the diff is identical, the sha is not.
        repo.git(&["commit", "--amend", "-m", "add the second line"]);
        let after = head_commit(repo.path()).unwrap();
        assert_ne!(before, after, "amend rewrites the sha");
        assert_eq!(
            patch_id(repo.path(), &after).as_deref(),
            Some(id_before.as_str()),
            "patch-id hashes the diff, not the commit"
        );
    }

    #[test]
    fn an_empty_commit_has_no_patch_id() {
        // Its patch-id is a constant, so every empty commit would match every
        // other one. Excluding them is what stops that.
        let repo = TestRepo::new();
        repo.write("a.rs", "one\n");
        repo.commit_all("initial");
        repo.git(&["commit", "--allow-empty", "-m", "empty"]);
        let sha = head_commit(repo.path()).unwrap();
        assert_eq!(patch_id(repo.path(), &sha), None);
    }

    #[test]
    fn a_rewritten_away_commit_stops_being_reachable() {
        let repo = TestRepo::new();
        repo.write("a.rs", "one\n");
        repo.commit_all("initial");
        repo.write("a.rs", "one\ntwo\n");
        let before = repo.commit_all("add two");
        assert!(is_reachable(repo.path(), &before).unwrap());

        repo.git(&["reset", "--hard", "HEAD~1"]);
        assert!(!is_reachable(repo.path(), &before).unwrap());
    }

    #[test]
    fn a_commit_kept_alive_only_by_a_tag_is_still_reachable() {
        // A tagged release whose branch was rewritten away is permanently
        // reachable; calling it unreachable would orphan its Checkpoint over a
        // commit that is very much still in history.
        let repo = TestRepo::new();
        repo.write("a.rs", "one\n");
        repo.commit_all("initial");
        repo.write("a.rs", "one\ntwo\n");
        let tagged = repo.commit_all("add two");
        repo.git(&["tag", "v1.0"]);
        repo.git(&["reset", "--hard", "HEAD~1"]);

        assert!(is_reachable(repo.path(), &tagged).unwrap());
    }

    #[test]
    fn commit_info_carries_the_committer_time() {
        let repo = TestRepo::new();
        repo.write("a.rs", "one\n");
        let sha = repo.commit_all("initial");
        let info = commit_info(repo.path(), &sha).unwrap();
        // A real recent timestamp, not the parse-failure epoch fallback.
        assert!(info.commit_time > 1_500_000_000, "got {}", info.commit_time);
    }

    #[test]
    fn merge_side_commits_returns_the_side_branchs_commits_oldest_first() {
        let repo = TestRepo::new();
        repo.write("base.rs", "base");
        repo.commit_all("initial");

        repo.git(&["checkout", "-b", "side"]);
        repo.write("side1.rs", "one");
        let side1 = repo.commit_all("side one");
        repo.write("side2.rs", "two");
        let side2 = repo.commit_all("side two");

        repo.git(&["checkout", "main"]);
        repo.write("main.rs", "main");
        repo.commit_all("main work");
        repo.git(&["merge", "--no-ff", "side", "-m", "merge side"]);
        let merge = head_commit(repo.path()).unwrap();

        let info = commit_info(repo.path(), &merge).unwrap();
        let sides =
            merge_side_commits(repo.path(), &info.parents[0], &info.parents[1], 200).unwrap();
        assert_eq!(sides, vec![side1, side2]);
    }

    #[test]
    fn a_rewrite_in_a_linked_worktree_is_detected_through_the_resolved_gitdir() {
        // A linked worktree's rebase markers live under the private gitdir
        // (`.git/worktrees/<name>/`), not under `.git/` — the naive join never
        // sees them, and deferral would silently not happen mid-rebase.
        let repo = TestRepo::new();
        repo.write("a.rs", "one\n");
        repo.commit_all("initial");

        let wt_parent = tempfile::tempdir().unwrap();
        let wt = wt_parent.path().join("linked");
        repo.git(&["worktree", "add", wt.to_str().unwrap()]);
        assert!(!rewrite_in_progress(&wt));

        let marker = run(&wt, &["rev-parse", "--git-path", "rebase-merge"]).unwrap();
        let marker = marker.trim();
        let marker_path = if Path::new(marker).is_absolute() {
            Path::new(marker).to_path_buf()
        } else {
            wt.join(marker)
        };
        std::fs::create_dir_all(&marker_path).unwrap();

        assert!(rewrite_in_progress(&wt), "the worktree's own markers must count");
        assert!(!rewrite_in_progress(repo.path()), "the main worktree is not rebasing");
    }

    #[test]
    fn a_filtered_blob_read_applies_the_checkout_conversion() {
        let repo = TestRepo::new();
        repo.write(".gitattributes", "*.txt text eol=crlf\n");
        repo.commit_all("attributes");
        repo.write("notes.txt", "one\r\ntwo\r\n");
        let sha = repo.commit_all("notes");

        // The blob itself is normalised to LF at commit…
        assert_eq!(
            blob_at(repo.path(), &sha, "notes.txt").as_deref(),
            Some(b"one\ntwo\n".as_slice())
        );
        // …and the filtered read returns the worktree (checkout) form.
        assert_eq!(
            blob_at_filtered(repo.path(), &sha, "notes.txt").as_deref(),
            Some(b"one\r\ntwo\r\n".as_slice())
        );
    }

    #[test]
    fn head_tracking_answers_the_same_before_and_after_a_write() {
        // The whole point of preferring git over a filesystem probe: the
        // sampler often only learns a path *after* the agent wrote it, and
        // `exists()` cannot tell "edited what was here" from "created this".
        let repo = TestRepo::new();
        repo.write("README.md", "one\n");
        repo.commit_all("initial");

        assert!(tracked_in_head(repo.path(), "README.md"));
        repo.write("README.md", "one\ntwo\n");
        assert!(
            tracked_in_head(repo.path(), "README.md"),
            "a pre-existing file stays tracked after the agent edits it"
        );

        // A file the agent creates this turn is untracked whenever we ask, so
        // it keeps taking the strict arm.
        repo.write("brand_new.rs", "fn main() {}\n");
        assert!(!tracked_in_head(repo.path(), "brand_new.rs"));
        repo.git(&["add", "brand_new.rs"]);
        assert!(
            !tracked_in_head(repo.path(), "brand_new.rs"),
            "staging is not committing — HEAD still does not carry it"
        );
    }

    #[test]
    fn head_tracking_is_false_rather_than_fatal_outside_a_repository() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!tracked_in_head(dir.path(), "README.md"));

        // An unborn branch has no HEAD to resolve, and must not panic.
        let repo = TestRepo::new();
        repo.write("README.md", "one\n");
        assert!(!tracked_in_head(repo.path(), "README.md"));
    }

    #[test]
    fn head_tracking_does_not_confuse_a_directory_for_a_file() {
        let repo = TestRepo::new();
        repo.write("src/main.rs", "fn main() {}\n");
        repo.commit_all("initial");

        assert!(tracked_in_head(repo.path(), "src/main.rs"));
        assert!(!tracked_in_head(repo.path(), "src/other.rs"));
    }

    #[test]
    fn the_all_refs_scan_sees_commits_that_are_not_on_the_current_branch() {
        // The reason reconciliation cannot scan HEAD alone: a cherry-pick puts
        // the same diff on another branch, and a candidate scan that misses it
        // would confidently re-point at the one commit it happened to see.
        let repo = TestRepo::new();
        repo.write("a.rs", "one\n");
        repo.commit_all("initial");
        repo.git(&["checkout", "-b", "side"]);
        repo.write("side.rs", "side\n");
        let side = repo.commit_all("only on side");
        repo.git(&["checkout", "main"]);

        assert!(
            !recent_commits(repo.path(), 50).unwrap().contains(&side),
            "the first-parent scan follows only the current branch"
        );
        assert!(
            recent_commits_all_refs(repo.path(), 50).unwrap().contains(&side),
            "the all-refs scan must see it"
        );
    }

    #[test]
    fn a_rewrite_in_progress_is_detected_from_gits_own_markers() {
        let repo = TestRepo::new();
        repo.write("a.rs", "one\n");
        repo.commit_all("initial");
        assert!(!rewrite_in_progress(repo.path()));

        std::fs::create_dir_all(repo.path().join(".git/rebase-merge")).unwrap();
        assert!(rewrite_in_progress(repo.path()));
    }

    #[test]
    fn the_root_commit_is_the_oldest_and_survives_later_history() {
        let repo = TestRepo::new();
        repo.write("a", "1");
        let root = repo.commit_all("initial");
        repo.write("b", "2");
        repo.commit_all("second");
        assert_eq!(root_commit(repo.path()).as_deref(), Some(root.as_str()));
    }

    #[test]
    fn a_repository_with_no_commits_has_no_fingerprint() {
        assert_eq!(root_commit(TestRepo::new().path()), None);
    }

    #[test]
    fn remote_urls_normalise_to_the_same_identity() {
        // Switching a remote from SSH to HTTPS must not look like a different
        // project.
        let expected = "github.com/tryatlas/atlas";
        for raw in [
            "git@github.com:tryatlas/atlas.git",
            "https://github.com/tryatlas/atlas.git",
            "https://github.com/tryatlas/atlas",
            "ssh://git@github.com/tryatlas/atlas.git",
            "https://github.com/TryAtlas/Atlas.git",
            "https://token:x-oauth-basic@github.com/tryatlas/atlas.git",
            "git://github.com/tryatlas/atlas.git/",
        ] {
            assert_eq!(normalize_git_url(raw), expected, "for {raw}");
        }
    }

    #[test]
    fn different_repositories_do_not_normalise_together() {
        assert_ne!(
            normalize_git_url("git@github.com:tryatlas/atlas.git"),
            normalize_git_url("git@github.com:tryatlas/server.git")
        );
    }

    #[test]
    fn a_repository_with_no_remote_reports_no_origin() {
        let repo = TestRepo::new();
        repo.write("a", "1");
        repo.commit_all("initial");
        assert_eq!(origin_url(repo.path()), None);
    }

    #[test]
    fn an_origin_is_read_and_normalised() {
        let repo = TestRepo::new();
        repo.write("a", "1");
        repo.commit_all("initial");
        repo.git(&["remote", "add", "origin", "git@github.com:tryatlas/atlas.git"]);
        assert_eq!(
            origin_url(repo.path()).as_deref(),
            Some("github.com/tryatlas/atlas")
        );
    }

    #[test]
    fn an_ordinary_clone_is_not_shallow() {
        let repo = TestRepo::new();
        repo.write("a", "1");
        repo.commit_all("initial");
        assert!(!is_shallow(repo.path()));
    }

    #[test]
    fn a_bounded_rescan_returns_the_most_recent_commits() {
        let repo = TestRepo::new();
        let mut shas = Vec::new();
        for i in 0..5 {
            repo.write("a.rs", &format!("line {i}\n"));
            shas.push(repo.commit_all(&format!("commit {i}")));
        }
        let recent = recent_commits(repo.path(), 3).unwrap();
        assert_eq!(recent, shas[2..].to_vec());
    }
}

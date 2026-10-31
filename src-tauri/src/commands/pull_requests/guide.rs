//! The Guide tab's git side: a read-only checkout of a pull request's head for
//! the agent that writes the guide, the change it is measured against, and the
//! written guide, kept per pull request and per head commit.
//!
//! The guide itself is written by an agent session the frontend runs in the
//! background (`pull-request-guide-run.ts`): Atlas has no model call of its own
//! that can read a checkout, and a guide written without reading the change is
//! refused rather than written blind. This module gives that session somewhere
//! to look and keeps what it wrote:
//!
//! - [`pr_guide_prepare`] fetches the base branch into a ref of the run's own,
//!   finds the head commit (local objects, the commit, the branch, then
//!   `refs/pull/<n>/head`), adds a detached worktree at it under Atlas's data
//!   directory, and reads the change (`<merge-base>...HEAD`): the changed
//!   files and each file's hunk ranges, which the frontend clamps the guide's
//!   excerpts to;
//! - [`pr_guide_finish`] removes the worktree and the base ref; a run the
//!   app quit or crashed during is removed by the next [`pr_guide_prepare`]
//!   once it is [`STALE_RUN_AGE_MS`] old ([`prune_stale_runs`]);
//! - [`pr_guide_read`] / [`pr_guide_write`] keep the latest guide for a pull
//!   request. The guide names the head commit it was written for, so the tab
//!   can tell a guide written before the latest push. The guide is stored as
//!   the frontend wrote it; its shape is checked there.
//!
//! Every `git` here is bounded (ADR-0008): each step by its own timeout, and
//! the search for the head across remotes by [`FIND_HEAD_DEADLINE`] in all.
//!
//! Nothing here logs a repository, branch or path.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::checkout::{git, run, run_networked, GIT_TIMEOUT, NETWORK_TIMEOUT};
use super::model::PrError;

/// How long the head commit is looked for across every remote and source.
const FIND_HEAD_DEADLINE: Duration = Duration::from_secs(180);
/// A run this old is over, whatever became of the session that wrote it.
pub(crate) const STALE_RUN_AGE_MS: i64 = 6 * 60 * 60_000;

/// One file's changed line ranges, inclusive, on each side.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PrGuideHunks {
    pub new: Vec<[u32; 2]>,
    pub old: Vec<[u32; 2]>,
}

/// The change a guide is written against.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PrGuideChange {
    pub files: Vec<String>,
    pub hunks: BTreeMap<String, PrGuideHunks>,
}

/// A guide run's checkout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrGuideCheckout {
    pub run_id: String,
    /// The detached worktree at the head commit.
    pub path: String,
    /// The merge base the change is measured from.
    pub base_commit: String,
    /// The head commit, in full.
    pub head_commit: String,
    pub change: PrGuideChange,
}

const COMMIT_HASH_LEN: std::ops::RangeInclusive<usize> = 7..=64;
static RUN_COUNTER: AtomicU64 = AtomicU64::new(0);

fn data_dir(app: &AppHandle) -> Result<PathBuf, PrError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| PrError::failed(e.to_string()))?
        .join("pull-request-guides"))
}

/// The file a pull request's guide is kept in. Keyed by repository and number,
/// hashed so no name a host allows can escape the folder.
fn guide_file(dir: &Path, repository: &str, number: u64) -> PathBuf {
    let key = format!("{}#{number}", repository.trim().to_lowercase());
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in key.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    dir.join("stored").join(format!("{hash:016x}.json"))
}

/// The guide last written for this pull request, whichever head it was for.
#[tauri::command]
pub async fn pr_guide_read(
    app: AppHandle,
    repository: String,
    number: u64,
) -> Result<Option<Value>, PrError> {
    let number = super::pull_number(number)?;
    let file = guide_file(&data_dir(&app)?, &repository, number);
    tokio::task::spawn_blocking(move || match std::fs::read_to_string(&file) {
        Ok(text) => Ok(serde_json::from_str(&text).ok()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(PrError::failed(e.to_string())),
    })
    .await
    .map_err(|e| PrError::failed(e.to_string()))?
}

/// Keep `guide` as this pull request's guide, replacing the last one.
#[tauri::command]
pub async fn pr_guide_write(
    app: AppHandle,
    repository: String,
    number: u64,
    guide: Value,
) -> Result<(), PrError> {
    let number = super::pull_number(number)?;
    if !guide.is_object() {
        return Err(PrError::invalid("A guide is an object."));
    }
    let file = guide_file(&data_dir(&app)?, &repository, number);
    tokio::task::spawn_blocking(move || {
        let parent = file.parent().expect("guide files sit in a folder");
        std::fs::create_dir_all(parent).map_err(|e| PrError::failed(e.to_string()))?;
        let tmp = file.with_extension("json.tmp");
        let text = serde_json::to_string(&guide).map_err(|e| PrError::failed(e.to_string()))?;
        std::fs::write(&tmp, text).map_err(|e| PrError::failed(e.to_string()))?;
        std::fs::rename(&tmp, &file).map_err(|e| PrError::failed(e.to_string()))
    })
    .await
    .map_err(|e| PrError::failed(e.to_string()))?
}

/// Check out the pull request's head, detached, for a guide run, and read the
/// change it makes.
#[tauri::command]
pub async fn pr_guide_prepare(
    app: AppHandle,
    path: String,
    number: u64,
    head_sha: String,
    head_branch: String,
    base_branch: String,
) -> Result<PrGuideCheckout, PrError> {
    let path = super::checkout(&path)?.to_string();
    let number = super::pull_number(number)?;
    let runs = data_dir(&app)?.join("runs");
    prepare(
        Path::new(&path),
        &runs,
        number,
        head_sha.trim(),
        head_branch.trim(),
        base_branch.trim(),
    )
    .await
}

/// Remove a guide run's worktree and base ref. Best-effort: a run that left
/// something behind is removed by a later [`pr_guide_prepare`] once it is
/// stale.
#[tauri::command]
pub async fn pr_guide_finish(app: AppHandle, path: String, run_id: String) -> Result<(), PrError> {
    let path = super::checkout(&path)?.to_string();
    if run_id.is_empty()
        || !run_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(PrError::invalid("That is not a guide run."));
    }
    let runs = data_dir(&app)?.join("runs");
    finish(Path::new(&path), &runs, &run_id).await;
    Ok(())
}

const RUN_REF_PREFIX: &str = "refs/atlas/pr-guide/";

fn base_ref(run_id: &str) -> String {
    format!("{RUN_REF_PREFIX}{run_id}/base")
}

async fn finish(root: &Path, runs: &Path, run_id: &str) {
    let dir = runs.join(run_id);
    let checkout = dir.join("checkout");
    let _ = git(
        root,
        &["worktree", "remove", "--force", &checkout.to_string_lossy()],
    )
    .await;
    let _ = std::fs::remove_dir_all(&dir);
    let _ = git(root, &["update-ref", "-d", &base_ref(run_id)]).await;
    let _ = git(root, &["worktree", "prune"]).await;
}

/// When a run began, from its id (`<epoch ms>-<counter>`).
fn run_started_ms(run_id: &str) -> Option<i64> {
    let (ms, counter) = run_id.split_once('-')?;
    (!counter.is_empty() && counter.chars().all(|c| c.is_ascii_digit()))
        .then(|| ms.parse().ok())
        .flatten()
}

/// The run ids among `ids` that began [`STALE_RUN_AGE_MS`] or more before `now`.
pub(super) fn stale_run_ids<'a>(ids: impl IntoIterator<Item = &'a str>, now: i64) -> Vec<String> {
    ids.into_iter()
        .filter(|id| run_started_ms(id).is_some_and(|at| now - at >= STALE_RUN_AGE_MS))
        .map(str::to_string)
        .collect()
}

/// Remove what stale runs left: their folders under `runs` (which can belong
/// to any checkout — another repository's registration is pruned by its own
/// next `git worktree prune`), and this checkout's stale base refs.
pub(super) async fn prune_stale_runs(root: &Path, runs: &Path, now: i64) {
    let dirs: Vec<String> = std::fs::read_dir(runs)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|e| e.file_name().to_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    for run_id in stale_run_ids(dirs.iter().map(String::as_str), now) {
        let checkout = runs.join(&run_id).join("checkout");
        let _ = git(
            root,
            &["worktree", "remove", "--force", &checkout.to_string_lossy()],
        )
        .await;
        let _ = std::fs::remove_dir_all(runs.join(&run_id));
    }
    let refs = git(
        root,
        &["for-each-ref", "--format=%(refname)", RUN_REF_PREFIX],
    )
    .await
    .unwrap_or_default();
    let ids: Vec<&str> = refs
        .lines()
        .filter_map(|r| r.strip_prefix(RUN_REF_PREFIX)?.strip_suffix("/base"))
        .collect();
    for run_id in stale_run_ids(ids, now) {
        let _ = git(root, &["update-ref", "-d", &base_ref(&run_id)]).await;
    }
    let _ = git(root, &["worktree", "prune"]).await;
}

/// The guide runs' folders, across every checkout, that are stale: what the
/// launch sweep removes without a repository to hand.
pub(crate) fn remove_stale_run_dirs(app_data: &Path, now: i64) -> usize {
    let runs = app_data.join("pull-request-guides").join("runs");
    let dirs: Vec<String> = std::fs::read_dir(&runs)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|e| e.file_name().to_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    stale_run_ids(dirs.iter().map(String::as_str), now)
        .into_iter()
        .filter(|id| std::fs::remove_dir_all(runs.join(id)).is_ok())
        .count()
}

fn is_commit_hash(sha: &str) -> bool {
    COMMIT_HASH_LEN.contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit())
}

/// The commit `sha` names here, only when it is that commit — `rev-parse`
/// prefers a branch or tag named like a short hash.
async fn resolve_commit(root: &Path, sha: &str) -> Option<String> {
    let resolved = git(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{sha}^{{commit}}"),
        ],
    )
    .await
    .ok()?
    .trim()
    .to_lowercase();
    resolved.starts_with(sha).then_some(resolved)
}

async fn remotes(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = git(root, &["remote"])
        .await
        .map(|out| {
            out.lines()
                .map(str::to_string)
                .filter(|n| !n.is_empty())
                .collect()
        })
        .unwrap_or_default();
    // `origin` first: the clone's own remote is the likeliest to have the head.
    names.sort_by_key(|n| n != "origin");
    names
}

async fn fetch(root: &Path, remote: &str, refspec: &str, timeout: Duration) -> Result<(), String> {
    run_networked(
        root,
        "git",
        &["fetch", "--quiet", "--no-tags", "--", remote, refspec],
        timeout,
    )
    .await
    .map(|_| ())
    .map_err(|e| e.line())
}

/// The head commit, from wherever it can be found, in the reference's order.
async fn find_head(
    root: &Path,
    remotes: &[String],
    number: u64,
    sha: &str,
    branch: &str,
) -> Result<String, PrError> {
    if let Some(found) = resolve_commit(root, sha).await {
        return Ok(found);
    }
    let branch_ref = format!("refs/heads/{branch}");
    let branch_ok =
        !branch.is_empty() && git(root, &["check-ref-format", &branch_ref]).await.is_ok();
    let mut sources: Vec<String> = Vec::new();
    if sha.len() == 40 || sha.len() == 64 {
        sources.push(sha.to_string());
    }
    if branch_ok {
        sources.push(branch_ref);
    }
    sources.push(format!("refs/pull/{number}/head"));
    let mut failures: Vec<String> = Vec::new();
    let deadline = Instant::now() + FIND_HEAD_DEADLINE;
    'search: for remote in remotes {
        for source in &sources {
            // Each fetch gets what is left of the whole search's time.
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                failures.push("gave up looking after three minutes".into());
                break 'search;
            }
            match fetch(root, remote, source, left.min(NETWORK_TIMEOUT)).await {
                Ok(()) => {
                    if let Some(found) = resolve_commit(root, sha).await {
                        return Ok(found);
                    }
                }
                Err(e) => failures.push(e),
            }
        }
    }
    Err(PrError::failed(format!(
        "Could not find the pull request's head commit here.{}",
        failures
            .last()
            .map(|e| format!(" Last error: {e}"))
            .unwrap_or_default()
    )))
}

async fn prepare(
    path: &Path,
    runs: &Path,
    number: u64,
    head_sha: &str,
    head_branch: &str,
    base_branch: &str,
) -> Result<PrGuideCheckout, PrError> {
    let sha = head_sha.to_lowercase();
    if !is_commit_hash(&sha) {
        return Err(PrError::invalid(
            "GitHub did not report the pull request's head commit.",
        ));
    }
    // A name git rejects, or one that would change the refspec, never reaches
    // `git fetch`.
    if base_branch.is_empty()
        || base_branch.starts_with('+')
        || base_branch.contains(':')
        || git(path, &["check-ref-format", "--branch", base_branch])
            .await
            .is_err()
    {
        return Err(PrError::invalid(
            "The pull request's base branch name is not one git can fetch.",
        ));
    }
    let root = git(path, &["rev-parse", "--show-toplevel"])
        .await
        .map(|r| PathBuf::from(r.trim()))
        .map_err(|_| PrError::invalid("This folder is not a git checkout."))?;
    // What a quit or a crash left behind, before adding more.
    prune_stale_runs(&root, runs, super::gh::now_ms()).await;
    let remotes = remotes(&root).await;
    if remotes.is_empty() {
        return Err(PrError::invalid(
            "This checkout has no remote to fetch from.",
        ));
    }

    let run_id = format!(
        "{}-{}",
        super::gh::now_ms(),
        RUN_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    // Fetched into a ref of this run's own: FETCH_HEAD is shared by every
    // fetch in the checkout, so a concurrent run could otherwise measure this
    // change from its base.
    let base = base_ref(&run_id);
    let spec = format!("+refs/heads/{base_branch}:{base}");
    let mut fetched = false;
    for remote in &remotes {
        if fetch(&root, remote, &spec, NETWORK_TIMEOUT).await.is_ok() {
            fetched = true;
            break;
        }
    }
    if !fetched {
        return Err(PrError::failed(
            "Could not fetch the pull request's base branch.",
        ));
    }

    let head = match find_head(&root, &remotes, number, &sha, head_branch).await {
        Ok(head) => head,
        Err(e) => {
            finish(&root, runs, &run_id).await;
            return Err(e);
        }
    };
    let dir = runs.join(&run_id);
    let checkout = dir.join("checkout");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        finish(&root, runs, &run_id).await;
        return Err(PrError::failed(e.to_string()));
    }
    let checkout_str = checkout.to_string_lossy().into_owned();
    if let Err(e) = git(
        &root,
        &[
            "worktree",
            "add",
            "--detach",
            "--quiet",
            &checkout_str,
            &head,
        ],
    )
    .await
    {
        finish(&root, runs, &run_id).await;
        return Err(PrError::failed(format!("Could not make a worktree: {e}")));
    }
    let base_commit = match git(&checkout, &["merge-base", &base, "HEAD"]).await {
        Ok(b) => b.trim().to_string(),
        Err(e) => {
            finish(&root, runs, &run_id).await;
            return Err(PrError::failed(format!(
                "The head shares no history with the base: {e}"
            )));
        }
    };
    let range = format!("{base_commit}...HEAD");
    // Fixed prefixes: a user's diff.noPrefix or custom prefixes would hide the
    // headers the parser reads.
    const DIFF: [&str; 5] = [
        "-c",
        "core.quotePath=false",
        "diff",
        "--src-prefix=a/",
        "--dst-prefix=b/",
    ];
    let names_args: Vec<&str> = DIFF
        .iter()
        .copied()
        .chain(["--name-only", "-z", range.as_str()])
        .collect();
    let patch_args: Vec<&str> = DIFF
        .iter()
        .copied()
        .chain(["--unified=0", "--no-color", "--no-ext-diff", range.as_str()])
        .collect();
    let (names, patch) = tokio::join!(
        run(&checkout, "git", &names_args, GIT_TIMEOUT),
        run(&checkout, "git", &patch_args, GIT_TIMEOUT),
    );
    let change = match (names, patch) {
        (Ok(names), Ok(patch)) => parse_change(&names, &patch),
        (Err(e), _) | (_, Err(e)) => {
            finish(&root, runs, &run_id).await;
            return Err(PrError::failed(format!("Could not read the change: {e}")));
        }
    };
    let path = std::fs::canonicalize(&checkout)
        .unwrap_or(checkout)
        .to_string_lossy()
        .into_owned();
    Ok(PrGuideCheckout {
        run_id,
        path,
        base_commit,
        head_commit: head,
        change,
    })
}

fn hunk_range(start: &str, count: Option<&str>) -> Option<[u32; 2]> {
    let start: u32 = start.parse().ok()?;
    let lines: u32 = match count {
        None => 1,
        Some(c) => c.parse().ok()?,
    };
    (lines > 0).then(|| [start, start + lines - 1])
}

/// `@@ -a[,b] +c[,d] @@`, as its four parts.
fn parse_hunk_header(line: &str) -> Option<(&str, Option<&str>, &str, Option<&str>)> {
    let rest = line.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(" +")?;
    let (new, _) = rest.split_once(" @@")?;
    let (old_start, old_count) = hunk_side(old)?;
    let (new_start, new_count) = hunk_side(new)?;
    Some((old_start, old_count, new_start, new_count))
}

/// One side of a hunk header, `start[,count]`, digits only.
fn hunk_side(s: &str) -> Option<(&str, Option<&str>)> {
    let digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    let (start, count) = match s.split_once(',') {
        Some((a, b)) => (a, Some(b)),
        None => (s, None),
    };
    (digits(start) && count.is_none_or(digits)).then_some((start, count))
}

/// The path a `--- ` / `+++ ` header names, without its `a/` or `b/`
/// prefix; `None` for `/dev/null`. Git ends a name that has a space in it
/// with a tab, and C-quotes one with a quote, backslash or control character
/// in it (`"b/say \"hi\".txt"`), `core.quotePath=false` or not.
pub(super) fn header_path(raw: &str, prefix: &str) -> Option<String> {
    let raw = raw.strip_suffix('\r').unwrap_or(raw);
    let raw = raw.strip_suffix('\t').unwrap_or(raw);
    let name = if raw.starts_with('"') {
        unquote_c(raw)?
    } else {
        raw.to_string()
    };
    name.strip_prefix(prefix).map(str::to_string)
}

/// A C-quoted string as git writes one: `\"`, `\\`, `\a\b\t\n\v\f\r`
/// and `\NNN` octal bytes, which together spell UTF-8.
fn unquote_c(quoted: &str) -> Option<String> {
    let inner = quoted.strip_prefix('"')?.strip_suffix('"')?;
    let mut bytes = Vec::with_capacity(inner.len());
    let mut chars = inner.bytes().peekable();
    while let Some(b) = chars.next() {
        if b != b'\\' {
            bytes.push(b);
            continue;
        }
        let escaped = chars.next()?;
        let byte = match escaped {
            b'"' => b'"',
            b'\\' => b'\\',
            b'a' => 0x07,
            b'b' => 0x08,
            b't' => b'\t',
            b'n' => b'\n',
            b'v' => 0x0b,
            b'f' => 0x0c,
            b'r' => b'\r',
            b'0'..=b'7' => {
                let mut value = u32::from(escaped - b'0');
                for _ in 0..2 {
                    match chars.peek() {
                        Some(d @ b'0'..=b'7') => {
                            value = value * 8 + u32::from(d - b'0');
                            chars.next();
                        }
                        _ => break,
                    }
                }
                u8::try_from(value).ok()?
            }
            _ => return None,
        };
        bytes.push(byte);
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// The changed files (`--name-only -z`) and each file's hunk ranges from a
/// `--unified=0` patch.
pub(super) fn parse_change(name_only: &str, patch: &str) -> PrGuideChange {
    let mut hunks: BTreeMap<String, PrGuideHunks> = BTreeMap::new();
    let mut old_path: Option<String> = None;
    let mut current: Option<String> = None;
    // Inside a file's hunks a `--- ` or `+++ ` line is a removed or added
    // source line, not a header.
    let mut in_hunks = false;
    for line in patch.split('\n') {
        if line.starts_with("diff --git ") {
            old_path = None;
            current = None;
            in_hunks = false;
        } else if !in_hunks && line.starts_with("--- ") {
            old_path = header_path(&line[4..], "a/");
        } else if !in_hunks && line.starts_with("+++ ") {
            let path = header_path(&line[4..], "b/").or_else(|| old_path.clone());
            let Some(path) = path else { continue };
            hunks.entry(path.clone()).or_default();
            current = Some(path);
        } else if let Some(path) = current.as_ref() {
            let Some((os, oc, ns, nc)) = parse_hunk_header(line) else {
                continue;
            };
            in_hunks = true;
            let entry = hunks.entry(path.clone()).or_default();
            if let Some(r) = hunk_range(os, oc) {
                entry.old.push(r);
            }
            if let Some(r) = hunk_range(ns, nc) {
                entry.new.push(r);
            }
        }
    }
    PrGuideChange {
        files: name_only
            .split('\0')
            .filter(|p| !p.is_empty())
            .map(str::to_string)
            .collect(),
        hunks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_unified_zero_patch_reads_as_hunk_ranges() {
        let patch = "diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3,0 +4,2 @@ fn\n+x\n+y\n@@ -10 +12 @@\n-old\n+new\ndiff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-a\n-b\n-c\n";
        let change = parse_change("src/a.ts\0gone.ts\0", patch);
        assert_eq!(change.files, vec!["src/a.ts", "gone.ts"]);
        let a = &change.hunks["src/a.ts"];
        assert_eq!(a.new, vec![[4, 5], [12, 12]]);
        assert_eq!(a.old, vec![[10, 10]]);
        let gone = &change.hunks["gone.ts"];
        assert_eq!(gone.old, vec![[1, 3]]);
        assert!(gone.new.is_empty());
    }

    #[test]
    fn a_removed_line_that_looks_like_a_header_stays_a_line() {
        let patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n--- not a header\n+++ nor this\n";
        let change = parse_change("x\0", patch);
        assert_eq!(change.hunks.len(), 1);
        assert_eq!(change.hunks["x"].new, vec![[1, 2]]);
    }

    #[test]
    fn a_path_with_a_space_loses_git_s_trailing_tab() {
        let patch = "diff --git a/my file.ts b/my file.ts\n--- a/my file.ts\t\n+++ b/my file.ts\t\n@@ -1 +1 @@\n-a\n+b\n";
        let change = parse_change("my file.ts\0", patch);
        assert_eq!(change.hunks.keys().collect::<Vec<_>>(), ["my file.ts"]);
        assert_eq!(change.hunks["my file.ts"].new, vec![[1, 1]]);
    }

    #[test]
    fn a_c_quoted_path_is_unquoted() {
        let patch = "diff --git \"a/say \\\"hi\\\".txt\" \"b/say \\\"hi\\\".txt\"\n--- \"a/say \\\"hi\\\".txt\"\n+++ \"b/say \\\"hi\\\".txt\"\n@@ -2 +2,2 @@\n-a\n+b\n+c\n";
        let change = parse_change("say \"hi\".txt\0", patch);
        assert_eq!(change.hunks["say \"hi\".txt"].new, vec![[2, 3]]);
        // Octal escapes spell UTF-8, and a tab inside a name survives.
        assert_eq!(
            header_path("\"b/caf\\303\\251\\tx.md\"", "b/").as_deref(),
            Some("café\tx.md")
        );
        assert_eq!(header_path("/dev/null", "b/"), None);
        assert_eq!(header_path("b/plain.rs", "b/").as_deref(), Some("plain.rs"));
    }

    #[test]
    fn a_run_is_stale_after_six_hours() {
        let now = 100 * STALE_RUN_AGE_MS;
        let old = format!("{}-3", now - STALE_RUN_AGE_MS);
        let fresh = format!("{}-4", now - 1000);
        let stale = stale_run_ids([old.as_str(), fresh.as_str(), "junk", "12-x"], now);
        assert_eq!(stale, vec![old]);
    }

    #[test]
    fn only_hashes_count_as_commits() {
        assert!(is_commit_hash("abcdef1"));
        assert!(!is_commit_hash("abc"));
        assert!(!is_commit_hash("main-branch"));
    }

    #[test]
    fn a_guide_file_name_never_carries_the_repository() {
        let dir = Path::new("/data");
        let file = guide_file(dir, "Owner/../Repo", 4);
        assert!(file.starts_with("/data/stored"));
        assert!(!file.to_string_lossy().contains("Repo"));
        assert_eq!(file, guide_file(dir, "owner/../repo", 4));
        assert_ne!(file, guide_file(dir, "owner/../repo", 5));
    }

    /// A synchronous `git` for test setup.
    fn g(cwd: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}");
        String::from_utf8_lossy(&out.stdout).trim_end().to_string()
    }

    #[tokio::test]
    async fn a_run_checks_out_the_head_and_reads_its_change() {
        let dir = tempfile::tempdir().unwrap();
        let origin = dir.path().join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        let commit = |cwd: &Path, msg: &str| {
            g(
                cwd,
                &[
                    "-c",
                    "user.name=a",
                    "-c",
                    "user.email=a@b",
                    "commit",
                    "-q",
                    "-am",
                    msg,
                ],
            );
        };
        g(&origin, &["init", "-q", "-b", "main"]);
        std::fs::write(origin.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        g(&origin, &["add", "a.txt"]);
        commit(&origin, "base");
        g(&origin, &["checkout", "-q", "-b", "feat"]);
        std::fs::write(origin.join("a.txt"), "one\nTWO\nthree\nfour\n").unwrap();
        commit(&origin, "change");
        let head = g(&origin, &["rev-parse", "HEAD"]);
        g(&origin, &["checkout", "-q", "main"]);

        let clone = dir.path().join("clone");
        g(
            dir.path(),
            &[
                "clone",
                "-q",
                origin.to_str().unwrap(),
                clone.to_str().unwrap(),
            ],
        );
        let runs = dir.path().join("runs");
        let out = prepare(&clone, &runs, 9, &head, "feat", "main")
            .await
            .unwrap();
        assert_eq!(out.head_commit, head);
        assert_eq!(out.change.files, vec!["a.txt"]);
        assert_eq!(out.change.hunks["a.txt"].new, vec![[2, 2], [4, 4]]);
        assert!(Path::new(&out.path).join("a.txt").exists());
        // The clone's own checkout never moved.
        assert_eq!(g(&clone, &["symbolic-ref", "--short", "HEAD"]), "main");

        finish(&clone, &runs, &out.run_id).await;
        assert!(!Path::new(&out.path).exists());
        assert!(git(
            &clone,
            &["rev-parse", "--verify", "--quiet", &base_ref(&out.run_id)]
        )
        .await
        .is_err());

        // A run nobody finished is pruned once it is stale, ref and all.
        let left = prepare(&clone, &runs, 9, &head, "feat", "main")
            .await
            .unwrap();
        let started = run_started_ms(&left.run_id).unwrap();
        prune_stale_runs(
            Path::new(&g(&clone, &["rev-parse", "--show-toplevel"])),
            &runs,
            started + 1000,
        )
        .await;
        assert!(Path::new(&left.path).exists(), "a fresh run is left alone");
        prune_stale_runs(
            Path::new(&g(&clone, &["rev-parse", "--show-toplevel"])),
            &runs,
            started + STALE_RUN_AGE_MS,
        )
        .await;
        assert!(!Path::new(&left.path).exists());
        assert!(!runs.join(&left.run_id).exists());
        assert!(git(
            &clone,
            &["rev-parse", "--verify", "--quiet", &base_ref(&left.run_id)]
        )
        .await
        .is_err());
        let worktrees = g(&clone, &["worktree", "list", "--porcelain"]);
        assert_eq!(worktrees.matches("worktree ").count(), 1);
    }
}

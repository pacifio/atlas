//! Turning observed commits into Checkpoints.
//!
//! A developer works with an agent and then commits — from the Atlas git panel,
//! from the integrated terminal, from lazygit, from a different editor, or on a
//! laptop where Atlas was closed at the time. In every one of those cases a
//! Checkpoint should appear linking the Session to that commit.
//!
//! Commits are **observed, not intercepted**. The repository is never modified:
//! no hooks installed, no refs written, no config touched. Hooks were rejected
//! because they mutate the user's repository, must chain whatever else is
//! already installed, need per-repo consent, and — decisively — cannot see a
//! commit made before they existed. Watching refs move can, which is what lets
//! the open-time walk pick up everything that happened while Atlas was closed.
//!
//! # The link rule, and why it is asymmetric
//!
//! For each path present in both the commit and a Session's touched files:
//!
//! * The file **existed** in the parent commit → link on the path alone.
//!   Reviewing and tweaking agent output before committing is the normal
//!   workflow, and demanding an exact content match here would silently discard
//!   most real Sessions.
//! * The file is **new** → link only if the committed blob matches what the
//!   agent actually wrote. This is what stops "the agent created it, the human
//!   deleted it and wrote their own" from being credited to the agent.
//!
//! Getting either half wrong is invisible. Too strict and the feature quietly
//! records almost nothing; too loose and it confidently attributes human work to
//! an agent. The asymmetry is the whole design.
//!
//! Two bounds keep the rule honest over time:
//!
//! * **Touches are consumed.** Once a commit has settled a touched path —
//!   linked it, or displaced it (the human replaced the agent's new file) —
//!   that touch stops nominating the Session for later commits. Without this,
//!   every future commit to a hot file, including purely human work months
//!   later and teammate commits arriving via pull, would be attributed to the
//!   Session forever. This is the carry-forward rule from Entire's link engine,
//!   and it is the load-bearing half of the design.
//! * **Time.** A commit is never linked to a Session that started after the
//!   commit was created, which is what makes the bounded recovery re-scan safe:
//!   historical commits that predate every Session can neither link nor consume.
//!
//! # Merges
//!
//! The walk follows the first parent and a merge commit itself creates no
//! Checkpoints — linking a merge would credit every merged-in change a second
//! time, under a commit that did not produce it, and `git pull` creates merge
//! commits constantly. The side branch's *own* commits are not lost, though:
//! when the walk encounters a merge it evaluates the commits the merge brought
//! in (`first-parent..second-parent`, merges excluded) through the same link
//! rule, so work committed on a side branch while Atlas was closed and then
//! merged is linked exactly once, at the commit that actually produced it.

use std::collections::HashMap;
use std::path::Path;

use chrono::Utc;

use crate::blobs;
use crate::sketch;
use crate::error::{Error, Result};
use crate::git::{self, ChangedPath};
use crate::model::{FileTouch, WorkspaceMode};
use crate::store::{CheckpointInput, LinkCandidate, Store};

/// A git read that should have worked did not — lock contention, a mid-gc
/// window, antivirus interference. The walk must stop *before* the cursor
/// advances past the commit it could not examine, so the next pass re-examines
/// it; swallowing this as "no Checkpoints" would leave a permanent silent hole.
fn git_unavailable(err: git::GitError) -> Error {
    Error::Storage(format!("git observation failed: {err}"))
}

/// How far back to re-scan when the cursor cannot be resolved.
///
/// `rev-list cursor..HEAD` fails outright if the cursor commit was garbage
/// collected or rewritten away, and detection would then stop **forever** for
/// that Workspace with nothing logged. A bounded re-scan is the recovery: it is
/// cheap, `(Session, commit)` makes re-processing harmless, and the alternative
/// is a Workspace that has silently gone dark.
pub const RECOVERY_SCAN_LIMIT: usize = 200;

/// What one walk did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct WalkOutcome {
    /// Commits examined.
    pub commits_seen: usize,
    /// Checkpoints created. Fewer than `commits_seen` is the normal case —
    /// hand-written commits match no Session and that is not an error.
    pub checkpoints_created: usize,
    /// The cursor could not be resolved and a bounded re-scan was used instead.
    /// Surfaced through the capture-health signal.
    pub cursor_recovered: bool,
}

/// Walk from the last-seen commit to HEAD, creating Checkpoints.
///
/// Safe to call on every ref movement and on Workspace open. The open-time call
/// is not a fallback: a watcher only exists for a Workspace activated at least
/// once this app session, so for a never-activated or evicted Workspace this
/// walk is the *primary* mechanism.
pub fn walk_new_commits(
    store: &Store,
    workspace_id: &str,
    repo: &Path,
    mode: WorkspaceMode,
) -> Result<WalkOutcome> {
    if !git::is_repository(repo) {
        // Git is optional. A non-repository Workspace captures Sessions and
        // simply never produces Checkpoints.
        return Ok(WalkOutcome::default());
    }
    let Some(head) = git::head_commit(repo) else {
        // An unborn branch — `git init` with nothing committed yet.
        return Ok(WalkOutcome::default());
    };

    let cursor = store.commit_cursor(workspace_id)?;
    let mut candidates = store.link_candidates(workspace_id)?;

    if cursor.is_none() && candidates.is_empty() {
        // A first walk with nothing that could possibly link — the moment
        // capture is enabled on a repository with history. Examining up to
        // [`RECOVERY_SCAN_LIMIT`] commits would spawn git subprocesses per
        // commit to conclude nothing, on the command path of the enable click.
        // Just start the cursor at HEAD.
        store.set_commit_cursor(workspace_id, &head, false)?;
        return Ok(WalkOutcome::default());
    }

    let (commits, recovered) = resolve_range(repo, cursor.as_deref(), &head);
    if commits.is_empty() {
        // Still record the cursor, so a Workspace whose first walk finds nothing
        // does not re-scan from the beginning on every ref movement.
        store.set_commit_cursor(workspace_id, &head, recovered)?;
        return Ok(WalkOutcome {
            cursor_recovered: recovered,
            ..Default::default()
        });
    }

    let branch = git::current_branch(repo);
    let mut outcome = WalkOutcome {
        commits_seen: commits.len(),
        cursor_recovered: recovered,
        ..Default::default()
    };

    for commit in &commits {
        outcome.checkpoints_created +=
            link_commit(store, repo, commit, &mut candidates, branch.as_deref(), mode)?;

        // Advance per commit rather than once at the end: a crash mid-walk then
        // resumes from the last commit whose Checkpoints are durably written,
        // re-processing at most one commit instead of skipping the remainder.
        store.set_commit_cursor(workspace_id, commit, recovered)?;
    }

    Ok(outcome)
}

/// The commits to examine, and whether the cursor had to be recovered.
fn resolve_range(repo: &Path, cursor: Option<&str>, head: &str) -> (Vec<String>, bool) {
    match cursor {
        // No cursor yet — a Workspace whose capture was just enabled. Bound the
        // first walk rather than replaying an entire repository history, which
        // for a large repo would be tens of thousands of commits none of which
        // can match a Session that did not exist yet.
        None => (
            git::recent_commits(repo, RECOVERY_SCAN_LIMIT).unwrap_or_default(),
            false,
        ),
        Some(cursor) => match git::commits_between(repo, Some(cursor), head) {
            Ok(commits) => (commits, false),
            // The cursor is gone: garbage collected, or rewritten away.
            Err(_) => (
                git::recent_commits(repo, RECOVERY_SCAN_LIMIT).unwrap_or_default(),
                true,
            ),
        },
    }
}

/// Evaluate SPECIFIC commits, wherever the cursor is.
///
/// The ordinary walk advances the cursor past every commit it examines and
/// never looks back — correct for its job, and exactly wrong for the one case
/// this exists for: a shell call that COMMITS ITS OWN WRITES (#31). The git
/// watcher fires the instant the agent's `git commit` moves refs, so the walk
/// can consume that commit before the call's touches are recorded; when the
/// touches then land, the walk cannot help. Whoever recorded them names the
/// commits the window saw HEAD move across, and this evaluates exactly those —
/// same rule, same consumption, no cursor movement.
///
/// Idempotent by construction: the first evaluation consumes the touches it
/// settled, so a re-run finds no candidates.
pub fn link_commits(
    store: &Store,
    workspace_id: &str,
    repo: &Path,
    commits: &[String],
    mode: WorkspaceMode,
) -> Result<usize> {
    if commits.is_empty() || !git::is_repository(repo) {
        return Ok(0);
    }
    let mut candidates = store.link_candidates(workspace_id)?;
    let branch = git::current_branch(repo);
    let mut created = 0;
    for commit in commits {
        created += link_commit(store, repo, commit, &mut candidates, branch.as_deref(), mode)?;
    }
    Ok(created)
}

/// Evaluate one commit against every candidate Session.
///
/// Returns how many Checkpoints it produced — zero is the ordinary case for a
/// hand-written commit and must never be treated as an error. A **git failure**
/// is an `Err`, never a zero: the caller advances the cursor on `Ok`, and a
/// commit skipped over a transient failure would never be examined again.
fn link_commit(
    store: &Store,
    repo: &Path,
    commit_sha: &str,
    candidates: &mut [LinkCandidate],
    branch: Option<&str>,
    mode: WorkspaceMode,
) -> Result<usize> {
    if candidates.is_empty() {
        // Nothing can link and nothing can be consumed. Skipping the git reads
        // outright is what keeps a walk over a Session-less range free.
        return Ok(0);
    }

    let info = git::commit_info(repo, commit_sha).map_err(git_unavailable)?;

    // A merge itself creates no Checkpoints: its first-parent diff carries every
    // merged-in change again, under a commit that did not produce them, and
    // `git pull` creates merge commits constantly. The side branch's own commits
    // — which the first-parent walk deliberately skipped — are evaluated here
    // instead, so work committed on a side branch while Atlas was closed and
    // then merged still links, exactly once, at the commit that produced it.
    // Touch consumption and the `(Session, commit)` key make re-seeing an
    // already-walked side branch harmless.
    if info.is_merge() {
        let mut created = 0;
        let first_parent = &info.parents[0];
        for side_parent in &info.parents[1..] {
            let sides = git::merge_side_commits(repo, first_parent, side_parent, RECOVERY_SCAN_LIMIT)
                .map_err(git_unavailable)?;
            for side in sides {
                let side_info = git::commit_info(repo, &side).map_err(git_unavailable)?;
                created += evaluate_commit(store, repo, &side, &side_info, candidates, branch, mode)?;
            }
        }
        return Ok(created);
    }

    evaluate_commit(store, repo, commit_sha, &info, candidates, branch, mode)
}

/// Run the link rule for one non-merge commit, and consume what it settled.
fn evaluate_commit(
    store: &Store,
    repo: &Path,
    commit_sha: &str,
    info: &git::CommitInfo,
    candidates: &mut [LinkCandidate],
    branch: Option<&str>,
    mode: WorkspaceMode,
) -> Result<usize> {
    let changed = git::changed_paths(repo, commit_sha).map_err(git_unavailable)?;
    if changed.is_empty() {
        return Ok(0);
    }

    let mut created = 0;
    let mut stats = None;
    let mut patch_cache: Option<Option<String>> = None;

    for candidate in candidates.iter_mut() {
        // Never link a commit to a Session that started after the commit was
        // created — the commit cannot contain work from a Session that did not
        // exist yet. This is what makes the bounded recovery re-scan safe:
        // historical commits predating every Session neither link nor consume.
        // (`>=` at second granularity: git timestamps have one-second
        // resolution, and a commit made within the Session's starting second is
        // legitimately its work.)
        if info.commit_time < candidate.started_at.timestamp() {
            continue;
        }

        let matches = matching_paths(repo, commit_sha, &changed, &candidate.touches);
        if matches.touched.is_empty() {
            continue;
        }

        if !matches.linked.is_empty() {
            // Deferred until we know there is something to record: `git show`
            // on every commit in a large walk is the difference between
            // detection being free and being felt.
            let (insertions, deletions) =
                *stats.get_or_insert_with(|| git::line_stats(repo, commit_sha));
            let patch = patch_cache.get_or_insert_with(|| git::patch_id(repo, commit_sha));

            store.upsert_checkpoint(CheckpointInput {
                session_id: &candidate.session_id,
                commit_sha,
                patch_id: patch.as_deref(),
                branch,
                git_author_name: Some(info.author_name.as_str()),
                git_author_email: Some(info.author_email.as_str()),
                files_touched: &matches.linked,
                insertions,
                deletions,
                sync_state: mode.initial_sync_state(),
            })?;
            created += 1;
        }

        // Consume every touch this commit settled — linked or not. A strict-arm
        // mismatch means the human replaced the agent's file, and either way
        // the commit resolved that path: work that landed (or was displaced)
        // must stop nominating the Session, or every later commit touching the
        // same file — purely human work included — would link to it forever.
        //
        // Consumed under the touch-side spelling (the one the store matches
        // on), and only up to the commit's own time: a touch made *after* this
        // commit is later work the commit cannot have settled, and it stays
        // live for the next commit — which is exactly how one Session spanning
        // several commits produces one Checkpoint each. One second of slack
        // covers git's second-resolution timestamps.
        //
        // Pruned from the in-memory candidate too: this walk's remaining
        // commits share the candidate list, and a backlog walked in one batch
        // (Atlas reopened after days away) must see the same consumption a
        // commit-at-a-time walk would.
        let up_to = chrono::DateTime::<chrono::Utc>::from_timestamp(info.commit_time + 1, 0)
            .unwrap_or_else(chrono::Utc::now);
        store.consume_touches(&candidate.session_id, commit_sha, &matches.touched, up_to)?;
        candidate.touches.retain(|touch| {
            !matches.touched.contains(&touch.path) || touch.created_at > up_to
        });
    }
    Ok(created)
}

/// What one commit and one Session's touches agreed on.
struct PathMatches {
    /// Commit-side paths that passed the link rule — the Checkpoint's
    /// `files_touched`.
    linked: Vec<String>,
    /// Touch-side spellings of the linked paths — what consumption marks
    /// spent. Only *linked* touches are consumed: a strict-arm mismatch means
    /// the commit carries someone else's content for that path, and judging
    /// the agent's touch "settled" on that evidence would let a commit that
    /// merely predates the touch (a recovery re-scan, a same-second initial
    /// commit) erase it before its real commit arrives.
    touched: Vec<String>,
}

/// The paths on which this Session and this commit agree, under the link rule.
fn matching_paths(
    repo: &Path,
    commit_sha: &str,
    changed: &[ChangedPath],
    touches: &[FileTouch],
) -> PathMatches {
    // Keyed case-insensitively. The primary development filesystem on macOS is
    // case-insensitive while git is case-sensitive, so a byte comparison of
    // `Foo.rs` against `foo.rs` quietly fails, no Checkpoint forms, and nothing
    // is logged. Unicode form was already normalised when the touch was stored.
    let by_path: HashMap<String, &FileTouch> = touches
        .iter()
        .filter(|touch| !touch.out_of_repo)
        .map(|touch| (touch.path.to_lowercase(), touch))
        .collect();

    let mut matches = PathMatches { linked: Vec::new(), touched: Vec::new() };
    for change in changed {
        // A rename carries the agent's work under its *pre*-rename path: the
        // agent edited the file, the commit moved it. Either spelling counts.
        let candidates = [Some(change.path.as_str()), change.previous_path.as_deref()];
        let Some(touch) = candidates
            .into_iter()
            .flatten()
            .find_map(|path| by_path.get(&path.to_lowercase()).copied())
        else {
            continue;
        };

        if links(repo, commit_sha, change, touch) {
            matches.linked.push(change.path.clone());
            matches.touched.push(touch.path.clone());
        }
    }
    matches.linked.sort();
    matches.linked.dedup();
    matches.touched.sort();
    matches.touched.dedup();
    matches
}

/// The rule itself.
fn links(repo: &Path, commit_sha: &str, change: &ChangedPath, touch: &FileTouch) -> bool {
    use crate::git::ChangeKind;

    // A deletion has no content to compare. The touch record's deletion marker
    // is the evidence instead: the agent deleted the file and the commit records
    // that deletion.
    if change.kind == ChangeKind::Deleted {
        return touch.deleted;
    }

    if change.kind.existed_in_parent() && touch.existed_before {
        // The permissive arm. Humans routinely review and tweak agent output
        // before committing, and that is still agent-derived work.
        //
        // Both sides must agree the file predates the agent's write. Git's
        // view alone is not enough: a file the agent *created* exists in the
        // parent of every commit after the first one that carried it — so once
        // a human replaced the agent's new file and committed, path-alone
        // linking would credit every later human edit to the agent. When the
        // touch says the agent created the file, only content can prove a
        // commit carries the agent's work, so such touches always take the
        // strict arm below.
        return true;
    }

    // The strict arm: a file that is new in this commit only links if what was
    // committed is what the agent wrote. Without this, "the agent created it,
    // the human threw it away and wrote their own" is credited to the agent.
    let Some(expected) = &touch.sha256_after else {
        return false;
    };
    let Some(committed) = git::blob_at(repo, commit_sha, &change.path) else {
        return false;
    };
    if &blobs::key_for(&committed) == expected {
        return true;
    }

    // The raw bytes differ — but the touch hashed what the agent wrote into the
    // *worktree*, and on a repository with content filters (CRLF conversion,
    // `text=auto`) the committed blob is legitimately a different byte string
    // for the same content. Compare against the blob's checkout form before
    // declaring a mismatch, so a Windows-style repo does not silently fail the
    // strict arm on every agent-created file. Filters that are not invertible
    // from the blob side (ident expansion, LFS pointers) remain a genuine gap.
    if let Some(filtered) = git::blob_at_filtered(repo, commit_sha, &change.path) {
        if &blobs::key_for(&filtered) == expected {
            return true;
        }
    }

    // Neither form matched byte-for-byte, so the developer changed something
    // between the agent's write and the commit. That is the ordinary review
    // loop, not a rejection: requiring an exact match here meant the agent
    // scaffolds a file, the developer fixes one line, and the Checkpoint
    // silently never appears.
    //
    // Ask how much of the agent's content survived instead. Containment is
    // asymmetric on purpose — a developer who appends their own work to the
    // agent's file has still committed the agent's work — and the threshold
    // still rejects a wholesale rewrite, which is what this arm exists for.
    //
    // A touch written before schema v9 has no sketch. Those keep the old
    // exact-match behaviour rather than being retroactively re-judged on
    // evidence that was never recorded.
    let Some(agent_sketch) = &touch.sketch_after else {
        return false;
    };
    let Some(committed_sketch) = sketch::sketch(&committed) else {
        return false;
    };
    sketch::retains_agent_work(agent_sketch, &committed_sketch)
}

/// Are there Checkpoints for this Workspace whose commit has gone missing?
///
/// Split out so a caller can cheaply decide whether reconciliation is worth
/// running at all.
pub fn has_unreachable_checkpoints(store: &Store, workspace_id: &str, repo: &Path) -> Result<bool> {
    use crate::model::LinkState;
    Ok(store
        .checkpoints_for_workspace(workspace_id)?
        .into_iter()
        // A failed probe reads as "still reachable" here: this is only a cheap
        // pre-check, and it must never nominate a Checkpoint for orphaning on
        // the strength of a probe that did not run.
        .any(|cp| {
            cp.link_state == LinkState::Linked
                && !git::is_reachable(repo, &cp.commit_sha).unwrap_or(true)
        }))
}

/// What one reconciliation pass did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ReconcileOutcome {
    /// Re-pointed at the commit now carrying the same change. The developer
    /// never notices these.
    pub relinked: usize,
    /// Marked orphaned: the commit is gone and nothing carrying the same change
    /// could be identified.
    pub orphaned: usize,
    /// Previously orphaned, and reachable again — a reverted force-push.
    pub recovered: usize,
    /// Checkpoints this pass could not decide about — a reachability probe or
    /// the patch-id scan failed, or a store write refused. Skipped, never
    /// orphaned on a failure, and re-examined on the next pass. One row's
    /// failure never aborts the rest of the pass.
    pub failed: usize,
    /// Reconciliation was skipped because a rewrite was still in progress.
    pub deferred: bool,
}

impl ReconcileOutcome {
    /// Did this pass orphan enough Checkpoints at once to be worth telling the
    /// developer about?
    ///
    /// A history-wide rewrite (`git filter-repo`, a rebase of everything)
    /// orphans in bulk. That is correct behaviour, but discovering it link by
    /// link is not — the capture-health signal reports it once so the developer
    /// learns *why* their timeline just changed.
    pub fn is_mass_orphan(&self) -> bool {
        self.orphaned >= MASS_ORPHAN_THRESHOLD
    }
}

/// Orphaning at least this many Checkpoints in one pass is a history-wide
/// rewrite rather than an ordinary squash.
pub const MASS_ORPHAN_THRESHOLD: usize = 5;

/// Re-attach Checkpoints whose commits were rewritten.
///
/// Most developers rewrite history before pushing — `git pull --rebase`, an
/// interactive rebase to tidy a series, an `--amend` to fix a typo — and each
/// rewrites every commit hash involved. Without this, every Checkpoint recorded
/// against those hashes points at a commit that is no longer reachable. Nothing
/// errors; the links just rot, and "trace any change back to the Session that
/// produced it" becomes quietly false.
///
/// The mechanism is git's own stable patch-id, which hashes the **diff** rather
/// than the commit — so the same change under a new hash hashes identically.
/// This is how git itself detects already-applied commits during a rebase.
///
/// Safe and cheap to call on every ref movement: it does nothing when every
/// Checkpoint's commit is still reachable.
pub fn reconcile_rewrites(store: &Store, workspace_id: &str, repo: &Path) -> Result<ReconcileOutcome> {
    use crate::model::LinkState;

    let mut outcome = ReconcileOutcome::default();
    if !git::is_repository(repo) {
        return Ok(outcome);
    }

    // Mid-rebase the old commits are already detached and the new ones do not
    // exist yet. Orphaning in that window would be premature — and orphaning is
    // not a thing to do speculatively. The next ref movement, when the rewrite
    // has finished, reconciles correctly.
    if git::rewrite_in_progress(repo) {
        outcome.deferred = true;
        return Ok(outcome);
    }

    let checkpoints = store.checkpoints_for_workspace(workspace_id)?;
    if checkpoints.is_empty() {
        return Ok(outcome);
    }

    // Built once for the whole pass rather than per Checkpoint — an interactive
    // rebase touches every Checkpoint on the branch at the same time. A failed
    // build must not read as an *empty* map: "no candidates" becomes "no match,
    // orphan", and a transient git failure must never orphan anything — so the
    // failure is remembered and every re-match this pass is skipped instead.
    enum PatchMap {
        Unbuilt,
        Ready(std::collections::HashMap<String, Vec<String>>),
        Unavailable,
    }
    let mut patch_ids = PatchMap::Unbuilt;

    // Several Checkpoints can share one commit (two Sessions, one commit), and
    // a pass runs on every ref movement — probe each sha once, not once per row.
    let mut probes: HashMap<String, Option<bool>> = HashMap::new();

    for checkpoint in checkpoints {
        // `None` means the probe itself failed. That is "unknown", never
        // "unreachable": skip the row this pass, count it, and let the next
        // ref movement retry — orphaning on a failed probe is how a lock-file
        // collision rewrites a developer's timeline.
        let reachable = match probes.get(&checkpoint.commit_sha) {
            Some(cached) => *cached,
            None => {
                let probed = git::is_reachable(repo, &checkpoint.commit_sha).ok();
                probes.insert(checkpoint.commit_sha.clone(), probed);
                probed
            }
        };
        let Some(reachable) = reachable else {
            outcome.failed += 1;
            continue;
        };

        match checkpoint.link_state {
            // A previously orphaned Checkpoint whose commit is reachable again —
            // a reverted force-push. Re-link it rather than leaving the record
            // pessimistic.
            LinkState::Orphaned if reachable => {
                let branch = branch_hint(repo, &checkpoint.commit_sha, checkpoint.branch.as_deref());
                match store.relink_checkpoint(&checkpoint.id, &checkpoint.commit_sha, branch.as_deref()) {
                    Ok(()) => outcome.recovered += 1,
                    Err(_) => outcome.failed += 1,
                }
                continue;
            }
            LinkState::Orphaned => continue,
            LinkState::Linked if reachable => continue,
            LinkState::Linked => {}
        }

        // The commit is gone. Look for one carrying the same change.
        let Some(patch_id) = &checkpoint.patch_id else {
            // No patch-id means an empty diff, which can neither donate nor
            // receive a re-point.
            match store.orphan_checkpoint(&checkpoint.id) {
                Ok(()) => outcome.orphaned += 1,
                Err(_) => outcome.failed += 1,
            }
            continue;
        };

        if matches!(patch_ids, PatchMap::Unbuilt) {
            patch_ids = match git::patch_id_map(repo, RECOVERY_SCAN_LIMIT) {
                Ok(map) => PatchMap::Ready(map),
                Err(_) => PatchMap::Unavailable,
            };
        }
        let map = match &patch_ids {
            PatchMap::Ready(map) => map,
            _ => {
                outcome.failed += 1;
                continue;
            }
        };

        match resolve_candidate(repo, map.get(patch_id), checkpoint.branch.as_deref()) {
            Some(commit) => {
                let branch = branch_hint(repo, &commit, checkpoint.branch.as_deref());
                match store.relink_checkpoint(&checkpoint.id, &commit, branch.as_deref()) {
                    Ok(()) => outcome.relinked += 1,
                    Err(_) => outcome.failed += 1,
                }
            }
            None => {
                // A squash collapses several patches into one that matches none
                // of them; a differently-resolved conflict changes the diff.
                // Both are honest orphans — saying so beats attaching to the
                // wrong commit, which silently corrupts a shared timeline.
                match store.orphan_checkpoint(&checkpoint.id) {
                    Ok(()) => outcome.orphaned += 1,
                    Err(_) => outcome.failed += 1,
                }
            }
        }
    }

    record_reconcile_note(store, workspace_id, &outcome)?;
    Ok(outcome)
}

/// Persist what this pass did, when a developer needs to hear about it.
///
/// A mass orphan or a partly-failed pass is written as a small JSON note the
/// capture-health signal surfaces — a timeline that changes wholesale with the
/// explanation living only in a log file is the same as no explanation. A clean
/// pass zeroes the note rather than leaving the old alarm standing, so the
/// signal reports current state, not history.
fn record_reconcile_note(store: &Store, workspace_id: &str, outcome: &ReconcileOutcome) -> Result<()> {
    let noteworthy = outcome.is_mass_orphan() || outcome.failed > 0;
    if noteworthy {
        let note = serde_json::json!({
            "orphaned": outcome.orphaned,
            "relinked": outcome.relinked,
            "failed": outcome.failed,
            "at": Utc::now().to_rfc3339(),
        });
        store.set_reconcile_note(workspace_id, &note.to_string())?;
    } else if store.reconcile_note(workspace_id)?.is_some() {
        let clear = serde_json::json!({
            "orphaned": 0,
            "relinked": 0,
            "failed": 0,
            "at": Utc::now().to_rfc3339(),
        });
        store.set_reconcile_note(workspace_id, &clear.to_string())?;
    }
    Ok(())
}

/// The branch to record on a re-pointed Checkpoint, when it is cheap to know.
///
/// Prefers the branch the Checkpoint already recorded when the commit is still
/// on it; otherwise a commit on exactly one branch names itself. Anything
/// ambiguous returns `None`, which leaves the recorded branch untouched rather
/// than guessing — the branch field feeds the timeline filter and future
/// cherry-pick tie-breaks, so a stale value is better than a wrong one.
fn branch_hint(repo: &Path, sha: &str, recorded: Option<&str>) -> Option<String> {
    let branches = git::branches_containing(repo, sha);
    if let Some(recorded) = recorded {
        if branches.iter().any(|branch| branch == recorded) {
            return Some(recorded.to_string());
        }
    }
    match branches.len() {
        1 => Some(branches.into_iter().next().expect("len checked")),
        _ => None,
    }
}

/// Pick the commit a Checkpoint should re-point at, or `None` to orphan.
///
/// patch-id is **not unique across history**. The classic collision is a
/// cherry-pick: the same diff reachable at two commits on two branches. The rule
/// is to prefer the branch the Checkpoint was recorded on, and to orphan rather
/// than pick arbitrarily when that does not disambiguate — a wrong link silently
/// corrupts a shared Organisation timeline, while an orphan is honest and
/// recoverable.
fn resolve_candidate(
    repo: &Path,
    candidates: Option<&Vec<String>>,
    recorded_branch: Option<&str>,
) -> Option<String> {
    let candidates = candidates?;
    match candidates.len() {
        0 => None,
        1 => Some(candidates[0].clone()),
        _ => {
            let branch = recorded_branch?;
            let on_branch: Vec<&String> = candidates
                .iter()
                .filter(|sha| git::branches_containing(repo, sha).iter().any(|b| b == branch))
                .collect();
            // Still ambiguous after the branch preference — two commits with the
            // same diff on the same branch. Orphan rather than guess.
            (on_branch.len() == 1).then(|| on_branch[0].clone())
        }
    }
}

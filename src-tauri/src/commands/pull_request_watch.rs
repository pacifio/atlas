//! The pull request **watch reactor**: Atlas reads the pull requests a
//! session watches and wakes the session's agent when one needs it, and
//! settles a session whose pull request merged or closed.
//!
//! ## Watches
//!
//! A watch is turned on by the agent (`watch_pull_request` on the code tool
//! server) or by the user, and lives on the session's link
//! (`atlas_thread_metadata::PullRequestWatch`). Every [`SWEEP_EVERY`] —
//! window hidden or not — the reactor reads each watched pull request, up to
//! [`READ_CONCURRENCY`] at once, one read per checkout and pull request
//! however many sessions watch it, and wakes a session when:
//!
//! - a check newly failed, was cancelled or needs action;
//! - the gate passed: the required checks if there are any, else all of
//!   them, or a required check appeared already passed;
//! - someone other than the viewer commented, reviewed or replied in a
//!   thread after the watch's watermark (edits count);
//! - the branch started to conflict with its base.
//!
//! A push resets which checks have been told. What a watch has told rides on
//! it ([`evaluate`]), so nothing is told twice, and an ended watch keeps it,
//! so watching again does not repeat it either.
//!
//! A pull request is read again only when it might have news: its snapshot
//! moved, a check is pending or mergeability unknown, or [`QUIET_REREAD_MS`]
//! passed ([`plan_read`]). Reads are background reads (`ReadPolicy::
//! Background`): they leave the quota's reserve to the user, and a rate limit
//! pauses the watch without counting as a failure.
//!
//! A watch ends:
//!
//! - silently, when the pull request merges (settle on merge follows);
//! - with a wake, when it is closed, after [`READ_FAILURE_LIMIT`] failed reads
//!   in a row, or after [`WAKE_LIMIT`] comment-only wakes in a row;
//! - when its session settles, the user presses Stop, or the agent calls
//!   `unwatch_pull_request`.
//!
//! The wake itself is `AgentHost::wake`: queued behind a running turn, and
//! opening the session first when it is not loaded. It reaches the session's
//! tab as `atlas:session-prompt-injected`, drawn as a "watch update" row
//! rather than as the user's words. `pullRequestWatchWakes` turns waking off.
//!
//! ## Settle on merge
//!
//! Each sweep also settles the sessions whose pull requests are all done
//! ([`settles`]): a closed one always, a merged one when `autoSettleOnMerge`
//! is on — in both cases only when it happened after the user's last word in
//! the session.
//!
//! Nothing here logs a repository, title, branch or URL.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use atlas_thread_metadata::{
    visible_pull_requests, PullRequestLink, PullRequestSnapshot, PullRequestWatch, ThreadId,
    ThreadMetadata, WatchSync,
};
use chrono::{DateTime, Utc};
use futures::future::BoxFuture;
use futures::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::agent_host::{AgentHost, PendingWake, SessionKey, WakeSource};
use super::agents::{send_prompt, OutgoingPrompt, PromptOrigin};
use super::pull_requests::{
    quota_paused_until, GitHub, PrCheck, PrCheckStatus, PrChecksState, PrComment, PrCommentKind,
    PrDetail, PrError, PrMergeability, PrReviewDecision, PrState, ReadPolicy,
};
use crate::state::atlas_config;

/// Checks take minutes, so a faster pass mostly spends the rate limit every
/// machine on the account shares.
pub const SWEEP_EVERY: Duration = Duration::from_secs(2 * 60);
/// Pull requests read at once.
pub const READ_CONCURRENCY: usize = 4;
/// Failed reads in a row before the watch gives up (and says so).
pub const READ_FAILURE_LIMIT: u32 = 8;
/// A pull request with nothing in flight is read again only when its snapshot
/// moves, or after this long, for news the snapshot cannot show (a bot
/// editing its review).
pub const QUIET_REREAD_MS: i64 = 10 * 60_000;
/// Wakes in a row that bring only comments. Check, conflict or push news
/// resets the count, so this only stops a chatty bot looping an agent that is
/// replying to it.
pub const WAKE_LIMIT: u32 = 10;
/// How long one pull request's read may take, both requests and every page.
const READ_TIMEOUT: Duration = Duration::from_secs(120);
const LISTED_ITEMS: usize = 10;
const SNIPPET_LENGTH: usize = 200;

/// The event a wake's transcript row rides on.
pub const SESSION_PROMPT_INJECTED_EVENT: &str = "atlas:session-prompt-injected";

// ── what a pass decides (pure) ──────────────────────────────────────────

/// What a read found worth telling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchChange {
    ChecksFailed(Vec<PrCheck>),
    ChecksPassed { count: usize, required: bool },
    Remarks(Vec<PrComment>),
    Conflicting,
}

/// [`evaluate`]'s answer: what to tell, the watch after telling it, and
/// whether the comment-only limit was reached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchReport {
    pub changes: Vec<WatchChange>,
    pub next: PullRequestWatch,
    pub exhausted: bool,
}

/// The parts of a pull request a watch looks at.
#[derive(Debug, Clone)]
pub struct WatchedState<'a> {
    pub head_sha: Option<&'a str>,
    pub checks: &'a [PrCheck],
    pub mergeability: PrMergeability,
    /// Who Atlas reads as; their own remarks never wake them.
    pub viewer: Option<&'a str>,
    /// The pull request's author, standing in for the viewer when the host
    /// did not name one.
    pub author: Option<&'a str>,
}

/// "action-required" is a finished check that needs someone, so the agent
/// hears about it.
fn is_failed_check(check: &PrCheck) -> bool {
    matches!(
        check.status,
        PrCheckStatus::Failure | PrCheckStatus::Cancelled | PrCheckStatus::ActionRequired
    )
}

fn parse_time(text: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|t| t.timestamp_millis())
}

fn active_at(remark: &PrComment) -> &str {
    remark.edited_at.as_deref().unwrap_or(&remark.created_at)
}

/// What `state` says that `watch` has not told yet. `remarks` is `None` when
/// the conversation could not be read whole: the watermark then stays where
/// it is, so nothing an incomplete read missed is skipped.
pub fn evaluate(
    watch: &PullRequestWatch,
    state: &WatchedState<'_>,
    remarks: Option<&[PrComment]>,
) -> WatchReport {
    let mut changes = Vec::new();
    let head_sha = state.head_sha.map(str::to_string);
    let head_moved = head_sha != watch.head_sha;

    // An empty list keeps the last state: a host can answer with one when its
    // check read fails.
    let mut failed_checks = if head_moved {
        Vec::new()
    } else {
        watch.failed_checks.clone()
    };
    let mut passed = !head_moved && watch.passed;
    let mut passed_checks = if head_moved {
        Vec::new()
    } else {
        watch.passed_checks.clone()
    };
    if !state.checks.is_empty() {
        let failed: Vec<&PrCheck> = state.checks.iter().filter(|c| is_failed_check(c)).collect();
        let newly: Vec<PrCheck> = failed
            .iter()
            .filter(|c| !failed_checks.contains(&c.name))
            .map(|c| (*c).clone())
            .collect();
        if !newly.is_empty() {
            changes.push(WatchChange::ChecksFailed(newly));
        }
        failed_checks = failed.iter().map(|c| c.name.clone()).collect();

        let required: Vec<&PrCheck> = state
            .checks
            .iter()
            .filter(|c| c.required == Some(true))
            .collect();
        let gate: Vec<&PrCheck> = if required.is_empty() {
            state.checks.iter().collect()
        } else {
            required.clone()
        };
        let passed_now = gate
            .iter()
            .all(|c| c.status != PrCheckStatus::Pending && !is_failed_check(c));
        let gate_names: Vec<String> = gate.iter().map(|c| c.name.clone()).collect();
        let told = if passed && passed_checks.is_empty() {
            gate_names.clone()
        } else {
            passed_checks.clone()
        };
        // A required job created and finished between two passes is never
        // seen pending. Without required checks any check counts, and
        // advisory bots keep adding passed ones: no wake for those.
        let gate_grew = !required.is_empty() && gate_names.iter().any(|n| !told.contains(n));
        if passed_now && (!passed || gate_grew) {
            changes.push(WatchChange::ChecksPassed {
                count: gate.len(),
                required: !required.is_empty(),
            });
        }
        passed = passed_now;
        passed_checks = if passed_now { gate_names } else { Vec::new() };
    }

    let own = state.viewer.or(state.author).map(str::to_ascii_lowercase);
    let through = parse_time(&watch.remarks_through);
    // Host times are per second, so remarks at the boundary are told apart by id.
    let fresh: Vec<PrComment> = remarks
        .unwrap_or_default()
        .iter()
        .filter(|remark| {
            let (Some(at), Some(through)) = (parse_time(active_at(remark)), through) else {
                return false;
            };
            let after = at > through || (at == through && !watch.remark_ids.contains(&remark.id));
            let theirs = remark.author.as_ref().map(|a| a.login.to_ascii_lowercase()) != own;
            after && theirs
        })
        .cloned()
        .collect();
    let latest = fresh
        .iter()
        .filter_map(|r| parse_time(active_at(r)))
        .fold(through, |acc, t| Some(acc.map_or(t, |a| a.max(t))));
    let at_latest: Vec<&PrComment> = fresh
        .iter()
        .filter(|r| parse_time(active_at(r)) == latest)
        .collect();
    let moved = latest != through;
    let remarks_through = if moved {
        at_latest
            .first()
            .map_or(watch.remarks_through.clone(), |r| active_at(r).to_string())
    } else {
        watch.remarks_through.clone()
    };
    let mut remark_ids = if moved {
        Vec::new()
    } else {
        watch.remark_ids.clone()
    };
    remark_ids.extend(at_latest.iter().map(|r| r.id.clone()));
    if !fresh.is_empty() {
        changes.push(WatchChange::Remarks(fresh));
    }

    if state.mergeability == PrMergeability::Conflicting && !watch.conflicting {
        changes.push(WatchChange::Conflicting);
    }
    // "unknown" is the host still computing after a push; only a clean answer
    // clears a conflict.
    let conflicting = match state.mergeability {
        PrMergeability::Unknown => watch.conflicting,
        PrMergeability::Conflicting => true,
        PrMergeability::Mergeable => false,
    };

    let comments_only =
        !changes.is_empty() && changes.iter().all(|c| matches!(c, WatchChange::Remarks(_)));
    let progress = head_moved || (!changes.is_empty() && !comments_only);
    let wakes = (if progress { 0 } else { watch.wakes }) + u32::from(comments_only);
    WatchReport {
        changes,
        next: PullRequestWatch {
            started_at: watch.started_at,
            head_sha,
            failed_checks,
            passed,
            passed_checks,
            remarks_through,
            remark_ids,
            conflicting,
            wakes,
        },
        exhausted: comments_only && wakes >= WAKE_LIMIT,
    }
}

fn snippet(body: &str) -> String {
    let mut text = String::with_capacity(body.len());
    let mut rest = body;
    // HTML comments are bots' bookkeeping, not words.
    while let Some(start) = rest.find("<!--") {
        text.push_str(&rest[..start]);
        text.push(' ');
        rest = rest[start..]
            .find("-->")
            .map_or("", |end| &rest[start + end + 3..]);
    }
    text.push_str(rest);
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= SNIPPET_LENGTH {
        return text;
    }
    let cut: String = text.chars().take(SNIPPET_LENGTH - 3).collect();
    format!("{cut}...")
}

fn listed<T>(items: &[T], line: impl Fn(&T) -> String) -> Vec<String> {
    let mut lines: Vec<String> = items.iter().take(LISTED_ITEMS).map(line).collect();
    if items.len() > LISTED_ITEMS {
        lines.push(format!("  - and {} more", items.len() - LISTED_ITEMS));
    }
    lines
}

fn check_status_word(status: PrCheckStatus) -> &'static str {
    match status {
        PrCheckStatus::Pending => "pending",
        PrCheckStatus::ActionRequired => "action-required",
        PrCheckStatus::Success => "success",
        PrCheckStatus::Failure => "failure",
        PrCheckStatus::Skipped => "skipped",
        PrCheckStatus::Neutral => "neutral",
        PrCheckStatus::Cancelled => "cancelled",
    }
}

fn change_lines(change: &WatchChange, base_branch: &str, commit: &str) -> Vec<String> {
    match change {
        WatchChange::ChecksFailed(failed) => {
            let mut lines = vec![format!("- Checks failed{commit}:")];
            lines.extend(listed(failed, |check| {
                let status = if check.status == PrCheckStatus::Failure {
                    String::new()
                } else {
                    format!(" ({})", check_status_word(check.status))
                };
                let url = check
                    .url
                    .as_deref()
                    .map(|u| format!(" {u}"))
                    .unwrap_or_default();
                format!("  - {}{status}{url}", check.name)
            }));
            lines
        }
        WatchChange::ChecksPassed { count, required } => vec![format!(
            "- All {count} {}{} passed{commit}.",
            if *required { "required " } else { "" },
            if *count == 1 { "check" } else { "checks" }
        )],
        WatchChange::Remarks(remarks) => {
            let mut lines = vec![format!(
                "- {} new {}:",
                remarks.len(),
                if remarks.len() == 1 {
                    "comment"
                } else {
                    "comments"
                }
            )];
            lines.extend(listed(remarks, |remark| {
                let who = remark
                    .author
                    .as_ref()
                    .map_or("someone", |a| a.login.as_str());
                let place = remark
                    .path
                    .as_deref()
                    .map(|p| format!(" on {p}"))
                    .unwrap_or_default();
                let body = snippet(&remark.body);
                let said = if body.is_empty() {
                    remark
                        .review_state
                        .clone()
                        .unwrap_or_else(|| "reviewed".into())
                } else {
                    format!("\"{body}\"")
                };
                let url = remark
                    .url
                    .as_deref()
                    .map(|u| format!(" {u}"))
                    .unwrap_or_default();
                format!("  - {who}{place}: {said}{url}")
            }));
            lines
        }
        WatchChange::Conflicting => vec![format!("- The branch now conflicts with {base_branch}.")],
    }
}

fn summary_word(change: &WatchChange) -> &'static str {
    match change {
        WatchChange::ChecksFailed(_) => "checks failed",
        WatchChange::ChecksPassed { .. } => "checks passed",
        WatchChange::Remarks(_) => "new comments",
        WatchChange::Conflicting => "merge conflict",
    }
}

/// How a wake reads: bad news, good news, or just news.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WakeOutcomeKind {
    Failed,
    Completed,
    Updated,
}

/// What the agent is told, and the line the user sees for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WakeMessage {
    pub text: String,
    pub summary: String,
    pub outcome: WakeOutcomeKind,
}

/// The wake for `report` on pull request `number`.
pub fn message(
    number: u32,
    url: &str,
    base_branch: &str,
    head_sha: Option<&str>,
    report: &WatchReport,
) -> WakeMessage {
    let commit = head_sha
        .map(|sha| format!(" on {}", &sha[..sha.len().min(7)]))
        .unwrap_or_default();
    let mut lines = vec![format!(
        "Update on pull request #{number} ({url}), which Atlas is watching for you:"
    )];
    for change in &report.changes {
        lines.extend(change_lines(change, base_branch, &commit));
    }
    lines.push(String::new());
    lines.push(if report.exhausted {
        format!(
            "Atlas stopped watching after {WAKE_LIMIT} comment-only updates in a row. Call \
             watch_pull_request to watch it again."
        )
    } else {
        "Look into each item and act on it as your task requires. Atlas keeps watching and wakes \
         you on the next change, so end your turn when you are done. When you hand the work back \
         to the user, call unwatch_pull_request first so the session returns to their inbox."
            .to_string()
    });
    let failed = report
        .changes
        .iter()
        .any(|c| matches!(c, WatchChange::ChecksFailed(_) | WatchChange::Conflicting));
    let mut summary: Vec<&str> = report.changes.iter().map(summary_word).collect();
    if report.exhausted {
        summary.push("stopped watching");
    }
    let outcome = if failed {
        WakeOutcomeKind::Failed
    } else if report
        .changes
        .iter()
        .all(|c| matches!(c, WatchChange::ChecksPassed { .. }))
    {
        WakeOutcomeKind::Completed
    } else {
        WakeOutcomeKind::Updated
    };
    WakeMessage {
        text: lines.join("\n"),
        summary: format!("#{number}: {}", summary.join(", ")),
        outcome,
    }
}

/// The wake for a pull request that was closed.
pub fn closed_message(number: u32, url: &str) -> WakeMessage {
    WakeMessage {
        text: format!(
            "Pull request #{number} ({url}) was closed, so Atlas stopped watching it. Call \
             watch_pull_request if it reopens."
        ),
        summary: format!("#{number}: closed, stopped watching"),
        outcome: WakeOutcomeKind::Updated,
    }
}

/// The wake for a pull request Atlas could not read [`READ_FAILURE_LIMIT`]
/// times in a row.
pub fn unreadable_message(number: u32, url: &str) -> WakeMessage {
    WakeMessage {
        text: format!(
            "Atlas stopped watching pull request #{number} ({url}) because it failed to read it \
             from the host {READ_FAILURE_LIMIT} times in a row. Check it yourself, and call \
             watch_pull_request to watch it again."
        ),
        summary: format!("#{number}: stopped watching, could not read it"),
        outcome: WakeOutcomeKind::Failed,
    }
}

// ── read planning (pure) ────────────────────────────────────────────────

/// What the last read of one pull request saw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LastRead {
    pub at: i64,
    /// The sessions' snapshots then ([`snapshot_fingerprint`]).
    pub fingerprint: String,
    /// A check was pending or mergeability unknown: more is coming.
    pub in_flight: bool,
    /// The conversation was read whole.
    pub remarks_complete: bool,
    /// The watches it was read for ([`watch_key`]).
    pub watches: HashSet<String>,
}

/// A watch's identity across passes.
pub fn watch_key(thread_id: ThreadId, watch: &PullRequestWatch) -> String {
    format!("{thread_id} {}", watch.started_at.timestamp_millis())
}

/// What a link's snapshot says that a read could follow up on.
pub fn snapshot_fingerprint(link: &PullRequestLink) -> String {
    link.snapshot.as_ref().map_or_else(String::new, |s| {
        format!(
            "{} {} {} {} {}",
            s.state,
            s.updated_at.as_deref().unwrap_or("-"),
            s.checks_state.as_deref().unwrap_or("-"),
            s.review_decision.as_deref().unwrap_or("-"),
            s.is_draft
        )
    })
}

/// Whether a pull request is due a read: never read for these watches,
/// something in flight, the last read incomplete, the snapshot moved, or
/// quiet for [`QUIET_REREAD_MS`].
pub fn plan_read(
    watches: &HashSet<String>,
    fingerprint: &str,
    last: Option<&LastRead>,
    now: i64,
) -> bool {
    let Some(last) = last else {
        return true;
    };
    !watches.is_subset(&last.watches)
        || last.in_flight
        || !last.remarks_complete
        || last.fingerprint != fingerprint
        || now - last.at >= QUIET_REREAD_MS
}

// ── settle on merge (pure) ──────────────────────────────────────────────

/// When the link's pull request merged or closed, as far as Atlas knows: the
/// merge time on a merged snapshot, else the host's last update time on one
/// that says it is done ([`PullRequestSnapshot::done_at`]).
fn terminal_at(link: &PullRequestLink) -> Option<i64> {
    link.snapshot.as_ref()?.done_at().and_then(parse_time)
}

/// Whether the session's pull requests settle it: every one it waits on is
/// done, and the last of them closed — or merged, with `on_merge` — after the
/// user's last word in the session. A pull request linked after it was
/// already done records work the session did (an agent merging what it was
/// asked to), so it neither holds nor settles the session.
pub fn settles(thread: &ThreadMetadata, on_merge: bool) -> bool {
    if thread.is_settled() || thread.is_draft() || thread.is_pinned() || thread.is_snoozed() {
        return false;
    }
    let links: Vec<&PullRequestLink> = visible_pull_requests(&thread.pull_requests)
        .filter(|link| match terminal_at(link) {
            None => true,
            Some(at) => at >= link.linked_at.timestamp_millis(),
        })
        .collect();
    if links.is_empty()
        || links
            .iter()
            .any(|l| l.snapshot.as_ref().is_none_or(|s| s.state == "open"))
    {
        return false;
    }
    let Some((latest, at)) = links
        .iter()
        .filter_map(|l| terminal_at(l).map(|at| (*l, at)))
        .max_by_key(|(_, at)| *at)
    else {
        return false;
    };
    let state = latest.snapshot.as_ref().map(|s| s.state.as_str());
    if state != Some("closed") && !(state == Some("merged") && on_merge) {
        return false;
    }
    let anchor = thread
        .created_at
        .into_iter()
        .chain(thread.interacted_at)
        .max()
        .map(|t| t.timestamp_millis());
    anchor.is_some_and(|anchor| at >= anchor)
}

// ── reading a pull request ──────────────────────────────────────────────

/// What a watch reads of a pull request: the parts of its detail the
/// evaluation and the link's snapshot need.
#[derive(Debug, Clone)]
pub struct WatchedPr {
    pub state: PrState,
    pub title: String,
    pub head_branch: String,
    pub base_branch: String,
    pub is_draft: bool,
    pub updated_at: String,
    /// When it merged; `None` while it is not merged.
    pub merged_at: Option<String>,
    pub checks_state: Option<PrChecksState>,
    pub review_decision: Option<PrReviewDecision>,
    pub head_sha: Option<String>,
    pub checks: Vec<PrCheck>,
    pub mergeability: PrMergeability,
    pub viewer: Option<String>,
    pub author: Option<String>,
}

impl From<PrDetail> for WatchedPr {
    fn from(d: PrDetail) -> Self {
        Self {
            state: d.state,
            title: d.title,
            head_branch: d.head_branch,
            base_branch: d.base_branch,
            is_draft: d.is_draft,
            updated_at: d.updated_at,
            merged_at: d.merged_at,
            checks_state: d.checks_state,
            review_decision: d.review_decision,
            head_sha: d.head_sha,
            checks: d.checks,
            mergeability: d.mergeability,
            viewer: d.viewer,
            author: d.author.map(|a| a.login),
        }
    }
}

/// One read of a watched pull request.
#[derive(Debug, Clone)]
pub struct WatchRead {
    pub detail: WatchedPr,
    /// `None` when the conversation could not be read whole.
    pub remarks: Option<Vec<PrComment>>,
}

/// Where the reactor reads pull requests. A trait so a debug build can
/// stand a scripted source in for GitHub (`ATLAS_PR_WATCH_FAKE`), since a
/// watch cannot be tried without real events on a real pull request.
pub trait WatchSource: Send + Sync {
    fn read(
        &self,
        checkout: String,
        repository: String,
        number: u32,
    ) -> BoxFuture<'static, Result<WatchRead, PrError>>;
}

/// The real source: the checkout's `gh`, reading in the background.
pub struct GitHubSource;

impl WatchSource for GitHubSource {
    fn read(
        &self,
        checkout: String,
        repository: String,
        number: u32,
    ) -> BoxFuture<'static, Result<WatchRead, PrError>> {
        Box::pin(async move {
            let github = GitHub::open_with(&checkout, ReadPolicy::Background).await?;
            if !github
                .provider()
                .repository
                .eq_ignore_ascii_case(&repository)
            {
                return Err(PrError::Unsupported {
                    message: "The session's checkout is another repository.".into(),
                });
            }
            let number = u64::from(number);
            let (detail, activity) = tokio::join!(github.detail(number), github.activity(number));
            let (detail, activity) = (detail?, activity?);
            let remarks = read_remarks(&github, number, activity).await;
            Ok(WatchRead {
                detail: detail.into(),
                remarks,
            })
        })
    }
}

/// Every remark: the conversation's, and each review thread's whole tail.
/// `None` when that cannot be had: a cursor never says which threads it
/// skipped, so a truncated thread list is only finished when every thread
/// was listed.
async fn read_remarks(
    github: &GitHub,
    number: u64,
    activity: super::pull_requests::PrActivity,
) -> Option<Vec<PrComment>> {
    if activity.comments_truncated && activity.review_threads_truncated {
        return None;
    }
    let mut remarks = activity.comments;
    for thread in activity
        .review_threads
        .iter()
        .filter(|t| t.next_comments_cursor.is_some())
    {
        let mut cursor = thread.next_comments_cursor.clone();
        let mut seen = HashSet::new();
        let mut tail: HashMap<String, PrComment> = HashMap::new();
        while let Some(at) = cursor {
            if !seen.insert(at.clone()) {
                return None;
            }
            let page = github
                .thread_comments(number, &thread.id, Some(at))
                .await
                .ok()?;
            for c in page.comments {
                tail.insert(
                    c.id.clone(),
                    PrComment {
                        id: c.id,
                        kind: PrCommentKind::ReviewComment,
                        author: c.author,
                        body: c.body,
                        created_at: c.created_at,
                        edited_at: c.edited_at,
                        url: c.url,
                        path: Some(thread.path.clone()),
                        review_state: None,
                        reactions: c.reactions,
                        can_edit: c.can_edit,
                        can_delete: c.can_delete,
                    },
                );
            }
            cursor = page.next_cursor;
        }
        if (thread.comments.len() + tail.len()) < thread.comment_count as usize {
            return None;
        }
        remarks.extend(tail.into_values());
    }
    remarks.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Some(remarks)
}

// ── the loop ────────────────────────────────────────────────────────────

/// The reactor's memory between passes. In memory only: a restart reads
/// every watched pull request once, which is what a cold start costs anyway.
#[derive(Default)]
struct ReactorState {
    failures: HashMap<String, u32>,
    last_reads: HashMap<String, LastRead>,
}

/// One watched link, in its session.
#[derive(Debug, Clone)]
struct Target {
    thread_id: ThreadId,
    link: PullRequestLink,
    watch: PullRequestWatch,
}

/// The watches on one pull request, read through one checkout.
#[derive(Debug, Clone)]
struct Group {
    key: String,
    checkout: String,
    repository: String,
    number: u32,
    targets: Vec<Target>,
}

/// The payload of [`SESSION_PROMPT_INJECTED_EVENT`]: a prompt Atlas sent to a
/// session's agent on its own, for its tab to draw as its own row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPromptInjected {
    pub session_id: String,
    pub thread_id: String,
    pub text: String,
    /// One line for the row's header (`#12: checks failed`).
    pub summary: String,
    /// What sent it: `pull-request-watch` or `restart`.
    pub source: String,
    /// RFC 3339.
    pub at: String,
}

/// Wire up wakes and start the reactor: once per launch, from setup.
pub fn start(app: AppHandle, host: Arc<AgentHost>) {
    let weak = Arc::downgrade(&host);
    let emitter = app.clone();
    host.set_wake_delivery(Arc::new(move |key: &SessionKey, wake: &PendingWake| {
        let host = weak.upgrade().ok_or("Atlas is shutting down.")?;
        let _ = emitter.emit(
            SESSION_PROMPT_INJECTED_EVENT,
            SessionPromptInjected {
                session_id: key.session_id.clone(),
                thread_id: wake.thread_id.to_string(),
                text: wake.text.clone(),
                summary: wake.summary.clone(),
                source: wake.source.token().into(),
                at: Utc::now().to_rfc3339(),
            },
        );
        send_prompt(
            &emitter,
            &host,
            key,
            OutgoingPrompt::text(wake.text.clone()),
            PromptOrigin::Atlas,
        )
    }));

    let source: Arc<dyn WatchSource> = source_for_build();
    let every = sweep_every();
    tauri::async_runtime::spawn(async move {
        let mut state = ReactorState::default();
        loop {
            tokio::time::sleep(every).await;
            sweep(&app, &host, source.as_ref(), &mut state).await;
        }
    });
}

#[cfg(debug_assertions)]
fn source_for_build() -> Arc<dyn WatchSource> {
    match std::env::var_os("ATLAS_PR_WATCH_FAKE") {
        Some(path) => {
            tracing::warn!("pull request watch reads a scripted source (ATLAS_PR_WATCH_FAKE)");
            Arc::new(fake::FakeSource(path.into()))
        }
        None => Arc::new(GitHubSource),
    }
}

#[cfg(not(debug_assertions))]
fn source_for_build() -> Arc<dyn WatchSource> {
    Arc::new(GitHubSource)
}

fn sweep_every() -> Duration {
    #[cfg(debug_assertions)]
    if let Some(secs) = std::env::var("ATLAS_PR_WATCH_SWEEP_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
    {
        return Duration::from_secs(secs.max(1));
    }
    SWEEP_EVERY
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn checkout_of(thread: &ThreadMetadata) -> Option<String> {
    thread
        .folder_paths()
        .paths()
        .first()
        .map(|p| p.to_string_lossy().into_owned())
}

/// One pass: settle what is done, end what cannot go on, read what is due.
async fn sweep(
    app: &AppHandle,
    host: &Arc<AgentHost>,
    source: &dyn WatchSource,
    state: &mut ReactorState,
) {
    let Some(history) = host.history() else {
        return;
    };
    let store = history.store().clone();
    settle_finished(host, atlas_config::read(app).auto_settle_on_merge).await;

    let wakes_on = atlas_config::read(app).pull_request_watch_wakes;
    let threads = store.threads();
    let mut groups: HashMap<String, Group> = HashMap::new();
    for thread in &threads {
        let Some(checkout) = checkout_of(thread) else {
            continue;
        };
        for link in visible_pull_requests(&thread.pull_requests) {
            let Some(watch) = link.watch.clone() else {
                continue;
            };
            // Merged ends the watch without a word; settle on merge follows.
            if link.snapshot.as_ref().is_some_and(|s| s.state == "merged") {
                store.sync_pull_request_watch(
                    thread.thread_id,
                    &link.repository,
                    link.number,
                    watch.started_at,
                    WatchSync::End { told: None },
                );
                continue;
            }
            let key = format!(
                "{checkout}\0{}#{}",
                link.repository.to_ascii_lowercase(),
                link.number
            );
            groups
                .entry(key.clone())
                .or_insert_with(|| Group {
                    key,
                    checkout: checkout.clone(),
                    repository: link.repository.clone(),
                    number: link.number,
                    targets: Vec::new(),
                })
                .targets
                .push(Target {
                    thread_id: thread.thread_id,
                    link: link.clone(),
                    watch,
                });
        }
    }
    state.failures.retain(|k, _| groups.contains_key(k));
    state.last_reads.retain(|k, _| groups.contains_key(k));
    // Off: nothing is read and nobody is woken; the watches stay as they are.
    if !wakes_on || groups.is_empty() {
        return;
    }
    let now = now_ms();
    if quota_paused_until(now).is_some() {
        return;
    }
    let due: Vec<(Group, String, HashSet<String>)> = groups
        .into_values()
        .filter_map(|group| {
            let watches: HashSet<String> = group
                .targets
                .iter()
                .map(|t| watch_key(t.thread_id, &t.watch))
                .collect();
            let mut prints: Vec<String> = group
                .targets
                .iter()
                .map(|t| snapshot_fingerprint(&t.link))
                .collect();
            prints.sort();
            prints.dedup();
            let fingerprint = prints.join("\n");
            plan_read(
                &watches,
                &fingerprint,
                state.last_reads.get(&group.key),
                now,
            )
            .then_some((group, fingerprint, watches))
        })
        .collect();
    let reads: Vec<_> = futures::stream::iter(due)
        .map(|(group, fingerprint, watches)| {
            let read = source.read(
                group.checkout.clone(),
                group.repository.clone(),
                group.number,
            );
            async move {
                let result = match tokio::time::timeout(READ_TIMEOUT, read).await {
                    Ok(result) => result,
                    Err(_) => Err(PrError::Network {
                        message: "The pull request took too long to read.".into(),
                    }),
                };
                (group, fingerprint, watches, result)
            }
        })
        .buffer_unordered(READ_CONCURRENCY)
        .collect()
        .await;
    for (group, fingerprint, watches, result) in reads {
        apply_read(host, state, group, fingerprint, watches, result, now);
    }
}

/// What one read means for its watches.
fn apply_read(
    host: &Arc<AgentHost>,
    state: &mut ReactorState,
    group: Group,
    fingerprint: String,
    watches: HashSet<String>,
    result: Result<WatchRead, PrError>,
    now: i64,
) {
    let Some(history) = host.history() else {
        return;
    };
    let store = history.store();
    let read = match result {
        Ok(read) => read,
        // A rate limit pauses the watch; it is not the pull request's fault.
        Err(PrError::RateLimited { .. }) => {
            state.last_reads.remove(&group.key);
            return;
        }
        Err(e) => {
            state.last_reads.remove(&group.key);
            let failures = state.failures.entry(group.key.clone()).or_default();
            *failures += 1;
            tracing::debug!(error = ?std::mem::discriminant(&e), failures = *failures, "pull request watch read failed");
            if *failures >= READ_FAILURE_LIMIT {
                state.failures.remove(&group.key);
                for target in &group.targets {
                    let wake = unreadable_message(target.link.number, &target.link.url);
                    end_with(host, target, None, Some(wake));
                }
            }
            return;
        }
    };
    state.failures.remove(&group.key);
    let detail = &read.detail;
    // What the read says becomes the links' snapshot too, so every surface
    // (and the settle rule) sees a merge the watch found.
    for target in &group.targets {
        store.sync_pull_request(
            &group.repository,
            group.number,
            &snapshot_of_detail(detail, target.link.snapshot.as_ref()),
        );
    }
    if detail.state != PrState::Open {
        state.last_reads.remove(&group.key);
        for target in &group.targets {
            let wake = (detail.state == PrState::Closed)
                .then(|| closed_message(target.link.number, &target.link.url));
            end_with(host, target, None, wake);
        }
        return;
    }
    state.last_reads.insert(
        group.key.clone(),
        LastRead {
            at: now,
            fingerprint,
            in_flight: detail.mergeability == PrMergeability::Unknown
                || detail
                    .checks
                    .iter()
                    .any(|c| c.status == PrCheckStatus::Pending),
            remarks_complete: read.remarks.is_some(),
            watches,
        },
    );
    let watched = WatchedState {
        head_sha: detail.head_sha.as_deref(),
        checks: &detail.checks,
        mergeability: detail.mergeability,
        viewer: detail.viewer.as_deref(),
        author: detail.author.as_deref(),
    };
    for target in &group.targets {
        let report = evaluate(&target.watch, &watched, read.remarks.as_deref());
        if report.changes.is_empty() {
            if report.next != target.watch {
                store.sync_pull_request_watch(
                    target.thread_id,
                    &target.link.repository,
                    target.link.number,
                    target.watch.started_at,
                    WatchSync::Continue(report.next),
                );
            }
            continue;
        }
        let wake = message(
            target.link.number,
            &target.link.url,
            &detail.base_branch,
            report.next.head_sha.as_deref(),
            &report,
        );
        if report.exhausted {
            end_with(host, target, Some(report.next), Some(wake));
            continue;
        }
        // Recorded first: a stop or settle that landed during the read wins,
        // and then nothing is said.
        if store.sync_pull_request_watch(
            target.thread_id,
            &target.link.repository,
            target.link.number,
            target.watch.started_at,
            WatchSync::Continue(report.next),
        ) {
            send_wake(host, target.thread_id, wake);
        }
    }
}

/// End `target`'s watch (keeping `told`), and say `wake` if the watch was
/// still the one on.
fn end_with(
    host: &Arc<AgentHost>,
    target: &Target,
    told: Option<PullRequestWatch>,
    wake: Option<WakeMessage>,
) {
    let Some(history) = host.history() else {
        return;
    };
    let ended = history.store().sync_pull_request_watch(
        target.thread_id,
        &target.link.repository,
        target.link.number,
        target.watch.started_at,
        WatchSync::End { told },
    );
    if let (true, Some(wake)) = (ended, wake) {
        send_wake(host, target.thread_id, wake);
    }
}

/// Wake the session, on its own task: opening a session that is not loaded
/// can take a while, and the pass does not wait for it.
fn send_wake(host: &Arc<AgentHost>, thread_id: ThreadId, wake: WakeMessage) {
    let host = host.clone();
    tauri::async_runtime::spawn(async move {
        let pending = PendingWake {
            source: WakeSource::PullRequestWatch,
            thread_id,
            text: wake.text,
            summary: wake.summary,
        };
        if let Err(e) = host.wake(pending).await {
            tracing::warn!(error = %e, "pull request watch could not wake its session");
        }
    });
}

/// A full read as a link's snapshot. The detail does not count comments, so
/// the held count stays.
fn snapshot_of_detail(
    detail: &WatchedPr,
    held: Option<&PullRequestSnapshot>,
) -> PullRequestSnapshot {
    PullRequestSnapshot {
        state: match detail.state {
            PrState::Open => "open",
            PrState::Closed => "closed",
            PrState::Merged => "merged",
        }
        .into(),
        title: detail.title.clone(),
        head_branch: detail.head_branch.clone(),
        base_branch: detail.base_branch.clone(),
        is_draft: detail.is_draft,
        updated_at: Some(detail.updated_at.clone()).filter(|u| !u.is_empty()),
        merged_at: detail.merged_at.clone().filter(|m| !m.is_empty()),
        checks_state: detail.checks_state.map(|c| {
            match c {
                PrChecksState::Passing => "passing",
                PrChecksState::Failing => "failing",
                PrChecksState::Pending => "pending",
            }
            .to_string()
        }),
        review_decision: detail.review_decision.map(|r| {
            match r {
                PrReviewDecision::Approved => "approved",
                PrReviewDecision::ChangesRequested => "changes-requested",
                PrReviewDecision::ReviewRequired => "review-required",
            }
            .to_string()
        }),
        comment_count: held.and_then(|s| s.comment_count),
        synced_at: Utc::now(),
    }
}

/// Settle every session whose pull requests are done ([`settles`]). The
/// host's settle refuses a session mid-turn or live in another process, so a
/// refused one is simply tried again next pass. Off the async runtime: the
/// liveness check reads transcript folders.
pub async fn settle_finished(host: &Arc<AgentHost>, on_merge: bool) {
    let host = host.clone();
    let settled = tokio::task::spawn_blocking(move || {
        let Some(history) = host.history() else {
            return 0;
        };
        history
            .store()
            .threads()
            .iter()
            .filter(|t| settles(t, on_merge))
            .filter(|t| {
                host.settle_thread(t.thread_id, &super::session_watcher::activity_in)
                    .unwrap_or(false)
            })
            .count()
    })
    .await
    .unwrap_or(0);
    if settled > 0 {
        tracing::debug!(settled, "settled sessions whose pull requests are done");
    }
}

/// A scripted source for trying watches in a debug build: a JSON file, read
/// on every pass, of `"owner/name#number"` → the pull request as it is now.
/// Edit the file and the next pass sees the change.
#[cfg(debug_assertions)]
mod fake {
    use super::*;
    use crate::commands::pull_requests::PrActor;
    use serde::Deserialize;

    pub struct FakeSource(pub std::path::PathBuf);

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FakePr {
        #[serde(default = "default_state")]
        state: String,
        #[serde(default)]
        head_sha: Option<String>,
        #[serde(default = "default_base")]
        base_branch: String,
        #[serde(default)]
        mergeability: Option<String>,
        #[serde(default)]
        viewer: Option<String>,
        /// The host's last update time; a close is dated by it, and a merge
        /// too when `mergedAt` is left out.
        #[serde(default)]
        updated_at: Option<String>,
        /// When it merged; a merge is dated by it.
        #[serde(default)]
        merged_at: Option<String>,
        #[serde(default)]
        checks: Vec<FakeCheck>,
        #[serde(default)]
        remarks: Vec<FakeRemark>,
        /// Answer with a network failure instead.
        #[serde(default)]
        fail: bool,
    }

    fn default_state() -> String {
        "open".into()
    }
    fn default_base() -> String {
        "main".into()
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FakeCheck {
        name: String,
        status: PrCheckStatus,
        #[serde(default)]
        required: Option<bool>,
        #[serde(default)]
        url: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FakeRemark {
        id: String,
        author: String,
        body: String,
        created_at: String,
        #[serde(default)]
        edited_at: Option<String>,
        #[serde(default)]
        path: Option<String>,
    }

    impl WatchSource for FakeSource {
        fn read(
            &self,
            _checkout: String,
            repository: String,
            number: u32,
        ) -> BoxFuture<'static, Result<WatchRead, PrError>> {
            let path = self.0.clone();
            Box::pin(async move {
                let text = tokio::fs::read_to_string(&path)
                    .await
                    .map_err(|e| PrError::failed(e.to_string()))?;
                let mut all: HashMap<String, FakePr> =
                    serde_json::from_str(&text).map_err(|e| PrError::failed(e.to_string()))?;
                let key = format!("{}#{number}", repository.to_ascii_lowercase());
                let pr = all.remove(&key).ok_or(PrError::NotFound)?;
                if pr.fail {
                    return Err(PrError::Network {
                        message: "scripted failure".into(),
                    });
                }
                let actor = |login: &str| PrActor {
                    login: login.to_string(),
                    name: None,
                    avatar_url: None,
                    is_bot: false,
                };
                let checks: Vec<PrCheck> = pr
                    .checks
                    .into_iter()
                    .map(|c| PrCheck {
                        name: c.name,
                        status: c.status,
                        description: None,
                        url: c.url,
                        required: c.required,
                        workflow: None,
                        started_at: None,
                        completed_at: None,
                        duration_ms: None,
                    })
                    .collect();
                let remarks = pr
                    .remarks
                    .into_iter()
                    .map(|r| PrComment {
                        id: r.id,
                        kind: if r.path.is_some() {
                            PrCommentKind::ReviewComment
                        } else {
                            PrCommentKind::IssueComment
                        },
                        author: Some(actor(&r.author)),
                        body: r.body,
                        created_at: r.created_at,
                        edited_at: r.edited_at,
                        url: None,
                        path: r.path,
                        review_state: None,
                        reactions: Vec::new(),
                        can_edit: false,
                        can_delete: false,
                    })
                    .collect();
                let state = match pr.state.as_str() {
                    "merged" => PrState::Merged,
                    "closed" => PrState::Closed,
                    _ => PrState::Open,
                };
                let mergeability = match pr.mergeability.as_deref() {
                    Some("conflicting") => PrMergeability::Conflicting,
                    Some("unknown") => PrMergeability::Unknown,
                    _ => PrMergeability::Mergeable,
                };
                let checks_state = if checks.iter().any(is_failed_check) {
                    Some(PrChecksState::Failing)
                } else if checks.iter().any(|c| c.status == PrCheckStatus::Pending) {
                    Some(PrChecksState::Pending)
                } else if checks.is_empty() {
                    None
                } else {
                    Some(PrChecksState::Passing)
                };
                let detail = WatchedPr {
                    state,
                    title: format!("Scripted pull request #{number}"),
                    head_branch: "scripted".into(),
                    base_branch: pr.base_branch,
                    is_draft: false,
                    updated_at: pr.updated_at.unwrap_or_default(),
                    merged_at: pr.merged_at,
                    checks_state,
                    review_decision: None,
                    head_sha: pr.head_sha,
                    checks,
                    mergeability,
                    viewer: pr.viewer,
                    author: None,
                };
                Ok(WatchRead {
                    detail,
                    remarks: Some(remarks),
                })
            })
        }
    }
}

#[cfg(test)]
mod tests;

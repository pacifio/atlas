//! GitHub's answers, read into the provider-neutral wire types.
//!
//! Pure functions over `serde_json::Value`, deliberately lenient: GitHub
//! allows a null in almost any list, and a node this code does not
//! understand (a type added later, a field an older Enterprise server lacks)
//! is skipped rather than failing the whole read. Each function is tested
//! against fixture answers in `fixtures/`.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::model::*;

// ── small readers ────────────────────────────────────────────────────────

/// A string with its whitespace trimmed, or `None` for null, absent or empty.
pub(crate) fn trimmed(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn text(value: &Value, key: &str) -> Option<String> {
    trimmed(value.get(key))
}

fn string_or_empty(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn boolean(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}

fn number(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64)
}

fn u32_of(value: &Value, key: &str) -> u32 {
    number(value, key)
        .map(|n| n.min(u64::from(u32::MAX)) as u32)
        .unwrap_or(0)
}

/// A connection's nodes, without the nulls GraphQL allows in a list.
pub(crate) fn nodes(connection: Option<&Value>) -> Vec<&Value> {
    connection
        .and_then(|c| c.get("nodes"))
        .and_then(Value::as_array)
        .map(|list| list.iter().filter(|n| !n.is_null()).collect())
        .unwrap_or_default()
}

/// GitHub sends an `endCursor` on a page that is also the last one, so the
/// flag is what decides, not the cursor's presence.
pub(crate) fn next_cursor(page_info: Option<&Value>) -> Option<String> {
    let page_info = page_info?;
    (boolean(page_info, "hasNextPage") == Some(true))
        .then(|| text(page_info, "endCursor"))
        .flatten()
}

pub(crate) fn to_actor(raw: Option<&Value>) -> Option<PrActor> {
    let raw = raw.filter(|v| !v.is_null())?;
    let login = text(raw, "login")?;
    Some(PrActor {
        login,
        name: text(raw, "name"),
        avatar_url: text(raw, "avatarUrl"),
        is_bot: raw.get("__typename").and_then(Value::as_str) == Some("Bot"),
    })
}

/// A requested team, which goes by `org/slug` — the handle GitHub mentions
/// it by. No login contains a slash, so a team never shares a row with a
/// user.
pub(crate) fn to_requested_team(raw: Option<&Value>) -> Option<PrActor> {
    let raw = raw?;
    let login = text(raw, "combinedSlug")?;
    Some(PrActor {
        login,
        name: text(raw, "teamName"),
        avatar_url: text(raw, "teamAvatarUrl"),
        is_bot: false,
    })
}

/// A commit author off the review read, which names an account by
/// `user.login`; an unlinked signature keeps its name (or email) so a
/// co-authored commit does not collapse into one author.
fn to_commit_actor(raw: &Value) -> Option<PrActor> {
    let login = trimmed(raw.get("user").and_then(|u| u.get("login")))
        .or_else(|| text(raw, "name"))
        .or_else(|| text(raw, "email"))?;
    Some(PrActor {
        login,
        name: text(raw, "name"),
        avatar_url: text(raw, "avatarUrl"),
        is_bot: false,
    })
}

pub(crate) fn to_state(raw: &Value) -> PrState {
    if text(raw, "mergedAt").is_some() {
        return PrState::Merged;
    }
    match text(raw, "state")
        .map(|s| s.to_ascii_uppercase())
        .as_deref()
    {
        Some("MERGED") => PrState::Merged,
        Some("CLOSED") => PrState::Closed,
        _ => PrState::Open,
    }
}

pub(crate) fn to_mergeability(value: Option<&Value>) -> PrMergeability {
    match trimmed(value).map(|s| s.to_ascii_uppercase()).as_deref() {
        Some("MERGEABLE") => PrMergeability::Mergeable,
        Some("CONFLICTING") => PrMergeability::Conflicting,
        _ => PrMergeability::Unknown,
    }
}

pub(crate) fn to_merge_method(value: Option<&Value>) -> Option<PrMergeMethod> {
    match trimmed(value)?.to_ascii_uppercase().as_str() {
        "MERGE" => Some(PrMergeMethod::Merge),
        "SQUASH" => Some(PrMergeMethod::Squash),
        "REBASE" => Some(PrMergeMethod::Rebase),
        _ => None,
    }
}

pub(crate) fn graphql_merge_method(method: PrMergeMethod) -> &'static str {
    match method {
        PrMergeMethod::Merge => "MERGE",
        PrMergeMethod::Squash => "SQUASH",
        PrMergeMethod::Rebase => "REBASE",
    }
}

fn to_review_decision(value: Option<&Value>) -> Option<PrReviewDecision> {
    match trimmed(value)?.to_ascii_uppercase().as_str() {
        "APPROVED" => Some(PrReviewDecision::Approved),
        "CHANGES_REQUESTED" => Some(PrReviewDecision::ChangesRequested),
        "REVIEW_REQUIRED" => Some(PrReviewDecision::ReviewRequired),
        _ => None,
    }
}

/// GitHub's own `reviewDecision` counts only reviews that satisfy branch
/// rules, so an approval from an app, or from anyone without the required
/// permission, leaves it empty; the latest reviews fill that in.
fn to_review_decision_with_reviews(
    value: Option<&Value>,
    reviews: &[&Value],
) -> Option<PrReviewDecision> {
    let summarized = to_review_decision(value);
    if matches!(
        summarized,
        Some(PrReviewDecision::Approved | PrReviewDecision::ChangesRequested)
    ) {
        return summarized;
    }
    let states: HashSet<String> = reviews
        .iter()
        .filter_map(|r| text(r, "state"))
        .map(|s| s.to_ascii_uppercase())
        .collect();
    if states.contains("CHANGES_REQUESTED") {
        return Some(PrReviewDecision::ChangesRequested);
    }
    if states.contains("APPROVED") {
        return Some(PrReviewDecision::Approved);
    }
    summarized
}

fn to_label(raw: Option<&Value>) -> Option<PrLabel> {
    let raw = raw.filter(|v| !v.is_null())?;
    Some(PrLabel {
        name: text(raw, "name")?,
        color: text(raw, "color"),
    })
}

fn to_labels(connection: Option<&Value>) -> Vec<PrLabel> {
    nodes(connection)
        .into_iter()
        .filter_map(|label| to_label(Some(label)))
        .collect()
}

// ── checks ───────────────────────────────────────────────────────────────

/// What GitHub writes where a run has not reached that moment yet.
const UNSET_TIMESTAMP: &str = "0001-01-01T00:00:00Z";
/// Sorts after every real time, so a run still going outranks a finished
/// run of the same check.
const STILL_RUNNING: &str = "9999-12-31T23:59:59Z";

fn real_timestamp(value: Option<&Value>) -> Option<String> {
    trimmed(value).filter(|at| at != UNSET_TIMESTAMP)
}

/// Commit statuses report one `state`; check runs report `status` plus a
/// `conclusion` that exists only once the run has completed.
fn to_check_status(raw: &Value) -> PrCheckStatus {
    if let Some(status) = text(raw, "status") {
        if !status.eq_ignore_ascii_case("COMPLETED") {
            return PrCheckStatus::Pending;
        }
    }
    let verdict = text(raw, "conclusion").or_else(|| text(raw, "state"));
    match verdict.map(|s| s.to_ascii_uppercase()).as_deref() {
        Some("SUCCESS") => PrCheckStatus::Success,
        Some("ACTION_REQUIRED") => PrCheckStatus::ActionRequired,
        Some("FAILURE" | "ERROR" | "TIMED_OUT" | "STARTUP_FAILURE") => PrCheckStatus::Failure,
        Some("CANCELLED") => PrCheckStatus::Cancelled,
        Some("SKIPPED") => PrCheckStatus::Skipped,
        Some("PENDING" | "EXPECTED") => PrCheckStatus::Pending,
        _ => PrCheckStatus::Neutral,
    }
}

fn duration_ms(started: Option<&str>, completed: Option<&str>) -> Option<u64> {
    let started = chrono::DateTime::parse_from_rfc3339(started?).ok()?;
    let completed = chrono::DateTime::parse_from_rfc3339(completed?).ok()?;
    u64::try_from((completed - started).num_milliseconds()).ok()
}

struct CheckEntry {
    check: PrCheck,
    workflow: Option<String>,
    at: Option<String>,
}

fn workflow_name(raw: &Value) -> Option<String> {
    trimmed(
        raw.get("checkSuite")
            .and_then(|s| s.get("workflowRun"))
            .and_then(|r| r.get("workflow"))
            .and_then(|w| w.get("name")),
    )
}

fn to_check_entries(contexts: &[&Value]) -> Vec<CheckEntry> {
    contexts
        .iter()
        .filter_map(|raw| {
            let name = text(raw, "name").or_else(|| text(raw, "context"))?;
            let status = to_check_status(raw);
            let started_at = real_timestamp(raw.get("startedAt"))
                .or_else(|| real_timestamp(raw.get("createdAt")));
            let completed_at = real_timestamp(raw.get("completedAt"));
            let workflow = workflow_name(raw);
            Some(CheckEntry {
                check: PrCheck {
                    name,
                    status,
                    description: text(raw, "description"),
                    url: text(raw, "detailsUrl").or_else(|| text(raw, "targetUrl")),
                    required: boolean(raw, "isRequired"),
                    workflow: workflow.clone(),
                    duration_ms: duration_ms(started_at.as_deref(), completed_at.as_deref()),
                    started_at: started_at.clone(),
                    completed_at: completed_at.clone(),
                },
                workflow,
                at: if status == PrCheckStatus::Pending {
                    Some(STILL_RUNNING.to_string())
                } else {
                    completed_at.or(started_at)
                },
            })
        })
        .collect()
}

/// A rollup is a list of runs, not of checks: while a workflow is re-run the
/// same check arrives twice. Nothing in a check carries an id, so the name,
/// qualified by its workflow, identifies it and the newest run wins. Failing
/// checks sort first.
fn dedupe_checks(entries: Vec<CheckEntry>) -> Vec<PrCheck> {
    let mut order: Vec<(String, String)> = Vec::new();
    let mut newest: HashMap<(String, String), CheckEntry> = HashMap::new();
    for entry in entries {
        let key = (
            entry.workflow.clone().unwrap_or_default(),
            entry.check.name.clone(),
        );
        match newest.get(&key) {
            Some(kept) if !is_at_least_as_new(entry.at.as_deref(), kept.at.as_deref()) => {}
            Some(_) => {
                newest.insert(key, entry);
            }
            None => {
                order.push(key.clone());
                newest.insert(key, entry);
            }
        }
    }
    let survivors: Vec<CheckEntry> = order.iter().filter_map(|k| newest.remove(k)).collect();
    let mut counts: HashMap<String, usize> = HashMap::new();
    for entry in &survivors {
        *counts.entry(entry.check.name.clone()).or_default() += 1;
    }
    let mut checks: Vec<PrCheck> = survivors
        .into_iter()
        .map(|entry| {
            let workflow = entry.workflow.unwrap_or_default();
            let mut check = entry.check;
            if !workflow.is_empty() && counts.get(&check.name).copied().unwrap_or(0) > 1 {
                check.name = format!("{workflow} / {}", check.name);
            }
            check
        })
        .collect();
    let failing =
        |c: &PrCheck| matches!(c.status, PrCheckStatus::Failure | PrCheckStatus::Cancelled);
    checks.sort_by_key(|c| !failing(c));
    checks
}

fn is_at_least_as_new(candidate: Option<&str>, kept: Option<&str>) -> bool {
    match (candidate, kept) {
        (None, kept) => kept.is_none(),
        (Some(_), None) => true,
        (Some(c), Some(k)) => {
            match (
                chrono::DateTime::parse_from_rfc3339(c),
                chrono::DateTime::parse_from_rfc3339(k),
            ) {
                (Ok(c), Ok(k)) => c >= k,
                _ => c >= k,
            }
        }
    }
}

pub(crate) fn to_checks(contexts: &[&Value]) -> Vec<PrCheck> {
    dedupe_checks(to_check_entries(contexts))
}

/// The one-word verdict over a set of checks. A nameless context (the
/// listing's rollup enum, dressed as a check) still votes.
pub(crate) fn rollup_checks_state(contexts: &[&Value]) -> Option<PrChecksState> {
    let mut statuses: Vec<PrCheckStatus> = to_checks(contexts).iter().map(|c| c.status).collect();
    statuses.extend(
        contexts
            .iter()
            .filter(|raw| text(raw, "name").is_none() && text(raw, "context").is_none())
            .map(|raw| to_check_status(raw)),
    );
    if statuses.is_empty() {
        return None;
    }
    if statuses
        .iter()
        .any(|s| matches!(s, PrCheckStatus::Failure | PrCheckStatus::Cancelled))
    {
        return Some(PrChecksState::Failing);
    }
    if statuses
        .iter()
        .any(|s| matches!(s, PrCheckStatus::Pending | PrCheckStatus::ActionRequired))
    {
        return Some(PrChecksState::Pending);
    }
    statuses
        .contains(&PrCheckStatus::Success)
        .then_some(PrChecksState::Passing)
}

// ── reactions ────────────────────────────────────────────────────────────

pub(crate) fn reaction_content(raw: &str) -> Option<PrReactionContent> {
    Some(match raw.trim().to_ascii_uppercase().as_str() {
        "THUMBS_UP" => PrReactionContent::ThumbsUp,
        "THUMBS_DOWN" => PrReactionContent::ThumbsDown,
        "LAUGH" => PrReactionContent::Laugh,
        "HOORAY" => PrReactionContent::Hooray,
        "CONFUSED" => PrReactionContent::Confused,
        "HEART" => PrReactionContent::Heart,
        "ROCKET" => PrReactionContent::Rocket,
        "EYES" => PrReactionContent::Eyes,
        _ => return None,
    })
}

pub(crate) fn github_reaction(content: PrReactionContent) -> &'static str {
    match content {
        PrReactionContent::ThumbsUp => "THUMBS_UP",
        PrReactionContent::ThumbsDown => "THUMBS_DOWN",
        PrReactionContent::Laugh => "LAUGH",
        PrReactionContent::Hooray => "HOORAY",
        PrReactionContent::Confused => "CONFUSED",
        PrReactionContent::Heart => "HEART",
        PrReactionContent::Rocket => "ROCKET",
        PrReactionContent::Eyes => "EYES",
    }
}

/// The groups GitHub answered with. GitHub answers a group per content it
/// knows, including the ones nobody chose; those are dropped.
pub(crate) fn to_reactions(groups: Option<&Value>, viewer: Option<&str>) -> Vec<PrReaction> {
    let viewer = viewer.map(str::to_ascii_lowercase);
    let Some(groups) = groups.and_then(Value::as_array) else {
        return Vec::new();
    };
    groups
        .iter()
        .filter_map(|group| {
            let content = reaction_content(group.get("content")?.as_str()?)?;
            let reactors = group.get("reactors");
            let logins: Vec<String> = nodes(reactors)
                .into_iter()
                .filter_map(|n| text(n, "login"))
                .collect();
            let total = reactors.and_then(|r| number(r, "totalCount")).unwrap_or(0) as usize;
            let count = total.max(logins.len());
            if count == 0 {
                return None;
            }
            let actors = match &viewer {
                Some(v) => logins
                    .into_iter()
                    .filter(|l| l.to_ascii_lowercase() != *v)
                    .collect(),
                None => logins,
            };
            Some(PrReaction {
                content,
                count: count as u32,
                actors,
                viewer_has_reacted: boolean(group, "viewerHasReacted").unwrap_or(false),
            })
        })
        .collect()
}

// ── repository and viewer ────────────────────────────────────────────────

/// The repository a checkout's remote names, and who is signed in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RepoContext {
    pub owner: String,
    pub name: String,
    pub host: String,
    pub viewer: Option<String>,
    /// The repository's default branch, when GitHub named one.
    pub default_branch: Option<String>,
}

impl RepoContext {
    pub fn repository(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }
}

/// A name part GitHub can address. A name holding a space could otherwise
/// end a search qualifier and start one of its own.
pub(crate) fn is_repository_part(part: &str) -> bool {
    !part.is_empty()
        && part
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

pub(crate) fn to_repo_context(data: &Value) -> Option<RepoContext> {
    let repository = data.get("repository").filter(|r| !r.is_null())?;
    let name_with_owner = text(repository, "nameWithOwner")?;
    let (owner, name) = name_with_owner.split_once('/')?;
    if !is_repository_part(owner) || !is_repository_part(name) {
        return None;
    }
    let host = text(repository, "url")
        .and_then(|u| url::Url::parse(&u).ok())
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
        .unwrap_or_else(|| "github.com".into());
    Some(RepoContext {
        owner: owner.to_string(),
        name: name.to_string(),
        host,
        viewer: trimmed(data.get("viewer").and_then(|v| v.get("login"))),
        default_branch: trimmed(
            repository
                .get("defaultBranchRef")
                .and_then(|d| d.get("name")),
        ),
    })
}

/// What GitHub can do, as a host. Fixed: GitHub offers all of it to someone;
/// whether the viewer may is [`viewer_permissions`].
pub(crate) fn capabilities() -> PrCapabilities {
    PrCapabilities {
        diff: true,
        comment: true,
        actions: vec![
            PrAction::Merge,
            PrAction::Ready,
            PrAction::Draft,
            PrAction::Close,
            PrAction::Reopen,
            PrAction::DeleteBranch,
            PrAction::UpdateBranch,
            PrAction::EnableAutoMerge,
            PrAction::DisableAutoMerge,
            PrAction::Revert,
            PrAction::ApproveWorkflows,
        ],
        merge_methods: vec![
            PrMergeMethod::Merge,
            PrMergeMethod::Squash,
            PrMergeMethod::Rebase,
        ],
        delete_branch: true,
        update_methods: vec![PrUpdateMethod::Merge, PrUpdateMethod::Rebase],
        search: true,
        reactions: true,
        viewed_files: Some(PrViewedFilesStore::Host),
        review: PrReviewCapabilities {
            inline_comment: true,
            reply: true,
            resolve: true,
            verdicts: vec![
                PrReviewVerdict::Comment,
                PrReviewVerdict::Approve,
                PrReviewVerdict::RequestChanges,
            ],
        },
        reviewers: PrReviewerCapabilities {
            request: true,
            list_candidates: true,
        },
        edit: PrEditCapabilities {
            change_request: true,
            comment: true,
        },
        labels: true,
        file_contents: true,
        conditional_reads: true,
    }
}

/// `null` is what a GitHub App installation gets, and no API says what one
/// may do — so it is granted, and GitHub refuses whatever it was not given.
pub(crate) fn to_can_write(permission: Option<&Value>) -> bool {
    match permission {
        Some(Value::Null) => true,
        other => matches!(
            trimmed(other).map(|s| s.to_ascii_uppercase()).as_deref(),
            Some("ADMIN" | "MAINTAIN" | "WRITE")
        ),
    }
}

fn to_can_triage(permission: Option<&Value>) -> bool {
    trimmed(permission).is_some_and(|p| p.eq_ignore_ascii_case("TRIAGE"))
        || to_can_write(permission)
}

/// The merge states in which a merge happens at once rather than arming
/// auto-merge.
pub(crate) fn is_immediately_mergeable(merge_state_status: Option<&str>) -> bool {
    matches!(
        merge_state_status.map(str::to_ascii_uppercase).as_deref(),
        Some("CLEAN" | "HAS_HOOKS" | "UNSTABLE")
    )
}

/// The viewer's standing on one pull request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ViewerAccess {
    pub can_write: bool,
    pub can_delete_branch: bool,
    pub can_triage: bool,
    /// A permission: unknown grants it.
    pub can_update: bool,
    /// A fact about authorship: unknown is "not the author".
    pub did_author: bool,
    pub can_update_branch: bool,
    pub can_merge_now: bool,
    pub auto_merge_allowed: bool,
    /// The pull request is merged: the only state a revert is offered in.
    pub merged: bool,
    /// Open, with its head in a fork: the only kind whose workflow runs
    /// wait on a maintainer's approval.
    pub open_from_fork: bool,
}

/// What the viewer may do. Asking for a review needs write access, which an
/// outside author does not have; an author may only comment on their own
/// change, since GitHub refuses their approval.
pub(crate) fn viewer_permissions(access: &ViewerAccess) -> PrViewerPermissions {
    let mut actions = Vec::new();
    if access.can_delete_branch {
        actions.push(PrAction::DeleteBranch);
    }
    if access.can_write {
        actions.push(PrAction::Merge);
        if access.auto_merge_allowed && !access.can_merge_now {
            actions.push(PrAction::EnableAutoMerge);
        }
        // Kept even if the repository has since turned auto-merge off.
        actions.push(PrAction::DisableAutoMerge);
    }
    if access.can_update {
        actions.extend([
            PrAction::Ready,
            PrAction::Draft,
            PrAction::Close,
            PrAction::Reopen,
        ]);
    }
    if access.can_update_branch {
        actions.push(PrAction::UpdateBranch);
    }
    // Both need push access: GitHub refuses a revert, or an approval, from
    // anyone without it.
    if access.can_write && access.merged {
        actions.push(PrAction::Revert);
    }
    if access.can_write && access.open_from_fork {
        actions.push(PrAction::ApproveWorkflows);
    }
    PrViewerPermissions {
        can_merge: actions.contains(&PrAction::Merge),
        actions,
        comment: true,
        resolve: access.can_write || access.did_author,
        verdicts: if access.did_author {
            vec![PrReviewVerdict::Comment]
        } else {
            capabilities().review.verdicts
        },
        request_reviewers: access.can_write,
        update_methods: if access.can_update_branch {
            capabilities().update_methods
        } else {
            Vec::new()
        },
        labels: access.can_triage,
        edit_change_request: access.can_update,
    }
}

// ── detail ───────────────────────────────────────────────────────────────

fn reviewer_state(state: &str) -> Option<PrReviewerState> {
    Some(match state.to_ascii_uppercase().as_str() {
        "APPROVED" => PrReviewerState::Approved,
        "CHANGES_REQUESTED" => PrReviewerState::ChangesRequested,
        "COMMENTED" => PrReviewerState::Commented,
        "DISMISSED" => PrReviewerState::Dismissed,
        "PENDING" => PrReviewerState::Pending,
        _ => return None,
    })
}

/// Whoever has been asked and not yet answered, then whoever has reviewed,
/// each once. A request outstanding after a review means they were asked
/// again, so the request wins.
fn to_reviewers(pr: &Value) -> Vec<PrReviewer> {
    let mut out: Vec<PrReviewer> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for request in nodes(pr.get("reviewRequests")) {
        let reviewer = request.get("requestedReviewer");
        let (actor, kind) = match to_actor(reviewer) {
            Some(actor) => (actor, PrReviewerKind::User),
            None => match to_requested_team(reviewer) {
                Some(team) => (team, PrReviewerKind::Team),
                None => continue,
            },
        };
        if seen.insert(actor.login.to_ascii_lowercase()) {
            out.push(PrReviewer {
                actor,
                kind,
                state: PrReviewerState::Requested,
            });
        }
    }
    for review in nodes(pr.get("latestReviews")) {
        let Some(actor) = to_actor(review.get("author")) else {
            continue;
        };
        let Some(state) = text(review, "state").and_then(|s| reviewer_state(&s)) else {
            continue;
        };
        if seen.insert(actor.login.to_ascii_lowercase()) {
            out.push(PrReviewer {
                actor,
                kind: PrReviewerKind::User,
                state,
            });
        }
    }
    out
}

/// Whether the only errors in a GraphQL answer are GitHub refusing to show
/// the requested reviewers (a team behind `read:org`). The read is then
/// repeated asking for none, rather than failing whole.
pub(crate) fn is_refused_requested_reviewers_only(errors: &[Value]) -> bool {
    !errors.is_empty()
        && errors.iter().all(|e| {
            e.get("type").and_then(Value::as_str) == Some("FORBIDDEN")
                && e.get("path").and_then(Value::as_array).is_some_and(|path| {
                    let at = |i: usize| path.get(i).and_then(Value::as_str);
                    path.len() >= 3
                        && at(0) == Some("repository")
                        && at(1) == Some("pullRequest")
                        && at(2) == Some("reviewRequests")
                })
        })
}

/// The detail read's answer. `None` for a pull request the viewer cannot see.
/// `checks_truncated` reports a rollup past the first hundred contexts, which
/// the caller then walks whole.
pub(crate) fn to_detail(data: &Value, repository: &str) -> Option<PrDetail> {
    let repo = data.get("repository").filter(|r| !r.is_null())?;
    let pr = repo.get("pullRequest").filter(|p| !p.is_null())?;
    let viewer = trimmed(data.get("viewer").and_then(|v| v.get("login")));
    let contexts_connection = nodes(pr.get("commits"))
        .first()
        .and_then(|c| c.get("commit"))
        .and_then(|c| c.get("statusCheckRollup"))
        .and_then(|r| r.get("contexts"))
        .cloned();
    let contexts = nodes(contexts_connection.as_ref());
    let state = to_state(pr);
    let latest_reviews = nodes(pr.get("latestReviews"));
    let merge_state_status = text(pr, "mergeStateStatus");
    let comparison = if state == PrState::Open {
        pr.get("baseRef")
            .and_then(|b| b.get("compare"))
            .filter(|c| !c.is_null())
            .map(|c| number(c, "behindBy").map(|n| n as u32))
    } else {
        None
    };
    let behind_by = comparison.flatten();
    let access = ViewerAccess {
        can_write: to_can_write(repo.get("viewerPermission")),
        can_delete_branch: to_can_write(
            pr.get("headRepository")
                .and_then(|h| h.get("viewerPermission")),
        ) && pr.get("headRef").is_some_and(|r| !r.is_null()),
        can_triage: to_can_triage(repo.get("viewerPermission")),
        can_update: boolean(pr, "viewerCanUpdate") != Some(false),
        did_author: boolean(pr, "viewerDidAuthor") == Some(true),
        can_update_branch: comparison.is_some()
            && boolean(pr, "viewerCanUpdateBranch") == Some(true),
        can_merge_now: is_immediately_mergeable(merge_state_status.as_deref()),
        auto_merge_allowed: boolean(repo, "autoMergeAllowed").unwrap_or(false),
        merged: state == PrState::Merged,
        open_from_fork: state == PrState::Open && boolean(pr, "isCrossRepository").unwrap_or(false),
    };
    let auto_merge = pr.get("autoMergeRequest");
    Some(PrDetail {
        capabilities: capabilities(),
        viewer_permissions: viewer_permissions(&access),
        repository: repository.to_string(),
        number: number(pr, "number").unwrap_or(0),
        title: string_or_empty(pr, "title"),
        body: string_or_empty(pr, "body"),
        url: string_or_empty(pr, "url"),
        author: to_actor(pr.get("author")),
        state,
        is_draft: boolean(pr, "isDraft").unwrap_or(false),
        mergeability: to_mergeability(pr.get("mergeable")),
        merge_state_status,
        review_decision: to_review_decision_with_reviews(pr.get("reviewDecision"), &latest_reviews),
        additions: u32_of(pr, "additions"),
        deletions: u32_of(pr, "deletions"),
        changed_files: u32_of(pr, "changedFiles"),
        commit_count: pr
            .get("totalCommits")
            .map(|c| u32_of(c, "totalCount"))
            .unwrap_or(0),
        head_branch: string_or_empty(pr, "headRefName"),
        head_repository: trimmed(
            pr.get("headRepository")
                .and_then(|h| h.get("nameWithOwner")),
        ),
        head_sha: text(pr, "headRefOid"),
        base_branch: string_or_empty(pr, "baseRefName"),
        base_sha: text(pr, "baseRefOid"),
        is_cross_repository: boolean(pr, "isCrossRepository").unwrap_or(false),
        created_at: string_or_empty(pr, "createdAt"),
        updated_at: string_or_empty(pr, "updatedAt"),
        merged_at: text(pr, "mergedAt"),
        closed_at: text(pr, "closedAt"),
        reviewers: to_reviewers(pr),
        labels: to_labels(pr.get("labels")),
        assignees: nodes(pr.get("assignees"))
            .into_iter()
            .filter_map(|a| to_actor(Some(a)))
            .collect(),
        checks: to_checks(&contexts),
        checks_state: rollup_checks_state(&contexts),
        checks_truncated: contexts_connection
            .as_ref()
            .and_then(|c| c.get("pageInfo"))
            .and_then(|p| boolean(p, "hasNextPage"))
            == Some(true),
        merge_capabilities: PrMergeCapabilities {
            merge: boolean(repo, "mergeCommitAllowed").unwrap_or(false),
            squash: boolean(repo, "squashMergeAllowed").unwrap_or(false),
            rebase: boolean(repo, "rebaseMergeAllowed").unwrap_or(false),
        },
        viewer,
        base_comparison: match comparison {
            None | Some(None) => PrBaseComparison::Unknown,
            Some(Some(0)) => PrBaseComparison::UpToDate,
            Some(Some(_)) => PrBaseComparison::Behind,
        },
        behind_by,
        auto_merge_enabled: auto_merge.map(|a| !a.is_null()),
        auto_merge_method: auto_merge.and_then(|a| to_merge_method(a.get("mergeMethod"))),
    })
}

/// One page of the full check walk: the head it read (a push mid-walk must
/// fail rather than mix two revisions' checks), its contexts and the cursor.
pub(crate) fn to_check_contexts_page(data: &Value) -> Option<(String, Vec<Value>, Option<String>)> {
    let pr = data
        .get("repository")
        .and_then(|r| r.get("pullRequest"))
        .filter(|p| !p.is_null())?;
    let head = text(pr, "headRefOid")?;
    let contexts = nodes(pr.get("commits"))
        .first()
        .and_then(|c| c.get("commit"))
        .and_then(|c| c.get("statusCheckRollup"))
        .and_then(|r| r.get("contexts"))
        .cloned();
    let list = nodes(contexts.as_ref()).into_iter().cloned().collect();
    Some((
        head,
        list,
        next_cursor(contexts.as_ref().and_then(|c| c.get("pageInfo"))),
    ))
}

// ── activity ─────────────────────────────────────────────────────────────

/// One page of the activity read.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct ActivityPage {
    pub author: Option<PrActor>,
    pub commits: Vec<PrCommit>,
    pub remarks: Vec<PrComment>,
    pub next_comments_cursor: Option<String>,
    pub next_reviews_cursor: Option<String>,
}

fn is_review_verdict(state: Option<&str>) -> bool {
    matches!(
        state.map(str::to_ascii_uppercase).as_deref(),
        Some("APPROVED" | "CHANGES_REQUESTED" | "DISMISSED")
    )
}

/// Issue comments and reviews as remarks. A review with no body is kept
/// only when its state is the event itself (an approval, a request for
/// changes, a dismissal): GitHub also opens a bodiless `COMMENTED` review as
/// the container for line comments, which arrive through the threads.
fn to_remarks(comments: &[&Value], reviews: &[&Value]) -> Vec<PrComment> {
    let mut out: Vec<PrComment> = comments
        .iter()
        .filter_map(|c| {
            Some(PrComment {
                id: text(c, "id")?,
                kind: PrCommentKind::IssueComment,
                author: to_actor(c.get("author")),
                body: string_or_empty(c, "body"),
                created_at: text(c, "createdAt")?,
                edited_at: text(c, "lastEditedAt"),
                url: text(c, "url"),
                path: None,
                review_state: None,
                reactions: Vec::new(),
                can_edit: boolean(c, "viewerCanUpdate") == Some(true),
                can_delete: boolean(c, "viewerCanDelete") == Some(true),
            })
        })
        .collect();
    out.extend(reviews.iter().filter_map(|r| {
        let submitted_at = text(r, "submittedAt")?;
        let state = text(r, "state");
        let body = string_or_empty(r, "body");
        if body.trim().is_empty() && !is_review_verdict(state.as_deref()) {
            return None;
        }
        Some(PrComment {
            id: text(r, "id")?,
            kind: PrCommentKind::Review,
            author: to_actor(r.get("author")),
            body,
            created_at: submitted_at,
            edited_at: text(r, "lastEditedAt"),
            url: text(r, "url"),
            path: None,
            review_state: state,
            reactions: Vec::new(),
            can_edit: boolean(r, "viewerCanUpdate") == Some(true),
            // A submitted review is never deleted, only dismissed.
            can_delete: false,
        })
    }));
    out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    out
}

/// One page of the activity read; `None` for a pull request the viewer
/// cannot see.
pub(crate) fn to_activity_page(data: &Value) -> Option<ActivityPage> {
    let pr = data
        .get("repository")
        .and_then(|r| r.get("pullRequest"))
        .filter(|p| !p.is_null())?;
    let commits = nodes(pr.get("commits"))
        .into_iter()
        .filter_map(|n| {
            let commit = n.get("commit")?;
            Some(PrCommit {
                oid: text(commit, "oid")?,
                message_headline: string_or_empty(commit, "messageHeadline"),
                committed_date: text(commit, "committedDate")?,
                additions: None,
                deletions: None,
                authors: nodes(commit.get("authors"))
                    .into_iter()
                    .filter_map(to_commit_actor)
                    .collect(),
            })
        })
        .collect();
    let comments = nodes(pr.get("comments"));
    let reviews = nodes(pr.get("reviews"));
    Some(ActivityPage {
        author: to_actor(pr.get("author")),
        commits,
        remarks: to_remarks(&comments, &reviews),
        next_comments_cursor: next_cursor(pr.get("comments").and_then(|c| c.get("pageInfo"))),
        next_reviews_cursor: next_cursor(pr.get("reviews").and_then(|c| c.get("pageInfo"))),
    })
}

fn to_thread_comment(raw: &Value, viewer: Option<&str>) -> Option<PrThreadComment> {
    Some(PrThreadComment {
        id: text(raw, "id")?,
        author: to_actor(raw.get("author")),
        body: string_or_empty(raw, "body"),
        created_at: text(raw, "createdAt")?,
        edited_at: text(raw, "lastEditedAt"),
        url: text(raw, "url"),
        reactions: to_reactions(raw.get("reactionGroups"), viewer),
        can_edit: boolean(raw, "viewerCanUpdate") == Some(true),
        can_delete: boolean(raw, "viewerCanDelete") == Some(true),
    })
}

/// One page of the review-thread read.
#[derive(Debug, Default)]
pub(crate) struct ThreadPage {
    pub threads: Vec<PrReviewThread>,
    pub next_cursor: Option<String>,
    pub reactions: Vec<PrReaction>,
    pub reactions_by_id: HashMap<String, Vec<PrReaction>>,
    pub edited_at_by_id: HashMap<String, String>,
    pub reviewers: Vec<PrActor>,
    pub avatars_by_login: HashMap<String, String>,
    pub bot_logins: HashSet<String>,
    pub commits: Vec<PrCommit>,
    pub dismissals_by_review_id: HashMap<String, String>,
    pub next_dismissal_cursor: Option<String>,
}

fn to_dismissals(connection: Option<&Value>) -> HashMap<String, String> {
    nodes(connection)
        .into_iter()
        .filter_map(|n| {
            let id = trimmed(n.get("review").and_then(|r| r.get("id")))?;
            Some((id, text(n, "dismissalMessage")?))
        })
        .collect()
}

pub(crate) fn to_review_dismissals_page(
    data: &Value,
) -> Option<(HashMap<String, String>, Option<String>)> {
    let items = data
        .get("repository")
        .and_then(|r| r.get("pullRequest"))
        .and_then(|p| p.get("timelineItems"))?;
    Some((
        to_dismissals(Some(items)),
        next_cursor(items.get("pageInfo")),
    ))
}

/// A review read's commit. GitHub measures a merge commit against its first
/// parent, so merging the base in reports every upstream change as the pull
/// request's: such a commit gets no stat.
fn to_graphql_commit(raw: &Value) -> Option<PrCommit> {
    let commit = raw.get("commit")?;
    let single_parent = commit
        .get("parents")
        .map(|p| number(p, "totalCount").unwrap_or(0) <= 1)
        .unwrap_or(true);
    Some(PrCommit {
        oid: text(commit, "oid")?,
        message_headline: string_or_empty(commit, "messageHeadline"),
        committed_date: text(commit, "committedDate")?,
        additions: single_parent.then(|| u32_of(commit, "additions")),
        deletions: single_parent.then(|| u32_of(commit, "deletions")),
        authors: nodes(commit.get("authors"))
            .into_iter()
            .filter_map(to_commit_actor)
            .collect(),
    })
}

/// One page of review threads; `None` for a pull request the viewer cannot
/// see.
pub(crate) fn to_review_thread_page(data: &Value) -> Option<ThreadPage> {
    let pr = data
        .get("repository")
        .and_then(|r| r.get("pullRequest"))
        .filter(|p| !p.is_null())?;
    let viewer = trimmed(data.get("viewer").and_then(|v| v.get("login")));
    let viewer = viewer.as_deref();
    let threads_connection = pr.get("reviewThreads");
    let thread_nodes = nodes(threads_connection);
    let threads = thread_nodes
        .iter()
        .filter_map(|thread| {
            let path = text(thread, "path")?;
            let id = text(thread, "id")?;
            let comments_connection = thread.get("comments");
            let comments: Vec<PrThreadComment> = nodes(comments_connection)
                .into_iter()
                .filter_map(|c| to_thread_comment(c, viewer))
                .collect();
            if comments.is_empty() {
                return None;
            }
            let is_resolved = boolean(thread, "isResolved").unwrap_or(false);
            let can_resolve = if is_resolved {
                boolean(thread, "viewerCanUnresolve")
            } else {
                boolean(thread, "viewerCanResolve")
            };
            Some(PrReviewThread {
                id,
                path,
                line: number(thread, "line").filter(|&l| l > 0).map(|l| l as u32),
                side: if text(thread, "diffSide").is_some_and(|s| s.eq_ignore_ascii_case("LEFT")) {
                    PrDiffSide::Left
                } else {
                    PrDiffSide::Right
                },
                is_resolved,
                is_outdated: boolean(thread, "isOutdated").unwrap_or(false),
                comment_count: comments_connection
                    .map(|c| u32_of(c, "totalCount"))
                    .unwrap_or(0)
                    .max(comments.len() as u32),
                comments,
                next_comments_cursor: next_cursor(
                    comments_connection.and_then(|c| c.get("pageInfo")),
                ),
                can_resolve,
            })
        })
        .collect();

    let requested: Vec<&Value> = nodes(pr.get("reviewRequests"))
        .into_iter()
        .filter_map(|n| n.get("requestedReviewer").filter(|r| !r.is_null()))
        .collect();
    let latest = nodes(pr.get("latestReviews"));
    let comments = nodes(pr.get("comments"));
    let reviews = nodes(pr.get("reviews"));

    let mut avatars_by_login = HashMap::new();
    let mut bot_logins = HashSet::new();
    let mut everyone: Vec<Option<&Value>> = vec![pr.get("author")];
    everyone.extend(comments.iter().map(|n| n.get("author")));
    everyone.extend(reviews.iter().map(|n| n.get("author")));
    everyone.extend(requested.iter().map(|r| Some(*r)));
    everyone.extend(latest.iter().map(|n| n.get("author")));
    for thread in &thread_nodes {
        everyone.extend(
            nodes(thread.get("comments"))
                .into_iter()
                .map(|c| c.get("author")),
        );
    }
    for raw in everyone.into_iter().flatten() {
        if let Some(actor) = to_actor(Some(raw)) {
            if let Some(avatar) = &actor.avatar_url {
                avatars_by_login.insert(actor.login.clone(), avatar.clone());
            }
            if actor.is_bot {
                bot_logins.insert(actor.login);
            }
        }
    }

    let mut reviewers: Vec<PrActor> = Vec::new();
    let mut seen = HashSet::new();
    for raw in requested
        .iter()
        .map(|r| Some(*r))
        .chain(latest.iter().map(|n| n.get("author")))
    {
        if let Some(actor) = to_actor(raw).or_else(|| to_requested_team(raw)) {
            if seen.insert(actor.login.clone()) {
                reviewers.push(actor);
            }
        }
    }

    let mut reactions_by_id = HashMap::new();
    let mut edited_at_by_id = HashMap::new();
    for node in comments.iter().chain(reviews.iter()) {
        let Some(id) = text(node, "id") else { continue };
        if let Some(edited) = text(node, "lastEditedAt") {
            edited_at_by_id.insert(id.clone(), edited);
        }
        let reactions = to_reactions(node.get("reactionGroups"), viewer);
        if !reactions.is_empty() {
            reactions_by_id.insert(id, reactions);
        }
    }

    Some(ThreadPage {
        threads,
        next_cursor: next_cursor(threads_connection.and_then(|c| c.get("pageInfo"))),
        reactions: to_reactions(pr.get("reactionGroups"), viewer),
        reactions_by_id,
        edited_at_by_id,
        reviewers,
        avatars_by_login,
        bot_logins,
        commits: nodes(pr.get("commits"))
            .into_iter()
            .filter_map(to_graphql_commit)
            .collect(),
        dismissals_by_review_id: to_dismissals(pr.get("reviewDismissals")),
        next_dismissal_cursor: next_cursor(
            pr.get("reviewDismissals").and_then(|d| d.get("pageInfo")),
        ),
    })
}

/// The rest of one thread's comments, and whether the thread belongs to the
/// pull request it was asked about.
pub(crate) fn to_thread_comments_page(data: &Value) -> (bool, PrThreadCommentsPage) {
    let viewer = trimmed(data.get("viewer").and_then(|v| v.get("login")));
    let thread = data
        .get("node")
        .filter(|n| n.get("__typename").and_then(Value::as_str) == Some("PullRequestReviewThread"));
    let pr_id = trimmed(
        data.get("repository")
            .and_then(|r| r.get("pullRequest"))
            .and_then(|p| p.get("id")),
    );
    let thread_pr = trimmed(
        thread
            .and_then(|t| t.get("pullRequest"))
            .and_then(|p| p.get("id")),
    );
    let belongs = pr_id.is_some() && pr_id == thread_pr;
    let comments = thread.and_then(|t| t.get("comments"));
    (
        belongs,
        PrThreadCommentsPage {
            comments: nodes(comments)
                .into_iter()
                .filter_map(|c| to_thread_comment(c, viewer.as_deref()))
                .collect(),
            next_cursor: next_cursor(comments.and_then(|c| c.get("pageInfo"))),
        },
    )
}

/// Whether HTML comments are all a body has: bot reviews often carry only a
/// marker comment, which markdown renders as nothing.
fn renders_empty(body: &str) -> bool {
    let mut rest = body;
    let mut visible = String::new();
    while let Some(start) = rest.find("<!--") {
        visible.push_str(&rest[..start]);
        match rest[start..].find("-->") {
            Some(end) => rest = &rest[start + end + 3..],
            None => {
                rest = "";
                break;
            }
        }
    }
    visible.push_str(rest);
    visible.trim().is_empty()
}

fn with_avatar(
    actor: Option<PrActor>,
    avatars: &HashMap<String, String>,
    bots: &HashSet<String>,
) -> Option<PrActor> {
    let mut actor = actor?;
    if bots.contains(&actor.login) {
        actor.is_bot = true;
    }
    if actor.avatar_url.is_none() {
        actor.avatar_url = avatars.get(&actor.login).cloned();
    }
    Some(actor)
}

/// The activity read and the review-thread walk, merged into one
/// conversation. Line comments come from the threads; a dismissed review
/// with nothing visible of its own reads its words from the dismissal event.
#[allow(clippy::too_many_arguments)]
pub(crate) fn merge_activity(
    activity_author: Option<PrActor>,
    activity_commits: Vec<PrCommit>,
    remarks: Vec<PrComment>,
    threads: Vec<PrReviewThread>,
    page: ThreadPage,
    threads_truncated: bool,
) -> PrActivity {
    let avatars = &page.avatars_by_login;
    let bots = &page.bot_logins;
    let review_comments: Vec<PrComment> = threads
        .iter()
        .flat_map(|thread| {
            thread.comments.iter().map(|c| PrComment {
                id: c.id.clone(),
                kind: PrCommentKind::ReviewComment,
                author: c.author.clone(),
                body: c.body.clone(),
                created_at: c.created_at.clone(),
                edited_at: c.edited_at.clone(),
                url: c.url.clone(),
                path: Some(thread.path.clone()),
                review_state: None,
                reactions: c.reactions.clone(),
                can_edit: c.can_edit,
                can_delete: c.can_delete,
            })
        })
        .collect();
    let thread_comment_count: u32 = threads.iter().map(|t| t.comment_count).sum();
    let remark_count = remarks.len() as u32;
    let mut comments: Vec<PrComment> = remarks
        .into_iter()
        .chain(review_comments)
        .map(|mut c| {
            if c.kind == PrCommentKind::Review
                && c.review_state
                    .as_deref()
                    .is_some_and(|s| s.eq_ignore_ascii_case("DISMISSED"))
                && renders_empty(&c.body)
            {
                if let Some(message) = page.dismissals_by_review_id.get(&c.id) {
                    c.body = message.clone();
                }
            }
            if c.reactions.is_empty() {
                if let Some(reactions) = page.reactions_by_id.get(&c.id) {
                    c.reactions = reactions.clone();
                }
            }
            if let Some(edited) = page.edited_at_by_id.get(&c.id) {
                c.edited_at = Some(edited.clone());
            }
            c.author = with_avatar(c.author, avatars, bots);
            c
        })
        .collect();
    comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    let commits = if page.commits.is_empty() {
        activity_commits
    } else {
        page.commits.clone()
    };
    let comments_truncated =
        threads_truncated || threads.iter().any(|t| t.next_comments_cursor.is_some());
    PrActivity {
        author: with_avatar(activity_author, avatars, bots),
        reviewers: page.reviewers.clone(),
        comment_count: remark_count + thread_comment_count,
        comments,
        comments_truncated,
        review_threads_truncated: threads_truncated,
        review_threads: threads
            .into_iter()
            .map(|mut t| {
                t.comments = t
                    .comments
                    .into_iter()
                    .map(|mut c| {
                        c.author = with_avatar(c.author, avatars, bots);
                        c
                    })
                    .collect();
                t
            })
            .collect(),
        commits: commits
            .into_iter()
            .map(|mut c| {
                c.authors = c
                    .authors
                    .into_iter()
                    .filter_map(|a| with_avatar(Some(a), avatars, bots))
                    .collect();
                c
            })
            .collect(),
        reactions: page.reactions.clone(),
    }
}

// ── listing ──────────────────────────────────────────────────────────────

/// The ceiling on `search`, which refuses anything larger.
pub(crate) const SEARCH_MAX_ROWS: u32 = 100;

/// Quoting is the whole defence: outside quotes GitHub reads `is:merged` as
/// a qualifier, so typed text could widen the very listing it narrows.
fn search_phrase(query: &str) -> String {
    format!("\"{}\"", query.replace('\\', "\\\\").replace('"', "\\\""))
}

/// A typed qualifier value, quoted. No label or login holds a double quote,
/// so one is dropped rather than escaped.
fn qualifier_value(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "").trim())
}

/// GitHub's search query for one repository's listing, or `None` for a
/// repository name GitHub cannot address.
pub(crate) fn search_query(repository: &str, viewer: &str, query: &PrListQuery) -> Option<String> {
    let (owner, name) = repository.split_once('/')?;
    if !is_repository_part(owner) || !is_repository_part(name) {
        return None;
    }
    let mut parts: Vec<String> = vec!["is:pr".into()];
    match query.state.unwrap_or(PrListState::Open) {
        PrListState::All => {}
        PrListState::Open => parts.push("is:open".into()),
        PrListState::Closed => {
            parts.push("is:closed".into());
            parts.push("is:unmerged".into());
        }
        PrListState::Merged => parts.push("is:merged".into()),
    }
    let viewer = viewer.trim();
    match query.involvement.unwrap_or(PrInvolvement::All) {
        PrInvolvement::All => {}
        PrInvolvement::Authored => parts.push(format!("author:{viewer}")),
        PrInvolvement::Reviewing => parts.push(format!("review-requested:{viewer}")),
        PrInvolvement::Involves => parts.push(format!("involves:{viewer}")),
    }
    if let Some(text) = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        parts.push(search_phrase(text));
    }
    if let Some(author) = query
        .author
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
    {
        let resolved = if author.eq_ignore_ascii_case("@me") || author.eq_ignore_ascii_case("me") {
            viewer
        } else {
            author
        };
        parts.push(format!("author:{}", qualifier_value(resolved)));
    }
    match query.draft.as_deref() {
        Some("only") => parts.push("draft:true".into()),
        Some("hide") => parts.push("draft:false".into()),
        _ => {}
    }
    for label in query.labels.iter().flatten() {
        if !label.trim().is_empty() {
            parts.push(format!("label:{}", qualifier_value(label)));
        }
    }
    for group in query.label_groups.iter().flatten() {
        let names: Vec<String> = group
            .iter()
            .filter(|label| !label.trim().is_empty())
            .map(|label| qualifier_value(label))
            .collect();
        if !names.is_empty() {
            parts.push(format!("label:{}", names.join(",")));
        }
    }
    for label in query.excluded_labels.iter().flatten() {
        if !label.trim().is_empty() {
            parts.push(format!("-label:{}", qualifier_value(label)));
        }
    }
    if let Some(head) = query
        .head
        .as_deref()
        .map(str::trim)
        .filter(|h| !h.is_empty())
    {
        parts.push(format!("head:{}", qualifier_value(head)));
    }
    parts.push("sort:updated-desc".into());
    parts.push(format!("repo:{owner}/{name}"));
    Some(parts.join(" "))
}

/// One listing row; `None` for a node that is not a pull request.
fn to_list_entry(node: &Value, viewer: Option<&str>) -> Option<PrListEntry> {
    let number = number(node, "number")?;
    let latest = nodes(node.get("latestReviews"));
    let mut review_logins = Vec::new();
    let mut team_request = false;
    for request in nodes(node.get("reviewRequests")) {
        let reviewer = request.get("requestedReviewer");
        if let Some(login) = trimmed(reviewer.and_then(|r| r.get("login"))) {
            review_logins.push(login);
        } else if trimmed(reviewer.and_then(|r| r.get("slug"))).is_some() {
            team_request = true;
        }
    }
    // The head commit's rollup enum, dressed as a nameless check so it is
    // read the same way the detail's checks are.
    let rollups: Vec<Value> = nodes(node.get("commits"))
        .into_iter()
        .filter_map(|c| {
            let state = trimmed(
                c.get("commit")
                    .and_then(|c| c.get("statusCheckRollup"))
                    .and_then(|r| r.get("state")),
            )?;
            Some(serde_json::json!({ "state": state }))
        })
        .collect();
    let rollup_refs: Vec<&Value> = rollups.iter().collect();
    let viewer_lower = viewer.map(str::to_ascii_lowercase);
    Some(PrListEntry {
        number,
        title: text(node, "title")?,
        url: text(node, "url")?,
        author: to_actor(node.get("author")),
        head_branch: string_or_empty(node, "headRefName"),
        base_branch: string_or_empty(node, "baseRefName"),
        state: to_state(node),
        is_draft: boolean(node, "isDraft").unwrap_or(false),
        mergeability: to_mergeability(node.get("mergeable")),
        additions: u32_of(node, "additions"),
        deletions: u32_of(node, "deletions"),
        created_at: string_or_empty(node, "createdAt"),
        updated_at: string_or_empty(node, "updatedAt"),
        merged_at: text(node, "mergedAt"),
        viewer_review_requested: team_request
            || viewer_lower
                .is_some_and(|v| review_logins.iter().any(|l| l.to_ascii_lowercase() == v)),
        labels: to_labels(node.get("labels")),
        review_decision: to_review_decision_with_reviews(node.get("reviewDecision"), &latest),
        checks_state: rollup_checks_state(&rollup_refs),
        comment_count: node
            .get("comments")
            .and_then(|c| c.get("totalCount"))
            .and_then(Value::as_u64)
            .map_or(0, |n| u32::try_from(n).unwrap_or(u32::MAX)),
        head_repository: trimmed(
            node.get("headRepository")
                .and_then(|r| r.get("nameWithOwner")),
        ),
        is_cross_repository: boolean(node, "isCrossRepository").unwrap_or(false),
    })
}

/// The rows a [`pull_requests_by_number`](super::queries::pull_requests_by_number)
/// answer holds, in the order the numbers were asked. A number the
/// repository does not have is left out.
pub(crate) fn to_entries_by_alias(
    data: &Value,
    count: usize,
    viewer: Option<&str>,
) -> Vec<PrListEntry> {
    let Some(repository) = data.get("repository") else {
        return Vec::new();
    };
    (0..count)
        .filter_map(|ix| repository.get(format!("p{ix}")))
        .filter(|node| !node.is_null())
        .filter_map(|node| to_list_entry(node, viewer))
        .collect()
}

/// A search page's rows, each read on its own: a node that is not a pull
/// request is skipped rather than blanking the page.
pub(crate) fn to_list_page(
    data: &Value,
    viewer: Option<&str>,
) -> (Vec<PrListEntry>, Option<String>) {
    let search = data.get("search");
    let rows = nodes(search)
        .into_iter()
        .filter_map(|n| to_list_entry(n, viewer))
        .collect();
    (rows, next_cursor(search.and_then(|s| s.get("pageInfo"))))
}

// ── timeline and commits ─────────────────────────────────────────────────

fn to_timeline_item(node: &Value) -> Option<PrTimelineItem> {
    let typename = node.get("__typename")?.as_str()?;
    let id = || text(node, "id");
    let actor = || to_actor(node.get("actor"));
    let at = || text(node, "createdAt");
    Some(match typename {
        "PullRequestCommit" => {
            let commit = node.get("commit")?;
            PrTimelineItem::Commit {
                id: id()?,
                oid: text(commit, "oid")?,
                message_headline: string_or_empty(commit, "messageHeadline"),
                authors: nodes(commit.get("authors"))
                    .into_iter()
                    .filter_map(to_commit_actor)
                    .collect(),
                at: text(commit, "committedDate")?,
            }
        }
        "IssueComment" => PrTimelineItem::Comment {
            id: id()?,
            actor: to_actor(node.get("author")),
            body: string_or_empty(node, "body"),
            url: text(node, "url"),
            at: at()?,
        },
        "PullRequestReview" => PrTimelineItem::Review {
            id: id()?,
            actor: to_actor(node.get("author")),
            state: text(node, "state").unwrap_or_default(),
            body: string_or_empty(node, "body"),
            url: text(node, "url"),
            at: text(node, "submittedAt").or_else(at)?,
        },
        "MergedEvent" => PrTimelineItem::Merged {
            id: id()?,
            actor: actor(),
            commit_oid: trimmed(node.get("commit").and_then(|c| c.get("oid"))),
            base_branch: text(node, "mergeRefName"),
            at: at()?,
        },
        "ClosedEvent" => PrTimelineItem::Closed {
            id: id()?,
            actor: actor(),
            at: at()?,
        },
        "ReopenedEvent" => PrTimelineItem::Reopened {
            id: id()?,
            actor: actor(),
            at: at()?,
        },
        "HeadRefForcePushedEvent" => PrTimelineItem::ForcePushed {
            id: id()?,
            actor: actor(),
            before_oid: trimmed(node.get("beforeCommit").and_then(|c| c.get("oid"))),
            after_oid: trimmed(node.get("afterCommit").and_then(|c| c.get("oid"))),
            at: at()?,
        },
        "ReadyForReviewEvent" => PrTimelineItem::ReadyForReview {
            id: id()?,
            actor: actor(),
            at: at()?,
        },
        "ConvertToDraftEvent" => PrTimelineItem::ConvertedToDraft {
            id: id()?,
            actor: actor(),
            at: at()?,
        },
        "ReviewRequestedEvent" => {
            let reviewer = node.get("requestedReviewer");
            PrTimelineItem::ReviewRequested {
                id: id()?,
                actor: actor(),
                reviewer: to_actor(reviewer).or_else(|| to_requested_team(reviewer)),
                at: at()?,
            }
        }
        "HeadRefDeletedEvent" => PrTimelineItem::HeadRefDeleted {
            id: id()?,
            actor: actor(),
            at: at()?,
        },
        // A label since deleted from the repository comes back `null`; the
        // event says nothing without it.
        "LabeledEvent" => PrTimelineItem::Labeled {
            id: id()?,
            actor: actor(),
            label: to_label(node.get("label"))?,
            at: at()?,
        },
        "UnlabeledEvent" => PrTimelineItem::Unlabeled {
            id: id()?,
            actor: actor(),
            label: to_label(node.get("label"))?,
            at: at()?,
        },
        _ => return None,
    })
}

/// One page of the timeline. The first page opens with the synthesised
/// "opened" event.
pub(crate) fn to_timeline_page(data: &Value, first_page: bool) -> Option<PrTimelinePage> {
    let pr = data
        .get("repository")
        .and_then(|r| r.get("pullRequest"))
        .filter(|p| !p.is_null())?;
    let connection = pr.get("timelineItems");
    let mut items = Vec::new();
    if first_page {
        if let Some(at) = text(pr, "createdAt") {
            items.push(PrTimelineItem::Opened {
                actor: to_actor(pr.get("author")),
                at,
            });
        }
    }
    items.extend(nodes(connection).into_iter().filter_map(to_timeline_item));
    Some(PrTimelinePage {
        items,
        next_cursor: next_cursor(connection.and_then(|c| c.get("pageInfo"))),
    })
}

pub(crate) fn to_commits_page(data: &Value) -> Option<PrCommitsPage> {
    let connection = data
        .get("repository")
        .and_then(|r| r.get("pullRequest"))
        .filter(|p| !p.is_null())?
        .get("commits");
    Some(PrCommitsPage {
        commits: nodes(connection)
            .into_iter()
            .filter_map(to_graphql_commit)
            .collect(),
        next_cursor: next_cursor(connection.and_then(|c| c.get("pageInfo"))),
    })
}

// ── files ────────────────────────────────────────────────────────────────

/// A patch header path, quoted the way git quotes one. The `a/` or `b/`
/// belongs inside the quoting: git quotes the whole token.
pub(crate) fn quote_git_patch_path(path: &str) -> String {
    let mut body = String::new();
    let mut quoting = false;
    for c in path.chars() {
        let escape = match c {
            '"' => Some("\\\""),
            '\\' => Some("\\\\"),
            '\u{7}' => Some("\\a"),
            '\u{8}' => Some("\\b"),
            '\t' => Some("\\t"),
            '\n' => Some("\\n"),
            '\u{b}' => Some("\\v"),
            '\u{c}' => Some("\\f"),
            '\r' => Some("\\r"),
            _ => None,
        };
        if let Some(escape) = escape {
            body.push_str(escape);
            quoting = true;
            continue;
        }
        let code = c as u32;
        if code < 0x20 || code == 0x7f {
            body.push_str(&format!("\\{code:03o}"));
            quoting = true;
            continue;
        }
        body.push(c);
    }
    if quoting {
        format!("\"{body}\"")
    } else {
        path.to_string()
    }
}

fn to_file_status(raw: Option<&str>) -> PrFileStatus {
    match raw.map(str::to_ascii_lowercase).as_deref() {
        Some("added") => PrFileStatus::Added,
        Some("removed") => PrFileStatus::Removed,
        Some("renamed") => PrFileStatus::Renamed,
        Some("copied") => PrFileStatus::Copied,
        Some("changed") => PrFileStatus::Changed,
        Some("unchanged") => PrFileStatus::Unchanged,
        _ => PrFileStatus::Modified,
    }
}

/// A page of the files API, as a unified patch. The API returns hunks per
/// file with no `diff --git` header, so the patch a diff viewer expects is
/// assembled here. A file with no hunks is still listed: a pure rename has
/// none to give, a binary file none that can be shown — only the second is a
/// hole in the patch.
pub(crate) struct FilesPatch {
    pub patch: String,
    pub files: Vec<PrDiffFile>,
    pub truncated: bool,
    /// Entries on the page before any were skipped, so a skipped entry
    /// cannot hide a next page.
    pub raw_count: usize,
    pub omitted: Vec<PrOmittedFileStat>,
}

pub(crate) fn to_files_patch(entries: &[Value]) -> FilesPatch {
    let mut sections = String::new();
    let mut files = Vec::new();
    let mut omitted = Vec::new();
    let mut truncated = false;
    for entry in entries {
        let Some(filename) = entry.get("filename").and_then(Value::as_str) else {
            continue;
        };
        let hunks = entry.get("patch").and_then(Value::as_str).unwrap_or("");
        let status_raw = entry.get("status").and_then(Value::as_str);
        let status = to_file_status(status_raw);
        let additions = u32_of(entry, "additions");
        let deletions = u32_of(entry, "deletions");
        if hunks.is_empty() && additions + deletions > 0 {
            truncated = true;
            omitted.push(PrOmittedFileStat {
                path: filename.to_string(),
                additions,
                deletions,
            });
        }
        let previous = entry
            .get("previous_filename")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty());
        let old_path = if status == PrFileStatus::Renamed {
            previous.unwrap_or(filename)
        } else {
            filename
        };
        let mut header = vec![format!(
            "diff --git {} {}",
            quote_git_patch_path(&format!("a/{old_path}")),
            quote_git_patch_path(&format!("b/{filename}"))
        )];
        if status == PrFileStatus::Added {
            header.push("new file mode 100644".into());
        }
        if status == PrFileStatus::Removed {
            header.push("deleted file mode 100644".into());
        }
        if status == PrFileStatus::Renamed {
            header.push(format!("rename from {}", quote_git_patch_path(old_path)));
            header.push(format!("rename to {}", quote_git_patch_path(filename)));
        }
        header.push(format!(
            "--- {}",
            if status == PrFileStatus::Added {
                "/dev/null".to_string()
            } else {
                quote_git_patch_path(&format!("a/{old_path}"))
            }
        ));
        header.push(format!(
            "+++ {}",
            if status == PrFileStatus::Removed {
                "/dev/null".to_string()
            } else {
                quote_git_patch_path(&format!("b/{filename}"))
            }
        ));
        sections.push_str(&header.join("\n"));
        sections.push('\n');
        if !hunks.is_empty() {
            sections.push_str(hunks);
            if !hunks.ends_with('\n') {
                sections.push('\n');
            }
        }
        files.push(PrDiffFile {
            path: filename.to_string(),
            previous_path: if status == PrFileStatus::Renamed {
                previous.map(str::to_string)
            } else {
                None
            },
            status,
            additions,
            deletions,
            has_patch: !hunks.is_empty(),
        });
    }
    FilesPatch {
        patch: sections,
        files,
        truncated,
        raw_count: entries.len(),
        omitted,
    }
}

fn to_file_viewed_state(raw: &str) -> PrFileViewedState {
    match raw.trim().to_ascii_uppercase().as_str() {
        "VIEWED" => PrFileViewedState::Viewed,
        "DISMISSED" => PrFileViewedState::Dismissed,
        _ => PrFileViewedState::Unviewed,
    }
}

/// One page of viewed state; empty for a pull request the host has nothing
/// to say about.
pub(crate) fn to_files_viewed_page(data: &Value) -> (Vec<PrFileViewed>, Option<String>) {
    let files = data
        .get("repository")
        .and_then(|r| r.get("pullRequest"))
        .and_then(|p| p.get("files"));
    (
        nodes(files)
            .into_iter()
            .filter_map(|n| {
                let path = n.get("path")?.as_str()?;
                (!path.is_empty()).then(|| PrFileViewed {
                    path: path.to_string(),
                    state: to_file_viewed_state(
                        n.get("viewerViewedState")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                    ),
                })
            })
            .collect(),
        next_cursor(files.and_then(|f| f.get("pageInfo"))),
    )
}

/// True when the subject named is the pull request itself, or hangs off it.
pub(crate) fn is_subject_of_pull_request(data: &Value) -> bool {
    let expected = trimmed(
        data.get("repository")
            .and_then(|r| r.get("pullRequest"))
            .and_then(|p| p.get("id")),
    );
    let Some(node) = data.get("node").filter(|n| !n.is_null()) else {
        return false;
    };
    let pr_of = |key: &str| trimmed(node.get(key).and_then(|p| p.get("id")));
    let actual = match node.get("__typename").and_then(Value::as_str) {
        Some("IssueComment") => pr_of("pullRequest"),
        Some("PullRequestReviewComment") => pr_of("reviewCommentPullRequest"),
        Some("PullRequestReview") => pr_of("reviewPullRequest"),
        Some("PullRequestReviewThread") => pr_of("threadPullRequest"),
        _ => text(node, "id"),
    };
    expected.is_some() && expected == actual
}

/// The body of `POST …/pulls/{n}/reviews`, which sends a review whole.
pub(crate) fn build_review_submission(
    verdict: PrReviewVerdict,
    body: &str,
    comments: &[PrReviewCommentDraft],
) -> Value {
    let event = match verdict {
        PrReviewVerdict::Comment => "COMMENT",
        PrReviewVerdict::Approve => "APPROVE",
        PrReviewVerdict::RequestChanges => "REQUEST_CHANGES",
    };
    let comments: Vec<Value> = comments
        .iter()
        .map(|c| {
            let (line, side) = match c.position {
                PrReviewPosition::Added { new_line } => (new_line, "RIGHT"),
                PrReviewPosition::Deleted { old_line } => (old_line, "LEFT"),
                PrReviewPosition::Context {
                    old_line,
                    new_line,
                    side,
                } => match side {
                    PrDiffSide::Left => (old_line, "LEFT"),
                    PrDiffSide::Right => (new_line, "RIGHT"),
                },
            };
            serde_json::json!({ "path": c.path, "line": line, "side": side, "body": c.body })
        })
        .collect();
    serde_json::json!({ "event": event, "body": body, "comments": comments })
}

/// The body of a review-request change: people by login, teams by slug.
pub(crate) fn build_reviewer_request(reviewers: &[PrReviewerRef]) -> Value {
    let users: Vec<&str> = reviewers
        .iter()
        .filter(|r| r.kind == PrReviewerKind::User)
        .map(|r| r.id.as_str())
        .collect();
    let teams: Vec<&str> = reviewers
        .iter()
        .filter(|r| r.kind == PrReviewerKind::Team)
        .map(|r| r.id.as_str())
        .collect();
    serde_json::json!({ "reviewers": users, "team_reviewers": teams })
}

/// The reviewer picker's rows: the people with write access (less the
/// author, whom GitHub refuses), then any team already asked. Those already
/// asked are marked, so a press takes the request back.
pub(crate) fn to_reviewer_candidates(data: &Value) -> Option<PrReviewerCandidates> {
    let repository = data.get("repository").filter(|r| !r.is_null())?;
    let pull = repository.get("pullRequest").filter(|p| !p.is_null())?;
    let author =
        trimmed(pull.get("author").and_then(|a| a.get("login"))).map(|login| login.to_lowercase());
    let mut requested_users = HashSet::new();
    let mut teams = Vec::new();
    for request in nodes(pull.get("reviewRequests")) {
        let Some(reviewer) = request.get("requestedReviewer") else {
            continue;
        };
        match reviewer.get("__typename").and_then(Value::as_str) {
            Some("Team") => {
                if let (Some(slug), Some(actor)) =
                    (text(reviewer, "slug"), to_requested_team(Some(reviewer)))
                {
                    teams.push(PrReviewerCandidate {
                        id: slug,
                        kind: PrReviewerKind::Team,
                        actor,
                        is_requested: true,
                    });
                }
            }
            _ => {
                if let Some(login) = text(reviewer, "login") {
                    requested_users.insert(login.to_lowercase());
                }
            }
        }
    }
    let users = repository.get("assignableUsers");
    let mut candidates: Vec<PrReviewerCandidate> = nodes(users)
        .into_iter()
        .filter_map(|user| {
            let actor = to_actor(Some(user))?;
            let key = actor.login.to_lowercase();
            if author.as_deref() == Some(key.as_str()) {
                return None;
            }
            Some(PrReviewerCandidate {
                id: actor.login.clone(),
                kind: PrReviewerKind::User,
                is_requested: requested_users.contains(&key),
                actor,
            })
        })
        .collect();
    // Asked first, then by login, so the picker opens on who is pending.
    candidates.sort_by(|a, b| {
        b.is_requested.cmp(&a.is_requested).then_with(|| {
            a.actor
                .login
                .to_lowercase()
                .cmp(&b.actor.login.to_lowercase())
        })
    });
    candidates.extend(teams);
    let truncated = users
        .and_then(|u| u.get("pageInfo"))
        .and_then(|p| boolean(p, "hasNextPage"))
        == Some(true);
    Some(PrReviewerCandidates {
        candidates,
        truncated,
    })
}

/// The label picker's rows, in the repository's name order, each marked when
/// the pull request carries it.
pub(crate) fn to_label_candidates(data: &Value) -> Option<PrLabelCandidates> {
    let repository = data.get("repository").filter(|r| !r.is_null())?;
    let pull = repository.get("pullRequest").filter(|p| !p.is_null())?;
    let applied: HashSet<String> = nodes(pull.get("labels"))
        .into_iter()
        .filter_map(|label| text(label, "name"))
        .collect();
    let labels = repository.get("labels");
    let candidates = nodes(labels)
        .into_iter()
        .filter_map(|label| {
            let name = text(label, "name")?;
            Some(PrLabelCandidate {
                is_applied: applied.contains(&name),
                color: text(label, "color"),
                description: text(label, "description"),
                name,
            })
        })
        .collect();
    let truncated = labels
        .and_then(|l| l.get("pageInfo"))
        .and_then(|p| boolean(p, "hasNextPage"))
        == Some(true);
    Some(PrLabelCandidates {
        candidates,
        truncated,
    })
}

/// Which file names belong to which revisions, from `GET …/pulls/{n}` (base
/// and head) or `GET …/commits/{sha}` (its first parent and itself).
pub(crate) fn to_revisions(body: &Value, commit: bool) -> (Option<String>, Option<String>) {
    if commit {
        let parent = body
            .get("parents")
            .and_then(Value::as_array)
            .and_then(|p| p.first())
            .and_then(|p| text(p, "sha"));
        (parent, text(body, "sha"))
    } else {
        (
            trimmed(body.get("base").and_then(|b| b.get("sha"))),
            trimmed(body.get("head").and_then(|h| h.get("sha"))),
        )
    }
}

/// A SHA as GitHub prints one, which is the only shape that may go into a
/// request path.
pub(crate) fn is_commit_sha(value: &str) -> bool {
    (7..=64).contains(&value.len()) && value.chars().all(|c| c.is_ascii_hexdigit())
}

/// A page cursor as this surface issues one: a page number, bounded so it
/// stays out of exponential notation.
pub(crate) fn diff_cursor_page(cursor: &str) -> Option<u32> {
    let valid = !cursor.is_empty()
        && cursor.len() <= 7
        && !cursor.starts_with('0')
        && cursor.chars().all(|c| c.is_ascii_digit());
    valid.then(|| cursor.parse().ok()).flatten()
}

/// A GraphQL node id as GitHub issues them; anything else never reaches a
/// mutation.
pub(crate) fn is_node_id(value: &str) -> bool {
    (1..=200).contains(&value.len())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '=' | '/' | '+'))
}

// ── writes' reads ────────────────────────────────────────────────────────

/// The `__typename` of the node a rewrite or delete names, read beside the
/// check that it belongs to this pull request.
pub(crate) fn subject_typename(data: &Value) -> Option<String> {
    trimmed(data.get("node").and_then(|n| n.get("__typename")))
}

/// The GraphQL type a remark of each kind is.
pub(crate) fn comment_typename(kind: PrCommentKind) -> &'static str {
    match kind {
        PrCommentKind::IssueComment => "IssueComment",
        PrCommentKind::ReviewComment => "PullRequestReviewComment",
        PrCommentKind::Review => "PullRequestReview",
    }
}

/// The pull request a revert opened.
pub(crate) fn to_reverted(data: &Value) -> Option<PrReverted> {
    let pr = data
        .get("revertPullRequest")
        .and_then(|r| r.get("revertPullRequest"))
        .filter(|p| !p.is_null())?;
    Some(PrReverted {
        number: number(pr, "number").filter(|&n| n > 0)?,
        url: text(pr, "url")?,
    })
}

/// GitHub's own merge message for a method, the head it was written for,
/// and whether a merge queue will pick its own instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MergeMessage {
    pub queued: bool,
    pub head: Option<String>,
    pub body: String,
}

pub(crate) fn to_merge_message(data: &Value) -> Option<MergeMessage> {
    let pr = data
        .get("repository")
        .and_then(|r| r.get("pullRequest"))
        .filter(|p| !p.is_null())?;
    Some(MergeMessage {
        queued: boolean(pr, "isMergeQueueEnabled") == Some(true),
        head: text(pr, "headRefOid"),
        body: string_or_empty(pr, "viewerMergeBodyText"),
    })
}

/// Where a pull request's head lives, as workflow approval checks it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkflowHead {
    pub open: bool,
    pub cross_repository: bool,
    pub branch: String,
    pub sha: Option<String>,
    pub owner: Option<String>,
}

impl WorkflowHead {
    /// The same commit, on the same branch, of the same fork.
    pub fn is_same_head(&self, other: &WorkflowHead) -> bool {
        self.cross_repository == other.cross_repository
            && self.branch == other.branch
            && self.sha.is_some()
            && self.sha == other.sha
            && match (&self.owner, &other.owner) {
                (Some(a), Some(b)) => a.eq_ignore_ascii_case(b),
                _ => false,
            }
    }
}

pub(crate) fn to_workflow_head(data: &Value) -> Option<WorkflowHead> {
    let pr = data
        .get("repository")
        .and_then(|r| r.get("pullRequest"))
        .filter(|p| !p.is_null())?;
    Some(WorkflowHead {
        open: to_state(pr) == PrState::Open,
        cross_repository: boolean(pr, "isCrossRepository") == Some(true),
        branch: string_or_empty(pr, "headRefName"),
        sha: text(pr, "headRefOid"),
        owner: trimmed(pr.get("headRepositoryOwner").and_then(|o| o.get("login"))),
    })
}

/// One open pull request whose head branch has a given name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HeadRow {
    pub number: u64,
    pub sha: Option<String>,
    pub cross_repository: bool,
    pub owner: Option<String>,
}

pub(crate) fn to_heads_page(data: &Value) -> Option<(Vec<HeadRow>, Option<String>)> {
    let connection = data
        .get("repository")
        .filter(|r| !r.is_null())?
        .get("pullRequests");
    let rows = nodes(connection)
        .into_iter()
        .filter_map(|n| {
            Some(HeadRow {
                number: number(n, "number")?,
                sha: text(n, "headRefOid"),
                cross_repository: boolean(n, "isCrossRepository") == Some(true),
                owner: trimmed(n.get("headRepositoryOwner").and_then(|o| o.get("login"))),
            })
        })
        .collect();
    Some((
        rows,
        next_cursor(connection.and_then(|c| c.get("pageInfo"))),
    ))
}

/// Whether this pull request is the one open pull request that is exactly
/// `head` (the commit, from that fork). A run names only a branch and a
/// commit, so with two such pull requests nobody can say whose run it is.
pub(crate) fn is_only_open_head(rows: &[HeadRow], number: u64, head: &WorkflowHead) -> bool {
    let exact: Vec<&HeadRow> = rows
        .iter()
        .filter(|row| {
            row.cross_repository
                && row.sha.is_some()
                && row.sha == head.sha
                && match (&row.owner, &head.owner) {
                    (Some(a), Some(b)) => a.eq_ignore_ascii_case(b),
                    _ => false,
                }
        })
        .collect();
    matches!(exact.as_slice(), [only] if only.number == number)
}

/// A workflow run waiting on a maintainer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkflowRun {
    pub id: u64,
    pub name: String,
}

/// The runs of one page of `actions/runs` that wait on approval for exactly
/// this head, and how many runs the page carried before any was dropped
/// (which says whether another page follows). A run waiting on a maintainer
/// reports `completed` with an `action_required` conclusion, or the status
/// itself; either counts.
pub(crate) fn to_action_required_runs(
    body: &Value,
    head_sha: &str,
    head_branch: &str,
) -> (Vec<WorkflowRun>, usize) {
    let raw = body
        .get("workflow_runs")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let runs = raw
        .iter()
        .filter(|run| {
            let is = |key: &str| text(run, key).is_some_and(|v| v == "action_required");
            (is("conclusion") || is("status"))
                && text(run, "head_sha").is_some_and(|s| s.eq_ignore_ascii_case(head_sha))
                && text(run, "head_branch").as_deref() == Some(head_branch)
        })
        .filter_map(|run| {
            let id = number(run, "id")?;
            Some(WorkflowRun {
                id,
                name: text(run, "name").unwrap_or_else(|| format!("Workflow run {id}")),
            })
        })
        .collect();
    (runs, raw.len())
}

#[cfg(test)]
mod tests;

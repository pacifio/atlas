//! The pull-request surface's wire types — provider-neutral on purpose.
//!
//! Nothing here names GitHub. A host driver (today only `github.rs`) reads
//! its own API and answers in these shapes; what a host can do is carried as
//! data ([`PrCapabilities`], [`PrViewerPermissions`]) rather than assumed by
//! the UI, so a second host (GitLab) slots in as a driver without the
//! frontend changing. Enum values are kebab-case, field names camelCase.
//!
//! Every type the frontend reads has a twin in
//! `src/features/pull-requests/lib/pull-requests-types.ts`;
//! `tests/wire-shape-contract.test.ts` holds the two to the same fields.

use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;

// ── errors ───────────────────────────────────────────────────────────────

/// Why a pull-request command failed, as the rejected promise's value. The
/// kinds call for different behaviour on the frontend: `notInstalled` and
/// `notAuthenticated` wait for the user, `rateLimited` waits for `retryAt`,
/// `network` retries with backoff, the rest are shown.
#[derive(Debug, Clone, PartialEq)]
pub enum PrError {
    /// `gh` is not installed.
    NotInstalled,
    /// `gh` is not signed in, or GitHub refused its credential.
    NotAuthenticated,
    /// GitHub refused for its rate limit. `retry_at` is epoch milliseconds.
    RateLimited { retry_at: Option<i64> },
    /// Offline, timed out, or GitHub answered 5xx: worth retrying.
    Network { message: String },
    /// The pull request, file or subject does not exist, or the account
    /// cannot see it.
    NotFound,
    /// The checkout is not on a host this surface can read.
    Unsupported { message: String },
    /// The caller sent something unusable (a malformed cursor, a SHA that is
    /// not one).
    Invalid { message: String },
    /// GitHub refused with a reason of its own, which `message` carries.
    Failed { message: String },
    /// A GraphQL answer with `errors`, kept whole so a caller can recognise
    /// a refusal it knows how to work around. Leaves as `failed`.
    GraphqlErrors { errors: Vec<Value> },
}

impl PrError {
    pub fn invalid(message: impl Into<String>) -> Self {
        PrError::Invalid {
            message: message.into(),
        }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        PrError::Failed {
            message: message.into(),
        }
    }

    fn graphql_message(errors: &[Value]) -> String {
        let messages: Vec<&str> = errors
            .iter()
            .filter_map(|e| e.get("message").and_then(Value::as_str))
            .collect();
        if messages.is_empty() {
            "GitHub returned an error.".into()
        } else {
            format!("GitHub returned an error: {}", messages.join("; "))
        }
    }
}

impl Serialize for PrError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let (kind, message, retry_at): (&str, Option<String>, Option<Option<i64>>) = match self {
            PrError::NotInstalled => ("notInstalled", None, None),
            PrError::NotAuthenticated => ("notAuthenticated", None, None),
            PrError::RateLimited { retry_at } => ("rateLimited", None, Some(*retry_at)),
            PrError::Network { message } => ("network", Some(message.clone()), None),
            PrError::NotFound => ("notFound", None, None),
            PrError::Unsupported { message } => ("unsupported", Some(message.clone()), None),
            PrError::Invalid { message } => ("invalid", Some(message.clone()), None),
            PrError::Failed { message } => ("failed", Some(message.clone()), None),
            PrError::GraphqlErrors { errors } => {
                ("failed", Some(PrError::graphql_message(errors)), None)
            }
        };
        let len = 1 + usize::from(message.is_some()) + usize::from(retry_at.is_some());
        let mut s = serializer.serialize_struct("PrError", len)?;
        s.serialize_field("kind", kind)?;
        if let Some(message) = message {
            s.serialize_field("message", &message)?;
        }
        if let Some(retry_at) = retry_at {
            s.serialize_field("retryAt", &retry_at)?;
        }
        s.end()
    }
}

// ── shared values ────────────────────────────────────────────────────────

/// What a pull request is now. A draft is `open` with `isDraft`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrState {
    Open,
    Closed,
    Merged,
}

/// Which pull requests a listing shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrListState {
    All,
    Open,
    Closed,
    Merged,
}

/// Whose pull requests a listing shows, relative to the signed-in account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrInvolvement {
    All,
    Authored,
    Reviewing,
    Involves,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrReviewDecision {
    Approved,
    ChangesRequested,
    ReviewRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrChecksState {
    Passing,
    Failing,
    Pending,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrMergeability {
    Mergeable,
    Conflicting,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrMergeMethod {
    Merge,
    Squash,
    Rebase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrUpdateMethod {
    Merge,
    Rebase,
}

/// Something a pull request can be asked to do, beyond a comment or review.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrAction {
    Merge,
    Ready,
    Draft,
    Close,
    Reopen,
    DeleteBranch,
    UpdateBranch,
    EnableAutoMerge,
    DisableAutoMerge,
    /// Open a new pull request that undoes a merged one.
    Revert,
    /// Let workflow runs a fork's push is holding for a maintainer go ahead.
    ApproveWorkflows,
}

/// Whether the head is behind its base.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrBaseComparison {
    UpToDate,
    Behind,
    Unknown,
}

/// A person, an app, or a team. A team goes by `org/slug`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrActor {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub is_bot: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrLabel {
    pub name: String,
    /// Hex without the `#`, as GitHub stores it.
    pub color: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrCheckStatus {
    Pending,
    ActionRequired,
    Success,
    Failure,
    Skipped,
    Neutral,
    Cancelled,
}

/// One check or commit status on the head commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCheck {
    pub name: String,
    pub status: PrCheckStatus,
    pub description: Option<String>,
    pub url: Option<String>,
    /// Absent where the host does not say.
    pub required: Option<bool>,
    pub workflow: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    /// From start to completion, once both are known.
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrReactionContent {
    ThumbsUp,
    ThumbsDown,
    Laugh,
    Hooray,
    Confused,
    Heart,
    Rocket,
    Eyes,
}

/// One reaction group. The viewer's own login is left out of `actors` (the
/// UI says "You"), but `count` counts them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReaction {
    pub content: PrReactionContent,
    pub count: u32,
    pub actors: Vec<String>,
    pub viewer_has_reacted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrCommentKind {
    IssueComment,
    ReviewComment,
    Review,
}

/// A remark in the conversation: a comment, a review's words, or a line
/// comment (with its `path`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrComment {
    pub id: String,
    pub kind: PrCommentKind,
    pub author: Option<PrActor>,
    pub body: String,
    pub created_at: String,
    pub edited_at: Option<String>,
    pub url: Option<String>,
    pub path: Option<String>,
    /// A review's state (`APPROVED`, `CHANGES_REQUESTED`, …) as the host
    /// names it; null on anything that is not a review.
    pub review_state: Option<String>,
    pub reactions: Vec<PrReaction>,
    /// The signed-in account may rewrite it (the host's own word, per
    /// remark; false where the host does not say).
    #[serde(default)]
    pub can_edit: bool,
    /// The signed-in account may delete it. Never true for a review's own
    /// summary, which no host deletes once submitted.
    #[serde(default)]
    pub can_delete: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrDiffSide {
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrReviewVerdict {
    Comment,
    Approve,
    RequestChanges,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrThreadComment {
    pub id: String,
    pub author: Option<PrActor>,
    pub body: String,
    pub created_at: String,
    pub edited_at: Option<String>,
    pub url: Option<String>,
    pub reactions: Vec<PrReaction>,
    #[serde(default)]
    pub can_edit: bool,
    #[serde(default)]
    pub can_delete: bool,
}

/// A conversation pinned to a line of the diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewThread {
    pub id: String,
    pub path: String,
    /// Null once the line has left the diff (the thread is outdated).
    pub line: Option<u32>,
    pub side: PrDiffSide,
    pub is_resolved: bool,
    pub is_outdated: bool,
    pub comments: Vec<PrThreadComment>,
    pub comment_count: u32,
    /// Where `pr_thread_comments` carries on, for a thread longer than the
    /// comments that rode along.
    pub next_comments_cursor: Option<String>,
    /// Narrows the viewer's repository-wide `resolve` permission; never
    /// widens it. Null where the host does not say per thread.
    pub can_resolve: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrReviewerKind {
    User,
    Team,
}

/// Where a reviewer stands: asked and not yet answered, or their latest
/// review's verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrReviewerState {
    Requested,
    Approved,
    ChangesRequested,
    Commented,
    Dismissed,
    Pending,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewer {
    pub actor: PrActor,
    pub kind: PrReviewerKind,
    pub state: PrReviewerState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCommit {
    pub oid: String,
    pub message_headline: String,
    pub committed_date: String,
    /// Null for a merge commit, whose host stat is measured against its
    /// first parent and so counts the base's changes as its own.
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub authors: Vec<PrActor>,
}

// ── capabilities and permissions ─────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewCapabilities {
    pub inline_comment: bool,
    pub reply: bool,
    pub resolve: bool,
    pub verdicts: Vec<PrReviewVerdict>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewerCapabilities {
    pub request: bool,
    pub list_candidates: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrEditCapabilities {
    pub change_request: bool,
    pub comment: bool,
}

/// Where a host keeps "viewed" marks on files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrViewedFilesStore {
    /// On the host, per account (GitHub).
    Host,
    /// Nowhere the host knows of; the client keeps them.
    Environment,
}

/// What a host can do at all. A host that says nothing about something
/// offers nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCapabilities {
    pub diff: bool,
    pub comment: bool,
    pub actions: Vec<PrAction>,
    pub merge_methods: Vec<PrMergeMethod>,
    pub delete_branch: bool,
    pub update_methods: Vec<PrUpdateMethod>,
    pub search: bool,
    pub reactions: bool,
    pub viewed_files: Option<PrViewedFilesStore>,
    pub review: PrReviewCapabilities,
    pub reviewers: PrReviewerCapabilities,
    pub edit: PrEditCapabilities,
    pub labels: bool,
    /// Whether full file contents can be read at the base and head, to
    /// expand a diff's collapsed context.
    pub file_contents: bool,
    /// Whether unchanged reads are revalidated rather than re-sent.
    pub conditional_reads: bool,
}

/// What the signed-in account may do to this pull request. A permission the
/// host reports nothing about is granted, and the host's own refusal
/// explains anything that then fails.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrViewerPermissions {
    pub actions: Vec<PrAction>,
    pub comment: bool,
    pub resolve: bool,
    pub verdicts: Vec<PrReviewVerdict>,
    pub request_reviewers: bool,
    pub update_methods: Vec<PrUpdateMethod>,
    pub labels: bool,
    pub edit_change_request: bool,
    /// `actions` contains `merge`.
    pub can_merge: bool,
}

/// Which merge methods the repository allows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrMergeCapabilities {
    pub merge: bool,
    pub squash: bool,
    pub rebase: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrProviderKind {
    Github,
}

/// The host a checkout's pull requests live on, and what it can do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrProvider {
    pub kind: PrProviderKind,
    pub host: String,
    /// `owner/name`.
    pub repository: String,
    pub viewer: Option<String>,
    pub capabilities: PrCapabilities,
}

// ── reads ────────────────────────────────────────────────────────────────

/// A listing's filters. Every field may be left out.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PrListQuery {
    pub state: Option<PrListState>,
    pub involvement: Option<PrInvolvement>,
    /// Free text, searched as a phrase (never as qualifiers).
    pub search: Option<String>,
    /// An author's login; `@me` is the signed-in account.
    pub author: Option<String>,
    /// `only` or `hide` drafts.
    pub draft: Option<String>,
    pub labels: Option<Vec<String>>,
    /// Label groups: a pull request carries at least one label of every
    /// group (`label:a,b` typed in the search).
    pub label_groups: Option<Vec<Vec<String>>>,
    /// Labels a pull request must not carry (`-label:x`).
    pub excluded_labels: Option<Vec<String>>,
    /// Only pull requests whose head is this branch (the session context
    /// overlay's "this branch's pull requests").
    pub head: Option<String>,
    pub cursor: Option<String>,
    /// Rows per page, 1–100.
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrListEntry {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub author: Option<PrActor>,
    pub head_branch: String,
    pub base_branch: String,
    pub state: PrState,
    pub is_draft: bool,
    pub mergeability: PrMergeability,
    pub additions: u32,
    pub deletions: u32,
    pub created_at: String,
    pub updated_at: String,
    /// When it merged; `None` while it is not merged. A session's link
    /// snapshot dates the merge by it.
    #[serde(default)]
    pub merged_at: Option<String>,
    pub viewer_review_requested: bool,
    pub labels: Vec<PrLabel>,
    pub review_decision: Option<PrReviewDecision>,
    pub checks_state: Option<PrChecksState>,
    /// Conversation comments, the count the list row shows. Line comments
    /// inside review threads are not among them.
    #[serde(default)]
    pub comment_count: u32,
    /// `owner/name` of the repository the head branch lives in; `None` when
    /// that repository is gone (a deleted fork). The branch sweep reads it to
    /// keep a fork's same-named branch from linking.
    #[serde(default)]
    pub head_repository: Option<String>,
    /// The head branch lives in another repository than the base.
    #[serde(default)]
    pub is_cross_repository: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrListResult {
    pub provider: PrProvider,
    pub entries: Vec<PrListEntry>,
    pub next_cursor: Option<String>,
}

/// One pull request's state, standing and checks. The conversation is
/// [`PrActivity`], read separately so each can refresh on its own clock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDetail {
    pub capabilities: PrCapabilities,
    pub viewer_permissions: PrViewerPermissions,
    pub repository: String,
    pub number: u64,
    pub title: String,
    pub body: String,
    pub url: String,
    pub author: Option<PrActor>,
    pub state: PrState,
    pub is_draft: bool,
    pub mergeability: PrMergeability,
    /// The host's finer merge status (`CLEAN`, `BLOCKED`, `BEHIND`,
    /// `DIRTY`, `UNSTABLE`, …), uppercase as it names it.
    pub merge_state_status: Option<String>,
    pub review_decision: Option<PrReviewDecision>,
    pub additions: u32,
    pub deletions: u32,
    pub changed_files: u32,
    pub commit_count: u32,
    pub head_branch: String,
    pub head_repository: Option<String>,
    pub head_sha: Option<String>,
    pub base_branch: String,
    pub base_sha: Option<String>,
    pub is_cross_repository: bool,
    pub created_at: String,
    pub updated_at: String,
    pub merged_at: Option<String>,
    pub closed_at: Option<String>,
    pub reviewers: Vec<PrReviewer>,
    pub labels: Vec<PrLabel>,
    pub assignees: Vec<PrActor>,
    pub checks: Vec<PrCheck>,
    pub checks_state: Option<PrChecksState>,
    /// More checks exist than were read.
    pub checks_truncated: bool,
    pub merge_capabilities: PrMergeCapabilities,
    pub viewer: Option<String>,
    pub base_comparison: PrBaseComparison,
    pub behind_by: Option<u32>,
    /// Null where the host does not report it, which is not "off".
    pub auto_merge_enabled: Option<bool>,
    pub auto_merge_method: Option<PrMergeMethod>,
}

/// The conversation: comments, reviews, line comments in their threads,
/// commits and the pull request's own reactions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrActivity {
    pub author: Option<PrActor>,
    pub reviewers: Vec<PrActor>,
    /// Comments, reviews and line comments, oldest first.
    pub comments: Vec<PrComment>,
    pub comment_count: u32,
    pub comments_truncated: bool,
    pub review_threads_truncated: bool,
    pub review_threads: Vec<PrReviewThread>,
    pub commits: Vec<PrCommit>,
    pub reactions: Vec<PrReaction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrThreadCommentsPage {
    pub comments: Vec<PrThreadComment>,
    pub next_cursor: Option<String>,
}

/// One event in a pull request's history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PrTimelineItem {
    /// Synthesised from the pull request's own author and creation time;
    /// first on the first page only.
    #[serde(rename_all = "camelCase")]
    Opened { actor: Option<PrActor>, at: String },
    #[serde(rename_all = "camelCase")]
    Commit {
        id: String,
        oid: String,
        message_headline: String,
        authors: Vec<PrActor>,
        at: String,
    },
    #[serde(rename_all = "camelCase")]
    Comment {
        id: String,
        actor: Option<PrActor>,
        body: String,
        url: Option<String>,
        at: String,
    },
    #[serde(rename_all = "camelCase")]
    Review {
        id: String,
        actor: Option<PrActor>,
        state: String,
        body: String,
        url: Option<String>,
        at: String,
    },
    #[serde(rename_all = "camelCase")]
    Merged {
        id: String,
        actor: Option<PrActor>,
        commit_oid: Option<String>,
        base_branch: Option<String>,
        at: String,
    },
    #[serde(rename_all = "camelCase")]
    Closed {
        id: String,
        actor: Option<PrActor>,
        at: String,
    },
    #[serde(rename_all = "camelCase")]
    Reopened {
        id: String,
        actor: Option<PrActor>,
        at: String,
    },
    #[serde(rename_all = "camelCase")]
    ForcePushed {
        id: String,
        actor: Option<PrActor>,
        before_oid: Option<String>,
        after_oid: Option<String>,
        at: String,
    },
    #[serde(rename_all = "camelCase")]
    ReadyForReview {
        id: String,
        actor: Option<PrActor>,
        at: String,
    },
    #[serde(rename_all = "camelCase")]
    ConvertedToDraft {
        id: String,
        actor: Option<PrActor>,
        at: String,
    },
    #[serde(rename_all = "camelCase")]
    ReviewRequested {
        id: String,
        actor: Option<PrActor>,
        reviewer: Option<PrActor>,
        at: String,
    },
    #[serde(rename_all = "camelCase")]
    HeadRefDeleted {
        id: String,
        actor: Option<PrActor>,
        at: String,
    },
    #[serde(rename_all = "camelCase")]
    Labeled {
        id: String,
        actor: Option<PrActor>,
        label: PrLabel,
        at: String,
    },
    #[serde(rename_all = "camelCase")]
    Unlabeled {
        id: String,
        actor: Option<PrActor>,
        label: PrLabel,
        at: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrTimelinePage {
    pub items: Vec<PrTimelineItem>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCommitsPage {
    pub commits: Vec<PrCommit>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrFileStatus {
    Added,
    Removed,
    Modified,
    Renamed,
    Copied,
    Changed,
    Unchanged,
}

/// One changed file of a diff page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDiffFile {
    pub path: String,
    pub previous_path: Option<String>,
    pub status: PrFileStatus,
    pub additions: u32,
    pub deletions: u32,
    /// False for a binary file or a hunk the host declined to inline.
    pub has_patch: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrOmittedFileStat {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
}

/// A slice of a diff: a large change is more than any host hands over at
/// once (GitHub refuses past 300 files) and more than a viewer can lay out
/// in one go.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDiffResult {
    /// A unified patch with `diff --git` headers, ready for a diff viewer.
    pub patch: String,
    pub files: Vec<PrDiffFile>,
    /// Something in this slice could not be shown (a binary file, an
    /// oversized hunk). Not the same as there being more slices.
    pub truncated: bool,
    pub next_cursor: Option<String>,
    pub omitted_file_stats: Vec<PrOmittedFileStat>,
}

/// How a file changed, which says which sides exist to read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrFileChangeType {
    Change,
    RenamePure,
    RenameChanged,
    New,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDiffFileContents {
    pub old_contents: String,
    pub new_contents: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrFileViewedState {
    Unviewed,
    Viewed,
    Dismissed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrFileViewed {
    pub path: String,
    pub state: PrFileViewedState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrFilesViewed {
    /// Only the files the host reported a state for; a missing file is
    /// unviewed.
    pub files: Vec<PrFileViewed>,
    pub truncated: bool,
}

/// Someone who may be asked to review: a person by login, or a team by slug
/// (`id`, what a request names). `actor` is how the row reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewerCandidate {
    pub id: String,
    pub kind: PrReviewerKind,
    pub actor: PrActor,
    /// Asked already, and not yet answered.
    pub is_requested: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewerCandidates {
    pub candidates: Vec<PrReviewerCandidate>,
    /// The repository has more people with access than were listed.
    pub truncated: bool,
}

/// A label the repository defines, and whether this pull request carries it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrLabelCandidate {
    pub name: String,
    /// Hex without the `#`, as GitHub stores it.
    pub color: Option<String>,
    pub description: Option<String>,
    pub is_applied: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrLabelCandidates {
    pub candidates: Vec<PrLabelCandidate>,
    /// The repository has more labels than were listed.
    pub truncated: bool,
}

/// An image from a pull request's body or comments, fetched through the
/// host's credential. `data` is base64.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrImage {
    pub content_type: String,
    pub data: String,
}

// ── writes ───────────────────────────────────────────────────────────────

/// One file's viewed mark to set or clear.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrFileViewedChange {
    pub path: String,
    pub viewed: bool,
}

/// Where a line comment goes, in terms of the diff's two sides.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PrReviewPosition {
    #[serde(rename_all = "camelCase")]
    Added { new_line: u32 },
    #[serde(rename_all = "camelCase")]
    Deleted { old_line: u32 },
    #[serde(rename_all = "camelCase")]
    Context {
        old_line: u32,
        new_line: u32,
        side: PrDiffSide,
    },
}

/// A line comment held by the client until its review is submitted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewCommentDraft {
    pub path: String,
    pub position: PrReviewPosition,
    pub body: String,
}

/// A reviewer to request or withdraw: a login, or a team's slug.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewerRef {
    pub id: String,
    pub kind: PrReviewerKind,
}

/// A pull-request action with its options.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrActionInput {
    pub action: PrAction,
    #[serde(default)]
    pub merge_method: Option<PrMergeMethod>,
    #[serde(default)]
    pub update_method: Option<PrUpdateMethod>,
    /// For a merge or auto-merge: the head commit the reader was looking at.
    /// A head that moved since is refused rather than merged unseen.
    #[serde(default)]
    pub expected_head_oid: Option<String>,
    /// For a merge or auto-merge: take agent co-author trailers and
    /// "Generated with" footers out of the merge commit's message. Off
    /// unless asked for; a rebase has no message of its own to rewrite.
    #[serde(default)]
    pub remove_agent_credits: bool,
}

/// The pull request a revert opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReverted {
    pub number: u64,
    pub url: String,
}

/// The end of one check's log, read on demand: the lines around its last
/// error (or its last lines, when nothing is marked as one), with
/// timestamps and terminal colour codes taken out. It is a third party's
/// output, so whoever passes it on (a Fix handoff) marks it untrusted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCheckLog {
    /// The host's id for the job the log belongs to.
    pub job_id: String,
    pub text: String,
    /// Lines before (or after) the window were left out.
    pub truncated: bool,
    /// The window is anchored on a line the runner marked as an error.
    pub found_error: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_are_tagged_by_kind_with_camel_case_fields() {
        assert_eq!(
            serde_json::to_value(PrError::NotInstalled).unwrap(),
            serde_json::json!({ "kind": "notInstalled" })
        );
        assert_eq!(
            serde_json::to_value(PrError::RateLimited { retry_at: Some(5) }).unwrap(),
            serde_json::json!({ "kind": "rateLimited", "retryAt": 5 })
        );
        assert_eq!(
            serde_json::to_value(PrError::RateLimited { retry_at: None }).unwrap(),
            serde_json::json!({ "kind": "rateLimited", "retryAt": null })
        );
        assert_eq!(
            serde_json::to_value(PrError::Network {
                message: "offline".into()
            })
            .unwrap(),
            serde_json::json!({ "kind": "network", "message": "offline" })
        );
    }

    #[test]
    fn graphql_errors_leave_as_failed_with_their_messages() {
        let error = PrError::GraphqlErrors {
            errors: vec![
                serde_json::json!({"type":"FORBIDDEN","message":"Resource not accessible"}),
                serde_json::json!({"message":"Second"}),
            ],
        };
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            serde_json::json!({
                "kind": "failed",
                "message": "GitHub returned an error: Resource not accessible; Second"
            })
        );
    }

    #[test]
    fn enum_values_are_kebab_case() {
        assert_eq!(
            serde_json::to_value(PrAction::EnableAutoMerge).unwrap(),
            "enable-auto-merge"
        );
        assert_eq!(
            serde_json::to_value(PrReactionContent::ThumbsUp).unwrap(),
            "thumbs-up"
        );
        assert_eq!(
            serde_json::to_value(PrReviewDecision::ChangesRequested).unwrap(),
            "changes-requested"
        );
        assert_eq!(
            serde_json::to_value(PrProviderKind::Github).unwrap(),
            "github"
        );
    }

    #[test]
    fn a_review_position_is_tagged_by_kind() {
        let position: PrReviewPosition = serde_json::from_value(
            serde_json::json!({ "kind": "context", "oldLine": 3, "newLine": 4, "side": "left" }),
        )
        .unwrap();
        assert_eq!(
            position,
            PrReviewPosition::Context {
                old_line: 3,
                new_line: 4,
                side: PrDiffSide::Left
            }
        );
    }

    #[test]
    fn a_timeline_item_is_tagged_by_kind() {
        let item = PrTimelineItem::ForcePushed {
            id: "e".into(),
            actor: None,
            before_oid: Some("a".into()),
            after_oid: Some("b".into()),
            at: "t".into(),
        };
        assert_eq!(
            serde_json::to_value(item).unwrap(),
            serde_json::json!({
                "kind": "force-pushed", "id": "e", "actor": null,
                "beforeOid": "a", "afterOid": "b", "at": "t"
            })
        );
        let label = PrTimelineItem::Unlabeled {
            id: "e".into(),
            actor: None,
            label: PrLabel {
                name: "bug".into(),
                color: Some("d73a4a".into()),
            },
            at: "t".into(),
        };
        assert_eq!(
            serde_json::to_value(label).unwrap(),
            serde_json::json!({
                "kind": "unlabeled", "id": "e", "actor": null,
                "label": { "name": "bug", "color": "d73a4a" }, "at": "t"
            })
        );
    }
}

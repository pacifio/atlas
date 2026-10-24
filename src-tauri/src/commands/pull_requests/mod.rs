//! The pull-request surface: list, read, review and act on a checkout's pull
//! requests, through the user's own `gh` login.
//!
//! Layers, top to bottom:
//!
//! - this module — the IPC commands, flat arguments, one per operation;
//! - [`host`] — the provider seam: the host a checkout's remote names,
//!   which every command opens and calls;
//! - [`github`] — the GitHub driver: which requests an operation takes;
//! - [`parse`] / [`queries`] — GitHub's answers read into [`model`], and the
//!   GraphQL documents that ask for them;
//! - [`gh`] — the transport: one bounded `gh api -i` process per request,
//!   with rate-limit, conditional-read and concurrency policy;
//! - [`images`] — the image proxy for bodies and comments;
//! - [`check_log`] — which job a check names, and the part of its log
//!   worth reading;
//! - [`merge_message`] — a merge message with the agents' credits taken out;
//! - [`create`] — opening a pull request with `gh pr create`;
//! - [`checkout`] — the pull request's head checked out for a "Fix" session,
//!   never by switching the main checkout;
//! - [`guide`] — the Guide tab's read-only head checkout, the change it is
//!   measured against, and the guide kept per pull request.
//!
//! Every command answers `Result<T, PrError>`; [`PrError`] serializes as
//! `{ kind, message?, retryAt? }` so the frontend can tell "install gh" from
//! "sign in" from "wait until" from "try again". Nothing here logs a
//! repository, title, branch or URL.

mod check_log;
pub mod checkout;
pub mod create;
mod gh;
mod github;
pub mod guide;
mod host;
mod images;
pub mod list_stats;
mod merge_message;
mod model;
mod parse;
mod queries;

pub use model::*;

/// The driver, for the session links' sweep (`session_pull_requests`), which
/// reads pull requests by number and by branch outside any one command.
pub(crate) use gh::quota_paused_until;
pub(crate) use github::{GitHub, ReadPolicy};

fn checkout(path: &str) -> Result<&str, PrError> {
    let path = path.trim();
    if path.is_empty() {
        return Err(PrError::invalid("No checkout was named."));
    }
    Ok(path)
}

fn pull_number(number: u64) -> Result<u64, PrError> {
    if number == 0 || number > u64::from(u32::MAX) {
        return Err(PrError::invalid("That is not a pull request number."));
    }
    Ok(number)
}

/// The host a checkout's pull requests live on: the seam every command
/// goes through ([`host::PrHost`]).
async fn open(path: &str) -> Result<host::PrHost, PrError> {
    host::PrHost::open(checkout(path)?).await
}

/// A node id the client names (a comment, a review), checked for shape
/// before it reaches the host.
fn node_id(id: &str) -> Result<&str, PrError> {
    let id = id.trim();
    if !parse::is_node_id(id) {
        return Err(PrError::invalid("That is not a comment or review id."));
    }
    Ok(id)
}

// ── reads ────────────────────────────────────────────────────────────────

/// The host behind a checkout's remote, its repository, who is signed in, and
/// what the host can do. `refresh` forgets the remembered answer first.
#[tauri::command]
pub async fn pr_provider(path: String, refresh: Option<bool>) -> Result<PrProvider, PrError> {
    if refresh == Some(true) {
        github::forget_repo_context(checkout(&path)?);
    }
    Ok(open(&path).await?.provider())
}

/// One page of the checkout's pull requests, newest activity first.
#[tauri::command]
pub async fn pr_list(path: String, query: Option<PrListQuery>) -> Result<PrListResult, PrError> {
    open(&path).await?.list(&query.unwrap_or_default()).await
}

/// One pull request, with its checks, reviewers and what the viewer may do.
#[tauri::command]
pub async fn pr_detail(path: String, number: u64) -> Result<PrDetail, PrError> {
    open(&path).await?.detail(pull_number(number)?).await
}

/// The conversation: comments, reviews, review threads, commits.
#[tauri::command]
pub async fn pr_activity(path: String, number: u64) -> Result<PrActivity, PrError> {
    open(&path).await?.activity(pull_number(number)?).await
}

/// The rest of one review thread's comments, past the ten the activity read
/// carries.
#[tauri::command]
pub async fn pr_thread_comments(
    path: String,
    number: u64,
    thread_id: String,
    cursor: Option<String>,
) -> Result<PrThreadCommentsPage, PrError> {
    open(&path)
        .await?
        .thread_comments(pull_number(number)?, &thread_id, cursor)
        .await
}

/// One page of the pull request's history.
#[tauri::command]
pub async fn pr_timeline(
    path: String,
    number: u64,
    cursor: Option<String>,
) -> Result<PrTimelinePage, PrError> {
    open(&path)
        .await?
        .timeline(pull_number(number)?, cursor)
        .await
}

/// One page of the pull request's commits, oldest first.
#[tauri::command]
pub async fn pr_commits(
    path: String,
    number: u64,
    cursor: Option<String>,
) -> Result<PrCommitsPage, PrError> {
    open(&path)
        .await?
        .commits(pull_number(number)?, cursor)
        .await
}

/// The patch of the pull request (or of one of its commits), whole or a page
/// of files at a time.
#[tauri::command]
pub async fn pr_diff(
    path: String,
    number: u64,
    cursor: Option<String>,
    commit: Option<String>,
) -> Result<PrDiffResult, PrError> {
    open(&path)
        .await?
        .diff(pull_number(number)?, cursor, commit)
        .await
}

/// Both sides of one changed file, for a diff shown in full.
#[tauri::command]
pub async fn pr_diff_file_contents(
    path: String,
    number: u64,
    commit: Option<String>,
    change_type: PrFileChangeType,
    old_path: String,
    new_path: String,
) -> Result<PrDiffFileContents, PrError> {
    open(&path)
        .await?
        .diff_file_contents(
            pull_number(number)?,
            commit,
            change_type,
            &old_path,
            &new_path,
        )
        .await
}

/// Which files the signed-in account has marked viewed.
#[tauri::command]
pub async fn pr_files_viewed(path: String, number: u64) -> Result<PrFilesViewed, PrError> {
    open(&path).await?.files_viewed(pull_number(number)?).await
}

/// The people and teams the reviewer picker offers, those already asked
/// marked.
#[tauri::command]
pub async fn pr_reviewer_candidates(
    path: String,
    number: u64,
) -> Result<PrReviewerCandidates, PrError> {
    open(&path)
        .await?
        .reviewer_candidates(pull_number(number)?)
        .await
}

/// The repository's labels, those on this pull request marked.
#[tauri::command]
pub async fn pr_label_candidates(path: String, number: u64) -> Result<PrLabelCandidates, PrError> {
    open(&path)
        .await?
        .label_candidates(pull_number(number)?)
        .await
}

// ── writes ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn pr_set_files_viewed(
    path: String,
    number: u64,
    files: Vec<PrFileViewedChange>,
) -> Result<(), PrError> {
    open(&path)
        .await?
        .set_files_viewed(pull_number(number)?, &files)
        .await
}

#[tauri::command]
pub async fn pr_comment(path: String, number: u64, body: String) -> Result<(), PrError> {
    open(&path)
        .await?
        .comment(pull_number(number)?, &body)
        .await
}

#[tauri::command]
pub async fn pr_reply_to_thread(
    path: String,
    number: u64,
    thread_id: String,
    body: String,
) -> Result<(), PrError> {
    pull_number(number)?;
    open(&path).await?.reply_to_thread(&thread_id, &body).await
}

#[tauri::command]
pub async fn pr_resolve_thread(
    path: String,
    number: u64,
    thread_id: String,
    resolved: bool,
) -> Result<(), PrError> {
    pull_number(number)?;
    open(&path)
        .await?
        .resolve_thread(&thread_id, resolved)
        .await
}

/// Add or remove a reaction on the pull request (no `subjectId`) or on one of
/// its comments or reviews.
#[tauri::command]
pub async fn pr_react(
    path: String,
    number: u64,
    subject_id: Option<String>,
    content: PrReactionContent,
    reacted: bool,
) -> Result<(), PrError> {
    open(&path)
        .await?
        .react(
            pull_number(number)?,
            subject_id.as_deref(),
            content,
            reacted,
        )
        .await
}

#[tauri::command]
pub async fn pr_submit_review(
    path: String,
    number: u64,
    verdict: PrReviewVerdict,
    body: String,
    comments: Vec<PrReviewCommentDraft>,
) -> Result<(), PrError> {
    open(&path)
        .await?
        .submit_review(pull_number(number)?, verdict, &body, &comments)
        .await
}

#[tauri::command]
pub async fn pr_action(path: String, number: u64, input: PrActionInput) -> Result<(), PrError> {
    open(&path)
        .await?
        .action(pull_number(number)?, &input)
        .await
}

/// Rewrite the pull request's title or description; a field left out is
/// left as it is.
#[tauri::command]
pub async fn pr_update(
    path: String,
    number: u64,
    title: Option<String>,
    body: Option<String>,
) -> Result<(), PrError> {
    open(&path)
        .await?
        .update(pull_number(number)?, title.as_deref(), body.as_deref())
        .await
}

#[tauri::command]
pub async fn pr_request_reviewers(
    path: String,
    number: u64,
    reviewers: Vec<PrReviewerRef>,
    requested: bool,
) -> Result<(), PrError> {
    open(&path)
        .await?
        .request_reviewers(pull_number(number)?, &reviewers, requested)
        .await
}

#[tauri::command]
pub async fn pr_set_labels(
    path: String,
    number: u64,
    labels: Vec<String>,
    applied: bool,
) -> Result<(), PrError> {
    open(&path)
        .await?
        .set_labels(pull_number(number)?, &labels, applied)
        .await
}

/// Rewrite a comment, a line comment or a review's summary the viewer may
/// edit (`canEdit` on the remark).
#[tauri::command]
pub async fn pr_edit_comment(
    path: String,
    number: u64,
    comment_id: String,
    kind: PrCommentKind,
    body: String,
) -> Result<(), PrError> {
    open(&path)
        .await?
        .edit_comment(pull_number(number)?, node_id(&comment_id)?, kind, &body)
        .await
}

/// Delete a comment or a line comment the viewer may delete (`canDelete`).
/// A review's summary is refused.
#[tauri::command]
pub async fn pr_delete_comment(
    path: String,
    number: u64,
    comment_id: String,
    kind: PrCommentKind,
) -> Result<(), PrError> {
    open(&path)
        .await?
        .delete_comment(pull_number(number)?, node_id(&comment_id)?, kind)
        .await
}

/// Open a pull request that undoes a merged one, and answer which.
#[tauri::command]
pub async fn pr_revert(path: String, number: u64) -> Result<PrReverted, PrError> {
    open(&path).await?.revert(pull_number(number)?).await
}

/// The end of one check's log, around its first error, read when asked for.
/// `checkUrl` is the check's own link; only a GitHub Actions job of this
/// repository has a log to read.
#[tauri::command]
pub async fn pr_check_log(
    path: String,
    number: u64,
    check_url: String,
) -> Result<PrCheckLog, PrError> {
    pull_number(number)?;
    open(&path).await?.check_log(&check_url).await
}

// ── images ───────────────────────────────────────────────────────────────

/// An image from a pull request's body or comments, fetched with the gh
/// credential. GitHub's own image hosts only.
#[tauri::command]
pub async fn pr_image(path: String, url: String) -> Result<PrImage, PrError> {
    images::fetch(checkout(&path)?, &url).await
}

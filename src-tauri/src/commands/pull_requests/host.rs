//! The provider seam: the host a checkout's pull requests live on, as the
//! commands see it.
//!
//! Every command opens a [`PrHost`] and calls it; only this file knows which
//! driver answers. GitHub is the one host today. A second (GitLab, a
//! self-hosted forge) is a new variant whose driver answers in the same
//! [`model`](super::model) shapes, plus one arm per method here — the
//! commands and the frontend stay as they are, because what a host can do
//! travels as data ([`PrCapabilities`]).

use super::github::GitHub;
use super::list_stats::PrListStat;
use super::model::*;

/// A checkout's pull-request host, resolved from its remote.
pub(crate) enum PrHost {
    GitHub(GitHub),
}

impl PrHost {
    /// The host behind a checkout's remote. Only GitHub is recognised; any
    /// other remote is refused by its driver as unsupported.
    pub async fn open(cwd: &str) -> Result<Self, PrError> {
        Ok(PrHost::GitHub(GitHub::open(cwd).await?))
    }

    pub fn provider(&self) -> PrProvider {
        match self {
            PrHost::GitHub(host) => host.provider(),
        }
    }
}

/// One forwarding method per operation, each a `match` over the hosts.
macro_rules! forward {
    ($( $(#[$doc:meta])* fn $name:ident(&self $(, $arg:ident: $ty:ty)* $(,)?) -> $ret:ty; )*) => {
        impl PrHost {
            $(
                $(#[$doc])*
                pub async fn $name(&self $(, $arg: $ty)*) -> Result<$ret, PrError> {
                    match self {
                        PrHost::GitHub(host) => host.$name($($arg),*).await,
                    }
                }
            )*
        }
    };
}

forward! {
    fn list(&self, query: &PrListQuery) -> PrListResult;
    fn detail(&self, number: u64) -> PrDetail;
    fn activity(&self, number: u64) -> PrActivity;
    fn thread_comments(&self, number: u64, thread_id: &str, cursor: Option<String>)
        -> PrThreadCommentsPage;
    fn timeline(&self, number: u64, cursor: Option<String>) -> PrTimelinePage;
    fn commits(&self, number: u64, cursor: Option<String>) -> PrCommitsPage;
    fn diff(&self, number: u64, cursor: Option<String>, commit: Option<String>) -> PrDiffResult;
    fn diff_file_contents(
        &self,
        number: u64,
        commit: Option<String>,
        change_type: PrFileChangeType,
        old_path: &str,
        new_path: &str,
    ) -> PrDiffFileContents;
    fn files_viewed(&self, number: u64) -> PrFilesViewed;
    fn reviewer_candidates(&self, number: u64) -> PrReviewerCandidates;
    fn label_candidates(&self, number: u64) -> PrLabelCandidates;
    fn set_files_viewed(&self, number: u64, files: &[PrFileViewedChange]) -> ();
    fn comment(&self, number: u64, body: &str) -> ();
    fn reply_to_thread(&self, thread_id: &str, body: &str) -> ();
    fn resolve_thread(&self, thread_id: &str, resolved: bool) -> ();
    fn react(
        &self,
        number: u64,
        subject_id: Option<&str>,
        content: PrReactionContent,
        reacted: bool,
    ) -> ();
    fn submit_review(
        &self,
        number: u64,
        verdict: PrReviewVerdict,
        body: &str,
        comments: &[PrReviewCommentDraft],
    ) -> ();
    fn action(&self, number: u64, input: &PrActionInput) -> ();
    fn update(&self, number: u64, title: Option<&str>, body: Option<&str>) -> ();
    fn request_reviewers(&self, number: u64, reviewers: &[PrReviewerRef], requested: bool) -> ();
    fn set_labels(&self, number: u64, labels: &[String], applied: bool) -> ();
    fn edit_comment(&self, number: u64, comment_id: &str, kind: PrCommentKind, body: &str) -> ();
    fn delete_comment(&self, number: u64, comment_id: &str, kind: PrCommentKind) -> ();
    fn revert(&self, number: u64) -> PrReverted;
    fn check_log(&self, check_url: &str) -> PrCheckLog;
    fn list_stats(&self, wanted: &[u64]) -> Vec<PrListStat>;
}

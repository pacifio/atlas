// Bridge to the native pull-request commands (`commands/pull_requests`).
// Every call goes through the user's own `gh` login; Atlas holds no token.
//
// Each wrapper rejects with a `PrError` (see `pr-errors.ts`). Calls pass the
// gh gate first: while `gh` is known missing, signed out or rate limited, a
// read rejects at once with that reason instead of spawning a `gh` that would
// fail the same way.

import { invoke } from "@tauri-apps/api/core";

import { classifyPrError, ghGate, noteGhOutcome } from "./pr-errors";
import type { GuideCheckout } from "./pull-request-guide-types";
import type {
  PrActionInput,
  PrActivity,
  PrCheckLog,
  PrCommentKind,
  PrCommitsPage,
  PrCreateDraft,
  PrCreated,
  PrCreateInput,
  PrDetail,
  PrDiffFileContents,
  PrDiffResult,
  PrFileChangeType,
  PrFilesViewed,
  PrFileViewedChange,
  PrImage,
  PrLabelCandidates,
  PrListQuery,
  PrListResult,
  PrListStat,
  PrProvider,
  PrReactionContent,
  PrReviewCommentDraft,
  PrReviewerCandidates,
  PrReviewerRef,
  PrReverted,
  PrReviewVerdict,
  PrThreadCommentsPage,
  PrTimelinePage,
} from "./pull-requests-types";

async function gated<T>(run: () => Promise<T>): Promise<T> {
  const held = ghGate();
  if (held) throw held;
  try {
    const value = await run();
    noteGhOutcome(null);
    return value;
  } catch (raw) {
    const error = classifyPrError(raw);
    noteGhOutcome(error);
    throw error;
  }
}

// ── reads ───────────────────────────────────────────────────────────────

export function prProvider(path: string, refresh = false): Promise<PrProvider> {
  return gated(() => invoke<PrProvider>("pr_provider", { path, refresh }));
}

export function prList(path: string, query: PrListQuery = {}): Promise<PrListResult> {
  return gated(() => invoke<PrListResult>("pr_list", { path, query }));
}

/** Line counts and changed files for listed pull requests, batched. */
export function prListStats(path: string, numbers: number[]): Promise<PrListStat[]> {
  return gated(() => invoke<PrListStat[]>("pr_list_stats", { path, numbers }));
}

export function prDetail(path: string, number: number): Promise<PrDetail> {
  return gated(() => invoke<PrDetail>("pr_detail", { path, number }));
}

export function prActivity(path: string, number: number): Promise<PrActivity> {
  return gated(() => invoke<PrActivity>("pr_activity", { path, number }));
}

export function prThreadComments(
  path: string,
  number: number,
  threadId: string,
  cursor: string | null = null,
): Promise<PrThreadCommentsPage> {
  return gated(() =>
    invoke<PrThreadCommentsPage>("pr_thread_comments", { path, number, threadId, cursor }),
  );
}

export function prTimeline(
  path: string,
  number: number,
  cursor: string | null = null,
): Promise<PrTimelinePage> {
  return gated(() => invoke<PrTimelinePage>("pr_timeline", { path, number, cursor }));
}

export function prCommits(
  path: string,
  number: number,
  cursor: string | null = null,
): Promise<PrCommitsPage> {
  return gated(() => invoke<PrCommitsPage>("pr_commits", { path, number, cursor }));
}

/** The patch: whole on the first call, or a page of files from `cursor`;
 *  `commit` narrows it to one commit. */
export function prDiff(
  path: string,
  number: number,
  cursor: string | null = null,
  commit: string | null = null,
): Promise<PrDiffResult> {
  return gated(() => invoke<PrDiffResult>("pr_diff", { path, number, cursor, commit }));
}

export function prDiffFileContents(
  path: string,
  number: number,
  changeType: PrFileChangeType,
  oldPath: string,
  newPath: string,
  commit: string | null = null,
): Promise<PrDiffFileContents> {
  return gated(() =>
    invoke<PrDiffFileContents>("pr_diff_file_contents", {
      path,
      number,
      commit,
      changeType,
      oldPath,
      newPath,
    }),
  );
}

export function prFilesViewed(path: string, number: number): Promise<PrFilesViewed> {
  return gated(() => invoke<PrFilesViewed>("pr_files_viewed", { path, number }));
}

/** Who the reviewer picker offers, those already asked marked. */
export function prReviewerCandidates(path: string, number: number): Promise<PrReviewerCandidates> {
  return gated(() => invoke<PrReviewerCandidates>("pr_reviewer_candidates", { path, number }));
}

/** The repository's labels, those on this pull request marked. */
export function prLabelCandidates(path: string, number: number): Promise<PrLabelCandidates> {
  return gated(() => invoke<PrLabelCandidates>("pr_label_candidates", { path, number }));
}

// ── writes ──────────────────────────────────────────────────────────────

export function prSetFilesViewed(
  path: string,
  number: number,
  files: PrFileViewedChange[],
): Promise<void> {
  return gated(() => invoke<void>("pr_set_files_viewed", { path, number, files }));
}

export function prComment(path: string, number: number, body: string): Promise<void> {
  return gated(() => invoke<void>("pr_comment", { path, number, body }));
}

export function prReplyToThread(
  path: string,
  number: number,
  threadId: string,
  body: string,
): Promise<void> {
  return gated(() => invoke<void>("pr_reply_to_thread", { path, number, threadId, body }));
}

export function prResolveThread(
  path: string,
  number: number,
  threadId: string,
  resolved: boolean,
): Promise<void> {
  return gated(() => invoke<void>("pr_resolve_thread", { path, number, threadId, resolved }));
}

/** React to the pull request (`subjectId` null) or one of its comments or reviews. */
export function prReact(
  path: string,
  number: number,
  subjectId: string | null,
  content: PrReactionContent,
  reacted: boolean,
): Promise<void> {
  return gated(() => invoke<void>("pr_react", { path, number, subjectId, content, reacted }));
}

/** Send a review whole: the verdict, its summary and every drafted line comment. */
export function prSubmitReview(
  path: string,
  number: number,
  verdict: PrReviewVerdict,
  body: string,
  comments: PrReviewCommentDraft[],
): Promise<void> {
  return gated(() => invoke<void>("pr_submit_review", { path, number, verdict, body, comments }));
}

export function prAction(path: string, number: number, input: PrActionInput): Promise<void> {
  return gated(() => invoke<void>("pr_action", { path, number, input }));
}

/** Rewrite the title or description; a field left `null` is left as it is. */
export function prUpdate(
  path: string,
  number: number,
  title: string | null,
  body: string | null,
): Promise<void> {
  return gated(() => invoke<void>("pr_update", { path, number, title, body }));
}

export function prRequestReviewers(
  path: string,
  number: number,
  reviewers: PrReviewerRef[],
  requested: boolean,
): Promise<void> {
  return gated(() => invoke<void>("pr_request_reviewers", { path, number, reviewers, requested }));
}

export function prSetLabels(
  path: string,
  number: number,
  labels: string[],
  applied: boolean,
): Promise<void> {
  return gated(() => invoke<void>("pr_set_labels", { path, number, labels, applied }));
}

/** Rewrite a comment, a line comment or a review's summary (`canEdit`). */
export function prEditComment(
  path: string,
  number: number,
  commentId: string,
  kind: PrCommentKind,
  body: string,
): Promise<void> {
  return gated(() => invoke<void>("pr_edit_comment", { path, number, commentId, kind, body }));
}

/** Delete a comment or a line comment (`canDelete`); a review's summary is
 *  refused. */
export function prDeleteComment(
  path: string,
  number: number,
  commentId: string,
  kind: PrCommentKind,
): Promise<void> {
  return gated(() => invoke<void>("pr_delete_comment", { path, number, commentId, kind }));
}

/** Open a pull request that undoes a merged one; answers which. */
export function prRevert(path: string, number: number): Promise<PrReverted> {
  return gated(() => invoke<PrReverted>("pr_revert", { path, number }));
}

/** The end of one check's log, around its first error. `checkUrl` is the
 *  check's own link (a GitHub Actions job of this repository). */
export function prCheckLog(path: string, number: number, checkUrl: string): Promise<PrCheckLog> {
  return gated(() => invoke<PrCheckLog>("pr_check_log", { path, number, checkUrl }));
}

/** A title and body to open a pull request for the current branch with.
 *  Not gated: it reads the local repository only, never GitHub. */
export function prCreateDraft(path: string): Promise<PrCreateDraft> {
  return invoke<PrCreateDraft>("pr_create_draft", { path }).catch((raw: unknown) => {
    throw classifyPrError(raw);
  });
}

/** Open a pull request for the current branch (`gh pr create`). The branch
 *  must already be on the remote. `sessionId`, the live session it is opened
 *  from, gets it linked as `created`. */
export function prCreate(
  path: string,
  input: PrCreateInput,
  sessionId: string | null = null,
): Promise<PrCreated> {
  return gated(() => invoke<PrCreated>("pr_create", { path, input, sessionId }));
}

// ── images ──────────────────────────────────────────────────────────────

/** An image from a body or comment, fetched natively with the gh credential.
 *  Not gated: an image is not a GitHub API read. */
export function prImage(path: string, url: string): Promise<PrImage> {
  return invoke<PrImage>("pr_image", { path, url }).catch((raw: unknown) => {
    throw classifyPrError(raw);
  });
}

// ── agent actions ───────────────────────────────────────────────────────

/** Where a "Fix" session runs: the checkout already on the pull request's
 *  branch, or a new worktree with it checked out. Never switches the main
 *  checkout (`commands/pull_requests/checkout.rs`). */
export interface PrCheckout {
  branch: string;
  /** `null` when the main checkout is already on the branch. */
  worktreePath: string | null;
  cwd: string;
  isOnPullRequestHead: boolean;
  reused: boolean;
}

/**
 * `inPlace`: "Check out → In this repository". The main checkout itself is
 * switched to the branch, refused (`invalid`) while its working tree has
 * changes or another worktree holds the branch. Otherwise the checkout
 * already on the branch is used, or a new worktree is made.
 */
export function prPrepareCheckout(
  path: string,
  detail: Pick<PrDetail, "number" | "headBranch" | "headSha" | "isCrossRepository">,
  inPlace = false,
): Promise<PrCheckout> {
  return gated(() =>
    invoke<PrCheckout>("pr_prepare_checkout", {
      path,
      number: detail.number,
      headBranch: detail.headBranch,
      headSha: detail.headSha,
      isCrossRepository: detail.isCrossRepository,
      inPlace,
    }),
  );
}

/** The guide last kept for a pull request, as stored (checked by the caller).
 *  Not gated: it reads Atlas's own data, never GitHub. */
export function prGuideRead(repository: string, number: number): Promise<unknown> {
  return invoke<unknown>("pr_guide_read", { repository, number }).catch((raw: unknown) => {
    throw classifyPrError(raw);
  });
}

export function prGuideWrite(repository: string, number: number, guide: unknown): Promise<void> {
  return invoke<void>("pr_guide_write", { repository, number, guide }).catch((raw: unknown) => {
    throw classifyPrError(raw);
  });
}

/** A detached checkout of the head for a guide run, and the change it makes. */
export function prGuidePrepare(
  path: string,
  detail: Pick<PrDetail, "number" | "headSha" | "headBranch" | "baseBranch">,
): Promise<GuideCheckout> {
  return invoke<GuideCheckout>("pr_guide_prepare", {
    path,
    number: detail.number,
    headSha: detail.headSha ?? "",
    headBranch: detail.headBranch,
    baseBranch: detail.baseBranch,
  }).catch((raw: unknown) => {
    throw classifyPrError(raw);
  });
}

/** Remove a guide run's checkout. Best-effort. */
export function prGuideFinish(path: string, runId: string): Promise<void> {
  return invoke<void>("pr_guide_finish", { path, runId }).catch(() => undefined);
}

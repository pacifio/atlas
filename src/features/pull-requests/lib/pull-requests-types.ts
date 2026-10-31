// The pull-request surface's wire types, twin of
// `src-tauri/src/commands/pull_requests/model.rs`. Provider-neutral on
// purpose: what a host can do arrives as data (`PrCapabilities`,
// `PrViewerPermissions`), so the UI asks those rather than assuming GitHub.
// `tests/wire-shape-contract.test.ts` holds the two files to the same fields.

// ── errors ──────────────────────────────────────────────────────────────

export type PrErrorKind =
  | "notInstalled"
  | "notAuthenticated"
  | "rateLimited"
  | "network"
  | "notFound"
  | "unsupported"
  | "invalid"
  | "failed";

/** What every pull-request command rejects with. */
export interface PrError {
  kind: PrErrorKind;
  message?: string;
  /** For `rateLimited`: when GitHub said to try again (epoch ms), if it did. */
  retryAt?: number | null;
}

// ── shared values ───────────────────────────────────────────────────────

export type PrState = "open" | "closed" | "merged";
export type PrListState = "all" | "open" | "closed" | "merged";
export type PrInvolvement = "all" | "authored" | "reviewing" | "involves";
export type PrReviewDecision = "approved" | "changes-requested" | "review-required";
export type PrChecksState = "passing" | "failing" | "pending";
export type PrMergeability = "mergeable" | "conflicting" | "unknown";
export type PrMergeMethod = "merge" | "squash" | "rebase";
export type PrUpdateMethod = "merge" | "rebase";
export type PrAction =
  | "merge"
  | "ready"
  | "draft"
  | "close"
  | "reopen"
  | "delete-branch"
  | "update-branch"
  | "enable-auto-merge"
  | "disable-auto-merge"
  | "revert"
  | "approve-workflows";
export type PrBaseComparison = "up-to-date" | "behind" | "unknown";

export interface PrActor {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  isBot: boolean;
}

export interface PrLabel {
  name: string;
  /** Six hex digits, no `#`, as the host gives it. */
  color: string | null;
}

export type PrCheckStatus =
  | "pending"
  | "action-required"
  | "success"
  | "failure"
  | "skipped"
  | "neutral"
  | "cancelled";

export interface PrCheck {
  name: string;
  status: PrCheckStatus;
  description: string | null;
  url: string | null;
  required: boolean | null;
  workflow: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
}

export type PrReactionContent =
  | "thumbs-up"
  | "thumbs-down"
  | "laugh"
  | "hooray"
  | "confused"
  | "heart"
  | "rocket"
  | "eyes";

export interface PrReaction {
  content: PrReactionContent;
  count: number;
  /** Who reacted, bounded, without the viewer (see `viewerHasReacted`). */
  actors: string[];
  viewerHasReacted: boolean;
}

export type PrCommentKind = "issue-comment" | "review-comment" | "review";

export interface PrComment {
  id: string;
  kind: PrCommentKind;
  author: PrActor | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  url: string | null;
  /** For a line comment, the file it is on. */
  path: string | null;
  /** For a review: the host's state word (`APPROVED`, `DISMISSED`, …). */
  reviewState: string | null;
  reactions: PrReaction[];
  /** The viewer may rewrite it (the host's word for this remark). */
  canEdit: boolean;
  /** The viewer may delete it; never true for a review's summary. */
  canDelete: boolean;
}

export type PrDiffSide = "left" | "right";
export type PrReviewVerdict = "comment" | "approve" | "request-changes";

export interface PrThreadComment {
  id: string;
  author: PrActor | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  url: string | null;
  reactions: PrReaction[];
  canEdit: boolean;
  canDelete: boolean;
}

export interface PrReviewThread {
  id: string;
  path: string;
  line: number | null;
  side: PrDiffSide;
  isResolved: boolean;
  isOutdated: boolean;
  comments: PrThreadComment[];
  commentCount: number;
  /** More comments past the first page; follow with `prThreadComments`. */
  nextCommentsCursor: string | null;
  /** Whether the viewer may resolve (or unresolve) it; `null` = unknown. */
  canResolve: boolean | null;
}

export type PrReviewerKind = "user" | "team";
export type PrReviewerState =
  | "requested"
  | "approved"
  | "changes-requested"
  | "commented"
  | "dismissed"
  | "pending";

export interface PrReviewer {
  actor: PrActor;
  kind: PrReviewerKind;
  state: PrReviewerState;
}

export interface PrCommit {
  oid: string;
  messageHeadline: string;
  committedDate: string;
  /** `null` for a merge commit, which the host measures against its first parent. */
  additions: number | null;
  deletions: number | null;
  authors: PrActor[];
}

// ── capabilities and permissions ────────────────────────────────────────

export interface PrReviewCapabilities {
  inlineComment: boolean;
  reply: boolean;
  resolve: boolean;
  verdicts: PrReviewVerdict[];
}

export interface PrReviewerCapabilities {
  request: boolean;
  listCandidates: boolean;
}

export interface PrEditCapabilities {
  changeRequest: boolean;
  comment: boolean;
}

export type PrViewedFilesStore = "host" | "environment";

/** What the host can do at all, for someone. */
export interface PrCapabilities {
  diff: boolean;
  comment: boolean;
  actions: PrAction[];
  mergeMethods: PrMergeMethod[];
  deleteBranch: boolean;
  updateMethods: PrUpdateMethod[];
  search: boolean;
  reactions: boolean;
  viewedFiles: PrViewedFilesStore | null;
  review: PrReviewCapabilities;
  reviewers: PrReviewerCapabilities;
  edit: PrEditCapabilities;
  labels: boolean;
  fileContents: boolean;
  conditionalReads: boolean;
}

/** What the signed-in account may do on one pull request. */
export interface PrViewerPermissions {
  actions: PrAction[];
  comment: boolean;
  resolve: boolean;
  verdicts: PrReviewVerdict[];
  requestReviewers: boolean;
  updateMethods: PrUpdateMethod[];
  labels: boolean;
  editChangeRequest: boolean;
  canMerge: boolean;
}

export interface PrMergeCapabilities {
  merge: boolean;
  squash: boolean;
  rebase: boolean;
}

export type PrProviderKind = "github";

export interface PrProvider {
  kind: PrProviderKind;
  host: string;
  repository: string;
  viewer: string | null;
  capabilities: PrCapabilities;
}

// ── reads ───────────────────────────────────────────────────────────────

export interface PrListQuery {
  state?: PrListState | null;
  involvement?: PrInvolvement | null;
  search?: string | null;
  author?: string | null;
  /** `"only"` drafts, `"hide"` drafts, or anything else for both. */
  draft?: string | null;
  labels?: string[] | null;
  /** Each group ORs its labels; every group must hold (`label:a,b`). */
  labelGroups?: string[][] | null;
  /** Labels a pull request must not carry (`-label:x`). */
  excludedLabels?: string[] | null;
  /** Only pull requests whose head is this branch. */
  head?: string | null;
  cursor?: string | null;
  /** Rows per page, at most 100. */
  limit?: number | null;
}

/** One changed file's line counts, for the list's change breakdown. */
export interface PrFileStat {
  path: string;
  additions: number;
  deletions: number;
}

/** A listed pull request's line counts with the files behind them
 *  (`pr_list_stats`). */
export interface PrListStat {
  number: number;
  additions: number;
  deletions: number;
  files: PrFileStat[];
  /** More files changed than were read: a split would be partial. */
  filesTruncated: boolean;
}

export interface PrListEntry {
  number: number;
  title: string;
  url: string;
  author: PrActor | null;
  headBranch: string;
  baseBranch: string;
  state: PrState;
  isDraft: boolean;
  mergeability: PrMergeability;
  additions: number;
  deletions: number;
  createdAt: string;
  updatedAt: string;
  /** When it merged; `null` (or absent) while it is not merged. */
  mergedAt?: string | null;
  viewerReviewRequested: boolean;
  labels: PrLabel[];
  reviewDecision: PrReviewDecision | null;
  checksState: PrChecksState | null;
  /** Conversation comments; line comments inside review threads are not counted. */
  commentCount: number;
  /** `owner/name` the head branch lives in; `null` once a fork is deleted. */
  headRepository?: string | null;
  /** The head branch lives in another repository than the base. */
  isCrossRepository?: boolean;
}

export interface PrListResult {
  provider: PrProvider;
  entries: PrListEntry[];
  nextCursor: string | null;
}

export interface PrDetail {
  capabilities: PrCapabilities;
  viewerPermissions: PrViewerPermissions;
  repository: string;
  number: number;
  title: string;
  body: string;
  url: string;
  author: PrActor | null;
  state: PrState;
  isDraft: boolean;
  mergeability: PrMergeability;
  mergeStateStatus: string | null;
  reviewDecision: PrReviewDecision | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
  headBranch: string;
  headRepository: string | null;
  headSha: string | null;
  baseBranch: string;
  baseSha: string | null;
  isCrossRepository: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  reviewers: PrReviewer[];
  labels: PrLabel[];
  assignees: PrActor[];
  /** Failing checks first. */
  checks: PrCheck[];
  checksState: PrChecksState | null;
  /** More checks than the host would list; `checksState` may be optimistic. */
  checksTruncated: boolean;
  mergeCapabilities: PrMergeCapabilities;
  viewer: string | null;
  baseComparison: PrBaseComparison;
  behindBy: number | null;
  autoMergeEnabled: boolean | null;
  autoMergeMethod: PrMergeMethod | null;
}

export interface PrActivity {
  author: PrActor | null;
  reviewers: PrActor[];
  /** Issue comments, reviews and line comments, oldest first. */
  comments: PrComment[];
  commentCount: number;
  commentsTruncated: boolean;
  reviewThreadsTruncated: boolean;
  reviewThreads: PrReviewThread[];
  commits: PrCommit[];
  reactions: PrReaction[];
}

export interface PrThreadCommentsPage {
  comments: PrThreadComment[];
  nextCursor: string | null;
}

export type PrTimelineItem =
  | { kind: "opened"; actor: PrActor | null; at: string }
  | {
      kind: "commit";
      id: string;
      oid: string;
      messageHeadline: string;
      authors: PrActor[];
      at: string;
    }
  | {
      kind: "comment";
      id: string;
      actor: PrActor | null;
      body: string;
      url: string | null;
      at: string;
    }
  | {
      kind: "review";
      id: string;
      actor: PrActor | null;
      state: string;
      body: string;
      url: string | null;
      at: string;
    }
  | {
      kind: "merged";
      id: string;
      actor: PrActor | null;
      commitOid: string | null;
      baseBranch: string | null;
      at: string;
    }
  | { kind: "closed"; id: string; actor: PrActor | null; at: string }
  | { kind: "reopened"; id: string; actor: PrActor | null; at: string }
  | {
      kind: "force-pushed";
      id: string;
      actor: PrActor | null;
      beforeOid: string | null;
      afterOid: string | null;
      at: string;
    }
  | { kind: "ready-for-review"; id: string; actor: PrActor | null; at: string }
  | { kind: "converted-to-draft"; id: string; actor: PrActor | null; at: string }
  | {
      kind: "review-requested";
      id: string;
      actor: PrActor | null;
      reviewer: PrActor | null;
      at: string;
    }
  | { kind: "head-ref-deleted"; id: string; actor: PrActor | null; at: string }
  | { kind: "labeled"; id: string; actor: PrActor | null; label: PrLabel; at: string }
  | { kind: "unlabeled"; id: string; actor: PrActor | null; label: PrLabel; at: string };

export interface PrTimelinePage {
  items: PrTimelineItem[];
  nextCursor: string | null;
}

export interface PrCommitsPage {
  commits: PrCommit[];
  nextCursor: string | null;
}

export type PrFileStatus =
  | "added"
  | "removed"
  | "modified"
  | "renamed"
  | "copied"
  | "changed"
  | "unchanged";

export interface PrDiffFile {
  path: string;
  previousPath: string | null;
  status: PrFileStatus;
  additions: number;
  deletions: number;
  /** False for a file the host gave no hunks for (binary, too large, pure rename). */
  hasPatch: boolean;
}

export interface PrOmittedFileStat {
  path: string;
  additions: number;
  deletions: number;
}

export interface PrDiffResult {
  /** A unified patch with `diff --git` headers. */
  patch: string;
  /** Per-file metadata; empty when the host sent the patch whole. */
  files: PrDiffFile[];
  /** Some file's hunks were withheld; see `omittedFileStats`. */
  truncated: boolean;
  /** The next page of files, when the patch is read a page at a time. */
  nextCursor: string | null;
  omittedFileStats: PrOmittedFileStat[];
}

export type PrFileChangeType = "change" | "rename-pure" | "rename-changed" | "new" | "deleted";

export interface PrDiffFileContents {
  oldContents: string;
  newContents: string;
}

export type PrFileViewedState = "unviewed" | "viewed" | "dismissed";

export interface PrFileViewed {
  path: string;
  state: PrFileViewedState;
}

export interface PrFilesViewed {
  files: PrFileViewed[];
  truncated: boolean;
}

export interface PrImage {
  contentType: string;
  /** Base64. */
  data: string;
}

/** Someone who may be asked to review: a person by login, or a team by slug
 *  (`id`, what a request names). */
export interface PrReviewerCandidate {
  id: string;
  kind: PrReviewerKind;
  actor: PrActor;
  /** Asked already, and not yet answered. */
  isRequested: boolean;
}

export interface PrReviewerCandidates {
  candidates: PrReviewerCandidate[];
  /** The repository has more people with access than were listed. */
  truncated: boolean;
}

/** A label the repository defines, and whether this pull request carries it. */
export interface PrLabelCandidate {
  name: string;
  /** Six hex digits, no `#`. */
  color: string | null;
  description: string | null;
  isApplied: boolean;
}

export interface PrLabelCandidates {
  candidates: PrLabelCandidate[];
  /** The repository has more labels than were listed. */
  truncated: boolean;
}

// ── writes ──────────────────────────────────────────────────────────────

export interface PrFileViewedChange {
  path: string;
  viewed: boolean;
}

export type PrReviewPosition =
  | { kind: "added"; newLine: number }
  | { kind: "deleted"; oldLine: number }
  | { kind: "context"; oldLine: number; newLine: number; side: PrDiffSide };

export interface PrReviewCommentDraft {
  path: string;
  position: PrReviewPosition;
  body: string;
}

export interface PrReviewerRef {
  /** A login, or a team's slug. */
  id: string;
  kind: PrReviewerKind;
}

export interface PrActionInput {
  action: PrAction;
  mergeMethod?: PrMergeMethod | null;
  updateMethod?: PrUpdateMethod | null;
  /** For a merge or auto-merge: the head commit the reader saw. A head that
   *  has moved on since is refused rather than merged unseen. */
  expectedHeadOid?: string | null;
  /** For a merge or auto-merge: take agent co-author trailers and
   *  "Generated with" footers out of the merge commit's message. Off unless
   *  asked for (the `removeAgentCreditsOnMerge` setting drives it). */
  removeAgentCredits?: boolean;
}

/** The pull request a revert opened. */
export interface PrReverted {
  number: number;
  url: string;
}

/** The end of one check's log around its first error, read on demand.
 *  A third party's output: anything that passes it on marks it untrusted. */
export interface PrCheckLog {
  jobId: string;
  text: string;
  /** Lines before or after the window were left out. */
  truncated: boolean;
  /** The window is anchored on a line the runner marked as an error. */
  foundError: boolean;
}

// ── opening one (`commands/pull_requests/create.rs`) ────────────────────

/** What the Create PR dialog confirmed. */
export interface PrCreateInput {
  title: string;
  body: string;
  /** The branch to merge into; `null` lets the host use its default. */
  base: string | null;
  draft: boolean;
}

/** The pull request `gh pr create` opened. */
export interface PrCreated {
  number: number;
  url: string;
}

/** A starting title and body for the current branch, as `--fill` would write. */
export interface PrCreateDraft {
  /** The current branch; `null` on a detached HEAD. */
  headBranch: string | null;
  /** The remote's default branch, when the remote names one. */
  baseBranch: string | null;
  title: string;
  body: string;
  /** Commits on the branch that the base does not have. */
  commitCount: number;
}

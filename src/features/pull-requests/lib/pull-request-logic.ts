// What the pull-request tab decides, as pure functions: which control the
// header leads with, which merge method is selected, whether the branch is
// behind its base, how the conversation is grouped, filtered and paged, and
// how checks are summarised. Kept free of React so each rule is tested on
// its own (`pull-request-logic.test.ts`).
//
// The detail (`PrDetail`) and the conversation (`PrActivity`) are separate
// reads here, so functions take the piece they need rather than one merged
// object.

import type {
  PrAction,
  PrActor,
  PrCheck,
  PrChecksState,
  PrComment,
  PrCommit,
  PrDetail,
  PrMergeability,
  PrMergeMethod,
  PrReviewThread,
  PrState,
  PrUpdateMethod,
} from "./pull-requests-types";

// ── actions ─────────────────────────────────────────────────────────────

export const MERGE_METHOD_LABELS: Record<PrMergeMethod, string> = {
  merge: "Merge",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

/** Whether the host offers `action` at all and the viewer may take it here. */
export function canPerform(
  detail: Pick<PrDetail, "capabilities" | "viewerPermissions"> | null,
  action: PrAction,
): boolean {
  return (
    detail !== null &&
    detail.capabilities.actions.includes(action) &&
    detail.viewerPermissions.actions.includes(action)
  );
}

/** The methods both the host and this repository's settings allow. */
export function allowedMergeMethods(
  detail: Pick<PrDetail, "capabilities" | "mergeCapabilities"> | null,
): PrMergeMethod[] {
  return detail === null
    ? []
    : detail.capabilities.mergeMethods.filter((method) => detail.mergeCapabilities[method]);
}

/** The method the primary button merges with: the one picked for this pull
 *  request, else the last one picked anywhere, else the first allowed. */
export function resolveMergeMethod(
  allowed: readonly PrMergeMethod[],
  current: PrMergeMethod | null,
  lastSelected: PrMergeMethod | null,
): PrMergeMethod {
  for (const method of [current, lastSelected]) {
    if (method && allowed.includes(method)) return method;
  }
  return allowed[0] ?? "merge";
}

export type PrimaryControl =
  | "resolve"
  | "ready"
  | "merge"
  | "enable-auto-merge"
  | "auto-merge-armed"
  | "merged"
  | "closed"
  | null;

/** The header's one prominent control, which depends on where the pull
 *  request stands: a draft offers Ready for review; checks still running (or
 *  failing) offer auto-merge when the host can wait on them; otherwise Merge. */
export function resolvePrimaryControl(input: {
  state: PrState;
  isDraft: boolean;
  mergeability: PrMergeability;
  checksState: PrChecksState | null;
  autoMergeEnabled: boolean | null;
  hasMergeMethod: boolean;
  canMerge: boolean;
  canMarkReady: boolean;
  canEnableAutoMerge: boolean;
}): PrimaryControl {
  if (input.state === "merged") return "merged";
  if (input.state === "closed") return "closed";
  if (input.mergeability === "conflicting") return "resolve";
  if (input.isDraft) return input.canMarkReady ? "ready" : null;
  if (input.autoMergeEnabled) return "auto-merge-armed";
  if (!input.hasMergeMethod) return null;
  if (
    input.autoMergeEnabled === false &&
    input.checksState !== null &&
    input.checksState !== "passing" &&
    input.canEnableAutoMerge
  ) {
    return "enable-auto-merge";
  }
  return input.canMerge ? "merge" : null;
}

/** The command that checks the pull request out, ready to paste. */
export function checkoutCommand(number: number): string {
  return `gh pr checkout ${number}`;
}

/** Whether the branch has fallen behind its base, and how it may be brought
 *  up to date; `null` when there is nothing to warn about. */
export function resolveBaseFreshness(
  detail: Pick<
    PrDetail,
    "state" | "mergeability" | "baseComparison" | "behindBy" | "capabilities" | "viewerPermissions"
  >,
): { behindBy: number | null; methods: PrUpdateMethod[] } | null {
  if (detail.state !== "open" || detail.baseComparison !== "behind") return null;
  if (detail.mergeability === "conflicting") return null;
  const allowed = detail.viewerPermissions.updateMethods;
  return {
    behindBy: detail.behindBy ?? null,
    methods: detail.capabilities.updateMethods.filter((method) => allowed.includes(method)),
  };
}

/** A branch is deleted once its pull request is done with. */
export function canDeleteBranch(
  detail: Pick<PrDetail, "state" | "capabilities" | "viewerPermissions" | "isCrossRepository">,
): boolean {
  return (
    detail.state !== "open" &&
    detail.capabilities.deleteBranch &&
    canPerform(detail, "delete-branch")
  );
}

/** The viewer may rewrite the title and description. */
export function canEditPullRequest(
  detail: Pick<PrDetail, "capabilities" | "viewerPermissions">,
): boolean {
  return detail.capabilities.edit.changeRequest && detail.viewerPermissions.editChangeRequest;
}

export const ACTION_FAILURE_LABELS: Record<PrAction, string> = {
  merge: "Could not merge this pull request",
  ready: "Could not mark this ready for review",
  draft: "Could not convert this to a draft",
  close: "Could not close this pull request",
  reopen: "Could not reopen this pull request",
  "update-branch": "Could not update this branch",
  "enable-auto-merge": "Could not turn on auto-merge",
  "disable-auto-merge": "Could not turn off auto-merge",
  "delete-branch": "Could not delete this branch",
  revert: "Could not revert this pull request",
  "approve-workflows": "Could not approve the workflows",
};

// ── checks ──────────────────────────────────────────────────────────────

/** Failing beats running beats passing; `null` with nothing reported. */
export function checksStateOf(checks: readonly PrCheck[]): PrChecksState | null {
  if (checks.length === 0) return null;
  const statuses = new Set(checks.map((check) => check.status));
  if (statuses.has("failure") || statuses.has("cancelled")) return "failing";
  if (statuses.has("pending") || statuses.has("action-required")) return "pending";
  return statuses.has("success") ? "passing" : null;
}

function isWorkflowApprovalCheck(check: Pick<PrCheck, "status" | "url">): boolean {
  return (
    check.status === "action-required" &&
    check.url !== null &&
    /\/actions\/runs\/\d+(?:\/|$)/u.test(check.url)
  );
}

const CHECK_STATUS_LABELS: Record<PrCheck["status"], string> = {
  pending: "Running",
  "action-required": "Awaiting action",
  success: "Passed",
  failure: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
  neutral: "Neutral",
};

export function checkStatusLabel(check: Pick<PrCheck, "status" | "url">): string {
  return isWorkflowApprovalCheck(check) ? "Awaiting approval" : CHECK_STATUS_LABELS[check.status];
}

/** The checks pill's text: "2 of 5 failing", "All checks passed", … */
export function summarizeChecks(checks: readonly PrCheck[]): string {
  if (checks.length === 0) return "No checks reported";
  const actionRequired = checks.filter((check) => check.status === "action-required");
  const workflowApprovals = actionRequired.filter(isWorkflowApprovalCheck).length;
  const otherActionRequired = actionRequired.length - workflowApprovals;
  const failed = checks.filter(
    (check) => check.status === "failure" || check.status === "cancelled",
  ).length;
  const pending = checks.filter((check) => check.status === "pending").length;
  const passed = checks.filter((check) => check.status === "success").length;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (failed > 0) return `${failed} of ${checks.length} failing`;
  if (workflowApprovals > 0 && otherActionRequired > 0) {
    return `${plural(workflowApprovals, "workflow", "workflows")} and ${plural(otherActionRequired, "check", "checks")} awaiting action`;
  }
  if (workflowApprovals > 0) {
    return `${plural(workflowApprovals, "workflow", "workflows")} awaiting approval`;
  }
  if (otherActionRequired > 0) {
    return `${plural(otherActionRequired, "check", "checks")} awaiting action`;
  }
  if (pending > 0) return `${pending} of ${checks.length} running`;
  return passed === checks.length ? "All checks passed" : `${passed} of ${checks.length} passing`;
}

export const CHECKS_STATE_LABELS: Record<PrChecksState, string> = {
  passing: "All checks have passed",
  failing: "Some checks were not successful",
  pending: "Some checks haven't completed yet",
};

/** Checks that need a look first, then running ones, then the rest. */
export function groupChecks(checks: readonly PrCheck[]) {
  const attention = checks.filter(
    (c) => c.status === "failure" || c.status === "cancelled" || c.status === "action-required",
  );
  const running = checks.filter((c) => c.status === "pending");
  const completed = checks.filter((c) => !attention.includes(c) && !running.includes(c));
  return { attention, running, completed };
}

// ── reviews ─────────────────────────────────────────────────────────────

export type ReviewOutcome = "approved" | "changes-requested" | "dismissed";

/** GitHub's `CHANGES_REQUESTED` and the like, as a verdict; anything else
 *  (`COMMENTED`) is not one. */
export function reviewOutcome(reviewState: string | null): ReviewOutcome | null {
  switch (reviewState?.trim().toLowerCase().replaceAll("_", "-")) {
    case "approved":
      return "approved";
    case "changes-requested":
      return "changes-requested";
    case "dismissed":
      return "dismissed";
    default:
      return null;
  }
}

function instant(iso: string): number {
  return Date.parse(iso);
}

export function newestCommitAt(commits: readonly PrCommit[]): string | null {
  let newest: string | null = null;
  let newestAt = Number.NEGATIVE_INFINITY;
  for (const commit of commits) {
    const at = instant(commit.committedDate);
    if (Number.isNaN(at) || at <= newestAt) continue;
    newest = commit.committedDate;
    newestAt = at;
  }
  return newest;
}

/** A verdict given before the newest commit was about earlier changes. */
export function isVerdictStale(at: string, newestCommit: string | null): boolean {
  if (newestCommit === null) return false;
  const verdictAt = instant(at);
  const commitAt = instant(newestCommit);
  return !Number.isNaN(verdictAt) && !Number.isNaN(commitAt) && verdictAt < commitAt;
}

export interface ReviewOutcomeEntry {
  key: string;
  actor: PrActor | null;
  outcome: ReviewOutcome;
  at: string;
  stale: boolean;
}

/** Each reviewer's latest verdict, read from the whole conversation; a
 *  dismissed one stands for nothing. */
export function latestReviewOutcomes(
  comments: readonly PrComment[],
  commits: readonly PrCommit[] = [],
): ReviewOutcomeEntry[] {
  const newest = newestCommitAt(commits);
  const latest = new Map<string, ReviewOutcomeEntry>();
  for (const comment of comments) {
    const outcome = reviewOutcome(comment.reviewState);
    if (outcome === null) continue;
    const login = comment.author?.login.toLowerCase() ?? `ghost:${comment.id}`;
    const current = latest.get(login);
    if (current !== undefined && instant(current.at) > instant(comment.createdAt)) continue;
    latest.set(login, {
      key: login,
      actor: comment.author,
      outcome,
      at: comment.createdAt,
      stale: isVerdictStale(comment.createdAt, newest),
    });
  }
  return [...latest.values()].filter((entry) => entry.outcome !== "dismissed");
}

// ── the conversation ────────────────────────────────────────────────────

/** A body that is only HTML comments (a bot's marker) counts as no body. */
export function visibleBody(body: string): string | null {
  return body.replace(/<!--[\s\S]*?-->/gu, "").trim().length === 0 ? null : body.trim();
}

/** One line of a collapsed comment: the body without its markdown. */
export function bodyPreview(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<[^>]+>/gu, "")
    .replace(/^\s*>?\s*\[!\w+\]\s*$/gmu, "")
    .replace(/!?(\[([^\]]+)\])\([^)]*\)/gu, "$2")
    .replace(/^[\s>#*-]+/gmu, "")
    .replace(/[*`]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ReplyAvailability {
  moreReplies: number;
  hasMoreReplies: boolean;
  url: string | null;
}

export type ConversationItem =
  | { kind: "comment"; id: string; createdAt: string; comment: PrComment }
  | ({
      kind: "thread";
      id: string;
      createdAt: string;
      root: PrComment;
      replies: PrComment[];
      thread: PrReviewThread;
    } & ReplyAvailability);

/** Loose comments and review threads in one timeline: each thread sits at
 *  its first comment's time, its replies under it. */
export function conversationItems(
  comments: readonly PrComment[],
  reviewThreads: readonly PrReviewThread[],
): ConversationItem[] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const claimed = new Set<string>();
  const threads: ConversationItem[] = [];
  for (const thread of reviewThreads) {
    const ordered = thread.comments
      .map(
        (comment): PrComment =>
          byId.get(comment.id) ?? {
            ...comment,
            kind: "review-comment",
            path: thread.path,
            reviewState: null,
          },
      )
      .sort((left, right) => instant(left.createdAt) - instant(right.createdAt));
    const [root, ...replies] = ordered;
    if (root === undefined) continue;
    for (const comment of ordered) claimed.add(comment.id);
    const moreReplies = Math.max(0, thread.commentCount - ordered.length);
    threads.push({
      kind: "thread",
      id: thread.id,
      createdAt: root.createdAt,
      root,
      replies,
      thread,
      moreReplies,
      hasMoreReplies: moreReplies > 0 || thread.nextCommentsCursor !== null,
      url: ordered.find((comment) => comment.url !== null)?.url ?? null,
    });
  }
  threads.sort((left, right) => instant(left.createdAt) - instant(right.createdAt));
  const items: ConversationItem[] = [];
  let next = 0;
  for (const comment of comments) {
    if (claimed.has(comment.id)) continue;
    while (next < threads.length && instant(threads[next].createdAt) < instant(comment.createdAt)) {
      items.push(threads[next++]);
    }
    items.push({ kind: "comment", id: comment.id, createdAt: comment.createdAt, comment });
  }
  items.push(...threads.slice(next));
  return items;
}

export function itemComments(item: ConversationItem): PrComment[] {
  return item.kind === "comment" ? [item.comment] : [item.root, ...item.replies];
}

/** Resolved, or a dismissed review: shown folded. */
export function isFinished(comment: PrComment, thread?: PrReviewThread): boolean {
  return thread?.isResolved === true || reviewOutcome(comment.reviewState) === "dismissed";
}

export function isBot(actor: PrActor | null): boolean {
  return actor?.isBot === true || actor?.login.endsWith("[bot]") === true;
}

export interface CommentFilter {
  bots: boolean;
  resolved: boolean;
}

/** Hide bots and finished threads unless asked; a thread stays when any of
 *  its comments passes, so a person's reply to a bot keeps the finding. */
export function filterConversation(
  items: readonly ConversationItem[],
  filter: CommentFilter,
): ConversationItem[] {
  return items.filter((item) =>
    itemComments(item).some(
      (comment) =>
        (filter.bots || !isBot(comment.author)) &&
        (filter.resolved || !isFinished(comment, item.kind === "thread" ? item.thread : undefined)),
    ),
  );
}

/** The newest `count` items, and how many older ones are left out. */
export function pageConversation(
  items: readonly ConversationItem[],
  count: number,
): { shown: ConversationItem[]; hidden: number } {
  const shown = items.slice(Math.max(0, items.length - count));
  return { shown, hidden: items.length - shown.length };
}

export function orderByTime<T>(items: readonly T[], order: "newest" | "oldest"): T[] {
  return order === "newest" ? [...items].reverse() : [...items];
}

// ── findings (agent actions, step 7) ────────────────────────────────────

export type Finding =
  | { kind: "thread"; thread: PrReviewThread }
  | { kind: "check"; check: PrCheck }
  | { kind: "comment"; comment: PrComment };

export function findingKey(finding: Finding): string {
  switch (finding.kind) {
    case "thread":
      return `finding:thread:${finding.thread.id}`;
    case "comment":
      return `finding:comment:${finding.comment.id}`;
    case "check":
      return `finding:check:${finding.check.name}:${finding.check.url ?? ""}`;
  }
}

// ── scroll ──────────────────────────────────────────────────────────────

const STICKY_EDGE_TOLERANCE_PX = 1;

/** Collapsing a section whose sticky heading is pinned would jump the page;
 *  this is the scrollTop that keeps the pressed heading where it was. */
export function sectionCollapseAnchorScrollTop(input: {
  scrollTop: number;
  viewportTop: number;
  sectionTop: number;
  headingTop: number;
}): number | null {
  const scrolledPast = input.sectionTop < input.viewportTop;
  const pinned = input.headingTop <= input.viewportTop + STICKY_EDGE_TOLERANCE_PX;
  if (!scrolledPast || !pinned) return null;
  return Math.max(0, input.scrollTop + input.sectionTop - input.viewportTop);
}

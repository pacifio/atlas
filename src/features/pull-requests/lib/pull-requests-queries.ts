// The pull-request reads as react-query hooks: one key family per checkout,
// stale times matched to how fast each answer actually changes, and one
// invalidation an agent's turn end can call.
//
// Freshness, in three layers:
//  - stale times per read (below) — a list moves faster than a merged pull
//    request's detail, which effectively never does;
//  - a slow poll (`REFRESH_INTERVAL_MS`) while a read is on screen, plus a
//    refetch when the window regains focus;
//  - `invalidatePullRequestQueries` on an agent's turn end, which is when a
//    session is likely to have pushed.
// Conditional REST reads cost no quota when nothing changed (the native
// side revalidates with an ETag), so the poll is cheaper than it looks.

import { useEffect } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  type InfiniteData,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";

import { ghGate, prRetryDelay, shouldRetryPrError } from "./pr-errors";
import {
  readCachedPullRequestDetail,
  writeCachedPullRequestDetail,
} from "./pull-request-detail-cache";
import {
  prAction,
  prActivity,
  prComment,
  prCommits,
  prDeleteComment,
  prDetail,
  prDiff,
  prEditComment,
  prFilesViewed,
  prLabelCandidates,
  prReviewerCandidates,
  prList,
  prProvider,
  prReact,
  prReplyToThread,
  prRequestReviewers,
  prResolveThread,
  prRevert,
  prSetLabels,
  prSubmitReview,
  prTimeline,
  prUpdate,
} from "./pull-requests-api";
import type {
  PrActionInput,
  PrActivity,
  PrCommentKind,
  PrCommitsPage,
  PrDetail,
  PrDiffResult,
  PrError,
  PrFilesViewed,
  PrLabelCandidates,
  PrReviewerCandidates,
  PrListQuery,
  PrListResult,
  PrProvider,
  PrReactionContent,
  PrReverted,
  PrReviewCommentDraft,
  PrReviewerRef,
  PrReviewVerdict,
  PrTimelineItem,
  PrTimelinePage,
} from "./pull-requests-types";

export const STALE = {
  list: 30_000,
  detail: 60_000,
  /** A merged pull request changes only by new comments. */
  mergedDetail: 10 * 60_000,
  activity: 60_000,
  checks: 15_000,
  diff: 60_000,
  /** A commit's diff never changes. */
  commitDiff: 10 * 60_000,
  filesViewed: 15_000,
  provider: 10 * 60_000,
} as const;

export const REFRESH_INTERVAL_MS = 5 * 60_000;

/** Every key starts with this and the checkout, so one call clears a checkout. */
export const pullRequestKeys = {
  all: (cwd: string) => ["pull-requests", cwd] as const,
  provider: (cwd: string) => ["pull-requests", cwd, "provider"] as const,
  list: (cwd: string, query: PrListQuery) => ["pull-requests", cwd, "list", query] as const,
  /** Every page of one listing read so far — under `list`, so a write that
   *  refreshes the listings refreshes it too. */
  listPages: (cwd: string, query: PrListQuery) =>
    ["pull-requests", cwd, "list", "pages", query] as const,
  pull: (cwd: string, number: number) => ["pull-requests", cwd, "pull", number] as const,
  detail: (cwd: string, number: number) =>
    ["pull-requests", cwd, "pull", number, "detail"] as const,
  activity: (cwd: string, number: number) =>
    ["pull-requests", cwd, "pull", number, "activity"] as const,
  timeline: (cwd: string, number: number, cursor: string | null) =>
    ["pull-requests", cwd, "pull", number, "timeline", cursor] as const,
  timelineHistory: (cwd: string, number: number) =>
    ["pull-requests", cwd, "pull", number, "timeline-history"] as const,
  commits: (cwd: string, number: number, cursor: string | null) =>
    ["pull-requests", cwd, "pull", number, "commits", cursor] as const,
  diff: (cwd: string, number: number, cursor: string | null, commit: string | null) =>
    ["pull-requests", cwd, "pull", number, "diff", cursor, commit] as const,
  /** Every page of the diff read so far, as one infinite read. */
  diffPages: (cwd: string, number: number, commit: string | null) =>
    ["pull-requests", cwd, "pull", number, "diff-pages", commit] as const,
  commitPages: (cwd: string, number: number) =>
    ["pull-requests", cwd, "pull", number, "commit-pages"] as const,
  filesViewed: (cwd: string, number: number) =>
    ["pull-requests", cwd, "pull", number, "files-viewed"] as const,
  reviewerCandidates: (cwd: string, number: number) =>
    ["pull-requests", cwd, "pull", number, "reviewer-candidates"] as const,
  labelCandidates: (cwd: string, number: number) =>
    ["pull-requests", cwd, "pull", number, "label-candidates"] as const,
};

/** Shared by every read: retry only what is transient, with back-off; never
 *  poll while the gh gate is closed. */
const COMMON = {
  retry: shouldRetryPrError,
  retryDelay: (attempt: number) => prRetryDelay(attempt),
  refetchOnWindowFocus: true,
  refetchInterval: () => (ghGate() ? false : REFRESH_INTERVAL_MS),
  refetchIntervalInBackground: false,
} as const;

type Result<T> = UseQueryResult<T, PrError>;

export function usePrProvider(cwd: string | null): Result<PrProvider> {
  return useQuery<PrProvider, PrError>({
    ...COMMON,
    queryKey: pullRequestKeys.provider(cwd ?? ""),
    queryFn: () => prProvider(cwd!),
    enabled: !!cwd,
    staleTime: STALE.provider,
    refetchInterval: false,
  });
}

export function usePrList(cwd: string | null, query: PrListQuery = {}): Result<PrListResult> {
  return useQuery<PrListResult, PrError>({
    ...COMMON,
    queryKey: pullRequestKeys.list(cwd ?? "", query),
    queryFn: () => prList(cwd!, query),
    enabled: !!cwd,
    staleTime: STALE.list,
  });
}

/** A listing a page at a time, for the pull-request list surface. */
export function usePrListPages(cwd: string | null, query: Omit<PrListQuery, "cursor">) {
  return useInfiniteQuery<
    PrListResult,
    PrError,
    InfiniteData<PrListResult, string | null>,
    readonly unknown[],
    string | null
  >({
    ...COMMON,
    queryKey: pullRequestKeys.listPages(cwd ?? "", query),
    queryFn: ({ pageParam }) => prList(cwd!, { ...query, cursor: pageParam }),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: !!cwd,
    staleTime: STALE.list,
  });
}

/** How long a detail stays fresh: a merged one barely changes, and an open
 *  one with checks still running changes fastest of all. */
export function detailStaleTime(detail: PrDetail | undefined): number {
  if (!detail) return STALE.detail;
  if (detail.state === "merged") return STALE.mergedDetail;
  if (detail.state === "open" && detail.checksState === "pending") return STALE.checks;
  return STALE.detail;
}

/** One pull request's detail. Until the first read lands, the last one kept
 *  on this machine stands in (`isPlaceholderData`), so the tab paints at
 *  once; each read that lands is kept for next time. */
export function usePrDetail(cwd: string | null, number: number | null): Result<PrDetail> {
  const query = useQuery<PrDetail, PrError>({
    ...COMMON,
    queryKey: pullRequestKeys.detail(cwd ?? "", number ?? 0),
    queryFn: () => prDetail(cwd!, number!),
    enabled: !!cwd && !!number,
    staleTime: (query) => detailStaleTime(query.state.data),
    placeholderData: () => (cwd && number ? readCachedPullRequestDetail(cwd, number) : undefined),
  });
  const fresh = query.isPlaceholderData ? undefined : query.data;
  useEffect(() => {
    if (cwd && fresh) writeCachedPullRequestDetail(cwd, fresh);
  }, [cwd, fresh]);
  return query;
}

export function usePrActivity(cwd: string | null, number: number | null): Result<PrActivity> {
  return useQuery<PrActivity, PrError>({
    ...COMMON,
    queryKey: pullRequestKeys.activity(cwd ?? "", number ?? 0),
    queryFn: () => prActivity(cwd!, number!),
    enabled: !!cwd && !!number,
    staleTime: STALE.activity,
  });
}

export function usePrTimeline(
  cwd: string | null,
  number: number | null,
  cursor: string | null = null,
): Result<PrTimelinePage> {
  return useQuery<PrTimelinePage, PrError>({
    ...COMMON,
    queryKey: pullRequestKeys.timeline(cwd ?? "", number ?? 0, cursor),
    queryFn: () => prTimeline(cwd!, number!, cursor),
    enabled: !!cwd && !!number,
    staleTime: STALE.activity,
  });
}

/** The most history pages the Timeline reads: 50 pages of 100 events. A
 *  pull request past that is cut off at its oldest 5,000, and says so. */
export const TIMELINE_PAGE_LIMIT = 50;

export interface PrTimelineHistory {
  items: PrTimelineItem[];
  /** More history than `TIMELINE_PAGE_LIMIT` pages hold. */
  truncated: boolean;
  /** Pages read. */
  pages: number;
  /** The cursor the newest page was read from, and where its items start:
   *  what a refresh re-reads (`readTimelineTail`). */
  tailCursor: string | null;
  tailStart: number;
  /** When every page was last read (epoch ms). */
  fullAt: number;
}

/** How long a refresh may re-read only the newest page before it reads the
 *  whole history again (to catch an edit to an older comment made elsewhere). */
export const TIMELINE_FULL_READ_MS = 15 * 60_000;

async function readPagesFrom(
  cwd: string,
  number: number,
  read: typeof prTimeline,
  start: { items: PrTimelineItem[]; pages: number; cursor: string | null },
): Promise<Omit<PrTimelineHistory, "fullAt">> {
  const items = start.items;
  let { pages, cursor } = start;
  let tailCursor = cursor;
  let tailStart = items.length;
  while (pages < TIMELINE_PAGE_LIMIT) {
    tailCursor = cursor;
    tailStart = items.length;
    const next: PrTimelinePage = await read(cwd, number, cursor);
    pages += 1;
    items.push(...next.items);
    cursor = next.nextCursor;
    if (cursor === null) return { items, truncated: false, pages, tailCursor, tailStart };
  }
  return { items, truncated: true, pages, tailCursor, tailStart };
}

/** Every page of the history, oldest first, followed in one read: the tab
 *  orders and groups the whole of it, so it has to have the whole of it. */
export async function readTimelineHistory(
  cwd: string,
  number: number,
  read: typeof prTimeline = prTimeline,
  now: number = Date.now(),
): Promise<PrTimelineHistory> {
  const history = await readPagesFrom(cwd, number, read, { items: [], pages: 0, cursor: null });
  return { ...history, fullAt: now };
}

/**
 * A refresh of a history already read: the pages before the newest are
 * kept, and reading resumes from the newest page's cursor. A timeline only
 * grows at its end (a new comment, review, push), so a comment posted here
 * costs one page, not fifty.
 */
export async function readTimelineTail(
  cwd: string,
  number: number,
  previous: PrTimelineHistory,
  read: typeof prTimeline = prTimeline,
): Promise<PrTimelineHistory> {
  const history = await readPagesFrom(cwd, number, read, {
    items: previous.items.slice(0, previous.tailStart),
    pages: Math.max(0, previous.pages - 1),
    cursor: previous.tailCursor,
  });
  return { ...history, fullAt: previous.fullAt };
}

/** The read a refetch makes: the tail of what is held, or the whole history
 *  when nothing is held, it was cut off, or the last full read is old. */
export function readTimelineRefresh(
  cwd: string,
  number: number,
  previous: PrTimelineHistory | undefined,
  read: typeof prTimeline = prTimeline,
  now: number = Date.now(),
): Promise<PrTimelineHistory> {
  return previous && !previous.truncated && now - previous.fullAt < TIMELINE_FULL_READ_MS
    ? readTimelineTail(cwd, number, previous, read)
    : readTimelineHistory(cwd, number, read, now);
}

export function usePrTimelineHistory(
  cwd: string | null,
  number: number | null,
  enabled = true,
): Result<PrTimelineHistory> {
  const client = useQueryClient();
  const queryKey = pullRequestKeys.timelineHistory(cwd ?? "", number ?? 0);
  return useQuery<PrTimelineHistory, PrError>({
    ...COMMON,
    queryKey,
    queryFn: () =>
      readTimelineRefresh(cwd!, number!, client.getQueryData<PrTimelineHistory>(queryKey)),
    enabled: enabled && !!cwd && !!number,
    staleTime: STALE.activity,
    // Up to fifty pages behind one read: not on every focus. A write here,
    // an agent's turn end and the slow poll still refresh it, by its tail.
    refetchOnWindowFocus: false,
  });
}

export function usePrCommits(
  cwd: string | null,
  number: number | null,
  cursor: string | null = null,
): Result<PrCommitsPage> {
  return useQuery<PrCommitsPage, PrError>({
    ...COMMON,
    queryKey: pullRequestKeys.commits(cwd ?? "", number ?? 0, cursor),
    queryFn: () => prCommits(cwd!, number!, cursor),
    enabled: !!cwd && !!number,
    staleTime: STALE.activity,
  });
}

export function usePrDiff(
  cwd: string | null,
  number: number | null,
  cursor: string | null = null,
  commit: string | null = null,
): Result<PrDiffResult> {
  return useQuery<PrDiffResult, PrError>({
    ...COMMON,
    queryKey: pullRequestKeys.diff(cwd ?? "", number ?? 0, cursor, commit),
    queryFn: () => prDiff(cwd!, number!, cursor, commit),
    enabled: !!cwd && !!number,
    staleTime: commit ? STALE.commitDiff : STALE.diff,
    // A commit's diff is immutable, and a whole patch is too large to poll.
    refetchInterval: false,
  });
}

/**
 * The diff a page at a time: whole on the first page while GitHub will send
 * it whole, else a hundred files per page, the next asked for as the reader
 * nears the end (`fetchNextPage`). A refresh re-reads every loaded page, and
 * an unchanged page keeps its identity, so its files keep their parse.
 */
export function usePrDiffPages(
  cwd: string,
  number: number,
  commit: string | null,
  /** For a reader that only peeks at what the Code tab loaded (the
   *  composer's check of pending comments): off until wanted, and no
   *  re-read of every page just because it mounted. */
  options: { enabled?: boolean; refetchOnMount?: boolean } = {},
) {
  return useInfiniteQuery<
    PrDiffResult,
    PrError,
    InfiniteData<PrDiffResult, string | null>,
    readonly unknown[],
    string | null
  >({
    retry: shouldRetryPrError,
    retryDelay: (attempt: number) => prRetryDelay(attempt),
    queryKey: pullRequestKeys.diffPages(cwd, number, commit),
    queryFn: ({ pageParam }) => prDiff(cwd, number, pageParam, commit),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: commit ? STALE.commitDiff : STALE.diff,
    // Every loaded page would be re-read: refreshed by the panel, an agent's
    // turn end, or a write that moves the code, never on a timer or focus.
    refetchInterval: false,
    refetchOnWindowFocus: false,
    enabled: options.enabled ?? true,
    refetchOnMount: options.refetchOnMount ?? true,
  });
}

/** The commits, newest last as GitHub lists them, a page at a time. */
export function usePrCommitPages(cwd: string, number: number) {
  return useInfiniteQuery<
    PrCommitsPage,
    PrError,
    InfiniteData<PrCommitsPage, string | null>,
    readonly unknown[],
    string | null
  >({
    ...COMMON,
    queryKey: pullRequestKeys.commitPages(cwd, number),
    queryFn: ({ pageParam }) => prCommits(cwd, number, pageParam),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: STALE.activity,
    refetchInterval: false,
  });
}

export function usePrFilesViewed(cwd: string | null, number: number | null): Result<PrFilesViewed> {
  return useQuery<PrFilesViewed, PrError>({
    ...COMMON,
    queryKey: pullRequestKeys.filesViewed(cwd ?? "", number ?? 0),
    queryFn: () => prFilesViewed(cwd!, number!),
    enabled: !!cwd && !!number,
    staleTime: STALE.filesViewed,
  });
}

/** The reviewer picker's rows. Read only while the picker is open
 *  (`enabled`): most readers never open it. */
export function usePrReviewerCandidates(
  cwd: string,
  number: number,
  enabled: boolean,
): Result<PrReviewerCandidates> {
  return useQuery<PrReviewerCandidates, PrError>({
    ...COMMON,
    queryKey: pullRequestKeys.reviewerCandidates(cwd, number),
    queryFn: () => prReviewerCandidates(cwd, number),
    enabled,
    staleTime: STALE.detail,
    refetchInterval: false,
  });
}

/** The label picker's rows, read only while it is open. */
export function usePrLabelCandidates(
  cwd: string,
  number: number,
  enabled: boolean,
): Result<PrLabelCandidates> {
  return useQuery<PrLabelCandidates, PrError>({
    ...COMMON,
    queryKey: pullRequestKeys.labelCandidates(cwd, number),
    queryFn: () => prLabelCandidates(cwd, number),
    enabled,
    staleTime: STALE.detail,
    refetchInterval: false,
  });
}

/** Mark every pull-request read for a checkout stale — what an agent's turn
 *  end calls, since a push is likely to have changed them. Only queries on
 *  screen refetch. */
export function invalidatePullRequestQueries(client: QueryClient, cwd: string): Promise<void> {
  return client.invalidateQueries({ queryKey: pullRequestKeys.all(cwd) });
}

// ── writes ──────────────────────────────────────────────────────────────

/** Reads a write cannot change unless it moves the code: the diff (pages of
 *  up to a hundred files each, refetched whole) and the viewed marks. */
const CODE_READS = new Set(["diff", "diff-pages", "files-viewed"]);

/** A write on one pull request; on success its reads (and the checkout's
 *  listings) are marked stale. Only a write that can move the code (`code`)
 *  also re-reads the diff: a reply refetching a 200-file diff would be
 *  pages of requests for nothing. */
function usePrMutation<V>(
  cwd: string,
  number: number,
  run: (vars: V) => Promise<void>,
  options: { listings?: boolean; code?: boolean } = {},
) {
  const client = useQueryClient();
  return useMutation<void, PrError, V>({
    mutationFn: run,
    onSuccess: async () => {
      await client.invalidateQueries({
        queryKey: pullRequestKeys.pull(cwd, number),
        predicate: options.code ? undefined : (query) => !CODE_READS.has(String(query.queryKey[4])),
      });
      if (options.listings) {
        await client.invalidateQueries({ queryKey: ["pull-requests", cwd, "list"] });
      }
    },
  });
}

export function usePrActionMutation(cwd: string, number: number) {
  return usePrMutation<PrActionInput>(cwd, number, (input) => prAction(cwd, number, input), {
    listings: true,
    code: true,
  });
}

export function usePrCommentMutation(cwd: string, number: number) {
  return usePrMutation<string>(cwd, number, (body) => prComment(cwd, number, body));
}

export function usePrReplyMutation(cwd: string, number: number) {
  return usePrMutation<{ threadId: string; body: string }>(cwd, number, ({ threadId, body }) =>
    prReplyToThread(cwd, number, threadId, body),
  );
}

export function usePrResolveMutation(cwd: string, number: number) {
  return usePrMutation<{ threadId: string; resolved: boolean }>(
    cwd,
    number,
    ({ threadId, resolved }) => prResolveThread(cwd, number, threadId, resolved),
  );
}

export function usePrReactMutation(cwd: string, number: number) {
  return usePrMutation<{ subjectId: string | null; content: PrReactionContent; reacted: boolean }>(
    cwd,
    number,
    ({ subjectId, content, reacted }) => prReact(cwd, number, subjectId, content, reacted),
  );
}

export function usePrSubmitReviewMutation(cwd: string, number: number) {
  return usePrMutation<{
    verdict: PrReviewVerdict;
    body: string;
    comments: PrReviewCommentDraft[];
  }>(
    cwd,
    number,
    ({ verdict, body, comments }) => prSubmitReview(cwd, number, verdict, body, comments),
    { listings: true },
  );
}

export function usePrUpdateMutation(cwd: string, number: number) {
  return usePrMutation<{ title: string | null; body: string | null }>(
    cwd,
    number,
    ({ title, body }) => prUpdate(cwd, number, title, body),
    { listings: true },
  );
}

export function usePrReviewersMutation(cwd: string, number: number) {
  return usePrMutation<{ reviewers: PrReviewerRef[]; requested: boolean }>(
    cwd,
    number,
    ({ reviewers, requested }) => prRequestReviewers(cwd, number, reviewers, requested),
  );
}

export function usePrLabelsMutation(cwd: string, number: number) {
  return usePrMutation<{ labels: string[]; applied: boolean }>(
    cwd,
    number,
    ({ labels, applied }) => prSetLabels(cwd, number, labels, applied),
    { listings: true },
  );
}

export function usePrEditCommentMutation(cwd: string, number: number) {
  return usePrMutation<{ commentId: string; kind: PrCommentKind; body: string }>(
    cwd,
    number,
    ({ commentId, kind, body }) => prEditComment(cwd, number, commentId, kind, body),
  );
}

export function usePrDeleteCommentMutation(cwd: string, number: number) {
  return usePrMutation<{ commentId: string; kind: PrCommentKind }>(
    cwd,
    number,
    ({ commentId, kind }) => prDeleteComment(cwd, number, commentId, kind),
  );
}

/** Revert a merged pull request: answers the one it opened, and marks this
 *  one's reads and the checkout's listings stale (the revert is a new row). */
export function usePrRevertMutation(cwd: string, number: number) {
  const client = useQueryClient();
  return useMutation<PrReverted, PrError, void>({
    mutationFn: () => prRevert(cwd, number),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: pullRequestKeys.pull(cwd, number) });
      await client.invalidateQueries({ queryKey: ["pull-requests", cwd, "list"] });
    },
  });
}

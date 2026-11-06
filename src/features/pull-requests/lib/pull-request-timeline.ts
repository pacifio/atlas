// The Timeline tab's model: a pull request's history as one list of events,
// then grouped into the rows the tab draws.
//
// The history is `pr_timeline` — every page, oldest first — which names
// each commit, comment, review and state change. The activity read adds
// what the history leaves out: reactions and edit marks on comments, line
// comments in their review threads, and each commit's diff stat. Either
// may be missing; the history alone still reads.

import type {
  PrActivity,
  PrActor,
  PrComment,
  PrLabel,
  PrReaction,
  PrReviewThread,
  PrTimelineItem,
} from "./pull-requests-types";
import {
  conversationItems,
  isVerdictStale,
  reviewOutcome,
  visibleBody,
  type ReplyAvailability,
} from "./pull-request-logic";

export type TimelineOrder = "newest" | "oldest";

export type TimelineEventKind = PrTimelineItem["kind"];

export interface TimelineCommit {
  oid: string;
  headline: string;
  authors: PrActor[];
  additions: number | null;
  deletions: number | null;
}

export interface TimelineThread
  extends Pick<PrReviewThread, "path" | "line" | "isResolved" | "isOutdated">, ReplyAvailability {
  replies: TimelineEvent[];
}

export interface TimelineEvent {
  id: string;
  at: string;
  kind: TimelineEventKind;
  actor: PrActor | null;
  /** A comment or review's body, `null` when there is nothing to show. */
  body: string | null;
  url: string | null;
  /** A line comment's file. */
  path: string | null;
  /** A review's host state word (`APPROVED`, `COMMENTED`, …). */
  reviewState: string | null;
  reactions: PrReaction[];
  editedAt: string | null;
  /** The comment behind a comment or review event, for reacting to it. */
  comment?: PrComment;
  /** A line comment that opens a review thread, with its replies. */
  thread?: TimelineThread;
  commit?: TimelineCommit;
  label?: PrLabel;
  /** Review requested: who was asked; `null` for one no longer visible. */
  reviewer?: PrActor | null;
  /** Force-pushed: the head before and after. */
  beforeOid?: string | null;
  afterOid?: string | null;
  /** Merged: the merge commit and the branch it went into. */
  mergeCommitOid?: string | null;
  baseBranch?: string | null;
}

function instant(iso: string): number {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : at;
}

function blankEvent(id: string, at: string, kind: TimelineEventKind, actor: PrActor | null) {
  return {
    id,
    at,
    kind,
    actor,
    body: null,
    url: null,
    path: null,
    reviewState: null,
    reactions: [],
    editedAt: null,
  } satisfies TimelineEvent;
}

function commentEvent(comment: PrComment): TimelineEvent {
  return {
    comment,
    id: comment.id,
    at: comment.createdAt,
    kind: comment.kind === "review" ? "review" : "comment",
    actor: comment.author,
    body: visibleBody(comment.body),
    url: comment.url,
    path: comment.path,
    reviewState: comment.reviewState,
    reactions: comment.reactions,
    editedAt: comment.editedAt,
  };
}

/** A review is worth a row when it rules or says something. One that only
 *  carries line comments (GitHub's empty `COMMENTED`) shows as its threads;
 *  a `PENDING` one is the viewer's unsent draft. */
function reviewIsShown(state: string, body: string): boolean {
  if (state.toUpperCase() === "PENDING") return false;
  return reviewOutcome(state) !== null || visibleBody(body) !== null;
}

/**
 * The history as events, oldest first. GitHub sets both a merge and a close
 * on a merged pull request; the close says nothing the merge did not, so
 * it is dropped, as GitHub's own page does.
 */
export function buildTimeline(
  items: readonly PrTimelineItem[],
  activity: Pick<PrActivity, "comments" | "reviewThreads" | "commits"> | null,
): TimelineEvent[] {
  const commentsById = new Map((activity?.comments ?? []).map((c) => [c.id, c]));
  const statsByOid = new Map((activity?.commits ?? []).map((c) => [c.oid, c]));
  const mergedAt = items.reduce<number | null>(
    (found, item) =>
      item.kind === "merged" ? Math.min(found ?? Infinity, instant(item.at)) : found,
    null,
  );
  const seen = new Set<string>();
  const events: TimelineEvent[] = [];

  for (const item of items) {
    const id = item.kind === "opened" ? "opened" : item.id;
    if (seen.has(id)) continue;
    seen.add(id);
    switch (item.kind) {
      case "opened":
        events.push(blankEvent(id, item.at, "opened", item.actor));
        break;
      case "commit": {
        const stat = statsByOid.get(item.oid);
        events.push({
          ...blankEvent(id, item.at, "commit", item.authors[0] ?? null),
          commit: {
            oid: item.oid,
            headline: item.messageHeadline,
            authors: item.authors,
            additions: stat?.additions ?? null,
            deletions: stat?.deletions ?? null,
          },
        });
        break;
      }
      case "comment": {
        const known = commentsById.get(item.id);
        events.push(
          commentEvent({
            id: item.id,
            kind: "issue-comment",
            author: item.actor,
            body: item.body,
            createdAt: item.at,
            editedAt: known?.editedAt ?? null,
            url: item.url,
            path: null,
            reviewState: null,
            reactions: known?.reactions ?? [],
            canEdit: known?.canEdit ?? false,
            canDelete: known?.canDelete ?? false,
          }),
        );
        break;
      }
      case "review": {
        if (!reviewIsShown(item.state, item.body)) break;
        const known = commentsById.get(item.id);
        events.push(
          commentEvent({
            id: item.id,
            kind: "review",
            author: item.actor,
            body: item.body,
            createdAt: item.at,
            editedAt: known?.editedAt ?? null,
            url: item.url,
            path: null,
            // The activity read knows a review was dismissed after the fact.
            reviewState: known?.reviewState ?? item.state,
            reactions: known?.reactions ?? [],
            canEdit: known?.canEdit ?? false,
            canDelete: known?.canDelete ?? false,
          }),
        );
        break;
      }
      case "merged":
        events.push({
          ...blankEvent(id, item.at, "merged", item.actor),
          mergeCommitOid: item.commitOid,
          baseBranch: item.baseBranch,
        });
        break;
      case "closed":
        if (mergedAt !== null && instant(item.at) >= mergedAt) break;
        events.push(blankEvent(id, item.at, "closed", item.actor));
        break;
      case "force-pushed":
        events.push({
          ...blankEvent(id, item.at, "force-pushed", item.actor),
          beforeOid: item.beforeOid,
          afterOid: item.afterOid,
        });
        break;
      case "review-requested":
        events.push({
          ...blankEvent(id, item.at, "review-requested", item.actor),
          reviewer: item.reviewer,
        });
        break;
      case "labeled":
      case "unlabeled":
        events.push({ ...blankEvent(id, item.at, item.kind, item.actor), label: item.label });
        break;
      case "reopened":
      case "ready-for-review":
      case "converted-to-draft":
      case "head-ref-deleted":
        events.push(blankEvent(id, item.at, item.kind, item.actor));
        break;
    }
  }

  // Line comments live in their review threads, which the history does not
  // carry: each thread joins at its first comment's time.
  const lineComments = (activity?.comments ?? []).filter((c) => c.kind === "review-comment");
  for (const entry of conversationItems(lineComments, activity?.reviewThreads ?? [])) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    if (entry.kind === "comment") {
      events.push(commentEvent(entry.comment));
      continue;
    }
    events.push({
      ...commentEvent(entry.root),
      thread: {
        path: entry.thread.path,
        line: entry.thread.line,
        isResolved: entry.thread.isResolved,
        isOutdated: entry.thread.isOutdated,
        replies: entry.replies.map(commentEvent),
        moreReplies: entry.moreReplies,
        hasMoreReplies: entry.hasMoreReplies,
        url: entry.url,
      },
    });
  }

  // Stable: events at the same instant keep the order GitHub gave them.
  return events
    .map((event, index) => ({ event, index, at: instant(event.at) }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map(({ event }) => event);
}

/** The newest commit's time, for telling a verdict on earlier changes. */
export function newestCommitTime(events: readonly TimelineEvent[]): string | null {
  let newest: string | null = null;
  for (const event of events) {
    if (event.kind !== "commit") continue;
    if (newest === null || instant(event.at) > instant(newest)) newest = event.at;
  }
  return newest;
}

export function isStaleVerdict(event: TimelineEvent, newestCommit: string | null): boolean {
  return isVerdictStale(event.at, newestCommit);
}

// ── rows ────────────────────────────────────────────────────────────────

export type TimelineRow =
  | { kind: "event"; key: string; event: TimelineEvent }
  /** Consecutive comments without a verdict or a thread, folded together. */
  | { kind: "comments"; key: string; events: TimelineEvent[] }
  /** Consecutive commits. */
  | { kind: "commits"; key: string; events: TimelineEvent[] }
  /** One person's consecutive label changes, as GitHub writes them. */
  | {
      kind: "labels";
      key: string;
      actor: PrActor | null;
      at: string;
      added: PrLabel[];
      removed: PrLabel[];
    }
  /** One person's consecutive review requests. */
  | {
      kind: "review-requests";
      key: string;
      actor: PrActor | null;
      at: string;
      reviewers: Array<PrActor | null>;
    }
  /** One person's consecutive force-pushes: the first head to the last. */
  | { kind: "force-pushes"; key: string; actor: PrActor | null; events: TimelineEvent[] };

function isLooseComment(event: TimelineEvent): boolean {
  return (
    (event.kind === "comment" || event.kind === "review") &&
    event.thread === undefined &&
    reviewOutcome(event.reviewState) === null
  );
}

function sameActor(a: PrActor | null, b: PrActor | null): boolean {
  return (a?.login ?? null) === (b?.login ?? null);
}

/**
 * The events in the order asked, grouped into rows. Grouping runs on the
 * ordered list, so a run reads the same way either direction; a row's `at`
 * is its first event's in that order.
 */
export function groupTimeline(
  events: readonly TimelineEvent[],
  order: TimelineOrder,
): TimelineRow[] {
  const ordered = order === "newest" ? [...events].reverse() : events;
  const rows: TimelineRow[] = [];
  for (const event of ordered) {
    const last = rows[rows.length - 1] as TimelineRow | undefined;
    if (isLooseComment(event)) {
      if (last?.kind === "comments") last.events.push(event);
      else rows.push({ kind: "comments", key: `comments:${event.id}`, events: [event] });
      continue;
    }
    if (event.kind === "commit") {
      if (last?.kind === "commits") last.events.push(event);
      else rows.push({ kind: "commits", key: `commits:${event.id}`, events: [event] });
      continue;
    }
    if ((event.kind === "labeled" || event.kind === "unlabeled") && event.label) {
      const target =
        last?.kind === "labels" && sameActor(last.actor, event.actor)
          ? last
          : (() => {
              const row: TimelineRow & { kind: "labels" } = {
                kind: "labels",
                key: `labels:${event.id}`,
                actor: event.actor,
                at: event.at,
                added: [],
                removed: [],
              };
              rows.push(row);
              return row;
            })();
      const [into, from] =
        event.kind === "labeled" ? [target.added, target.removed] : [target.removed, target.added];
      // Added then taken off within one run nets out to nothing.
      const undone = from.findIndex((label) => label.name === event.label!.name);
      if (undone >= 0) from.splice(undone, 1);
      else if (!into.some((label) => label.name === event.label!.name)) into.push(event.label);
      continue;
    }
    if (event.kind === "review-requested") {
      if (last?.kind === "review-requests" && sameActor(last.actor, event.actor)) {
        const login = event.reviewer?.login ?? null;
        if (login === null || !last.reviewers.some((r) => r?.login === login)) {
          last.reviewers.push(event.reviewer ?? null);
        }
      } else {
        rows.push({
          kind: "review-requests",
          key: `review-requests:${event.id}`,
          actor: event.actor,
          at: event.at,
          reviewers: [event.reviewer ?? null],
        });
      }
      continue;
    }
    if (event.kind === "force-pushed") {
      if (last?.kind === "force-pushes" && sameActor(last.actor, event.actor)) {
        last.events.push(event);
      } else {
        rows.push({
          kind: "force-pushes",
          key: `force-pushes:${event.id}`,
          actor: event.actor,
          events: [event],
        });
      }
      continue;
    }
    rows.push({ kind: "event", key: `event:${event.id}`, event });
  }
  // A label run that netted out to nothing is not worth a row.
  return rows.filter(
    (row) => row.kind !== "labels" || row.added.length > 0 || row.removed.length > 0,
  );
}

/** A force-push run's span in time order: the head it started from and the
 *  one it left, whichever way the list reads. */
export function forcePushSpan(events: readonly TimelineEvent[]): {
  beforeOid: string | null;
  afterOid: string | null;
} {
  const chronological = [...events].sort((a, b) => instant(a.at) - instant(b.at));
  return {
    beforeOid: chronological[0]?.beforeOid ?? null,
    afterOid: chronological[chronological.length - 1]?.afterOid ?? null,
  };
}

/** The distinct people in a run of events, first seen first. */
export function uniqueActors(events: readonly TimelineEvent[]): PrActor[] {
  const actors = new Map<string, PrActor>();
  for (const event of events) {
    const people = event.commit ? event.commit.authors : event.actor ? [event.actor] : [];
    for (const actor of people) if (!actors.has(actor.login)) actors.set(actor.login, actor);
  }
  return [...actors.values()];
}

export function shortOid(oid: string | null | undefined): string | null {
  return oid ? oid.slice(0, 7) : null;
}

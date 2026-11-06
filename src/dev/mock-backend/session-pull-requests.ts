// A session's linked pull requests — link, unlink and the sweep — as the fake
// backend answers them (`session_pull_requests.rs`). Shared by every handler
// map that fakes history, like `session-lifecycle.ts`: the rows are the
// map's own, and a change fires `atlas:threads-changed` as Rust's store does.
//
// A number links to the fixture repository's pull request of that number
// (`fixtures/pull-requests.ts`); one it does not have is `notFound`. The
// sweep reads nothing and changes nothing: the links' snapshots are what the
// fixtures seeded.

import type {
  PullRequestLink,
  PullRequestLinkSnapshot,
  ThreadRow,
} from "@/features/chat/lib/history-api";
import type {
  SessionPullRequestsChange,
  SessionPullRequestsSync,
} from "@/features/pull-requests/lib/session-pull-requests-api";
import type { PrListEntry } from "@/features/pull-requests/lib/pull-requests-types";
import { PULL_REQUEST_REPOSITORY, pullRequestEntry } from "./fixtures/pull-requests";
import type { MockHandlers } from "./types";

interface ThreadList {
  get: () => ThreadRow[];
  set: (rows: ThreadRow[]) => void;
  changed: () => void;
}

/** A link's snapshot, from a list row. */
export function snapshotOf(entry: PrListEntry, syncedAt = new Date().toISOString()) {
  return {
    state: entry.state,
    title: entry.title,
    headBranch: entry.headBranch,
    baseBranch: entry.baseBranch,
    isDraft: entry.isDraft,
    updatedAt: entry.updatedAt,
    mergedAt: entry.mergedAt ?? null,
    checksState: entry.checksState,
    reviewDecision: entry.reviewDecision,
    commentCount: entry.commentCount,
    syncedAt,
  } satisfies PullRequestLinkSnapshot;
}

/** A link to the fixture repository's pull request `number`, read now. */
export function fixtureLink(
  number: number,
  source: PullRequestLink["source"],
  linkedAt = new Date().toISOString(),
): PullRequestLink {
  const entry = pullRequestEntry(number);
  if (!entry) throw new Error(`no fixture pull request ${number}`);
  return {
    repository: PULL_REQUEST_REPOSITORY,
    number,
    url: entry.url,
    source,
    linkedAt,
    snapshot: snapshotOf(entry, linkedAt),
    watching: false,
  };
}

const same = (link: PullRequestLink, repository: string, number: number) =>
  link.repository.toLowerCase() === repository.toLowerCase() && link.number === number;

export function sessionPullRequestHandlers(list: ThreadList): MockHandlers {
  const change = (
    threadId: unknown,
    mutate: (links: PullRequestLink[]) => PullRequestLink[] | null,
  ): SessionPullRequestsChange => {
    const row = list.get().find((r) => r.threadId === String(threadId));
    if (!row) throw { kind: "invalid", message: "That session has no history row." };
    const next = mutate(row.pullRequests ?? []);
    if (next === null) return { pullRequests: row.pullRequests ?? [], changed: false };
    list.set(
      list.get().map((r) => (r.threadId === row.threadId ? { ...r, pullRequests: next } : r)),
    );
    list.changed();
    return { pullRequests: next, changed: true };
  };
  return {
    session_pull_requests_link: ({ threadId, number, source }): SessionPullRequestsChange =>
      change(threadId, (links) => {
        const n = Number(number);
        if (!pullRequestEntry(n)) {
          throw { kind: "notFound" };
        }
        if (links.some((l) => same(l, PULL_REQUEST_REPOSITORY, n))) return null;
        return [...links, fixtureLink(n, source === "agent" ? "agent" : "manual")];
      }),
    session_pull_requests_unlink: ({ threadId, repository, number }): SessionPullRequestsChange =>
      change(threadId, (links) => {
        const next = links.filter((l) => !same(l, String(repository), Number(number)));
        return next.length === links.length ? null : next;
      }),
    // Watching an open, linked pull request; the fake never wakes anyone.
    session_pull_requests_watch: ({
      threadId,
      repository,
      number,
      watching,
    }): SessionPullRequestsChange =>
      change(threadId, (links) => {
        const link = links.find((l) => same(l, String(repository), Number(number)));
        if (!link) {
          throw { kind: "invalid", message: "That pull request is not linked to this session." };
        }
        const on = Boolean(watching);
        if (on && link.snapshot && link.snapshot.state !== "open") {
          throw { kind: "invalid", message: "The pull request is not open." };
        }
        if (link.watching === on) return null;
        return links.map((l) => (l === link ? { ...l, watching: on } : l));
      }),
    session_pull_requests_sync: (): SessionPullRequestsSync => ({
      read: 0,
      detected: 0,
      changed: 0,
      skipped: false,
    }),
  };
}

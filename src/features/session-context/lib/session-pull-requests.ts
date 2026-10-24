// The session's pull requests, as the overlay lists them: every pull request
// linked to the session (opened from it, found on its branch, linked by the
// user or the agent — `ThreadRow.pullRequests`), together with the branch's
// own pull requests read live (`pr_list` with a `head:` filter), so one
// opened a moment ago shows before the sweep records it.
//
// The first row is the one that matters now (an open one, if any); the rest
// fold under "Show N more".

import { useMemo } from "react";

import type { PullRequestLink } from "@/features/chat/lib/history-api";
import { usePrList } from "@/features/pull-requests/lib/pull-requests-queries";
import type {
  PrChecksState,
  PrListEntry,
  PrState,
} from "@/features/pull-requests/lib/pull-requests-types";
import { useThreadHistory } from "./session-lineage";

/** How many of the branch's pull requests to ask for. */
const LIMIT = 20;

/** One overlay row: a linked pull request or one of the branch's. */
export interface SessionPullRequest {
  number: number;
  title: string;
  url: string;
  state: PrState;
  isDraft: boolean;
  checksState: PrChecksState | null;
  updatedAt: string;
  /** How it is linked; `null` for a branch pull request not linked yet. */
  source: PullRequestLink["source"] | null;
}

export interface SessionPullRequests {
  /** The open one when there is one, else the most recently active. */
  current: SessionPullRequest | null;
  /** The rest, newest activity first. */
  rest: SessionPullRequest[];
  /** Whether any is open (Create PR steps aside). */
  hasOpen: boolean;
  loading: boolean;
  /** The session's history row id, which a link is recorded against;
   *  `null` before the session has one. */
  threadId: string | null;
  /** What is linked already, for the link dialog. */
  links: PullRequestLink[];
}

function fromLink(link: PullRequestLink): SessionPullRequest {
  const snapshot = link.snapshot;
  return {
    number: link.number,
    title: snapshot?.title ?? `${link.repository}#${link.number}`,
    url: link.url,
    state: snapshot?.state ?? "open",
    isDraft: snapshot?.isDraft ?? false,
    checksState: snapshot?.checksState ?? null,
    updatedAt: snapshot?.updatedAt ?? link.linkedAt,
    source: link.source,
  };
}

function fromEntry(entry: PrListEntry): SessionPullRequest {
  return {
    number: entry.number,
    title: entry.title,
    url: entry.url,
    state: entry.state,
    isDraft: entry.isDraft,
    checksState: entry.checksState,
    updatedAt: entry.updatedAt,
    source: null,
  };
}

/** The links, then the branch's pull requests not linked yet. A branch read
 *  is fresher than a link's snapshot, so its state wins where both exist. */
export function mergeSessionPullRequests(
  links: readonly PullRequestLink[],
  branch: readonly PrListEntry[],
): SessionPullRequest[] {
  const live = new Map(branch.map((entry) => [entry.url.toLowerCase(), entry]));
  const merged = links.map((link) => {
    const entry = live.get(link.url.toLowerCase());
    live.delete(link.url.toLowerCase());
    return entry ? { ...fromEntry(entry), source: link.source } : fromLink(link);
  });
  return [...merged, ...[...live.values()].map(fromEntry)];
}

/** Split into the one to show and the rest. */
export function orderSessionPullRequests<T extends { state: PrState; updatedAt: string }>(
  entries: readonly T[],
): { current: T | null; rest: T[] } {
  const sorted = [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const open = sorted.find((e) => e.state === "open") ?? null;
  const current = open ?? sorted[0] ?? null;
  return { current, rest: sorted.filter((e) => e !== current) };
}

export function useSessionPullRequests(
  projectPath: string | null,
  branch: string | null,
  sessionId: string | null,
): SessionPullRequests {
  const query = useMemo(() => ({ state: "all" as const, head: branch, limit: LIMIT }), [branch]);
  const list = usePrList(branch ? projectPath : null, query);
  const rows = useThreadHistory(!!sessionId);
  const row = sessionId ? rows.find((r) => r.sessionId === sessionId) : undefined;
  const links = row?.pullRequests;
  return useMemo(() => {
    const merged = mergeSessionPullRequests(links ?? [], list.data?.entries ?? []);
    const { current, rest } = orderSessionPullRequests(merged);
    return {
      current,
      rest,
      hasOpen: current?.state === "open",
      loading: list.isLoading,
      threadId: row?.threadId ?? null,
      links: links ?? [],
    };
  }, [links, list.data, list.isLoading, row?.threadId]);
}

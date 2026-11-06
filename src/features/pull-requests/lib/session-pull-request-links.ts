/**
 * What a session's linked pull requests read as: the one that matters now,
 * the sidebar badge, the order a list shows them in, and the words a search
 * matches them by. Pure, over `ThreadRow.pullRequests`.
 *
 * The wire carries only the visible links (an unlinked one is a tombstone in
 * the store and never leaves Rust), so nothing here filters.
 */

import type { PullRequestLink } from "@/features/chat/lib/history-api";

import { resolveSessionPullRequestChains } from "./session-pull-request-chains";

/** The state a link shows: a draft is an open pull request marked draft;
 *  a link the host has not been read for yet counts as open. */
export type PullRequestLinkState = "open" | "draft" | "closed" | "merged";

export function linkState(link: PullRequestLink): PullRequestLinkState {
  const snapshot = link.snapshot;
  if (!snapshot) return "open";
  if (snapshot.state === "open" && snapshot.isDraft) return "draft";
  return snapshot.state;
}

const isOpen = (link: PullRequestLink) => !link.snapshot || link.snapshot.state === "open";

/** The host's last activity, else when it was linked; 0 when unreadable. */
function activityMs(link: PullRequestLink): number {
  const ms = Date.parse(link.snapshot?.updatedAt ?? link.linkedAt);
  return Number.isNaN(ms) ? 0 : ms;
}

/** The identity of a link: `owner/name#number`, case-folded. */
export function linkKey(link: Pick<PullRequestLink, "repository" | "number">): string {
  return `${link.repository.toLowerCase()}#${link.number}`;
}

/**
 * Newest first: the open ones (most recently linked first, since the newest
 * link is the work in hand), then the rest by last activity.
 */
export function orderLinks(links: readonly PullRequestLink[]): PullRequestLink[] {
  const linked = (l: PullRequestLink) => Date.parse(l.linkedAt) || 0;
  const open = links.filter(isOpen).sort((a, b) => linked(b) - linked(a));
  const rest = links.filter((l) => !isOpen(l)).sort((a, b) => activityMs(b) - activityMs(a));
  return [...open, ...rest];
}

/** The one that matters now: the newest open one, else the last active. */
export function currentLink(links: readonly PullRequestLink[]): PullRequestLink | null {
  return orderLinks(links)[0] ?? null;
}

/** The sidebar badge: the current link, how many others there are, and the
 *  state they add up to. */
export interface PullRequestBadge {
  link: PullRequestLink;
  others: number;
  /** Two or more links, all in one chain derived from base branches: the
   *  badge reads as a stack of `others + 1`. */
  stacked: boolean;
  /** `draft` when every one is an open draft; `open` when any is open;
   *  `merged` when all merged; else `closed`. */
  state: PullRequestLinkState;
}

export function pullRequestBadge(
  links: readonly PullRequestLink[] | undefined,
): PullRequestBadge | null {
  const all = links ?? [];
  const link = currentLink(all);
  if (!link) return null;
  const states = all.map(linkState);
  const state: PullRequestLinkState = states.every((s) => s === "draft")
    ? "draft"
    : states.some((s) => s === "open" || s === "draft")
      ? "open"
      : states.every((s) => s === "merged")
        ? "merged"
        : "closed";
  const stacked = all.length > 1 && resolveSessionPullRequestChains(all).length === 1;
  return { link, others: all.length - 1, state, stacked };
}

/** The words a session search matches its pull requests by. */
export function pullRequestSearchTerms(links: readonly PullRequestLink[] | undefined): string[] {
  return (links ?? []).flatMap((link) => [
    `#${link.number}`,
    `${link.repository}#${link.number}`,
    link.url,
    link.snapshot?.title ?? "",
  ]);
}

/** How a link came to be, in a few words for a tooltip. */
export const LINK_SOURCE_LABEL: Record<PullRequestLink["source"], string> = {
  created: "Opened from this session",
  detected: "Found on the session's branch",
  manual: "Linked by you",
  agent: "Linked by the agent",
};

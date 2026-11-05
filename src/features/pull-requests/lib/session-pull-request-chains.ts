/**
 * A session's linked pull requests as chains: a pull request whose base
 * branch is another linked pull request's head (in the same repository) sits
 * on it. Only chains derived from base branches; GitHub has no native stacks
 * to read. Pure, over `ThreadRow.pullRequests`, for the session's pull
 * request panel, the sidebar badge and its hover list.
 *
 * Unlike the repository list's stacks (`resolvePullRequestStacks`), closed and
 * merged links stay in their chain: a session's panel shows what it shipped
 * too, and a merged base still explains why the layer above it exists.
 */

import type { PullRequestLink } from "@/features/chat/lib/history-api";

/** `owner/name#number`, case-folded: `linkKey`, restated so the badge in
 *  `session-pull-request-links.ts` can read chains without an import cycle. */
const linkKey = (link: Pick<PullRequestLink, "repository" | "number">) =>
  `${link.repository.toLowerCase()}#${link.number}`;

export interface SessionPullRequestChain {
  /** Base first; a parent before its children. */
  layers: PullRequestLink[];
  /** One per layer: 0 for the base, the parent's depth + 1 above it.
   *  Siblings share a depth. */
  depths: number[];
}

/** One row of a flattened list: the link, how deep it sits, and on a
 *  chain's first row the chain's size. */
export interface SessionPullRequestLine {
  link: PullRequestLink;
  depth: number;
  /** The key of the chain's base, shared by every row of one chain. */
  chainKey: string;
  /** On the base row of a chain of two or more; `null` elsewhere. */
  chain: { size: number } | null;
}

const repoOf = (link: PullRequestLink) => link.repository.toLowerCase();
const branchKey = (link: PullRequestLink, branch: string) => `${repoOf(link)}:${branch}`;

/**
 * Chains derived from base branches. A head branch two links share is
 * ambiguous and links nothing. Every link lands in exactly one chain, a lone
 * one in a chain of one, in the order the links came.
 */
export function resolveSessionPullRequestChains(
  links: readonly PullRequestLink[],
): SessionPullRequestChain[] {
  const byHead = new Map<string, PullRequestLink | null>();
  for (const link of links) {
    if (!link.snapshot) continue;
    const key = branchKey(link, link.snapshot.headBranch);
    byHead.set(key, byHead.has(key) ? null : link);
  }
  const parentOf = (link: PullRequestLink) => {
    if (!link.snapshot) return undefined;
    const parent = byHead.get(branchKey(link, link.snapshot.baseBranch));
    return parent == null || parent === link ? undefined : parent;
  };
  const children = new Map<string, PullRequestLink[]>();
  for (const link of links) {
    const parent = parentOf(link);
    if (!parent) continue;
    const key = linkKey(parent);
    const siblings = children.get(key) ?? [];
    siblings.push(link);
    children.set(key, siblings);
  }

  const chains: SessionPullRequestChain[] = [];
  const placed = new Set<string>();
  for (const base of links) {
    if (parentOf(base) !== undefined) continue;
    const layers: PullRequestLink[] = [];
    const depths: number[] = [];
    const pending = [{ link: base, depth: 0 }];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const key = linkKey(next.link);
      // Two links with one identity would otherwise share a child list and
      // expand forever.
      if (placed.has(key)) continue;
      placed.add(key);
      layers.push(next.link);
      depths.push(next.depth);
      const below = children.get(key) ?? [];
      for (let index = below.length - 1; index >= 0; index -= 1) {
        pending.push({ link: below[index]!, depth: next.depth + 1 });
      }
    }
    if (layers.length > 0) chains.push({ layers, depths });
  }
  // A cycle of bases (a → b → a) has no root; each member stands alone.
  for (const link of links) {
    if (!placed.has(linkKey(link))) {
      placed.add(linkKey(link));
      chains.push({ layers: [link], depths: [0] });
    }
  }
  return chains;
}

/** The host's last activity, else when it was linked; 0 when unreadable. */
function activityMs(link: PullRequestLink): number {
  const ms = Date.parse(link.snapshot?.updatedAt ?? link.linkedAt);
  return Number.isNaN(ms) ? 0 : ms;
}

/** The chains as rows: the most recently active chain first, each chain
 *  base first. */
export function sessionPullRequestLines(
  chains: readonly SessionPullRequestChain[],
): SessionPullRequestLine[] {
  const latest = (chain: SessionPullRequestChain) => Math.max(...chain.layers.map(activityMs));
  const ordered = [...chains].sort((a, b) => latest(b) - latest(a));
  return ordered.flatMap((chain) => {
    const chainKey = linkKey(chain.layers[0]!);
    return chain.layers.map((link, index) => ({
      link,
      depth: chain.depths[index]!,
      chainKey,
      chain: index === 0 && chain.layers.length > 1 ? { size: chain.layers.length } : null,
    }));
  });
}

/** The links as panel rows, in one call. */
export function sessionPullRequestRows(
  links: readonly PullRequestLink[],
): SessionPullRequestLine[] {
  return sessionPullRequestLines(resolveSessionPullRequestChains(links));
}

/** The latest time the host was read for any link; `null` before any was. */
export function latestSyncedAt(links: readonly PullRequestLink[]): string | null {
  let latest: string | null = null;
  for (const link of links) {
    const at = link.snapshot?.syncedAt;
    if (at && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

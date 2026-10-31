import { describe, expect, it } from "vitest";

import type { PullRequestLink, PullRequestLinkSnapshot } from "@/features/chat/lib/history-api";

import {
  latestSyncedAt,
  resolveSessionPullRequestChains,
  sessionPullRequestRows,
} from "./session-pull-request-chains";
import { pullRequestBadge } from "./session-pull-request-links";

function link(
  number: number,
  head: string,
  base = "main",
  over: Partial<PullRequestLink> = {},
  snap: Partial<PullRequestLinkSnapshot> = {},
): PullRequestLink {
  return {
    repository: "acme/shop",
    number,
    url: `https://github.com/acme/shop/pull/${number}`,
    source: "manual",
    linkedAt: "2026-10-01T00:00:00Z",
    watching: false,
    snapshot: {
      state: "open",
      title: `PR ${number}`,
      headBranch: head,
      baseBranch: base,
      isDraft: false,
      updatedAt: `2026-10-${String(number % 28).padStart(2, "0")}T00:00:00Z`,
      checksState: null,
      reviewDecision: null,
      commentCount: null,
      syncedAt: "2026-10-20T00:00:00Z",
      ...snap,
    },
    ...over,
  };
}

describe("resolveSessionPullRequestChains", () => {
  it("chains a pull request onto the one whose head is its base", () => {
    const chains = resolveSessionPullRequestChains([
      link(3, "c", "b"),
      link(1, "a"),
      link(2, "b", "a"),
      link(9, "z"),
    ]);
    expect(chains.map((c) => c.layers.map((l) => l.number))).toEqual([[1, 2, 3], [9]]);
    expect(chains[0]!.depths).toEqual([0, 1, 2]);
  });

  it("puts siblings at one depth, and keeps merged layers in the chain", () => {
    const chains = resolveSessionPullRequestChains([
      link(1, "a", "main", {}, { state: "merged" }),
      link(2, "b", "a"),
      link(3, "c", "a"),
    ]);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.depths).toEqual([0, 1, 1]);
  });

  it("links nothing on an ambiguous head, across repositories, or without a snapshot", () => {
    const twins = resolveSessionPullRequestChains([link(1, "a"), link(2, "a"), link(3, "b", "a")]);
    expect(twins).toHaveLength(3);
    const other = resolveSessionPullRequestChains([
      link(1, "a"),
      link(2, "b", "a", { repository: "acme/docs" }),
    ]);
    expect(other).toHaveLength(2);
    const unread = resolveSessionPullRequestChains([{ ...link(1, "a"), snapshot: null }]);
    expect(unread).toHaveLength(1);
  });

  it("stands each member of a cycle alone instead of walking forever", () => {
    const chains = resolveSessionPullRequestChains([link(1, "a", "b"), link(2, "b", "a")]);
    expect(chains.flatMap((c) => c.layers.map((l) => l.number)).sort()).toEqual([1, 2]);
  });
});

describe("sessionPullRequestRows", () => {
  it("orders chains by latest activity and marks the base row with the size", () => {
    const rows = sessionPullRequestRows([link(1, "a"), link(2, "b", "a"), link(5, "z")]);
    expect(rows.map((r) => [r.link.number, r.depth, r.chain?.size ?? null])).toEqual([
      [5, 0, null],
      [1, 0, 2],
      [2, 1, null],
    ]);
  });

  it("reads the latest sync", () => {
    expect(
      latestSyncedAt([
        link(1, "a"),
        link(2, "b", "main", {}, { syncedAt: "2026-10-22T00:00:00Z" }),
      ]),
    ).toBe("2026-10-22T00:00:00Z");
    expect(latestSyncedAt([])).toBeNull();
  });
});

describe("pullRequestBadge stacking", () => {
  it("is a stack when every link sits in one chain", () => {
    expect(pullRequestBadge([link(1, "a"), link(2, "b", "a")])?.stacked).toBe(true);
    expect(pullRequestBadge([link(1, "a"), link(2, "z")])?.stacked).toBe(false);
    expect(pullRequestBadge([link(1, "a")])?.stacked).toBe(false);
  });
});

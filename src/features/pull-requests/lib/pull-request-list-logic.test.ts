import { describe, expect, it } from "vitest";

import {
  collectPullRequestListFacets,
  groupPullRequestsByInvolvement,
  matchesPullRequestFilters,
  matchesPullRequestQuery,
  rankPullRequestsByMergeReadiness,
  scorePullRequestMatch,
  sortPullRequestGroups,
  applyPullRequestOverrides,
  pullRequestOverrideAfterAction,
  pullRequestQuickActions,
  pullRequestStatsToRequest,
  resolvePullRequestStacks,
  resolveSweepKeys,
  settlePullRequestOverrides,
} from "./pull-request-list-logic";
import {
  DEFAULT_PULL_REQUEST_LIST_PREFERENCES,
  decodePullRequestListPreferences,
  readPullRequestListPreferences,
  readPullRequestListSnapshot,
  writePullRequestListPreferences,
  writePullRequestListSnapshot,
} from "./pull-request-list-preferences";
import { classifyChangedFile, toChangeBreakdown } from "./pull-request-change-breakdown";
import type { PrAction, PrProvider } from "./pull-requests-types";
import type { PrListEntry } from "./pull-requests-types";

function entry(number: number, over: Partial<PrListEntry> = {}): PrListEntry {
  return {
    number,
    title: `Change ${number}`,
    url: `https://github.com/acme/shop/pull/${number}`,
    author: { login: "someone", name: null, avatarUrl: null, isBot: false },
    headBranch: `branch-${number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 10,
    deletions: 2,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-10T00:00:00Z",
    viewerReviewRequested: false,
    labels: [],
    reviewDecision: null,
    checksState: null,
    commentCount: 0,
    ...over,
  };
}

const me = { login: "Uzayer", name: null, avatarUrl: null, isBot: false };

describe("groupPullRequestsByInvolvement", () => {
  it("puts the viewer's own first, then review requests, then the rest", () => {
    const groups = groupPullRequestsByInvolvement(
      [entry(1), entry(2, { viewerReviewRequested: true }), entry(3, { author: me })],
      "uzayer",
    );
    expect(groups.map((g) => [g.key, g.entries.map((e) => e.number)])).toEqual([
      ["authored", [3]],
      ["reviewRequested", [2]],
      ["others", [1]],
    ]);
  });
  it("puts everything under Others with no viewer", () => {
    expect(groupPullRequestsByInvolvement([entry(1, { author: me })], null)[0]!.key).toBe("others");
  });
});

describe("filters and search", () => {
  it("narrows by draft, review, checks, author and labels", () => {
    const pr = entry(1, {
      isDraft: true,
      reviewDecision: "approved",
      checksState: "passing",
      author: me,
      labels: [{ name: "Bug", color: null }],
    });
    expect(matchesPullRequestFilters(pr, { draft: "only" }, null)).toBe(true);
    expect(matchesPullRequestFilters(pr, { draft: "hide" }, null)).toBe(false);
    expect(matchesPullRequestFilters(pr, { review: "none" }, null)).toBe(false);
    expect(matchesPullRequestFilters(pr, { checks: "failing" }, null)).toBe(false);
    expect(matchesPullRequestFilters(pr, { author: "@me" }, "uzayer")).toBe(true);
    expect(matchesPullRequestFilters(pr, { labels: [["bug"]] }, null)).toBe(true);
    expect(matchesPullRequestFilters(pr, { labels: [["bug"], ["ui"]] }, null)).toBe(false);
  });
  it("matches what the row shows, and scores a number exactly", () => {
    const pr = entry(42, { title: "Add discount codes", headBranch: "feature/discounts" });
    expect(matchesPullRequestQuery(pr, "#42")).toBe(true);
    expect(matchesPullRequestQuery(pr, "discounts")).toBe(true);
    expect(scorePullRequestMatch(pr, "42")).toBe(100);
    expect(scorePullRequestMatch(pr, "4")).toBe(0);
    expect(scorePullRequestMatch(pr, "add discount codes")).toBe(90);
    expect(scorePullRequestMatch(pr, "nowhere")).toBe(10);
  });
});

describe("sorting", () => {
  it("ranks ready to merge first and conflicts last", () => {
    const ranked = rankPullRequestsByMergeReadiness([
      entry(1, { mergeability: "conflicting" }),
      entry(2, { checksState: "passing", reviewDecision: "approved" }),
      entry(3, { isDraft: true }),
      entry(4, { checksState: "passing" }),
    ]);
    expect(ranked.map((e) => e.number)).toEqual([2, 4, 3, 1]);
  });
  it("sorts within each group and keeps relevance order while searching", () => {
    const groups = [
      {
        key: "others" as const,
        label: "Others",
        entries: [
          entry(1, { createdAt: "2026-09-01T00:00:00Z", additions: 500 }),
          entry(2, { createdAt: "2026-10-05T00:00:00Z", additions: 1 }),
        ],
      },
    ];
    const order = (sort: Parameters<typeof sortPullRequestGroups>[1], q = "") =>
      sortPullRequestGroups(groups, sort, q)[0]!.entries.map((e) => e.number);
    expect(order("newest")).toEqual([2, 1]);
    expect(order("oldest")).toEqual([1, 2]);
    expect(order("largest")).toEqual([1, 2]);
    expect(order("smallest")).toEqual([2, 1]);
    expect(order("ready", "change")).toEqual([1, 2]);
  });
});

describe("facets", () => {
  it("counts authors by merges and labels by use", () => {
    const facets = collectPullRequestListFacets(
      [
        entry(1, { author: me, state: "merged" }),
        entry(2, { author: me, labels: [{ name: "ui", color: "ff0000" }] }),
        entry(3, {
          labels: [
            { name: "UI", color: null },
            { name: "bug", color: null },
          ],
        }),
      ],
      "open",
    );
    expect(facets.authors.map((a) => [a.actor.login, a.count, a.mergedCount])).toEqual([
      ["Uzayer", 1, 1],
      ["someone", 1, 0],
    ]);
    expect(facets.labels.map((l) => [l.name, l.count])).toEqual([
      ["ui", 2],
      ["bug", 1],
    ]);
  });
});

describe("preferences", () => {
  it("keeps what is valid and drops the rest", () => {
    const prefs = decodePullRequestListPreferences({
      state: "merged",
      involvement: "bogus",
      sort: "largest",
      filters: { draft: "hide", review: "maybe", labels: ["bug", 3] },
    });
    expect(prefs).toEqual({
      state: "merged",
      involvement: "all",
      sort: "largest",
      filters: { draft: "hide", labels: ["bug"] },
    });
  });
  it("round-trips through storage, and survives storage that throws", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    const prefs = { ...DEFAULT_PULL_REQUEST_LIST_PREFERENCES, state: "all" as const };
    writePullRequestListPreferences(prefs, storage);
    expect(readPullRequestListPreferences(storage)).toEqual(prefs);
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => writePullRequestListPreferences(prefs, broken)).not.toThrow();
    expect(readPullRequestListPreferences(broken)).toEqual(DEFAULT_PULL_REQUEST_LIST_PREFERENCES);
  });
});

describe("label groups and exclusions", () => {
  it("holds a group by any of its labels, and fails on an excluded one", () => {
    const pr = entry(1, {
      labels: [
        { name: "Bug", color: null },
        { name: "wip", color: null },
      ],
    });
    expect(matchesPullRequestFilters(pr, { labels: [["ui", "bug"]] }, null)).toBe(true);
    expect(matchesPullRequestFilters(pr, { labels: [["ui", "ux"]] }, null)).toBe(false);
    expect(matchesPullRequestFilters(pr, { excludedLabels: ["WIP"] }, null)).toBe(false);
    expect(matchesPullRequestFilters(pr, { excludedLabels: ["stale"] }, null)).toBe(true);
  });
});

describe("pullRequestQuickActions", () => {
  const all = new Set<PrAction>(["close", "merge", "ready", "reopen"]);

  it("offers what the state allows", () => {
    expect(pullRequestQuickActions({ state: "open", isDraft: false }, all)).toEqual([
      "close",
      "merge",
    ]);
    expect(pullRequestQuickActions({ state: "open", isDraft: true }, all)).toEqual([
      "close",
      "ready",
    ]);
    expect(pullRequestQuickActions({ state: "closed", isDraft: false }, all)).toEqual(["reopen"]);
    expect(pullRequestQuickActions({ state: "merged", isDraft: false }, all)).toEqual([]);
  });

  it("offers only what the host can do", () => {
    expect(
      pullRequestQuickActions({ state: "open", isDraft: false }, new Set<PrAction>(["close"])),
    ).toEqual(["close"]);
  });
});

describe("resolveSweepKeys", () => {
  const ordered = [1, 2, 3, 4, 5];

  it("covers origin to target either way, keeping what it can close", () => {
    expect(resolveSweepKeys(ordered, 2, 4, () => true)).toEqual([2, 3, 4]);
    expect(resolveSweepKeys(ordered, 4, 2, () => true)).toEqual([2, 3, 4]);
    expect(resolveSweepKeys(ordered, 1, 5, (n) => n !== 3)).toEqual([1, 2, 4, 5]);
  });

  it("covers nothing for a row no longer listed", () => {
    expect(resolveSweepKeys(ordered, 9, 2, () => true)).toEqual([]);
  });
});

describe("optimistic rows", () => {
  const now = new Date("2026-10-24T12:00:00Z");

  it("shows the action's state and drops rows the state filter hides", () => {
    const close = pullRequestOverrideAfterAction(entry(1), "close", now, 1)!;
    const ready = pullRequestOverrideAfterAction(entry(2, { isDraft: true }), "ready", now, 2)!;
    const overrides = new Map([
      [1, close],
      [2, ready],
    ]);
    const rows = [entry(1), entry(2, { isDraft: true }), entry(3)];
    expect(applyPullRequestOverrides(rows, overrides, "open").map((e) => e.number)).toEqual([2, 3]);
    expect(applyPullRequestOverrides(rows, overrides, "open")[0]!.isDraft).toBe(false);
    expect(applyPullRequestOverrides(rows, overrides, "all")[0]!.state).toBe("closed");
    expect(applyPullRequestOverrides(rows, new Map(), "open")).toBe(rows);
    expect(pullRequestOverrideAfterAction(entry(1), "update-branch", now, 3)).toBeNull();
  });

  it("clears an override once the host agrees, or a minute on", () => {
    const close = pullRequestOverrideAfterAction(entry(1), "close", now, 1)!;
    const overrides = new Map([[1, close]]);
    const at = now.getTime();
    expect(settlePullRequestOverrides(overrides, [entry(1)], at + 1000)).toBe(overrides);
    expect(settlePullRequestOverrides(overrides, [], at + 1000)).toBe(overrides);
    expect(settlePullRequestOverrides(overrides, [entry(1, { state: "closed" })], at).size).toBe(0);
    expect(settlePullRequestOverrides(overrides, [entry(1)], at + 61_000).size).toBe(0);
  });
});

describe("resolvePullRequestStacks", () => {
  it("chains open pull requests by base branch, base first, siblings sharing a depth", () => {
    const base = entry(10, { headBranch: "a" });
    const mid = entry(11, { headBranch: "b", baseBranch: "a" });
    const top = entry(12, { headBranch: "c", baseBranch: "b" });
    const side = entry(13, { headBranch: "d", baseBranch: "a" });
    const lone = entry(14, { headBranch: "e" });
    const stacks = resolvePullRequestStacks([top, lone, side, mid, base]);
    const chain = stacks.get(12)!.chain;
    expect(chain.layers.map((e) => e.number)).toEqual([10, 11, 12, 13]);
    expect(chain.depths).toEqual([0, 1, 2, 1]);
    expect(stacks.get(11)).toMatchObject({ position: 2, size: 4 });
    expect(stacks.has(14)).toBe(false);
  });

  it("links nothing through a closed one, a shared head or a fork", () => {
    expect(
      resolvePullRequestStacks([
        entry(1, { headBranch: "a", state: "merged" }),
        entry(2, { headBranch: "b", baseBranch: "a" }),
      ]).size,
    ).toBe(0);
    expect(
      resolvePullRequestStacks([
        entry(1, { headBranch: "a" }),
        entry(2, { headBranch: "a" }),
        entry(3, { headBranch: "b", baseBranch: "a" }),
      ]).size,
    ).toBe(0);
    expect(
      resolvePullRequestStacks([
        entry(1, { headBranch: "a" }),
        entry(2, { headBranch: "b", baseBranch: "a", isCrossRepository: true }),
      ]).size,
    ).toBe(0);
  });

  it("survives two pull requests based on each other", () => {
    expect(() =>
      resolvePullRequestStacks([
        entry(1, { headBranch: "a", baseBranch: "b" }),
        entry(2, { headBranch: "b", baseBranch: "a" }),
      ]),
    ).not.toThrow();
  });
});

describe("pullRequestStatsToRequest", () => {
  it("asks for rows on screen not held or in flight, once each", () => {
    expect(pullRequestStatsToRequest([1, 2, 3, 2, 4], new Set([1]), new Set([3]))).toEqual([2, 4]);
  });
});

describe("change breakdown", () => {
  it("sorts files by what they are", () => {
    expect(classifyChangedFile("src/cart/total.ts")).toBe("code");
    expect(classifyChangedFile("src/cart/total.test.ts")).toBe("tests");
    expect(classifyChangedFile("tests/cart.rs")).toBe("tests");
    expect(classifyChangedFile("src/__fixtures__/cart.json")).toBe("mocks");
    expect(classifyChangedFile("src/__snapshots__/a.snap")).toBe("mocks");
    expect(classifyChangedFile("bun.lock")).toBe("generated");
    expect(classifyChangedFile("dist/app.min.js")).toBe("generated");
    expect(classifyChangedFile("docs/guide.md")).toBe("docs");
    expect(classifyChangedFile("requirements.txt")).toBe("code");
    expect(classifyChangedFile("src/LatestTest.java")).toBe("tests");
    expect(classifyChangedFile("src/Latest.java")).toBe("code");
  });

  it("adds files up by kind, and refuses a partial split", () => {
    const files = [
      { path: "src/a.ts", additions: 5, deletions: 1 },
      { path: "src/b.ts", additions: 2, deletions: 0 },
      { path: "src/a.test.ts", additions: 3, deletions: 2 },
    ];
    const split = toChangeBreakdown({ files, filesTruncated: false })!;
    expect(split.code).toEqual({ additions: 7, deletions: 1 });
    expect(split.tests).toEqual({ additions: 3, deletions: 2 });
    expect(split.generated).toEqual({ additions: 0, deletions: 0 });
    expect(toChangeBreakdown({ files, filesTruncated: true })).toBeNull();
  });
});

describe("the list snapshot", () => {
  const provider = { kind: "github", repository: "acme/shop" } as unknown as PrProvider;

  function memory() {
    const held = new Map<string, string>();
    return {
      getItem: (key: string) => held.get(key) ?? null,
      setItem: (key: string, value: string) => void held.set(key, value),
    };
  }

  it("reads back what was written for the same checkout and listing", () => {
    const store = memory();
    writePullRequestListSnapshot("/repo", { scope: "s", provider, entries: [entry(1)] }, store);
    expect(readPullRequestListSnapshot("/repo", "s", store)?.entries.map((e) => e.number)).toEqual([
      1,
    ]);
    expect(readPullRequestListSnapshot("/repo", "other", store)).toBeNull();
    expect(readPullRequestListSnapshot("/elsewhere", "s", store)).toBeNull();
  });

  it("refuses rows that are not rows, and survives storage that throws", () => {
    const store = memory();
    store.setItem(
      "atlas.pullRequests.list:/repo",
      JSON.stringify({ scope: "s", provider, entries: [{ number: "1" }] }),
    );
    expect(readPullRequestListSnapshot("/repo", "s", store)).toBeNull();
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readPullRequestListSnapshot("/repo", "s", broken)).toBeNull();
    expect(() =>
      writePullRequestListSnapshot("/repo", { scope: "s", provider, entries: [] }, broken),
    ).not.toThrow();
  });
});

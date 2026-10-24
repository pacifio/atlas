import { describe, expect, it } from "vitest";

import type { PullRequestLink, PullRequestLinkSnapshot } from "@/features/chat/lib/history-api";

import {
  currentLink,
  linkKey,
  linkState,
  orderLinks,
  pullRequestBadge,
  pullRequestSearchTerms,
} from "./session-pull-request-links";

function snapshot(over: Partial<PullRequestLinkSnapshot> = {}): PullRequestLinkSnapshot {
  return {
    state: "open",
    title: "Add discounts",
    headBranch: "feature/discounts",
    baseBranch: "main",
    isDraft: false,
    updatedAt: "2026-10-20T10:00:00Z",
    checksState: null,
    reviewDecision: null,
    commentCount: null,
    syncedAt: "2026-10-20T10:01:00Z",
    ...over,
  };
}

function link(
  number: number,
  over: Partial<PullRequestLink> = {},
  snap: Partial<PullRequestLinkSnapshot> | null = {},
): PullRequestLink {
  return {
    repository: "acme/shop",
    number,
    url: `https://github.com/acme/shop/pull/${number}`,
    source: "manual",
    linkedAt: "2026-10-01T00:00:00Z",
    snapshot: snap === null ? null : snapshot(snap),
    watching: false,
    ...over,
  };
}

describe("linkState", () => {
  it("reads an unread link as open and an open draft as draft", () => {
    expect(linkState(link(1, {}, null))).toBe("open");
    expect(linkState(link(1, {}, { isDraft: true }))).toBe("draft");
    expect(linkState(link(1, {}, { state: "merged", isDraft: true }))).toBe("merged");
  });
});

describe("orderLinks / currentLink", () => {
  it("puts the newest-linked open one first, then the rest by activity", () => {
    const merged = link(1, {}, { state: "merged", updatedAt: "2026-10-23T00:00:00Z" });
    const closed = link(2, {}, { state: "closed", updatedAt: "2026-10-10T00:00:00Z" });
    const oldOpen = link(3, { linkedAt: "2026-10-02T00:00:00Z" });
    const newOpen = link(4, { linkedAt: "2026-10-05T00:00:00Z" });
    expect(orderLinks([merged, closed, oldOpen, newOpen]).map((l) => l.number)).toEqual([
      4, 3, 1, 2,
    ]);
    expect(currentLink([merged, closed])?.number).toBe(1);
    expect(currentLink([])).toBeNull();
  });
});

describe("pullRequestBadge", () => {
  it("is null with no links", () => {
    expect(pullRequestBadge([])).toBeNull();
    expect(pullRequestBadge(undefined)).toBeNull();
  });
  it("counts the others and adds the states up", () => {
    const badge = pullRequestBadge([
      link(1, {}, { state: "merged" }),
      link(2, {}, { isDraft: true }),
      link(3, {}, { state: "closed" }),
    ]);
    expect(badge?.link.number).toBe(2);
    expect(badge?.others).toBe(2);
    expect(badge?.state).toBe("open");
    expect(pullRequestBadge([link(1, {}, { isDraft: true })])?.state).toBe("draft");
    expect(pullRequestBadge([link(1, {}, { state: "merged" })])?.state).toBe("merged");
    expect(
      pullRequestBadge([link(1, {}, { state: "merged" }), link(2, {}, { state: "closed" })])?.state,
    ).toBe("closed");
  });
});

describe("search terms and keys", () => {
  it("matches by number, repository, URL and title", () => {
    expect(pullRequestSearchTerms([link(7)])).toEqual([
      "#7",
      "acme/shop#7",
      "https://github.com/acme/shop/pull/7",
      "Add discounts",
    ]);
  });
  it("folds case in the key", () => {
    expect(linkKey({ repository: "Acme/Shop", number: 3 })).toBe("acme/shop#3");
  });
});

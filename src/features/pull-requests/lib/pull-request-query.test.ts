import { describe, expect, it } from "vitest";

import {
  applyPullRequestDraftFilterChange,
  mergePullRequestFilters,
  parsePullRequestQuery,
  pullRequestServerFilters,
} from "./pull-request-query";

describe("parsePullRequestQuery", () => {
  it("leaves plain words as the text", () => {
    expect(parsePullRequestQuery("fix the cart")).toEqual({ text: "fix the cart", filters: {} });
  });

  it("reads labels, OR within one qualifier, and quoted names", () => {
    expect(parsePullRequestQuery('cart label:bug,"help wanted" label:ui').filters).toEqual({
      labels: [["bug", "help wanted"], ["ui"]],
    });
    expect(parsePullRequestQuery('label:"needs review"').filters.labels).toEqual([
      ["needs review"],
    ]);
  });

  it("reads excluded labels", () => {
    expect(parsePullRequestQuery("-label:wip,blocked -label:stale").filters).toEqual({
      excludedLabels: ["wip", "blocked", "stale"],
    });
  });

  it("reads author, draft, review and checks", () => {
    const parsed = parsePullRequestQuery(
      "speed author:@me draft:false review:changes_requested status:failure",
    );
    expect(parsed.text).toBe("speed");
    expect(parsed.filters).toEqual({
      author: "@me",
      draft: "hide",
      review: "changes-requested",
      checks: "failing",
    });
    expect(parsePullRequestQuery("draft:TRUE checks:passing review:none").filters).toEqual({
      draft: "only",
      checks: "passing",
      review: "none",
    });
  });

  it("keeps qualifiers it cannot honour in the text", () => {
    expect(parsePullRequestQuery("-author:bot draft:maybe review:soon label:").text).toBe(
      "-author:bot draft:maybe review:soon label:",
    );
    expect(parsePullRequestQuery("fix: crash").text).toBe("fix: crash");
  });

  it("reads other qualifiers as scoped labels, but not a pasted URL", () => {
    expect(parsePullRequestQuery("area:ui -kind:chore").filters).toEqual({
      labels: [["area:ui"]],
      excludedLabels: ["kind:chore"],
    });
    expect(parsePullRequestQuery("https://github.com/a/b/pull/1")).toEqual({
      text: "https://github.com/a/b/pull/1",
      filters: {},
    });
  });

  it("bounds what one qualifier can carry", () => {
    const many = Array.from({ length: 15 }, (_, i) => `l${i}`).join(",");
    expect(parsePullRequestQuery(`label:${many}`).filters.labels?.[0]).toHaveLength(10);
    expect(parsePullRequestQuery(`author:${"a".repeat(300)}`).filters.author).toHaveLength(200);
  });
});

describe("mergePullRequestFilters", () => {
  it("lets a typed qualifier take the menu's place for its field", () => {
    expect(
      mergePullRequestFilters(
        { draft: "only", author: "ana", labels: ["bug"] },
        { draft: "hide", labels: [["ui", "ux"]] },
      ),
    ).toEqual({ draft: "hide", author: "ana", labels: [["ui", "ux"]] });
    expect(mergePullRequestFilters({ labels: ["bug", "ui"] }, {})).toEqual({
      labels: [["bug"], ["ui"]],
    });
  });
});

describe("pullRequestServerFilters", () => {
  it("sends single labels apart from OR groups, and review and checks not at all", () => {
    expect(
      pullRequestServerFilters({
        labels: [["bug"], ["ui", "ux"]],
        excludedLabels: ["wip"],
        author: "@me",
        draft: "hide",
        review: "approved",
        checks: "failing",
      }),
    ).toEqual({
      author: "@me",
      draft: "hide",
      labels: ["bug"],
      labelGroups: [["ui", "ux"]],
      excludedLabels: ["wip"],
    });
    expect(pullRequestServerFilters({})).toEqual({
      author: null,
      draft: null,
      labels: null,
      labelGroups: null,
      excludedLabels: null,
    });
  });
});

describe("applyPullRequestDraftFilterChange", () => {
  it("takes a typed draft: out when the menu picks another value", () => {
    expect(applyPullRequestDraftFilterChange("cart draft:true", undefined, "hide")).toEqual({
      query: "cart",
      draft: "hide",
    });
  });

  it("leaves the query alone when the menu picks what is typed", () => {
    expect(applyPullRequestDraftFilterChange("draft:true", undefined, "only")).toEqual({
      query: "draft:true",
      draft: undefined,
    });
  });

  it("is a plain menu change with nothing typed", () => {
    expect(applyPullRequestDraftFilterChange("cart", "only", undefined)).toEqual({
      query: "cart",
      draft: undefined,
    });
  });
});

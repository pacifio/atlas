import { describe, expect, it } from "vitest";
import {
  bodyPreview,
  checksStateOf,
  conversationItems,
  filterConversation,
  groupChecks,
  latestReviewOutcomes,
  pageConversation,
  resolveMergeMethod,
  resolvePrimaryControl,
  reviewOutcome,
  sectionCollapseAnchorScrollTop,
  summarizeChecks,
  visibleBody,
} from "./pull-request-logic";
import { applyPendingReactions } from "./pull-request-reactions";
import type {
  PrActor,
  PrCheck,
  PrCheckStatus,
  PrComment,
  PrReviewThread,
} from "./pull-requests-types";

const person = (login: string, isBot = false): PrActor => ({
  login,
  name: null,
  avatarUrl: null,
  isBot,
});

const comment = (id: string, at: string, extra: Partial<PrComment> = {}): PrComment => ({
  id,
  kind: "issue-comment",
  author: person("ines"),
  body: id,
  createdAt: at,
  editedAt: null,
  url: null,
  path: null,
  reviewState: null,
  reactions: [],
  canEdit: false,
  canDelete: false,
  ...extra,
});

const check = (name: string, status: PrCheckStatus, url: string | null = null): PrCheck => ({
  name,
  status,
  description: null,
  url,
  required: null,
  workflow: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
});

const thread = (id: string, comments: PrComment[], extra: Partial<PrReviewThread> = {}) =>
  ({
    id,
    path: "a.ts",
    line: 1,
    side: "right",
    isResolved: false,
    isOutdated: false,
    comments,
    commentCount: comments.length,
    nextCommentsCursor: null,
    canResolve: true,
    ...extra,
  }) satisfies PrReviewThread;

const control = (over: Partial<Parameters<typeof resolvePrimaryControl>[0]> = {}) =>
  resolvePrimaryControl({
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    checksState: "passing",
    autoMergeEnabled: false,
    hasMergeMethod: true,
    canMerge: true,
    canMarkReady: true,
    canEnableAutoMerge: true,
    ...over,
  });

describe("resolvePrimaryControl", () => {
  it("leads with the pull request's terminal state", () => {
    expect(control({ state: "merged" })).toBe("merged");
    expect(control({ state: "closed" })).toBe("closed");
  });

  it("asks to resolve a conflict before anything else", () => {
    expect(control({ mergeability: "conflicting", isDraft: true })).toBe("resolve");
  });

  it("offers Ready for review on a draft, if the viewer may", () => {
    expect(control({ isDraft: true })).toBe("ready");
    expect(control({ isDraft: true, canMarkReady: false })).toBeNull();
  });

  it("offers auto-merge while checks are not yet passing", () => {
    expect(control({ checksState: "pending" })).toBe("enable-auto-merge");
    expect(control({ checksState: "pending", canEnableAutoMerge: false })).toBe("merge");
    expect(control({ autoMergeEnabled: true })).toBe("auto-merge-armed");
  });

  it("does not offer auto-merge where the host cannot say", () => {
    expect(control({ checksState: "failing", autoMergeEnabled: null })).toBe("merge");
  });

  it("merges when everything is green, and offers nothing it cannot do", () => {
    expect(control()).toBe("merge");
    expect(control({ canMerge: false })).toBeNull();
    expect(control({ hasMergeMethod: false })).toBeNull();
  });
});

describe("resolveMergeMethod", () => {
  it("prefers this pull request's pick, then the last pick, then the first allowed", () => {
    expect(resolveMergeMethod(["merge", "squash"], "squash", "merge")).toBe("squash");
    expect(resolveMergeMethod(["merge", "squash"], null, "squash")).toBe("squash");
    expect(resolveMergeMethod(["squash"], "rebase", "merge")).toBe("squash");
    expect(resolveMergeMethod([], null, null)).toBe("merge");
  });
});

describe("checks", () => {
  it("rolls failing over running over passing", () => {
    expect(checksStateOf([])).toBeNull();
    expect(checksStateOf([check("a", "success"), check("b", "pending")])).toBe("pending");
    expect(checksStateOf([check("a", "cancelled"), check("b", "pending")])).toBe("failing");
    expect(checksStateOf([check("a", "success"), check("b", "skipped")])).toBe("passing");
  });

  it("summarises for the pill", () => {
    expect(summarizeChecks([])).toBe("No checks reported");
    expect(summarizeChecks([check("a", "failure"), check("b", "success")])).toBe("1 of 2 failing");
    expect(summarizeChecks([check("a", "pending"), check("b", "success")])).toBe("1 of 2 running");
    expect(summarizeChecks([check("a", "success")])).toBe("All checks passed");
    expect(summarizeChecks([check("a", "action-required", "https://x/o/r/actions/runs/12")])).toBe(
      "1 workflow awaiting approval",
    );
  });

  it("groups the ones that need a look first", () => {
    const groups = groupChecks([
      check("ok", "success"),
      check("run", "pending"),
      check("bad", "failure"),
    ]);
    expect(groups.attention.map((c) => c.name)).toEqual(["bad"]);
    expect(groups.running.map((c) => c.name)).toEqual(["run"]);
    expect(groups.completed.map((c) => c.name)).toEqual(["ok"]);
  });
});

describe("reviews", () => {
  it("reads the host's state words", () => {
    expect(reviewOutcome("CHANGES_REQUESTED")).toBe("changes-requested");
    expect(reviewOutcome("APPROVED")).toBe("approved");
    expect(reviewOutcome("COMMENTED")).toBeNull();
    expect(reviewOutcome(null)).toBeNull();
  });

  it("keeps each reviewer's latest verdict and marks it stale behind a newer commit", () => {
    const outcomes = latestReviewOutcomes(
      [
        comment("r1", "2026-01-01T00:00:00Z", { reviewState: "CHANGES_REQUESTED" }),
        comment("r2", "2026-01-03T00:00:00Z", { reviewState: "APPROVED" }),
        comment("r3", "2026-01-02T00:00:00Z", {
          reviewState: "DISMISSED",
          author: person("theo"),
        }),
      ],
      [
        {
          oid: "a",
          messageHeadline: "x",
          committedDate: "2026-01-04T00:00:00Z",
          additions: 1,
          deletions: 0,
          authors: [],
        },
      ],
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ key: "ines", outcome: "approved", stale: true });
  });
});

describe("the conversation", () => {
  it("treats a body of only HTML comments as empty", () => {
    expect(visibleBody("<!-- bot marker -->\n")).toBeNull();
    expect(visibleBody(" hi ")).toBe("hi");
  });

  it("previews a body as one plain line", () => {
    expect(bodyPreview("## Title\n\nSee [the docs](https://x) and `code`.")).toBe(
      "Title See the docs and code.",
    );
  });

  it("weaves threads into the timeline at their first comment", () => {
    const root = comment("t1c1", "2026-01-02T00:00:00Z", { kind: "review-comment" });
    const reply = comment("t1c2", "2026-01-04T00:00:00Z", { kind: "review-comment" });
    const items = conversationItems(
      [comment("c1", "2026-01-01T00:00:00Z"), root, comment("c2", "2026-01-03T00:00:00Z"), reply],
      [thread("t1", [reply, root], { commentCount: 3 })],
    );
    expect(items.map((item) => item.id)).toEqual(["c1", "t1", "c2"]);
    const woven = items[1];
    expect(woven.kind === "thread" && woven.replies.map((r) => r.id)).toEqual(["t1c2"]);
    expect(woven.kind === "thread" && woven.moreReplies).toBe(1);
  });

  it("hides bots and finished threads unless asked, keeping a person's reply", () => {
    const bot = person("ci[bot]");
    const items = conversationItems(
      [
        comment("bot", "2026-01-01T00:00:00Z", { author: bot }),
        comment("done", "2026-01-02T00:00:00Z", { kind: "review-comment" }),
        comment("botroot", "2026-01-03T00:00:00Z", { author: bot, kind: "review-comment" }),
        comment("reply", "2026-01-04T00:00:00Z", { kind: "review-comment" }),
      ],
      [
        thread("resolved", [comment("done", "2026-01-02T00:00:00Z")], { isResolved: true }),
        thread("mixed", [
          comment("botroot", "2026-01-03T00:00:00Z", { author: bot }),
          comment("reply", "2026-01-04T00:00:00Z"),
        ]),
      ],
    );
    const ids = (filter: { bots: boolean; resolved: boolean }) =>
      filterConversation(items, filter).map((item) => item.id);
    expect(ids({ bots: false, resolved: false })).toEqual(["mixed"]);
    expect(ids({ bots: true, resolved: true })).toEqual(["bot", "resolved", "mixed"]);
  });

  it("pages from the newest end", () => {
    const items = conversationItems(
      Array.from({ length: 5 }, (_, i) => comment(`c${i}`, `2026-01-0${i + 1}T00:00:00Z`)),
      [],
    );
    const { shown, hidden } = pageConversation(items, 2);
    expect(shown.map((item) => item.id)).toEqual(["c3", "c4"]);
    expect(hidden).toBe(3);
  });
});

describe("applyPendingReactions", () => {
  it("adds, removes and keeps the canonical order", () => {
    const next = applyPendingReactions(
      [
        { content: "heart", count: 1, actors: ["a"], viewerHasReacted: true },
        { content: "laugh", count: 2, actors: ["a", "b"], viewerHasReacted: false },
      ],
      new Map([
        ["heart", false],
        ["laugh", true],
        ["thumbs-up", true],
      ]),
    );
    expect(next.map((r) => [r.content, r.count, r.viewerHasReacted])).toEqual([
      ["thumbs-up", 1, true],
      ["laugh", 3, true],
    ]);
  });
});

describe("sectionCollapseAnchorScrollTop", () => {
  it("only compensates when the heading is pinned past the top", () => {
    expect(
      sectionCollapseAnchorScrollTop({
        scrollTop: 500,
        viewportTop: 100,
        sectionTop: -200,
        headingTop: 100,
      }),
    ).toBe(200);
    expect(
      sectionCollapseAnchorScrollTop({
        scrollTop: 500,
        viewportTop: 100,
        sectionTop: 150,
        headingTop: 150,
      }),
    ).toBeNull();
  });
});

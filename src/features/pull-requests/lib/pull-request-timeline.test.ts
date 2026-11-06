import { describe, expect, it, vi } from "vitest";

import {
  buildTimeline,
  forcePushSpan,
  groupTimeline,
  isStaleVerdict,
  newestCommitTime,
  type TimelineEvent,
} from "./pull-request-timeline";
import {
  readTimelineHistory,
  readTimelineRefresh,
  TIMELINE_FULL_READ_MS,
  TIMELINE_PAGE_LIMIT,
} from "./pull-requests-queries";
import type {
  PrActivity,
  PrActor,
  PrComment,
  PrReviewThread,
  PrTimelineItem,
} from "./pull-requests-types";

const person = (login: string, isBot = false): PrActor => ({
  login,
  name: null,
  avatarUrl: null,
  isBot,
});
const ANA = person("ana");
const BEN = person("ben");
const BOT = person("ci-bot", true);

const at = (minute: number) => new Date(Date.UTC(2026, 9, 20, 12, minute)).toISOString();

const comment = (
  id: string,
  minute: number,
  actor = ANA,
  body = "Looks good.",
): PrTimelineItem => ({
  kind: "comment",
  id,
  actor,
  body,
  url: `https://github.com/o/r/pull/7#issuecomment-${id}`,
  at: at(minute),
});
const commit = (id: string, minute: number, actor = ANA): PrTimelineItem => ({
  kind: "commit",
  id,
  oid: `${id}`.padEnd(40, "0"),
  messageHeadline: `Commit ${id}`,
  authors: [actor],
  at: at(minute),
});
const review = (id: string, minute: number, state: string, body = ""): PrTimelineItem => ({
  kind: "review",
  id,
  actor: BEN,
  state,
  body,
  url: null,
  at: at(minute),
});
const labeled = (
  kind: "labeled" | "unlabeled",
  id: string,
  name: string,
  minute: number,
  actor = BOT,
): PrTimelineItem => ({ kind, id, actor, label: { name, color: "0e8a16" }, at: at(minute) });

const activityOf = (patch: Partial<PrActivity>): PrActivity => ({
  author: ANA,
  reviewers: [],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreadsTruncated: false,
  reviewThreads: [],
  commits: [],
  reactions: [],
  ...patch,
});

const kinds = (events: TimelineEvent[]) => events.map((e) => e.kind);

describe("buildTimeline", () => {
  it("reads the history oldest first, keeping GitHub's order for the same instant", () => {
    const events = buildTimeline(
      [
        { kind: "opened", actor: ANA, at: at(0) },
        commit("c2", 5),
        comment("IC_1", 3),
        commit("c1", 5),
      ],
      null,
    );
    expect(events.map((e) => e.id)).toEqual(["opened", "IC_1", "c2", "c1"]);
  });

  it("drops the close GitHub records beside a merge", () => {
    const events = buildTimeline(
      [
        { kind: "opened", actor: ANA, at: at(0) },
        { kind: "merged", id: "ME", actor: BEN, commitOid: "abc", baseBranch: "main", at: at(9) },
        { kind: "closed", id: "CE", actor: BEN, at: at(9) },
        { kind: "head-ref-deleted", id: "HRD", actor: BEN, at: at(10) },
      ],
      null,
    );
    expect(kinds(events)).toEqual(["opened", "merged", "head-ref-deleted"]);
    expect(events[1]).toMatchObject({ mergeCommitOid: "abc", baseBranch: "main" });
  });

  it("keeps a close and reopen before the merge", () => {
    const events = buildTimeline(
      [
        { kind: "closed", id: "CE1", actor: ANA, at: at(1) },
        { kind: "reopened", id: "RE", actor: ANA, at: at(2) },
        { kind: "merged", id: "ME", actor: BEN, commitOid: null, baseBranch: null, at: at(3) },
      ],
      null,
    );
    expect(kinds(events)).toEqual(["closed", "reopened", "merged"]);
  });

  it("leaves out empty commenting reviews and the viewer's pending draft", () => {
    const events = buildTimeline(
      [
        review("PRR_1", 1, "COMMENTED"),
        review("PRR_2", 2, "PENDING", "half-written"),
        review("PRR_3", 3, "COMMENTED", "<!-- marker -->"),
        review("PRR_4", 4, "APPROVED"),
        review("PRR_5", 5, "COMMENTED", "One question inline."),
      ],
      null,
    );
    expect(events.map((e) => e.id)).toEqual(["PRR_4", "PRR_5"]);
  });

  it("takes reactions, edit marks and a later dismissal from the activity read", () => {
    const known: PrComment = {
      id: "PRR_1",
      kind: "review",
      author: BEN,
      body: "No.",
      createdAt: at(1),
      editedAt: at(4),
      url: null,
      path: null,
      reviewState: "DISMISSED",
      reactions: [{ content: "eyes", count: 1, actors: ["ana"], viewerHasReacted: false }],
      canEdit: true,
      canDelete: false,
    };
    const [event] = buildTimeline(
      [review("PRR_1", 1, "CHANGES_REQUESTED", "No.")],
      activityOf({ comments: [known] }),
    );
    expect(event.reviewState).toBe("DISMISSED");
    expect(event.editedAt).toBe(at(4));
    expect(event.reactions).toHaveLength(1);
    expect(event.comment?.id).toBe("PRR_1");
    expect(event.comment?.canEdit).toBe(true);
  });

  it("gives a commit its diff stat when the activity read has one", () => {
    const [event] = buildTimeline(
      [commit("c1", 1)],
      activityOf({
        commits: [
          {
            oid: "c1".padEnd(40, "0"),
            messageHeadline: "",
            committedDate: at(1),
            additions: 12,
            deletions: 3,
            authors: [],
          },
        ],
      }),
    );
    expect(event.commit).toMatchObject({ additions: 12, deletions: 3, headline: "Commit c1" });
  });

  it("places each review thread at its first comment, replies under it", () => {
    const thread: PrReviewThread = {
      id: "PRRT_1",
      path: "src/a.ts",
      line: 4,
      side: "right",
      isResolved: true,
      isOutdated: false,
      comments: [
        {
          id: "RC_2",
          author: ANA,
          body: "Fixed.",
          createdAt: at(6),
          editedAt: null,
          url: null,
          reactions: [],
          canEdit: false,
          canDelete: false,
        },
        {
          id: "RC_1",
          author: BEN,
          body: "Off by one?",
          createdAt: at(2),
          editedAt: null,
          url: "https://github.com/o/r/pull/7#discussion_r1",
          reactions: [],
          canEdit: false,
          canDelete: false,
        },
      ],
      commentCount: 4,
      nextCommentsCursor: null,
      canResolve: true,
    };
    const events = buildTimeline(
      [comment("IC_1", 1), comment("IC_2", 3)],
      activityOf({ reviewThreads: [thread] }),
    );
    expect(events.map((e) => e.id)).toEqual(["IC_1", "RC_1", "IC_2"]);
    expect(events[1].thread).toMatchObject({
      path: "src/a.ts",
      line: 4,
      isResolved: true,
      moreReplies: 2,
      hasMoreReplies: true,
    });
    expect(events[1].thread?.replies.map((r) => r.id)).toEqual(["RC_2"]);
  });

  it("knows a verdict given before the newest commit", () => {
    const events = buildTimeline(
      [review("PRR_1", 1, "APPROVED"), commit("c1", 5), review("PRR_2", 9, "APPROVED")],
      null,
    );
    const newest = newestCommitTime(events);
    expect(newest).toBe(at(5));
    expect(isStaleVerdict(events[0], newest)).toBe(true);
    expect(isStaleVerdict(events[2], newest)).toBe(false);
  });
});

describe("groupTimeline", () => {
  const events = buildTimeline(
    [
      { kind: "opened", actor: ANA, at: at(0) },
      labeled("labeled", "L1", "bug", 1),
      labeled("labeled", "L2", "triage", 1),
      labeled("unlabeled", "L3", "triage", 2),
      labeled("labeled", "L4", "large", 2),
      { kind: "review-requested", id: "RR1", actor: ANA, reviewer: BEN, at: at(3) },
      { kind: "review-requested", id: "RR2", actor: ANA, reviewer: BOT, at: at(3) },
      commit("c1", 4),
      commit("c2", 5),
      commit("c3", 6),
      comment("IC_1", 7),
      comment("IC_2", 8, BEN),
      review("PRR_1", 9, "CHANGES_REQUESTED", "Needs a test."),
      comment("IC_3", 10),
      {
        kind: "force-pushed",
        id: "F1",
        actor: ANA,
        beforeOid: "aaa",
        afterOid: "bbb",
        at: at(11),
      },
      {
        kind: "force-pushed",
        id: "F2",
        actor: ANA,
        beforeOid: "bbb",
        afterOid: "ccc",
        at: at(12),
      },
      commit("c4", 13),
    ],
    null,
  );

  it("folds runs, oldest first, with counts", () => {
    const rows = groupTimeline(events, "oldest");
    expect(rows.map((r) => r.kind)).toEqual([
      "event",
      "labels",
      "review-requests",
      "commits",
      "comments",
      "event",
      "comments",
      "force-pushes",
      "commits",
    ]);
    const labels = rows[1];
    expect(labels.kind === "labels" && labels.added.map((l) => l.name)).toEqual(["bug", "large"]);
    expect(labels.kind === "labels" && labels.removed).toEqual([]);
    const requests = rows[2];
    expect(requests.kind === "review-requests" && requests.reviewers.map((r) => r?.login)).toEqual([
      "ben",
      "ci-bot",
    ]);
    const commits = rows[3];
    expect(commits.kind === "commits" && commits.events).toHaveLength(3);
    const comments = rows[4];
    expect(comments.kind === "comments" && comments.events.map((e) => e.id)).toEqual([
      "IC_1",
      "IC_2",
    ]);
  });

  it("reads the same runs newest first", () => {
    const rows = groupTimeline(events, "newest");
    expect(rows.map((r) => r.kind)).toEqual([
      "commits",
      "force-pushes",
      "comments",
      "event",
      "comments",
      "commits",
      "review-requests",
      "labels",
      "event",
    ]);
    const pushes = rows[1];
    expect(pushes.kind === "force-pushes" && forcePushSpan(pushes.events)).toEqual({
      beforeOid: "aaa",
      afterOid: "ccc",
    });
    expect(rows[0].kind === "commits" && rows[0].events.map((e) => e.id)).toEqual(["c4"]);
  });

  it("does not merge different people's label changes, and drops a run that nets out", () => {
    const rows = groupTimeline(
      buildTimeline(
        [
          labeled("labeled", "L1", "bug", 1, ANA),
          labeled("labeled", "L2", "bug", 1, BEN),
          labeled("unlabeled", "L3", "bug", 2, BEN),
        ],
        null,
      ),
      "oldest",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "labels", actor: ANA });
  });

  it("gives every row a distinct key", () => {
    const rows = groupTimeline(events, "oldest");
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});

describe("readTimelineHistory", () => {
  it("follows every page in order", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ items: [comment("IC_1", 1)], nextCursor: "p2" })
      .mockResolvedValueOnce({ items: [comment("IC_2", 2)], nextCursor: null });
    const history = await readTimelineHistory("/repo", 7, read);
    expect(history.truncated).toBe(false);
    expect(history.items.map((i) => (i.kind === "comment" ? i.id : ""))).toEqual(["IC_1", "IC_2"]);
    expect(read.mock.calls).toEqual([
      ["/repo", 7, null],
      ["/repo", 7, "p2"],
    ]);
  });

  it("stops at the page bound and says the history was cut", async () => {
    const read = vi.fn().mockResolvedValue({ items: [], nextCursor: "more" });
    const history = await readTimelineHistory("/repo", 7, read);
    expect(history.truncated).toBe(true);
    expect(read).toHaveBeenCalledTimes(TIMELINE_PAGE_LIMIT);
  });
});

describe("readTimelineRefresh", () => {
  const ids = (history: { items: { kind: string }[] }) =>
    history.items.map((i) => ("id" in i ? (i as { id: string }).id : ""));
  const threePages = () =>
    vi
      .fn()
      .mockResolvedValueOnce({ items: [comment("IC_1", 1)], nextCursor: "p2" })
      .mockResolvedValueOnce({ items: [comment("IC_2", 2)], nextCursor: "p3" })
      .mockResolvedValueOnce({ items: [comment("IC_3", 3)], nextCursor: null });

  it("re-reads only the newest page of a history already held", async () => {
    const held = await readTimelineHistory("/repo", 7, threePages(), 1_000);
    const read = vi.fn().mockResolvedValueOnce({
      items: [comment("IC_3", 3), comment("IC_4", 4)],
      nextCursor: null,
    });
    const next = await readTimelineRefresh("/repo", 7, held, read, 2_000);
    expect(read.mock.calls).toEqual([["/repo", 7, "p3"]]);
    expect(ids(next)).toEqual(["IC_1", "IC_2", "IC_3", "IC_4"]);
    expect(next.pages).toBe(3);

    // And again from the same tail: a page that grew a new page goes on.
    const more = vi
      .fn()
      .mockResolvedValueOnce({ items: [comment("IC_3", 3), comment("IC_4", 4)], nextCursor: "p4" })
      .mockResolvedValueOnce({ items: [comment("IC_5", 5)], nextCursor: null });
    const after = await readTimelineRefresh("/repo", 7, next, more, 3_000);
    expect(more.mock.calls.map((c) => c[2])).toEqual(["p3", "p4"]);
    expect(ids(after)).toEqual(["IC_1", "IC_2", "IC_3", "IC_4", "IC_5"]);
    expect(after.pages).toBe(4);
  });

  it("reads the whole history when nothing is held or the last full read is old", async () => {
    const first = threePages();
    const held = await readTimelineRefresh("/repo", 7, undefined, first, 0);
    expect(first).toHaveBeenCalledTimes(3);
    const again = threePages();
    await readTimelineRefresh("/repo", 7, held, again, TIMELINE_FULL_READ_MS + 1);
    expect(again.mock.calls[0]?.[2]).toBeNull();
    expect(again).toHaveBeenCalledTimes(3);
  });
});

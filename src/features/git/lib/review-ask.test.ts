import { describe, expect, it } from "vitest";

import type { MentionReviewComment } from "@/features/chat/lib/mentions";

import { reviewAsk, reviewCommentContext } from "./review-ask";

function comment(over: Partial<MentionReviewComment>): MentionReviewComment {
  return {
    kind: "review_comment",
    id: "c1",
    displayName: "src/a.ts:3",
    sectionId: "branch-range",
    sectionTitle: "Changes",
    filePath: "src/a.ts",
    rangeLabel: "+3",
    diff: "@@ -1,1 +3,1 @@\n+const a = 1;",
    fenceLanguage: "diff",
    text: "Rename this",
    start: 3,
    end: 3,
    side: "additions",
    endSide: "additions",
    ...over,
  };
}

describe("reviewCommentContext", () => {
  it("makes a comment on the diff a hunk, with no index side", () => {
    expect(reviewCommentContext(comment({}))).toEqual({
      kind: "diff_hunk",
      path: "src/a.ts",
      hunk: "@@ -1,1 +3,1 @@\n+const a = 1;",
    });
  });

  it("makes a comment on a file's own text a file range, low line first", () => {
    expect(
      reviewCommentContext(
        comment({ fenceLanguage: "ts", diff: "const a = 1;\nconst b = 2;", start: 9, end: 8 }),
      ),
    ).toEqual({
      kind: "file_range",
      path: "src/a.ts",
      startLine: 8,
      endLine: 9,
      excerpt: "const a = 1;\nconst b = 2;",
    });
  });
});

describe("reviewAsk", () => {
  it("lists every comment in the prompt, in the order of its chips", () => {
    const ask = reviewAsk([
      comment({ id: "a", text: "  Rename this  " }),
      comment({ id: "b", filePath: "src/b.ts", rangeLabel: "+10 to +12", text: "Drop the log" }),
    ]);
    expect(ask.prompt).toContain("left 2 comments");
    expect(ask.prompt).toContain("1. `src/a.ts` +3: Rename this");
    expect(ask.prompt).toContain("2. `src/b.ts` +10 to +12: Drop the log");
    expect(ask.context.map((c) => ("path" in c ? c.path : null))).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("speaks of one comment in the singular", () => {
    expect(reviewAsk([comment({})]).prompt).toMatch(/^I reviewed these changes and left a comment/);
  });
});

// @vitest-environment happy-dom
//
// happy-dom for `self`: the module under test reaches the diffs web worker
// through `diff-panel-view`, and the worker touches `self` as it loads.
//
// Where line comments are drawn: under the last line of their range, grouped
// per line, per file, with a version per file that moves only when what that
// file shows does, so a change re-renders that file alone.

import { describe, expect, it } from "vitest";

import type { MentionReviewComment } from "@/features/chat/lib/mentions";
import { placeReviewComments, type CommentGroup } from "./use-diff-review-comments";

/** The viewer's annotation type is generic over its metadata. */
const commentsOf = (a: { metadata: unknown }) => (a.metadata as CommentGroup).comments;

const comment = (over: Partial<MentionReviewComment>): MentionReviewComment => ({
  kind: "review_comment",
  id: "c1",
  displayName: "src/a.ts:2-3",
  sectionId: "changes",
  sectionTitle: "Changes",
  filePath: "src/a.ts",
  rangeLabel: "2 to 3",
  diff: "+x",
  fenceLanguage: "diff",
  text: "Rename this.",
  start: 2,
  end: 3,
  side: "additions",
  endSide: "additions",
  ...over,
});

const pathOf = (c: MentionReviewComment) => (c.sectionId === "changes" ? c.filePath : null);

describe("placeReviewComments", () => {
  it("groups comments under the last line of their range, per file", () => {
    const placed = placeReviewComments(
      [
        comment({ id: "a" }),
        comment({ id: "b", start: 3, end: 3 }),
        comment({ id: "c", filePath: "src/b.ts" }),
      ],
      null,
      pathOf,
    );
    expect([...placed.keys()]).toEqual(["src/a.ts", "src/b.ts"]);
    const a = placed.get("src/a.ts")!.annotations;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ side: "additions", lineNumber: 3 });
    expect(commentsOf(a[0]).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("leaves out comments from another section", () => {
    expect(placeReviewComments([comment({ sectionId: "turn-2" })], null, pathOf).size).toBe(0);
  });

  it("puts the box being written beside the comments, on its side", () => {
    const placed = placeReviewComments(
      [comment({ id: "a" })],
      {
        path: "src/a.ts",
        id: "d",
        comment: comment({ start: 5, end: 5, side: "deletions", endSide: "deletions" }),
      },
      pathOf,
    );
    const a = placed.get("src/a.ts")!.annotations;
    expect(a.map((x) => [x.side, x.lineNumber])).toEqual([
      ["additions", 3],
      ["deletions", 5],
    ]);
    expect(commentsOf(a[1])[0]).toMatchObject({ id: "d", kind: "draft", text: "" });
  });

  it("moves a file's version only when that file's comments change", () => {
    const before = placeReviewComments(
      [comment({ id: "a" }), comment({ id: "b", filePath: "src/b.ts" })],
      null,
      pathOf,
    );
    const after = placeReviewComments(
      [comment({ id: "a" }), comment({ id: "b", filePath: "src/b.ts", text: "Changed." })],
      null,
      pathOf,
    );
    expect(after.get("src/a.ts")!.version).toBe(before.get("src/a.ts")!.version);
    expect(after.get("src/b.ts")!.version).not.toBe(before.get("src/b.ts")!.version);
  });
});

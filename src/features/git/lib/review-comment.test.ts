// Building a line comment from what the reader picked: the rows of a diff it
// covers, quoted as a small hunk, or a file's own lines. The chip's label and
// the range it is drawn back on come from here too.

import { describe, expect, it } from "vitest";
import { parsePatchFiles } from "@pierre/diffs";

import {
  buildDiffReviewComment,
  buildFileReviewComment,
  formatFileRange,
  inferFenceLanguage,
  lineReference,
  reviewCommentRange,
} from "./review-comment";
import { isCommentSubmitShortcut } from "./comment-submit-shortcut";

const PATCH = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,4 @@
 one
-two
+TWO
 three
 four
`;

const fileDiff = parsePatchFiles(PATCH)[0]!.files[0]!;
const section = { id: "changes", title: "Changes" };

describe("buildDiffReviewComment", () => {
  it("quotes the rows an addition range covers as a hunk", () => {
    const draft = buildDiffReviewComment({
      section,
      filePath: "src/a.ts",
      fileDiff,
      range: { start: 2, end: 3, side: "additions" },
    });
    expect(draft).toMatchObject({
      kind: "review_comment",
      displayName: "src/a.ts:2-3",
      sectionId: "changes",
      sectionTitle: "Changes",
      filePath: "src/a.ts",
      rangeLabel: "2 to 3",
      fenceLanguage: "diff",
      start: 2,
      end: 3,
      side: "additions",
      endSide: "additions",
    });
    expect(draft!.diff).toBe("@@ -3,1 +2,2 @@\n+TWO\n three");
  });

  it("marks a range of only removed lines with a minus", () => {
    const draft = buildDiffReviewComment({
      section,
      filePath: "src/a.ts",
      fileDiff,
      range: { start: 2, end: 2, side: "deletions" },
    });
    expect(draft!.rangeLabel).toBe("-2");
    expect(draft!.diff).toBe("@@ -2,1 +0,0 @@\n-two");
    expect(draft!.side).toBe("deletions");
  });

  it("is null for lines the diff does not show", () => {
    expect(
      buildDiffReviewComment({
        section,
        filePath: "src/a.ts",
        fileDiff,
        range: { start: 40, end: 41, side: "additions" },
      }),
    ).toBeNull();
  });
});

describe("buildFileReviewComment", () => {
  const contents = "a\nb\nc\nd\ne";

  it("quotes the file's own lines, either order, fenced by extension", () => {
    const draft = buildFileReviewComment({
      section: { id: "file:/p/src/x.rs", title: "File" },
      filePath: "src/x.rs",
      startLine: 4,
      endLine: 2,
      contents,
    });
    expect(draft).toMatchObject({
      displayName: "src/x.rs:2-4",
      rangeLabel: "L2 to L4",
      diff: "b\nc\nd",
      fenceLanguage: "rs",
      start: 2,
      end: 4,
    });
  });

  it("labels one line without a range", () => {
    const draft = buildFileReviewComment({
      section,
      filePath: "Makefile",
      startLine: 1,
      endLine: 1,
      contents,
    });
    expect(draft.displayName).toBe("Makefile:1");
    expect(draft.rangeLabel).toBe("L1");
    expect(draft.fenceLanguage).toBe("text");
  });
});

describe("labels", () => {
  it("writes the chip label as the file view's line reference", () => {
    expect(lineReference("a.ts", 9, 3)).toBe("a.ts:3-9");
    expect(lineReference("a.ts", 5, 5)).toBe("a.ts:5");
  });

  it("formats a file range", () => {
    expect(formatFileRange(3, 3)).toBe("L3");
    expect(formatFileRange(3, 7)).toBe("L3 to L7");
  });

  it("infers a fence language from the name", () => {
    expect(inferFenceLanguage("src/App.TSX")).toBe("tsx");
    expect(inferFenceLanguage(".env")).toBe("env");
    expect(inferFenceLanguage("C:\\x\\README")).toBe("text");
  });

  it("hands the viewer back the range a comment was written on", () => {
    expect(
      reviewCommentRange({ start: 1, end: 4, side: "deletions", endSide: "additions" }),
    ).toEqual({ start: 1, end: 4, side: "deletions", endSide: "additions" });
  });
});

describe("isCommentSubmitShortcut", () => {
  const key = { key: "Enter", metaKey: true, ctrlKey: false };

  it("adds on ⌘Enter or Ctrl+Enter with text", () => {
    expect(isCommentSubmitShortcut(key, "hi")).toBe(true);
    expect(isCommentSubmitShortcut({ ...key, metaKey: false, ctrlKey: true }, "hi")).toBe(true);
  });

  it("does not add empty, pending, composing, repeated or modified", () => {
    expect(isCommentSubmitShortcut(key, "  ")).toBe(false);
    expect(isCommentSubmitShortcut(key, "hi", true)).toBe(false);
    expect(isCommentSubmitShortcut({ ...key, isComposing: true }, "hi")).toBe(false);
    expect(isCommentSubmitShortcut({ ...key, repeat: true }, "hi")).toBe(false);
    expect(isCommentSubmitShortcut({ ...key, shiftKey: true }, "hi")).toBe(false);
    expect(isCommentSubmitShortcut({ ...key, metaKey: false }, "hi")).toBe(false);
  });
});

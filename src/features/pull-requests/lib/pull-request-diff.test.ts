import { describe, expect, it } from "vitest";

import {
  isLineInFileDiff,
  offDiffPendingComments,
  pendingCommentPlacement,
  positionAnchor,
  prDiffFiles,
  resolveReviewPosition,
} from "./pull-request-diff";
import type { PrDiffResult } from "./pull-requests-types";

// One hunk: old lines 10–14, new lines 10–15. Line 10 is context, old 11–12
// became new 11–13, then context 13–14 (old) / 14–15 (new).
const PATCH_A = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,5 +10,6 @@",
  " const one = 1;",
  "-const two = 2;",
  "-const three = 3;",
  "+const two = token(2);",
  "+const three = token(3);",
  "+const four = token(4);",
  " const five = 5;",
  " const six = 6;",
  "",
].join("\n");

const PATCH_B = [
  "diff --git a/src/b.ts b/src/b.ts",
  "index 3333333..4444444 100644",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1,1 +1,1 @@",
  "-let x  = 1;",
  "+let x = 1;",
  "",
].join("\n");

function page(patch: string, patch_extra: Partial<PrDiffResult> = {}): PrDiffResult {
  return {
    patch,
    files: [],
    truncated: false,
    nextCursor: null,
    omittedFileStats: [],
    ...patch_extra,
  };
}

const fileA = () => prDiffFiles([page(PATCH_A)], "t", false).files[0]!.source;

describe("prDiffFiles", () => {
  it("joins the pages in order and keeps a page's parse across calls", () => {
    const first = page(PATCH_A);
    const second = page(PATCH_B);
    const once = prDiffFiles([first], "t", false);
    const twice = prDiffFiles([first, second], "t", false);
    expect(twice.files.map((f) => f.stat.path)).toEqual(["src/a.ts", "src/b.ts"]);
    // The first page was parsed once: the viewer sees the same object.
    expect(twice.files[0]).toBe(once.files[0]);
    expect(twice.files[0]!.stat).toMatchObject({ additions: 3, deletions: 2, status: "modified" });
    expect(twice.withheld).toBe(false);
  });

  it("takes the host's counts, and calls a file with lines but no hunks too large", () => {
    const binary = [
      "diff --git a/img/logo.png b/img/logo.png",
      "index 5555555..6666666 100644",
      "Binary files a/img/logo.png and b/img/logo.png differ",
      "",
    ].join("\n");
    const result = prDiffFiles(
      [
        page(PATCH_A + binary, {
          truncated: true,
          files: [
            {
              path: "src/a.ts",
              previousPath: null,
              status: "modified",
              additions: 30,
              deletions: 20,
              hasPatch: true,
            },
          ],
          omittedFileStats: [],
        }),
      ],
      "t",
      false,
    );
    expect(result.files[0]!.stat).toMatchObject({ additions: 30, deletions: 20 });
    expect(result.files[1]!.state).toBe("binary");
    expect(result.withheld).toBe(true);
  });

  it("hides whitespace-only changes on request, keeping GitHub's patch as the source", () => {
    const shown = prDiffFiles([page(PATCH_B)], "t", true).files[0]!;
    // The hunk keeps its range; what it holds reads as unchanged.
    expect(shown.fileDiff.hunks[0]!.hunkContent.map((c) => c.type)).toEqual(["context"]);
    expect(shown.source.hunks[0]!.hunkContent.map((c) => c.type)).toEqual(["change"]);
  });
});

describe("isLineInFileDiff", () => {
  it("knows which lines each side of a hunk holds", () => {
    const file = fileA();
    expect(isLineInFileDiff(file, "right", 15)).toBe(true);
    expect(isLineInFileDiff(file, "right", 16)).toBe(false);
    expect(isLineInFileDiff(file, "left", 14)).toBe(true);
    expect(isLineInFileDiff(file, "left", 15)).toBe(false);
    expect(isLineInFileDiff(file, "right", 9)).toBe(false);
  });
});

describe("resolveReviewPosition", () => {
  it("names added, deleted and context lines the way GitHub counts them", () => {
    const file = fileA();
    expect(resolveReviewPosition(file, 13, "additions")).toEqual({ kind: "added", newLine: 13 });
    expect(resolveReviewPosition(file, 12, "deletions")).toEqual({ kind: "deleted", oldLine: 12 });
    expect(resolveReviewPosition(file, 10, "additions")).toEqual({
      kind: "context",
      oldLine: 10,
      newLine: 10,
      side: "right",
    });
    // The trailing context: old 13 is new 14.
    expect(resolveReviewPosition(file, 13, "deletions")).toEqual({
      kind: "context",
      oldLine: 13,
      newLine: 14,
      side: "left",
    });
  });

  it("refuses a line outside every hunk, and never borrows the other side's line", () => {
    const file = fileA();
    expect(resolveReviewPosition(file, 3, "additions")).toBeNull();
    expect(resolveReviewPosition(file, 40, "deletions")).toBeNull();
    // New line 15 is context; old 15 is not in the hunk at all.
    expect(resolveReviewPosition(file, 15, "deletions")).toBeNull();
  });

  it("round-trips through the thread anchor", () => {
    const file = fileA();
    const position = resolveReviewPosition(file, 12, "additions")!;
    expect(positionAnchor(position)).toEqual({ line: 12, side: "right" });
  });
});

describe("offDiffPendingComments", () => {
  const files = () => prDiffFiles([page(PATCH_A)], "t", false).files;
  const comment = (id: string, path: string, newLine: number) => ({
    id,
    path,
    position: { kind: "added" as const, newLine },
    body: id,
  });
  const on = comment("on", "src/a.ts", 12);
  const moved = comment("moved", "src/a.ts", 40);
  const gone = comment("gone", "src/gone.ts", 1);

  it("puts a comment whose line or file left the diff off it, once the whole diff is read", () => {
    expect(offDiffPendingComments([on, moved, gone], files(), true).map((c) => c.id)).toEqual([
      "moved",
      "gone",
    ]);
  });

  it("does not judge a file on a page not read yet", () => {
    expect(offDiffPendingComments([gone], files(), false)).toEqual([]);
    const byPath = new Map(files().map((f) => [f.stat.path, f]));
    expect(pendingCommentPlacement(gone, byPath, false)).toBe("unknown");
    expect(pendingCommentPlacement(on, byPath, false)).toBe("on");
  });
});

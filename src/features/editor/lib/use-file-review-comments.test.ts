// Where a file view draws its line comments: under their last line, moved
// with the lines when an edit shifts them, the open box beside them.

import { describe, expect, it } from "vitest";

import type { MentionReviewComment } from "@/features/chat/lib/mentions";
import {
  normalizeFileCommentRange,
  placeFileComments,
  remapFileCommentAnnotations,
} from "./use-file-review-comments";

const comment = (id: string, start: number, end: number): MentionReviewComment => ({
  kind: "review_comment",
  id,
  displayName: `src/x.ts:${start}-${end}`,
  sectionId: "file:/p/src/x.ts",
  sectionTitle: "File",
  filePath: "src/x.ts",
  rangeLabel: `L${start} to L${end}`,
  diff: "x",
  fenceLanguage: "ts",
  text: `note ${id}`,
  start,
  end,
  side: "additions",
  endSide: "additions",
});

describe("placeFileComments", () => {
  it("draws each comment under its last line, sorted, the box beside them", () => {
    const placed = placeFileComments([comment("b", 8, 9), comment("a", 2, 4)], new Map(), {
      id: "d",
      kind: "draft",
      startLine: 4,
      endLine: 4,
      text: "",
    });
    expect(placed.map((a) => a.lineNumber)).toEqual([4, 9]);
    expect(placed[0].metadata.entries.map((e) => [e.id, e.kind])).toEqual([
      ["a", "comment"],
      ["d", "draft"],
    ]);
  });

  it("uses where an edit moved a comment over where it was written", () => {
    const placed = placeFileComments(
      [comment("a", 2, 4)],
      new Map([["a", { startLine: 6, endLine: 8 }]]),
      null,
    );
    expect(placed[0].lineNumber).toBe(8);
    expect(placed[0].metadata.entries[0]).toMatchObject({ startLine: 6, endLine: 8 });
  });
});

describe("remapFileCommentAnnotations", () => {
  it("keeps each entry's span, ending on the line the editor moved it to", () => {
    const [moved] = remapFileCommentAnnotations([
      {
        lineNumber: 12,
        metadata: { entries: [{ id: "a", kind: "comment", startLine: 2, endLine: 4, text: "" }] },
      },
    ]);
    expect(moved.metadata.entries[0]).toMatchObject({ startLine: 10, endLine: 12 });
  });

  it("never starts above line 1", () => {
    const [moved] = remapFileCommentAnnotations([
      {
        lineNumber: 1,
        metadata: { entries: [{ id: "a", kind: "comment", startLine: 3, endLine: 6, text: "" }] },
      },
    ]);
    expect(moved.metadata.entries[0].startLine).toBe(1);
  });
});

it("normalizes a range picked bottom-up", () => {
  expect(normalizeFileCommentRange({ start: 9, end: 3 })).toEqual({ startLine: 3, endLine: 9 });
});

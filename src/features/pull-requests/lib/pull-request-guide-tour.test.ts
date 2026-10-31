import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vitest";

import {
  excerptRows,
  fileDiffRows,
  letterStopNotes,
  pickedLines,
  rowsToPatch,
} from "./pull-request-guide-tour";

const PATCH = `diff --git a/src/tray.ts b/src/tray.ts
--- a/src/tray.ts
+++ b/src/tray.ts
@@ -10,5 +10,6 @@ function tray()
 const a = 1;
-const size = pick();
+const size = "xs";
+const variant = "tray";
 const b = 2;
 const c = 3;
 const d = 4;
@@ -40,3 +41,2 @@ function footer()
 keep();
-dropped();
 tail();
`;

function parse(patch: string) {
  const file = parsePatchFiles(patch, `test:${patch.length}`)[0]?.files[0];
  if (file === undefined) throw new Error("patch did not parse");
  return file;
}

const rows = fileDiffRows(parse(PATCH));

describe("fileDiffRows", () => {
  it("numbers both sides through context, deletions and additions", () => {
    expect(rows.map((row) => [row.kind, row.oldLine, row.newLine])).toEqual([
      ["context", 10, 10],
      ["deletion", 11, null],
      ["addition", null, 11],
      ["addition", null, 12],
      ["context", 12, 13],
      ["context", 13, 14],
      ["context", 14, 15],
      ["context", 40, 41],
      ["deletion", 41, null],
      ["context", 42, 42],
    ]);
  });
});

describe("excerptRows", () => {
  it("brings the replaced lines along with an excerpt that starts on an addition", () => {
    const shown = excerptRows(rows, { side: "new", start: 11, end: 12 });
    expect(shown.map((row) => row.kind)).toEqual(["deletion", "addition", "addition"]);
  });

  it("selects old-side lines for a removal and stops at the hunk boundary", () => {
    const shown = excerptRows(rows, { side: "old", start: 41, end: 41 });
    expect(shown.map((row) => [row.kind, row.oldLine])).toEqual([["deletion", 41]]);
  });
});

describe("rowsToPatch", () => {
  it("cuts a slice that parses back to the same lines and numbers", () => {
    const shown = excerptRows(rows, { side: "new", start: 10, end: 13 });
    const slice = parse(rowsToPatch("src/tray.ts", "src/tray.ts", shown));
    expect(fileDiffRows(slice).map((row) => [row.kind, row.oldLine, row.newLine])).toEqual(
      shown.map((row) => [row.kind, row.oldLine, row.newLine]),
    );
  });

  it("starts a hunk per source hunk so separate hunks stay separate", () => {
    const shown = excerptRows(rows, { side: "old", start: 14, end: 42 });
    const patch = rowsToPatch("src/tray.ts", "src/tray.ts", shown);
    expect(patch.match(/^@@ /gm)).toHaveLength(2);
    expect(patch).toContain("@@ -14,1 +15,1 @@");
    expect(patch).toContain("@@ -40,3 +41,2 @@");
  });
});

describe("letterStopNotes", () => {
  it("letters notes and places each on its excerpt's line", () => {
    const { lettered, byExcerpt } = letterStopNotes({
      title: "t",
      summary: "",
      attention: null,
      excerpts: [{ path: "a.ts", side: "new", start: 1, end: 5, caption: "" }],
      files: [],
      notes: [
        { path: "a.ts", line: 2, title: "First", body: "" },
        { path: "a.ts", line: 2, title: "Second", body: "" },
      ],
      questions: [],
    });
    expect(lettered.map((n) => n.marker)).toEqual(["A", "B"]);
    expect(byExcerpt[0]).toEqual([
      {
        line: 2,
        markers: [
          { marker: "A", title: "First" },
          { marker: "B", title: "Second" },
        ],
      },
    ]);
  });
});

describe("pickedLines", () => {
  it("takes the rows of a range on the new side, prefixed as the diff shows them", () => {
    const picked = pickedLines("src/tray.ts", rows, { start: 11, end: 12, side: "additions" });
    expect(picked).toEqual({
      path: "src/tray.ts",
      side: "new",
      start: 11,
      end: 12,
      code: '+const size = "xs";\n+const variant = "tray";',
    });
  });

  it("reads a range picked on removed lines on the old side", () => {
    const picked = pickedLines("src/tray.ts", rows, { start: 41, end: 41, side: "deletions" });
    expect(picked.side).toBe("old");
    expect(picked.code).toBe("-dropped();");
  });

  it("orders a range picked bottom-up", () => {
    const picked = pickedLines("src/tray.ts", rows, { start: 12, end: 11, side: "additions" });
    expect([picked.start, picked.end]).toEqual([11, 12]);
  });
});

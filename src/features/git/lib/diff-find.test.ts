// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { parsePatchFiles } from "@pierre/diffs";
import {
  createPaintedRanges,
  findInDiff,
  firstMatchFrom,
  groupByFile,
  lineKeyOfElement,
  lineKeysOf,
  paintMatches,
  rotateTo,
  textRange,
} from "./diff-find";

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const keep = 1;
-const oldName = 2;
+const newName = 2;
+const added = oldName;
 const tail = 4;
@@ -20,3 +21,3 @@ function x() {
 ctx20 name
-del21 Name
+add22 names
 ctx22
diff --git a/src/b.ts b/src/b.ts
index 3333333..4444444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,1 @@
-nil
+: nil
`;

const items = parsePatchFiles(PATCH)[0]!.files.map((fileDiff, index) => ({
  id: `file-${index}`,
  fileDiff,
}));

const find = (text: string, matchCase = false) =>
  findInDiff(items, { text, matchCase }).map(
    (m) => `${m.id}:${m.side}:${m.context ? "ctx" : "chg"}:${m.lineNumber}:${m.start}-${m.end}`,
  );

describe("findInDiff", () => {
  it("finds removed, added and unchanged lines, in the order the diff draws them", () => {
    expect(find("oldName")).toEqual([
      "file-0:deletions:chg:2:6-13",
      "file-0:additions:chg:3:14-21",
    ]);
    expect(find("nil")).toEqual(["file-1:deletions:chg:1:0-3", "file-1:additions:chg:1:2-5"]);
    // Unchanged lines are addressed on the new side, numbered there.
    expect(find("ctx22")).toEqual(["file-0:additions:ctx:23:0-5"]);
  });

  it("counts every occurrence, case-insensitively unless asked", () => {
    expect(find("name")).toHaveLength(6);
    expect(find("Name", true)).toEqual([
      "file-0:deletions:chg:2:9-13",
      "file-0:additions:chg:2:9-13",
      "file-0:additions:chg:3:17-21",
      "file-0:deletions:chg:21:6-10",
    ]);
  });

  it("finds nothing for an empty or multi-line query, and stops at the limit", () => {
    expect(find("")).toEqual([]);
    expect(find("a\nb")).toEqual([]);
    expect(findInDiff(items, { text: "e", matchCase: false }, 3)).toHaveLength(3);
  });

  it("keeps an unchanged line's old-side number for the split view's left copy", () => {
    const [match] = findInDiff(items, { text: "ctx22", matchCase: false });
    expect(match!.deletionLineNumber).toBe(22);
    expect(lineKeysOf(match!)).toEqual(["c:23:22", "c:22:23"]);
  });

  it("groups by file, in order", () => {
    const grouped = groupByFile(findInDiff(items, { text: "nil", matchCase: false }));
    expect([...grouped.keys()]).toEqual(["file-1"]);
    expect(grouped.get("file-1")).toHaveLength(2);
  });
});

describe("firstMatchFrom", () => {
  const matches = findInDiff(items, { text: "n", matchCase: false });
  const order = items.map((i) => i.id);

  it("starts at the file at the top of the viewer", () => {
    const index = firstMatchFrom(matches, order, "file-1");
    expect(matches[index]!.id).toBe("file-1");
    expect(firstMatchFrom(matches, order, "file-0")).toBe(0);
    expect(firstMatchFrom(matches, order, null)).toBe(0);
    expect(firstMatchFrom([], order, "file-1")).toBe(-1);
  });
});

describe("painting", () => {
  function line(attrs: Record<string, string>, ...parts: string[]): HTMLElement {
    const el = document.createElement("div");
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    for (const part of parts) {
      const span = document.createElement("span");
      span.textContent = part;
      el.append(span);
    }
    return el;
  }

  it("keys rendered rows the way matches are keyed", () => {
    expect(lineKeyOfElement(line({ "data-line": "2", "data-line-type": "change-deletion" }))).toBe(
      "d:2",
    );
    expect(lineKeyOfElement(line({ "data-line": "3", "data-line-type": "change-addition" }))).toBe(
      "a:3",
    );
    expect(
      lineKeyOfElement(
        line({ "data-line": "23", "data-alt-line": "22", "data-line-type": "context" }),
      ),
    ).toBe("c:23:22");
    expect(lineKeyOfElement(line({ "data-column-number": "4" }))).toBeNull();
  });

  it("spans a range across the token spans a line is drawn in", () => {
    const el = line({}, "const ", "added", " = ", "oldName;");
    const range = textRange(el, 14, 21);
    expect(range?.toString()).toBe("oldName");
    expect(textRange(el, 40, 44)).toBeNull();
  });

  it("is a no-op where the highlight API is missing", () => {
    expect(paintMatches(createPaintedRanges(), [], new Map(), null)).toBeNull();
  });
});

describe("findInDiff offsets", () => {
  const PATCH_U = `diff --git a/u.ts b/u.ts
--- a/u.ts
+++ b/u.ts
@@ -1,1 +1,1 @@
-x
+İstanbul name; a.b*c
`;
  const items = parsePatchFiles(PATCH_U)[0]!.files.map((fileDiff) => ({ id: "u", fileDiff }));

  it("keeps offsets on the line as written when case folding changes its length", () => {
    // "İ".toLowerCase() is two code units: a folded copy would put "name" at 10.
    const [match] = findInDiff(items, { text: "NAME", matchCase: false });
    expect(match).toMatchObject({ start: 9, end: 13 });
  });

  it("matches a query's pattern characters literally", () => {
    expect(findInDiff(items, { text: "b*c", matchCase: true })).toHaveLength(1);
    expect(findInDiff(items, { text: "a.b", matchCase: true })).toHaveLength(1);
    expect(findInDiff(items, { text: "a.c", matchCase: true })).toHaveLength(0);
  });
});

describe("rotateTo", () => {
  const ids = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("starts at the given file and wraps round", () => {
    expect(rotateTo(ids, "b").map((i) => i.id)).toEqual(["b", "c", "a"]);
    expect(rotateTo(ids, null).map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(rotateTo(ids, "missing").map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});

import { describe, expect, it } from "vitest";
import { parseDiff, splitHunkLines } from "./diff";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 keep
-old one
-old two
+new one
+new two
+new three
 tail
`;

describe("splitHunkLines", () => {
  const [hunk] = parseDiff(DIFF)[0].hunks;
  const pairs = splitHunkLines(hunk);

  it("puts context on both sides", () => {
    expect(pairs[0].left?.content).toBe("keep");
    expect(pairs[0].right?.content).toBe("keep");
    expect(pairs[pairs.length - 1]?.left?.content).toBe("tail");
  });

  it("lays a removal run across from the addition run that replaced it", () => {
    expect(pairs.slice(1, 4).map((p) => [p.left?.content, p.right?.content])).toEqual([
      ["old one", "new one"],
      ["old two", "new two"],
      [undefined, "new three"],
    ]);
  });

  it("keeps each side's own line numbers", () => {
    expect(pairs[2].left?.oldLine).toBe(3);
    expect(pairs[3].right?.newLine).toBe(4);
    expect(pairs[pairs.length - 1]?.left?.oldLine).toBe(4);
    expect(pairs[pairs.length - 1]?.right?.newLine).toBe(5);
  });
});

describe("parseDiff extended headers", () => {
  it("marks a binary file", () => {
    const [file] = parseDiff(
      "diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n",
    );
    expect(file).toMatchObject({ path: "logo.png", binary: true, hunks: [] });
  });

  it("keeps the old path of a rename", () => {
    const [file] = parseDiff(
      "diff --git a/src/old.ts b/src/new.ts\nsimilarity index 100%\nrename from src/old.ts\nrename to src/new.ts\n",
    );
    expect(file).toMatchObject({ path: "src/new.ts", oldPath: "src/old.ts" });
    expect(file.binary).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  fnv1a32,
  getDiffLineStat,
  getRenderablePatch,
  resolveFileDiffPath,
  textFingerprint,
} from "./diff-rendering";

const TWO_FILES = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
@@ -40,2 +40,3 @@ function tail() {
 const y = 1;
+const z = 2;
 const w = 3;
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,2 @@
+export const b = 1;
+export const c = 2;
`;

function filesOf(patch: string) {
  const rendered = getRenderablePatch(patch);
  if (rendered?.kind !== "files") throw new Error(`expected files, got ${rendered?.kind}`);
  return rendered.files;
}

describe("getRenderablePatch", () => {
  it("is null for an empty patch", () => {
    expect(getRenderablePatch(undefined)).toBeNull();
    expect(getRenderablePatch("  \n")).toBeNull();
  });

  it("parses each file with its path and counts", () => {
    const files = filesOf(TWO_FILES);
    expect(files.map(resolveFileDiffPath)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(getDiffLineStat(files)).toEqual({ additions: 4, deletions: 1 });
  });

  it("lays a partial file's hunks out back to back", () => {
    const [a] = filesOf(TWO_FILES);
    const [first, second] = a.hunks;
    expect(second.unifiedLineStart).toBe(first.unifiedLineCount);
    expect(a.unifiedLineCount).toBe(first.unifiedLineCount + second.unifiedLineCount);
  });

  it("falls back to raw text for something that is not a patch", () => {
    expect(getRenderablePatch("not a diff at all")?.kind).toBe("raw");
  });

  it("falls back to the whole raw patch rather than drop a bad hunk", () => {
    const broken = TWO_FILES.replace("@@ -40,2 +40,3 @@", "@@ -40,9 +40,9 @@");
    const rendered = getRenderablePatch(broken);
    expect(rendered?.kind).toBe("raw");
  });
});

describe("content version", () => {
  it("changes only for the file whose content changed", () => {
    const before = filesOf(TWO_FILES);
    const after = filesOf(TWO_FILES.replace("const b = 3;", "const b = 5;"));
    expect(buildFileDiffContentVersion(after[0])).not.toBe(buildFileDiffContentVersion(before[0]));
    expect(buildFileDiffContentVersion(after[1])).toBe(buildFileDiffContentVersion(before[1]));
  });

  it("keeps an unchanged file's highlight-cache key when another file changes", () => {
    const before = filesOf(TWO_FILES);
    const after = filesOf(TWO_FILES.replace("const b = 3;", "const b = 5;"));
    expect(after[1].cacheKey).toBe(before[1].cacheKey);
    expect(after[0].cacheKey).not.toBe(before[0].cacheKey);
    expect(before[0].cacheKey).not.toBe(before[1].cacheKey);
  });

  it("keeps a trailing context line that is a lone space", () => {
    const patch = TWO_FILES.replace(" const w = 3;\n", " const w = 3;\n \n").replace(
      "@@ -40,2 +40,3 @@",
      "@@ -40,3 +40,4 @@",
    );
    const [a] = filesOf(`${patch.split("diff --git a/src/b.ts")[0]}`);
    expect(a.hunks[1].additionCount).toBe(4);
  });

  it("keys identity by path and change type", () => {
    const [, b] = filesOf(TWO_FILES);
    expect(buildFileDiffIdentityKey(b)).toBe("src/b.ts\u0000src/b.ts\u0000new");
  });
});

describe("fnv1a32", () => {
  it("matches the reference vectors", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
  });
});

describe("textFingerprint", () => {
  it("is short, stable, and tells apart texts of the same length", () => {
    const big = "x".repeat(1_000_000);
    expect(textFingerprint(big)).toBe(textFingerprint("x".repeat(1_000_000)));
    expect(textFingerprint(big).length).toBeLessThan(40);
    expect(textFingerprint("ab")).not.toBe(textFingerprint("ba"));
    expect(textFingerprint("")).not.toBe(textFingerprint("a"));
  });
});

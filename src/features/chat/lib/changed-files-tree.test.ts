import { describe, expect, it } from "vitest";
import type { TurnFile } from "@/types/agent";
import {
  buildChangedFilesTree,
  changedFilesOf,
  folderPaths,
  formatDiffCount,
  splitForMiddleTruncate,
  sumStats,
  visibleRows,
  type ChangedDirNode,
  type ChangedFile,
} from "./changed-files-tree";

const file = (path: string, added = 1, removed = 0): ChangedFile => ({
  path,
  source: `/repo/${path}`,
  added,
  removed,
  created: false,
});

const names = (rows: ReturnType<typeof visibleRows>) =>
  rows.map((r) => `${"  ".repeat(r.depth)}${r.node.name}`);

describe("changedFilesOf", () => {
  it("keeps the turn's edits, repo-relative, and leaves out what it only read", () => {
    const files: TurnFile[] = [
      { path: "/repo/src/a.ts", kind: "edit", added: 3, removed: 1, created: false },
      { path: "/repo/src/b.ts", kind: "read", added: 0, removed: 0 },
      { path: "/repo/src/c.ts", kind: "edit", added: 9, removed: 0, created: true },
    ];
    expect(changedFilesOf(files, "/repo")).toEqual([
      { path: "src/a.ts", source: "/repo/src/a.ts", added: 3, removed: 1, created: false },
      { path: "src/c.ts", source: "/repo/src/c.ts", added: 9, removed: 0, created: true },
    ]);
  });

  it("leaves a path outside the project as the turn reported it", () => {
    const files: TurnFile[] = [{ path: "/elsewhere/x.ts", kind: "edit", added: 1, removed: 0 }];
    expect(changedFilesOf(files, "/repo")[0].path).toBe("/elsewhere/x.ts");
  });
});

describe("buildChangedFilesTree", () => {
  it("lists folders before files, each by name with numbers in order", () => {
    const tree = buildChangedFilesTree([
      file("z.ts"),
      file("src/b.ts"),
      file("a.ts"),
      file("lib/x.ts"),
      file("src/file10.ts"),
      file("src/file9.ts"),
    ]);
    expect(names(visibleRows(tree, {}, true))).toEqual([
      "lib",
      "  x.ts",
      "src",
      "  b.ts",
      "  file9.ts",
      "  file10.ts",
      "a.ts",
      "z.ts",
    ]);
  });

  it("folds a chain of single-folder folders into one row, keyed by its deepest folder", () => {
    const tree = buildChangedFilesTree([
      file("src/server/api/v2/routes/users.ts"),
      file("src/server/api/v2/routes/index.ts"),
    ]);
    expect(tree).toHaveLength(1);
    const dir = tree[0] as ChangedDirNode;
    expect(dir.name).toBe("src/server/api/v2/routes");
    expect(dir.path).toBe("src/server/api/v2/routes");
    expect(dir.children.map((c) => c.name)).toEqual(["index.ts", "users.ts"]);
  });

  it("stops folding where a folder holds a file or a second folder", () => {
    const tree = buildChangedFilesTree([
      file("src/features/auth/session.ts"),
      file("src/features/auth/session.test.ts"),
      file("src/components/ui/button.tsx"),
    ]);
    expect(names(visibleRows(tree, {}, true))).toEqual([
      "src",
      "  components/ui",
      "    button.tsx",
      "  features/auth",
      "    session.test.ts",
      "    session.ts",
    ]);
  });

  it("rolls each file's counts up into every folder above it", () => {
    const tree = buildChangedFilesTree([file("src/a/x.ts", 5, 1), file("src/b/y.ts", 2, 3)]);
    const src = tree[0] as ChangedDirNode;
    expect(src.stat).toEqual({ added: 7, removed: 4 });
    expect((src.children[0] as ChangedDirNode).stat).toEqual({ added: 5, removed: 1 });
  });

  it("accepts Windows separators", () => {
    const tree = buildChangedFilesTree([file("src\\a.ts")]);
    expect((tree[0] as ChangedDirNode).name).toBe("src");
  });
});

describe("visibleRows", () => {
  const tree = buildChangedFilesTree([file("src/a/x.ts"), file("src/b/y.ts"), file("top.ts")]);

  it("shows only the top level while folders are folded", () => {
    expect(names(visibleRows(tree, {}, false))).toEqual(["src", "top.ts"]);
  });

  it("opens every folder when all are expanded", () => {
    expect(names(visibleRows(tree, {}, true))).toEqual([
      "src",
      "  a",
      "    x.ts",
      "  b",
      "    y.ts",
      "top.ts",
    ]);
  });

  it("lets the reader's own toggles override the default either way", () => {
    expect(names(visibleRows(tree, { src: true }, false))).toEqual(["src", "  a", "  b", "top.ts"]);
    expect(names(visibleRows(tree, { "src/a": false }, true))).toEqual([
      "src",
      "  a",
      "  b",
      "    y.ts",
      "top.ts",
    ]);
  });

  it("lists every folder path for keying the reader's toggles", () => {
    expect(folderPaths(tree)).toEqual(["src", "src/a", "src/b"]);
  });
});

describe("sumStats", () => {
  it("adds up the files' counts", () => {
    expect(sumStats([file("a", 3, 1), file("b", 4, 2)])).toEqual({ added: 7, removed: 3 });
  });
});

describe("formatDiffCount", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1000, "1k"],
    [1234, "1.2k"],
    [12_345, "12k"],
    [999_499, "999k"],
    [999_600, "1m"],
    [3_400_000, "3.4m"],
  ])("%d reads as %s", (value, expected) => {
    expect(formatDiffCount(value)).toBe(expected);
  });
});

describe("splitForMiddleTruncate", () => {
  it("leaves a short name whole", () => {
    expect(splitForMiddleTruncate("session.ts")).toBeNull();
  });

  it("keeps the last ten characters of a long one", () => {
    expect(splitForMiddleTruncate("use-turn-review-files.test.tsx")).toEqual({
      head: "use-turn-review-file",
      tail: "s.test.tsx",
    });
  });

  it("never cuts inside a surrogate pair", () => {
    const split = splitForMiddleTruncate(`${"a".repeat(10)}😀${"b".repeat(9)}`);
    expect(split?.tail).toBe(`😀${"b".repeat(9)}`);
  });
});

import { describe, expect, it } from "vitest";
import type { ProjectEntry } from "./fs-api";
import {
  buildSearchRows,
  collectMatches,
  isHiddenPath,
  literalIndexQuery,
  normalizeTreeQuery,
  SEARCH_INDEX_LIMIT,
  stillListed,
} from "./tree-search";

const dir = (path: string, ignored?: boolean): ProjectEntry => ({
  path,
  kind: "directory",
  ...(ignored ? { ignored } : {}),
});
const file = (path: string): ProjectEntry => ({ path, kind: "file" });

const LISTINGS = new Map<string, readonly ProjectEntry[]>([
  ["", [dir("src"), dir("node_modules", true), file(".env"), file("README.md")]],
  ["src", [dir("src/lib"), file("src/main.ts")]],
  ["node_modules", [dir("node_modules/react", true)]],
]);
const NONE = new Map<string, readonly ProjectEntry[]>();

const paths = (rows: { path: string }[]) => rows.map((r) => r.path);

describe("normalizeTreeQuery", () => {
  it("trims, lower-cases and reads a backslash as a slash", () => {
    expect(normalizeTreeQuery("  Src\\Lib ")).toBe("src/lib");
    expect(normalizeTreeQuery("   ")).toBe("");
  });
});

describe("literalIndexQuery", () => {
  it("escapes the index matcher's operators so the query is taken literally", () => {
    expect(literalIndexQuery("main.ts")).toBe("main.ts");
    expect(literalIndexQuery("^src")).toBe("\\^src");
    expect(literalIndexQuery("'src")).toBe("\\'src");
    expect(literalIndexQuery("!src")).toBe("\\!src");
    expect(literalIndexQuery("ts$")).toBe("ts\\$");
    // A space would split the query into separate words.
    expect(literalIndexQuery("my file")).toBe("my\\ file");
  });
});

describe("isHiddenPath", () => {
  it("is any segment starting with a dot", () => {
    expect(isHiddenPath(".env")).toBe(true);
    expect(isHiddenPath("a/.cache/b")).toBe(true);
    expect(isHiddenPath("a/b.c")).toBe(false);
  });
});

describe("stillListed", () => {
  it("trusts the index for folders not loaded, and the listings where they are", () => {
    expect(stillListed(LISTINGS, "src/main.ts")).toBe(true);
    // `src/lib` is not loaded: nothing contradicts the index.
    expect(stillListed(LISTINGS, "src/lib/deep/util.ts")).toBe(true);
    // `src` is loaded and has no `gone.ts`: deleted or renamed.
    expect(stillListed(LISTINGS, "src/gone.ts")).toBe(false);
    // The root has no `old`: its whole subtree is gone.
    expect(stillListed(LISTINGS, "old/a/b.ts")).toBe(false);
  });
});

describe("collectMatches", () => {
  it("matches a substring of the whole relative path, in loaded listings and index hits", () => {
    const { hits } = collectMatches(
      LISTINGS,
      ["src/lib/deep/util.ts", "docs/guide.md"],
      "lib",
      false,
    );
    // `src/lib` and the index's file under it; `docs/guide.md` holds no "lib".
    expect([...hits.keys()].sort()).toEqual(["src/lib", "src/lib/deep/util.ts"]);
    expect(hits.get("src/lib/deep/util.ts")).toEqual({ kind: "file", ignored: false });
  });

  it("narrows the index's fuzzy answers to the same substring rule", () => {
    // A fuzzy matcher answers `mt` with `main.ts`; the tree does not.
    expect(collectMatches(NONE, ["src/main.ts"], "mt", false).hits.size).toBe(0);
  });

  it("drops an index hit the loaded listings say is gone", () => {
    const { hits } = collectMatches(LISTINGS, ["src/deleted.ts", "src/main.ts"], ".ts", false);
    expect([...hits.keys()]).toEqual(["src/main.ts"]);
  });

  it("finds ignored entries the tree has loaded, flagged as ignored", () => {
    const { hits, ignoredDirs } = collectMatches(LISTINGS, [], "react", false);
    expect(hits.get("node_modules/react")).toEqual({ kind: "directory", ignored: true });
    expect(ignoredDirs.has("node_modules")).toBe(true);
  });

  it("skips hidden paths unless hidden files are shown", () => {
    expect(collectMatches(LISTINGS, [], "env", false).hits.has(".env")).toBe(false);
    expect(collectMatches(LISTINGS, [], "env", true).hits.has(".env")).toBe(true);
    expect(collectMatches(NONE, [".github/ci.yml"], "ci", false).hits.size).toBe(0);
  });

  it("matches nothing for an empty query", () => {
    expect(collectMatches(LISTINGS, ["a.ts"], "", true).hits.size).toBe(0);
  });
});

describe("buildSearchRows", () => {
  it("shows each hit under its folders, all open, folders first then by name", () => {
    const { rows, matchCount, firstMatch } = buildSearchRows(
      collectMatches(NONE, ["src/z/util.ts", "src/a.ts", "b.ts", "A.ts"], ".ts", false),
    );
    // `src` holds a folder and a file, so it is not compacted; `src/z` is.
    expect(paths(rows)).toEqual(["src", "src/z", "src/z/util.ts", "src/a.ts", "A.ts", "b.ts"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 1, 0, 0]);
    expect(matchCount).toBe(4);
    expect(firstMatch).toBe("src/z/util.ts");
  });

  it("compacts a folder whose only shown child is a folder, and marks hits", () => {
    const { rows } = buildSearchRows(
      collectMatches(NONE, ["a/b/c/one.ts", "a/b/c/two.ts"], "c/", false),
    );
    expect(rows[0]).toMatchObject({ path: "a/b/c", depth: 0, chain: ["a", "a/b", "a/b/c"] });
    expect(rows[0].match).toBe(false);
    expect(rows.slice(1)).toEqual([
      expect.objectContaining({ path: "a/b/c/one.ts", depth: 1, match: true }),
      expect.objectContaining({ path: "a/b/c/two.ts", depth: 1, match: true }),
    ]);
  });

  it("keeps a folder the user closed during the search closed", () => {
    const matches = collectMatches(NONE, ["src/a.ts", "src/b.ts", "top.ts"], ".ts", false);
    expect(paths(buildSearchRows(matches, new Set(["src"])).rows)).toEqual(["src", "top.ts"]);
  });

  it("dims a folder above a hit when the listings know it is ignored", () => {
    const { rows } = buildSearchRows(collectMatches(LISTINGS, [], "react", false));
    expect(rows[0]).toMatchObject({
      path: "node_modules/react",
      chain: ["node_modules", "node_modules/react"],
      ignored: true,
      match: true,
    });
  });

  it("says there may be more only when a full page of index hits held", () => {
    const page = Array.from({ length: SEARCH_INDEX_LIMIT }, (_, i) => `f/x-${i}.ts`);
    expect(buildSearchRows(collectMatches(NONE, page, "x-", false)).truncated).toBe(true);
    // A full fuzzy page that the substring rule empties is no matches, not "more".
    const fuzzyOnly = buildSearchRows(collectMatches(NONE, page, "zzz", false));
    expect(fuzzyOnly).toMatchObject({ matchCount: 0, truncated: false });
    // Fewer than a page held: everything is shown.
    expect(buildSearchRows(collectMatches(NONE, page, "x-1", false)).truncated).toBe(false);
  });
});

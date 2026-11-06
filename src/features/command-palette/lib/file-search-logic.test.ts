import { describe, expect, it } from "vitest";
import {
  emptyQueryFiles,
  findMatchIndices,
  highlightSegments,
  normalizeFileQuery,
  relativeTo,
  toFileSearchMatches,
} from "./file-search-logic";

describe("normalizeFileQuery", () => {
  it("drops case, whitespace and a habitual leading @ . or /", () => {
    expect(normalizeFileQuery("  @Src/Main TS ")).toBe("src/maints");
    expect(normalizeFileQuery("./lib")).toBe("lib");
  });
});

describe("findMatchIndices", () => {
  it("finds the query as an in-order subsequence", () => {
    expect(findMatchIndices("button.tsx", "btn")).toEqual([0, 2, 5]);
    expect(findMatchIndices("Button.tsx", "btn")).toEqual([0, 2, 5]);
  });

  it("returns null when a character is missing, and [] for no query", () => {
    expect(findMatchIndices("main.ts", "xyz")).toBeNull();
    expect(findMatchIndices("main.ts", "")).toEqual([]);
  });
});

describe("toFileSearchMatches", () => {
  it("keeps the backend's order and caps at the limit", () => {
    const matches = toFileSearchMatches(
      [
        { path: "/p/src/b.ts", rel: "src/b.ts" },
        { path: "/p/a.ts", rel: "a.ts" },
        { path: "/p/c.ts", rel: "c.ts" },
      ],
      "ts",
      2,
    );
    expect(matches.map((match) => match.rel)).toEqual(["src/b.ts", "a.ts"]);
    expect(matches[0]).toMatchObject({ name: "b.ts", nameMatchIndices: [2, 3] });
  });

  it("renders a row the backend matched on other grounds without highlights", () => {
    const [match] = toFileSearchMatches([{ path: "/p/x.ts", rel: "x.ts" }], "qq");
    expect(match?.nameMatchIndices).toEqual([]);
  });

  it("highlights the file name only; the path carries no match positions", () => {
    const [match] = toFileSearchMatches(
      [{ path: "/p/src/features/app.tsx", rel: "src/features/app.tsx" }],
      "app",
    );
    expect(match).toEqual({
      path: "/p/src/features/app.tsx",
      rel: "src/features/app.tsx",
      name: "app.tsx",
      nameMatchIndices: [0, 1, 2],
    });
    expect(match).not.toHaveProperty("relMatchIndices");
  });
});

describe("highlightSegments", () => {
  it("joins adjacent matched characters into one run", () => {
    expect(highlightSegments("button.tsx", [0, 1, 5])).toEqual([
      { text: "bu", matched: true },
      { text: "tto", matched: false },
      { text: "n", matched: true },
      { text: ".tsx", matched: false },
    ]);
  });

  it("returns the whole value as one plain run with no indices", () => {
    expect(highlightSegments("main.ts", [])).toEqual([{ text: "main.ts", matched: false }]);
  });

  it("ignores out-of-range and out-of-order indices", () => {
    expect(highlightSegments("ab", [1, 0, 9])).toEqual([
      { text: "a", matched: false },
      { text: "b", matched: true },
    ]);
  });
});

describe("relativeTo", () => {
  it("strips the root, with or without a trailing slash, and rejects outsiders", () => {
    expect(relativeTo("/p", "/p/src/a.ts")).toBe("src/a.ts");
    expect(relativeTo("/p/", "/p/a.ts")).toBe("a.ts");
    expect(relativeTo("/p", "/pp/a.ts")).toBeNull();
  });
});

describe("emptyQueryFiles", () => {
  it("lists open tabs, then recents newest first, then the index, each once", () => {
    const files = emptyQueryFiles({
      projectPath: "/p",
      openFiles: ["/p/open.ts", "/elsewhere/x.ts"],
      recentFiles: [
        { absPath: "/p/old.ts", touchedAt: 1 },
        { absPath: "/p/new.ts", touchedAt: 2 },
        { absPath: "/p/open.ts", touchedAt: 3 },
      ],
      indexed: [
        { path: "/p/new.ts", rel: "new.ts" },
        { path: "/p/z.ts", rel: "z.ts" },
      ],
    });
    expect(files.map((file) => file.rel)).toEqual(["open.ts", "new.ts", "old.ts", "z.ts"]);
  });

  it("stops at the limit", () => {
    const files = emptyQueryFiles({
      projectPath: "/p",
      openFiles: [],
      recentFiles: [],
      indexed: [
        { path: "/p/a", rel: "a" },
        { path: "/p/b", rel: "b" },
      ],
      limit: 1,
    });
    expect(files).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import { findInText, firstMatchAtOrAfter } from "./plain-find";

describe("findInText", () => {
  const text = "alpha beta\nBeta gamma\n\nbetabeta";

  it("finds every match with its 1-based line and columns", () => {
    expect(findInText(text, "beta", true)).toEqual([
      { line: 1, column: 7, endColumn: 11 },
      { line: 4, column: 1, endColumn: 5 },
      { line: 4, column: 5, endColumn: 9 },
    ]);
  });

  it("ignores case unless asked not to", () => {
    expect(findInText(text, "BETA", false).map((m) => m.line)).toEqual([1, 2, 4, 4]);
    expect(findInText(text, "BETA", true)).toEqual([]);
  });

  it("stops at the cap, and finds nothing for an empty or multi-line query", () => {
    expect(findInText("aaaa", "a", true, 2)).toHaveLength(2);
    expect(findInText(text, "", true)).toEqual([]);
    expect(findInText(text, "beta\nBeta", true)).toEqual([]);
  });

  it("handles a long file in one pass", () => {
    const big = "x\n".repeat(200_000) + "needle";
    expect(findInText(big, "needle", true)).toEqual([{ line: 200_001, column: 1, endColumn: 7 }]);
  });
});

describe("firstMatchAtOrAfter", () => {
  const matches = findInText("a\nb a\nc\na", "a", true);

  it("starts from the cursor's line, wrapping to the first", () => {
    expect(firstMatchAtOrAfter(matches, 2)).toBe(1);
    expect(firstMatchAtOrAfter(matches, 3)).toBe(2);
    expect(firstMatchAtOrAfter(matches, 9)).toBe(0);
    expect(firstMatchAtOrAfter([], 1)).toBe(-1);
  });
});

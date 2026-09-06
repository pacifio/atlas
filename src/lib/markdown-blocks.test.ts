import { describe, it, expect } from "vitest";
import {
  splitBlocks,
  splitTopLevelBlocks,
  mayStartNewBlock,
  isIncompleteCodeFence,
  hasReferenceDefinitions,
} from "./markdown-blocks";

describe("splitBlocks", () => {
  it("returns the whole source as one block when there is nothing to split", () => {
    expect(splitBlocks("just a paragraph")).toEqual({
      blocks: ["just a paragraph"],
      tailStart: 0,
    });
  });

  it("splits top-level blocks and reports where the last one starts", () => {
    const src = "first para\n\nsecond para\n\n# heading";
    const { blocks, tailStart } = splitBlocks(src);
    expect(blocks).toEqual(["first para", "second para", "# heading"]);
    expect(src.slice(tailStart)).toBe("# heading");
  });

  it("gives a tail offset that reconstructs the trailing block as it grows", () => {
    // The invariant the incremental path depends on: while the tail is only
    // appended to, `source.slice(tailStart)` IS the trailing block.
    const src = "intro\n\nthe tail";
    const { tailStart } = splitBlocks(src);
    const grown = src + " keeps going";
    expect(grown.slice(tailStart)).toBe("the tail keeps going");
    const regrown = splitBlocks(grown).blocks;
    expect(regrown[regrown.length - 1]).toBe("the tail keeps going");
  });

  it("keeps splitTopLevelBlocks behaviour", () => {
    expect(splitTopLevelBlocks("a\n\nb")).toEqual(["a", "b"]);
    expect(splitTopLevelBlocks("")).toEqual([]);
  });
});

describe("mayStartNewBlock", () => {
  it("is false for prose that only continues the current block", () => {
    expect(mayStartNewBlock(" more words", false)).toBe(false);
    expect(mayStartNewBlock("\nanother sentence", false)).toBe(false);
  });

  it("is true for a delta that could open a block", () => {
    for (const delta of ["\n\n", "\n# h", "\n- item", "\n1. item", "\n> quote", "\n```ts"]) {
      expect(mayStartNewBlock(delta, false)).toBe(true);
    }
  });

  it("inside an open fence only a fence line matters", () => {
    expect(mayStartNewBlock("\n- not a list, this is code", true)).toBe(false);
    expect(mayStartNewBlock("\n```", true)).toBe(true);
  });
});

describe("isIncompleteCodeFence", () => {
  it("detects an unclosed fence", () => {
    expect(isIncompleteCodeFence("```ts\nconst a = 1;")).toBe(true);
    expect(isIncompleteCodeFence("```ts\nconst a = 1;\n```")).toBe(false);
    expect(isIncompleteCodeFence("not code")).toBe(false);
  });
});

describe("hasReferenceDefinitions", () => {
  it("spots reference and footnote definitions", () => {
    expect(hasReferenceDefinitions("[ref]: https://example.com")).toBe(true);
    expect(hasReferenceDefinitions("[^1]: a note")).toBe(true);
    expect(hasReferenceDefinitions("[inline](https://example.com)")).toBe(false);
  });
});

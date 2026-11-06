import { describe, expect, it } from "vitest";
import { EMPTY_SPLIT, splitIncremental, splitTopLevelBlocks } from "@/lib/markdown-blocks";

/** Stream `doc` one character at a time, carrying the incremental state. */
function streamed(doc: string): string[] {
  let carry = EMPTY_SPLIT;
  for (let i = 1; i <= doc.length; i++) carry = splitIncremental(doc.slice(0, i), carry);
  return carry.blocks;
}

const DOCS: Record<string, string> = {
  setext: "A paragraph here\nthat continues\n---\n\nnext para\n",
  lazyContinuation: "para one\n\npara two\nlazily continued\nand more\n",
  looseList: "intro\n\n- one\n- two\n\n- three after blank\n\nafter\n",
  nestedList: "intro\n\n- a\n  - b\n  - c\n- d\n\nend\n",
  openFence: "before\n\n```ts\nconst x = 1;\nconst y = 2;\n",
  closedFence: "before\n\n```ts\nconst x = 1;\n```\n\nafter\n",
  blockquote: "intro\n\n> quoted\n> more quote\n\nout\n",
  table: "intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter\n",
  headings: "# H1\n\ntext\n\n## H2\n\nmore\n\n### H3\n\nlast\n",
  thematicBreak: "one\n\n***\n\ntwo\n\n___\n\nthree\n",
  htmlBlock: "intro\n\n<div>\n  <p>hi</p>\n</div>\n\nafter\n",
  mixed:
    "# Title\n\nSome prose.\n\n- a\n- b\n\n```js\nfoo();\n```\n\n> note\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\nTrailing para\nwith lazy line\n---\n\nEnd.\n",
  // Repeated and lookalike blocks. A version of the splitter that found the
  // last-but-one block by searching for its TEXT passed every document above
  // and failed every one of these: `ok` twice duplicated a block, and `foo`
  // followed by `foo bar foo` truncated the last block to `foo`.
  repeatedBlock: "intro\n\nok\n\nok\n\nok\n",
  lastBlockContainsPrev: "alpha\n\nfoo\n\nfoo bar foo\n",
  tinyBlockAfterBigGap: "para\n\n\n\n\n\nx\n\nnext\n",
  identicalTail: "a\n\nb\n\nb\n",
  blankHeavy: "\n\n\none\n\n\n\n\ntwo\n\n\n",
  repeatedListItems: "- a\n- a\n\n- a\n- a\n",
  sameParaTwice: "same\n\nsame\n",
  prefixOfLater: "ab\n\nabc\n\nabcd\n",
};

describe("splitIncremental equals a full split at every prefix", () => {
  for (const [name, doc] of Object.entries(DOCS)) {
    it(name, () => {
      for (let i = 1; i <= doc.length; i++) {
        const prefix = doc.slice(0, i);
        let carry = EMPTY_SPLIT;
        for (let j = 1; j <= i; j++) carry = splitIncremental(doc.slice(0, j), carry);
        expect(carry.blocks, `prefix length ${i}: ${JSON.stringify(prefix)}`).toEqual(
          splitTopLevelBlocks(prefix),
        );
      }
    });
  }

  it("re-splits in full when the source shrinks", () => {
    let carry = splitIncremental("a\n\nb\n\nc\n\nd\n", EMPTY_SPLIT);
    carry = splitIncremental("a\n\nb\n", carry);
    expect(carry.blocks).toEqual(splitTopLevelBlocks("a\n\nb\n"));
  });

  it("re-parses the window when only the tail changed at the same length", () => {
    let carry = splitIncremental("a\n\nb\n\nc\n\nd\n", EMPTY_SPLIT);
    carry = splitIncremental("a\n\nb\n\nc\n\nZ\n", carry);
    expect(carry.blocks).toEqual(splitTopLevelBlocks("a\n\nb\n\nc\n\nZ\n"));
  });

  it("re-splits in full when the source is replaced rather than appended to", () => {
    let carry = splitIncremental("# A\n\npara one\n\npara two\n", EMPTY_SPLIT);
    carry = splitIncremental("totally different\n\nsecond\n\nthird\n", carry);
    expect(carry.blocks).toEqual(splitTopLevelBlocks("totally different\n\nsecond\n\nthird\n"));
  });

  it("matches on the full documents too", () => {
    for (const doc of Object.values(DOCS)) {
      expect(streamed(doc)).toEqual(splitTopLevelBlocks(doc));
    }
  });
});

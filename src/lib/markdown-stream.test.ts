import { describe, it, expect } from "vitest";
import { closeIncompleteMarkdown } from "./markdown-stream";
import { parseMarkdown } from "./markdown-render";

/** What the reader actually sees: the repair only matters if it renders. */
function html(src: string): string {
  return parseMarkdown(closeIncompleteMarkdown(src));
}

describe("closeIncompleteMarkdown", () => {
  it("leaves complete markdown untouched", () => {
    for (const src of [
      "plain text",
      "**bold** and *italic*",
      "a `code` span",
      "~~struck~~",
      "[label](https://example.com)",
      "- one\n- two",
      "# heading",
    ]) {
      expect(closeIncompleteMarkdown(src)).toBe(src);
    }
  });

  it("closes emphasis the stream cut in half", () => {
    expect(html("**bol")).toContain("<strong>bol</strong>");
    expect(html("**bold** and *ital")).toContain("<em>ital</em>");
    expect(html("~~struc")).toContain("<del>struc</del>");
  });

  it("closes an unterminated code span", () => {
    expect(html("call `fn(")).toContain("<code>fn(</code>");
  });

  it("is idempotent across a marker arriving one character at a time", () => {
    // The frames a stream actually produces for `**bold**`. Every one of them
    // must render the same bold word — that is what stops the snap.
    for (const frame of ["**bold", "**bold*", "**bold**"]) {
      expect(html(frame)).toContain("<strong>bold</strong>");
    }
  });

  it("hides a link until its syntax is complete", () => {
    expect(closeIncompleteMarkdown("see [the doc")).toBe("see ");
    expect(closeIncompleteMarkdown("see [the doc](https://exa")).toBe("see ");
    expect(closeIncompleteMarkdown("see ![alt](https://exa")).toBe("see ");
    expect(closeIncompleteMarkdown("see [the doc](https://e.com)")).toBe(
      "see [the doc](https://e.com)",
    );
  });

  it("leaves task-list brackets alone", () => {
    expect(closeIncompleteMarkdown("- [ ] todo")).toBe("- [ ] todo");
  });

  it("does not treat a list bullet as emphasis", () => {
    expect(closeIncompleteMarkdown("* one\n* two")).toBe("* one\n* two");
  });

  it("leaves underscores in identifiers alone", () => {
    // snake_case is far more common in agent output than underscore italics.
    expect(closeIncompleteMarkdown("call some_helper_fn")).toBe("call some_helper_fn");
  });

  it("ignores markers inside a complete code span", () => {
    expect(closeIncompleteMarkdown("`a * b`")).toBe("`a * b`");
  });

  it("declines to repair anything inside an unclosed fence", () => {
    const src = "```ts\nconst a = b * c;\n";
    expect(closeIncompleteMarkdown(src)).toBe(src);
  });
});

// @vitest-environment happy-dom
//
// `Markdown` (plans, the plan review, notes, notebooks) on the package's
// `StreamingMarkdown`: the `.prose-session` root, the chat engine's
// highlighting, and links that can never navigate the webview.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import MarkdownImpl from "./markdown-impl";

afterEach(cleanup);

describe("MarkdownImpl", () => {
  it("renders on the package prose root", () => {
    const { container } = render(<MarkdownImpl>{"hello"}</MarkdownImpl>);
    expect(container.querySelector(".prose-session")).not.toBeNull();
  });

  it("highlights a fence in its named language", () => {
    const { container } = render(
      <MarkdownImpl>{"```ts\nconst answer: number = 42;\n```"}</MarkdownImpl>,
    );
    expect(container.querySelectorAll(".hljs-keyword").length).toBeGreaterThan(0);
  });

  it("leaves a plain-text fence uncoloured", () => {
    const { container } = render(<MarkdownImpl>{"```text\nconst a = 1;\n```"}</MarkdownImpl>);
    expect(container.querySelector('[class^="hljs-"]')).toBeNull();
  });

  it("drops a javascript: link's href and opens the rest outside", () => {
    const { container } = render(
      <MarkdownImpl>{"[bad](javascript:alert(1)) and [good](https://example.com)"}</MarkdownImpl>,
    );
    const [bad, good] = container.querySelectorAll("a");
    expect(bad.getAttribute("href") ?? "").toBe("");
    expect(good.getAttribute("href")).toBe("https://example.com");
    expect(good.getAttribute("target")).toBe("_blank");
  });
});

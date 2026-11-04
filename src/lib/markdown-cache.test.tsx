// @vitest-environment happy-dom
//
// A code fence in cached markdown gets its corner (the language and Copy)
// through a React portal into a host inside its `pre`, on the package's
// `.prose-session` root. These pin the host, what Copy copies, and that a
// changed source is enhanced again.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// No worker in happy-dom: small blocks parse on the main thread anyway.
vi.mock("./markdown.worker?worker", () => ({
  default: class {
    postMessage() {}
    addEventListener() {}
    removeEventListener() {}
    terminate() {}
  },
}));

import { CachedMarkdown, loadMarkdownRenderer } from "./markdown-cache";

const writeText = vi.fn(async (_text: string) => {});

beforeAll(async () => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  await loadMarkdownRenderer();
});
afterEach(() => {
  cleanup();
  writeText.mockClear();
});

const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;

describe("CachedMarkdown", () => {
  it("renders on the package prose root", () => {
    const { container } = render(<CachedMarkdown source="hello" />);
    expect(container.firstElementChild?.classList.contains("prose-session")).toBe(true);
  });

  it("gives a fence a Copy button and its language", () => {
    const { container } = render(<CachedMarkdown source={fence("ts", "const a = 1;")} />);
    const pre = container.querySelector("pre")!;
    const host = pre.querySelector("[data-code-actions]")!;
    expect(host).not.toBeNull();
    expect(host.textContent).toContain("ts");
    expect(screen.getByRole("button", { name: "Copy code" })).not.toBeNull();
  });

  it("copies the fence's code, not its label", async () => {
    render(<CachedMarkdown source={fence("ts", "const a = 1;")} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    });
    // The code element's text, as before: its trailing newline included.
    expect(writeText).toHaveBeenCalledWith("const a = 1;\n");
  });

  it("labels no language on a plain-text fence", () => {
    const { container } = render(<CachedMarkdown source={fence("text", "just words")} />);
    const host = container.querySelector("[data-code-actions]")!;
    expect(host.textContent).toBe("");
    expect(screen.getByRole("button", { name: "Copy code" })).not.toBeNull();
  });

  it("enhances the new fence when the source changes", () => {
    const view = render(<CachedMarkdown source={fence("ts", "one")} />);
    view.rerender(<CachedMarkdown source={fence("rust", "fn two() {}")} />);
    const hosts = view.container.querySelectorAll("[data-code-actions]");
    expect(hosts).toHaveLength(1);
    expect(hosts[0].textContent).toContain("rust");
  });

  it("puts nothing in a fence when told not to", () => {
    const { container } = render(
      <CachedMarkdown source={fence("ts", "const a = 1;")} codeActions={null} />,
    );
    expect(container.querySelector("[data-code-actions]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy code" })).toBeNull();
  });
});

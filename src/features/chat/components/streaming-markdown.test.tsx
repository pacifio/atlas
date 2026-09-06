// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { StreamingMarkdown } from "./streaming-markdown";
import { noteTailHtml, tailFallback } from "@/lib/markdown-cache";

afterEach(cleanup);

/** The block split is rAF-coalesced, so the tail only reaches the DOM a frame
 *  after the source changes. Poll for the text rather than racing the clock. */
async function tailReads(container: HTMLElement, text: string): Promise<void> {
  await waitFor(() =>
    expect(container.querySelector(".atlas-stream-tail")?.textContent).toBe(text),
  );
}

describe("StreamingMarkdown", () => {
  it("renders the live tail formatted, with the caret hook on it", () => {
    const { container } = render(
      <StreamingMarkdown source={"Intro line\n\nSecond paragraph"} streaming />,
    );
    const tail = container.querySelector(".atlas-stream-tail");
    expect(tail).not.toBeNull();
    expect(tail?.textContent).toContain("Second paragraph");
    // Only the trailing block is live; settled ones are plain cached blocks.
    expect(container.querySelectorAll(".atlas-stream-tail")).toHaveLength(1);
    expect(container.querySelectorAll(".atlas-md-block").length).toBeGreaterThan(1);
  });

  it("formats markup the stream has not finished writing", () => {
    // `**bol` renders bold immediately instead of showing its asterisks and
    // snapping a few frames later.
    const { container } = render(<StreamingMarkdown source="Hello **bol" streaming />);
    expect(container.querySelector(".atlas-stream-tail strong")?.textContent).toBe("bol");
  });

  it("grows the tail in place rather than rebuilding it", async () => {
    const { container, rerender } = render(<StreamingMarkdown source="Hello wo" streaming />);
    await tailReads(container, "Hello wo");
    const p = container.querySelector(".atlas-stream-tail p");
    expect(p).not.toBeNull();

    rerender(<StreamingMarkdown source="Hello world, and more" streaming />);
    await tailReads(container, "Hello world, and more");

    // Same element, new text: the patch changed a text node, it did not throw
    // the paragraph away and build another.
    expect(container.querySelector(".atlas-stream-tail p")).toBe(p);
  });

  it("drops the tail marker once the turn settles", async () => {
    const { container, rerender } = render(
      <StreamingMarkdown source={"Intro\n\nAnswer text"} streaming />,
    );
    await tailReads(container, "Answer text");
    rerender(<StreamingMarkdown source={"Intro\n\nAnswer text"} streaming={false} />);
    await waitFor(() => expect(container.querySelector(".atlas-stream-tail")).toBeNull());
    expect(container.textContent).toContain("Answer text");
  });
});

describe("tail html handoff", () => {
  it("offers the last tail render to any longer source that starts with it", () => {
    noteTailHtml("Answer so f", "<p>Answer so f</p>");
    // The settling block asks with its final raw source.
    expect(tailFallback("Answer so far")).toBe("<p>Answer so f</p>");
    // …but never lends html to unrelated text.
    expect(tailFallback("Something else entirely")).toBeNull();
    // …nor to a source it barely covers: that would swap a text flash for a
    // height jump.
    expect(tailFallback("Answer so far" + " and much, much more".repeat(4))).toBeNull();
  });
});

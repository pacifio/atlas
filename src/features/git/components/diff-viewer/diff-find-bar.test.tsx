// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { parsePatchFiles, type CodeViewDiffItem } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import { DIFF_FIND_DEBOUNCE_MS, DiffFindBar } from "./diff-find-bar";

const PATCH = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
-const needle = 1;
+const needle = 2;
 tail
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1,1 +1,1 @@
-old
+a needle here
`;

const files = parsePatchFiles(PATCH)[0]!.files;
const itemsWith = (collapsed: Record<string, boolean>): CodeViewDiffItem<unknown>[] =>
  files.map((fileDiff, i) => ({
    id: `f${i}`,
    type: "diff",
    fileDiff,
    collapsed: collapsed[`f${i}`] ?? false,
  }));

function fakeViewer() {
  const scrollTo = vi.fn();
  const viewer = {
    scrollTo,
    getInstance: () => ({
      getRenderedItems: () => [],
      subscribeToScroll: () => () => {},
      getScrollTop: () => 0,
      getTopForItem: () => 0,
    }),
  } as unknown as CodeViewHandle<unknown, undefined>;
  return { viewer, scrollTo };
}

const count = () => screen.getByRole("search").querySelector("[aria-live]")?.textContent;

async function type(text: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Find in diff" }), {
    target: { value: text },
  });
  await act(async () => {
    vi.advanceTimersByTime(DIFF_FIND_DEBOUNCE_MS + 1);
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("DiffFindBar", () => {
  it("counts matches across every file, after the debounce", async () => {
    const { viewer } = fakeViewer();
    render(
      <DiffFindBar viewer={viewer} items={itemsWith({})} onUnfold={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Find in diff" }), {
      target: { value: "needle" },
    });
    // Nothing searched mid-keystroke.
    expect(count()).toBe("");
    await act(async () => {
      vi.advanceTimersByTime(DIFF_FIND_DEBOUNCE_MS + 1);
    });
    expect(count()).toBe("1 of 3");
    await type("absent");
    expect(count()).toBe("No results");
  });

  it("steps next and previous, wrapping, and scrolls to each match", async () => {
    const { viewer, scrollTo } = fakeViewer();
    render(
      <DiffFindBar viewer={viewer} items={itemsWith({})} onUnfold={vi.fn()} onClose={vi.fn()} />,
    );
    await type("needle");
    expect(scrollTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "f0", side: "deletions", lineNumber: 1 }),
    );
    const input = screen.getByRole("textbox", { name: "Find in diff" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(count()).toBe("2 of 3");
    expect(scrollTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "f0", side: "additions", lineNumber: 1 }),
    );
    fireEvent.click(screen.getByRole("button", { name: /next match/i }));
    expect(count()).toBe("3 of 3");
    fireEvent.click(screen.getByRole("button", { name: /next match/i }));
    expect(count()).toBe("1 of 3");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(count()).toBe("3 of 3");
  });

  it("matches case only when asked", async () => {
    const { viewer } = fakeViewer();
    render(
      <DiffFindBar viewer={viewer} items={itemsWith({})} onUnfold={vi.fn()} onClose={vi.fn()} />,
    );
    await type("NEEDLE");
    expect(count()).toBe("1 of 3");
    fireEvent.click(screen.getByRole("button", { name: "Match case" }));
    await act(async () => {
      vi.advanceTimersByTime(DIFF_FIND_DEBOUNCE_MS + 1);
    });
    expect(count()).toBe("No results");
  });

  it("unfolds a folded file before going to its match", async () => {
    const { viewer, scrollTo } = fakeViewer();
    const onUnfold = vi.fn();
    const props = { viewer, onUnfold, onClose: vi.fn() };
    const { rerender } = render(<DiffFindBar {...props} items={itemsWith({ f1: true })} />);
    await type("here");
    // The only match is in the folded file: it is asked to unfold, and the
    // viewer is not scrolled to a line it has not drawn.
    expect(count()).toBe("1 of 1");
    expect(onUnfold).toHaveBeenCalledWith("f1");
    expect(scrollTo).not.toHaveBeenCalled();
    // The panel unfolds it; the bar then goes to the line.
    rerender(<DiffFindBar {...props} items={itemsWith({})} />);
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ id: "f1", side: "additions", lineNumber: 1 }),
    );
  });

  it("keeps its place when the panel re-renders with new callbacks and new files", async () => {
    const { viewer, scrollTo } = fakeViewer();
    const props = { viewer, onClose: vi.fn() };
    const { rerender } = render(
      <DiffFindBar {...props} onUnfold={vi.fn()} items={itemsWith({})} />,
    );
    await type("needle");
    fireEvent.click(screen.getByRole("button", { name: /next match/i }));
    fireEvent.click(screen.getByRole("button", { name: /next match/i }));
    expect(count()).toBe("3 of 3");
    scrollTo.mockClear();
    // A pending file loading: a new `onUnfold` and new items (fresh objects,
    // same text) — nothing about the search changed.
    rerender(<DiffFindBar {...props} onUnfold={vi.fn()} items={itemsWith({})} />);
    await act(async () => {
      vi.advanceTimersByTime(DIFF_FIND_DEBOUNCE_MS + 1);
    });
    expect(count()).toBe("3 of 3");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("searches once when Enter beats the debounce", async () => {
    const { viewer, scrollTo } = fakeViewer();
    render(
      <DiffFindBar viewer={viewer} items={itemsWith({})} onUnfold={vi.fn()} onClose={vi.fn()} />,
    );
    const input = screen.getByRole("textbox", { name: "Find in diff" });
    fireEvent.change(input, { target: { value: "needle" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(count()).toBe("1 of 3");
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // The debounced search was cancelled, not run again over the same query.
    await act(async () => {
      vi.advanceTimersByTime(DIFF_FIND_DEBOUNCE_MS + 1);
    });
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const { viewer } = fakeViewer();
    const onClose = vi.fn();
    render(
      <DiffFindBar viewer={viewer} items={itemsWith({})} onUnfold={vi.fn()} onClose={onClose} />,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Find in diff" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

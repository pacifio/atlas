// @vitest-environment happy-dom
//
// The page tree is an ARIA tree with one Tab stop: the arrows walk and open
// folders, type-ahead jumps by name, and a page opened from elsewhere opens
// its folders.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// happy-dom lays nothing out, so the virtualizer would draw no rows: draw them all.
const scrollToIndex = vi.fn();
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 24, size: 24 })),
    getTotalSize: () => count * 24,
    scrollToIndex,
  }),
}));

import { KnowledgeTree } from "./knowledge-tree";

afterEach(cleanup);

const entries = [
  { id: "architecture/auth-flow", title: "Auth flow" },
  { id: "architecture/data-model", title: "Data model" },
  { id: "guides/onboarding", title: "Onboarding" },
  { id: "roadmap-q4", title: "Roadmap Q4" },
];

const row = (name: string) => screen.getByText(name).closest<HTMLElement>('[role="treeitem"]')!;

describe("KnowledgeTree", () => {
  it("has one Tab stop and walks the rows with the arrows", () => {
    render(<KnowledgeTree entries={entries} activeEntryId={null} onSelect={vi.fn()} />);
    expect(screen.getByRole("tree", { name: "Notes" })).toBeTruthy();
    const stops = screen.getAllByRole("treeitem").filter((r) => r.tabIndex === 0);
    expect(stops.map((r) => r.textContent)).toEqual(["architecture"]);

    const folder = row("architecture");
    folder.focus();
    fireEvent.keyDown(folder, { key: "ArrowRight" });
    expect(folder.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(folder, { key: "ArrowRight" });
    expect(document.activeElement).toBe(row("Auth flow"));
    fireEvent.keyDown(row("Auth flow"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(row("architecture"));
    fireEvent.keyDown(row("architecture"), { key: "ArrowLeft" });
    expect(row("architecture").getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(row("architecture"), { key: "End" });
    expect(document.activeElement).toBe(row("Roadmap Q4"));
  });

  it("jumps by typed name", () => {
    render(<KnowledgeTree entries={entries} activeEntryId={null} onSelect={vi.fn()} />);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const folder = row("architecture");
    folder.focus();
    fireEvent.keyDown(folder, { key: "r" });
    expect(document.activeElement).toBe(row("Roadmap Q4"));
    // Typed in quick succession, the letters add up to one name…
    fireEvent.keyDown(row("Roadmap Q4"), { key: "o" });
    expect(document.activeElement).toBe(row("Roadmap Q4"));
    // …and after a pause a letter starts a new search.
    now.mockReturnValue(5_000);
    fireEvent.keyDown(row("Roadmap Q4"), { key: "g" });
    expect(document.activeElement).toBe(row("guides"));
    now.mockRestore();
  });

  it("Enter opens a page; a page opened elsewhere opens its folders", () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <KnowledgeTree entries={entries} activeEntryId={null} onSelect={onSelect} />,
    );
    fireEvent.keyDown(row("Roadmap Q4"), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("roadmap-q4");

    act(() => {
      rerender(
        <KnowledgeTree entries={entries} activeEntryId="guides/onboarding" onSelect={onSelect} />,
      );
    });
    expect(row("guides").getAttribute("aria-expanded")).toBe("true");
    expect(row("Onboarding").getAttribute("aria-selected")).toBe("true");
    expect(row("Onboarding").tabIndex).toBe(0);
  });
});

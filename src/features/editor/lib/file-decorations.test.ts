import { describe, expect, it, vi } from "vitest";
import type { BlameLine } from "@/features/git/lib/git-blame-api";
import { FileDecorations, type LineEdit } from "./file-decorations";

const commit = (line: number, author = "Ada"): BlameLine => ({
  line,
  sha: "abc",
  shortSha: "abc",
  author,
  timeMs: 0,
  summary: "first",
  committed: true,
});

/** An edit replacing lines `from`–`to` (1-based) with `text`. */
const edit = (from: number, to: number, text: string, start = from * 100): LineEdit => ({
  range: { start: { line: from - 1 }, end: { line: to - 1 } },
  start,
  text,
});

describe("change bars", () => {
  it("draws each kind on its line numbers", () => {
    const d = new FileDecorations();
    d.setStatus({ added: [3], changed: [5], deletedBefore: [9] });
    const css = d.css();
    expect(css).toContain('[data-column-number="3"]');
    expect(css).toMatch(/data-column-number="5".*\n.*diff-changed-bar/);
    expect(css).toMatch(/data-column-number="9".*\n.*diff-removed-text/);
  });

  it("moves bars below an edit by the lines it added", () => {
    const d = new FileDecorations();
    d.setStatus({ added: [10], changed: [], deletedBefore: [] });
    d.applyChanges([edit(2, 2, "a\nb\nc")]);
    expect(d.css()).toContain('[data-column-number="12"]');
    expect(d.css()).not.toContain('[data-column-number="10"]');
  });
});

describe("blame", () => {
  it("draws the cursor line's note inline when not wrapping", () => {
    const d = new FileDecorations();
    d.setLayout(false, true);
    d.setBlame([commit(4)]);
    d.setCursorLine(4);
    expect(d.css()).toContain('[data-line="4"]::after');
    expect(d.css()).toContain('content: "Ada · first"');
    expect(d.headerBlame()).toBeNull();
  });

  /// The note must never change a line's height: with wrap on, nothing is
  /// drawn in the text, and the header gets the attribution instead.
  it("hands the note to the header while wrapping", () => {
    const d = new FileDecorations();
    d.setLayout(true, true);
    d.setBlame([commit(4)]);
    d.setCursorLine(4);
    expect(d.css()).not.toContain("::after");
    expect(d.headerBlame()?.[0]).toEqual({ kind: "author", text: "Ada" });
  });

  it("calls an edited line uncommitted, and shifts the rest", () => {
    const d = new FileDecorations();
    d.setLayout(true, true);
    d.setBlame([commit(1, "Ada"), commit(2, "Bo"), commit(3, "Cy")]);
    d.applyChanges([edit(2, 2, "changed\nadded")]);
    d.setCursorLine(2);
    expect(
      d
        .headerBlame()
        ?.map((p) => p.text)
        .join(""),
    ).toBe("You · Uncommitted changes");
    d.setCursorLine(4);
    expect(d.headerBlame()?.[0].text).toBe("Cy");
  });

  it("draws nothing without blame, or with the setting off", () => {
    const d = new FileDecorations();
    d.setLayout(false, true);
    d.setCursorLine(1);
    expect(d.css()).not.toContain("::after");
    d.setBlame([commit(1)]);
    d.setLayout(false, false);
    expect(d.css()).not.toContain("::after");
  });

  it("escapes quotes in what it writes into CSS", () => {
    const d = new FileDecorations();
    d.setLayout(false, true);
    d.setBlame([{ ...commit(1), summary: 'say "hi" \\ bye' }]);
    d.setCursorLine(1);
    expect(d.css()).toContain('say \\"hi\\" \\\\ bye');
  });
});

describe("listeners", () => {
  it("hears changes, and a header value is stable until it changes", () => {
    const d = new FileDecorations();
    const heard = vi.fn();
    d.subscribe(heard);
    d.setLayout(true, true);
    d.setBlame([commit(1)]);
    d.setCursorLine(1);
    const first = d.headerBlame();
    d.setStatus(null);
    expect(d.headerBlame()).toBe(first);
    expect(heard).toHaveBeenCalled();
  });
});

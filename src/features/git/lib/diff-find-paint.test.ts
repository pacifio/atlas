// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DiffFindMatch } from "./diff-find";

// The highlight entries are page-wide singletons, made on first paint; the
// test DOM has no Highlight API, so a minimal one stands in before the module
// is loaded.
class FakeHighlight extends Set<Range> {}
const registry = new Map<string, FakeHighlight>();

let mod: typeof import("./diff-find");
beforeAll(async () => {
  vi.stubGlobal("Highlight", FakeHighlight);
  vi.stubGlobal("CSS", { highlights: registry });
  mod = await import("./diff-find");
});

function fileRoot(text: string): ParentNode {
  const root = document.createElement("div");
  const line = document.createElement("div");
  line.setAttribute("data-line", "1");
  line.setAttribute("data-line-type", "change-addition");
  line.textContent = text;
  root.append(line);
  return root;
}

const match = (id: string): DiffFindMatch => ({
  id,
  side: "additions",
  context: false,
  lineNumber: 1,
  deletionLineNumber: -1,
  start: 0,
  end: 3,
});

describe("two find bars painting at once", () => {
  it("each takes back only its own ranges", () => {
    const left = mod.createPaintedRanges();
    const right = mod.createPaintedRanges();
    const a = match("a");
    const b = match("b");
    mod.paintMatches(left, [{ id: "a", root: fileRoot("foo") }], new Map([["a", [a]]]), null);
    mod.paintMatches(right, [{ id: "b", root: fileRoot("foo") }], new Map([["b", [b]]]), b);
    const all = registry.get(mod.DIFF_FIND_HIGHLIGHT)!;
    const current = registry.get(mod.DIFF_FIND_CURRENT_HIGHLIGHT)!;
    expect(all.size).toBe(1);
    expect(current.size).toBe(1);

    // The left bar repaints, then closes: the right bar's ranges stay.
    mod.paintMatches(left, [{ id: "a", root: fileRoot("foo") }], new Map([["a", [a]]]), null);
    expect(all.size).toBe(1);
    mod.clearMatches(left);
    expect(all.size).toBe(0);
    expect(current.size).toBe(1);
    mod.clearMatches(right);
    expect(current.size).toBe(0);
  });
});

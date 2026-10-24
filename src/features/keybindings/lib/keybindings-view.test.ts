import { describe, expect, it } from "vitest";
import { parseCombo } from "./combo";
import { buildRows, filterRows, groupRows, rowClash } from "./keybindings-view";
import { findConflicts, resolveProfile } from "./resolve";
import type { KeybindingProfile } from "./types";

const profile = (bindings: KeybindingProfile["bindings"]): KeybindingProfile => ({
  id: "p",
  name: "Mine",
  bindings,
});

const view = (bindings: KeybindingProfile["bindings"] = {}) => {
  const resolved = resolveProfile(profile(bindings));
  return { rows: buildRows(resolved), conflicts: findConflicts(resolved.list) };
};

const search = (query: string, bindings: KeybindingProfile["bindings"] = {}) => {
  const { rows, conflicts } = view(bindings);
  return filterRows(rows, { query, pressed: null, filter: "all" }, conflicts).map((r) => r.id);
};

describe("search", () => {
  it("matches every word against the title", () => {
    expect(search("toggle terminal")).toContain("panels.terminal");
  });

  it("reads a query with a modifier as a shortcut and matches it exactly", () => {
    expect(search("cmd k")).toEqual(search("cmd+k"));
    expect(search("cmd k")).toContain("nav.commandPalette");
    // Not every row whose text merely contains a "k".
    expect(search("cmd k").length).toBeLessThan(5);
  });

  it("keeps a bare word a text search", () => {
    expect(search("zen")).toEqual(["panels.zen"]);
  });

  it("finds the rows bound to a pressed chord", () => {
    const { rows, conflicts } = view();
    const hits = filterRows(
      rows,
      { query: "", pressed: parseCombo("cmd+k"), filter: "all" },
      conflicts,
    );
    expect(hits.map((r) => r.id)).toContain("nav.commandPalette");
  });

  it("narrows to changed rows", () => {
    const { rows, conflicts } = view({ "panels.zen": ["alt+shift+z"] });
    const hits = filterRows(rows, { query: "", pressed: null, filter: "changed" }, conflicts);
    expect(hits.map((r) => r.id)).toEqual(["panels.zen"]);
  });
});

describe("clashes", () => {
  it("flags a user chord that collides in the same context", () => {
    const { rows, conflicts } = view({ "panels.zen": ["cmd+k"] });
    const zen = rows.find((r) => r.id === "panels.zen")!;
    expect(rowClash(zen, conflicts)).toMatchObject({ kind: "hard" });
    expect(rowClash(zen, conflicts)!.with).toContain("nav.commandPalette");
  });

  it("stays quiet about the shipped defaults' own cross-context overlaps", () => {
    const { rows, conflicts } = view();
    const close = rows.find((r) => r.id === "tabs.close")!;
    expect(rowClash(close, conflicts)).toBeNull();
  });
});

describe("grouping", () => {
  it("keeps category order and drops empty categories", () => {
    const { rows } = view();
    const groups = groupRows(rows.filter((r) => r.def.category !== "Canvas"));
    expect(groups[0]!.title).toBe("Project");
    expect(groups.some((g) => g.title === "Canvas")).toBe(false);
  });
});

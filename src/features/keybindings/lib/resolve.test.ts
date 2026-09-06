import { describe, expect, it } from "vitest";
import { ACTIONS } from "./actions";
import { bindingsForCombo, findConflicts, resolveProfile } from "./resolve";
import { parseCombo } from "./combo";
import type { KeybindingProfile } from "./types";

const profile = (bindings: KeybindingProfile["bindings"]): KeybindingProfile => ({
  id: "p",
  name: "P",
  bindings,
});

describe("resolveProfile", () => {
  it("falls back to defaults when no profile", () => {
    const r = resolveProfile(undefined);
    expect(r.byAction.get("panels.left")![0]!.serialized).toBe("cmd+b");
    expect(r.byAction.get("panels.left")![0]!.source).toBe("default");
    expect(r.unknownActionIds).toEqual([]);
  });
  it("override replaces, null unbinds, missing keeps default", () => {
    const r = resolveProfile(profile({ "panels.left": ["cmd+shift+l"], "panels.right": null }));
    expect(r.byAction.get("panels.left")!.map((b) => b.serialized)).toEqual(["cmd+shift+l"]);
    expect(r.byAction.get("panels.left")![0]!.source).toBe("user");
    expect(r.byAction.get("panels.right")).toEqual([]);
    expect(r.perAction.get("panels.right")!.overridden).toBe(true);
    expect(r.byAction.get("panels.terminal")![0]!.serialized).toBe("cmd+j");
    expect(r.perAction.get("panels.terminal")!.overridden).toBe(false);
  });
  it("reports unknown ids and invalid combos without dropping the action", () => {
    const r = resolveProfile(
      profile({ "nope.action": ["cmd+x"], "tabs.close": ["cmd+w", "garbage+"] }),
    );
    expect(r.unknownActionIds).toEqual(["nope.action"]);
    expect(r.perAction.get("tabs.close")!.invalid).toEqual(["garbage+"]);
    expect(r.byAction.get("tabs.close")!.map((b) => b.serialized)).toEqual(["cmd+w"]);
  });
  it("every default combo in the registry parses", () => {
    for (const a of ACTIONS)
      for (const s of a.defaults) expect(parseCombo(s), `${a.id}: ${s}`).not.toBeNull();
  });
});

describe("findConflicts", () => {
  it("classifies default cross-scope overlaps as soft only", () => {
    const r = resolveProfile(undefined);
    const conflicts = findConflicts(r.list);
    // ⌘W: tabs.close (global) vs terminal.closeTab (terminalFocus)
    expect(conflicts.get("cmd+w")!.kind).toBe("soft");
    // ⌘; : terminal.prevTab vs kb.toggleSidebar — different scopes
    expect(conflicts.get("cmd+;")!.kind).toBe("soft");
    expect([...conflicts.values()].every((c) => c.kind === "soft")).toBe(true);
  });
  it("flags a same-scope duplicate as hard", () => {
    const r = resolveProfile(profile({ "panels.right": ["cmd+b"] }));
    const c = findConflicts(r.list).get("cmd+b")!;
    expect(c.kind).toBe("hard");
    expect(c.bindings.map((b) => b.actionId).sort()).toEqual(["panels.left", "panels.right"]);
  });
  it("bindingsForCombo excludes the action being edited", () => {
    const r = resolveProfile(undefined);
    const others = bindingsForCombo(r.list, parseCombo("cmd+w")!, "tabs.close");
    expect(others.map((b) => b.actionId)).toEqual(["terminal.closeTab"]);
  });
});

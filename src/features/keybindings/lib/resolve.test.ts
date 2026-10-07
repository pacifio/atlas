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

describe("presets in resolution", () => {
  const based = (basedOn: string, bindings: KeybindingProfile["bindings"] = {}) => ({
    ...profile(bindings),
    basedOn,
  });

  it("layers the preset over the defaults", () => {
    const r = resolveProfile(based("vscode"));
    const palette = r.byAction.get("nav.commandPalette")!;
    expect(palette.map((b) => b.serialized)).toEqual(["cmd+shift+p", "f1"]);
    expect(palette[0]!.source).toBe("preset");
    expect(r.perAction.get("nav.commandPalette")!.overridden).toBe(false);
    // Not in the preset: the registry default.
    expect(r.byAction.get("tabs.close")![0]!.source).toBe("default");
    expect(r.preset?.id).toBe("vscode");
  });

  it("an override beats the preset, and a preset null unbinds", () => {
    const r = resolveProfile(based("jetbrains", { "nav.commandPalette": ["cmd+k"] }));
    expect(r.byAction.get("nav.commandPalette")!.map((b) => b.serialized)).toEqual(["cmd+k"]);
    expect(r.byAction.get("nav.commandPalette")![0]!.source).toBe("user");
    expect(r.byAction.get("tabs.focus1")).toEqual([]);
  });

  it("an unknown preset resolves as the defaults and is reported", () => {
    const r = resolveProfile(based("emacs"));
    expect(r.preset).toBeNull();
    expect(r.unknownPresetId).toBe("emacs");
    expect(r.byAction.get("nav.commandPalette")![0]!.serialized).toBe("cmd+k");
  });
});

describe("findConflicts across platforms", () => {
  it("off macOS, cmd+x and ctrl+x on two global actions are a hard conflict", () => {
    const r = resolveProfile(profile({ "panels.right": ["ctrl+b"] }));
    expect(findConflicts(r.list, true).get("cmd+b")).toBeUndefined();
    expect(findConflicts(r.list, false).get("cmd+b")!.kind).toBe("hard");
  });
  it("one action bound twice to the same effective chord is not a conflict", () => {
    const r = resolveProfile(profile({ "panels.left": ["cmd+b", "ctrl+b"] }));
    expect(findConflicts(r.list, false).get("cmd+b")).toBeUndefined();
  });
});

describe("findConflicts — the model picker's chords", () => {
  // The open picker's ⌘1–⌘9 deliberately shadow the global tab chords; the
  // two live in different `when` contexts, so the overlap is soft (by design,
  // quiet in the editor), never a hard "this can never fire".
  it("reads modelPicker.jumpN vs tabs.focusN as a soft, cross-context overlap", () => {
    const conflicts = findConflicts(resolveProfile(undefined).list, true);
    for (let n = 1; n <= 9; n++) {
      const c = conflicts.get(`cmd+${n}`)!;
      expect(c.kind).toBe("soft");
      expect(c.bindings.map((b) => b.actionId).sort()).toEqual([
        `modelPicker.jump${n}`,
        `tabs.focus${n}`,
      ]);
    }
  });

  it("is hard once two picker actions share a chord", () => {
    const r = resolveProfile(profile({ "modelPicker.toggleFavorite": ["cmd+1"] }));
    expect(findConflicts(r.list, true).get("cmd+1")!.kind).toBe("hard");
  });

  it("gives the favorite toggle a chord nothing else uses", () => {
    const conflicts = findConflicts(resolveProfile(undefined).list, true);
    expect(conflicts.get("cmd+shift+s")).toBeUndefined();
  });
});

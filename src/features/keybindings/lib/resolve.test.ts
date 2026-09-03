import { describe, expect, it } from "vitest";
import { ACTIONS, ACTION_BY_ID } from "./actions";
import { parseCombo, serializeCombo } from "./combo";
import { PRESETS } from "./presets";
import {
  buildLookup,
  findConflicts,
  findShadowed,
  lookupAction,
  resolveKeymap,
  type ResolvedBinding,
} from "./resolve";

function bindingOf(bindings: readonly ResolvedBinding[], id: string): ResolvedBinding {
  const found = bindings.find((b) => b.action.id === id);
  if (!found) throw new Error(`no such action: ${id}`);
  return found;
}

function chordOf(bindings: readonly ResolvedBinding[], id: string): string | null {
  const [first] = bindingOf(bindings, id).combos;
  return first ? serializeCombo(first) : null;
}

function chordsOf(bindings: readonly ResolvedBinding[], id: string): string[] {
  return bindingOf(bindings, id).combos.map(serializeCombo);
}

describe("the catalogue and its presets", () => {
  it("has a unique id for every command", () => {
    expect(new Set(ACTIONS.map((a) => a.id)).size).toBe(ACTIONS.length);
  });

  it("gives every default chord a parseable spelling", () => {
    for (const action of ACTIONS) {
      if (action.binding === null) continue;
      for (const chord of [action.binding].flat()) {
        expect(parseCombo(chord, "mac"), action.id).not.toBeNull();
      }
    }
  });

  it("names only real commands, with parseable chords, in every preset", () => {
    for (const preset of PRESETS) {
      for (const [actionId, binding] of Object.entries(preset.bindings)) {
        expect(ACTION_BY_ID.has(actionId), `${preset.id}: ${actionId}`).toBe(true);
        if (binding === null) continue;
        for (const chord of [binding].flat()) {
          expect(parseCombo(chord, "mac"), `${preset.id}: ${actionId}`).not.toBeNull();
        }
      }
    }
  });

  it("resolves every preset to a conflict-free keymap on both platforms", () => {
    for (const preset of PRESETS) {
      for (const platform of ["mac", "other"] as const) {
        const { bindings, problems } = resolveKeymap(preset.id, {}, platform);
        expect(problems, `${preset.id} on ${platform}`).toEqual([]);
        expect(findConflicts(bindings), `${preset.id} on ${platform}`).toEqual([]);
      }
    }
  });
});

describe("resolveKeymap", () => {
  it("layers user over preset over default", () => {
    const { bindings } = resolveKeymap("vscode", { "toggle-terminal": "mod+t" }, "mac");
    expect(chordOf(bindings, "toggle-terminal")).toBe("mod+t");
    expect(bindingOf(bindings, "toggle-terminal").source).toBe("user");
    // Untouched by the user, moved by the preset.
    expect(chordOf(bindings, "command-palette")).toBe("mod+shift+p");
    expect(bindingOf(bindings, "command-palette").source).toBe("preset");
    // Named by neither: still Atlas's own.
    expect(chordOf(bindings, "close-tab")).toBe("mod+w");
    expect(bindingOf(bindings, "close-tab").source).toBe("default");
  });

  it("treats a null override as an unbind, not as an absent key", () => {
    const { bindings } = resolveKeymap("atlas", { "toggle-terminal": null }, "mac");
    expect(bindingOf(bindings, "toggle-terminal").combos).toEqual([]);
    expect(bindingOf(bindings, "toggle-terminal").source).toBe("user");
  });

  it("binds every chord of a command that ships with more than one", () => {
    // ⌘+ arrives as ⇧= on a US layout; both spellings have to reach Zoom In.
    const { bindings } = resolveKeymap("atlas", {}, "mac");
    expect(chordsOf(bindings, "zoom-in")).toEqual(["mod+=", "mod+shift+="]);
  });

  it("takes a list from an override, replacing the default's list wholesale", () => {
    const { bindings } = resolveKeymap("atlas", { "zoom-in": ["mod+up", "mod+shift+up"] }, "mac");
    expect(chordsOf(bindings, "zoom-in")).toEqual(["mod+arrowup", "mod+shift+arrowup"]);
  });

  it("drops an unparseable override and reports it rather than keeping the old chord", () => {
    const { bindings, problems } = resolveKeymap("atlas", { "close-tab": "mod+nope" }, "mac");
    expect(bindingOf(bindings, "close-tab").combos).toEqual([]);
    expect(problems).toEqual([
      { actionId: "close-tab", binding: "mod+nope", reason: "unparseable" },
    ]);
  });

  it("reports an override naming a command this build doesn't have", () => {
    const { problems } = resolveKeymap("atlas", { "fly-to-the-moon": "mod+shift+m" }, "mac");
    expect(problems).toEqual([
      { actionId: "fly-to-the-moon", binding: "mod+shift+m", reason: "unknown-action" },
    ]);
  });

  it("falls back to Atlas defaults when the stored preset id is unknown", () => {
    const { bindings } = resolveKeymap("nonesuch" as "atlas", {}, "mac");
    expect(chordOf(bindings, "command-palette")).toBe("mod+k");
  });
});

describe("findConflicts", () => {
  it("flags two commands sharing a chord in the same scope", () => {
    const { bindings } = resolveKeymap("atlas", { "close-tab": "mod+k" }, "mac");
    expect(findConflicts(bindings)).toEqual([
      {
        combo: parseCombo("mod+k", "mac"),
        scope: "global",
        actionIds: ["command-palette", "close-tab"],
      },
    ]);
  });

  it("flags a command whose second chord collides with another command", () => {
    const { bindings } = resolveKeymap("atlas", { "close-tab": ["mod+w", "mod+k"] }, "mac");
    expect(findConflicts(bindings)).toEqual([
      {
        combo: parseCombo("mod+k", "mac"),
        scope: "global",
        actionIds: ["command-palette", "close-tab"],
      },
    ]);
  });

  it("does not flag the same chord in different scopes", () => {
    const { bindings } = resolveKeymap("atlas", {}, "mac");
    // ⌘F ships on three surfaces at once, which is the point of scopes.
    expect(chordOf(bindings, "chat-find")).toBe("mod+f");
    expect(chordOf(bindings, "terminal-find")).toBe("mod+f");
    expect(findConflicts(bindings)).toEqual([]);
  });
});

describe("findShadowed", () => {
  it("reports a scoped binding that hides a global one", () => {
    const { bindings } = resolveKeymap("atlas", { "global-search": "mod+f" }, "mac");
    expect(findShadowed(bindings)).toEqual(
      expect.arrayContaining([
        {
          combo: parseCombo("mod+f", "mac"),
          scopedActionId: "chat-find",
          globalActionId: "global-search",
        },
      ]),
    );
  });

  it("reports nothing when scoped chords are free", () => {
    const { bindings } = resolveKeymap("atlas", {}, "mac");
    expect(findShadowed(bindings)).toEqual([]);
  });
});

describe("lookupAction", () => {
  const { bindings } = resolveKeymap("atlas", {}, "mac");
  const lookup = buildLookup(bindings);
  const combo = (text: string) => parseCombo(text, "mac")!;

  it("prefers the focused scope's binding over the global one", () => {
    expect(lookupAction(lookup, combo("mod+f"), "chat")).toBe("chat-find");
    expect(lookupAction(lookup, combo("mod+f"), "terminal")).toBe("terminal-find");
  });

  it("falls through to global when the scope doesn't bind the chord", () => {
    expect(lookupAction(lookup, combo("mod+k"), "terminal")).toBe("command-palette");
    expect(lookupAction(lookup, combo("mod+k"), null)).toBe("command-palette");
  });

  it("returns null for an unbound chord", () => {
    expect(lookupAction(lookup, combo("mod+shift+y"), "chat")).toBeNull();
  });

  it("does not leak a scoped binding into another surface", () => {
    // ⌘S saves the editor buffer; over a terminal it must reach nothing.
    expect(lookupAction(lookup, combo("mod+s"), "editor")).toBe("editor-save");
    expect(lookupAction(lookup, combo("mod+s"), "terminal")).toBeNull();
  });
});

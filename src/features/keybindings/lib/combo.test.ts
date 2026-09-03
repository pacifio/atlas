import { describe, expect, it } from "vitest";
import {
  comboFromEvent,
  combosEqual,
  formatCombo,
  parseCombo,
  serializeCombo,
  type Combo,
} from "./combo";

/** A `keydown` as the matcher reads it. Only the five fields the combo layer
 *  touches — building a real `KeyboardEvent` would need a DOM for no gain. */
function keydown(e: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...e,
  } as KeyboardEvent;
}

function combo(text: string, platform: "mac" | "other" = "mac"): Combo {
  const parsed = parseCombo(text, platform);
  if (!parsed) throw new Error(`test wrote an unparseable combo: ${text}`);
  return parsed;
}

describe("parseCombo", () => {
  it("parses modifiers in any order into a canonical combo", () => {
    expect(parseCombo("shift+mod+k", "mac")).toEqual(combo("mod+shift+k"));
  });

  it("accepts cmd, meta and super as spellings of mod", () => {
    for (const text of ["cmd+p", "meta+p", "super+p"]) {
      expect(parseCombo(text, "mac")).toEqual(combo("mod+p"));
    }
  });

  it("accepts opt and option as spellings of alt", () => {
    expect(parseCombo("opt+z", "mac")).toEqual(combo("alt+z"));
    expect(parseCombo("option+z", "mac")).toEqual(combo("alt+z"));
  });

  it("keeps ctrl distinct from mod on macOS", () => {
    expect(parseCombo("ctrl+a", "mac")).toMatchObject({ ctrl: true, mod: false });
  });

  it("folds ctrl into mod off macOS, where they are the same key", () => {
    expect(parseCombo("ctrl+a", "other")).toEqual(parseCombo("mod+a", "other"));
    expect(parseCombo("ctrl+a", "other")).toMatchObject({ mod: true, ctrl: false });
  });

  it("accepts the short arrow spellings other editors' keymaps use", () => {
    expect(parseCombo("mod+up", "mac")).toEqual(combo("mod+arrowup"));
    expect(serializeCombo(combo("mod+left"))).toBe("mod+arrowleft");
  });

  it("rejects a chord with no key, an unknown key name, or a key that isn't last", () => {
    for (const text of ["mod+shift", "mod+", "mod+notakey", "k+mod", "mod+a+b", ""]) {
      expect(parseCombo(text, "mac")).toBeNull();
    }
  });

  it("round-trips through serializeCombo", () => {
    for (const text of ["mod+k", "mod+shift+f", "alt+;", "ctrl+alt+shift+arrowup", "f12"]) {
      expect(serializeCombo(combo(text))).toBe(text);
    }
  });
});

describe("formatCombo", () => {
  it("draws macOS chords in Apple's ⌃⌥⇧⌘ order", () => {
    expect(formatCombo(combo("mod+ctrl+alt+shift+k"), "mac")).toEqual(["⌃", "⌥", "⇧", "⌘", "K"]);
  });

  it("names modifiers off macOS, where the keycaps are words", () => {
    expect(formatCombo(combo("mod+shift+k", "other"), "other")).toEqual(["Ctrl", "Shift", "K"]);
  });

  it("draws non-printable keys as macOS glyphs and as words elsewhere", () => {
    expect(formatCombo(combo("mod+enter"), "mac")).toEqual(["⌘", "↵"]);
    expect(formatCombo(combo("mod+enter", "other"), "other")).toEqual(["Ctrl", "Enter"]);
  });
});

describe("comboFromEvent", () => {
  it("returns null while only modifiers are held", () => {
    expect(comboFromEvent(keydown({ key: "Meta", metaKey: true }), "mac")).toBeNull();
    expect(comboFromEvent(keydown({ key: "Shift", shiftKey: true }), "mac")).toBeNull();
  });

  it("reads the unshifted key, so ⌘+ and ⌘⇧= are one binding", () => {
    const pressed = comboFromEvent(
      keydown({ key: "+", code: "Equal", metaKey: true, shiftKey: true }),
      "mac",
    );
    expect(pressed).toEqual(combo("mod+shift+="));
  });

  it("reads through Option's character substitution", () => {
    // ⌥; types "…" on a US Mac layout; the binding is still on the ; key.
    const pressed = comboFromEvent(keydown({ key: "…", code: "Semicolon", altKey: true }), "mac");
    expect(pressed).toEqual(combo("alt+;"));
  });

  it("maps Ctrl to mod off macOS and to literal ctrl on it", () => {
    const event = keydown({ key: "a", code: "KeyA", ctrlKey: true });
    expect(comboFromEvent(event, "other")).toEqual(combo("mod+a", "other"));
    expect(comboFromEvent(event, "mac")).toEqual(combo("ctrl+a"));
  });

  it("names the space key", () => {
    expect(comboFromEvent(keydown({ key: " ", code: "Space", metaKey: true }), "mac")).toEqual(
      combo("mod+space"),
    );
  });
});

describe("combosEqual", () => {
  it("requires every modifier to match, including the ones the combo omits", () => {
    const pressed = comboFromEvent(
      keydown({ key: "b", code: "KeyB", metaKey: true, altKey: true }),
      "mac",
    );
    expect(combosEqual(pressed!, combo("mod+alt+b"))).toBe(true);
    // ⌘⌥B belongs to whoever bound it — a ⌘B binding must not also fire.
    expect(combosEqual(pressed!, combo("mod+b"))).toBe(false);
  });
});

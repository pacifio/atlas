import { describe, expect, it } from "vitest";
import { parseCombo } from "./combo";
import { toMenuAccelerator, toNativeAccelerator } from "./native-accelerator";

describe("toNativeAccelerator", () => {
  it("spells the primary modifier per platform", () => {
    expect(toNativeAccelerator(parseCombo("cmd+w")!, true)).toBe("Cmd+W");
    expect(toNativeAccelerator(parseCombo("cmd+w")!, false)).toBe("Control+W");
    expect(toNativeAccelerator(parseCombo("cmd+ctrl+alt+shift+f5")!, true)).toBe(
      "Cmd+Control+Alt+Shift+F5",
    );
    expect(toNativeAccelerator(parseCombo("alt+left")!, true)).toBe("Alt+Left");
  });
  it("names punctuation by its physical key", () => {
    const cases: Array<[string, string]> = [
      ["cmd+,", "Cmd+Comma"],
      ["cmd+shift+.", "Cmd+Shift+Period"],
      ["cmd+/", "Cmd+Slash"],
      ["cmd+\\", "Cmd+Backslash"],
      ["cmd+shift+[", "Cmd+Shift+BracketLeft"],
      ["cmd+shift+]", "Cmd+Shift+BracketRight"],
      ["cmd+-", "Cmd+Minus"],
      ["cmd+=", "Cmd+Equal"],
      ["cmd+`", "Cmd+Backquote"],
      ["alt+;", "Alt+Semicolon"],
      ["alt+'", "Alt+Quote"],
    ];
    for (const [chord, accelerator] of cases) {
      expect(toNativeAccelerator(parseCombo(chord)!, true), chord).toBe(accelerator);
    }
  });
  it("declines a key it has no spelling for", () => {
    expect(
      toNativeAccelerator(
        { code: "IntlBackslash", meta: true, ctrl: false, alt: false, shift: false },
        true,
      ),
    ).toBeNull();
  });
});

describe("toMenuAccelerator", () => {
  it("puts only ⌘ and ⌃ chords on a menu item", () => {
    expect(toMenuAccelerator(parseCombo("cmd+,")!, true)).toBe("Cmd+Comma");
    expect(toMenuAccelerator(parseCombo("ctrl+tab")!, true)).toBe("Control+Tab");
    expect(toMenuAccelerator(parseCombo("alt+z")!, true)).toBeNull();
    expect(toMenuAccelerator(parseCombo("shift+f5")!, true)).toBeNull();
  });
});

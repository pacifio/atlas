import { describe, expect, it } from "vitest";
import { parseCombo, type Combo } from "./combo";
import { isTypingRatherThanChord } from "./dispatch";

function combo(text: string): Combo {
  const parsed = parseCombo(text, "mac");
  if (!parsed) throw new Error(`test wrote an unparseable combo: ${text}`);
  return parsed;
}

describe("isTypingRatherThanChord", () => {
  it("lets any chord through when focus isn't in a text field", () => {
    expect(isTypingRatherThanChord(combo("f"), "global", false)).toBe(false);
  });

  it("suppresses a global bare-key binding while the user is typing", () => {
    expect(isTypingRatherThanChord(combo("f"), "global", true)).toBe(true);
    expect(isTypingRatherThanChord(combo("shift+f"), "global", true)).toBe(true);
  });

  it("still fires a modified chord while typing — ⌘K must open the palette from the composer", () => {
    expect(isTypingRatherThanChord(combo("mod+k"), "global", true)).toBe(false);
    expect(isTypingRatherThanChord(combo("alt+j"), "global", true)).toBe(false);
  });

  it("lets a scoped command claim a bare chord — Shift+Tab cycles from the composer", () => {
    expect(isTypingRatherThanChord(combo("shift+tab"), "chat", true)).toBe(false);
  });
});

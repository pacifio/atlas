import { describe, expect, it } from "vitest";
import {
  comboFromEvent,
  displayKeys,
  displayLabel,
  matchesCombo,
  parseCombo,
  serializeCombo,
  splitGlyphCombo,
} from "./combo";

function key(init: Partial<KeyboardEvent> & { code: string; key?: string }): KeyboardEvent {
  return {
    key: init.key ?? "",
    code: init.code,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
  } as KeyboardEvent;
}

describe("parseCombo / serializeCombo", () => {
  it("round-trips the canonical forms", () => {
    for (const s of [
      "cmd+shift+b",
      "alt+;",
      "cmd+alt+space",
      "shift+tab",
      "cmd+1",
      "cmd+\\",
      "cmd+shift+[",
      "f5",
      "cmd+ctrl+alt+shift+k",
    ]) {
      const c = parseCombo(s);
      expect(c, s).not.toBeNull();
      expect(serializeCombo(c!)).toBe(s);
    }
  });
  it("normalises modifier order and aliases", () => {
    expect(serializeCombo(parseCombo("shift+cmd+b")!)).toBe("cmd+shift+b");
    expect(serializeCombo(parseCombo("Command+Option+J")!)).toBe("cmd+alt+j");
    expect(serializeCombo(parseCombo("esc")!)).toBe("escape");
  });
  it("accepts a literal plus key", () => {
    expect(serializeCombo(parseCombo("cmd++")!)).toBe("cmd+shift+=");
  });
  it("rejects malformed input", () => {
    expect(parseCombo("")).toBeNull();
    expect(parseCombo("cmd+")).toBeNull();
    expect(parseCombo("cmd+shift")).toBeNull();
    expect(parseCombo("cmd+b+c")).toBeNull();
    expect(parseCombo("cmd+cmd+b")).toBeNull();
    expect(parseCombo("cmd+bogus")).toBeNull();
  });
});

describe("matchesCombo", () => {
  it("matches on the physical key despite macOS Option diacritics", () => {
    const c = parseCombo("alt+b")!;
    expect(matchesCombo(key({ key: "∫", code: "KeyB", altKey: true }), c)).toBe(true);
  });
  it("cmd+alt+j does not match a plain alt+j (and vice versa)", () => {
    const withMeta = parseCombo("cmd+alt+j")!;
    const altOnly = parseCombo("alt+j")!;
    const ev = key({ key: "∆", code: "KeyJ", altKey: true });
    expect(matchesCombo(ev, withMeta)).toBe(false);
    expect(matchesCombo(ev, altOnly)).toBe(true);
    const evMeta = key({ key: "j", code: "KeyJ", altKey: true, metaKey: true });
    expect(matchesCombo(evMeta, withMeta)).toBe(true);
    expect(matchesCombo(evMeta, altOnly)).toBe(false);
  });
  it("cmd accepts ctrl as the primary modifier", () => {
    const c = parseCombo("cmd+k")!;
    expect(matchesCombo(key({ key: "k", code: "KeyK", ctrlKey: true }), c)).toBe(true);
    expect(matchesCombo(key({ key: "k", code: "KeyK" }), c)).toBe(false);
  });
  it("shift must match exactly", () => {
    const c = parseCombo("cmd+b")!;
    expect(matchesCombo(key({ key: "B", code: "KeyB", metaKey: true, shiftKey: true }), c)).toBe(
      false,
    );
  });
  it("space is matched on code", () => {
    const c = parseCombo("cmd+alt+space")!;
    expect(matchesCombo(key({ key: " ", code: "Space", metaKey: true, altKey: true }), c)).toBe(
      true,
    );
  });
});

describe("comboFromEvent", () => {
  it("ignores modifier-only keydowns", () => {
    expect(comboFromEvent(key({ code: "ShiftLeft", shiftKey: true }))).toBeNull();
    expect(comboFromEvent(key({ code: "MetaLeft", metaKey: true }))).toBeNull();
  });
  it("captures a chord", () => {
    const c = comboFromEvent(key({ key: "G", code: "KeyG", metaKey: true, shiftKey: true }))!;
    expect(serializeCombo(c)).toBe("cmd+shift+g");
  });
});

describe("display", () => {
  it("renders glyphs in macOS order", () => {
    expect(displayKeys(parseCombo("cmd+shift+b")!)).toEqual(["⇧", "⌘", "B"]);
    expect(displayKeys(parseCombo("cmd+alt+space")!)).toEqual(["⌥", "⌘", "Space"]);
    expect(displayKeys(parseCombo("shift+tab")!)).toEqual(["⇧", "⇥"]);
    expect(displayKeys(parseCombo("cmd+shift+=")!)).toEqual(["⇧", "⌘", "+"]);
    expect(displayLabel(parseCombo("cmd+,")!)).toBe("⌘,");
  });
  it("splits legacy glyph strings into caps", () => {
    expect(splitGlyphCombo("⌘⇧F")).toEqual(["⌘", "⇧", "F"]);
    expect(splitGlyphCombo("⌥Space")).toEqual(["⌥", "Space"]);
    expect(splitGlyphCombo("↵")).toEqual(["↵"]);
  });
});

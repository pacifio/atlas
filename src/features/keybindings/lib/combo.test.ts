import { describe, expect, it } from "vitest";
import {
  comboFromEvent,
  displayKeys,
  displayLabel,
  effectiveCombo,
  matchesCombo,
  parseCombo,
  serializeCombo,
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
  it("reads `mod` as the primary modifier", () => {
    expect(serializeCombo(parseCombo("mod+shift+p")!)).toBe("cmd+shift+p");
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
  it("off macOS, cmd is Ctrl — and so is ctrl", () => {
    const ctrlK = key({ key: "k", code: "KeyK", ctrlKey: true });
    expect(matchesCombo(ctrlK, parseCombo("cmd+k")!, false)).toBe(true);
    expect(matchesCombo(ctrlK, parseCombo("ctrl+k")!, false)).toBe(true);
    expect(matchesCombo(key({ key: "k", code: "KeyK" }), parseCombo("cmd+k")!, false)).toBe(false);
    // Ctrl+Super is the one way to ask for both.
    const both = key({ key: "k", code: "KeyK", ctrlKey: true, metaKey: true });
    expect(matchesCombo(both, parseCombo("cmd+ctrl+k")!, false)).toBe(true);
    expect(matchesCombo(both, parseCombo("cmd+k")!, false)).toBe(false);
  });
  it("on macOS every modifier is exact: ⌃B never fires a ⌘B binding", () => {
    const cmdB = parseCombo("cmd+b")!;
    expect(matchesCombo(key({ key: "b", code: "KeyB", ctrlKey: true }), cmdB, true)).toBe(false);
    expect(matchesCombo(key({ key: "b", code: "KeyB", metaKey: true }), cmdB, true)).toBe(true);
    const ctrlCmdI = parseCombo("cmd+ctrl+i")!;
    const both = key({ key: "i", code: "KeyI", ctrlKey: true, metaKey: true });
    expect(matchesCombo(both, ctrlCmdI, true)).toBe(true);
    expect(matchesCombo(both, parseCombo("cmd+i")!, true)).toBe(false);
  });
  it("effectiveCombo folds cmd and ctrl together only off macOS", () => {
    const ctrlK = parseCombo("ctrl+k")!;
    expect(serializeCombo(effectiveCombo(ctrlK, false))).toBe("cmd+k");
    expect(serializeCombo(effectiveCombo(ctrlK, true))).toBe("ctrl+k");
    const both = parseCombo("cmd+ctrl+k")!;
    expect(serializeCombo(effectiveCombo(both, false))).toBe("cmd+ctrl+k");
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
  it("records ⌃⌘ on macOS, and a plain Ctrl as cmd elsewhere", () => {
    const both = key({ key: "i", code: "KeyI", metaKey: true, ctrlKey: true });
    expect(serializeCombo(comboFromEvent(both, true)!)).toBe("cmd+ctrl+i");
    const ctrl = key({ key: "k", code: "KeyK", ctrlKey: true });
    expect(serializeCombo(comboFromEvent(ctrl, true)!)).toBe("ctrl+k");
    expect(serializeCombo(comboFromEvent(ctrl, false)!)).toBe("cmd+k");
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
});

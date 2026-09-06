/**
 * The normalized key-combo model shared by the dispatcher, the recorder and
 * every shortcut label in the app.
 *
 * Combos are matched on `KeyboardEvent.code` (the physical key) rather than
 * `e.key`: on macOS, Option rewrites the typed character (⌥B → "∫", ⌥Space →
 * NBSP), so key-based matching silently fails for every ⌥ chord. Matching on
 * the code makes that fallback the rule instead of a list of special cases.
 *
 * String form (what lives in `keybindings.json`): lowercase tokens joined by
 * `+`, modifiers first in the canonical order `cmd+ctrl+alt+shift`, then one
 * key token — e.g. `cmd+shift+b`, `alt+;`, `cmd+alt+space`, `shift+tab`.
 */

export interface Combo {
  /** `KeyboardEvent.code` value, e.g. "KeyB", "Digit1", "BracketLeft", "Space". */
  code: string;
  /** ⌘ on macOS. Matches `metaKey || ctrlKey` unless `ctrl` is also set, so a
   *  `cmd+…` combo keeps working on a Ctrl-based layout (the historical
   *  `useHotkeys` behaviour). */
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

/** Key token (string form) ↔ `e.code`. Tokens are what users type by hand. */
const TOKEN_TO_CODE: Record<string, string> = {
  "[": "BracketLeft",
  "]": "BracketRight",
  ";": "Semicolon",
  "'": "Quote",
  "\\": "Backslash",
  "/": "Slash",
  ",": "Comma",
  ".": "Period",
  "=": "Equal",
  "-": "Minus",
  "`": "Backquote",
  space: "Space",
  enter: "Enter",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};

const CODE_TO_TOKEN: Record<string, string> = Object.fromEntries(
  Object.entries(TOKEN_TO_CODE)
    // "esc" is an input alias; "escape" is canonical.
    .filter(([token]) => token !== "esc")
    .map(([token, code]) => [code, token]),
);

/** Display glyph per code (falls back to the token, capitalised). */
const CODE_TO_GLYPH: Record<string, string> = {
  Space: "Space",
  Enter: "↩",
  Tab: "⇥",
  Escape: "Esc",
  Backspace: "⌫",
  Delete: "⌦",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Home: "↖",
  End: "↘",
  PageUp: "⇞",
  PageDown: "⇟",
};

const MODIFIER_CODES = new Set([
  "MetaLeft",
  "MetaRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "CapsLock",
  "Fn",
]);

export function tokenToCode(token: string): string | null {
  const t = token.toLowerCase();
  if (TOKEN_TO_CODE[t]) return TOKEN_TO_CODE[t];
  if (/^[a-z]$/.test(t)) return `Key${t.toUpperCase()}`;
  if (/^[0-9]$/.test(t)) return `Digit${t}`;
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(t)) return `F${t.slice(1)}`;
  return null;
}

export function codeToToken(code: string): string {
  if (CODE_TO_TOKEN[code]) return CODE_TO_TOKEN[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code.toLowerCase();
  return code.toLowerCase();
}

const MODIFIER_FLAG: Record<string, keyof Omit<Combo, "code">> = {
  cmd: "meta",
  meta: "meta",
  command: "meta",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
};

/** Parse the string form. Returns null for anything malformed (unknown
 *  token, no key, two keys, duplicate modifier). A trailing literal `+`
 *  (`cmd++`) is accepted as an alias for `cmd+shift+=`. */
export function parseCombo(input: string): Combo | null {
  let text = input.trim().toLowerCase();
  let plusKey = false;
  if (text.endsWith("++") || text === "+") {
    plusKey = true;
    text = text.slice(0, -1);
    if (text.endsWith("+")) text = text.slice(0, -1);
  }
  const parts = text === "" ? [] : text.split("+").map((p) => p.trim());
  if (parts.some((p) => p === "")) return null;
  const combo: Combo = { code: "", meta: false, ctrl: false, shift: false, alt: false };
  for (const part of parts) {
    const flag = MODIFIER_FLAG[part];
    if (flag) {
      if (combo[flag]) return null;
      combo[flag] = true;
      continue;
    }
    if (combo.code) return null;
    const code = tokenToCode(part);
    if (!code) return null;
    combo.code = code;
  }
  if (plusKey) {
    if (combo.code) return null;
    combo.code = "Equal";
    combo.shift = true;
  }
  if (!combo.code) return null;
  return combo;
}

/** Canonical string form: `cmd+ctrl+alt+shift+<key>`. */
export function serializeCombo(c: Combo): string {
  const parts: string[] = [];
  if (c.meta) parts.push("cmd");
  if (c.ctrl) parts.push("ctrl");
  if (c.alt) parts.push("alt");
  if (c.shift) parts.push("shift");
  parts.push(codeToToken(c.code));
  return parts.join("+");
}

export function comboEquals(a: Combo, b: Combo): boolean {
  return (
    a.code === b.code &&
    a.meta === b.meta &&
    a.ctrl === b.ctrl &&
    a.shift === b.shift &&
    a.alt === b.alt
  );
}

/** Build a combo from a live keydown. Null while only modifiers are held. */
export function comboFromEvent(e: KeyboardEvent): Combo | null {
  const code = e.code;
  if (!code || MODIFIER_CODES.has(code)) return null;
  return {
    code,
    meta: e.metaKey,
    ctrl: e.ctrlKey && !e.metaKey,
    shift: e.shiftKey,
    alt: e.altKey,
  };
}

/** Exact match on all four modifiers. `meta` accepts ctrlKey too (unless the
 *  combo names ctrl itself) so cmd combos survive a non-Mac keyboard. */
export function matchesCombo(e: KeyboardEvent, c: Combo): boolean {
  if (!matchCode(e, c.code)) return false;
  if (c.shift !== e.shiftKey) return false;
  if (c.alt !== e.altKey) return false;
  if (c.ctrl) {
    if (!e.ctrlKey) return false;
    if (c.meta !== e.metaKey) return false;
    return true;
  }
  const primary = e.metaKey || e.ctrlKey;
  return c.meta === primary;
}

function matchCode(e: KeyboardEvent, code: string): boolean {
  if (e.code === code) return true;
  // Non-US layouts, or synthetic events without a code: fall back to the
  // typed key for the single-character cases where it's unambiguous.
  if (!e.code && e.key) {
    const guess = tokenToCode(e.key.length === 1 ? e.key : e.key.toLowerCase());
    return guess === code;
  }
  return false;
}

/** Keycaps for display — modifiers in the macOS order ⌃ ⌥ ⇧ ⌘, then the key. */
export function displayKeys(c: Combo): string[] {
  const keys: string[] = [];
  if (c.ctrl) keys.push("⌃");
  if (c.alt) keys.push("⌥");
  if (c.shift) keys.push("⇧");
  if (c.meta) keys.push("⌘");
  keys.push(displayKey(c));
  return keys;
}

function displayKey(c: Combo): string {
  // ⌘⇧= is how "⌘+" arrives on a US layout; show what the user thinks of.
  if (c.code === "Equal" && c.shift) return "+";
  if (CODE_TO_GLYPH[c.code]) return CODE_TO_GLYPH[c.code];
  if (/^Key[A-Z]$/.test(c.code)) return c.code.slice(3);
  if (/^Digit[0-9]$/.test(c.code)) return c.code.slice(5);
  if (/^F[0-9]+$/.test(c.code)) return c.code;
  const token = codeToToken(c.code);
  return token.length === 1 ? token : token.charAt(0).toUpperCase() + token.slice(1);
}

/** Compact single-string label ("⌘⇧B") for `title=` tooltips. */
export function displayLabel(c: Combo): string {
  return displayKeys(c).join("");
}

/** Split a legacy glyph string ("⌘⇧F", "⌥Space") into keycaps: every modifier
 *  glyph is its own cap, the remainder is one cap. */
export function splitGlyphCombo(combo: string): string[] {
  const keys: string[] = [];
  let rest = combo;
  while (rest.length > 0 && "⌃⌥⇧⌘".includes(rest[0]!)) {
    keys.push(rest[0]!);
    rest = rest.slice(1);
  }
  if (rest) keys.push(rest);
  return keys;
}

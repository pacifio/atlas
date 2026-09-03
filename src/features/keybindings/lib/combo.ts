/**
 * Key combinations: the one place that knows how a chord is written down, how
 * it is drawn, and how a `KeyboardEvent` turns into one.
 *
 * A combo is stored platform-independently. `mod` is the platform's primary
 * modifier — ⌘ on macOS, Ctrl everywhere else — so a single preset entry
 * (`mod+p`) is ⌘P on a Mac and Ctrl+P on Linux/Windows without the preset
 * carrying two tables. Literal `ctrl` stays available for the chords that mean
 * Control specifically (⌃A and friends in the terminal); off macOS that IS the
 * primary modifier, so it normalizes to `mod` on parse and the two spellings
 * can never resolve to different bindings on the same machine.
 *
 * Matching is exact: every modifier is compared, including the ones the combo
 * does not want. A binding for `mod+b` must not fire on ⌘⌥B — that chord
 * belongs to whatever binds it, and the old first-match-wins listener firing
 * both was the bug this replaces.
 */

export type Platform = "mac" | "other";

/**
 * A parsed chord. Normalized: `key` is the unshifted, lowercased identity of
 * the physical key (`"="`, not `"+"`; `"escape"`, not `"Escape"`), and off
 * macOS `ctrl` is always false because Control is `mod` there.
 */
export interface Combo {
  key: string;
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

let cachedPlatform: Platform | null = null;

/** The running platform. Cached — it cannot change within a session, and this
 *  is called on every keystroke. */
export function hostPlatform(): Platform {
  if (cachedPlatform) return cachedPlatform;
  const mac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
  cachedPlatform = mac ? "mac" : "other";
  return cachedPlatform;
}

/**
 * `event.code` → the unshifted character that key produces on a US layout.
 *
 * Consulted before `event.key` because both Shift and Option rewrite `key`:
 * ⇧= arrives as `"+"` and ⌥; as `"…"`, which would otherwise store and match as
 * different keys than the ones printed on the keycap. Reading the code makes
 * `mod+=` and `mod+shift+=` the same key with different modifiers, the way a
 * user reads them.
 *
 * The cost is that a non-US layout matches by physical position for these keys
 * — AZERTY's `KeyQ` binds as `q`. Every editor with a static keymap makes some
 * version of this trade; ours matches VS Code's, and the letters at least keep
 * their positions relative to each other.
 */
const CHAR_BY_CODE: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

/** Keys with no printable identity, in the spelling used on the wire and in
 *  `event.key` (lowercased). Anything here is accepted by [`parseCombo`]; a
 *  name outside it is rejected rather than stored as an unmatchable binding. */
const NAMED_KEYS = new Set([
  "enter",
  "escape",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
]);

function isPrintableKey(key: string): boolean {
  return Array.from(key).length === 1 && key !== " ";
}

/** Spellings accepted on the wire for keys whose `event.key` name is longer.
 *  VS Code and Zed keymaps both write the arrows this way, and a config file
 *  people hand-edit should take the spelling they already know. */
const KEY_ALIASES: Record<string, string> = {
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  esc: "escape",
  del: "delete",
  return: "enter",
};

/** Fold the modifier tokens onto a platform. Off macOS, Control and Command
 *  both mean "the primary modifier": there is no ⌘ key to press, and a preset
 *  that spells a chord `ctrl+p` means the same thing Atlas spells `mod+p`. */
function normalizeModifiers(combo: Combo, platform: Platform): Combo {
  if (platform === "mac") return combo;
  if (!combo.ctrl) return combo;
  return { ...combo, mod: true, ctrl: false };
}

/**
 * Parse a wire-format chord (`"mod+shift+k"`, `"alt+;"`, `"ctrl+a"`).
 *
 * Returns null for anything unparseable — an unknown modifier, an unknown key
 * name, a missing key, or more than one non-modifier. Callers surface that as
 * a rejected binding rather than silently dropping it; a chord nothing can
 * ever press is exactly the kind of thing a hand-edited config file needs told
 * about.
 */
export function parseCombo(text: string, platform: Platform = hostPlatform()): Combo | null {
  // No escape hatch for a literal `+`: it is unreachable by design. A press of
  // ⇧= normalizes to `=` with shift (see `CHAR_BY_CODE`), so a binding on `+`
  // could never match an event even if it parsed.
  const tokens = text.trim().toLowerCase().split("+");
  if (tokens.some((t) => t === "")) return null;

  const combo: Combo = { key: "", mod: false, ctrl: false, alt: false, shift: false };
  for (const [i, token] of tokens.entries()) {
    const last = i === tokens.length - 1;
    switch (token) {
      case "mod":
      case "cmd":
      case "meta":
      case "super":
        combo.mod = true;
        continue;
      case "ctrl":
      case "control":
        combo.ctrl = true;
        continue;
      case "alt":
      case "opt":
      case "option":
        combo.alt = true;
        continue;
      case "shift":
        combo.shift = true;
        continue;
    }
    // Not a modifier, so it must be the key — and it must be last, so that
    // `k+mod` is rejected instead of quietly accepted as `mod+k`.
    if (!last || combo.key) return null;
    const key = KEY_ALIASES[token] ?? token;
    if (!isPrintableKey(key) && !NAMED_KEYS.has(key)) return null;
    combo.key = key;
  }
  if (!combo.key) return null;
  return normalizeModifiers(combo, platform);
}

/** Wire format, in the canonical modifier order. Round-trips through
 *  [`parseCombo`] unchanged. */
export function serializeCombo(combo: Combo): string {
  const parts: string[] = [];
  if (combo.mod) parts.push("mod");
  if (combo.ctrl) parts.push("ctrl");
  if (combo.alt) parts.push("alt");
  if (combo.shift) parts.push("shift");
  parts.push(combo.key);
  return parts.join("+");
}

const MAC_MODIFIER_GLYPHS = { mod: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };

/** Glyphs for keys whose name would otherwise be drawn as a word. macOS spells
 *  these as symbols on the keycaps themselves; elsewhere they are written out,
 *  which is what those keyboards print. */
const MAC_KEY_GLYPHS: Record<string, string> = {
  enter: "↵",
  escape: "⎋",
  tab: "⇥",
  space: "␣",
  backspace: "⌫",
  delete: "⌦",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  pageup: "⇞",
  pagedown: "⇟",
  home: "↖",
  end: "↘",
};

const KEY_LABELS: Record<string, string> = {
  enter: "Enter",
  escape: "Esc",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PgUp",
  pagedown: "PgDn",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

/**
 * The chord as a reader sees it, one element per key drawn: `["⌘", "⇧", "K"]`
 * on macOS, `["Ctrl", "Shift", "K"]` elsewhere.
 *
 * Parts rather than a string because the two platforms don't render the same
 * shape — macOS glyphs pack into one `⌘⇧K` chip, while `Ctrl+Shift+K` needs a
 * chip each — and joining here would leave every caller re-splitting it.
 */
export function formatCombo(combo: Combo, platform: Platform = hostPlatform()): string[] {
  const parts: string[] = [];
  if (platform === "mac") {
    if (combo.ctrl) parts.push(MAC_MODIFIER_GLYPHS.ctrl);
    if (combo.alt) parts.push(MAC_MODIFIER_GLYPHS.alt);
    if (combo.shift) parts.push(MAC_MODIFIER_GLYPHS.shift);
    // ⌘ last: macOS orders written chords ⌃⌥⇧⌘ (Apple HIG), the reverse of
    // the wire format's most-significant-first.
    if (combo.mod) parts.push(MAC_MODIFIER_GLYPHS.mod);
    parts.push(MAC_KEY_GLYPHS[combo.key] ?? displayKey(combo.key));
    return parts;
  }
  if (combo.mod) parts.push("Ctrl");
  if (combo.alt) parts.push("Alt");
  if (combo.shift) parts.push("Shift");
  parts.push(displayKey(combo.key));
  return parts;
}

function displayKey(key: string): string {
  return KEY_LABELS[key] ?? key.toUpperCase();
}

/**
 * The chord a `keydown` represents, or null while only modifiers are held —
 * which is what the Settings recorder shows as "waiting for a key" rather than
 * committing ⌘ on its own.
 */
export function comboFromEvent(
  e: KeyboardEvent,
  platform: Platform = hostPlatform(),
): Combo | null {
  const key = keyFromEvent(e);
  if (!key) return null;
  return normalizeModifiers(
    {
      key,
      mod: platform === "mac" ? e.metaKey : e.ctrlKey,
      ctrl: platform === "mac" ? e.ctrlKey : false,
      alt: e.altKey,
      shift: e.shiftKey,
    },
    platform,
  );
}

const MODIFIER_KEYS = new Set(["control", "shift", "alt", "meta", "capslock", "os"]);

function keyFromEvent(e: KeyboardEvent): string | null {
  const key = e.key?.toLowerCase() ?? "";
  if (!key || MODIFIER_KEYS.has(key)) return null;

  const fromCode = CHAR_BY_CODE[e.code];
  if (fromCode) return fromCode;
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);

  if (key === " ") return "space";
  if (isPrintableKey(key) || NAMED_KEYS.has(key)) return key;
  return null;
}

export function combosEqual(a: Combo, b: Combo): boolean {
  return (
    a.key === b.key &&
    a.mod === b.mod &&
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift
  );
}

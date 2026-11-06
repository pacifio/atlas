import { isMac } from "@/lib/platform";
import type { Combo } from "./combo";

/**
 * A chord in Tauri's accelerator spelling, for the native menu bar
 * (`src-tauri/src/menu.rs`). Its items show the user's chords, and they are
 * what catches a chord while the embedded browser — a separate native webview
 * the dispatcher never sees — has focus.
 *
 * Null for a chord Tauri can't express; the caller leaves the item unbound
 * rather than guessing at a near-miss.
 */
export function toNativeAccelerator(combo: Combo, mac: boolean = isMac): string | null {
  const key = nativeKey(combo.code);
  if (!key) return null;
  const parts: string[] = [];
  if (mac) {
    if (combo.meta) parts.push("Cmd");
    if (combo.ctrl) parts.push("Control");
  } else if (combo.meta || combo.ctrl) {
    // Off macOS `cmd` is Ctrl; both flags together is Ctrl+Super.
    parts.push("Control");
    if (combo.meta && combo.ctrl) parts.push("Super");
  }
  if (combo.alt) parts.push("Alt");
  if (combo.shift) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/** Letters, digits, F-keys, punctuation and the named keys. Punctuation is
 *  named by its physical key (`Comma`, `BracketLeft`), the same `KeyboardEvent.code`
 *  the dispatcher matches on, so Tauri never sees a layout-dependent character. */
function nativeKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return NAMED[code] ?? null;
}

const NAMED: Record<string, string> = {
  Enter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  Space: "Space",
  Backspace: "Backspace",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Comma: "Comma",
  Period: "Period",
  Slash: "Slash",
  Backslash: "Backslash",
  BracketLeft: "BracketLeft",
  BracketRight: "BracketRight",
  Minus: "Minus",
  Equal: "Equal",
  Backquote: "Backquote",
  Semicolon: "Semicolon",
  Quote: "Quote",
};

/**
 * The accelerator a native menu item shows for `combo`, or null to show none.
 *
 * Only chords with ⌘ or ⌃ go on a menu item: AppKit treats a menu's key
 * equivalent as taking the keystroke, so an Option-only chord such as ⌥Z (Zen
 * mode) bound there would stop typing Ω in a text field of the embedded
 * browser. Those still work from the keyboard in the main window; the item
 * simply shows no chord.
 */
export function toMenuAccelerator(combo: Combo, mac: boolean = isMac): string | null {
  if (!combo.meta && !combo.ctrl) return null;
  return toNativeAccelerator(combo, mac);
}

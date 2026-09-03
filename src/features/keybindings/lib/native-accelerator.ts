import type { Combo } from "./combo";

/**
 * A chord in Tauri's accelerator spelling, for the one binding that also has to
 * exist outside the webview.
 *
 * The native Window ▸ Close Tab item is what catches ⌘W while the *embedded
 * browser* holds focus: that is a separate native webview, so the keybinding
 * dispatcher never sees the key at all (see `src-tauri/src/menu.rs`). If the
 * user rebinds "Close Tab", the menu has to move with them, or the browser
 * keeps closing tabs on a chord they retired.
 *
 * Returns null for a chord Tauri can't express, which the caller treats as
 * "leave the menu item unbound" rather than guessing at a near-miss.
 */
export function toNativeAccelerator(combo: Combo): string | null {
  const parts: string[] = [];
  // `CmdOrCtrl` is Tauri's own name for the platform's primary modifier —
  // exactly what `mod` means here.
  if (combo.mod) parts.push("CmdOrCtrl");
  if (combo.ctrl) parts.push("Control");
  if (combo.alt) parts.push("Alt");
  if (combo.shift) parts.push("Shift");

  const key = NATIVE_KEY_NAMES[combo.key] ?? (/^[a-z0-9]$/.test(combo.key) ? combo.key : null);
  if (!key) return null;
  parts.push(key.toUpperCase());
  return parts.join("+");
}

/** Keys Tauri names rather than takes literally. Punctuation is deliberately
 *  absent: its accelerator spelling varies by platform, and a menu item is not
 *  worth guessing wrong on. */
const NATIVE_KEY_NAMES: Record<string, string> = {
  enter: "Enter",
  escape: "Escape",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  ...Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
};

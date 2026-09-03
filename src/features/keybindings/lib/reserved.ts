/**
 * Chords the operating system takes before Atlas ever sees them.
 *
 * Binding one is not an error — Atlas cannot stop the user, and on a machine
 * with the OS shortcut disabled it even works — so this is a warning shown at
 * the moment of recording, not a rejection. The list is deliberately short:
 * only chords whose owner is the OS itself, where the binding would appear to
 * do nothing at all. `mod+w` and friends are Atlas's to bind, and the webview
 * hands them over.
 */

import { serializeCombo, type Combo, type Platform, hostPlatform } from "./combo";

const MAC_RESERVED: Record<string, string> = {
  "mod+q": "macOS quits Atlas with this.",
  "mod+h": "macOS hides Atlas with this.",
  "mod+m": "macOS minimizes the window with this.",
  "mod+space": "Spotlight takes this.",
  "mod+tab": "The app switcher takes this.",
  "mod+alt+escape": "Force Quit takes this.",
  "mod+shift+3": "macOS screenshots take this.",
  "mod+shift+4": "macOS screenshots take this.",
  "mod+shift+5": "macOS screenshots take this.",
  // The system Cancel chord: swallowed before the webview, which is why the
  // workspace sidebar's default carries Shift.
  "mod+.": "macOS reserves this as Cancel; it never reaches Atlas.",
};

const OTHER_RESERVED: Record<string, string> = {
  "alt+tab": "The window switcher takes this.",
  "alt+f4": "The window manager closes windows with this.",
  "mod+alt+delete": "The system takes this.",
};

/** Why this chord may never reach Atlas, or null if nothing claims it. */
export function reservedReason(combo: Combo, platform: Platform = hostPlatform()): string | null {
  const table = platform === "mac" ? MAC_RESERVED : OTHER_RESERVED;
  return table[serializeCombo(combo)] ?? null;
}

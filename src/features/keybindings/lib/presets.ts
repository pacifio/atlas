/**
 * Keymap presets — "I'm coming from VS Code" as a data table.
 *
 * A preset is a sparse layer between the registry defaults and a profile's
 * own overrides (`defaults → preset → overrides`, see `resolve.ts`). It names
 * only the commands where the other editor has a well-known equivalent;
 * everything else keeps Atlas's chord, so a command added in a later build
 * gets a working default under every preset the day it lands.
 *
 * Each table follows that editor's macOS default keymap, checked against its
 * shipped keymap file or docs. `cmd` is the primary modifier (Ctrl off
 * macOS), so the same table is right on Windows and Linux to the extent
 * those editors swap ⌘ for Ctrl there. Every preset must resolve without a
 * hard conflict on both platforms — `presets.test.ts` holds that line.
 *
 * Multi-stroke chords (VS Code's `⌘K Z` zen mode, `⌘K ⌘S` keybindings) are
 * absent: Atlas matches single chords, so an entry for one would be a
 * binding that silently never fires. JetBrains' double-⇧ Search Everywhere is
 * absent for the same reason.
 *
 * The ids are STORAGE KEYS — a profile's `basedOn` names one — so renaming
 * one orphans every profile created from it.
 */

import type { ActionId } from "./actions";

export type PresetId = "vscode" | "cursor" | "zed" | "jetbrains";

export type PresetBindings = Partial<Record<ActionId, string[] | null>>;

export interface Preset {
  id: PresetId;
  label: string;
  /** One line, shown in onboarding and the profile menu. */
  description: string;
  bindings: PresetBindings;
}

/** Ctrl+1…9 for "focus tab N" — VS Code, Cursor and Zed all use it, and it
 *  frees ⌘1…9, which those editors give to editor groups instead. */
const CTRL_DIGIT_TABS: PresetBindings = Object.fromEntries(
  [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`tabs.focus${n}`, [`ctrl+${n}`]]),
);

const VSCODE: PresetBindings = {
  "nav.commandPalette": ["cmd+shift+p", "f1"],
  // ⌃` is VS Code's terminal toggle and ⌘J its panel toggle; in Atlas the
  // terminal IS the bottom panel, so both land on it.
  "panels.terminal": ["ctrl+`", "cmd+j"],
  "tabs.newTerminal": ["ctrl+shift+`"],
  // `panels.right` is Source Control (the id predates it being a surface):
  // ⌃⇧G is VS Code's Source Control view. ⌥⌘B, its secondary side bar, keeps
  // Atlas's default: the session Details card, the panel on the right.
  "panels.right": ["ctrl+shift+g"],
  "workspace.toggleSidebar": ["cmd+ctrl+i"],
  "tabs.prev": ["cmd+alt+left", "cmd+shift+["],
  "tabs.next": ["cmd+alt+right", "cmd+shift+]"],
  // ⌘\ splits a focused terminal in VS Code; the terminal scope shadows
  // Atlas's global split-right there, which is exactly the VS Code behaviour.
  // Atlas terminals split down only, so it splits down.
  "terminal.splitDown": ["cmd+\\"],
  ...CTRL_DIGIT_TABS,
};

export const PRESETS: readonly Preset[] = [
  {
    id: "vscode",
    label: "VS Code",
    description: "⇧⌘P palette, ⌃` terminal, ⌃1–9 tabs.",
    bindings: VSCODE,
  },
  {
    id: "cursor",
    label: "Cursor",
    description: "VS Code's keys, with ⌘L / ⌘I for the agent.",
    bindings: {
      ...VSCODE,
      // Cursor's side-panel chords. Its ⌘K is inline edit, which Atlas has no
      // equivalent of — the palette stays on VS Code's ⇧⌘P rather than
      // pretending ⌘K means the same thing.
      "workspace.toggleSidebar": ["cmd+l", "cmd+i"],
    },
  },
  {
    id: "zed",
    label: "Zed",
    description: "⇧⌘P palette, ⌃` terminal, ⌘? agent panel.",
    bindings: {
      "nav.commandPalette": ["cmd+shift+p"],
      "panels.terminal": ["ctrl+`", "cmd+j"],
      "tabs.newTerminal": ["ctrl+shift+`"],
      // Zed's right dock is ⌘R and its git panel ⌃⇧G; `panels.right` is
      // Source Control, so it takes both.
      "panels.right": ["ctrl+shift+g", "cmd+r"],
      "workspace.toggleSidebar": ["cmd+shift+/"],
      // Zed's nearest to zen: hide all docks.
      "panels.zen": ["cmd+alt+y"],
      "tabs.prev": ["cmd+alt+left", "cmd+shift+["],
      "tabs.next": ["cmd+alt+right", "cmd+shift+]"],
      ...CTRL_DIGIT_TABS,
    },
  },
  {
    id: "jetbrains",
    label: "JetBrains",
    description: "⇧⌘A actions, ⇧⌘O files, ⌘1 project, ⌥F12 terminal.",
    bindings: {
      "nav.commandPalette": ["cmd+shift+a"],
      "nav.filePicker": ["cmd+shift+o"],
      // ⇧⌘O is Go to File there, so the project list keeps the palette route.
      "tabs.newChatIn": null,
      "panels.left": ["cmd+1"],
      "panels.terminal": ["alt+f12"],
      // ⌘0 Commit, ⌘9 Git — both open Source Control in Atlas.
      "panels.right": ["cmd+0", "cmd+9"],
      // Hide All Tool Windows.
      "panels.zen": ["cmd+shift+f12"],
      // JetBrains zooms the whole IDE on ⌃⌥=/-/0, and ⌘0/⌘9 are taken above.
      "view.zoomIn": ["ctrl+alt+="],
      "view.zoomOut": ["ctrl+alt+-"],
      "view.zoomReset": ["ctrl+alt+0"],
      // JetBrains has no go-to-tab-N, and ⌘1/⌘9/⌘0 are tool windows there.
      ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`tabs.focus${n}`, null])),
    },
  },
];

export const PRESET_BY_ID: ReadonlyMap<string, Preset> = new Map(PRESETS.map((p) => [p.id, p]));

export function isPresetId(id: string): id is PresetId {
  return PRESET_BY_ID.has(id);
}

/**
 * Keymap presets — "I'm coming from VS Code" as a data table.
 *
 * A preset is a sparse overlay on the catalogue defaults in `actions.ts`, not
 * a replacement keymap: it names only the commands where the other editor has
 * a well-known equivalent, and everything it doesn't name keeps Atlas's own
 * chord. That keeps a preset honest — no invented bindings standing in for
 * shortcuts the original editor doesn't have — and means a new Atlas command
 * gets a working default in every preset the day it lands.
 *
 * Chord-sequence bindings (VS Code's `⌘K ⌘S`, Zed's `⌘K →`) are deliberately
 * absent: Atlas matches single chords, so an entry for one would be a binding
 * that silently never fires. The commands they cover keep their Atlas chord.
 */

import type { ActionId } from "./actions";

export type PresetId = "atlas" | "vscode" | "zed";

export interface Preset {
  id: PresetId;
  label: string;
  /** One line, shown in onboarding and in Settings. */
  description: string;
  bindings: Partial<Record<ActionId, string | null>>;
}

export const PRESETS: readonly Preset[] = [
  {
    id: "atlas",
    label: "Atlas",
    description: "Atlas's own shortcuts.",
    bindings: {},
  },
  {
    id: "vscode",
    label: "VS Code / Cursor",
    description: "⌘⇧P for the palette, ⌘` for the terminal, ⌘J for the panel.",
    bindings: {
      "command-palette": "mod+shift+p",
      "toggle-terminal": "mod+`",
      "toggle-bottom-panel": "mod+j",
      "toggle-right-panel": "mod+alt+b",
      "new-terminal": "mod+shift+`",
      "previous-tab": "mod+alt+arrowleft",
      "next-tab": "mod+alt+arrowright",
      // Cursor's chat chord. VS Code's own (⌃⌘I) is Copilot's, not the
      // editor's, so this follows the fork people actually arrive from.
      "new-chat": "mod+l",
    },
  },
  {
    id: "zed",
    label: "Zed",
    description: "⌘⇧P for the palette, ⌘B/⌘R/⌘J for the docks.",
    bindings: {
      "command-palette": "mod+shift+p",
      // Zed's three docks. Atlas's right panel and bottom panel are the same
      // idea; its terminal moves to Zed's ⌃` panel toggle so ⌘J is free for
      // the dock, as it is there.
      "toggle-right-panel": "mod+r",
      "toggle-bottom-panel": "mod+j",
      "toggle-terminal": "ctrl+`",
    },
  },
];

export const PRESET_BY_ID: ReadonlyMap<string, Preset> = new Map(PRESETS.map((p) => [p.id, p]));

export const DEFAULT_PRESET_ID: PresetId = "atlas";

export function isPresetId(id: string): id is PresetId {
  return PRESET_BY_ID.has(id);
}

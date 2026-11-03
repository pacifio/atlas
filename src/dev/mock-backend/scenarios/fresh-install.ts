// A fresh install: no keybindings.json and no tips.json yet. Atlas opens
// First run (what Atlas is, then the keymap question), and afterwards the
// first focus of a session composer brings up its Tip. Answers, seen tips and
// Replay all tips hold until the page reloads.

import type { KeybindingsLoadResult } from "@/features/keybindings/lib/keybindings-api";
import { DEFAULT_KEYBINDINGS_FILE, type KeybindingsFile } from "@/features/keybindings/lib/types";
import type { TipsState } from "@/features/tips/lib/tips-api";
import type { Scenario } from "../types";

let written: KeybindingsFile | null = null;
let tips: TipsState = { version: 1, cohort: "fresh", seen: [] };

export const freshInstall: Scenario = {
  name: "fresh-install",
  description: "First launch — First run, then Tips as each feature is met.",
  commands: {
    keybindings_load: (): KeybindingsLoadResult => ({
      file: written ?? DEFAULT_KEYBINDINGS_FILE,
      path: "~/.config/atlas/keybindings.json",
      exists: written !== null,
      warnings: [],
    }),
    keybindings_save: ({ file }): KeybindingsFile => {
      written = file as KeybindingsFile;
      return written;
    },
    tips_load: (): TipsState => tips,
    tips_mark_seen: ({ ids }): TipsState => {
      tips = { ...tips, seen: [...new Set([...tips.seen, ...(ids as string[])])] };
      return tips;
    },
    tips_reset: ({ keep }): TipsState => {
      tips = { ...tips, cohort: "fresh", seen: tips.seen.filter((id) => keep.includes(id)) };
      return tips;
    },
  },
};

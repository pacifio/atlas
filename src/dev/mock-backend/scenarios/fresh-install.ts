// A fresh install: no keybindings.json and no tips.json yet. Atlas opens
// First run (what Atlas is, then the keymap question), and afterwards the
// first focus of a session composer brings up its Tip. Answers, seen tips and
// Replay all tips hold until the page reloads.

import type { KeybindingsLoadResult } from "@/features/keybindings/lib/keybindings-api";
import { DEFAULT_KEYBINDINGS_FILE, type KeybindingsFile } from "@/features/keybindings/lib/types";
import { tipsHandlers } from "../fixtures/settings";
import type { Scenario } from "../types";

let written: KeybindingsFile | null = null;

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
    ...tipsHandlers({
      cohort: "fresh",
      seen: [],
      checklist: [],
      checklistDismissed: false,
      activeDays: [],
    }),
  },
};

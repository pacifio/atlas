import { create } from "zustand";

/**
 * Every section the Settings panel can show.
 *
 * Named rather than left as `string` because the callers that navigate here
 * (the sidebar's Skills button, the account menu) live nowhere near the panel:
 * a typo would compile, open Settings, and silently land on nothing. The
 * `SECTIONS` table in `settings-panel.tsx` is typed against this, so the two
 * cannot drift apart.
 */
export type SettingsSection =
  | "general"
  | "appearance"
  | "layouts"
  | "providers"
  | "skills"
  | "agents"
  | "models"
  | "updates"
  | "keybindings"
  | "about";

/** Cross-component signal to open the Settings tab on a specific section.
 *  Set `goTo(section)` before/after opening the (singleton, persistent) settings
 *  tab; `SettingsPanel` consumes it so the switch works whether the tab is
 *  freshly opened or already mounted on another section. */
interface SettingsNavState {
  section: SettingsSection | null;
  goTo: (section: SettingsSection) => void;
  clear: () => void;
}

export const useSettingsNav = create<SettingsNavState>((set) => ({
  section: null,
  goTo: (section) => set({ section }),
  clear: () => set({ section: null }),
}));

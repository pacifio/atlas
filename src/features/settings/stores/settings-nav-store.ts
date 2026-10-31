import { create } from "zustand";

/**
 * Every section the Settings panel can show.
 *
 * Named rather than left as `string` because the callers that navigate here
 * (the sidebar's Skills button, the account menu) live nowhere near the panel:
 * a typo would compile, open Settings, and silently land on nothing. The
 * sidebar in `settings-screen.tsx` is typed against this, and every page of the
 * settings registry (`SETTINGS_PAGES`) must be one of these — a type check in
 * `settings-sections.ts` fails the build otherwise. The agent-facing `ui_open`
 * tool offers the same list (`ui-actions-contract.test.ts`).
 */
export const SETTINGS_SECTIONS = [
  "general",
  "appearance",
  "chat",
  "memory",
  "notifications",
  "source-control",
  "pull-requests",
  "privacy",
  "keybindings",
  "updates",
  "agents",
  "skills",
  "layouts",
  "about",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Whether the Settings screen is up, and cross-component signals to it.
 *  Settings is not a tab: it takes over the whole window and
 *  `Back` returns to the workspace exactly as it was (`SettingsScreen`).
 *  `goTo(section)` reaches the screen whether it is opening fresh or is already
 *  showing another section. */
interface SettingsNavState {
  /** The Settings screen covers the window. */
  open: boolean;
  setOpen: (open: boolean) => void;
  section: SettingsSection | null;
  /** A row to scroll to and flash once its section renders (a setting key, or
   *  a row's own anchor). Consumed by the row that owns it. */
  anchor: string | null;
  /** The section the screen is showing right now (null: not open) —
   *  what lets a notification know the user is already looking at its subject. */
  shown: string | null;
  /** Which settings the pages edit: `null` for every project (the global
   *  `config.toml`), or one project's path (its `.atlas/config.toml`). */
  scope: string | null;
  setScope: (scope: string | null) => void;
  goTo: (section: SettingsSection, anchor?: string) => void;
  clear: () => void;
  clearAnchor: () => void;
  setShown: (section: string | null) => void;
}

export const useSettingsNav = create<SettingsNavState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  section: null,
  anchor: null,
  shown: null,
  scope: null,
  setScope: (scope) => set({ scope }),
  goTo: (section, anchor) => set({ section, anchor: anchor ?? null }),
  clear: () => set({ section: null }),
  clearAnchor: () => set({ anchor: null }),
  setShown: (shown) => set({ shown }),
}));

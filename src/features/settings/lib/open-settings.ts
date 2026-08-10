import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useSettingsNav, type SettingsSection } from "../stores/settings-nav-store";

/**
 * Open the Settings tab already showing `section`.
 *
 * Both channels are used, because the panel has two ways of arriving at a
 * section and only one of them covers each case:
 *
 * - `data.section` becomes the panel's initial state, so a tab opened fresh
 *   *renders* on the right section. Without it the panel mounts on General and
 *   swaps a frame later — a visible flash on the common path.
 * - The nav store reaches a panel that is **already mounted** on another
 *   section, where the initial state has long since been read.
 *
 * Setting one without the other leaves half the ticket's requirement working.
 */
export function openSettingsSection(section: SettingsSection): void {
  useSettingsNav.getState().goTo(section);
  useLayoutStore.getState().actions.addTab({
    id: "settings",
    type: "settings",
    title: "Settings",
    closable: true,
    dirty: false,
    data: { section },
  });
}

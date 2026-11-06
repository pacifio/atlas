import { useSettingsNav, type SettingsSection } from "../stores/settings-nav-store";

/**
 * Bring up the Settings screen, on `section` when given (else wherever it was
 * last left).
 *
 * `anchor` names one row on that section (a setting key, e.g. `"gitAutoFetch"`)
 * to scroll to and flash once it renders.
 */
export function openSettingsSection(section?: SettingsSection, anchor?: string): void {
  const nav = useSettingsNav.getState();
  if (section) nav.goTo(section, anchor);
  nav.setOpen(true);
}

/** Back to the workspace, which was left mounted underneath. */
export function closeSettings(): void {
  useSettingsNav.getState().setOpen(false);
}

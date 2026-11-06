import { openUrl } from "@tauri-apps/plugin-opener";
import { runAction } from "@/features/keybindings/lib/action-registry";
import { isActionId } from "@/features/keybindings/lib/actions";
import { openSettingsSection } from "@/features/settings/lib/open-settings";
import { useFeedbackStore } from "@/features/feedback/stores/feedback-store";
import { DISCORD_URL, DOCS_URL, GITHUB_URL } from "@/lib/atlas-links";
import type { MenuCommandId } from "./menu-model";

const COMMANDS: Record<MenuCommandId, () => void> = {
  "app.about": () => openSettingsSection("about"),
  "app.checkUpdates": () => openSettingsSection("updates", "check-updates"),
  "help.docs": () => void openUrl(DOCS_URL),
  "help.shortcuts": () => openSettingsSection("keybindings"),
  // The source tags the report; the rail's help menu sends the same one.
  "help.feedback": () => useFeedbackStore.getState().actions.openPanel("status-bar"),
  "help.github": () => void openUrl(GITHUB_URL),
  "help.discord": () => void openUrl(DISCORD_URL),
};

/**
 * Run a menu item by id: a keybinding action through `runAction`, exactly as
 * its chord would, or a menu-only command. Returns whether anything ran.
 */
export function runMenuItem(id: string): boolean {
  if (isActionId(id)) return runAction(id).ok;
  const command = COMMANDS[id as MenuCommandId];
  if (!command) return false;
  command();
  return true;
}

export const MENU_COMMAND_IDS = Object.keys(COMMANDS);

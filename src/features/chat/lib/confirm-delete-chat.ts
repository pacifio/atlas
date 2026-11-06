import { confirm } from "@/lib/confirm";
import { useSettingsStore } from "@/features/settings/stores/settings-store";

/** Whether to go ahead with deleting the session `title`: asks first unless the
 *  user switched `confirmDeleteChat` off. `scope`: see `ConfirmPrompt`. */
export async function confirmDeleteChat(title: string, scope?: string): Promise<boolean> {
  if (!useSettingsStore.getState().settings.confirmDeleteChat) return true;
  return confirm({
    title: "Delete this session?",
    body: `“${title || "Untitled session"}” leaves your sidebar and history. Settle it instead to keep it out of the way.`,
    confirmLabel: "Delete",
    destructive: true,
    scope,
  });
}

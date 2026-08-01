import { useWorkspaceStore } from "../stores/workspace-store";

/**
 * Open the native folder picker and add the chosen directory as a workspace
 * (or focus it if already open). Shared by the Cmd+Shift+N hotkey, the
 * sidebar "+" affordance, and the welcome screen. Replaces the old
 * "open a new native window" flow — Atlas is single-window now.
 */
export async function pickAndAddWorkspace(): Promise<void> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true });
    if (selected) {
      await useWorkspaceStore
        .getState()
        .actions.addWorkspace(selected as string);
    }
  } catch {
    // dialog not available (e.g. non-Tauri context) — no-op
  }
}

import { useProjectStore } from "../stores/project-store";

/**
 * Open the native folder picker and add the chosen directory as a project
 * (or focus it if already open). Shared by the Cmd+Shift+N hotkey, the
 * sidebar "+" affordance, the welcome screen and the command palette.
 * Replaces the old "open a new native window" flow — Atlas is single-window
 * now.
 *
 * `create` is the palette's "New project": the same picker, titled for it and
 * offering its New Folder button, so an empty folder made there becomes the
 * project.
 */
export async function pickAndAddProject(opts: { create?: boolean } = {}): Promise<void> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: true,
      ...(opts.create
        ? { canCreateDirectories: true, title: "Choose or create a folder for the new project" }
        : {}),
    });
    if (selected) {
      await useProjectStore.getState().actions.addProject(selected as string);
    }
  } catch {
    // dialog not available (e.g. non-Tauri context) — no-op
  }
}

import { projectPathForTab } from "@/features/chat/lib/tab-project";
import { useProjectStore } from "@/features/projects/stores/project-store";

/** The project a session's Details card describes: the tab's own project,
 *  else the active one. Shared by the button (its capture dot) and the card. */
export function useDetailsProjectPath(tabId: string): string | null {
  const activePath = useProjectStore(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.path ?? null,
  );
  return projectPathForTab(tabId) ?? activePath;
}

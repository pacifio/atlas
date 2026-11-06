import { useMemo } from "react";
import { useAppStore } from "../stores/app-store";
import { recentsForOrg } from "../lib/recent-projects";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { WelcomeScreenView } from "./views/welcome-screen-view";

export function WelcomeScreen() {
  const paletteHint = useActionShortcut("nav.commandPalette")?.label ?? "⌘K";
  // "Open Folder" is the same pick-a-folder-and-add-it flow as the
  // `workspace.add` action, so show that action's live chord (hidden if unbound).
  const openFolderHint = useActionShortcut("workspace.add")?.label;
  const allRecents = useAppStore.use.recentProjects();
  const activeOrgId = useOrgStore.use.activeOrganisationId();
  const projects = useProjectStore.use.projects();
  // Scoped to the active org: this list used to show every org's project
  // names and absolute paths, and opening one forked it into the wrong org.
  const recentProjects = useMemo(
    () => recentsForOrg(allRecents, projects, activeOrgId),
    [allRecents, projects, activeOrgId],
  );
  const { openProject, removeRecent } = useAppStore.use.actions();

  const handleOpenFolder = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true });
      if (selected) {
        openProject(selected as string);
      }
    } catch {
      // dialog not available
    }
  };

  return (
    <WelcomeScreenView
      recents={recentProjects}
      paletteHint={paletteHint}
      openFolderHint={openFolderHint}
      onOpenFolder={() => void handleOpenFolder()}
      onOpenRecent={(path) => void openProject(path)}
      onRemoveRecent={removeRecent}
    />
  );
}

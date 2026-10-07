import { useMemo } from "react";
import { useAppStore } from "../stores/app-store";
import { recentsForOrg } from "../lib/recent-projects";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { FolderOpen, Clock, X, Folder } from "lucide-react";
import { AtlasIcon } from "@/components/atlas-icon";
import { Hint } from "@/ui/tooltip";

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
    <div className="h-full flex items-center justify-center bg-background">
      <div className="w-[360px] space-y-8">
        {/* Branding */}
        <div className="text-center space-y-2">
          <AtlasIcon size={64} className="mx-auto mb-4 rounded-2xl" />
          <h1 className="text-xl font-semibold text-[var(--foreground)]">Atlas</h1>
          <p className="text-sm text-[var(--secondary-foreground)]">Multiplayer AI development</p>
        </div>

        {/* Primary action */}
        <button
          onClick={handleOpenFolder}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--card)] hover:bg-[var(--atlas-element-hover)] hover:border-[var(--atlas-border-strong)] transition-colors text-left group"
        >
          <FolderOpen size={14} className="text-[var(--primary)] shrink-0" />
          <span className="text-sm font-medium text-[var(--foreground)]">Open Folder</span>
          {openFolderHint && (
            <span className="text-2xs text-[var(--muted-foreground)] ml-auto font-mono">
              {openFolderHint}
            </span>
          )}
        </button>

        {/* Recent projects */}
        {recentProjects.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 px-1">
              <Clock size={11} className="text-[var(--muted-foreground)]" />
              <span className="text-2xs font-semibold text-[var(--muted-foreground)] uppercase tracking-wide">
                Recent Projects
              </span>
            </div>
            <div className="space-y-1">
              {recentProjects.map((project) => (
                <div
                  key={project.path}
                  className="group flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[var(--atlas-element-hover)] transition-colors cursor-pointer"
                  onClick={() => openProject(project.path)}
                >
                  <Folder size={14} className="text-[var(--primary)] shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-[var(--foreground)] truncate">
                      {project.name}
                    </div>
                    <div className="text-2xs text-[var(--muted-foreground)] truncate font-mono">
                      {project.path}
                    </div>
                  </div>
                  <Hint label="Remove from recents">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeRecent(project.path);
                      }}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1 rounded hover:bg-[var(--atlas-element-active)] text-[var(--muted-foreground)] transition-opacity"
                    >
                      <X size={10} />
                    </button>
                  </Hint>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Hint */}
        <div className="text-center">
          <span className="text-2xs text-[var(--muted-foreground)]">
            Press{" "}
            <kbd className="px-1 py-0.5 rounded bg-[var(--card)] border border-[var(--border)] text-3xs font-mono">
              {paletteHint}
            </kbd>{" "}
            for command palette
          </span>
        </div>
      </div>
    </div>
  );
}

import { useProjectStore } from "../stores/project-store";
import { FolderOpen, Clock, X, Folder } from "lucide-react";
import { AtlasIcon } from "@/components/atlas-icon";

export function WelcomeScreen() {
  const recentProjects = useProjectStore.use.recentProjects();
  const { openProject, removeRecent } = useProjectStore.use.actions();

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
    <div className="h-full flex items-center justify-center bg-bg-base">
      <div className="w-[360px] space-y-8">
        {/* Branding */}
        <div className="text-center space-y-2">
          <AtlasIcon size={64} className="mx-auto mb-4 rounded-2xl" />
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">Atlas</h1>
          <p className="text-sm text-[var(--text-secondary)]">The second brain IDE</p>
        </div>

        {/* Primary action */}
        <button
          onClick={handleOpenFolder}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)] hover:border-[var(--border-strong)] transition-colors text-left group"
        >
          <FolderOpen size={14} className="text-[var(--accent-primary)] shrink-0" />
          <span className="text-[12px] font-medium text-[var(--text-primary)]">Open Folder</span>
          <span className="text-[10px] text-[var(--text-tertiary)] ml-auto font-mono">⌘O</span>
        </button>

        {/* Recent projects */}
        {recentProjects.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 px-1">
              <Clock size={11} className="text-[var(--text-tertiary)]" />
              <span className="text-[10px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wide">
                Recent Projects
              </span>
            </div>
            <div className="space-y-1">
              {recentProjects.map((project) => (
                <div
                  key={project.path}
                  className="group flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                  onClick={() => openProject(project.path)}
                >
                  <Folder size={14} className="text-[var(--accent-primary)] shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-medium text-[var(--text-primary)] truncate">
                      {project.name}
                    </div>
                    <div className="text-[10px] text-[var(--text-tertiary)] truncate font-mono">
                      {project.path}
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeRecent(project.path);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[var(--bg-active)] text-[var(--text-tertiary)] transition-opacity"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Hint */}
        <div className="text-center">
          <span className="text-[10px] text-[var(--text-tertiary)]">
            Press{" "}
            <kbd className="px-1 py-0.5 rounded bg-[var(--bg-elevated)] border border-[var(--border-default)] text-[9px] font-mono">
              ⌘K
            </kbd>{" "}
            for command palette
          </span>
        </div>
      </div>
    </div>
  );
}

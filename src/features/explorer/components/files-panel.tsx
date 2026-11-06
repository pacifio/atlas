import { useProjectStore } from "@/features/projects/stores/project-store";

/**
 * The Files tab's own content: nothing, once there is a project. The tree it
 * shows is the column's (`FileDockColumn` in `file-dock.tsx`), filling the
 * column while this tab is active and docking beside the file once a file
 * tab replaces it, so the same tree, scroll and open folders carry from one
 * to the other. Without a project there is no tree; this says so.
 */
export function FilesPanel({ projectId }: { projectId: string | null }) {
  const root = useProjectStore(
    (s) => (projectId && s.projects.find((p) => p.id === projectId)?.path) || null,
  );
  if (root) return null;
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
      Open a project to browse its files.
    </div>
  );
}

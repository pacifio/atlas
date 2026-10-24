import { useMemo, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { groupOf, useLayoutStore } from "@/features/layout/stores/layout-store";
import {
  FILE_SURFACE_SUBHEADER_CLASS,
  FileTreeToggle,
} from "@/features/editor/components/file-surface-chrome";
import { FileBreadcrumbsRow } from "@/features/editor/components/file-breadcrumbs";
import { retainedBreadcrumbTrail } from "@/features/editor/lib/file-path";
import { OpenInEditorButton } from "@/features/external-editor/components/open-in-editor-button";
import { useFileTabTreeStore } from "../stores/file-tab-tree-store";
import { relativeTo } from "../lib/project-file-ops";
import { openInProject } from "../lib/open-in-project";
import { FILE_DOCK_RESERVE, FILE_DOCK_RESERVE_VAR, FILE_DOCK_WIDTH } from "../lib/file-tabs";
import {
  FileTabFrameContext,
  useFileDock,
  useFileTabFrame,
  type FileTabFrameValue,
} from "../lib/file-tab-frame-context";

/**
 * A file tab's frame: a header band naming the file (breadcrumbs, then the
 * toolbar), and under it the file, with room on its right for the project
 * tree the column docks there (`file-dock.tsx`).
 *
 * The tree is the column's, one instance for every file tab in it, so moving
 * between files never rebuilds it. The frame only leaves room for it: the
 * {@link FILE_DOCK_RESERVE_VAR} variable is the tree's width while it is
 * shown beside this file, and a file's body takes it as its right margin. The
 * header runs the full width, over the tree, so its toolbar ends at the
 * column's edge with the tree toggle last.
 *
 * The editor draws its own header (its toolbar has word wrap, the rendered
 * toggle and blame); every other file view gets the frame's.
 *
 * The tree shows only for a file inside the open project. An attachment, or
 * anything else outside it, has no tree to place it in. Its visibility is one
 * persisted preference for every file tab.
 *
 * The frame's shape never changes. Editor tabs of background projects stay
 * mounted, and the file they hold goes in and out of "the project" as the
 * user switches; a frame that dropped a wrapper then would remount the editor
 * and lose unsaved edits and undo history. For the same reason the root is
 * the tab's own project, never whichever one happens to be active.
 */
export function FileTabFrame({
  tabId,
  projectId,
  filePath,
  ownHeader = false,
  children,
}: {
  tabId: string;
  /** The project the tab belongs to; null for the projectless strip. */
  projectId: string | null;
  filePath: string | undefined;
  /** The file view draws the header band itself (the editor). */
  ownHeader?: boolean;
  children: ReactNode;
}) {
  const project = useProjectStore((s) =>
    projectId ? (s.projects.find((p) => p.id === projectId) ?? null) : null,
  );
  const root = project?.path || null;
  const shown = useFileTabTreeStore.use.shown();
  const { setShown } = useFileTabTreeStore.use.actions();
  const dock = useFileDock();
  // The main column draws no tab strip; every other column, and the
  // projectless strip, has a tab naming the file.
  const titled = useLayoutStore((s) => {
    if (projectId === null) return true;
    const tab = s.tabs.find((t) => t.id === tabId);
    return !tab || groupOf(tab) !== s.groupOrder[0];
  });

  const inProject =
    !!root &&
    !!filePath &&
    !filePath.startsWith("untitled:") &&
    relativeTo(root, filePath) !== null;
  const active = dock?.activeTabId === tabId;
  const treeShown = inProject && shown;

  const frame = useMemo<FileTabFrameValue>(
    () => ({
      root: inProject ? root : null,
      projectName: inProject ? (project?.name ?? null) : null,
      titled,
      crumbFolder: active ? (dock?.crumbFolder ?? null) : null,
      revealFolder: (path) => dock?.revealFolder(path),
      revealFile: () => dock?.revealFile(),
      treeShown,
      toggleTree: () => setShown(!shown),
    }),
    [inProject, root, project?.name, titled, active, dock, treeShown, shown, setShown],
  );

  const reserve = { [FILE_DOCK_RESERVE_VAR]: treeShown ? FILE_DOCK_WIDTH : "0px" } as CSSProperties;

  // Always this element tree: the header and the body wrapper are both
  // there whatever the file is, so `children` keeps its position (and its
  // state).
  return (
    <FileTabFrameContext.Provider value={frame}>
      <div className="flex h-full min-h-0 w-full flex-col" style={reserve} data-file-tab-frame>
        {!ownHeader && <FrameHeader filePath={filePath} />}
        <div
          className="min-h-0 flex-1"
          style={ownHeader ? undefined : { marginRight: FILE_DOCK_RESERVE }}
        >
          {children}
        </div>
      </div>
    </FileTabFrameContext.Provider>
  );
}

/**
 * The header band of a file view that has no toolbar of its own (an image, a
 * PDF, a notebook): the file's breadcrumbs, opening it in an editor, and the
 * tree toggle.
 */
function FrameHeader({ filePath }: { filePath: string | undefined }) {
  const frame = useFileTabFrame();
  if (!filePath) return <div className={FILE_SURFACE_SUBHEADER_CLASS} />;
  const root = frame?.root ?? null;
  const rel = root ? relativeTo(root, filePath) : null;
  const current = rel === null ? filePath : (frame?.crumbFolder ?? rel);
  const trail = rel === null ? filePath : retainedBreadcrumbTrail(rel, current);
  return (
    <div
      className={cn(
        "flex items-center gap-2 overflow-hidden bg-background px-3",
        FILE_SURFACE_SUBHEADER_CLASS,
      )}
      data-surface-subheader
    >
      <FileBreadcrumbsRow
        root={rel === null ? null : root}
        projectName={frame?.projectName ?? ""}
        relativePath={current}
        trail={trail}
        onNavigate={(crumbPath) => {
          if (rel === null) {
            void import("@tauri-apps/plugin-opener").then(({ revealItemInDir }) =>
              revealItemInDir(crumbPath).catch(() => {}),
            );
          } else if (crumbPath === trail) frame?.revealFile();
          else frame?.revealFolder(crumbPath);
        }}
        onOpenFile={(abs) => void openInProject(abs)}
        identity={frame?.titled === false ? { path: filePath, dirty: false } : null}
        className="shrink"
      />
      <div className="ml-auto flex items-center gap-1 pl-2">
        <OpenInEditorButton compact path={filePath} />
        <FileTreeToggle />
      </div>
    </div>
  );
}

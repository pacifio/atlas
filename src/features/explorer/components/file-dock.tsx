import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useLayoutStore, type Tab } from "@/features/layout/stores/layout-store";
import { showWorkingTreeDiff } from "@/features/git/lib/open-review-file";
import { useFileTabTreeStore } from "../stores/file-tab-tree-store";
import { useFilesRevealStore } from "../stores/files-reveal-store";
import { relativeTo } from "../lib/project-file-ops";
import { FILE_DOCK_WIDTH, isFileTab } from "../lib/file-tabs";
import { FileDockContext, type FileDockValue } from "../lib/file-tab-frame-context";

const ProjectFileTree = lazy(() =>
  import("./project-file-tree").then((m) => ({ default: m.ProjectFileTree })),
);

/** Where the column's tree sits: the whole column (the Files tab), docked
 *  right of the file under its header (a file tab), or out of sight. */
export type FileDockMode = "full" | "docked" | "off";

/**
 * The file-tab state that decides the dock's mode. Exported for the tests:
 * the same rule sets the room a file's frame leaves for the tree.
 */
export function fileDockMode(input: {
  root: string | null;
  activeTab: Pick<Tab, "type" | "data"> | null;
  treeShown: boolean;
}): FileDockMode {
  const { root, activeTab, treeShown } = input;
  if (!root || !activeTab) return "off";
  if (activeTab.type === "files") return "full";
  return treeShown && fileInProject(root, activeTab) ? "docked" : "off";
}

/** A file tab whose file is inside `root`: the tabs the docked tree serves. */
export function fileInProject(root: string | null, tab: Pick<Tab, "type" | "data">): boolean {
  if (!root || !isFileTab(tab.type)) return false;
  const path = tab.data.filePath;
  return (
    typeof path === "string" && !path.startsWith("untitled:") && relativeTo(root, path) !== null
  );
}

/**
 * One split column's project tree, shared by the column's Files tab and every
 * file tab in it.
 *
 * With the Files tab active the tree fills the column. With a file tab active
 * it docks on the right, under the file's header band, as wide as
 * {@link FILE_DOCK_WIDTH}; the file's frame leaves that much room
 * (`FILE_DOCK_RESERVE`). It is ONE instance for the whole column: switching
 * between the Files tab and file tabs, or from one file to the next, moves the
 * same tree, so its virtualizer, scroll position, search and expanded folders
 * all stay as they were. Picking a file from the Files tab opens the file's
 * tab and closes the Files tab: the file replaces it, and the tree stays.
 *
 * It mounts the first time the column shows a Files or file tab, stays mounted
 * (hidden) while the column shows something else, and unmounts when the
 * column has no such tab left or its project goes to the background, so a
 * background project keeps no tree, watcher or virtualizer alive.
 */
export function FileDockColumn({
  projectId,
  projectActive,
  tabs,
  activeTab,
  children,
}: {
  /** The column's project; null for the projectless strip. */
  projectId: string | null;
  projectActive: boolean;
  /** This column's tabs. */
  tabs: readonly Tab[];
  activeTab: Tab | null;
  children: ReactNode;
}) {
  const root = useProjectStore(
    (s) => (projectId && s.projects.find((p) => p.id === projectId)?.path) || null,
  );
  const treeShown = useFileTabTreeStore.use.shown();
  const { setShown } = useFileTabTreeStore.use.actions();
  const mode = fileDockMode({ root, activeTab, treeShown });
  const activeFile =
    activeTab && fileInProject(root, activeTab) ? (activeTab.data.filePath as string) : null;
  const activeId = activeTab?.id ?? null;

  // ── Mounting: on first need, kept while the column could need it ──
  const keep = projectActive && !!root && tabs.some((t) => t.type === "files" || isFileTab(t.type));
  const [started, setStarted] = useState(false);
  if (started && !keep) setStarted(false);
  else if (!started && keep && mode !== "off") setStarted(true);

  // ── Revealing ──
  // Each time a tab comes on screen (or its file changes), reveal its file
  // afresh, and the crumbs end at the file again.
  const [revealNonce, setRevealNonce] = useState(0);
  const [crumbFolder, setCrumbFolder] = useState<{ path: string; nonce: number } | null>(null);
  const shownKey = `${activeId ?? ""}\n${activeFile ?? ""}`;
  const [seenKey, setSeenKey] = useState(shownKey);
  if (seenKey !== shownKey) {
    setSeenKey(shownKey);
    setRevealNonce((n) => n + 1);
    setCrumbFolder(null);
  }

  // A path asked for by `revealFiles(path)` (an agent's `ui_focus` explorer)
  // is highlighted on the Files tab; without one the tree follows the file
  // being read. Taken during render, so the tree never reveals the reader's
  // file for a frame first. A path in another project means follow the reader.
  const filesActive = activeTab?.type === "files";
  const request = useFilesRevealStore.use.request();
  const { take } = useFilesRevealStore.use.actions();
  const [filesReveal, setFilesReveal] = useState<{ path: string; nonce: number } | null>(null);
  const [seenRequest, setSeenRequest] = useState<number | null>(null);
  if (filesActive && root && request && request.nonce !== seenRequest) {
    setSeenRequest(request.nonce);
    const path = request.path;
    setFilesReveal(
      path !== null && relativeTo(root, path) !== null ? { path, nonce: request.nonce } : null,
    );
  }
  if (!filesActive && filesReveal) setFilesReveal(null);
  useEffect(() => {
    if (filesActive && root && request) take();
  }, [filesActive, root, request, take]);
  // A request the Files tab never read is stale once it leaves the screen.
  const wasFilesActive = useRef(filesActive);
  useEffect(() => {
    if (wasFilesActive.current && !filesActive) take();
    wasFilesActive.current = filesActive;
  }, [filesActive, take]);

  // The Files tab hands off: the file it opened takes its place.
  const filesTabId = filesActive ? activeTab.id : null;
  const handOff = useCallback(() => {
    if (filesTabId) useLayoutStore.getState().actions.closeTab(filesTabId);
  }, [filesTabId]);

  const value = useMemo<FileDockValue>(
    () => ({
      activeTabId: activeId,
      crumbFolder: crumbFolder?.path ?? null,
      revealFolder: (path) => {
        setShown(true);
        setCrumbFolder((cur) => ({ path, nonce: (cur?.nonce ?? 0) + 1 }));
      },
      revealFile: () => {
        setShown(true);
        setCrumbFolder(null);
        setRevealNonce((n) => n + 1);
      },
    }),
    [activeId, crumbFolder, setShown],
  );

  // Out of sight, the tree keeps its last place, size and target, so coming
  // back reveals nothing new and its scroll stays put.
  const live: DockTarget | null =
    mode === "full"
      ? {
          geometry: "full",
          activeFile: filesReveal ? filesReveal.path : undefined,
          revealNonce: filesReveal ? filesReveal.nonce : revealNonce,
          onFileOpened: handOff,
        }
      : mode === "docked"
        ? { geometry: "docked", activeFile, revealNonce, onFileOpened: undefined }
        : null;
  const [frozen, setFrozen] = useState(live);
  if (live && !sameTarget(frozen, live)) setFrozen(live);
  const shown = live ?? frozen;
  const geometry = shown?.geometry ?? "full";

  return (
    <FileDockContext.Provider value={value}>
      {children}
      {started && root && (
        <aside
          aria-label="Project files"
          data-file-dock={mode}
          inert={mode === "off"}
          className={cn(
            "absolute right-0 bottom-0 flex min-h-0 flex-col bg-background",
            geometry === "full" ? "top-0 left-0" : "top-(--control-lg) border-l border-border",
            mode === "off" && "invisible",
          )}
          style={geometry === "docked" ? { width: FILE_DOCK_WIDTH } : undefined}
        >
          <Suspense fallback={<PanelSkeleton rows={8} />}>
            <ProjectFileTree
              root={root}
              activeFile={shown?.activeFile}
              revealNonce={shown?.revealNonce ?? 0}
              revealFolder={mode === "docked" ? crumbFolder : null}
              onFileOpened={shown?.onFileOpened}
              onShowDiff={(path) => showWorkingTreeDiff(root, path)}
            />
          </Suspense>
        </aside>
      )}
    </FileDockContext.Provider>
  );
}

interface DockTarget {
  geometry: "full" | "docked";
  /** Undefined: follow the file being read. */
  activeFile: string | null | undefined;
  revealNonce: number;
  onFileOpened: (() => void) | undefined;
}

function sameTarget(a: DockTarget | null, b: DockTarget): boolean {
  return (
    !!a &&
    a.geometry === b.geometry &&
    a.activeFile === b.activeFile &&
    a.revealNonce === b.revealNonce &&
    a.onFileOpened === b.onFileOpened
  );
}

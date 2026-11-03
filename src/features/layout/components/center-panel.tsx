import { useMemo, memo, Fragment } from "react";
import { cn } from "@/lib/utils";
import { Group, Separator, useDefaultLayout } from "react-resizable-panels";
import { useLayoutStore, type ProjectView } from "../stores/layout-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useAppStore } from "@/features/app/stores/app-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useShallow } from "zustand/react/shallow";
import { surfaceMinWidth } from "@/lib/constants";
import { ProjectlessCenter } from "./projectless-center";
import { TabColumn } from "./tab-column";
import { ColumnPanel } from "./views/column-panel";

// The tab registry — every tab type's lazy import and render branch, and the
// persistent-type lists — lives in `tab-panels.tsx`.
export { PERSISTENT_TYPES_LIST, IDLE_EXPENSIVE_TYPES_LIST } from "./tab-panels";

/**
 * The center panel is one or more side-by-side **split columns**
 * (`layout-store.groupOrder`, max 3, resizable). Each column hosts an
 * independent tab strip + content area; a given tab lives in exactly one
 * column. The single-column case is the normal IDE.
 */
export function CenterPanel() {
  const currentProject = useAppStore.use.currentProject();
  // Render ONLY the bounded HOT set, not the full project registry — keeps
  // memory/DOM bounded at 100+ projects (Chrome tab-discard model). Resolve ids
  // to projects, preserving registry order for stable React keys.
  const projectsAll = useProjectStore.use.projects();
  const mountedProjectIds = useProjectStore.use.mountedProjectIds();
  const projects = useMemo(() => {
    const mounted = new Set(mountedProjectIds);
    return projectsAll.filter((w) => mounted.has(w.id));
  }, [projectsAll, mountedProjectIds]);
  const activeProjectId = useProjectStore.use.activeProjectId();
  const viewsByWs = useLayoutStore.use.viewsByWs();

  // Live mirror of the ACTIVE project's view.
  const tabs = useLayoutStore.use.tabs();
  const groupOrder = useLayoutStore.use.groupOrder();
  const activeByGroup = useLayoutStore.use.activeByGroup();
  const focusedGroupId = useLayoutStore.use.focusedGroupId();
  const tabHistory = useLayoutStore.use.tabHistory();
  const tabHistoryIndex = useLayoutStore.use.tabHistoryIndex();
  const mirrorView: ProjectView = useMemo(
    () => ({
      tabs,
      groupOrder,
      activeByGroup,
      focusedGroupId,
      tabHistory,
      tabHistoryIndex,
      activeTabId: activeByGroup[focusedGroupId] ?? null,
    }),
    [tabs, groupOrder, activeByGroup, focusedGroupId, tabHistory, tabHistoryIndex],
  );

  // Running-tab ids (shallow-equal so streaming chunks don't churn it),
  // computed once here and shared to every column's tab strip.
  const runningTabIdsArray = useChatStore(
    useShallow((s) =>
      Object.entries(s.sessions)
        .filter(([, sess]) => sess.status === "running")
        .map(([id]) => id)
        .sort(),
    ),
  );
  const runningTabIds = useMemo(() => new Set(runningTabIdsArray), [runningTabIdsArray]);

  if (!currentProject) return <ProjectlessCenter />;

  // Render every mounted project's shell in a stable container (key=ws.id),
  // only the active one visible. Background projects keep the INERT expensive
  // subtrees mounted (editor/chat/knowledge/settings) so switching back is
  // instant, but drop the ones that keep working while hidden — terminals,
  // browser embeds, Pixi graphs, PDFs — which were burning CPU/GPU in
  // projects the user couldn't even see. A project with no view yet (never
  // visited this session) renders nothing until its first cold load.
  return (
    // `data-atlas-center-panel`: the anchor for overlays that should centre on
    // the CONTENT, not the window — see `use-center-panel-x.ts`. A `fixed
    // left-1/2` pill drifts off-centre by half the width of whichever side
    // panel is open.
    <div data-atlas-center-panel className="h-full w-full bg-background relative">
      {projects.map((ws) => {
        const isActive = ws.id === activeProjectId;
        const view = isActive ? mirrorView : viewsByWs[ws.id];
        if (!view) return null;
        return (
          <div
            key={ws.id}
            className="absolute inset-0"
            style={{ display: isActive ? "block" : "none" }}
          >
            <ProjectColumns
              projectId={ws.id}
              view={view}
              isActive={isActive}
              runningTabIds={runningTabIds}
            />
          </div>
        );
      })}
    </div>
  );
}

// Memoized so a project switch re-renders only the ≤2 columns whose props
// actually change, not every mounted project's whole subtree (the O(N×tabs)
// re-render that makes even warm switches feel slow). `view` is a stable
// reference for uninvolved projects; `runningTabIds` is shallow-stable.
const ProjectColumns = memo(function ProjectColumns({
  projectId,
  view,
  isActive,
  runningTabIds,
}: {
  projectId: string;
  view: ProjectView;
  isActive: boolean;
  runningTabIds: Set<string>;
}) {
  const surfaces = useLayoutStore.use.surfaces();
  const split = view.groupOrder.length > 1;
  // The first column is the main pane; every one after it is the surfaces
  // pane. Hidden or expanded, a column is collapsed to zero width rather than
  // unmounted, so its terminals keep running and its chat keeps its scroll.
  const shown = view.groupOrder.map((_, i) =>
    !split || surfaces === "shown" ? true : surfaces === "hidden" ? i === 0 : i > 0,
  );
  const firstShown = shown.indexOf(true);
  const lastShown = shown.lastIndexOf(true);
  const solo = firstShown === lastShown;
  const edges = (i: number) => ({ atLeft: i === firstShown, atRight: i === lastShown });
  // A fresh two-column split opens 65/35, not even: the column you split from
  // is the one you were working in (a chat, beside its changes), and the new
  // one is a reference beside it. Only a default — the library uses it when it
  // has no layout for this exact set of columns, and a new split is always a
  // new set (fresh group id). Three columns stay even.
  const pairSizes = view.groupOrder.length === 2 ? ["65", "35"] : null;
  // Same storage id as before the v4 upgrade, so saved split widths carry over.
  // v4 dropped `autoSaveId` in favour of this hook; the Group takes the stored
  // layout as `defaultLayout` and writes back through `onLayoutChanged`.
  const layoutId = `atlas-center-split-${projectId}`;
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: layoutId });
  return (
    <Group
      id={layoutId}
      orientation="horizontal"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      className="h-full bg-background"
    >
      {view.groupOrder.map((gid, i) => (
        <Fragment key={gid}>
          {i > 0 && (
            <Separator
              className={cn(
                "bg-border hover:bg-primary data-[separator=active]:bg-primary transition-colors",
                "w-px cursor-col-resize",
                // Kept in the tree, like the collapsed column beside it; inert
                // while either side is collapsed.
                !(shown[i - 1] && shown[i]) && "pointer-events-none invisible",
              )}
            />
          )}
          <ColumnPanel
            id={gid}
            shown={shown[i]}
            defaultSize={pairSizes?.[i]}
            minSize={i === 0 ? undefined : columnMinSize(view, gid)}
          >
            <TabColumn
              groupId={gid}
              role={i === 0 ? "main" : "surface"}
              view={view}
              isActive={isActive}
              runningTabIds={runningTabIds}
              solo={solo}
              {...edges(i)}
              placementControls={i > 0 && i === view.groupOrder.length - 1}
              projectId={projectId}
            />
          </ColumnPanel>
        </Fragment>
      ))}
    </Group>
  );
});

/**
 * A surfaces column's floor: the pixel minimum its active surface declares
 * (`TAB_PLACEMENT`, ADR-0024), so a column cannot be dragged narrower than
 * its tool's layout works at. A percentage floor alone let team chat's
 * composer wrap on a narrow window.
 */
function columnMinSize(view: ProjectView, groupId: string): string {
  const activeId = view.activeByGroup[groupId];
  const tab = view.tabs.find((t) => t.id === activeId);
  const px = tab ? surfaceMinWidth(tab.type) : null;
  return px === null ? "20" : `${px}px`;
}

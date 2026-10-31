import { useEffect, useRef, useState, useMemo, memo, lazy, Suspense, Fragment } from "react";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { cn } from "@/lib/utils";
import { deepActiveElement } from "@/lib/deep-active-element";
import { HintGroup, HintItem } from "@/ui/hint-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Kbd } from "@/ui/kbd";
import { IconButton } from "@/ui/icon-button";
import { PaneHeader } from "@/components/titlebar";
import { BreadcrumbSeparator } from "@/components/breadcrumb-button";
import { columnChrome } from "../lib/shell-edges";
import { PaneTopInsetContext } from "../lib/pane-top-inset";
import { OPEN_SURFACE_MENU_EVENT, SURFACES, openSurface, surfaceForKey } from "../lib/surfaces";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { useLayoutStore, type Tab, type ProjectView } from "../stores/layout-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
// Chat is the default landing surface — always loaded so the first paint
// shows the agent UI without a Suspense flash.
import { ChatPanel } from "@/features/chat/components/chat-panel";
import { WelcomeScreen } from "@/features/app/components/welcome-screen";
import { UnsupportedView } from "@/features/unsupported/components/unsupported-view";
import { FileTabFrame } from "@/features/explorer/components/file-tab-frame";
import { FileDockColumn } from "@/features/explorer/components/file-dock";
import { PaneTab, tabIcons } from "./pane-tab";
import { PaneTabStrip } from "./pane-tab-strip";

// Every other tab type is lazy. Editor/Terminal in particular pull in
// CodeMirror+Lezer (~600 KB) and xterm (~250 KB) respectively — keeping
// them eager added multi-second parse cost to cold start on machines that
// don't have them in the OS file cache yet. The Suspense fallback in the
// tab content area absorbs the brief load.
const TerminalPanel = lazy(() =>
  import("@/features/terminal/components/terminal-panel").then((m) => ({
    default: m.TerminalPanel,
  })),
);
const EditorPanel = lazy(() =>
  import("@/features/editor/components/editor-panel").then((m) => ({ default: m.EditorPanel })),
);
const BrowserPanel = lazy(() =>
  import("@/features/browser/components/browser-panel").then((m) => ({ default: m.BrowserPanel })),
);
const MediaViewer = lazy(() =>
  import("@/features/media/components/media-viewer").then((m) => ({ default: m.MediaViewer })),
);
const SvgViewer = lazy(() =>
  import("@/features/svg/components/svg-viewer").then((m) => ({ default: m.SvgViewer })),
);
const CommsDraftTab = lazy(() =>
  import("@/features/comms/components/comms-draft-tab").then((m) => ({
    default: m.CommsDraftTab,
  })),
);
const PdfViewer = lazy(() =>
  import("@/features/pdf/components/pdf-viewer").then((m) => ({ default: m.PdfViewer })),
);
const NotebookViewer = lazy(() =>
  import("@/features/notebook/components/notebook-viewer").then((m) => ({
    default: m.NotebookViewer,
  })),
);
const CommitView = lazy(() =>
  import("@/features/git/components/commit-view").then((m) => ({ default: m.CommitView })),
);
// One pull request (`pull-request:<checkout>:<number>`); its own chunk.
const PullRequestPanel = lazy(() =>
  import("@/features/pull-requests/components/pull-request-panel").then((m) => ({
    default: m.PullRequestPanel,
  })),
);
// A repository's pull requests (`pull-requests:<checkout>`); its own chunk.
const PullRequestListPanel = lazy(() =>
  import("@/features/pull-requests/components/pull-request-list-panel").then((m) => ({
    default: m.PullRequestListPanel,
  })),
);
// One session's linked pull requests (`session-pull-requests:<threadId>`);
// its own chunk.
const SessionPullRequestsPanel = lazy(() =>
  import("@/features/pull-requests/components/session-pull-requests-panel").then((m) => ({
    default: m.SessionPullRequestsPanel,
  })),
);
// The review diff (`diff`, `session-changes`). Its own chunk, which is the only
// thing that imports the diff viewer, Shiki and their workers.
const ReviewPanel = lazy(() =>
  import("@/features/git/components/diff-viewer/review-panel").then((m) => ({
    default: m.ReviewPanel,
  })),
);
// The project tree as a surface of its own (`files-surface.ts`).
const FilesPanel = lazy(() =>
  import("@/features/explorer/components/files-panel").then((m) => ({
    default: m.FilesPanel,
  })),
);
const SourceControlPanel = lazy(() =>
  import("@/features/git/components/source-control-panel").then((m) => ({
    default: m.SourceControlPanel,
  })),
);
// Team chat is a surface tab (ADR-0024); it used to be the right slot.
const CommsPanel = lazy(() =>
  import("@/features/comms/components/comms-panel").then((m) => ({ default: m.CommsPanel })),
);
const LogPanel = lazy(() =>
  import("@/features/log/components/log-panel").then((m) => ({ default: m.LogPanel })),
);
import { useAppStore } from "@/features/app/stores/app-store";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { sessionDisplayTitle } from "@/features/chat/lib/session-title";
import { SessionHeaderSlot } from "@/features/chat/components/session-header-slot";
import { useShallow } from "zustand/react/shallow";
import { MessageSquare, Plus, House, Maximize2, Minimize2 } from "lucide-react";
import { readPullRequestTabData } from "@/features/pull-requests/lib/open-pull-request-tab";
import { readPullRequestListTabData } from "@/features/pull-requests/lib/open-pull-request-list-tab";
import { readSessionPullRequestsTabData } from "@/features/pull-requests/lib/open-session-pull-requests-tab";
import { PROJECTLESS_TYPES, surfaceMinWidth, type TabType } from "@/lib/constants";
import { useSettingsNav } from "@/features/settings/stores/settings-nav-store";

const GROUP_OF = (t: Tab) => t.groupId ?? "main";
/**
 * Declared as an `as const` TUPLE, not a bare `Set<TabType>`, so the member
 * literals survive into the type system: `PersistentTabType` below is derived
 * from it, and `PersistentPanel`'s `switch` is checked for exhaustiveness
 * against that union. Adding an entry here without giving it a `case` is a
 * COMPILE ERROR — which is the whole point. A `Set<TabType>` erased the
 * literals, so a missing branch silently fell through to the terminal
 * fallback and mounted a PTY instead of the panel (this is how the Spaces tab
 * regressed in 32767aff8).
 */
export const PERSISTENT_TYPES_LIST = [
  "editor",
  "terminal",
  "browser",
  "pdf",
  // Keep chat mounted across tab switches too: it keeps its mounted
  // transcript window + scroll position (remounting re-ran the "loading
  // transcript" path and rebuilt scroll). Team chat, for the same reason: an
  // open conversation keeps its scroll and its half-typed message.
  "chat",
  "team-chat",
  // Knowledge, the knowledge graph and Spaces were here too; they are
  // destinations now (ADR-0024), kept mounted by the destination screen.
] as const satisfies readonly TabType[];

type PersistentTabType = (typeof PERSISTENT_TYPES_LIST)[number];
type PersistentTab = Tab & { type: PersistentTabType };

const PERSISTENT_TYPES: ReadonlySet<TabType> = new Set(PERSISTENT_TYPES_LIST);

// Of the persistent types, these are the ones that keep BURNING CPU/GPU while
// hidden — a PTY draining output, a live web embed, a Pixi/WebGL graph ticking,
// a PDF worker. Those get unmounted for background projects (idle heat is the
// bigger cost than their rebuild). The rest are inert-but-expensive-to-rebuild
// (chat's transcript window + load path, knowledge's tree walk, settings' form
// drafts) and stay mounted everywhere: hiding them saves nothing per frame and
// costs a full remount on switch-back.
export const IDLE_EXPENSIVE_TYPES_LIST = [
  "terminal",
  "browser",
  "pdf",
] as const satisfies readonly PersistentTabType[];

const IDLE_EXPENSIVE_TYPES: ReadonlySet<TabType> = new Set(IDLE_EXPENSIVE_TYPES_LIST);

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

/**
 * One split column's panel, collapsed to zero width instead of unmounted when
 * the surfaces mode hides it. Sizes are percentages: v4 reads bare numbers as
 * PIXELS and unit-less strings as percentages. `order` is gone — panels are
 * ordered by DOM position — but `id` still keys the saved layout.
 */
function ColumnPanel({
  id,
  shown,
  defaultSize,
  minSize = "20",
  children,
}: {
  id: string;
  shown: boolean;
  defaultSize?: string;
  /** A percentage, or a pixel floor ("320px") from the surface it shows. */
  minSize?: string;
  children: React.ReactNode;
}) {
  const panelRef = usePanelRef();
  // Synced again on the next frame: on mount the Group has not measured itself
  // yet, so a collapse or expand issued then is a no-op or throws.
  useEffect(() => {
    const sync = () => {
      const panel = panelRef.current;
      if (!panel) return;
      try {
        if (shown && panel.isCollapsed()) panel.expand();
        else if (!shown && !panel.isCollapsed()) panel.collapse();
      } catch {
        // A panel added this commit is not registered with its Group yet and
        // throws "constraints not found"; the next-frame sync handles it.
      }
    };
    sync();
    const raf = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(raf);
  }, [shown, panelRef]);
  return (
    <Panel
      id={id}
      panelRef={panelRef}
      collapsible
      collapsedSize="0"
      minSize={minSize}
      defaultSize={defaultSize}
      className="min-w-0"
    >
      {children}
    </Panel>
  );
}

/**
 * One split column. The two roles are deliberately unalike, so it reads at a
 * glance which pane is the work and which holds references beside it:
 *
 * - **main** (the first column): no `+` and no close. With one tab it shows no
 *   strip at all — the tab's title is the breadcrumb's last segment, except an
 *   editor's, which its own crumb row names. A strip appears only once there
 *   is something to switch between. Its right end carries the session's own
 *   controls on a session tab (Details, terminal, ⋯), and on the window's
 *   right edge the window's group (the panel toggle, the account).
 * - **surface**: tabs then `+`, left-aligned; the pane's last column ends in
 *   maximize and the two placement toggles (`PanelPlacementControls`). The
 *   pane is shown and hidden by the window group's panel toggle
 *   (`RightPanelToggle`), never closed with an ×, so hiding it never throws
 *   its tabs into the main pane.
 */
const TabColumn = memo(function TabColumn({
  groupId,
  role,
  view,
  isActive,
  runningTabIds,
  solo,
  atLeft,
  atRight,
  placementControls,
  projectId,
}: {
  groupId: string;
  role: "main" | "surface";
  view: ProjectView;
  isActive: boolean;
  runningTabIds: Set<string>;
  /** The only column on screen. */
  solo: boolean;
  atLeft: boolean;
  atRight: boolean;
  /** The pane's last column: its strip ends in maximize and the placement
   *  toggles. */
  placementControls: boolean;
  projectId: string;
}) {
  const { setActiveTab, setFocusedGroup, moveTab } = useLayoutStore.use.actions();

  const tabsAll = view.tabs;
  const tabs = useMemo(() => tabsAll.filter((t) => GROUP_OF(t) === groupId), [tabsAll, groupId]);
  const activeId = view.activeByGroup[groupId] ?? null;
  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const isFocused = isActive && view.focusedGroupId === groupId;
  const chrome = columnChrome(atLeft, atRight);
  const main = role === "main";
  // The main column is the session: it names it in the breadcrumb and never
  // draws a strip. Sessions switch from the sidebar; everything else opens in
  // the surfaces pane, whose strip this is.
  const showStrip = !main;
  // The session column's header floats over the transcript (see
  // `pane-top-inset.ts`); how tall it is, for what has to clear it.
  const headerRef = useRef<HTMLDivElement>(null);
  const topInset = useFloatingHeaderHeight(headerRef, main);

  return (
    <div
      data-session-column={main || undefined}
      className="relative h-full flex flex-col overflow-hidden bg-background"
      // The notifications drawer sizes itself to the surfaces pane by this.
      data-surface-column={main ? undefined : ""}
      onMouseDownCapture={() => setFocusedGroup(groupId)}
    >
      {/* The column's header, and this column's slice of the window bar: the
          outermost columns carry the window's own controls. In the session
          column it floats, transparent, over the content: the transcript
          scrolls under it and dissolves into the transcript's progressive
          blur instead of being cut off by an opaque strip. */}
      <PaneHeader
        ref={headerRef}
        leading={chrome.leading}
        breadcrumb={main && chrome.breadcrumb}
        trailing={chrome.trailing}
        className={main ? "absolute inset-x-0 top-0 z-titlebar" : undefined}
      >
        {main && chrome.breadcrumb && !showStrip && activeTab && namedInWindowBar(activeTab) && (
          <>
            <BreadcrumbSeparator />
            <MainTitle tab={activeTab} />
          </>
        )}
        <HintGroup>
          {showStrip && (
            // Tabs then `+`, left-aligned together: the `+` sits where the
            // next tab will appear. Only the tabs scroll; the `+` and the
            // controls after it stay put.
            <PaneTabStrip
              tabs={tabs}
              activeId={activeId}
              // With two panes on screen, only the focused one's active tab
              // is fully lit, so it is clear where the next keystroke lands.
              focused={solo || isFocused}
              runningTabIds={runningTabIds}
              onSelect={setActiveTab}
              onMove={moveTab}
            />
          )}
          {/* Never narrower than its controls: when space runs out it is the
              tab strip that gives way and scrolls. */}
          <div className="flex min-w-fit flex-1 items-center gap-0.5">
            {!main && <SurfaceAdd groupId={groupId} />}
            <span className="flex-1" />
            {/* The session's controls (pins, Details), portalled in by its
                chat panel. Only for a session tab: any other tab leaves this
                end of the bar as it is. The window's group (the panel toggle)
                comes after, in the header at the window's right edge
                (`TopbarTrailing`). */}
            {activeTab?.type === "chat" && (
              <SessionHeaderSlot key={activeTab.id} tabId={activeTab.id} />
            )}
            {placementControls && <PanelPlacementControls />}
          </div>
        </HintGroup>
      </PaneHeader>

      <PaneTopInsetContext.Provider value={topInset}>
        <TabContentContainer
          groupId={groupId}
          view={view}
          isActive={isActive}
          projectId={projectId}
        />
      </PaneTopInsetContext.Provider>
    </div>
  );
});

/** The floating header's height, tracked as the interface zoom changes it. 0
 *  while the header is an ordinary row. */
function useFloatingHeaderHeight(ref: React.RefObject<HTMLDivElement | null>, floating: boolean) {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!floating || !el) {
      setHeight(0);
      return;
    }
    const measure = () => setHeight(Math.round(el.getBoundingClientRect().height));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, floating]);
  return height;
}

/** Whether the window bar names the main pane's tab after the project. An
 *  editor tab doesn't: its breadcrumb row already ends at the file, with its
 *  icon and unsaved dot, so the bar keeps only the project. */
function namedInWindowBar(tab: Tab): boolean {
  return tab.type !== "editor";
}

/** The main pane's title, the breadcrumb's last segment. A chat names its
 *  session (the chat store is keyed by tab id) rather than the tab's generic
 *  "Agents". It is the one place the session's name shows: the session view
 *  itself does not repeat it. */
function MainTitle({ tab }: { tab: Tab }) {
  const sessionTitle = useChatStore((s) => {
    const session = tab.type === "chat" ? s.sessions[tab.id] : undefined;
    return session ? sessionDisplayTitle(session.title, session.firstUserContent) : null;
  });
  return (
    <span className="min-w-0 truncate px-1 text-sm text-foreground">
      {sessionTitle ?? tab.title}
    </span>
  );
}

/**
 * The end of the surfaces pane's strip: Maximize, which gives the pane the
 * whole centre (the session collapses, still mounted), so the strip sits at
 * the window's top; again restores it. It is the strip's only control: the
 * pane is shown and hidden by the window group's panel toggle
 * (`RightPanelToggle`), and it always sits on the right.
 */
function PanelPlacementControls() {
  const surfaces = useLayoutStore.use.surfaces();
  const { setSurfaces } = useLayoutStore.use.actions();
  const maximized = surfaces === "expanded";
  const maximizeLabel = maximized ? "Restore panel size" : "Maximize panel";
  return (
    <>
      <HintItem label={maximizeLabel}>
        <IconButton
          icon={maximized ? Minimize2 : Maximize2}
          label={maximizeLabel}
          size="sm"
          iconSize="md"
          aria-pressed={maximized}
          onClick={() => setSurfaces(maximized ? "shown" : "expanded")}
        />
      </HintItem>
    </>
  );
}

const TabContentContainer = memo(function TabContentContainer({
  groupId,
  view,
  isActive,
  projectId,
}: {
  groupId: string;
  view: ProjectView;
  isActive: boolean;
  /** Handed to terminal tabs so they can record their owner. */
  projectId: string;
}) {
  const { setActiveTab } = useLayoutStore.use.actions();
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  const tabsAll = view.tabs;
  const tabs = useMemo(() => tabsAll.filter((t) => GROUP_OF(t) === groupId), [tabsAll, groupId]);
  const activeTabId = view.activeByGroup[groupId] ?? null;
  const activeTab = tabs.find((t) => t.id === activeTabId);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) setHeight(Math.floor(h));
    };
    measure();
    requestAnimationFrame(measure);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // If this column's active id is stale (closed tab, etc.) snap to its first.
  // Only for the ACTIVE project — `setActiveTab` mutates the live (active)
  // store, so a background project must not fire it.
  useEffect(() => {
    if (isActive && !activeTab && tabs.length > 0) setActiveTab(tabs[0].id);
  }, [isActive, activeTab, tabs, setActiveTab]);

  // Hidden chat tabs stay LAID OUT (`visibility:hidden`, see the wrapper
  // below) — but only once this column has been active for an idle slice.
  // Flipping every mounted chat from `display:none` to laid-out costs one
  // layout per thread, and doing that on app boot or in the same frame as a
  // project switch (background projects are `display:none`) would move
  // the stall we are removing onto those paths instead.
  const [warmReady, setWarmReady] = useState(false);
  useEffect(() => {
    if (!isActive) {
      setWarmReady(false);
      return;
    }
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout?: number }) => number;
      cancelIdleCallback?: (h: number) => void;
    };
    let idle: number | null = null;
    let timer: number | null = null;
    const warm = () => {
      idle = null;
      timer = null;
      setWarmReady(true);
    };
    if (typeof w.requestIdleCallback === "function") {
      idle = w.requestIdleCallback(warm, { timeout: 2000 });
    } else {
      timer = window.setTimeout(warm, 150);
    }
    return () => {
      if (idle !== null) w.cancelIdleCallback?.(idle);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [isActive]);
  const warmChats = isActive && warmReady;

  // An empty column offers what it can hold.
  if (tabs.length === 0) {
    return (
      <div ref={ref} style={{ flex: "1 1 0%", minHeight: 0, overflow: "hidden" }}>
        <SurfaceLauncher
          groupId={groupId}
          focused={isActive && view.focusedGroupId === groupId}
          closable={view.groupOrder.length > 1}
        />
      </div>
    );
  }

  if (!activeTab) {
    return <div ref={ref} style={{ flex: "1 1 0%", minHeight: 0, overflow: "hidden" }} />;
  }

  // Persist expensive tabs across tab switches within this column. For a
  // BACKGROUND project we additionally drop the types that keep working while
  // hidden (see IDLE_EXPENSIVE_TYPES) — off-screen terminals/browser embeds/
  // graphs were a major source of idle heat. Chat/knowledge/settings stay
  // mounted even in background projects: unmounting chat re-ran the whole
  // transcript-load path (window fill, markdown settle, anchor) on every
  // switch back, and settings lost its form drafts.
  //
  // HOW a hidden tab is hidden matters. Most types use `display:none`. Chat
  // does not: its transcript is real DOM for the whole thread (thousands of
  // laid-out rows for a long session — see `transcript.tsx`, deliberately not
  // virtualized), and `display:none` throws that layout away. Showing the tab
  // again then rebuilt the render tree and laid out every row on the switch
  // frame: a stall proportional to thread length, while an empty chat switched
  // instantly. So a hidden chat keeps its box: `visibility:hidden` skips paint
  // but keeps layout (and the scroller's `scrollTop`), and `inert` takes the
  // subtree out of focus, hit-testing and find. Same contract the terminal
  // uses for its inactive panes. The active chat wrapper is the same absolute
  // box, so toggling a sibling's mode never relayouts the visible thread.
  // The explicit predicate is load-bearing: `Set.has` does not narrow, and
  // `PersistentPanel` below relies on `tab.type` being the `PersistentTabType`
  // union for its exhaustiveness check.
  //
  // Mounted in id order, not strip order. Dragging a tab to a new place in the
  // strip must not move its panel's DOM: React reorders keyed siblings with
  // `insertBefore`, and moving an iframe reloads it. Id order never changes
  // for the tabs already open, so a reorder touches nothing here.
  const persistentTabs = tabs
    .filter(
      (t): t is PersistentTab =>
        PERSISTENT_TYPES.has(t.type) && (isActive || !IDLE_EXPENSIVE_TYPES.has(t.type)),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const activeIsNonPersistent = !persistentTabs.find((t) => t.id === activeTab.id);

  // `@container`: the column's width is what the docked file tree and the
  // room a file leaves for it are measured against (`FILE_DOCK_WIDTH`).
  return (
    <div
      ref={ref}
      className="@container"
      style={{ flex: "1 1 0%", minHeight: 0, overflow: "hidden", position: "relative" }}
    >
      <FileDockColumn
        projectId={projectId}
        projectActive={isActive}
        tabs={tabs}
        activeTab={activeTab}
      >
        <Suspense fallback={<PanelLoading />}>
          {persistentTabs.map((tab) => {
            const isActive = tab.id === activeTab.id;
            if (tab.type === "chat") {
              // Until the column has been active for an idle slice, hidden chats
              // fall back to `display:none` (see `warmReady`).
              const hidden = !isActive;
              return (
                <div
                  key={tab.id}
                  className="absolute inset-0"
                  inert={hidden}
                  // Pauses the session's working shimmers while it is hidden
                  // (`src/lib/visible-animation.ts`): `visibility:hidden` does
                  // not stop CSS animations the way `display:none` does.
                  data-atlas-offstage={hidden || undefined}
                  style={{
                    display: hidden && !warmChats ? "none" : undefined,
                    visibility: hidden ? "hidden" : "visible",
                    // `visibility` alone is not enough. Anything inside that
                    // WebKit has promoted to its own compositing layer keeps
                    // painting for ~100ms after the ancestor is hidden, and this
                    // wrapper is positioned, so those leftovers land ON TOP of
                    // the tab you just switched to. Ancestor opacity is applied
                    // when the layer is composited, so a stale layer cannot
                    // survive it. Free: opacity is not a layout or paint input.
                    opacity: hidden ? 0 : 1,
                    pointerEvents: hidden ? "none" : "auto",
                    zIndex: hidden ? 0 : 1,
                    contain: "layout style",
                  }}
                >
                  <ChatPanel tabId={tab.id} />
                </div>
              );
            }
            if (tab.type === "terminal") {
              // The chat's contract (above), minus the warm-up: a hidden terminal
              // keeps its box. Under `display:none` WebKit dropped the render
              // tree of every block and line, and showing the tab rebuilt all of
              // it on the switch frame — the near-freeze when switching to a
              // terminal that had been busy. Its sessions stop rendering while
              // hidden anyway (`useIsTabVisible`), so the kept box costs nothing
              // per frame.
              const hidden = !isActive;
              return (
                <div
                  key={tab.id}
                  className="absolute inset-0"
                  inert={hidden}
                  style={{
                    visibility: hidden ? "hidden" : "visible",
                    opacity: hidden ? 0 : 1,
                    pointerEvents: hidden ? "none" : "auto",
                    zIndex: hidden ? 0 : 1,
                    contain: "layout style",
                  }}
                >
                  <PersistentPanel tab={tab} projectId={projectId} height={height} />
                </div>
              );
            }
            return (
              <div key={tab.id} style={{ display: isActive ? "contents" : "none" }}>
                <PersistentPanel tab={tab} projectId={projectId} height={height} />
              </div>
            );
          })}

          {/* Keyed by tab id: two tabs of one type (two drafts, two diffs) sit in
            the same slot here, and without a key React reuses the first tab's
            component — and its state — for the second. Two draft tabs shared
            one Y.Doc that way and wrote each other's content. */}
          {activeIsNonPersistent && (
            <TabContent key={activeTab.id} tab={activeTab} projectId={projectId} />
          )}
        </Suspense>
      </FileDockColumn>
    </div>
  );
});

/**
 * Mounts one persistent tab's panel.
 *
 * A `switch` with a `never` default, NOT an if/else-if chain with a catch-all.
 * The chain this replaced ended in an unconditional `<TerminalPanel/>`, and
 * because `tab.type` was the full `TabType` union in every arm, a persistent
 * type with no branch of its own type-checked perfectly and quietly rendered a
 * terminal — spawning a real PTY keyed to that tab's id. That shipped: a Space
 * tab mounted PowerShell in alpha-0.3.2. Here `tab.type` is narrowed to
 * `PersistentTabType`, so omitting a case fails `tsc` at `_exhaustive`.
 */
function PersistentPanel({
  tab,
  projectId,
  height,
}: {
  tab: PersistentTab;
  projectId: string;
  height: number;
}) {
  switch (tab.type) {
    case "editor":
      return (
        <FileTabFrame
          tabId={tab.id}
          projectId={projectId}
          filePath={tab.data.filePath as string | undefined}
          ownHeader
        >
          <EditorPanel
            tabId={tab.id}
            filePath={tab.data.filePath as string | undefined}
            containerHeight={height}
          />
        </FileTabFrame>
      );
    case "browser":
      return (
        <BrowserPanel
          tabId={tab.id}
          groupId={GROUP_OF(tab)}
          initialUrl={tab.data.url as string | undefined}
        />
      );
    case "pdf":
      return (
        <FileTabFrame tabId={tab.id} projectId={projectId} filePath={tab.data.filePath as string}>
          <PdfViewer filePath={tab.data.filePath as string} tabId={tab.id} />
        </FileTabFrame>
      );
    case "team-chat":
      return <CommsPanel />;
    // Chat is normally handled by the caller, which needs its own
    // `visibility:hidden` wrapper rather than `display:none`. Listed anyway so
    // the exhaustiveness check below is real and not a hole.
    case "chat":
      return <ChatPanel tabId={tab.id} />;
    case "terminal":
      return <TerminalPanel tabId={tab.id} projectId={projectId} />;
    default: {
      const _exhaustive: never = tab.type;
      void _exhaustive;
      return <PlaceholderContent tab={tab} />;
    }
  }
}

/**
 * The centre with NO project open. The old gate returned a bare
 * `<WelcomeScreen/>` and silently discarded the whole tab system — so an
 * `addTab("comms-draft")` from the chat panel "worked" in the store while
 * nothing could ever render it. Org-scoped surfaces (settings, prompt
 * drafts, spaces when it lands) do not need a project; this shell renders
 * exactly those, with Welcome as an un-closable Home tab, and leaves every
 * other tab untouched in the store for when a project opens.
 */
function ProjectlessCenter() {
  const tabs = useLayoutStore.use.tabs();
  const activeByGroup = useLayoutStore.use.activeByGroup();
  const focusedGroupId = useLayoutStore.use.focusedGroupId();
  const { setActiveTab } = useLayoutStore.use.actions();
  // The only column: the leftmost and the rightmost.
  const chrome = columnChrome(true, true);
  // Home is LOCAL state, not a store id: `setActiveTab` validates ids and
  // falls back to `tabs[0]` on a miss, so a sentinel id would re-activate
  // the very tab the user clicked away from.
  const [atHome, setAtHome] = useState(false);

  const allowed = tabs.filter((t) => PROJECTLESS_TYPES.has(t.type));
  const storeActive = activeByGroup[focusedGroupId] ?? null;
  const active = atHome ? null : (allowed.find((t) => t.id === storeActive) ?? null);

  return (
    <div className="flex h-full w-full flex-col bg-background">
      {/* Always there, even with only Welcome to show: it is where the
        window's own controls (traffic lights, account) sit. */}
      <PaneHeader
        leading={chrome.leading}
        breadcrumb={chrome.breadcrumb}
        trailing={chrome.trailing}
      >
        {allowed.length > 0 && (
          <div
            role="tablist"
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto hide-scrollbar"
          >
            {/* Home is a pseudo-tab, not a store tab: it cannot close and it
                is simply "no allowed tab selected". */}
            <PaneTab
              tab={HOME_TAB}
              icon={House}
              active={active === null}
              focused
              running={false}
              onSelect={() => setAtHome(true)}
            />
            {allowed.map((tab) => (
              <PaneTab
                key={tab.id}
                tab={tab}
                active={tab.id === active?.id}
                focused
                running={false}
                onSelect={() => {
                  setAtHome(false);
                  setActiveTab(tab.id);
                }}
              />
            ))}
          </div>
        )}
      </PaneHeader>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={<PanelLoading />}>
          {active ? <TabContent key={active.id} tab={active} /> : <WelcomeScreen />}
        </Suspense>
      </div>
    </div>
  );
}

/** The projectless strip's Home pseudo-tab. Typed as a chat tab only so it
 *  can borrow `PaneTab`, which is handed the House icon alongside it. */
const HOME_TAB: Tab = {
  id: "__home",
  type: "chat",
  title: "Home",
  closable: false,
  dirty: false,
  data: {},
};

function PanelLoading() {
  // Structural skeleton (not centered text) so the first open of a lazy panel
  // while its JS chunk downloads reads as "loading content" rather than blank.
  return <PanelSkeleton rows={7} />;
}

function TabContent({ tab, projectId = null }: { tab: Tab; projectId?: string | null }) {
  // A file tab sits in its frame: the header band, and room for the column's
  // docked project tree (`file-tab-frame.tsx`, `file-dock.tsx`).
  const framed = (content: React.ReactNode) => (
    <FileTabFrame
      tabId={tab.id}
      projectId={projectId}
      filePath={tab.data.filePath as string | undefined}
    >
      {content}
    </FileTabFrame>
  );
  switch (tab.type) {
    case "chat":
      return <ChatPanel tabId={tab.id} />;
    case "browser":
      return <BrowserPanel initialUrl={tab.data.url as string | undefined} />;
    case "log":
      return <LogPanel />;
    case "source-control":
      return <SourceControlPanel />;
    case "files":
      return <FilesPanel projectId={projectId} />;
    case "media":
      return framed(<MediaViewer filePath={tab.data.filePath as string} />);
    case "svg":
      return framed(<SvgViewer filePath={tab.data.filePath as string} />);
    case "pdf":
      return framed(<PdfViewer filePath={tab.data.filePath as string} tabId={tab.id} />);
    case "notebook":
      return framed(<NotebookViewer filePath={tab.data.filePath as string} />);
    case "diff":
      return <ReviewPanel tabId={tab.id} repoPath={tab.data.repoPath as string} />;
    case "commit":
      return <CommitView repoPath={tab.data.repoPath as string} sha={tab.data.sha as string} />;
    case "pull-request": {
      const pr = readPullRequestTabData(tab.data);
      return pr ? (
        <PullRequestPanel tabId={tab.id} repoPath={pr.repoPath} number={pr.number} />
      ) : (
        <PlaceholderContent tab={tab} />
      );
    }
    case "pull-requests": {
      const list = readPullRequestListTabData(tab.data);
      return list ? (
        <PullRequestListPanel repoPath={list.repoPath} />
      ) : (
        <PlaceholderContent tab={tab} />
      );
    }
    case "session-pull-requests": {
      const session = readSessionPullRequestsTabData(tab.data);
      return session ? (
        <SessionPullRequestsPanel tabId={tab.id} threadId={session.threadId} cwd={session.cwd} />
      ) : (
        <PlaceholderContent tab={tab} />
      );
    }
    case "session-changes":
      return (
        <ReviewPanel
          tabId={tab.id}
          repoPath={tab.data.projectPath as string}
          sessionId={tab.data.sessionId as string}
        />
      );
    case "comms-draft":
      return (
        <CommsDraftTab convId={tab.data.convId as string} draftId={tab.data.draftId as string} />
      );
    case "unsupported":
      return framed(<UnsupportedView filePath={tab.data.filePath as string} />);
    default:
      return <PlaceholderContent tab={tab} />;
  }
}

function PlaceholderContent({ tab }: { tab: Tab }) {
  const Icon = tabIcons[tab.type as TabType] ?? MessageSquare;
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="w-12 h-12 rounded-xl bg-card border border-border flex items-center justify-center mx-auto">
          <Icon size={24} className="text-muted-foreground" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">{tab.title}</p>
          <p className="text-xs text-muted-foreground mt-1">Coming soon</p>
        </div>
      </div>
    </div>
  );
}

/**
 * The surfaces pane's `+`: a menu of the surfaces for this column, each with
 * its letter, which also picks it while the menu is open. `⌘T` opens it once
 * the pane exists (see `tabs.openSurface` in App.tsx).
 */
function SurfaceAdd({ groupId }: { groupId: string }) {
  const hint = useActionShortcut("tabs.openSurface")?.label;
  const label = hint ? `Open a surface (${hint})` : "Open a surface";
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<{ groupId?: string }>).detail?.groupId === groupId) setOpen(true);
    };
    window.addEventListener(OPEN_SURFACE_MENU_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SURFACE_MENU_EVENT, onOpen);
  }, [groupId]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <HintItem label={label}>
        <DropdownMenuTrigger
          render={<IconButton icon={Plus} label="Open a surface" size="sm" iconSize="md" />}
        />
      </HintItem>
      {/* Opens under the `+` with their left edges in line —
          the menu grows out of the button it came from, toward the pane. */}
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        className="min-w-48"
        // Letters pick, before the menu's own typeahead sees them.
        onKeyDownCapture={(e) => {
          const surface = surfaceForKey(e);
          if (!surface) return;
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          openSurface(surface, groupId);
        }}
      >
        {SURFACES.map((surface) => (
          <DropdownMenuItem key={surface.type} onClick={() => openSurface(surface, groupId)}>
            <surface.icon size={14} />
            {surface.label}
            <DropdownMenuShortcut>{surface.key}</DropdownMenuShortcut>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** True while focus is somewhere typing belongs — a letter there is text. */
function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const html = el as HTMLElement;
  return (
    html.isContentEditable ||
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT"
  );
}

/**
 * An empty column: the "Open a surface" launcher. Each row's letter
 * picks it from anywhere while this column is focused and nothing that takes
 * typing has focus — no ⌘ needed. Esc closes the pane, so a stray ⌘T is one
 * key to undo.
 */
function SurfaceLauncher({
  groupId,
  focused,
  closable,
}: {
  groupId: string;
  focused: boolean;
  closable: boolean;
}) {
  // Take focus when the launcher opens in the focused column. `⌘T` is
  // pressed from wherever you were — usually the chat composer — and without
  // this the letter that follows would be typed into it.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) rootRef.current?.focus({ preventScroll: true });
  }, [focused]);

  useEffect(() => {
    if (!focused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(deepActiveElement())) return;
      // A dialog or menu owns the keyboard while it is up, and so does the
      // Settings screen, which covers the workspace without being a dialog.
      if (document.querySelector("[role='dialog'], [role='menu']")) return;
      if (useSettingsNav.getState().open) return;
      if (e.key === "Escape" && closable) {
        e.preventDefault();
        useLayoutStore.getState().actions.closeGroup(groupId);
        return;
      }
      const surface = surfaceForKey(e);
      if (!surface) return;
      e.preventDefault();
      openSurface(surface, groupId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focused, closable, groupId]);

  return (
    // Lifted by the bar's height so it sits at the optical centre of the
    // window rather than the column's.
    <div
      ref={rootRef}
      tabIndex={-1}
      className="flex h-full items-center justify-center pb-(--titlebar-height) outline-none"
    >
      <div className="w-full max-w-xs px-4">
        <p className="mb-3 text-center text-sm font-medium text-foreground">Open a surface</p>
        <div className="flex flex-col gap-0.5">
          {SURFACES.map((surface) => (
            <button
              key={surface.type}
              onClick={() => openSurface(surface, groupId)}
              className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-secondary-foreground transition-colors hover:bg-element-hover hover:text-foreground"
            >
              <surface.icon size={16} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{surface.label}</span>
              <Kbd>{surface.key}</Kbd>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

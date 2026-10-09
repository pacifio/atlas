import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  memo,
  lazy,
  Suspense,
  Fragment,
} from "react";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { useNavigationHint } from "@/features/keybindings/lib/use-navigation-hint";
import {
  splitNavigationActions,
  tabNavigationActions,
} from "@/features/keybindings/lib/navigation-hints";
import { cn } from "@/lib/utils";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { requestCloseTab } from "@/features/chat/lib/close-tab";
import { Menu as DropdownMenu } from "@base-ui/react/menu";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { useLayoutStore, navigationTabs, type Tab, type ProjectView } from "../stores/layout-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { FileIcon, type FallbackIcon } from "@/features/icon-theme/components/file-icon";
// Chat is the default landing surface — always loaded so the first paint
// shows the agent UI without a Suspense flash.
import { ChatPanel } from "@/features/chat/components/chat-panel";
import { WelcomeScreen } from "@/features/app/components/welcome-screen";
import { UnsupportedView } from "@/features/unsupported/components/unsupported-view";

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
const SpacesTab = lazy(() =>
  import("@/features/spaces/components/spaces-tab").then((m) => ({ default: m.SpacesTab })),
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
const GitDiffPanel = lazy(() =>
  import("@/features/git/components/git-diff-panel").then((m) => ({ default: m.GitDiffPanel })),
);
const KnowledgePanel = lazy(() =>
  import("@/features/knowledge/components/knowledge-panel").then((m) => ({
    default: m.KnowledgePanel,
  })),
);
const KnowledgeGraph = lazy(() =>
  import("@/features/knowledge/components/knowledge-graph").then((m) => ({
    default: m.KnowledgeGraph,
  })),
);
const SettingsPanel = lazy(() =>
  import("@/features/settings/components/settings-panel").then((m) => ({
    default: m.SettingsPanel,
  })),
);
const LogPanel = lazy(() =>
  import("@/features/log/components/log-panel").then((m) => ({ default: m.LogPanel })),
);
const UsagePanel = lazy(() =>
  import("@/features/usage/components/usage-panel").then((m) => ({ default: m.UsagePanel })),
);
const ArtifactsPanel = lazy(() =>
  import("@/features/artifacts/components/artifacts-panel").then((m) => ({
    default: m.ArtifactsPanel,
  })),
);
const CanvasPanel = lazy(() =>
  import("@/features/canvas/components/canvas-panel").then((m) => ({ default: m.CanvasPanel })),
);
const MemoryPanel = lazy(() =>
  import("@/features/memory/components/memory-panel").then((m) => ({ default: m.MemoryPanel })),
);
import { useAppStore } from "@/features/app/stores/app-store";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { AtlasIcon } from "@/components/atlas-icon";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useShallow } from "zustand/react/shallow";
import {
  MessageSquare,
  Map,
  Globe,
  Loader2,
  Code,
  Brain,
  BrainCircuit,
  Network,
  Terminal,
  GitCompare,
  GitCommitHorizontal,
  Settings,
  Plus,
  X,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  ScrollText,
  FileText,
  Columns2,
  House,
  Gauge,
  Layers,
  Frame,
  NotebookText,
} from "lucide-react";
import type { TabType } from "@/lib/constants";

// Typed as the icon-theme fallback rather than `React.ElementType`: these are
// what a tab falls back to when the icon theme has nothing for it, and
// `ElementType` also admits raw tag names, which a fallback cannot be.
const tabIcons: Record<TabType, FallbackIcon> = {
  chat: AtlasIcon,
  canvas: Map,
  browser: Globe,
  tasks: CheckSquare,
  editor: Code,
  knowledge: Brain,
  "knowledge-graph": Network,
  memory: BrainCircuit,
  terminal: Terminal,
  diff: GitCompare,
  commit: GitCommitHorizontal,
  settings: Settings,
  log: ScrollText,
  media: Code,
  svg: Code,
  pdf: FileText,
  notebook: NotebookText,
  unsupported: Code,
  usage: Gauge,
  artifacts: Layers,
  "comms-draft": FileText,
  spaces: Frame,
};

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
  "knowledge-graph",
  "pdf",
  // Keep chat + knowledge mounted across tab switches too: chat keeps its
  // mounted transcript window + scroll position (remounting re-ran the
  // "loading transcript" path and rebuilt scroll), and knowledge avoids
  // re-walking its tree/graph on every revisit.
  "chat",
  "knowledge",
  // Keep settings mounted so its open section + sub-tab + form drafts survive a
  // tab switch (it's a singleton tab; remounting reset all its local useState).
  "settings",
  // A Space is a live socket + a Y.Doc: remounting re-dials, replays the page
  // and lands re-fitted. Kept mounted so a tab switch is a tab switch.
  "spaces",
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
  "knowledge-graph",
  "pdf",
  "spaces",
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
  const solo = view.groupOrder.length === 1;
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
            <Separator className="w-px bg-border hover:bg-primary data-[separator=active]:bg-primary transition-colors cursor-col-resize" />
          )}
          {/* Sizes are percentages: v4 reads bare numbers as PIXELS and
              unit-less strings as percentages. `order` is gone — panels are
              ordered by DOM position — but `id` still keys the saved layout. */}
          <Panel id={gid} minSize="20" className="min-w-0">
            <TabColumn
              groupId={gid}
              view={view}
              isActive={isActive}
              runningTabIds={runningTabIds}
              soloColumn={solo}
              projectId={projectId}
            />
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
});

const TabColumn = memo(function TabColumn({
  groupId,
  view,
  isActive,
  runningTabIds,
  soloColumn,
  projectId,
}: {
  groupId: string;
  view: ProjectView;
  isActive: boolean;
  runningTabIds: Set<string>;
  soloColumn?: boolean;
  projectId: string;
}) {
  const splitNewHint = useActionShortcut("split.new")?.label;
  const navigationHint = useNavigationHint();
  const splitCloseHint = useActionShortcut("split.close")?.label;
  const tabBarVisible = useLayoutStore.use.tabBarVisible();
  const {
    setActiveTab,
    addTab,
    navigateTabBack,
    navigateTabForward,
    setFocusedGroup,
    addGroup,
    closeGroup,
  } = useLayoutStore.use.actions();

  const tabsAll = view.tabs;
  const tabHistory = view.tabHistory;
  const tabHistoryIndex = view.tabHistoryIndex;
  const tabs = useMemo(() => tabsAll.filter((t) => GROUP_OF(t) === groupId), [tabsAll, groupId]);
  const activeId = view.activeByGroup[groupId] ?? null;
  const isFocused = isActive && view.focusedGroupId === groupId;
  const activeIndex = tabs.findIndex((t) => t.id === activeId);
  const canSplit = view.groupOrder.length < 3;
  const canCloseGroup = view.groupOrder.length > 1;

  // Back/forward operate on the (global) tab history.
  const canGoBack = useMemo(() => {
    for (let i = tabHistoryIndex - 1; i >= 0; i--)
      if (tabsAll.find((t) => t.id === tabHistory[i])) return true;
    return false;
  }, [tabHistory, tabHistoryIndex, tabsAll]);
  const canGoForward = useMemo(() => {
    for (let i = tabHistoryIndex + 1; i < tabHistory.length; i++)
      if (tabsAll.find((t) => t.id === tabHistory[i])) return true;
    return false;
  }, [tabHistory, tabHistoryIndex, tabsAll]);

  return (
    <div
      role="group"
      aria-label={`Pane ${view.groupOrder.indexOf(groupId) + 1}`}
      {...navigationHint(
        isActive ? splitNavigationActions(groupId, view.groupOrder, view.focusedGroupId) : [],
      )}
      className={cn("h-full flex flex-col overflow-hidden bg-background")}
      onMouseDownCapture={() => setFocusedGroup(groupId)}
    >
      {tabBarVisible && (
        <div
          className={cn(
            "flex items-stretch h-[29px] shrink-0 bg-background border-b border-border transition-opacity",
            // When split, dim the UNFOCUSED columns' tab bars so the focused
            // one stands out (the focused pane also shows a white dot, below).
            !soloColumn && !isFocused && "opacity-45",
          )}
        >
          <HintGroup>
            <div className="flex items-center justify-center gap-0.5 w-[44px] border-r border-border shrink-0">
              <HintItem label="Back">
                <button
                  onClick={navigateTabBack}
                  disabled={!canGoBack}
                  className={cn(
                    "flex items-center justify-center w-6 h-6 rounded transition-colors outline-none",
                    canGoBack
                      ? "text-secondary-foreground hover:text-foreground hover:bg-element-hover cursor-pointer"
                      : "text-muted-foreground/40 cursor-not-allowed",
                  )}
                >
                  <ChevronLeft size={13} />
                </button>
              </HintItem>
              <HintItem label="Forward">
                <button
                  onClick={navigateTabForward}
                  disabled={!canGoForward}
                  className={cn(
                    "flex items-center justify-center w-6 h-6 rounded transition-colors outline-none",
                    canGoForward
                      ? "text-secondary-foreground hover:text-foreground hover:bg-element-hover cursor-pointer"
                      : "text-muted-foreground/40 cursor-not-allowed",
                  )}
                >
                  <ChevronRight size={13} />
                </button>
              </HintItem>
            </div>
          </HintGroup>

          <div className="flex items-stretch min-w-0 flex-1 overflow-x-auto hide-scrollbar">
            {tabs.map((tab, index) => {
              const Icon = tabIcons[tab.type as TabType] ?? MessageSquare;
              // A tab opened from a path carries it in `data.filePath`, so the
              // strip shows the same icon the tree row it came from does.
              const tabFilePath = typeof tab.data?.filePath === "string" ? tab.data.filePath : null;
              const isActive = tab.id === activeId;
              const isRunning = runningTabIds.has(tab.id);
              return (
                <div
                  key={tab.id}
                  role="tab"
                  tabIndex={0}
                  {...navigationHint(
                    isFocused ? tabNavigationActions(index, tabs.length, activeIndex) : [],
                  )}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") setActiveTab(tab.id);
                  }}
                  className={cn(
                    "atlas-tab group relative flex items-center gap-1.5 px-4 h-full text-sm font-medium shrink-0 cursor-pointer select-none border-r border-border",
                    "transition-[background-color,color] duration-150",
                    isActive
                      ? "text-foreground bg-background"
                      : "text-muted-foreground bg-background hover:text-secondary-foreground hover:bg-element-hover",
                  )}
                >
                  {isRunning ? (
                    <Loader2 size={12} className="animate-spin text-primary shrink-0" />
                  ) : tabFilePath ? (
                    <FileIcon path={tabFilePath} size={12} fallback={Icon} />
                  ) : (
                    <Icon
                      size={12}
                      className={cn(
                        "shrink-0",
                        isActive ? "text-secondary-foreground" : "text-muted-foreground",
                      )}
                    />
                  )}
                  <span
                    className={cn(
                      "truncate max-w-[140px] leading-normal",
                      tab.dirty && "italic",
                      // Fades out from under the close button on hover — see
                      // `.atlas-tab-label` in globals.css.
                      tab.closable && "atlas-tab-label",
                    )}
                  >
                    {tab.title}
                  </span>
                  {tab.closable && (
                    // No tooltip. An × on the tab you are hovering is not
                    // ambiguous, and a panel opening under the pointer to say
                    // "Close tab" is noise on the one control every user
                    // already knows. `aria-label` still names it, since the
                    // button's only content is an icon.
                    <button
                      aria-label="Close tab"
                      onClick={(e) => {
                        e.stopPropagation();
                        requestCloseTab(tab.id);
                      }}
                      className={cn(
                        "absolute right-1.5 top-1/2 -translate-y-1/2",
                        "inline-flex items-center justify-center w-4 h-4 rounded-full",
                        "text-muted-foreground opacity-0 scale-90 group-hover:opacity-100 group-hover:scale-100 focus-visible:opacity-100 focus-visible:scale-100",
                        "hover:bg-element-hover hover:text-foreground transition-[opacity,transform] duration-150",
                      )}
                    >
                      <X size={10} strokeWidth={2.2} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* `pr-1.5` on the group, not on the last button: the trailing gap
              used to live on whichever action happened to be rightmost, so it
              was 2px behind "Split right" in a single pane and 4px behind
              "Close split" in a split one — the button sat almost flush with
              the window edge in the common case. */}
          <HintGroup>
            <div className="relative flex shrink-0 items-center pr-1.5">
              <div
                aria-hidden
                className="pointer-events-none absolute right-full top-0 h-full w-8"
                style={{ background: "linear-gradient(to right, transparent, var(--background))" }}
              />
              {/* Selected-pane indicator: a white dot before the +/x actions. */}
              {!soloColumn && isFocused && (
                <span
                  aria-hidden
                  title="Active pane"
                  className="self-center shrink-0 mx-1 h-1.5 w-1.5 rounded-full bg-[var(--primary)]"
                />
              )}
              <NewTabDropdown addTab={addTab} groupId={groupId} />
              {canSplit && (
                <HintItem label={splitNewHint ? `Split right (${splitNewHint})` : "Split right"}>
                  <button
                    onClick={addGroup}
                    className="self-center flex items-center justify-center w-6 h-6 text-muted-foreground hover:text-secondary-foreground hover:bg-element-hover rounded transition-colors shrink-0 cursor-pointer outline-none"
                  >
                    <Columns2 size={13} />
                  </button>
                </HintItem>
              )}
              {canCloseGroup && (
                <HintItem
                  label={splitCloseHint ? `Close split (${splitCloseHint})` : "Close split"}
                >
                  <button
                    onClick={() => closeGroup(groupId)}
                    className="self-center flex items-center justify-center w-6 h-6 text-muted-foreground hover:text-secondary-foreground hover:bg-element-hover rounded transition-colors shrink-0 cursor-pointer outline-none"
                  >
                    <X size={13} />
                  </button>
                </HintItem>
              )}
            </div>
          </HintGroup>
        </div>
      )}

      <TabContentContainer
        groupId={groupId}
        view={view}
        isActive={isActive}
        projectId={projectId}
      />
    </div>
  );
});

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
  const newTabHint = useActionShortcut("nav.newTabPalette")?.label;
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

  // Empty split column — invite the user to open something.
  if (tabs.length === 0) {
    return (
      <div
        ref={ref}
        style={{ flex: "1 1 0%", minHeight: 0, overflow: "hidden" }}
        className="flex items-center justify-center text-sm text-muted-foreground"
      >
        Empty split — open a tab with +{newTabHint ? ` or ${newTabHint}` : ""}
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
  const persistentTabs = tabs.filter(
    (t): t is PersistentTab =>
      PERSISTENT_TYPES.has(t.type) && (isActive || !IDLE_EXPENSIVE_TYPES.has(t.type)),
  );
  const activeIsNonPersistent = !persistentTabs.find((t) => t.id === activeTab.id);

  return (
    <div
      ref={ref}
      style={{ flex: "1 1 0%", minHeight: 0, overflow: "hidden", position: "relative" }}
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
        {activeIsNonPersistent && <TabContent key={activeTab.id} tab={activeTab} />}
      </Suspense>
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
        <EditorPanel
          tabId={tab.id}
          filePath={tab.data.filePath as string | undefined}
          containerHeight={height}
        />
      );
    case "knowledge":
      return <KnowledgePanel tabId={tab.id} />;
    case "browser":
      return (
        <BrowserPanel
          tabId={tab.id}
          groupId={GROUP_OF(tab)}
          initialUrl={tab.data.url as string | undefined}
        />
      );
    case "knowledge-graph":
      return <KnowledgeGraph />;
    case "pdf":
      return <PdfViewer filePath={tab.data.filePath as string} tabId={tab.id} />;
    case "settings":
      return <SettingsPanel initialSection={tab.data.section as string | undefined} />;
    case "spaces":
      return <SpacesTab convId={tab.data.convId as string} />;
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
  const navigationHint = useNavigationHint();
  const tabs = useLayoutStore.use.tabs();
  const activeByGroup = useLayoutStore.use.activeByGroup();
  const focusedGroupId = useLayoutStore.use.focusedGroupId();
  const { setActiveTab, closeTab } = useLayoutStore.use.actions();
  // Home is LOCAL state, not a store id: `setActiveTab` validates ids and
  // falls back to `tabs[0]` on a miss, so a sentinel id would re-activate
  // the very tab the user clicked away from.
  const [atHome, setAtHome] = useState(false);

  const allowed = navigationTabs(tabs, focusedGroupId, true);
  // Today's behaviour, exactly, until something project-independent opens.
  if (allowed.length === 0) return <WelcomeScreen />;

  const storeActive = activeByGroup[focusedGroupId] ?? null;
  const activeIndex = allowed.findIndex((t) => t.id === storeActive);
  const active = atHome ? null : (allowed.find((t) => t.id === storeActive) ?? null);

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-background">
        {/* Home is a pseudo-tab, not a store tab: it cannot close and it is
            simply "no allowed tab selected". */}
        <div
          role="tab"
          tabIndex={0}
          onClick={() => setAtHome(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") setAtHome(true);
          }}
          className={cn(
            "flex items-center gap-1.5 border-r border-border px-3 text-sm font-medium cursor-pointer select-none",
            active === null
              ? "bg-background text-foreground"
              : "bg-background text-muted-foreground hover:bg-element-hover hover:text-secondary-foreground",
          )}
        >
          <House size={12} className="shrink-0" />
          <span className="leading-none">Home</span>
        </div>

        {allowed.map((tab, index) => {
          const Icon = tabIcons[tab.type] ?? MessageSquare;
          const tabFilePath = typeof tab.data?.filePath === "string" ? tab.data.filePath : null;
          const isActive = tab.id === active?.id;
          return (
            <div
              key={tab.id}
              role="tab"
              tabIndex={0}
              {...navigationHint(
                !atHome ? tabNavigationActions(index, allowed.length, activeIndex) : [],
              )}
              onClick={() => {
                setAtHome(false);
                setActiveTab(tab.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  setAtHome(false);
                  setActiveTab(tab.id);
                }
              }}
              className={cn(
                "atlas-tab group relative flex shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-border px-4 text-sm font-medium",
                "transition-[background-color,color] duration-150",
                isActive
                  ? "bg-background text-foreground"
                  : "bg-background text-muted-foreground hover:bg-element-hover hover:text-secondary-foreground",
              )}
            >
              {tabFilePath ? (
                <FileIcon path={tabFilePath} size={12} fallback={Icon} />
              ) : (
                <Icon
                  size={12}
                  className={cn(
                    "shrink-0",
                    isActive ? "text-secondary-foreground" : "text-muted-foreground",
                  )}
                />
              )}
              <span
                className={cn(
                  "max-w-[140px] truncate leading-normal",
                  tab.closable && "atlas-tab-label",
                )}
              >
                {tab.title}
              </span>
              {tab.closable && (
                // No tooltip — see the note on the primary tab strip's close
                // button above.
                <button
                  aria-label="Close tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  className={cn(
                    "absolute right-1.5 top-1/2 -translate-y-1/2",
                    "inline-flex h-4 w-4 items-center justify-center rounded-full",
                    "text-muted-foreground opacity-0 scale-90 group-hover:opacity-100 group-hover:scale-100 focus-visible:opacity-100 focus-visible:scale-100",
                    "transition-[opacity,transform] duration-150 hover:bg-element-hover hover:text-foreground",
                  )}
                >
                  <X size={10} strokeWidth={2.2} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={<PanelLoading />}>
          {active ? <TabContent key={active.id} tab={active} /> : <WelcomeScreen />}
        </Suspense>
      </div>
    </div>
  );
}

function PanelLoading() {
  // Structural skeleton (not centered text) so the first open of a lazy panel
  // while its JS chunk downloads reads as "loading content" rather than blank.
  return <PanelSkeleton rows={7} />;
}

function TabContent({ tab }: { tab: Tab }) {
  switch (tab.type) {
    case "chat":
      return <ChatPanel tabId={tab.id} />;
    case "canvas":
      return <CanvasPanel />;
    case "knowledge":
      return <KnowledgePanel tabId={tab.id} />;
    case "knowledge-graph":
      return <KnowledgeGraph />;
    case "memory":
      return <MemoryPanel />;
    case "browser":
      return <BrowserPanel initialUrl={tab.data.url as string | undefined} />;
    case "settings":
      return <SettingsPanel initialSection={tab.data.section as string | undefined} />;
    case "log":
      return <LogPanel />;
    case "usage":
      return <UsagePanel />;
    case "artifacts":
      return <ArtifactsPanel />;
    case "media":
      return <MediaViewer filePath={tab.data.filePath as string} />;
    case "svg":
      return <SvgViewer filePath={tab.data.filePath as string} />;
    case "pdf":
      return <PdfViewer filePath={tab.data.filePath as string} tabId={tab.id} />;
    case "notebook":
      return <NotebookViewer filePath={tab.data.filePath as string} />;
    case "diff":
      return (
        <GitDiffPanel
          repoPath={tab.data.repoPath as string}
          file={tab.data.file as string}
          staged={!!tab.data.staged}
          commit={(tab.data.commit as string | null | undefined) ?? null}
        />
      );
    case "commit":
      return <CommitView repoPath={tab.data.repoPath as string} sha={tab.data.sha as string} />;
    case "comms-draft":
      return (
        <CommsDraftTab convId={tab.data.convId as string} draftId={tab.data.draftId as string} />
      );
    case "spaces":
      return <SpacesTab convId={tab.data.convId as string} />;
    case "unsupported":
      return <UnsupportedView filePath={tab.data.filePath as string} />;
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

const NEW_TAB_OPTIONS: Array<{ type: TabType; label: string; icon: React.ElementType }> = [
  { type: "chat", label: "Agents", icon: AtlasIcon },
  { type: "canvas", label: "Spaces", icon: Map },
  { type: "terminal", label: "Terminal", icon: Terminal },
  { type: "browser", label: "Browser", icon: Globe },
  { type: "knowledge", label: "Knowledge", icon: Brain },
  { type: "memory", label: "Memory", icon: BrainCircuit },
  { type: "log", label: "Log", icon: ScrollText },
];

function NewTabDropdown({
  addTab,
  groupId,
}: {
  addTab: (tab: Tab, groupId?: string) => void;
  groupId: string;
}) {
  const handleAdd = useCallback(
    (type: TabType, label: string) => {
      addTab(
        {
          id: `${type}-${Date.now()}`,
          type,
          title: label,
          closable: true,
          dirty: false,
          data: {},
        },
        groupId,
      );
    },
    [addTab, groupId],
  );

  return (
    <DropdownMenu.Root>
      <HintItem label="New tab">
        <DropdownMenu.Trigger
          render={
            <button className="self-center flex items-center justify-center w-6 h-6 text-muted-foreground hover:text-secondary-foreground hover:bg-element-hover rounded transition-colors shrink-0 mx-1 cursor-pointer outline-none focus:outline-none focus-visible:outline-none ring-0 focus:ring-0">
              <Plus size={14} />
            </button>
          }
        />
      </HintItem>
      <DropdownMenu.Portal>
        <DropdownMenu.Positioner className="z-popover" align="start" sideOffset={4}>
          <DropdownMenu.Popup className="w-[160px] rounded-lg border border-border bg-card shadow-lg py-1">
            {NEW_TAB_OPTIONS.map(({ type, label, icon: Icon }) => (
              <DropdownMenu.Item
                key={type}
                onClick={() => handleAdd(type, label)}
                className="flex items-center gap-2 px-3 h-[30px] text-xs text-secondary-foreground hover:bg-element-hover hover:text-foreground cursor-default outline-none"
              >
                <Icon size={12} className="text-muted-foreground" />
                {label}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Popup>
        </DropdownMenu.Positioner>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

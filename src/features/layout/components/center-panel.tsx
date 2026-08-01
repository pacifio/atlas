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
import { cn } from "@/lib/utils";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  useLayoutStore,
  type Tab,
  type WorkspaceView,
} from "../stores/layout-store";
import { useWorkspaceStore } from "@/features/workspaces/stores/workspace-store";
// Chat is the default landing surface — always loaded so the first paint
// shows the agent UI without a Suspense flash.
import { ChatPanel } from "@/features/chat/components/chat-panel";
import { WelcomeScreen } from "@/features/project/components/welcome-screen";
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
  import("@/features/editor/components/editor-panel").then((m) => ({
    default: m.EditorPanel,
  })),
);
const BrowserPanel = lazy(() =>
  import("@/features/browser/components/browser-panel").then((m) => ({
    default: m.BrowserPanel,
  })),
);
const MediaViewer = lazy(() =>
  import("@/features/media/components/media-viewer").then((m) => ({
    default: m.MediaViewer,
  })),
);
const SvgViewer = lazy(() =>
  import("@/features/svg/components/svg-viewer").then((m) => ({
    default: m.SvgViewer,
  })),
);
const PdfViewer = lazy(() =>
  import("@/features/pdf/components/pdf-viewer").then((m) => ({
    default: m.PdfViewer,
  })),
);
const GitDiffPanel = lazy(() =>
  import("@/features/git/components/git-diff-panel").then((m) => ({
    default: m.GitDiffPanel,
  })),
);
const CanvasPanel = lazy(() =>
  import("@/features/canvas/components/canvas-panel").then((m) => ({
    default: m.CanvasPanel,
  })),
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
const ResearchPanel = lazy(() =>
  import("@/features/research/components/research-panel").then((m) => ({
    default: m.ResearchPanel,
  })),
);
const SettingsPanel = lazy(() =>
  import("@/features/settings/components/settings-panel").then((m) => ({
    default: m.SettingsPanel,
  })),
);
const LogPanel = lazy(() =>
  import("@/features/log/components/log-panel").then((m) => ({
    default: m.LogPanel,
  })),
);
const PomodoroPanel = lazy(() =>
  import("@/features/pomodoro/components/pomodoro-panel").then((m) => ({
    default: m.PomodoroPanel,
  })),
);
const MissionControlPanel = lazy(() =>
  import("@/features/mission-control/components/mission-control-panel").then(
    (m) => ({ default: m.MissionControlPanel }),
  ),
);
const ArtifactsPanel = lazy(() =>
  import("@/features/artifacts/components/artifacts-panel").then((m) => ({
    default: m.ArtifactsPanel,
  })),
);
const ModelChatPanel = lazy(() =>
  import("@/features/model-chat/components/model-chat-panel").then((m) => ({
    default: m.ModelChatPanel,
  })),
);
const MemoryPanel = lazy(() =>
  import("@/features/memory/components/memory-panel").then((m) => ({
    default: m.MemoryPanel,
  })),
);
import { useProjectStore } from "@/features/project/stores/project-store";
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
  BookOpen,
  Brain,
  BrainCircuit,
  Network,
  Terminal,
  GitCompare,
  Settings,
  Plus,
  X,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  ScrollText,
  Timer,
  FileText,
  Columns2,
  LayoutDashboard,
  Layers,
} from "lucide-react";
import type { TabType } from "@/lib/constants";

const tabIcons: Record<TabType, React.ElementType> = {
  chat: AtlasIcon,
  "model-chat": MessageSquare,
  canvas: Map,
  browser: Globe,
  tasks: CheckSquare,
  editor: Code,
  research: BookOpen,
  knowledge: Brain,
  "knowledge-graph": Network,
  memory: BrainCircuit,
  terminal: Terminal,
  diff: GitCompare,
  settings: Settings,
  log: ScrollText,
  media: Code,
  svg: Code,
  pdf: FileText,
  unsupported: Code,
  pomodoro: Timer,
  "mission-control": LayoutDashboard,
  artifacts: Layers,
};

const GROUP_OF = (t: Tab) => t.groupId ?? "main";
const PERSISTENT_TYPES: ReadonlySet<TabType> = new Set([
  "editor",
  "terminal",
  "browser",
  "knowledge-graph",
  "pdf",
  // Keep chat + knowledge mounted across tab switches too: chat preserves the
  // virtualizer's measurement cache + scroll position (remounting re-ran the
  // "loading transcript" path and rebuilt scroll), and knowledge avoids
  // re-walking its tree/graph on every revisit.
  "chat",
  "knowledge",
  // Keep settings mounted so its open section + sub-tab + form drafts survive a
  // tab switch (it's a singleton tab; remounting reset all its local useState).
  "settings",
]);

// Of the persistent types, these are the ones that keep BURNING CPU/GPU while
// hidden — a PTY draining output, a live web embed, a Pixi/WebGL graph ticking,
// a PDF worker. Those get unmounted for background workspaces (idle heat is the
// bigger cost than their rebuild). The rest are inert-but-expensive-to-rebuild
// (chat's virtualizer + transcript load, knowledge's tree walk, settings' form
// drafts) and stay mounted everywhere: hiding them saves nothing per frame and
// costs a full remount on switch-back.
const IDLE_EXPENSIVE_TYPES: ReadonlySet<TabType> = new Set([
  "terminal",
  "browser",
  "knowledge-graph",
  "pdf",
]);

/**
 * The center panel is one or more side-by-side **split columns**
 * (`layout-store.groupOrder`, max 3, resizable). Each column hosts an
 * independent tab strip + content area; a given tab lives in exactly one
 * column. The single-column case is the normal IDE.
 */
export function CenterPanel() {
  const currentProject = useProjectStore.use.currentProject();
  // Render ONLY the bounded HOT set, not the full project registry — keeps
  // memory/DOM bounded at 100+ projects (Chrome tab-discard model). Resolve ids
  // to workspaces, preserving registry order for stable React keys.
  const workspacesAll = useWorkspaceStore.use.workspaces();
  const mountedWorkspaceIds = useWorkspaceStore.use.mountedWorkspaceIds();
  const workspaces = useMemo(() => {
    const mounted = new Set(mountedWorkspaceIds);
    return workspacesAll.filter((w) => mounted.has(w.id));
  }, [workspacesAll, mountedWorkspaceIds]);
  const activeWorkspaceId = useWorkspaceStore.use.activeWorkspaceId();
  const viewsByWs = useLayoutStore.use.viewsByWs();

  // Live mirror of the ACTIVE workspace's view.
  const tabs = useLayoutStore.use.tabs();
  const groupOrder = useLayoutStore.use.groupOrder();
  const activeByGroup = useLayoutStore.use.activeByGroup();
  const focusedGroupId = useLayoutStore.use.focusedGroupId();
  const tabHistory = useLayoutStore.use.tabHistory();
  const tabHistoryIndex = useLayoutStore.use.tabHistoryIndex();
  const mirrorView: WorkspaceView = useMemo(
    () => ({
      tabs,
      groupOrder,
      activeByGroup,
      focusedGroupId,
      tabHistory,
      tabHistoryIndex,
      activeTabId: activeByGroup[focusedGroupId] ?? null,
    }),
    [
      tabs,
      groupOrder,
      activeByGroup,
      focusedGroupId,
      tabHistory,
      tabHistoryIndex,
    ],
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
  const runningTabIds = useMemo(
    () => new Set(runningTabIdsArray),
    [runningTabIdsArray],
  );

  if (!currentProject) return <WelcomeScreen />;

  // Render every mounted workspace's shell in a stable container (key=ws.id),
  // only the active one visible. Background workspaces keep the INERT expensive
  // subtrees mounted (editor/chat/knowledge/settings) so switching back is
  // instant, but drop the ones that keep working while hidden — terminals,
  // browser embeds, Pixi graphs, PDFs — which were burning CPU/GPU in
  // workspaces the user couldn't even see. A workspace with no view yet (never
  // visited this session) renders nothing until its first cold load.
  return (
    <div className="h-full w-full bg-bg-surface relative">
      {workspaces.map((ws) => {
        const isActive = ws.id === activeWorkspaceId;
        const view = isActive ? mirrorView : viewsByWs[ws.id];
        if (!view) return null;
        return (
          <div
            key={ws.id}
            className="absolute inset-0"
            style={{ display: isActive ? "block" : "none" }}
          >
            <WorkspaceColumns
              workspaceId={ws.id}
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

// Memoized so a workspace switch re-renders only the ≤2 columns whose props
// actually change, not every mounted workspace's whole subtree (the O(N×tabs)
// re-render that makes even warm switches feel slow). `view` is a stable
// reference for uninvolved workspaces; `runningTabIds` is shallow-stable.
const WorkspaceColumns = memo(function WorkspaceColumns({
  workspaceId,
  view,
  isActive,
  runningTabIds,
}: {
  workspaceId: string;
  view: WorkspaceView;
  isActive: boolean;
  runningTabIds: Set<string>;
}) {
  const solo = view.groupOrder.length === 1;
  return (
    <PanelGroup
      direction="horizontal"
      autoSaveId={`atlas-center-split-${workspaceId}`}
      className="h-full bg-bg-surface"
    >
      {view.groupOrder.map((gid, i) => (
        <Fragment key={gid}>
          {i > 0 && (
            <PanelResizeHandle className="w-px bg-border-default hover:bg-accent data-[resize-handle-active]:bg-accent transition-colors cursor-col-resize" />
          )}
          <Panel id={gid} order={i + 1} minSize={20} className="min-w-0">
            <TabColumn
              groupId={gid}
              view={view}
              isActive={isActive}
              runningTabIds={runningTabIds}
              soloColumn={solo}
            />
          </Panel>
        </Fragment>
      ))}
    </PanelGroup>
  );
});

const TabColumn = memo(function TabColumn({
  groupId,
  view,
  isActive,
  runningTabIds,
  soloColumn,
}: {
  groupId: string;
  view: WorkspaceView;
  isActive: boolean;
  runningTabIds: Set<string>;
  soloColumn?: boolean;
}) {
  const tabBarVisible = useLayoutStore.use.tabBarVisible();
  const {
    setActiveTab,
    closeTab,
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
  const tabs = useMemo(
    () => tabsAll.filter((t) => GROUP_OF(t) === groupId),
    [tabsAll, groupId],
  );
  const activeId = view.activeByGroup[groupId] ?? null;
  const isFocused = isActive && view.focusedGroupId === groupId;
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
      className={cn("h-full flex flex-col overflow-hidden bg-bg-surface")}
      onMouseDownCapture={() => setFocusedGroup(groupId)}
    >
      {tabBarVisible && (
        <div
          className={cn(
            "flex items-stretch h-[29px] shrink-0 bg-bg-base border-b border-border-default transition-opacity",
            // When split, dim the UNFOCUSED columns' tab bars so the focused
            // one stands out (the focused pane also shows a white dot, below).
            !soloColumn && !isFocused && "opacity-45",
          )}
        >
          <div className="flex items-center justify-center gap-0.5 w-[44px] border-r border-border-default shrink-0">
            <button
              onClick={navigateTabBack}
              disabled={!canGoBack}
              className={cn(
                "flex items-center justify-center w-6 h-6 rounded transition-colors outline-none",
                canGoBack
                  ? "text-text-secondary hover:text-text-primary hover:bg-bg-hover cursor-pointer"
                  : "text-text-tertiary/40 cursor-not-allowed",
              )}
              title="Back"
            >
              <ChevronLeft size={13} />
            </button>
            <button
              onClick={navigateTabForward}
              disabled={!canGoForward}
              className={cn(
                "flex items-center justify-center w-6 h-6 rounded transition-colors outline-none",
                canGoForward
                  ? "text-text-secondary hover:text-text-primary hover:bg-bg-hover cursor-pointer"
                  : "text-text-tertiary/40 cursor-not-allowed",
              )}
              title="Forward"
            >
              <ChevronRight size={13} />
            </button>
          </div>

          <div className="flex items-stretch min-w-0 flex-1 overflow-x-auto hide-scrollbar">
            {tabs.map((tab) => {
              const Icon = tabIcons[tab.type as TabType] ?? MessageSquare;
              const isActive = tab.id === activeId;
              const isRunning = runningTabIds.has(tab.id);
              return (
                <div
                  key={tab.id}
                  role="tab"
                  tabIndex={0}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ")
                      setActiveTab(tab.id);
                  }}
                  className={cn(
                    "group relative flex items-center gap-1.5 pl-3 h-full text-[12px] font-medium shrink-0 cursor-pointer select-none border-r border-border-default",
                    "transition-[padding-right,background-color,color] duration-150",
                    tab.closable ? "pr-3 hover:pr-7" : "pr-3",
                    isActive
                      ? "text-text-primary bg-bg-surface"
                      : "text-text-tertiary bg-bg-base hover:text-text-secondary hover:bg-bg-hover",
                  )}
                >
                  {isRunning ? (
                    <Loader2
                      size={12}
                      className="animate-spin text-accent shrink-0"
                    />
                  ) : (
                    <Icon
                      size={12}
                      className={cn(
                        "shrink-0",
                        isActive ? "text-text-secondary" : "text-text-tertiary",
                      )}
                    />
                  )}
                  <span
                    className={cn(
                      "truncate max-w-[140px] leading-none",
                      tab.dirty && "italic",
                    )}
                  >
                    {tab.title}
                  </span>
                  {tab.closable && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(tab.id);
                      }}
                      title="Close tab"
                      className={cn(
                        "absolute right-1.5 top-1/2 -translate-y-1/2",
                        "inline-flex items-center justify-center w-4 h-4 rounded-full",
                        "text-text-tertiary opacity-0 group-hover:opacity-100",
                        "hover:bg-[#ffffff22] hover:text-text-primary transition-opacity duration-150",
                      )}
                    >
                      <X size={10} strokeWidth={2.2} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="relative flex items-center shrink-0">
            <div
              aria-hidden
              className="pointer-events-none absolute right-full top-0 h-full w-8"
              style={{
                background:
                  "linear-gradient(to right, transparent, var(--bg-base))",
              }}
            />
            {/* Selected-pane indicator: a white dot before the +/x actions. */}
            {!soloColumn && isFocused && (
              <span
                aria-hidden
                title="Active pane"
                className="self-center shrink-0 mx-1 h-1.5 w-1.5 rounded-full bg-[var(--accent-primary)]"
              />
            )}
            <NewTabDropdown addTab={addTab} groupId={groupId} />
            {canSplit && (
              <button
                onClick={addGroup}
                title="Split right (⌘\\)"
                className="self-center flex items-center justify-center w-6 h-6 text-text-tertiary hover:text-text-secondary hover:bg-bg-hover rounded transition-colors shrink-0 mr-0.5 cursor-pointer outline-none"
              >
                <Columns2 size={13} />
              </button>
            )}
            {canCloseGroup && (
              <button
                onClick={() => closeGroup(groupId)}
                title="Close split (⌥W)"
                className="self-center flex items-center justify-center w-6 h-6 text-text-tertiary hover:text-text-secondary hover:bg-bg-hover rounded transition-colors shrink-0 mr-1 cursor-pointer outline-none"
              >
                <X size={13} />
              </button>
            )}
          </div>
        </div>
      )}

      <TabContentContainer groupId={groupId} view={view} isActive={isActive} />
    </div>
  );
});

const TabContentContainer = memo(function TabContentContainer({
  groupId,
  view,
  isActive,
}: {
  groupId: string;
  view: WorkspaceView;
  isActive: boolean;
}) {
  const { setActiveTab } = useLayoutStore.use.actions();
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  const tabsAll = view.tabs;
  const tabs = useMemo(
    () => tabsAll.filter((t) => GROUP_OF(t) === groupId),
    [tabsAll, groupId],
  );
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
  // Only for the ACTIVE workspace — `setActiveTab` mutates the live (active)
  // store, so a background workspace must not fire it.
  useEffect(() => {
    if (isActive && !activeTab && tabs.length > 0) setActiveTab(tabs[0].id);
  }, [isActive, activeTab, tabs, setActiveTab]);

  // Empty split column — invite the user to open something.
  if (tabs.length === 0) {
    return (
      <div
        ref={ref}
        style={{ flex: "1 1 0%", minHeight: 0, overflow: "hidden" }}
        className="flex items-center justify-center text-[12px] text-text-tertiary"
      >
        Empty split — open a tab with + or ⌘⌥N
      </div>
    );
  }

  if (!activeTab) {
    return (
      <div
        ref={ref}
        style={{ flex: "1 1 0%", minHeight: 0, overflow: "hidden" }}
      />
    );
  }

  // Persist expensive tabs across tab switches within this column. For a
  // BACKGROUND workspace we additionally drop the types that keep working while
  // hidden (see IDLE_EXPENSIVE_TYPES) — off-screen terminals/browser embeds/
  // graphs were a major source of idle heat. Chat/knowledge/settings stay
  // mounted even in background workspaces: they cost nothing per frame when
  // hidden, and unmounting chat threw away the virtualizer's live state and
  // re-ran the transcript-load path on every switch back.
  const persistentTabs = tabs.filter(
    (t) =>
      PERSISTENT_TYPES.has(t.type) &&
      (isActive || !IDLE_EXPENSIVE_TYPES.has(t.type)),
  );
  const activeIsNonPersistent = !persistentTabs.find(
    (t) => t.id === activeTab.id,
  );

  return (
    <div
      ref={ref}
      style={{
        flex: "1 1 0%",
        minHeight: 0,
        overflow: "hidden",
        position: "relative",
      }}
    >
      <Suspense fallback={<PanelLoading />}>
        {persistentTabs.map((tab) => {
          const isActive = tab.id === activeTab.id;
          return (
            <div
              key={tab.id}
              style={{ display: isActive ? "contents" : "none" }}
            >
              {tab.type === "editor" ? (
                <EditorPanel
                  tabId={tab.id}
                  filePath={tab.data.filePath as string | undefined}
                  containerHeight={height}
                />
              ) : tab.type === "chat" ? (
                <ChatPanel tabId={tab.id} />
              ) : tab.type === "knowledge" ? (
                <KnowledgePanel />
              ) : tab.type === "browser" ? (
                <BrowserPanel
                  tabId={tab.id}
                  groupId={GROUP_OF(tab)}
                  initialUrl={tab.data.url as string | undefined}
                />
              ) : tab.type === "knowledge-graph" ? (
                <KnowledgeGraph />
              ) : tab.type === "pdf" ? (
                <PdfViewer
                  filePath={tab.data.filePath as string}
                  tabId={tab.id}
                />
              ) : tab.type === "settings" ? (
                <SettingsPanel
                  initialSection={tab.data.section as string | undefined}
                />
              ) : (
                <TerminalPanel tabId={tab.id} />
              )}
            </div>
          );
        })}

        {activeIsNonPersistent && <TabContent tab={activeTab} />}
      </Suspense>
    </div>
  );
});

function PanelLoading() {
  // Structural skeleton (not centered text) so the first open of a lazy panel
  // while its JS chunk downloads reads as "loading content" rather than blank.
  return <PanelSkeleton rows={7} />;
}

function TabContent({ tab }: { tab: Tab }) {
  switch (tab.type) {
    case "chat":
      return <ChatPanel tabId={tab.id} />;
    case "model-chat":
      return <ModelChatPanel tabId={tab.id} />;
    case "canvas":
      return <CanvasPanel />;
    case "knowledge":
      return <KnowledgePanel />;
    case "knowledge-graph":
      return <KnowledgeGraph />;
    case "memory":
      return <MemoryPanel />;
    case "research":
      return <ResearchPanel />;
    case "browser":
      return <BrowserPanel initialUrl={tab.data.url as string | undefined} />;
    case "settings":
      return (
        <SettingsPanel
          initialSection={tab.data.section as string | undefined}
        />
      );
    case "log":
      return <LogPanel />;
    case "pomodoro":
      return <PomodoroPanel />;
    case "mission-control":
      return <MissionControlPanel />;
    case "artifacts":
      return <ArtifactsPanel />;
    case "media":
      return <MediaViewer filePath={tab.data.filePath as string} />;
    case "svg":
      return <SvgViewer filePath={tab.data.filePath as string} />;
    case "pdf":
      return (
        <PdfViewer filePath={tab.data.filePath as string} tabId={tab.id} />
      );
    case "diff":
      return (
        <GitDiffPanel
          repoPath={tab.data.repoPath as string}
          file={tab.data.file as string}
          staged={!!tab.data.staged}
          commit={(tab.data.commit as string | null | undefined) ?? null}
        />
      );
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
        <div className="w-12 h-12 rounded-xl bg-bg-secondary border border-border-default flex items-center justify-center mx-auto">
          <Icon size={24} className="text-text-tertiary" />
        </div>
        <div>
          <p className="text-sm font-medium text-text-primary">{tab.title}</p>
          <p className="text-xs text-text-tertiary mt-1">Coming soon</p>
        </div>
      </div>
    </div>
  );
}

const NEW_TAB_OPTIONS: Array<{
  type: TabType;
  label: string;
  icon: React.ElementType;
}> = [
  { type: "chat", label: "Agents", icon: AtlasIcon },
  { type: "model-chat", label: "Chat", icon: MessageSquare },
  { type: "terminal", label: "Terminal", icon: Terminal },
  { type: "diff", label: "Git Diff", icon: GitCompare },
  { type: "canvas", label: "Spaces", icon: Map },
  { type: "browser", label: "Browser", icon: Globe },
  { type: "research", label: "Research", icon: BookOpen },
  { type: "knowledge", label: "Knowledge", icon: Brain },
  { type: "memory", label: "Memory", icon: BrainCircuit },
  { type: "log", label: "Log", icon: ScrollText },
  { type: "pomodoro", label: "Pomodoro", icon: Timer },
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
      <DropdownMenu.Trigger asChild>
        <button className="self-center flex items-center justify-center w-6 h-6 text-text-tertiary hover:text-text-secondary hover:bg-bg-hover rounded transition-colors shrink-0 mx-1 cursor-pointer outline-none focus:outline-none focus-visible:outline-none ring-0 focus:ring-0">
          <Plus size={14} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="w-[160px] rounded-lg border border-border-default bg-bg-secondary shadow-lg py-1"
          style={{ zIndex: 99999 }}
        >
          {NEW_TAB_OPTIONS.map(({ type, label, icon: Icon }) => (
            <DropdownMenu.Item
              key={type}
              onClick={() => handleAdd(type, label)}
              className="flex items-center gap-2 px-3 h-[30px] text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-default outline-none"
            >
              <Icon size={12} className="text-text-tertiary" />
              {label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

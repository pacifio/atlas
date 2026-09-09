import { useEffect, useCallback, useRef, Fragment } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useScopedHotkeys } from "@/features/keybindings/lib/use-scoped-hotkeys";
import {
  useTerminalStore,
  collectPanes,
  type TreeNode,
  type PaneNode,
  type SplitNode,
} from "../stores/terminal-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { BlockTerminal } from "./block-terminal";
import { terminalSessions } from "../lib/terminal-session";
import { useIsFocusedTerminal } from "../lib/focus";
import { pickPaneInDirection, type Direction, type RectLike } from "../lib/pane-navigation";
import {
  Plus,
  Columns2,
  Rows2,
  X,
  Terminal as TerminalIcon,
  Loader2,
  Maximize2,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Sessions close when their terminal leaves the store — every close path in
// one place. Bound once for the app's lifetime.
terminalSessions.bindToStore();

interface TerminalPanelProps {
  tabId: string;
  /** The workspace this tab belongs to — recorded so a notification can route
   *  back to it after its workspace has gone to the background. */
  workspaceId?: string;
}

/**
 * A terminal tab: a tree of resizable panes, each holding one or more
 * terminals (tabs within the pane).
 *
 * Terminals render INSIDE their pane container. The previous design measured
 * every container with `getBoundingClientRect` and floated the terminals over
 * the chrome in a flat, absolutely-positioned layer — so that restructuring
 * the tree could never remount a terminal and kill its shell. That invariant
 * is now the session registry's (`terminal-session.ts`): a remount re-parents
 * the session's surface and re-renders cached blocks, and costs nothing else.
 * So the geometry can be what the DOM says it is, and the ResizeObservers,
 * double-rAF retries and stale-rect guards are gone with it.
 */
export function TerminalPanel({ tabId, workspaceId }: TerminalPanelProps) {
  const tab = useTerminalStore((s) => s.tabs[tabId]);
  const {
    initTab,
    setActiveTerminalInPane,
    setActivePane,
    closeTerminalInPane,
    splitPane,
    closePane,
    toggleZoom,
  } = useTerminalStore.use.actions();
  // Is this tab the one showing in its column? Mounted already implies the
  // active workspace (background workspaces unmount terminal panels); this is
  // what tells a hidden tab's terminals to stop rendering.
  const panelVisible = useLayoutStore((s) => {
    const t = s.tabs.find((x) => x.id === tabId);
    return !!t && s.activeByGroup[t.groupId ?? "main"] === tabId;
  });

  useEffect(() => {
    initTab(tabId, workspaceId);
  }, [tabId, tab, initTab, workspaceId]);

  const activePane = useCallback((): PaneNode | null => {
    const t = useTerminalStore.getState().tabs[tabId];
    if (!t) return null;
    const panes = collectPanes(t.root);
    return panes.find((p) => p.id === t.activePaneId) ?? panes[0] ?? null;
  }, [tabId]);

  const cycleTerminal = (delta: number) => {
    const pane = activePane();
    // Nothing to cycle — decline so the chord falls through (e.g. to the
    // Knowledge Base's ⌘;/⌘' toggles).
    if (!pane || pane.terminals.length < 2) return false;
    const idx = Math.max(0, pane.terminals.indexOf(pane.activeTerminalId ?? pane.terminals[0]));
    const next = (idx + delta + pane.terminals.length) % pane.terminals.length;
    setActiveTerminalInPane(tabId, pane.id, pane.terminals[next]);
    setActivePane(tabId, pane.id);
    return true;
  };

  const cyclePane = (delta: number) => {
    const t = useTerminalStore.getState().tabs[tabId];
    if (!t) return false;
    const panes = collectPanes(t.root);
    if (panes.length < 2) return false;
    const idx = Math.max(
      0,
      panes.findIndex((p) => p.id === t.activePaneId),
    );
    setActivePane(tabId, panes[(idx + delta + panes.length) % panes.length].id);
    return true;
  };

  const rootRef = useRef<HTMLDivElement>(null);

  const focusDirection = (dir: Direction) => {
    const pane = activePane();
    const root = rootRef.current;
    if (!pane || !root) return false;
    // Real DOM now, so real rectangles — read at keypress time, never cached.
    const rects: Record<string, RectLike> = {};
    root.querySelectorAll<HTMLElement>("[data-pane-container]").forEach((el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      rects[el.dataset.paneContainer!] = {
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
      };
    });
    const next = pickPaneInDirection(rects, pane.id, dir);
    if (!next) return false;
    setActivePane(tabId, next);
    return true;
  };

  useScopedHotkeys({
    rootRef,
    requireFocusWithin: true,
    handlers: {
      "terminal.closeTab": () => {
        const pane = activePane();
        // Only intercept when there's a terminal tab to close; otherwise let
        // the global ⌘W close the editor tab as usual.
        if (!pane || pane.terminals.length < 2) return false;
        closeTerminalInPane(tabId, pane.id, pane.activeTerminalId ?? pane.terminals[0]);
        setActivePane(tabId, pane.id);
        return true;
      },
      "terminal.prevTab": () => cycleTerminal(-1),
      "terminal.nextTab": () => cycleTerminal(1),
      "terminal.splitRight": () => {
        const pane = activePane();
        if (!pane) return false;
        splitPane(tabId, pane.id, "horizontal");
        return true;
      },
      "terminal.splitDown": () => {
        const pane = activePane();
        if (!pane) return false;
        splitPane(tabId, pane.id, "vertical");
        return true;
      },
      "terminal.closePane": () => {
        const t = useTerminalStore.getState().tabs[tabId];
        const pane = activePane();
        // A single pane is the tab itself; let the chord fall through.
        if (!t || !pane || t.root.type === "pane") return false;
        closePane(tabId, pane.id);
        return true;
      },
      "terminal.focusPaneLeft": () => focusDirection("left"),
      "terminal.focusPaneRight": () => focusDirection("right"),
      "terminal.focusPaneUp": () => focusDirection("up"),
      "terminal.focusPaneDown": () => focusDirection("down"),
      "terminal.focusNextPane": () => cyclePane(1),
      "terminal.focusPrevPane": () => cyclePane(-1),
      "terminal.zoomPane": () => {
        const t = useTerminalStore.getState().tabs[tabId];
        const pane = activePane();
        if (!t || !pane || t.root.type === "pane") return false;
        toggleZoom(tabId, pane.id);
        return true;
      },
      "terminal.find": () => {
        const pane = activePane();
        const id = pane?.activeTerminalId;
        if (!id) return false;
        terminalSessions.get(id)?.requestSearch();
        return true;
      },
    },
  });

  if (!tab) return null;

  const zoomed = tab.zoomedPaneId
    ? collectPanes(tab.root).find((p) => p.id === tab.zoomedPaneId)
    : null;

  return (
    <div ref={rootRef} className="h-full bg-[#000] relative">
      {zoomed ? (
        <PaneView pane={zoomed} tabId={tabId} panelVisible={panelVisible} zoomed />
      ) : (
        <LayoutRenderer node={tab.root} tabId={tabId} panelVisible={panelVisible} />
      )}
    </div>
  );
}

function LayoutRenderer({
  node,
  tabId,
  panelVisible,
}: {
  node: TreeNode;
  tabId: string;
  panelVisible: boolean;
}) {
  if (node.type === "pane") {
    return <PaneView pane={node} tabId={tabId} panelVisible={panelVisible} />;
  }
  return <SplitView node={node} tabId={tabId} panelVisible={panelVisible} />;
}

/** A split: a nested resizable group. Proportions live on the node and are
 *  written back only on a user drag, never on the library's own constraint
 *  recomputes (that would loop). */
function SplitView({
  node,
  tabId,
  panelVisible,
}: {
  node: SplitNode;
  tabId: string;
  panelVisible: boolean;
}) {
  const { setSplitSizes } = useTerminalStore.use.actions();
  const horizontal = node.direction === "horizontal";
  return (
    <Group
      id={`term-split-${node.id}`}
      orientation={horizontal ? "horizontal" : "vertical"}
      defaultLayout={node.sizes}
      onLayoutChanged={(layout, meta) => {
        if (meta?.isUserInteraction) setSplitSizes(tabId, node.id, layout);
      }}
      className="h-full"
    >
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && (
            <Separator
              className={cn(
                "bg-border-default hover:bg-accent data-[separator=active]:bg-accent transition-colors",
                horizontal ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
              )}
            />
          )}
          {/* Percentages: v4 reads bare numbers as pixels, unit-less strings
              as percentages. */}
          <Panel id={child.id} minSize="15" className="min-w-0 min-h-0">
            <LayoutRenderer node={child} tabId={tabId} panelVisible={panelVisible} />
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
}

function PaneView({
  pane,
  tabId,
  panelVisible,
  zoomed,
}: {
  pane: PaneNode;
  tabId: string;
  panelVisible: boolean;
  zoomed?: boolean;
}) {
  const {
    addTerminalToPane,
    splitPane,
    closeTerminalInPane,
    closePane,
    setActiveTerminalInPane,
    setActivePane,
    toggleZoom,
  } = useTerminalStore.use.actions();
  // Only this pane's slice — a sibling's tab switch must not re-render us.
  const isActivePane = useTerminalStore((s) => s.tabs[tabId]?.activePaneId === pane.id);
  const hasSplits = useTerminalStore((s) => s.tabs[tabId]?.root.type === "split");
  const busy = useTerminalStore((s) => s.busy);
  const groupFocused = useLayoutStore((s) => {
    const t = s.tabs.find((x) => x.id === tabId);
    return !!t && s.focusedGroupId === (t.groupId ?? "main");
  });
  const activePty = pane.activeTerminalId;

  return (
    <div
      className={cn(
        "h-full flex flex-col",
        isActivePane && groupFocused && "ring-1 ring-[#ffffff08] ring-inset",
      )}
    >
      <div className="flex items-center h-[32px] shrink-0 border-b border-border-default bg-bg-primary px-1 gap-0.5">
        <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto hide-scrollbar">
          {pane.terminals.map((ptyId) => (
            <div
              key={ptyId}
              onClick={() => {
                setActiveTerminalInPane(tabId, pane.id, ptyId);
                setActivePane(tabId, pane.id);
              }}
              className={cn(
                "group flex items-center gap-1 px-1.5 h-5 rounded text-[10px] font-mono cursor-pointer shrink-0",
                ptyId === activePty
                  ? "text-text-primary bg-bg-selected"
                  : "text-text-tertiary hover:text-text-secondary hover:bg-bg-hover",
              )}
            >
              {busy[ptyId] ? (
                <Loader2 size={9} className="animate-spin text-[var(--accent-primary)]" />
              ) : (
                <TerminalIcon size={9} />
              )}
              <span>~</span>
              {pane.terminals.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTerminalInPane(tabId, pane.id, ptyId);
                  }}
                  className="opacity-0 group-hover:opacity-100 hover:text-text-primary"
                >
                  <X size={8} />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {zoomed && (
            <span className="mr-1 rounded bg-white/[0.06] px-1.5 py-px text-[9px] text-text-tertiary">
              zoomed
            </span>
          )}
          <button
            onClick={() => {
              addTerminalToPane(tabId, pane.id);
              setActivePane(tabId, pane.id);
            }}
            className="flex items-center justify-center w-5 h-5 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
            title="New tab"
          >
            <Plus size={11} />
          </button>
          <button
            onClick={() => splitPane(tabId, pane.id, "horizontal")}
            className="flex items-center justify-center w-5 h-5 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
            title="Split right"
          >
            <Columns2 size={11} />
          </button>
          <button
            onClick={() => splitPane(tabId, pane.id, "vertical")}
            className="flex items-center justify-center w-5 h-5 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
            title="Split down"
          >
            <Rows2 size={11} />
          </button>
          {hasSplits && (
            <button
              onClick={() => toggleZoom(tabId, pane.id)}
              className={cn(
                "flex items-center justify-center w-5 h-5 rounded hover:bg-bg-hover transition-colors cursor-pointer",
                zoomed ? "text-text-primary" : "text-text-tertiary hover:text-text-secondary",
              )}
              title={zoomed ? "Unzoom pane" : "Zoom pane"}
            >
              <Maximize2 size={11} />
            </button>
          )}
          {hasSplits && (
            <button
              onClick={() => closePane(tabId, pane.id)}
              className="flex items-center justify-center w-5 h-5 rounded text-text-tertiary hover:text-white hover:bg-bg-hover transition-colors cursor-pointer"
              title="Close pane"
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>
      {/* The pane's terminals, in the DOM where they belong. Inactive ones stay
          laid out (`visibility:hidden`, not `display:none`) so their fit is
          real and switching is instant. */}
      <div className="flex-1 min-h-0 relative" data-pane-container={pane.id}>
        {pane.terminals.map((ptyId) => (
          <TerminalSlot
            key={ptyId}
            ptyId={ptyId}
            pane={pane}
            tabId={tabId}
            panelVisible={panelVisible}
          />
        ))}
      </div>
    </div>
  );
}

function TerminalSlot({
  ptyId,
  pane,
  tabId,
  panelVisible,
}: {
  ptyId: string;
  pane: PaneNode;
  tabId: string;
  panelVisible: boolean;
}) {
  const { setActiveTerminalInPane, setActivePane } = useTerminalStore.use.actions();
  const isActiveInPane = ptyId === pane.activeTerminalId;
  const focused = useIsFocusedTerminal(ptyId);
  const onFocus = useCallback(() => {
    setActiveTerminalInPane(tabId, pane.id, ptyId);
    setActivePane(tabId, pane.id);
  }, [setActiveTerminalInPane, setActivePane, tabId, pane.id, ptyId]);
  return (
    <div
      className="absolute inset-0"
      style={{
        visibility: isActiveInPane ? "visible" : "hidden",
        pointerEvents: isActiveInPane ? "auto" : "none",
      }}
    >
      <BlockTerminal
        isActive={focused}
        visible={panelVisible && isActiveInPane}
        terminalKey={ptyId}
        tabId={tabId}
        onFocus={onFocus}
      />
    </div>
  );
}

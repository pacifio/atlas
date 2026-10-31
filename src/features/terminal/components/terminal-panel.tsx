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
import { useIsTabVisible } from "@/features/layout/lib/use-tab-visible";
import { BlockTerminal } from "./block-terminal";
import { terminalSessions } from "../lib/terminal-session";
import { useIsFocusedTerminal } from "../lib/focus";
import { pickPaneInDirection, type Direction, type RectLike } from "../lib/pane-navigation";
import { TerminalTabStrip } from "./terminal-tab-strip";
import { DrawerPaneActions } from "./drawer-pane-actions";
import { cn } from "@/lib/utils";

// Sessions close when their terminal leaves the store — every close path in
// one place. Bound once for the app's lifetime.
terminalSessions.bindToStore();

interface TerminalPanelProps {
  tabId: string;
  /** The project this tab belongs to — recorded so a notification can route
   *  back to it after its project has gone to the background. */
  projectId?: string;
  /** Whether the terminals are on screen. A layout tab leaves this out and
   *  asks the layout; a session's terminal drawer is not a layout tab, so it
   *  says. */
  visible?: boolean;
  /** `drawer`: a session's terminal drawer. A pane with one terminal shows no
   *  tab strip (a strip of one, in a drawer a few lines tall), only its
   *  actions, floating at its top-right; the strip appears with the second
   *  terminal. */
  variant?: "tab" | "drawer";
}

/**
 * A terminal tab: a tree of resizable panes, each holding one or more
 * terminals (tabs within the pane, in a strip across its top). Panes split
 * down only (`terminal.splitDown`); a tree restored from before that rule may
 * still hold a side-by-side split, and renders as it was.
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
export function TerminalPanel({ tabId, projectId, visible, variant = "tab" }: TerminalPanelProps) {
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
  // active project (background projects unmount terminal panels); this is
  // what tells a hidden tab's terminals to stop rendering.
  const tabVisible = useIsTabVisible(tabId);
  const panelVisible = visible ?? tabVisible;
  const drawer = variant === "drawer";

  useEffect(() => {
    initTab(tabId, projectId);
  }, [tabId, tab, initTab, projectId]);

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
        // A session drawer's last terminal closes here, and the drawer with
        // it: letting ⌘W fall through would close the SESSION's tab from
        // under the shell being typed in.
        if (drawer && pane && pane.terminals.length === 1) {
          closeTerminalInPane(tabId, pane.id, pane.activeTerminalId ?? pane.terminals[0]);
          return true;
        }
        // Only intercept when there's a terminal tab to close; otherwise let
        // the global ⌘W close the editor tab as usual.
        if (!pane || pane.terminals.length < 2) return false;
        closeTerminalInPane(tabId, pane.id, pane.activeTerminalId ?? pane.terminals[0]);
        setActivePane(tabId, pane.id);
        return true;
      },
      "terminal.prevTab": () => cycleTerminal(-1),
      "terminal.nextTab": () => cycleTerminal(1),
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
    // Flat, edge to edge — the column border is the terminal's edge. It used
    // to be a rounded card inset on a lighter frame, a panel inside a panel.
    <div
      ref={rootRef}
      data-when-scope="terminalFocus"
      className="relative h-full min-h-0 overflow-hidden bg-[var(--atlas-terminal-background)]"
    >
      {zoomed ? (
        <PaneView pane={zoomed} tabId={tabId} panelVisible={panelVisible} drawer={drawer} zoomed />
      ) : (
        <LayoutRenderer node={tab.root} tabId={tabId} panelVisible={panelVisible} drawer={drawer} />
      )}
    </div>
  );
}

function LayoutRenderer({
  node,
  tabId,
  panelVisible,
  drawer,
}: {
  node: TreeNode;
  tabId: string;
  panelVisible: boolean;
  drawer: boolean;
}) {
  if (node.type === "pane") {
    return <PaneView pane={node} tabId={tabId} panelVisible={panelVisible} drawer={drawer} />;
  }
  return <SplitView node={node} tabId={tabId} panelVisible={panelVisible} drawer={drawer} />;
}

/** A split: a nested resizable group. Proportions live on the node and are
 *  written back only on a user drag, never on the library's own constraint
 *  recomputes (that would loop). */
function SplitView({
  node,
  tabId,
  panelVisible,
  drawer,
}: {
  node: SplitNode;
  tabId: string;
  panelVisible: boolean;
  drawer: boolean;
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
                "bg-border hover:bg-primary data-[separator=active]:bg-primary transition-colors",
                horizontal ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
              )}
            />
          )}
          {/* Percentages: v4 reads bare numbers as pixels, unit-less strings
              as percentages. */}
          <Panel id={child.id} minSize="15" className="min-w-0 min-h-0">
            <LayoutRenderer
              node={child}
              tabId={tabId}
              panelVisible={panelVisible}
              drawer={drawer}
            />
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
  drawer,
  zoomed,
}: {
  pane: PaneNode;
  tabId: string;
  panelVisible: boolean;
  drawer: boolean;
  zoomed?: boolean;
}) {
  // Only this pane's slice — a sibling's tab switch must not re-render us.
  const isActivePane = useTerminalStore((s) => s.tabs[tabId]?.activePaneId === pane.id);
  const hasSplits = useTerminalStore((s) => s.tabs[tabId]?.root.type === "split");
  const groupFocused = useLayoutStore((s) => {
    const t = s.tabs.find((x) => x.id === tabId);
    return !!t && s.focusedGroupId === (t.groupId ?? "main");
  });

  return (
    <div
      className={cn(
        "flex h-full flex-col",
        isActivePane && groupFocused && "ring-1 ring-[var(--atlas-element-hover)] ring-inset",
      )}
    >
      {drawer && pane.terminals.length < 2 ? null : (
        <TerminalTabStrip pane={pane} tabId={tabId} zoomed={zoomed} hasSplits={hasSplits} />
      )}
      {/* The pane's terminals, in the DOM where they belong. Inactive ones stay
          laid out (`visibility:hidden`, not `display:none`) so their fit is
          real and switching is instant. */}
      <div className="relative min-h-0 min-w-0 flex-1" data-pane-container={pane.id}>
        {pane.terminals.map((ptyId) => (
          <TerminalSlot
            key={ptyId}
            ptyId={ptyId}
            pane={pane}
            tabId={tabId}
            panelVisible={panelVisible}
          />
        ))}
        {drawer && pane.terminals.length < 2 && (
          <DrawerPaneActions pane={pane} tabId={tabId} hasSplits={hasSplits} zoomed={zoomed} />
        )}
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

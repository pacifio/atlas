import { useEffect, useRef, useState, useCallback } from "react";
import { useScopedHotkeys } from "@/features/keybindings/lib/use-scoped-hotkeys";
import {
  useTerminalStore,
  collectPanes,
  type TreeNode,
  type PaneNode,
} from "../stores/terminal-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { BlockTerminal } from "./block-terminal";
import { Plus, Columns2, Rows2, X, Terminal as TerminalIcon, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface TerminalPanelProps {
  tabId: string;
}

interface PaneRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function TerminalPanel({ tabId }: TerminalPanelProps) {
  const tab = useTerminalStore((s) => s.tabs[tabId]);
  const { initTab, setActiveTerminalInPane, setActivePane, closeTerminalInPane } =
    useTerminalStore.use.actions();
  const rootRef = useRef<HTMLDivElement>(null);
  const [paneRects, setPaneRects] = useState<Record<string, PaneRect>>({});

  useEffect(() => {
    if (!tab) initTab(tabId);
  }, [tabId, tab, initTab]);

  const measureRetryRef = useRef(0);
  const measurePanes = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    // Bail while the panel is hidden/collapsed (tab inactive, mid-transition).
    // Measuring now yields a stale top:0 / height:0 that paints the terminal
    // over its own 28px pane header and the tab bar. We simply don't update —
    // the last *valid* rects stay in place; the ResizeObserver re-measures
    // once real geometry exists.
    if (root.offsetParent === null) return;
    const rootRect = root.getBoundingClientRect();
    if (rootRect.height === 0 || rootRect.width === 0) return;

    const containers = root.querySelectorAll<HTMLElement>("[data-pane-container]");
    const rects: Record<string, PaneRect> = {};
    let allValid = containers.length > 0;
    containers.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.height === 0 || r.width === 0 || el.offsetParent === null) {
        allValid = false;
        return;
      }
      rects[el.dataset.paneContainer!] = {
        top: r.top - rootRect.top,
        left: r.left - rootRect.left,
        width: r.width,
        height: r.height,
      };
    });

    if (!allValid) {
      // Layout still settling — retry a few frames before giving up (avoids
      // committing a half-measured frame, and avoids an infinite loop).
      if (measureRetryRef.current < 10) {
        measureRetryRef.current += 1;
        requestAnimationFrame(measurePanes);
      }
      return;
    }
    measureRetryRef.current = 0;
    setPaneRects(rects);
  }, []);

  // Measure after tree changes and on window resize
  useEffect(() => {
    if (!rootRef.current || !tab) return;
    // Double RAF to ensure layout is settled
    requestAnimationFrame(() => requestAnimationFrame(measurePanes));
  }, [tab?.root, measurePanes]);

  useEffect(() => {
    // Double RAF so we measure AFTER layout settles. A single RAF can fire
    // while the panel is still transitioning (e.g. tab switch flipping the
    // container from display:none to visible), capturing a stale top of 0 —
    // which makes the absolutely-positioned terminal overlay cover its own
    // 28px pane header and bleed up under the tab bar.
    const onResize = () => requestAnimationFrame(() => requestAnimationFrame(measurePanes));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measurePanes]);

  // Measure when the root OR any pane container resizes. Observing the
  // containers (not just the root) is what catches geometry changes that don't
  // change the root's box — e.g. the center tab-bar toggling (⌘⌥T), a split
  // column being added/removed, zen mode, or the 28px pane header settling
  // after mount. Re-attached whenever the terminal's pane tree changes (the
  // container elements are recreated). Double RAF for the settle reason above.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const ro = new ResizeObserver(() =>
      requestAnimationFrame(() => requestAnimationFrame(measurePanes)),
    );
    ro.observe(root);
    root.querySelectorAll<HTMLElement>("[data-pane-container]").forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [measurePanes, tab?.root]);

  // Re-measure when a surrounding panel toggles (⌘⌥B status bar = height,
  // ⌘B / ⌘⇧B left/right panels = width). The ResizeObserver above can miss the
  // reflow (the box change races the conditional mount/unmount), so the
  // absolutely-positioned terminals — and their command input — would otherwise
  // keep the old rect. Re-measuring on the visibility flags fixes it directly.
  const leftVisible = useLayoutStore((s) => s.leftPanel.visible);
  const rightVisible = useLayoutStore((s) => s.rightPanel.visible);
  const bottomVisible = useLayoutStore((s) => s.bottomPanel.visible);
  const chatSidebarVisible = useLayoutStore((s) => s.chatSidebar.visible);
  // The center's own chrome also changes the terminal's box: the tab bar
  // toggling (⌘⌥T), split columns being added/removed (groupOrder), and zen
  // mode. None resize the surrounding panels, so watch them explicitly.
  const tabBarVisible = useLayoutStore((s) => s.tabBarVisible);
  const groupCount = useLayoutStore((s) => s.groupOrder.length);
  const zen = useLayoutStore((s) => s.zen);
  useEffect(() => {
    requestAnimationFrame(() => requestAnimationFrame(measurePanes));
  }, [
    leftVisible,
    rightVisible,
    bottomVisible,
    chatSidebarVisible,
    tabBarVisible,
    groupCount,
    zen,
    measurePanes,
  ]);

  // Terminal-tab keyboard shortcuts, gated to the VISIBLE terminal panel
  // (offsetParent !== null) so background tabs never steal them:
  //   ⌘;  → previous terminal tab     ⌘'  → next terminal tab  (within the
  //         active pane, wrapping)
  //   ⌘W  → close the active terminal tab WHEN the pane has more than one;
  //         otherwise it falls through to the global ⌘W (close the editor tab).
  // Registered in the CAPTURE phase so ⌘W can stopImmediatePropagation() before
  // the global (bubble-phase) ⌘W handler closes the whole tab.
  const activePane = () => {
    const t = useTerminalStore.getState().tabs[tabId];
    if (!t) return null;
    const panes = collectPanes(t.root);
    return panes.find((p) => p.id === t.activePaneId) ?? panes[0] ?? null;
  };
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
    },
  });

  if (!tab) return null;

  const allPanes = collectPanes(tab.root);

  return (
    <div ref={rootRef} className="h-full bg-[#000] relative">
      {/* Layout layer — toolbars + empty container divs */}
      <div className="h-full absolute inset-0">
        <LayoutRenderer node={tab.root} tabId={tabId} activePaneId={tab.activePaneId} />
      </div>

      {/* Terminal layer — flat list, absolutely positioned, NEVER unmounts on tree changes */}
      {allPanes.map((pane) =>
        pane.terminals.map((ptyId) => {
          const rect = paneRects[pane.id];
          const isActiveInPane = ptyId === pane.activeTerminalId;
          const isPaneActive = pane.id === tab.activePaneId;

          return (
            <div
              key={ptyId}
              style={{
                position: "absolute",
                top: rect?.top ?? 0,
                left: rect?.left ?? 0,
                width: rect?.width ?? 0,
                height: rect?.height ?? 0,
                visibility: rect && isActiveInPane ? "visible" : "hidden",
                pointerEvents: isActiveInPane ? "auto" : "none",
              }}
            >
              <BlockTerminal
                isActive={isActiveInPane && isPaneActive}
                terminalKey={ptyId}
                tabId={tabId}
                onFocus={() => {
                  setActiveTerminalInPane(tabId, pane.id, ptyId);
                  setActivePane(tabId, pane.id);
                }}
              />
            </div>
          );
        }),
      )}
    </div>
  );
}

function LayoutRenderer({
  node,
  tabId,
  activePaneId,
}: {
  node: TreeNode;
  tabId: string;
  activePaneId: string | null;
}) {
  if (node.type === "pane") {
    return <PaneChrome pane={node} tabId={tabId} isActivePane={node.id === activePaneId} />;
  }

  return (
    <div className={cn("h-full flex", node.direction === "horizontal" ? "flex-row" : "flex-col")}>
      {node.children.map((child, i) => (
        <div
          key={child.id}
          className={cn(
            "min-w-0 min-h-0",
            i > 0 &&
              (node.direction === "horizontal"
                ? "border-l border-border-default"
                : "border-t border-border-default"),
          )}
          style={{ flex: 1 }}
        >
          <LayoutRenderer node={child} tabId={tabId} activePaneId={activePaneId} />
        </div>
      ))}
    </div>
  );
}

function PaneChrome({
  pane,
  tabId,
  isActivePane,
}: {
  pane: PaneNode;
  tabId: string;
  isActivePane: boolean;
}) {
  const {
    addTerminalToPane,
    splitPane,
    closeTerminalInPane,
    closePane,
    setActiveTerminalInPane,
    setActivePane,
  } = useTerminalStore.use.actions();
  const tab = useTerminalStore((s) => s.tabs[tabId]);
  const busy = useTerminalStore((s) => s.busy);
  const hasSplits = tab?.root.type === "split";
  const activePty = pane.activeTerminalId;

  return (
    <div
      className={cn("h-full flex flex-col", isActivePane && "ring-1 ring-[#ffffff08] ring-inset")}
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
              onClick={() => closePane(tabId, pane.id)}
              className="flex items-center justify-center w-5 h-5 rounded text-text-tertiary hover:text-white hover:bg-bg-hover transition-colors cursor-pointer"
              title="Close pane"
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>
      {/* Empty container — terminals overlay this via absolute positioning */}
      <div className="flex-1 min-h-0" data-pane-container={pane.id} />
    </div>
  );
}

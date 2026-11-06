/**
 * Which terminal has the keyboard — ONE answer, app-wide.
 *
 * The old `isActive` was derived from the terminal store alone (active in its
 * pane, pane active in its tab), which is blind to the layout: a terminal tab
 * that is not the active tab of its column, or a column that is not the
 * focused one, still claimed focus — and hidden terminals called `focus()` on
 * themselves whenever an alt-screen app started. This walks the whole chain:
 * focused column → its active tab → a terminal tab → its active pane → the
 * pane's active terminal. The layout mirror always represents the active
 * project, so project visibility is implicit.
 *
 * A session's terminal drawer is the one terminal surface that is not a
 * layout tab. It answers for itself: while DOM focus is inside a drawer, that
 * drawer's tab stands in for the layout half (`session-drawer-store`). The
 * layout half still wins when it has an answer.
 */
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { collectPanes, useTerminalStore, type TerminalTabState } from "../stores/terminal-store";
import { useSessionDrawerStore } from "../stores/session-drawer-store";

interface LayoutSlice {
  tabs: ReadonlyArray<{ id: string; type: string; groupId?: string }>;
  focusedGroupId: string;
  activeByGroup: Record<string, string | null>;
}

export function focusedTerminalId(
  layout: LayoutSlice,
  term: { tabs: Record<string, TerminalTabState> },
): string | null {
  const tabId = focusedTerminalTabId(layout);
  return tabId ? activeTerminalOf(term.tabs[tabId]) : null;
}

/** The layout half: the focused column's active tab, if it is a terminal tab. */
function focusedTerminalTabId(layout: LayoutSlice): string | null {
  const tabId = layout.activeByGroup[layout.focusedGroupId];
  if (!tabId) return null;
  const tab = layout.tabs.find((t) => t.id === tabId);
  return tab && tab.type === "terminal" ? tabId : null;
}

/** The terminal half: that tab's active pane's active terminal. */
function activeTerminalOf(t: TerminalTabState | undefined): string | null {
  if (!t) return null;
  const panes = collectPanes(t.root);
  const pane = panes.find((p) => p.id === t.activePaneId) ?? panes[0];
  return pane?.activeTerminalId ?? null;
}

/** Boolean selector per terminal — two store subscriptions, no allocation.
 *  The same two halves `focusedTerminalId` composes, split so each store is
 *  subscribed with a primitive and a terminal re-renders only when its answer
 *  changes. */
export function useIsFocusedTerminal(terminalId: string): boolean {
  const layoutHit = useLayoutStore(focusedTerminalTabId);
  const drawerHit = useSessionDrawerStore((s) => s.focusedTab);
  const hit = layoutHit ?? drawerHit;
  return useTerminalStore((s) => hit !== null && activeTerminalOf(s.tabs[hit]) === terminalId);
}

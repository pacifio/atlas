import { AGENT_PANEL_TAB, useLayoutStore } from "../stores/layout-store";
import { destinationShown, openDestination } from "./destinations";
import { revealSingleton, singletonShown } from "./singleton-surface";

/**
 * Where the Organisation agent shows, in the layout.
 *
 *  - Its home is the side panel — the surfaces pane — beside the session: the
 *    `agent-panel` surface, one per window (`WINDOW_TYPES`), with the
 *    conversations as tabs inside it.
 *  - The full page is the `agent` destination: every conversation, or one
 *    given the room.
 *
 * Two types rather than one `surface-or-destination` (team chat's shape):
 * a dual type LEAVES its column when it goes full page, and the side panel
 * must stay to say where its conversation went. Within the agent, a
 * conversation lives in one place at a time — side panel, floating messenger
 * or full page — and the side panel stands in for one that is elsewhere
 * (`org-agent-side-panel.tsx`).
 *
 * Entry points:
 *  - ⌘⌥A, the palette: the side panel (toggled);
 *  - the sidebar's Agent row: the full page;
 *  - a conversation's Full screen: the full page, on it.
 */

type LayoutSnapshot = ReturnType<typeof useLayoutStore.getState>;

/** Whether the agent's side panel is on screen. Selector-shaped. */
export function agentPanelShown(s: LayoutSnapshot): boolean {
  return singletonShown(s, "agent-panel");
}

/** Whether the agent's full page is the destination on screen. */
export function agentPageShown(s: LayoutSnapshot): boolean {
  return destinationShown(s, "agent");
}

/** Bring the side panel on screen (leaving the full page if it is up). */
export function revealAgentPanel(): void {
  const s = useLayoutStore.getState();
  if (s.destinationShown) s.actions.hideDestination();
  revealSingleton(AGENT_PANEL_TAB);
}

/** The full page. */
export function revealAgentPage(): void {
  openDestination("agent");
}

/** ⌘⌥A: the side panel away when it is on screen, else on screen. */
export function toggleAgentPanel(): void {
  const s = useLayoutStore.getState();
  if (agentPanelShown(s) && !s.destinationShown) {
    const tab = s.tabs.find((t) => t.type === "agent-panel");
    if (tab) s.actions.closeTab(tab.id);
    return;
  }
  revealAgentPanel();
}

/** The sidebar's Agent row: the full page, or back to the session from it. */
export function toggleAgentPage(): void {
  const s = useLayoutStore.getState();
  if (agentPageShown(s)) s.actions.hideDestination();
  else revealAgentPage();
}

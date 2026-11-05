import { groupOf, useLayoutStore, type Tab } from "../stores/layout-store";

/**
 * A surface the window holds at most one of — source control, team chat — and
 * the three things every entry point does with it: ask whether it is on
 * screen, bring it on screen, and toggle it (the ⌘⇧ shortcut).
 */

type LayoutSnapshot = ReturnType<typeof useLayoutStore.getState>;

/**
 * Whether the window's `type` tab is on screen: the active tab of a column
 * that is showing. Selector-shaped so a component can subscribe to it.
 */
export function singletonShown(s: LayoutSnapshot, type: Tab["type"]): boolean {
  const tab = s.tabs.find((t) => t.type === type);
  if (!tab) return false;
  const group = groupOf(tab);
  if (s.activeByGroup[group] !== tab.id) return false;
  const isMain = group === s.groupOrder[0];
  return isMain ? s.surfaces !== "expanded" : s.surfaces !== "hidden";
}

/**
 * Bring `tab` on screen: focus it where it already is, else open it in the
 * surfaces pane (growing one beside the main column when the window has only
 * that). A hidden surfaces pane is shown, or the tab would open out of sight.
 */
export function revealSingleton(tab: Tab): void {
  const { actions } = useLayoutStore.getState();
  const existing = useLayoutStore.getState().tabs.find((t) => t.type === tab.type);
  if (existing) {
    actions.setActiveTab(existing.id);
  } else {
    const { groupOrder } = useLayoutStore.getState();
    if (groupOrder.length === 1) {
      actions.setFocusedGroup(groupOrder[0]);
      actions.addGroup();
    }
    const { groupOrder: order, focusedGroupId } = useLayoutStore.getState();
    // Never the main column: a surface opens beside the agent, not over it.
    const target = focusedGroupId === order[0] ? order[1] : focusedGroupId;
    actions.addTab(tab, target ?? order[0]);
  }
  const s = useLayoutStore.getState();
  if (!singletonShown(s, tab.type) && s.surfaces === "hidden") actions.setSurfaces("shown");
}

/** Close the window's `tab.type` tab when it is on screen, else reveal it. */
export function toggleSingleton(tab: Tab): void {
  const state = useLayoutStore.getState();
  const open = state.tabs.find((t) => t.type === tab.type);
  if (open && singletonShown(state, tab.type)) state.actions.closeTab(open.id);
  else revealSingleton(tab);
}

import { useLayoutStore } from "../stores/layout-store";

/**
 * Is this tab the one showing in its split column?
 *
 * Reads the live mirror (`tabs` / `activeByGroup`), which only ever holds the
 * ACTIVE workspace's view — so a tab in a background workspace answers false
 * without a workspace check. The selector returns a boolean, so subscribers
 * re-render only for the two tabs involved in a switch.
 *
 * Used by panels that stay mounted while hidden and want to stop spending on
 * work nobody can see: the terminal stops rendering, the chat transcript
 * pauses its idle window fill.
 */
export function useIsTabVisible(tabId: string): boolean {
  return useLayoutStore((s) => {
    const t = s.tabs.find((x) => x.id === tabId);
    return !!t && s.activeByGroup[t.groupId ?? "main"] === tabId;
  });
}

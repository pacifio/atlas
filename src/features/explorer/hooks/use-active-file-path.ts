import { useLayoutStore } from "@/features/layout/stores/layout-store";

import { isFileTab } from "../lib/file-tabs";

/** Tab types whose `data.filePath` is a file the tree can point at. */

/**
 * The file the reader is looking at: the active tab of the focused column, or
 * of any column, or failing both the most recent file tab. The last matters
 * because a file opened from this tree opens in the tree's own column (editors
 * are surfaces, ADR-0024), so coming back to the tree means that file's tab
 * is no longer the active one, and the highlight must not vanish with it.
 */
export function useActiveFilePath(): string | null {
  return useLayoutStore((s) => {
    const fileOf = (id: string | null | undefined) => {
      const tab = id ? s.tabs.find((t) => t.id === id) : undefined;
      return tab && isFileTab(tab.type) && typeof tab.data.filePath === "string"
        ? tab.data.filePath
        : null;
    };
    const groups = [s.focusedGroupId, ...s.groupOrder.filter((g) => g !== s.focusedGroupId)];
    for (const group of groups) {
      const path = fileOf(s.activeByGroup[group]);
      if (path) return path;
    }
    for (let i = s.tabHistory.length - 1; i >= 0; i--) {
      const path = fileOf(s.tabHistory[i]);
      if (path) return path;
    }
    return null;
  });
}

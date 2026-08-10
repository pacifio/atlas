import { useEffect, useState } from "react";
import { useLayoutStore } from "@/features/layout/stores/layout-store";

/**
 * Cmd/Ctrl+F "find in chat" binder, scoped to the FOCUSED pane + tab.
 *
 * Each chat panel (agent chat, model chat) calls this with its own center-panel
 * `tabId` and keeps its own palette state + message source — same UI composite
 * (ChatSearchPalette), separate per-pane logic. The trigger fires only when this
 * tab is the active tab of the focused split column.
 *
 * We scope off `activeTabId` (the store's mirror of the focused column's active
 * tab, set by `onMouseDownCapture → setFocusedGroup` in center-panel) rather
 * than `document.activeElement`, because clicking a non-focusable element in a
 * pane moves *pane* focus without moving DOM focus — so an activeElement check
 * lets the other pane keep the keyboard and both finders fire.
 */
export function usePaneFind(tabId: string | undefined): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!tabId) return;
    const handler = (e: KeyboardEvent) => {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f" && !e.shiftKey && !e.altKey)) {
        return;
      }
      if (useLayoutStore.getState().activeTabId !== tabId) return;
      e.preventDefault();
      setOpen(true);
    };
    // Capture phase to beat the browser's native find.
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [tabId]);

  return [open, setOpen];
}

import { useEffect, useState } from "react";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { matchesAction } from "@/features/keybindings/lib/use-scoped-hotkeys";

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
/** Opens a chat tab's find bar from outside its panel (the Details card's
 *  Find button). A window event; `detail.tabId` names the tab. */
export const OPEN_CHAT_FIND_EVENT = "atlas:chat-open-find";

export function usePaneFind(tabId: string | undefined): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!tabId) return;
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<{ tabId?: string }>).detail?.tabId === tabId) setOpen(true);
    };
    window.addEventListener(OPEN_CHAT_FIND_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_CHAT_FIND_EVENT, onOpen);
  }, [tabId]);

  useEffect(() => {
    if (!tabId) return;
    const handler = (e: KeyboardEvent) => {
      if (!matchesAction(e, "chat.find")) return;
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

import { useState } from "react";
import { useActionHandlers } from "@/features/keybindings/hooks/use-action-handlers";

/**
 * "Find in chat", scoped to the FOCUSED pane + tab.
 *
 * Each chat panel (agent chat, model chat) calls this with its own center-panel
 * `tabId` and keeps its own palette state + message source — same UI composite
 * (ChatSearchPalette), separate per-pane logic.
 *
 * The tab id is what scopes it: the keybinding registry only runs the handler
 * whose `tabId` is the focused column's active tab. That is deliberately not
 * `document.activeElement` — clicking a non-focusable element in a pane moves
 * *pane* focus without moving DOM focus, so an activeElement check lets the
 * other pane keep the keyboard and both finders fire.
 */
export function usePaneFind(tabId: string | undefined): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  useActionHandlers({ "chat-find": () => setOpen(true) }, tabId);
  return [open, setOpen];
}

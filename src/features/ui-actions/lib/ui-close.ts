/**
 * `ui_close`: close a tab through the app's own close path, so a busy chat
 * still asks the user first. Unsaved work is never closed by an agent: an
 * editor (or a PDF with annotations) with changes is refused outright, with
 * no override.
 */

import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { requestCloseTab } from "@/features/chat/lib/close-tab";
import { isBusyAgentStatus } from "@/types/agent";
import { readArgs, refuse } from "./args";
import { tabInScope } from "./scope";
import type { UiActionRequest } from "./types";

export async function performClose(request: UiActionRequest): Promise<unknown> {
  const a = readArgs("ui_close", request.args);
  const tabId =
    a.optStr("tabId") ?? useLayoutStore.getState().activeTabId ?? refuse("no tab is active");
  const tab = tabInScope(tabId);
  if (!tab.closable) return refuse(`tab ${tabId} cannot be closed`);
  // The tab's own flag, which its save session keeps current, is the truth.
  // The file's shared buffer flag is not: another tab on the same file, or a
  // buffer cached from a tab closed with "Don't save", can leave it stale.
  // Any tab type: a PDF with unsaved annotations marks its tab dirty too.
  if (tab.dirty) {
    return refuse(`${tab.title} has unsaved changes; ask the user to save or close it`);
  }
  const busy =
    tab.type === "chat" && isBusyAgentStatus(useChatStore.getState().sessions[tabId]?.status);
  requestCloseTab(tabId);
  const closed = !useLayoutStore.getState().tabs.some((t) => t.id === tabId);
  return busy && !closed ? { tabId, closed, awaitingUserConfirm: true } : { tabId, closed };
}

/**
 * Which window answers a UI action. Rust broadcasts the request; the window
 * that hosts the calling session's chat tab answers, and failing that the
 * main window — so a second app window, should one ever exist, never answers
 * for a session it does not show. The bridge answers at most once per id, and
 * Rust takes the first answer. An organisation call's Logs row is written by
 * the same window, by the same rule.
 */

import { useChatStore, findTabByAcpSession } from "@/features/chat/stores/chat-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import type { UiActionRequest } from "./types";

export function ownsUiActionRequest(
  request: Pick<UiActionRequest, "sessionId">,
  windowLabel: string,
): boolean {
  const tabId = findTabByAcpSession(useChatStore.getState().sessions, request.sessionId);
  if (tabId && useLayoutStore.getState().tabs.some((t) => t.id === tabId)) return true;
  return windowLabel === "main";
}

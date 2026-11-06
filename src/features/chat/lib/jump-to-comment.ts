// Scroll a chat to the row a cloud comment hangs off.
//
// A comment is anchored to a CAPTURED row (its id on the server); the thread
// knows that row as a message or a tool call. `AnchorMap` translates, and the
// transcript's own jump (`atlas:chat-jump`) does the scrolling — addressed by
// message index as every other jump is, plus the row ids to highlight once it
// lands. A tool-call thread inside a folded "Worked" section lands on the
// header when the row is not in the DOM.

import { useChatCommentsStore } from "../stores/chat-comments-store";
import { useChatStore } from "../stores/chat-store";

export interface ChatJumpDetail {
  index: number;
  /** The chat to move. Every mounted transcript hears the event; without this
   *  each of them scrolled to the same index of its own thread. */
  tabId?: string;
  /** Rows to highlight on arrival, first one found wins. */
  highlightRowIds?: string[];
}

/** How long an "open this thread" request stands. Long enough for a jump to
 *  settle and the row to mount; short enough that scrolling away and back
 *  later does not pop the thread open again. */
const FOCUS_HOLD_MS = 4000;
const focusTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Jump `tabId`'s transcript to the row behind `anchorId` AND open that row's
 * thread — what clicking a comment does in the Timeline. A comment on the
 * session as a whole (`sessionAnchorId`) goes to the top of the thread; there
 * is no row to open it on.
 */
export function jumpToCommentAnchor(
  tabId: string,
  anchorId: string,
  sessionAnchorId?: string,
): void {
  const messages = useChatStore.getState().sessions[tabId]?.messages ?? [];
  if (anchorId === sessionAnchorId) {
    if (messages.length > 0) dispatchJump({ index: 0, tabId });
    return;
  }
  const state = useChatCommentsStore.getState().byTab[tabId];
  const chatKey = state?.anchors.chatKeyByRowId.get(anchorId);
  if (!chatKey) return;
  let index = messages.findIndex((m) => m.id === chatKey);
  let rowId: string;
  if (index >= 0) {
    const m = messages[index];
    rowId = m.role === "user" ? `u:${m.id}` : m.mode === "thinking" ? `th:${m.id}` : `p:${m.id}`;
  } else {
    index = messages.findIndex((m) => m.toolCalls.some((tc) => tc.id === chatKey));
    if (index < 0) return;
    rowId = `mk:${chatKey}`;
  }
  let start = index;
  if (messages[index].role !== "user") {
    while (start > 0 && messages[start - 1].role !== "user") start -= 1;
  }
  const turnId = `t:${messages[start].id}`;
  dispatchJump({ index: start, tabId, highlightRowIds: [rowId, `wk:${turnId}`] });
  focusThreadFor(tabId, anchorId);
}

function focusThreadFor(tabId: string, rowId: string): void {
  const { focusThread, clearFocus } = useChatCommentsStore.getState().actions;
  focusThread(tabId, rowId);
  clearTimeout(focusTimers.get(tabId));
  focusTimers.set(
    tabId,
    setTimeout(() => {
      focusTimers.delete(tabId);
      clearFocus(tabId);
    }, FOCUS_HOLD_MS),
  );
}

function dispatchJump(detail: ChatJumpDetail): void {
  window.dispatchEvent(new CustomEvent<ChatJumpDetail>("atlas:chat-jump", { detail }));
}

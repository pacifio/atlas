import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "@/features/chat/stores/chat-store";

/**
 * Populate the agent chat composer with `text` — the shared mechanism behind
 * the KB "send selection to chat" button and the Memory policy "send to chat"
 * action. Picks the agent chat tab (active session if it's one, else the
 * first), appends to its draft (read as the composer's initial value when it
 * mounts), brings the tab into view, and fires a tab-targeted live insert for
 * the already-mounted/split case.
 */
export function sendToAgentChat(text: string): void {
  const layout = useLayoutStore.getState();
  const tabId = agentChatTarget();
  if (!tabId) return;

  const chat = useChatStore.getState();
  const cur = chat.drafts[tabId] ?? "";
  const next = cur.trim() ? `${cur}\n\n${text}` : text;
  chat.actions.setDraft(tabId, next);

  layout.actions.setActiveTab(tabId);

  requestAnimationFrame(() =>
    window.dispatchEvent(new CustomEvent("atlas:chat-insert", { detail: { text: next, tabId } })),
  );
}

/** The chat tab `sendToAgentChat` writes to: the active session when it is
 *  a chat tab, else the first chat tab; null with none open. */
export function agentChatTarget(): string | null {
  const chatTabs = useLayoutStore.getState().tabs.filter((t) => t.type === "chat");
  if (chatTabs.length === 0) return null;
  const activeSession = useChatStore.getState().activeSessionId;
  return (chatTabs.find((t) => t.id === activeSession) ?? chatTabs[0]).id;
}

/** `agentChatTarget`, re-read as tabs open and close and the session
 *  changes. */
export function useAgentChatTarget(): string | null {
  // Subscribed for the re-render; the answer is read whole each time.
  useLayoutStore((s) => s.tabs.length);
  useChatStore((s) => s.activeSessionId);
  return agentChatTarget();
}

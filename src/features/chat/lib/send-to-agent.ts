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
  const chatTabs = layout.tabs.filter((t) => t.type === "chat");
  if (chatTabs.length === 0) return;
  const activeSession = useChatStore.getState().activeSessionId;
  const target = chatTabs.find((t) => t.id === activeSession) ?? chatTabs[0];
  const tabId = target.id;

  const chat = useChatStore.getState();
  const cur = chat.drafts[tabId] ?? "";
  const next = cur.trim() ? `${cur}\n\n${text}` : text;
  chat.actions.setDraft(tabId, next);

  layout.actions.setActiveTab(tabId);

  requestAnimationFrame(() =>
    window.dispatchEvent(new CustomEvent("atlas:chat-insert", { detail: { text: next, tabId } })),
  );
}

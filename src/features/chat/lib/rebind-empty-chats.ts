import { useChatStore } from "@/features/chat/stores/chat-store";
import { isBusyAgentStatus } from "@/types/agent";

/** Drop the backend session of every empty, idle chat, so its panel binds a
 *  fresh one. A session takes the tool servers on offer when it opens: an
 *  empty chat opened while `agentCodeTools` was off would otherwise keep its
 *  tool-less session after the setting is turned back on. A chat with a
 *  conversation, a turn in flight or a resume pending is left alone. */
export function rebindEmptyChats(): void {
  const { sessions, actions } = useChatStore.getState();
  for (const [tabId, s] of Object.entries(sessions)) {
    const empty = s.messages.length === 0 && !s.pendingSend;
    const settled = !isBusyAgentStatus(s.status) && !s.resumePending && !s.transcriptLoading;
    if (s.acpSessionId && empty && settled) actions.clearSession(tabId);
  }
}

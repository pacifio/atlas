import { useChatStore } from "@/features/chat/stores/chat-store";
import { NATIVE_AGENT, isBusyAgentStatus, type SwitchableAgent } from "@/types/agent";
import { switchableAgentIds } from "@/features/agents/lib/agent-meta";
import { openNewAgentChat } from "./open-agent-session";

/**
 * Bind a chat tab to a different coding agent — the single implementation
 * behind every entry point (⌥/ cycle, the composer's agent pill, the "+" menu
 * picker), so they can never drift apart.
 *
 * A session is paired to ONE agent for its lifetime, so switching means a fresh
 * session. Three cases:
 * - empty chat  → flip the agent in place, nothing to lose.
 * - idle chat   → reset in place bound to the new agent (the old conversation
 *                 is already persisted per-turn and stays in history).
 * - BUSY chat   → leave it completely alone and open a fresh tab on the new
 *                 agent. Clearing here would orphan the live turn: its deltas
 *                 would find no tab, Stop would vanish, and it would keep
 *                 running invisibly.
 */
export function switchAgentForTab(tabId: string, next: SwitchableAgent): void {
  const chat = useChatStore.getState();
  const sess = chat.sessions[tabId];
  if ((sess?.agentType ?? NATIVE_AGENT) === next) return;

  if (isBusyAgentStatus(sess?.status)) {
    openNewAgentChat(next);
    return;
  }
  if ((sess?.messages.length ?? 0) > 0) {
    chat.actions.clearSession(tabId);
  }
  chat.actions.switchChatAgent(tabId, next);
  window.dispatchEvent(new CustomEvent("atlas:chat-focus", { detail: { tabId } }));
}

/** The next agent in the ⌥/ rotation for a tab — first-party agents in their
 *  fixed order, then any installed registry externals. */
export function nextAgentForTab(tabId: string): SwitchableAgent {
  const rotation = switchableAgentIds();
  const cur = useChatStore.getState().sessions[tabId]?.agentType;
  const idx = rotation.indexOf(cur ?? NATIVE_AGENT);
  return rotation[(Math.max(idx, 0) + 1) % rotation.length];
}

/** Advance a chat tab to the next agent (⌥/ and the composer's agent pill). */
export function cycleChatAgent(tabId: string): void {
  switchAgentForTab(tabId, nextAgentForTab(tabId));
}

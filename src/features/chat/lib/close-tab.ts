import { emit } from "@tauri-apps/api/event";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { agents } from "./agents-api";
import { isBusyAgentStatus } from "@/types/agent";
import { useStopAgentsConfirmStore } from "@/features/workspaces/lib/stop-agents-confirm";

/**
 * Close a tab, with chat-session hygiene. Bare `layout.closeTab` never told the
 * chat store anything, which orphaned the session two ways:
 *
 * - RUNNING: the turn kept burning tokens headless (no tab = deltas dropped,
 *   Stop gone), and resuming the same acpSessionId later created a duplicate
 *   store entry that hijacked the deltas from the visible tab
 *   (`findTabByAcpSession` returns the first match — the invisible orphan).
 * - IDLE: the backend session actor leaked for the process lifetime.
 *
 * So: a busy chat asks first (same dialog as workspace close) and is cancelled
 * on confirm; either way the store session + backend actor are dropped WITH the
 * tab. Non-chat tabs close exactly as before.
 */
export function requestCloseTab(tabId: string): void {
  const layout = useLayoutStore.getState();
  const tab = layout.tabs.find((t) => t.id === tabId);
  if (!tab || !tab.closable) return;
  if (tab.type !== "chat") {
    layout.actions.closeTab(tabId);
    return;
  }

  const s = useChatStore.getState().sessions[tabId];
  if (s && isBusyAgentStatus(s.status)) {
    void (async () => {
      const ok = await useStopAgentsConfirmStore.getState().actions.ask({
        count: 1,
        actionLabel: "Closing this chat",
        confirmLabel: "Stop agent & close",
      });
      if (!ok) return;
      if (s.acpAgentId && s.acpSessionId) {
        await agents
          .cancel({ agent_id: s.acpAgentId, session_id: s.acpSessionId })
          .catch(() => {});
      }
      finishClose(tabId);
    })();
    return;
  }
  finishClose(tabId);
}

function finishClose(tabId: string): void {
  const chat = useChatStore.getState();
  const s = chat.sessions[tabId];
  if (s) {
    if (s.acpSessionId) {
      chat.actions.clearPermissionsForSession(s.acpSessionId);
    }
    chat.actions.removeSession(tabId);
    // The closed chat's live row was the sidebar's only handle on it — re-list
    // from disk so it lands in history instead of vanishing.
    if (s.workingDirectory) {
      void emit("atlas:sessions-changed", { cwd: s.workingDirectory });
    }
  }
  useLayoutStore.getState().actions.closeTab(tabId);
}

import { emit } from "@tauri-apps/api/event";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useTerminalStore } from "@/features/terminal/stores/terminal-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { agents } from "./agents-api";
import { forgetQueueHolds } from "./turn-queue";
import { useRcStore } from "@/features/chat/stores/rc-store";
import { clearSessionAttention } from "@/features/notifications/lib/agent-notifier";
import { isBusyAgentStatus } from "@/types/agent";
import { useStopAgentsConfirmStore } from "@/features/projects/lib/stop-agents-confirm";
import {
  confirmCloseFileTab,
  filePathOf,
  releaseFileBuffer,
} from "@/features/editor/lib/dirty-close";

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
 * So: a busy chat asks first (same dialog as project close) and is cancelled
 * on confirm; either way the store session + backend actor are dropped WITH the
 * tab — unless the session is held, in which case Rust keeps it running and
 * only the tab goes. Non-chat tabs close exactly as before.
 */
export function requestCloseTab(tabId: string): void {
  const layout = useLayoutStore.getState();
  const tab = layout.tabs.find((t) => t.id === tabId);
  if (!tab || !tab.closable) return;
  if (tab.type === "editor") {
    const close = () => {
      useLayoutStore.getState().actions.closeTab(tabId);
      releaseFileBuffer(filePathOf(tab), useLayoutStore.getState().tabs);
    };
    // A clean tab closes at once (`ui_close` reads the result synchronously);
    // unsaved edits ask first, see `dirty-close.ts`.
    if (!tab.dirty) {
      close();
      return;
    }
    void confirmCloseFileTab(tab).then((ok) => ok && close());
    return;
  }
  if (tab.type !== "chat") {
    layout.actions.closeTab(tabId);
    // A terminal tab's pane tree (and any command still queued for one of its
    // terminals) used to outlive the tab for ever. Dropping it here is also
    // what closes the shells: the session registry sweeps sessions whose
    // terminal id has left the store.
    if (tab.type === "terminal") useTerminalStore.getState().actions.removeTabs([tabId]);
    return;
  }

  const s = useChatStore.getState().sessions[tabId];
  // A held session (Universal RC, or the developer toggle) keeps running past
  // its tab: Rust's drop honours the hold, so there is nothing to stop and
  // nothing to ask. Reopening the thread rebinds to it.
  if (s && isBusyAgentStatus(s.status) && !s.held) {
    void (async () => {
      const ok = await useStopAgentsConfirmStore.getState().actions.ask({
        count: 1,
        actionLabel: "Closing this session",
        confirmLabel: "Stop agent & close",
      });
      if (!ok) return;
      if (s.acpAgentId && s.acpSessionId) {
        await agents.cancel({ agent_id: s.acpAgentId, session_id: s.acpSessionId }).catch(() => {});
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
      clearSessionAttention(s.acpSessionId);
      // An ended room stays in the mirror so the title-bar pill can say why it ended;
      // with the tab gone there is no header, and a thread reopened later
      // would wear a stale "Ended" pill. A live room stays: Rust still hosts it.
      const room = useRcStore.getState().bySession[s.acpSessionId];
      if (room?.state === "ended") useRcStore.getState().actions.forget(s.acpSessionId);
    }
    chat.actions.removeSession(tabId);
    forgetQueueHolds(tabId);
    // The closed chat's live row was the sidebar's only handle on it — re-list
    // from disk so it lands in history instead of vanishing.
    if (s.workingDirectory) {
      void emit("atlas:sessions-changed", { cwd: s.workingDirectory });
    }
  }
  useLayoutStore.getState().actions.closeTab(tabId);
}

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { agents } from "@/features/chat/lib/agents-api";
import { isBusyAgentStatus, type ChatSession } from "@/types/agent";

/**
 * Confirm-before-killing-agents flow, shared by the org switcher and workspace
 * close. Destructive context switches must never silently stop running agents
 * (the whole product is many agents working concurrently) — so callers ask the
 * user first, and on confirm CANCEL the live turns before tearing sessions
 * down. Cancelling first matters: `agents_drop_session` alone removes the
 * actor but never tells the adapter subprocess, which would keep editing files
 * headless.
 */

export interface StopAgentsPrompt {
  /** Number of running/waiting sessions the action would stop. */
  count: number;
  /** e.g. "Switching organisations" / "Closing this workspace". */
  actionLabel: string;
  /** Confirm button, e.g. "Stop agents & switch". */
  confirmLabel: string;
}

interface StopAgentsConfirmState {
  pending: (StopAgentsPrompt & { resolve: (ok: boolean) => void }) | null;
  actions: {
    ask: (prompt: StopAgentsPrompt) => Promise<boolean>;
    settle: (ok: boolean) => void;
  };
}

const useStopAgentsConfirmStoreBase = create<StopAgentsConfirmState>((set, get) => ({
  pending: null,
  actions: {
    ask: (prompt) =>
      new Promise<boolean>((resolve) => {
        // A newer ask supersedes an unanswered one — decline the old caller
        // so its promise never dangles.
        get().pending?.resolve(false);
        set({ pending: { ...prompt, resolve } });
      }),
    settle: (ok) => {
      const p = get().pending;
      if (!p) return;
      set({ pending: null });
      p.resolve(ok);
    },
  },
}));

export const useStopAgentsConfirmStore = createSelectors(useStopAgentsConfirmStoreBase);

/** Busy (running or permission-waiting) sessions, optionally scoped to one
 *  workspace path. */
export function busySessions(path?: string): ChatSession[] {
  return Object.values(useChatStore.getState().sessions).filter(
    (s) => isBusyAgentStatus(s.status) && (!path || s.workingDirectory === path),
  );
}

/** Cancel every busy session's in-flight turn (scoped to `path` if given) and
 *  give the CancelNotifications a beat to reach the adapters before the caller
 *  drops the sessions. Best-effort — a failed cancel must not block teardown. */
export async function cancelBusySessions(path?: string): Promise<void> {
  const cancels = busySessions(path)
    .filter((s) => s.acpAgentId && s.acpSessionId)
    .map((s) => agents.cancel({ agent_id: s.acpAgentId!, session_id: s.acpSessionId! }));
  if (!cancels.length) return;
  await Promise.allSettled(cancels);
  await new Promise((r) => setTimeout(r, 250));
}

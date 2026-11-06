/**
 * Developer toggle for session holds (Universal RC groundwork).
 *
 * A held session keeps running when its tab closes or its project leaves the
 * hot set; reopening the thread rebinds to it and hydrates from its snapshot.
 * The real holder is the RC layer, in Rust (`AgentHost::hold_session`); this
 * is how to try it before that exists. From the devtools console:
 *
 *   __atlasDev.holdSession("<tab id>", true)   // or false to release
 *   __atlasDev.holdActiveSession(true)
 *
 * Installed in development builds only, and the command it calls refuses in a
 * release build anyway.
 */
import { useChatStore } from "../stores/chat-store";
import { agents } from "./agents-api";

async function holdSession(tabId: string, held: boolean): Promise<void> {
  const session = useChatStore.getState().sessions[tabId];
  if (!session?.acpSessionId) throw new Error(`tab ${tabId} has no live session`);
  await agents.setHold(session.acpSessionId, held);
}

export function installDevSessionHold(): void {
  const target = window as unknown as {
    __atlasDev?: Record<string, unknown>;
  };
  target.__atlasDev = {
    ...target.__atlasDev,
    holdSession,
    holdActiveSession: (held: boolean) => {
      const tabId = useChatStore.getState().activeSessionId;
      if (!tabId) throw new Error("no active chat tab");
      return holdSession(tabId, held);
    },
  };
}

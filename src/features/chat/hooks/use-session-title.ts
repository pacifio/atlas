import { useThreadHistory } from "@/features/session-context/lib/session-lineage";
import { sessionDisplayTitle } from "../lib/session-title";
import { UNTITLED_SESSION, useChatStore } from "../stores/chat-store";

/** Rust's combined title includes the user's permanent override. The local
 *  first-message title covers the interval before the history row arrives.
 *  A saved tab can supply its title until its store session exists. */
export function useSessionTitle(tabId: string, fallbackTitle = UNTITLED_SESSION): string {
  const sessionId = useChatStore((s) => s.sessions[tabId]?.acpSessionId);
  const localTitle = useChatStore((s) => {
    const session = s.sessions[tabId];
    return session ? sessionDisplayTitle(session.title, session.firstUserContent) : fallbackTitle;
  });
  const rows = useThreadHistory(!!sessionId);
  return rows.find((row) => row.sessionId === sessionId)?.title ?? localTitle;
}

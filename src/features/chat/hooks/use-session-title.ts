import { useThreadHistory } from "@/features/session-context/lib/session-lineage";
import { sessionDisplayTitle } from "../lib/session-title";
import { useChatStore } from "../stores/chat-store";

/** Rust's combined title includes the user's permanent override. The local
 *  first-message title covers the interval before the history row arrives. */
export function useSessionTitle(tabId: string): string {
  const sessionId = useChatStore((s) => s.sessions[tabId]?.acpSessionId);
  const localTitle = useChatStore((s) => {
    const session = s.sessions[tabId];
    return sessionDisplayTitle(session?.title, session?.firstUserContent);
  });
  const rows = useThreadHistory(!!sessionId);
  return rows.find((row) => row.sessionId === sessionId)?.title ?? localTitle;
}

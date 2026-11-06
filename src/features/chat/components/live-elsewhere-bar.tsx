import { TerminalSquare } from "lucide-react";
import { useChatStore } from "../stores/chat-store";
import { useLiveElsewhereStore, useSendHeldForTerminal } from "../stores/live-elsewhere-store";
import { useStripHidden } from "./composer-strip-close";
import { ChatNoticeView } from "./views/chat-notice-view";

/**
 * This session is still being written by another process, usually `claude` in a
 * terminal. A second writer would fork the transcript, so sending from here is
 * held until the user says they mean it (ADR-0001 amendment, Rule 7). Same
 * strip as the other composer notices. It clears by itself once the session
 * stops being live.
 */
export function LiveElsewhereBar({ tabId }: { tabId: string }) {
  const sessionId = useChatStore((s) => s.sessions[tabId]?.acpSessionId);
  const held = useSendHeldForTerminal(sessionId);
  const sendAnyway = useLiveElsewhereStore.use.actions().sendAnyway;
  // Hiding the notice does not release the hold: a send still waits until
  // the session stops being live, or for "Send anyway" — hidden, that wait
  // has no explanation on screen, which is the user's call to make.
  const [hidden, hide] = useStripHidden(sessionId);
  if (!held || !sessionId || hidden) return null;

  return (
    <ChatNoticeView
      placement="tucked"
      tone="warning"
      icon={TerminalSquare}
      data-testid="live-elsewhere-bar"
      live
      action={{ label: "Send anyway", onClick: () => sendAnyway(sessionId) }}
      onDismiss={hide}
    >
      This session is active in another process (likely a terminal). Sending here will fork it.
    </ChatNoticeView>
  );
}

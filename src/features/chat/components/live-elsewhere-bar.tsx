import { TerminalSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { useChatStore } from "../stores/chat-store";
import { useLiveElsewhereStore, useSendHeldForTerminal } from "../stores/live-elsewhere-store";
import { COMPOSER_STRIP, COMPOSER_STRIP_ACTION } from "./composer-strip";

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
  if (!held || !sessionId) return null;

  return (
    <div data-testid="live-elsewhere-bar" role="status" className={COMPOSER_STRIP}>
      <span className="flex min-w-0 items-center gap-1.5">
        <TerminalSquare
          size={11}
          className="shrink-0 text-[var(--atlas-status-warning-foreground)]"
        />
        <span className="min-w-0 truncate text-[var(--muted-foreground)]">
          This session is active in another process (likely a terminal). Sending here will fork it.
        </span>
      </span>
      <button
        type="button"
        onClick={() => sendAnyway(sessionId)}
        className={cn(COMPOSER_STRIP_ACTION, "cursor-pointer")}
      >
        Send anyway
      </button>
    </div>
  );
}

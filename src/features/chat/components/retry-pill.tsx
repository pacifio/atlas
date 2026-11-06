import { useEffect, useState } from "react";
import { useChatStore } from "../stores/chat-store";
import { ChatNoticeView } from "./views/chat-notice-view";

/**
 * Live retry countdown (native agent): shown while a transient provider
 * failure (rate limit / overload / 5xx) is being retried after a backoff.
 * Driven by the `retry_status` delta; clears itself when content resumes
 * flowing or the turn ends (the store owns clearing — this only renders).
 */
export function RetryPill({ tabId }: { tabId: string }) {
  const retry = useChatStore((s) => s.sessions[tabId]?.retryStatus);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!retry) return;
    // 1s, not 250ms: the label renders whole seconds, so three of every four
    // ticks were re-rendering the pill to the identical string. And no tick
    // at all while hidden — `now` re-seeds on the visibility edge.
    const tick = () => {
      if (document.visibilityState === "visible") setNow(Date.now());
    };
    const t = setInterval(tick, 1_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [retry]);

  if (!retry) return null;

  const remainingMs = Math.max(0, retry.receivedAt + retry.delayMs - now);
  const secs = Math.ceil(remainingMs / 1000);
  // Terse cause: first line of the provider error, without the JSON tail.
  const cause = retry.lastError.split("\n")[0].slice(0, 80);

  return (
    <ChatNoticeView placement="above" busy data-testid="retry-pill" title={retry.lastError}>
      {/* One line: the cause truncates rather than wrapping the card taller
          while the countdown ticks. */}
      <span className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 font-medium text-foreground">
          Retrying {retry.attempt}/{retry.maxAttempts}
          {secs > 0 ? ` in ${secs}s` : "…"}
        </span>
        <span className="truncate text-muted-foreground">{cause}</span>
      </span>
    </ChatNoticeView>
  );
}

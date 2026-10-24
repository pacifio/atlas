import { MoonStar } from "lucide-react";
import { isBusyAgentStatus } from "@/types/agent";
import { useChatStore } from "../stores/chat-store";
import { wokePillLabel } from "../lib/interruption-copy";

/**
 * The moment after waking, while the turn the computer slept through is still
 * going: "Woke after 21m · picking the reply back up". It answers the one
 * question the user has on opening the lid — is it still working? — and goes
 * when the turn ends, when the same fact settles into the transcript as the
 * turn's interruption row.
 *
 * Driven by `sleptMidTurn`, which the store clears at the turn's terminal; this
 * only renders. The same frame as `RetryPill`, which it sits beside, so the
 * two read as one family of live turn status. It enters with `atlas-pill-in`
 * (a rare, one-off event, so it earns a short ease-out rise; reduced motion
 * keeps only the fade) and leaves without a transition — by then the row has
 * taken over, and a fading pill would be two places saying one thing.
 */
export function SleepPill({ tabId }: { tabId: string }) {
  const slept = useChatStore((s) => {
    const session = s.sessions[tabId];
    if (!session?.sleptMidTurn || !isBusyAgentStatus(session.status)) return undefined;
    return session.sleptMidTurn.sleptSecs;
  });
  if (slept === undefined) return null;

  return (
    <div
      data-testid="sleep-pill"
      role="status"
      className="atlas-pill-in mb-2 flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] text-xs text-[var(--secondary-foreground)]"
    >
      <MoonStar size={12} className="shrink-0 text-[var(--atlas-status-warning-foreground)]" />
      <span className="font-medium text-[var(--foreground)]">{wokePillLabel(slept)}</span>
      <span className="truncate text-[var(--muted-foreground)]">picking the reply back up</span>
    </div>
  );
}

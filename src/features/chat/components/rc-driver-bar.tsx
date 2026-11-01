import { useCallback, useState } from "react";
import { Hand, RadioTower } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useChatStore } from "../stores/chat-store";
import { useRcRoom } from "../stores/rc-store";
import { errInfo } from "../lib/agent-signin";
import { drivenElsewhere, driverLabel, rc, roomOpen } from "../lib/rc-api";
import { COMPOSER_STRIP, COMPOSER_STRIP_ACTION } from "./composer-strip";

/**
 * Universal RC's seat, explained at the composer (R4: one person prompts at
 * a time). Two notices, same strip as the other composer notices:
 *
 * - someone else is driving: the input below cannot send (the steering entry
 *   refuses it too, so this is the explanation, not the lock), and the one
 *   way out is right here — Take over;
 * - a visitor asks to drive: Allow hands them the seat, Decline keeps it.
 *
 * No ✕: the first clears when the seat comes back, the second when the
 * request is answered or times out. Hiding either would leave a locked input
 * with no explanation.
 *
 * Every action here is a call into Rust that can be refused (the room went
 * offline, the request expired, the seat moved): the refusal is said in a
 * toast, and the button is held until the answer so a double click is not
 * two frames.
 */
export function RcDriverBar({ tabId }: { tabId: string }) {
  const sessionId = useChatStore((s) => s.sessions[tabId]?.acpSessionId);
  const room = useRcRoom(sessionId);
  const driver = drivenElsewhere(room);
  const request = roomOpen(room) ? room.pending[0] : undefined;
  const more = roomOpen(room) ? room.pending.length - 1 : 0;
  const [busy, setBusy] = useState(false);
  const run = useCallback((call: Promise<void>) => {
    setBusy(true);
    call.catch((e) => toast.error(errInfo(e).message)).finally(() => setBusy(false));
  }, []);
  if (!sessionId || (!driver && !request)) return null;

  if (driver) {
    return (
      <div data-testid="rc-driver-bar" role="status" className={COMPOSER_STRIP}>
        <span className="flex min-w-0 items-center gap-1.5">
          <RadioTower
            size={11}
            className="shrink-0 text-[var(--atlas-status-warning-foreground)]"
          />
          <span className="min-w-0 truncate">
            <span className="font-semibold text-[var(--foreground)]">{driverLabel(driver)}</span>
            <span className="text-[var(--muted-foreground)]">
              {driver.lost
                ? " is driving from remote control (reconnecting) · only they can prompt"
                : " is driving from remote control · only they can prompt"}
            </span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => run(rc.takeOver(sessionId))}
            title="Take the seat back; only you can prompt again"
            className={cn(COMPOSER_STRIP_ACTION, "cursor-pointer disabled:opacity-50")}
          >
            <Hand size={11} />
            Take over
          </button>
        </span>
      </div>
    );
  }

  if (!request) return null;
  return (
    <div data-testid="rc-request-bar" role="status" className={COMPOSER_STRIP}>
      <span className="flex min-w-0 items-center gap-1.5">
        <Hand size={11} className="shrink-0 text-[var(--atlas-status-warning-foreground)]" />
        <span className="min-w-0 truncate">
          <span className="font-semibold text-[var(--foreground)]">{driverLabel(request)}</span>
          <span className="text-[var(--muted-foreground)]">
            {" "}
            asks to drive · while they do, only they can prompt
            {more > 0 ? ` · ${more} more waiting` : ""}
          </span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => run(rc.answerControl(sessionId, request.requestId, true))}
          title="Hand them the seat"
          className={cn(COMPOSER_STRIP_ACTION, "cursor-pointer disabled:opacity-50")}
        >
          Allow
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => run(rc.answerControl(sessionId, request.requestId, false))}
          title="Keep the seat"
          className={cn(COMPOSER_STRIP_ACTION, "cursor-pointer disabled:opacity-50")}
        >
          Decline
        </button>
      </span>
    </div>
  );
}

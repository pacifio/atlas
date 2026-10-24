import { memo, useState } from "react";
import { ChevronRight, CornerDownRight, MoonStar, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { CONTENT_COLUMN } from "../lib/row-metrics";
import { CONTINUE_AFTER_SLEEP, interruptionHeadline } from "../lib/interruption-copy";
import { retryLastTurn } from "../lib/retry-turn";
import type { InterruptionRow } from "../lib/turn-rows";
import { ICON_PX, ICON_STROKE } from "./tool-glyph";

/**
 * A turn something outside the conversation cut into — today, the computer
 * sleeping mid-reply (`TurnInterruption`).
 *
 * One quiet line in the footer's register, under the turn: the reply stays the
 * loudest thing on screen, and this says only what happened to it. The moon is
 * the one coloured mark, in the warning token — it is a caution about the
 * reply, not an error the user caused. The agent's own error, when there is
 * one, is folded behind Details: it is for diagnosis, not the headline.
 *
 * No entrance animation. Rows remount as the virtualizer scrolls them in and
 * out, so a fade here would replay every time the turn came back into view;
 * the live moment already has its motion in the composer pill
 * (`sleep-pill.tsx`).
 *
 * Retry and Continue appear on the latest turn only, since both act on the
 * thread's last reply. Retry is the existing rewind (`retryLastTurn`) and so
 * only appears where the agent can rewind; Continue is an ordinary message,
 * sent through `atlas:chat-send` like a suggestion chip, so every agent gets it.
 */
export const InterruptionRowView = memo(function InterruptionRowView({
  row,
  tabId,
  canRetry,
  canContinue,
}: {
  row: InterruptionRow;
  tabId: string;
  canRetry: boolean;
  canContinue: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { interruption } = row;
  const headline = interruptionHeadline(interruption);
  const showRetry = row.latest && canRetry;
  const showContinue = row.latest && canContinue;

  return (
    <div data-testid="interruption-row" className={cn(CONTENT_COLUMN, "pt-1 pb-4")}>
      <div className="flex min-h-[26px] items-center gap-2 text-base text-[var(--muted-foreground)]">
        <span className="flex w-4 shrink-0 justify-center text-[var(--atlas-status-warning-foreground)]">
          <MoonStar size={ICON_PX} strokeWidth={ICON_STROKE} />
        </span>
        {/* Not `flex-1`: the actions follow the sentence they answer rather
            than sitting a column's width away from it. */}
        <span className="min-w-0 truncate" title={headline}>
          {headline}
        </span>
        {interruption.error && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="ml-1 flex shrink-0 cursor-pointer items-center gap-0.5 text-xs transition-colors hover:text-[var(--secondary-foreground)]"
          >
            Details
            <ChevronRight
              size={ICON_PX}
              strokeWidth={ICON_STROKE}
              className={cn("shrink-0 transition-transform", open && "rotate-90")}
            />
          </button>
        )}
        {(showRetry || showContinue) && (
          <span className="flex shrink-0 items-center gap-1">
            {showContinue && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent("atlas:chat-send", {
                      detail: { tabId, text: CONTINUE_AFTER_SLEEP },
                    }),
                  )
                }
              >
                <CornerDownRight size={ICON_PX} strokeWidth={ICON_STROKE} />
                Continue
              </Button>
            )}
            {showRetry && (
              <Button variant="ghost" size="xs" onClick={() => void retryLastTurn(tabId)}>
                <RotateCcw size={ICON_PX} strokeWidth={ICON_STROKE} />
                Retry
              </Button>
            )}
          </span>
        )}
      </div>
      {open && interruption.error && (
        <p className="mt-1 ml-6 font-mono text-2xs break-words whitespace-pre-wrap text-[var(--muted-foreground)]">
          {interruption.error}
        </p>
      )}
    </div>
  );
});

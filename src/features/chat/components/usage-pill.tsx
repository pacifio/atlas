import { memo } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSessionUsage } from "../lib/use-session-usage";
import { ComposerDropup, composerPillClass, useComposerDropup } from "./composer-dropup";
import { UsageRing } from "./usage-meter";
import { UsagePopup } from "./usage-popup";

/**
 * The Usage pill — the one place a session's consumption is shown, for
 * every agent.
 *
 * Sits first in the composer footer's right cluster (`[Usage] [Options]
 * [Plan]`) as its own right-anchored dropup. The pill itself reads the most
 * useful single number it has: the context window's fill as a percentage
 * with a ring (any agent that reports a gauge), else total tokens (an agent
 * that reports a split but no window), else just "Usage". While the agent
 * compacts its context the pill says so, which is what the native agent's
 * old tok/cost pill used to do.
 *
 * The leading glyph is always the 12 px context ring — filled from used /
 * window, dashed when the agent does not report a limit — so a mid-run
 * gauge tick cannot swap it for the old speedometer icon and shove the
 * footer. Token and price detail lives in the popup, unchanged.
 *
 * It replaces the status-bar usage widget and the native agent's composer
 * pill, both of which rendered the persisted input/output split and read as
 * "0 tokens · $0.0000" for every ACP session — the protocol never sends
 * that split mid-turn, and the end-of-turn one was dropped before it got
 * here. See `use-session-usage.ts` for what feeds this now.
 */
export const UsagePill = memo(function UsagePill({ tabId }: { tabId: string }) {
  const { open, toggle, ref, contentRef, panelHeight } = useComposerDropup("usage");
  const view = useSessionUsage(tabId, open);
  const { pill } = view;

  const tint =
    pill.tint === "error"
      ? "text-[var(--status-error)]"
      : pill.tint === "warn"
        ? "text-[var(--status-warning)]"
        : pill.state === "compacting"
          ? "text-[var(--accent-primary)]"
          : "text-[var(--text-tertiary)]";

  return (
    <div ref={ref} className="relative">
      <ComposerDropup open={open} panelHeight={panelHeight} contentRef={contentRef}>
        {/* Mounted only while open so the stagger replays and nothing animates
            under a `height: 0` panel. */}
        {open ? <UsagePopup view={view} /> : null}
      </ComposerDropup>

      <button
        onClick={toggle}
        className={composerPillClass(open)}
        title={pill.hint}
        aria-label={pill.hint}
        data-usage-state={pill.state}
      >
        {/* Keyed on state, not the percentage: a 42% → 43% tick during a run
            must not remount and replay the swap animation. */}
        <span key={pill.state} className="atlas-pill-swap flex items-center">
          <span className={cn("flex h-3 w-3 shrink-0 items-center justify-center", tint)}>
            <UsageRing
              frac={pill.ringFrac}
              className={pill.state === "compacting" ? "animate-pulse" : undefined}
            />
          </span>
          <span
            className={cn(
              "ml-1.5 whitespace-nowrap tabular-nums",
              // 4ch holds "100%" so 9% → 42% → 100% cannot grow the pill.
              pill.state === "context" && "inline-block min-w-[4ch] text-right",
              pill.tint !== "none" && tint,
              pill.state === "compacting" && tint,
            )}
          >
            {pill.label}
          </span>
          <ChevronDown size={10} className="ml-0.5 shrink-0 text-[var(--text-tertiary)]" />
        </span>
      </button>
    </div>
  );
});

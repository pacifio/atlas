import { memo } from "react";
import { ChevronDown, Gauge } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSessionUsage } from "../lib/use-session-usage";
import {
  ComposerDropup,
  composerPillClass,
  composerPillLabelClass,
  useComposerDropup,
} from "./composer-dropup";
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
      ? "text-error"
      : pill.tint === "warn"
        ? "text-warning"
        : pill.state === "compacting"
          ? "text-primary"
          : "text-muted-foreground";

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
        title="Session usage — context, tokens, cost and what Atlas recorded"
        data-usage-state={pill.state}
      >
        <span key={pill.state} className="atlas-pill-swap flex items-center">
          <span className={cn("flex shrink-0 items-center", tint)}>
            {pill.state === "compacting" ? (
              <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
            ) : pill.ringFrac !== null ? (
              <UsageRing frac={pill.ringFrac} />
            ) : (
              <Gauge size={11} />
            )}
          </span>
          <span
            className={cn(
              composerPillLabelClass("early"),
              "tabular-nums",
              pill.tint !== "none" && tint,
              pill.state === "compacting" && tint,
            )}
          >
            {pill.label}
          </span>
          <ChevronDown size={10} className="ml-0.5 shrink-0 text-muted-foreground" />
        </span>
      </button>
    </div>
  );
});

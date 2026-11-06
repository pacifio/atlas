import { ChevronDown, Gauge } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionUsageView } from "../../lib/session-usage";
import { composerPillClass, composerPillLabelClass } from "../../lib/composer-pill-class";
import { UsageRing } from "../usage-meter";

/**
 * The Usage pill's trigger, drawn from the session's usage view: the context
 * ring (or a gauge, or the compacting pulse) and the most useful single
 * number. `usage-pill.tsx` owns the dropup and the data.
 */
export function UsagePillTriggerView({
  pill,
  open,
  onToggle,
}: {
  pill: SessionUsageView["pill"];
  open: boolean;
  onToggle: () => void;
}) {
  const tint =
    pill.tint === "error"
      ? "text-error"
      : pill.tint === "warn"
        ? "text-warning"
        : pill.state === "compacting"
          ? "text-primary"
          : "text-muted-foreground";

  return (
    <button
      type="button"
      onClick={onToggle}
      className={composerPillClass(open)}
      title="Session usage — context, tokens, cost and what Atlas recorded"
      data-usage-state={pill.state}
    >
      <span key={pill.state} className="atlas-pill-swap flex items-center">
        <span className={cn("flex shrink-0 items-center", tint)}>
          {pill.state === "compacting" ? (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
          ) : pill.ringFrac !== null ? (
            <UsageRing frac={pill.ringFrac} />
          ) : (
            <Gauge size={11} />
          )}
        </span>
        <span
          className={cn(
            composerPillLabelClass("early"),
            "tnum",
            (pill.tint !== "none" || pill.state === "compacting") && tint,
          )}
        >
          {pill.label}
        </span>
        <ChevronDown size={10} className="ml-0.5 shrink-0 text-muted-foreground" />
      </span>
    </button>
  );
}

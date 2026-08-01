/**
 * How capture state reads on a trigger.
 *
 * Lives here rather than in the Timeline board because capture is per project
 * while the board spans every project in the Organisation — the state belongs
 * next to the thing that names one project, which is the titlebar pill.
 */

import type { Binding, CaptureHealth } from "../types";
import { cn } from "@/lib/utils";

export function StatusDot({
  binding,
  health,
}: {
  binding: Binding | null;
  health: CaptureHealth | null;
}) {
  const tone =
    health?.state === "stopped"
      ? "bg-[var(--status-error)]"
      : health?.state === "degraded"
        ? "bg-[var(--status-warning)]"
        : binding?.enabled
          ? "bg-[var(--status-info)]"
          : "bg-[var(--text-ghost)]";
  return <span className={cn("size-1.5 shrink-0 rounded-full", tone)} />;
}

/**
 * One line of capture truth.
 *
 * Stopped and degraded are different sentences, not different dot colours:
 * "capture stopped" means data is being lost now, "needs review" means work
 * continues. The degraded label is `health.summary` because the backend already
 * formats the count and reason better than a recomputation here would.
 */
export function statusLabel(
  binding: Binding | null,
  health: CaptureHealth | null,
): string {
  if (health?.state === "stopped") return "Capture stopped";
  if (health?.state === "degraded") return health.summary || "Needs review";
  if (!binding) return "Off";
  if (!binding.enabled) return "Paused";
  if (binding.mode === "cloud" && !binding.importApproved)
    return "Cloud · import waiting";
  const mode = binding.mode === "cloud" ? "Cloud" : "Local";
  const pending = health?.pendingRows ?? 0;
  if (pending > 0) return `${mode} · ${pending} pending`;
  return `Capturing · ${mode}`;
}

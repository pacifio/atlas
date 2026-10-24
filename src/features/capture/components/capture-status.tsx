/**
 * How capture state reads on a trigger.
 *
 * Lives here rather than in the Timeline board because capture is per project
 * while the board spans every project in the Organisation — the state belongs
 * next to the thing that names one project, which is the titlebar pill.
 */

import type { Binding, CaptureHealth } from "../types";
import { cn } from "@/lib/utils";

/**
 * The recording dot: green while capture is live.
 *
 * A steady dot, not a pulsing one: capture is often on for hours, and a
 * blinking light in the bar for all of that time pulls the eye every time it
 * moves. Green means capturing; it is there to be checked, not to call out.
 *
 * The wrapper is a fixed-size grid cell, which is what keeps it on the text
 * baseline's centre line.
 */
export function CaptureDot({
  tone = "success",
}: {
  tone?: "success" | "warning" | "error" | "idle";
}) {
  const color =
    tone === "error"
      ? "var(--atlas-status-error-foreground)"
      : tone === "warning"
        ? "var(--atlas-status-warning-foreground)"
        : tone === "idle"
          ? "var(--atlas-text-disabled)"
          : "var(--atlas-status-success-foreground)";

  return (
    <span className="relative grid size-[10px] shrink-0 place-items-center" aria-hidden>
      <span className="relative size-[5px] rounded-full" style={{ backgroundColor: color }} />
    </span>
  );
}

/**
 * The titlebar dot. Green while capturing; a fault keeps its own colour, since
 * painting a stopped recorder green would be the one lie this indicator cannot
 * afford.
 */
export function StatusDot({
  binding,
  health,
}: {
  binding: Binding | null;
  health: CaptureHealth | null;
}) {
  const tone =
    health?.state === "stopped"
      ? "error"
      : health?.state === "degraded"
        ? "warning"
        : binding?.enabled
          ? "success"
          : "idle";

  return (
    <span className={cn("flex items-center", tone === "idle" && "opacity-70")}>
      <CaptureDot tone={tone} />
    </span>
  );
}

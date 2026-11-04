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
 * The recording dot: the success tone while capture is live.
 *
 * A steady dot, not a pulsing one: capture is often on for hours, and a
 * blinking light in the bar for all of that time pulls the eye every time it
 * moves. It is there to be checked, not to call out.
 *
 * The shape carries the state as well as the tone, so it reads without
 * colour: a solid dot is a recorder that is on (capturing, or faulted in the
 * warning or error tone), a hollow ring is one that is not (neutral).
 *
 * The wrapper is a fixed-size grid cell, which is what keeps it on the text
 * baseline's centre line.
 */
export function CaptureDot({
  tone = "success",
  label,
}: {
  /** `idle` is the older name for `neutral`. */
  tone?: "success" | "warning" | "error" | "neutral" | "idle";
  /** Read by screen readers; without one the dot is decorative. */
  label?: string;
}) {
  return (
    <span className="relative grid size-2.5 shrink-0 place-items-center" aria-hidden={!label}>
      <span
        className={cn(
          "relative size-1.5 rounded-full",
          tone === "error"
            ? "bg-error"
            : tone === "warning"
              ? "bg-warning"
              : tone === "neutral" || tone === "idle"
                ? "border border-current bg-transparent text-disabled"
                : "bg-success",
        )}
      />
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}

/**
 * The titlebar dot. The success tone while capturing; a fault keeps its own
 * tone, since painting a stopped recorder green would be the one lie this
 * indicator cannot afford.
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
          : "neutral";

  return (
    <span className={cn("flex items-center", tone === "neutral" && "opacity-70")}>
      <CaptureDot tone={tone} />
    </span>
  );
}

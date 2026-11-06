/**
 * How capture state reads on a trigger.
 *
 * Lives here rather than in the Timeline board because capture is per project
 * while the board spans every project in the Organisation — the state belongs
 * next to the thing that names one project, which is the titlebar pill.
 */

import type { Binding, CaptureHealth } from "../types";
import { cn } from "@/lib/utils";
import { captureIndicator } from "../lib/capture-indicator";

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
}: {
  tone?: "success" | "warning" | "error" | "neutral";
}) {
  return (
    <span className="relative grid size-2.5 shrink-0 place-items-center" aria-hidden>
      <span
        className={cn(
          "relative size-1.5 rounded-full",
          tone === "error"
            ? "bg-error"
            : tone === "warning"
              ? "bg-warning"
              : tone === "neutral"
                ? "border border-current bg-transparent text-disabled"
                : "bg-success",
        )}
      />
    </span>
  );
}

/**
 * The titlebar dot. The success tone while capturing; a fault keeps its own
 * tone, since painting a stopped recorder green would be the one lie this
 * indicator cannot afford. The tone is `captureIndicator`'s, the model the
 * popover radar's label reads too.
 */
export function StatusDot({
  binding,
  health,
}: {
  binding: Binding | null;
  health: CaptureHealth | null;
}) {
  const { tone } = captureIndicator(binding, health);

  return (
    <span className={cn("flex items-center", tone === "neutral" && "opacity-70")}>
      <CaptureDot tone={tone} />
    </span>
  );
}

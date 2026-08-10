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
 * The recording dot: a small green pulse while capture is live.
 *
 * Green and *moving* is the whole signal — a static coloured dot in a titlebar
 * reads as a status LED nobody looks at twice, and the point of this one is to
 * be noticed once and then ignored. The pulse is a second ring behind the dot
 * rather than an opacity animation on the dot itself, so the core stays at full
 * strength and only the halo breathes; a fading dot looks like a rendering bug.
 *
 * The wrapper is a fixed-size grid cell, which is what keeps it on the text
 * baseline's centre line: sizing the ring off the dot made the flex line box
 * taller than the dot and pushed it visibly off-centre.
 */
export function CaptureDot({
  live,
  tone = "success",
}: {
  /** Pulsing only while capture is actually running. */
  live: boolean;
  tone?: "success" | "warning" | "error" | "idle";
}) {
  const color =
    tone === "error"
      ? "var(--status-error)"
      : tone === "warning"
        ? "var(--status-warning)"
        : tone === "idle"
          ? "var(--text-ghost)"
          : "var(--capture-live)";

  return (
    <span className="relative grid size-[10px] shrink-0 place-items-center" aria-hidden>
      {live && (
        <span
          className="absolute size-[10px] animate-ping rounded-full opacity-40"
          style={{ backgroundColor: color, animationDuration: "1.8s" }}
        />
      )}
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
      <CaptureDot live={!!binding?.enabled && tone === "success"} tone={tone} />
    </span>
  );
}

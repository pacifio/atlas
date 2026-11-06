import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

import type { Binding, CaptureHealth } from "../../types";
import { captureIndicator } from "../../lib/capture-indicator";
import { CaptureDot } from "../capture-status";

/**
 * Radar geometry, in px inside the box.
 *
 * Everything is polar around one origin — the dish, at the bottom centre — and
 * that is the whole reason it reads as a scope. The first version positioned
 * the rings as *percentage-width* ellipses in a 112px-tall box, so the visible
 * slice of each was nearly a straight line; the box has to be tall enough for a
 * ring's radius to fit inside it or there is no curve to see.
 */
const RADAR_HEIGHT = 176;
const RADAR_ORIGIN_X = 176; // half of the 352px panel
const RADAR_RINGS = [56, 100, 144, 188];

/** Blips sit **on** the rings, like real contacts. `deg` is from the +x axis. */
const RADAR_BLIPS = [
  { r: 100, deg: 150 },
  { r: 144, deg: 118 },
  { r: 188, deg: 45 },
  { r: 56, deg: 42 },
  { r: 144, deg: 24 },
  { r: 100, deg: 74 },
  { r: 188, deg: 143 },
] as const;

function blipAt({ r, deg }: { r: number; deg: number }) {
  const rad = (deg * Math.PI) / 180;
  return {
    left: RADAR_ORIGIN_X + r * Math.cos(rad),
    top: RADAR_HEIGHT - r * Math.sin(rad),
  };
}

/**
 * The recorder, drawn.
 *
 * A bound project's panel opens onto this instead of a title bar. It says the
 * one thing a status line said in words — *something is listening* — and says
 * it in the half-second before anyone reads a label. The sweep wobbles rather
 * than spinning: a full rotation reads as a loading spinner, which is exactly
 * the wrong idea for something that never finishes.
 *
 * Drawn in CSS (rings are `border-t` on `rounded-full` boxes centred on the
 * dish, the sweep is one rotating radial gradient) rather than as an asset, so
 * it inherits the status colours and costs nothing to ship. Only the
 * highlighted blip needs state, and it only ticks while the popover is open.
 */
export function CaptureRadar({
  binding,
  health,
}: {
  binding: Binding;
  health: CaptureHealth | null;
}) {
  // The sweep runs while the binding is on, whatever the health: a faulted
  // recorder is still switched on, and its sweep turns the fault's tone.
  const live = binding.enabled;
  // The label is the shared indicator's, the same model the titlebar dot
  // reads, so the two never disagree (a stopped project is never "Capturing").
  const indicator = captureIndicator(binding, health);
  const [blip, setBlip] = useState(0);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setBlip((n) => (n + 1) % RADAR_BLIPS.length), 2400);
    return () => clearInterval(timer);
  }, [live]);

  const tone =
    health?.state === "stopped"
      ? "var(--status-error-foreground)"
      : health?.state === "degraded"
        ? "var(--status-warning-foreground)"
        : "var(--status-success-foreground)";

  const active = blipAt(RADAR_BLIPS[blip]);

  return (
    <div
      className="relative overflow-hidden border-b border-element-hover bg-background/40"
      style={{ height: RADAR_HEIGHT }}
    >
      {/* Range rings: true circles centred on the dish. `border-t` draws only
          the upper arc, which is the half that is inside the box — a full
          border would leave two stray verticals down the left and right edges
          where the circle passes the origin's own row. */}
      {RADAR_RINGS.map((r) => (
        <span
          key={r}
          aria-hidden
          className="absolute rounded-full border-t border-dashed border-element-selected"
          style={{
            width: r * 2,
            height: r * 2,
            left: RADAR_ORIGIN_X - r,
            top: RADAR_HEIGHT - r,
          }}
        />
      ))}

      {/* The sweep, radiating from the dish. */}
      {live && (
        <span
          aria-hidden
          className="atlas-radar-sweep pointer-events-none absolute bottom-0 h-[200px] w-[200px] origin-bottom-left"
          style={{
            left: RADAR_ORIGIN_X,
            background: `radial-gradient(circle at 0% 100%, color-mix(in oklab, ${tone} 22%, transparent) 5%, transparent 62%)`,
          }}
        />
      )}

      {RADAR_BLIPS.map((b, i) => {
        const at = blipAt(b);
        return (
          <span
            key={`${b.r}-${b.deg}`}
            aria-hidden
            className={cn(
              "absolute size-[4px] rounded-full transition-colors duration-500",
              i === blip && live ? "" : "bg-foreground/20",
            )}
            style={{
              top: at.top - 2,
              left: at.left - 2,
              ...(i === blip && live
                ? {
                    backgroundColor: tone,
                    // The glow is the live capture tone, computed per render.
                    // ratchet-allow: a per-render hue has no static value to name.
                    boxShadow: `0 0 10px 3px color-mix(in oklab, ${tone} 45%, transparent)`,
                  }
                : null),
            }}
          />
        );
      })}

      {/* The pulse ring, keyed on the blip so it restarts on each hop. */}
      {live && (
        <span
          key={blip}
          aria-hidden
          className="atlas-radar-ping absolute size-[16px] rounded-full border"
          style={{ top: active.top - 8, left: active.left - 8, borderColor: tone }}
        />
      )}

      {/* The dish the sweep radiates from — a disc bisected by the bottom edge,
          so the origin of every ring is visibly a thing rather than a corner. */}
      <span
        aria-hidden
        className="absolute size-[92px] rounded-full border border-element-selected bg-card"
        style={{ left: RADAR_ORIGIN_X - 46, top: RADAR_HEIGHT - 46 }}
      />

      <span className="absolute bottom-3 left-3.5 flex items-center gap-1.5">
        <CaptureDot tone={indicator.tone} />
        <span className="eyebrow">{indicator.label}</span>
      </span>
    </div>
  );
}

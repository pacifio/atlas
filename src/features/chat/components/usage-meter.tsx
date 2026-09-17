import { cn } from "@/lib/utils";

/**
 * The Usage popup's two gauges, and the pill's context ring.
 *
 * `TickMeter` is the reference card's meter: a row of thin ticks whose colour
 * runs green → amber → red along the scale, with a marker at the current
 * value and everything past the marker dimmed. For a context window the
 * scale IS the window: 0 % on the left, the model's limit on the right, the
 * warning band starting at 80 % where the ACP thread starts warning too.
 *
 * `UsageRing` is the pill's 12 px arc. It replaced the lucide Gauge glyph:
 * the icon now *carries* the window fill it previously only labelled. Geometry
 * is fixed (no text inside) and the arc animates via `stroke-dashoffset`,
 * which is not a layout property — a value landing mid-run repaints without
 * reflowing the composer footer.
 */

const TICKS = 48;

export function TickMeter({
  value,
  ticks = TICKS,
  warnAt = 80,
  className,
}: {
  /** 0–100; values past 100 pin the marker at the end. */
  value: number;
  ticks?: number;
  /** Percent at which the ticks turn amber. */
  warnAt?: number;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("relative", className)}>
      <div className="flex h-3 items-end gap-px" aria-hidden>
        {Array.from({ length: ticks }, (_, i) => {
          const at = ((i + 0.5) / ticks) * 100;
          const lit = at <= pct;
          const color =
            at >= 100
              ? "var(--status-error)"
              : at >= warnAt
                ? "var(--status-warning)"
                : "var(--capture-live)";
          return (
            <span
              key={i}
              className="h-full w-[2px] flex-1 rounded-sm transition-opacity duration-200"
              style={{ background: color, opacity: lit ? 1 : 0.22 }}
            />
          );
        })}
      </div>
      {/* The marker: a hairline at the value, moving with it. */}
      <span
        className="pointer-events-none absolute -top-0.5 h-4 w-px bg-[var(--text-primary)]"
        style={{ left: `${pct}%`, transition: "left 220ms cubic-bezier(0.32,0.72,0,1)" }}
        aria-hidden
      />
    </div>
  );
}

/** Rendered box, in px. The 20×20 viewBox scales into it. */
const RING_PX = 12;
/** Radius inside the 20×20 viewBox — leaves room for the 4-wide stroke. */
const RING_R = 7;
const RING_C = 2 * Math.PI * RING_R;
/** A 4/20 stroke on a 12px box is ~2.4 device px of ring: heavy enough that
 *  the arc reads as a fill rather than a hairline at this size. */
const RING_STROKE = 4;
const RING_VIEW = 20;
const RING_CX = RING_VIEW / 2;

/** Circumference offset for a 0..1 fill. Exported so tests can check the
 *  proportion without scraping SVG presentation attributes. */
export function ringDashOffset(frac: number): number {
  const f = Math.max(0, Math.min(1, frac));
  return RING_C * (1 - f);
}

export function UsageRing({
  frac,
  size = RING_PX,
  className,
}: {
  /** 0..1 window fill, or `null` when the agent reports no limit. */
  frac: number | null;
  size?: number;
  className?: string;
}) {
  const f = frac === null ? null : Math.max(0, Math.min(1, frac));
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${RING_VIEW} ${RING_VIEW}`}
      className={cn("shrink-0", className)}
      aria-hidden
      focusable="false"
      data-usage-ring={f === null ? "unknown" : "known"}
    >
      {/* Track. With no reported limit it's the whole glyph, and it goes
          dashed — a solid empty ring is what 0%-of-a-known-window looks like,
          and "we don't know the capacity" must not read as "nothing used". */}
      <circle
        cx={RING_CX}
        cy={RING_CX}
        r={RING_R}
        fill="none"
        stroke="currentColor"
        strokeWidth={RING_STROKE}
        className={f === null ? "opacity-40" : "opacity-25"}
        strokeDasharray={f === null ? "2.6 2.2" : undefined}
      />
      {f !== null ? (
        <circle
          cx={RING_CX}
          cy={RING_CX}
          r={RING_R}
          fill="none"
          stroke="currentColor"
          strokeWidth={RING_STROKE}
          // Butt caps: round ones pad both ends of the arc and overstate
          // small readings. The criterion is proportional accuracy.
          strokeLinecap="butt"
          strokeDasharray={RING_C}
          strokeDashoffset={ringDashOffset(f)}
          transform={`rotate(-90 ${RING_CX} ${RING_CX})`}
          style={{ transition: "stroke-dashoffset 300ms cubic-bezier(0.32,0.72,0,1)" }}
        />
      ) : null}
    </svg>
  );
}

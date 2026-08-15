/**
 * Compact context-window meter — a donut whose arc is the fraction of the
 * model's context window the session has consumed.
 *
 * Replaces the speedometer glyph that used to sit beside the context numbers:
 * the icon now *carries* the value it previously only labelled, so the fill
 * level is readable at a glance without parsing "45.2k / 200.0k".
 *
 * Geometry is fixed (12px box, no text inside) and the arc animates purely via
 * `stroke-dashoffset`, which is not a layout property — so a value landing
 * mid-run repaints without reflowing the row it sits in.
 */
import type { ContextUsage } from "@/types/agent";

/** Rendered box, in px. The 20×20 viewBox scales into it. */
const RING_PX = 12;
/** Radius inside the 20×20 viewBox — leaves room for the 4-wide stroke. */
const RING_R = 7;
const RING_C = 2 * Math.PI * RING_R;
/** A 4/20 stroke on a 12px box is ~2.4 device px of ring: heavy enough that
 *  the arc reads as a fill rather than a hairline at this size. */
const RING_STROKE = 4;

/** Fraction of the window used, or `null` when the agent reports no limit. */
export function contextFraction(ctx: ContextUsage): number | null {
  if (ctx.size <= 0) return null;
  return Math.min(1, Math.max(0, ctx.used / ctx.size));
}

/**
 * Screen-reader label / tooltip for a context reading: used tokens, total
 * window, percentage, and estimated cost. Agents that don't advertise a
 * context limit say so instead of implying a proportion we don't have.
 */
export function contextLabel(ctx: ContextUsage): string {
  const frac = contextFraction(ctx);
  const cost = ctx.cost > 0 ? ` · est. $${ctx.cost.toFixed(4)}` : "";
  if (frac === null) {
    return `Context: ${ctx.used.toLocaleString()} tokens used — this agent does not report a context limit${cost}`;
  }
  return `Context: ${ctx.used.toLocaleString()} of ${ctx.size.toLocaleString()} tokens used (${Math.round(
    frac * 100,
  )}%)${cost}`;
}

export function ContextRing({ ctx }: { ctx: ContextUsage }) {
  const frac = contextFraction(ctx);
  // The point of the ring is seeing the wall before you hit it, so the arc
  // warms as the window fills. Below the thresholds it stays monochrome, in
  // keeping with the rest of the palette.
  const stroke =
    frac === null
      ? "var(--text-tertiary)"
      : frac >= 0.9
        ? "var(--status-error)"
        : frac >= 0.75
          ? "var(--status-warning)"
          : "var(--text-secondary)";

  return (
    <svg
      width={RING_PX}
      height={RING_PX}
      viewBox="0 0 20 20"
      className="shrink-0"
      // The reading is announced by the labelled wrapper this sits inside;
      // the SVG itself is decoration.
      aria-hidden
      focusable="false"
    >
      {/* Track. With no reported limit it's the whole glyph, and it goes
          dashed — a solid empty ring is what 0%-of-a-known-window looks like,
          and "we don't know the capacity" must not read as "nothing used". */}
      <circle
        cx="10"
        cy="10"
        r={RING_R}
        fill="none"
        stroke="var(--border-strong)"
        strokeWidth={RING_STROKE}
        strokeDasharray={frac === null ? "2.6 2.2" : undefined}
      />
      {frac !== null && frac > 0 && (
        <circle
          cx="10"
          cy="10"
          r={RING_R}
          fill="none"
          stroke={stroke}
          strokeWidth={RING_STROKE}
          // Butt caps: round ones would pad both ends of the arc and overstate
          // small readings, and the criterion here is proportional accuracy.
          strokeLinecap="butt"
          strokeDasharray={RING_C}
          strokeDashoffset={RING_C * (1 - frac)}
          // Start the fill at 12 o'clock rather than 3.
          transform="rotate(-90 10 10)"
          style={{ transition: "stroke-dashoffset 300ms ease-out" }}
        />
      )}
    </svg>
  );
}

import { cn } from "@/lib/utils";

/**
 * The Usage popup's two gauges.
 *
 * `TickMeter` is the reference card's meter: a row of thin ticks whose colour
 * runs green → amber → red along the scale, with a marker at the current
 * value and everything past the marker dimmed. For a context window the
 * scale IS the window: 0 % on the left, the model's limit on the right, the
 * warning band starting at 80 % where the ACP thread starts warning too.
 *
 * `UsageRing` is the pill's 12 px arc — the plan pill's ring, at the pill's
 * size.
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
              ? "var(--status-error-foreground)"
              : at >= warnAt
                ? "var(--status-warning-foreground)"
                : "var(--status-success-foreground)";
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
        className="pointer-events-none absolute -top-0.5 h-4 w-px bg-foreground"
        style={{ left: `${pct}%`, transition: "left 220ms cubic-bezier(0.32,0.72,0,1)" }}
        aria-hidden
      />
    </div>
  );
}

export function UsageRing({
  frac,
  size = 12,
  className,
}: {
  /** 0..1 */
  frac: number;
  size?: number;
  className?: string;
}) {
  const r = 6;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, frac));
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={cn("shrink-0 -rotate-90", className)}
      aria-hidden
    >
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        className="opacity-25"
      />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${Math.max(0.001, f) * c} ${c}`}
        style={{ transition: "stroke-dasharray 300ms cubic-bezier(0.32,0.72,0,1)" }}
      />
    </svg>
  );
}

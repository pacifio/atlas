import { cn } from "@/lib/utils";

/**
 * The usage pill's 12 px arc — the plan pill's ring, at the pill's size. The
 * popup's tick meter is the package's `SegmentMeter variant="gauge"`.
 */

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

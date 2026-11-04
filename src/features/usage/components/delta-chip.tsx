import { cn } from "@/lib/utils";

/**
 * Period-over-period change as a small chip: `▲ 8%` / `▼ 3%`. Deliberately NEUTRAL grey —
 * more tokens is neither good nor bad, so the chip informs and does not judge. Renders
 * nothing when there is no previous period to compare with.
 */
export function DeltaChip({ delta, className }: { delta: number | null; className?: string }) {
  if (delta === null || !Number.isFinite(delta)) return null;
  const pct = Math.round(Math.abs(delta) * 100);
  const flat = pct === 0;
  return (
    <span
      className={cn(
        "inline-flex h-4 items-center gap-0.5 rounded-full border border-element-active px-1.5 text-3xs font-medium tabular-nums text-[var(--secondary-foreground)]",
        className,
      )}
      title="vs the previous period of the same length"
    >
      {flat ? "—" : delta > 0 ? "▲" : "▼"}
      {!flat && ` ${pct}%`}
    </span>
  );
}

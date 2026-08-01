import { cn } from "@/lib/utils";

interface PanelSkeletonProps {
  /** Number of skeleton rows to draw (default 6). */
  rows?: number;
  /** Optional label shown above the rows (e.g. "Loading changes…"). */
  label?: string;
  className?: string;
}

/**
 * Generic skeleton for lazy-loaded sidebar panels. The bars are static
 * (no animation) and styled to match the AMOLED palette so the user
 * sees structure rather than a spinner while a panel's chunk + initial
 * data load.
 */
export function PanelSkeleton({
  rows = 6,
  label,
  className,
}: PanelSkeletonProps) {
  return (
    <div className={cn("h-full flex flex-col gap-2 p-3", className)}>
      {label && (
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)] px-0.5">
          {label}
        </div>
      )}
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="h-6 rounded-md bg-[var(--bg-elevated)] opacity-50"
            style={{
              // Slight width variation makes the placeholder feel like a list
              // rather than a grid of identical bars.
              width: `${78 + ((i * 13) % 22)}%`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

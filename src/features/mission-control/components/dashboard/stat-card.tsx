import { cn } from "@/lib/utils";

/** A single metric tile — label, big value, optional sub-line + accent dot. */
export function StatCard({
  label,
  value,
  sub,
  accent,
  className,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3.5 py-3 flex flex-col gap-1.5",
        className,
      )}
    >
      <div className="flex items-center gap-1.5">
        {accent && (
          <span
            className="h-1.5 w-1.5 rounded-full shrink-0"
            style={{ backgroundColor: accent }}
          />
        )}
        <span className="text-[9px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
          {label}
        </span>
      </div>
      <span className="text-[20px] font-mono tabular-nums text-[var(--text-primary)] leading-none">
        {value}
      </span>
      {sub && (
        <span className="text-[10px] text-[var(--text-tertiary)] font-mono">
          {sub}
        </span>
      )}
    </div>
  );
}

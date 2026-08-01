import { fmtTokens } from "@/features/monitor/lib/usage-format";

interface TipEntry {
  value?: number;
  name?: string;
  dataKey?: string | number;
  color?: string;
  fill?: string;
}
interface TipProps {
  active?: boolean;
  payload?: TipEntry[];
  label?: string | number;
}

/** AMOLED tooltip for recharts (the default is white). Sums + lists series. */
export function ChartTooltip({ active, payload, label }: TipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const rows = payload.filter((p) => (p.value ?? 0) > 0);
  if (rows.length === 0) return null;
  const total = rows.reduce((n, p) => n + (Number(p.value) || 0), 0);
  return (
    <div className="rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2.5 py-2 shadow-lg text-[11px] min-w-[150px]">
      {label != null && (
        <div className="text-[10px] text-[var(--text-tertiary)] mb-1 font-mono">
          {String(label)}
        </div>
      )}
      {rows.slice(0, 8).map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2">
          <span
            className="h-1.5 w-1.5 rounded-full shrink-0"
            style={{ backgroundColor: (p.color as string) ?? p.fill }}
          />
          <span className="flex-1 min-w-0 truncate text-[var(--text-secondary)]">
            {p.name}
          </span>
          <span className="font-mono tabular-nums text-[var(--text-primary)]">
            {fmtTokens(Number(p.value) || 0)}
          </span>
        </div>
      ))}
      {rows.length > 1 && (
        <div className="mt-1 pt-1 border-t border-[var(--border-subtle)] flex items-center justify-between">
          <span className="text-[var(--text-tertiary)]">Total</span>
          <span className="font-mono tabular-nums text-[var(--text-primary)]">
            {fmtTokens(total)}
          </span>
        </div>
      )}
    </div>
  );
}

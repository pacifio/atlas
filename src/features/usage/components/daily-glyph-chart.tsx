import { useMemo, useState } from "react";
import { CAPTION, Card, useMounted } from "@/components/usage-primitives";
import { fmtCost, fmtNum, fmtTokens } from "@/features/monitor/lib/usage-format";
import { cn } from "@/lib/utils";
import type { GroupBy, Metric } from "../types";
import type { Series } from "../lib/derive";
import { addDays, fmtDay } from "../lib/date-range";

const H = 128;

const fmtFor = (metric: Metric) =>
  metric === "cost" ? fmtCost : metric === "tokens" ? fmtTokens : fmtNum;
const GROUP_LABEL: Record<GroupBy, string> = { project: "project", agent: "agent", model: "model" };

/**
 * Whether column `i` of `n` carries a date on the x axis: every `every`th, and
 * always the last. A label overflows its column (a day's column is narrower
 * than "Sep 10"), so a regular label too close to the last one is dropped
 * rather than drawn on top of it.
 */
export function axisLabelAt(i: number, n: number, every: number): boolean {
  if (i === n - 1) return true;
  return i % every === 0 && n - 1 - i >= Math.ceil(every / 2);
}

/**
 * The daily series as a glyph chart (the reference's bar-glyph area): one column per day (or
 * week, past 120 days), stacked by the group-by key in the theme's series palette, hovered
 * column brightened with a breakdown card beside it. Pure divs, no SVG, so html-to-image
 * export captures it as drawn. Every bucket in the range is present — a quiet day is a gap.
 */
export function DailyGlyphChart({
  series,
  metric,
  groupBy,
  attribution,
}: {
  series: Series;
  metric: Metric;
  groupBy: GroupBy;
  /** The caption's honesty line about how usage is dated. */
  attribution: string;
}) {
  const mounted = useMounted();
  const [hover, setHover] = useState<number | null>(null);
  const fmt = fmtFor(metric);
  const { columns, keys, max, bucket } = series;
  const n = columns.length;

  // Axis labels: ~6 across, always the first and the last.
  const labelEvery = useMemo(() => Math.max(1, Math.ceil(n / 6)), [n]);
  const ticks = useMemo(() => [max, max / 2, 0], [max]);

  const active = hover !== null ? columns[hover] : null;

  return (
    <Card index={2} section="chart" className="relative">
      <div className="flex items-baseline justify-between">
        <div className={CAPTION}>
          {metric === "tokens" ? "Tokens" : metric === "cost" ? "Est. cost" : "Messages"} · by{" "}
          {bucket} · per {GROUP_LABEL[groupBy]}
        </div>
        <div className="text-3xs text-[var(--muted-foreground)]">{attribution}</div>
      </div>

      <div className="mt-2 flex gap-2">
        {/* y axis */}
        <div
          className="flex w-[40px] shrink-0 flex-col justify-between text-right text-3xs tabular-nums text-[var(--muted-foreground)]"
          style={{ height: H }}
        >
          {ticks.map((t, i) => (
            <span key={i}>{max > 0 ? fmt(t) : ""}</span>
          ))}
        </div>
        {/* columns */}
        <div
          className="relative min-w-0 flex-1"
          style={{ height: H, transform: "translateZ(0)" }}
          onMouseLeave={() => setHover(null)}
        >
          {/* grid lines */}
          {[0, 0.5, 1].map((f) => (
            <span
              key={f}
              className="pointer-events-none absolute inset-x-0 border-t border-element-selected"
              style={{ top: `${f * 100}%` }}
              aria-hidden
            />
          ))}
          <div className="absolute inset-0 flex items-end gap-px">
            {columns.map((c, i) => {
              const dim = hover !== null && hover !== i;
              return (
                <div
                  key={c.date}
                  className="relative flex h-full min-w-0 flex-1 flex-col-reverse"
                  onMouseEnter={() => setHover(i)}
                >
                  {keys.map((k, ki) => {
                    const v = c.values[ki];
                    if (v <= 0 || max <= 0) return null;
                    const h = mounted ? (v / max) * 100 : 0;
                    return (
                      <span
                        key={k.key}
                        className="block w-full"
                        style={{
                          height: `${h}%`,
                          background: k.color,
                          opacity: dim ? 0.35 : 1,
                          transition: "height 320ms cubic-bezier(0.32,0.72,0,1), opacity 120ms",
                          transitionDelay: mounted ? `${Math.min(i, 60) * 4}ms` : "0ms",
                          marginTop: 1,
                        }}
                        aria-hidden
                      />
                    );
                  })}
                  {hover === i && (
                    <span
                      className="pointer-events-none absolute inset-y-0 -inset-x-px bg-element-hover"
                      aria-hidden
                    />
                  )}
                </div>
              );
            })}
          </div>
          {/* tooltip */}
          {active && (
            <div
              className={cn(
                "pointer-events-none absolute top-0 z-10 min-w-[170px] rounded-md border border-[var(--border)] bg-[var(--card)] px-2.5 py-2 text-xs shadow-md",
                hover !== null && hover > n / 2
                  ? "right-[calc(100%_-_var(--x))]"
                  : "left-[var(--x)]",
              )}
              style={
                {
                  "--x": `${((hover ?? 0) + 0.5) * (100 / Math.max(1, n))}%`,
                } as React.CSSProperties
              }
            >
              <div className="text-2xs text-[var(--muted-foreground)]">
                {bucket === "week"
                  ? `${fmtDay(active.date)} – ${fmtDay(addDays(active.date, 6))}`
                  : fmtDay(active.date)}
              </div>
              {keys.map((k, ki) =>
                active.values[ki] > 0 ? (
                  <div key={k.key} className="mt-1 flex items-center gap-2">
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: k.color }}
                    />
                    <span className="min-w-0 flex-1 truncate text-[var(--secondary-foreground)]">
                      {k.label}
                    </span>
                    <span className="tabular-nums text-[var(--foreground)]">
                      {fmt(active.values[ki])}
                    </span>
                  </div>
                ) : null,
              )}
              <div className="mt-1.5 flex items-center justify-between border-t border-element-selected pt-1.5">
                <span className="text-2xs uppercase tracking-wider text-[var(--muted-foreground)]">
                  Total
                </span>
                <span className="tabular-nums text-[var(--foreground)]">{fmt(active.total)}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* x axis */}
      <div className="ml-[48px] mt-1 flex gap-px text-3xs tabular-nums text-[var(--muted-foreground)]">
        {/* Each label hangs off its column rather than fitting inside it: at
            30 columns a day is ~20px and "Sep 10" truncated to "S…". */}
        {columns.map((c, i) => (
          <span key={c.date} className="relative h-3 min-w-0 flex-1">
            {axisLabelAt(i, n, labelEvery) && (
              <span
                className={cn(
                  "absolute top-0 whitespace-nowrap",
                  i === n - 1 && n > 1 ? "right-0" : "left-0",
                )}
              >
                {fmtDay(c.date)}
              </span>
            )}
          </span>
        ))}
      </div>

      {/* legend: bracketed chips, the reference's [ ■ name ] */}
      {keys.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {keys.map((k) => (
            <span
              key={k.key}
              className="flex items-center gap-1 text-2xs text-[var(--secondary-foreground)]"
            >
              <span className="text-disabled">[</span>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: k.color }} />
              <span className="max-w-[160px] truncate">{k.label}</span>
              <span className="text-disabled">]</span>
            </span>
          ))}
        </div>
      )}
      {max === 0 && (
        <div className="absolute inset-x-0 top-1/2 text-center text-2xs text-[var(--muted-foreground)]">
          Nothing in this range
        </div>
      )}
    </Card>
  );
}

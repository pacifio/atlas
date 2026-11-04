import { CAPTION, Card, VALUE, useMounted } from "@/components/usage-primitives";
import { fmtPct, fmtTokens } from "@/features/monitor/lib/usage-format";
import { cn } from "@/lib/utils";
import type { Metrics } from "../types";

const TICKS = 40;

/**
 * Token classes as tick trackers (the reference's "Rent & Utilities ||||||" band): each class
 * shows its value and a strip of thin ticks lit in proportion to its share of the largest
 * class. Reasoning appears only when an agent reported it — it rides inside output and is
 * never priced, so an always-present zero would mislead.
 */
export function ClassTrackers({ totals }: { totals: Metrics }) {
  const mounted = useMounted();
  const classes = [
    { key: "input", label: "Input", value: totals.input },
    { key: "output", label: "Output", value: totals.output },
    { key: "cacheRead", label: "Cache read", value: totals.cacheRead },
    { key: "cacheWrite", label: "Cache write", value: totals.cacheWrite },
    ...(totals.reasoning > 0
      ? [{ key: "reasoning", label: "Reasoning", value: totals.reasoning }]
      : []),
  ];
  const max = classes.reduce((m, c) => Math.max(m, c.value), 0);
  const all = classes.reduce((s, c) => s + c.value, 0);
  return (
    <Card index={1} section="classes" className="!px-0 !py-0">
      <div
        className="grid divide-x divide-element-selected"
        style={{ gridTemplateColumns: `repeat(${classes.length}, minmax(0, 1fr))` }}
      >
        {classes.map((c) => {
          const frac = max > 0 ? c.value / max : 0;
          const lit = mounted ? Math.round(frac * TICKS) : 0;
          const largest = c.value === max && max > 0;
          return (
            <div key={c.key} className="min-w-0 px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className={CAPTION}>{c.label}</span>
                <span className="text-3xs tabular-nums text-[var(--muted-foreground)]">
                  {all > 0 ? fmtPct(c.value / all) : "—"}
                </span>
              </div>
              <div
                // `text-lg` after VALUE, because VALUE carries `text-xs`.
                className={cn("mt-1 leading-none font-semibold tabular-nums", VALUE, "text-lg")}
              >
                {fmtTokens(c.value)}
              </div>
              <div className="mt-2 flex h-3 items-end gap-px" aria-hidden>
                {Array.from({ length: TICKS }, (_, i) => (
                  <span
                    key={i}
                    className="h-full w-[2px] flex-1 rounded-sm transition-opacity duration-300"
                    style={{
                      background: largest ? "var(--foreground)" : "var(--secondary-foreground)",
                      opacity: i < lit ? 1 : 0.16,
                      transitionDelay: `${i * 6}ms`,
                    }}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

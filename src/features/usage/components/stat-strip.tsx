import { CAPTION, Card, EstTag, useCountUp } from "@/components/usage-primitives";
import { fmtCost, fmtNum, fmtPct, fmtTokens } from "@/features/monitor/lib/usage-format";
import type { Metrics } from "../types";
import { cacheRatePerDay, deltaPct, tokensOf, type Efficiency } from "../lib/derive";
import { DeltaChip } from "./delta-chip";
import { DotMatrix } from "./dot-matrix";

/**
 * The headline band: five figures separated by hairlines inside one card, each
 * a caption, a count-up number, its period-over-period chip, and the trend that
 * produced it.
 *
 * The trends are the point of the change. Every one of these five is a figure
 * over a window, and a window's total says nothing about whether it arrived in
 * one spike or evenly across a fortnight — which is exactly the question the
 * delta chip beside it invites. The sparkline answers it in the same cell.
 */
export function StatStrip({
  totals,
  prevTotals,
  sessionCount,
  prevSessionCount,
  eff,
  prevEff,
  days,
  sessionDays,
}: {
  totals: Metrics;
  prevTotals: Metrics | null;
  sessionCount: number;
  prevSessionCount: number | null;
  eff: Efficiency;
  prevEff: Efficiency | null;
  /** One entry per day in the range, in order — the sparklines' source. */
  days: Metrics[];
  /** Distinct sessions per day, aligned to `days`. */
  sessionDays: number[];
}) {
  const cells: Array<{
    key: string;
    caption: React.ReactNode;
    value: number;
    fmt: (n: number) => string;
    delta: number | null;
    series: ReadonlyArray<number | null>;
  }> = [
    {
      key: "tokens",
      caption: "Tokens",
      value: tokensOf(totals),
      fmt: fmtTokens,
      delta: deltaPct(tokensOf(totals), prevTotals ? tokensOf(prevTotals) : null),
      series: days.map(tokensOf),
    },
    {
      key: "cost",
      caption: (
        <span className="inline-flex items-center gap-1">
          Cost <EstTag />
        </span>
      ),
      value: totals.cost,
      fmt: fmtCost,
      delta: deltaPct(totals.cost, prevTotals?.cost),
      series: days.map((d) => d.cost),
    },
    {
      key: "sessions",
      caption: "Sessions",
      value: sessionCount,
      fmt: fmtNum,
      delta: deltaPct(sessionCount, prevSessionCount),
      series: sessionDays,
    },
    {
      key: "messages",
      caption: "Messages",
      value: totals.messages,
      fmt: fmtNum,
      delta: deltaPct(totals.messages, prevTotals?.messages),
      series: days.map((d) => d.messages),
    },
    {
      key: "cache",
      caption: "Cache hit rate",
      value: (eff.cacheHitRate ?? 0) * 100,
      fmt: (n) => (eff.cacheHitRate === null ? "—" : fmtPct(n / 100)),
      delta:
        eff.cacheHitRate === null
          ? null
          : deltaPct(eff.cacheHitRate, prevEff?.cacheHitRate ?? null),
      series: cacheRatePerDay(days),
    },
  ];
  return (
    <Card index={0} section="stats" className="!px-0 !py-0">
      <div className="grid grid-cols-5 divide-x divide-element-selected">
        {cells.map((c) => (
          <StatCell
            key={c.key}
            caption={c.caption}
            value={c.value}
            fmt={c.fmt}
            delta={c.delta}
            series={c.series}
          />
        ))}
      </div>
    </Card>
  );
}

function StatCell({
  caption,
  value,
  fmt,
  delta,
  series,
}: {
  caption: React.ReactNode;
  value: number;
  fmt: (n: number) => string;
  delta: number | null;
  series: ReadonlyArray<number | null>;
}) {
  const shown = useCountUp(value);
  return (
    // Roomier than the other cards on the page, on purpose: this is the band a
    // reader lands on, and it now carries three lines rather than two.
    <div className="min-w-0 px-3.5 py-3">
      <div className={CAPTION}>{caption}</div>
      <div className="mt-1.5 flex items-baseline gap-2">
        {/* One step below the insight headline's text-2xl (the scale's top
            step) — a stat cell is five-per-row, the headline is one figure
            alone, and they should not read as the same weight. */}
        <span className="truncate text-xl leading-none font-semibold tabular-nums text-[var(--foreground)]">
          {fmt(shown)}
        </span>
        <DeltaChip delta={delta} />
      </div>
      <DotMatrix values={series} className="mt-2.5" />
    </div>
  );
}

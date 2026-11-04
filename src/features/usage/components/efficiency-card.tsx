import { CAPTION, Card, EstTag, VALUE } from "@/components/usage-primitives";
import { TickMeter } from "@/features/chat/components/usage-meter";
import { fmtCost, fmtPct, fmtTokens } from "@/features/monitor/lib/usage-format";
import type { DailyBucket, GroupBy, SessionRow, UsageDashboard } from "../types";
import { deltaPct, efficiency, keyOf, rankBy, type Efficiency } from "../lib/derive";
import { DeltaChip } from "@tryatlas/design";

const fmtRatio = (r: number) =>
  r >= 1 ? `${r.toFixed(1)}×` : `1:${Math.max(1, Math.round(1 / r))}`;
const fmtCostFine = (n: number) => (n < 0.01 && n > 0 ? fmtCost(n, "USD", 4) : fmtCost(n));

/**
 * The token-efficiency report: six ratios over the window with their period deltas, then the
 * same ratios per group-by key so agents, models or projects can be compared on how they
 * spend, not just how much. `null` ratios (zero denominators) render as a dash, never as 0.
 */
export function EfficiencyCard({
  eff,
  prevEff,
  rows,
  sessions,
  groupBy,
  data,
}: {
  eff: Efficiency;
  prevEff: Efficiency | null;
  rows: DailyBucket[];
  sessions: SessionRow[];
  groupBy: GroupBy;
  data: UsageDashboard | null;
}) {
  const tiles: Array<{
    key: keyof Efficiency;
    label: React.ReactNode;
    fmt: (n: number) => string;
    meter?: boolean;
  }> = [
    { key: "cacheHitRate", label: "Cache hit rate", fmt: fmtPct, meter: true },
    { key: "outputPerInput", label: "Output : input", fmt: fmtRatio },
    { key: "tokensPerSession", label: "Tokens / session", fmt: fmtTokens },
    { key: "costPerSession", label: <Est>Cost / session</Est>, fmt: fmtCostFine },
    { key: "costPerMessage", label: <Est>Cost / message</Est>, fmt: fmtCostFine },
    { key: "blendedCostPer1kOutput", label: <Est>$ / 1K output</Est>, fmt: fmtCostFine },
  ];

  // Per-key efficiency: sessions grouped by the same axis give the distinct-session count.
  const ranked = rankBy(rows, groupBy, "tokens", data).slice(0, 8);
  const sessionsByKey = new Map<string, number>();
  for (const s of sessions) {
    const k = keyOf(s, groupBy);
    sessionsByKey.set(k, (sessionsByKey.get(k) ?? 0) + 1);
  }
  const total = ranked.reduce((s, r) => s + r.value, 0);

  return (
    <Card index={5} section="efficiency">
      <div className={CAPTION}>Token efficiency</div>
      <div className="mt-1.5 grid grid-cols-3 gap-x-4 gap-y-2.5 lg:grid-cols-6">
        {tiles.map((t) => {
          const v = eff[t.key];
          const p = prevEff?.[t.key] ?? null;
          return (
            <div key={t.key} className="min-w-0">
              <div className="text-2xs text-muted-foreground">{t.label}</div>
              <div className="mt-0.5 flex items-baseline gap-1.5">
                <span className="truncate text-xl leading-none font-semibold tabular-nums text-foreground">
                  {v === null ? "—" : t.fmt(v)}
                </span>
                <DeltaChip delta={v === null ? null : deltaPct(v, p)} />
              </div>
              {t.meter && v !== null && (
                <TickMeter value={v * 100} warnAt={101} ticks={32} className="mt-1.5" />
              )}
            </div>
          );
        })}
      </div>

      {ranked.length > 1 && (
        <div className="mt-3 border-t border-element-selected pt-2">
          <div className="flex h-5 items-center text-3xs font-medium uppercase tracking-wider text-muted-foreground">
            <span className="min-w-0 flex-1">By {groupBy}</span>
            <span className="w-[64px] text-right">Cache hit</span>
            <span className="w-[64px] text-right">Out : in</span>
            <span className="w-[80px] text-right">Cost / sess.</span>
            <span className="w-[56px] text-right">Share</span>
          </div>
          {ranked.map((r) => {
            const e = efficiency(r.metrics, sessionsByKey.get(r.key) ?? 0);
            return (
              <div key={r.key} className="flex h-6 items-center text-xs">
                <span className="min-w-0 flex-1 truncate text-secondary-foreground" title={r.label}>
                  {r.label}
                </span>
                <span className={`w-[64px] text-right ${VALUE}`}>
                  {e.cacheHitRate === null ? "—" : fmtPct(e.cacheHitRate)}
                </span>
                <span className={`w-[64px] text-right ${VALUE}`}>
                  {e.outputPerInput === null ? "—" : fmtRatio(e.outputPerInput)}
                </span>
                <span className={`w-[80px] text-right ${VALUE}`}>
                  {e.costPerSession === null ? "—" : fmtCostFine(e.costPerSession)}
                </span>
                <span className="w-[56px] text-right text-2xs tabular-nums text-muted-foreground">
                  {total > 0 ? fmtPct(r.value / total) : "—"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function Est({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      {children} <EstTag />
    </span>
  );
}

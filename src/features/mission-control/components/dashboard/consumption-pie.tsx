import { useMemo } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { fmtTokens } from "@/features/monitor/lib/usage-format";
import { projectColor } from "../../lib/chart-theme";
import { consumptionShares } from "../../lib/series";
import type { MissionControlUsage } from "../../types";
import { ChartCard } from "./chart-card";

/** Donut of max consumption — token share by project. */
export function ConsumptionPie({ data }: { data: MissionControlUsage }) {
  const shares = useMemo(() => consumptionShares(data), [data]);
  const total = shares.reduce((n, s) => n + s.value, 0);

  return (
    <ChartCard title="Consumption" subtitle="Token share by project">
      <div className="h-[240px] flex items-center gap-2">
        {shares.length === 0 ? (
          <div className="flex-1 text-center text-[11px] text-[var(--text-tertiary)]">
            No data.
          </div>
        ) : (
          <>
            <div className="relative h-full w-[160px] shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={shares}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={48}
                    outerRadius={72}
                    paddingAngle={2}
                    stroke="none"
                    isAnimationActive={false}
                  >
                    {shares.map((s, i) => (
                      <Cell key={s.path} fill={projectColor(i)} />
                    ))}
                  </Pie>
                  <Tooltip content={<PieTip total={total} />} />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <span className="text-[14px] font-mono text-[var(--text-primary)]">
                  {fmtTokens(total)}
                </span>
                <span className="text-[9px] uppercase tracking-wide text-[var(--text-tertiary)]">
                  total
                </span>
              </div>
            </div>
            <div className="flex-1 min-w-0 overflow-y-auto max-h-full space-y-1 pr-1">
              {shares.slice(0, 10).map((s, i) => (
                <div
                  key={s.path}
                  className="flex items-center gap-2 text-[11px]"
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: projectColor(i) }}
                  />
                  <span className="flex-1 min-w-0 truncate text-[var(--text-secondary)]">
                    {s.name}
                  </span>
                  <span className="font-mono tabular-nums text-[var(--text-tertiary)]">
                    {total > 0 ? Math.round((s.value / total) * 100) : 0}%
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </ChartCard>
  );
}

function PieTip({
  active,
  payload,
  total,
}: {
  active?: boolean;
  payload?: Array<{
    name?: string;
    value?: number;
    payload?: { name: string };
  }>;
  total: number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0];
  const v = Number(p.value) || 0;
  return (
    <div className="rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-[11px]">
      <div className="text-[var(--text-secondary)]">
        {p.payload?.name ?? p.name}
      </div>
      <div className="font-mono text-[var(--text-primary)]">
        {fmtTokens(v)} · {total > 0 ? Math.round((v / total) * 100) : 0}%
      </div>
    </div>
  );
}

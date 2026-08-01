import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtTokens } from "@/features/monitor/lib/usage-format";
import { CHART, projectColorMap } from "../../lib/chart-theme";
import { areaRows, filterDaily } from "../../lib/series";
import type { MissionControlUsage } from "../../types";
import { ChartCard } from "./chart-card";
import { ChartTooltip } from "./chart-tooltip";

/** Stacked area: combined token usage over time, one band per project. */
export function UsageAreaChart({
  data,
  rangeDays,
}: {
  data: MissionControlUsage;
  rangeDays: number | null;
}) {
  const paths = useMemo(
    () => data.projects.map((p) => p.projectPath),
    [data.projects],
  );
  const nameByPath = useMemo(
    () =>
      Object.fromEntries(
        data.projects.map((p) => [p.projectPath, p.projectName]),
      ),
    [data.projects],
  );
  const colors = useMemo(() => projectColorMap(paths), [paths]);
  const rows = useMemo(
    () => areaRows(filterDaily(data.daily, rangeDays), paths),
    [data.daily, rangeDays, paths],
  );

  return (
    <ChartCard
      title="Token usage over time"
      subtitle="Combined tokens per day, stacked by project"
    >
      <div className="h-[240px]">
        {rows.length === 0 ? (
          <Empty />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={rows}
              margin={{ top: 8, right: 8, left: 4, bottom: 0 }}
            >
              <defs>
                {paths.map((p) => (
                  <linearGradient
                    key={p}
                    id={`area-${gid(p)}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0%" stopColor={colors[p]} stopOpacity={0.5} />
                    <stop
                      offset="100%"
                      stopColor={colors[p]}
                      stopOpacity={0.03}
                    />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke={CHART.grid}
                vertical={false}
              />
              <XAxis
                dataKey="date"
                tick={{ fill: CHART.axis, fontSize: CHART.tickFont }}
                tickLine={false}
                axisLine={{ stroke: CHART.grid }}
                minTickGap={28}
                tickFormatter={(d: string) => d.slice(5)}
              />
              <YAxis
                tick={{ fill: CHART.axis, fontSize: CHART.tickFont }}
                tickLine={false}
                axisLine={false}
                width={44}
                tickFormatter={(v: number) => fmtTokens(v)}
              />
              <Tooltip
                content={<ChartTooltip />}
                cursor={{ stroke: CHART.grid }}
              />
              {paths.map((p) => (
                <Area
                  key={p}
                  type="monotone"
                  dataKey={p}
                  name={nameByPath[p]}
                  stackId="1"
                  stroke={colors[p]}
                  strokeWidth={1.5}
                  fill={`url(#area-${gid(p)})`}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </ChartCard>
  );
}

function Empty() {
  return (
    <div className="h-full flex items-center justify-center text-[11px] text-[var(--text-tertiary)]">
      No usage in this range.
    </div>
  );
}

/** Sanitize a project path into a valid SVG gradient id. */
function gid(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "_");
}

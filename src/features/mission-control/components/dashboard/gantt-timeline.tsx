import { useMemo } from "react";
import { fmtTokens, fmtDate } from "@/features/monitor/lib/usage-format";
import { AGENT_COLOR } from "../../lib/chart-theme";
import { bucketTokens } from "../../lib/series";
import type { MissionControlUsage } from "../../types";
import { ChartCard } from "./chart-card";

/**
 * Project-activity timeline. One row per project: a bar spanning its first→last
 * activity, overlaid with per-day cells whose opacity scales with that day's
 * token volume (a monochrome-ish heat ramp). Pure divs (no SVG foreignObject)
 * so it survives html-to-image export.
 */
export function GanttTimeline({ data }: { data: MissionControlUsage }) {
  const rows = useMemo(() => {
    const dayTokens = new Map<string, Map<string, number>>(); // path -> date -> tokens
    for (const d of data.daily) {
      let m = dayTokens.get(d.projectPath);
      if (!m) {
        m = new Map();
        dayTokens.set(d.projectPath, m);
      }
      m.set(d.date, (m.get(d.date) ?? 0) + bucketTokens(d));
    }
    return data.projects
      .filter((p) => p.firstActivityMs != null && p.lastActivityMs != null)
      .map((p) => ({
        path: p.projectPath,
        name: p.projectName,
        first: p.firstActivityMs as number,
        last: p.lastActivityMs as number,
        total: p.totalTokens,
        days: dayTokens.get(p.projectPath) ?? new Map<string, number>(),
      }))
      .sort((a, b) => a.first - b.first);
  }, [data]);

  // Fixed-width heatmap grid: bucket the timeline into <=BUCKETS columns shared
  // across all rows, so the DOM stays bounded (was 1 div per active day → could
  // be thousands; now <=BUCKETS per project).
  const BUCKETS = 56;
  const { min, max, cells, maxCell } = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const r of rows) {
      min = Math.min(min, r.first);
      max = Math.max(max, r.last);
    }
    const span = Math.max(1, max - min);
    const bucketMs = span / BUCKETS;
    let maxCell = 1;
    const cells = rows.map((r) => {
      const arr = new Array<number>(BUCKETS).fill(0);
      for (const [date, tokens] of r.days) {
        const ms = Date.parse(`${date}T12:00:00`);
        if (Number.isNaN(ms)) continue;
        const idx = Math.min(
          BUCKETS - 1,
          Math.max(0, Math.floor((ms - min) / bucketMs)),
        );
        arr[idx] += tokens;
      }
      for (const v of arr) maxCell = Math.max(maxCell, v);
      return arr;
    });
    return { min, max, cells, maxCell };
  }, [rows]);

  if (rows.length === 0) {
    return (
      <ChartCard
        title="Project timeline"
        subtitle="Activity + token volume over time"
      >
        <div className="h-[120px] flex items-center justify-center text-[11px] text-[var(--text-tertiary)]">
          No project activity.
        </div>
      </ChartCard>
    );
  }

  const span = Math.max(1, max - min);
  const pct = (ms: number) => ((ms - min) / span) * 100;

  return (
    <ChartCard
      title="Project timeline"
      subtitle={`${fmtDate(min)} → ${fmtDate(max)} · cell intensity = daily tokens`}
    >
      <div className="px-1.5 pb-1 space-y-1.5">
        {rows.map((r, ri) => (
          <div key={r.path} className="flex items-center gap-2">
            <div
              className="w-[120px] shrink-0 truncate text-[11px] text-[var(--text-secondary)]"
              title={r.name}
            >
              {r.name}
            </div>
            <div className="relative flex-1 h-5 rounded bg-[var(--bg-base)] overflow-hidden">
              {/* span bar */}
              <div
                className="absolute top-1/2 -translate-y-1/2 h-1 rounded-full"
                style={{
                  left: `${pct(r.first)}%`,
                  width: `${Math.max(0.6, pct(r.last) - pct(r.first))}%`,
                  backgroundColor: "rgba(255,255,255,0.08)",
                }}
              />
              {/* bucketed heat cells (bounded count) */}
              {cells[ri].map((tokens, i) =>
                tokens === 0 ? null : (
                  <div
                    key={i}
                    title={fmtTokens(tokens)}
                    className="absolute top-1/2 -translate-y-1/2 h-3.5 rounded-[1px]"
                    style={{
                      left: `${(i / BUCKETS) * 100}%`,
                      width: `${100 / BUCKETS}%`,
                      backgroundColor: AGENT_COLOR.claude,
                      opacity: 0.3 + 0.7 * Math.min(1, tokens / maxCell),
                    }}
                  />
                ),
              )}
            </div>
            <div className="w-[56px] shrink-0 text-right text-[10px] font-mono text-[var(--text-tertiary)]">
              {fmtTokens(r.total)}
            </div>
          </div>
        ))}
      </div>
    </ChartCard>
  );
}

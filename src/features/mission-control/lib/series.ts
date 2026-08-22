import type { DailyBucket, MissionControlUsage } from "../types";

/** Total tokens a daily bucket represents (claude in+out + codex). */
export function bucketTokens(d: DailyBucket): number {
  return d.claudeInput + d.claudeOutput + d.codexTokens;
}

/** Filter the daily series to the last `rangeDays` (null = all time). */
export function filterDaily(daily: DailyBucket[], rangeDays: number | null): DailyBucket[] {
  if (rangeDays == null) return daily;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - rangeDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return daily.filter((d) => d.date >= cutoffStr);
}

/**
 * Pivot the daily buckets into stacked-area rows: one row per date, one numeric
 * key per project path (combined tokens), filling gaps with 0 so the area is
 * continuous. Returns rows sorted by date + the ordered project paths.
 */
export function areaRows(
  daily: DailyBucket[],
  projectPaths: string[],
): Array<Record<string, number | string>> {
  const byDate = new Map<string, Record<string, number | string>>();
  for (const d of daily) {
    let row = byDate.get(d.date);
    if (!row) {
      row = { date: d.date };
      for (const p of projectPaths) row[p] = 0;
      byDate.set(d.date, row);
    }
    row[d.projectPath] = (Number(row[d.projectPath]) || 0) + bucketTokens(d);
  }
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/** Per-project consumption shares (for the pie), sorted desc, biggest first. */
export function consumptionShares(
  data: MissionControlUsage,
): Array<{ name: string; path: string; value: number }> {
  return data.projects
    .map((p) => ({ name: p.projectName, path: p.projectPath, value: p.totalTokens }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);
}

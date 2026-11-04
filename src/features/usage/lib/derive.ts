/**
 * Pure derivations over the dashboard payload. Everything the Usage tab renders comes out of
 * these functions applied to `daily[]` (already filtered by range + facets) — the Rust side
 * folds its own rollups from the same rows, so a filtered view and the unfiltered one agree.
 *
 * `null` means "don't render that number", never zero: a ratio with a zero denominator is
 * unknown, not 0.
 */

import type { AgentMetaResolver } from "@/features/agents/lib/agent-identity";
import { agentLabel, prettyModel } from "@/features/artifacts/lib/board";
import {
  BYOK_AGENT,
  UNKNOWN,
  type ByokDay,
  type DailyBucket,
  type Facets,
  type GroupBy,
  type Metric,
  type Metrics,
  type SessionRow,
  type UsageDashboard,
} from "../types";
import { epochToDay, inRange, spanDays, weekKey, type ResolvedRange } from "./date-range";

export const EMPTY_METRICS: Metrics = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  cost: 0,
  messages: 0,
  sessions: 0,
};

/** BYOK rows re-keyed so they flow through the same range/facet/group-by machinery. */
export function byokAsDaily(byok: ByokDay[], byokProjectPath: string): DailyBucket[] {
  return byok.map((b) => ({
    date: b.date,
    projectPath: byokProjectPath,
    agent: BYOK_AGENT,
    model: `${b.provider}/${b.model}`,
    input: b.input,
    output: b.output,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    cost: b.cost,
    messages: b.requests,
    sessions: 0,
  }));
}

/** Agent rows plus BYOK rows — the one array every view starts from. */
export function allDaily(data: UsageDashboard): DailyBucket[] {
  return data.daily.concat(byokAsDaily(data.byokDaily, data.byokProjectPath));
}

export function rowsInRange<T extends { date: string }>(rows: T[], r: ResolvedRange): T[] {
  return rows.filter((row) => inRange(row.date, r));
}

/** Empty facet list = no narrowing on that axis. */
export function applyFacets<T extends { projectPath: string; agent: string; model: string }>(
  rows: T[],
  f: Facets,
): T[] {
  const p = f.projects.length ? new Set(f.projects) : null;
  const a = f.agents.length ? new Set(f.agents) : null;
  const m = f.models.length ? new Set(f.models) : null;
  if (!p && !a && !m) return rows;
  return rows.filter(
    (r) => (!p || p.has(r.projectPath)) && (!a || a.has(r.agent)) && (!m || m.has(r.model)),
  );
}

export function sessionsInRange(rows: SessionRow[], r: ResolvedRange): SessionRow[] {
  return rows.filter((s) => inRange(epochToDay(s.lastActivityMs ?? s.startedMs), r));
}

export function addMetrics(into: Metrics, m: Metrics): Metrics {
  into.input += m.input;
  into.output += m.output;
  into.cacheRead += m.cacheRead;
  into.cacheWrite += m.cacheWrite;
  into.reasoning += m.reasoning;
  into.cost += m.cost;
  into.messages += m.messages;
  // `sessions` is distinct-per-bucket on the wire and NOT additive across buckets; callers
  // that need a distinct count over a filtered set take it from `sessions[]` instead.
  return into;
}

export function totalsOf(rows: Metrics[]): Metrics {
  return rows.reduce((acc, r) => addMetrics(acc, r), { ...EMPTY_METRICS });
}

/** input + output — the "tokens" everyone means; cache and reasoning are shown apart. */
export const tokensOf = (m: Pick<Metrics, "input" | "output">): number => m.input + m.output;

export function metricOf(m: Metrics, metric: Metric): number {
  return metric === "tokens" ? tokensOf(m) : metric === "cost" ? m.cost : m.messages;
}

export function keyOf(row: { projectPath: string; agent: string; model: string }, g: GroupBy) {
  return g === "project" ? row.projectPath : g === "agent" ? row.agent : row.model;
}

// ── Labels ─────────────────────────────────────────────────────────────────

export function projectLabel(path: string, data?: UsageDashboard | null): string {
  if (data && path === data.byokProjectPath) return "BYOK chat";
  const known = data?.projects.find((p) => p.projectPath === path);
  return known?.projectName ?? path.split("/").filter(Boolean).pop() ?? path;
}

export function agentDisplay(agent: string, resolveAgent: AgentMetaResolver): string {
  if (agent === BYOK_AGENT) return "BYOK";
  if (agent === UNKNOWN) return "Unknown agent";
  return agentLabel(agent, resolveAgent);
}

export function modelDisplay(model: string): string {
  if (model === UNKNOWN) return "Unknown model";
  const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  return prettyModel(bare) ?? bare;
}

export function labelFor(
  key: string,
  g: GroupBy,
  data: UsageDashboard | null,
  resolveAgent: AgentMetaResolver,
): string {
  return g === "project"
    ? projectLabel(key, data)
    : g === "agent"
      ? agentDisplay(key, resolveAgent)
      : modelDisplay(key);
}

// ── Facets ─────────────────────────────────────────────────────────────────

export interface FacetOption {
  value: string;
  label: string;
  /** Tokens (in+out) behind the option, for the count/size badge and the ordering. */
  tokens: number;
  rows: number;
}

/** Every value present on each axis, heaviest first — computed over range-filtered rows. */
export function facetsOf(
  rows: DailyBucket[],
  data: UsageDashboard | null,
  resolveAgent: AgentMetaResolver,
) {
  const collect = (g: GroupBy): FacetOption[] => {
    const acc = new Map<string, { tokens: number; rows: number }>();
    for (const r of rows) {
      const k = keyOf(r, g);
      const cur = acc.get(k) ?? { tokens: 0, rows: 0 };
      cur.tokens += tokensOf(r);
      cur.rows += 1;
      acc.set(k, cur);
    }
    return [...acc.entries()]
      .map(([value, v]) => ({ value, label: labelFor(value, g, data, resolveAgent), ...v }))
      .sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
  };
  return { projects: collect("project"), agents: collect("agent"), models: collect("model") };
}

// ── Ranking / series ───────────────────────────────────────────────────────

export interface RankedKey {
  key: string;
  label: string;
  metrics: Metrics;
  value: number;
  /** 0..1 share of the sum over all keys. */
  share: number;
}

export function rankBy(
  rows: DailyBucket[],
  g: GroupBy,
  metric: Metric,
  data: UsageDashboard | null,
  resolveAgent: AgentMetaResolver,
): RankedKey[] {
  const acc = new Map<string, Metrics>();
  for (const r of rows) {
    const k = keyOf(r, g);
    acc.set(k, addMetrics(acc.get(k) ?? { ...EMPTY_METRICS }, r));
  }
  const total = [...acc.values()].reduce((s, m) => s + metricOf(m, metric), 0);
  return [...acc.entries()]
    .map(([key, metrics]) => {
      const value = metricOf(metrics, metric);
      return {
        key,
        label: labelFor(key, g, data, resolveAgent),
        metrics,
        value,
        share: total > 0 ? value / total : 0,
      };
    })
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

/**
 * A key's colour, stable across range and metric changes.
 *
 * Projects index off the payload's own project order rather than off their
 * rank in the current window, because a project that keeps its colour is the
 * whole value of having one: rank-indexed colours meant toggling Tokens → Cost
 * repainted the entire chart, and the table dot beside a project name could
 * disagree with the legend two cards above it. Agents and models have no
 * comparable stable list on the wire, so they take their rank position.
 */
export function colorFor(
  key: string,
  g: GroupBy,
  data: UsageDashboard | null,
  rankIndex: number,
  color: (i: number) => string,
): string {
  if (g !== "project" || !data) return color(rankIndex);
  if (key === data.byokProjectPath) return color(data.projects.length);
  const i = data.projects.findIndex((p) => p.projectPath === key);
  return color(i >= 0 ? i : rankIndex);
}

export const MAX_SERIES = 8;
export const OTHER_KEY = "__other__";
/** Above this many days the chart buckets by week — 90 daily columns still read, 365 don't. */
export const WEEK_BUCKET_ABOVE_DAYS = 120;

export interface SeriesKey {
  key: string;
  label: string;
  color: string;
}

export interface SeriesColumn {
  /** Bucket id: the day key, or the Monday key when bucketed by week. */
  date: string;
  /** Per series key, in `keys` order. */
  values: number[];
  total: number;
}

export interface Series {
  bucket: "day" | "week";
  keys: SeriesKey[];
  columns: SeriesColumn[];
  max: number;
}

/**
 * The stacked daily (or weekly) series for the chart. Every bucket in the range is present,
 * including empty ones, so gaps show as gaps. Keys beyond the top `MAX_SERIES` fold into
 * "Other".
 */
export function series(
  rows: DailyBucket[],
  g: GroupBy,
  metric: Metric,
  range: ResolvedRange,
  data: UsageDashboard | null,
  color: (i: number) => string,
  otherColor: string,
  resolveAgent: AgentMetaResolver,
): Series {
  const from =
    range.from ??
    rows.reduce<string | null>((m, r) => (m === null || r.date < m ? r.date : m), null);
  if (from === null) return { bucket: "day", keys: [], columns: [], max: 0 };
  const bucket: "day" | "week" = spanDays(from, range.to) > WEEK_BUCKET_ABOVE_DAYS ? "week" : "day";
  const bucketOf = bucket === "day" ? (d: string) => d : weekKey;

  const ranked = rankBy(rows, g, metric, data, resolveAgent);
  const top = ranked.slice(0, MAX_SERIES);
  const hasOther = ranked.length > MAX_SERIES;
  const keys: SeriesKey[] = top.map((r, i) => ({
    key: r.key,
    label: r.label,
    color: colorFor(r.key, g, data, i, color),
  }));
  if (hasOther) keys.push({ key: OTHER_KEY, label: "Other", color: otherColor });
  const index = new Map(keys.map((k, i) => [k.key, i]));

  const columns = new Map<string, SeriesColumn>();
  // Walk every bucket in the range so empty ones exist.
  for (let d = bucketOf(from); d <= range.to;) {
    columns.set(d, { date: d, values: keys.map(() => 0), total: 0 });
    const next = bucket === "day" ? addDaysLocal(d, 1) : addDaysLocal(d, 7);
    if (next <= d) break;
    d = next;
  }
  for (const r of rows) {
    const col = columns.get(bucketOf(r.date));
    if (!col) continue;
    const i = index.get(keyOf(r, g)) ?? (hasOther ? keys.length - 1 : -1);
    if (i < 0) continue;
    const v = metricOf(r, metric);
    col.values[i] += v;
    col.total += v;
  }
  const cols = [...columns.values()];
  return { bucket, keys, columns: cols, max: cols.reduce((m, c) => Math.max(m, c.total), 0) };
}

function addDaysLocal(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, (m ?? 1) - 1, (d ?? 1) + n);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

// ── Per-day series, for the headline sparklines ────────────────────────────

/**
 * One entry per day in the range, in order, including days with nothing.
 *
 * The stat band's sparklines need a value per day whether or not anything
 * happened — a gap in a trend line is information, and a series that silently
 * skips quiet days draws a busy fortnight and a quiet one identically.
 */
export function dailyMetrics(rows: DailyBucket[], range: ResolvedRange): Metrics[] {
  const from =
    range.from ??
    rows.reduce<string | null>((m, r) => (m === null || r.date < m ? r.date : m), null);
  if (from === null) return [];
  const byDay = new Map<string, Metrics>();
  for (let d = from; d <= range.to; d = addDay(d)) byDay.set(d, { ...EMPTY_METRICS });
  for (const r of rows) {
    const cell = byDay.get(r.date);
    if (cell) addMetrics(cell, r);
  }
  return [...byDay.values()];
}

/** Distinct sessions per day, dated the way the sessions table dates them. */
export function sessionsPerDay(sessions: SessionRow[], range: ResolvedRange): number[] {
  const from =
    range.from ??
    sessions.reduce<string | null>((m, s) => {
      const d = epochToDay(s.lastActivityMs ?? s.startedMs);
      return m === null || d < m ? d : m;
    }, null);
  if (from === null) return [];
  const byDay = new Map<string, Set<string>>();
  for (let d = from; d <= range.to; d = addDay(d)) byDay.set(d, new Set());
  for (const s of sessions) {
    byDay.get(epochToDay(s.lastActivityMs ?? s.startedMs))?.add(s.sessionId);
  }
  return [...byDay.values()].map((set) => set.size);
}

/**
 * Cache hit rate per day, as a percentage.
 *
 * A day with no prompt tokens has no rate — not a rate of zero — so it reads
 * `null`, which the sparkline draws as an empty column rather than a floor.
 */
export function cacheRatePerDay(days: Metrics[]): Array<number | null> {
  return days.map((d) => {
    const prompt = d.input + d.cacheRead + d.cacheWrite;
    return prompt > 0 ? (d.cacheRead / prompt) * 100 : null;
  });
}

function addDay(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, (m ?? 1) - 1, (d ?? 1) + 1);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

// ── Efficiency ─────────────────────────────────────────────────────────────

export interface Efficiency {
  /** cacheRead / (input + cacheRead + cacheWrite): the share of prompt tokens served from cache. */
  cacheHitRate: number | null;
  /** output / input. */
  outputPerInput: number | null;
  costPerSession: number | null;
  costPerMessage: number | null;
  tokensPerSession: number | null;
  /** cost / (output / 1000): what a thousand generated tokens effectively cost, all classes in. */
  blendedCostPer1kOutput: number | null;
}

const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

export function efficiency(totals: Metrics, sessionCount: number): Efficiency {
  const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
  return {
    cacheHitRate: ratio(totals.cacheRead, prompt),
    outputPerInput: ratio(totals.output, totals.input),
    costPerSession: ratio(totals.cost, sessionCount),
    costPerMessage: ratio(totals.cost, totals.messages),
    tokensPerSession: ratio(tokensOf(totals), sessionCount),
    blendedCostPer1kOutput: ratio(totals.cost, totals.output / 1000),
  };
}

/** Signed fractional change `now` vs `prev`; `null` when there is nothing to compare with. */
export function deltaPct(now: number, prev: number | null | undefined): number | null {
  if (prev === null || prev === undefined || prev <= 0) return null;
  return (now - prev) / prev;
}

/** Distinct sessions behind a set of daily rows — from `sessions[]`, which carries the ids. */
export function distinctSessions(sessions: SessionRow[]): number {
  return new Set(sessions.map((s) => s.sessionId)).size;
}

// ── Insights ───────────────────────────────────────────────────────────────

export interface Insight {
  id: string;
  /** The big number, already formatted. */
  stat: string;
  /** Sentence: the leading emphasised phrase, then the rest. */
  lead: string;
  rest: string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Rule-based sentences over the current window. Each rule contributes only when its data is
 * meaningful, so a quiet week may yield one insight and a busy one six.
 */
export function insights(args: {
  rows: DailyBucket[];
  totals: Metrics;
  prevTotals: Metrics | null;
  sessions: SessionRow[];
  data: UsageDashboard | null;
  fmtCost: (n: number) => string;
  fmtTokens: (n: number) => string;
  resolveAgent: AgentMetaResolver;
}): Insight[] {
  const { rows, totals, prevTotals, sessions, data, fmtCost, fmtTokens, resolveAgent } = args;
  const out: Insight[] = [];
  const tokens = tokensOf(totals);

  const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
  if (prompt > 0 && totals.cacheRead > 0) {
    const rate = totals.cacheRead / prompt;
    out.push({
      id: "cache",
      stat: pct(rate),
      lead: "of prompt tokens came from cache",
      rest:
        rate >= 0.5
          ? "— repeated context is being reused rather than re-sent."
          : "— most context is being re-sent each turn.",
    });
  }

  if (totals.cost > 0) {
    const top = rankBy(rows, "agent", "cost", data, resolveAgent)[0];
    if (top && top.share > 0) {
      out.push({
        id: "top-agent",
        stat: pct(top.share),
        lead: `of spend went to ${top.label}`,
        rest: `— ${fmtCost(top.value)} of ${fmtCost(totals.cost)} estimated.`,
      });
    }
    const model = rankBy(rows, "model", "cost", data, resolveAgent)[0];
    if (model && model.share > 0) {
      out.push({
        id: "top-model",
        stat: model.label,
        lead: "is the costliest model",
        rest: `— ${pct(model.share)} of the window's estimated spend.`,
      });
    }
  }

  if (prevTotals && tokensOf(prevTotals) > 0) {
    const d = deltaPct(tokens, tokensOf(prevTotals));
    if (d !== null && Math.abs(d) >= 0.05) {
      out.push({
        id: "period",
        stat: `${d > 0 ? "+" : "−"}${pct(Math.abs(d))}`,
        lead:
          d > 0 ? "more tokens than the previous period" : "fewer tokens than the previous period",
        rest: `— ${fmtTokens(tokens)} vs ${fmtTokens(tokensOf(prevTotals))}.`,
      });
    }
  }

  const byDow = new Map<number, number>();
  for (const r of rows) {
    const [y, m, d] = r.date.split("-").map(Number);
    const dow = new Date(y, (m ?? 1) - 1, d ?? 1).getDay();
    byDow.set(dow, (byDow.get(dow) ?? 0) + tokensOf(r));
  }
  if (byDow.size >= 3 && tokens > 0) {
    const [dow, v] = [...byDow.entries()].sort((a, b) => b[1] - a[1])[0];
    out.push({
      id: "weekday",
      stat: WEEKDAYS[dow],
      lead: "is the busiest day",
      rest: `— ${pct(v / tokens)} of the window's tokens.`,
    });
  }

  if (totals.input > 0 && totals.output > 0) {
    const r = totals.output / totals.input;
    out.push({
      id: "ratio",
      stat: r >= 1 ? `${r.toFixed(1)}×` : `1:${Math.round(1 / r)}`,
      lead: "output to input",
      rest:
        r < 0.1
          ? "— prompts dwarf answers; context is the cost driver here."
          : "— answers carry a meaningful share of the tokens.",
    });
  }

  const unpriced = sessions.filter((s) => s.cost === 0 && s.input + s.output > 0).length;
  if (unpriced > 0 && sessions.length > 0) {
    out.push({
      id: "unpriced",
      stat: String(unpriced),
      lead: unpriced === 1 ? "session has no price" : "sessions have no price",
      rest: "— the model is missing from the price map, so cost reads low.",
    });
  }

  return out;
}

import { useMemo } from "react";
import type { AgentMetaResolver } from "@/features/agents/lib/agent-identity";
import { useAgentMetaResolver } from "@/features/agents/lib/agent-meta-context";
import { fmtCost, fmtTokens } from "@/features/monitor/lib/usage-format";
import { useUsageStore } from "../stores/usage-store";
import type {
  DateRange,
  Facets,
  GroupBy,
  Metric,
  Metrics,
  SessionRow,
  TableTab,
  UsageDashboard,
} from "../types";
import { previousRange, resolveRange, type ResolvedRange } from "./date-range";
import {
  allDaily,
  applyFacets,
  dailyMetrics,
  sessionsPerDay,
  distinctSessions,
  efficiency,
  facetsOf,
  insights,
  projectLabel,
  agentDisplay,
  modelDisplay,
  rowsInRange,
  series,
  sessionsInRange,
  totalsOf,
  type Efficiency,
  type FacetOption,
  type Insight,
  type Series,
} from "./derive";
import { useSeriesPalette } from "./palette";
import type { DailyBucket } from "../types";

/** Everything the Usage tab renders, derived once per (data, range, facets, …) change. */
export interface UsageView {
  // raw state
  data: UsageDashboard | null;
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
  range: DateRange;
  facets: Facets;
  groupBy: GroupBy;
  metric: Metric;
  table: TableTab;
  search: string;
  // derived
  resolved: ResolvedRange;
  prev: ResolvedRange | null;
  all: DailyBucket[];
  inRange: DailyBucket[];
  rows: DailyBucket[];
  prevRows: DailyBucket[] | null;
  totals: Metrics;
  prevTotals: Metrics | null;
  sessions: SessionRow[];
  sessionCount: number;
  /** Distinct sessions in the previous period; `null` when there is none to compare with. */
  prevSessionCount: number | null;
  facetOptions: { projects: FacetOption[]; agents: FacetOption[]; models: FacetOption[] };
  chart: Series;
  eff: Efficiency;
  prevEff: Efficiency | null;
  /** One entry per day in the range, in order — the headline sparklines. */
  days: Metrics[];
  /** Distinct sessions per day, aligned to `days`. */
  sessionDays: number[];
  insightList: Insight[];
  /** Names agents in labels; pass it to any `derive.ts` call made from this view. */
  resolveAgent: AgentMetaResolver;
}

const EMPTY: DailyBucket[] = [];
const NO_SESSIONS: SessionRow[] = [];

/** Sessions whose title / project / agent / model contain `q` (case-insensitive). */
export function filterSessions(
  sessions: SessionRow[],
  q: string,
  data: UsageDashboard | null,
  resolveAgent: AgentMetaResolver,
): SessionRow[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return sessions;
  return sessions.filter((s) =>
    [
      s.title,
      s.projectPath,
      projectLabel(s.projectPath, data),
      s.agent,
      agentDisplay(s.agent, resolveAgent),
      s.model,
      modelDisplay(s.model),
    ].some((v) => v.toLowerCase().includes(needle)),
  );
}

/**
 * The derived view over the store. Each store field is selected on its own
 * (primitive selectors — never a fresh object from a selector), and every
 * derivation is memoised on exactly the inputs it reads so a `search`
 * keystroke re-filters sessions without re-bucketing the chart.
 */
export function useUsageView(): UsageView {
  const data = useUsageStore.use.data();
  const loading = useUsageStore.use.loading();
  const error = useUsageStore.use.error();
  const fetchedAt = useUsageStore.use.fetchedAt();
  const range = useUsageStore.use.range();
  const facets = useUsageStore.use.facets();
  const groupBy = useUsageStore.use.groupBy();
  const metric = useUsageStore.use.metric();
  const table = useUsageStore.use.table();
  const search = useUsageStore.use.search();
  // Resolved theme colours, rebuilt on `atlas:theme-applied` — the chart's
  // segments are inline styles and cannot follow a custom property.
  const { seriesColor, otherColor } = useSeriesPalette();
  const resolveAgent = useAgentMetaResolver();

  const resolved = useMemo(() => resolveRange(range), [range]);
  const prev = useMemo(() => previousRange(resolved), [resolved]);
  const all = useMemo(() => (data ? allDaily(data) : EMPTY), [data]);
  const inRange = useMemo(() => rowsInRange(all, resolved), [all, resolved]);
  const rows = useMemo(() => applyFacets(inRange, facets), [inRange, facets]);
  const prevRows = useMemo(
    () => (prev ? applyFacets(rowsInRange(all, prev), facets) : null),
    [all, prev, facets],
  );
  const totals = useMemo(() => totalsOf(rows), [rows]);
  const prevTotals = useMemo(() => (prevRows ? totalsOf(prevRows) : null), [prevRows]);

  const facetedSessions = useMemo(
    () => (data ? applyFacets(sessionsInRange(data.sessions, resolved), facets) : NO_SESSIONS),
    [data, resolved, facets],
  );
  const prevSessionCount = useMemo(
    () =>
      data && prev
        ? distinctSessions(applyFacets(sessionsInRange(data.sessions, prev), facets))
        : null,
    [data, prev, facets],
  );
  const sessions = useMemo(
    () => filterSessions(facetedSessions, search, data, resolveAgent),
    [facetedSessions, search, data, resolveAgent],
  );
  const sessionCount = useMemo(() => distinctSessions(facetedSessions), [facetedSessions]);

  // Range-filtered but NOT facet-filtered, so picking one value never hides the others.
  const facetOptions = useMemo(
    () => facetsOf(inRange, data, resolveAgent),
    [inRange, data, resolveAgent],
  );

  const chart = useMemo(
    () => series(rows, groupBy, metric, resolved, data, seriesColor, otherColor, resolveAgent),
    [rows, groupBy, metric, resolved, data, seriesColor, otherColor, resolveAgent],
  );

  const eff = useMemo(() => efficiency(totals, sessionCount), [totals, sessionCount]);
  const prevEff = useMemo(
    () => (prevTotals ? efficiency(prevTotals, prevSessionCount ?? 0) : null),
    [prevTotals, prevSessionCount],
  );

  const days = useMemo(() => dailyMetrics(rows, resolved), [rows, resolved]);
  const sessionDays = useMemo(
    () => sessionsPerDay(facetedSessions, resolved),
    [facetedSessions, resolved],
  );

  const insightList = useMemo(
    () =>
      insights({
        rows,
        totals,
        prevTotals,
        sessions: facetedSessions,
        data,
        fmtCost,
        fmtTokens,
        resolveAgent,
      }),
    [rows, totals, prevTotals, facetedSessions, data, resolveAgent],
  );

  return {
    data,
    loading,
    error,
    fetchedAt,
    range,
    facets,
    groupBy,
    metric,
    table,
    search,
    resolved,
    prev,
    all,
    inRange,
    rows,
    prevRows,
    totals,
    prevTotals,
    sessions,
    sessionCount,
    prevSessionCount,
    facetOptions,
    chart,
    eff,
    prevEff,
    days,
    sessionDays,
    insightList,
    resolveAgent,
  };
}

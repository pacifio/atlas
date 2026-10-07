import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Card } from "@/components/usage-primitives";
import { GradualBlur } from "@/components/gradual-blur";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useUsageStore } from "../stores/usage-store";
import { useUsageView } from "../lib/use-usage-view";
import { copyMarkdownReport, exportJpeg, exportMarkdown, exportPdf } from "../lib/export";
import { fmtDay, resolveRange } from "../lib/date-range";
import { rankBy } from "../lib/derive";
import { ClassTrackers } from "./class-trackers";
import { DailyGlyphChart } from "./daily-glyph-chart";
import { EfficiencyCard } from "./efficiency-card";
import { FilterBar } from "./filter-bar";
import { InsightsCard } from "./insights-card";
import { StatStrip } from "./stat-strip";
import { UsageHeader, type ExportKind } from "./usage-header";
import { UsageTables } from "./usage-tables";

/**
 * The Usage tab: the organisation's token usage, filtered client-side over one payload.
 *
 * Order, top to bottom: the headline band, the token classes, the daily series and its
 * insight side by side, the efficiency report, then the tables. Everything above the tables
 * is the export capture region. Sections follow the composer Usage pill's grammar — nested
 * cards, count-ups, tick meters — and share its primitives.
 */
export function UsagePanel() {
  const view = useUsageView();
  const {
    refresh,
    setRange,
    toggleFacet,
    clearFacets,
    setGroupBy,
    setMetric,
    setTable,
    setSearch,
  } = useUsageStore.use.actions();
  const orgName = useOrgStore((s) => {
    const id = s.activeOrganisationId;
    return s.organisations.find((o) => o.id === id)?.name ?? null;
  });
  // Re-fetch when the org's project set changes (this also covers an org switch).
  const projectSig = useProjectStore((s) => s.projects.map((p) => p.path).join("|"));
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSig]);

  const captureRef = useRef<HTMLDivElement>(null);
  // A boolean, not the offset: this only ever flips at the very top, so the
  // panel re-renders twice per scroll session rather than once per frame.
  const [scrolled, setScrolled] = useState(false);
  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrolled(e.currentTarget.scrollTop > 2);
  }, []);

  const onExport = async (kind: ExportKind) => {
    if (!view.data) return;
    try {
      if (kind === "copy-markdown") {
        if (!(await copyMarkdownReport(view))) throw new Error("clipboard write failed");
        toast.success("Copied Markdown report");
        return;
      }
      if (kind === "markdown") await exportMarkdown(view);
      else if (captureRef.current) {
        if (kind === "pdf") await exportPdf(captureRef.current);
        else await exportJpeg(captureRef.current);
      }
      toast.success(`Exported ${kind.toUpperCase()}`);
    } catch (e) {
      toast.error(`Export failed: ${String(e)}`);
    }
  };

  const { data, loading, error, range, facets, groupBy, metric, table, search } = view;
  const earliest = data ? (data.daily[0]?.date ?? null) : null;
  const attribution = attributionLine(data?.ledgerSince ?? null, range);

  return (
    // The tab is a card on a slightly lighter ground, the way the Timeline is:
    // the page's content sits INSIDE a rounded, ringed panel rather than
    // bleeding into the window's edges. Same inset constant, so the two tabs
    // line up when they sit side by side in a split.
    <div className="flex h-full min-h-0 flex-col bg-[var(--card)]">
      <UsageHeader
        orgName={orgName}
        range={range}
        onRange={setRange}
        earliest={earliest}
        onExport={(k) => void onExport(k)}
        onRefresh={() => void refresh({ force: true })}
        loading={loading}
        canExport={!!data}
        inset={CARD_INSET}
      />
      <div
        // `ring-1 ring-border` + `shadow-lg`, which is the Timeline's card
        // exactly: on a near-black panel a shadow has almost nothing to darken,
        // so the ring carries the edge and the shadow only lifts the card.
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-background shadow-lg ring-1 ring-border"
        style={{ marginInline: CARD_INSET, marginBottom: CARD_INSET }}
      >
        <div
          className="hide-scrollbar min-h-0 flex-1 overflow-y-auto"
          style={{ paddingTop: data ? FILTER_H : 0 }}
          onScroll={onScroll}
        >
          {!data && loading && (
            <div className="p-6 text-sm text-[var(--muted-foreground)]">Reading usage…</div>
          )}
          {error && (
            <div className="p-6 text-sm text-[var(--atlas-status-error-foreground)]">
              Failed to load: {error}
            </div>
          )}
          {data && view.all.length === 0 && !loading && (
            <div className="p-4">
              <Card index={0} section="empty">
                <div className="text-xs font-medium text-[var(--foreground)]">Nothing yet</div>
                <div className="mt-0.5 text-2xs leading-snug text-[var(--muted-foreground)]">
                  Usage appears after the first agent turn in one of this organization's projects.
                </div>
              </Card>
            </div>
          )}
          {data && view.all.length > 0 && (
            <div className="flex flex-col gap-3 p-4">
              <div ref={captureRef} className="flex flex-col gap-3 bg-[var(--background)]">
                <StatStrip
                  totals={view.totals}
                  prevTotals={view.prevTotals}
                  sessionCount={view.sessionCount}
                  prevSessionCount={view.prevSessionCount}
                  eff={view.eff}
                  prevEff={view.prevEff}
                  days={view.days}
                  sessionDays={view.sessionDays}
                />
                <ClassTrackers totals={view.totals} />
                {/* Chart and insight share a row. The insight is a sentence
                    ABOUT the series beside it, so reading one used to mean
                    scrolling past the other — and the ranked list that held
                    this slot said what the Projects / Agents / Models tables
                    below already say, at less precision. */}
                <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
                  <div className="min-w-0 xl:col-span-2">
                    <DailyGlyphChart
                      series={view.chart}
                      metric={metric}
                      groupBy={groupBy}
                      attribution={attribution}
                    />
                  </div>
                  <InsightsCard insights={view.insightList} />
                </div>
                <EfficiencyCard
                  eff={view.eff}
                  prevEff={view.prevEff}
                  rows={view.rows}
                  sessions={view.sessions}
                  groupBy={groupBy}
                  data={data}
                />
              </div>
              <UsageTables
                tab={table}
                onTab={setTable}
                sessions={view.sessions}
                sessionsTotal={data.sessionsTotal}
                ranked={{
                  projects: rankBy(view.rows, "project", "tokens", data),
                  agents: rankBy(view.rows, "agent", "tokens", data),
                  models: rankBy(view.rows, "model", "tokens", data),
                }}
                data={data}
                search={search}
                onSearch={setSearch}
              />
            </div>
          )}
        </div>

        {/* The filters belong to the body, not to the window chrome: they narrow
          what is in the card, so they sit ON the card. Floating rather than in
          flow means content passes UNDER them, and the progressive blur behind
          makes that legible — the same treatment the agent transcript gives its
          own floating header (`transcript.tsx`). A backdrop-filter can only
          blur what is painted behind it, so the blur has to be a sibling of the
          scroller rather than a child of it, or it would scroll away with the
          content it is meant to soften. */}
        {data && (
          <>
            {/* Only once the content has actually moved. At rest the band sat
                over the stat card's own captions and softened them for nothing —
                there is no content passing under the row to dissolve yet. */}
            <GradualBlur
              position="top"
              height={`${FILTER_TOP + PILL_H + 14 + TOP_BLUR_RAMP}px`}
              strength={2.1}
              layers={scrolled ? 5 : 0}
              tint={scrolled ? "color-mix(in srgb, var(--background) 90%, transparent)" : undefined}
              className="z-10"
            />
            <FilterBar
              className="absolute inset-x-0 top-0 z-20"
              style={{ paddingTop: FILTER_TOP }}
              facets={facets}
              options={view.facetOptions}
              onToggle={toggleFacet}
              onClear={clearFacets}
              groupBy={groupBy}
              onGroupBy={setGroupBy}
              metric={metric}
              onMetric={setMetric}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The card's inset from the tab's edges, in px. Matches the Timeline's, which
 * is what it is measured against — the two tabs sit side by side in a split.
 */
const CARD_INSET = 4;

/**
 * The floating filter row's geometry.
 *
 * `FILTER_TOP` is the gap above the pills, and it matches the gap the content
 * below leaves under them — the row used to hug the card's top edge with all
 * its slack underneath, which read as the pills having fallen off the top.
 * `FILTER_H` is what the scroller reserves: the gap, the pills, and the gap
 * again, minus the content's own 16px padding, which supplies the lower half.
 */
const FILTER_TOP = 14;
const PILL_H = 26;
const FILTER_H = FILTER_TOP + PILL_H + 14 - 16;
const TOP_BLUR_RAMP = 28;

/** How the chart's days are dated — honest about the pre-ledger window. */
function attributionLine(
  ledgerSince: string | null,
  range: Parameters<typeof resolveRange>[0],
): string {
  if (!ledgerSince) return "dated to each session's last-active day";
  const sinceDay = ledgerSince.slice(0, 10);
  const r = resolveRange(range);
  if (r.from !== null && r.from >= sinceDay) return "dated per turn";
  return `dated per turn since ${fmtDay(sinceDay)}; earlier by last-active day`;
}

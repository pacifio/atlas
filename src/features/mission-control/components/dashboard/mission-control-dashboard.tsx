import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useWorkspaceStore } from "@/features/workspaces/stores/workspace-store";
import { useMissionControlStore } from "../../stores/mission-control-store";
import { RANGE_DAYS } from "../../types";
import { copyMarkdownReport, exportJpeg, exportMarkdown, exportPdf } from "../../lib/export";
import { DashboardHeader } from "./dashboard-header";
import { StatCards } from "./stat-cards";
import { UsageAreaChart } from "./usage-area-chart";
import { ConsumptionPie } from "./consumption-pie";
import { UsageBarChart } from "./usage-bar-chart";
import { GanttTimeline } from "./gantt-timeline";
import { LogsTable } from "./logs-table";

export function MissionControlDashboard() {
  const data = useMissionControlStore.use.data();
  const range = useMissionControlStore.use.range();
  const loading = useMissionControlStore.use.loading();
  const error = useMissionControlStore.use.error();
  const { setRange, refresh } = useMissionControlStore.use.actions();
  // Re-fetch when the set of workspaces changes.
  const wsSig = useWorkspaceStore((s) => s.workspaces.map((w) => w.path).join("|"));

  // Node captured for image/PDF export (cards + charts + gantt).
  const captureRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsSig]);

  const rangeDays = RANGE_DAYS[range];

  const onExport = async (kind: "pdf" | "jpeg" | "markdown" | "copy-markdown") => {
    if (!data) return;
    try {
      if (kind === "copy-markdown") {
        const ok = await copyMarkdownReport(data);
        if (!ok) throw new Error("clipboard write failed");
        toast.success("Copied Markdown report");
        return;
      }
      if (kind === "markdown") await exportMarkdown(data);
      else if (captureRef.current) {
        if (kind === "pdf") await exportPdf(captureRef.current);
        else await exportJpeg(captureRef.current);
      }
      toast.success(`Exported ${kind.toUpperCase()}`);
    } catch (e) {
      toast.error(`Export failed: ${String(e)}`);
    }
  };

  return (
    <div className="h-full flex flex-col bg-[var(--bg-base)]">
      <DashboardHeader
        range={range}
        onRange={setRange}
        onExport={(k) => void onExport(k)}
        onRefresh={() => void refresh()}
        loading={loading}
      />

      <div className="flex-1 min-h-0 overflow-y-auto">
        {!data && loading && (
          <div className="p-6 text-[12px] text-[var(--text-tertiary)]">Loading metrics…</div>
        )}
        {error && (
          <div className="p-6 text-[12px] text-[var(--status-error)]">Failed to load: {error}</div>
        )}
        {data && (
          <div className="p-4 space-y-4">
            {/* Captured region for image/PDF export. */}
            <div ref={captureRef} className="space-y-4 bg-[var(--bg-base)]">
              <StatCards data={data} />
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="lg:col-span-2">
                  <UsageAreaChart data={data} rangeDays={rangeDays} />
                </div>
                <ConsumptionPie data={data} />
              </div>
              <UsageBarChart data={data} />
              <GanttTimeline data={data} />
            </div>

            {/* Logs table — full width, generous height. */}
            <div className="h-[460px]">
              <LogsTable projects={data.projects} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

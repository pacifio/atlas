import { lazy, Suspense } from "react";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "../stores/layout-store";
import { FileTree } from "@/features/explorer/components/file-tree";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { BarChart3, ChevronDown, RefreshCw } from "lucide-react";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useUsageReport } from "@/features/monitor/stores/usage-report-store";

// The project "Usage" report (token/cost donut). Lazy — it reads the
// on-disk Claude session stats only when the user expands it.
const UsagePanel = lazy(() =>
  import("@/features/monitor/components/usage-panel").then((m) => ({
    default: m.UsagePanel,
  })),
);

/**
 * Left panel (Cmd+B) — now a pure, performative FILE TREE. The old section
 * switcher (Files / Knowledge / Analysis / Explore) was removed: analysis +
 * explore (project symbol analysis) are gone entirely, and knowledge lives in
 * its own KB tab. `FileTree` renders its own header (workspace name on the
 * left, expand/collapse-all + open-folder on the right). A collapsible project
 * "Usage" report stays docked at the bottom.
 */
export function LeftPanel() {
  const usagePanelVisible = useLayoutStore((s) => s.leftPanel.usagePanelVisible);
  const { toggleUsagePanel } = useLayoutStore.use.actions();
  const cwd = useProjectStore((s) => s.currentProject?.path ?? null);
  const loadUsage = useUsageReport((s) => s.load);
  const usageLoading = useUsageReport((s) => s.loadingCwd === cwd);

  return (
    <div className="atlas-vibrant-panel h-full flex flex-col bg-[var(--panel-bg)]">
      {/* File tree fills the panel; it carries its own header (name + actions). */}
      <div className="flex-1 min-h-0">
        <FileTree />
      </div>

      {/* Project usage report — collapsible accordion at the bottom. */}
      <div
        className={cn(
          "border-t border-border-default flex flex-col shrink-0",
          usagePanelVisible ? "min-h-[200px] max-h-[50%]" : "",
        )}
      >
        <div className="flex items-center justify-between px-3 h-[28px] shrink-0 hover:bg-bg-hover transition-colors">
          <button
            type="button"
            onClick={toggleUsagePanel}
            className="flex items-center gap-1.5 flex-1 min-w-0 text-left text-[11px] font-medium text-text-secondary cursor-pointer"
            title={usagePanelVisible ? "Collapse usage" : "Expand usage"}
          >
            <BarChart3 size={12} className="shrink-0" />
            <span>Usage</span>
          </button>
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (cwd) void loadUsage(cwd);
              }}
              className={cn(
                "p-0.5 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-active transition-colors",
                usageLoading && "animate-spin",
              )}
              title="Refresh usage"
            >
              <RefreshCw size={11} />
            </button>
            <button
              type="button"
              onClick={toggleUsagePanel}
              className="p-0.5 rounded text-text-tertiary cursor-pointer"
              title={usagePanelVisible ? "Collapse usage" : "Expand usage"}
            >
              <ChevronDown
                size={12}
                className={cn("transition-transform", !usagePanelVisible && "-rotate-90")}
              />
            </button>
          </div>
        </div>
        {usagePanelVisible && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <Suspense fallback={<PanelSkeleton rows={3} />}>
              <UsagePanel />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}

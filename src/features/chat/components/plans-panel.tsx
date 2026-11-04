import { useCallback, useEffect, useState } from "react";
import { ClipboardList } from "lucide-react";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { usePaneTopInset } from "@/features/layout/lib/pane-top-inset";
import { useAppStore } from "@/features/app/stores/app-store";
import type { PlanRecord } from "../lib/plans";
import { loadPlans } from "../lib/plans-api";
import { SidePanelFrameView } from "./views/side-panel-frame-view";
import { PlansPanelView } from "./views/plans-panel-view";

interface PlansPanelProps {
  onClose: () => void;
}

/**
 * Persistent, cross-session list of every plan an agent has proposed for
 * this project — captured at the ExitPlanMode permission and stored in
 * `.atlas/plans.json`. Each entry shows the user message that triggered the
 * plan, a human timestamp, and the plan markdown (expandable). Mirrors the
 * bash-history panel's right-side slide-in overlay.
 */
export function PlansPanel({ onClose }: PlansPanelProps) {
  const plansPanel = useLayoutStore.use.plansPanel();
  // The session column's window bar floats over this pane (z-titlebar); start
  // below it, or the bar covers this panel's header and eats its clicks.
  const topInset = usePaneTopInset();
  const { setPlansPanelWidth } = useLayoutStore.use.actions();
  const projectPath = useAppStore.use.currentProject()?.path ?? null;

  const [plans, setPlans] = useState<PlanRecord[]>([]);

  const load = useCallback(() => {
    if (!projectPath) return;
    void loadPlans(projectPath)
      .then(setPlans)
      .catch(() => {});
  }, [projectPath]);

  // Load on open, and refresh whenever a new plan is captured mid-session.
  useEffect(() => {
    load();
    const onSaved = () => load();
    window.addEventListener("atlas:plan-saved", onSaved);
    return () => window.removeEventListener("atlas:plan-saved", onSaved);
  }, [load]);

  return (
    <SidePanelFrameView
      panel="plans"
      icon={ClipboardList}
      title="Plans"
      count={plans.length}
      width={plansPanel.width}
      top={topInset}
      onWidthChange={setPlansPanelWidth}
      onClose={onClose}
      closeLabel="Hide plans"
    >
      <PlansPanelView plans={plans} fileRoot={projectPath} />
    </SidePanelFrameView>
  );
}

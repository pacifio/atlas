import { memo } from "react";
import { useChatStore } from "../stores/chat-store";
import { isBusyAgentStatus } from "@/types/agent";
import { ComposerDropup, useComposerDropup } from "./composer-dropup";
import { PlanTasksListView, PlanTasksTriggerView } from "./views/plan-tasks-pill-view";

/**
 * The live plan as a composer-footer pill + its own morphing dropup panel —
 * replaces the old PlanDock strip above the composer. The pill carries a
 * determinate arc ring (completed/total) and the count; the panel is the
 * beui-style "Implementation plan" list: circled-check + strikethrough for
 * done, a spinning arc for the in-progress step, a faint circle for pending.
 *
 * Same live-only semantics as the dock it replaces: `livePlan` resets on every
 * (re)bind, and the pill hides the moment the turn is no longer active — a
 * finished plan lives on in the thread, never as stale composer chrome.
 *
 * Same interaction grammar as the composer's other menus: height-morph panel
 * (ResizeObserver → height tween), Esc/outside closes, and it participates in
 * the `atlas:composer-menu-open` mutual-exclusion signal.
 */

export const PlanTasksPill = memo(function PlanTasksPill({ tabId }: { tabId: string }) {
  const plan = useChatStore((s) => s.sessions[tabId]?.livePlan);
  const status = useChatStore((s) => s.sessions[tabId]?.status);
  const { open, toggle, ref, contentRef, panelHeight } = useComposerDropup("plan", {
    measureKey: plan?.length,
  });

  // Live-only, mirroring the dock this replaces (see module docs).
  if (!plan || plan.length === 0) return null;
  if (!isBusyAgentStatus(status ?? "idle")) return null;

  const completed = plan.filter((s) => s.status === "completed").length;

  return (
    <div ref={ref} className="relative">
      {/* Morphing panel — right-anchored dropup, shared with the options and
          usage pills. */}
      <ComposerDropup open={open} panelHeight={panelHeight} contentRef={contentRef} width={320}>
        <PlanTasksListView steps={plan} open={open} />
      </ComposerDropup>
      <PlanTasksTriggerView
        completed={completed}
        total={plan.length}
        open={open}
        onToggle={toggle}
      />
    </div>
  );
});

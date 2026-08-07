import { memo, useState } from "react";
import { CheckCircle2, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useChatStore } from "../stores/chat-store";
import { isBusyAgentStatus, type PlanStep } from "@/types/agent";

/**
 * Live plan panel docked directly on top of the chat input bar
 * (JetBrains-Air / Zed style). Reuses the attached-panel recipe from
 * `CodebaseIndexBanner` (memory chat): a sibling rendered *before* the composer
 * box, tucked behind it via `-mb-3.5` + `rounded-t-xl`, so it reads as an
 * attached tab of the input.
 *
 * - Expanded: the full step list (checkmark / spinner / hollow-circle).
 * - Collapsed: a one-liner "PLAN n/m · <current step>" with the in-motion step.
 * - Hidden entirely when there's no live plan, or the plan is complete and the
 *   turn is no longer busy.
 */
function planCurrentStep(steps: PlanStep[]): PlanStep | undefined {
  return steps.find((s) => s.status === "in_progress") ?? steps.find((s) => s.status === "pending");
}

function StepIcon({ status }: { status: PlanStep["status"] }) {
  if (status === "completed")
    return <CheckCircle2 size={12} className="text-[var(--status-success)]" />;
  if (status === "in_progress")
    return <Loader2 size={12} className="animate-spin text-[var(--accent-primary)]" />;
  return <div className="h-3 w-3 rounded-full border border-[var(--border-strong)]" />;
}

export const PlanDock = memo(function PlanDock({ tabId }: { tabId: string }) {
  const plan = useChatStore((s) => s.sessions[tabId]?.livePlan);
  const status = useChatStore((s) => s.sessions[tabId]?.status);
  const [collapsed, setCollapsed] = useState(false);

  if (!plan || plan.length === 0) return null;

  const completed = plan.filter((s) => s.status === "completed").length;
  const busy = isBusyAgentStatus(status ?? "idle");
  // The dock is a LIVE indicator pinned to the composer: hide it as soon as the
  // turn is no longer active (idle / error) — a finished plan lives on in the
  // thread, and a session switched to while idle must not show a stale plan.
  // Combined with `livePlan` being reset on every (re)bind and re-derived from
  // the snapshot on load, this gives per-session plan visibility: present only
  // while THAT session is actively running/awaiting a plan.
  if (!busy) return null;

  const current = planCurrentStep(plan);

  return (
    <div
      className={cn(
        // Attached-panel recipe (see CodebaseIndexBanner): narrower than the
        // input, top-rounded, extra bottom padding tucked under the composer.
        "relative z-0 mx-2 -mb-3.5 rounded-t-xl bg-[var(--bg-tertiary)]",
        "px-3.5 pt-1.5 pb-5 text-[11px]",
      )}
    >
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-2 text-left"
      >
        {collapsed ? (
          <ChevronRight size={12} className="text-[var(--text-tertiary)]" />
        ) : (
          <ChevronDown size={12} className="text-[var(--text-tertiary)]" />
        )}
        <span className="font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
          Plan {completed}/{plan.length}
        </span>
        {collapsed && current && (
          <span className="flex min-w-0 items-center gap-1.5 text-[var(--text-secondary)]">
            <span className="text-[var(--text-tertiary)]">·</span>
            {busy && current.status === "in_progress" && (
              <Loader2 size={11} className="shrink-0 animate-spin text-[var(--accent-primary)]" />
            )}
            <span className="truncate">{current.description}</span>
          </span>
        )}
      </button>

      {!collapsed && (
        <div className="mt-1.5 space-y-1">
          {plan.map((step) => (
            <div key={step.id} className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0">
                <StepIcon status={step.status} />
              </span>
              <span
                className={cn(
                  step.status === "completed"
                    ? "text-[var(--text-tertiary)] line-through"
                    : "text-[var(--text-secondary)]",
                )}
              >
                {step.description}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

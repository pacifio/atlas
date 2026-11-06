import { ChevronUp, ListTodo } from "lucide-react";
import { cn } from "@/lib/utils";
import { composerPillClass } from "../../lib/composer-pill-class";

/**
 * The live plan pill, drawn from props: the footer trigger (an arc ring and
 * the count) and the "Implementation plan" list its dropup shows. The
 * container, `plan-tasks-pill.tsx`, reads the session's plan and owns the
 * dropup.
 */

export interface PlanStepView {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
}

/** Determinate progress ring (the pill's arc). `frac` 0..1. */
function ArcRing({ frac, size = 14 }: { frac: number; size?: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="shrink-0 -rotate-90" aria-hidden>
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="opacity-25"
      />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${Math.max(0.001, frac) * c} ${c}`}
        style={{
          transition: "stroke-dasharray 300ms cubic-bezier(0.32,0.72,0,1)",
        }}
      />
    </svg>
  );
}

/** Per-row status glyph: check / spinning arc / faint circle. `active` gates
 *  the in-progress spin: the panel stays MOUNTED while closed (height 0), and
 *  an `animation: … infinite` keeps running under `height: 0` — a continuous
 *  compositor tax for the entire streaming turn, live during exactly the
 *  scroll-while-streaming window where transcript blanking shows. */
function StepIcon({ status, active }: { status: PlanStepView["status"]; active: boolean }) {
  if (status === "completed") {
    return (
      <svg
        width={16}
        height={16}
        viewBox="0 0 16 16"
        className="shrink-0 text-muted-foreground"
        aria-hidden
      >
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M5.2 8.2 7.2 10.2 11 5.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (status === "in_progress") {
    return (
      <svg
        width={16}
        height={16}
        viewBox="0 0 16 16"
        className={cn("shrink-0 text-foreground", active && "atlas-arc-spin")}
        aria-hidden
      >
        <circle
          cx="8"
          cy="8"
          r="6.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="opacity-20"
        />
        <circle
          cx="8"
          cy="8"
          r="6.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="12 29"
        />
      </svg>
    );
  }
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      className="shrink-0 text-border-strong"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function PlanTasksTriggerView({
  completed,
  total,
  open,
  onToggle,
}: {
  completed: number;
  total: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      data-plan-pill
      className={cn(composerPillClass(open), "gap-1.5 px-2")}
      title="Implementation plan"
    >
      <span className="text-primary">
        <ArcRing frac={total ? completed / total : 0} />
      </span>
      <span className="tnum">
        {completed}/{total}
      </span>
      <ChevronUp
        size={10}
        className={cn(
          "shrink-0 text-muted-foreground transition-transform duration-200",
          open && "rotate-180",
        )}
      />
    </button>
  );
}

export function PlanTasksListView({ steps, open }: { steps: PlanStepView[]; open: boolean }) {
  const completed = steps.filter((s) => s.status === "completed").length;
  return (
    <>
      <div className="flex h-9 items-center gap-2 px-3">
        <ListTodo size={13} className="shrink-0 text-secondary-foreground" />
        <span className="flex-1 truncate text-sm font-medium text-foreground">
          Implementation plan
        </span>
        <span className="font-mono text-2xs tnum text-muted-foreground">
          {completed}/{steps.length}
        </span>
      </div>
      <div className="hide-scrollbar max-h-[260px] overflow-y-auto px-2 pb-2">
        {steps.map((step) => (
          <div key={step.id} className="flex min-h-8 items-center gap-2.5 rounded-lg px-1.5 py-1">
            <StepIcon status={step.status} active={open} />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm leading-5",
                step.status === "completed" &&
                  "text-muted-foreground line-through decoration-muted-foreground",
                step.status === "in_progress" && "text-foreground",
                step.status === "pending" && "text-secondary-foreground opacity-70",
              )}
            >
              {step.description}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

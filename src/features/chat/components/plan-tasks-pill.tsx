import { memo, useEffect, useRef, useState } from "react";
import { ChevronUp, ListTodo } from "lucide-react";
import { cn } from "@/lib/utils";
import { useChatStore } from "../stores/chat-store";
import { isBusyAgentStatus } from "@/types/agent";

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

/** Per-row status glyph: check / spinning arc / faint circle. */
function StepIcon({ status }: { status: string }) {
  if (status === "completed") {
    return (
      <svg width={16} height={16} viewBox="0 0 16 16" className="shrink-0" aria-hidden>
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" />
        <path
          d="M5.2 8.2 7.2 10.2 11 5.8"
          fill="none"
          stroke="var(--text-tertiary)"
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
        className="atlas-arc-spin shrink-0 text-[var(--text-primary)]"
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
    <svg width={16} height={16} viewBox="0 0 16 16" className="shrink-0" aria-hidden>
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="var(--border-strong)" strokeWidth="1.5" />
    </svg>
  );
}

export const PlanTasksPill = memo(function PlanTasksPill({ tabId }: { tabId: string }) {
  const plan = useChatStore((s) => s.sessions[tabId]?.livePlan);
  const status = useChatStore((s) => s.sessions[tabId]?.status);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [panelHeight, setPanelHeight] = useState(0);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onOther = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== "plan") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("atlas:composer-menu-open", onOther);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("atlas:composer-menu-open", onOther);
    };
  }, [open]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPanelHeight(el.offsetHeight));
    ro.observe(el);
    setPanelHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, [open, plan?.length]);

  // Live-only, mirroring the dock this replaces (see module docs).
  if (!plan || plan.length === 0) return null;
  if (!isBusyAgentStatus(status ?? "idle")) return null;

  const completed = plan.filter((s) => s.status === "completed").length;

  return (
    <div ref={ref} className="relative">
      {/* Morphing panel — right-anchored dropup. */}
      <div
        aria-hidden={!open}
        className="absolute bottom-full right-0 z-50 mb-1.5 w-[320px] overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-[var(--shadow-overlay)]"
        style={{
          height: open ? panelHeight : 0,
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "height 260ms cubic-bezier(0.32,0.72,0,1), opacity 180ms ease-out",
        }}
      >
        <div ref={contentRef}>
          <div className="flex h-9 items-center gap-2 px-3">
            <ListTodo size={13} className="shrink-0 text-[var(--text-secondary)]" />
            <span className="flex-1 truncate text-[12px] font-medium text-[var(--text-primary)]">
              Implementation plan
            </span>
            <span className="font-mono text-[10px] tabular-nums text-[var(--text-tertiary)]">
              {completed}/{plan.length}
            </span>
          </div>
          <div className="hide-scrollbar max-h-[260px] overflow-y-auto px-2 pb-2">
            {plan.map((step) => (
              <div
                key={step.id}
                className="flex min-h-8 items-center gap-2.5 rounded-lg px-1.5 py-1"
              >
                <StepIcon status={step.status} />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-[11.5px] leading-5",
                    step.status === "completed" &&
                      "text-[var(--text-tertiary)] line-through decoration-[var(--text-tertiary)]",
                    step.status === "in_progress" && "text-[var(--text-primary)]",
                    step.status === "pending" && "text-[var(--text-secondary)] opacity-70",
                  )}
                >
                  {step.description}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* The footer pill: arc progress + count. */}
      <button
        onClick={() => {
          setOpen((o) => {
            if (!o) {
              window.dispatchEvent(new CustomEvent("atlas:composer-menu-open", { detail: "plan" }));
            }
            return !o;
          });
        }}
        className={cn(
          "flex h-6.5 items-center gap-1.5 rounded-full border px-2 text-[10px] font-medium leading-none transition-colors cursor-pointer",
          open
            ? "border-[var(--border-strong)] bg-[var(--bg-selected)] text-[var(--text-primary)]"
            : "border-[var(--border-default)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
        )}
        title="Implementation plan"
      >
        <span className="text-[var(--accent-primary)]">
          <ArcRing frac={plan.length ? completed / plan.length : 0} />
        </span>
        <span className="tabular-nums">
          {completed}/{plan.length}
        </span>
        <ChevronUp
          size={10}
          className={cn(
            "shrink-0 text-[var(--text-tertiary)] transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>
    </div>
  );
});

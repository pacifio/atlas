import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ClipboardList, ChevronRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Markdown } from "@/lib/markdown";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import {
  type PlanRecord,
  formatPlanTimestamp,
  planTimeAgo,
} from "../lib/plans";

interface PlansPanelProps {
  onClose: () => void;
}

/**
 * Persistent, cross-session list of every plan Claude Code has proposed for
 * this project — captured at the ExitPlanMode permission and stored in
 * `.atlas/plans.json`. Each entry shows the user message that triggered the
 * plan, a human timestamp, and the plan markdown (expandable). Mirrors the
 * bash-history panel's right-side slide-in overlay.
 */
export function PlansPanel({ onClose }: PlansPanelProps) {
  const plansPanel = useLayoutStore.use.plansPanel();
  const { setPlansPanelWidth } = useLayoutStore.use.actions();
  const projectPath = useProjectStore.use.currentProject()?.path ?? null;

  const [plans, setPlans] = useState<PlanRecord[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    if (!projectPath) return;
    void invoke<PlanRecord[]>("plans_load", { projectPath })
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

  // Esc closes the overlay (it's a plain div, not a Radix dialog).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Left-edge resize handle (mirrors the bash panel).
  const resizeStartXRef = useRef<number | null>(null);
  const resizeStartWidthRef = useRef<number>(0);
  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      resizeStartXRef.current = e.clientX;
      resizeStartWidthRef.current = plansPanel.width;
      const onMove = (ev: MouseEvent) => {
        if (resizeStartXRef.current === null) return;
        // Panel is anchored right, so dragging left (smaller clientX) widens it.
        const delta = resizeStartXRef.current - ev.clientX;
        setPlansPanelWidth(resizeStartWidthRef.current + delta);
      };
      const onUp = () => {
        resizeStartXRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [plansPanel.width, setPlansPanelWidth],
  );

  return (
    <>
      {/* Scrim — click outside the panel to dismiss. */}
      <div
        className="absolute inset-0 z-20 bg-black/20 animate-fade-in"
        onClick={onClose}
        aria-hidden
      />
      <div
        style={{ width: plansPanel.width }}
        className="absolute right-0 top-0 bottom-0 z-30 flex flex-col border-l border-[var(--border-default)] bg-[var(--bg-sidebar)] shadow-[var(--shadow-overlay)] animate-slide-in-right"
      >
        {/* Left-edge resize handle */}
        <div
          onMouseDown={onResizeStart}
          className="absolute top-0 -left-px w-px h-full bg-border-default hover:bg-accent transition-colors cursor-col-resize z-10"
          title="Drag to resize"
        />

        {/* Header */}
        <div className="flex items-center justify-between px-3 h-[32px] border-b border-[var(--border-default)] shrink-0">
          <div className="flex items-center gap-1.5">
            <ClipboardList size={11} className="text-[var(--text-tertiary)]" />
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">
              Plans
            </span>
            <span className="text-[10px] text-[var(--text-tertiary)]">
              · {plans.length}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
            title="Hide plans"
          >
            <ChevronRight size={12} />
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto hide-scrollbar">
          {plans.length === 0 ? (
            <div className="px-3 py-3 text-[11px] text-[var(--text-tertiary)] leading-relaxed">
              No plans yet. When Claude Code proposes a plan, it’s saved here
              with the message that triggered it.
            </div>
          ) : (
            plans.map((p, idx) => {
              const isOpen = expanded.has(p.id);
              const isLast = idx === plans.length - 1;
              return (
                <div
                  key={p.id}
                  className={cn(
                    "px-3 py-2.5",
                    !isLast && "border-b border-[var(--border-subtle)]",
                  )}
                >
                  {/* Header row: user message + expand toggle */}
                  <button
                    onClick={() => toggle(p.id)}
                    className="group w-full text-left flex items-start gap-1.5 cursor-pointer"
                    title={isOpen ? "Collapse plan" : "Expand plan"}
                  >
                    {isOpen ? (
                      <ChevronDown
                        size={12}
                        className="mt-0.5 shrink-0 text-[var(--text-tertiary)]"
                      />
                    ) : (
                      <ChevronRight
                        size={12}
                        className="mt-0.5 shrink-0 text-[var(--text-tertiary)]"
                      />
                    )}
                    <span
                      className={cn(
                        "text-[12px] leading-snug text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors",
                        !isOpen && "line-clamp-2",
                      )}
                    >
                      {p.userMessage || "(no message)"}
                    </span>
                  </button>

                  {/* Meta: human timestamp + relative age + session */}
                  <div className="flex items-center gap-2 pl-[18px] mt-1 text-[10px] text-[var(--text-tertiary)]">
                    <span title={p.timestamp}>
                      {formatPlanTimestamp(p.timestamp)}
                    </span>
                    <span>·</span>
                    <span>{planTimeAgo(p.timestamp)}</span>
                    {p.sessionTitle && (
                      <>
                        <span>·</span>
                        <span className="truncate">{p.sessionTitle}</span>
                      </>
                    )}
                  </div>

                  {/* Expanded plan markdown */}
                  {isOpen && (
                    <div className="pl-[18px] mt-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 max-h-[420px] overflow-auto">
                      <Markdown className="text-[12px]">{p.plan}</Markdown>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}

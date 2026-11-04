// Shared pieces of the transcript's row views: the content column, the
// gutter figures (elapsed time, call counts) and the subagent orb. Props only.

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { SubagentStatus } from "@/types/agent";
import { CONTENT_COLUMN } from "../../lib/row-metrics";

/** Shared by every row: the centred content column. */
export function Column({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn(CONTENT_COLUMN, className)}>{children}</div>;
}

/**
 * A settled child's duration, or nothing when there is none to state.
 *
 * Under a second is what a child reads when nothing measured it — a reopened
 * session's async child, whose launch returned at once and whose own report
 * never reaches this session — and "0s" would be a claim, not a figure. The
 * live counter blanks below a second for the same reason.
 */
export function settledFigure(ms: number) {
  return ms >= 1000 ? <span>{formatWorked(ms)}</span> : null;
}

/** "1 call", "12 calls" — a child's work as the gutter counts it. */
export function formatCalls(n: number): string {
  return `${n} ${n === 1 ? "call" : "calls"}`;
}

/** What the gutter says after the name. Terminal states are words, not icons:
 *  "stopped" and "failed" are different facts and no glyph tells them apart at
 *  this size. */
export const SUBAGENT_STATE: Record<SubagentStatus, string> = {
  running: "running",
  completed: "done",
  failed: "failed",
  interrupted: "stopped",
};

/**
 * The thinking orb that stands in for a tool glyph on a subagent's row.
 *
 * A filled disc rather than a line icon, so it reads as a presence among the
 * outlined tool glyphs instead of as another tool. Live, it breathes on the
 * shared marker shimmer — OPACITY ONLY, like every other animation in the
 * transcript: no transform and no layout, so a row's predicted height holds
 * and the scroll loop has nothing to re-measure.
 */
export function AgentOrb({ running, failed }: { running: boolean; failed: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 rounded-full",
        failed ? "bg-error" : running ? "bg-[var(--primary)] atlas-marker-running" : "bg-disabled",
      )}
    />
  );
}

// ── Work header ────────────────────────────────────────────────────────────

/** "17s", "1m 29s", "7m 37s", "1h 3m" — compact elapsed-time format. */
export function formatWorked(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The live "Working for 46s" figure, written straight to the DOM once a second
 * — the same bargain as `useElapsed` in `loading-state.tsx`: the one element
 * that changes every second never goes through React, and a hidden window
 * stops painting it (the next visible paint is exact, being derived from
 * `startedAt`).
 */
export function LiveElapsed({ startedAt, minMs = 0 }: { startedAt: number; minMs?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const write = () => {
      const ms = Date.now() - startedAt;
      // Below `minMs` the figure stays blank rather than reading "0s". A tool
      // marker uses this: most reads finish inside a frame or two, and a "0s"
      // blinking in and out beside every one of them is noise that says
      // nothing. The turn header leaves it at 0 — there, "Working for" needs
      // a figure after it from the first paint.
      if (ref.current) ref.current.textContent = ms < minMs ? "" : formatWorked(ms);
    };
    const paint = () => {
      if (document.visibilityState === "visible") write();
    };
    // The first write is unconditional: a row that mounts in a hidden window
    // must not sit on an empty "Working for" until it is shown.
    write();
    const id = window.setInterval(paint, 1000);
    document.addEventListener("visibilitychange", paint);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", paint);
    };
  }, [startedAt, minMs]);
  return <span ref={ref} className="tabular-nums" />;
}

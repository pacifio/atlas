import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useVisibleAnimation } from "@/lib/visible-animation";

/**
 * LOADING STATE — the pixel-grid loader shown while a turn is doing work the
 * transcript can't render yet (the ACP round-trip, the first tokens, the beat
 * before a tool call).
 *
 * Three parts, in order: a 3×3 grid of dots lit by a travelling wavefront, a
 * shimmering label, and a live elapsed timer in mono tabular figures.
 *
 * Default variant is `dots` — the round cells. `drive` is the same wavefront
 * with square cells, `orbit` a comet lapping the perimeter.
 *
 * Perf notes — this sits INSIDE the transcript, above a long thread of real
 * DOM rows:
 *  - the grid animates `opacity` only (paint, no layout, no transform), on
 *    nine 2.5px cells, so it can't touch the scroll path;
 *  - the timer writes `textContent` through a ref on a 100ms interval. A
 *    `useState` tick would re-render this component 10×/s while the transcript
 *    is also draining stream deltas; the DOM write costs nothing and React
 *    never hears about it;
 *  - the row is a fixed height, so its mount/unmount doesn't jolt the thread.
 *
 * Reduced motion freezes the grid to its dim state; the timer still ticks.
 */

/** Cell delays (ms) for a chevron wavefront driving left→right. The 650ms cycle
 *  is shorter than the sweep, so two fronts are always in flight. */
const CHEVRON = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3);
  const c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

/** Perimeter order for the orbit variant; the centre cell stays dark (`null`). */
const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const ORBIT = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i);
  return k === -1 ? null : k * 110;
});

const PATTERNS = {
  drive: { delays: CHEVRON, dur: 650, round: false },
  dots: { delays: CHEVRON, dur: 650, round: true },
  orbit: { delays: ORBIT, dur: 950, round: false },
} satisfies Record<string, { delays: (number | null)[]; dur: number; round: boolean }>;

export type LoaderVariant = keyof typeof PATTERNS;

function format(ms: number): string {
  const total = ms / 1000;
  if (total < 60) return `${total.toFixed(1)}s`;
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}

/** How long the indicator waits before calling the wait a stall. */
export const STALL_AFTER_MS = 30_000;

/** How long a wait has to run before the elapsed clock is worth showing.
 *
 *  Below this the number is noise: it appears, reads "0.2s", and is gone
 *  before anyone has finished looking at it. Past it the wait is long enough
 *  that "how long has this been going?" is a real question, which is the
 *  moment the clock starts earning its place. */
export const SHOW_ELAPSED_AFTER_MS = 3_000;

/** What the indicator says while the request is still in flight.
 *
 *  Not "Thinking": this indicator is only ever on screen BEFORE the model has
 *  produced anything (see `working` in `transcript.tsx` — a streaming
 *  assistant turn only exists once it emits a row, and the indicator is gone
 *  by then). Saying "Thinking" through a five-second wait claims the model is
 *  working when the request may not even have reached it. */
export const WAITING_LABEL = "Waiting for model";

/** Elapsed since mount, written straight to the DOM — see the perf note above.
 *
 *  `stalled` is the one piece of React state here: it flips true ONCE, when
 *  the wait has outlasted `stallAfterMs`, so the caller can swap in a "still
 *  going…" affordance. One re-render in thirty seconds; the ticking label
 *  itself never goes through React. */
function useElapsed(stallAfterMs: number, showAfterMs: number) {
  const ref = useRef<HTMLSpanElement>(null);
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const start = performance.now();
    const paint = () => {
      // A backgrounded window with a running agent was repainting this label
      // 10×/s forever; elapsed time is derived from `start` at paint time, so
      // skipping ticks while hidden loses nothing — the next visible paint is
      // exact.
      if (document.visibilityState !== "visible") return;
      if (!ref.current) return;
      const elapsed = performance.now() - start;
      // Blank until the wait is worth counting, so a turn that starts promptly
      // never flashes a number at the reader.
      ref.current.textContent = elapsed < showAfterMs ? "" : format(elapsed);
    };
    paint();
    const id = window.setInterval(paint, 100);
    const stallId = window.setTimeout(() => setStalled(true), stallAfterMs);
    document.addEventListener("visibilitychange", paint);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(stallId);
      document.removeEventListener("visibilitychange", paint);
    };
  }, [stallAfterMs, showAfterMs]);
  return { ref, stalled };
}

export const LoadingState = memo(function LoadingState({
  label = WAITING_LABEL,
  variant = "dots",
  className,
  stalledContent,
  stallAfterMs = STALL_AFTER_MS,
  showElapsedAfterMs = SHOW_ELAPSED_AFTER_MS,
}: {
  label?: string;
  variant?: LoaderVariant;
  className?: string;
  /** Rendered under the indicator once the wait has outlasted `stallAfterMs`
   *  — the way out of a start that is not going to finish on its own. Nothing
   *  is rendered (and no state flips) when this is not given. */
  stalledContent?: ReactNode;
  stallAfterMs?: number;
  /** How long before the elapsed clock appears. See `SHOW_ELAPSED_AFTER_MS`. */
  showElapsedAfterMs?: number;
}) {
  const { ref: elapsed, stalled } = useElapsed(stallAfterMs, showElapsedAfterMs);
  const shimmer = useVisibleAnimation<HTMLElement>();
  const { delays, dur, round } = PATTERNS[variant] ?? PATTERNS.dots;

  const indicator = (
    <div
      ref={shimmer}
      role="status"
      aria-live="polite"
      aria-label={label}
      className={cn("flex w-fit items-center gap-1.5", className)}
    >
      <span aria-hidden className="grid grid-cols-[repeat(3,2.5px)] gap-[1px]">
        {delays.map((d, i) => (
          <span
            key={i}
            className={cn(
              "size-[2.5px] bg-[var(--foreground)]",
              round ? "rounded-full" : "rounded-none",
              d !== null && "atlas-pixel-cell",
            )}
            style={
              d === null
                ? { opacity: 0.07 }
                : {
                    opacity: 0.15,
                    animationDuration: `${dur}ms`,
                    animationDelay: `${d}ms`,
                  }
            }
          />
        ))}
      </span>
      <span className="atlas-thinking-shimmer text-xs leading-[16px] font-medium">{label}</span>
      <span
        ref={elapsed}
        className="font-mono text-2xs tabular-nums text-[var(--muted-foreground)]"
      />
    </div>
  );
  if (!stalledContent || !stalled) return indicator;
  return (
    <div className="flex flex-col gap-1">
      {indicator}
      {stalledContent}
    </div>
  );
});

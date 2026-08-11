import { memo, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

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

/** Elapsed since mount, written straight to the DOM — see the perf note above. */
function useElapsed() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const start = performance.now();
    const paint = () => {
      if (ref.current) ref.current.textContent = format(performance.now() - start);
    };
    paint();
    const id = window.setInterval(paint, 100);
    return () => window.clearInterval(id);
  }, []);
  return ref;
}

export const LoadingState = memo(function LoadingState({
  label = "Thinking",
  variant = "dots",
  className,
}: {
  label?: string;
  variant?: LoaderVariant;
  className?: string;
}) {
  const elapsed = useElapsed();
  const { delays, dur, round } = PATTERNS[variant] ?? PATTERNS.dots;

  return (
    <div
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
              "size-[2.5px] bg-[var(--text-primary)]",
              round ? "rounded-full" : "rounded-[0.5px]",
              d !== null && "atlas-pixel-cell",
            )}
            style={
              d === null
                ? { opacity: 0.07 }
                : { opacity: 0.15, animationDuration: `${dur}ms`, animationDelay: `${d}ms` }
            }
          />
        ))}
      </span>
      <span className="atlas-thinking-shimmer text-[11px] leading-[16px] font-medium">{label}</span>
      <span
        ref={elapsed}
        className="font-mono text-[10px] tabular-nums text-[var(--text-tertiary)]"
      />
    </div>
  );
});

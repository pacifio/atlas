/**
 * How much of the model's context window a Session used, as segmented ticks.
 *
 * A bar rather than a number alone, because the question is never "how many
 * tokens" but "how close to the edge did this run get" — and a bar answers
 * that without reading. Green while there is room, amber past 75% of the
 * window, red past 90%.
 *
 * The tone goes by POSITION, not by the fill level: a bar that reaches 92%
 * still shows green ticks where it was comfortable and red only at the end,
 * so you can see *where* it crossed. Colouring the whole bar red would say
 * the whole run was in trouble.
 *
 * The ticks are counted from the measured width — one per ~7px — so they keep
 * their slim pill shape in a narrow dock cell and in a wide one, instead of
 * fattening into sausages when the panel grows.
 */

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { formatTokens } from "../lib/board";

/** Bar width per tick. Until the bar is measured, assume this many ticks. */
const TICK_PITCH = 7;
const TICKS_UNMEASURED = 24;
const MIN_TICKS = 12;
const MAX_TICKS = 60;

/** Where the bar changes tone, as a share of the window. */
const WARN_AT = 0.75;
const HOT_AT = 0.9;

export function ContextMeter({ used, size }: { used: number; size: number }) {
  const bar = useRef<HTMLDivElement>(null);
  const [segments, setSegments] = useState(TICKS_UNMEASURED);

  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const width = el.clientWidth;
      if (!width) return;
      setSegments(Math.min(MAX_TICKS, Math.max(MIN_TICKS, Math.round((width + 2) / TICK_PITCH))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const share = size > 0 ? Math.min(used / size, 1) : 0;
  const pct = Math.round(share * 100);
  // At least one lit tick for any use at all: a Session that spent something
  // must not read as an empty bar.
  const lit = share > 0 ? Math.max(1, Math.round(share * segments)) : 0;
  const warnAt = Math.round(segments * WARN_AT);
  const hotAt = Math.round(segments * HOT_AT);
  const toneOf = (i: number) =>
    i >= hotAt ? "bg-error" : i >= warnAt ? "bg-warning" : "bg-success";

  const ticks = Array.from({ length: segments }, (_, i) => (
    <span
      key={i}
      className={cn("min-w-0 flex-1 rounded-full", toneOf(i), i >= lit && "opacity-20")}
    />
  ));

  return (
    <>
      {/* The fraction rides beside the percentage so this cell keeps the same
          two lines as its neighbours — a value, then one row beneath it. */}
      <p className="mt-1 flex items-baseline gap-1.5">
        <span className="font-mono text-md font-medium tracking-tight tabular-nums">{pct}%</span>
        <span className="truncate font-mono text-3xs text-disabled">
          {formatTokens(used)}/{formatTokens(size)}
        </span>
      </p>
      <div
        ref={bar}
        role="meter"
        aria-label="Context used"
        aria-valuemin={0}
        aria-valuemax={size}
        aria-valuenow={used}
        className="mt-1 flex h-3 items-stretch gap-0.5"
      >
        {ticks.slice(0, lit)}
        {/* The fill line, so the exact edge is readable even where two
            neighbouring ticks share a tone. */}
        <span aria-hidden className="-my-0.5 w-0.5 shrink-0 rounded-full bg-foreground" />
        {ticks.slice(lit)}
      </div>
    </>
  );
}

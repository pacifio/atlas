/**
 * The Timeline's stats rail: four totals and a week of activity.
 *
 * Collapsible, and everything is derived from the rows currently on screen
 * rather than from the store — narrowing the board narrows the numbers. A total
 * that ignores the filter above it is a number nobody can act on.
 */

import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";

import { formatDuration, formatTokens, lastSevenDays, sessionState } from "../lib/board";
import type { BoardSession } from "../types";

/**
 * The rail's height.
 *
 * Exported because the collapse animation needs the exact number: a wrapper
 * cannot transition to `auto`, so the panel animates to this and the rail
 * renders at it. Two copies of `118` would drift the first time either moved.
 */
export const STATS_HEIGHT = 118;

/** The chart's viewBox. Fixed so the path maths reads as plain numbers. */
const VIEW_W = 700;
const VIEW_H = 100;
/**
 * How much of the card's height the curve may use.
 *
 * The plot bleeds to all four edges and the readout floats on top of it, so the
 * curve is confined to the lower ~46%. Anything taller runs through the 28px
 * total and neither survives.
 */
const PLOT_H = 46;

export function SessionStats({ sessions }: { sessions: BoardSession[] }) {
  /** Which day the pointer is over, or `null` for the week. */
  const [hover, setHover] = useState<number | null>(null);

  // Everything derived from the rows, memoised as one block. Hover is the only
  // other state, and without this every pointer move re-summed every row and
  // rebuilt the whole path — to move a dot.
  const chart = useMemo(() => {
    const week = lastSevenDays(sessions);
    const peak = Math.max(1, ...week.map((d) => d.minutes));
    const column = VIEW_W / week.length;
    // Sample x positions are column centres, so a day's value sits under the
    // middle of its own slice rather than on the boundary between two.
    const points = week.map((d, i) => ({
      x: column * (i + 0.5),
      y: VIEW_H - (d.minutes / peak) * PLOT_H,
    }));

    // Smooth rather than a polyline: seven samples read as a trend, straight
    // segments between them read as seven unrelated readings. Control points at
    // the horizontal midpoint give a symmetric S between each pair.
    let line = `M0,${points[0].y.toFixed(1)}`;
    points.forEach((p, i) => {
      const prev = i ? points[i - 1] : null;
      if (!prev) {
        line += ` L${p.x.toFixed(1)},${p.y.toFixed(1)}`;
        return;
      }
      const mid = (prev.x + p.x) / 2;
      line +=
        ` C${mid.toFixed(1)},${prev.y.toFixed(1)}` +
        ` ${mid.toFixed(1)},${p.y.toFixed(1)}` +
        ` ${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    });
    // Flat run-out to the right edge, so the curve reaches the card's border
    // rather than stopping short of it.
    line += ` L${VIEW_W},${points[points.length - 1].y.toFixed(1)}`;

    return {
      week,
      points,
      line,
      seconds: sessions.reduce((a, s) => a + s.durationSeconds, 0),
      tokens: sessions.reduce((a, s) => a + s.totalTokens, 0),
      checkpoints: sessions.reduce((a, s) => a + s.checkpointCount, 0),
      linked: sessions.filter((s) => s.checkpointCount > 0).length,
      live: sessions.filter((s) => sessionState(s) === "live").length,
      weekMinutes: week.reduce((a, d) => a + d.minutes, 0),
    };
  }, [sessions]);

  const { week, points, line, seconds, tokens, checkpoints, linked, live, weekMinutes } = chart;
  const cursor = points[hover ?? 0];

  return (
    <section
      style={{ height: STATS_HEIGHT }}
      className="flex shrink-0 items-stretch border-b border-[var(--border-default)]"
    >
      <Stat
        label="Tracked"
        value={formatDuration(seconds)}
        sub={`across ${sessions.length} session${sessions.length === 1 ? "" : "s"}`}
      />
      <Stat label="Tokens" value={tokens > 0 ? formatTokens(tokens) : "—"} sub="in + out" divided />
      <Stat
        label="Checkpoints"
        value={String(checkpoints)}
        sub={
          checkpoints > 0
            ? `from ${linked} session${linked === 1 ? "" : "s"}`
            : "no commits linked yet"
        }
        divided
      />
      {/* Live sits last of the stats, beside the chart: both are about *now*. */}
      <Stat
        label="Live"
        value={String(live)}
        sub={live > 0 ? "streaming now" : "nothing recording"}
        tone={live > 0 ? "var(--capture-live)" : undefined}
        pulse={live > 0}
        divided
      />

      {/* The chart bleeds to all four edges — no padding, and the readout floats
          on top of it rather than sitting above it in flow. */}
      <div
        onMouseLeave={() => setHover(null)}
        className="relative min-w-0 flex-[2] overflow-hidden border-l border-[var(--border-default)] bg-[#050505]"
      >
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          className="absolute inset-0 block h-full w-full"
          aria-hidden
        >
          <path d={`${line} L${VIEW_W},${VIEW_H} L0,${VIEW_H} Z`} fill="#141414" />
          <path
            d={line}
            fill="none"
            stroke="#8a8a8a"
            strokeWidth={1.25}
            strokeLinejoin="round"
            // Essential: the non-uniform viewBox scale would otherwise stretch
            // the stroke horizontally into a wedge.
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {/* Dims the left so the readout stays legible; the right keeps the curve
            at full brightness. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "linear-gradient(90deg, rgba(0,0,0,.72) 0%, rgba(0,0,0,.5) 28%, rgba(0,0,0,.16) 56%, rgba(0,0,0,0) 80%)",
          }}
        />

        {hover !== null && (
          <>
            <span
              aria-hidden
              className="pointer-events-none absolute bottom-0 top-0 w-px bg-[#3d3d3d]"
              style={{ left: `${(cursor.x / VIEW_W) * 100}%` }}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute size-[5px] rounded-full bg-white"
              style={{
                left: `${(cursor.x / VIEW_W) * 100}%`,
                top: `${cursor.y}%`,
                margin: "-3px 0 0 -3px",
              }}
            />
          </>
        )}

        {/* The readout IS the tooltip — there is no second floating one. */}
        <div className="pointer-events-none absolute inset-0 px-5 pt-3.5">
          <p className="text-[28px] font-semibold leading-none tracking-[-0.03em] text-white">
            {formatDuration((hover === null ? weekMinutes : week[hover].minutes) * 60)}
          </p>
          <p className="mt-[5px] font-mono text-[10px] uppercase tracking-[0.06em] text-[#8a8a8a]">
            {hover === null
              ? `${week[0].label} – ${week[week.length - 1].label}`
              : week[hover].full}
          </p>
        </div>

        {/* Seven equal hit cells. The chart is one path, so the hover regions
            have to be their own layer. */}
        <div className="absolute inset-0 flex">
          {week.map((d, i) => (
            <button
              key={d.key}
              type="button"
              tabIndex={-1}
              aria-label={`${d.full}: ${formatDuration(d.minutes * 60)}`}
              onMouseEnter={() => setHover(i)}
              className="min-w-0 flex-1 cursor-default"
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
  pulse,
  divided,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: string;
  /** Draw the breathing dot beside the label. */
  pulse?: boolean;
  divided?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col justify-center px-5 py-4",
        divided && "border-l border-[var(--border-default)]",
      )}
    >
      <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
        {pulse && (
          <span
            aria-hidden
            className="atlas-live-pulse size-1.5 rounded-full"
            style={{
              backgroundColor: "var(--capture-live)",
              ["--atlas-pulse-color" as string]:
                "color-mix(in oklab, var(--capture-live) 45%, transparent)",
            }}
          />
        )}
        {label}
      </span>
      <span
        className="mt-[7px] whitespace-nowrap text-[28px] font-semibold leading-[1.1] tracking-[-0.03em]"
        style={{ color: tone ?? "var(--text-primary)" }}
      >
        {value}
      </span>
      <span className="mt-1 truncate font-mono text-[10px] text-[var(--text-tertiary)]">{sub}</span>
    </div>
  );
}

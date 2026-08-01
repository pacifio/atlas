import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtHM, fmtDur } from "../lib/format";
import type { Block, DayAggregate } from "../lib/pomodoro-types";

const HOUR_PX = 110;
const DEFAULT_START_HOUR = 8;
const DEFAULT_END_HOUR = 21;

interface Props {
  day: DayAggregate;
  blocks: Block[];
  nowMin: number; // -1 to hide
  onNewSession: () => void;
}

export function DayTimeline({ day, blocks, nowMin, onNewSession }: Props) {
  const dateStr = new Date(day.date + "T00:00:00").toLocaleDateString(
    undefined,
    {
      weekday: "long",
      month: "long",
      day: "numeric",
    },
  );

  // Auto-fit the hour gutter to the work-hours range, expanding to cover
  // any block or the current time outside it.
  let startHour = DEFAULT_START_HOUR;
  let endHour = DEFAULT_END_HOUR;
  for (const b of blocks) {
    startHour = Math.min(startHour, Math.floor(b.startMin / 60));
    endHour = Math.max(endHour, Math.ceil(b.endMin / 60));
  }
  if (nowMin >= 0) {
    startHour = Math.min(startHour, Math.floor(nowMin / 60));
    endHour = Math.max(endHour, Math.ceil((nowMin + 1) / 60));
  }
  startHour = Math.max(0, startHour);
  endHour = Math.min(24, endHour);
  const hours = Array.from(
    { length: endHour - startHour + 1 },
    (_, i) => startHour + i,
  );
  const totalHeight = (endHour - startHour) * HOUR_PX;

  const minToY = (m: number) => ((m - startHour * 60) / 60) * HOUR_PX;

  return (
    <div className="bg-bg-primary min-h-full">
      {/* Header height matches DayRail's so bottom borders align. */}
      <div className="sticky top-0 z-[3] bg-bg-primary border-b border-border-subtle h-[104px] px-6 pt-6 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">
            {day.today ? "Today's timeline" : "Timeline"}
          </div>
          <h2 className="text-[20px] font-semibold tracking-tight text-text-primary leading-none mt-1">
            {dateStr}
          </h2>
          <div className="flex items-center gap-2 text-[11px] text-text-tertiary whitespace-nowrap mt-2">
            <span>{fmtDur(day.focusMin)} focus</span>
            <span className="text-text-tertiary/50">·</span>
            <span>
              {day.sessions} session{day.sessions === 1 ? "" : "s"}
            </span>
            {day.distractions > 0 && (
              <>
                <span className="text-text-tertiary/50">·</span>
                <span>{day.distractions} distracted</span>
              </>
            )}
          </div>
        </div>
        <button
          onClick={onNewSession}
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-[12px] font-medium bg-text-primary text-bg-primary hover:opacity-90 transition-opacity cursor-pointer shrink-0 self-center"
        >
          <Plus size={12} strokeWidth={2.5} />
          New session
        </button>
      </div>

      <div
        className="relative px-6 py-4"
        style={{ minHeight: totalHeight + 32 }}
      >
        <div
          className="relative"
          style={{ height: totalHeight, marginLeft: 56 }}
        >
          {hours.slice(0, -1).map((h, i) => (
            <div
              key={h}
              className="absolute left-0 right-0 border-t border-border-default"
              style={{ top: i * HOUR_PX, height: HOUR_PX }}
            >
              <div className="absolute -left-12 -top-2 w-10 text-right font-mono text-[10px] text-text-tertiary tabular-nums">
                {String(h).padStart(2, "0")}:00
              </div>
              {[1, 2, 3].map((q) => (
                <div
                  key={q}
                  className="absolute left-0 right-0 border-t border-border-subtle"
                  style={{ top: (q * HOUR_PX) / 4 }}
                />
              ))}
            </div>
          ))}
          {/* Final hour marker label */}
          <div
            className="absolute -left-12 w-10 text-right font-mono text-[10px] text-text-tertiary tabular-nums"
            style={{ top: (hours.length - 1) * HOUR_PX - 6 }}
          >
            {String(hours[hours.length - 1]).padStart(2, "0")}:00
          </div>

          {blocks.map((b) => {
            const top = minToY(b.startMin);
            const height = Math.max(28, minToY(b.endMin) - minToY(b.startMin));
            return (
              <TimelineBlock key={b.id} block={b} top={top} height={height} />
            );
          })}

          {nowMin >= 0 && (
            <div
              className="absolute left-0 right-0 pointer-events-none z-[2]"
              style={{ top: minToY(nowMin) }}
            >
              <div className="h-px bg-[var(--status-error)] relative">
                <div className="absolute -left-1 -top-1 w-2 h-2 rounded-full bg-[var(--status-error)]" />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TimelineBlock({
  block,
  top,
  height,
}: {
  block: Block;
  top: number;
  height: number;
}) {
  const isFocus = block.type === "focus";
  const totalMin = Math.max(1, block.endMin - block.startMin);
  const pct = block.elapsedMin
    ? Math.min(100, (block.elapsedMin / totalMin) * 100)
    : 0;

  return (
    <div
      className={cn(
        "absolute left-2 right-2 rounded-md overflow-hidden border transition-shadow",
        isFocus
          ? "bg-bg-elevated border-border-default"
          : "bg-bg-secondary border-border-subtle",
        block.current && "ring-1 ring-text-primary/40 shadow-lg",
      )}
      style={{ top, height }}
    >
      {block.current && (
        <div
          className="absolute inset-y-0 left-0 bg-text-primary/10 pointer-events-none"
          style={{ width: `${pct}%` }}
        />
      )}
      <div className="relative h-full p-2.5 flex flex-col justify-between min-h-0">
        <div>
          <div className="flex items-baseline justify-between gap-2 min-w-0">
            <div className="flex items-baseline gap-1.5 min-w-0 flex-1 flex-wrap">
              <span
                className={cn(
                  "text-[11px] leading-none",
                  isFocus ? "text-text-primary/80" : "text-text-tertiary",
                )}
              >
                {isFocus ? `Cycle ${block.cycle ?? 1}` : "Break"}
              </span>
              {block.current && (
                <span className="inline-flex items-center gap-1 px-1.5 py-px rounded-full bg-[var(--status-success)]/15 text-[var(--status-success)] text-[10px] leading-none translate-y-px">
                  <span className="w-1 h-1 rounded-full bg-[var(--status-success)] animate-pulse" />
                  Live
                </span>
              )}
            </div>
            <span className="text-[11px] font-mono text-text-tertiary tabular-nums leading-none shrink-0">
              {fmtHM(block.startMin)}
              <span className="text-text-tertiary/50"> · {totalMin}m</span>
            </span>
          </div>

          {block.title && (
            <div
              className={cn(
                "text-[12.5px] font-medium leading-tight truncate mt-1",
                isFocus ? "text-text-primary" : "text-text-secondary",
              )}
            >
              {block.title}
            </div>
          )}
          {isFocus && block.tags && block.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {block.tags.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center px-1.5 py-px rounded text-[10px] text-text-tertiary bg-bg-secondary border border-border-subtle"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
        {isFocus && (block.distractions ?? 0) > 0 && (
          <div className="text-[10px] text-text-tertiary">
            {block.distractions} distraction
            {block.distractions === 1 ? "" : "s"}
          </div>
        )}
      </div>
    </div>
  );
}

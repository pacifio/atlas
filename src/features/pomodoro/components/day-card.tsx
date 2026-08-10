import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtDur } from "../lib/format";
import type { DayAggregate } from "../lib/pomodoro-types";
import { HourHistogram } from "./hour-histogram";

interface Props {
  day: DayAggregate;
  active: boolean;
  onClick: () => void;
}

export function DayCard({ day, active, onClick }: Props) {
  const d = new Date(day.date + "T00:00:00");
  const dayN = d.getDate();
  const mon = d.toLocaleString(undefined, { month: "short" });
  const weekday = d.toLocaleString(undefined, { weekday: "short" });

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-stretch gap-3 px-4 py-3 text-left border-b border-border-subtle outline-none transition-colors cursor-pointer",
        active ? "bg-bg-elevated" : "hover:bg-bg-hover",
      )}
    >
      <div className="w-12 shrink-0 flex flex-col items-start justify-center leading-none">
        <span className="text-[11px] text-text-tertiary">{mon}</span>
        <span className="text-[22px] font-semibold text-text-primary mt-0.5 leading-none tabular-nums">
          {String(dayN).padStart(2, "0")}
        </span>
        <span className="text-[11px] text-text-tertiary mt-1">{day.today ? "Today" : weekday}</span>
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        <HourHistogram hours={day.hours} active={active} />
        <div className="flex items-center gap-2 text-[11px] text-text-tertiary">
          <span>{fmtDur(day.focusMin)}</span>
          <span className="text-text-tertiary/50">·</span>
          <span>
            {day.sessions} session{day.sessions === 1 ? "" : "s"}
          </span>
        </div>
        {day.sessions === 0 && (
          <p className="text-[11px] text-text-secondary leading-snug line-clamp-2">
            {day.today ? "No sessions yet today." : "No sessions on this day."}
          </p>
        )}
      </div>
      <ChevronRight
        size={12}
        className={cn(
          "self-center shrink-0",
          active ? "text-text-primary" : "text-text-tertiary/60",
        )}
      />
    </button>
  );
}

import { useState } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePomodoroStore } from "../stores/pomodoro-store";
import { DayCard } from "./day-card";

export function DayRail() {
  const days = usePomodoroStore.use.days();
  const knownTags = usePomodoroStore.use.knownTags();
  const activeDayIdx = usePomodoroStore.use.activeDayIdx();
  const { setActiveDay } = usePomodoroStore.use.actions();
  const [q, setQ] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);

  const filtered = days.filter((d) => {
    if (q && !(d.summary ?? "").toLowerCase().includes(q.toLowerCase()))
      return false;
    return true;
  });

  return (
    <aside className="border-r border-border-subtle bg-bg-secondary overflow-auto min-h-0 min-w-0 flex flex-col">
      <div className="sticky top-0 z-[2] bg-bg-secondary border-b border-border-subtle h-[104px] px-5 pt-6">
        <div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">
          History
        </div>
        <h2 className="text-[20px] font-semibold tracking-tight text-text-primary leading-none mt-1">
          Sessions
        </h2>
        <div className="mt-3 h-7 flex items-center gap-1.5 px-2 bg-bg-input border border-border-default rounded">
          <Search size={12} className="text-text-tertiary shrink-0" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter days, tasks…"
            className="flex-1 min-w-0 bg-transparent border-none outline-none text-[12px] text-text-primary placeholder:text-text-tertiary"
          />
        </div>
      </div>

      {knownTags.length > 0 && (
        <div className="px-4 py-2.5 border-b border-border-subtle flex flex-wrap gap-1">
          <button
            onClick={() => setActiveTag(null)}
            className={cn(
              "inline-flex items-center h-6 px-2 rounded-full border text-[11px] cursor-pointer transition-colors",
              activeTag === null
                ? "bg-text-primary text-bg-primary border-text-primary"
                : "border-border-subtle text-text-secondary hover:bg-bg-hover",
            )}
          >
            All
          </button>
          {knownTags.map((t) => {
            const active = t === activeTag;
            return (
              <button
                key={t}
                onClick={() => setActiveTag(active ? null : t)}
                className={cn(
                  "inline-flex items-center h-6 px-2 rounded-full border text-[11px] cursor-pointer transition-colors",
                  active
                    ? "bg-text-primary text-bg-primary border-text-primary"
                    : "border-border-subtle text-text-secondary hover:bg-bg-hover",
                )}
              >
                {t}
              </button>
            );
          })}
        </div>
      )}

      <div>
        {filtered.map((d) => (
          <DayCard
            key={d.date}
            day={d}
            active={days.indexOf(d) === activeDayIdx}
            onClick={() => setActiveDay(days.indexOf(d))}
          />
        ))}
        {filtered.length === 0 && (
          <div className="px-4 py-6 text-center text-[12px] text-text-tertiary">
            No days match "{q}"
          </div>
        )}
      </div>
    </aside>
  );
}

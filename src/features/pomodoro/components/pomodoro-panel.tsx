import { useEffect } from "react";
import { useProjectStore } from "@/features/project/stores/project-store";
import { usePomodoroStore, attachPersistence } from "../stores/pomodoro-store";
import { nowMinOfDay } from "../lib/format";
import { DayRail } from "./day-rail";
import { DayTimeline } from "./day-timeline";
import { ActiveTimer } from "./active-timer";
import { NewSessionSheet } from "./new-session-sheet";

export function PomodoroPanel() {
  const currentProject = useProjectStore.use.currentProject();
  const days = usePomodoroStore.use.days();
  const activeDayIdx = usePomodoroStore.use.activeDayIdx();
  const blocks = usePomodoroStore.use.blocks();
  const isRunning = usePomodoroStore.use.isRunning();
  const { tick, hydrate, openSheet, rolloverDay } = usePomodoroStore.use.actions();

  useEffect(() => {
    if (!currentProject?.path) return;
    hydrate(currentProject.path);
    return attachPersistence(currentProject.path);
  }, [currentProject?.path, hydrate]);

  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => tick(), 1000);
    return () => clearInterval(id);
  }, [isRunning, tick]);

  // Day rollover: if Atlas was left open across midnight (or the laptop
  // woke on a new day), the in-memory `days[0]` is stale. Re-check on
  // mount, every minute, and any time the window comes back into focus.
  useEffect(() => {
    rolloverDay();
    const id = setInterval(() => rolloverDay(), 60_000);
    const onFocusOrVisible = () => rolloverDay();
    window.addEventListener("focus", onFocusOrVisible);
    document.addEventListener("visibilitychange", onFocusOrVisible);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocusOrVisible);
      document.removeEventListener("visibilitychange", onFocusOrVisible);
    };
  }, [rolloverDay]);

  const day = days[activeDayIdx] ?? days[0];

  return (
    <div
      className="h-full min-h-0 grid"
      style={{ gridTemplateColumns: "280px minmax(0, 1fr) 320px" }}
    >
      <DayRail />
      <div className="overflow-auto hide-scrollbar min-h-0 min-w-0">
        {day && (
          <DayTimeline
            day={day}
            blocks={day.today ? blocks : []}
            nowMin={day.today ? nowMinOfDay() : -1}
            onNewSession={openSheet}
          />
        )}
      </div>
      <ActiveTimer />
      <NewSessionSheet />
    </div>
  );
}

import { Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { usePomodoroStore, selectDisplayClock } from "../stores/pomodoro-store";

export function StatusBarTimer() {
  const { addTab, setActiveTab } = useLayoutStore.use.actions();
  const tabs = useLayoutStore.use.tabs();
  const isRunning = usePomodoroStore.use.isRunning();
  const phase = usePomodoroStore.use.phase();
  const currentTask = usePomodoroStore.use.currentTask();
  const clock = usePomodoroStore((s) => selectDisplayClock(s));

  const onClick = () => {
    const existing = tabs.find((t) => t.type === "pomodoro");
    if (existing) {
      setActiveTab(existing.id);
    } else {
      addTab({
        id: "pomodoro",
        type: "pomodoro",
        title: "Pomodoro",
        closable: true,
        dirty: false,
        data: {},
      });
    }
  };

  const title = isRunning
    ? `${phase === "focus" ? "Focus" : "Break"} · ${clock} left${currentTask ? ` · ${currentTask}` : ""}`
    : "Open Pomodoro";

  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 h-5 px-1.5 rounded font-mono text-[11px] cursor-pointer transition-colors",
        "text-[#888] hover:text-text-primary hover:bg-bg-hover",
      )}
    >
      {isRunning ? (
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full",
            phase === "focus" ? "bg-[var(--status-success)]" : "border border-text-tertiary",
          )}
        />
      ) : (
        <Timer size={11} className="text-text-tertiary" />
      )}
      <span className="tabular-nums">{clock}</span>
    </button>
  );
}

import { Play, Pause, RotateCcw, Download, Trash2, Zap } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import { usePomodoroStore } from "../stores/pomodoro-store";
import { PRESETS } from "../lib/presets";
import { fmtDur } from "../lib/format";
import { TimerRing } from "./timer-ring";

export function ActiveTimer() {
  const isRunning = usePomodoroStore.use.isRunning();
  const phase = usePomodoroStore.use.phase();
  const focusMin = usePomodoroStore.use.focusMin();
  const breakMin = usePomodoroStore.use.breakMin();
  const cyclesPlanned = usePomodoroStore.use.cyclesPlanned();
  const cycleIdx = usePomodoroStore.use.cycleIdx();
  const secElapsed = usePomodoroStore.use.secElapsed();
  const presetId = usePomodoroStore.use.presetId();
  const currentTask = usePomodoroStore.use.currentTask();
  const currentTags = usePomodoroStore.use.currentTags();
  const days = usePomodoroStore.use.days();
  const blocks = usePomodoroStore.use.blocks();
  const knownTags = usePomodoroStore.use.knownTags();
  const today = days[0];
  const { pause, resume, reset, setPresetId, openSheet, quickStart, clearAll } =
    usePomodoroStore.use.actions();

  const handleExport = async () => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const stamp = new Date().toISOString().slice(0, 10);
      const chosen = await save({
        defaultPath: `pomodoro-${stamp}.json`,
        title: "Export Pomodoro Data",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!chosen) return;
      const payload = JSON.stringify({ days, blocks, knownTags }, null, 2);
      await invoke("write_file_content", { path: chosen, content: payload });
    } catch (err) {
      console.error("[pomodoro] export failed", err);
    }
  };

  const handleClearAll = () => {
    if (
      window.confirm(
        "Clear all Pomodoro history? This wipes every recorded session for this project and cannot be undone.",
      )
    ) {
      clearAll();
    }
  };

  const phaseMin = phase === "rest" ? breakMin : focusMin;
  const totalSec = phaseMin * 60;
  const phaseLabel =
    phase === "idle"
      ? `${focusMin} min focus`
      : `${phase === "focus" ? "Focus" : "Break"} · ${phaseMin} min`;

  return (
    <aside className="border-l border-border-subtle bg-bg-secondary overflow-auto min-h-0 flex flex-col">
      <div className="sticky top-0 z-[2] bg-bg-secondary border-b border-border-subtle h-[104px] px-5 pt-6 shrink-0">
        <div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">
          Active session
        </div>
        {currentTask ? (
          <div className="text-[20px] font-semibold tracking-tight text-text-primary leading-tight mt-1 line-clamp-2">
            {currentTask}
          </div>
        ) : (
          <>
            <div className="text-[14px] text-text-tertiary italic mt-1">
              No session running
            </div>
            <div className="inline-flex items-stretch rounded-md overflow-hidden bg-bg-elevated border border-border-default text-text-primary mt-3 divide-x divide-border-default shadow-[0_2px_8px_rgba(0,0,0,0.35)]">
              <GroupedActionBtn
                icon={Zap}
                label="Quick start"
                onClick={quickStart}
              />
              <GroupedActionBtn
                icon={Download}
                label="Export"
                onClick={handleExport}
              />
              <GroupedActionBtn
                icon={Trash2}
                label="Clear all"
                onClick={handleClearAll}
              />
            </div>
          </>
        )}
        {currentTags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {currentTags.map((t) => (
              <span
                key={t}
                className="inline-flex items-center px-2 h-5 rounded-full bg-bg-elevated border border-border-subtle text-[11px] text-text-secondary"
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-center py-4">
        <TimerRing
          secElapsed={secElapsed}
          totalSec={totalSec}
          label={phaseLabel}
          recording={isRunning && phase === "focus"}
        />
      </div>

      <div className="flex items-center justify-center gap-2 px-5 pb-4">
        <button
          onClick={reset}
          className="inline-flex items-center justify-center w-9 h-9 rounded-full border border-border-default text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          title="Reset"
        >
          <RotateCcw size={13} />
        </button>
        {isRunning ? (
          <button
            onClick={pause}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-full bg-text-primary text-bg-primary text-[12px] font-medium hover:opacity-90 transition-opacity cursor-pointer"
          >
            <Pause size={12} fill="currentColor" />
            Pause
          </button>
        ) : (
          <button
            onClick={phase === "idle" ? openSheet : resume}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-full bg-text-primary text-bg-primary text-[12px] font-medium hover:opacity-90 transition-opacity cursor-pointer"
          >
            <Play size={12} fill="currentColor" />
            {phase === "idle" ? "Start" : "Resume"}
          </button>
        )}
      </div>

      <div className="px-5 pb-4">
        <div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider mb-2">
          Cycles
        </div>
        <div className="flex gap-1.5">
          {Array.from({ length: cyclesPlanned }, (_, i) => {
            const done = i < cycleIdx;
            const current = i === cycleIdx && phase !== "idle";
            return (
              <div
                key={i}
                className={cn(
                  "flex-1 h-2 rounded-full",
                  done
                    ? "bg-text-primary"
                    : current
                      ? "bg-text-primary/40"
                      : "bg-border-default",
                )}
              />
            );
          })}
        </div>
      </div>

      <div className="px-5 pb-4">
        <div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider mb-2">
          Preset
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.filter((p) => p.id !== "custom").map((p) => {
            const active = p.id === presetId;
            return (
              <button
                key={p.id}
                onClick={() => setPresetId(p.id)}
                disabled={isRunning}
                className={cn(
                  "h-7 px-2.5 rounded-full text-[12px] border transition-colors",
                  active
                    ? "bg-text-primary text-bg-primary border-text-primary"
                    : "border-border-default text-text-secondary hover:bg-bg-hover",
                  isRunning && "opacity-50 cursor-not-allowed",
                )}
              >
                {p.sub}
              </button>
            );
          })}
        </div>
      </div>

      {today && (
        <div className="px-5 pb-5 mt-auto">
          <div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider mb-2">
            Today
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Focus" value={fmtDur(today.focusMin)} />
            <Stat label="Sessions" value={String(today.sessions)} />
            <Stat label="Distracted" value={String(today.distractions)} />
            <Stat label="Streak" value="—" />
          </div>
        </div>
      )}
    </aside>
  );
}

function GroupedActionBtn({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className="inline-flex items-center gap-1.5 h-7 px-3 text-[11px] leading-none font-medium text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
    >
      <Icon size={11} strokeWidth={2.2} />
      {label}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border-subtle bg-bg-elevated px-2.5 py-2">
      <div className="text-[15px] font-semibold text-text-primary tabular-nums">
        {value}
      </div>
      <div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider mt-0.5">
        {label}
      </div>
    </div>
  );
}

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { invoke } from "@tauri-apps/api/core";
import { createSelectors } from "@/lib/create-selectors";
import { presetById } from "../lib/presets";
import { nowMinOfDay, todayIso, fmtClock } from "../lib/format";
import type {
  Block,
  DayAggregate,
  Phase,
  PresetId,
  PomodoroFile,
  SessionConfig,
} from "../lib/pomodoro-types";

interface PomodoroState {
  hydrated: boolean;
  hydratedFor: string | null;

  // Active session
  isRunning: boolean;
  presetId: PresetId;
  focusMin: number;
  breakMin: number;
  cyclesPlanned: number;
  cycleIdx: number; // 0-based; cycleIdx === cyclesPlanned → session done
  phase: Phase;
  secElapsed: number; // within current phase
  currentTask: string | null;
  currentTags: string[];

  // History
  blocks: Block[]; // today's blocks
  days: DayAggregate[];
  /** Universe of tags created across all sessions (autocomplete source). */
  knownTags: string[];

  // UI
  activeDayIdx: number;
  sheetOpen: boolean;

  actions: {
    tick(): void;
    startSession(cfg: SessionConfig): void;
    pause(): void;
    resume(): void;
    reset(): void;
    setPresetId(id: PresetId): void;
    setActiveDay(i: number): void;
    openSheet(): void;
    closeSheet(): void;
    quickStart(): void;
    clearAll(): void;
    hydrate(projectPath: string): Promise<void>;
    /** If `days[0]` no longer matches the current local date — Atlas was
     *  left running past midnight or woke from sleep on a new day —
     *  prepend a fresh "today" entry and shift `activeDayIdx` so the
     *  user's current selection follows. No-op if the date hasn't
     *  changed. */
    rolloverDay(): void;
  };
}

const DEFAULT_PRESET: PresetId = "25-5";

function emptyToday(): DayAggregate {
  return {
    date: todayIso(),
    today: true,
    focusMin: 0,
    sessions: 0,
    distractions: 0,
    hours: Array.from({ length: 24 }, () => 0),
    summary: "No sessions yet today.",
  };
}

export const usePomodoroStore = createSelectors(
  create<PomodoroState>()(
    immer((set, get) => ({
      hydrated: false,
      hydratedFor: null,

      isRunning: false,
      presetId: DEFAULT_PRESET,
      focusMin: 25,
      breakMin: 5,
      cyclesPlanned: 4,
      cycleIdx: 0,
      phase: "idle",
      secElapsed: 0,
      currentTask: null,
      currentTags: [],

      blocks: [],
      days: [emptyToday()],
      knownTags: [],

      activeDayIdx: 0,
      sheetOpen: false,

      actions: {
        tick: () =>
          set((s) => {
            if (!s.isRunning || s.phase === "idle") return;
            const phaseTotalSec = (s.phase === "focus" ? s.focusMin : s.breakMin) * 60;
            s.secElapsed += 1;

            // Update current block's elapsedMin live so the Gantt fill grows.
            const cur = s.blocks.find((b) => b.current);
            if (cur) cur.elapsedMin = Math.floor(s.secElapsed / 60);

            if (s.secElapsed >= phaseTotalSec) {
              // Phase boundary.
              if (cur) {
                cur.current = false;
                cur.elapsedMin = cur.endMin - cur.startMin;
              }
              if (s.phase === "focus") {
                // Roll into rest (if not last cycle); else end session.
                const isLast = s.cycleIdx + 1 >= s.cyclesPlanned;
                // Update today's aggregate for the just-completed focus block.
                const today = s.days[0];
                if (today) {
                  today.focusMin += s.focusMin;
                  today.sessions += 1;
                  const startMin = cur?.startMin ?? nowMinOfDay() - s.focusMin;
                  const h = Math.floor(startMin / 60);
                  if (h >= 0 && h < 24) today.hours[h] += s.focusMin;
                }

                if (isLast) {
                  s.phase = "idle";
                  s.isRunning = false;
                  s.secElapsed = 0;
                  s.currentTask = null;
                  s.currentTags = [];
                  fireNotification(
                    "Session complete",
                    `${s.cyclesPlanned} cycle${s.cyclesPlanned === 1 ? "" : "s"} done. Nice.`,
                  );
                } else {
                  s.phase = "rest";
                  s.secElapsed = 0;
                  const nowM = nowMinOfDay();
                  s.blocks.push({
                    id: `rest-${Date.now()}`,
                    startMin: nowM,
                    endMin: nowM + s.breakMin,
                    type: "rest",
                    title: "Break",
                    current: true,
                    elapsedMin: 0,
                  });
                  fireNotification("Focus complete", `Time for a ${s.breakMin}-min break.`);
                }
              } else {
                // rest → next focus
                s.phase = "focus";
                s.cycleIdx += 1;
                s.secElapsed = 0;
                const nowM = nowMinOfDay();
                s.blocks.push({
                  id: `focus-${Date.now()}`,
                  startMin: nowM,
                  endMin: nowM + s.focusMin,
                  type: "focus",
                  title: s.currentTask ?? "Focus",
                  tags: [...s.currentTags],
                  cycle: s.cycleIdx + 1,
                  distractions: 0,
                  current: true,
                  elapsedMin: 0,
                });
                fireNotification(
                  "Back to focus",
                  s.currentTask ? `Resuming: ${s.currentTask}` : "Cycle starting.",
                );
              }
            }
          }),

        startSession: (cfg) =>
          set((s) => {
            const nowM = nowMinOfDay();
            s.isRunning = true;
            s.presetId = cfg.presetId;
            s.focusMin = cfg.focusMin;
            s.breakMin = cfg.breakMin;
            s.cyclesPlanned = cfg.cycles;
            s.cycleIdx = 0;
            s.phase = "focus";
            s.secElapsed = 0;
            s.currentTask = cfg.task;
            s.currentTags = [...cfg.tags];
            // Merge new tags into knownTags universe.
            for (const t of cfg.tags) {
              if (!s.knownTags.includes(t)) s.knownTags.push(t);
            }
            // Demote any prior current block.
            for (const b of s.blocks) b.current = false;
            s.blocks.push({
              id: `focus-${Date.now()}`,
              startMin: nowM,
              endMin: nowM + cfg.focusMin,
              type: "focus",
              title: cfg.task,
              tags: [...cfg.tags],
              cycle: 1,
              distractions: 0,
              current: true,
              elapsedMin: 0,
            });
            s.sheetOpen = false;
          }),

        pause: () =>
          set((s) => {
            s.isRunning = false;
          }),

        resume: () =>
          set((s) => {
            if (s.phase === "idle") return;
            s.isRunning = true;
          }),

        reset: () =>
          set((s) => {
            s.secElapsed = 0;
            const cur = s.blocks.find((b) => b.current);
            if (cur) cur.elapsedMin = 0;
          }),

        setPresetId: (id) =>
          set((s) => {
            s.presetId = id;
            const p = presetById(id);
            if (id !== "custom") {
              s.focusMin = p.focusMin;
              s.breakMin = p.breakMin;
            }
          }),

        setActiveDay: (i) =>
          set((s) => {
            s.activeDayIdx = i;
          }),

        openSheet: () =>
          set((s) => {
            s.sheetOpen = true;
          }),
        closeSheet: () =>
          set((s) => {
            s.sheetOpen = false;
          }),

        quickStart: () => {
          get().actions.startSession({
            task: "Quick focus",
            tags: [],
            presetId: "25-5",
            focusMin: 25,
            breakMin: 5,
            cycles: 3,
          });
        },

        clearAll: () =>
          set((s) => {
            s.isRunning = false;
            s.phase = "idle";
            s.secElapsed = 0;
            s.cycleIdx = 0;
            s.currentTask = null;
            s.currentTags = [];
            s.blocks = [];
            s.days = [emptyToday()];
            s.activeDayIdx = 0;
          }),

        hydrate: async (projectPath: string) => {
          if (get().hydratedFor === projectPath) return;
          try {
            const file = await invoke<PomodoroFile>("pomodoro_load", {
              projectPath,
            });
            set((s) => {
              const today = todayIso();
              const persistedDays = file?.days ?? [];
              const hasToday = persistedDays.some((d) => d.date === today);
              // Always remap `today` against the current date — the
              // persisted flag is whatever was true when the file was
              // last written, which is stale the moment the clock
              // crosses midnight.
              const normalized = persistedDays.map((d) => ({
                ...d,
                today: d.date === today,
              }));
              s.days = hasToday ? normalized : [{ ...emptyToday(), today: true }, ...normalized];
              s.activeDayIdx = 0;
              s.blocks = (file?.blocks ?? []).map((b) => ({ ...b, current: false }));
              s.knownTags = file?.knownTags ?? [];
              s.hydrated = true;
              s.hydratedFor = projectPath;
            });
          } catch {
            set((s) => {
              s.hydrated = true;
              s.hydratedFor = projectPath;
            });
          }
        },

        rolloverDay: () =>
          set((s) => {
            const today = todayIso();
            if (s.days.length > 0 && s.days[0].date === today) {
              // Defensive: ensure exactly one day has today: true.
              for (let i = 0; i < s.days.length; i++) {
                s.days[i].today = i === 0;
              }
              return;
            }
            // Demote any stale today flags.
            for (const d of s.days) d.today = false;
            // Drop any in-flight session — it belongs to the previous
            // day. Blocks from yesterday stay in the persisted history.
            s.blocks = [];
            s.isRunning = false;
            s.phase = "idle";
            s.secElapsed = 0;
            s.cycleIdx = 0;
            s.currentTask = null;
            s.currentTags = [];
            s.days.unshift({ ...emptyToday(), today: true });
            // Keep the user's selection pointing at the same logical day
            // they had picked before the rollover. activeDayIdx was 0
            // means "today" — slide it to the new today (still 0).
            // Anything else means a historical day; shift by one to keep
            // pointing at the same date entry.
            if (s.activeDayIdx > 0) s.activeDayIdx += 1;
          }),
      },
    })),
  ),
);

export function selectDisplayClock(s: PomodoroState): string {
  if (s.phase === "idle") return `${String(s.focusMin).padStart(2, "0")}:00`;
  const phaseTotalSec = (s.phase === "focus" ? s.focusMin : s.breakMin) * 60;
  const remain = Math.max(0, phaseTotalSec - s.secElapsed);
  return fmtClock(remain);
}

async function fireNotification(title: string, body: string) {
  try {
    const mod = await import("@tauri-apps/plugin-notification");
    const granted = await mod.isPermissionGranted();
    const ok = granted || (await mod.requestPermission()) === "granted";
    if (ok) mod.sendNotification({ title, body });
  } catch {
    // plugin denied or unavailable
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSig = "";
export function attachPersistence(projectPath: string) {
  return usePomodoroStore.subscribe((s) => {
    if (!s.hydrated) return;
    const file: PomodoroFile = { days: s.days, blocks: s.blocks, knownTags: s.knownTags };
    const sig = JSON.stringify(file);
    if (sig === lastSig) return;
    lastSig = sig;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      invoke("pomodoro_save", { projectPath, file }).catch(() => {});
    }, 300);
  });
}

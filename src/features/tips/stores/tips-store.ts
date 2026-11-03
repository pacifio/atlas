import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { loadTips, markTipsSeen, resetTips, type TipsState } from "../lib/tips-api";
import type { TipCohort } from "../lib/tips-api";
import { NEVER_REPLAYED } from "../lib/tip-registry";

/**
 * Tips (CONTEXT.md, "Tip"): which ones are waiting, which one is on screen,
 * and the seen record Rust keeps in `tips.json`.
 *
 * This store decides nothing about *when* a tip appears — that is
 * `pickNextTip`, asked by the tips host. Callers only `request` a tip at the
 * moment the user meets its feature; asking twice, or for one already seen,
 * is harmless.
 *
 * A tip is marked seen when it is finished, however it closed (Done, Escape,
 * a click outside). A tip whose anchor goes away mid-tip was not really seen:
 * it goes back in the queue, and the gap it started is undone.
 */

interface ActiveTip {
  id: string;
  step: number;
}

interface TipsStoreState {
  loaded: boolean;
  cohort: TipCohort;
  seen: string[];
  /** Requested tip ids not yet shown, oldest first. */
  queue: string[];
  /** A tip asked for by name (Show tip…), waiting for its anchor. */
  forced: string | null;
  active: ActiveTip | null;
  /** When the last tip appeared in this window. */
  lastShownAt: number | null;
  actions: {
    load: () => Promise<void>;
    /** Another window (or this one) wrote `tips.json`. */
    applyRemote: (state: TipsState) => void;
    request: (id: string) => void;
    showByName: (id: string) => void;
    start: (id: string, now: number) => void;
    nextStep: () => void;
    finish: () => Promise<void>;
    anchorLost: () => void;
    replayAll: () => Promise<void>;
  };
}

export const useTipsStore = createSelectors(
  create<TipsStoreState>()((set, get) => {
    /** `lastShownAt` before the active tip started, to undo on anchor loss. */
    let shownBefore: number | null = null;
    /** The active tip was asked for by name, so on anchor loss it is again. */
    let activeWasForced = false;

    const adopt = (state: TipsState) => set({ cohort: state.cohort, seen: state.seen });

    return {
      loaded: false,
      cohort: "upgrade",
      seen: [],
      queue: [],
      forced: null,
      active: null,
      lastShownAt: null,
      actions: {
        load: async () => {
          try {
            adopt(await loadTips());
            set({ loaded: true });
          } catch {
            // No record means no tips this launch, rather than every tip again.
          }
        },
        applyRemote: adopt,
        request: (id) => {
          const { seen, queue } = get();
          if (seen.includes(id) || queue.includes(id)) return;
          set({ queue: [...queue, id] });
        },
        showByName: (id) => set({ forced: id }),
        start: (id, now) => {
          shownBefore = get().lastShownAt;
          activeWasForced = get().forced === id;
          set((s) => ({
            active: { id, step: 0 },
            queue: s.queue.filter((q) => q !== id),
            forced: s.forced === id ? null : s.forced,
            lastShownAt: now,
          }));
        },
        nextStep: () =>
          set((s) => (s.active ? { active: { ...s.active, step: s.active.step + 1 } } : {})),
        finish: async () => {
          const active = get().active;
          if (!active) return;
          set((s) => ({
            active: null,
            seen: s.seen.includes(active.id) ? s.seen : [...s.seen, active.id],
          }));
          try {
            adopt(await markTipsSeen([active.id]));
          } catch {
            // Kept seen for this launch; the next launch may show it again.
          }
        },
        anchorLost: () => {
          const active = get().active;
          if (!active) return;
          set((s) =>
            activeWasForced
              ? { active: null, forced: s.forced ?? active.id, lastShownAt: shownBefore }
              : {
                  active: null,
                  queue: [active.id, ...s.queue.filter((q) => q !== active.id)],
                  lastShownAt: shownBefore,
                },
          );
        },
        replayAll: async () => {
          adopt(await resetTips([...NEVER_REPLAYED]));
        },
      },
    };
  }),
);

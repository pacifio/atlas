import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import {
  completeChecklistItem,
  dismissGetStarted,
  loadTips,
  markTipSeen,
  reportTipShown,
  resetTips,
  type TipCohort,
  type TipOutcome,
  type TipsState,
} from "../lib/tips-api";
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
 *
 * It also mirrors Get started's progress (CONTEXT.md), which lives in the
 * same file: completing an item is idempotent, so any place that sees the
 * real event may report it.
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
  /** Get started items done. */
  checklist: string[];
  checklistDismissed: boolean;
  /** Get started is not for this user: they upgraded and already had a
   *  project. Decided once per launch, after projects load; null until then. */
  getStartedSkipped: boolean | null;
  /** Local dates Atlas was opened on, the last week of them. */
  activeDays: string[];
  actions: {
    load: () => Promise<void>;
    /** Another window (or this one) wrote `tips.json`. */
    applyRemote: (state: TipsState) => void;
    request: (id: string) => void;
    /** A requested tip is no longer true (the user signed in, capture went
     *  on): drop it unseen, and take it down if it is showing. */
    withdraw: (id: string) => void;
    showByName: (id: string) => void;
    start: (id: string, now: number) => void;
    nextStep: () => void;
    /** Close the active tip, recording how. */
    finish: (outcome?: TipOutcome) => Promise<void>;
    /** Record a prompt that is not a tip (the star prompt) as seen. */
    markSeen: (id: string, outcome: TipOutcome) => Promise<void>;
    completeItem: (item: string) => Promise<void>;
    /** Decide `getStartedSkipped`, once, from whether a project exists now.
     *  An upgrader who had one never gets "Add a project" ticked, so the
     *  same answer comes out on every launch; one who adds their first
     *  project from Get started keeps it. */
    decideGetStarted: (hasProject: boolean) => void;
    dismissChecklist: () => Promise<void>;
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

    const adopt = (state: TipsState) =>
      set({
        cohort: state.cohort,
        seen: state.seen,
        checklist: state.checklist,
        checklistDismissed: state.checklistDismissed,
        activeDays: state.activeDays,
      });

    return {
      loaded: false,
      cohort: "upgrade",
      seen: [],
      queue: [],
      forced: null,
      active: null,
      lastShownAt: null,
      checklist: [],
      checklistDismissed: false,
      getStartedSkipped: null,
      activeDays: [],
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
        withdraw: (id) =>
          set((s) => ({
            queue: s.queue.filter((q) => q !== id),
            forced: s.forced === id ? null : s.forced,
            ...(s.active?.id === id ? { active: null, lastShownAt: shownBefore } : {}),
          })),
        start: (id, now) => {
          shownBefore = get().lastShownAt;
          activeWasForced = get().forced === id;
          set((s) => ({
            active: { id, step: 0 },
            queue: s.queue.filter((q) => q !== id),
            forced: s.forced === id ? null : s.forced,
            lastShownAt: now,
          }));
          void reportTipShown(id).catch(() => {});
        },
        nextStep: () =>
          set((s) => (s.active ? { active: { ...s.active, step: s.active.step + 1 } } : {})),
        finish: async (outcome = "dismissed") => {
          const active = get().active;
          if (!active) return;
          set({ active: null });
          await get().actions.markSeen(active.id, outcome);
        },
        markSeen: async (id, outcome) => {
          set((s) => (s.seen.includes(id) ? {} : { seen: [...s.seen, id] }));
          try {
            adopt(await markTipSeen(id, outcome));
          } catch {
            // Kept seen for this launch; the next launch may show it again.
          }
        },
        completeItem: async (item) => {
          if (!get().loaded || get().checklist.includes(item)) return;
          set((s) => ({ checklist: [...s.checklist, item] }));
          try {
            adopt(await completeChecklistItem(item));
          } catch {
            // Ticked for this launch; the real event will report it again.
          }
        },
        decideGetStarted: (hasProject) => {
          const s = get();
          if (!s.loaded || s.getStartedSkipped !== null) return;
          set({
            getStartedSkipped:
              s.cohort === "upgrade" && hasProject && !s.checklist.includes("add-project"),
          });
        },
        dismissChecklist: async () => {
          set({ checklistDismissed: true });
          try {
            adopt(await dismissGetStarted());
          } catch {
            // Closed for this launch.
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

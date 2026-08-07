import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createSelectors } from "@/lib/create-selectors";

/**
 * Hint-mode ("ShortCat") state — intentionally tiny: just whether the overlay
 * is open. ALL the heavy work (DOM scan, label render, key handling) lives in
 * the overlay component and only runs while `open` is true, so when this is
 * false the feature has effectively zero cost.
 */
interface HintState {
  open: boolean;
}

interface HintActions {
  actions: {
    open: () => void;
    close: () => void;
    toggle: () => void;
  };
}

export const useHintStore = createSelectors(
  create<HintState & HintActions>()(
    immer((set) => ({
      open: false,
      actions: {
        open: () =>
          set((s) => {
            s.open = true;
          }),
        close: () =>
          set((s) => {
            s.open = false;
          }),
        toggle: () =>
          set((s) => {
            s.open = !s.open;
          }),
      },
    })),
  ),
);

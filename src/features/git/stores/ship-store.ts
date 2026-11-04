// The source-control panel's "Commit, push & PR" run, per repository: which
// steps it has, where each stands, and the failure or pull request it ended
// on. Kept in a store rather than the panel so switching to History and back,
// or closing the tab mid-push, does not lose the run or its retry.
//
// The run itself is `ship-flow.ts`; `ship-run.ts` drives it into here.

import { create } from "zustand";

import { createSelectors } from "@/lib/create-selectors";
import type { ShipState } from "../lib/ship-flow";

interface ShipStoreState {
  runs: Record<string, ShipState>;
  actions: {
    set: (repoPath: string, state: ShipState) => void;
    clear: (repoPath: string) => void;
  };
}

export const useShipStore = createSelectors(
  create<ShipStoreState>()((set) => ({
    runs: {},
    actions: {
      set: (repoPath, state) => set((s) => ({ runs: { ...s.runs, [repoPath]: state } })),
      clear: (repoPath) =>
        set((s) => {
          if (!(repoPath in s.runs)) return s;
          const runs = { ...s.runs };
          delete runs[repoPath];
          return { runs };
        }),
    },
  })),
);

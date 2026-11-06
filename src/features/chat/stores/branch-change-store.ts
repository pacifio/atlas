// Which sessions' last turn left their checkout on a different branch from the
// one it started on (`lib/branch-change-watch.ts` records them), for the
// composer's "Branch changed" strip. Not persisted: it reports what a turn
// just did, and a restart is a new look at the checkout.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";

export interface BranchChange {
  /** The checkout the turn ran in. */
  cwd: string;
  /** The branch it was on when the turn started. */
  was: string;
  /** The branch it was on when the turn ended. */
  now: string;
}

interface BranchChangeState {
  /** Tab id → the change its last turn made. Absent: none. */
  changes: Record<string, BranchChange>;
  actions: {
    record: (tabId: string, change: BranchChange) => void;
    clear: (tabId: string) => void;
  };
}

export const useBranchChangeStore = createSelectors(
  create<BranchChangeState>()((set) => ({
    changes: {},
    actions: {
      record: (tabId, change) => set((s) => ({ changes: { ...s.changes, [tabId]: change } })),
      clear: (tabId) =>
        set((s) => {
          if (!(tabId in s.changes)) return s;
          const { [tabId]: _gone, ...rest } = s.changes;
          return { changes: rest };
        }),
    },
  })),
);

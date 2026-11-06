// Whether a file tab shows the project tree beside the file. One preference
// for every file tab, persisted like the diff panel's view preferences: it is
// how the reader likes to work, and a relaunch should not reset it.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSelectors } from "@/lib/create-selectors";

interface FileTabTreeState {
  shown: boolean;
  actions: {
    setShown: (shown: boolean) => void;
  };
}

export const useFileTabTreeStore = createSelectors(
  create<FileTabTreeState>()(
    persist(
      (set) => ({
        shown: true,
        actions: {
          setShown: (shown) => set({ shown }),
        },
      }),
      { name: "atlas.explorer.file-tab-tree", partialize: (s) => ({ shown: s.shown }) },
    ),
  ),
);

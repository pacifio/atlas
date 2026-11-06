// A request for the Files surface to reveal a path (`ui_focus` explorer,
// `revealFiles(path)`), or to go back to following the file being read
// (`revealFiles()`, `toggleFiles()`: `path` null).
//
// A request is read once. The Files surface takes it and clears it here
// (`take`), and clears any left over when it leaves the screen, so reopening Files later
// (⌘T F, ⌘B) never re-highlights an old path. Not persisted.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";

export interface FilesRevealRequest {
  /** Absolute; null to follow the file being read. */
  path: string | null;
  /** Distinguishes a second ask for the same path. */
  nonce: number;
}

interface FilesRevealState {
  request: FilesRevealRequest | null;
  actions: {
    reveal: (path: string | null) => void;
    /** Clear the request once the surface has read it. */
    take: () => void;
  };
}

let nonce = 0;

export const useFilesRevealStore = createSelectors(
  create<FilesRevealState>()((set) => ({
    request: null,
    actions: {
      reveal: (path) => set({ request: { path, nonce: ++nonce } }),
      take: () => set({ request: null }),
    },
  })),
);

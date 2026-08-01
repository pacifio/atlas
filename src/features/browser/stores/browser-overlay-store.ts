import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createSelectors } from "@/lib/create-selectors";

/**
 * Tracks whether any DOM overlay is currently open, so the embedded browser
 * (a native child webview that paints ABOVE the DOM and can't be occluded by
 * z-index) can be hidden while a popup is showing.
 *
 * `embedCount` gates the detector: the overlay MutationObserver only runs while
 * at least one browser embed is live, so the feature costs nothing otherwise.
 */
interface BrowserOverlayState {
  overlayOpen: boolean;
  embedCount: number;
}

interface BrowserOverlayActions {
  actions: {
    setOverlayOpen: (open: boolean) => void;
    registerEmbed: () => void;
    unregisterEmbed: () => void;
  };
}

export const useBrowserOverlayStore = createSelectors(
  create<BrowserOverlayState & BrowserOverlayActions>()(
    immer((set) => ({
      overlayOpen: false,
      embedCount: 0,
      actions: {
        setOverlayOpen: (open) =>
          set((s) => {
            s.overlayOpen = open;
          }),
        registerEmbed: () =>
          set((s) => {
            s.embedCount += 1;
          }),
        unregisterEmbed: () =>
          set((s) => {
            s.embedCount = Math.max(0, s.embedCount - 1);
            if (s.embedCount === 0) s.overlayOpen = false;
          }),
      },
    })),
  ),
);

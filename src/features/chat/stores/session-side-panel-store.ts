// Which of a session's side panels is open: the Bash calls list or the Plans
// panel, never both.
//
// The chat panel draws them, but they are opened from the Details card
// (`activity-section.tsx`), which is a different feature's component and is
// not inside the chat panel's tree. So the choice lives here, keyed by tab,
// rather than in the chat panel's local state. Its own store, like the detail
// panel's: opening one must not re-render a transcript row.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";

export type SessionSidePanel = "bash" | "plans";

interface SessionSidePanelState {
  /** Keyed by chat tab id. A missing key is "none open". */
  open: Record<string, SessionSidePanel>;
  actions: {
    /** Open `panel` for the tab, closing the other; open already, close it. */
    toggle: (tabId: string, panel: SessionSidePanel) => void;
    close: (tabId: string) => void;
  };
}

const store = create<SessionSidePanelState>()((set) => ({
  open: {},
  actions: {
    toggle: (tabId, panel) =>
      set((s) => {
        const open = { ...s.open };
        if (open[tabId] === panel) delete open[tabId];
        else open[tabId] = panel;
        return { open };
      }),
    close: (tabId) =>
      set((s) => {
        if (!(tabId in s.open)) return s;
        const open = { ...s.open };
        delete open[tabId];
        return { open };
      }),
  },
}));

export const useSessionSidePanelStore = createSelectors(store);

/** The tab's open side panel, or `null`. */
export function useSessionSidePanel(tabId: string): SessionSidePanel | null {
  return useSessionSidePanelStore((s) => s.open[tabId] ?? null);
}

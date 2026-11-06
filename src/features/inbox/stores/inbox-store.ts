// The inbox's unread count — the sidebar dot — and its poll.
//
// Nothing pushes the inbox (the server has no socket for it), so the count is
// polled, as the web does: once a minute, only while the window is in front,
// and again the moment it comes back. The inbox page writes the count it
// reads, so opening it settles the dot without waiting for the next tick.

import { useEffect } from "react";
import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { inbox } from "../lib/inbox-api";

/** The web's own cadence (`INBOX_UNREAD_POLL_MS`). */
export const INBOX_POLL_MS = 60_000;

interface InboxState {
  /** `null` until read, and while the Organisation is not synced. */
  unread: number | null;
  actions: {
    setUnread: (unread: number | null) => void;
    /** One unread entry was read here: the dot follows without a round trip. */
    decrement: (by?: number) => void;
    refresh: () => Promise<void>;
  };
}

export const useInboxStore = createSelectors(
  create<InboxState>((set) => ({
    unread: null,
    actions: {
      setUnread: (unread) => set({ unread }),
      decrement: (by = 1) =>
        set((s) => ({ unread: s.unread === null ? null : Math.max(0, s.unread - by) })),
      refresh: async () => {
        try {
          set({ unread: await inbox.unread() });
        } catch {
          // Signed out, or a local-only Organisation: no inbox, no dot.
          set({ unread: null });
        }
      },
    },
  })),
);

/** Keep the count current while mounted: on mount, every minute while the
 *  window is in front, and on coming back to it. `key` (the Organisation)
 *  re-reads at once when it changes. */
export function useInboxUnreadPoll(key: string | null): void {
  useEffect(() => {
    const { refresh } = useInboxStore.getState().actions;
    if (!key) {
      useInboxStore.getState().actions.setUnread(null);
      return;
    }
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, INBOX_POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [key]);
}

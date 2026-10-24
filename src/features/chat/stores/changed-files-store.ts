// Which turns' changed-files cards the reader has expanded every folder of.
//
// Persisted, like the diff panel's preferences: a card the reader opened up
// stays open across a relaunch. Kept out of the chat store so a toggle
// re-renders the one card that reads its turn and nothing else; the
// transcript's rows never subscribe to the chat store.
//
// Keyed by the turn's stable key (`stableTurnKey`, `tc:<tool call id>`). A
// turn without one is named by its transcript id, which is re-minted when the
// log reloads, so that answer lasts the session and is never written out.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSelectors } from "@/lib/create-selectors";

/** Turns remembered. Insertion order is recency; the oldest go past this. */
export const MAX_REMEMBERED_TURNS = 200;

/** Only stable keys survive a reload; anything else would name nothing. */
const isStableKey = (key: string) => key.startsWith("tc:");

interface ChangedFilesState {
  /** Turn key → every folder expanded. Absent: the default, folded. */
  expanded: Record<string, true>;
  actions: {
    setExpanded: (turnKey: string, expanded: boolean) => void;
  };
}

export const useChangedFilesStore = createSelectors(
  create<ChangedFilesState>()(
    persist(
      (set) => ({
        expanded: {},
        actions: {
          setExpanded: (turnKey, expanded) =>
            set((s) => {
              const entries = Object.entries(s.expanded).filter(([key]) => key !== turnKey);
              if (expanded) entries.push([turnKey, true]);
              return { expanded: Object.fromEntries(entries.slice(-MAX_REMEMBERED_TURNS)) };
            }),
        },
      }),
      {
        name: "atlas.chat.changed-files",
        partialize: (s) => ({
          expanded: Object.fromEntries(Object.entries(s.expanded).filter(([k]) => isStableKey(k))),
        }),
      },
    ),
  ),
);

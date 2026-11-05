// Where a session's title-bar controls go.
//
// The session's controls (pins, the Details button) belong to the chat panel: it owns every piece
// of state they read and write. But they show in the window's title bar, at
// the right end of the column header that names the session, which the layout
// draws and the chat panel is not part of. So the column header renders an
// empty slot for its active session tab and registers it here, and that tab's
// chat panel portals its controls into it.
//
// Keyed by tab. Only a column's ACTIVE tab gets a slot, so a hidden session
// (chat panels stay mounted across tab switches) portals nothing, and a
// non-session tab leaves the title bar exactly as it was.

import { create } from "zustand";

interface SessionHeaderSlotState {
  slots: Record<string, HTMLElement>;
  register: (tabId: string, el: HTMLElement) => void;
  /** Only removes `el`: a remount can register the new element before the
   *  old one's cleanup runs. */
  unregister: (tabId: string, el: HTMLElement) => void;
}

export const useSessionHeaderSlotStore = create<SessionHeaderSlotState>()((set) => ({
  slots: {},
  register: (tabId, el) =>
    set((s) => (s.slots[tabId] === el ? s : { slots: { ...s.slots, [tabId]: el } })),
  unregister: (tabId, el) =>
    set((s) => {
      if (s.slots[tabId] !== el) return s;
      const slots = { ...s.slots };
      delete slots[tabId];
      return { slots };
    }),
}));

/** The title-bar slot for `tabId`'s controls, while its column shows it. */
export function useSessionHeaderSlot(tabId: string): HTMLElement | null {
  return useSessionHeaderSlotStore((s) => s.slots[tabId] ?? null);
}

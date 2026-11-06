// Whether the session list is scrolling. A row's hover card is anchored to
// its row; scrolling moves the row out from under the card (and the
// virtualizer may unmount it), which left the card floating over the
// destinations, pinned to where the row used to be. The rows disable their
// cards while this is true, which also closes an open one.
//
// It flips twice per scroll gesture — on at the first event, off once the
// list has been still for `SETTLE_MS` — so the rows re-render twice, not per
// frame.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";

/** How long the list has to be still before hover cards come back. */
const SETTLE_MS = 150;

interface SessionListScrollState {
  scrolling: boolean;
}

export const useSessionListScroll = createSelectors(
  create<SessionListScrollState>()(() => ({ scrolling: false })),
);

let settleTimer: ReturnType<typeof setTimeout> | undefined;

/** The list's scroll handler. */
export function noteSessionListScroll(): void {
  if (!useSessionListScroll.getState().scrolling) {
    useSessionListScroll.setState({ scrolling: true });
  }
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => useSessionListScroll.setState({ scrolling: false }), SETTLE_MS);
}

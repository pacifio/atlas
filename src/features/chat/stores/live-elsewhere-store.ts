// Which sessions another process (typically `claude` in a terminal) is still
// writing, and which of those the user chose to send to anyway (ADR-0001
// amendment, Rule 7, ATL-424).
//
// The backend decides liveness (`ThreadRow.liveElsewhere`). Exactly one writer
// sets the live ids: the shared query in `hooks/use-live-elsewhere-feed.ts`,
// which reads the whole history store, so the set never depends on which view
// or project a session was opened from. The composer reads it to hold a send
// behind a banner. Its own store, per the usual rule: stores never call other
// stores, and the composer must not re-render on unrelated history state.

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createSelectors } from "@/lib/create-selectors";

interface LiveElsewhereState {
  /** Session ids another process is writing now. A record rather than a Set so
   *  immer needs no MapSet plugin. */
  live: Record<string, true>;
  /** Live sessions the user pressed "Send anyway" on. */
  overridden: Record<string, true>;
  actions: {
    /** Replace the live set — the complete one, from the feed's query only.
     *  An override outlives only its liveness: once the other process goes
     *  quiet it is dropped, so a later live spell asks again. */
    setLive: (ids: readonly string[]) => void;
    /** Let sends through for this session while it stays live. */
    sendAnyway: (sessionId: string) => void;
  };
}

export const useLiveElsewhereStore = createSelectors(
  create<LiveElsewhereState>()(
    immer((set) => ({
      live: {},
      overridden: {},
      actions: {
        setLive: (ids) =>
          set((s) => {
            const next: Record<string, true> = {};
            for (const id of ids) next[id] = true;
            const sameLive =
              Object.keys(next).length === Object.keys(s.live).length &&
              Object.keys(next).every((id) => s.live[id]);
            if (!sameLive) s.live = next;
            for (const id of Object.keys(s.overridden)) {
              if (!next[id]) delete s.overridden[id];
            }
          }),
        sendAnyway: (sessionId) =>
          set((s) => {
            s.overridden[sessionId] = true;
          }),
      },
    })),
  ),
);

/** Whether a send from this session is held: live elsewhere and not overridden. */
export function useSendHeldForTerminal(sessionId: string | null | undefined): boolean {
  return useLiveElsewhereStore((s) =>
    sessionId ? !!s.live[sessionId] && !s.overridden[sessionId] : false,
  );
}

/**
 * The same answer outside React, for the action boundaries every send passes
 * through (`ChatPanel.handleSend`, `ui_chat`'s `send`).
 */
export function isSendHeldElsewhere(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  const s = useLiveElsewhereStore.getState();
  return !!s.live[sessionId] && !s.overridden[sessionId];
}

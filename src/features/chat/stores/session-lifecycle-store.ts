// A session's lifecycle, as actions: pin, snooze, settle, mark read/unread.
//
// Rust owns the state (`atlas-thread-metadata`): every rule between states
// lives in its store, and the sidebar re-reads rows on `atlas:threads-changed`.
// So this store holds no copy of any session — only which sessions have a
// lifecycle write in flight, so a row can show it — and its actions are the
// one place the UI reaches the lifecycle commands. A failure is toasted here
// with the backend's reason (the session is waiting on you, the time is in the
// past…) and the action resolves `false`, so callers need no error handling.
//
// "Viewed" is the frequent one: every tab focus would be a store write. It is
// debounced per session, so flicking through tabs marks only the one the user
// settles on.

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { toast } from "sonner";
import { createSelectors } from "@/lib/create-selectors";
import {
  markSessionUnread,
  markSessionViewed,
  pinSession,
  renameThread,
  reorderPinnedSession,
  settleThread,
  snoozeSession,
  unpinSession,
  unsettleThread,
  unsnoozeSession,
  wakeSession,
} from "../lib/history-api";

/** How long a session must stay focused before it counts as viewed. */
export const VIEWED_DEBOUNCE_MS = 1_500;

interface SessionLifecycleState {
  /** Thread ids with a lifecycle write in flight. */
  pending: Record<string, true>;
  actions: {
    /** Pin, at `orderKey` among the pinned (`pin-order.ts`). Brings a settled
     *  or snoozed session back. */
    pin: (threadId: string, orderKey?: string) => Promise<boolean>;
    unpin: (threadId: string) => Promise<boolean>;
    /** Move a pinned session; see `planPinnedReorder` for the keys. */
    reorderPin: (threadId: string, orderKey: string) => Promise<boolean>;
    /** Snooze until `until` (ISO; `session-snooze.ts`). Refused while the
     *  session waits on the user. */
    snooze: (threadId: string, until: string) => Promise<boolean>;
    wake: (threadId: string) => Promise<boolean>;
    /** Undo a snooze just set: clears it without the "woke" mark a wake leaves. */
    unsnooze: (threadId: string) => Promise<boolean>;
    settle: (threadId: string) => Promise<boolean>;
    unsettle: (threadId: string) => Promise<boolean>;
    markUnread: (threadId: string) => Promise<boolean>;
    /** Rename; an empty title clears the rename. */
    rename: (threadId: string, title: string) => Promise<boolean>;
    /** The chat tab running `sessionId` was opened or focused. Debounced. */
    noteViewed: (sessionId: string) => void;
    /** Drop a pending "viewed" — the tab lost focus before it counted. */
    cancelViewed: (sessionId: string) => void;
  };
}

/** Pending "viewed" timers, by live session id. Not state: nothing renders them. */
const viewedTimers = new Map<string, ReturnType<typeof setTimeout>>();

function reason(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

export const useSessionLifecycleStore = createSelectors(
  create<SessionLifecycleState>()(
    immer((set) => {
      /** Run one lifecycle write for `threadId`, marking it pending throughout. */
      const run = async (
        threadId: string,
        what: string,
        write: () => Promise<boolean>,
      ): Promise<boolean> => {
        set((s) => {
          s.pending[threadId] = true;
        });
        try {
          return await write();
        } catch (err) {
          toast.error(`Couldn't ${what}: ${reason(err)}`);
          return false;
        } finally {
          set((s) => {
            delete s.pending[threadId];
          });
        }
      };

      return {
        pending: {},
        actions: {
          pin: (threadId, orderKey) => run(threadId, "pin", () => pinSession(threadId, orderKey)),
          unpin: (threadId) => run(threadId, "unpin", () => unpinSession(threadId)),
          reorderPin: (threadId, orderKey) =>
            run(threadId, "move the pin", () => reorderPinnedSession(threadId, orderKey)),
          snooze: (threadId, until) =>
            run(threadId, "snooze", () => snoozeSession(threadId, until)),
          wake: (threadId) => run(threadId, "wake", () => wakeSession(threadId)),
          unsnooze: (threadId) => run(threadId, "undo the snooze", () => unsnoozeSession(threadId)),
          settle: (threadId) => run(threadId, "settle", () => settleThread(threadId)),
          unsettle: (threadId) => run(threadId, "un-settle", () => unsettleThread(threadId)),
          markUnread: (threadId) => run(threadId, "mark unread", () => markSessionUnread(threadId)),
          rename: (threadId, title) =>
            run(threadId, "rename", async () => {
              await renameThread(threadId, title);
              return true;
            }),
          noteViewed: (sessionId) => {
            const previous = viewedTimers.get(sessionId);
            if (previous !== undefined) clearTimeout(previous);
            viewedTimers.set(
              sessionId,
              setTimeout(() => {
                viewedTimers.delete(sessionId);
                // Quiet on failure: a missed "viewed" leaves a dot, not a loss.
                markSessionViewed(sessionId).catch((err) =>
                  console.warn("Couldn't mark the session viewed:", err),
                );
              }, VIEWED_DEBOUNCE_MS),
            );
          },
          cancelViewed: (sessionId) => {
            const pending = viewedTimers.get(sessionId);
            if (pending === undefined) return;
            clearTimeout(pending);
            viewedTimers.delete(sessionId);
          },
        },
      };
    }),
  ),
);

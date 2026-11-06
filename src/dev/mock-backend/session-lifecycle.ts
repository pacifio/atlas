// The session lifecycle — settle, pin, snooze, viewed/unread — as the fake
// backend answers it. Shared by every handler map that fakes history
// (`fixtures/misc.ts`, the Northwind scenario), so the rules are written
// once, mirroring Rust's store (`atlas-thread-metadata`): settling clears pin
// and snooze, pinning brings a settled or snoozed session back, a snooze wakes
// on one timer for the soonest of them, `unread` and `woke` are decided here
// and arrive on the row.

import type { ThreadRow } from "@/features/chat/lib/history-api";
import type { MockHandlers } from "./types";

interface ThreadList {
  get: () => ThreadRow[];
  set: (rows: ThreadRow[]) => void;
  /** Tell every history surface to re-read (`atlas:threads-changed`). */
  changed: () => void;
}

/** A row with `unread` / `woke` recomputed from its stored times, as Rust's
 *  `thread_row` does. */
export function withDerivedLifecycle(row: ThreadRow): ThreadRow {
  const viewed = row.lastViewedAt ? Date.parse(row.lastViewedAt) : null;
  const done = row.lastTurnCompletedAt ? Date.parse(row.lastTurnCompletedAt) : null;
  const woke = row.lastSnoozeWakeAt ? Date.parse(row.lastSnoozeWakeAt) : null;
  return {
    ...row,
    unread: done !== null && (viewed === null || viewed < done),
    woke:
      row.settledAt === null &&
      row.snoozedUntil === null &&
      woke !== null &&
      (viewed === null || viewed < woke),
  };
}

/**
 * The lifecycle commands over `list`, plus the snooze wake timer. Each
 * handler answers what Rust answers: whether anything changed, or a thrown
 * error with the reason the real command gives.
 */
export function sessionLifecycleHandlers(list: ThreadList): MockHandlers {
  const now = () => new Date().toISOString();
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Change one row; answers whether `mutate` changed it. */
  const update = (threadId: unknown, mutate: (row: ThreadRow) => ThreadRow | null): boolean => {
    let changed = false;
    list.set(
      list.get().map((row) => {
        if (row.threadId !== String(threadId)) return row;
        const next = mutate(row);
        if (next === null) return row;
        changed = true;
        return withDerivedLifecycle(next);
      }),
    );
    if (changed) {
      list.changed();
      schedule();
    }
    return changed;
  };

  /** One timer for the soonest snooze, as `run_snooze_waker` keeps. */
  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer);
    const soonest = list
      .get()
      .map((row) => (row.snoozedUntil ? Date.parse(row.snoozedUntil) : Infinity))
      .reduce((a, b) => Math.min(a, b), Infinity);
    if (soonest === Infinity) return;
    timer = setTimeout(
      () => {
        const at = Date.now();
        let woke = false;
        list.set(
          list.get().map((row) => {
            if (!row.snoozedUntil || Date.parse(row.snoozedUntil) > at) return row;
            woke = true;
            return withDerivedLifecycle({
              ...row,
              snoozedUntil: null,
              snoozedAt: null,
              lastSnoozeWakeAt: row.snoozedUntil,
            });
          }),
        );
        if (woke) list.changed();
        schedule();
      },
      // setTimeout's ceiling is ~24.8 days; a later snooze re-arms on firing.
      Math.min(Math.max(0, soonest - Date.now()), 2 ** 31 - 1),
    );
  }

  // Arm for the rows the list starts with, once it exists.
  queueMicrotask(schedule);

  return {
    threads_settle: ({ threadId }): boolean =>
      update(threadId, (row) =>
        row.settledAt !== null && row.pinnedAt === null && row.snoozedUntil === null
          ? null
          : {
              ...row,
              settledAt: row.settledAt ?? now(),
              pinnedAt: null,
              pinOrder: null,
              snoozedUntil: null,
              snoozedAt: null,
            },
      ),
    threads_unsettle: ({ threadId }): boolean =>
      update(threadId, (row) => (row.settledAt === null ? null : { ...row, settledAt: null })),
    threads_pin: ({ threadId, orderKey }): boolean =>
      update(threadId, (row) => {
        const promotes = row.settledAt !== null || row.snoozedUntil !== null;
        if (row.pinnedAt !== null && !promotes) return null;
        return {
          ...row,
          pinnedAt: row.pinnedAt ?? now(),
          pinOrder: row.pinnedAt !== null ? row.pinOrder : (orderKey ?? null),
          settledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          lastSnoozeWakeAt: row.snoozedUntil !== null ? now() : row.lastSnoozeWakeAt,
        };
      }),
    threads_unpin: ({ threadId }): boolean =>
      update(threadId, (row) =>
        row.pinnedAt === null ? null : { ...row, pinnedAt: null, pinOrder: null },
      ),
    threads_reorder_pin: ({ threadId, orderKey }): boolean =>
      update(threadId, (row) =>
        row.pinnedAt === null || row.pinOrder === orderKey
          ? null
          : { ...row, pinOrder: String(orderKey) },
      ),
    threads_snooze: ({ threadId, until }): boolean => {
      if (!(Date.parse(String(until)) > Date.now())) {
        throw new Error("Pick a time in the future to snooze until.");
      }
      return update(threadId, (row) => ({
        ...row,
        snoozedUntil: new Date(String(until)).toISOString(),
        snoozedAt: now(),
      }));
    },
    threads_wake: ({ threadId }): boolean =>
      update(threadId, (row) =>
        row.snoozedUntil === null
          ? null
          : { ...row, snoozedUntil: null, snoozedAt: null, lastSnoozeWakeAt: now() },
      ),
    threads_unsnooze: ({ threadId }): boolean =>
      update(threadId, (row) =>
        row.snoozedUntil === null ? null : { ...row, snoozedUntil: null, snoozedAt: null },
      ),
    threads_rename: ({ threadId, title }): null => {
      update(threadId, (row) => {
        const next = String(title ?? "").trim();
        return next && next !== row.title ? { ...row, title: next } : null;
      });
      return null;
    },
    threads_mark_viewed: ({ sessionId }): boolean => {
      const row = list.get().find((candidate) => candidate.sessionId === String(sessionId));
      if (!row) return false;
      update(row.threadId, (current) => ({ ...current, lastViewedAt: now() }));
      return true;
    },
    threads_mark_unread: ({ threadId }): boolean => {
      const row = list.get().find((candidate) => candidate.threadId === String(threadId));
      if (!row) return false;
      if (!row.lastTurnCompletedAt) {
        throw new Error("This session has no finished turn to mark unread.");
      }
      if (row.unread) return false;
      const justBefore = new Date(Date.parse(row.lastTurnCompletedAt) - 1).toISOString();
      return update(threadId, (current) => ({ ...current, lastViewedAt: justBefore }));
    },
  };
}

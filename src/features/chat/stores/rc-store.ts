/**
 * The rooms this desktop hosts, by session id — a mirror of Rust's
 * `RcState`, fed by `atlas:rc` (see `lib/rc-mirror.ts`). Rust owns the room;
 * this only remembers what it last said, so the chat header can draw it.
 *
 * An `ended` room stays here until the session starts another, so the header
 * can say why it ended rather than silently dropping the indicator.
 */

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { drivenElsewhere, type RcDriver, type RcRoom } from "../lib/rc-api";

interface RcStoreState {
  bySession: Record<string, RcRoom>;
  actions: {
    /** One room, replaced whole — the event is never a delta. */
    upsert: (room: RcRoom) => void;
    /** The whole set, from `rc_status`. Rooms the seed does not name are
     *  dropped unless they ended (an ended room is no longer in Rust's set).
     *  A room the listener already has wins over the seed's copy: the
     *  listener was installed first, so its copy is never older. */
    seed: (rooms: RcRoom[]) => void;
    forget: (sessionId: string) => void;
  };
}

function sameDriver(a: RcRoom["driver"], b: RcRoom["driver"]): boolean {
  if (!a || !b) return a === b;
  return a.id === b.id && a.name === b.name && a.isOwner === b.isOwner && a.lost === b.lost;
}

function samePending(a: RcRoom["pending"], b: RcRoom["pending"]): boolean {
  return a.length === b.length && a.every((r, i) => r.requestId === b[i].requestId);
}

function samePeers(a: RcRoom["peers"], b: RcRoom["peers"]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => {
      const q = b[i];
      return (
        p.id === q.id &&
        p.name === q.name &&
        p.role === q.role &&
        p.tier === q.tier &&
        p.since === q.since &&
        p.surfaces.length === q.surfaces.length &&
        p.surfaces.every((s, j) => s === q.surfaces[j])
      );
    })
  );
}

// Every field the window draws. A field left out here is a change the
// window never sees: Rust sends the room whole, so an event that differs
// only in that field is dropped as a repeat — the switch flips back, the
// list stays stale.
function same(a: RcRoom | undefined, b: RcRoom): boolean {
  return (
    !!a &&
    a.roomId === b.roomId &&
    a.state === b.state &&
    a.ownerOnline === b.ownerOnline &&
    a.viewers === b.viewers &&
    a.memberTier === b.memberTier &&
    a.acceptRequests === b.acceptRequests &&
    a.startedAt === b.startedAt &&
    a.lastError === b.lastError &&
    a.endReason === b.endReason &&
    a.viewerUrl === b.viewerUrl &&
    a.scope?.orgId === b.scope?.orgId &&
    a.scope?.workspaceId === b.scope?.workspaceId &&
    sameDriver(a.driver, b.driver) &&
    samePending(a.pending, b.pending) &&
    samePeers(a.peers, b.peers)
  );
}

export const useRcStore = createSelectors(
  create<RcStoreState>((set) => ({
    bySession: {},
    actions: {
      upsert: (room) =>
        set((s) => {
          const current = s.bySession[room.sessionId];
          // A deleted room the window already forgot (the delete's answer
          // landed before its event): not brought back as a dead pill.
          if (!current && room.state === "ended" && room.endReason === "deleted") return s;
          return same(current, room)
            ? s
            : { bySession: { ...s.bySession, [room.sessionId]: room } };
        }),
      seed: (rooms) =>
        set((s) => {
          const next: Record<string, RcRoom> = {};
          for (const [id, room] of Object.entries(s.bySession)) {
            if (room.state === "ended") next[id] = room;
          }
          for (const room of rooms) {
            next[room.sessionId] = s.bySession[room.sessionId] ?? room;
          }
          return { bySession: next };
        }),
      forget: (sessionId) =>
        set((s) => {
          if (!(sessionId in s.bySession)) return s;
          const { [sessionId]: _gone, ...rest } = s.bySession;
          return { bySession: rest };
        }),
    },
  })),
);

/** The session's room, if it has (or had) one. */
export function useRcRoom(sessionId: string | null | undefined): RcRoom | undefined {
  return useRcStore((s) => (sessionId ? s.bySession[sessionId] : undefined));
}

/**
 * Who drives the session from remote control when it is not this desktop's
 * account — the one state in which the window's own composer is refused (the
 * steering entry refuses it too; this is what lets the composer say so first).
 * `null` while the owner drives, while there is no room, and once it ended.
 */
export function useRcRemoteDriver(sessionId: string | null | undefined): RcDriver | null {
  return useRcStore((s) => drivenElsewhere(sessionId ? s.bySession[sessionId] : undefined));
}

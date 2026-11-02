// Universal RC, faked: a room that opens, goes live a beat later, gains a
// viewer, hears that viewer ask to drive, and ends when stopped — the states
// the chat header's indicator and the composer's seat strip draw, reachable
// in `bun run dev` without a room server.
//
// Every change goes out on `atlas:rc` the way Rust's host task announces it,
// so the header is driven by the same listener it uses in the app. The room
// is the account's: it opens solo (`scope: null`); `rc_set_scope` shares it
// with the mock organisation.

import { emit } from "@tauri-apps/api/event";
import type {
  RcControlRequest,
  RcRoom,
  RcScope,
  RcStarted,
  RcTier,
} from "@/features/chat/lib/rc-api";
import type { TypedHandlers, Unit } from "../types";

export interface RcResponses {
  rc_start: RcStarted;
  rc_stop: Unit;
  rc_status: RcRoom[];
  rc_set_scope: RcScope | null;
  rc_set_member_tier: RcTier;
  rc_take_over: Unit;
  rc_answer_control: Unit;
  rc_grant_control: Unit;
  rc_kick: Unit;
}

const OWNER = { id: "user_mock", name: null, isOwner: true, lost: false };
const ADA = { id: "user_ada", name: "Ada", isOwner: false, lost: false };
const MOCK_SCOPE: RcScope = { orgId: "org_mock", workspaceId: null };
const rooms = new Map<string, RcRoom>();

function announce(room: RcRoom) {
  rooms.set(room.sessionId, room);
  void emit("atlas:rc", room);
}

function later(ms: number, fn: () => void) {
  setTimeout(fn, ms);
}

function open(sessionId: string): RcRoom | undefined {
  const room = rooms.get(sessionId);
  return room && room.state !== "ended" ? room : undefined;
}

export const rcHandlers: TypedHandlers<RcResponses> = {
  rc_start: ({ sessionId }) => {
    const existing = open(sessionId as string);
    if (existing) {
      return {
        roomId: existing.roomId,
        scope: existing.scope,
        viewerUrl: existing.viewerUrl,
        note: null,
      };
    }
    const roomId = `01MOCKROOM${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const room: RcRoom = {
      sessionId: sessionId as string,
      roomId,
      scope: null,
      memberTier: "view",
      viewerUrl: `https://app.tryatlas.cc/rc/rooms/${roomId}`,
      state: "connecting",
      ownerOnline: false,
      viewers: 0,
      driver: null,
      pending: [],
      lastError: null,
      endReason: null,
    };
    announce(room);
    later(600, () => {
      const now = rooms.get(room.sessionId);
      if (now?.roomId === roomId && now.state === "connecting") {
        announce({ ...now, state: "live", ownerOnline: true, driver: OWNER });
      }
    });
    later(2500, () => {
      const now = rooms.get(room.sessionId);
      if (now?.roomId === roomId && now.state === "live") announce({ ...now, viewers: 1 });
    });
    // A beat later the viewer asks to drive; Allow hands Ada the seat and the
    // composer locks until Take over.
    later(5000, () => {
      const now = rooms.get(room.sessionId);
      if (now?.roomId === roomId && now.state === "live" && now.driver?.isOwner) {
        const request: RcControlRequest = {
          requestId: `req_${roomId}`,
          fromId: ADA.id,
          fromName: ADA.name,
          requestedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        };
        announce({ ...now, pending: [request] });
      }
    });
    return { roomId, scope: null, viewerUrl: room.viewerUrl, note: null };
  },
  rc_stop: ({ sessionId }) => {
    const room = open(sessionId as string);
    if (room) {
      announce({
        ...room,
        state: "ended",
        ownerOnline: false,
        viewers: 0,
        driver: null,
        pending: [],
        endReason: "closed_by_owner",
      });
    }
    return null;
  },
  rc_status: () => [...rooms.values()].filter((room) => room.state !== "ended"),
  rc_set_scope: ({ sessionId }) => {
    const room = open(sessionId as string);
    if (!room) throw new Error("Remote control is not on for this session.");
    if (!room.scope) announce({ ...room, scope: MOCK_SCOPE });
    return rooms.get(sessionId as string)?.scope ?? null;
  },
  rc_set_member_tier: ({ sessionId, tier }) => {
    const room = open(sessionId as string);
    if (!room) throw new Error("Remote control is not on for this session.");
    if (!room.scope) throw new Error("Share the room with an organisation first.");
    const memberTier = tier as RcTier;
    if (room.memberTier !== memberTier) announce({ ...room, memberTier });
    return memberTier;
  },
  rc_take_over: ({ sessionId }) => {
    const room = open(sessionId as string);
    if (!room) throw new Error("Remote control is not on for this session.");
    if (room.driver && !room.driver.isOwner) announce({ ...room, driver: OWNER });
    return null;
  },
  rc_answer_control: ({ sessionId, requestId, approve }) => {
    const room = open(sessionId as string);
    if (!room) throw new Error("Remote control is not on for this session.");
    const request = room.pending.find((r) => r.requestId === requestId);
    if (!request) return null;
    const pending = room.pending.filter((r) => r.requestId !== requestId);
    announce({
      ...room,
      pending,
      driver: approve ? { ...ADA, id: request.fromId, name: request.fromName } : room.driver,
    });
    return null;
  },
  rc_grant_control: ({ sessionId, target }) => {
    const room = open(sessionId as string);
    if (!room) throw new Error("Remote control is not on for this session.");
    announce({
      ...room,
      pending: room.pending.filter((r) => r.fromId !== target),
      driver: { ...ADA, id: target as string, name: target === ADA.id ? ADA.name : null },
    });
    return null;
  },
  rc_kick: ({ sessionId, target }) => {
    const room = open(sessionId as string);
    if (!room) throw new Error("Remote control is not on for this session.");
    announce({
      ...room,
      viewers: Math.max(0, room.viewers - 1),
      pending: room.pending.filter((r) => r.fromId !== target),
      driver: room.driver?.id === target ? OWNER : room.driver,
    });
    return null;
  },
};

// Universal RC, faked: a room that opens, goes live a beat later, gains
// people (you on your phone, then Priya on the web), hears Priya ask to
// drive, and ends when stopped — the states the title bar's room panel and
// the composer's seat strip draw, reachable in `bun run dev` without a room
// server. Ids are the mock Organisation's members (`integrations.ts`), so
// faces and names resolve the way they do against the real roster — which
// names nobody: the room sends `name: null` for every user.
//
// Every change goes out on `atlas:rc` the way Rust's host task announces it,
// so the header is driven by the same listener it uses in the app. The room
// is the account's: it opens solo (`scope: null`); `rc_set_scope` shares it
// with the mock organisation.

import { emit } from "@tauri-apps/api/event";
import type {
  RcControlRequest,
  RcMember,
  RcPeer,
  RcRoom,
  RcScope,
  RcStarted,
  RcTier,
} from "@/features/chat/lib/rc-api";
import { MOCK_ORG_ID } from "../project";
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
  rc_members: RcMember[];
  rc_invite: RcMember;
  rc_revoke_invite: Unit;
  rc_set_accept_requests: Unit;
}

/** The signed-in mock account (`integrations.ts`). */
const OWNER = { id: "usr_dev", name: null, isOwner: true, lost: false };
/** The teammate who watches and asks to drive. */
const PRIYA = { id: "usr_priya", name: null, isOwner: false, lost: false };
const MOCK_SCOPE: RcScope = { orgId: MOCK_ORG_ID, workspaceId: null };
const rooms = new Map<string, RcRoom>();
/** Invites per room — the server's `rc_members`. */
const members = new Map<string, RcMember[]>();

const ownerPhone: RcPeer = {
  id: OWNER.id,
  kind: "user",
  name: null,
  surfaces: ["mobile"],
  role: "owner",
  tier: "steer_approve",
  since: Date.now(),
};
const priyaWeb: RcPeer = {
  id: PRIYA.id,
  kind: "user",
  name: null,
  surfaces: ["web"],
  role: "visitor",
  tier: "steer",
  since: Date.now(),
};

/** Roles follow the seat: whoever drives reads `driver`. */
function withRoles(peers: RcPeer[], driverId: string | undefined): RcPeer[] {
  return peers.map((p) =>
    p.role === "owner" ? p : { ...p, role: p.id === driverId ? "driver" : "visitor" },
  );
}

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
      startedAt: Date.now(),
      state: "connecting",
      ownerOnline: false,
      viewers: 0,
      peers: [],
      acceptRequests: true,
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
    later(1500, () => {
      const now = rooms.get(room.sessionId);
      if (now?.roomId === roomId && now.state === "live") {
        announce({ ...now, viewers: 1, peers: [ownerPhone] });
      }
    });
    later(2500, () => {
      const now = rooms.get(room.sessionId);
      if (now?.roomId === roomId && now.state === "live") {
        announce({ ...now, viewers: 2, peers: [ownerPhone, priyaWeb] });
      }
    });
    // A beat later the viewer asks to drive; Allow hands Ada the seat and the
    // composer locks until Take over.
    later(5000, () => {
      const now = rooms.get(room.sessionId);
      if (
        now?.roomId === roomId &&
        now.state === "live" &&
        now.driver?.isOwner &&
        now.acceptRequests
      ) {
        const request: RcControlRequest = {
          requestId: `req_${roomId}`,
          fromId: PRIYA.id,
          fromName: PRIYA.name,
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
        peers: [],
        acceptRequests: true,
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
    if (!room.scope) {
      // Priya came in on the org's invite list; Sam is invited, not yet here.
      members.set(room.roomId, [
        { userId: PRIYA.id, invitedAt: Date.now() - 60_000, joinedAt: Date.now() - 30_000 },
        { userId: "usr_sam", invitedAt: Date.now() - 60_000, joinedAt: null },
      ]);
      announce({ ...room, scope: MOCK_SCOPE });
    }
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
    if (room.driver && !room.driver.isOwner) {
      announce({ ...room, driver: OWNER, peers: withRoles(room.peers, OWNER.id) });
    }
    return null;
  },
  rc_answer_control: ({ sessionId, requestId, approve }) => {
    const room = open(sessionId as string);
    if (!room) throw new Error("Remote control is not on for this session.");
    const request = room.pending.find((r) => r.requestId === requestId);
    if (!request) return null;
    const pending = room.pending.filter((r) => r.requestId !== requestId);
    const driver = approve ? { ...PRIYA, id: request.fromId } : room.driver;
    announce({ ...room, pending, driver, peers: withRoles(room.peers, driver?.id) });
    return null;
  },
  rc_grant_control: ({ sessionId, target }) => {
    const room = open(sessionId as string);
    if (!room) throw new Error("Remote control is not on for this session.");
    const driver = { ...PRIYA, id: target as string };
    announce({
      ...room,
      pending: room.pending.filter((r) => r.fromId !== target),
      driver,
      peers: withRoles(room.peers, driver.id),
    });
    return null;
  },
  rc_kick: ({ sessionId, target }) => {
    const room = open(sessionId as string);
    if (!room) throw new Error("Remote control is not on for this session.");
    const peers = room.peers.filter((p) => p.id !== target);
    const driver = room.driver?.id === target ? OWNER : room.driver;
    announce({
      ...room,
      viewers: peers.length,
      peers: withRoles(peers, driver?.id),
      pending: room.pending.filter((r) => r.fromId !== target),
      driver,
    });
    return null;
  },
  rc_members: ({ sessionId }) => {
    const room = open(sessionId as string);
    return room?.scope ? (members.get(room.roomId) ?? []) : [];
  },
  rc_invite: ({ sessionId, userId }) => {
    const room = open(sessionId as string);
    if (!room) throw new Error("Remote control is not on for this session.");
    if (!room.scope) throw new Error("Share the room with an organisation first.");
    const member: RcMember = { userId: userId as string, invitedAt: Date.now(), joinedAt: null };
    const list = (members.get(room.roomId) ?? []).filter((m) => m.userId !== userId);
    members.set(room.roomId, [...list, member]);
    return member;
  },
  rc_revoke_invite: ({ sessionId, userId }) => {
    const room = open(sessionId as string);
    if (!room) throw new Error("Remote control is not on for this session.");
    members.set(
      room.roomId,
      (members.get(room.roomId) ?? []).filter((m) => m.userId !== userId),
    );
    // The server drops a revoked teammate's sockets.
    if (room.peers.some((p) => p.id === userId)) {
      const peers = room.peers.filter((p) => p.id !== userId);
      const driver = room.driver?.id === userId ? OWNER : room.driver;
      announce({ ...room, peers: withRoles(peers, driver?.id), viewers: peers.length, driver });
    }
    return null;
  },
  rc_set_accept_requests: ({ sessionId, accept }) => {
    const room = open(sessionId as string);
    if (!room) throw new Error("Remote control is not on for this session.");
    // Off declines every open ask at once.
    announce({ ...room, acceptRequests: !!accept, pending: accept ? room.pending : [] });
    return null;
  },
};

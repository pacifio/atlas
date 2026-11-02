// Thin TS wrapper around Universal RC's Tauri commands
// (`src-tauri/src/commands/rc.rs`). Rust holds the room — its host socket, its
// secret, the session hold — and announces every change on `atlas:rc`; the
// window mirrors it and decides nothing.
//
// A room is the signed-in account's: starting one needs no organisation. The
// optional `scope` is the organisation (and project) the owner may invite
// from — multiplayer — and nothing else.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** The window event channel: one room's whole state, on every change. */
export const RC_EVENT = "atlas:rc";

/** The host socket's state. `ended` is final: the room is gone. */
export type RcLinkState = "connecting" | "live" | "offline" | "ended";

/** Why a room ended (`RC_END_REASONS` on the server). */
export type RcEndReason =
  | "closed_by_owner"
  | "closed_by_admin"
  | "owner_timeout"
  | "never_hosted"
  | "erased"
  | "retention";

/** The tier invited members connect under (Rust `Tier`). */
export type RcTier = "view" | "steer" | "steer_approve";

/** Mirror of Rust `RcScopeWire`: whom the owner may invite. `null` = solo. */
export interface RcScope {
  orgId: string;
  workspaceId: string | null;
}

/** Mirror of Rust `RcDriverWire`: who holds the seat. */
export interface RcDriver {
  id: string;
  name: string | null;
  /** This desktop's account drives — the composer is free. */
  isOwner: boolean;
  /** The seat is waiting out the driver's reconnect. */
  lost: boolean;
}

/** Mirror of Rust `RcControlRequestWire`: a visitor asking to drive. */
export interface RcControlRequest {
  requestId: string;
  fromId: string;
  fromName: string | null;
  requestedAt: number;
  expiresAt: number;
}

/** Mirror of Rust `RcRoomWire`. */
export interface RcRoom {
  sessionId: string;
  roomId: string;
  scope: RcScope | null;
  /** What invited members may do: watch (`view`), or prompt and ask for the
   *  seat (`steer`). Changed from the title-bar pill or the web room page. */
  memberTier: RcTier;
  /** The web page a phone opens to watch and steer. */
  viewerUrl: string;
  state: RcLinkState;
  /** The room's own view of this desktop. */
  ownerOnline: boolean;
  /** Distinct people connected, from the room's roster. */
  viewers: number;
  /** `null` before the room's first welcome. */
  driver: RcDriver | null;
  pending: RcControlRequest[];
  lastError: string | null;
  endReason: RcEndReason | null;
}

/** Mirror of Rust `RcStarted`. */
export interface RcStarted {
  roomId: string;
  scope: RcScope | null;
  viewerUrl: string;
  /** A non-blocking word: the organisation refused sharing, so the room is
   *  solo. `null` when there is nothing to say. */
  note: string | null;
}

export const rc = {
  /** Open (or answer the existing) room for a live session. */
  start: (sessionId: string, title?: string) =>
    invoke<RcStarted>("rc_start", { sessionId, title: title ?? null }),
  /** End the session's room. Idempotent. */
  stop: (sessionId: string) => invoke<void>("rc_stop", { sessionId }),
  /** Every room this desktop hosts — the seed for a window that just loaded. */
  status: () => invoke<RcRoom[]>("rc_status"),
  /** Share a solo room with the organisation Atlas now targets. Set once. */
  setScope: (sessionId: string) => invoke<RcScope | null>("rc_set_scope", { sessionId }),
  /** Owner: what invited members may do. Refused on a solo room. */
  setMemberTier: (sessionId: string, tier: RcTier) =>
    invoke<RcTier>("rc_set_member_tier", { sessionId, tier }),
  /** Owner: take the seat back from whoever drives. */
  takeOver: (sessionId: string) => invoke<void>("rc_take_over", { sessionId }),
  /** Owner: answer a visitor's request to drive. */
  answerControl: (sessionId: string, requestId: string, approve: boolean) =>
    invoke<void>("rc_answer_control", { sessionId, requestId, approve }),
  /** Owner: hand the seat to a connected principal (by principal id). */
  grantControl: (sessionId: string, target: string) =>
    invoke<void>("rc_grant_control", { sessionId, target }),
  /** Owner: cut a principal's sockets; a driver so kicked loses the seat. */
  kick: (sessionId: string, target: string) => invoke<void>("rc_kick", { sessionId, target }),
  listen: (cb: (room: RcRoom) => void): Promise<UnlistenFn> =>
    listen<RcRoom>(RC_EVENT, (event) => cb(event.payload)),
};

/** Someone other than this desktop's account holds the seat of a room whose
 *  host socket is up. Only `live` counts: a driver the desktop cannot hear
 *  (the room `offline` or still `connecting`) is not driving, so the owner's
 *  composer is free — Rust's steering entry draws the same line — and the next
 *  welcome or roster re-asserts the seat if they still hold it. */
export function drivenElsewhere(room: RcRoom | undefined): RcDriver | null {
  if (!room || room.state !== "live" || !room.driver || room.driver.isOwner) return null;
  return room.driver;
}

/** Whether the room is still open — any state but `ended`. */
export function roomOpen(room: RcRoom | undefined): room is RcRoom {
  return !!room && room.state !== "ended";
}

/** What to call the driver in a sentence. */
export function driverLabel(driver: RcDriver | RcControlRequest): string {
  const name = "name" in driver ? driver.name : driver.fromName;
  return name?.trim() || "Someone else";
}

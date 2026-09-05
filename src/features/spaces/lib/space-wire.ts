/**
 * The Spaces wire codec — a byte-for-byte port of the server contract
 * (`packages/contracts/src/space.ts`) and the web client's awareness module
 * (`apps/web/src/lib/space-awareness.ts`).
 *
 * The server relays these bytes without parsing them, so nothing anywhere
 * enforces that this file and the web client agree — they converge only by
 * discipline. Every constant and algorithm here is copied from the web
 * implementation, most critically `actorColour`: the same person must render
 * in the same colour on both clients, and the colour is derived, never sent.
 */

// ---------------------------------------------------------------------------
// Binary frames: [u8 type][u8 slot][payload]
// ---------------------------------------------------------------------------

/** An opaque CRDT update for one page. */
export const SPACE_FRAME_UPDATE = 0x01;
/** One actor's opaque awareness state (out) / a coalesced fanout (in). */
export const SPACE_FRAME_AWARENESS = 0x02;

export const SPACE_FRAME_HEADER_BYTES = 2;
const SPACE_BATCH_LENGTH_BYTES = 4;
const SPACE_ACTOR_LENGTH_BYTES = 1;

// Limits, verbatim from the contract. Client-side clamping is the only guard
// for name/selection — the server bounds payload bytes, not fields.
export const SPACE_UPDATE_MAX_BYTES = 128 * 1024;
export const SPACE_AWARENESS_MAX_BYTES = 16 * 1024;
export const SPACE_FLUSH_TICK_MS = 50;
export const SPACE_ACTOR_NAME_MAX = 64;
export const SPACE_ACTOR_SELECTION_MAX = 64;
export const SPACE_PAGE_NAME_MAX = 200;
export const SPACE_PAGE_ICON_MAX = 16;
export const SPACE_PAGE_MAX = 200;
export const SPACE_PAGE_DEPTH_MAX = 8;
export const SPACE_PROTOCOL_VERSION = 1;
export const SPACE_DOC_VERSION = 1;
/** Web parity: collapse held offline updates past this many. */
export const HELD_MERGE_AT = 64;

export interface SpaceFrame {
  type: number;
  slot: number;
  payload: Uint8Array;
}

/** Two bytes of header, payload verbatim — never inspected here. */
export function encodeSpaceFrame(type: number, slot: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(SPACE_FRAME_HEADER_BYTES + payload.length);
  frame[0] = type & 0xff;
  frame[1] = slot & 0xff;
  frame.set(payload, SPACE_FRAME_HEADER_BYTES);
  return frame;
}

/**
 * Read a binary frame, or `null` if it is not one. A frame carrying a header
 * and nothing else is refused too — an empty payload is a client bug by
 * contract, not a degenerate update.
 */
export function decodeSpaceFrame(frame: ArrayBuffer | Uint8Array): SpaceFrame | null {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.length <= SPACE_FRAME_HEADER_BYTES) return null;
  return { type: bytes[0], slot: bytes[1], payload: bytes.subarray(SPACE_FRAME_HEADER_BYTES) };
}

/**
 * Unpack a server update batch — `u32 BE length ‖ bytes`, repeated — or
 * `null` if the lengths do not add up. All-or-nothing: half a CRDT update
 * applied is worse than none.
 */
export function decodeSpaceUpdates(payload: Uint8Array): Uint8Array[] | null {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const updates: Uint8Array[] = [];
  let at = 0;
  while (at < payload.length) {
    if (at + SPACE_BATCH_LENGTH_BYTES > payload.length) return null;
    const length = view.getUint32(at);
    at += SPACE_BATCH_LENGTH_BYTES;
    if (length === 0 || at + length > payload.length) return null;
    updates.push(payload.subarray(at, at + length));
    at += length;
  }
  return updates.length > 0 ? updates : null;
}

// ---------------------------------------------------------------------------
// Awareness
// ---------------------------------------------------------------------------

export interface ActorCursor {
  x: number;
  y: number;
}

export interface ActorViewport {
  x: number;
  y: number;
  zoom: number;
}

/** The bespoke JSON state both clients agree on. Every field optional. */
export interface SpaceAwarenessState {
  name?: string;
  colour?: string;
  cursor?: ActorCursor | null;
  selection?: string[];
  viewport?: ActorViewport | null;
  following?: string | null;
}

/** One other person on this page, as the canvas draws them. */
export interface SpaceActor {
  id: string;
  name: string;
  colour: string;
  cursor: ActorCursor | null;
  selection: readonly string[];
  viewport: ActorViewport | null;
  following: string | null;
}

export interface SpaceAwarenessEntry {
  /** Who — stamped by the server, never taken from what a client sent. */
  actor: string;
  /** Their opaque state, or **empty for an actor who is gone**. */
  state: Uint8Array;
}

const UTF8_ENCODE = new TextEncoder();
const UTF8_DECODE = new TextDecoder();

/**
 * Unpack a coalesced awareness fanout —
 * `[u8 actorLen][actor][u32 stateLen][state]`, repeated — or `null` if the
 * lengths do not add up. A zero-length actor id means the frame lost sync
 * with its own lengths; a zero-length *state* is a departure and is valid.
 */
export function decodeSpaceAwareness(payload: Uint8Array): SpaceAwarenessEntry[] | null {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const entries: SpaceAwarenessEntry[] = [];
  let at = 0;
  while (at < payload.length) {
    const actorLength = payload[at];
    at += SPACE_ACTOR_LENGTH_BYTES;
    if (actorLength === 0 || at + actorLength > payload.length) return null;
    const actor = UTF8_DECODE.decode(payload.subarray(at, at + actorLength));
    at += actorLength;
    if (at + SPACE_BATCH_LENGTH_BYTES > payload.length) return null;
    const stateLength = view.getUint32(at);
    at += SPACE_BATCH_LENGTH_BYTES;
    if (at + stateLength > payload.length) return null;
    entries.push({ actor, state: payload.subarray(at, at + stateLength) });
    at += stateLength;
  }
  return entries.length > 0 ? entries : null;
}

export function encodeSpaceAwarenessState(state: SpaceAwarenessState): Uint8Array {
  return UTF8_ENCODE.encode(JSON.stringify(state));
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Read a state, or `null` if it is not one. Parsed rather than cast — these
 * bytes came from another client, and an unparsed viewport would reach
 * `@xyflow/react` as `NaN` and fail there instead of here.
 */
export function decodeSpaceAwarenessState(state: Uint8Array): SpaceAwarenessState | null {
  if (state.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8_DECODE.decode(state));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const raw = parsed as Record<string, unknown>;
  const out: SpaceAwarenessState = {};
  if (typeof raw.name === "string") out.name = raw.name.slice(0, SPACE_ACTOR_NAME_MAX);
  if (typeof raw.colour === "string") out.colour = raw.colour.slice(0, 32);
  if (raw.cursor === null) out.cursor = null;
  else if (
    typeof raw.cursor === "object" &&
    raw.cursor !== null &&
    isFiniteNumber((raw.cursor as { x: unknown }).x) &&
    isFiniteNumber((raw.cursor as { y: unknown }).y)
  ) {
    out.cursor = { x: (raw.cursor as ActorCursor).x, y: (raw.cursor as ActorCursor).y };
  }
  if (Array.isArray(raw.selection)) {
    out.selection = raw.selection
      .filter((v): v is string => typeof v === "string")
      .slice(0, SPACE_ACTOR_SELECTION_MAX);
  }
  if (raw.viewport === null) out.viewport = null;
  else if (
    typeof raw.viewport === "object" &&
    raw.viewport !== null &&
    isFiniteNumber((raw.viewport as { x: unknown }).x) &&
    isFiniteNumber((raw.viewport as { y: unknown }).y) &&
    isFiniteNumber((raw.viewport as { zoom: unknown }).zoom)
  ) {
    const v = raw.viewport as ActorViewport;
    out.viewport = { x: v.x, y: v.y, zoom: v.zoom };
  }
  if (raw.following === null) out.following = null;
  else if (typeof raw.following === "string") out.following = raw.following;
  return out;
}

// ---------------------------------------------------------------------------
// Actor identity: colour and fallback name — MUST match the web client
// ---------------------------------------------------------------------------

/** The web client's exact list, in its exact order. Do not reorder. */
export const ACTOR_COLOURS: readonly string[] = [
  "#e11d48",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0891b2",
  "#2563eb",
  "#7c3aed",
  "#db2777",
];

/**
 * FNV-1a over the id, mod 8 — the web's `actorColour`, verbatim. Derived
 * rather than assigned, so two clients agree without a round trip; a
 * divergence renders one person in two colours.
 */
export function actorColour(id: string): string {
  let hash = 0x811c9dc5;
  for (let at = 0; at < id.length; at += 1) {
    hash ^= id.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ACTOR_COLOURS[hash % ACTOR_COLOURS.length];
}

/** A readable stand-in for somebody whose client sent no name. */
export function actorFallbackName(id: string): string {
  const tail = id.split("_").pop() ?? id;
  return tail.length > 8 ? `${tail.slice(0, 8)}…` : tail;
}

/**
 * Fold one decoded awareness fanout into the roster. Returns a NEW map when
 * anything changed (React sees the reference), the SAME map when nothing did.
 * An empty state removes the actor; an undecodable one keeps them as-is.
 */
export function applyAwareness(
  actors: ReadonlyMap<string, SpaceActor>,
  payload: Uint8Array,
): ReadonlyMap<string, SpaceActor> {
  const entries = decodeSpaceAwareness(payload);
  if (entries === null) return actors;
  const next = new Map(actors);
  for (const entry of entries) {
    if (entry.state.length === 0) {
      next.delete(entry.actor);
      continue;
    }
    const state = decodeSpaceAwarenessState(entry.state);
    if (state === null) continue;
    next.set(entry.actor, {
      id: entry.actor,
      name: state.name?.trim() || actorFallbackName(entry.actor),
      colour: state.colour ?? actorColour(entry.actor),
      cursor: state.cursor ?? null,
      selection: state.selection ?? [],
      viewport: state.viewport ?? null,
      following: state.following ?? null,
    });
  }
  return next;
}

/** Did this frame introduce somebody the roster had not seen? Awareness is
 *  never replayed, so everybody answers a newcomer with one state of their
 *  own — terminates in two rounds. A departure is not an arrival. */
export function hasNewcomer(
  before: ReadonlyMap<string, SpaceActor>,
  after: ReadonlyMap<string, SpaceActor>,
): boolean {
  for (const id of after.keys()) if (!before.has(id)) return true;
  return false;
}

/** Trim a state to what the contract publishes — the client is the ONLY
 *  guard; the server bounds payload bytes, not what is inside them. */
export function clampAwareness(state: SpaceAwarenessState): SpaceAwarenessState {
  const clamped: SpaceAwarenessState = { ...state };
  if (clamped.name !== undefined) clamped.name = clamped.name.slice(0, SPACE_ACTOR_NAME_MAX);
  if (clamped.selection !== undefined) {
    clamped.selection = clamped.selection.slice(0, SPACE_ACTOR_SELECTION_MAX);
  }
  return clamped;
}

/** Which node is outlined in whose colour. First claimant wins — any rule
 *  works as long as both clients pick the same one. */
export function selectionColours(actors: ReadonlyMap<string, SpaceActor>): Map<string, string> {
  const colours = new Map<string, string>();
  for (const actor of actors.values()) {
    for (const nodeId of actor.selection) {
      if (!colours.has(nodeId)) colours.set(nodeId, actor.colour);
    }
  }
  return colours;
}

/** Frame this client's own state for a slot. */
export function frameAwareness(slot: number, state: SpaceAwarenessState): Uint8Array {
  return encodeSpaceFrame(
    SPACE_FRAME_AWARENESS,
    slot,
    encodeSpaceAwarenessState(clampAwareness(state)),
  );
}

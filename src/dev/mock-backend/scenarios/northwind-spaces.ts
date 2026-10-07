// The `northwind` scenario's realtime Spaces: every conversation's Space, held
// as REAL Yjs documents on a fake server, so what Uzayer draws survives a
// close and reopen, and Zuhayer's edits reach the canvas the way the Space
// relays a peer's — a CRDT update applied to the server's document and fanned
// out on the page's slot.
//
// Why not `fixtures/spaces.ts`: that one is the Acme board — a seeded,
// read-mostly page set whose envelope names `MOCK_ORG_ID`. Here every Space
// starts the way the server creates one (lazily, on the first summary) with a
// single blank page called "Canvas" (`SPACE_DEFAULT_PAGE_NAME` in the server
// contract), and every envelope names Northwind's server org.
//
// The protocol is the server's, reduced to one client: per-socket slots are
// positions in an append-only page list (re-opening a page keeps its slot,
// reconnecting starts a new list); a client update is applied to the page's
// server doc and never echoed back; a relayed update is a `u32 BE length ‖
// bytes` batch; an awareness fanout is `[u8 actorLen][actor][u32 len][state]`.
//
// The cue helpers at the bottom (`zuhayerJoinsSpace`, `zuhayerMovesNote`) are
// what the coordinator binds to keys during a take (video 5, beat 3).

import { emit } from "@tauri-apps/api/event";
import * as Y from "yjs";

import { fromBase64, toBase64 } from "@/features/comms/lib/draft-sync";
import { nodesMap, readNodes, type SpaceNodeView } from "@/features/spaces/lib/space-doc";
import {
  decodeSpaceAwarenessState,
  decodeSpaceFrame,
  encodeSpaceAwarenessState,
  encodeSpaceFrame,
  SPACE_FRAME_AWARENESS,
  SPACE_FRAME_UPDATE,
  type ActorCursor,
  type ActorViewport,
  type SpaceAwarenessState,
} from "@/features/spaces/lib/space-wire";
import type {
  SpaceClientMessage,
  SpaceEnvelope,
  SpacePage,
  SpaceServerMessage,
  SpaceSummary,
} from "@/features/spaces/lib/spaces-api";
import type { MockResponses, TypedHandlers } from "../types";
import { CONV_ID } from "./northwind-comms";
import { ORG_REMOTE_ID, PEOPLE } from "./northwind-world";

// ── ids ───────────────────────────────────────────────────────────────────

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID, as the server mints page and Space ids. */
function ulid(at = Date.now()): string {
  let time = "";
  let t = at;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = "";
  for (let i = 0; i < 16; i += 1) rand += CROCKFORD[Math.floor(Math.random() * 32)];
  return time + rand;
}

/** The server contract's names for what it creates unasked. */
const DEFAULT_PAGE_NAME = "Canvas";
const UNTITLED_PAGE_NAME = "Untitled";
const UNTITLED_FOLDER_NAME = "New folder";

// ── the server's state ────────────────────────────────────────────────────

interface ServerSpace {
  spaceId: string;
  convId: string;
  pages: SpacePage[];
  activePageId: string | null;
  /** One document per page — the CRDT the server stores and replays. */
  docs: Map<string, Y.Doc>;
  /** Updates applied per page: the `index` a `page.opened` reports. */
  index: Map<string, number>;
}

/** The ONE socket this window has per conversation. */
interface ServerSocket {
  open: boolean;
  /** Append-only; a page's position is its slot. */
  slots: string[];
  /** The page the canvas is showing (`page.active`). */
  activePageId: string | null;
  /** Uzayer's own last awareness, as his client published it. */
  mine: SpaceAwarenessState;
}

const spaces = new Map<string, ServerSpace>();
const sockets = new Map<string, ServerSocket>();

/** Lazily created on the first summary, as the server does, with one page. */
function spaceFor(convId: string): ServerSpace {
  let space = spaces.get(convId);
  if (space) return space;
  const now = Date.now();
  const page: SpacePage = {
    id: ulid(now),
    kind: "page",
    name: DEFAULT_PAGE_NAME,
    icon: null,
    parent_id: null,
    sort: 0,
    created_at: now,
    updated_at: now,
  };
  space = {
    spaceId: ulid(now),
    convId,
    pages: [page],
    activePageId: page.id,
    docs: new Map(),
    index: new Map(),
  };
  spaces.set(convId, space);
  return space;
}

function docFor(space: ServerSpace, pageId: string): Y.Doc {
  let doc = space.docs.get(pageId);
  if (!doc) {
    doc = new Y.Doc();
    space.docs.set(pageId, doc);
  }
  return doc;
}

function summaryFor(convId: string): SpaceSummary {
  const space = spaceFor(convId);
  return {
    protocol: 1,
    doc_version: 1,
    space_id: space.spaceId,
    conv_id: convId,
    pages: space.pages,
    active_page_id: space.activePageId,
    archived: false,
  };
}

// ── the wire ──────────────────────────────────────────────────────────────

function send(convId: string, ev: SpaceEnvelope["ev"]): void {
  void emit("atlas:spaces", { org: ORG_REMOTE_ID, conv: convId, ev } satisfies SpaceEnvelope);
}

const control = (convId: string, message: SpaceServerMessage): void =>
  send(convId, { kind: "control", frame: JSON.stringify(message) });

const binary = (convId: string, frame: Uint8Array): void =>
  send(convId, { kind: "binary", data: toBase64(frame) });

/** A relayed batch: `u32 BE length ‖ bytes`, repeated. */
function relayFrame(slot: number, updates: Uint8Array[]): Uint8Array {
  const size = updates.reduce((sum, u) => sum + 4 + u.length, 0);
  const payload = new Uint8Array(size);
  const view = new DataView(payload.buffer);
  let at = 0;
  for (const update of updates) {
    view.setUint32(at, update.length);
    at += 4;
    payload.set(update, at);
    at += update.length;
  }
  return encodeSpaceFrame(SPACE_FRAME_UPDATE, slot, payload);
}

/** A coalesced awareness fanout; an empty state is a departure. */
function awarenessFrame(slot: number, entries: { actor: string; state: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts = entries.map((e) => ({ actor: encoder.encode(e.actor), state: e.state }));
  const size = parts.reduce((sum, p) => sum + 1 + p.actor.length + 4 + p.state.length, 0);
  const payload = new Uint8Array(size);
  const view = new DataView(payload.buffer);
  let at = 0;
  for (const part of parts) {
    payload[at] = part.actor.length;
    at += 1;
    payload.set(part.actor, at);
    at += part.actor.length;
    view.setUint32(at, part.state.length);
    at += 4;
    payload.set(part.state, at);
    at += part.state.length;
  }
  return encodeSpaceFrame(SPACE_FRAME_AWARENESS, slot, payload);
}

/** Dial: `connecting`, then `open` and the hello, as a real socket delivers
 *  them. Delayed so the bus subscription (a separate effect) is up. A dial
 *  is a NEW socket — its slot list starts empty. */
function openSocket(convId: string): void {
  const previous = sockets.get(convId);
  sockets.set(convId, {
    open: false,
    slots: [],
    activePageId: previous?.activePageId ?? null,
    mine: previous?.mine ?? {},
  });
  send(convId, { kind: "connection", state: "connecting" });
  setTimeout(() => {
    const socket = sockets.get(convId);
    if (!socket) return;
    socket.open = true;
    send(convId, { kind: "connection", state: "open" });
    control(convId, { t: "space.hello", ...summaryFor(convId) });
  }, 120);
}

function parseClientMessage(frame: string): SpaceClientMessage | null {
  try {
    return JSON.parse(frame) as SpaceClientMessage;
  } catch {
    return null;
  }
}

function broadcastTree(convId: string): void {
  control(convId, { t: "page.tree", pages: spaceFor(convId).pages });
}

/** Re-number one parent's children densely, in their current order. */
function resort(space: ServerSpace, parentId: string | null): void {
  space.pages
    .filter((p) => p.parent_id === parentId)
    .sort((a, b) => a.sort - b.sort)
    .forEach((p, i) => {
      p.sort = i;
    });
}

/** Depth-first, parents before children — the order the summary promises. */
function ordered(pages: SpacePage[]): SpacePage[] {
  const out: SpacePage[] = [];
  const walk = (parent: string | null) => {
    for (const p of pages.filter((q) => q.parent_id === parent).sort((a, b) => a.sort - b.sort)) {
      out.push(p);
      walk(p.id);
    }
  };
  walk(null);
  return out;
}

function handleControl(convId: string, message: SpaceClientMessage): void {
  const space = spaceFor(convId);
  const socket = sockets.get(convId);
  switch (message.t) {
    case "page.open": {
      if (!socket?.open) return;
      const page = space.pages.find((p) => p.id === message.page_id && p.kind === "page");
      if (!page) {
        control(convId, {
          t: "error",
          error: { code: "not_found", message: "That page does not exist." },
        });
        return;
      }
      let slot = socket.slots.indexOf(page.id);
      if (slot < 0) {
        slot = socket.slots.length;
        socket.slots.push(page.id);
      }
      const doc = docFor(space, page.id);
      const index = space.index.get(page.id) ?? 0;
      setTimeout(() => {
        control(convId, {
          t: "page.opened",
          page_id: page.id,
          slot,
          resume: message.since !== undefined,
          // An unwritten page has no snapshot at all; a written one is the
          // whole state (the CRDT absorbs any overlap with a resume).
          snapshot: index === 0 ? null : toBase64(Y.encodeStateAsUpdate(doc)),
          index,
          updates: [],
          read_only: null,
        });
        // Awareness is never replayed: anybody already on the page answers
        // the newcomer with a state of their own.
        if (zuhayer.joined && zuhayer.pageId === page.id) {
          setTimeout(() => announceZuhayer(convId), 150);
        }
      }, 60);
      return;
    }
    case "page.active": {
      if (socket) socket.activePageId = message.page_id;
      space.activePageId = message.page_id;
      return;
    }
    case "page.create": {
      const now = Date.now();
      const kind = message.kind ?? "page";
      const parentId = message.parent_id ?? null;
      const id = ulid(now);
      space.pages.push({
        id,
        kind,
        name: message.name ?? (kind === "folder" ? UNTITLED_FOLDER_NAME : UNTITLED_PAGE_NAME),
        icon: message.icon ?? null,
        parent_id: parentId,
        sort: space.pages.filter((p) => p.parent_id === parentId).length,
        created_at: now,
        updated_at: now,
      });
      space.pages = ordered(space.pages);
      setTimeout(() => {
        control(convId, { t: "page.created", page_id: id });
        broadcastTree(convId);
      }, 80);
      return;
    }
    case "page.rename": {
      const page = space.pages.find((p) => p.id === message.page_id);
      if (page) {
        if (message.name !== undefined) page.name = message.name;
        if (message.icon !== undefined) page.icon = message.icon;
        page.updated_at = Date.now();
      }
      setTimeout(() => broadcastTree(convId), 80);
      return;
    }
    case "page.move": {
      const page = space.pages.find((p) => p.id === message.page_id);
      if (page) {
        const from = page.parent_id;
        page.parent_id = message.parent_id;
        // Slot it in just before whatever sits at `index` among its new siblings.
        page.sort = message.index - 0.5;
        resort(space, from);
        resort(space, message.parent_id);
        space.pages = ordered(space.pages);
      }
      setTimeout(() => broadcastTree(convId), 80);
      return;
    }
    case "page.delete": {
      const doomed = new Set<string>([message.page_id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const p of space.pages) {
          if (p.parent_id !== null && doomed.has(p.parent_id) && !doomed.has(p.id)) {
            doomed.add(p.id);
            grew = true;
          }
        }
      }
      const left = space.pages.filter((p) => !doomed.has(p.id));
      if (!left.some((p) => p.kind === "page")) {
        // The last-page rule: a Space always has something to render.
        setTimeout(
          () =>
            control(convId, {
              t: "error",
              error: { code: "conflict", message: "A Space keeps at least one page." },
            }),
          80,
        );
        return;
      }
      const parent = space.pages.find((p) => p.id === message.page_id)?.parent_id ?? null;
      space.pages = left;
      resort(space, parent);
      space.pages = ordered(space.pages);
      for (const id of doomed) {
        space.docs.delete(id);
        space.index.delete(id);
        if (space.activePageId === id) space.activePageId = null;
      }
      setTimeout(() => {
        const slots = sockets.get(convId)?.slots ?? [];
        slots.forEach((pageId, slot) => {
          if (doomed.has(pageId)) {
            control(convId, { t: "page.closed", page_id: pageId, slot, reason: "deleted" });
          }
        });
        broadcastTree(convId);
      }, 80);
      return;
    }
  }
}

/** A client binary frame: an update is applied to the page's server doc (and
 *  relayed to nobody — there is no second client but the scripted one); an
 *  awareness state is remembered, because Zuhayer's camera starts from it. */
function handleBinary(convId: string, data: string): void {
  const socket = sockets.get(convId);
  if (!socket?.open) return;
  const bytes = fromBase64(data);
  if (bytes === null) return;
  const frame = decodeSpaceFrame(bytes);
  if (frame === null) return;
  const pageId = socket.slots[frame.slot];
  if (pageId === undefined) return;
  if (frame.type === SPACE_FRAME_UPDATE) {
    const space = spaceFor(convId);
    try {
      Y.applyUpdate(docFor(space, pageId), frame.payload, "client");
      space.index.set(pageId, (space.index.get(pageId) ?? 0) + 1);
    } catch (e) {
      console.warn("northwind spaces: dropped a malformed client update:", e);
    }
  } else if (frame.type === SPACE_FRAME_AWARENESS) {
    const state = decodeSpaceAwarenessState(frame.payload);
    if (state) socket.mine = { ...socket.mine, ...state };
  }
}

// ── handlers ──────────────────────────────────────────────────────────────

/** Every `spaces_*` command that carries a conversation's Space. Media
 *  (`spaces_media_upload` / `spaces_media_fetch`) has no org in it and is
 *  left to the base fixture. */
export const northwindSpacesCommands: Partial<TypedHandlers<MockResponses>> = {
  spaces_summary: ({ convId }): SpaceSummary => summaryFor(String(convId)),
  spaces_connect: ({ convId }): null => {
    openSocket(String(convId));
    return null;
  },
  spaces_disconnect: ({ convId }): null => {
    const conv = String(convId);
    const socket = sockets.get(conv);
    if (socket) {
      socket.open = false;
      socket.slots = [];
    }
    send(conv, { kind: "connection", state: "disconnected" });
    return null;
  },
  spaces_cycle: ({ convId }): null => {
    const conv = String(convId);
    const socket = sockets.get(conv);
    if (socket) socket.open = false;
    send(conv, { kind: "connection", state: "backoff" });
    setTimeout(() => openSocket(conv), 200);
    return null;
  },
  spaces_send_control: ({ convId, frame }): null => {
    const message = parseClientMessage(String(frame));
    if (message) handleControl(String(convId), message);
    return null;
  },
  spaces_send_binary: ({ convId, data }): null => {
    handleBinary(String(convId), String(data));
    return null;
  },
};

// ── Zuhayer, the scripted second client ───────────────────────────────────

const ZUHAYER = PEOPLE.zuhayer;
const TICK_MS = 50;
const HEARTBEAT_MS = 5_000;

const zuhayer: {
  joined: boolean;
  convId: string | null;
  pageId: string | null;
  /** His own replica — edits are made here, then go to the server as updates. */
  doc: Y.Doc | null;
  state: SpaceAwarenessState;
  heartbeat: ReturnType<typeof setInterval> | null;
  /** Bumped by each new gesture so an older one stops moving the cursor. */
  gesture: number;
} = {
  joined: false,
  convId: null,
  pageId: null,
  doc: null,
  state: {},
  heartbeat: null,
  gesture: 0,
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** The open canvas's slot on `convId`, or `null` when the Space is not open. */
function liveSlot(convId: string): { slot: number; pageId: string } | null {
  const socket = sockets.get(convId);
  if (!socket?.open || socket.activePageId === null) return null;
  const slot = socket.slots.indexOf(socket.activePageId);
  return slot < 0 ? null : { slot, pageId: socket.activePageId };
}

function announceZuhayer(convId: string): void {
  const live = liveSlot(convId);
  if (!live || live.pageId !== zuhayer.pageId) return;
  binary(
    convId,
    awarenessFrame(live.slot, [
      { actor: ZUHAYER.userId, state: encodeSpaceAwarenessState(zuhayer.state) },
    ]),
  );
}

function setZuhayer(patch: Partial<SpaceAwarenessState>): void {
  zuhayer.state = { ...zuhayer.state, ...patch };
  if (zuhayer.convId) announceZuhayer(zuhayer.convId);
}

/** Catch Zuhayer's replica up with the server's copy of the page. */
function syncZuhayer(space: ServerSpace, pageId: string): Y.Doc {
  if (!zuhayer.doc || zuhayer.pageId !== pageId) {
    zuhayer.doc?.destroy();
    zuhayer.doc = new Y.Doc();
  }
  const server = docFor(space, pageId);
  Y.applyUpdate(
    zuhayer.doc,
    Y.encodeStateAsUpdate(server, Y.encodeStateVector(zuhayer.doc)),
    "server",
  );
  return zuhayer.doc;
}

/** The pane's size in screen pixels, for framing a camera. */
function paneSize(): { width: number; height: number } {
  const pane = typeof document === "undefined" ? null : document.querySelector(".react-flow");
  const rect = pane?.getBoundingClientRect();
  return rect && rect.width > 0
    ? { width: rect.width, height: rect.height }
    : { width: 1100, height: 700 };
}

function bounds(nodes: SpaceNodeView[]): { cx: number; cy: number } {
  if (nodes.length === 0) return { cx: 0, cy: 0 };
  const left = Math.min(...nodes.map((n) => n.x));
  const top = Math.min(...nodes.map((n) => n.y));
  const right = Math.max(...nodes.map((n) => n.x + n.width));
  const bottom = Math.max(...nodes.map((n) => n.y + n.height));
  return { cx: (left + right) / 2, cy: (top + bottom) / 2 };
}

/** Where Zuhayer is looking: the board's middle, at Uzayer's zoom — what a
 *  fit-ish first look at the same board gives somebody on another screen. */
function zuhayerViewport(convId: string, nodes: SpaceNodeView[]): ActorViewport {
  const mine = sockets.get(convId)?.mine.viewport ?? null;
  if (nodes.length === 0 && mine) return { x: mine.x - 40, y: mine.y - 24, zoom: mine.zoom };
  const zoom = Math.min(1.1, Math.max(0.7, mine?.zoom ?? 1));
  const { width, height } = paneSize();
  const { cx, cy } = bounds(nodes);
  return { x: width / 2 - cx * zoom + 36, y: height / 2 - cy * zoom + 20, zoom };
}

/** Glide the cursor from where it is to `to`, a frame per server tick. */
async function glideCursor(to: ActorCursor, ms: number, gesture: number): Promise<void> {
  const from = zuhayer.state.cursor ?? to;
  const steps = Math.max(1, Math.round(ms / TICK_MS));
  for (let i = 1; i <= steps; i += 1) {
    if (zuhayer.gesture !== gesture) return;
    const t = ease(i / steps);
    setZuhayer({ cursor: { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t } });
    await sleep(TICK_MS);
  }
}

function spaceIsOpen(convId: string, cue: string): { slot: number; pageId: string } | null {
  const live = liveSlot(convId);
  if (!live) {
    console.warn(`northwind: ${cue} — the Space for ${convId} is not open yet; nothing happened.`);
  }
  return live;
}

/**
 * Zuhayer opens the same Space: his avatar joins the presence pill, his
 * cursor appears on the board and wanders a little, and a heartbeat restates
 * his state so he never reads as gone. His awareness carries a viewport, which
 * is what clicking his avatar (follow) rides.
 */
export function zuhayerJoinsSpace(convId: string = CONV_ID.shop): void {
  const live = spaceIsOpen(convId, "zuhayerJoinsSpace");
  if (!live) return;
  const space = spaceFor(convId);
  const doc = syncZuhayer(space, live.pageId);
  const nodes = readNodes(doc);
  const { cx, cy } = bounds(nodes);

  const fresh = !zuhayer.joined || zuhayer.convId !== convId || zuhayer.pageId !== live.pageId;
  zuhayer.joined = true;
  zuhayer.convId = convId;
  zuhayer.pageId = live.pageId;
  if (fresh) {
    zuhayer.state = {
      name: ZUHAYER.name,
      cursor: { x: cx + 180, y: cy + 140 },
      selection: [],
      viewport: zuhayerViewport(convId, nodes),
      following: null,
    };
    announceZuhayer(convId);
  }

  if (zuhayer.heartbeat === null) {
    zuhayer.heartbeat = setInterval(() => {
      if (zuhayer.convId) announceZuhayer(zuhayer.convId);
    }, HEARTBEAT_MS);
  }

  // A short look around the board before he does anything.
  const gesture = ++zuhayer.gesture;
  void (async () => {
    await sleep(300);
    for (const [dx, dy, ms] of [
      [90, 60, 700],
      [-40, 110, 600],
      [140, 20, 800],
      [60, 90, 500],
    ] as const) {
      if (zuhayer.gesture !== gesture) return;
      await glideCursor({ x: cx + dx, y: cy + dy }, ms, gesture);
      await sleep(180);
    }
  })();
}

/**
 * Zuhayer drags one of Uzayer's notes — "Pricing service" if it exists, else
 * any note, else any node — a short way, smoothly: his cursor travels to it,
 * selects it, and every tick of the ~1.5s drag is a real Yjs change made on
 * his replica, applied to the server doc and relayed to the canvas. Joins
 * first if he has not.
 */
export async function zuhayerMovesNote(convId: string = CONV_ID.shop): Promise<void> {
  const live = spaceIsOpen(convId, "zuhayerMovesNote");
  if (!live) return;
  if (!zuhayer.joined || zuhayer.convId !== convId || zuhayer.pageId !== live.pageId) {
    zuhayerJoinsSpace(convId);
    await sleep(1_400);
  }
  const space = spaceFor(convId);
  const doc = syncZuhayer(space, live.pageId);
  const nodes = readNodes(doc);
  const target =
    nodes.find((n) => n.kind === "note" && n.title.trim().toLowerCase() === "pricing service") ??
    nodes.find((n) => n.kind === "note") ??
    nodes[0];
  if (!target) {
    console.warn("northwind: zuhayerMovesNote — the page has no node to move.");
    return;
  }

  const gesture = ++zuhayer.gesture;
  // Grab it by its title bar.
  const grab = { dx: Math.min(60, target.width / 3), dy: Math.min(22, target.height / 4) };
  await glideCursor({ x: target.x + grab.dx, y: target.y + grab.dy }, 650, gesture);
  setZuhayer({ selection: [target.id] });
  await sleep(220);

  const from = { x: target.x, y: target.y };
  const to = { x: Math.round(from.x + 140), y: Math.round(from.y + 70) };
  const steps = 30; // 30 × 50ms ≈ 1.5s
  for (let i = 1; i <= steps; i += 1) {
    const now = liveSlot(convId);
    if (!now || now.pageId !== live.pageId) return; // the canvas closed mid-drag
    const t = ease(i / steps);
    const at = {
      x: Math.round(from.x + (to.x - from.x) * t),
      y: Math.round(from.y + (to.y - from.y) * t),
    };

    const replica = syncZuhayer(space, live.pageId);
    const node = nodesMap(replica).get(target.id);
    if (!node) return; // deleted under him
    const before = Y.encodeStateVector(replica);
    replica.transact(() => {
      node.set("x", at.x);
      node.set("y", at.y);
    }, "zuhayer");
    const update = Y.encodeStateAsUpdate(replica, before);
    Y.applyUpdate(docFor(space, live.pageId), update, "zuhayer");
    space.index.set(live.pageId, (space.index.get(live.pageId) ?? 0) + 1);
    binary(convId, relayFrame(now.slot, [update]));

    setZuhayer({ cursor: { x: at.x + grab.dx, y: at.y + grab.dy } });
    await sleep(TICK_MS);
  }

  // Let go, linger, and drift off a little.
  await sleep(500);
  setZuhayer({ selection: [] });
  await glideCursor({ x: to.x + grab.dx + 120, y: to.y + grab.dy + 80 }, 700, gesture);
}

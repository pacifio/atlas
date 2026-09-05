/**
 * The Spaces document — a faithful port of the web client's
 * `apps/web/src/lib/space.ts`. The CRDT runs in the clients and the server
 * never sees inside it, so this shape is a contract nothing can enforce:
 * if this file and the web client diverge they corrupt each other silently.
 *
 * The two rules that would be invisible if broken are enforced by the
 * functions here rather than left to call sites:
 *  - ids are client-generated and **never renumbered** (edges name node ids);
 *  - deleting a node deletes its edges, **client-side, in one transaction**
 *    (the server holds no referential integrity).
 */
import * as Y from "yjs";

import { fromBase64 } from "@/features/comms/lib/draft-sync";
import { decodeSpaceUpdates, encodeSpaceFrame, SPACE_FRAME_UPDATE } from "./space-wire";

/** The two root maps, keyed by client-generated id. Maps, not arrays. */
export const SPACE_DOC_NODES = "nodes";
export const SPACE_DOC_EDGES = "edges";

/**
 * Origin markers. `doc.on("update")` fires for local and remote edits alike;
 * without the marker a client would relay every update it just received
 * straight back. Strings (not Symbols) for web parity — they also scope undo.
 */
export const REMOTE = "remote";
export const LOCAL = "local";

export type SpaceNodeKind = "note" | "text" | "shape" | "media" | "group";
export type SpaceShapeType = "rectangle" | "ellipse" | "diamond" | "triangle";
export type SpaceMediaKind = "image" | "video";
export type SpaceAnchor = "n" | "e" | "s" | "w";

const NODE_KINDS: readonly string[] = ["note", "text", "shape", "media", "group"];
const SHAPE_TYPES: readonly string[] = ["rectangle", "ellipse", "diamond", "triangle"];
const MEDIA_KINDS: readonly string[] = ["image", "video"];
const ANCHORS: readonly string[] = ["n", "e", "s", "w"];

export const SPACE_NODE_DEFAULT_SIZE = { width: 220, height: 140 };

/** One node, flattened out of the CRDT for rendering. */
export interface SpaceNodeView {
  id: string;
  kind: SpaceNodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  body: string;
  text: string;
  color: string | null;
  shapeType: SpaceShapeType | null;
  mediaKind: SpaceMediaKind | null;
  contentHash: string | null;
  mime: string | null;
}

export interface SpaceEdgeView {
  id: string;
  source: string;
  target: string;
  sourceAnchor: SpaceAnchor;
  targetAnchor: SpaceAnchor;
  text: string;
  color: string | null;
}

export function nodesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(SPACE_DOC_NODES);
}

export function edgesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(SPACE_DOC_EDGES);
}

/** Tolerant of a plain string — unknown-version clients may have written one;
 *  rendering what is there beats rendering nothing. */
function readText(map: Y.Map<unknown>, key: string): string {
  const value = map.get(key);
  if (value instanceof Y.Text) return value.toString();
  return typeof value === "string" ? value : "";
}

function readNumber(map: Y.Map<unknown>, key: string, fallback: number): number {
  const value = map.get(key);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readString(map: Y.Map<unknown>, key: string): string | null {
  const value = map.get(key);
  return typeof value === "string" ? value : null;
}

/** Closed-set fields are parsed, never cast: an unknown `kind` from a newer
 *  client reads as absent (→ fallback) rather than crashing inside xyflow. */
function readEnum<T extends string>(
  allowed: readonly string[],
  map: Y.Map<unknown>,
  key: string,
): T | null {
  const value = map.get(key);
  return typeof value === "string" && allowed.includes(value) ? (value as T) : null;
}

export function readNodes(doc: Y.Doc): SpaceNodeView[] {
  const out: SpaceNodeView[] = [];
  for (const [id, node] of nodesMap(doc)) {
    out.push({
      id,
      kind: readEnum<SpaceNodeKind>(NODE_KINDS, node, "kind") ?? "note",
      x: readNumber(node, "x", 0),
      y: readNumber(node, "y", 0),
      width: readNumber(node, "width", SPACE_NODE_DEFAULT_SIZE.width),
      height: readNumber(node, "height", SPACE_NODE_DEFAULT_SIZE.height),
      title: readText(node, "title"),
      body: readText(node, "body"),
      text: readText(node, "text"),
      color: readString(node, "color"),
      shapeType: readEnum<SpaceShapeType>(SHAPE_TYPES, node, "shape_type"),
      mediaKind: readEnum<SpaceMediaKind>(MEDIA_KINDS, node, "media_kind"),
      contentHash: readString(node, "content_hash"),
      mime: readString(node, "mime"),
    });
  }
  return out;
}

export function readEdges(doc: Y.Doc): SpaceEdgeView[] {
  const out: SpaceEdgeView[] = [];
  for (const [id, edge] of edgesMap(doc)) {
    const source = readString(edge, "source");
    const target = readString(edge, "target");
    // An endpoint-less edge is unrenderable; a convergent doc mid-edit is
    // better off skipping it than throwing inside a render.
    if (!source || !target) continue;
    out.push({
      id,
      source,
      target,
      sourceAnchor: readEnum<SpaceAnchor>(ANCHORS, edge, "source_anchor") ?? "e",
      targetAnchor: readEnum<SpaceAnchor>(ANCHORS, edge, "target_anchor") ?? "w",
      text: readText(edge, "text"),
      color: readString(edge, "color"),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export function spaceId(): string {
  return crypto.randomUUID();
}

export interface NewNode {
  id?: string;
  kind: SpaceNodeKind;
  x: number;
  y: number;
  width?: number;
  height?: number;
  title?: string;
  body?: string;
  text?: string;
  color?: string;
  shapeType?: SpaceShapeType;
  mediaKind?: SpaceMediaKind;
  contentHash?: string;
  mime?: string;
}

/**
 * Add a node in one transaction. Geometry and enums are plain LWW-per-field
 * values (right for a drag, and per-field keeps a concurrent retitle);
 * prose is `Y.Text`, always set — all three fields, even empty (web parity).
 */
export function addNode(doc: Y.Doc, node: NewNode): string {
  const id = node.id ?? spaceId();
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    map.set("kind", node.kind);
    map.set("x", node.x);
    map.set("y", node.y);
    map.set("width", node.width ?? SPACE_NODE_DEFAULT_SIZE.width);
    map.set("height", node.height ?? SPACE_NODE_DEFAULT_SIZE.height);
    if (node.color) map.set("color", node.color);
    if (node.shapeType) map.set("shape_type", node.shapeType);
    if (node.mediaKind) map.set("media_kind", node.mediaKind);
    // A media node carries the content hash + mime and NOTHING else — no
    // filename, ever: a local path in a shared doc is one machine's disk on
    // everybody's canvas.
    if (node.contentHash) map.set("content_hash", node.contentHash);
    if (node.mime) map.set("mime", node.mime);
    map.set("title", new Y.Text(node.title ?? ""));
    map.set("body", new Y.Text(node.body ?? ""));
    map.set("text", new Y.Text(node.text ?? ""));
    nodesMap(doc).set(id, map);
  }, LOCAL);
  return id;
}

export function moveNode(doc: Y.Doc, id: string, at: { x: number; y: number }): void {
  const node = nodesMap(doc).get(id);
  if (!node) return;
  doc.transact(() => {
    node.set("x", at.x);
    node.set("y", at.y);
  }, LOCAL);
}

export function resizeNode(doc: Y.Doc, id: string, size: { width: number; height: number }): void {
  const node = nodesMap(doc).get(id);
  if (!node) return;
  doc.transact(() => {
    node.set("width", Math.max(40, Math.round(size.width)));
    node.set("height", Math.max(40, Math.round(size.height)));
  }, LOCAL);
}

/** Delete a node AND every edge naming it, in one transaction — peers never
 *  see the moment where the node is gone and its edges are not. */
export function deleteNode(doc: Y.Doc, id: string): void {
  doc.transact(() => {
    nodesMap(doc).delete(id);
    for (const [edgeId, edge] of edgesMap(doc)) {
      if (edge.get("source") === id || edge.get("target") === id) {
        edgesMap(doc).delete(edgeId);
      }
    }
  }, LOCAL);
}

export interface NewEdge {
  id?: string;
  source: string;
  target: string;
  sourceAnchor?: SpaceAnchor;
  targetAnchor?: SpaceAnchor;
  text?: string;
  color?: string;
}

export function addEdge(doc: Y.Doc, edge: NewEdge): string | null {
  const nodes = nodesMap(doc);
  // An edge to a missing node would survive every future deletion — deletion
  // only looks at the edges of the node being removed.
  if (!nodes.has(edge.source) || !nodes.has(edge.target)) return null;
  const id = edge.id ?? spaceId();
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    map.set("source", edge.source);
    map.set("target", edge.target);
    map.set("source_anchor", edge.sourceAnchor ?? "e");
    map.set("target_anchor", edge.targetAnchor ?? "w");
    if (edge.color) map.set("color", edge.color);
    map.set("text", new Y.Text(edge.text ?? ""));
    edgesMap(doc).set(id, map);
  }, LOCAL);
  return id;
}

export function deleteEdge(doc: Y.Doc, id: string): void {
  doc.transact(() => edgesMap(doc).delete(id), LOCAL);
}

export interface Splice {
  index: number;
  remove: number;
  insert: string;
}

/** Narrow a whole-value change to its common-prefix/suffix splice, so two
 *  people typing in one note merge character-wise instead of clobbering. */
export function splice(current: string, next: string): Splice | null {
  if (current === next) return null;
  let prefix = 0;
  const max = Math.min(current.length, next.length);
  while (prefix < max && current[prefix] === next[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < max - prefix &&
    current[current.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return {
    index: prefix,
    remove: current.length - prefix - suffix,
    insert: next.slice(prefix, next.length - suffix),
  };
}

/** Write a prose field as one transaction. A field that is not `Y.Text` yet
 *  (older client wrote a plain string) is upgraded in place, not refused. */
export function writeField(
  doc: Y.Doc,
  map: Y.Map<unknown> | undefined,
  key: string,
  next: string,
): void {
  if (!map) return;
  const current = map.get(key);
  if (!(current instanceof Y.Text)) {
    doc.transact(() => map.set(key, new Y.Text(next)), LOCAL);
    return;
  }
  const change = splice(current.toString(), next);
  if (change === null) return;
  doc.transact(() => {
    if (change.remove > 0) current.delete(change.index, change.remove);
    if (change.insert.length > 0) current.insert(change.index, change.insert);
  }, LOCAL);
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/**
 * Rebuild or continue a page from what `page.opened` carried:
 * `snapshot === null ? updates : [snapshot, ...updates]`, applied REMOTE.
 * (The web client branches on the snapshot too, despite its own docstring —
 * do not "fix" this to branch on `resume`.) Malformed parts are skipped:
 * a gap in a convergent doc is repaired by anybody's next edit.
 */
export function applyPageContent(
  doc: Y.Doc,
  opened: { snapshot: string | null; updates: readonly string[] },
): void {
  const parts = opened.snapshot === null ? opened.updates : [opened.snapshot, ...opened.updates];
  for (const part of parts) {
    const bytes = fromBase64(part);
    if (bytes === null || bytes.length === 0) continue;
    try {
      Y.applyUpdate(doc, bytes, REMOTE);
    } catch (e) {
      console.warn("spaces: skipping malformed page update:", e);
    }
  }
}

/** Apply one relayed frame — a LIST of updates. Refused wholesale when the
 *  lengths do not add up; half a CRDT update applied is worse than none. */
export function applyRelayed(doc: Y.Doc, payload: Uint8Array): boolean {
  const updates = decodeSpaceUpdates(payload);
  if (updates === null) return false;
  for (const update of updates) {
    try {
      Y.applyUpdate(doc, update, REMOTE);
    } catch (e) {
      console.warn("spaces: skipping malformed relayed update:", e);
    }
  }
  return true;
}

/** Frame one of this client's own updates for a slot — the payload is the
 *  BARE update; only the server length-prefixes batches. */
export function frameUpdate(slot: number, update: Uint8Array): Uint8Array {
  return encodeSpaceFrame(SPACE_FRAME_UPDATE, slot, update);
}

/**
 * An undo stack that can only ever reach this person's own edits —
 * `trackedOrigins` is the whole mechanism. Both root maps are tracked, so
 * undoing a node deletion brings its edges back with it.
 */
export function localUndo(doc: Y.Doc): Y.UndoManager {
  return new Y.UndoManager([nodesMap(doc), edgesMap(doc)], {
    trackedOrigins: new Set([LOCAL]),
  });
}

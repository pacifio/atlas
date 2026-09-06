import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { toBase64 } from "@/features/comms/lib/draft-sync";
import {
  addEdge,
  addNode,
  applyPageContent,
  applyRelayed,
  deleteNode,
  edgesMap,
  frameUpdate,
  LOCAL,
  localUndo,
  moveNode,
  nodesMap,
  readEdges,
  readNodes,
  REMOTE,
  resizeNode,
  splice,
  writeField,
} from "./space-doc";
import { decodeSpaceFrame } from "./space-wire";

// The document rules nothing at runtime can enforce — verified here instead.

function connectedPair(): { a: Y.Doc; b: Y.Doc } {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on("update", (u: Uint8Array) => Y.applyUpdate(b, u, REMOTE));
  b.on("update", (u: Uint8Array) => Y.applyUpdate(a, u, REMOTE));
  return { a, b };
}

describe("node lifecycle", () => {
  it("creates all three Y.Text fields even when empty (web parity)", () => {
    const doc = new Y.Doc();
    const id = addNode(doc, { kind: "note", x: 1, y: 2 });
    const node = nodesMap(doc).get(id)!;
    for (const key of ["title", "body", "text"]) {
      expect(node.get(key)).toBeInstanceOf(Y.Text);
    }
    // Optional plain fields are OMITTED when falsy, not written as null.
    expect(node.has("color")).toBe(false);
    expect(node.has("content_hash")).toBe(false);
  });

  it("deleting a node deletes every edge naming it, in one transaction", () => {
    const doc = new Y.Doc();
    const a = addNode(doc, { kind: "note", x: 0, y: 0 });
    const b = addNode(doc, { kind: "note", x: 10, y: 0 });
    const c = addNode(doc, { kind: "note", x: 20, y: 0 });
    addEdge(doc, { source: a, target: b });
    addEdge(doc, { source: b, target: c });
    addEdge(doc, { source: a, target: c });

    let transactions = 0;
    doc.on("afterTransaction", () => (transactions += 1));
    deleteNode(doc, a);

    expect(transactions).toBe(1); // peers never see node-gone-edges-not
    expect(
      readNodes(doc)
        .map((n) => n.id)
        .sort(),
    ).toEqual([b, c].sort());
    expect(readEdges(doc).length).toBe(1); // only b→c survives
  });

  it("refuses an edge to a node that is not there", () => {
    const doc = new Y.Doc();
    const a = addNode(doc, { kind: "note", x: 0, y: 0 });
    expect(addEdge(doc, { source: a, target: "ghost" })).toBeNull();
    expect(readEdges(doc).length).toBe(0);
  });

  it("clamps resize to max(40, round) and defaults anchors e→w", () => {
    const doc = new Y.Doc();
    const a = addNode(doc, { kind: "shape", shapeType: "diamond", x: 0, y: 0 });
    const b = addNode(doc, { kind: "shape", shapeType: "triangle", x: 9, y: 9 });
    resizeNode(doc, a, { width: 3.7, height: 999.4 });
    const view = readNodes(doc).find((n) => n.id === a)!;
    expect(view.width).toBe(40);
    expect(view.height).toBe(999);
    addEdge(doc, { source: a, target: b });
    const edge = readEdges(doc)[0];
    expect(edge.sourceAnchor).toBe("e");
    expect(edge.targetAnchor).toBe("w");
  });

  it("an unknown kind renders as note, never crashes the renderer", () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const map = new Y.Map<unknown>();
      map.set("kind", "freehand-from-the-future");
      map.set("x", 0);
      map.set("y", 0);
      nodesMap(doc).set("n1", map);
    }, LOCAL);
    expect(readNodes(doc)[0].kind).toBe("note");
  });
});

describe("text merge", () => {
  it("splice narrows to common prefix/suffix", () => {
    expect(splice("hello world", "hello brave world")).toEqual({
      index: 6,
      remove: 0,
      insert: "brave ",
    });
    expect(splice("same", "same")).toBeNull();
  });

  it("two people typing in one field merge instead of clobbering", () => {
    // TRUE concurrency: seed both docs, then buffer each side's edit and
    // cross-apply only after both have typed — a synchronous relay would
    // linearize the writes and prove nothing.
    const a = new Y.Doc();
    const id = addNode(a, { kind: "note", x: 0, y: 0, title: "note" });
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), REMOTE);

    const fromA: Uint8Array[] = [];
    const fromB: Uint8Array[] = [];
    a.on("update", (u: Uint8Array, origin: unknown) => origin === LOCAL && fromA.push(u));
    b.on("update", (u: Uint8Array, origin: unknown) => origin === LOCAL && fromB.push(u));
    writeField(a, nodesMap(a).get(id), "title", "Xnote");
    writeField(b, nodesMap(b).get(id), "title", "noteY");
    for (const u of fromB) Y.applyUpdate(a, u, REMOTE);
    for (const u of fromA) Y.applyUpdate(b, u, REMOTE);
    const titleA = readNodes(a).find((n) => n.id === id)!.title;
    const titleB = readNodes(b).find((n) => n.id === id)!.title;
    expect(titleA).toBe(titleB);
    expect(titleA).toContain("X");
    expect(titleA).toContain("Y");
  });

  it("upgrades a plain-string field (older client) to Y.Text in place", () => {
    const doc = new Y.Doc();
    const id = addNode(doc, { kind: "note", x: 0, y: 0 });
    doc.transact(() => nodesMap(doc).get(id)!.set("title", "plain"), LOCAL);
    writeField(doc, nodesMap(doc).get(id), "title", "typed");
    expect(nodesMap(doc).get(id)!.get("title")).toBeInstanceOf(Y.Text);
    expect(readNodes(doc)[0].title).toBe("typed");
  });
});

describe("the wire", () => {
  it("applyPageContent branches on the snapshot (documented web behaviour)", () => {
    const source = new Y.Doc();
    const id = addNode(source, { kind: "note", x: 5, y: 5, title: "hi" });
    const snapshot = toBase64(Y.encodeStateAsUpdate(source));
    moveNode(source, id, { x: 9, y: 9 });
    const follow = toBase64(Y.encodeStateAsUpdate(source, Y.encodeStateVector(new Y.Doc())));

    const doc = new Y.Doc();
    applyPageContent(doc, { snapshot, updates: [follow] });
    const node = readNodes(doc)[0];
    expect(node.x).toBe(9);
    expect(node.title).toBe("hi");

    // Malformed entries are skipped, never thrown on.
    const doc2 = new Y.Doc();
    applyPageContent(doc2, { snapshot: null, updates: ["%%%not-base64%%%", snapshot] });
    expect(readNodes(doc2).length).toBe(1);
  });

  it("applyRelayed refuses a misaligned batch wholesale", () => {
    const doc = new Y.Doc();
    const claimed = Uint8Array.of(0, 0, 0, 9, 1, 2); // says 9 bytes, has 2
    expect(applyRelayed(doc, claimed)).toBe(false);
    expect(readNodes(doc).length).toBe(0);
  });

  it("frameUpdate carries the BARE update — only the server batches", () => {
    const doc = new Y.Doc();
    addNode(doc, { kind: "note", x: 0, y: 0 });
    const update = Y.encodeStateAsUpdate(doc);
    const frame = frameUpdate(2, update);
    const decoded = decodeSpaceFrame(frame)!;
    // The payload applies directly — no length prefix to strip.
    const target = new Y.Doc();
    Y.applyUpdate(target, decoded.payload, REMOTE);
    expect(readNodes(target).length).toBe(1);
  });
});

describe("undo", () => {
  it("can only ever reach this person's own edits (trackedOrigins)", () => {
    const { a, b } = connectedPair();
    const undoA = localUndo(a);
    const mine = addNode(a, { kind: "note", x: 0, y: 0 });
    const theirs = addNode(b, { kind: "note", x: 50, y: 0 });

    undoA.undo(); // undoes MY node…
    expect(nodesMap(a).has(mine)).toBe(false);
    expect(nodesMap(a).has(theirs)).toBe(true); // …never the peer's

    undoA.undo(); // nothing of mine left — a no-op, not a reach across the room
    expect(nodesMap(a).has(theirs)).toBe(true);
  });

  it("undoing a deletion brings the node's edges back with it", () => {
    const doc = new Y.Doc();
    const undo = localUndo(doc);
    const a = addNode(doc, { kind: "note", x: 0, y: 0 });
    const b = addNode(doc, { kind: "note", x: 10, y: 0 });
    addEdge(doc, { source: a, target: b });
    undo.stopCapturing();
    deleteNode(doc, a);
    undo.undo();
    expect(nodesMap(doc).has(a)).toBe(true);
    expect(edgesMap(doc).size).toBe(1);
  });
});

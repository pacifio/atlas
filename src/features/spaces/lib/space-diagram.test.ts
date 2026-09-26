import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addEdge, addNode, readEdges, readNodes, REMOTE, type SpaceNodeView } from "./space-doc";
import { drawingUpdate, writeDiagram } from "./space-diagram";
import { layoutDiagram, type PlacedDiagram } from "./space-layout";

const drawing: PlacedDiagram = layoutDiagram({
  nodes: [
    { id: "core", kind: "group", text: "Core" },
    { id: "api", kind: "shape", shape: "diamond", text: "API", parent: "core" },
    { id: "why", kind: "note", text: "Why\nIt keeps the socket in Rust" },
    { id: "hint", kind: "text", text: "read left to right" },
  ],
  edges: [{ from: "why", to: "api", from_anchor: "s", to_anchor: "n", label: "explains" }],
});

/** A page someone already drew on. */
function drawnOn(): Y.Doc {
  const doc = new Y.Doc();
  const a = addNode(doc, { kind: "note", x: 0, y: 0, title: "old" });
  const b = addNode(doc, { kind: "shape", x: 300, y: 0, shapeType: "ellipse" });
  addEdge(doc, { source: a, target: b });
  return doc;
}

const byTitle = (nodes: SpaceNodeView[], title: string) => nodes.find((n) => n.title === title)!;

describe("writing a drawing into a page", () => {
  it("replaces everything on it with the drawing, read back through the page codec", () => {
    const doc = drawnOn();
    writeDiagram(doc, drawing);
    const nodes = readNodes(doc);
    expect(nodes).toHaveLength(4);
    expect(nodes.some((n) => n.title === "old")).toBe(false);

    const core = byTitle(nodes, "Core");
    expect(core).toMatchObject({ kind: "group", shapeType: null });
    const api = byTitle(nodes, "API");
    expect(api).toMatchObject({ kind: "shape", shapeType: "diamond" });
    const why = byTitle(nodes, "Why");
    expect(why).toMatchObject({ kind: "note", body: "It keeps the socket in Rust" });
    const hint = nodes.find((n) => n.kind === "text")!;
    expect(hint.text).toBe("read left to right");

    const placed = drawing.nodes.find((n) => n.id === "api")!;
    expect(api).toMatchObject({
      x: placed.x,
      y: placed.y,
      width: placed.width,
      height: placed.height,
    });

    const edges = readEdges(doc);
    expect(edges).toEqual([
      expect.objectContaining({
        source: why.id,
        target: api.id,
        sourceAnchor: "s",
        targetAnchor: "n",
        text: "explains",
      }),
    ]);
  });

  it("gives every node a fresh page id rather than the model's", () => {
    const doc = new Y.Doc();
    writeDiagram(doc, drawing);
    const ids = readNodes(doc).map((n) => n.id);
    for (const modelId of ["core", "api", "why", "hint"]) expect(ids).not.toContain(modelId);
  });

  it("is one update a peer applies to see exactly the drawing", () => {
    const mine = drawnOn();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(mine), REMOTE);

    const scratch = new Y.Doc();
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(mine));
    const update = drawingUpdate(scratch, drawing);

    let updates = 0;
    peer.on("update", () => (updates += 1));
    Y.applyUpdate(peer, update, REMOTE);
    expect(updates).toBe(1);
    expect(
      readNodes(peer)
        .map((n) => n.title)
        .sort(),
    ).toEqual(["", "API", "Core", "Why"]);
    expect(readEdges(peer)).toHaveLength(1);
  });
});

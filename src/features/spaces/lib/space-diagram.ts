/**
 * Writing a laid-out diagram into a Space page (`org_page_write`), through
 * the page codec in `space-doc.ts` and nothing else — so what Atlas Agent
 * draws is exactly what a person drawing it on the canvas would have made,
 * and reads the same on the web client.
 *
 * A write **replaces** the page (v1 has no in-place edit): every edge and
 * every node goes, then the diagram's nodes and edges are added, all in one
 * transaction, so a peer never sees the page half-cleared. Nodes get fresh
 * page ids (the contract's ids are client-generated and never renumbered;
 * the model's ids only join its edges to its nodes).
 */
import * as Y from "yjs";

import { addEdge, addNode, edgesMap, LOCAL, nodesMap, type NewNode } from "./space-doc";
import type { PlacedDiagram, PlacedNode } from "./space-layout";

/** Where a node's text goes, as the canvas renders each kind: a note's first
 *  line is its title and the rest its body; a text box's is its text; a
 *  shape's and a group's is the label the canvas draws on it (`title`). */
function prose(node: PlacedNode): Pick<NewNode, "title" | "body" | "text"> {
  switch (node.kind) {
    case "note": {
      const [title, ...rest] = node.text.split("\n");
      return { title, body: rest.join("\n") };
    }
    case "text":
      return { text: node.text };
    case "shape":
    case "group":
      return { title: node.text };
  }
}

/** Replace `doc`'s content with `diagram`, as one local transaction. */
export function writeDiagram(doc: Y.Doc, diagram: PlacedDiagram): void {
  doc.transact(() => {
    // Snapshotted first: deleting from a map while walking its own keys
    // would skip some.
    const edges = edgesMap(doc);
    for (const id of Array.from(edges.keys())) edges.delete(id);
    const nodes = nodesMap(doc);
    for (const id of Array.from(nodes.keys())) nodes.delete(id);

    const pageIds = new Map<string, string>();
    for (const node of diagram.nodes) {
      const id = addNode(doc, {
        kind: node.kind,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        ...(node.shape ? { shapeType: node.shape } : {}),
        ...prose(node),
      });
      pageIds.set(node.id, id);
    }
    for (const edge of diagram.edges) {
      const source = pageIds.get(edge.from);
      const target = pageIds.get(edge.to);
      if (!source || !target) continue;
      addEdge(doc, {
        source,
        target,
        sourceAnchor: edge.fromAnchor,
        targetAnchor: edge.toAnchor,
        text: edge.label,
      });
    }
  }, LOCAL);
}

/**
 * The one CRDT update that turns the page `doc` holds into `diagram`.
 *
 * `doc` is a scratch copy of the page (its content as the Space has it, or as
 * an open canvas holds it); the update is what went into it, ready to go out
 * on the Space's own sync — applied to an open canvas's doc, or framed onto
 * the page's slot — and so reach every teammate with the page open.
 */
export function drawingUpdate(doc: Y.Doc, diagram: PlacedDiagram): Uint8Array {
  const before = Y.encodeStateVector(doc);
  writeDiagram(doc, diagram);
  return Y.encodeStateAsUpdate(doc, before);
}

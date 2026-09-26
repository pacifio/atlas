import { describe, expect, it } from "vitest";
import {
  KIND_SIZE,
  LAYOUT,
  layoutDiagram,
  type Diagram,
  type PlacedDiagram,
  type PlacedNode,
} from "./space-layout";

const at = (placed: PlacedDiagram, id: string): PlacedNode => {
  const node = placed.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
};

const overlaps = (a: PlacedNode, b: PlacedNode) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const inside = (inner: PlacedNode, outer: PlacedNode) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

describe("a diagram with no positions", () => {
  const pipeline: Diagram = {
    nodes: [
      { id: "store", kind: "shape", text: "Store" },
      { id: "api", kind: "shape", text: "API" },
      { id: "client", kind: "note", text: "Client" },
      { id: "cache", kind: "shape", shape: "ellipse", text: "Cache" },
    ],
    edges: [
      { from: "client", to: "api" },
      { from: "api", to: "store" },
      { from: "api", to: "cache" },
    ],
  };

  it("is laid out left to right along the edges, one column per step", () => {
    const placed = layoutDiagram(pipeline);
    const [client, api, store, cache] = ["client", "api", "store", "cache"].map((id) =>
      at(placed, id),
    );
    expect(client.x).toBeLessThan(api.x);
    expect(api.x).toBeLessThan(store.x);
    expect(store.x).toBe(cache.x);
    expect(api.x - (client.x + client.width)).toBeGreaterThanOrEqual(LAYOUT.columnGap);
  });

  it("places a node past the furthest node that points at it (longest path)", () => {
    const placed = layoutDiagram({
      nodes: [
        { id: "a", kind: "shape" },
        { id: "b", kind: "shape" },
        { id: "c", kind: "shape" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "a", to: "c" },
      ],
    });
    expect(at(placed, "c").x).toBeGreaterThan(at(placed, "b").x);
  });

  it("overlaps nothing and starts at the page's origin", () => {
    const placed = layoutDiagram(pipeline);
    for (const a of placed.nodes)
      for (const b of placed.nodes)
        if (a !== b) expect(overlaps(a, b), `${a.id}/${b.id}`).toBe(false);
    expect(Math.min(...placed.nodes.map((n) => n.x))).toBe(0);
    expect(Math.min(...placed.nodes.map((n) => n.y))).toBe(0);
  });

  it("gives each kind the canvas's own default size", () => {
    const placed = layoutDiagram(pipeline);
    expect(at(placed, "client")).toMatchObject(KIND_SIZE.note);
    expect(at(placed, "api")).toMatchObject(KIND_SIZE.shape);
    expect(at(placed, "api").shape).toBe("rectangle");
    expect(at(placed, "cache").shape).toBe("ellipse");
    expect(at(placed, "client").shape).toBeNull();
  });

  it("survives a cycle and still draws every edge", () => {
    const placed = layoutDiagram({
      nodes: [
        { id: "a", kind: "shape" },
        { id: "b", kind: "shape" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    });
    expect(at(placed, "a").x).toBeLessThan(at(placed, "b").x);
    expect(placed.edges).toHaveLength(2);
  });

  it("orders a column by where its neighbours are, so edges cross less", () => {
    // top → x, bottom → y; given y before x, the barycentre puts x first.
    const placed = layoutDiagram({
      nodes: [
        { id: "top", kind: "shape" },
        { id: "bottom", kind: "shape" },
        { id: "y", kind: "shape" },
        { id: "x", kind: "shape" },
      ],
      edges: [
        { from: "top", to: "x" },
        { from: "bottom", to: "y" },
      ],
    });
    expect(at(placed, "top").y).toBeLessThan(at(placed, "bottom").y);
    expect(at(placed, "x").y).toBeLessThan(at(placed, "y").y);
  });
});

describe("given positions", () => {
  it("are kept exactly, with the given size", () => {
    const placed = layoutDiagram({
      nodes: [{ id: "a", kind: "note", x: 500, y: -40, w: 300, h: 90 }],
      edges: [],
    });
    expect(at(placed, "a")).toMatchObject({ x: 500, y: -40, width: 300, height: 90 });
  });

  it("put the unplaced nodes below the placed ones, never on top of them", () => {
    const placed = layoutDiagram({
      nodes: [
        { id: "fixed", kind: "note", x: 100, y: 100 },
        { id: "free1", kind: "shape" },
        { id: "free2", kind: "shape" },
      ],
      edges: [{ from: "free1", to: "free2" }],
    });
    const fixed = at(placed, "fixed");
    expect(fixed).toMatchObject({ x: 100, y: 100 });
    for (const id of ["free1", "free2"]) {
      expect(overlaps(at(placed, id), fixed)).toBe(false);
      expect(at(placed, id).y).toBeGreaterThanOrEqual(fixed.y + fixed.height + LAYOUT.blockGap);
    }
  });
});

describe("groups", () => {
  it("are containers sized around their laid-out children, drawn beneath them", () => {
    const placed = layoutDiagram({
      nodes: [
        { id: "in", kind: "shape" },
        { id: "a", kind: "shape", parent: "core" },
        { id: "b", kind: "shape", parent: "core" },
        { id: "core", kind: "group", text: "Core" },
        { id: "out", kind: "shape" },
      ],
      edges: [
        { from: "in", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "out" },
      ],
    });
    const core = at(placed, "core");
    expect(inside(at(placed, "a"), core)).toBe(true);
    expect(inside(at(placed, "b"), core)).toBe(true);
    expect(at(placed, "a").x - core.x).toBe(LAYOUT.groupPadding);
    expect(at(placed, "a").x).toBeLessThan(at(placed, "b").x);
    // The group is one box among its siblings, between what feeds it and
    // what it feeds.
    expect(at(placed, "in").x + at(placed, "in").width).toBeLessThanOrEqual(core.x);
    expect(core.x + core.width).toBeLessThanOrEqual(at(placed, "out").x);
    expect(overlaps(at(placed, "in"), core)).toBe(false);
    expect(placed.nodes[0].id).toBe("core");
  });

  it("nest, outer frames first", () => {
    const placed = layoutDiagram({
      nodes: [
        { id: "leaf", kind: "text", parent: "inner" },
        { id: "inner", kind: "group", parent: "outer" },
        { id: "outer", kind: "group" },
      ],
      edges: [],
    });
    expect(inside(at(placed, "leaf"), at(placed, "inner"))).toBe(true);
    expect(inside(at(placed, "inner"), at(placed, "outer"))).toBe(true);
    expect(placed.nodes.map((n) => n.id)).toEqual(["outer", "inner", "leaf"]);
  });

  it("placed at a position lay their children out inside it", () => {
    const placed = layoutDiagram({
      nodes: [
        { id: "g", kind: "group", x: 1000, y: 1000 },
        { id: "a", kind: "shape", parent: "g" },
      ],
      edges: [],
    });
    expect(at(placed, "g")).toMatchObject({ x: 1000, y: 1000 });
    expect(at(placed, "a")).toMatchObject({
      x: 1000 + LAYOUT.groupPadding,
      y: 1000 + LAYOUT.groupPadding,
    });
    expect(inside(at(placed, "a"), at(placed, "g"))).toBe(true);
  });

  it("holding a placed child are drawn around it", () => {
    const placed = layoutDiagram({
      nodes: [
        { id: "g", kind: "group" },
        { id: "a", kind: "shape", parent: "g", x: 400, y: 300 },
      ],
      edges: [],
    });
    expect(at(placed, "a")).toMatchObject({ x: 400, y: 300 });
    expect(inside(at(placed, "a"), at(placed, "g"))).toBe(true);
  });

  it("with nothing in them get the canvas's default frame", () => {
    const placed = layoutDiagram({ nodes: [{ id: "g", kind: "group" }], edges: [] });
    expect(at(placed, "g")).toMatchObject(KIND_SIZE.group);
  });
});

describe("edges", () => {
  it("attach at the anchors they name and carry their labels", () => {
    const placed = layoutDiagram({
      nodes: [
        { id: "a", kind: "shape" },
        { id: "b", kind: "shape" },
      ],
      edges: [{ from: "a", to: "b", from_anchor: "s", to_anchor: "n", label: "calls" }],
    });
    expect(placed.edges).toEqual([
      { from: "a", to: "b", fromAnchor: "s", toAnchor: "n", label: "calls" },
    ]);
  });

  it("otherwise attach at the sides that face each other", () => {
    const placed = layoutDiagram({
      nodes: [
        { id: "left", kind: "shape" },
        { id: "right", kind: "shape" },
        { id: "high", kind: "shape", x: 0, y: -1000 },
        { id: "low", kind: "shape", x: 0, y: 1000 },
      ],
      edges: [
        { from: "left", to: "right" },
        { from: "right", to: "left" },
        { from: "high", to: "low" },
        { from: "low", to: "high" },
      ],
    });
    const anchors = placed.edges.map((e) => `${e.from}:${e.fromAnchor}-${e.to}:${e.toAnchor}`);
    expect(anchors).toEqual(["left:e-right:w", "right:w-left:e", "high:s-low:n", "low:n-high:s"]);
    expect(placed.edges.every((e) => e.label === "")).toBe(true);
  });
});

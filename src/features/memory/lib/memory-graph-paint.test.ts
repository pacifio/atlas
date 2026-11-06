// The memory graph's paint rules, one case per rule. The numbers are the ones
// the pixi scene drew before the rules moved out of it; a change here is a
// visible change to the graph.
import { describe, expect, it } from "vitest";
import type { GraphPalette } from "@/components/graph-palette";
import {
  arrowHead,
  buildAdjacency,
  makeRecency,
  paintEdge,
  paintNode,
  reachable,
  type PaintState,
} from "./memory-graph-paint";

const P: GraphPalette = {
  primary: 1,
  secondary: 2,
  muted: 3,
  edgeDefault: 4,
  edgeSelected: 5,
  edgeDim: 6,
  edgeLink: 7,
  ancestor: 8,
  labelPrimary: "p",
  labelSecondary: "s",
  labelMuted: "m",
};

const base: PaintState = {
  selectedId: null,
  impact: new Set(),
  ancestors: new Set(),
  matched: new Set(),
  draggingId: null,
  draggingNeighbors: new Set(),
  cutoff: null,
  zoom: 1,
};
const state = (over: Partial<PaintState>): PaintState => ({ ...base, ...over });
const node = (id: string, ts = 100, recency = 1) => ({ id, ts, recency });

describe("paintNode", () => {
  it("neutral grades alpha with recency", () => {
    const p = paintNode(node("a", 100, 0.5), base, P);
    expect(p).toMatchObject({ color: P.secondary, alpha: 0.75, radiusScale: 1, ring: false });
    expect(p.label).toEqual({ visible: true, alpha: 0.85, tone: "secondary" });
  });

  it("a node after the cutoff is faint with its label hidden, over every other rule", () => {
    const p = paintNode(node("a", 200), state({ cutoff: 150, selectedId: "a" }), P);
    expect(p).toMatchObject({ color: P.muted, alpha: 0.05, ring: false });
    expect(p.label.visible).toBe(false);
  });

  it("selection: selected, impact, ancestor, other", () => {
    const s = state({ selectedId: "s", impact: new Set(["i"]), ancestors: new Set(["a"]) });
    expect(paintNode(node("s"), s, P)).toMatchObject({
      color: P.primary,
      alpha: 1,
      radiusScale: 1.25,
      ring: true,
      label: { alpha: 1, tone: "primary" },
    });
    expect(paintNode(node("i"), s, P)).toMatchObject({ color: P.primary, ring: false });
    expect(paintNode(node("a"), s, P)).toMatchObject({
      color: P.ancestor,
      alpha: 0.95,
      label: { tone: "primary" },
    });
    expect(paintNode(node("x"), s, P)).toMatchObject({
      color: P.muted,
      alpha: 0.28,
      label: { alpha: 0.25, tone: "muted" },
    });
  });

  it("selection wins over drag and matches", () => {
    const s = state({ selectedId: "s", draggingId: "x", matched: new Set(["x"]) });
    expect(paintNode(node("x"), s, P).color).toBe(P.muted);
  });

  it("drag: dragged, neighbour, other", () => {
    const s = state({ draggingId: "d", draggingNeighbors: new Set(["n"]) });
    expect(paintNode(node("d"), s, P)).toMatchObject({ color: P.primary, ring: true });
    expect(paintNode(node("n"), s, P)).toMatchObject({ color: P.primary, ring: false });
    expect(paintNode(node("x"), s, P)).toMatchObject({ color: P.muted, alpha: 0.4 });
  });

  it("matches: matched, unmatched", () => {
    const s = state({ matched: new Set(["m"]) });
    expect(paintNode(node("m"), s, P)).toMatchObject({
      color: P.primary,
      radiusScale: 1.15,
      ring: true,
    });
    expect(paintNode(node("x"), s, P)).toMatchObject({ color: P.muted, alpha: 0.35 });
  });

  it("labels hide below half zoom", () => {
    expect(paintNode(node("a"), state({ zoom: 0.49 }), P).label.visible).toBe(false);
    expect(paintNode(node("a"), state({ zoom: 0.5 }), P).label.visible).toBe(true);
  });
});

describe("paintEdge", () => {
  const sim = { from: "a", to: "b", kind: "similarity" };
  const link = { from: "a", to: "b", kind: "link" };

  it("rests at the kind's colour", () => {
    expect(paintEdge(sim, 1, 2, base, P)).toEqual({
      color: P.edgeDefault,
      alpha: 0.3,
      width: 1,
      arrow: null,
    });
    expect(paintEdge(link, 1, 2, base, P)).toMatchObject({ color: P.edgeLink, alpha: 0.5 });
  });

  it("an unborn endpoint keeps the edge faint", () => {
    expect(paintEdge(sim, 1, 200, state({ cutoff: 100 }), P)).toEqual({
      color: P.edgeDim,
      alpha: 0.04,
      width: 1,
      arrow: null,
    });
  });

  it("selection lights the forward cone, then the ancestors, and dims the rest", () => {
    const s = state({ selectedId: "a", impact: new Set(["b"]), ancestors: new Set(["z"]) });
    expect(paintEdge(sim, 1, 2, s, P)).toEqual({
      color: P.primary,
      alpha: 0.85,
      width: 1.5,
      arrow: P.primary,
    });
    expect(paintEdge({ from: "z", to: "a", kind: "similarity" }, 1, 2, s, P)).toEqual({
      color: P.ancestor,
      alpha: 0.7,
      width: 1.5,
      arrow: P.ancestor,
    });
    expect(paintEdge({ from: "q", to: "r", kind: "similarity" }, 1, 2, s, P)).toMatchObject({
      color: P.edgeDim,
      alpha: 0.12,
      arrow: null,
    });
  });

  it("drag lights the dragged node's edges", () => {
    const s = state({ draggingId: "a" });
    expect(paintEdge(sim, 1, 2, s, P)).toMatchObject({ color: P.edgeSelected, alpha: 0.9 });
    expect(paintEdge({ from: "q", to: "r", kind: "link" }, 1, 2, s, P)).toMatchObject({
      color: P.edgeDim,
      alpha: 0.15,
    });
  });

  it("matches fade every edge but keep its colour", () => {
    expect(paintEdge(link, 1, 2, state({ matched: new Set(["a"]) }), P)).toMatchObject({
      color: P.edgeLink,
      alpha: 0.12,
    });
  });
});

describe("reachable", () => {
  // a → b → c, a → d
  const adj = buildAdjacency([
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "a", to: "d" },
  ]);
  it("walks forward and backward", () => {
    expect(reachable("a", adj.fwd)).toEqual(new Set(["b", "c", "d"]));
    expect(reachable("c", adj.bwd)).toEqual(new Set(["b", "a"]));
    expect(reachable("c", adj.fwd)).toEqual(new Set());
  });
});

describe("makeRecency", () => {
  it("is 0.5 everywhere when no timestamp is known", () => {
    const r = makeRecency([{ timestampMs: 0 }, { timestampMs: 0 }]);
    expect(r(0)).toBe(0.5);
    expect(r(10)).toBe(0.5);
  });
  it("spans oldest to newest", () => {
    const r = makeRecency([{ timestampMs: 10 }, { timestampMs: 20 }]);
    expect(r(10)).toBe(0);
    expect(r(15)).toBe(0.5);
    expect(r(20)).toBe(1);
  });
});

describe("arrowHead", () => {
  it("sits outside the target on a horizontal edge", () => {
    const [tx, ty, lx, ly, rx, ry] = arrowHead(0, 0, 100, 0, 10, 1);
    expect([tx, ty]).toEqual([88, 0]);
    expect(lx).toBe(82);
    expect(ly).toBeCloseTo(3.6);
    expect(rx).toBe(82);
    expect(ry).toBeCloseTo(-3.6);
  });
});

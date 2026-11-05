/**
 * The memory graph's paint rules: what colour, alpha and size each node, label
 * and edge gets for a given selection / drag / search / timeline state. Pure —
 * no pixi, no DOM — so the rules are unit-tested and the scene only draws.
 *
 * Precedence, highest first: not yet born (timeline cutoff), selection, drag,
 * search matches, neutral.
 */
import type { GraphPalette } from "@/components/graph-palette";

/** Label visibility threshold: below this zoom labels hide. */
export const HIDE_LABEL_BELOW = 0.5;

export function nodeRadiusForDegree(degree: number): number {
  return Math.min(3 + Math.sqrt(Math.max(0, degree)) * 1.6, 14);
}

export interface Adjacency {
  fwd: Map<string, string[]>;
  bwd: Map<string, string[]>;
}

/** Forward/backward adjacency (edges are oriented older → newer). */
export function buildAdjacency(edges: readonly { from: string; to: string }[]): Adjacency {
  const fwd = new Map<string, string[]>();
  const bwd = new Map<string, string[]>();
  for (const e of edges) {
    (fwd.get(e.from) ?? fwd.set(e.from, []).get(e.from)!).push(e.to);
    (bwd.get(e.to) ?? bwd.set(e.to, []).get(e.to)!).push(e.from);
  }
  return { fwd, bwd };
}

/** Everything reachable from `start` (exclusive) along `adj`. The time DAG has
 *  no cycles, and the `seen` set ends the walk even if one sneaks in. */
export function reachable(start: string, adj: ReadonlyMap<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const nxt of adj.get(cur) ?? []) {
      if (!seen.has(nxt)) {
        seen.add(nxt);
        stack.push(nxt);
      }
    }
  }
  return seen;
}

/** Recency 0 (oldest) … 1 (newest) over the known timestamps; 0.5 for an
 *  unknown timestamp or when every timestamp is the same. */
export function makeRecency(nodes: readonly { timestampMs: number }[]): (ts: number) => number {
  const known = nodes.map((n) => n.timestampMs).filter((t) => t > 0);
  const min = known.length ? Math.min(...known) : 0;
  const max = known.length ? Math.max(...known) : 0;
  return (ts) => (ts <= 0 || max <= min ? 0.5 : (ts - min) / (max - min));
}

export interface PaintState {
  selectedId: string | null;
  /** Forward time-reachable from the selection — what it influenced. */
  impact: Set<string>;
  /** Backward time-reachable — what influenced the selection. */
  ancestors: Set<string>;
  matched: Set<string>;
  draggingId: string | null;
  draggingNeighbors: Set<string>;
  /** Hide memories created after this instant (time scrubber). null = show all. */
  cutoff: number | null;
  zoom: number;
}

export type LabelTone = "primary" | "secondary" | "muted";

export interface NodePaint {
  color: number;
  alpha: number;
  /** Multiplier on the node's degree radius. */
  radiusScale: number;
  /** Draw the focus ring (same colour, alpha 0.6). */
  ring: boolean;
  label: { visible: boolean; alpha: number; tone: LabelTone };
}

export interface EdgePaint {
  color: number;
  alpha: number;
  /** Screen px; the scene multiplies by `1 / zoom`. */
  width: number;
  /** Arrowhead colour when the edge is on an influence path. */
  arrow: number | null;
}

function mode(s: PaintState) {
  const hasSelection = s.selectedId !== null;
  const hasDrag = !hasSelection && s.draggingId !== null;
  const hasMatches = !hasSelection && !hasDrag && s.matched.size > 0;
  return { hasSelection, hasDrag, hasMatches };
}

function isFuture(ts: number, cutoff: number | null): boolean {
  return cutoff !== null && ts > 0 && ts > cutoff;
}

export function paintNode(
  node: { id: string; ts: number; recency: number },
  s: PaintState,
  palette: GraphPalette,
): NodePaint {
  const { hasSelection, hasDrag, hasMatches } = mode(s);
  const future = isFuture(node.ts, s.cutoff);
  let color = palette.secondary;
  let alpha = 1;
  let radiusScale = 1;
  let ring = false;
  let lit = false;
  let labelDim = false;

  if (future) {
    // Not yet "born" at the scrubber's instant.
    color = palette.muted;
    alpha = 0.05;
    labelDim = true;
  } else if (hasSelection) {
    if (node.id === s.selectedId) {
      color = palette.primary;
      radiusScale = 1.25;
      ring = true;
      lit = true;
    } else if (s.impact.has(node.id)) {
      color = palette.primary;
      lit = true;
    } else if (s.ancestors.has(node.id)) {
      color = palette.ancestor;
      alpha = 0.95;
      lit = true;
    } else {
      color = palette.muted;
      alpha = 0.28;
      labelDim = true;
    }
  } else if (hasDrag) {
    if (node.id === s.draggingId) {
      color = palette.primary;
      ring = true;
      lit = true;
    } else if (s.draggingNeighbors.has(node.id)) {
      color = palette.primary;
      lit = true;
    } else {
      color = palette.muted;
      alpha = 0.4;
      labelDim = true;
    }
  } else if (hasMatches) {
    if (s.matched.has(node.id)) {
      color = palette.primary;
      radiusScale = 1.15;
      ring = true;
      lit = true;
    } else {
      color = palette.muted;
      alpha = 0.35;
      labelDim = true;
    }
  } else {
    // Neutral: brightness grades with recency (newer = brighter).
    alpha = 0.5 + 0.5 * node.recency;
  }

  let label: NodePaint["label"];
  if (s.zoom < HIDE_LABEL_BELOW || future) label = { visible: false, alpha: 0, tone: "secondary" };
  else if (!hasSelection && !hasDrag && !hasMatches)
    label = { visible: true, alpha: 0.85, tone: "secondary" };
  else if (lit) label = { visible: true, alpha: 1, tone: "primary" };
  else if (labelDim) label = { visible: true, alpha: 0.25, tone: "muted" };
  else label = { visible: true, alpha: 0.6, tone: "secondary" };

  return { color, alpha, radiusScale, ring, label };
}

export function paintEdge(
  edge: { from: string; to: string; kind: string },
  fromTs: number,
  toTs: number,
  s: PaintState,
  palette: GraphPalette,
): EdgePaint {
  if (isFuture(fromTs, s.cutoff) || isFuture(toTs, s.cutoff)) {
    // One endpoint not born yet — keep faint.
    return { color: palette.edgeDim, alpha: 0.04, width: 1, arrow: null };
  }
  const { hasSelection, hasDrag, hasMatches } = mode(s);
  const link = edge.kind === "link";
  let color = link ? palette.edgeLink : palette.edgeDefault;
  let alpha = link ? 0.5 : 0.3;
  let arrow: number | null = null;

  if (hasSelection) {
    const litFwd = (id: string) => id === s.selectedId || s.impact.has(id);
    const litBwd = (id: string) => id === s.selectedId || s.ancestors.has(id);
    if (litFwd(edge.from) && litFwd(edge.to)) {
      color = palette.primary;
      alpha = 0.85;
      arrow = palette.primary;
    } else if (litBwd(edge.from) && litBwd(edge.to)) {
      color = palette.ancestor;
      alpha = 0.7;
      arrow = palette.ancestor;
    } else {
      color = palette.edgeDim;
      alpha = 0.12;
    }
  } else if (hasDrag) {
    const touches = edge.from === s.draggingId || edge.to === s.draggingId;
    color = touches ? palette.edgeSelected : palette.edgeDim;
    alpha = touches ? 0.9 : 0.15;
  } else if (hasMatches) {
    alpha = 0.12;
  }
  return { color, alpha, width: arrow !== null ? 1.5 : 1, arrow };
}

/**
 * Arrowhead just outside the target node, pointing a → b (older → newer).
 * `inv` is `1 / zoom`, so the head keeps a constant screen size.
 * Returns `[tipX, tipY, leftX, leftY, rightX, rightY]`.
 */
export function arrowHead(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  targetRadius: number,
  inv: number,
): [number, number, number, number, number, number] {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const tipX = bx - ux * (targetRadius + 2 * inv);
  const tipY = by - uy * (targetRadius + 2 * inv);
  const size = 6 * inv;
  return [
    tipX,
    tipY,
    tipX - ux * size - uy * size * 0.6,
    tipY - uy * size + ux * size * 0.6,
    tipX - ux * size + uy * size * 0.6,
    tipY - uy * size - ux * size * 0.6,
  ];
}

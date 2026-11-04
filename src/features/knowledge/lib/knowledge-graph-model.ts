/**
 * The knowledge graph's data shapes and tuning constants. Pure: no React, no
 * pixi. Node ids are note paths without the extension.
 */

export interface GraphNode {
  id: string;
  title: string;
  inDegree: number;
  outDegree: number;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface ProjectGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Per-node {x, y} world-space positions. Loaded from disk on mount,
 *  saved on unmount + on a debounced timer while a node is dragged.
 *  Mirrors the Rust `GraphLayout` shape in `knowledge_graph_layout.rs`. */
export interface GraphLayout {
  positions: Record<string, { x: number; y: number }>;
}

/** Above this many notes the graph is not drawn. */
export const NODE_CAP = 1000;
/** Pixi's backing-store resolution. */
export const RESOLUTION = 2;
export const MIN_SCALE = 0.2;
export const MAX_SCALE = 4;
export const ZOOM_STEP = 0.004;
/** Labels hide below this zoom. */
export const HIDE_LABEL_BELOW = 0.5;
export const DOUBLE_CLICK_MS = 280;
/** Constant screen-px gap between a node's disc and its label (counter-scaled). */
export const LABEL_GAP = 6;

export function nodeRadiusForDegree(degree: number): number {
  return Math.min(3 + Math.sqrt(Math.max(0, degree)) * 1.6, 14);
}

/** Ids one edge away from `id`, in either direction. */
export function neighborsOf(id: string, edges: readonly GraphEdge[]): Set<string> {
  const out = new Set<string>();
  for (const e of edges) {
    if (e.from === id) out.add(e.to);
    else if (e.to === id) out.add(e.from);
  }
  return out;
}

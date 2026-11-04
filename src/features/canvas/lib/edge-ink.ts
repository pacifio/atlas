import type { CSSProperties } from "react";

/**
 * How both boards (the local canvas and a realtime Space) draw edges, set on
 * the `<ReactFlow>` element: xyflow's own custom properties, read by its edge
 * rules. An edge is `border-strong`; a selected one turns `primary`.
 *
 * Set here rather than as an inline `stroke` on each edge, because an inline
 * stroke outranks xyflow's `.selected` rule and a selected edge would never
 * change colour. Theme variables, so a theme switch recolours with no render.
 */
export const EDGE_INK = {
  "--xy-edge-stroke": "var(--border-strong)",
  "--xy-edge-stroke-selected": "var(--primary)",
  "--xy-edge-stroke-width": "1.5px",
} as CSSProperties;

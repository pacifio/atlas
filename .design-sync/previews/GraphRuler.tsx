import { GraphRuler } from "atlas";

/**
 * Figma-style ruler overlay for the graph views: one canvas, drawn in world
 * coordinates, redrawn when the viewport pans or zooms. `pointer-events:none`,
 * so it never intercepts graph interaction.
 */
const Stage = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      position: "relative",
      width: 260,
      height: 160,
      borderRadius: 6,
      overflow: "hidden",
      border: "1px solid var(--border-default)",
      background: "var(--bg-canvas)",
    }}
  >
    {children}
  </div>
);

export const AtOrigin = () => (
  <Stage>
    <GraphRuler width={260} height={160} viewport={{ x: 0, y: 0, scale: 1 }} />
  </Stage>
);

export const Panned = () => (
  <Stage>
    <GraphRuler width={260} height={160} viewport={{ x: -420, y: -260, scale: 1 }} />
  </Stage>
);

export const ZoomedIn = () => (
  <Stage>
    <GraphRuler width={260} height={160} viewport={{ x: -120, y: -80, scale: 2.5 }} />
  </Stage>
);

export const ZoomedOut = () => (
  <Stage>
    <GraphRuler width={260} height={160} viewport={{ x: 0, y: 0, scale: 0.35 }} />
  </Stage>
);

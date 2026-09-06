import { GradualBlur } from "atlas";

const Passage = () => (
  <div style={{ padding: 10, fontSize: 11.5, lineHeight: 1.6, color: "var(--text-secondary)" }}>
    Atlas keeps its business logic in Rust and treats React as a view layer. The
    renderer owns no state a Tauri command could own instead, which is why panel
    switches stay cheap and why a workspace switch can flush and restore without
    a reload. Scroll-hot work is deferred behind an idle gate so a long chat
    transcript never contends with the markdown lane.
  </div>
);

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      position: "relative",
      width: 260,
      height: 140,
      overflow: "hidden",
      borderRadius: 6,
      border: "1px solid var(--border-default)",
      background: "var(--bg-raised)",
    }}
  >
    <Passage />
    {children}
  </div>
);

/** A reading edge at the bottom of a scroll container. */
export const BottomEdge = () => (
  <Frame>
    <GradualBlur position="bottom" height="52px" />
  </Frame>
);

export const TopEdge = () => (
  <Frame>
    <GradualBlur position="top" height="52px" />
  </Frame>
);

/** `tint` composites a colour wash so content dims as well as blurs. */
export const Tinted = () => (
  <Frame>
    <GradualBlur position="bottom" height="64px" tint="var(--bg-raised)" />
  </Frame>
);

export const StrongerRamp = () => (
  <Frame>
    <GradualBlur position="bottom" height="64px" strength={3} layers={8} exponential />
  </Frame>
);

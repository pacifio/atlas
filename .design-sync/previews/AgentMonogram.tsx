import { AgentMonogram } from "atlas";

/** Last-resort glyph for an agent with no icon source: the label's initial. */
export const Single = () => (
  <div style={{ color: "var(--text-secondary)" }}>
    <AgentMonogram label="Warp" />
  </div>
);

export const Sizes = () => (
  <div style={{ display: "flex", alignItems: "center", gap: 18, color: "var(--text-secondary)" }}>
    <AgentMonogram label="Warp" size={12} />
    <AgentMonogram label="Warp" size={18} />
    <AgentMonogram label="Warp" size={28} />
  </div>
);

export const AcrossLabels = () => (
  <div style={{ display: "flex", alignItems: "center", gap: 18, color: "var(--text-secondary)" }}>
    {["Warp", "aider", "Goose", "zed"].map((l) => (
      <span key={l} style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <AgentMonogram label={l} size={18} />
        <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{l}</span>
      </span>
    ))}
  </div>
);

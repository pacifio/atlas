import { AtlasLoader } from "atlas";

/** Four bars that shuffle, evoking the Atlas logo. Inherits `currentColor`. */
export const Default = () => (
  <div style={{ color: "var(--text-secondary)" }}>
    <AtlasLoader />
  </div>
);

export const Sizes = () => (
  <div style={{ display: "flex", alignItems: "center", gap: 20, color: "var(--text-secondary)" }}>
    <AtlasLoader size={12} />
    <AtlasLoader size={16} />
    <AtlasLoader size={24} />
    <AtlasLoader size={36} />
  </div>
);

export const InAStatusRow = () => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      fontSize: 11.5,
      color: "var(--text-secondary)",
    }}
  >
    <AtlasLoader size={14} />
    <span>Indexing workspace…</span>
  </div>
);

export const OnAccent = () => (
  <div style={{ color: "var(--accent-primary)" }}>
    <AtlasLoader size={20} />
  </div>
);

import { AtlasIcon } from "atlas";

/** The Atlas brand mark, served from the bundled SVG. */
export const Default = () => <AtlasIcon />;

export const Sizes = () => (
  <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
    <AtlasIcon size={14} />
    <AtlasIcon size={18} />
    <AtlasIcon size={32} />
    <AtlasIcon size={48} />
  </div>
);

export const InATitleRow = () => (
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <AtlasIcon size={18} />
    <span style={{ fontSize: 12.5, color: "var(--text-primary)" }}>Atlas</span>
    <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>0.3.1</span>
  </div>
);

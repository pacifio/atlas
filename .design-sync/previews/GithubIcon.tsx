import { GithubIcon } from "atlas";

/** Inherits `currentColor`, so it takes whatever text token wraps it. */
export const Default = () => (
  <div style={{ color: "var(--text-secondary)" }}>
    <GithubIcon />
  </div>
);

export const Sizes = () => (
  <div style={{ display: "flex", alignItems: "center", gap: 16, color: "var(--text-secondary)" }}>
    <GithubIcon width={14} height={14} />
    <GithubIcon width={18} height={18} />
    <GithubIcon width={28} height={28} />
  </div>
);

export const InARepoRow = () => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      fontSize: 11.5,
      color: "var(--text-secondary)",
    }}
  >
    <GithubIcon width={14} height={14} />
    <span>pacifio/atlas</span>
  </div>
);

export const OnPrimaryText = () => (
  <div style={{ color: "var(--text-primary)" }}>
    <GithubIcon width={22} height={22} />
  </div>
);

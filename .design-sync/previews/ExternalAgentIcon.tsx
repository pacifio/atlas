import { ExternalAgentIcon } from "atlas";

/**
 * Registry agents ship their icon as a data URL. A `currentColor` SVG is
 * drawn as a CSS mask so it takes the surrounding text token; anything with
 * real brand colours is drawn as an image, untouched.
 */
const MONO = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 2 7l10 5 10-5-10-5Zm0 8.5L2 15.5 12 20.5l10-5-10-5Z"/></svg>',
)}`;

const COLOR = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#d97757"/><path d="M7 15 12 6l5 9Z" fill="#fff"/></svg>',
)}`;

export const MonochromeMasked = () => (
  <div style={{ color: "var(--text-secondary)" }}>
    <ExternalAgentIcon dataUrl={MONO} size={24} />
  </div>
);

export const BrandColoursKept = () => <ExternalAgentIcon dataUrl={COLOR} size={24} />;

export const Sizes = () => (
  <div style={{ display: "flex", alignItems: "center", gap: 16, color: "var(--text-secondary)" }}>
    <ExternalAgentIcon dataUrl={MONO} size={14} />
    <ExternalAgentIcon dataUrl={MONO} size={18} />
    <ExternalAgentIcon dataUrl={MONO} size={28} />
  </div>
);

export const InstalledAgentRow = () => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      fontSize: 11.5,
      color: "var(--text-secondary)",
    }}
  >
    <ExternalAgentIcon dataUrl={COLOR} size={16} />
    <span>Installed from the registry</span>
  </div>
);

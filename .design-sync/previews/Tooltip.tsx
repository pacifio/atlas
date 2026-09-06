import { Tooltip, TooltipTrigger, TooltipContent } from "atlas";

/**
 * `Tooltip` self-wraps a provider, so it works anywhere with no setup.
 * Previews use `defaultOpen` — a hover-only surface is invisible otherwise —
 * and reserve headroom so the panel isn't clipped out of the card.
 */
const stage: React.CSSProperties = {
  height: 120,
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "center",
};
const trigger: React.CSSProperties = {
  borderRadius: 4,
  border: "1px solid var(--border-default)",
  background: "var(--bg-raised)",
  padding: "4px 8px",
  fontSize: 11.5,
  color: "var(--text-secondary)",
};

export const Above = () => (
  <div style={stage}>
    <Tooltip defaultOpen>
      <TooltipTrigger asChild>
        <button style={trigger}>Reindex workspace</button>
      </TooltipTrigger>
      <TooltipContent side="top">Rebuilds the file index</TooltipContent>
    </Tooltip>
  </div>
);

export const Below = () => (
  <div style={{ ...stage, alignItems: "flex-start" }}>
    <Tooltip defaultOpen>
      <TooltipTrigger asChild>
        <button style={trigger}>Checkpoint</button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Snapshot this session</TooltipContent>
    </Tooltip>
  </div>
);

export const LongerCopy = () => (
  <div style={stage}>
    <Tooltip defaultOpen>
      <TooltipTrigger asChild>
        <button style={trigger}>Cloud capture</button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <span style={{ display: "block", maxWidth: 190 }}>
          Session capture is org-scoped and stays on this machine until you opt in.
        </span>
      </TooltipContent>
    </Tooltip>
  </div>
);

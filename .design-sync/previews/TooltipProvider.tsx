import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "atlas";

/**
 * The provider carries the shared skip-delay group: once one tooltip has
 * opened, moving to a neighbouring trigger shows instantly instead of
 * re-waiting. `Tooltip` self-wraps one, so this is only needed at the app
 * root — where it turns a row of triggers into a single control.
 */
const stage: React.CSSProperties = {
  height: 120,
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "center",
  gap: 8,
};
const chip: React.CSSProperties = {
  borderRadius: 4,
  border: "1px solid var(--border-default)",
  background: "var(--bg-raised)",
  padding: "4px 8px",
  fontSize: 11,
  color: "var(--text-secondary)",
};

export const AroundAFacepile = () => (
  <TooltipProvider delayDuration={200} skipDelayDuration={400}>
    <div style={stage}>
      {[
        ["Claude", "Claude Code session"],
        ["Codex", "Codex session"],
        ["Atlas", "Native Atlas agent"],
      ].map(([label, copy], i) => (
        <Tooltip key={label} defaultOpen={i === 1}>
          <TooltipTrigger asChild>
            <span style={chip}>{label}</span>
          </TooltipTrigger>
          <TooltipContent side="top">{copy}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  </TooltipProvider>
);

export const CustomDelays = () => (
  <TooltipProvider delayDuration={0} skipDelayDuration={0}>
    <div style={stage}>
      <Tooltip defaultOpen>
        <TooltipTrigger asChild>
          <span style={chip}>Instant</span>
        </TooltipTrigger>
        <TooltipContent side="top">delayDuration = 0</TooltipContent>
      </Tooltip>
    </div>
  </TooltipProvider>
);

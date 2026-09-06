import { Tooltip, TooltipTrigger, TooltipContent } from "atlas";

/**
 * `TooltipTrigger` only renders inside a `Tooltip`, so every cell is the full
 * composition. `asChild` merges the trigger onto your own element — pass a
 * plain element, not a wrapper component, or the merged props are dropped.
 */
const stage: React.CSSProperties = {
  height: 120,
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "center",
};
const chip: React.CSSProperties = {
  borderRadius: 4,
  border: "1px solid var(--border-default)",
  background: "var(--bg-raised)",
  padding: "4px 8px",
  fontSize: 11.5,
  color: "var(--text-secondary)",
};

export const AsChildButton = () => (
  <div style={stage}>
    <Tooltip defaultOpen>
      <TooltipTrigger asChild>
        <button style={chip}>Trigger as a button</button>
      </TooltipTrigger>
      <TooltipContent side="top">asChild merges onto your element</TooltipContent>
    </Tooltip>
  </div>
);

export const AsChildIcon = () => (
  <div style={stage}>
    <Tooltip defaultOpen>
      <TooltipTrigger asChild>
        <span
          style={{
            display: "grid",
            placeItems: "center",
            width: 24,
            height: 24,
            borderRadius: 4,
            background: "var(--bg-hover)",
            fontSize: 11,
            color: "var(--text-secondary)",
          }}
        >
          ⌘
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">Command palette</TooltipContent>
    </Tooltip>
  </div>
);

export const DefaultElement = () => (
  <div style={stage}>
    <Tooltip defaultOpen>
      <TooltipTrigger
        style={{
          background: "none",
          border: 0,
          fontSize: 11.5,
          color: "var(--text-secondary)",
          textDecoration: "underline dotted",
        }}
      >
        Without asChild
      </TooltipTrigger>
      <TooltipContent side="top">Renders its own button element</TooltipContent>
    </Tooltip>
  </div>
);

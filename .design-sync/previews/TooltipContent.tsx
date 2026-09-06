import { Tooltip, TooltipTrigger, TooltipContent } from "atlas";

/**
 * The panel itself: `--bg-overlay` fill, hairline outline, and a border-arrow
 * whose notch is bound to the same two tokens. Rendered inside its `Tooltip`
 * because that is the only render that is true.
 */
const Cell = ({
  side,
  label,
  children,
}: {
  side: "top" | "bottom" | "right";
  label: string;
  children: React.ReactNode;
}) => (
  <div
    style={{
      height: 130,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}
  >
    <Tooltip defaultOpen>
      <TooltipTrigger asChild>
        <button
          style={{
            borderRadius: 4,
            border: "1px solid var(--border-default)",
            background: "var(--bg-raised)",
            padding: "4px 8px",
            fontSize: 11.5,
            color: "var(--text-secondary)",
          }}
        >
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent side={side}>{children}</TooltipContent>
    </Tooltip>
  </div>
);

export const Top = () => (
  <Cell side="top" label="Top">
    Anchored above the trigger
  </Cell>
);
export const Bottom = () => (
  <Cell side="bottom" label="Bottom">
    Anchored below
  </Cell>
);
export const Right = () => (
  <Cell side="right" label="Right">
    Anchored to the side
  </Cell>
);
export const Wrapped = () => (
  <Cell side="top" label="Long copy">
    <span style={{ display: "block", maxWidth: 190 }}>
      Text balances and wraps inside the panel at its natural width.
    </span>
  </Cell>
);

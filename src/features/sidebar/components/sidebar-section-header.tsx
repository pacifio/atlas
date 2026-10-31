// A section heading in the session list: the label, a hairline to the edge,
// and a chevron. The Snoozed and Settled shelves' toggle.

import type { ComponentProps, ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const tones = {
  muted: { label: "text-muted-foreground", line: "bg-border-subtle" },
  accent: { label: "text-primary", line: "bg-primary/50" },
  info: { label: "text-info", line: "bg-info/40" },
} as const;

export function CollapsibleSectionHeader({
  children,
  expanded,
  tone = "muted",
  accessory,
  ...buttonProps
}: Omit<ComponentProps<"button">, "className" | "style" | "aria-expanded"> & {
  expanded: boolean;
  tone?: keyof typeof tones;
  accessory?: ReactNode;
}) {
  return (
    <button
      {...buttonProps}
      type="button"
      aria-expanded={expanded}
      className={cn(
        "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        tones[tone].label,
      )}
    >
      <span className="shrink-0">{children}</span>
      <span aria-hidden className={cn("h-px min-w-2 flex-1", tones[tone].line)} />
      {accessory}
      <ChevronDown
        aria-hidden
        className={cn("size-3 shrink-0 transition-transform", !expanded && "rotate-180")}
      />
    </button>
  );
}

/** A static heading for a section that does not collapse, and the drop
 *  boundary a drag lights up. */
export function SidebarSectionLabel({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: keyof typeof tones;
}) {
  return (
    <div className={cn("flex h-7 items-center gap-2 px-2 text-xs font-medium", tones[tone].label)}>
      <span className="shrink-0">{children}</span>
      <span aria-hidden className={cn("h-px min-w-2 flex-1", tones[tone].line)} />
    </div>
  );
}

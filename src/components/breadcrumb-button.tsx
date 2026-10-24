import type { ComponentProps, ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * One segment of the top bar's `org / project` breadcrumb.
 *
 * Plain text on the bar — but each segment opens something, and text alone does not say so. The chevron is
 * always there (not only on hover) because a control you have to discover by
 * pointing at it is one most people never find; hover then gives the segment
 * its shape, and an open menu keeps it lit.
 *
 * A function component that spreads its props onto the `<button>`, so it can
 * be handed to a Base UI trigger's `render` and receive the trigger's props
 * and ref.
 */
export function BreadcrumbButton({
  children,
  trailing,
  className,
  ...props
}: ComponentProps<"button"> & {
  /** Rendered between the label and the chevron (the capture status dot). */
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "group flex h-6 min-w-0 cursor-pointer items-center gap-1 rounded-md pr-1 pl-1.5 text-sm leading-none outline-none",
        "text-muted-foreground transition-colors hover:bg-element-hover hover:text-foreground",
        "data-popup-open:bg-element-selected data-popup-open:text-foreground",
        className,
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
      {trailing}
      <ChevronDown
        size={12}
        className="shrink-0 text-muted-foreground opacity-70 transition-opacity group-hover:opacity-100"
      />
    </button>
  );
}

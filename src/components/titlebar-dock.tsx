import type { ReactElement, ReactNode } from "react";

import { cn } from "@/lib/utils";
import { HintGroup, HintItem } from "@/ui/hint-group";

export interface DockItem {
  /** Stable identity, and the tooltip's text. */
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** The corner dot — update-ready, unread, needs-attention. */
  badge?: ReactNode;
  /** Overrides `label` for the accessible name where it says more. */
  title?: string;
}

/** The titlebar pill uses the same sliding, accessible hints as other toolbars. */
export function TitlebarDock({
  items,
  trailing,
  className,
}: {
  items: DockItem[];
  /** The hosted control must forward aria-describedby to its focusable element. */
  trailing?: { label: string; node: ReactElement<Record<string, unknown>> };
  className?: string;
}) {
  return (
    <HintGroup>
      <div className={cn("relative", className)}>
        <div className="flex h-6 items-center gap-1 rounded-full border border-border-subtle bg-card px-1 py-0.5">
          {items.map((item) => (
            <HintItem key={item.label} label={item.label}>
              <button
                type="button"
                onClick={item.onClick}
                disabled={item.disabled}
                aria-label={item.title ?? item.label}
                className={cn(
                  "relative flex size-5 items-center justify-center rounded-full outline-none",
                  "text-muted-foreground transition-colors duration-150",
                  item.disabled
                    ? "cursor-default opacity-60"
                    : "cursor-pointer hover:bg-element-hover hover:text-foreground",
                )}
              >
                {item.icon}
                {item.badge}
              </button>
            </HintItem>
          ))}
          {trailing && <HintItem label={trailing.label}>{trailing.node}</HintItem>}
        </div>
      </div>
    </HintGroup>
  );
}

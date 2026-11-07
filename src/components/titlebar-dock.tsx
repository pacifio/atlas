// The titlebar action row shares the sliding hints used by other toolbars.
import { HintGroup, HintItem } from "@tryatlas/design";
import { cn } from "@/lib/utils";

export interface DockItem {
  /** Stable identity, and the tooltip's text. */
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** The corner dot — update-ready, unread, needs-attention. */
  badge?: React.ReactNode;
  /** Overrides `label` for the accessible name where it says more. */
  title?: string;
  /** A toggle that is on. */
  pressed?: boolean;
}

export function TitlebarDock({
  items,
  trailing,
  className,
}: {
  items: DockItem[];
  /** A hosted control keeps ownership of its trigger and event handlers. */
  trailing?: { label: string; node: React.ReactNode };
  className?: string;
}) {
  return (
    <HintGroup side="bottom">
      <div className={cn("relative", className)}>
        <div className="flex items-center gap-0.5">
          {items.map((item) => (
            <HintItem key={item.label} label={item.label}>
              <button
                type="button"
                onClick={item.onClick}
                disabled={item.disabled}
                aria-pressed={item.pressed}
                aria-label={item.title ?? item.label}
                className={cn(
                  "relative flex size-6 items-center justify-center rounded-md outline-none",
                  "text-muted-foreground transition-colors duration-150",
                  item.disabled
                    ? "cursor-default opacity-60"
                    : "cursor-pointer hover:bg-element-hover hover:text-foreground",
                  "aria-pressed:bg-element-selected aria-pressed:text-foreground",
                )}
              >
                {item.icon}
                {item.badge}
              </button>
            </HintItem>
          ))}
          {trailing && (
            <HintItem label={trailing.label}>
              <span className="flex items-center">{trailing.node}</span>
            </HintItem>
          )}
        </div>
      </div>
    </HintGroup>
  );
}

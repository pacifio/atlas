// The overlay's row kit:
//
//   ContextSection   (a titled group, divider above)
//   ContextRow       (one full-width action)
//   ContextSplitRow  (an action, a divider, a ▾ menu)
//
// The classes are module constants built from Atlas's tokens (`element-hover`,
// `secondary-foreground`, the type scale), so no theme has to restate a
// black/white alpha for a fixed-alpha hover fill.

import type { ComponentProps, ReactNode } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/ui/dropdown-menu";

import { useSessionDetailsStore, type CollapsibleSection } from "../stores/session-details-store";

/** One row's box: a 32px row, a 10px inset and gap. */
const ROW =
  "flex h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm font-medium text-secondary-foreground outline-none transition-colors";
const ROW_INTERACTIVE =
  "cursor-pointer hover:bg-element-hover hover:text-foreground focus-visible:bg-element-hover data-popup-open:bg-element-hover";
const ROW_DISABLED = "cursor-default opacity-60";

/** The glyph at a row's start. */
export function RowIcon({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return <Icon size={14} className={cn("shrink-0 text-muted-foreground", className)} aria-hidden />;
}

/** The label: takes the room, truncates. */
export function RowLabel({ children }: { children: ReactNode }) {
  return <span className="min-w-0 flex-1 truncate">{children}</span>;
}

/** Quiet trailing text — a count, a number, a state. */
export function RowMeta({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn("shrink-0 text-2xs font-normal text-muted-foreground tabular-nums", className)}
    >
      {children}
    </span>
  );
}

/**
 * A titled group. `showHeading={false}` keeps the title for screen readers
 * only: the Workspace and Version control groups read as rows with no
 * heading.
 *
 * `collapse` makes the heading a disclosure the reader can fold, remembered
 * across sessions (`collapsed` in the Details store). Its `badge` (a count,
 * "2 running") stays beside the title folded or not: that count is the whole
 * value of a folded section.
 */
export function ContextSection({
  title,
  showHeading = true,
  separated = true,
  actions,
  collapse,
  children,
}: {
  title: string;
  showHeading?: boolean;
  separated?: boolean;
  actions?: ReactNode;
  collapse?: { id: CollapsibleSection; badge?: string; badgeTitle?: string };
  children: ReactNode;
}) {
  const collapsed = useSessionDetailsStore((s) => (collapse ? !!s.collapsed[collapse.id] : false));
  return (
    <section
      aria-label={title}
      data-details-section={collapse?.id}
      className={cn("px-1.5 pt-1.5 pb-1.5", separated && "border-t border-border")}
    >
      {showHeading && (
        <div className="flex min-h-7 min-w-0 items-center justify-between gap-2 px-2.5">
          {collapse ? (
            <button
              type="button"
              aria-expanded={!collapsed}
              onClick={() => useSessionDetailsStore.getState().actions.toggleSection(collapse.id)}
              className="-mx-1 flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-left outline-none transition-colors hover:text-foreground focus-visible:bg-element-hover"
            >
              <h3 className="min-w-0 truncate text-2xs font-medium text-muted-foreground select-none">
                {title}
              </h3>
              {collapse.badge && (
                <span
                  title={collapse.badgeTitle}
                  className="shrink-0 text-2xs text-muted-foreground tabular-nums"
                >
                  {collapse.badge}
                </span>
              )}
              <ChevronDown
                size={12}
                aria-hidden
                className={cn(
                  "shrink-0 text-muted-foreground transition-transform duration-fast",
                  collapsed && "-rotate-90",
                )}
              />
            </button>
          ) : (
            <h3 className="min-w-0 truncate text-2xs font-medium text-muted-foreground select-none">
              {title}
            </h3>
          )}
          {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
        </div>
      )}
      {!collapsed && children}
    </section>
  );
}

/** One full-width action. Without `onClick` it is a plain fact row. */
export function ContextRow({
  onClick,
  disabled,
  title,
  className,
  children,
}: {
  onClick?: () => void;
  disabled?: boolean;
  /** Native tooltip — the row's full value when the label truncates. */
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  if (!onClick) {
    return (
      <div title={title} className={cn(ROW, className)}>
        {children}
      </div>
    );
  }
  return (
    <button
      type="button"
      title={title}
      // `aria-disabled`, not `disabled`: a disabled button takes no hover, and
      // its title is the only place that says why it is off.
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      className={cn(ROW, disabled ? ROW_DISABLED : ROW_INTERACTIVE, className)}
    >
      {children}
    </button>
  );
}

/**
 * An action with a ▾ beside it for the alternatives — a split control
 * ("Open in VS Code ▾", "Push & create PR ▾"). The menu items are the
 * caller's `DropdownMenuItem`s.
 */
export function ContextSplitRow({
  onClick,
  disabled,
  title,
  menuLabel,
  menu,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  /** The ▾'s accessible name. */
  menuLabel: string;
  menu: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex w-full items-center rounded-lg">
      <button
        type="button"
        title={title}
        aria-disabled={disabled || undefined}
        onClick={disabled ? undefined : onClick}
        className={cn(ROW, "flex-1 rounded-e-none", disabled ? ROW_DISABLED : ROW_INTERACTIVE)}
      >
        {children}
      </button>
      <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
      <DropdownMenu>
        {/* The trigger renders the row's own button: the row owns this look,
            not the menu primitive. */}
        <DropdownMenuTrigger render={<MenuButton kind="chevron" aria-label={menuLabel} />} />
        <DropdownMenuContent align="end" className="min-w-48">
          {menu}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * The button a row's menu or picker trigger renders (`kind="row"` is a whole
 * row that opens one, like the branch picker). Its look lives here, not on the
 * `DropdownMenuTrigger` call site: the trigger is a `src/ui` primitive and does
 * not take a restyle, so it renders this instead. Base UI hands it the
 * trigger's props (handlers, aria, ref) through `render`.
 */
export function MenuButton({
  kind,
  className,
  children,
  ...props
}: ComponentProps<"button"> & { kind: "row" | "chevron" }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        kind === "row"
          ? cn(ROW, "pe-0")
          : "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg rounded-s-none text-muted-foreground outline-none transition-colors",
        ROW_INTERACTIVE,
        className,
      )}
    >
      {kind === "chevron" ? <ChevronDown size={14} aria-hidden /> : children}
    </button>
  );
}

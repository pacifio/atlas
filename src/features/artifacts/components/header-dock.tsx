/**
 * The Timeline header's action dock.
 *
 * One pill holding every icon control, in the shape the titlebar dock uses
 * (`components/titlebar-dock.tsx`): a hairline round-ended track, icons as
 * round hover targets inside it, no dividers between them. The controls used to
 * be two bordered segments and a loose button, which drew three boxes in a 32px
 * bar to say one thing — "here are the tab's actions".
 *
 * The controls share one sliding tooltip (`HintGroup`), as the titlebar dock's
 * do: the dock is the group, and each control is a `HintItem` — `DockButton`
 * wraps itself, and the popover triggers wrap their `Trigger` in one.
 *
 * Its own module rather than living in the panel, because the checkpoints picker
 * needs the trigger class too — and importing it from the panel, which imports
 * the picker, is a cycle that happens to work until someone moves a top-level
 * constant.
 */

import { cn } from "@/lib/utils";
import { HintGroup, HintItem, iconButtonVariants } from "@tryatlas/design";

/**
 * The pill that gathers the header's icon controls.
 *
 * **The geometry is concentric, and it has to stay that way.** Round inside
 * round only looks right when the inner radius equals the outer radius minus
 * the padding, and the padding is the same on all four sides: 26px tall
 * (`control-md`, the height of the header's other pills), 3px of inset (2px
 * padding plus the 1px border), 20px buttons (`control-xs`) — so 13 − 3 = 10,
 * the button's own radius. All of it is in px: the spacing scale is rem-based
 * and the app's root font size is not 16px, so an `h-7` pill around px-sized
 * buttons stops being concentric (and stops fitting them). The first pass used
 * 22px buttons with 6px of side padding, which left them tangent to the pill's
 * end caps: a hovered button's fill ran into the border at the ends and the
 * two curves visibly disagreed.
 */
export function HeaderDock({ children }: { children: React.ReactNode }) {
  return (
    <HintGroup>
      <div className="flex h-control-md items-center gap-1.5 rounded-full border border-border-subtle bg-card p-[2px]">
        {children}
      </div>
    </HintGroup>
  );
}

/**
 * The class an icon control wears inside a {@link HeaderDock}: the package's
 * ghost `xs` icon button (20px, `size-control-xs`), round so it sits
 * concentric in the pill.
 *
 * A class rather than a component because the popover triggers own these
 * buttons through `render` and hand them the class directly — including the
 * `data-popup-open` styling that keeps a button lit while its menu is up.
 * (Base UI marks an open trigger `data-popup-open`.) The package's
 * `IconButton` can't stand in: it takes a Lucide icon, and the dock's callers
 * pass nodes (a spinning glyph, a rail mark).
 *
 * `outline-none` and `cursor-pointer` keep today's focus look and pointer: the
 * dock's `HintGroup` already marks the focused control with its hint.
 */
export const DOCK_TRIGGER = cn(
  iconButtonVariants({ variant: "ghost", size: "xs", shape: "round" }),
  "cursor-pointer outline-none data-popup-open:bg-element-active data-popup-open:text-foreground",
);

/** Applied on top of {@link DOCK_TRIGGER} when the control's mode is on. */
export const DOCK_ACTIVE = "bg-element-active text-foreground";

/**
 * A plain button inside the dock. Its tooltip comes from the enclosing
 * `HintGroup`; one used outside a dock needs a group of its own.
 */
export function DockButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <HintItem label={label}>
      <button
        type="button"
        aria-pressed={active}
        onClick={onClick}
        className={cn(DOCK_TRIGGER, active && DOCK_ACTIVE)}
      >
        {children}
      </button>
    </HintItem>
  );
}

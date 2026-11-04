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
 * wraps itself, and the Radix triggers wrap their `Trigger` in one.
 *
 * Its own module rather than living in the panel, because the checkpoints picker
 * needs the trigger class too — and importing it from the panel, which imports
 * the picker, is a cycle that happens to work until someone moves a top-level
 * constant.
 */

import { cn } from "@/lib/utils";
import { HintGroup, HintItem } from "@tryatlas/design";

/**
 * The pill that gathers the header's icon controls.
 *
 * **The geometry is concentric, and it has to stay that way.** Round inside
 * round only looks right when the inner radius equals the outer radius minus
 * the padding, and the padding is the same on all four sides: 28px tall, 4px of
 * inset, 20px buttons — so 14 − 4 = 10, the button's own radius. The first pass
 * used 22px buttons with 6px of side padding, which left them tangent to the
 * pill's end caps: a hovered button's fill ran into the border at the ends and
 * the two curves visibly disagreed.
 */
export function HeaderDock({ children }: { children: React.ReactNode }) {
  return (
    <HintGroup>
      <div className="flex h-7 items-center gap-1.5 rounded-full border border-border-subtle bg-card p-1">
        {children}
      </div>
    </HintGroup>
  );
}

/**
 * The class an icon control wears inside a {@link HeaderDock}.
 *
 * Exported rather than wrapped in a component because the popover triggers own
 * these buttons through `render` and hand them the class directly — including
 * the `data-popup-open` styling that keeps a button lit while its menu is up.
 * (Base UI marks an open trigger `data-popup-open`; Radix used
 * `data-[state=open]`.)
 */
export const DOCK_TRIGGER =
  "relative flex size-5 cursor-pointer items-center justify-center rounded-full outline-none " +
  "text-[var(--muted-foreground)] transition-colors duration-150 hover:bg-element-active hover:text-[var(--foreground)] " +
  "data-popup-open:bg-element-active data-popup-open:text-[var(--foreground)]";

/** Applied on top of {@link DOCK_TRIGGER} when the control's mode is on. */
export const DOCK_ACTIVE = "bg-element-active text-[var(--foreground)]";

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

import { Button as BaseButton } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { resolveClassName } from "@/ui/button";
import { Icon, type IconSize } from "@/ui/icon";

/**
 * A square, icon-only button (decision 32), built on `@base-ui/react/button`
 * — see `button.tsx` for why and what that buys.
 *
 * shadcn covers this with `<Button size="icon">`; Atlas gives it its own
 * component because the icon-only control is the single most common thing in
 * this UI (titlebar, every panel header, every row affordance) and it has one
 * rule the text button does not: **it must carry a label**. `label` is required,
 * becomes the `aria-label`, and is what a `Tooltip` wrapper should show.
 *
 * The square is a control height, and the glyph inside is one step down from
 * it, so the icon never crowds its box:
 *
 *     xs 20px → icon xs (10)   sm 24px → icon sm (12)
 *     md 26px → icon sm (12)   lg 32px → icon md (14)
 *
 * `focusableWhenDisabled` defaults to `false`, same as `Button` — see there.
 * Atlas's own hint system (`Hint` / `HintGroup`, `src/ui/tooltip.tsx`) already
 * puts a tooltip on a disabled icon button explaining why; that tooltip is
 * only reachable by keyboard when the call site opts into
 * `focusableWhenDisabled` explicitly, since most disabled icon buttons in this
 * UI carry no such explanation and keeping them out of the tab order by
 * default is the less surprising choice.
 */
const iconButtonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center",
    "rounded border border-transparent select-none",
    "transition-colors duration-fast ease-out-strong",
    "data-disabled:cursor-not-allowed data-disabled:opacity-50",
    // A toggle (`aria-pressed`) that is on reads as selected, in any variant.
    "aria-pressed:bg-element-selected aria-pressed:text-foreground",
    "[&_svg]:pointer-events-none",
  ],
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover",
        destructive: "bg-destructive text-destructive-foreground hover:opacity-90",
        outline: "border-border bg-transparent text-foreground hover:bg-element-hover",
        secondary: "bg-card text-foreground hover:bg-element-hover",
        ghost: "bg-transparent text-muted-foreground hover:bg-element-hover hover:text-foreground",
        // `hairline` is the rail footer's pair (help, interface scale): a
        // quiet glyph inside a subtle ring, so the controls read as present
        // but sit back from the card. Both open a popup, and stay lit while
        // it is open (`aria-expanded`, which only popup triggers set — a
        // tooltip's own open state must not light it).
        hairline: [
          "border-border-subtle bg-transparent text-muted-foreground",
          "hover:bg-element-hover hover:text-foreground",
          "aria-expanded:bg-element-hover aria-expanded:text-foreground",
        ],
      },
      size: {
        xs: "size-control-xs",
        sm: "size-control-sm",
        md: "size-control-md",
        lg: "size-control-lg",
      },
      // `round` is the stepper's shape (the −/+ either side of a value), where a
      // pair of circles reads as one control rather than two square buttons.
      shape: {
        square: "",
        round: "rounded-full",
      },
      // `active` is a control whose setting is on at rest — a filter that is
      // narrowing the list — so the square keeps the active fill rather than
      // only lighting on hover. It is a look, not a toggle: a menu trigger
      // carrying it is still a menu trigger, so no `aria-pressed`.
      active: {
        true: "bg-element-active text-foreground",
        false: "",
      },
    },
    defaultVariants: { variant: "ghost", size: "md", shape: "square", active: false },
  },
);

/** The glyph step that sits inside each square. */
const GLYPH_FOR_SIZE: Record<
  NonNullable<VariantProps<typeof iconButtonVariants>["size"]>,
  IconSize
> = {
  xs: "xs",
  sm: "sm",
  md: "sm",
  lg: "md",
};

export interface IconButtonProps
  extends Omit<BaseButton.Props, "children">, VariantProps<typeof iconButtonVariants> {
  icon: LucideIcon;
  /** Required: an icon-only control has no visible name. */
  label: string;
  /** Override the glyph step. Rarely needed — the square picks a sensible one. */
  iconSize?: IconSize;
}

function IconButton({
  className,
  variant,
  size,
  shape,
  active,
  icon,
  label,
  iconSize,
  type = "button",
  ...props
}: IconButtonProps) {
  return (
    <BaseButton
      data-slot="icon-button"
      type={type}
      aria-label={label}
      className={(state) =>
        cn(iconButtonVariants({ variant, size, shape, active }), resolveClassName(className, state))
      }
      {...props}
    >
      <Icon icon={icon} size={iconSize ?? GLYPH_FOR_SIZE[size ?? "md"]} />
    </BaseButton>
  );
}

export { IconButton, iconButtonVariants };

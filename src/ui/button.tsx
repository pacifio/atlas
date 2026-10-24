import { Button as BaseButton } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * The house button (decision 32), built on `@base-ui/react/button`.
 *
 * Shaped like shadcn's base-style `Button` — same file, same `buttonVariants`
 * export, same `variant` / `size` prop pair, same `data-slot` — so a later
 * `shadcn add <component>` that renders a button drops in without a rewrite.
 * What differs is deliberate:
 *
 *  - **Sizes are Atlas control heights**, not shadcn's 32/36/40px. Atlas is a
 *    dense, px-based UI; `md` (26px) is the compact control the audit found
 *    everywhere, and it is the default.
 *  - **No `asChild`.** shadcn's version leans on a Slot primitive; this one
 *    takes Base UI's own `render` prop instead — `<Button render={<a
 *    href="/x" />}>` composes the element the same way, with props merged by
 *    Base UI rather than a Slot clone. (Base UI's own guidance is to reserve
 *    `render` for composing with *other components*, e.g. a Dialog/Menu
 *    trigger — a plain link that should look like a button is styled
 *    directly with `buttonVariants({ variant, size })` on an `<a>`, since a
 *    link has its own keyboard semantics that Button's `role="button"`
 *    handling isn't meant to replace.)
 *  - **Hover uses real tokens**, not `/90` opacity modifiers, which Tailwind v4
 *    compiles to `color-mix()`.
 *
 * `focusableWhenDisabled` defaults to Base UI's own default (`false`) — a
 * disabled button is out of the tab order unless a call site opts in. See
 * `IconButton` for why icon-only controls with a hint explaining the disabled
 * state are the case that wants it.
 */
const buttonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap",
    "rounded border border-transparent font-medium select-none",
    "transition-colors duration-fast ease-out-strong",
    "data-disabled:cursor-not-allowed data-disabled:opacity-50",
    // A toggle (`aria-pressed`) that is on reads as selected, in any variant —
    // the same rule as `IconButton`.
    "aria-pressed:border-border-strong aria-pressed:bg-element-selected aria-pressed:text-foreground",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover",
        destructive: "bg-destructive text-destructive-foreground hover:opacity-90",
        outline: "border-border bg-transparent text-foreground hover:bg-element-hover",
        secondary: "bg-card text-foreground hover:bg-element-hover",
        ghost:
          "bg-transparent text-secondary-foreground hover:bg-element-hover hover:text-foreground",
        // An action that answers a problem: conflicts to resolve, runs waiting
        // for approval. The border and text carry the tone; hover tints it.
        "destructive-outline": "border-error bg-transparent text-error hover:bg-error-muted",
        "warning-outline": "border-warning bg-transparent text-warning hover:bg-warning-muted",
        link: "bg-transparent text-foreground underline-offset-2 hover:underline",
      },
      size: {
        xs: "h-control-xs gap-1 px-1.5 text-2xs",
        sm: "h-control-sm px-2 text-xs",
        md: "h-control-md px-2.5 text-xs",
        lg: "h-control-lg px-3 text-sm",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

export interface ButtonProps extends BaseButton.Props, VariantProps<typeof buttonVariants> {}

function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return (
    <BaseButton
      data-slot="button"
      type={type}
      className={(state) =>
        cn(buttonVariants({ variant, size }), resolveClassName(className, state))
      }
      {...props}
    />
  );
}

/** `className` accepts Base UI's plain-string form as well as its state-function form. */
function resolveClassName<S>(
  className: string | ((state: S) => string | undefined) | undefined,
  state: S,
) {
  return typeof className === "function" ? className(state) : className;
}

export { Button, buttonVariants, resolveClassName };

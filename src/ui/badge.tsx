import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * A status pill (decision 32).
 *
 * shadcn's base-style `Badge` in shape — a `<span>`, a `data-slot`, an exported
 * `badgeVariants` for composing onto a link — with the four Atlas status roles
 * added, because that is what the badges in this app actually say. Colour comes
 * from the status tokens the theme resolves, never from a literal.
 *
 * A badge is not a control, so it is not on the control-height scale: it sizes
 * itself to its text. Reach for `Kbd` instead when the content is a keystroke.
 */
const badgeVariants = cva(
  [
    "inline-flex w-fit shrink-0 items-center justify-center gap-1",
    "rounded border px-1.5 py-px font-medium whitespace-nowrap select-none",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-card text-secondary-foreground",
        outline: "border-border bg-transparent text-secondary-foreground",
        destructive: "border-transparent bg-error-muted text-error",
        success: "border-transparent bg-success-muted text-success",
        warning: "border-transparent bg-warning-muted text-warning",
        severe: "border-transparent bg-severe-muted text-severe",
        info: "border-transparent bg-info-muted text-info",
      },
      size: {
        sm: "text-3xs",
        md: "text-2xs",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface BadgeProps
  extends React.ComponentProps<"span">, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };

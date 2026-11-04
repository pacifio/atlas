import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * The house text field (decision 32).
 *
 * shadcn's base-style `Input` in shape — one `<input>`, a `data-slot`, class
 * composition through `className` — sized on the Atlas control heights and
 * drawn with the theme's own `--input` / `--border` tokens.
 *
 * It keeps the global `:focus-visible` ring rather than drawing its own: one
 * focus indicator across the whole app is the point of decision 31. The border
 * still lifts to `--border-strong` on focus, which is the "this field is live"
 * signal a ring alone does not give a mouse user.
 */
const inputVariants = cva(
  [
    "w-full min-w-0 rounded border bg-panel-input text-foreground",
    "border-border transition-colors duration-fast ease-out-strong",
    "placeholder:text-muted-foreground",
    "focus:border-border-strong",
    "disabled:cursor-not-allowed disabled:opacity-50",
    "aria-invalid:border-destructive",
  ],
  {
    variants: {
      size: {
        xs: "h-control-xs px-1.5 text-2xs",
        sm: "h-control-sm px-2 text-xs",
        md: "h-control-md px-2 text-xs",
        lg: "h-control-lg px-2.5 text-sm",
      },
    },
    defaultVariants: { size: "md" },
  },
);

export interface InputProps
  extends Omit<React.ComponentProps<"input">, "size">, VariantProps<typeof inputVariants> {}

function Input({ className, size, type = "text", ...props }: InputProps) {
  return (
    <input
      data-slot="input"
      type={type}
      className={cn(inputVariants({ size }), className)}
      {...props}
    />
  );
}

export { Input, inputVariants };

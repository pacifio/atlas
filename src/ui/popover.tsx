import * as React from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { cn } from "@/lib/utils";

/**
 * The house popover (decision 16), built on `@base-ui/react/popover`.
 *
 * Shaped like shadcn's base-style `popover` — same exports, same `data-slot`,
 * the positioning quartet declared on `PopoverContent` — so a later
 * `shadcn add` drops in with the classes swapped rather than the structure
 * rewritten.
 *
 * Anatomy is `Portal > Positioner > Popup`. The positioning props must be
 * *forwarded* to the Positioner: left in `...props` they land on the Popup,
 * which is the wrong node, and nothing type-errors.
 *
 * Scales: `rounded-lg` (the popover step), `shadow-md` (`--elevation-menu`),
 * and the `z-popover` layer on the Positioner — the Popup is static inside it,
 * so a z-index on the Popup would do nothing at all.
 */

function Popover(props: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root {...props} />;
}

function PopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverPortal(props: PopoverPrimitive.Portal.Props) {
  return <PopoverPrimitive.Portal {...props} />;
}

function PopoverClose(props: PopoverPrimitive.Close.Props) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

function PopoverContent({
  className,
  align = "center",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  surface = "default",
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset"> & {
    /**
     * `tinted` is the two-surface recipe the agent/model picker and org
     * switcher use: the popup is the foreground at 4% over the background (the
     * popover token is a grey slab beside an inset card) under the raised-rung
     * shadow, and the controls sit in an inset card on the app's own
     * background inside it.
     */
    surface?: "default" | "tinted";
  }) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        className="isolate z-popover outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "max-h-(--available-height) w-72 overflow-hidden rounded-lg",
            surface === "tinted"
              ? "bg-[color-mix(in_srgb,var(--foreground)_4%,var(--background))] p-1.5 shadow-sm"
              : "bg-popover p-2.5 shadow-md",
            "border border-border text-foreground",
            "text-sm outline-none",
            "origin-[var(--transform-origin)] animate-scale-in",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-0.5 pb-1.5", className)}
      {...props}
    />
  );
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      data-slot="popover-title"
      className={cn("label text-foreground", className)}
      {...props}
    />
  );
}

function PopoverDescription({ className, ...props }: PopoverPrimitive.Description.Props) {
  return (
    <PopoverPrimitive.Description
      data-slot="popover-description"
      className={cn("caption", className)}
      {...props}
    />
  );
}

export {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverPortal,
  PopoverTitle,
  PopoverTrigger,
};

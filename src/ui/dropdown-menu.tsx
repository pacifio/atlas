import * as React from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Check, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The house dropdown menu (decision 16), built on `@base-ui/react/menu`.
 *
 * Base UI has no "DropdownMenu": a trigger-anchored menu *is* `Menu`. The
 * public names stay shadcn's `DropdownMenu*` so call sites read the same as
 * everywhere else, and the file keeps shadcn's base-style shape — same exports,
 * same `data-slot`, same `inset` / `variant` prop pair — so a later
 * `shadcn add` drops in with the classes swapped rather than the structure
 * rewritten.
 *
 * Anatomy is `Portal > Positioner > Popup`. Positioning props belong to the
 * Positioner; they are declared on `DropdownMenuContent` and forwarded, because
 * left in `...props` they would land on the Popup and positioning would break
 * with no type error.
 *
 * Scales: `rounded-lg`, `shadow-md` (`--elevation-menu`), and the `z-popover`
 * layer — which is *above* `z-modal` on purpose, so a menu opened inside a
 * dialog escapes it.
 */

function DropdownMenu(props: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root {...props} />;
}

function DropdownMenuPortal(props: MenuPrimitive.Portal.Props) {
  return <MenuPrimitive.Portal {...props} />;
}

function DropdownMenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

function DropdownMenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot {...props} />;
}

/** The shared popup surface, so Content and SubContent cannot drift apart. */
const POPUP = [
  "max-h-(--available-height) min-w-[11rem] overflow-y-auto overflow-x-hidden",
  "rounded-lg p-0.5",
  "bg-popover border border-border text-foreground shadow-md",
  "origin-[var(--transform-origin)] animate-scale-in outline-none",
];

/** `anchor` positions the menu against another element than its trigger:
 *  a split row's ⌄ opens a menu lined up with (and as wide as) the row. */
type PositionerProps = Pick<
  MenuPrimitive.Positioner.Props,
  "align" | "alignOffset" | "side" | "sideOffset" | "anchor"
>;

function DropdownMenuContent({
  className,
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  anchor,
  ...props
}: MenuPrimitive.Popup.Props & PositionerProps) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="isolate z-popover outline-none"
        anchor={anchor}
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(POPUP, className)}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & { inset?: boolean }) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={inset ? "" : undefined}
      className={cn("eyebrow px-2 py-1 text-muted-foreground", "data-[inset]:pl-7", className)}
      {...props}
    />
  );
}

const ITEM = [
  "group/dropdown-menu-item relative flex items-center gap-2 rounded px-2 py-1",
  "text-xs cursor-pointer select-none outline-none",
  "text-secondary-foreground",
  "focus:bg-element-hover focus:text-foreground",
  "data-[inset]:pl-6",
  "data-[variant=destructive]:text-error data-[variant=destructive]:focus:text-error",
  "data-disabled:pointer-events-none data-disabled:opacity-50",
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
];

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset ? "" : undefined}
      data-variant={variant}
      className={cn(ITEM, className)}
      {...props}
    />
  );
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & { inset?: boolean }) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset ? "" : undefined}
      className={cn(
        ITEM,
        "data-popup-open:bg-element-hover data-popup-open:text-foreground",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

/**
 * Composes the public Content wrapper. The four positioning defaults are the
 * submenu's visual alignment with its parent item and are load-bearing: Radix's
 * `SubContent` implied them, Base UI's Positioner does not.
 */
function DropdownMenuSubContent({
  className,
  align = "start",
  alignOffset = -3,
  side = "right",
  sideOffset = 0,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      data-slot="dropdown-menu-sub-content"
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      className={cn("w-auto min-w-[10rem]", className)}
      {...props}
    />
  );
}

const MARKED_ITEM = [
  "relative flex items-center gap-2 rounded py-1 pr-2 pl-7",
  "text-xs cursor-pointer select-none outline-none",
  "text-secondary-foreground",
  "focus:bg-element-hover focus:text-foreground",
  "data-disabled:pointer-events-none data-disabled:opacity-50",
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
];

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: MenuPrimitive.CheckboxItem.Props) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(MARKED_ITEM, className)}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 inline-flex size-3 items-center justify-center">
        <MenuPrimitive.CheckboxItemIndicator>
          <Check size={12} />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioItem({ className, children, ...props }: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(MARKED_ITEM, className)}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 inline-flex size-3 items-center justify-center">
        <MenuPrimitive.RadioItemIndicator>
          <Check size={12} />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Separator>) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "ml-auto pl-3 text-3xs text-disabled",
        "group-focus/dropdown-menu-item:text-secondary-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};

import * as React from "react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Atlas-themed shadcn-flavored context menu primitive built on
 * `@radix-ui/react-context-menu`. Used by the file-tree row menu and
 * any future surface that needs right-click actions.
 *
 * Styling tokens: `--bg-overlay` for popover bg, `--border-default`
 * for border, `--text-{primary,secondary,tertiary,muted}` for text,
 * `--bg-hover` for focus/hover, `--status-error` for destructive
 * variant. Atlas is dark-only so the shadcn `dark:` variants are
 * dropped.
 */

const ContextMenu = ContextMenuPrimitive.Root;
const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
const ContextMenuGroup = ContextMenuPrimitive.Group;
const ContextMenuPortal = ContextMenuPrimitive.Portal;
const ContextMenuSub = ContextMenuPrimitive.Sub;
const ContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup;

function ContextMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        className={cn(
          "z-[9999] min-w-[11rem] overflow-hidden rounded-md p-0.5",
          "bg-black border border-[var(--border-default)]",
          "shadow-[0_8px_24px_rgba(0,0,0,0.6)]",
          "text-[var(--text-primary)]",
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <ContextMenuPrimitive.Item
      data-inset={inset ? "" : undefined}
      data-variant={variant}
      className={cn(
        "group/context-menu-item relative flex items-center gap-2 rounded px-2 py-1",
        "text-[11.5px] cursor-pointer select-none outline-none",
        "text-[var(--text-secondary)]",
        "focus:bg-[var(--bg-hover)] focus:text-[var(--text-primary)]",
        "data-[inset]:pl-6",
        // `destructive` variant kept for completeness but rendered the
        // same as default — per UX feedback, file-tree Delete reads as
        // a regular item; the confirm dialog is where the destructive
        // affordance lives.
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
  inset?: boolean;
}) {
  return (
    <ContextMenuPrimitive.SubTrigger
      data-inset={inset ? "" : undefined}
      className={cn(
        "flex items-center gap-2 rounded px-2 py-1 text-[11.5px]",
        "cursor-pointer select-none outline-none",
        "text-[var(--text-secondary)]",
        "focus:bg-[var(--bg-hover)] focus:text-[var(--text-primary)]",
        "data-[state=open]:bg-[var(--bg-hover)] data-[state=open]:text-[var(--text-primary)]",
        "data-[inset]:pl-6",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto" />
    </ContextMenuPrimitive.SubTrigger>
  );
}

function ContextMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  return (
    <ContextMenuPrimitive.SubContent
      className={cn(
        "z-[9999] min-w-[10rem] overflow-hidden rounded-md p-0.5",
        "bg-black border border-[var(--border-default)]",
        "shadow-[0_8px_24px_rgba(0,0,0,0.6)]",
        "text-[var(--text-primary)]",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem> & {
  inset?: boolean;
}) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      data-inset={inset ? "" : undefined}
      className={cn(
        "relative flex items-center gap-2 rounded-md py-1.5 pr-8 pl-7 text-[12px]",
        "cursor-default select-none outline-none",
        "text-[var(--text-secondary)]",
        "focus:bg-[var(--bg-hover)] focus:text-[var(--text-primary)]",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
        className,
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 inline-flex h-3 w-3 items-center justify-center">
        <ContextMenuPrimitive.ItemIndicator>
          <Check size={12} />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  );
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & {
  inset?: boolean;
}) {
  return (
    <ContextMenuPrimitive.Label
      data-inset={inset ? "" : undefined}
      className={cn(
        "px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]",
        "data-[inset]:pl-7",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      className={cn("-mx-1 my-1 h-px bg-[var(--border-default)]", className)}
      {...props}
    />
  );
}

function ContextMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "ml-auto pl-3 text-[9.5px] text-[var(--text-muted)]",
        "group-focus/context-menu-item:text-[var(--text-secondary)]",
        className,
      )}
      {...props}
    />
  );
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuRadioGroup,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuCheckboxItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
};

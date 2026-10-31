import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ChevronRight, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Icon } from "@/ui/icon";

/**
 * The command shell: the large search dialog that ⌘K, ⌘P and the new-tab
 * palette all open (decision 32's shape, shadcn's base-style `command`).
 *
 * A centred dialog with no Positioner, the search field on top, a list, and
 * a footer of key hints. It has no open or close animation on purpose — it
 * is opened hundreds of times a day, and a scale-in reads as latency.
 *
 * The keyboard model belongs to the caller: the field keeps focus, the
 * caller tracks the highlighted row and passes `active` to `CommandItem`, so
 * a mouse resting over the list never fights the keys.
 *
 * Scales: `rounded-xl` (the dialog step), `shadow-lg`, `z-overlay` for the
 * scrim and `z-modal` for the dialog.
 */

function CommandDialog(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root {...props} />;
}

function CommandDialogPopup({
  className,
  children,
  title,
  ...props
}: DialogPrimitive.Popup.Props & {
  /** The dialog's accessible name, read out on open. */
  title: string;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        data-slot="command-dialog-backdrop"
        className="fixed inset-0 z-overlay scrim"
      />
      <DialogPrimitive.Popup
        data-slot="command-dialog-popup"
        aria-describedby={undefined}
        className={cn(
          // High rather than centred: the list grows downward, and a centred
          // dialog would move its own field as the results filter.
          "fixed top-[12vh] left-1/2 z-modal -translate-x-1/2",
          "flex w-[min(46rem,calc(100vw-2rem))] max-h-[76vh] flex-col overflow-hidden",
          "rounded-xl border border-border bg-popover text-popover-foreground shadow-lg outline-none",
          className,
        )}
        {...props}
      >
        <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

/** The search field. `startAddon` replaces the magnifier (a back arrow in a
 *  submenu); `endAddon` sits at its right end (a step's "Create ⌘ Enter").
 *  The input is a combobox over the list it controls. */
function CommandInput({
  className,
  startAddon,
  endAddon,
  ...props
}: React.ComponentProps<"input"> & { startAddon?: React.ReactNode; endAddon?: React.ReactNode }) {
  return (
    <div data-slot="command-input" className="flex shrink-0 items-center gap-3 px-5 pt-4 pb-3">
      <span className="flex shrink-0 items-center text-muted-foreground">
        {startAddon ?? <Icon icon={Search} size="lg" />}
      </span>
      <input
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className={cn(
          "min-w-0 flex-1 bg-transparent text-md text-foreground outline-none focus-ring-none",
          "placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
      {endAddon}
    </div>
  );
}

/** The scroll area under the field. */
function CommandPanel({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & {
  /** `tall` is ⌘P's list: the same width, more rows. */
  size?: "default" | "tall";
}) {
  return (
    <div
      data-slot="command-panel"
      role="listbox"
      className={cn(
        "relative min-h-0 overflow-y-auto overscroll-contain px-2 pb-2",
        size === "tall" ? "max-h-[min(42rem,64vh)]" : "max-h-[min(34rem,58vh)]",
        className,
      )}
      {...props}
    />
  );
}

/** A group's small muted header ("Actions", "Recent Sessions", a project). */
function CommandGroupLabel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="command-group-label"
      role="presentation"
      className={cn(
        "px-2 pt-2 pb-1.5 text-xs font-medium text-muted-foreground select-none",
        className,
      )}
      {...props}
    />
  );
}

/** One row. `active` is the keyboard highlight, which the caller owns. */
function CommandItem({
  className,
  active = false,
  disabled = false,
  ...props
}: React.ComponentProps<"div"> & { active?: boolean; disabled?: boolean }) {
  return (
    <div
      data-slot="command-item"
      role="option"
      aria-selected={active}
      aria-disabled={disabled || undefined}
      data-active={active || undefined}
      className={cn(
        "flex min-h-9 w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-md text-foreground select-none",
        disabled ? "disabled-look" : "cursor-pointer",
        active && "bg-element-selected",
        className,
      )}
      {...props}
    />
  );
}

/** The leading glyph, held to the first line of a two-line row. */
function CommandItemIcon({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-item-icon"
      className={cn("flex h-5 shrink-0 items-center self-start text-muted-foreground", className)}
      {...props}
    />
  );
}

/** A chord as plain glyphs on the right of a row ("⌘⇧N") — quieter than
 *  keycaps, which belong to the footer. */
function CommandShortcut({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="command-shortcut"
      className={cn(
        "ms-auto shrink-0 font-sans text-xs font-medium tracking-widest text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** The `>` on a row that drills into a submenu. */
function CommandSubmenuChevron({ className }: { className?: string }) {
  return (
    <Icon
      icon={ChevronRight}
      size="lg"
      className={cn("-me-0.5 ms-auto text-muted-foreground", className)}
    />
  );
}

/** The key legend along the bottom. */
function CommandFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="command-footer"
      className={cn(
        "flex shrink-0 items-center justify-between gap-2 bg-element-hover px-5 py-2.5 text-sm font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** One "keys + label" pair in the footer. */
function CommandFooterHint({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-footer-hint"
      className={cn("inline-flex items-center gap-1.5", className)}
      {...props}
    />
  );
}

/** The centred line a list shows when it has no rows. */
function CommandEmpty({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="command-empty"
      className={cn("py-10 text-center text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandFooterHint,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandItemIcon,
  CommandPanel,
  CommandShortcut,
  CommandSubmenuChevron,
};

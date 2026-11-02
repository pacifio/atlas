import * as React from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The house select, built on `@base-ui/react/select` and ported from the
 * Standards select.
 *
 * It replaces raw `<select>`, which renders as each OS's own popup — the
 * reason a settings row looked different on macOS, Windows and Linux. A select
 * IS a menu of one choice, so the popup is the dropdown-menu surface
 * (`rounded-lg`, `shadow-md`, the `z-popover` layer) and its items share the
 * dropdown item's vocabulary, with the `pl-7` check gutter so labels line up
 * whether or not an item is the selected one.
 *
 * Two trigger looks. `bordered` is a form field. `ghost` sits inside a
 * toolbar or a settings row, where a box around it would be one rectangle
 * too many.
 *
 * Options are data, not children: every call site in the app maps an array to
 * items anyway, and taking the array lets the trigger show the selected
 * option's label (Base UI's `Value` otherwise renders the raw value string).
 */

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** A caption under the label, inside the popup only. */
  description?: string;
  icon?: React.ReactNode;
}

export interface SelectProps<T extends string> {
  value: T;
  onValueChange: (next: T) => void;
  options: readonly SelectOption<T>[];
  disabled?: boolean;
  /** Shown instead of the value, e.g. "Mixed". */
  placeholder?: string;
  size?: "sm" | "md";
  variant?: "bordered" | "ghost";
  "aria-label"?: string;
  /** Applied to the trigger. */
  className?: string;
  /**
   * Draw the selected item's check, and the gutter that holds it (default).
   * `false` for a picker whose choice is acted on and cleared — "invite this
   * person" — where nothing stays selected and the gutter is only a gap.
   */
  indicator?: boolean;
  /** `pill` rounds the trigger's ends — a picker sitting beside round
   *  controls (the sidebar's search row, a glass `+`). */
  shape?: "default" | "pill";
  /** A glyph before the value, inside the trigger. */
  leading?: React.ReactNode;
}

const POPUP = [
  "max-h-(--available-height) min-w-(--anchor-width) overflow-y-auto overflow-x-hidden",
  "rounded-lg p-0.5",
  "bg-popover border border-border text-foreground shadow-md",
  "origin-[var(--transform-origin)] animate-scale-in outline-none",
];

const ITEM = [
  "relative flex cursor-pointer items-center gap-2 rounded py-1 pr-2 pl-7",
  "text-xs select-none outline-none",
  "text-secondary-foreground",
  "focus:bg-element-hover focus:text-foreground",
  "data-selected:text-foreground",
  "data-disabled:pointer-events-none data-disabled:opacity-50",
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
];

export function Select<T extends string>({
  value,
  onValueChange,
  options,
  disabled,
  placeholder,
  size = "md",
  variant = "bordered",
  className,
  indicator = true,
  shape = "default",
  leading,
  ...props
}: SelectProps<T>) {
  const selected = options.find((option) => option.value === value);
  const shown = placeholder ?? selected?.label;

  return (
    <SelectPrimitive.Root<T>
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        data-slot="select-trigger"
        data-size={size}
        data-variant={variant}
        data-shape={shape}
        aria-label={props["aria-label"]}
        className={cn(
          "flex w-fit min-w-0 cursor-pointer items-center justify-between gap-1.5 rounded-md px-2",
          "data-[shape=pill]:rounded-full data-[shape=pill]:pr-2 data-[shape=pill]:pl-2.5",
          "text-xs whitespace-nowrap select-none outline-none",
          "transition-colors duration-fast ease-out-strong",
          "data-[size=md]:h-control-md data-[size=sm]:h-control-sm",
          "data-[variant=bordered]:border data-[variant=bordered]:border-border data-[variant=bordered]:bg-panel-input",
          "data-[variant=bordered]:text-foreground data-[variant=bordered]:hover:border-border-strong",
          "data-[variant=ghost]:text-secondary-foreground data-[variant=ghost]:hover:bg-element-hover data-[variant=ghost]:hover:text-foreground",
          "data-popup-open:bg-element-active",
          "data-disabled:cursor-not-allowed data-disabled:opacity-50",
          "[&_svg]:pointer-events-none [&_svg]:shrink-0",
          className,
        )}
      >
        <span
          data-slot="select-value"
          className={cn(
            "flex min-w-0 items-center gap-1.5 truncate",
            placeholder !== undefined && "text-muted-foreground",
          )}
        >
          {leading && (
            <span className="flex shrink-0 items-center text-muted-foreground">{leading}</span>
          )}
          {placeholder === undefined && selected?.icon}
          <span className="truncate">{shown}</span>
        </span>
        <SelectPrimitive.Icon render={<ChevronDown className="size-3.5 text-muted-foreground" />} />
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          className="isolate z-popover outline-none"
          side="bottom"
          align="start"
          sideOffset={4}
          alignItemWithTrigger={false}
        >
          <SelectPrimitive.Popup data-slot="select-content" className={cn(POPUP)}>
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                data-slot="select-item"
                className={cn(ITEM, !indicator && "pl-2")}
              >
                {indicator && (
                  <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
                    <SelectPrimitive.ItemIndicator>
                      <Check className="size-3.5" />
                    </SelectPrimitive.ItemIndicator>
                  </span>
                )}
                {option.icon}
                <span className="flex min-w-0 flex-col">
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                  {option.description && (
                    <span className="caption text-muted-foreground">{option.description}</span>
                  )}
                </span>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

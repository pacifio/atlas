import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "@/lib/utils";

/**
 * The house on/off control, built on `@base-ui/react/switch` and ported from
 * the Standards switch.
 *
 * A settings row is a label and a description with one of these hard-right.
 * Off is the input fill, on is the primary ink — no green, because "on" is a
 * state, not a success. The `after:` inset widens the hit target past the
 * 16px track without changing the painted size.
 *
 * `mixed` is the indeterminate state a setting has when it differs across a
 * selection (several projects, say): the thumb sits centred, the track takes
 * the input fill, and assistive tech hears `aria-checked="mixed"`. Toggling a
 * mixed switch turns it on, so one click makes every selected target agree.
 */

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  /** Indeterminate: settings that differ across a selection. Thumb centred, aria-checked="mixed". */
  mixed?: boolean;
  size?: "sm" | "md";
  "aria-label"?: string;
  id?: string;
  className?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  mixed = false,
  size = "md",
  className,
  ...props
}: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      data-mixed={mixed ? "" : undefined}
      checked={mixed ? false : checked}
      onCheckedChange={(next) => onCheckedChange(mixed ? true : next)}
      disabled={disabled}
      // Spread only when mixed: an explicit `undefined` would replace the
      // `aria-checked` Base UI computes from `checked`.
      {...(mixed ? { "aria-checked": "mixed" as const } : {})}
      className={cn(
        "group/switch relative inline-flex shrink-0 cursor-pointer items-center rounded-full p-px",
        "transition-colors duration-fast ease-out-strong",
        "after:absolute after:-inset-2",
        "data-[size=md]:h-4 data-[size=md]:w-7",
        "data-[size=sm]:h-3.5 data-[size=sm]:w-6",
        // Off also gets an inset hairline: on a popover in a dark theme the input
        // fill alone is nearly the surface colour, and the track disappears.
        "data-checked:bg-primary data-unchecked:bg-input data-unchecked:ring-1 data-unchecked:ring-border data-unchecked:ring-inset",
        "data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-background",
          "transition-transform duration-fast ease-out-strong",
          "group-data-[size=md]/switch:size-3.5 group-data-[size=sm]/switch:size-3",
          "data-unchecked:translate-x-0",
          "group-data-[size=md]/switch:data-checked:translate-x-3",
          "group-data-[size=sm]/switch:data-checked:translate-x-2.5",
          // Centred: half the travel of the checked position.
          "group-data-[mixed]/switch:group-data-[size=md]/switch:translate-x-1.5",
          "group-data-[mixed]/switch:group-data-[size=sm]/switch:translate-x-1.25",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

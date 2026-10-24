import * as React from "react";
import { useId, useRef } from "react";
import { motion } from "motion/react";

import { cn } from "@/lib/utils";
import { SPRING_INDICATOR } from "@/lib/motion";

/**
 * A segmented control: one choice among a few, all visible at once (theme
 * mode, a density). Ported from the Standards `SegmentedPills`.
 *
 * The options sit in ONE track with a hairline edge, and the active one is a
 * thumb that slides inside it (a shared `layoutId`, `SPRING_INDICATOR`) — so
 * the control reads as one object with parts rather than loose words, and the
 * selection moves instead of cross-fading. The thumb is the selected-element
 * fill, never the primary: this is a choice, not the loudest action on screen.
 *
 * Radio-group semantics: one tab stop (the selected option), arrow keys move
 * the selection, Home/End jump to the ends.
 */

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  /** Draw only the icon; the label stays the option's accessible name and
   *  its tooltip. For a toolbar's icon pair (a diff's layout). */
  iconOnly?: boolean;
}

export interface SegmentedProps<T extends string> {
  value: T;
  onValueChange: (next: T) => void;
  options: readonly SegmentedOption<T>[];
  disabled?: boolean;
  size?: "sm" | "md";
  "aria-label": string;
  className?: string;
}

export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  disabled,
  size = "md",
  className,
  ...props
}: SegmentedProps<T>) {
  const layoutId = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const move = (from: number, to: number) => {
    if (options.length === 0) return;
    const index = (to + options.length) % options.length;
    if (index === from) return;
    onValueChange(options[index].value);
    buttons.current[index]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        move(index, index + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        move(index, index - 1);
        break;
      case "Home":
        event.preventDefault();
        move(index, 0);
        break;
      case "End":
        event.preventDefault();
        move(index, options.length - 1);
        break;
    }
  };

  return (
    <div
      data-slot="segmented"
      role="radiogroup"
      aria-label={props["aria-label"]}
      aria-disabled={disabled || undefined}
      className={cn(
        "flex w-fit max-w-full items-center gap-0.5 rounded-full border border-border p-0.5",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.iconOnly ? option.label : undefined}
            title={option.iconOnly ? option.label : undefined}
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            onClick={() => {
              if (!active) onValueChange(option.value);
            }}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "relative shrink-0 cursor-pointer rounded-full font-medium whitespace-nowrap outline-none",
              "transition-colors duration-fast ease-out-strong",
              "disabled:cursor-not-allowed",
              size === "sm" ? "h-control-xs text-2xs" : "h-control-sm text-xs",
              option.iconOnly
                ? size === "sm"
                  ? "px-1"
                  : "px-1.5"
                : size === "sm"
                  ? "px-2"
                  : "px-2.5",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                transition={SPRING_INDICATOR}
                className="absolute inset-0 rounded-full bg-element-selected"
              />
            )}
            <span className="relative flex items-center gap-1.5">
              {option.icon}
              {!option.iconOnly && option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

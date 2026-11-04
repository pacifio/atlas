import type { KeyboardEvent, MouseEvent } from "react";

/** Arrow-key step in px; Shift takes the bigger one. */
const STEP = 16;
const BIG_STEP = 64;

/**
 * A column's resize handle: a 4px strip on the border, invisible until hover
 * or keyboard focus. The pointer drags it (`onMouseDown`); the keyboard
 * reaches it with Tab and resizes with the arrows (Shift for bigger steps),
 * Home and End jumping to the narrowest and widest. `grows` is the arrow that
 * widens the column: right for a column on the left, left for one on the right.
 * The store clamps every width, so the keys can overshoot safely.
 */
export function ResizeSeparator({
  label,
  width,
  min,
  max,
  grows,
  onResize,
  onMouseDown,
}: {
  label: string;
  width: number;
  min: number;
  max: number;
  grows: "left" | "right";
  onResize: (width: number) => void;
  onMouseDown: (e: MouseEvent) => void;
}) {
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.shiftKey ? BIG_STEP : STEP;
    const sign = grows === "right" ? 1 : -1;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = width + step * sign;
    else if (e.key === "ArrowLeft") next = width - step * sign;
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    if (next === null) return;
    e.preventDefault();
    onResize(Math.max(min, Math.min(next, max)));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      className="z-panel shrink-0 cursor-col-resize outline-none transition-colors duration-fast hover:bg-border-strong/60 focus-visible:bg-primary/60"
      style={{ width: 4, marginLeft: -2, marginRight: -2 }}
    />
  );
}

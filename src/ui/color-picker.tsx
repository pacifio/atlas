import {
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";

import { cn } from "@/lib/utils";
import type { HsvColor } from "@tryatlas/design/theme";

/**
 * The two controls a colour picker is made of: a saturation/brightness plane
 * and a hue slider, both in HSV.
 *
 * Both are pointer-draggable and keyboard-operable: the plane is two hidden
 * range inputs (Tab moves between saturation and brightness), the slider is a
 * `role="slider"`. The picker draws literal colour — pure white, pure black,
 * the hue wheel — whatever the theme is, which is why the few lines below that
 * name one carry a `ratchet-allow`.
 */

const clamp = (value: number) => Math.min(1, Math.max(0, value));

function useColorDrag(
  update: (event: PointerEvent<HTMLDivElement>) => void,
  onInteractionEnd?: () => void,
  focusTarget?: RefObject<HTMLElement | null>,
) {
  const [isDragging, setIsDragging] = useState(false);
  const pointerId = useRef<number | null>(null);
  const stopDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== event.pointerId) return;
    pointerId.current = null;
    setIsDragging(false);
    onInteractionEnd?.();
  };
  return {
    // Eased when a click jumps the thumb, immediate while it follows a drag.
    thumbTransition: isDragging ? undefined : "left 80ms linear, top 80ms linear",
    handlers: {
      onPointerDown(event: PointerEvent<HTMLDivElement>) {
        if (pointerId.current !== null || event.button !== 0) return;
        pointerId.current = event.pointerId;
        (focusTarget?.current ?? event.currentTarget).focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        setIsDragging(true);
        update(event);
      },
      onPointerMove(event: PointerEvent<HTMLDivElement>) {
        if (pointerId.current === event.pointerId) update(event);
      },
      onPointerUp: stopDragging,
      onPointerCancel: stopDragging,
      onLostPointerCapture: stopDragging,
    },
  };
}

interface ColorControlProps<T> {
  label: string;
  value: T;
  onChange: (value: T) => void;
  /** Fires when a drag ends, so a caller batching updates can flush. */
  onInteractionEnd?: () => void;
  className?: string;
}

// ratchet-allow: a picker thumb is a white ring with a dark hairline so it
// reads on every colour the plane can show, which no theme token guarantees.
const THUMB_RING = "border-2 border-white";
const THUMB = cn(
  "pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full",
  THUMB_RING,
);
// ratchet-allow: the thumb's hairline must be dark on any hue, theme or not.
const THUMB_OUTLINE = { boxShadow: "0 0 0 1px rgb(0 0 0 / 0.4)" };
// ratchet-allow: the plane IS pure black over the hue toward the bottom; a theme
// token here would make the picker lie about the colour being picked.
const SHADE_DOWN = "linear-gradient(to top, #000, transparent)";
// ratchet-allow: and pure white toward the left, for the same reason as above.
const SHADE_ACROSS = "linear-gradient(to right, #fff, transparent)";

export function ColorSaturationValuePlane({
  label,
  value,
  onChange,
  onInteractionEnd,
  className,
}: ColorControlProps<HsvColor>) {
  const instructionsId = useId();
  const saturationRef = useRef<HTMLInputElement>(null);
  const { handlers, thumbTransition } = useColorDrag(
    (event) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      onChange({
        ...value,
        s: clamp((event.clientX - bounds.left) / bounds.width),
        v: 1 - clamp((event.clientY - bounds.top) / bounds.height),
      });
    },
    onInteractionEnd,
    saturationRef,
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>, axis: "s" | "v") => {
    const step = event.shiftKey ? 0.1 : 0.02;
    const next =
      event.key === "ArrowRight" || event.key === "ArrowUp"
        ? clamp(value[axis] + step)
        : event.key === "ArrowLeft" || event.key === "ArrowDown"
          ? clamp(value[axis] - step)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? 1
              : null;
    if (next === null) return;
    event.preventDefault();
    onChange({ ...value, [axis]: next });
  };

  return (
    <div
      aria-label={`${label} saturation and brightness`}
      role="group"
      className={cn(
        "relative h-32 cursor-crosshair touch-none overflow-hidden rounded-md",
        "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
        className,
      )}
      style={{
        backgroundImage: `${SHADE_DOWN}, ${SHADE_ACROSS}`,
        // ratchet-allow: the plane's base is the fully saturated hue itself.
        backgroundColor: `hsl(${value.h} 100% 50%)`,
      }}
      {...handlers}
    >
      <span id={instructionsId} className="sr-only">
        Use the arrow keys to adjust, Shift for larger steps, Home and End for the ends. Tab moves
        between saturation and brightness.
      </span>
      {(
        [
          ["s", "Saturation"],
          ["v", "Brightness"],
        ] as const
      ).map(([axis, axisLabel]) => (
        <input
          key={axis}
          ref={axis === "s" ? saturationRef : undefined}
          type="range"
          min={0}
          max={100}
          step="any"
          value={value[axis] * 100}
          aria-label={`${label} ${axisLabel.toLowerCase()}`}
          aria-describedby={instructionsId}
          aria-valuetext={`${Math.round(value[axis] * 100)}%`}
          className="sr-only"
          onKeyDown={(event) => handleKeyDown(event, axis)}
          onChange={(event) =>
            onChange({ ...value, [axis]: event.currentTarget.valueAsNumber / 100 })
          }
        />
      ))}
      <span
        className={cn(THUMB, "size-3")}
        style={{
          ...THUMB_OUTLINE,
          left: `calc(${value.s} * (100% - 0.75rem) + 0.375rem)`,
          top: `calc(${1 - value.v} * (100% - 0.75rem) + 0.375rem)`,
          transition: thumbTransition,
        }}
      />
    </div>
  );
}

export function ColorHueSlider({
  label,
  value,
  onChange,
  onInteractionEnd,
  className,
}: ColorControlProps<number>) {
  const { handlers, thumbTransition } = useColorDrag((event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width) return;
    onChange(clamp((event.clientX - bounds.left) / bounds.width) * 360);
  }, onInteractionEnd);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : -1;
    onChange((value + direction * step + 360) % 360);
  };

  return (
    <div
      aria-label={label}
      aria-valuemax={360}
      aria-valuemin={0}
      aria-valuenow={Math.round(value)}
      className={cn(
        "relative flex h-5 cursor-pointer touch-none items-center rounded-full outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      role="slider"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      {...handlers}
    >
      <span
        aria-hidden
        className="h-2.5 w-full rounded-full"
        style={{
          // ratchet-allow: the hue wheel is the six sRGB primaries by
          // definition; it is the same in every theme.
          backgroundImage: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
        }}
      />
      <span
        className={cn(THUMB, "top-1/2 size-4")}
        style={{
          ...THUMB_OUTLINE,
          left: `calc(${value / 360} * (100% - 1rem) + 0.5rem)`,
          // ratchet-allow: the thumb shows the hue it sits on.
          backgroundColor: `hsl(${value} 100% 50%)`,
          transition: thumbTransition,
        }}
      />
    </div>
  );
}

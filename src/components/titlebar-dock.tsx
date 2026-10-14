// The titlebar's action dock: the loose icon row, gathered into one pill with
// a single tooltip that slides between its items.
//
// The tooltip is ONE strip containing every label, translated so the active
// label centres under the hovered icon and clipped so only that label shows.
// That is what produces the morph — the box appears to travel and resize
// between items instead of one tooltip fading out and another fading in.
//
// Animated with CSS transitions on `transform` and `clip-path`, not a spring
// library. The reference implementation uses framer-motion, which is not a
// dependency here and would be a poor one to add for this: the titlebar is on
// the eager boot path, so its cost would be paid before first paint by every
// launch, to animate a hover. Timing and curves come from
// `ui/tooltip-timing.ts`, shared with every other tooltip: the first label
// waits for the open delay, and the next one is instant while any tooltip in
// the app is warm.
//
// It opens DOWNWARD. A titlebar tooltip has nothing above it but the window
// edge and the traffic lights.

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { ActionId } from "@/features/keybindings/lib/actions";
import { useNavigationHint } from "@/features/keybindings/lib/use-navigation-hint";
import { slideGeometry, type SlideGeometry } from "@/ui/slide-geometry";
import {
  isTooltipWarm,
  markTooltipClosed,
  markTooltipOpen,
  slideTransition,
  TOOLTIP_OPEN_DELAY,
} from "@/ui/tooltip-timing";

export interface DockItem {
  /** Stable identity, and the tooltip's text. */
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** The corner dot — update-ready, unread, needs-attention. */
  badge?: React.ReactNode;
  /** Overrides `label` for the accessible name where it says more. */
  title?: string;
  /** The existing panel command represented by this control, when applicable. */
  navigationAction?: ActionId;
}

interface Geometry extends SlideGeometry {
  /** False for the first reveal: it must materialise in place, not fly in
   *  from wherever the previous hover left the strip. */
  animate: boolean;
  /** Viewport y the strip is pinned to — the pill's bottom edge. See the
   *  anchor's comment for why this is measured rather than `top: 100%`. */
  top: number;
}

/** Keeps the tooltip inside the window. The dock sits at the right edge, so a
 *  long label centred on the last icon would otherwise run off it. */
const EDGE_MARGIN = 8;

export function TitlebarDock({
  items,
  trailing,
  className,
}: {
  items: DockItem[];
  /** A control the dock hosts but does not render: the account button owns a
   *  Radix trigger, which has to be attached to the real element. It still
   *  gets a tooltip, so it is part of the strip's arithmetic. */
  trailing?: { label: string; node: React.ReactNode };
  className?: string;
}) {
  const count = items.length + (trailing ? 1 : 0);
  const navigationHint = useNavigationHint();
  const buttons = useRef<(HTMLElement | null)[]>([]);
  const labels = useRef<(HTMLDivElement | null)[]>([]);
  /* The strip's own rect is NOT usable as the origin: it is the element being
     translated, so its `left` already contains the previous offset and each
     hover would compound the error. This wrapper never moves. */
  const anchor = useRef<HTMLDivElement>(null);
  /* The pill, for the anchor's `top` — the anchor is fixed to the viewport and
     so cannot get it from `top: 100%` any more. */
  const pill = useRef<HTMLDivElement>(null);

  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [visible, setVisibleState] = useState(false);
  const visibleRef = useRef(false);
  const openTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const setVisible = useCallback((next: boolean) => {
    if (next === visibleRef.current) return;
    visibleRef.current = next;
    if (next) markTooltipOpen();
    else markTooltipClosed();
    setVisibleState(next);
  }, []);

  useEffect(
    () => () => {
      clearTimeout(openTimer.current);
      if (visibleRef.current) markTooltipClosed();
    },
    [],
  );

  const onEnter = useCallback(
    (index: number) => {
      const button = buttons.current[index]?.getBoundingClientRect();
      const active = labels.current[index]?.getBoundingClientRect();
      const parent = anchor.current?.getBoundingClientRect();
      const host = pill.current?.getBoundingClientRect();
      if (!button || !active || !parent || !host) return;

      // Widths are read fresh rather than cached: the labels are laid out once
      // and never change, but a font swap or a UI-scale change would move them
      // and a stale cache would offset every tooltip by the difference.
      const widths = Array.from(
        { length: count },
        (_, i) => labels.current[i]?.getBoundingClientRect().width ?? 0,
      );
      const slide = slideGeometry({
        index,
        widths,
        controlCentre: button.left + button.width / 2,
        stripLeft: parent.left,
        viewportWidth: window.innerWidth,
        margin: EDGE_MARGIN,
      });
      if (!slide) return;

      clearTimeout(openTimer.current);
      const travelling = visibleRef.current;
      setGeometry({ ...slide, animate: travelling, top: host.bottom });
      if (travelling || isTooltipWarm()) setVisible(true);
      else openTimer.current = setTimeout(() => setVisible(true), TOOLTIP_OPEN_DELAY);
    },
    [count, setVisible],
  );

  // Only the fade runs on leave, so the strip stays where it was and the next
  // hover travels from there rather than from the origin.
  const onLeave = useCallback(() => {
    clearTimeout(openTimer.current);
    setVisible(false);
  }, [setVisible]);

  return (
    <div className={cn("relative", className)} onMouseLeave={onLeave}>
      <div
        ref={pill}
        className={cn(
          "flex h-6 items-center gap-1 rounded-full px-1 py-0.5",
          "border border-border-subtle bg-card",
        )}
      >
        {items.map((item, index) => (
          <button
            key={item.label}
            ref={(el) => {
              buttons.current[index] = el;
            }}
            type="button"
            {...navigationHint(item.navigationAction ? [item.navigationAction] : [])}
            onClick={item.onClick}
            onMouseEnter={() => onEnter(index)}
            onFocus={() => onEnter(index)}
            onBlur={onLeave}
            disabled={item.disabled}
            aria-label={item.title ?? item.label}
            className={cn(
              "relative flex size-5 items-center justify-center rounded-full outline-none",
              "text-muted-foreground transition-colors duration-150",
              item.disabled
                ? "cursor-default opacity-60"
                : "cursor-pointer hover:bg-element-hover hover:text-foreground",
            )}
          >
            {item.icon}
            {item.badge}
          </button>
        ))}
        {trailing && (
          <span
            ref={(el) => {
              buttons.current[items.length] = el;
            }}
            onMouseEnter={() => onEnter(items.length)}
            className="flex items-center"
          >
            {trailing.node}
          </span>
        )}
      </div>

      {/* Not a child of the pill: the pill would have to clip its overflow to
          keep its round corners, and that would cut the tooltip off.

          FIXED, not absolute, and this is load-bearing. The strip is ONE row
          holding every label — `w-max`, ~414px — and it is mounted all the time,
          clipped down to the active label by `clip-path`, which is a paint
          effect and does not shrink the layout box. Anchored to the pill at the
          right end of the title bar, that box ran ~320px past the window, and
          because `#root` is `overflow: hidden` the browser treated that as
          320px of scrollable overflow it was allowed to scroll into view. Any
          programmatic reveal (`focus()`, `scrollIntoView()`) then slid the ENTIRE
          app shell left by up to 320px — nav clipped, first column of Settings
          off-screen — with no scrollbar to put it back. A fixed box is laid out
          against the viewport and is never part of an ancestor's scrollable
          overflow, so the extent it would need simply does not exist. Same
          reason `HintGroup` portals its identical strip to `body` as `fixed`.

          The price is that `top: 100%` no longer reaches the pill, so the pill's
          bottom edge is measured on hover instead (`geometry.top`). Keep both
          `left-0` and `stripLeft` reading this element's own rect: the slide
          arithmetic is relative to wherever the untranslated strip starts. */}
      <div
        ref={anchor}
        className="pointer-events-none fixed left-0 z-tooltip pt-1.5"
        style={{ top: geometry?.top ?? 0 }}
      >
        <div
          className={cn(
            "flex w-max",
            "bg-popover text-foreground",
            "outline outline-1 outline-[var(--border)]",
            "shadow-md",
          )}
          style={{
            opacity: visible ? 1 : 0,
            transform: `translateX(${geometry?.tx ?? 0}px)`,
            clipPath: `inset(0 ${geometry?.right ?? 0}% 0 ${geometry?.left ?? 0}% round 6px)`,
            // Opacity is always eased and quick; position only animates once
            // the strip is already up, and never under reduced motion.
            transition: slideTransition({ visible, travel: geometry?.animate ?? false }),
          }}
        >
          {[...items.map((i) => i.label), ...(trailing ? [trailing.label] : [])].map(
            (label, index) => (
              <div
                key={label}
                ref={(el) => {
                  labels.current[index] = el;
                }}
                className="flex h-[22px] shrink-0 items-center whitespace-nowrap px-2.5 text-xs leading-none"
              >
                {label}
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

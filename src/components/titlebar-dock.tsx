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
// launch, to animate a hover. An easing curve with a little overshoot reads
// close enough to a spring over 260ms.
//
// It opens DOWNWARD. A titlebar tooltip has nothing above it but the window
// edge and the traffic lights.

import { useCallback, useRef, useState } from "react";
import { cn } from "@/lib/utils";

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
}

interface Geometry {
  /** Strip offset, in px, that centres the active label on its icon. */
  tx: number;
  /** Percentages hiding everything either side of the active label. */
  left: number;
  right: number;
  /** False for the first reveal: it must materialise in place, not fly in
   *  from wherever the previous hover left the strip. */
  animate: boolean;
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
  const buttons = useRef<(HTMLElement | null)[]>([]);
  const labels = useRef<(HTMLDivElement | null)[]>([]);
  /* The strip's own rect is NOT usable as the origin: it is the element being
     translated, so its `left` already contains the previous offset and each
     hover would compound the error. This wrapper never moves. */
  const anchor = useRef<HTMLDivElement>(null);

  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [visible, setVisible] = useState(false);

  const onEnter = useCallback(
    (index: number) => {
      const button = buttons.current[index]?.getBoundingClientRect();
      const active = labels.current[index]?.getBoundingClientRect();
      const parent = anchor.current?.getBoundingClientRect();
      if (!button || !active || !parent) return;

      // Widths are read fresh rather than cached: the labels are laid out once
      // and never change, but a font swap or a UI-scale change would move them
      // and a stale cache would offset every tooltip by the difference.
      let before = 0;
      for (let i = 0; i < index; i++) {
        before += labels.current[i]?.getBoundingClientRect().width ?? 0;
      }
      let after = 0;
      for (let i = index + 1; i < count; i++) {
        after += labels.current[i]?.getBoundingClientRect().width ?? 0;
      }
      const total = before + active.width + after;
      if (total <= 0) return;

      const iconCentre = button.left + button.width / 2;
      let tx = iconCentre - (parent.left + before + active.width / 2);

      // After the shift the active label spans [centre - w/2, centre + w/2].
      // Push it back inside the window if either edge escapes.
      const overflowRight = iconCentre + active.width / 2 - (window.innerWidth - EDGE_MARGIN);
      if (overflowRight > 0) tx -= overflowRight;
      const overflowLeft = EDGE_MARGIN - (iconCentre - active.width / 2);
      if (overflowLeft > 0) tx += overflowLeft;

      setGeometry({
        tx,
        left: (before / total) * 100,
        right: (after / total) * 100,
        animate: visible,
      });
      setVisible(true);
    },
    [count, visible],
  );

  // Only the fade runs on leave, so the strip stays where it was and the next
  // hover travels from there rather than from the origin.
  const onLeave = useCallback(() => setVisible(false), []);

  return (
    <div className={cn("relative", className)} onMouseLeave={onLeave}>
      <div
        className={cn(
          "flex h-6 items-center gap-1 rounded-full px-1 py-0.5",
          "border border-white/[0.07] bg-[#121212]",
        )}
      >
        {items.map((item, index) => (
          <button
            key={item.label}
            ref={(el) => {
              buttons.current[index] = el;
            }}
            type="button"
            onClick={item.onClick}
            onMouseEnter={() => onEnter(index)}
            onFocus={() => onEnter(index)}
            onBlur={onLeave}
            disabled={item.disabled}
            aria-label={item.title ?? item.label}
            className={cn(
              "relative flex size-5 items-center justify-center rounded-full outline-none",
              "text-[#666] transition-colors duration-150",
              item.disabled
                ? "cursor-default opacity-60"
                : "cursor-pointer hover:bg-white/[0.08] hover:text-[#ccc]",
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
          keep its round corners, and that would cut the tooltip off. */}
      <div ref={anchor} className="pointer-events-none absolute left-0 top-full z-[60] pt-1.5">
        <div
          className={cn(
            "flex w-max",
            "bg-black text-text-primary",
            "outline outline-1 outline-[var(--border-default)]",
            "shadow-[0_8px_24px_rgba(0,0,0,0.5)]",
          )}
          style={{
            opacity: visible ? 1 : 0,
            transform: `translateX(${geometry?.tx ?? 0}px)`,
            clipPath: `inset(0 ${geometry?.right ?? 0}% 0 ${geometry?.left ?? 0}% round 6px)`,
            // A touch of overshoot at the end of the travel, which is the part
            // of a spring the eye actually reads. Opacity is always eased and
            // quick; position only animates once the strip is already up.
            transition: [
              "opacity 140ms ease-out",
              ...(geometry?.animate
                ? [
                    "transform 260ms cubic-bezier(0.22, 1.2, 0.36, 1)",
                    "clip-path 260ms cubic-bezier(0.22, 1.2, 0.36, 1)",
                  ]
                : []),
            ].join(", "),
          }}
        >
          {[...items.map((i) => i.label), ...(trailing ? [trailing.label] : [])].map(
            (label, index) => (
              <div
                key={label}
                ref={(el) => {
                  labels.current[index] = el;
                }}
                className="flex h-[22px] shrink-0 items-center whitespace-nowrap px-2.5 text-[11px] leading-none"
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

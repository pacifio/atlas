// Edge fades for a scroll container, and the measurement that drives them.
//
// A list that is clipped mid-row reads as finished. The fade says "there is
// more", and it must only appear while there IS more — a permanent fade over a
// short list just dims its first and last rows.
//
// The gradient's colour is the CALLER's, not a default: a fade is a ramp from
// whatever paints behind the list to transparent, and fading from the wrong
// colour is a grey wash over the surface rather than an invisible one. That is
// why `className` carries the stops instead of this file picking them.
//
// Not for translucent surfaces. On a blurred panel an opaque gradient punches
// a solid strip through the blur, so a caller on one should leave the fades
// out rather than guess at a colour.

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** Which edges have content past them. Both false means nothing to scroll. */
export interface ScrollEdges {
  top: boolean;
  bottom: boolean;
}

/**
 * Whether a scroll container has content above and below its viewport.
 *
 * Re-measured on scroll and on resize, because a list can become scrollable
 * without anyone scrolling it (the panel narrows, a row grows, rows arrive).
 * `deps` is for the content: new rows change `scrollHeight` with no event of
 * their own.
 *
 * The 2px slack absorbs fractional scroll positions — at a UI scale the root
 * font size sets, `scrollTop + clientHeight` lands a hair short of
 * `scrollHeight` at the true bottom, which left the bottom fade on forever.
 */
export function useScrollEdges(
  ref: React.RefObject<HTMLElement | null>,
  deps: unknown[],
): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({ top: false, bottom: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const top = el.scrollTop > 2;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
      // Same-value guard: `scroll` fires per frame while dragging, and a fresh
      // object every time would re-render every row behind the fade.
      setEdges((cur) => (cur.top === top && cur.bottom === bottom ? cur : { top, bottom }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return edges;
}

/**
 * One edge fade. Absolutely positioned, so the scroll container needs a
 * `relative` ancestor that is NOT itself the scroller — inside the scroller the
 * fade would scroll away with the content.
 *
 * `className` supplies the gradient stops (`from-…`, `via-…`); everything else
 * — geometry, direction, the opacity transition — is fixed here so the two
 * edges of one list cannot drift apart.
 */
export function ScrollFade({
  at,
  visible,
  className,
}: {
  at: "top" | "bottom";
  visible: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-0 z-10 h-14 transition-opacity duration-200",
        at === "top" ? "top-0 bg-gradient-to-b" : "bottom-0 bg-gradient-to-t",
        "to-transparent",
        visible ? "opacity-100" : "opacity-0",
        className,
      )}
    />
  );
}

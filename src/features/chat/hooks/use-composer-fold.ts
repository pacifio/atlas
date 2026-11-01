// The composer's fold, run on the compositor.
//
// Folding used to animate the tray's grid track (0fr ↔ 1fr). That is a LAYOUT
// animation: every frame resized the composer stack, so the transcript's
// scroller above it resized with it — its ResizeObservers fired (re-anchor,
// re-measure), the turn rail re-measured its gutter, the scroller's bottom
// tiles repainted — all on the main thread, the one a streaming turn renders
// on. Under load the frames slipped and the fold stuttered, which made the
// whole composer feel slow to answer a click.
//
// Now the layout changes ONCE per fold, and only transform and opacity move,
// through the Web Animations API, which WebKit runs off the main thread:
//
//   opening  the tray joins the layout at once, which lifts the card's box by
//            the tray's height; the card is drawn back down by that height and
//            eased up to rest, uncovering the tray, which fades in.
//   folding  the card eases down over the tray, which fades out; when it lands
//            the tray leaves the layout and the animation is dropped in the
//            same commit, so the card's box and where it is drawn agree.
//
// A fold reversed midway starts from wherever the card is drawn right now.

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** `--duration-base` and `--ease-out-strong`, which the CSS version used. */
const DURATION_MS = 180;
const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";

/** The vertical offset an element is drawn at: the `ty` of its computed
 *  transform, which reflects a running animation. */
function drawnY(el: HTMLElement): number {
  const t = getComputedStyle(el).transform;
  const m = /^matrix(3d)?\((.+)\)$/.exec(t);
  if (!m) return 0;
  const v = m[2].split(",").map(Number);
  return (m[1] ? v[13] : v[5]) || 0;
}

/**
 * Drives the fold of `card` over `tray`. Returns whether the tray holds its
 * room in the layout: true while open AND for the length of the fold-out.
 */
export function useComposerFold(
  collapsed: boolean,
  cardRef: RefObject<HTMLElement | null>,
  trayRef: RefObject<HTMLElement | null>,
): boolean {
  const [trayShown, setTrayShown] = useState(!collapsed);
  // Opening puts the tray back in THIS render, not an effect later: the
  // layout effect below has to find it in the layout to measure it.
  if (!collapsed && !trayShown) setTrayShown(true);

  const running = useRef<Animation[]>([]);
  const prevCollapsed = useRef(collapsed);

  const track = (anims: Animation[]) => {
    // Cancelling rejects `finished`. Browsers mark that rejection handled;
    // not every DOM implementation does, and nothing here awaits it.
    for (const a of anims) a.finished.catch(() => {});
    running.current = anims;
  };

  const stop = () => {
    for (const a of running.current) a.cancel();
    running.current = [];
  };

  useLayoutEffect(() => {
    // Only a change folds; a mount (or StrictMode's second run) does not.
    if (prevCollapsed.current === collapsed) return;
    prevCollapsed.current = collapsed;
    const card = cardRef.current;
    const tray = trayRef.current;
    const animate =
      card &&
      tray &&
      typeof card.animate === "function" &&
      !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!animate) {
      stop();
      if (collapsed) setTrayShown(false);
      return;
    }

    const reversing = running.current.length > 0;
    const fromY = drawnY(card);
    const fromOpacity = Number(getComputedStyle(tray).opacity);
    const height = tray.offsetHeight;
    stop();

    const timing: KeyframeAnimationOptions = {
      duration: DURATION_MS,
      easing: EASE,
      fill: "forwards",
    };
    if (collapsed) {
      const cardAnim = card.animate(
        [{ transform: `translateY(${fromY}px)` }, { transform: `translateY(${height}px)` }],
        timing,
      );
      const trayAnim = tray.animate([{ opacity: fromOpacity }, { opacity: 0 }], timing);
      track([cardAnim, trayAnim]);
      cardAnim.onfinish = () => {
        if (running.current[0] === cardAnim) setTrayShown(false);
      };
    } else {
      // From a rest fold, the card's box just rose by the tray's height; a
      // fold-out caught midway never left the layout, so it is drawn where
      // it is.
      const startY = reversing ? fromY : height;
      const startOpacity = reversing ? fromOpacity : 0;
      track([
        card.animate(
          [{ transform: `translateY(${startY}px)` }, { transform: "translateY(0)" }],
          timing,
        ),
        tray.animate([{ opacity: startOpacity }, { opacity: 1 }], timing),
      ]);
      running.current[0].onfinish = () => stop();
    }
  }, [collapsed]);

  // The fold-out landed and the tray left the layout: drop the held frame in
  // the same commit, before paint.
  useLayoutEffect(() => {
    if (!trayShown) stop();
  }, [trayShown]);

  useLayoutEffect(() => stop, []);

  return trayShown;
}

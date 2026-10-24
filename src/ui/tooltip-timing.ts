// One timing for every tooltip in the app — the Base UI `Tooltip`/`Hint`, the
// sliding `HintGroup`, and the titlebar dock. The first tooltip waits
// TOOLTIP_OPEN_DELAY so a pointer crossing the UI doesn't flash labels; once
// one has been open, the next opens instantly (and without an entrance) until
// TOOLTIP_WARM_WINDOW has passed with nothing open. The warm state is shared
// module state, so moving from one kind of tooltip to another stays instant.

export const TOOLTIP_OPEN_DELAY = 300;
/** Keeps a hint readable across a small pointer gap; focus/press/Escape do not wait. */
export const TOOLTIP_CLOSE_DELAY = 80;
export const TOOLTIP_WARM_WINDOW = 300;

/** Strong ease-out: starts moving at once, settles without overshoot. */
export const TOOLTIP_EASE = "cubic-bezier(0.23, 1, 0.32, 1)";
export const TOOLTIP_SLIDE_MS = 180;
export const TOOLTIP_FADE_IN_MS = 125;
export const TOOLTIP_FADE_OUT_MS = 80;

let openCount = 0;
let warmUntil = 0;

/** Call when a tooltip becomes visible. */
export function markTooltipOpen() {
  openCount += 1;
}

/** Call when a tooltip that was visible hides. */
export function markTooltipClosed() {
  openCount = Math.max(0, openCount - 1);
  warmUntil = Date.now() + TOOLTIP_WARM_WINDOW;
}

/** True while a tooltip is open or one closed within the warm window. */
export function isTooltipWarm() {
  return openCount > 0 || Date.now() < warmUntil;
}

export function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/** The sliding strip's transition: opacity always, travel only when asked. */
export function slideTransition({ visible, travel }: { visible: boolean; travel: boolean }) {
  const parts = [
    visible
      ? `opacity ${TOOLTIP_FADE_IN_MS}ms ${TOOLTIP_EASE}`
      : `opacity ${TOOLTIP_FADE_OUT_MS}ms ease-out`,
  ];
  if (travel && !prefersReducedMotion()) {
    parts.push(
      `transform ${TOOLTIP_SLIDE_MS}ms ${TOOLTIP_EASE}`,
      `clip-path ${TOOLTIP_SLIDE_MS}ms ${TOOLTIP_EASE}`,
    );
  }
  return parts.join(", ");
}

/** Test hook: forget any open/warm state between tests. */
export function resetTooltipTiming() {
  openCount = 0;
  warmUntil = 0;
}

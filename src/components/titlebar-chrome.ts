/**
 * The pure half of the window bar's dragging: which presses belong to the
 * window, and the threshold before a press becomes a drag. The native calls
 * (`startDragging`, zoom) stay with the caller, in `titlebar.tsx`.
 */

/** How far the pointer must travel, in CSS px, before a press on the bar
 *  drags the window. Below it the press is a click or a double-click. */
export const WINDOW_DRAG_THRESHOLD = 4;

/**
 * True when a press on `target` belongs to the window, not to a control. A
 * tab is a control here: dragging a tab must never drag the window.
 *
 * An interactive child added to the bar later must be a `button`, `a` or form
 * field, have one of these roles, or carry `data-no-window-drag`; anything
 * else drags the window when pressed.
 */
export function isWindowSurface(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !el?.closest?.(
    "button, a, input, select, textarea, [role='menuitem'], [role='tab'], [data-no-window-drag]",
  );
}

/**
 * Calls `start` once the pointer, pressed at `from`, has moved past the
 * threshold; never if the button comes up first. Listens on `window` so a
 * fast pointer that leaves the bar still counts, and removes both listeners
 * either way.
 *
 * Why wait at all: calling `startDragging()` straight from mousedown hands the
 * event stream to the OS drag session and swallows the double-click, so a
 * stationary click or double-click must flow through untouched.
 */
export function beginDragOnMove(from: { clientX: number; clientY: number }, start: () => void) {
  const onMove = (ev: MouseEvent) => {
    if (Math.hypot(ev.clientX - from.clientX, ev.clientY - from.clientY) > WINDOW_DRAG_THRESHOLD) {
      cleanup();
      start();
    }
  };
  const cleanup = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", cleanup);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", cleanup);
}

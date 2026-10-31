/**
 * The turn rail sits beside the transcript's scroller, not inside it, so a wheel
 * over the rail would otherwise scroll nothing. Re-dispatch it on the scroller
 * first (its own listeners, such as the sticky anchor's release, see a real
 * wheel), then scroll by the same delta unless one of them cancelled it.
 * Pinch-zoom (`ctrlKey`) and purely horizontal wheels are left alone.
 */
export function forwardWheelToScroller(event: WheelEvent, scroller: HTMLElement): void {
  if (event.defaultPrevented || event.ctrlKey || event.deltaY === 0) return;
  event.preventDefault();

  const forwarded = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaZ: event.deltaZ,
    deltaMode: event.deltaMode,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    altKey: event.altKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  });
  if (!scroller.dispatchEvent(forwarded)) return;

  const pixelsPerUnit =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? scroller.clientHeight
        : 1;
  scroller.scrollBy({ top: event.deltaY * pixelsPerUnit });
}

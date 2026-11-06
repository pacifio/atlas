/** What the title bar's project label hears to open its capture popover. */
export const OPEN_CAPTURE_EVENT = "atlas:open-capture";

/** ⌘⌥C and the palette's "Open Session Capture": the project label's
 *  capture popover. */
export function openCapture(): void {
  window.dispatchEvent(new CustomEvent(OPEN_CAPTURE_EVENT));
}

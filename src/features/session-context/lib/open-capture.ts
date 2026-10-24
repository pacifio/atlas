import { openSessionDetails } from "../stores/session-details-store";

/** What the title bar's project label hears when there is no session to open
 *  capture in: it opens its own capture popover instead. */
export const OPEN_CAPTURE_EVENT = "atlas:open-capture";

/**
 * ⌘⌥C and the palette's "Open Session Capture": the session's Details card,
 * straight onto its capture view. With no session in the main column there is
 * no card to open, so the project label's capture popover answers instead.
 */
export function openCapture(): void {
  if (openSessionDetails("capture")) return;
  window.dispatchEvent(new CustomEvent(OPEN_CAPTURE_EVENT));
}

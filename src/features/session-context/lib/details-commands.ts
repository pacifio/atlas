// The Details card's keyboard commands, raised from the app's action map.
//
// Whether the card docks or pops over, and where the session works, is known
// only to the session's own title-bar button, so the commands are window
// events the button on screen answers (`session-details-button.tsx`).

/** Show or hide the Details card of the session in the main column. */
export const TOGGLE_SESSION_DETAILS_EVENT = "atlas:toggle-session-details";
/** Open that session's checkout in the preferred editor. */
export const OPEN_SESSION_IN_EDITOR_EVENT = "atlas:open-session-in-editor";

export function toggleSessionDetails(): void {
  window.dispatchEvent(new CustomEvent(TOGGLE_SESSION_DETAILS_EVENT));
}

export function openSessionInEditor(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SESSION_IN_EDITOR_EVENT));
}

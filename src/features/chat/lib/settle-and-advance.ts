/**
 * The settle keybinding's route to the sidebar.
 *
 * Settling the open session has to move the chat somewhere, and only the
 * sidebar knows the list it would move along — so the shell's chord asks the
 * sidebar to do it, naming the chat tab in front. The app has one sidebar; it
 * registers itself here while mounted.
 */

type SettleHandler = (tabId: string) => void;

let handler: SettleHandler | null = null;

/** Make `next` the settle action; returns the matching unregister, which
 *  leaves a newer registration alone. */
export function registerSettleAndAdvance(next: SettleHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/** Settle (or un-settle) the session open in `tabId`. Answers `false` when no
 *  sidebar is mounted to do it. */
export function settleAndAdvance(tabId: string): boolean {
  if (!handler) return false;
  handler(tabId);
  return true;
}

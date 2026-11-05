// The closed sidebar's peek: the same sidebar, laid over the session rather
// than beside it, for as long as the pointer is on it. It opens from the
// window's left edge or from the sidebar toggle, after a short rest so a
// pointer passing through does not set it off, and it goes when the pointer
// leaves — unless a menu opened from it is still up, which would otherwise
// lose its anchor mid-choice.
//
// The timers live here, not in a component, because three places drive one
// peek: the edge strip, the toggle in the title bar, and the panel itself.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";

/** How long the pointer rests on the edge or the toggle before the peek opens. */
const OPEN_DELAY_MS = 150;
/** How long after the pointer leaves before the peek goes: long enough to
 *  cross a gap back onto it. */
const CLOSE_DELAY_MS = 250;

interface SidebarPeekState {
  open: boolean;
}

export const useSidebarPeek = createSelectors(create<SidebarPeekState>()(() => ({ open: false })));

let openTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

/** The panel, so a pending close can ask whether a menu of its is open. */
let panel: HTMLElement | null = null;

export function setPeekPanel(el: HTMLElement | null): void {
  panel = el;
}

function clearTimers() {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
  openTimer = closeTimer = undefined;
}

/** The pointer reached the edge or the toggle: open after a rest. */
export function requestPeek(): void {
  clearTimeout(closeTimer);
  closeTimer = undefined;
  if (useSidebarPeek.getState().open || openTimer) return;
  openTimer = setTimeout(() => {
    openTimer = undefined;
    useSidebarPeek.setState({ open: true });
  }, OPEN_DELAY_MS);
}

/** The pointer is on the peek: keep it. */
export function holdPeek(): void {
  clearTimeout(closeTimer);
  closeTimer = undefined;
}

/** A menu or popover opened from the panel is still up. Its trigger carries
 *  `data-popup-open` while it is (Base UI), and a context menu has no trigger
 *  to mark, so an open menu anywhere counts too — an open one only: some
 *  dialogs stay mounted while closed (`CommentsMorph` goes `inert`), and
 *  counting those would hold the peek open for good. */
function popupOpen(): boolean {
  if (panel?.querySelector("[data-popup-open]")) return true;
  for (const el of document.querySelectorAll<HTMLElement>("[role='menu'], [role='dialog']")) {
    if (el.closest("[inert], [hidden]")) continue;
    if (el.getClientRects().length === 0) continue;
    return true;
  }
  return false;
}

/** The pointer left the edge, the toggle or the panel: close after a beat,
 *  and later still while a menu of the panel's is up. */
export function releasePeek(): void {
  clearTimeout(openTimer);
  openTimer = undefined;
  if (!useSidebarPeek.getState().open || closeTimer) return;
  const attempt = () => {
    if (panel?.matches(":hover")) {
      closeTimer = undefined;
      return;
    }
    if (popupOpen()) {
      closeTimer = setTimeout(attempt, CLOSE_DELAY_MS);
      return;
    }
    closeTimer = undefined;
    useSidebarPeek.setState({ open: false });
  };
  closeTimer = setTimeout(attempt, CLOSE_DELAY_MS);
}

/** Close now: Escape, or the sidebar was docked. */
export function endPeek(): void {
  clearTimers();
  if (useSidebarPeek.getState().open) useSidebarPeek.setState({ open: false });
}

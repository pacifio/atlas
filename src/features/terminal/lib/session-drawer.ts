// Kept for later: the session terminal drawer is unmounted (no UI reaches it) until the terminal rework. Not dead code; do not delete.
//
// The session terminal drawer's actions, and the arithmetic of its height.
//
// The drawer's open flag and height are in `session-drawer-store`; its
// terminals are a terminal tab in `terminal-store`. Opening, adopting and
// discarding a drawer touch both, so they live here, at the action boundary,
// rather than in either store (stores never call each other).

import { useChatStore } from "@/features/chat/stores/chat-store";
import { sessionScope } from "@/features/chat/lib/session-scope";
import { projectIdForTab, projectPathForTab } from "@/features/chat/lib/tab-project";
import { sessionWorkPath } from "@/features/session-context/lib/session-work-path";
import { useTerminalStore } from "../stores/terminal-store";
import { drawerTabId, useSessionDrawerStore } from "../stores/session-drawer-store";

export { DRAWER_TAB_PREFIX, drawerTabId, isDrawerTab } from "../stores/session-drawer-store";

/** The session scope a chat tab shows right now (`sessionScope`). */
export function drawerScopeForTab(chatTabId: string): string {
  return sessionScope(chatTabId, useChatStore.getState().sessions[chatTabId]?.acpSessionId);
}

// ── Height ────────────────────────────────────────────────────────────────

/** The drawer is never shorter than this: a prompt and a few lines. */
export const MIN_DRAWER_HEIGHT = 180;
/** Nor taller than this share of the window. */
export const MAX_DRAWER_HEIGHT_RATIO = 0.75;
/** What the drawer always leaves the transcript above the composer. */
export const MIN_TRANSCRIPT_HEIGHT = 120;

export interface DrawerLayout {
  viewportHeight: number;
  /** The session column the drawer sits in, drawer included. */
  columnHeight?: number;
  /** What the column must keep besides the drawer: the composer stack and
   *  the transcript's minimum. */
  reservedHeight?: number;
}

/** The tallest the drawer may be in this layout. */
export function resolveDrawerMaxHeight(input: DrawerLayout): number {
  const windowCap = Math.max(
    MIN_DRAWER_HEIGHT,
    Math.floor(input.viewportHeight * MAX_DRAWER_HEIGHT_RATIO),
  );
  if (input.columnHeight === undefined) return windowCap;
  // Without this cap a tall drawer pushes the composer off the column.
  return Math.max(
    MIN_DRAWER_HEIGHT,
    Math.min(windowCap, input.columnHeight - (input.reservedHeight ?? 0)),
  );
}

/** A preferred height, as this layout allows it. */
export function clampDrawerHeight(height: number, maxHeight: number, fallback: number): number {
  const safe = Number.isFinite(height) ? height : fallback;
  return Math.min(Math.max(Math.round(safe), MIN_DRAWER_HEIGHT), maxHeight);
}

// ── Actions ───────────────────────────────────────────────────────────────

/**
 * Open the drawer of the session `chatTabId` shows. Seeds its terminal tab
 * first, in the session's working directory (its worktree when it has one,
 * else its project), so an open drawer always has a terminal to show.
 */
export function openSessionDrawer(chatTabId: string): void {
  const scope = drawerScopeForTab(chatTabId);
  const tabId = drawerTabId(scope);
  const session = useChatStore.getState().sessions[chatTabId];
  const cwd = sessionWorkPath(session, projectPathForTab(chatTabId)) ?? undefined;
  const terminal = useTerminalStore.getState().actions;
  terminal.initTab(tabId, projectIdForTab(chatTabId) ?? undefined, cwd);
  const drawer = useSessionDrawerStore.getState().actions;
  drawer.setOpen(scope, true);
  // The terminal takes the keyboard once it mounts: the drawer owns focus
  // from here (`focus.ts`), and the request is consumed by its terminal.
  drawer.setFocusedTab(tabId);
  terminal.requestTerminalFocus(tabId);
}

/** Hide the drawer. Its terminals keep running; the composer gets focus. */
export function closeSessionDrawer(chatTabId: string): void {
  const scope = drawerScopeForTab(chatTabId);
  const drawer = useSessionDrawerStore.getState();
  drawer.actions.setOpen(scope, false);
  if (drawer.focusedTab === drawerTabId(scope)) drawer.actions.setFocusedTab(null);
  window.dispatchEvent(new CustomEvent("atlas:chat-focus", { detail: { tabId: chatTabId } }));
}

/** The session ⋯ menu's Terminal item and the shortcut. Returns whether it is now open. */
export function toggleSessionDrawer(chatTabId: string): boolean {
  const open = !!useSessionDrawerStore.getState().open[drawerScopeForTab(chatTabId)];
  if (open) closeSessionDrawer(chatTabId);
  else openSessionDrawer(chatTabId);
  return !open;
}

/** A tab's session just bound: its unbound drawer becomes the session's. */
export function adoptSessionDrawer(from: string, to: string): void {
  if (from === to) return;
  useTerminalStore.getState().actions.renameTab(drawerTabId(from), drawerTabId(to));
  useSessionDrawerStore.getState().actions.adopt(from, to);
}

/** The session is gone (deleted): end its drawer's shells and forget it. */
export function discardSessionDrawer(scope: string): void {
  useTerminalStore.getState().actions.removeTabs([drawerTabId(scope)]);
  useSessionDrawerStore.getState().actions.forget(scope);
}

/** A live session id's drawer, for callers that know the session, not the
 *  tab (the sidebar's delete). */
export function discardSessionDrawerFor(acpSessionId: string): void {
  if (acpSessionId) discardSessionDrawer(sessionScope("", acpSessionId));
}

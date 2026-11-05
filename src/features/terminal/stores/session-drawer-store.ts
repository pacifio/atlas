// Kept for later: the session terminal drawer is unmounted (no UI reaches it) until the terminal rework. Not dead code; do not delete.
//
// A session's terminal drawer: whether it is open, how tall it is, and which
// drawer has the keyboard.
//
// Its own store, like the session Details card's: opening the drawer, dragging its
// edge or typing in it must not re-render the chat panel or a single
// transcript row. The chat panel never subscribes here; the drawer and the
// session ⋯ menu's Terminal item subscribe for themselves.
//
// The drawer's TERMINALS are not here. They are an ordinary terminal tab in
// `terminal-store` (id `drawerTabId(scope)`), so the session registry that
// owns every shell (`terminal-session.ts`) keeps them alive exactly as it
// keeps a terminal tab's: closing the drawer, switching session or tab, even
// closing the session's tab, leaves them running. They end when their tab
// leaves the terminal store: the last one closed, the session deleted, or its
// project discarded.
//
// Keyed by SESSION scope (`sessionScope`: the ACP session once bound, the tab
// until then), not by tab: "new agent" and opening a session from history
// both reuse a tab, and the drawer belongs to the session it was opened in.

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createSelectors } from "@/lib/create-selectors";

/** A drawer's terminal tab ids start with this; no layout tab does. */
export const DRAWER_TAB_PREFIX = "session-drawer:";

/** The terminal-store tab holding a session's drawer terminals. */
export function drawerTabId(scope: string): string {
  return `${DRAWER_TAB_PREFIX}${scope}`;
}

export function isDrawerTab(tabId: string): boolean {
  return tabId.startsWith(DRAWER_TAB_PREFIX);
}

/** The drawer tabs `owners` (terminal-store's tab → project map) gives to a
 *  project: what a project discard must end along with its layout tabs. */
export function drawerTabsOwnedBy(owners: Record<string, string>, projectId: string): string[] {
  return Object.keys(owners).filter((id) => isDrawerTab(id) && owners[id] === projectId);
}

/** A new session's drawer height before anyone has dragged one. */
export const DEFAULT_DRAWER_HEIGHT = 280;

interface SessionDrawerState {
  /** Open drawers, by session scope. Absent means closed. */
  open: Record<string, true>;
  /** Each session's drawer height, in CSS pixels, as last dragged. */
  heights: Record<string, number>;
  /** The height last dragged anywhere: a session that has never had a drawer
   *  opens at the size the user last chose, not at the default. */
  lastHeight: number;
  /** The drawer terminal tab with DOM focus inside it, if any. Focus is how a
   *  terminal knows it owns the keyboard (`focus.ts`); a drawer is not a
   *  layout tab, so the layout cannot answer for it. */
  focusedTab: string | null;
  actions: {
    setOpen: (scope: string, open: boolean) => void;
    setHeight: (scope: string, height: number) => void;
    setFocusedTab: (tabId: string | null) => void;
    /** Carry an unbound tab's drawer (`t:<tab>`) over to the session that tab
     *  bound to, so a drawer opened before the first message stays open. */
    adopt: (from: string, to: string) => void;
    /** Forget a session's drawer (it was deleted). */
    forget: (scope: string) => void;
  };
}

export const useSessionDrawerStore = createSelectors(
  create<SessionDrawerState>()(
    persist(
      (set) => ({
        open: {},
        heights: {},
        lastHeight: DEFAULT_DRAWER_HEIGHT,
        focusedTab: null,
        actions: {
          setOpen: (scope, next) =>
            set((s) => {
              if (!!s.open[scope] === next) return s;
              const open = { ...s.open };
              if (next) open[scope] = true;
              else delete open[scope];
              return { open };
            }),
          setHeight: (scope, height) =>
            set((s) => {
              if (!Number.isFinite(height) || height <= 0) return s;
              const h = Math.round(height);
              if (s.heights[scope] === h && s.lastHeight === h) return s;
              return { heights: { ...s.heights, [scope]: h }, lastHeight: h };
            }),
          setFocusedTab: (tabId) =>
            set((s) => (s.focusedTab === tabId ? s : { focusedTab: tabId })),
          adopt: (from, to) =>
            set((s) => {
              if (from === to) return s;
              const patch: Partial<SessionDrawerState> = {};
              if (s.open[from]) {
                const open = { ...s.open, [to]: true as const };
                delete open[from];
                patch.open = open;
              }
              if (s.heights[from] !== undefined && s.heights[to] === undefined) {
                const heights = { ...s.heights, [to]: s.heights[from] };
                delete heights[from];
                patch.heights = heights;
              }
              return Object.keys(patch).length ? patch : s;
            }),
          forget: (scope) =>
            set((s) => {
              if (!s.open[scope] && s.heights[scope] === undefined) return s;
              const open = { ...s.open };
              delete open[scope];
              const heights = { ...s.heights };
              delete heights[scope];
              return { open, heights };
            }),
        },
      }),
      {
        name: "atlas.session.terminal-drawer",
        version: 1,
        // `open` is deliberately NOT persisted. A drawer's shells do not
        // survive a restart, so a drawer that reopened itself on launch would
        // spawn a fresh shell for every session that once had one open — a
        // process the user did not ask for in this run. The height is the
        // remembered part.
        partialize: (s) => ({ heights: s.heights, lastHeight: s.lastHeight }),
      },
    ),
  ),
);

/** The drawer height a session opens at: its own, else the last dragged. */
export function drawerHeightFor(
  state: Pick<SessionDrawerState, "heights" | "lastHeight">,
  scope: string,
): number {
  return state.heights[scope] ?? state.lastHeight;
}

// State for the session Details card: the one card the title bar's Details
// button shows over a session's top-right. It replaced two cards that
// overlapped (the session overview and the session context card), and so this
// one store replaced theirs.
//
// Its own store, so opening the card or collapsing a section re-renders the
// button, the card and the dock lane and never a transcript row: rows never
// subscribe here, and the chat panel reads nothing but the stable actions.
//
// The card has two forms, and the store holds both:
//
//  - **Docked.** Where the chat panel keeps room at its top-right
//    (`context-dock.ts`), the card is drawn into that room and the button
//    toggles `open` for the session. It stays until toggled off: across
//    turns, across tab switches.
//  - **Popover.** Anywhere else the card is a popover anchored to the button,
//    open while `popoverFor` names the session. Like any popover it closes on
//    an outside press and on Escape.
//
// Both are keyed by SESSION (`sessionScope`), not by tab: "new agent" and
// opening a session from history both reuse the tab, and a tab-keyed flag
// followed the user into every session the tab ever showed.
//
// The dialogs the card opens (a project script's editor and its first-run
// confirmation, Create PR) are here too, not in the rows that open them: a
// popover closes when focus moves into a dialog, and a dialog mounted inside
// it would close with it. Their host is mounted once, at the app root.

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { sessionScope } from "@/features/chat/lib/session-scope";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { createSelectors } from "@/lib/create-selectors";
import type { PrCreateDraft } from "@/features/pull-requests/lib/pull-requests-types";

import type { ProjectScript } from "../lib/session-context-api";

/** What the card shows. `main` is the sections; the others are drill-in
 *  views that replace them (with a back button). */
export type DetailsView = "main" | "capture" | "usage";

/** The sections a reader can collapse. A closed vocabulary: a new collapsible
 *  section is a deliberate addition here. */
export const COLLAPSIBLE_SECTIONS = ["changes", "lineage", "memory"] as const;
export type CollapsibleSection = (typeof COLLAPSIBLE_SECTIONS)[number];

/** The project script editor: a new script (`script: null`) or an existing one. */
export interface ScriptEditorRequest {
  projectPath: string;
  script: ProjectScript | null;
}

/** A project script about to run for the first time (or with a changed
 *  command): the confirmation that shows its whole command. */
export interface ScriptConfirmRequest {
  projectPath: string;
  script: ProjectScript;
  /** Where it will run: the project root, or the session's worktree. */
  cwd: string;
}

/** The Create PR dialog, opened once the branch is on the remote. */
export interface CreatePrRequest {
  projectPath: string;
  draft: boolean;
  prefill: PrCreateDraft;
  /** The session it is opened from, which the pull request is linked to. */
  sessionId: string | null;
}

interface SessionDetailsState {
  /** The docked card's open flag, by session scope. Absent means closed. */
  open: Record<string, true>;
  /** Which session's popover is open, when its panel has no room to dock. */
  popoverFor: string | null;
  /** The last toggle came from the keyboard: the card shows without its
   *  entrance. Something opened this often by key should be there on the
   *  keypress, not 150ms after it. */
  instant: boolean;
  /** Chat tabs whose panel can dock the card right now. Read only by
   *  `openSessionDetails`, which has to pick a form from outside the panel. */
  dockable: Record<string, true>;
  view: DetailsView;
  /** Collapsed sections, shared across sessions and persisted: which sections
   *  a reader cares about is a preference, not a per-session fact. */
  collapsed: Partial<Record<CollapsibleSection, true>>;
  scriptEditor: ScriptEditorRequest | null;
  scriptConfirm: ScriptConfirmRequest | null;
  createPr: CreatePrRequest | null;
  actions: {
    /** The title-bar button, docked form. */
    toggle: (scope: string, opts?: { instant?: boolean }) => void;
    /** The title-bar button, popover form. */
    setPopover: (scope: string, open: boolean, opts?: { instant?: boolean }) => void;
    close: (scope: string) => void;
    /** Carry a card opened before the session bound (scope `t:<tab>`) over to
     *  the session it bound to, and clear the tab scope so the tab's NEXT
     *  session does not inherit it. */
    adopt: (from: string, to: string) => void;
    /** The panel gained room to dock: a popover left open there becomes the
     *  docked card, so the card the user opened stays open. */
    handOver: (scope: string) => void;
    setDockable: (tabId: string, dockable: boolean) => void;
    toggleSection: (section: CollapsibleSection) => void;
    show: (view: DetailsView) => void;
    back: () => void;
    editScript: (request: ScriptEditorRequest | null) => void;
    confirmScript: (request: ScriptConfirmRequest | null) => void;
    requestCreatePr: (request: CreatePrRequest | null) => void;
  };
}

/** Where the store persists. */
export const DETAILS_STORAGE_KEY = "atlas.session-details";
/** The session overview's key, from before the two cards merged. Read once by
 *  `adoptLegacyDetailsPrefs`, then removed. (The session context card's store
 *  was never persisted, so it leaves nothing to carry over.) */
export const LEGACY_OVERVIEW_KEY = "atlas.chat.thread-overview";

/** The overview's collapsible cards, as the merged card's sections. Its
 *  Subagents card is the Lineage section now (the child agents list there);
 *  its Session card no longer collapses. */
const LEGACY_SECTION: Record<string, CollapsibleSection> = {
  subagents: "lineage",
  changes: "changes",
  memories: "memory",
};

/**
 * Carry the session overview's collapsed sections over to the Details card,
 * once: written under the new key only when there is nothing there yet, and
 * the old key is removed either way, so it is never read again. Runs before
 * the store hydrates. Exported for its test.
 */
export function adoptLegacyDetailsPrefs(storage: Storage | undefined): void {
  if (!storage) return;
  try {
    const raw = storage.getItem(LEGACY_OVERVIEW_KEY);
    if (raw === null) return;
    storage.removeItem(LEGACY_OVERVIEW_KEY);
    if (storage.getItem(DETAILS_STORAGE_KEY) !== null) return;
    const old = JSON.parse(raw) as { state?: { collapsed?: Record<string, unknown> } } | null;
    const collapsed: Partial<Record<CollapsibleSection, true>> = {};
    for (const [id, on] of Object.entries(old?.state?.collapsed ?? {})) {
      const next = LEGACY_SECTION[id];
      if (next && on) collapsed[next] = true;
    }
    storage.setItem(DETAILS_STORAGE_KEY, JSON.stringify({ state: { collapsed }, version: 0 }));
  } catch {
    // Unreadable or blocked storage: start from the defaults.
  }
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

adoptLegacyDetailsPrefs(browserStorage());

export const useSessionDetailsStore = createSelectors(
  create<SessionDetailsState>()(
    persist(
      (set) => ({
        open: {},
        popoverFor: null,
        instant: false,
        dockable: {},
        view: "main",
        collapsed: {},
        scriptEditor: null,
        scriptConfirm: null,
        createPr: null,
        actions: {
          toggle: (scope, opts) =>
            set((s) => {
              const open = { ...s.open };
              if (open[scope]) delete open[scope];
              else open[scope] = true;
              // Opened or closed, the next look starts at the sections.
              return { open, instant: !!opts?.instant, view: "main" };
            }),
          setPopover: (scope, next, opts) =>
            set((s) => {
              if (next) return { popoverFor: scope, instant: !!opts?.instant, view: "main" };
              return s.popoverFor === scope ? { popoverFor: null, view: "main" } : s;
            }),
          close: (scope) =>
            set((s) => {
              if (!s.open[scope] && s.popoverFor !== scope) return s;
              const open = { ...s.open };
              delete open[scope];
              return {
                open,
                popoverFor: s.popoverFor === scope ? null : s.popoverFor,
                view: "main",
              };
            }),
          adopt: (from, to) =>
            set((s) => {
              if (from === to) return s;
              const patch: Partial<SessionDetailsState> = {};
              if (s.open[from]) {
                const open = { ...s.open, [to]: true as const };
                delete open[from];
                patch.open = open;
              }
              if (s.popoverFor === from) patch.popoverFor = to;
              return Object.keys(patch).length ? patch : s;
            }),
          handOver: (scope) =>
            set((s) =>
              s.popoverFor === scope
                ? { popoverFor: null, open: { ...s.open, [scope]: true }, instant: true }
                : s,
            ),
          setDockable: (tabId, dockable) =>
            set((s) => {
              if (!!s.dockable[tabId] === dockable) return s;
              const next = { ...s.dockable };
              if (dockable) next[tabId] = true;
              else delete next[tabId];
              return { dockable: next };
            }),
          toggleSection: (section) =>
            set((s) => {
              const collapsed = { ...s.collapsed };
              if (collapsed[section]) delete collapsed[section];
              else collapsed[section] = true;
              return { collapsed };
            }),
          show: (view) => set({ view }),
          back: () => set({ view: "main" }),
          editScript: (request) => set({ scriptEditor: request }),
          confirmScript: (request) => set({ scriptConfirm: request }),
          requestCreatePr: (request) => set({ createPr: request }),
        },
      }),
      {
        name: DETAILS_STORAGE_KEY,
        version: 0,
        // Only the reader's preference. `open` is per-session layout for this
        // run: a card that reopens itself on launch is a surface the user did
        // not ask for.
        partialize: (s) => ({ collapsed: s.collapsed }),
      },
    ),
  ),
);

/** Whether `scope`'s card is showing, in either form. Selector-shaped. */
export function selectDetailsOpen(s: SessionDetailsState, scope: string): boolean {
  return !!s.open[scope] || s.popoverFor === scope;
}

/** The main column's session tab, when it shows one. */
function mainColumnSessionTab(): string | null {
  const { tabs, groupOrder, activeByGroup } = useLayoutStore.getState();
  const id = activeByGroup[groupOrder[0]];
  return tabs.find((t) => t.id === id)?.type === "chat" ? (id ?? null) : null;
}

/**
 * Open the Details card from anywhere (the palette, ⌘⌥C), optionally straight
 * onto a drill-in view: the docked card where that session's panel has room,
 * else the popover under its button. Answers `false`, opening nothing, when
 * there is no session to describe (the main column shows something else).
 */
export function openSessionDetails(
  view: DetailsView = "main",
  tabId: string | null = mainColumnSessionTab(),
): boolean {
  if (!tabId) return false;
  const scope = sessionScope(tabId, useChatStore.getState().sessions[tabId]?.acpSessionId);
  useSessionDetailsStore.setState((s) =>
    s.dockable[tabId]
      ? { open: { ...s.open, [scope]: true }, view, instant: false }
      : { popoverFor: scope, view, instant: false },
  );
  return true;
}

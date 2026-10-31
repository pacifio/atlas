// State for the diff panel — what it shows and how — kept apart from the
// git store so folding a file or flipping the layout re-renders the panel and
// nothing else.
//
// Two lifetimes:
//  - Preferences (layout, whitespace, the file tree) and each panel's
//    chosen scope and base branch persist: they are how the reader likes to
//    review, and a relaunch should not reset them.
//  - Which files are folded lives for the run only. It is keyed by the scope
//    being reviewed, so it survives switching tabs, scopes and panels, but a
//    fold from yesterday's diff has no business closing today's file.
//
// Which files were marked viewed is not kept here: only a pull request's
// review marks files, and GitHub keeps those marks (`use-pull-request-files-viewed.ts`).

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSelectors } from "@/lib/create-selectors";

/** What a diff panel reviews: the working tree against the branch's base
 *  ("Changes"), the uncommitted changes, or one turn's own edits (offered only
 *  where there is a session). The stored values predate the menu's names and
 *  are kept as they are; only {@link SCOPE_LABEL} speaks to the reader. */
export type DiffScope = "turn" | "working-tree" | "branch-range";

/** What the scope menu calls each scope. The turn scope reads "Latest turn"
 *  on the newest turn and "Turn N" on any other. */
export const SCOPE_LABEL: Record<DiffScope, string> = {
  "branch-range": "Changes",
  "working-tree": "Uncommitted",
  turn: "Latest turn",
};

/**
 * A stored scope as the panel reads it. `session` (the working tree narrowed
 * to one session's files) is folded into Changes, whose range is the working
 * tree against the base and so holds every edit the session left. Anything
 * unknown is no choice at all.
 */
export function readStoredScope(value: unknown): DiffScope | undefined {
  if (value === "session") return "branch-range";
  if (value === "turn" || value === "working-tree" || value === "branch-range") return value;
  return undefined;
}

/** The turn choice that follows the session's newest turn with changes. */
export const LATEST_TURN = "latest";

export type DiffLayout = "unified" | "split";

/** What "collapse all" or "expand all" last said; `null` until either is pressed. */
export type FoldOverride = "folded" | "expanded" | null;

/**
 * A scope's folds, kept as the reader's departures from a default rather than
 * as the set of folded files: a diff can arrive a page at a time, and a file
 * that has not loaded yet cannot be in a set. Kept as a set, it would land
 * open moments after the reader folded everything.
 */
export interface FoldState {
  /** The last "collapse all" / "expand all"; `null` follows each file's default. */
  override: FoldOverride;
  /** Files the reader toggled since, by item id. */
  toggled: Record<string, true>;
}

export const NO_FOLDS: FoldState = { override: null, toggled: {} };

/** Whether one file is folded: its default (or the last fold-all), flipped if
 *  the reader toggled it since. */
export function isFolded(state: FoldState, id: string, foldedByDefault: boolean): boolean {
  const base = state.override === null ? foldedByDefault : state.override === "folded";
  return id in state.toggled ? !base : base;
}

interface DiffPanelState {
  /** Per panel (its tab id). Absent: the panel's own default. */
  scope: Record<string, DiffScope>;
  /** Per panel: the turn the `turn` scope shows, its stable key
   *  (`stableTurnKey`, which survives a relaunch) or {@link LATEST_TURN}.
   *  Absent: the latest. */
  turn: Record<string, string>;
  /** Per repository: the base branch the branch range compares against.
   *  Absent or `null`: the remote default, as the backend picks it. */
  baseRef: Record<string, string | null>;
  layout: DiffLayout;
  /** `null`: follow the `diffIgnoreWhitespace` setting. */
  ignoreWhitespace: boolean | null;
  /** The tree beside the diff. Closed until asked for: the diff's own file
   *  rows already name every file. */
  fileTreeOpen: boolean;
  /** Folds per review scope key. Absent: nothing touched yet, every file at
   *  its default. */
  folds: Record<string, FoldState>;
  actions: {
    setScope: (panel: string, scope: DiffScope) => void;
    /** Show one turn (or {@link LATEST_TURN}): the `turn` scope, on it. */
    setTurn: (panel: string, turn: string) => void;
    setBaseRef: (repo: string, baseRef: string | null) => void;
    setLayout: (layout: DiffLayout) => void;
    setIgnoreWhitespace: (ignore: boolean) => void;
    setFileTreeOpen: (open: boolean) => void;
    /** Fold an open file, open a folded one. */
    toggleFold: (scopeKey: string, id: string) => void;
    /** Fold or open one file, whichever it is now; `foldedByDefault` is what
     *  it would be untouched. */
    setFolded: (scopeKey: string, id: string, folded: boolean, foldedByDefault: boolean) => void;
    /** Collapse or expand every file, including those still to load. */
    foldAll: (scopeKey: string, override: "folded" | "expanded") => void;
  };
}

/** Panels whose chosen scope is remembered. A tab id outlives its tab in the
 *  persisted map, so the oldest choices are dropped past this. */
export const MAX_REMEMBERED_SCOPES = 32;

/** `record` with `key` set last (insertion order is recency), trimmed to the
 *  {@link MAX_REMEMBERED_SCOPES} most recent. */
export function withRecent<T>(record: Record<string, T>, key: string, value: T): Record<string, T> {
  const entries = Object.entries(record).filter(([k]) => k !== key);
  entries.push([key, value]);
  return Object.fromEntries(entries.slice(-MAX_REMEMBERED_SCOPES));
}

function toggled(state: FoldState, id: string): FoldState {
  const next = { ...state.toggled };
  if (id in next) delete next[id];
  else next[id] = true;
  return { override: state.override, toggled: next };
}

export const useDiffPanelStore = createSelectors(
  create<DiffPanelState>()(
    persist(
      (set) => ({
        scope: {},
        turn: {},
        baseRef: {},
        layout: "unified",
        ignoreWhitespace: null,
        fileTreeOpen: false,
        folds: {},
        actions: {
          setScope: (panel, scope) => set((s) => ({ scope: withRecent(s.scope, panel, scope) })),
          setTurn: (panel, turn) =>
            set((s) => ({
              scope: withRecent(s.scope, panel, "turn"),
              turn: withRecent(s.turn, panel, turn),
            })),
          setBaseRef: (repo, baseRef) =>
            set((s) => ({ baseRef: { ...s.baseRef, [repo]: baseRef?.trim() || null } })),
          setLayout: (layout) => set({ layout }),
          setIgnoreWhitespace: (ignoreWhitespace) => set({ ignoreWhitespace }),
          setFileTreeOpen: (fileTreeOpen) => set({ fileTreeOpen }),
          toggleFold: (scopeKey, id) =>
            set((s) => ({
              folds: { ...s.folds, [scopeKey]: toggled(s.folds[scopeKey] ?? NO_FOLDS, id) },
            })),
          setFolded: (scopeKey, id, folded, foldedByDefault) =>
            set((s) => {
              const current = s.folds[scopeKey] ?? NO_FOLDS;
              if (isFolded(current, id, foldedByDefault) === folded) return s;
              return { folds: { ...s.folds, [scopeKey]: toggled(current, id) } };
            }),
          foldAll: (scopeKey, override) =>
            set((s) => ({ folds: { ...s.folds, [scopeKey]: { override, toggled: {} } } })),
        },
      }),
      {
        name: "atlas.git.diff-panel",
        // 1: the `session` scope folded into `branch-range` (Changes).
        version: 1,
        migrate: (persisted) => migrateDiffPanelState(persisted) as DiffPanelState,
        partialize: (s) => ({
          scope: s.scope,
          turn: s.turn,
          baseRef: s.baseRef,
          layout: s.layout,
          ignoreWhitespace: s.ignoreWhitespace,
          fileTreeOpen: s.fileTreeOpen,
        }),
      },
    ),
  ),
);

/** A state persisted before version 1, with each panel's stored scope read
 *  through {@link readStoredScope}: `session` becomes Changes, the rest stay
 *  as stored. */
export function migrateDiffPanelState(persisted: unknown): Partial<DiffPanelState> {
  const state = (persisted ?? {}) as Omit<Partial<DiffPanelState>, "scope"> & {
    scope?: Record<string, unknown>;
  };
  const scope: Record<string, DiffScope> = {};
  for (const [panel, value] of Object.entries(state.scope ?? {})) {
    const read = readStoredScope(value);
    if (read) scope[panel] = read;
  }
  return { ...state, scope };
}

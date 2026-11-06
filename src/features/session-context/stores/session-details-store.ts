// State for the session Details card, the card the title bar's Details
// button shows over a session's top-right.
//
// Its own store, so opening the card re-renders the button, the card and the
// dock lane and never a transcript row: rows never subscribe here, and the
// chat panel reads nothing but the stable actions.
//
// The card has two forms, and the store holds both:
//
//  - **Docked.** Where the chat panel keeps room at its top-right
//    (`context-dock.ts`), the card is drawn into that room. It shows by
//    default, and the button hides it for the session (`hidden`) until
//    toggled back. Not persisted: the next launch shows it again.
//  - **Popover.** Anywhere else the card is a popover anchored to the button,
//    open while `popoverFor` names the session.
//
// Both are keyed by SESSION (`sessionScope`), not by tab: "new agent" and
// opening a session from history both reuse the tab, and a tab-keyed flag
// followed the user into every session the tab ever showed.
//
// The dialogs the card opens are here too, not in the rows that open them: a
// popover closes when focus moves into a dialog, and a dialog mounted inside
// it would close with it. Their host is mounted once, at the app root
// (`session-details-dialogs.tsx`).

import { create } from "zustand";

import type { PrCreateDraft } from "@/features/pull-requests/lib/pull-requests-types";
import { createSelectors } from "@/lib/create-selectors";

import type { ProjectScript } from "../lib/session-context-api";
import type { GitAction } from "../lib/git-quick-action";

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

/** A git action on the session's checkout that waits on the user: a commit
 *  message (`commit`), or a choice before pushing to the default branch
 *  (`default-branch`). */
export interface GitActionPrompt {
  kind: "commit" | "default-branch";
  path: string;
  action: GitAction;
  sessionId: string | null;
  /** Run it on a new branch (chosen in the default-branch prompt). */
  featureBranch: boolean;
}

interface SessionDetailsState {
  /** Sessions whose docked card the user hid, by session scope. */
  hidden: Record<string, true>;
  /** Which session's popover is open, when its panel has no room to dock. */
  popoverFor: string | null;
  /** The last toggle came from the keyboard: the card shows without its
   *  entrance. Something opened this often by key should be there on the
   *  keypress, not 150ms after it. */
  instant: boolean;
  scriptEditor: ScriptEditorRequest | null;
  scriptConfirm: ScriptConfirmRequest | null;
  createPr: CreatePrRequest | null;
  gitPrompt: GitActionPrompt | null;
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
    editScript: (request: ScriptEditorRequest | null) => void;
    confirmScript: (request: ScriptConfirmRequest | null) => void;
    requestCreatePr: (request: CreatePrRequest | null) => void;
    promptGitAction: (request: GitActionPrompt | null) => void;
  };
}

export const useSessionDetailsStore = createSelectors(
  create<SessionDetailsState>()((set) => ({
    hidden: {},
    popoverFor: null,
    instant: false,
    scriptEditor: null,
    scriptConfirm: null,
    createPr: null,
    gitPrompt: null,
    actions: {
      toggle: (scope, opts) =>
        set((s) => {
          const hidden = { ...s.hidden };
          if (hidden[scope]) delete hidden[scope];
          else hidden[scope] = true;
          return { hidden, instant: !!opts?.instant };
        }),
      setPopover: (scope, next, opts) =>
        set((s) => {
          if (next) return { popoverFor: scope, instant: !!opts?.instant };
          return s.popoverFor === scope ? { popoverFor: null } : s;
        }),
      close: (scope) =>
        set((s) => {
          if (s.hidden[scope] && s.popoverFor !== scope) return s;
          return {
            hidden: { ...s.hidden, [scope]: true },
            popoverFor: s.popoverFor === scope ? null : s.popoverFor,
          };
        }),
      adopt: (from, to) =>
        set((s) => {
          if (from === to || (!s.hidden[from] && s.popoverFor !== from)) return s;
          const hidden = { ...s.hidden };
          if (hidden[from]) {
            delete hidden[from];
            hidden[to] = true;
          }
          return { hidden, popoverFor: s.popoverFor === from ? to : s.popoverFor };
        }),
      editScript: (request) => set({ scriptEditor: request }),
      confirmScript: (request) => set({ scriptConfirm: request }),
      requestCreatePr: (request) => set({ createPr: request }),
      promptGitAction: (request) => set({ gitPrompt: request }),
    },
  })),
);

/** Whether `scope`'s docked card shows, where its panel has room. */
export function selectDockedOpen(s: SessionDetailsState, scope: string): boolean {
  return !s.hidden[scope];
}

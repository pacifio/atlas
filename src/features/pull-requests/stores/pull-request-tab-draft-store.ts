// What a pull-request tab was in the middle of, kept across tab switches.
//
// A pull-request tab is not persistent (a mounted panel per open pull
// request would cost every render), so leaving it unmounts it. What the
// reader had half done is kept here instead, keyed by the tab's id, and read
// back when the tab mounts again: the composer's comment and review summary,
// the line comment open in the Code tab, and the commit picked there.
//
// A field is cleared when what it held is sent; the whole entry goes when
// the tab closes (`watchPullRequestTabDrafts`). Memory only: a restart
// starts clean, as the line comments of a review in progress do.

import type { SelectedLineRange } from "@pierre/diffs";
import { create } from "zustand";

import { createSelectors } from "@/lib/create-selectors";

import type { PrReviewPosition, PrReviewVerdict } from "../lib/pull-requests-types";

/** The line comment open in the Code tab. */
export interface LineCommentDraft {
  /** The diff it was opened on (pull request and commit scope). */
  scopeKey: string;
  /** The diff viewer's item id. */
  id: string;
  path: string;
  position: PrReviewPosition;
  range: SelectedLineRange;
  text: string;
}

export interface PullRequestTabDraft {
  comment?: string;
  summary?: string;
  verdict?: PrReviewVerdict;
  lineComment?: LineCommentDraft | null;
  /** The Code tab's commit; `null` for all of them. */
  commit?: string | null;
}

interface PullRequestTabDraftState {
  drafts: Record<string, PullRequestTabDraft>;
  actions: {
    patch: (tabId: string, patch: Partial<PullRequestTabDraft>) => void;
    clear: (tabId: string) => void;
    /** Drop every draft whose tab is no longer open. */
    prune: (openTabIds: ReadonlySet<string>) => void;
  };
}

export const NO_DRAFT: PullRequestTabDraft = Object.freeze({});

export const usePullRequestTabDraftStore = createSelectors(
  create<PullRequestTabDraftState>()((set) => ({
    drafts: {},
    actions: {
      patch: (tabId, patch) =>
        set((s) => ({ drafts: { ...s.drafts, [tabId]: { ...s.drafts[tabId], ...patch } } })),
      clear: (tabId) =>
        set((s) => {
          if (!(tabId in s.drafts)) return s;
          const { [tabId]: _gone, ...rest } = s.drafts;
          return { drafts: rest };
        }),
      prune: (open) =>
        set((s) => {
          const kept = Object.entries(s.drafts).filter(([id]) => open.has(id));
          return kept.length === Object.keys(s.drafts).length
            ? s
            : { drafts: Object.fromEntries(kept) };
        }),
    },
  })),
);

/** The draft as the tab left it, read once on mount. */
export function readPullRequestTabDraft(tabId: string): PullRequestTabDraft {
  return usePullRequestTabDraftStore.getState().drafts[tabId] ?? NO_DRAFT;
}

export function patchPullRequestTabDraft(tabId: string, patch: Partial<PullRequestTabDraft>) {
  usePullRequestTabDraftStore.getState().actions.patch(tabId, patch);
}

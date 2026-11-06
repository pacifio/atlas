// A review in progress on a diff tab with no session beside it: the line
// comments the reader has left, held here until "Send review to agent" hands
// them over as one ask (`../lib/review-ask.ts`). Keyed by the tab, in memory
// only, and cleared once sent. Beside a session the comments go straight into
// its composer instead (`use-diff-review-comments.tsx`).

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import type { MentionReviewComment } from "@/features/chat/lib/mentions";

const NONE: readonly MentionReviewComment[] = [];

interface ReviewDraftState {
  byTab: Record<string, readonly MentionReviewComment[]>;
  actions: {
    add: (tabId: string, comment: MentionReviewComment) => void;
    remove: (tabId: string, id: string) => void;
    clear: (tabId: string) => void;
  };
}

export const useReviewDraftStore = createSelectors(
  create<ReviewDraftState>()((set) => ({
    byTab: {},
    actions: {
      add: (tabId, comment) =>
        set((s) => ({ byTab: { ...s.byTab, [tabId]: [...(s.byTab[tabId] ?? NONE), comment] } })),
      remove: (tabId, id) =>
        set((s) => ({
          byTab: { ...s.byTab, [tabId]: (s.byTab[tabId] ?? NONE).filter((c) => c.id !== id) },
        })),
      clear: (tabId) =>
        set((s) => {
          const { [tabId]: _gone, ...rest } = s.byTab;
          return { byTab: rest };
        }),
    },
  })),
);

/** The tab's held comments, oldest first; empty without a tab. */
export function useReviewDraft(tabId: string | null): readonly MentionReviewComment[] {
  return useReviewDraftStore((s) => (tabId ? (s.byTab[tabId] ?? NONE) : NONE));
}

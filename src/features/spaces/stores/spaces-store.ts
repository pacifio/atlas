// Metadata only — the page tree, connection state, and refusals. The hot
// path (Yjs updates, awareness) never touches this store; it rides the
// spaces-bus straight into the one mounted canvas (the draft-bus rule).

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import type { SpaceConnState, SpacePage, SpaceSummary } from "../lib/spaces-api";

export interface SpaceMeta {
  summary: SpaceSummary | null;
  /** The server-authoritative tree — whole, depth-first, never diffed.
   *  Nothing here is optimistic; rows come only from `page.tree`. */
  pages: SpacePage[];
  archived: boolean;
  /** The document speaks a NEWER dialect than this build (doc_version above
   *  ours). Contract rule: render it, never write into it — a write from an
   *  older client could silently corrupt fields it cannot see. */
  stale: boolean;
  connection: SpaceConnState;
  /** A human refusal for the "cannot open at all" states. */
  error: string | null;
}

const EMPTY: SpaceMeta = {
  summary: null,
  pages: [],
  archived: false,
  stale: false,
  connection: "disconnected",
  error: null,
};

interface SpacesState {
  byConv: Record<string, SpaceMeta>;
  /**
   * Who created a page, where we happen to know it.
   *
   * The server's page row carries `created_at` but NO creator — see
   * `packages/contracts/src/space.ts`'s `SpacePage`. So this is the honest
   * subset: pages THIS client created, this session. A page created by a
   * colleague, or before this app launched, has no entry and its row shows
   * no author rather than a guessed one.
   */
  pageAuthors: Record<string, Record<string, string>>;
  actions: {
    patch: (convId: string, patch: Partial<SpaceMeta>) => void;
    adoptSummary: (convId: string, summary: SpaceSummary) => void;
    notePageAuthor: (convId: string, pageId: string, userId: string) => void;
    /** Org-switch teardown: every Space belongs to exactly one org. */
    clearAll: () => void;
  };
}

export const useSpacesStore = createSelectors(
  create<SpacesState>((set) => ({
    byConv: {},
    pageAuthors: {},
    actions: {
      patch: (convId, patch) =>
        set((s) => ({
          byConv: {
            ...s.byConv,
            [convId]: { ...(s.byConv[convId] ?? EMPTY), ...patch },
          },
        })),
      adoptSummary: (convId, summary) =>
        set((s) => ({
          byConv: {
            ...s.byConv,
            [convId]: {
              ...(s.byConv[convId] ?? EMPTY),
              summary,
              pages: summary.pages,
              archived: summary.archived,
              error: null,
            },
          },
        })),
      notePageAuthor: (convId, pageId, userId) =>
        set((s) => ({
          pageAuthors: {
            ...s.pageAuthors,
            [convId]: { ...s.pageAuthors[convId], [pageId]: userId },
          },
        })),
      clearAll: () => set({ byConv: {}, pageAuthors: {} }),
    },
  })),
);

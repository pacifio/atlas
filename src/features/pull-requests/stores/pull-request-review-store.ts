// Line comments written in the Code tab and not yet sent: a review in
// progress, per pull request. They go to GitHub together with the review's
// verdict and summary (`pr_submit_review`, from the composer's Review mode),
// the way a reviewer works through a change and then submits once.
//
// GitHub's own pending-review state is not used: nothing here is on GitHub
// until the review is submitted. The drafts are kept on this machine
// instead (`persist`, localStorage), per checkout and pull request, so a
// review half written survives closing the tab and restarting Atlas. They
// are the reader's own unsent words, not state Rust owns — the same trade
// the session pins make.

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createSelectors } from "@/lib/create-selectors";

import type { PrReviewCommentDraft } from "../lib/pull-requests-types";

export interface PendingReviewComment extends PrReviewCommentDraft {
  /** Unique across restarts, not derived from the comment: two equal
   *  remarks on one line must not share a key, or discarding one would
   *  discard both. */
  id: string;
}

let sequence = 0;
export function nextPendingCommentId(): string {
  sequence += 1;
  // The time keeps an id written after a restart apart from one kept from
  // before it, whose counter started from the same zero.
  return `pending-review-comment-${Date.now().toString(36)}-${sequence}`;
}

export function reviewKeyOf(repoPath: string, number: number): string {
  return `${repoPath}\0${number}`;
}

interface PullRequestReviewState {
  drafts: Record<string, readonly PendingReviewComment[]>;
  actions: {
    add: (key: string, comment: PendingReviewComment) => void;
    remove: (key: string, id: string) => void;
    /** Drop the ones a submitted review carried, keeping any written since. */
    removeMany: (key: string, ids: readonly string[]) => void;
  };
}

export const NO_PENDING: readonly PendingReviewComment[] = [];

function without(
  drafts: Record<string, readonly PendingReviewComment[]>,
  key: string,
  drop: (c: PendingReviewComment) => boolean,
) {
  const remaining = (drafts[key] ?? NO_PENDING).filter((c) => !drop(c));
  if (remaining.length > 0) return { drafts: { ...drafts, [key]: remaining } };
  const { [key]: _removed, ...rest } = drafts;
  return { drafts: rest };
}

/** A kept draft as it was written; anything else in storage (an older
 *  shape, a hand edit) is dropped rather than sent to GitHub. */
function isPendingComment(value: unknown): value is PendingReviewComment {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  const position = c.position as Record<string, unknown> | null | undefined;
  return (
    typeof c.id === "string" &&
    typeof c.path === "string" &&
    typeof c.body === "string" &&
    typeof position === "object" &&
    position !== null &&
    typeof position.kind === "string"
  );
}

/** The drafts read back from storage, each entry checked. */
export function restoreDrafts(stored: unknown): Record<string, readonly PendingReviewComment[]> {
  if (typeof stored !== "object" || stored === null) return {};
  const drafts = (stored as { drafts?: unknown }).drafts;
  if (typeof drafts !== "object" || drafts === null) return {};
  const out: Record<string, readonly PendingReviewComment[]> = {};
  for (const [key, list] of Object.entries(drafts)) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter(isPendingComment);
    if (kept.length > 0) out[key] = kept;
  }
  return out;
}

export const usePullRequestReviewStore = createSelectors(
  create<PullRequestReviewState>()(
    persist(
      (set) => ({
        drafts: {},
        actions: {
          add: (key, comment) =>
            set((s) => ({
              drafts: { ...s.drafts, [key]: [...(s.drafts[key] ?? NO_PENDING), comment] },
            })),
          remove: (key, id) => set((s) => without(s.drafts, key, (c) => c.id === id)),
          removeMany: (key, ids) => {
            const sent = new Set(ids);
            set((s) => without(s.drafts, key, (c) => sent.has(c.id)));
          },
        },
      }),
      {
        name: "atlas-pull-request-review-drafts",
        version: 1,
        partialize: (s) => ({ drafts: s.drafts }),
        merge: (stored, current) => ({ ...current, drafts: restoreDrafts(stored) }),
      },
    ),
  ),
);

export function usePendingReviewComments(
  repoPath: string,
  number: number,
): readonly PendingReviewComment[] {
  return usePullRequestReviewStore((s) => s.drafts[reviewKeyOf(repoPath, number)] ?? NO_PENDING);
}

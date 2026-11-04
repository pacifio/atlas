// A comment thread's UI state that must outlive its row: whether the thread is
// open, which root has its reply box up, and every unsent draft.
//
// A row can unmount under the reader (a timeline window growing, a fold
// collapsing, a scroll), and the thread's popover and composers went with it,
// taking a half-written comment along. `CommentAnchorProvider` keeps that state
// above the rows, keyed by anchor, so a remounted row comes back open with its
// drafts. Without a provider (a test, a surface that never remounts its rows)
// every hook falls back to plain local state.
//
// Pure: React only, no store. Values live in a ref-held map, so a keystroke
// re-renders the composer that owns it and nothing else.

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

type AnchorState = Map<string, unknown>;

const CommentAnchorContext = createContext<AnchorState | null>(null);

/** Holds the comment threads' open state and drafts for everything under it. */
export function CommentAnchorProvider({ children }: { children: ReactNode }) {
  const state = useRef<AnchorState>(new Map());
  return (
    <CommentAnchorContext.Provider value={state.current}>{children}</CommentAnchorContext.Provider>
  );
}

/**
 * `useState`, remembered under `key` by the nearest `CommentAnchorProvider`.
 * A `null` key (or no provider) is plain local state.
 */
export function useCommentAnchorState<T>(key: string | null, initial: T): [T, (next: T) => void] {
  const store = useContext(CommentAnchorContext);
  const remembered = store !== null && key !== null;
  const [value, setValue] = useState<T>(() =>
    remembered && store.has(key) ? (store.get(key) as T) : initial,
  );
  const set = useCallback(
    (next: T) => {
      if (remembered) {
        // The resting value is not worth keeping: drop it, so the map only
        // ever holds threads that are open or have text in them.
        if (next === initial) store.delete(key);
        else store.set(key, next);
      }
      setValue(next);
    },
    [remembered, store, key, initial],
  );
  return [value, set];
}

/** The keys a thread's state is remembered under. */
export const commentAnchorKey = {
  open: (anchor: string) => `${anchor}\u0000open`,
  replying: (anchor: string) => `${anchor}\u0000replying`,
  rootDraft: (anchor: string) => `${anchor}\u0000draft`,
  replyDraft: (anchor: string, rootId: string) => `${anchor}\u0000reply\u0000${rootId}`,
};

/**
 * What the Session reader shares down its tree without threading props: the
 * comment bundle's shape, where an oversized payload is fetched from, and which
 * entry's thread the comments panel has asked to open.
 *
 * Kept out of `components/views/` on purpose: the focus store is read through
 * `useSyncExternalStore`, and the views only consume what this module exports.
 */

import { createContext, useContext, useSyncExternalStore } from "react";

import type { OrgDirectory } from "@/features/organisations/lib/use-org-directory";

import type { CommentActions } from "../components/comment-thread";
import type { Comment } from "./comments-api";

/**
 * The pure comment helpers the reader's rows and the comment thread's views
 * need, re-exported so a view does not import the IPC module (`comments-api`)
 * for two counting functions, a limit and two types. They are pure; the module
 * they live in also holds the invoke wrappers, which is the only reason for the
 * indirection.
 */
export {
  anchorKindFor,
  COMMENT_BODY_MAX,
  visibleCount,
  type AnchorKind,
  type Comment,
} from "./comments-api";

/**
 * Everything the comment surfaces need, or `null` on a Session that is not
 * shared with an Organisation.
 *
 * One object rather than five props, because it is all-or-nothing: without a
 * cloud Project there is no anchor to attach a comment to, so every part of it
 * is absent together.
 */
export interface RowComments {
  /** Entry `rowId` → its thread. The id is the local one, pushed verbatim. */
  byAnchor: Record<string, Comment[]>;
  /** Comments on the Session itself, shown from the masthead. */
  session: Comment[];
  actions: CommentActions;
  /**
   * The Organisation's roster, for names and faces.
   *
   * Passed down rather than looked up per comment: one hook at the pane, and
   * every byline, mention and avatar stack below resolves against the same map.
   * It also carries `currentUserId`, which is what decides whose comments get a
   * delete affordance.
   */
  directory: OrgDirectory;
}

/**
 * Where an oversized payload comes from, when it is not on this disk.
 *
 * A **context** rather than another prop because the components that expand a
 * payload — a response body, a tool call's arguments, its result — sit three
 * and four levels below the pane, behind `Calls` and `CallTable` and `CallRow`,
 * none of which have any other reason to know about it. Threading it would put
 * a prop nobody reads through every one of them.
 */
export interface RemoteSource {
  /** The server Project id. */
  projectId: string;
  sessionId: string;
}

export const RemoteSourceContext = createContext<RemoteSource | null>(null);

/**
 * Which entry's comment thread the all-comments panel has asked to open.
 *
 * A counter rather than a flag, so the same thread can be asked for twice —
 * close the popover, click the same row again, and `n` moves even though
 * `anchorId` did not. It travels by context because the rows that need it are
 * memoised components several levels down (`Row`, `CallRow`); threading a prop
 * through every level would re-render the whole reader on each jump, and the
 * levels in between have no business knowing about comments.
 *
 * A **store** in the context, not the value itself. A context value re-renders
 * every consumer when it changes, and every row consumes this one — so each
 * jump re-rendered every mounted row, every call row and every comment button
 * to tell exactly one of them to open (~600ms on a long Session, on the click).
 * Through `useSyncExternalStore` each row's snapshot is only its own number,
 * so the rows a request is not for compare equal and skip the render.
 */
type FocusRequest = { anchorId: string; n: number } | null;

export interface FocusStore {
  get: () => FocusRequest;
  set: (next: FocusRequest | ((prev: FocusRequest) => FocusRequest)) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createFocusStore(): FocusStore {
  let value: FocusRequest = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      const resolved = typeof next === "function" ? next(value) : next;
      if (resolved === value) return;
      value = resolved;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const NO_FOCUS: FocusStore = createFocusStore();
export const FocusThreadContext = createContext<FocusStore>(NO_FOCUS);

/** The open signal for one anchor: a new number each time it is asked for. */
export function useOpenSignal(anchorId: string) {
  const store = useContext(FocusThreadContext);
  return useSyncExternalStore(store.subscribe, () => {
    const focus = store.get();
    return focus?.anchorId === anchorId ? focus.n : undefined;
  });
}

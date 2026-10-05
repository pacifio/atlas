/**
 * The Shared Threads this machine has joined, and which local chat session was
 * shared as which (ATL-395).
 *
 * Fed by `shared_thread_list` once and then by Rust's `atlas:shared-threads`
 * pushes; a share or join answers the fresh view directly so the panel does
 * not wait for the event.
 */

import { create } from "zustand";

import { createSelectors } from "@/lib/create-selectors";

import {
  listThreads,
  onJoinRequested,
  onSharedPresence,
  onSharedRunFrame,
  onSharedThreadsChanged,
  type SharedPeer,
  type SharedRunFrame,
  type SharedThreadView,
} from "../lib/shared-threads-api";

/** How much of a live Run's text is kept for its chip. */
const LIVE_TAIL_CHARS = 280;

/** `${sharedThreadId}:${runNo}` — a Run's key in `live`. */
export function runKey(sharedThreadId: string, runNo: number): string {
  return `${sharedThreadId}:${runNo}`;
}

interface SharedThreadsState {
  threads: SharedThreadView[];
  /** ACP session id → Shared Thread id, for sessions shared from this machine. */
  bySession: Record<string, string>;
  /** The share/join answer, kept for its file lists until the next one. */
  lastResult: SharedThreadView | null;
  /** The tail of each live Run's text, from other people's Run frames. */
  live: Record<string, string>;
  /** Bumped per thread whenever somebody asks to join, so the owner panel refetches. */
  joinRequests: Record<string, number>;
  /**
   * Everybody else on each thread, as presence last said (ATL-407) — pushed
   * on every cursor move, so kept apart from the heavier thread views.
   */
  peers: Record<string, SharedPeer[]>;
  loaded: boolean;
  load: () => Promise<void>;
  apply: (threads: SharedThreadView[]) => void;
  heard: (frame: SharedRunFrame) => void;
  shared: (sessionId: string | null, view: SharedThreadView) => void;
}

const useSharedThreadsStoreBase = create<SharedThreadsState>((set, get) => ({
  threads: [],
  bySession: {},
  lastResult: null,
  live: {},
  joinRequests: {},
  peers: {},
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    set({ loaded: true });
    void onSharedThreadsChanged((threads) => get().apply(threads));
    void onSharedRunFrame((frame) => get().heard(frame));
    void onSharedPresence(({ sharedThreadId, peers }) =>
      set((state) => ({ peers: { ...state.peers, [sharedThreadId]: peers } })),
    );
    void onJoinRequested(({ sharedThreadId }) =>
      set((state) => ({
        joinRequests: {
          ...state.joinRequests,
          [sharedThreadId]: (state.joinRequests[sharedThreadId] ?? 0) + 1,
        },
      })),
    );
    try {
      get().apply(await listThreads());
    } catch {
      // Not signed in, or the backend is not up yet: the next push fills it.
    }
  },
  // A status push carries presence too; it seeds a thread nobody has moved in yet.
  apply: (threads) =>
    set((state) => ({
      threads,
      peers: Object.fromEntries(
        threads.map((t) => [t.sharedThreadId, state.peers[t.sharedThreadId] ?? t.status.peers ?? []]),
      ),
    })),
  heard: ({ sharedThreadId, runNo, delta }) => {
    // Only the answer's text is drawn on a chip; the full Run is the Runner's
    // Session, read from the timeline once it lands.
    if (delta.kind !== "text_chunk" || typeof delta.delta !== "string") return;
    const key = runKey(sharedThreadId, runNo);
    set((state) => ({
      live: {
        ...state.live,
        [key]: ((state.live[key] ?? "") + delta.delta).slice(-LIVE_TAIL_CHARS),
      },
    }));
  },
  shared: (sessionId, view) =>
    set((state) => ({
      lastResult: view,
      threads: [...state.threads.filter((t) => t.sharedThreadId !== view.sharedThreadId), view],
      bySession: sessionId
        ? { ...state.bySession, [sessionId]: view.sharedThreadId }
        : state.bySession,
    })),
}));

export const useSharedThreadsStore = createSelectors(useSharedThreadsStoreBase);

/**
 * Why an agent session working in `cwd` may not prompt (ATL-406): `cwd` is a
 * Shared Thread's Run worktree and this person may not change that thread — a
 * viewer, a closed thread, a replica without the Base. `null` when they may,
 * or when `cwd` is no thread's.
 */
export function runLockFor(threads: SharedThreadView[], cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const thread = threads.find((t) => t.runWorktree !== "" && t.runWorktree === cwd);
  if (!thread) return null;
  if (thread.status.readOnly) return thread.status.readOnly;
  if (thread.role === "viewer") return "You are a viewer in this Shared Thread, so prompting here would not run.";
  return null;
}

export function useRunLock(cwd: string | null | undefined): string | null {
  const threads = useSharedThreadsStore.use.threads();
  return runLockFor(threads, cwd);
}

const NOBODY: SharedPeer[] = [];

/** Everybody else on `sharedThreadId` now. */
export function usePeers(sharedThreadId: string | null | undefined): SharedPeer[] {
  const peers = useSharedThreadsStore.use.peers();
  return (sharedThreadId && peers[sharedThreadId]) || NOBODY;
}

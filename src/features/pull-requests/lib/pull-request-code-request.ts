// "Show this file in the pull request's Code tab": the seam between a file chip
// in the pull request's markdown (`pull-request-markdown-impl.tsx`) and the
// panel that owns the tabs.
//
// A plain module rather than a store: the chip asks, and the panel that has
// claimed the pull request takes the ask. The panel claims it with
// `usePullRequestCodeRequests`, switches to its Code tab when an ask lands,
// and the Code tab scrolls to the file (and line) and clears it. While no
// panel has claimed the pull request, `requestPullRequestCodeFile` answers
// false and the chip opens the checkout's file in Atlas's viewer instead.

import { useCallback, useEffect, useSyncExternalStore } from "react";

/** One ask: a changed file, relative to the checkout, and maybe a line. */
export interface PullRequestCodeRequest {
  path: string;
  line?: number;
  /** Counts up, so asking for the same file twice is two asks. */
  seq: number;
}

const keyOf = (repoPath: string, number: number) => `${repoPath}\u0000${number}`;

const pending = new Map<string, PullRequestCodeRequest>();
const claims = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
let seq = 0;

function notify(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
}

/**
 * Ask the pull request's panel to show `path` in its Code tab. False when no
 * panel has claimed this pull request: the caller opens the file elsewhere.
 */
export function requestPullRequestCodeFile(
  repoPath: string,
  number: number,
  path: string,
  line?: number,
): boolean {
  const key = keyOf(repoPath, number);
  if (!claims.get(key)) return false;
  seq += 1;
  pending.set(key, { path, ...(line !== undefined ? { line } : {}), seq });
  notify(key);
  return true;
}

/** Drop the ask once it has been shown. Only the ask that was shown: a newer
 *  one that landed meanwhile stays. */
export function clearPullRequestCodeRequest(
  repoPath: string,
  number: number,
  request: PullRequestCodeRequest,
): void {
  const key = keyOf(repoPath, number);
  if (pending.get(key)?.seq !== request.seq) return;
  pending.delete(key);
  notify(key);
}

/**
 * For the pull request's panel: claim its asks while mounted, and read the
 * one waiting (null when none). Switch to the Code tab when it is non-null;
 * the Code tab reads it too, shows the file, then calls `clear`.
 */
export function usePullRequestCodeRequests(
  repoPath: string,
  number: number,
  { claim = true }: { claim?: boolean } = {},
): { request: PullRequestCodeRequest | null; clear: (request: PullRequestCodeRequest) => void } {
  const key = keyOf(repoPath, number);
  useEffect(() => {
    if (!claim) return;
    claims.set(key, (claims.get(key) ?? 0) + 1);
    return () => {
      const left = (claims.get(key) ?? 1) - 1;
      if (left > 0) claims.set(key, left);
      else claims.delete(key);
    };
  }, [key, claim]);
  const subscribe = useCallback(
    (listener: () => void) => {
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(key);
      };
    },
    [key],
  );
  const request = useSyncExternalStore(subscribe, () => pending.get(key) ?? null);
  const clear = useCallback(
    (shown: PullRequestCodeRequest) => clearPullRequestCodeRequest(repoPath, number, shown),
    [repoPath, number],
  );
  return { request, clear };
}

/** Test seam: forget every ask and claim. */
export function resetPullRequestCodeRequestsForTests(): void {
  pending.clear();
  claims.clear();
  listeners.clear();
  seq = 0;
}

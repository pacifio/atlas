// The Code tab's "Viewed" boxes, kept by GitHub (`pr_files_viewed` /
// `pr_set_files_viewed`). A press shows at once; presses are sent together
// after a short pause, so working down a list of files is one write, not one
// per file; and a press is held over the host's answer until a read that could
// have seen it comes back (`pull-request-files-viewed.ts`).
//
// Stale marks are GitHub's: a file marked viewed and then pushed to reads back
// `dismissed`, which the box shows as "Changed".

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  isFileViewed,
  isStaleViewedState,
  NO_OVERLAY,
  revertFileViewedOverlay,
  settleFileViewedOverlay,
  toFileViewedBatch,
  toFileViewedStates,
  type FileViewedOverlay,
  type FileViewedStates,
} from "./pull-request-files-viewed";
import { prSetFilesViewed } from "./pull-requests-api";
import { usePrFilesViewed } from "./pull-requests-queries";

/** How long presses gather before they are sent as one write. */
export const FLUSH_DELAY_MS = 400;

export interface PullRequestFilesViewed {
  isViewed: (path: string) => boolean;
  isStale: (path: string) => boolean;
  setViewed: (path: string, viewed: boolean) => void;
  /** More files than GitHub reports marks for in one read. */
  truncated: boolean;
  /** The marks could not be read; the boxes show the last read, if any. */
  error: string | null;
}

export function usePullRequestFilesViewed(
  repoPath: string,
  number: number,
  enabled: boolean,
): PullRequestFilesViewed | null {
  const query = usePrFilesViewed(enabled ? repoPath : null, enabled ? number : null);
  const { refetch } = query;
  const states = useMemo(() => toFileViewedStates(query.data), [query.data]);
  const [overlay, setOverlay] = useState<FileViewedOverlay>(NO_OVERLAY);

  const queued = useRef<Map<string, boolean>>(new Map());
  const sentBy = useRef<Map<string, number>>(new Map());
  const requests = useRef(0);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scopeKey = `${repoPath}\0${number}`;
  const scope = useRef(scopeKey);
  // The host's answer as it stood when a write was acknowledged, per path:
  // the first answer that differs from it is the first read that could have
  // seen the write, which is what retires the press.
  const answeredFrom = useRef<Map<string, FileViewedStates | null>>(new Map());
  const committed = useRef(states);

  useEffect(() => {
    committed.current = states;
    const pending = new Set([...queued.current.keys(), ...sentBy.current.keys()]);
    const answered = new Set<string>();
    for (const [path, from] of answeredFrom.current) {
      if (pending.has(path) || from === states) continue;
      answered.add(path);
      answeredFrom.current.delete(path);
    }
    // oxlint-disable-next-line react/set-state-in-effect -- A read arriving is what settles the presses it answers for.
    setOverlay((current) => settleFileViewedOverlay(current, states, pending, answered));
  }, [states]);

  // Takes its target explicitly, so a scope being left still sends its last
  // presses to itself.
  const flush = useCallback(
    (target: { repoPath: string; number: number }) => {
      flushTimer.current = null;
      const batch = toFileViewedBatch(queued.current);
      if (batch.length === 0) return;
      queued.current = new Map();
      const sentFrom = `${target.repoPath}\0${target.number}`;
      const request = ++requests.current;
      for (const file of batch) sentBy.current.set(file.path, request);
      const settle = (failed: boolean) => {
        const mine = batch.map((f) => f.path).filter((p) => sentBy.current.get(p) === request);
        for (const path of mine) sentBy.current.delete(path);
        if (scope.current !== sentFrom) return;
        if (failed) {
          const owned = new Set(mine.filter((path) => !queued.current.has(path)));
          setOverlay((current) => revertFileViewedOverlay(current, batch, owned));
          if (owned.size > 0) toast.error("Could not update viewed files");
        } else {
          // Answered for from the next read on, whatever it says: a push
          // landing between the write and that read comes back `dismissed`,
          // and the press must not stand over it.
          for (const path of mine) answeredFrom.current.set(path, committed.current);
        }
        void refetch();
      };
      prSetFilesViewed(target.repoPath, target.number, batch).then(
        () => settle(false),
        () => settle(true),
      );
    },
    [refetch],
  );

  // Leaving the pull request (or the tab) sends what was pressed, then drops
  // the rest.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    scope.current = scopeKey;
    const leaving = { repoPath, number };
    // A reload inside the pause would otherwise drop the last presses.
    const sendNow = () => {
      if (flushTimer.current === null) return;
      clearTimeout(flushTimer.current);
      flushRef.current(leaving);
    };
    window.addEventListener("pagehide", sendNow);
    return () => {
      window.removeEventListener("pagehide", sendNow);
      if (flushTimer.current !== null) {
        clearTimeout(flushTimer.current);
        flushRef.current(leaving);
      }
      queued.current = new Map();
      sentBy.current = new Map();
      answeredFrom.current = new Map();
      setOverlay(NO_OVERLAY);
    };
  }, [scopeKey, repoPath, number]);

  // Every file header holds it; a new identity would redraw all of them.
  const target = useRef({ repoPath, number });
  target.current = { repoPath, number };
  const setViewed = useCallback((path: string, viewed: boolean) => {
    setOverlay((current) => new Map(current).set(path, viewed));
    queued.current.set(path, viewed);
    if (flushTimer.current !== null) clearTimeout(flushTimer.current);
    const to = target.current;
    flushTimer.current = setTimeout(() => flushRef.current(to), FLUSH_DELAY_MS);
  }, []);

  const isViewed = useCallback(
    (path: string) => isFileViewed(path, states, overlay),
    [states, overlay],
  );
  const isStale = useCallback(
    (path: string) => !overlay.has(path) && isStaleViewedState(states?.get(path)),
    [states, overlay],
  );
  const truncated = query.data?.truncated === true;
  const error = query.error ? (query.error.message ?? "GitHub did not answer.") : null;
  return useMemo(
    () => (enabled ? { isViewed, isStale, setViewed, truncated, error } : null),
    [enabled, isViewed, isStale, setViewed, truncated, error],
  );
}

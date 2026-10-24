import { createRef, useEffect, useState } from "react";
import { FileSaveCoordinator } from "./file-save-coordinator";

interface FileSaveOptions {
  path: string;
  /**
   * The contents on disk when the session starts, or `null` while they are
   * still being read. The session takes the first non-null value as its
   * baseline, whenever it arrives; later values are ignored (saves and reloads
   * move the baseline through the coordinator itself).
   */
  baseline: string | null;
  persist: (contents: string) => Promise<boolean>;
  onPendingChange: (pending: boolean) => void;
  onConfirmed: (contents: string) => void;
}

export interface FileSaveSession {
  change: (contents: string) => void;
  reset: (contents: string) => void;
  flush: () => Promise<boolean>;
}

/**
 * One `FileSaveCoordinator` per open file. A session owns what is pending, so
 * it outlives re-renders and is replaced only when the file it writes to
 * changes. Callbacks are read at call time, so a new closure never restarts
 * the session.
 */
export function useFileSaveCoordinator(options: FileSaveOptions): FileSaveSession {
  const [latest] = useState(() => ({ current: options }));
  latest.current = options;
  const [current, setCurrent] = useState(() => ({
    path: options.path,
    session: createFileSaveSession(latest),
  }));
  if (current.path !== options.path) {
    setCurrent({ path: options.path, session: createFileSaveSession(latest) });
  }
  const session = current.session;

  // StrictMode replays effect setup. A retired session stays inert, while the
  // replay gets a fresh coordinator instead of reusing a disposed one.
  useEffect(session.setup, [session]);
  // The file is read after the session starts: seed it once the text lands,
  // or "clean" would mean "empty" until the first reload.
  const { baseline } = options;
  useEffect(() => {
    if (baseline !== null) session.seed(baseline);
  }, [session, baseline]);
  return session;
}

function createFileSaveSession(latest: { current: FileSaveOptions }) {
  const coordinatorRef = createRef<FileSaveCoordinator>();
  let seeded = false;
  return {
    change: (contents: string) => coordinatorRef.current?.change(contents),
    reset: (contents: string) => {
      seeded = true;
      coordinatorRef.current?.reset(contents);
    },
    flush: () => coordinatorRef.current?.flush() ?? Promise.resolve(false),
    /** The first baseline only; a later one is the coordinator's own doing. */
    seed: (baseline: string) => {
      if (seeded || !coordinatorRef.current) return;
      seeded = true;
      coordinatorRef.current.reset(baseline);
    },
    setup: () => {
      const coordinator = new FileSaveCoordinator({
        debounceMs: null,
        persist: (contents) => latest.current.persist(contents),
        onPendingChange: (pending) => latest.current.onPendingChange(pending),
        onConfirmed: (contents) => latest.current.onConfirmed(contents),
      });
      coordinatorRef.current = coordinator;
      seeded = false;
      const { baseline } = latest.current;
      if (baseline !== null) {
        seeded = true;
        coordinator.reset(baseline);
      }
      return () => {
        coordinatorRef.current = null;
        coordinator.dispose();
      };
    },
  };
}

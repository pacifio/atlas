import { useCallback, useEffect, useRef, useState } from "react";

import {
  commentOnLines,
  listLineComments,
  onSharedDocUpdate,
  onVersionsChanged,
  replyToLineComment,
  resolveLineComment,
  sharedThreadError,
  voteLineComment,
  type LineComment,
  type LineSpan,
  type SharedThreadError,
} from "./shared-threads-api";

/** How often an open view reads the comments again: their frames go to the Workspace's socket, not the thread's. */
const POLL_MS = 20_000;
/** How long the text must be quiet before comments are placed again. */
const SETTLE_MS = 800;

/**
 * A Shared Thread's line comments (ATL-416), placed on the text as this
 * replica holds it: read again on an interval, when a file of the thread
 * changes, and after every write of this person's.
 */
export function useLineComments(sharedThreadId: string | null) {
  const [comments, setComments] = useState<LineComment[]>([]);
  const [error, setError] = useState<SharedThreadError | null>(null);
  const live = useRef(true);

  const refresh = useCallback(async () => {
    if (!sharedThreadId) return;
    try {
      const next = await listLineComments(sharedThreadId);
      if (live.current) {
        setComments(next);
        setError(null);
      }
    } catch (e) {
      if (live.current) setError(sharedThreadError(e));
    }
  }, [sharedThreadId]);

  useEffect(() => {
    live.current = true;
    setComments([]);
    if (!sharedThreadId) return;
    void refresh();
    const poll = setInterval(() => void refresh(), POLL_MS);
    let settle: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      clearTimeout(settle);
      settle = setTimeout(() => void refresh(), SETTLE_MS);
    };
    const unlisten: Array<Promise<() => void>> = [
      onSharedDocUpdate((e) => e.sharedThreadId === sharedThreadId && later()),
      onVersionsChanged((e) => e.sharedThreadId === sharedThreadId && later()),
    ];
    return () => {
      live.current = false;
      clearInterval(poll);
      clearTimeout(settle);
      for (const u of unlisten) void u.then((f) => f());
    };
  }, [sharedThreadId, refresh]);

  const write = useCallback(
    async (f: () => Promise<unknown>) => {
      try {
        await f();
        setError(null);
      } catch (e) {
        setError(sharedThreadError(e));
        throw e;
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  return {
    comments,
    error,
    refresh,
    comment: (file: { fileId: number } | { path: string }, lines: LineSpan, body: string) =>
      write(() => commentOnLines(sharedThreadId!, file, lines, body)),
    reply: (parentId: string, body: string) => write(() => replyToLineComment(sharedThreadId!, parentId, body)),
    resolve: (id: string, resolved: boolean) => write(() => resolveLineComment(sharedThreadId!, id, resolved)),
    vote: (id: string, value: 1 | -1 | 0) => write(() => voteLineComment(sharedThreadId!, id, value)),
  };
}

export type LineComments = ReturnType<typeof useLineComments>;

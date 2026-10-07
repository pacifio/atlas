import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { onThreadsChanged, threadHistory } from "../lib/history-api";
import { useLiveElsewhereStore } from "../stores/live-elsewhere-store";

/*
 * Feeds `live-elsewhere-store` with every session another process is writing
 * (ADR-0001 amendment, Rule 7). The composer mounts it, so the guard holds
 * whichever view the session was opened from — the sidebar, the History view
 * (archived rows included), another project.
 *
 * One source, one writer: the query below reads the whole history store
 * (`threads_history`, archived or not, with Rust's `liveElsewhere`) and its
 * `queryFn` is the only caller of `setLive`. Every mounted composer observes
 * the same query, so N composers cost one IPC per refresh, not N. Refreshes
 * ride `atlas:threads-changed`, which the backend also fires when the clock
 * alone moves a session out of the live window — through ONE listener shared
 * by every observer, so an event never starts N refetches that cancel each
 * other.
 */

export const LIVE_ELSEWHERE_QUERY_KEY = ["thread-history", "live-elsewhere"] as const;

async function fetchLiveElsewhere(): Promise<string[]> {
  const rows = await threadHistory(false);
  const ids = rows.flatMap((row) => (row.liveElsewhere && row.sessionId ? [row.sessionId] : []));
  useLiveElsewhereStore.getState().actions.setLive(ids);
  return ids;
}

/** One `atlas:threads-changed` listener per query client, refcounted. */
const shared = new Map<QueryClient, { users: number; unlisten: Promise<UnlistenFn> }>();

function retainListener(client: QueryClient): () => void {
  let entry = shared.get(client);
  if (!entry) {
    entry = {
      users: 0,
      unlisten: onThreadsChanged(() => {
        void client.invalidateQueries({ queryKey: LIVE_ELSEWHERE_QUERY_KEY });
      }),
    };
    shared.set(client, entry);
  }
  entry.users += 1;
  const held = entry;
  return () => {
    held.users -= 1;
    if (held.users > 0) return;
    shared.delete(client);
    void held.unlisten.then((u) => u());
  };
}

/**
 * Keep the live-elsewhere set current while `enabled` (the composer has a
 * session to guard). Read the result with `useSendHeldForTerminal`.
 */
export function useLiveElsewhereFeed(enabled: boolean): void {
  const client = useQueryClient();
  useQuery({
    queryKey: LIVE_ELSEWHERE_QUERY_KEY,
    queryFn: fetchLiveElsewhere,
    enabled,
    // Events keep it current while anything observes it; with nothing mounted
    // there is no listener, so a fresh composer must not trust the cache.
    staleTime: 0,
  });
  useEffect(() => {
    if (!enabled) return;
    return retainListener(client);
  }, [enabled, client]);
}
